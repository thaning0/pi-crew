import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import roomExtension from "./index.ts";
import { withFileLock } from "./lock.ts";
import {
	appendMessage,
	appendDirectedTaskMessage,
	createSpawningMember,
	createRoom,
	createSpawnJob,
	deleteRoomMemberState,
	finalizeMemberRuntime,
	findRoomByOwnerSessionId,
	getMemberHeartbeatPath,
	getRoomMutationLockPath,
	getRoomHeartbeatPath,
	getRoomMemberStatePath,
	getRoomSpawnJobPath,
	listBoardEntries,
	loadRoomMetadata,
	loadRoomMemberState,
	markMemberJoined,
	persistCrewAddReplayEvent,
	readMemberHeartbeat,
	readSpawnJob,
	updateRoomMemberState,
	withRoomMutationLock,
	writeJsonAtomic,
	writeMemberHeartbeat,
	writeRoomMemberState,
} from "./storage.ts";
import { handleStaleOwnerForMember, reapRoom, reapStaleRooms, reconcileMemberLiveness, reconcileSpawnTimeouts } from "./watchdog.ts";
import { buildCrewLifecycleEvent, setCrewEventEmitter } from "./integration-events.ts";
import type { RoomBackend, RoomMemberState, RoomSpawnAdapter } from "./types.ts";
import { createWorktree, git, persistWorktreeSnapshot } from "./worktree.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "room-watchdog-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function createHarness(options: { cwd: string; sessionId: string; extensionOptions?: unknown }) {
	const lifecycleListeners = new Map<string, Array<(event?: unknown, ctx?: unknown) => Promise<void> | void>>();
	const tools = new Map<string, any>();

	(roomExtension as any)(
		{
			events: {
				on() {},
				async emit() {
					return undefined;
				},
			},
			on(eventName: string, handler: (event?: unknown, ctx?: unknown) => Promise<void> | void) {
				const current = lifecycleListeners.get(eventName) ?? [];
				current.push(handler);
				lifecycleListeners.set(eventName, current);
			},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			sendMessage() {
				return undefined;
			},
		},
		options.extensionOptions,
	);

	const ctx = {
		cwd: options.cwd,
		hasUI: true,
		getSystemPrompt: () => "",
		sessionManager: {
			getSessionId: () => options.sessionId,
		},
	};

	return {
		async emit(eventName: string) {
			for (const handler of lifecycleListeners.get(eventName) ?? []) {
				await handler({}, ctx);
			}
		},
		async call(params: unknown) {
			const tool = tools.get("room");
			assert.ok(tool, "expected room tool to be registered");
			return await tool.execute("tool-call-1", params, new AbortController().signal, () => undefined, ctx);
		},
	};
}

