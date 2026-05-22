import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
	createRoom,
	initializeRoomRuntime,
	listBoardEntries,
	listRoomMembers,
	loadRoomMemberState,
	writeRoomMemberState,
	writeSpawnJob,
	readSpawnJob,
	writeRoomMetadata,
	loadRoomMetadata,
	getRoomPath,
	withRoomMutationLock,
	setRoomMutationClient,
	deleteRoomMutationClient,
} from "./storage.ts";
import {
	executeCrewAdd,
	executeCrewReply,
	executeCrewStop,
	executeCrewTell,
	queueCrewAdd,
} from "./tools.ts";
import { setActiveRoom, clearActiveRoom, resetActiveRoomsForTests, getActiveRoom } from "./lifecycle.ts";
import {
	createPiMemberAdapter,
	createPaseoPiMemberAdapter,
} from "./spawn.ts";
import { SpawnFailedError, ValidationError } from "./errors.ts";
import { MutationProxyServer } from "./mutation-proxy.ts";
import { createMutationClient } from "./mutation-client.ts";
import type { RoomMemberState, RoomSpawnAdapter } from "./types.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "transient-test-"));
	try {
		return await fn(dir);
	} finally {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			try {
				await fs.rm(dir, { recursive: true, force: true });
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (attempt === 19 || (code !== "ENOTEMPTY" && code !== "EBUSY")) throw error;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
	}
}

function setOwnerActiveRoomContext(created: Awaited<ReturnType<typeof createRoom>>, sessionId: string): void {
	setActiveRoom({
		role: "owner",
		roomDir: created.roomDir,
		roomId: created.metadata.roomId,
		memberName: created.metadata.ownerName,
		sessionId,
		pollTimer: null,
		heartbeatTimer: null,
		pendingPoll: null,
		pendingHeartbeat: null,
		pendingToolTasks: new Set<Promise<unknown>>(),
		shuttingDown: false,
		pendingDeliveryBatch: [],
		deliveryTimer: null,
	});
}

function setMemberActiveRoomContext(created: Awaited<ReturnType<typeof createRoom>>, sessionId: string, memberName: string): void {
	setActiveRoom({
		role: "member",
		roomDir: created.roomDir,
		roomId: created.metadata.roomId,
		memberName,
		sessionId,
		pollTimer: null,
		heartbeatTimer: null,
		pendingPoll: null,
		pendingHeartbeat: null,
		pendingToolTasks: new Set<Promise<unknown>>(),
		shuttingDown: false,
		pendingDeliveryBatch: [],
		deliveryTimer: null,
	});
}

