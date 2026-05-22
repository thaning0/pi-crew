/**
 * mutation-proxy.test.ts — Proxy Server Unit Tests
 *
 * Tests: start/stop lifecycle, command dispatch (append_message, update_member),
 * concurrent request serialization, large message frames, queue backpressure,
 * graceful shutdown.
 */

import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MutationProxyServer } from "./mutation-proxy.ts";
import {
  encodeFrame,
  createFrameParser,
  getProxySocketPath,
  type ProxyRequest,
  type ProxyResponse,
} from "./mutation-proxy-types.ts";
import {
  appendMessage,
  createRoom,
  writeRoomMemberState,
  loadRoomMemberState,
  listBoardEntries,
  createSpawnJob,
  readSpawnJob,
} from "./storage.ts";
import type { RoomBootstrap, RoomMemberState } from "./types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "room-proxy-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TestRoom {
  roomDir: string;
  runtimeRoot: string;
  tempDir: string;
}

async function setupTestRoom(tempDir: string): Promise<TestRoom> {
  const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
  const created = await createRoom({
    runtimeRoot,
    ownerName: "owner",
    ownerSessionId: "proxy-test-session",
    cwd: tempDir,
    ownerPid: process.pid,
  });

  // Create a worker member so appendMessage has a valid target
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
    sessionId: "worker-session",
  });

  return { roomDir: created.roomDir, runtimeRoot, tempDir };
}

function buildBootstrap(roomDir: string, memberName: string, token: string, spawnTaskId: string): RoomBootstrap {
  return {
    version: 1,
    roomId: path.basename(roomDir),
    roomDir,
    memberName,
    memberType: "worker",
    ownerName: "owner",
    ownerSessionId: "proxy-test-session",
    token,
    spawnTaskId,
  };
}

async function connectRaw(
  socketPath: string,
): Promise<{ socket: net.Socket; send: (req: ProxyRequest) => void; responses: ProxyResponse[] }> {
  const socket = net.createConnection(socketPath);
  const parser = createFrameParser();
  const responses: ProxyResponse[] = [];
  parser.onFrame = (obj) => {
    responses.push(obj as ProxyResponse);
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timeout")), 3000);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.on("data", (chunk: Buffer) => parser.feed(chunk));
      resolve({
        socket,
        send: (req: ProxyRequest) => socket.write(encodeFrame(req)),
        responses,
      });
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── 1. Start / Stop Lifecycle ────────────────────────────────────────────────

describe("MutationProxyServer start/stop", () => {
  it("start creates socket file, stop cleans it up", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const proxy = new MutationProxyServer(roomDir);
      const socketPath = getProxySocketPath(roomDir);

      // Before start, socket should not exist
      await expect(fs.stat(socketPath)).rejects.toThrow();

      // Start proxy
      await proxy.start();
      await expect(fs.stat(socketPath)).resolves.toBeDefined();

      // Stop proxy
      await proxy.stop();
      await expect(fs.stat(socketPath)).rejects.toThrow(/ENOENT/);
    });
  });

  it("stale socket file is cleaned up before listen", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const socketPath = getProxySocketPath(roomDir);

      // Write a stale socket file
      await fs.writeFile(socketPath, "stale");

      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();

      // Should be a real socket now, not the stale file
      const stat = await fs.stat(socketPath);
      expect(stat.isSocket()).toBe(true);

      await proxy.stop();
    });
  });

  it("two starts in sequence work without errors", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const proxy = new MutationProxyServer(roomDir);

      await proxy.start();
      await proxy.stop();
      await proxy.start();
      await proxy.stop();
    });
  });
});

// ── 2. append_message Command ────────────────────────────────────────────────

describe("MutationProxyServer append_message", () => {
  it("appends a message via proxy and returns it", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();

      const { socket, send, responses } = await connectRaw(
        getProxySocketPath(roomDir),
      );

      send({
        requestId: "req-1",
        protocolVersion: 1,
        command: {
          kind: "append_message",
          payload: {
            message: {
              from: "owner",
              to: "worker",
              broadcast: false,
              replyTo: null,
              kind: "task",
              summary: "proxy test message",
              content: "hello from proxy test",
            },
          },
        },
      });

      await sleep(200);

      expect(responses.length).toBeGreaterThanOrEqual(1);
      const resp = responses.find((r) => r.requestId === "req-1");
      expect(resp).toBeDefined();
      expect(resp!.ok).toBe(true);

      // Verify message is in the board
      const entries = await listBoardEntries(roomDir, 10);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const msg = entries.find((e) => e.summary === "proxy test message");
      expect(msg).toBeDefined();
      expect(msg!.from).toBe("owner");
      expect(msg!.to).toBe("worker");
      expect(msg!.content).toBe("hello from proxy test");

      socket.destroy();
      await proxy.stop();
    });
  });
});

