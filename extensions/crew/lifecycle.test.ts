import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";
import { buildRoomBootstrapBlock } from "./bootstrap.ts";
import { activateBootstrapRoom, clearActiveRoom, getActiveRoom, processUnreadMessages, resolveAccessibleRoom, resetActiveRoomsForTests, setActiveRoom } from "./lifecycle.ts";
import { createPiMemberAdapter, createPaseoPiMemberAdapter } from "./spawn.ts";
import { appendMessage, createRoom, createSpawningMember, deleteRoomMutationClient, getRoomMutationClient, listBoardEntries, loadRoomMemberState, readSpawnJob, writeRoomMemberState } from "./storage.ts";
import { MutationProxyServer } from "./mutation-proxy.ts";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RoomBootstrap } from "./types.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "room-lifecycle-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

afterEach(() => {
	resetActiveRoomsForTests();
});

describe("activateBootstrapRoom", () => {
	it("claims paseo bootstrap without writing process.pid into runtime identity", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session",
				cwd: tempDir,
			});
			await createSpawningMember(created.roomDir, {
				name: "worker",
				type: "worker",
				backend: "paseo",
				taskId: "spawn-worker",
				bootstrapToken: "spawn-token",
			});

			const bootstrap: RoomBootstrap = {
				version: 1,
				roomId: created.metadata.roomId,
				roomDir: created.roomDir,
				memberName: "worker",
				memberType: "worker",
				ownerName: "owner",
				ownerSessionId: "owner-session",
				token: "spawn-token",
				spawnTaskId: "spawn-worker",
			};

			await activateBootstrapRoom(
				{
					sendMessage() {
						return undefined;
					},
				} as ExtensionAPI,
				buildRoomBootstrapBlock(bootstrap),
				"member-session",
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
			);

			const member = await loadRoomMemberState(created.roomDir, "worker");
			assert.equal(member.backend, "paseo");
			assert.equal(member.runtimeId, null);
			assert.equal(member.runtimeIdentitySource, "member-pid");
			assert.equal(member.state, "spawning");
			assert.equal(member.spawnTaskId, "spawn-worker");
			assert.equal(member.sessionId, "member-session");
			assert.match(member.bootstrapClaimedAt ?? "", /\S+/);

			const job = await readSpawnJob(created.roomDir, "spawn-worker");
			assert.equal(job?.state, "claimed");
		});
	});

	it("connects the mutation client before bootstrap fallback activation", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-fallback",
				cwd: tempDir,
			});
			await createSpawningMember(created.roomDir, {
				name: "worker",
				type: "worker",
				backend: "paseo",
				taskId: "spawn-worker-fallback",
				bootstrapToken: "spawn-fallback-token",
			});

			const bootstrap: RoomBootstrap = {
				version: 1,
				roomId: created.metadata.roomId,
				roomDir: created.roomDir,
				memberName: "worker",
				memberType: "worker",
				ownerName: "owner",
				ownerSessionId: "owner-session-fallback",
				token: "spawn-fallback-token",
				spawnTaskId: "spawn-worker-fallback",
			};

			const proxy = new MutationProxyServer(created.roomDir);
			await proxy.start();
			try {
				const resolved = await resolveAccessibleRoom(
					{
						sendMessage() {
							return undefined;
						},
					} as ExtensionAPI,
					{
						getSystemPrompt: () => buildRoomBootstrapBlock(bootstrap),
						sessionManager: { getSessionId: () => "member-session-fallback" },
					} as Parameters<typeof resolveAccessibleRoom>[1],
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				);

				assert.equal(resolved?.role, "member");
				assert.equal(getRoomMutationClient(created.roomDir)?.getState(), "connected");
				const member = await loadRoomMemberState(created.roomDir, "worker");
				assert.equal(member.sessionId, "member-session-fallback");
			} finally {
				getRoomMutationClient(created.roomDir)?.disconnect();
				deleteRoomMutationClient(created.roomDir);
				await proxy.stop();
			}
		});
	});
});