async function exists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const stale = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "stale-owner-session",
			cwd: tempDir,
			ownerPid: 999_999,
		});
		await writeRoomMemberState(stale.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-stale",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sessionId: "worker-session-stale",
		});
		await writeJsonAtomic(getRoomHeartbeatPath(stale.roomDir), {
			roomId: stale.metadata.roomId,
			ownerSessionId: stale.metadata.ownerSessionId,
			ownerPid: stale.metadata.ownerPid,
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
		});

		const fresh = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "fresh-owner-session",
			cwd: tempDir,
			ownerPid: process.pid,
		});

		const removedMembers: string[] = [];
		const adapters = {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
				async remove(member) {
					removedMembers.push(member.name);
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
		};

		await reapStaleRooms(runtimeRoot, adapters, { heartbeatStaleMs: 1_000 });

		assert.deepEqual(removedMembers, ["worker"]);
		assert.equal(await exists(stale.roomDir), false);
		assert.equal(await exists(fresh.roomDir), true);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const stale = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "stale-owner-failed-cleanup",
			cwd: tempDir,
			ownerPid: 999_999,
		});
		await writeRoomMemberState(stale.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-stale-failure",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sessionId: "worker-session-stale-failure",
		});
		await writeJsonAtomic(getRoomHeartbeatPath(stale.roomDir), {
			roomId: stale.metadata.roomId,
			ownerSessionId: stale.metadata.ownerSessionId,
			ownerPid: stale.metadata.ownerPid,
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
		});

		await reapStaleRooms(runtimeRoot, {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
				async remove() {
					throw new Error("cleanup failed");
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
		}, { heartbeatStaleMs: 1_000 });

		assert.equal(await exists(stale.roomDir), true);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-spawn-timeout-clean",
			cwd: tempDir,
			ownerPid: process.pid,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: null,
			state: "spawning",
			spawnTaskId: "spawn-timeout-clean",
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			sessionId: null,
		});
		await createSpawnJob(room.roomDir, {
			taskId: "spawn-timeout-clean",
			memberName: "worker",
			backend: "pi",
			state: "starting",
		});
		await writeJsonAtomic(path.join(room.roomDir, "jobs", "spawn-spawn-timeout-clean.json"), {
			taskId: "spawn-timeout-clean",
			memberName: "worker",
			backend: "pi",
			state: "starting",
			createdAt: new Date(Date.now() - 60_000).toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			error: null,
		});

		await reconcileSpawnTimeouts(room.roomDir, {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
		}, { joinTimeoutMs: 1 });

		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "error");
		assert.match(worker.lastError ?? "", /bootstrap claim/i);
		assert.equal(worker.spawnTaskId, null);
		assert.equal((await readSpawnJob(room.roomDir, "spawn-timeout-clean"))?.state, "failed");
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-paseo-external-timeout",
			cwd: tempDir,
			ownerPid: process.pid,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "paseo",
			runtimeId: null,
			state: "spawning",
			spawnTaskId: "spawn-paseo-external-timeout",
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			sessionId: null,
		});
		await createSpawnJob(room.roomDir, {
			taskId: "spawn-paseo-external-timeout",
			memberName: "worker",
			backend: "paseo",
			state: "starting",
		});

		await reconcileSpawnTimeouts(room.roomDir, {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
				async remove() {
					throw new Error("should not remove timed out paseo member");
				},
			} satisfies RoomSpawnAdapter,
		}, { paseoExternalCreateTimeoutMs: 1 });

		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "spawning");
		assert.equal(worker.spawnTaskId, "spawn-paseo-external-timeout");

		const job = await readSpawnJob(room.roomDir, "spawn-paseo-external-timeout");
		assert.equal(job?.state, "timed_out_pending_external_resolution");
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-spawn-timeout-pre-runtime-watermark",
			cwd: tempDir,
			ownerPid: process.pid,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: null,
			state: "spawning",
			spawnTaskId: "spawn-timeout-pre-runtime-watermark",
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			sessionId: null,
		});
		await createSpawnJob(room.roomDir, {
			taskId: "spawn-timeout-pre-runtime-watermark",
			memberName: "worker",
			backend: "pi",
			state: "starting",
		});
		await writeJsonAtomic(path.join(room.roomDir, "jobs", "spawn-spawn-timeout-pre-runtime-watermark.json"), {
			taskId: "spawn-timeout-pre-runtime-watermark",
			memberName: "worker",
			backend: "pi",
			state: "starting",
			createdAt: new Date(Date.now() - 60_000).toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			error: null,
		});

		const pendingTask = await appendDirectedTaskMessage(room.roomDir, {
			from: "owner",
			to: "worker",
			replyTo: null,
			summary: "Queued before timeout cleanup",
		});

		await reconcileSpawnTimeouts(room.roomDir, {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
		}, { joinTimeoutMs: 1 });

		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "error");
		assert.equal(worker.runtimeId, null);
		assert.equal(worker.sessionId, null);
		assert.equal(worker.currentTask, null);
		assert.equal(worker.currentTaskMessageId, null);
		assert.equal(worker.lastSeenSeq, pendingTask.seq);

		await assert.rejects(
			() => createSpawningMember(room.roomDir, {
				name: "worker",
				type: "worker",
				backend: "pi",
				taskId: "spawn-timeout-pre-runtime-watermark-respawn",
			}),
			/already exists/i,
		);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-spawn-timeout-watermark",
			cwd: tempDir,
			ownerPid: process.pid,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-timeout-watermark",
			state: "spawning",
			spawnTaskId: "spawn-timeout-watermark",
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			sessionId: null,
		});
		await createSpawnJob(room.roomDir, {
			taskId: "spawn-timeout-watermark",
			memberName: "worker",
			backend: "pi",
			state: "starting",
		});
		await writeJsonAtomic(path.join(room.roomDir, "jobs", "spawn-spawn-timeout-watermark.json"), {
			taskId: "spawn-timeout-watermark",
			memberName: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-timeout-watermark",
			state: "starting",
			createdAt: new Date(Date.now() - 60_000).toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			error: null,
		});

		const pendingTask = await appendDirectedTaskMessage(room.roomDir, {
			from: "owner",
			to: "worker",
			replyTo: null,
			summary: "Old task should not replay",
		});

		await reconcileSpawnTimeouts(room.roomDir, {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
				async remove() {
					return;
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
		}, { joinTimeoutMs: 1 });

		await assert.rejects(
			() => createSpawningMember(room.roomDir, {
				name: "worker",
				type: "worker",
				backend: "pi",
				taskId: "spawn-timeout-watermark-respawn",
			}),
			/already exists/i,
		);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-spawn-timeout-remove-race",
			cwd: tempDir,
			ownerPid: process.pid,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-timeout-remove-race",
			state: "spawning",
			spawnTaskId: "spawn-timeout-remove-race",
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			sessionId: null,
		});
		await createSpawnJob(room.roomDir, {
			taskId: "spawn-timeout-remove-race",
			memberName: "worker",
			backend: "pi",
			state: "starting",
		});
		await writeJsonAtomic(path.join(room.roomDir, "jobs", "spawn-spawn-timeout-remove-race.json"), {
			taskId: "spawn-timeout-remove-race",
			memberName: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-timeout-remove-race",
			state: "starting",
			createdAt: new Date(Date.now() - 60_000).toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			error: null,
		});

		let releaseCleanup!: () => void;
		let cleanupStarted!: () => void;
		const cleanupBlocked = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		const cleanupReached = new Promise<void>((resolve) => {
			cleanupStarted = resolve;
		});
		const ownerHarness = createHarness({
			cwd: tempDir,
			sessionId: "owner-session-spawn-timeout-remove-race",
			extensionOptions: { runtimeRoot },
		});

		const watchdogRun = reconcileSpawnTimeouts(room.roomDir, {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
				async remove() {
					cleanupStarted();
					await cleanupBlocked;
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
		}, { joinTimeoutMs: 1 });

		await cleanupReached;
		const removeResult = await ownerHarness.call({ remove: { name: "worker" } });
		assert.equal(removeResult.isError, undefined);
		releaseCleanup();
		await watchdogRun;

		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "removed");
		assert.equal(worker.runtimeId, null);
		assert.equal(worker.sessionId, null);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-spawn-timeout-error",
			cwd: tempDir,
			ownerPid: process.pid,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-timeout",
			state: "spawning",
			spawnTaskId: "spawn-timeout-error",
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			sessionId: null,
		});
		await writeJsonAtomic(path.join(room.roomDir, "jobs", "spawn-spawn-timeout-error.json"), {
			taskId: "spawn-timeout-error",
			memberName: "worker",
			backend: "pi",
			state: "starting",
			createdAt: new Date(Date.now() - 60_000).toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			error: null,
		});

		await reconcileSpawnTimeouts(room.roomDir, {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
				async remove() {
					throw new Error("cleanup failed");
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
		}, { joinTimeoutMs: 1 });

		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "error");
		assert.match(worker.lastError ?? "", /bootstrap claim/i);
		assert.equal((await readSpawnJob(room.roomDir, "spawn-timeout-error"))?.state, "failed");
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-spawn-timeout-race",
			cwd: tempDir,
			ownerPid: process.pid,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-timeout-race",
			state: "spawning",
			spawnTaskId: "spawn-timeout-race",
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			sessionId: null,
		});
		const jobPath = path.join(room.roomDir, "jobs", "spawn-spawn-timeout-race.json");
		await writeJsonAtomic(jobPath, {
			taskId: "spawn-timeout-race",
			memberName: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-timeout-race",
			state: "starting",
			createdAt: new Date(Date.now() - 60_000).toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			error: null,
		});

		let releaseLock: (() => void) | null = null;
		let markHeld: (() => void) | null = null;
		const held = new Promise<void>((resolve) => {
			markHeld = resolve;
		});
		const blocker = withFileLock(getRoomMutationLockPath(room.roomDir), room.metadata.roomId, async () => {
			markHeld?.();
			await new Promise<void>((resolve) => {
				releaseLock = resolve;
			});
		});
		await held;

		const reconcilePromise = reconcileSpawnTimeouts(room.roomDir, {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
				async remove() {
					throw new Error("should not remove claimed member");
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
		}, { joinTimeoutMs: 1 });

		await new Promise((resolve) => setTimeout(resolve, 50));
		await writeJsonAtomic(jobPath, {
			taskId: "spawn-timeout-race",
			memberName: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-timeout-race",
			state: "completed",
			createdAt: new Date(Date.now() - 60_000).toISOString(),
			updatedAt: new Date().toISOString(),
			error: null,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-timeout-race",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sessionId: "worker-session-timeout-race",
		});
		releaseLock?.();
		await blocker;
		await reconcilePromise;

		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "idle");
		assert.equal(worker.sessionId, "worker-session-timeout-race");
		assert.equal((await readSpawnJob(room.roomDir, "spawn-timeout-race"))?.state, "completed");
	});

	for (const state of ["claimed", "external_created"] as const) {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const room = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: `owner-session-${state}`,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			await writeRoomMemberState(room.roomDir, {
				name: "worker",
				type: "worker",
				backend: "paseo",
				runtimeId: state === "external_created" ? "paseo-runtime" : null,
				state: "spawning",
				spawnTaskId: `spawn-timeout-${state}`,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date(Date.now() - 60_000).toISOString(),
				sessionId: state === "claimed" ? "worker-session-claimed" : null,
				bootstrapClaimedAt: state === "claimed" ? new Date(Date.now() - 30_000).toISOString() : null,
				runtimeIdentitySource: state === "external_created" ? "owner" : "none",
			});
			await createSpawnJob(room.roomDir, {
				taskId: `spawn-timeout-${state}`,
				memberName: "worker",
				backend: "paseo",
				state,
			});

			await reconcileSpawnTimeouts(room.roomDir, {
				pi: {
					kind: "pi",
					async spawn() {
						throw new Error("not used");
					},
				} satisfies RoomSpawnAdapter,
				paseo: {
					kind: "paseo",
					async spawn() {
						throw new Error("not used");
					},
					async remove() {
						throw new Error(`should not remove ${state} member`);
					},
				} satisfies RoomSpawnAdapter,
			}, { paseoBootstrapClaimTimeoutMs: 1 });

			const worker = await loadRoomMemberState(room.roomDir, "worker");
			assert.equal(worker.state, "spawning");
			assert.equal(worker.spawnTaskId, `spawn-timeout-${state}`);

			const job = await readSpawnJob(room.roomDir, `spawn-timeout-${state}`);
			assert.equal(job?.state, "timed_out_pending_member_claim");
		});
	}

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-member-liveness-pi",
			cwd: tempDir,
			ownerPid: process.pid,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "999999",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sessionId: "worker-session-dead-pi",
		});

		await reconcileMemberLiveness(room.roomDir, {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
		});

		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "error");
		assert.equal(worker.runtimeId, null);
		assert.equal(worker.sessionId, null);
		assert.match(worker.lastError ?? "", /runtime|heartbeat/i);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-member-liveness-paseo",
			cwd: tempDir,
			ownerPid: process.pid,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "paseo",
			runtimeId: "paseo-dead-runtime",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			sessionId: "worker-session-dead-paseo",
		});

		const removed: string[] = [];
		await reconcileMemberLiveness(room.roomDir, {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
				async remove(member) {
					removed.push(member.name);
				},
			} satisfies RoomSpawnAdapter,
		}, { memberHeartbeatStaleMs: 1_000 });

		assert.deepEqual(removed, ["worker"]);
		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "removed");
		assert.equal(worker.runtimeId, null);
		assert.equal(worker.sessionId, null);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-member-liveness-heartbeat",
			cwd: tempDir,
			ownerPid: process.pid,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "paseo",
			runtimeId: "paseo-heartbeat-dead-runtime",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sessionId: "worker-session-heartbeat",
		});
		const workerPath = getRoomMemberStatePath(room.roomDir, "worker");
		const currentWorker = JSON.parse(await fs.readFile(workerPath, "utf8")) as Record<string, unknown>;
		await writeJsonAtomic(workerPath, {
			...currentWorker,
			heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
			updatedAt: new Date().toISOString(),
			currentTask: "owner-side touch should not count as heartbeat",
		});

		const removed: string[] = [];
		await reconcileMemberLiveness(room.roomDir, {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
				async remove(member) {
					removed.push(member.name);
				},
			} satisfies RoomSpawnAdapter,
		}, { memberHeartbeatStaleMs: 1_000 });

		assert.deepEqual(removed, ["worker"]);
		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "removed");
		assert.equal(worker.sessionId, null);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-member-liveness-respawn-window",
			cwd: tempDir,
			ownerPid: process.pid,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker_old",
			type: "worker",
			backend: "paseo",
			runtimeId: null,
			state: "error",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: "old worker died",
			lastSeenSeq: 0,
			joinedAt: new Date(Date.now() - 120_000).toISOString(),
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
			heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
			sessionId: null,
		});
		await createSpawningMember(room.roomDir, {
			name: "worker",
			displayName: "worker-next",
			type: "worker",
			backend: "paseo",
			taskId: "spawn-respawn-window",
			bootstrapToken: "respawn-window-token",
		});
		await markMemberJoined({
			bootstrap: {
				version: 1,
				roomId: room.metadata.roomId,
				roomDir: room.roomDir,
				memberName: "worker",
				memberType: "worker",
				ownerName: room.metadata.ownerName,
				ownerSessionId: room.metadata.ownerSessionId,
				token: "respawn-window-token",
				spawnTaskId: "spawn-respawn-window",
			},
			sessionId: "worker-session-respawn-window",
			runtimeId: "paseo-respawn-window-runtime",
			backend: "paseo",
		});

		const removed: string[] = [];
		await reconcileMemberLiveness(room.roomDir, {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
				async remove(member) {
					removed.push(member.name);
				},
			} satisfies RoomSpawnAdapter,
		}, { memberHeartbeatStaleMs: 1_000 });

		assert.deepEqual(removed, []);
		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "idle");
		assert.equal(worker.sessionId, "worker-session-respawn-window");
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-member-stale",
			cwd: tempDir,
			ownerPid: 999_999,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-member",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sessionId: "worker-session-member-stale",
		});
		await writeJsonAtomic(getRoomHeartbeatPath(room.roomDir), {
			roomId: room.metadata.roomId,
			ownerSessionId: room.metadata.ownerSessionId,
			ownerPid: room.metadata.ownerPid,
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
		});

		const stoppedMembers: string[] = [];
		const handled = await handleStaleOwnerForMember(
			room.roomDir,
			"worker",
			{
				pi: {
					kind: "pi",
					async spawn() {
						throw new Error("not used");
					},
					async stop(member) {
						stoppedMembers.push(member.name);
					},
				} satisfies RoomSpawnAdapter,
				paseo: {
					kind: "paseo",
					async spawn() {
						throw new Error("not used");
					},
				} satisfies RoomSpawnAdapter,
			},
			{ heartbeatStaleMs: 1 },
		);

		assert.equal(handled, true);
		assert.deepEqual(stoppedMembers, ["worker"]);
		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "removed");
		assert.equal(worker.runtimeId, null);
		assert.equal(worker.sessionId, null);
		assert.match(worker.lastError ?? "", /Owner heartbeat stale/);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-member-stale-stop-failure",
			cwd: tempDir,
			ownerPid: 999_999,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-member-stop-failure",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sessionId: "worker-session-member-stop-failure",
		});
		await writeJsonAtomic(getRoomHeartbeatPath(room.roomDir), {
			roomId: room.metadata.roomId,
			ownerSessionId: room.metadata.ownerSessionId,
			ownerPid: room.metadata.ownerPid,
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
		});

		const handled = await handleStaleOwnerForMember(
			room.roomDir,
			"worker",
			{
				pi: {
					kind: "pi",
					async spawn() {
						throw new Error("not used");
					},
					async stop() {
						throw new Error("stop failed");
					},
				} satisfies RoomSpawnAdapter,
				paseo: {
					kind: "paseo",
					async spawn() {
						throw new Error("not used");
					},
				} satisfies RoomSpawnAdapter,
			},
			{ heartbeatStaleMs: 1 },
		);

		assert.equal(handled, true);
		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "error");
		assert.equal(worker.runtimeId, "pi-runtime-member-stop-failure");
		assert.equal(worker.sessionId, null);
		assert.match(worker.lastError ?? "", /requires reaping/i);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-member-stale-paseo",
			cwd: tempDir,
			ownerPid: 999_999,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "paseo",
			runtimeId: "paseo-runtime-member",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sessionId: "worker-session-member-stale-paseo",
		});
		await writeJsonAtomic(getRoomHeartbeatPath(room.roomDir), {
			roomId: room.metadata.roomId,
			ownerSessionId: room.metadata.ownerSessionId,
			ownerPid: room.metadata.ownerPid,
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
		});

		const removedMembers: string[] = [];
		const stoppedMembers: string[] = [];
		const handled = await handleStaleOwnerForMember(
			room.roomDir,
			"worker",
			{
				pi: {
					kind: "pi",
					async spawn() {
						throw new Error("not used");
					},
				} satisfies RoomSpawnAdapter,
				paseo: {
					kind: "paseo",
					async spawn() {
						throw new Error("not used");
					},
					async stop(member) {
						stoppedMembers.push(member.name);
					},
					async remove(member) {
						removedMembers.push(member.name);
					},
				} satisfies RoomSpawnAdapter,
			},
			{ heartbeatStaleMs: 1 },
		);

		assert.equal(handled, true);
		assert.deepEqual(removedMembers, ["worker"]);
		assert.deepEqual(stoppedMembers, []);
		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "removed");
		assert.equal(worker.runtimeId, null);
		assert.equal(worker.sessionId, null);
		assert.match(worker.lastError ?? "", /Owner heartbeat stale/);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-member-stale-ordering",
			cwd: tempDir,
			ownerPid: 999_999,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-member-ordering",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sessionId: "worker-session-member-ordering",
		});
		await writeJsonAtomic(getRoomHeartbeatPath(room.roomDir), {
			roomId: room.metadata.roomId,
			ownerSessionId: room.metadata.ownerSessionId,
			ownerPid: room.metadata.ownerPid,
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
		});

		await handleStaleOwnerForMember(
			room.roomDir,
			"worker",
			{
				pi: {
					kind: "pi",
					async spawn() {
						throw new Error("not used");
					},
					async stop(member) {
						const current = await loadRoomMemberState(room.roomDir, member.name);
						assert.equal(current.state, "removed");
						assert.match(current.lastError ?? "", /Owner heartbeat stale/);
					},
				} satisfies RoomSpawnAdapter,
				paseo: {
					kind: "paseo",
					async spawn() {
						throw new Error("not used");
					},
				} satisfies RoomSpawnAdapter,
			},
			{ heartbeatStaleMs: 1 },
		);

		const worker = await loadRoomMemberState(room.roomDir, "worker");
		assert.equal(worker.state, "removed");
		assert.equal(worker.runtimeId, null);
		assert.equal(worker.sessionId, null);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const removedMembers: string[] = [];
		let releaseHeartbeatWrite: (() => void) | null = null;
		let markHeartbeatWriteStarted: (() => void) | null = null;
		const heartbeatWriteStarted = new Promise<void>((resolve) => {
			markHeartbeatWriteStarted = resolve;
		});
		const harness = createHarness({
			cwd: tempDir,
			sessionId: "owner-session-shutdown",
			extensionOptions: {
				runtimeRoot,
				beforeOwnerHeartbeatWrite: async () => {
					markHeartbeatWriteStarted?.();
					await new Promise<void>((resolve) => {
						releaseHeartbeatWrite = resolve;
					});
				},
				adapters: {
					pi: {
						kind: "pi",
						async spawn() {
							throw new Error("not used");
						},
						async remove(member: RoomMemberState) {
							removedMembers.push(member.name);
						},
					} satisfies RoomSpawnAdapter,
					paseo: {
						kind: "paseo",
						async spawn() {
							throw new Error("not used");
						},
					} satisfies RoomSpawnAdapter,
				},
			},
		});

		await harness.call({ create: true });
		const ownerRoom = await findRoomByOwnerSessionId(runtimeRoot, "owner-session-shutdown");
		assert.ok(ownerRoom, "expected owner room to exist");
		await heartbeatWriteStarted;
		await writeRoomMemberState(ownerRoom!.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-owner-shutdown",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sessionId: "worker-session-owner-shutdown",
		});

		const shutdown = harness.emit("session_shutdown");
		setTimeout(() => {
			releaseHeartbeatWrite?.();
		}, 50);
		await shutdown;
		await new Promise((resolve) => setTimeout(resolve, 75));
		assert.deepEqual(removedMembers, ["worker"]);
		assert.equal(await exists(ownerRoom!.roomDir), false);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const harness = createHarness({
			cwd: tempDir,
			sessionId: "owner-session-shutdown-race",
			extensionOptions: {
				runtimeRoot,
				adapters: {
					pi: {
						kind: "pi",
						async spawn() {
							throw new Error("not used");
						},
						async remove() {
							await new Promise((resolve) => setTimeout(resolve, 300));
						},
					} satisfies RoomSpawnAdapter,
					paseo: {
						kind: "paseo",
						async spawn() {
							throw new Error("not used");
						},
					} satisfies RoomSpawnAdapter,
				},
			},
		});

		await harness.call({ create: true });
		const ownerRoom = await findRoomByOwnerSessionId(runtimeRoot, "owner-session-shutdown-race");
		assert.ok(ownerRoom, "expected owner room to exist");
		await writeRoomMemberState(ownerRoom!.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-owner-shutdown-race",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sessionId: "worker-session-owner-shutdown-race",
		});

		await harness.emit("session_shutdown");
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(await exists(ownerRoom!.roomDir), false);
	});

	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const room = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session-reap-no-lock-inversion",
			cwd: tempDir,
			ownerPid: process.pid,
		});
		await writeRoomMemberState(room.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-reap-no-lock-inversion",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sessionId: "worker-session-reap-no-lock-inversion",
		});

		const deleted = await reapRoom(room.roomDir, {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
				async remove(member) {
					await withRoomMutationLock(room.roomDir, async () => {
						const current = await loadRoomMemberState(room.roomDir, member.name);
						assert.equal(current.runtimeId, "pi-runtime-reap-no-lock-inversion");
					}, { timeoutMs: 100, retryIntervalMs: 5 });
				},
			} satisfies RoomSpawnAdapter,
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
			} satisfies RoomSpawnAdapter,
		});

		assert.equal(deleted, true);
		assert.equal(await exists(room.roomDir), false);
	});
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