// ── 3. update_member Command ─────────────────────────────────────────────────

describe("MutationProxyServer update_member", () => {
  it("updates member state via proxy", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();

      const { socket, send, responses } = await connectRaw(
        getProxySocketPath(roomDir),
      );

      send({
        requestId: "req-update",
        protocolVersion: 1,
        command: {
          kind: "update_member",
          payload: {
            memberName: "worker",
            patch: { currentTask: "running via proxy" },
          },
        },
      });

      await sleep(200);

      expect(responses.length).toBeGreaterThanOrEqual(1);
      const resp = responses.find((r) => r.requestId === "req-update");
      expect(resp).toBeDefined();
      expect(resp!.ok).toBe(true);

      const member = await loadRoomMemberState(roomDir, "worker");
      expect(member.currentTask).toBe("running via proxy");

      socket.destroy();
      await proxy.stop();
    });
  });
});

describe("MutationProxyServer notify_deps", () => {
  it("notifies downstream tasks when an upstream task is cancelled", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      await writeRoomMemberState(roomDir, {
        name: "reviewer",
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
        sessionId: "reviewer-session",
      });

      const upstream = await appendMessage(roomDir, {
        from: "owner",
        to: "worker",
        broadcast: false,
        replyTo: null,
        kind: "task",
        summary: "upstream task",
      });
      await appendMessage(roomDir, {
        from: "owner",
        to: "worker",
        broadcast: false,
        replyTo: upstream.id,
        kind: "cancelled",
        summary: "upstream cancelled",
      });
      await appendMessage(roomDir, {
        from: "owner",
        to: "reviewer",
        broadcast: false,
        replyTo: null,
        kind: "task",
        summary: "downstream task",
        content: `Wait for {input:#${upstream.seq}} before starting.`,
      });

      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();

      const { socket, send } = await connectRaw(getProxySocketPath(roomDir));
      send({
        requestId: "notify-deps-cancelled",
        protocolVersion: 1,
        command: {
          kind: "notify_deps",
          payload: {
            upstreamSeq: upstream.seq,
            status: "cancelled",
          },
        },
      });

      await sleep(200);

      const entries = await listBoardEntries(roomDir, 20);
      expect(entries.some((entry) => entry.to === "reviewer" && /Dependency cancelled/.test(entry.summary))).toBe(true);

      socket.destroy();
      await proxy.stop();
    });
  });
});

