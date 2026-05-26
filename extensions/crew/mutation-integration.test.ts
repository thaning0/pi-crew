/**
 * mutation-integration.test.ts — End-to-End Integration Tests
 *
 * Tests the full stack: Proxy Server + Client working together.
 * Covers: end-to-end message flow, proxy fallback, concurrent write
 * consistency, and proxy crash recovery.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { MutationProxyServer } from "./mutation-proxy.ts";
import { MutationClient } from "./mutation-client.ts";
import {
  createRoom,
  writeRoomMemberState,
  loadRoomMemberState,
  listBoardEntries,
  createSpawningMember,
  createSpawnJob,
  readSpawnJob,
  updateSpawnJob,
  readCrewAddRequestReplay,
  persistCrewAddReplayEvent,
  setRoomMutationClient,
  deleteRoomMutationClient,
} from "./storage.ts";
import {
  buildCrewLifecycleEvent,
  createCrewSpawnedLifecycleEvent,
} from "./integration-events.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "room-integration-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TestEnv {
  roomDir: string;
  proxy: MutationProxyServer;
  client: MutationClient;
  tempDir: string;
}

async function setupTestEnv(tempDir: string): Promise<TestEnv> {
  const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
  const created = await createRoom({
    runtimeRoot,
    ownerName: "owner",
    ownerSessionId: "integration-test-session",
    cwd: tempDir,
    ownerPid: process.pid,
  });

  // Create a worker member
  await writeRoomMemberState(created.roomDir, {
    name: "worker",
    type: "worker",
    backend: "pi",
    runtimeId: String(process.pid),
    state: "idle",
    spawnTaskId: null,
    currentTask: null,
    currentTaskMessageId: null,
    lastCompletedTask: null,
    lastError: null,
    lastSeenSeq: 0,
    joinedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: "worker-integration-session",
  });

  const proxy = new MutationProxyServer(created.roomDir);
  await proxy.start();

  const client = new MutationClient(created.roomDir);
  await client.connect();

  return {
    roomDir: created.roomDir,
    proxy,
    client,
    tempDir,
  };
}

async function seedPaseoSpawningMember(
  roomDir: string,
  options?: {
    memberName?: string;
    taskId?: string;
    token?: string;
    jobState?: "starting" | "claimed" | "completed";
    sessionId?: string | null;
  },
): Promise<{ bootstrap: Record<string, unknown>; memberName: string; taskId: string }> {
  const memberName = options?.memberName ?? "paseo-worker";
  const taskId = options?.taskId ?? "spawn-paseo";
  const token = options?.token ?? `${taskId}-token`;
  const now = new Date().toISOString();

  await writeRoomMemberState(roomDir, {
    name: memberName,
    type: "worker",
    backend: "paseo",
    runtimeId: null,
    state: "spawning",
    spawnTaskId: taskId,
    currentTask: null,
    currentTaskMessageId: null,
    lastCompletedTask: null,
    lastError: null,
    lastSeenSeq: 0,
    joinedAt: now,
    updatedAt: now,
    sessionId: options?.sessionId ?? null,
    bootstrapToken: token,
  });
  await createSpawnJob(roomDir, {
    taskId,
    memberName,
    backend: "paseo",
    state: options?.jobState ?? "starting",
  });

  return {
    bootstrap: {
      version: 1,
      roomId: path.basename(roomDir),
      roomDir,
      memberName,
      memberType: "worker",
      ownerName: "owner",
      ownerSessionId: "integration-test-session",
      token,
      spawnTaskId: taskId,
    },
    memberName,
    taskId,
  };
}

async function seedReplayablePaseoSpawningMember(
  roomDir: string,
  options?: {
    memberName?: string;
    requestedName?: string;
    taskId?: string;
    token?: string;
    requestId?: string;
    activation?: "immediate" | "manual";
    holdExpiresAt?: string | null;
  },
): Promise<{
  bootstrap: Record<string, unknown>;
  memberName: string;
  taskId: string;
  requestId: string;
  holdExpiresAt: string | null;
}> {
  const memberName = options?.memberName ?? "replayable-paseo-worker";
  const requestedName = options?.requestedName ?? "replayable-worker";
  const taskId = options?.taskId ?? "spawn-replayable-paseo";
  const token = options?.token ?? `${taskId}-token`;
  const requestId = options?.requestId ?? `${taskId}-request`;
  const activation = options?.activation ?? "immediate";
  const created = await createSpawningMember(roomDir, {
    name: memberName,
    displayName: requestedName,
    type: "worker",
    backend: "paseo",
    taskId,
    bootstrapToken: token,
    requestReplay: {
      request_id: requestId,
      requested_name: requestedName,
      type: "worker",
      model: null,
      task: null,
      transient: false,
      metadata: null,
      activation,
      hold_timeout_ms: activation === "manual" ? 30_000 : null,
    },
  });
  const holdExpiresAt = activation === "manual"
    ? (options?.holdExpiresAt ?? new Date(Date.now() + 30_000).toISOString())
    : null;
  const spawnedEvent = buildCrewLifecycleEvent(
    createCrewSpawnedLifecycleEvent({
      request_id: requestId,
      requested_name: requestedName,
      member_target: created.member.name,
      member_type: created.member.type,
      room_id: path.basename(roomDir),
      spawn_task_id: created.job.taskId,
      runtime_id: null,
      activation,
      metadata: null,
      delivery_state: activation === "manual" ? "held" : "enabled",
      hold_expires_at: holdExpiresAt,
    }),
  );
  await persistCrewAddReplayEvent({
    roomDir,
    requestId,
    event: spawnedEvent,
    member: created.member,
    job: created.job,
    updatedAt: created.job.updatedAt,
  });

  return {
    bootstrap: {
      version: 1,
      roomId: path.basename(roomDir),
      roomDir,
      memberName: created.member.name,
      memberType: created.member.type,
      ownerName: "owner",
      ownerSessionId: "integration-test-session",
      token,
      spawnTaskId: created.job.taskId,
    },
    memberName: created.member.name,
    taskId: created.job.taskId,
    requestId,
    holdExpiresAt,
  };
}

// ── 1. End-to-End: Proxy → Write → Read ─────────────────────────────────────

describe("Integration: end-to-end message flow", () => {
  it("writes a message through proxy and reads it back", async () => {
    await withTempDir(async (tempDir) => {
      const { client, roomDir, proxy } = await setupTestEnv(tempDir);

      const result = await client.send<unknown>({
        kind: "append_message",
        payload: {
          message: {
            from: "owner",
            to: "worker",
            broadcast: false,
            replyTo: null,
            kind: "task",
            summary: "integration test message",
            content: "this is an integration test",
          },
        },
      });

      expect(result).toBeDefined();
      const msg = result as { seq: number; id: string; summary: string };
      expect(msg.seq).toBeDefined();
      expect(msg.summary).toBe("integration test message");

      // Verify on disk via listBoardEntries
      const entries = await listBoardEntries(roomDir, 10);
      const found = entries.find((e) => e.summary === "integration test message");
      expect(found).toBeDefined();
      expect(found!.content).toBe("this is an integration test");

      client.disconnect();
      await proxy.stop();
    });
  });

  it("updates member state through proxy", async () => {
    await withTempDir(async (tempDir) => {
      const { client, roomDir, proxy } = await setupTestEnv(tempDir);

      await client.send({
        kind: "update_member",
        payload: {
          memberName: "worker",
          patch: { currentTask: "working on integration test" },
        },
      });

      const member = await loadRoomMemberState(roomDir, "worker");
      expect(member.currentTask).toBe("working on integration test");

      client.disconnect();
      await proxy.stop();
    });
  });
});

// ── 2. Proxy Unavailable → Fallback ─────────────────────────────────────────

describe("Integration: proxy unavailable fallback", () => {
  it("client rejects when proxy is stopped, storage fallback via lock works", async () => {
    await withTempDir(async (tempDir) => {
      const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
      const created = await createRoom({
        runtimeRoot,
        ownerName: "owner",
        ownerSessionId: "fallback-test-session",
        cwd: tempDir,
        ownerPid: process.pid,
      });

      await writeRoomMemberState(created.roomDir, {
        name: "worker",
        type: "worker",
        backend: "pi",
        runtimeId: String(process.pid),
        state: "idle",
        spawnTaskId: null,
        currentTask: null,
        currentTaskMessageId: null,
        lastCompletedTask: null,
        lastError: null,
        lastSeenSeq: 0,
        joinedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sessionId: "worker-fallback-session",
      });

      // Start and immediately stop the proxy to simulate unavailability
      const proxy = new MutationProxyServer(created.roomDir);
      await proxy.start();
      await proxy.stop();

      const client = new MutationClient(created.roomDir);

      // Connect should fail (or stay degraded)
      await expect(client.connect()).rejects.toThrow();
      expect(client.getState()).toBe("degraded");

      // Send should reject with "unavailable"
      await expect(
        client.send({
          kind: "append_message",
          payload: {
            message: {
              from: "owner",
              to: "worker",
              broadcast: false,
              replyTo: null,
              kind: "info",
              summary: "should fail — proxy down",
            },
          },
        }),
      ).rejects.toThrow(/unavailable/i);

      // With proxy down, the caller should fall back to file lock.
      // Since appendMessage uses withRoomMutationLock internally,
      // calling it directly should work:
      const { appendMessage } = await import("./storage.ts");
      const msg = await appendMessage(created.roomDir, {
        from: "owner",
        to: "worker",
        broadcast: false,
        replyTo: null,
        kind: "info",
        summary: "fallback message",
        content: "written via file lock fallback",
      });

      expect(msg.seq).toBeGreaterThan(0);
      expect(msg.summary).toBe("fallback message");

      const entries = await listBoardEntries(created.roomDir, 10);
      expect(entries.some((e) => e.summary === "fallback message")).toBe(true);

      client.disconnect();
    });
  });
});

// ── 3. Concurrent Writes → Consistency ──────────────────────────────────────

describe("Integration: concurrent write consistency", () => {
  it("10 concurrent writes through proxy produce sequential, non-overlapping messages", async () => {
    await withTempDir(async (tempDir) => {
      const { client, roomDir, proxy } = await setupTestEnv(tempDir);

      const count = 10;
      const results = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          client.send<{ seq: number; id: string }>({
            kind: "append_message",
            payload: {
              message: {
                from: "owner",
                to: "worker",
                broadcast: false,
                replyTo: null,
                kind: "info",
                summary: `concurrent-integration-${i}`,
              },
            },
          }),
        ),
      );

      expect(results.length).toBe(count);

      // All should have valid seq numbers
      const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBe(seqs[i - 1] + 1);
      }

      // All IDs should be unique
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(count);

      // Verify on disk
      const entries = await listBoardEntries(roomDir, 50);
      const ourMsgs = entries.filter((e) => e.summary?.startsWith("concurrent-integration-"));
      expect(ourMsgs.length).toBe(count);

      client.disconnect();
      await proxy.stop();
    });
  });
});

describe("Integration: split spawn mutations", () => {
  it("emits claimed only after the first persisted non-null sessionId arrives", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);
      const storage = await import("./storage.ts") as any;
      const seeded = await seedReplayablePaseoSpawningMember(roomDir, {
        taskId: "spawn-claim-session-anchor",
        requestId: "req-claim-session-anchor",
      });

      setRoomMutationClient(roomDir, client);
      try {
        const nullClaim = await storage.claimMemberSession({
          bootstrap: seeded.bootstrap,
          sessionId: null,
        });

        expect(nullClaim.claimedEvent ?? null).toBeNull();
        const replayAfterNullClaim = await readCrewAddRequestReplay(roomDir, seeded.requestId);
        expect(replayAfterNullClaim?.replay?.event).not.toBe("claimed");

        const claimed = await storage.claimMemberSession({
          bootstrap: seeded.bootstrap,
          sessionId: "member-claim-session",
        });

        expect(claimed.claimedEvent).toMatchObject({
          event: "claimed",
          phase: "delivery",
          request_id: seeded.requestId,
          member_target: seeded.memberName,
          spawn_task_id: seeded.taskId,
          runtime_id: null,
        });
        const replayAfterClaim = await readCrewAddRequestReplay(roomDir, seeded.requestId);
        expect(replayAfterClaim?.replay).toMatchObject({
          event: "claimed",
          phase: "delivery",
          request_id: seeded.requestId,
          member_target: seeded.memberName,
          spawn_task_id: seeded.taskId,
          runtime_id: null,
        });
      } finally {
        deleteRoomMutationClient(roomDir);
        client.disconnect();
        await proxy.stop();
      }
    });
  });

  it("does not emit claimed twice when a stale session reconciles an already claimed generation", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);
      const storage = await import("./storage.ts") as any;
      const seeded = await seedReplayablePaseoSpawningMember(roomDir, {
        taskId: "spawn-claim-reconcile",
        requestId: "req-claim-reconcile",
      });

      setRoomMutationClient(roomDir, client);
      try {
        const firstClaim = await storage.claimMemberSession({
          bootstrap: seeded.bootstrap,
          sessionId: "first-claim-session",
        });
        expect(firstClaim.claimedEvent).toMatchObject({
          event: "claimed",
          request_id: seeded.requestId,
        });
        const replayAfterFirstClaim = await readCrewAddRequestReplay(roomDir, seeded.requestId);

        const duplicateClaim = await storage.claimMemberSession({
          bootstrap: seeded.bootstrap,
          sessionId: "stale-claim-session",
        });

        expect(duplicateClaim.sessionId).toBe("first-claim-session");
        expect(duplicateClaim.claimedEvent ?? null).toBeNull();
        const replayAfterDuplicateClaim = await readCrewAddRequestReplay(roomDir, seeded.requestId);
        expect(replayAfterDuplicateClaim?.replay?.event).toBe("claimed");
        expect(replayAfterDuplicateClaim?.replay?.event_id).toBe(
          replayAfterFirstClaim?.replay?.event_id,
        );
      } finally {
        deleteRoomMutationClient(roomDir);
        client.disconnect();
        await proxy.stop();
      }
    });
  });

  it("keeps manual activation held when the first persisted claim arrives", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);
      const storage = await import("./storage.ts") as any;
      const seeded = await seedReplayablePaseoSpawningMember(roomDir, {
        taskId: "spawn-claim-held",
        requestId: "req-claim-held",
        activation: "manual",
        holdExpiresAt: "2026-05-26T00:01:00.000Z",
      });

      setRoomMutationClient(roomDir, client);
      try {
        const claimed = await storage.claimMemberSession({
          bootstrap: seeded.bootstrap,
          sessionId: "manual-claim-session",
        });

        expect(claimed.claimedEvent).toMatchObject({
          event: "claimed",
          activation: "manual",
          delivery_state: "held",
          hold_expires_at: seeded.holdExpiresAt,
        });
        const replayAfterClaim = await readCrewAddRequestReplay(roomDir, seeded.requestId);
        expect(replayAfterClaim?.replay).toMatchObject({
          event: "claimed",
          activation: "manual",
          delivery_state: "held",
          hold_expires_at: seeded.holdExpiresAt,
        });
      } finally {
        deleteRoomMutationClient(roomDir);
        client.disconnect();
        await proxy.stop();
      }
    });
  });

  it("emits claimed when recovering from timed_out_pending_member_claim", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);
      const storage = await import("./storage.ts") as any;
      const seeded = await seedReplayablePaseoSpawningMember(roomDir, {
        taskId: "spawn-claim-timeout-recovery",
        requestId: "req-claim-timeout-recovery",
      });

      await updateSpawnJob(roomDir, seeded.taskId, {
        state: "timed_out_pending_member_claim",
        error: "member claim timed out",
      });

      setRoomMutationClient(roomDir, client);
      try {
        const claimed = await storage.claimMemberSession({
          bootstrap: seeded.bootstrap,
          sessionId: "timeout-recovery-session",
        });

        expect(claimed.claimedEvent).toMatchObject({
          event: "claimed",
          request_id: seeded.requestId,
          spawn_task_id: seeded.taskId,
        });
        const replayAfterClaim = await readCrewAddRequestReplay(roomDir, seeded.requestId);
        expect(replayAfterClaim?.replay?.event).toBe("claimed");
      } finally {
        deleteRoomMutationClient(roomDir);
        client.disconnect();
        await proxy.stop();
      }
    });
  });

  it("routes claim/finalize through the mutation client and keeps paseo runtime empty until finalize", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);
      const storage = await import("./storage.ts") as any;
      const seeded = await seedPaseoSpawningMember(roomDir, {
        memberName: "client-routed-worker",
        taskId: "spawn-client-routed",
      });

      setRoomMutationClient(roomDir, client);
      try {
        const claimed = await storage.claimMemberSession({
          bootstrap: seeded.bootstrap,
          sessionId: "member-claim-session",
        });
        expect(claimed.sessionId).toBe("member-claim-session");
        expect(claimed.runtimeId).toBeNull();

        const memberAfterClaim = await loadRoomMemberState(roomDir, seeded.memberName);
        expect(memberAfterClaim.runtimeId).toBeNull();
        expect(memberAfterClaim.spawnTaskId).toBe(seeded.taskId);

        const jobAfterClaim = await readSpawnJob(roomDir, seeded.taskId);
        expect(jobAfterClaim?.state).toBe("claimed");

        const finalized = await storage.finalizeMemberRuntime({
          roomDir,
          memberName: seeded.memberName,
          taskId: seeded.taskId,
          runtimeId: "agent-client-routed",
          backend: "paseo",
        });

        expect(finalized.member.runtimeId).toBe("agent-client-routed");
        expect(finalized.member.backend).toBe("paseo");
        expect(finalized.job.runtimeId).toBe("agent-client-routed");
        expect(finalized.job.backend).toBe("paseo");
        expect(finalized.job.state).toBe("completed");
      } finally {
        deleteRoomMutationClient(roomDir);
        client.disconnect();
        await proxy.stop();
      }
    });
  });

  it("auto-completes a claimed paseo spawn when claim arrives after owner finalize", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);
      const storage = await import("./storage.ts") as any;
      const seeded = await seedReplayablePaseoSpawningMember(roomDir, {
        memberName: "finalize-first-worker",
        requestedName: "finalize-first-worker",
        taskId: "spawn-finalize-first",
        requestId: "req-finalize-first",
      });

      setRoomMutationClient(roomDir, client);
      try {
        const finalized = await storage.finalizeMemberRuntime({
          roomDir,
          memberName: seeded.memberName,
          taskId: seeded.taskId,
          runtimeId: "agent-finalize-first",
          backend: "paseo",
        });

        expect(finalized.member.runtimeId).toBe("agent-finalize-first");
        expect(finalized.job.state).toBe("external_created");

        const claimed = await storage.claimMemberSession({
          bootstrap: seeded.bootstrap,
          sessionId: "finalize-first-session",
        });

        const replayAfterClaim = await readCrewAddRequestReplay(roomDir, seeded.requestId);
        expect(claimed.claimedEvent).toMatchObject({
          event: "claimed",
          request_id: seeded.requestId,
          member_target: seeded.memberName,
          spawn_task_id: seeded.taskId,
          runtime_id: "agent-finalize-first",
        });
        expect(replayAfterClaim?.replay).toMatchObject({
          event: "claimed",
          request_id: seeded.requestId,
          member_target: seeded.memberName,
          spawn_task_id: seeded.taskId,
          runtime_id: "agent-finalize-first",
        });
        expect(claimed.runtimeId).toBe("agent-finalize-first");
        expect(claimed.state).toBe("idle");
        expect(claimed.spawnTaskId).toBeNull();

        const memberAfterClaim = await loadRoomMemberState(roomDir, seeded.memberName);
        expect(memberAfterClaim.runtimeId).toBe("agent-finalize-first");
        expect(memberAfterClaim.state).toBe("idle");
        expect(memberAfterClaim.spawnTaskId).toBeNull();

        const jobAfterClaim = await readSpawnJob(roomDir, seeded.taskId);
        expect(jobAfterClaim?.state).toBe("completed");
        expect(jobAfterClaim?.runtimeId).toBe("agent-finalize-first");
      } finally {
        deleteRoomMutationClient(roomDir);
        client.disconnect();
        await proxy.stop();
      }
    });
  });

  it("rejects replaying a completed finalize against a newer member generation", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);
      const storage = await import("./storage.ts") as any;
      const memberName = "replayed-worker";
      const oldTaskId = "spawn-old-generation";
      const newTaskId = "spawn-new-generation";
      const oldToken = "old-generation-token";
      const newToken = "new-generation-token";
      const now = new Date().toISOString();

      await seedPaseoSpawningMember(roomDir, {
        memberName,
        taskId: oldTaskId,
        token: oldToken,
        jobState: "completed",
        sessionId: "old-generation-session",
      });

      await writeRoomMemberState(roomDir, {
        name: memberName,
        type: "worker",
        backend: "paseo",
        runtimeId: null,
        state: "spawning",
        spawnTaskId: newTaskId,
        currentTask: null,
        currentTaskMessageId: null,
        lastCompletedTask: null,
        lastError: null,
        lastSeenSeq: 0,
        joinedAt: now,
        updatedAt: now,
        sessionId: null,
        bootstrapToken: newToken,
      });
      await createSpawnJob(roomDir, {
        taskId: newTaskId,
        memberName,
        backend: "paseo",
        state: "starting",
      });

      await expect(
        storage.finalizeMemberRuntime({
          roomDir,
          memberName,
          taskId: oldTaskId,
          runtimeId: "agent-old-generation",
          backend: "paseo",
        }),
      ).rejects.toThrow(/different member generation|different spawn job/i);

      const currentMember = await loadRoomMemberState(roomDir, memberName);
      expect(currentMember.spawnTaskId).toBe(newTaskId);
      expect(currentMember.runtimeId).toBeNull();
      expect(currentMember.bootstrapToken).toBe(newToken);

      const oldJob = await readSpawnJob(roomDir, oldTaskId);
      expect(oldJob?.state).toBe("completed");

      client.disconnect();
      await proxy.stop();
    });
  });

  it("fails fast when claim routing has a disconnected mutation client", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);
      const storage = await import("./storage.ts") as any;
      const seeded = await seedPaseoSpawningMember(roomDir, {
        memberName: "proxy-required-worker",
        taskId: "spawn-proxy-required",
      });

      setRoomMutationClient(roomDir, client);
      try {
        client.disconnect();

        await expect(
          storage.claimMemberSession({
            bootstrap: seeded.bootstrap,
            sessionId: "should-not-join",
          }),
        ).rejects.toThrow(/live proxy connection|owner proxy/i);

        const currentMember = await loadRoomMemberState(roomDir, seeded.memberName);
        expect(currentMember.sessionId).toBeNull();
        expect(currentMember.spawnTaskId).toBe(seeded.taskId);
      } finally {
        deleteRoomMutationClient(roomDir);
        await proxy.stop();
      }
    });
  });

  it("rejects a stale starting bootstrap claim from reclaiming a newer generation", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);
      const storage = await import("./storage.ts") as any;
      const memberName = "late-claim-worker";
      const oldTaskId = "spawn-old-claim-generation";
      const oldToken = "old-claim-token";
      const newToken = "new-claim-token";
      const now = new Date().toISOString();

      await createSpawningMember(roomDir, {
        name: memberName,
        type: "worker",
        backend: "paseo",
        taskId: oldTaskId,
        bootstrapToken: oldToken,
      });

      await writeRoomMemberState(roomDir, {
        name: memberName,
        type: "worker",
        backend: "paseo",
        runtimeId: "agent-new-generation",
        state: "idle",
        spawnTaskId: null,
        currentTask: null,
        currentTaskMessageId: null,
        lastCompletedTask: null,
        lastError: null,
        lastSeenSeq: 0,
        joinedAt: now,
        updatedAt: now,
        sessionId: "new-generation-session",
        bootstrapToken: newToken,
      });

      await expect(
        storage.claimMemberSession({
          bootstrap: {
            version: 1,
            roomId: path.basename(roomDir),
            roomDir,
            memberName,
            memberType: "worker",
            ownerName: "owner",
            ownerSessionId: "integration-test-session",
            token: oldToken,
            spawnTaskId: oldTaskId,
          },
          sessionId: "late-old-session",
        }),
      ).rejects.toThrow(/different member generation/i);

      const currentMember = await loadRoomMemberState(roomDir, memberName);
      expect(currentMember.sessionId).toBe("new-generation-session");
      expect(currentMember.bootstrapToken).toBe(newToken);
      expect(currentMember.runtimeId).toBe("agent-new-generation");

      client.disconnect();
      await proxy.stop();
    });
  });

  it("rejects a stale starting finalize from overwriting a newer generation", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);
      const storage = await import("./storage.ts") as any;
      const memberName = "late-finalize-worker";
      const oldTaskId = "spawn-old-finalize-generation";
      const oldToken = "old-finalize-token";
      const newToken = "new-finalize-token";
      const now = new Date().toISOString();

      await createSpawningMember(roomDir, {
        name: memberName,
        type: "worker",
        backend: "paseo",
        taskId: oldTaskId,
        bootstrapToken: oldToken,
      });

      await writeRoomMemberState(roomDir, {
        name: memberName,
        type: "worker",
        backend: "paseo",
        runtimeId: "agent-new-generation",
        state: "idle",
        spawnTaskId: null,
        currentTask: null,
        currentTaskMessageId: null,
        lastCompletedTask: null,
        lastError: null,
        lastSeenSeq: 0,
        joinedAt: now,
        updatedAt: now,
        sessionId: "new-generation-session",
        bootstrapToken: newToken,
      });

      await expect(
        storage.finalizeMemberRuntime({
          roomDir,
          memberName,
          taskId: oldTaskId,
          runtimeId: "agent-old-generation",
          backend: "paseo",
        }),
      ).rejects.toThrow(/different member generation/i);

      const currentMember = await loadRoomMemberState(roomDir, memberName);
      expect(currentMember.sessionId).toBe("new-generation-session");
      expect(currentMember.bootstrapToken).toBe(newToken);
      expect(currentMember.runtimeId).toBe("agent-new-generation");

      const oldJob = await readSpawnJob(roomDir, oldTaskId);
      expect(oldJob?.state).toBe("starting");

      client.disconnect();
      await proxy.stop();
    });
  });

  it("rejects a legacy no-token finalize replay against a newer completed member", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);
      const storage = await import("./storage.ts") as any;
      const memberName = "legacy-no-token-finalize-worker";
      const oldTaskId = "spawn-legacy-no-token-finalize";
      const now = new Date().toISOString();

      await seedPaseoSpawningMember(roomDir, {
        memberName,
        taskId: oldTaskId,
      });

      await writeRoomMemberState(roomDir, {
        name: memberName,
        type: "worker",
        backend: "paseo",
        runtimeId: "agent-new-generation",
        state: "idle",
        spawnTaskId: null,
        currentTask: null,
        currentTaskMessageId: null,
        lastCompletedTask: null,
        lastError: null,
        lastSeenSeq: 0,
        joinedAt: now,
        updatedAt: now,
        sessionId: "new-generation-session",
        bootstrapToken: "new-generation-token",
      });

      await expect(
        storage.finalizeMemberRuntime({
          roomDir,
          memberName,
          taskId: oldTaskId,
          runtimeId: "agent-old-generation",
          backend: "paseo",
        }),
      ).rejects.toThrow(/different member generation/i);

      const currentMember = await loadRoomMemberState(roomDir, memberName);
      expect(currentMember.runtimeId).toBe("agent-new-generation");
      expect(currentMember.sessionId).toBe("new-generation-session");

      client.disconnect();
      await proxy.stop();
    });
  });

  it("rejects a legacy no-token claim replay against a newer completed member", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);
      const storage = await import("./storage.ts") as any;
      const memberName = "legacy-no-token-claim-worker";
      const oldTaskId = "spawn-legacy-no-token-claim";
      const now = new Date().toISOString();

      await seedPaseoSpawningMember(roomDir, {
        memberName,
        taskId: oldTaskId,
      });

      await writeRoomMemberState(roomDir, {
        name: memberName,
        type: "worker",
        backend: "paseo",
        runtimeId: "agent-new-generation",
        state: "idle",
        spawnTaskId: null,
        currentTask: null,
        currentTaskMessageId: null,
        lastCompletedTask: null,
        lastError: null,
        lastSeenSeq: 0,
        joinedAt: now,
        updatedAt: now,
        sessionId: "new-generation-session",
        bootstrapToken: "new-generation-token",
      });

      await expect(
        storage.claimMemberSession({
          bootstrap: {
            version: 1,
            roomId: path.basename(roomDir),
            roomDir,
            memberName,
            memberType: "worker",
            ownerName: "owner",
            ownerSessionId: "integration-test-session",
            token: `${oldTaskId}-token`,
            spawnTaskId: oldTaskId,
          },
          sessionId: "late-legacy-session",
        }),
      ).rejects.toThrow(/different member generation|token does not match/i);

      const currentMember = await loadRoomMemberState(roomDir, memberName);
      expect(currentMember.runtimeId).toBe("agent-new-generation");
      expect(currentMember.sessionId).toBe("new-generation-session");

      client.disconnect();
      await proxy.stop();
    });
  });

  it("recovers legacy claimed spawn files with the split protocol", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);
      const storage = await import("./storage.ts") as any;
      const seeded = await seedPaseoSpawningMember(roomDir, {
        memberName: "legacy-claimed-worker",
        taskId: "spawn-legacy-claimed",
        jobState: "claimed",
        sessionId: "legacy-claimed-session",
      });

      const finalized = await storage.finalizeMemberRuntime({
        roomDir,
        memberName: seeded.memberName,
        taskId: seeded.taskId,
        runtimeId: "agent-legacy-claimed",
        backend: "paseo",
      });

      expect(finalized.member.runtimeId).toBe("agent-legacy-claimed");
      expect(finalized.member.spawnTaskId).toBeNull();
      expect(finalized.member.state).toBe("idle");

      const recoveredJob = await readSpawnJob(roomDir, seeded.taskId);
      expect(recoveredJob?.state).toBe("completed");
      expect(recoveredJob?.runtimeId).toBe("agent-legacy-claimed");

      client.disconnect();
      await proxy.stop();
    });
  });
});

// ── 4. Proxy Crash → Degrade Recovery ────────────────────────────────────────

describe("Integration: proxy crash and recovery", () => {
  it("client degrades on proxy crash, recovers when proxy restarts", async () => {
    await withTempDir(async (tempDir) => {
      const { client, proxy, roomDir } = await setupTestEnv(tempDir);

      // Verify connected
      expect(client.getState()).toBe("connected");

      // Send one message successfully
      await client.send({
        kind: "append_message",
        payload: {
          message: {
            from: "owner",
            to: "worker",
            broadcast: false,
            replyTo: null,
            kind: "info",
            summary: "before crash",
          },
        },
      });

      // Crash the proxy
      await proxy.stop();

      // Try to send — should fail
      await expect(
        client.send({
          kind: "append_message",
          payload: {
            message: {
              from: "owner",
              to: "worker",
              broadcast: false,
              replyTo: null,
              kind: "info",
              summary: "during crash",
            },
          },
        }),
      ).rejects.toThrow();

      // Client should be degraded
      expect(client.getState()).not.toBe("connected");

      // Restart proxy
      const proxy2 = new MutationProxyServer(roomDir);
      await proxy2.start();

      // Reconnect client
      client.disconnect();
      await client.connect();
      expect(client.getState()).toBe("connected");

      // Now send should work again
      const result = await client.send<{ seq: number }>({
        kind: "append_message",
        payload: {
          message: {
            from: "owner",
            to: "worker",
            broadcast: false,
            replyTo: null,
            kind: "info",
            summary: "after recovery",
          },
        },
      });

      expect(result.seq).toBeGreaterThan(0);

      // Verify all messages are there
      const entries = await listBoardEntries(roomDir, 10);
      expect(entries.some((e) => e.summary === "before crash")).toBe(true);
      expect(entries.some((e) => e.summary === "after recovery")).toBe(true);

      client.disconnect();
      await proxy2.stop();
    });
  });
});