describe("transient subagents", () => {
	beforeEach(() => {
		clearActiveRoom();
		resetActiveRoomsForTests();
	});

	it("rejects transient without task", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-transient-no-task";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: sessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, sessionId);

			const result = await executeCrewAdd(
				{ name: "worker", type: "worker", transient: true },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);
			expect(result.isError).toBe(true);
			expect(result.content?.[0]?.text).toContain("transient requires a task parameter");
		});
	});

	it("non-transient is fire-and-forget, returns queued message", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-non-transient";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: sessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, sessionId);

			const result = await executeCrewAdd(
				{ name: "worker", type: "worker", task: "Do something" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);
			expect(result.isError).toBeUndefined();
			const text = result.content?.[0]?.text ?? "";
			expect(text).toContain("Spawn");
			expect(text).toContain("queued for");
			expect(text).not.toContain("Dispatched");

			// Clean up pending spawn
			const activeRoom = getActiveRoom(sessionId);
			if (activeRoom) {
				await Promise.allSettled([...activeRoom.pendingToolTasks]);
			}
		});
	});

	it("blocks until spawn succeeds, returns 'Dispatched' not 'Spawn queued'", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-transient-blocks";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: sessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, sessionId);

			let spawnCalled = false;
			const result = await executeCrewAdd(
				{ name: "worker", type: "worker", task: "Transient task", transient: true },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
				runtimeRoot,
				{
					pi: {
						kind: "pi",
						async isAvailable() { return true; },
						async spawn() {
							spawnCalled = true;
							return { runtimeId: "fake-runtime-transient", backend: "pi" };
						},
					},
					paseo: {
						kind: "paseo",
						async isAvailable() { return false; },
						async spawn() { throw new Error("not used"); },
					},
				} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
				{},
			);
			expect(result.isError).toBeUndefined();
			const text = result.content?.[0]?.text ?? "";
			expect(text).toContain("Dispatched");
			expect(text).not.toContain("queued");
			expect(spawnCalled).toBe(true);
		});
	});

	it("returns error when spawn fails for transient", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-transient-fail";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: sessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, sessionId);

			const result = await executeCrewAdd(
				{ name: "worker", type: "worker", task: "Will fail", transient: true },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
				runtimeRoot,
				{
					pi: {
						kind: "pi",
						async isAvailable() { return true; },
						async spawn() { throw new Error("Simulated spawn failure"); },
					},
					paseo: {
						kind: "paseo",
						async isAvailable() { return false; },
						async spawn() { throw new Error("not used"); },
					},
				} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
				{},
			);
			expect(result.isError).toBe(true);
			const text = result.content?.[0]?.text ?? "";
			expect(text).toContain("Simulated spawn failure");
		});
	});

	it("auto-removes transient member after completion reply", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-transient-auto-remove";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: sessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			const memberName = "transient_0001";
			const memberSessionId = "member-session-transient";
			setOwnerActiveRoomContext(created, sessionId);

			// Directly create a transient member in idle state with transient: true
			await writeRoomMemberState(created.roomDir, {
				name: memberName,
				displayName: "transient",
				type: "worker",
				backend: "pi",
				runtimeId: "fake-runtime-removal",
				state: "idle",
				spawnTaskId: null,
				transient: true,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				chatBusy: false,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: memberSessionId,
			});

			// Send a task to this member
			const tellResult = await executeCrewTell(
				{ to: "transient", summary: "Complete this task", kind: "task" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);
			expect(tellResult.isError).toBeUndefined();
			const tellText = tellResult.content?.[0]?.text ?? "";
			expect(tellText).toContain("seq:");

			// Extract the seq for the task
			const taskSeqMatch = tellText.match(/seq:\s*(\d+)/);
			expect(taskSeqMatch).toBeTruthy();
			const taskSeq = Number(taskSeqMatch![1]);

			// Simulate task delivery: member picks up the task and
			// transitions to "running" with the correct currentTaskMessageId.
			const preReplyBoard = await listBoardEntries(created.roomDir, 20);
			const preReplyTask = preReplyBoard.find((m) => m.kind === "task" && m.seq === taskSeq);
			expect(preReplyTask).toBeTruthy();
			await writeRoomMemberState(created.roomDir, {
				name: memberName,
				displayName: "transient",
				type: "worker",
				backend: "pi",
				runtimeId: "fake-runtime-removal",
				state: "running",
				spawnTaskId: null,
				transient: true,
				currentTask: "Complete this task",
				currentTaskMessageId: preReplyTask!.id,
				lastCompletedTask: null,
				lastError: null,
				chatBusy: false,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: memberSessionId,
			});

			// Set up mutation proxy so member reply can notify owner
			const proxy = new MutationProxyServer(created.roomDir);
			await proxy.start();
			setMemberActiveRoomContext(created, memberSessionId, memberName);
			const client = createMutationClient(created.roomDir);
			await client.connect();
			setRoomMutationClient(created.roomDir, client);

			try {
				const replyResult = await executeCrewReply(
					{ seq: taskSeq, summary: "Task completed", kind: "completion" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => memberSessionId } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);
				expect(replyResult.isError).toBeUndefined();

				// Verify member is removed
				const member = await loadRoomMemberState(created.roomDir, memberName).catch(() => null);
				expect(member?.state).toBe("removed");

				// Verify board notification
				const board = await listBoardEntries(created.roomDir, 20);
				const removalMsg = board.find(
					(m) => m.kind === "info" && m.summary.includes("Transient agent") && m.summary.includes("completed and was removed"),
				);
				expect(removalMsg).toBeTruthy();
			} finally {
				client.disconnect();
				deleteRoomMutationClient(created.roomDir);
				await proxy.stop();
			}
		});
	});

	it("auto-removes transient member after error reply", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-transient-error-remove";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: sessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			const memberName = "transient_err_0002";
			const memberSessionId = "member-session-transient-err";
			setOwnerActiveRoomContext(created, sessionId);

			await writeRoomMemberState(created.roomDir, {
				name: memberName,
				displayName: "transient-err",
				type: "worker",
				backend: "pi",
				runtimeId: "fake-runtime-err",
				state: "idle",
				spawnTaskId: null,
				transient: true,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				chatBusy: false,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: memberSessionId,
			});

			const tellResult = await executeCrewTell(
				{ to: "transient-err", summary: "Error task", kind: "task" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);
			expect(tellResult.isError).toBeUndefined();
			const taskSeqMatch = (tellResult.content?.[0]?.text ?? "").match(/seq:\s*(\d+)/);
			expect(taskSeqMatch).toBeTruthy();
			const taskSeq = Number(taskSeqMatch![1]);

			// Simulate task delivery: member picks up the task and
			// transitions to "running" with the correct currentTaskMessageId.
			const preReplyBoard = await listBoardEntries(created.roomDir, 20);
			const preReplyTask = preReplyBoard.find((m) => m.kind === "task" && m.seq === taskSeq);
			expect(preReplyTask).toBeTruthy();
			await writeRoomMemberState(created.roomDir, {
				name: memberName,
				displayName: "transient-err",
				type: "worker",
				backend: "pi",
				runtimeId: "fake-runtime-err",
				state: "running",
				spawnTaskId: null,
				transient: true,
				currentTask: "Error task",
				currentTaskMessageId: preReplyTask!.id,
				lastCompletedTask: null,
				lastError: null,
				chatBusy: false,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: memberSessionId,
			});

			const proxy = new MutationProxyServer(created.roomDir);
			await proxy.start();
			setMemberActiveRoomContext(created, memberSessionId, memberName);
			const client = createMutationClient(created.roomDir);
			await client.connect();
			setRoomMutationClient(created.roomDir, client);

			try {
				const replyResult = await executeCrewReply(
					{ seq: taskSeq, summary: "Task failed", kind: "error" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => memberSessionId } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);
				expect(replyResult.isError).toBeUndefined();

				const member = await loadRoomMemberState(created.roomDir, memberName).catch(() => null);
				expect(member?.state).toBe("removed");

				const board = await listBoardEntries(created.roomDir, 20);
				const removalMsg = board.find(
					(m) => m.kind === "info" && m.summary.includes("Transient agent") && m.summary.includes("completed and was removed"),
				);
				expect(removalMsg).toBeTruthy();
			} finally {
				client.disconnect();
				deleteRoomMutationClient(created.roomDir);
				await proxy.stop();
			}
		});
	});

	it("skips auto-removal if member was re-tasked between reply and lock", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-transient-skip";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: sessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			const memberName = "transient_keep_0003";
			const memberSessionId = "member-session-transient-skip";
			setOwnerActiveRoomContext(created, sessionId);

			await writeRoomMemberState(created.roomDir, {
				name: memberName,
				displayName: "transient-keep",
				type: "worker",
				backend: "pi",
				runtimeId: "fake-runtime-keep",
				state: "idle",
				spawnTaskId: null,
				transient: true,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				chatBusy: false,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: memberSessionId,
			});

			// Send first task
			const tellResult1 = await executeCrewTell(
				{ to: "transient-keep", summary: "First task", kind: "task" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);
			const taskSeq1Match = (tellResult1.content?.[0]?.text ?? "").match(/seq:\s*(\d+)/);
			expect(taskSeq1Match).toBeTruthy();
			const taskSeq1 = Number(taskSeq1Match![1]);

			// Send second task BEFORE member replies to first (re-tasking)
			const tellResult2 = await executeCrewTell(
				{ to: "transient-keep", summary: "Second task - re-tasked", kind: "task" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);
			// If tell fails (e.g., member busy), simulate re-tasking via direct
			// state update instead. The important thing is the member has a new
			// task before replying to the old one.
			if (tellResult2.isError) {
				// Directly simulate the member having been re-tasked
				await writeRoomMemberState(created.roomDir, {
					name: memberName,
					displayName: "transient-keep",
					type: "worker",
					backend: "pi",
					runtimeId: "fake-runtime-keep",
					state: "running",
					spawnTaskId: null,
					transient: true,
					currentTask: "Second task - re-tasked",
					currentTaskMessageId: "fake-retask-message-id",
					lastCompletedTask: null,
					lastError: null,
					chatBusy: false,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: memberSessionId,
				});
			} else {
				// Extract seq of second task, then simulate the member accepting it
				const taskSeq2Match = (tellResult2.content?.[0]?.text ?? "").match(/seq:\s*(\d+)/);
				expect(taskSeq2Match).toBeTruthy();
				const taskSeq2 = Number(taskSeq2Match![1]);
				// Read the second task's message to get its id, then update the member
				const board = await listBoardEntries(created.roomDir, 20);
				const secondTaskMsg = board.find((m) => m.kind === "task" && m.seq === taskSeq2);
				expect(secondTaskMsg).toBeTruthy();
				// Simulate member accepting the second task
				await writeRoomMemberState(created.roomDir, {
					name: memberName,
					displayName: "transient-keep",
					type: "worker",
					backend: "pi",
					runtimeId: "fake-runtime-keep",
					state: "running",
					spawnTaskId: null,
					transient: true,
					currentTask: "Second task - re-tasked",
					currentTaskMessageId: secondTaskMsg!.id,
					lastCompletedTask: null,
					lastError: null,
					chatBusy: false,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: memberSessionId,
				});
			}

			const proxy = new MutationProxyServer(created.roomDir);
			await proxy.start();
			setMemberActiveRoomContext(created, memberSessionId, memberName);
			const client = createMutationClient(created.roomDir);
			await client.connect();
			setRoomMutationClient(created.roomDir, client);

			try {
				const replyResult = await executeCrewReply(
					{ seq: taskSeq1, summary: "First task done", kind: "completion" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => memberSessionId } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);
				expect(replyResult.isError).toBeUndefined();

				// Member should NOT be removed because it was re-tasked
				const member = await loadRoomMemberState(created.roomDir, memberName).catch(() => null);
				expect(member).toBeTruthy();
				expect(member?.state).not.toBe("removed");
			} finally {
				client.disconnect();
				deleteRoomMutationClient(created.roomDir);
				await proxy.stop();
			}
		});
	});

	it("writes removal notification to board after transient completion", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-transient-notify";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: sessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			const memberName = "transient_notify_0004";
			const memberSessionId = "member-session-transient-notify";
			setOwnerActiveRoomContext(created, sessionId);

			await writeRoomMemberState(created.roomDir, {
				name: memberName,
				displayName: "transient-notify",
				type: "worker",
				backend: "pi",
				runtimeId: "fake-runtime-notify",
				state: "idle",
				spawnTaskId: null,
				transient: true,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				chatBusy: false,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: memberSessionId,
			});

			const tellResult = await executeCrewTell(
				{ to: "transient-notify", summary: "Notify task", kind: "task" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);
			const taskSeqMatch = (tellResult.content?.[0]?.text ?? "").match(/seq:\s*(\d+)/);
			expect(taskSeqMatch).toBeTruthy();
			const taskSeq = Number(taskSeqMatch![1]);

			// Simulate task delivery: member picks up the task and
			// transitions to "running" with the correct currentTaskMessageId.
			const preReplyBoard = await listBoardEntries(created.roomDir, 20);
			const preReplyTask = preReplyBoard.find((m) => m.kind === "task" && m.seq === taskSeq);
			expect(preReplyTask).toBeTruthy();
			await writeRoomMemberState(created.roomDir, {
				name: memberName,
				displayName: "transient-notify",
				type: "worker",
				backend: "pi",
				runtimeId: "fake-runtime-notify",
				state: "running",
				spawnTaskId: null,
				transient: true,
				currentTask: "Notify task",
				currentTaskMessageId: preReplyTask!.id,
				lastCompletedTask: null,
				lastError: null,
				chatBusy: false,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: memberSessionId,
			});

			const proxy = new MutationProxyServer(created.roomDir);
			await proxy.start();
			setMemberActiveRoomContext(created, memberSessionId, memberName);
			const client = createMutationClient(created.roomDir);
			await client.connect();
			setRoomMutationClient(created.roomDir, client);

			try {
				await executeCrewReply(
					{ seq: taskSeq, summary: "Done", kind: "completion" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => memberSessionId } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);

				// Verify board has the removal notification with correct member label
				const board = await listBoardEntries(created.roomDir, 20);
				const members = await listRoomMembers(created.roomDir);
				const targetMember = members.find((m) => m.name === memberName);
				expect(targetMember).toBeTruthy();

				const notification = board.find(
					(m) => m.kind === "info" && m.summary.includes("Transient agent") && m.summary.includes("completed and was removed"),
				);
				expect(notification).toBeTruthy();
				// Notification includes the member label (internal name here since
				// displayName doesn't match the expected prefix pattern)
				expect(notification!.summary).toContain("transient_notify_0004");
			} finally {
				client.disconnect();
				deleteRoomMutationClient(created.roomDir);
				await proxy.stop();
			}
		});
	});

	it("non-transient member is NOT auto-removed after completion", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-non-transient-keep";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: sessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			const memberName = "persistent_0005";
			const memberSessionId = "member-session-persistent";
			setOwnerActiveRoomContext(created, sessionId);

			await writeRoomMemberState(created.roomDir, {
				name: memberName,
				displayName: "persistent",
				type: "worker",
				backend: "pi",
				runtimeId: "fake-runtime-persistent",
				state: "idle",
				spawnTaskId: null,
				transient: null, // explicitly NOT transient
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				chatBusy: false,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: memberSessionId,
			});

			const tellResult = await executeCrewTell(
				{ to: "persistent", summary: "Normal task", kind: "task" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);
			const taskSeqMatch = (tellResult.content?.[0]?.text ?? "").match(/seq:\s*(\d+)/);
			expect(taskSeqMatch).toBeTruthy();
			const taskSeq = Number(taskSeqMatch![1]);

			setMemberActiveRoomContext(created, memberSessionId, memberName);
			await executeCrewReply(
				{ seq: taskSeq, summary: "Done", kind: "completion" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => memberSessionId } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);

			// Member should still exist and NOT be removed
			const member = await loadRoomMemberState(created.roomDir, memberName).catch(() => null);
			expect(member).toBeTruthy();
			expect(member?.state).toBe("idle");
		});
	});

	it("throws SpawnFailedError when transient spawn is cancelled", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-transient-cancelled";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: sessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, sessionId);

			const result = await executeCrewAdd(
				{ name: "worker", type: "worker", task: "Transient task", transient: true },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
				runtimeRoot,
				{
					pi: {
						kind: "pi",
						async isAvailable() { return true; },
						async spawn({ roomDir, memberName }) {
							// Simulate spawn cancellation: mark the spawn job as "failed"
							// before returning. This causes finalized.cancelled=true
							// (currentJob.state === "failed") which throws SpawnFailedError
							// for transient agents.
							const member = await loadRoomMemberState(roomDir, memberName);
							const taskId = member.spawnTaskId;
							if (taskId) {
								const job = await readSpawnJob(roomDir, taskId);
								if (job) {
									await writeSpawnJob(roomDir, { ...job, state: "failed", updatedAt: new Date().toISOString() });
								}
							}
							return { runtimeId: "fake-runtime-cancelled", backend: "pi" };
						},
					},
					paseo: {
						kind: "paseo",
						async isAvailable() { return false; },
						async spawn() { throw new Error("not used"); },
					},
				} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
				{},
			);
			expect(result.isError).toBe(true);
			const text = result.content?.[0]?.text ?? "";
			expect(text).toContain("Spawn cancelled");
		});
	});

	it("auto-removes transient member when crew_cancel is called", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-transient-cancel";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: sessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			const memberName = "transient_cancel_0005";
			const memberSessionId = "member-session-transient-cancel";
			setOwnerActiveRoomContext(created, sessionId);

			// Create transient member in running state with a task
			await writeRoomMemberState(created.roomDir, {
				name: memberName,
				displayName: "transient-cancel",
				type: "worker",
				backend: "pi",
				runtimeId: "fake-runtime-cancel-stop",
				state: "running",
				spawnTaskId: null,
				transient: true,
				currentTask: "Cancellable task",
				currentTaskMessageId: "fake-cancel-task-id",
				lastCompletedTask: null,
				lastError: null,
				chatBusy: false,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: memberSessionId,
			});

			// Call crew_cancel (executeCrewStop) on the transient member
			const stopResult = await executeCrewStop(
				{ name: "transient-cancel" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{ ownerName: "owner" },
			);
			expect(stopResult.isError).toBeUndefined();
			const stopText = stopResult.content?.[0]?.text ?? "";
			expect(stopText).toContain("Cancelled and removed transient agent");

			// Verify member is removed
			const member = await loadRoomMemberState(created.roomDir, memberName).catch(() => null);
			expect(member?.state).toBe("removed");

			// Verify board notification
			const board = await listBoardEntries(created.roomDir, 20);
			const removalMsg = board.find(
				(m) => m.kind === "info" && m.summary.includes("Transient agent") && m.summary.includes("was cancelled and removed"),
			);
			expect(removalMsg).toBeTruthy();
		});
	});

	it("non-transient member is not auto-removed by crew_cancel", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-non-transient-cancel";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: sessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			const memberName = "normal_cancel_0006";
			const memberSessionId = "member-session-normal-cancel";
			setOwnerActiveRoomContext(created, sessionId);

			// Create normal (non-transient) member in running state
			await writeRoomMemberState(created.roomDir, {
				name: memberName,
				displayName: "normal-cancel",
				type: "worker",
				backend: "pi",
				runtimeId: "fake-runtime-normal-cancel",
				state: "running",
				spawnTaskId: null,
				transient: false,
				currentTask: "Normal task",
				currentTaskMessageId: "fake-normal-task-id",
				lastCompletedTask: null,
				lastError: null,
				chatBusy: false,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: memberSessionId,
			});

			// Call crew_cancel on normal member
			const stopResult = await executeCrewStop(
				{ name: "normal-cancel" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{ ownerName: "owner" },
			);
			expect(stopResult.isError).toBeUndefined();

			// Verify member is NOT removed (idle, not removed)
			const member = await loadRoomMemberState(created.roomDir, memberName).catch(() => null);
			expect(member).toBeTruthy();
			expect(member?.state).not.toBe("removed");
		});
	});
});