describe("MutationProxyServer spawn protocol compatibility", () => {
  it("rejects create_spawning_member when asked to reuse a removed internal id", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      await writeRoomMemberState(roomDir, {
        name: "worker_legacy",
        displayName: "worker",
        type: "worker",
        backend: "pi",
        runtimeId: null,
        state: "removed",
        spawnTaskId: null,
        currentTask: null,
        currentTaskMessageId: null,
        lastCompletedTask: null,
        lastError: null,
        lastSeenSeq: 0,
        joinedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sessionId: null,
      });

      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();

      const { socket, send, responses } = await connectRaw(getProxySocketPath(roomDir));
      send({
        requestId: "create-spawning-member-reuse-removed",
        protocolVersion: 1,
        command: {
          kind: "create_spawning_member",
          payload: {
            name: "worker_legacy",
            displayName: "worker",
            type: "worker",
            backend: "pi",
            taskId: "spawn-worker-legacy",
          },
        },
      } as ProxyRequest);

      await sleep(200);

      const response = responses.find((r) => r.requestId === "create-spawning-member-reuse-removed");
      expect(response).toBeDefined();
      expect(response?.ok).toBe(false);
      expect(JSON.stringify(response)).toMatch(/already exists/i);

      socket.destroy();
      await proxy.stop();
    });
  });

  it("accepts claim_member_session/finalize_member_runtime and keeps paseo runtime empty until finalize", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const memberName = "paseo-worker";
      const taskId = "spawn-claim";
      const token = "claim-token";
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
        sessionId: null,
        bootstrapToken: token,
      });
      await createSpawnJob(roomDir, {
        taskId,
        memberName,
        backend: "paseo",
        state: "starting",
      });

      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();

      const { socket, send, responses } = await connectRaw(getProxySocketPath(roomDir));
      const bootstrap = buildBootstrap(roomDir, memberName, token, taskId);

      send({
        requestId: "claim-member-session",
        protocolVersion: 1,
        command: {
          kind: "claim_member_session",
          payload: {
            bootstrap,
            sessionId: "member-session",
          },
        } as any,
      } as any);

      await sleep(200);

      const claimResponse = responses.find((r) => r.requestId === "claim-member-session");
      expect(claimResponse).toBeDefined();
      expect(claimResponse!.ok).toBe(true);

      const claimedMember = await loadRoomMemberState(roomDir, memberName);
      expect(claimedMember.sessionId).toBe("member-session");
      expect(claimedMember.runtimeId).toBeNull();

      const claimedJob = await readSpawnJob(roomDir, taskId);
      expect(claimedJob?.state).toBe("claimed");

      send({
        requestId: "finalize-member-runtime",
        protocolVersion: 1,
        command: {
          kind: "finalize_member_runtime",
          payload: {
            memberName,
            taskId,
            runtimeId: "agent-42",
            backend: "paseo",
          },
        } as any,
      } as any);

      await sleep(200);

      const finalizeResponse = responses.find((r) => r.requestId === "finalize-member-runtime");
      expect(finalizeResponse).toBeDefined();
      expect(finalizeResponse!.ok).toBe(true);

      const finalizedMember = await loadRoomMemberState(roomDir, memberName);
      expect(finalizedMember.runtimeId).toBe("agent-42");
      expect(finalizedMember.backend).toBe("paseo");

      const finalizedJob = await readSpawnJob(roomDir, taskId);
      expect(finalizedJob?.runtimeId).toBe("agent-42");
      expect(finalizedJob?.backend).toBe("paseo");
      expect(finalizedJob?.state).toBe("completed");

      socket.destroy();
      await proxy.stop();
    });
  });

  it("keeps mark_member_joined compatibility for existing callers", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const memberName = "legacy-worker";
      const taskId = "spawn-legacy";
      const token = "legacy-token";
      const now = new Date().toISOString();

      await writeRoomMemberState(roomDir, {
        name: memberName,
        type: "worker",
        backend: "pi",
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
        sessionId: null,
        bootstrapToken: token,
      });
      await createSpawnJob(roomDir, {
        taskId,
        memberName,
        backend: "pi",
        state: "starting",
      });

      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();

      const { socket, send, responses } = await connectRaw(getProxySocketPath(roomDir));
      const bootstrap = buildBootstrap(roomDir, memberName, token, taskId);

      send({
        requestId: "legacy-mark-member-joined",
        protocolVersion: 1,
        command: {
          kind: "mark_member_joined",
          payload: {
            bootstrap,
            sessionId: "legacy-session",
            runtimeId: "legacy-runtime",
            backend: "pi",
          },
        },
      });

      await sleep(200);

      const response = responses.find((r) => r.requestId === "legacy-mark-member-joined");
      expect(response).toBeDefined();
      expect(response!.ok).toBe(true);

      const member = await loadRoomMemberState(roomDir, memberName);
      expect(member.sessionId).toBe("legacy-session");
      expect(member.runtimeId).toBe("legacy-runtime");
      expect(member.state).toBe("idle");

      socket.destroy();
      await proxy.stop();
    });
  });

  it("ignores legacy paseo mark_member_joined runtimeId until owner finalize writes it", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const memberName = "legacy-paseo-worker";
      const taskId = "spawn-legacy-paseo";
      const token = "legacy-paseo-token";
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
        sessionId: null,
        bootstrapToken: token,
      });
      await createSpawnJob(roomDir, {
        taskId,
        memberName,
        backend: "paseo",
        state: "starting",
      });

      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();

      const { socket, send, responses } = await connectRaw(getProxySocketPath(roomDir));
      const bootstrap = buildBootstrap(roomDir, memberName, token, taskId);

      send({
        requestId: "legacy-paseo-mark-member-joined",
        protocolVersion: 1,
        command: {
          kind: "mark_member_joined",
          payload: {
            bootstrap,
            sessionId: "legacy-paseo-session",
            runtimeId: "legacy-paseo-runtime",
            backend: "paseo",
          },
        } as any,
      } as any);

      await sleep(200);

      const response = responses.find((candidate) => candidate.requestId === "legacy-paseo-mark-member-joined");
      expect(response).toBeDefined();
      expect(response!.ok).toBe(true);

      const member = await loadRoomMemberState(roomDir, memberName);
      expect(member.sessionId).toBe("legacy-paseo-session");
      expect(member.runtimeId).toBeNull();
      expect(member.state).toBe("spawning");
      expect(member.spawnTaskId).toBe(taskId);

      const job = await readSpawnJob(roomDir, taskId);
      expect(job?.state).toBe("claimed");

      socket.destroy();
      await proxy.stop();
    });
  });

  it("rejects claim_member_session when a completed job has no member anchor", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const memberName = "completed-missing-anchor-worker";
      const taskId = "spawn-completed-missing-anchor";

      await createSpawnJob(roomDir, {
        taskId,
        memberName,
        backend: "paseo",
        state: "completed",
      });

      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();

      const { socket, send, responses } = await connectRaw(getProxySocketPath(roomDir));
      send({
        requestId: "completed-missing-anchor-claim",
        protocolVersion: 1,
        command: {
          kind: "claim_member_session",
          payload: {
            bootstrap: buildBootstrap(roomDir, memberName, `${taskId}-token`, taskId),
            sessionId: "late-claim-session",
          },
        } as any,
      } as any);

      await sleep(200);

      const response = responses.find((candidate) => candidate.requestId === "completed-missing-anchor-claim");
      expect(response).toBeDefined();
      expect(response!.ok).toBe(false);
      expect(response!.error ?? "").toMatch(/already completed|member has been removed/i);

      socket.destroy();
      await proxy.stop();
    });
  });
});