// === Heartbeat-based liveness tests ===

async function createTestRoom(): Promise<{ roomDir: string; runtimeRoot: string }> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "room-wd-hb-test-"));
	const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
	const created = await createRoom({
		runtimeRoot,
		ownerName: "owner",
		ownerSessionId: `wd-hb-session-${Math.random().toString(36).slice(2)}`,
		cwd: tempDir,
		ownerPid: process.pid,
	});
	return { roomDir: created.roomDir, runtimeRoot };
}

async function createGitBackedTestRoom(): Promise<{ roomDir: string; runtimeRoot: string; cwd: string }> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "room-wd-git-test-"));
	await git(["init"], tempDir, 10_000);
	await git(["config", "user.name", "Watchdog Test"], tempDir, 10_000);
	await git(["config", "user.email", "watchdog-test@example.com"], tempDir, 10_000);
	await fs.writeFile(path.join(tempDir, "README.md"), "seed\n", "utf8");
	await git(["add", "README.md"], tempDir, 10_000);
	await git(["commit", "-m", "seed"], tempDir, 10_000);

	const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
	const created = await createRoom({
		runtimeRoot,
		ownerName: "owner",
		ownerSessionId: `wd-git-session-${Math.random().toString(36).slice(2)}`,
		cwd: tempDir,
		ownerPid: process.pid,
	});

	return { roomDir: created.roomDir, runtimeRoot, cwd: tempDir };
}