describe("silent room messages", () => {
	it("does not deliver silent initialization messages as steer events", async () => {
		await withTempDir(async (tempDir) => {
			process.env.PI_ROOM_DELIVERY_DEBOUNCE_MS = "5";
			try {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-silent-delivery",
					cwd: tempDir,
				});
				const sentMessages: unknown[] = [];
				const activeRoom = setActiveRoom({
					role: "owner",
					roomDir: created.roomDir,
					roomId: created.metadata.roomId,
					memberName: created.metadata.ownerName,
					sessionId: "owner-session-silent-delivery",
					pollTimer: null,
					heartbeatTimer: null,
					pendingPoll: null,
					pendingHeartbeat: null,
					pendingToolTasks: new Set(),
					shuttingDown: false,
					pendingDeliveryBatch: [],
					deliveryTimer: null,
				});

				const silentMessage = await appendMessage(created.roomDir, {
					from: "system",
					to: "room",
					broadcast: false,
					replyTo: null,
					kind: "info",
					summary: `Room initialized: ${created.metadata.roomId}`,
					silent: true,
				} as any);

				await processUnreadMessages({
					sendMessage(message: unknown) {
						sentMessages.push(message);
						return undefined;
					},
				} as ExtensionAPI, activeRoom);
				await new Promise((resolve) => setTimeout(resolve, 25));

				assert.equal(sentMessages.length, 0);
				const owner = await loadRoomMemberState(created.roomDir, created.metadata.ownerName);
				assert.equal(owner.lastSeenSeq, silentMessage.seq);
			} finally {
				delete process.env.PI_ROOM_DELIVERY_DEBOUNCE_MS;
			}
		});
	});

	it("still keeps silent initialization messages on the board", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-silent-board",
				cwd: tempDir,
			});

			await appendMessage(created.roomDir, {
				from: "system",
				to: "room",
				broadcast: false,
				replyTo: null,
				kind: "info",
				summary: `Room initialized: ${created.metadata.roomId}`,
				silent: true,
			} as any);

			const board = await listBoardEntries(created.roomDir, 20);
			assert.equal(board.at(-1)?.summary, `Room initialized: ${created.metadata.roomId}`);
			assert.equal((board.at(-1) as { silent?: boolean } | undefined)?.silent, true);
		});
	});
});

describe("lifecycle compatibility guards", () => {
	it("clears a stale member active context when the stored session id no longer matches", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-guard",
				cwd: tempDir,
			});
			await writeRoomMemberState(created.roomDir, {
				name: "worker_1234",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "new-session",
			});

			const staleContext = setActiveRoom({
				role: "member",
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: "worker_1234",
				sessionId: "old-session",
				pollTimer: null,
				heartbeatTimer: null,
				pendingPoll: null,
				pendingHeartbeat: null,
				pendingToolTasks: new Set(),
				shuttingDown: false,
				pendingDeliveryBatch: [],
				deliveryTimer: null,
			});

			await processUnreadMessages({ sendMessage() { return undefined; } } as ExtensionAPI, staleContext);
			assert.equal(getActiveRoom("old-session"), null);
		});
	});

	it("replaces older active contexts for the same room member when a new session claims it", () => {
		const pollTimer = setInterval(() => undefined, 1000);
		const heartbeatTimer = setInterval(() => undefined, 1000);
		const deliveryTimer = setTimeout(() => undefined, 1000);
		try {
			setActiveRoom({
				role: "member",
				roomDir: "/tmp/room-1",
				roomId: "room-1",
				memberName: "worker_1234",
				sessionId: "old-session",
				pollTimer,
				heartbeatTimer,
				pendingPoll: null,
				pendingHeartbeat: null,
				pendingToolTasks: new Set(),
				shuttingDown: false,
				pendingDeliveryBatch: [],
				deliveryTimer,
			});

			setActiveRoom({
				role: "member",
				roomDir: "/tmp/room-1",
				roomId: "room-1",
				memberName: "worker_1234",
				sessionId: "new-session",
				pollTimer: null,
				heartbeatTimer: null,
				pendingPoll: null,
				pendingHeartbeat: null,
				pendingToolTasks: new Set(),
				shuttingDown: false,
				pendingDeliveryBatch: [],
				deliveryTimer: null,
			});

			assert.equal(getActiveRoom("old-session"), null);
			assert.equal(getActiveRoom("new-session")?.memberName, "worker_1234");
		} finally {
			clearActiveRoom("old-session");
			clearActiveRoom("new-session");
		}
	});
});