// ── 4. Concurrent Request Serialization ──────────────────────────────────────

describe("MutationProxyServer concurrent serialization", () => {
  it("processes 10 concurrent requests sequentially via PQueue", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();

      const socketPath = getProxySocketPath(roomDir);
      const { socket, send, responses } = await connectRaw(socketPath);

      // Send 10 requests as fast as possible
      const count = 10;
      for (let i = 0; i < count; i++) {
        send({
          requestId: `concurrent-${i}`,
          protocolVersion: 1,
          command: {
            kind: "append_message",
            payload: {
              message: {
                from: "owner",
                to: "worker",
                broadcast: false,
                replyTo: null,
                kind: "info",
                summary: `concurrent msg ${i}`,
              },
            },
          },
        });
      }

      // Wait for all responses
      await sleep(500);

      const proxyResponses = responses.filter(
        (r) => r.requestId?.startsWith("concurrent-"),
      );
      expect(proxyResponses.length).toBe(count);

      // All should be ok
      for (const r of proxyResponses) {
        expect(r.ok).toBe(true);
      }

      // Verify messages have sequential seq numbers
      const entries = await listBoardEntries(roomDir, 100);
      const ourMsgs = entries.filter((e) => e.summary?.startsWith("concurrent msg "));
      expect(ourMsgs.length).toBe(count);

      // Check that seq numbers are sequential (PQueue concurrency=1 guarantees ordering)
      const seqs = ourMsgs.map((e) => e.seq).sort((a, b) => a - b);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBe(seqs[i - 1] + 1);
      }

      socket.destroy();
      await proxy.stop();
    });
  });
});

// ── 5. Large Message Frames ──────────────────────────────────────────────────

describe("MutationProxyServer large frames", () => {
  it("handles large multi-line message without truncation", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();

      const { socket, send, responses } = await connectRaw(
        getProxySocketPath(roomDir),
      );

      // Create a large payload with multi-line content
      const longContent = "Line " + Array.from({ length: 200 }, (_, i) => 
        `This is line ${i} with some padding to make the message longer and more realistic. `
      ).join("\n");

      send({
        requestId: "large-msg",
        protocolVersion: 1,
        command: {
          kind: "append_message",
          payload: {
            message: {
              from: "owner",
              to: "worker",
              broadcast: false,
              replyTo: null,
              kind: "info",
              summary: "large message test",
              content: longContent,
            },
          },
        },
      });

      await sleep(300);

      const resp = responses.find((r) => r.requestId === "large-msg");
      expect(resp).toBeDefined();
      expect(resp!.ok).toBe(true);

      // Verify content was stored correctly
      const entries = await listBoardEntries(roomDir, 10);
      const msg = entries.find((e) => e.summary === "large message test");
      expect(msg).toBeDefined();
      expect(msg!.content).toBe(longContent);

      socket.destroy();
      await proxy.stop();
    });
  });
});