async function createTestMember(roomDir: string, name: string, state: string, backend: RoomBackend = "pi"): Promise<void> {
	await writeRoomMemberState(roomDir, {
		name,
		type: "worker",
		backend,
		runtimeId: backend === "paseo" ? "paseo-agent-" + name : "pi-runtime-" + name,
		state,
		spawnTaskId: null,
		currentTask: null,
		currentTaskMessageId: null,
		lastCompletedTask: null,
		lastError: null,
		lastSeenSeq: 0,
		joinedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		sessionId: name + "-session",
	});
}

async function seedReplayableJoinedMember(options: {
	roomDir: string;
	roomId: string;
	ownerSessionId: string;
	memberName: string;
	taskId: string;
	requestId: string;
	activation?: "immediate" | "manual";
	holdTimeoutMs?: number | null;
}) {
	const activation = options.activation ?? "immediate";
	await createSpawningMember(options.roomDir, {
		name: options.memberName,
		displayName: options.memberName,
		type: "worker",
		backend: "pi",
		taskId: options.taskId,
		bootstrapToken: `bootstrap-${options.taskId}`,
		requestReplay: {
			requestId: options.requestId,
			requestedName: options.memberName,
			type: "worker",
			model: null,
			task: null,
			transient: false,
			metadata: { source: "watchdog-terminal" },
			activation,
			holdTimeoutMs: options.holdTimeoutMs ?? null,
		},
	} as never);
	await markMemberJoined({
		bootstrap: {
			version: 1,
			roomId: options.roomId,
			roomDir: options.roomDir,
			memberName: options.memberName,
			memberType: "worker",
			ownerName: "owner",
			ownerSessionId: options.ownerSessionId,
			token: `bootstrap-${options.taskId}`,
			spawnTaskId: options.taskId,
		},
		sessionId: `${options.memberName}-session`,
		runtimeId: String(process.pid),
		backend: "pi",
	});
}

function createPiAdapter(overrides?: Partial<RoomSpawnAdapter>): RoomSpawnAdapter {
	return {
		kind: "pi",
		async spawn() { throw new Error("not used"); },
		...overrides,
	} as RoomSpawnAdapter;
}

function getOwnerIndexPathForTest(runtimeRoot: string, ownerSessionId: string): string {
	return path.join(runtimeRoot, "owners", `${Buffer.from(ownerSessionId, "utf8").toString("hex")}.json`);
}

const adapters = {
	pi: createPiAdapter(),
	paseo: {
		kind: "paseo",
		async spawn() { throw new Error("not used"); },
	} satisfies RoomSpawnAdapter,
};

describe("stale room reaping", () => {
	it("reapRoom refuses to delete a room that is still active and fresh", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const room = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-fresh-recheck",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			const deleted = await reapRoom(room.roomDir, adapters);

			expect(deleted).toBe(false);
			expect(await exists(room.roomDir)).toBe(true);
		});
	});

	it("reapRoom aborts deletion if the room becomes fresh again during cleanup", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const room = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-refresh-during-reap",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			await writeRoomMemberState(room.roomDir, {
				name: "worker",
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
				sessionId: "worker-session",
			});
			await writeJsonAtomic(getRoomHeartbeatPath(room.roomDir), {
				roomId: room.metadata.roomId,
				ownerSessionId: room.metadata.ownerSessionId,
				ownerPid: process.pid,
				updatedAt: new Date(Date.now() - 60_000).toISOString(),
			});

			let releaseCleanup: (() => void) | null = null;
			const cleanupBlocked = new Promise<void>((resolve) => {
				releaseCleanup = resolve;
			});
			let cleanupStarted = false;
			const blockingAdapters = {
				pi: createPiAdapter({
					async remove() {
						cleanupStarted = true;
						await cleanupBlocked;
					},
				}),
				paseo: adapters.paseo,
			};

			const reapPromise = reapRoom(room.roomDir, blockingAdapters);
			while (!cleanupStarted) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			await writeJsonAtomic(getRoomHeartbeatPath(room.roomDir), {
				roomId: room.metadata.roomId,
				ownerSessionId: room.metadata.ownerSessionId,
				ownerPid: process.pid,
				updatedAt: new Date().toISOString(),
			});
			releaseCleanup?.();

			const deleted = await reapPromise;

			expect(deleted).toBe(false);
			expect(await exists(room.roomDir)).toBe(true);
			expect((await loadRoomMetadata(room.roomDir)).state).toBe("active");
		});
	});

	it("reapStaleRooms skips excluded roomIds and ownerSessionIds", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const current = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-current",
				cwd: tempDir,
				ownerPid: 999_999,
			});
			const shadow = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-current",
				cwd: tempDir,
				ownerPid: 999_999,
			});
			const staleOther = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-other",
				cwd: tempDir,
				ownerPid: 999_999,
			});

			for (const room of [current, shadow, staleOther]) {
				await writeJsonAtomic(getRoomHeartbeatPath(room.roomDir), {
					roomId: room.metadata.roomId,
					ownerSessionId: room.metadata.ownerSessionId,
					ownerPid: room.metadata.ownerPid,
					updatedAt: new Date(Date.now() - 60_000).toISOString(),
				});
			}

			const reaped = await reapStaleRooms(runtimeRoot, adapters, {
				heartbeatStaleMs: 1_000,
				excludeRoomIds: new Set([current.metadata.roomId]),
				excludeOwnerSessionIds: new Set([current.metadata.ownerSessionId]),
			} as any);

			expect(reaped).toContain(staleOther.metadata.roomId);
			expect(reaped).not.toContain(current.metadata.roomId);
			expect(await exists(current.roomDir)).toBe(true);
			expect(await exists(shadow.roomDir)).toBe(true);
			expect(await exists(staleOther.roomDir)).toBe(false);
		});
	});

	it("reapRoom clears the owner index when the room is deleted", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-clear-index-on-reap";
			const room = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: 999_999,
			});
			await writeJsonAtomic(getRoomHeartbeatPath(room.roomDir), {
				roomId: room.metadata.roomId,
				ownerSessionId,
				ownerPid: room.metadata.ownerPid,
				updatedAt: new Date(Date.now() - 60_000).toISOString(),
			});

			expect(await reapRoom(room.roomDir, adapters)).toBe(true);
			expect(await exists(getOwnerIndexPathForTest(runtimeRoot, ownerSessionId))).toBe(false);
			expect(await findRoomByOwnerSessionId(runtimeRoot, ownerSessionId)).toBeNull();
		});
	});

	it("reapStaleRooms emits terminated when stale cleanup destroys an active generation", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const room = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-stale-terminal",
				cwd: tempDir,
				ownerPid: 999_999,
			});
			await seedReplayableJoinedMember({
				roomDir: room.roomDir,
				roomId: room.metadata.roomId,
				ownerSessionId: room.metadata.ownerSessionId,
				memberName: "worker",
				taskId: "spawn-stale-terminal",
				requestId: "req-stale-terminal",
			});
			await writeJsonAtomic(getRoomHeartbeatPath(room.roomDir), {
				roomId: room.metadata.roomId,
				ownerSessionId: room.metadata.ownerSessionId,
				ownerPid: room.metadata.ownerPid,
				updatedAt: new Date(Date.now() - 60_000).toISOString(),
			});

			const emit = vi.fn(async () => undefined);
			setCrewEventEmitter(emit);
			try {
				await reapStaleRooms(runtimeRoot, {
					pi: createPiAdapter({
						async remove() {
							return;
						},
					}),
					paseo: adapters.paseo,
				}, { heartbeatStaleMs: 1_000 });
			} finally {
				setCrewEventEmitter(null);
			}

			const terminalPayloads = emit.mock.calls
				.map(([payload]) => payload as Record<string, unknown>)
				.filter((payload) => payload.event === "terminated");
			expect(terminalPayloads).toHaveLength(1);
			expect(terminalPayloads[0]).toMatchObject({
				event: "terminated",
				phase: "runtime",
				request_id: "req-stale-terminal",
				member_target: "worker",
				spawn_task_id: "spawn-stale-terminal",
				delivery_state: "ended",
				reason: "watchdog_cleanup",
			});
		});
	});
});

describe("held generation expiry", () => {
	it("reconcileMemberLiveness aborts expired held generations without terminated", async () => {
		const result = await createTestRoom();
		const roomDir = result.roomDir;
		const metadata = await loadRoomMetadata(roomDir);
		await seedReplayableJoinedMember({
			roomDir,
			roomId: metadata.roomId,
			ownerSessionId: metadata.ownerSessionId,
			memberName: "held-expiry-worker",
			taskId: "spawn-held-expiry",
			requestId: "req-held-expiry",
			activation: "manual",
			holdTimeoutMs: 1,
		});
		const expiredAt = new Date(Date.now() - 5_000).toISOString();
		await persistCrewAddReplayEvent({
			roomDir,
			requestId: "req-held-expiry",
			event: buildCrewLifecycleEvent({
				event: "claimed",
				phase: "delivery",
				request_id: "req-held-expiry",
				command_id: null,
				requested_name: "held-expiry-worker",
				member_target: "held-expiry-worker",
				member_type: "worker",
				room_id: metadata.roomId,
				spawn_task_id: "spawn-held-expiry",
				runtime_id: String(process.pid),
				activation: "manual",
				metadata: { source: "watchdog-terminal" },
				delivery_state: "held",
				hold_expires_at: expiredAt,
				error: null,
				reason: null,
			}),
		});

		const emit = vi.fn(async () => undefined);
		setCrewEventEmitter(emit);
		try {
			await reconcileMemberLiveness(roomDir, { pi: createPiAdapter(), paseo: adapters.paseo }, {
				memberHeartbeatStaleMs: 5_000,
			});
		} finally {
			setCrewEventEmitter(null);
		}

		const payloads = emit.mock.calls.map(([payload]) => payload as Record<string, unknown>);
		expect(payloads).toContainEqual(
			expect.objectContaining({
				event: "aborted",
				phase: "activation",
				request_id: "req-held-expiry",
				spawn_task_id: "spawn-held-expiry",
				reason: "hold_expired",
				delivery_state: "ended",
			}),
		);
		expect(
			payloads.filter(
				(payload) => payload.event === "terminated" && payload.spawn_task_id === "spawn-held-expiry",
			),
		).toHaveLength(0);
		await expect(loadRoomMemberState(roomDir, "held-expiry-worker")).resolves.toMatchObject({
			state: "removed",
			sessionId: null,
			runtimeId: null,
		});
	});

	it("reconcileMemberLiveness aborts expired held generations without request ids", async () => {
		const result = await createTestRoom();
		const roomDir = result.roomDir;
		const metadata = await loadRoomMetadata(roomDir);
		await createSpawningMember(roomDir, {
			name: "held-expiry-requestless-worker",
			displayName: "held-expiry-requestless-worker",
			type: "worker",
			backend: "pi",
			taskId: "spawn-held-expiry-requestless",
			bootstrapToken: "bootstrap-held-expiry-requestless",
		} as never);
		await markMemberJoined({
			bootstrap: {
				version: 1,
				roomId: metadata.roomId,
				roomDir,
				memberName: "held-expiry-requestless-worker",
				memberType: "worker",
				ownerName: "owner",
				ownerSessionId: metadata.ownerSessionId,
				token: "bootstrap-held-expiry-requestless",
				spawnTaskId: "spawn-held-expiry-requestless",
			},
			sessionId: "held-expiry-requestless-worker-session",
			runtimeId: String(process.pid),
			backend: "pi",
		});
		const job = await readSpawnJob(roomDir, "spawn-held-expiry-requestless");
		expect(job).toBeTruthy();
		const expiredAt = new Date(Date.now() - 5_000).toISOString();
		await writeJsonAtomic(getRoomSpawnJobPath(roomDir, "spawn-held-expiry-requestless"), {
			...job,
			deliveryActivation: "manual",
			deliveryState: "held",
			holdExpiresAt: expiredAt,
			updatedAt: new Date().toISOString(),
		});

		const emit = vi.fn(async () => undefined);
		setCrewEventEmitter(emit);
		try {
			await reconcileMemberLiveness(roomDir, { pi: createPiAdapter(), paseo: adapters.paseo }, {
				memberHeartbeatStaleMs: 5_000,
			});
		} finally {
			setCrewEventEmitter(null);
		}

		const payloads = emit.mock.calls.map(([payload]) => payload as Record<string, unknown>);
		expect(payloads).toContainEqual(
			expect.objectContaining({
				event: "aborted",
				phase: "activation",
				request_id: null,
				spawn_task_id: "spawn-held-expiry-requestless",
				reason: "hold_expired",
				delivery_state: "ended",
			}),
		);
		expect(
			payloads.filter(
				(payload) => payload.event === "terminated" && payload.spawn_task_id === "spawn-held-expiry-requestless",
			),
		).toHaveLength(0);
		await expect(loadRoomMemberState(roomDir, "held-expiry-requestless-worker")).resolves.toMatchObject({
			state: "removed",
			sessionId: null,
			runtimeId: null,
		});
		await expect(readSpawnJob(roomDir, "spawn-held-expiry-requestless")).resolves.toMatchObject({
			deliveryState: "ended",
			lifecycleEvent: "aborted",
			lifecycleReason: "hold_expired",
			holdExpiresAt: null,
		});
	});
});