// ── 6. Queue Backpressure ────────────────────────────────────────────────────

describe("MutationProxyServer queue backpressure", () => {
  it("rejects requests when queue exceeds MAX_QUEUE_SIZE (100)", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();

      const socketPath = getProxySocketPath(roomDir);

      // Create two connections to send many requests quickly
      const { socket: s1, send: send1, responses: r1 } = await connectRaw(socketPath);
      const { socket: s2, send: send2, responses: r2 } = await connectRaw(socketPath);

      // Send 200 requests — the queue should reject when >100 pending
      const total = 200;
      for (let i = 0; i < total; i++) {
        const fn = i % 2 === 0 ? send1 : send2;
        fn({
          requestId: `flood-${i}`,
          protocolVersion: 1,
          command: {
            kind: "append_message",
            payload: {
              message: {
                from: "owner",
                to: "worker",
                broadcast: false,
                replyTo: null,
                kind: "info",
                summary: `flood ${i}`,
              },
            },
          },
        });
      }

      // Wait a bit for responses
      await sleep(2000);

      // Check for at least one rejection
      const allResponses = [...r1, ...r2].filter(
        (r) => r.requestId?.startsWith("flood-"),
      );

      const failures = allResponses.filter((r) => !r.ok);
      // Should have at least some failures due to queue overflow
      expect(failures.length).toBeGreaterThan(0);

      // Failure messages should mention "busy" or "queue"
      for (const f of failures) {
        expect(f.error).toBeDefined();
        expect(
          f.error!.toLowerCase().includes("busy") ||
          f.error!.toLowerCase().includes("queue") ||
          f.error!.toLowerCase().includes("limit"),
        ).toBe(true);
      }

      s1.destroy();
      s2.destroy();
      await proxy.stop();
    });
  });
});

// ── 7. Graceful Shutdown ─────────────────────────────────────────────────────

describe("MutationProxyServer graceful shutdown", () => {
  it("completes in-flight request before stopping", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();

      const { socket, send, responses } = await connectRaw(
        getProxySocketPath(roomDir),
      );

      // Send a message then immediately initiate shutdown
      send({
        requestId: "before-shutdown",
        protocolVersion: 1,
        command: {
          kind: "append_message",
          payload: {
            message: {
              from: "owner",
              to: "worker",
              broadcast: false,
              replyTo: null,
              kind: "info",
              summary: "shutdown test msg",
            },
          },
        },
      });

      // Give a tiny bit of time for the request to start processing
      await sleep(50);

      // Stop the proxy
      await proxy.stop();

      // The request should have completed
      const resp = responses.find((r) => r.requestId === "before-shutdown");
      expect(resp).toBeDefined();
      expect(resp!.ok).toBe(true);

      // Verify message is persisted
      const entries = await listBoardEntries(roomDir, 10);
      expect(entries.some((e) => e.summary === "shutdown test msg")).toBe(true);

      socket.destroy();
    });
  });

  it("does not accept connections during shutdown", async () => {
    await withTempDir(async (tempDir) => {
      const { roomDir } = await setupTestRoom(tempDir);
      const proxy = new MutationProxyServer(roomDir);
      await proxy.start();
      await proxy.stop();

      const socketPath = getProxySocketPath(roomDir);
      // Socket file should be cleaned up
      await expect(fs.stat(socketPath)).rejects.toThrow(/ENOENT/);

      // Connecting should fail
      await expect(
        new Promise<void>((resolve, reject) => {
          const sock = net.createConnection(socketPath);
          sock.on("connect", () => {
            sock.destroy();
            resolve();
          });
          sock.on("error", (err) => reject(err));
        }),
      ).rejects.toThrow(/ENOENT/);
    });
  });
});