describe("reconcileMemberLiveness with heartbeat files", () => {
	let roomDir: string;
	beforeEach(async () => {
		const result = await createTestRoom();
		roomDir = result.roomDir;
	});

	it("stale heartbeat + dead PID → error", async () => {
		await createTestMember(roomDir, "w1", "idle");
		const hbPath = getMemberHeartbeatPath(roomDir, "w1");
		await fs.mkdir(path.dirname(hbPath), { recursive: true });
		await fs.writeFile(hbPath, JSON.stringify({
			memberName: "w1",
			updatedAt: new Date(Date.now() - 12000).toISOString(),
			pid: 99999,
		}), "utf8");

		await reconcileMemberLiveness(roomDir, adapters,
			{ memberHeartbeatStaleMs: 1000 });

		const w1 = await loadRoomMemberState(roomDir, "w1");
		expect(w1.state).toBe("error");
	});

	it("fresh heartbeat → NOT marked stale", async () => {
		await createTestMember(roomDir, "w1", "idle");
		await writeMemberHeartbeat(roomDir, "w1");

		await reconcileMemberLiveness(roomDir, adapters,
			{ memberHeartbeatStaleMs: 5000 });

		const w1 = await loadRoomMemberState(roomDir, "w1");
		expect(w1.state).toBe("idle");
	});

	it("pi error-state members self-heal on authoritative heartbeat evidence", async () => {
		await createTestMember(roomDir, "w1", "error");
		await updateRoomMemberState(roomDir, "w1", {
			runtimeId: String(process.pid),
			sessionId: null,
			lastError: "transient failure",
		});
		await writeMemberHeartbeat(roomDir, "w1");

		await reconcileMemberLiveness(roomDir, adapters,
			{ memberHeartbeatStaleMs: 5000 });

		const w1 = await loadRoomMemberState(roomDir, "w1");
		expect(w1.state).toBe("idle");
		expect(w1.lastError).toBeNull();
	});

	it("missing heartbeat file → fallback to heartbeatAt", async () => {
		await createTestMember(roomDir, "w1", "idle");
		await updateRoomMemberState(roomDir, "w1", {
			heartbeatAt: new Date(Date.now() - 12000).toISOString(),
		});

		await reconcileMemberLiveness(roomDir, adapters,
			{ memberHeartbeatStaleMs: 1000 });

		const w1 = await loadRoomMemberState(roomDir, "w1");
		expect(w1.state).toBe("error");
	});

	it("TOCTOU: member recovered during cleanup → NOT removed", async () => {
		await createTestMember(roomDir, "w1", "idle");
		// Set heartbeatAt old so fallback is stale, but keep runtimeId valid
		await updateRoomMemberState(roomDir, "w1", {
			runtimeId: String(process.pid),
			heartbeatAt: new Date(Date.now() - 12000).toISOString(),
		});
		const hbPath = getMemberHeartbeatPath(roomDir, "w1");
		await fs.mkdir(path.dirname(hbPath), { recursive: true });
		// Write a stale heartbeat with a dead PID
		await fs.writeFile(hbPath, JSON.stringify({
			memberName: "w1",
			updatedAt: new Date(Date.now() - 12000).toISOString(),
			pid: 99999,
		}), "utf8");

		const recoveringAdapter = {
			pi: createPiAdapter({
				async remove() {
					// Member "recovers" during cleanup — write a fresh heartbeat
					await writeMemberHeartbeat(roomDir, "w1");
				},
			}),
			paseo: {
				kind: "paseo",
				async spawn() { throw new Error("not used"); },
			} satisfies RoomSpawnAdapter,
		};

		await reconcileMemberLiveness(roomDir, recoveringAdapter,
			{ memberHeartbeatStaleMs: 1000 });

		const w1 = await loadRoomMemberState(roomDir, "w1");
		// Should be idle (recovered), not removed
		expect(w1.state).toBe("idle");
	});

	it("paseo cleanup recovery preserves owner-authored runtimeId", async () => {
		await createTestMember(roomDir, "w1", "idle", "paseo");
		await updateRoomMemberState(roomDir, "w1", {
			runtimeId: "paseo-agent-w1",
			heartbeatAt: new Date(Date.now() - 12000).toISOString(),
		});
		const hbPath = getMemberHeartbeatPath(roomDir, "w1");
		await fs.mkdir(path.dirname(hbPath), { recursive: true });
		await fs.writeFile(hbPath, JSON.stringify({
			memberName: "w1",
			updatedAt: new Date(Date.now() - 12000).toISOString(),
			pid: 99999,
		}), "utf8");

		let observeCount = 0;
		const recoveringAdapter = {
			pi: createPiAdapter(),
			paseo: {
				kind: "paseo",
				async spawn() { throw new Error("not used"); },
				async remove() {
					await writeMemberHeartbeat(roomDir, "w1");
				},
				async observeLiveness() {
					observeCount += 1;
					if (observeCount === 1) {
						return { live: false, authoritative: true, source: "paseo-daemon", detail: "closed" };
					}
					return { live: true, authoritative: true, source: "paseo-daemon", detail: "running" };
				},
			} satisfies RoomSpawnAdapter,
		};

		await reconcileMemberLiveness(roomDir, recoveringAdapter,
			{ memberHeartbeatStaleMs: 1000 });

		const w1 = await loadRoomMemberState(roomDir, "w1");
		expect(w1.state).toBe("idle");
		expect(w1.runtimeId).toBe("paseo-agent-w1");
	});

	it("createWorktree creates a real unique branch per member instance", async () => {
		const gitRoom = await createGitBackedTestRoom();
		const first = await (createWorktree as any)("w1", gitRoom.cwd, "spawn-a");
		const second = await (createWorktree as any)("w1", gitRoom.cwd, "spawn-b");
		expect(first).toBeTruthy();
		expect(second).toBeTruthy();
		expect(first?.branch).toBe("pi/w1/spawn-a");
		expect(second?.branch).toBe("pi/w1/spawn-b");
		expect(second?.branch).not.toBe(first?.branch);
		const headOid = await git(["rev-parse", "--verify", "HEAD"], gitRoom.cwd, 10_000);
		const firstBranchOid = await git(["rev-parse", "--verify", first!.branch], gitRoom.cwd, 10_000);
		const secondBranchOid = await git(["rev-parse", "--verify", second!.branch], gitRoom.cwd, 10_000);
		expect(firstBranchOid).toBe(headOid);
		expect(secondBranchOid).toBe(headOid);
		await git(["worktree", "remove", "--force", first!.path], gitRoom.cwd, 10_000);
		await git(["worktree", "remove", "--force", second!.path], gitRoom.cwd, 10_000);
	});

	it("createWorktree reuses an existing branch when retried with the same spawn identity", async () => {
		const gitRoom = await createGitBackedTestRoom();
		const first = await (createWorktree as any)("w1", gitRoom.cwd, "spawn-retry");
		expect(first).toBeTruthy();
		await git(["worktree", "remove", "--force", first!.path], gitRoom.cwd, 10_000);

		const retried = await (createWorktree as any)("w1", gitRoom.cwd, "spawn-retry");
		expect(retried).toBeTruthy();
		expect(retried?.branch).toBe(first?.branch);
		const headOid = await git(["rev-parse", "--verify", "HEAD"], gitRoom.cwd, 10_000);
		const retriedBranchOid = await git(["rev-parse", "--verify", retried!.branch], gitRoom.cwd, 10_000);
		expect(retriedBranchOid).toBe(headOid);
		await git(["worktree", "remove", "--force", retried!.path], gitRoom.cwd, 10_000);
	});

	it("persistWorktreeSnapshot retry reuses the existing snapshot commit metadata without another commit", async () => {
		const gitRoom = await createGitBackedTestRoom();
		const worktree = await (createWorktree as any)("w1", gitRoom.cwd, "spawn-snapshot");
		expect(worktree).toBeTruthy();
		if (!worktree) return;

		try {
			await fs.writeFile(path.join(worktree.path, "snapshot-change.txt"), "snapshot change\n", "utf8");
			const initialCommitCount = Number.parseInt(
				await git(["rev-list", "--count", worktree.branch], gitRoom.cwd, 10_000),
				10,
			);

			const firstSnapshot = await persistWorktreeSnapshot(worktree.path, {
				commitMessage: "pi-agent snapshot retry semantics",
			});
			expect(firstSnapshot).toMatchObject({
				hasChanges: true,
				branch: worktree.branch,
			});
			expect(firstSnapshot.commitOid).toBeDefined();

			const commitCountAfterFirstSnapshot = Number.parseInt(
				await git(["rev-list", "--count", worktree.branch], gitRoom.cwd, 10_000),
				10,
			);

			const retriedSnapshot = await persistWorktreeSnapshot(worktree.path, {
				commitMessage: "pi-agent snapshot retry semantics",
			});

			expect(retriedSnapshot as typeof retriedSnapshot & { hasNewSnapshot?: boolean }).toMatchObject({
				hasChanges: false,
				hasNewSnapshot: false,
				branch: worktree.branch,
				commitOid: firstSnapshot.commitOid,
			});

			const commitCountAfterRetry = Number.parseInt(
				await git(["rev-list", "--count", worktree.branch], gitRoom.cwd, 10_000),
				10,
			);
			const branchOidAfterRetry = await git(["rev-parse", "--verify", worktree.branch], gitRoom.cwd, 10_000);

			expect(commitCountAfterFirstSnapshot).toBe(initialCommitCount + 1);
			expect(commitCountAfterRetry).toBe(commitCountAfterFirstSnapshot);
			expect(branchOidAfterRetry).toBe(firstSnapshot.commitOid);
		} finally {
			await git(["worktree", "remove", "--force", worktree.path], gitRoom.cwd, 10_000);
		}
	});

	it("agent lost with worktree changes auto-commits branch, removes worktree, and preserves the error member", async () => {
		const gitRoom = await createGitBackedTestRoom();
		roomDir = gitRoom.roomDir;
		await createTestMember(roomDir, "w1", "idle", "paseo");
		const worktree = await (createWorktree as any)("w1", gitRoom.cwd, "spawn-lost");
		expect(worktree).toBeTruthy();
		expect(worktree?.branch).toBe("pi/w1/spawn-lost");
		const headOid = await git(["rev-parse", "--verify", "HEAD"], gitRoom.cwd, 10_000);
		const branchOid = await git(["rev-parse", "--verify", worktree!.branch], gitRoom.cwd, 10_000);
		expect(branchOid).toBe(headOid);
		await updateRoomMemberState(roomDir, "w1", {
			worktree,
			currentTask: "Investigate flaky test",
			currentTaskMessageId: "task-msg-1",
		});
		await fs.writeFile(path.join(worktree!.path, "lost-change.txt"), "unfinished change\n", "utf8");

		const hbPath = getMemberHeartbeatPath(roomDir, "w1");
		await fs.mkdir(path.dirname(hbPath), { recursive: true });
		await fs.writeFile(hbPath, JSON.stringify({
			memberName: "w1",
			updatedAt: new Date(Date.now() - 12_000).toISOString(),
			pid: 99999,
		}), "utf8");

		const cleanupAdapters = {
			pi: createPiAdapter(),
			paseo: {
				kind: "paseo",
				async spawn() { throw new Error("not used"); },
				async remove() {
					return;
				},
				async observeLiveness() {
					return { live: false, authoritative: true, source: "paseo-daemon", detail: "closed" };
				},
			} satisfies RoomSpawnAdapter,
		};

		await reconcileMemberLiveness(roomDir, cleanupAdapters,
			{ memberHeartbeatStaleMs: 1000 });

		expect(await exists(worktree!.path)).toBe(false);
		const w1 = await loadRoomMemberState(roomDir, "w1");
		expect(w1.state).toBe("error");
		expect(w1.worktreeResult).toMatchObject({
			hasChanges: true,
			branch: worktree!.branch,
		});
		const commitMessage = await git(["log", "-1", "--pretty=%s", w1.worktreeResult!.branch!], gitRoom.cwd, 10_000);
		expect(commitMessage).toBe("pi-agent: agentlost auto-cleanup for w1 (may be incomplete)");
	});

	it("agent lost with clean worktree removes it without creating branch and preserves the error member", async () => {
		const gitRoom = await createGitBackedTestRoom();
		roomDir = gitRoom.roomDir;
		await createTestMember(roomDir, "w2", "idle", "paseo");
		const worktree = await (createWorktree as any)("w2", gitRoom.cwd, "spawn-clean");
		expect(worktree).toBeTruthy();
		await updateRoomMemberState(roomDir, "w2", {
			worktree,
		});

		const cleanupAdapters = {
			pi: createPiAdapter(),
			paseo: {
				kind: "paseo",
				async spawn() { throw new Error("not used"); },
				async remove() {
					return;
				},
				async observeLiveness() {
					return { live: false, authoritative: true, source: "paseo-daemon", detail: "closed" };
				},
			} satisfies RoomSpawnAdapter,
		};

		await reconcileMemberLiveness(roomDir, cleanupAdapters,
			{ memberHeartbeatStaleMs: 1000 });

		expect(await exists(worktree!.path)).toBe(false);
		const w2 = await loadRoomMemberState(roomDir, "w2");
		expect(w2.state).toBe("error");
		expect(w2.worktreeResult).toEqual({ hasChanges: false, branch: undefined });
	});

	it("pi dead-runtime watchdog cleanup still archives fallback work and removes the worktree", async () => {
		const gitRoom = await createGitBackedTestRoom();
		roomDir = gitRoom.roomDir;
		await createTestMember(roomDir, "w3", "idle", "pi");
		const worktree = await (createWorktree as any)("w3", gitRoom.cwd, "spawn-dead-runtime");
		expect(worktree).toBeTruthy();
		if (!worktree) return;

		await fs.writeFile(path.join(worktree.path, "terminal.txt"), "terminal snapshot\n", "utf8");
		const terminalSnapshot = await persistWorktreeSnapshot(worktree.path, {
			commitMessage: "watchdog terminal snapshot",
		});
		expect(terminalSnapshot.commitOid).toBeDefined();
		await fs.writeFile(path.join(worktree.path, "cleanup.txt"), "cleanup fallback\n", "utf8");

		await updateRoomMemberState(roomDir, "w3", {
			runtimeId: null,
			sessionId: null,
			heartbeatAt: new Date(Date.now() - 12_000).toISOString(),
			worktree,
			lastSnapshotOid: terminalSnapshot.commitOid!,
		});

		await reconcileMemberLiveness(roomDir, { pi: createPiAdapter(), paseo: adapters.paseo },
			{ memberHeartbeatStaleMs: 1000 });

		expect(await exists(worktree.path)).toBe(false);
		const w3 = await loadRoomMemberState(roomDir, "w3");
		expect(w3.state).toBe("error");
		expect(w3.runtimeId).toBeNull();
		expect(w3.worktree).toBeNull();
		expect(w3.lastSnapshotOid).toBe(terminalSnapshot.commitOid);
		expect(w3.worktreeResult).toMatchObject({
			hasChanges: true,
			branch: worktree.branch,
		});
		expect(w3.worktreeResult?.snapshotOid).toMatch(/^[0-9a-f]{40}$/);
		expect(w3.worktreeResult?.snapshotOid).not.toBe(terminalSnapshot.commitOid);
	});
});

describe("reconcileMemberLiveness with paseo checkLiveness", () => {
	let roomDir: string;
	beforeEach(async () => {
		const result = await createTestRoom();
		roomDir = result.roomDir;
	});

	it("checkLiveness returns true → member stays idle", async () => {
		await createTestMember(roomDir, "w1", "idle", "paseo");
		await writeMemberHeartbeat(roomDir, "w1");

		const paseoAdapter: RoomSpawnAdapter = {
			kind: "paseo",
			async spawn() { throw new Error("not used"); },
			async checkLiveness() { return true; },
		};

		await reconcileMemberLiveness(roomDir, { pi: createPiAdapter(), paseo: paseoAdapter },
			{ memberHeartbeatStaleMs: 5000 });

		const w1 = await loadRoomMemberState(roomDir, "w1");
		expect(w1.state).toBe("idle");
	});

	it("checkLiveness returns false → member transitions to error", async () => {
		await createTestMember(roomDir, "w1", "idle", "paseo");
		// Write a stale heartbeat so hbFresh is false, forcing reliance on runtimeAlive
		const hbPath = getMemberHeartbeatPath(roomDir, "w1");
		await fs.mkdir(path.dirname(hbPath), { recursive: true });
		await fs.writeFile(hbPath, JSON.stringify({
			memberName: "w1",
			updatedAt: new Date(Date.now() - 12000).toISOString(),
			pid: 99999,
		}), "utf8");

		const paseoAdapter: RoomSpawnAdapter = {
			kind: "paseo",
			async spawn() { throw new Error("not used"); },
			async checkLiveness() { return false; },
		};

		await reconcileMemberLiveness(roomDir, { pi: createPiAdapter(), paseo: paseoAdapter },
			{ memberHeartbeatStaleMs: 1000 });

		const w1 = await loadRoomMemberState(roomDir, "w1");
		expect(w1.state).toBe("error");
	});

	it("stale heartbeat + authoritative live paseo result → member stays idle", async () => {
		await createTestMember(roomDir, "w1", "idle", "paseo");
		const hbPath = getMemberHeartbeatPath(roomDir, "w1");
		await fs.mkdir(path.dirname(hbPath), { recursive: true });
		await fs.writeFile(hbPath, JSON.stringify({
			memberName: "w1",
			updatedAt: new Date(Date.now() - 12000).toISOString(),
			pid: 99999,
		}), "utf8");

		const paseoAdapter: RoomSpawnAdapter = {
			kind: "paseo",
			async spawn() { throw new Error("not used"); },
			async observeLiveness() {
				return { live: true, authoritative: true, source: "paseo-daemon", detail: "running" };
			},
		};

		await reconcileMemberLiveness(roomDir, { pi: createPiAdapter(), paseo: paseoAdapter },
			{ memberHeartbeatStaleMs: 1000 });

		const w1 = await loadRoomMemberState(roomDir, "w1");
		expect(w1.state).toBe("idle");
	});

	it("missing heartbeat + authoritative live paseo result → member stays idle", async () => {
		await createTestMember(roomDir, "w1", "idle", "paseo");
		await updateRoomMemberState(roomDir, "w1", {
			heartbeatAt: new Date(Date.now() - 12000).toISOString(),
		});

		const paseoAdapter: RoomSpawnAdapter = {
			kind: "paseo",
			async spawn() { throw new Error("not used"); },
			async observeLiveness() {
				return { live: true, authoritative: true, source: "paseo-daemon", detail: "running" };
			},
		};

		await reconcileMemberLiveness(roomDir, { pi: createPiAdapter(), paseo: paseoAdapter },
			{ memberHeartbeatStaleMs: 1000 });

		const w1 = await loadRoomMemberState(roomDir, "w1");
		expect(w1.state).toBe("idle");
	});

	it("checkLiveness throws → optimistic fallback, member stays idle", async () => {
		await createTestMember(roomDir, "w1", "idle", "paseo");
		await writeMemberHeartbeat(roomDir, "w1");

		const paseoAdapter: RoomSpawnAdapter = {
			kind: "paseo",
			async spawn() { throw new Error("not used"); },
			async checkLiveness() { throw new Error("daemon unreachable"); },
		};

		await reconcileMemberLiveness(roomDir, { pi: createPiAdapter(), paseo: paseoAdapter },
			{ memberHeartbeatStaleMs: 5000 });

		const w1 = await loadRoomMemberState(roomDir, "w1");
		expect(w1.state).toBe("idle");
	});

	it("stale dead heartbeat + inconclusive paseo liveness → member transitions to error", async () => {
		await createTestMember(roomDir, "w1", "idle", "paseo");
		await updateRoomMemberState(roomDir, "w1", {
			heartbeatAt: new Date(Date.now() - 12000).toISOString(),
		});
		const hbPath = getMemberHeartbeatPath(roomDir, "w1");
		await fs.mkdir(path.dirname(hbPath), { recursive: true });
		await fs.writeFile(hbPath, JSON.stringify({
			memberName: "w1",
			updatedAt: new Date(Date.now() - 12000).toISOString(),
			pid: 99999,
		}), "utf8");

		const paseoAdapter: RoomSpawnAdapter = {
			kind: "paseo",
			async spawn() { throw new Error("not used"); },
			async checkLiveness() { throw new Error("daemon unreachable"); },
		};

		await reconcileMemberLiveness(roomDir, { pi: createPiAdapter(), paseo: paseoAdapter },
			{ memberHeartbeatStaleMs: 1000 });

		const w1 = await loadRoomMemberState(roomDir, "w1");
		expect(w1.state).toBe("error");
		expect(w1.runtimeId).toBe("paseo-agent-w1");
	});

	it("no checkLiveness → optimistic fallback, member stays idle", async () => {
		await createTestMember(roomDir, "w1", "idle", "paseo");
		await writeMemberHeartbeat(roomDir, "w1");

		const paseoAdapter: RoomSpawnAdapter = {
			kind: "paseo",
			async spawn() { throw new Error("not used"); },
			// no checkLiveness
		};

		await reconcileMemberLiveness(roomDir, { pi: createPiAdapter(), paseo: paseoAdapter },
			{ memberHeartbeatStaleMs: 5000 });

		const w1 = await loadRoomMemberState(roomDir, "w1");
		expect(w1.state).toBe("idle");
	});

	it("slow paseo liveness RPC does not block spawn finalize", async () => {
		await createTestMember(roomDir, "w1", "idle", "paseo");
		await writeMemberHeartbeat(roomDir, "w1");
		await createSpawningMember(roomDir, {
			name: "w2",
			type: "worker",
			backend: "paseo",
			taskId: "spawn-w2",
			bootstrapToken: "spawn-w2-token",
		});

		let releaseObservation!: () => void;
		const observationBlocked = new Promise<void>((resolve) => {
			releaseObservation = resolve;
		});

		const paseoAdapter: RoomSpawnAdapter = {
			kind: "paseo",
			async spawn() { throw new Error("not used"); },
			async observeLiveness() {
				await observationBlocked;
				return { live: true, authoritative: true, source: "paseo-daemon", detail: "running" };
			},
		};

		const reconcilePromise = reconcileMemberLiveness(roomDir, { pi: createPiAdapter(), paseo: paseoAdapter },
			{ memberHeartbeatStaleMs: 5000 });

		await expect(finalizeMemberRuntime({
			roomDir,
			memberName: "w2",
			taskId: "spawn-w2",
			runtimeId: "agent-w2",
			backend: "paseo",
		})).resolves.toMatchObject({
			job: { state: "external_created" },
		});

		releaseObservation();
		await reconcilePromise;
	});
});

describe("watchdog dependency notifications", () => {
	it("notifies downstream tasks when an agent-lost error closes an upstream task", async () => {
		const { roomDir } = await createTestRoom();
		await createTestMember(roomDir, "worker", "idle", "pi");
		await writeRoomMemberState(roomDir, {
			name: "reviewer",
			type: "worker",
			backend: "pi",
			runtimeId: "reviewer-runtime",
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
			summary: "upstream watchdog task",
		});
		await appendMessage(roomDir, {
			from: "owner",
			to: "reviewer",
			broadcast: false,
			replyTo: null,
			kind: "task",
			summary: "downstream watchdog task",
			content: `Wait for {input:#${upstream.seq}} before starting.`,
		});

		await writeJsonAtomic(getRoomHeartbeatPath(roomDir), {
			roomId: path.basename(roomDir),
			ownerSessionId: "owner-session",
			ownerPid: 999_999,
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
		});

		await handleStaleOwnerForMember(roomDir, "worker", {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
				async remove() {
					return;
				},
			},
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
			},
		}, { heartbeatStaleMs: 1_000 });

		await handleStaleOwnerForMember(roomDir, "worker", {
			pi: {
				kind: "pi",
				async spawn() {
					throw new Error("not used");
				},
				async remove() {
					return;
				},
			},
			paseo: {
				kind: "paseo",
				async spawn() {
					throw new Error("not used");
				},
			},
		}, { heartbeatStaleMs: 1_000 });

		const entries = await listBoardEntries(roomDir, 20);
		expect(entries.filter((entry) => entry.replyTo === upstream.id && entry.kind === "error" && /Agent lost: upstream watchdog task/.test(entry.summary))).toHaveLength(1);
		expect(entries.filter((entry) => entry.to === "reviewer" && /Dependency failed/.test(entry.summary))).toHaveLength(1);

		const worker = await loadRoomMemberState(roomDir, "worker");
		expect(worker.state).toBe("error");
		expect(worker.currentTask).toBeNull();
		expect(worker.currentTaskMessageId).toBeNull();
	});
});
