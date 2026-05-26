import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as storage from "./storage.ts";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setFileLockTestHooksForTests, withFileLock } from "./lock.ts";
import {
	appendMessage,
	createSpawningMember,
	createRoom,
	createSpawnJob,
	deleteMemberHeartbeat,
	findRoomByOwnerSessionId,
	getRoomMessagePath,
	getRoomHeartbeatPath,
	getRoomMemberStatePath,
	getRoomMutationLockPath,
	getRoomSpawnJobPath,
	initializeRoomRuntime,
	listRoomMembers,
	listBoardEntries,
	loadRoomMetadata,
	loadRoomMemberState,
	markMemberJoined,
	readMemberHeartbeat,
	readSpawnJob,
	transitionSpawnJob,
	updateRoomMemberState,
	updateSpawnJob,
	withRoomMutationLock,
	writeMemberHeartbeat,
	writeJsonAtomic,
	writeRoomMemberState,
	writeRoomMetadata,
} from "./storage.ts";
import { MutationProxyServer } from "./mutation-proxy.ts";
import { MutationClient } from "./mutation-client.ts";
import { reconcileSpawnTimeouts } from "./watchdog.ts";
import { queueCrewAdd } from "./tools.ts";
import { buildCrewLifecycleEvent } from "./integration-events.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "room-storage-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	await withTempDir(async (tempDir) => {
		const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
		const created = await createRoom({
			runtimeRoot,
			ownerName: "owner",
			ownerSessionId: "owner-session",
			cwd: tempDir,
			ownerPid: process.pid,
		});

		const metadata = await loadRoomMetadata(created.roomDir);
		assert.equal(metadata.ownerSessionId, "owner-session");
		assert.equal(metadata.ownerName, "owner");
		assert.equal(metadata.nextSeq, 1);

		await writeRoomMemberState(created.roomDir, {
			name: "worker",
			type: "worker",
			backend: "pi",
			runtimeId: "pi-runtime-storage-test",
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sessionId: "worker-session-storage-test",
		});

		const roomDirs = await fs.readdir(runtimeRoot);
		assert.deepEqual(roomDirs, [metadata.roomId]);

		const first = await appendMessage(created.roomDir, {
			from: "owner",
			to: "worker",
			broadcast: false,
			replyTo: null,
			kind: "task",
			summary: "first",
			content: "body-1",
		});
		const second = await appendMessage(created.roomDir, {
			from: "owner",
			to: "worker",
			broadcast: false,
			replyTo: first.id,
			kind: "info",
			summary: "second",
			content: "body-2",
		});

		assert.equal(first.seq, 1);
		assert.equal(second.seq, 2);
		assert.equal(await fs.stat(getRoomMessagePath(created.roomDir, 1, first.id)).then(() => true), true);
		assert.equal(await fs.stat(getRoomMessagePath(created.roomDir, 2, second.id)).then(() => true), true);

		const board = await listBoardEntries(created.roomDir, 10);
		assert.deepEqual(board.map((entry) => entry.seq), [1, 2]);
		assert.deepEqual(board.map((entry) => entry.summary), ["first", "second"]);
		assert.equal(storage.resolveTaskSeqByMessageIdFromEntries(board, second.id), 2);

		await writeRoomMetadata(created.roomDir, { ...(await loadRoomMetadata(created.roomDir)), nextSeq: 2 });
		const recoveredAfterMetadataRollback = await appendMessage(created.roomDir, {
			from: "owner",
			to: "worker",
			broadcast: false,
			replyTo: null,
			kind: "info",
			summary: "after-metadata-rollback",
			content: "body-rollback",
		});
		assert.equal(recoveredAfterMetadataRollback.seq, 3);

		await createSpawnJob(created.roomDir, {
			taskId: "spawn-1",
			memberName: "worker",
			backend: "paseo",
		});
		let spawnJob = await readSpawnJob(created.roomDir, "spawn-1");
		assert.ok(spawnJob, "expected spawn job to be created");
		assert.equal(spawnJob?.state, "starting");

		await updateSpawnJob(created.roomDir, "spawn-1", { state: "claimed" });
		spawnJob = await readSpawnJob(created.roomDir, "spawn-1");
		assert.equal(spawnJob?.state, "claimed");

		await createSpawnJob(created.roomDir, {
			taskId: "spawn-pi",
			memberName: "worker",
			backend: "pi",
		});
		await assert.rejects(
			() => updateSpawnJob(created.roomDir, "spawn-pi", { state: "claimed" }),
			/state claimed is only valid for paseo backend/i,
		);

		const lockPath = getRoomMutationLockPath(created.roomDir);
		await fs.mkdir(path.dirname(lockPath), { recursive: true });
		await fs.writeFile(
			lockPath,
			JSON.stringify({
				pid: 999_999,
				hostname: "stale-test",
				createdAt: new Date(Date.now() - 60_000).toISOString(),
				roomId: metadata.roomId,
			}),
			"utf8",
		);

		const reclaimed = await appendMessage(created.roomDir, {
			from: "owner",
			to: "room",
			broadcast: false,
			replyTo: null,
			kind: "info",
			summary: "after-stale-lock",
			content: "body-3",
		});
		assert.equal(reclaimed.seq, 4);

		await fs.writeFile(
			lockPath,
			JSON.stringify({
				pid: 999_999,
				hostname: os.hostname(),
				createdAt: new Date(Date.now() - 60_000).toISOString(),
				roomId: metadata.roomId,
			}),
			"utf8",
		);

		const sameHostReclaimed = await withFileLock(
			lockPath,
			metadata.roomId,
			async () => "same-host-reclaimed",
			{ staleMs: 1_000, retryIntervalMs: 5, timeoutMs: 100 },
		);
		assert.equal(sameHostReclaimed, "same-host-reclaimed");

		let releaseLock: (() => void) | null = null;
		let markHeld: (() => void) | null = null;
		const held = new Promise<void>((resolve) => {
			markHeld = resolve;
		});
		const holder = withFileLock(
			lockPath,
			metadata.roomId,
			async () => {
				markHeld?.();
				await new Promise<void>((resolve) => {
					releaseLock = resolve;
				});
			},
			{ staleMs: 50, retryIntervalMs: 5, timeoutMs: 500 },
		);
		await held;

		await assert.rejects(
			() => withFileLock(lockPath, metadata.roomId, async () => "unexpected", { staleMs: 50, retryIntervalMs: 5, timeoutMs: 100 }),
			/Timed out acquiring lock/,
		);

		releaseLock?.();
		await holder;
	});

	await withTempDir(async (tempDir) => {
		const lockPath = path.join(tempDir, "locks", "renew-release.lock");
		let releaseRenew: (() => void) | null = null;
		let markRenewStarted: (() => void) | null = null;
		const renewStarted = new Promise<void>((resolve) => {
			markRenewStarted = resolve;
		});
		const renewBlocked = new Promise<void>((resolve) => {
			releaseRenew = resolve;
		});

		setFileLockTestHooksForTests({
			async beforeRenewWrite() {
				markRenewStarted?.();
				await renewBlocked;
			},
		});

		try {
			const result = await withFileLock(
				lockPath,
				"renew-release-room",
				async () => {
					await renewStarted;
					return "released-before-renew-commit";
				},
				{ staleMs: 50, retryIntervalMs: 5, timeoutMs: 500 },
			);

			assert.equal(result, "released-before-renew-commit");
			assert.equal(await exists(lockPath), false);

			releaseRenew?.();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(await exists(lockPath), false, "expected a paused renew to stay unable to recreate a released lock");
		} finally {
			setFileLockTestHooksForTests(null);
			releaseRenew?.();
		}
	});


			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-failed-spawn-target",
					cwd: tempDir,
					ownerPid: process.pid,
				});

				await writeRoomMemberState(created.roomDir, {
					name: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "spawning",
					spawnTaskId: "spawn-failed-target",
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
				});
				await createSpawnJob(created.roomDir, {
					taskId: "spawn-failed-target",
					memberName: "worker",
					backend: "pi",
					state: "starting",
				});
				await updateSpawnJob(created.roomDir, "spawn-failed-target", {
					state: "failed",
					error: "spawn failed",
				});

				await assert.rejects(
					() => appendMessage(created.roomDir, {
						from: "owner",
						to: "worker",
						broadcast: false,
						replyTo: null,
						kind: "info",
						summary: "should be rejected once spawn failed",
					}),
					/not available/i,
				);
			});
	await withTempDir(async (tempDir) => {
		const lockPath = path.join(tempDir, "locks", "stale-handoff.lock");
		let releaseRenew: (() => void) | null = null;
		let markRenewStarted: (() => void) | null = null;
		const renewStarted = new Promise<void>((resolve) => {
			markRenewStarted = resolve;
		});
		const renewBlocked = new Promise<void>((resolve) => {
			releaseRenew = resolve;
		});

		setFileLockTestHooksForTests({
			async beforeRenewWrite() {
				markRenewStarted?.();
				await renewBlocked;
			},
		});

		try {
			const firstHolder = withFileLock(
				lockPath,
				"stale-handoff-room",
				async () => {
					await new Promise<void>((resolve) => setTimeout(resolve, 150));
				},
				{ staleMs: 50, retryIntervalMs: 5, timeoutMs: 500 },
			);

			await renewStarted;
			await new Promise((resolve) => setTimeout(resolve, 75));

			await assert.rejects(
				() => withFileLock(lockPath, "stale-handoff-room", async () => "unexpected", { staleMs: 50, retryIntervalMs: 5, timeoutMs: 100 }),
				/Timed out acquiring lock/,
				"expected a live same-host holder to keep exclusive ownership even if renew stalls",
			);

			releaseRenew?.();
			await firstHolder;
		} finally {
			setFileLockTestHooksForTests(null);
			releaseRenew?.();
		}
	});
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

// === Heartbeat file tests ===

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createOwnerRoomFixture(options: {
	runtimeRoot: string;
	tempDir: string;
	roomId: string;
	ownerSessionId: string;
	state?: "active" | "closing" | "reaped";
	heartbeatUpdatedAt?: string;
	ownerPid?: number;
}): Promise<{ roomDir: string; roomId: string }> {
	const now = new Date().toISOString();
	const ownerPid = options.ownerPid ?? process.pid;
	const roomDir = await initializeRoomRuntime(
		options.runtimeRoot,
		{
			roomId: options.roomId,
			ownerName: "owner",
			ownerSessionId: options.ownerSessionId,
			ownerPid,
			cwd: options.tempDir,
			createdAt: now,
			state: options.state ?? "active",
			nextSeq: 1,
		},
		{
			name: "owner",
			type: "owner",
			backend: "pi",
			runtimeId: String(ownerPid),
			state: "idle",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			chatBusy: false,
			lastSeenSeq: 0,
			joinedAt: now,
			updatedAt: now,
			heartbeatAt: now,
			lastActiveAt: now,
			sessionId: options.ownerSessionId,
			bootstrapToken: null,
		},
	);
	await writeJsonAtomic(getRoomHeartbeatPath(roomDir), {
		roomId: options.roomId,
		ownerSessionId: options.ownerSessionId,
		ownerPid,
		updatedAt: options.heartbeatUpdatedAt ?? now,
	});
	return { roomDir, roomId: options.roomId };
}

function getOwnerIndexPathForTest(runtimeRoot: string, ownerSessionId: string): string {
	return path.join(runtimeRoot, "owners", `${Buffer.from(ownerSessionId).toString("hex")}.json`);
}

async function createTestRoom(): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "room-hb-test-"));
	const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
	const created = await createRoom({
		runtimeRoot,
		ownerName: "owner",
		ownerSessionId: "hb-test-session",
		cwd: tempDir,
		ownerPid: process.pid,
	});
	return created.roomDir;
}

describe("Heartbeat files", () => {
	let roomDir: string;
	beforeEach(async () => { roomDir = await createTestRoom(); });

	it("writes and reads heartbeat with correct metadata", async () => {
		await writeMemberHeartbeat(roomDir, "w1");
		const hb = await readMemberHeartbeat(roomDir, "w1");
		expect(hb).not.toBeNull();
		expect(hb!.memberName).toBe("w1");
		expect(hb!.pid).toBe(process.pid);
		expect(Date.parse(hb!.updatedAt)).toBeGreaterThan(Date.now() - 5000);
	});

	it("returns null for missing heartbeat", async () => {
		expect(await readMemberHeartbeat(roomDir, "nonexistent")).toBeNull();
	});

	it("deleteMemberHeartbeat removes the file", async () => {
		await writeMemberHeartbeat(roomDir, "w1");
		await deleteMemberHeartbeat(roomDir, "w1");
		expect(await readMemberHeartbeat(roomDir, "w1")).toBeNull();
	});

	it("heartbeat write does NOT block on mutation lock", async () => {
		let lockAcquired = false;
		const barrier = new Promise<void>(resolve => {
			const check = setInterval(() => {
				if (lockAcquired) { clearInterval(check); resolve(); }
			}, 5);
		});
		const lock = withRoomMutationLock(roomDir, async () => {
			lockAcquired = true;
			await sleep(500);
		});
		await barrier;
		const start = Date.now();
		await writeMemberHeartbeat(roomDir, "w1");
		expect(Date.now() - start).toBeLessThan(200);
		const hb = await readMemberHeartbeat(roomDir, "w1");
		expect(hb).not.toBeNull();
		await lock;
	});

	it("atomic rename: no partial file under concurrent writes", async () => {
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				writeMemberHeartbeat(roomDir, `w${i}`))
		);
		for (let i = 0; i < 20; i++) {
			const hb = await readMemberHeartbeat(roomDir, `w${i}`);
			expect(hb).not.toBeNull();
		}
	});
});

describe("Spawn timeout delivery guards", () => {
	it("rejects directed delivery to timeout tombstones", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-timeout-tombstone-target",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			for (const [taskId, state] of [
				["spawn-timeout-external", "timed_out_pending_external_resolution"],
				["spawn-timeout-claim", "timed_out_pending_member_claim"],
			] as const) {
				const memberName = `worker-${taskId}`;
				await writeRoomMemberState(created.roomDir, {
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
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
				});
				await createSpawnJob(created.roomDir, {
					taskId,
					memberName,
					backend: "paseo",
					state: "starting",
				});
				await updateSpawnJob(created.roomDir, taskId, {
					state,
					error: `spawn is ${state}`,
				});

				await assert.rejects(
					() => appendMessage(created.roomDir, {
						from: "owner",
						to: memberName,
						broadcast: false,
						replyTo: null,
						kind: "info",
						summary: `should reject ${state}`,
					}),
					/spawn job is|not available/i,
				);
			}
		});
	});
});

describe("Owner room index", () => {
	it("reuses the owner index after createRoom writes it", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-index-hit";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});

			expect((await findRoomByOwnerSessionId(runtimeRoot, ownerSessionId))?.roomDir).toBe(created.roomDir);
			expect(JSON.parse(await fs.readFile(getOwnerIndexPathForTest(runtimeRoot, ownerSessionId), "utf8"))).toMatchObject({
				ownerSessionId,
				roomId: created.metadata.roomId,
			});
		});
	});

	it("falls back to a scan and repairs the index when the indexed room is gone", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-index-repair";
			const deleted = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			await fs.rm(deleted.roomDir, { recursive: true, force: true });

			const surviving = await createOwnerRoomFixture({
				runtimeRoot,
				tempDir,
				roomId: "room-survivor",
				ownerSessionId,
			});

			expect((await findRoomByOwnerSessionId(runtimeRoot, ownerSessionId))?.roomDir).toBe(surviving.roomDir);
			expect(JSON.parse(await fs.readFile(getOwnerIndexPathForTest(runtimeRoot, ownerSessionId), "utf8"))).toMatchObject({
				ownerSessionId,
				roomId: surviving.roomId,
			});
		});
	});

	it("repairs the index when the indexed room still exists but its ownerSessionId no longer matches", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-index-owner-mismatch";
			const indexed = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			await writeRoomMetadata(indexed.roomDir, {
				...(await loadRoomMetadata(indexed.roomDir)),
				ownerSessionId: "different-owner-session",
			});

			const surviving = await createOwnerRoomFixture({
				runtimeRoot,
				tempDir,
				roomId: "room-owner-mismatch-survivor",
				ownerSessionId,
			});

			expect((await findRoomByOwnerSessionId(runtimeRoot, ownerSessionId))?.roomDir).toBe(surviving.roomDir);
			expect(JSON.parse(await fs.readFile(getOwnerIndexPathForTest(runtimeRoot, ownerSessionId), "utf8"))).toMatchObject({
				ownerSessionId,
				roomId: surviving.roomId,
			});
		});
	});

	it("prefers active fresh rooms when duplicate owner candidates exist", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-duplicate-fresh";
			const staleUpdatedAt = new Date(Date.now() - 60_000).toISOString();

			const staleRoom = await createOwnerRoomFixture({
				runtimeRoot,
				tempDir,
				roomId: "room-a-stale",
				ownerSessionId,
				heartbeatUpdatedAt: staleUpdatedAt,
			});
			const freshRoom = await createOwnerRoomFixture({
				runtimeRoot,
				tempDir,
				roomId: "room-z-fresh",
				ownerSessionId,
			});

			expect((await findRoomByOwnerSessionId(runtimeRoot, ownerSessionId))?.roomDir).toBe(freshRoom.roomDir);
			expect(JSON.parse(await fs.readFile(getOwnerIndexPathForTest(runtimeRoot, ownerSessionId), "utf8"))).toMatchObject({
				ownerSessionId,
				roomId: freshRoom.roomId,
			});
		});
	});

	it("does not trust an indexed stale room when a fresher duplicate exists", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-indexed-stale-duplicate";
			const staleUpdatedAt = new Date(Date.now() - 60_000).toISOString();
			const indexed = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			await writeJsonAtomic(getRoomHeartbeatPath(indexed.roomDir), {
				roomId: indexed.metadata.roomId,
				ownerSessionId,
				ownerPid: process.pid,
				updatedAt: staleUpdatedAt,
			});

			const freshRoom = await createOwnerRoomFixture({
				runtimeRoot,
				tempDir,
				roomId: "room-fresh-successor",
				ownerSessionId,
			});

			expect((await findRoomByOwnerSessionId(runtimeRoot, ownerSessionId))?.roomDir).toBe(freshRoom.roomDir);
			expect(JSON.parse(await fs.readFile(getOwnerIndexPathForTest(runtimeRoot, ownerSessionId), "utf8"))).toMatchObject({
				ownerSessionId,
				roomId: freshRoom.roomId,
			});
		});
	});

	it("uses lexical roomId tie-breaks when duplicate owner candidates have equal priority", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-duplicate-lexical";
			const staleUpdatedAt = new Date(Date.now() - 60_000).toISOString();

			const first = await createOwnerRoomFixture({
				runtimeRoot,
				tempDir,
				roomId: "room-a-winner",
				ownerSessionId,
				state: "closing",
				heartbeatUpdatedAt: staleUpdatedAt,
			});
			await createOwnerRoomFixture({
				runtimeRoot,
				tempDir,
				roomId: "room-b-loser",
				ownerSessionId,
				state: "closing",
				heartbeatUpdatedAt: staleUpdatedAt,
			});

			expect((await findRoomByOwnerSessionId(runtimeRoot, ownerSessionId))?.roomDir).toBe(first.roomDir);
			expect(JSON.parse(await fs.readFile(getOwnerIndexPathForTest(runtimeRoot, ownerSessionId), "utf8"))).toMatchObject({
				ownerSessionId,
				roomId: first.roomId,
			});
		});
	});

	it("keeps duplicate owner-index repair idempotent across repeated lookups", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-duplicate-idempotent";
			const staleUpdatedAt = new Date(Date.now() - 60_000).toISOString();

			await createOwnerRoomFixture({
				runtimeRoot,
				tempDir,
				roomId: "room-a-stale",
				ownerSessionId,
				state: "closing",
				heartbeatUpdatedAt: staleUpdatedAt,
			});
			const winner = await createOwnerRoomFixture({
				runtimeRoot,
				tempDir,
				roomId: "room-b-fresh",
				ownerSessionId,
			});

			expect((await findRoomByOwnerSessionId(runtimeRoot, ownerSessionId))?.roomDir).toBe(winner.roomDir);
			expect((await findRoomByOwnerSessionId(runtimeRoot, ownerSessionId))?.roomDir).toBe(winner.roomDir);
			expect(JSON.parse(await fs.readFile(getOwnerIndexPathForTest(runtimeRoot, ownerSessionId), "utf8"))).toMatchObject({
				ownerSessionId,
				roomId: winner.roomId,
			});
		});
	});

	it("prefers active stale rooms over closing stale duplicates", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-active-stale-vs-closing-stale";
			const staleUpdatedAt = new Date(Date.now() - 60_000).toISOString();

			const activeStale = await createOwnerRoomFixture({
				runtimeRoot,
				tempDir,
				roomId: "room-z-active-stale",
				ownerSessionId,
				state: "active",
				heartbeatUpdatedAt: staleUpdatedAt,
			});
			await createOwnerRoomFixture({
				runtimeRoot,
				tempDir,
				roomId: "room-a-closing-stale",
				ownerSessionId,
				state: "closing",
				heartbeatUpdatedAt: staleUpdatedAt,
			});

			expect((await findRoomByOwnerSessionId(runtimeRoot, ownerSessionId))?.roomDir).toBe(activeStale.roomDir);
			expect(JSON.parse(await fs.readFile(getOwnerIndexPathForTest(runtimeRoot, ownerSessionId), "utf8"))).toMatchObject({
				ownerSessionId,
				roomId: activeStale.roomId,
			});
		});
	});

});

describe("Member identity helpers", () => {
	it("persists displayName when creating a spawning member", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-member-display-name",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			await createSpawningMember(created.roomDir, {
				name: "explorer_internal",
				displayName: "explorer",
				type: "worker",
				backend: "pi",
				taskId: "spawn-member-display-name",
			} as never);

			const stored = await loadRoomMemberState(created.roomDir, "explorer_internal");
			expect((stored as { displayName?: string | null }).displayName).toBe("explorer");
		});
	});

	describe("crew:add request replay persistence", () => {
		it("reuses an identical request_id without reserving a second generation and keeps first metadata", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-request-replay-identical",
					cwd: tempDir,
					ownerPid: process.pid,
				});

				const readCrewAddRequestReplay = (storage as {
					readCrewAddRequestReplay?: (roomDir: string, requestId: string) => Promise<any>;
				}).readCrewAddRequestReplay;
				expect(readCrewAddRequestReplay).toBeTypeOf("function");

				const first = await createSpawningMember(created.roomDir, {
					displayName: "explorer",
					type: "worker",
					backend: "pi",
					taskId: "spawn-request-replay-1",
					bootstrapToken: "replay-token-1",
					requestReplay: {
						requestId: "req-identical-replay",
						requestedName: "explorer",
						type: "worker",
						model: "gpt-5-mini",
						task: "ship it",
						transient: false,
						metadata: { source: "first-call", ordinal: 1 },
						activation: "manual",
						holdTimeoutMs: 45_000,
					},
				} as never);

				const replayed = await createSpawningMember(created.roomDir, {
					displayName: "explorer",
					type: "worker",
					backend: "pi",
					taskId: "spawn-request-replay-2",
					bootstrapToken: "replay-token-2",
					requestReplay: {
						requestId: "req-identical-replay",
						requestedName: "explorer",
						type: "worker",
						model: "gpt-5-mini",
						task: "ship it",
						transient: false,
						metadata: { source: "second-call", ordinal: 2 },
						activation: "manual",
						holdTimeoutMs: 45_000,
					},
				} as never);

				expect((replayed as { replayed?: boolean }).replayed).toBe(true);
				expect(replayed.member.name).toBe(first.member.name);
				expect(replayed.job.taskId).toBe(first.job.taskId);

				const members = await listRoomMembers(created.roomDir);
				expect(members.filter((member) => member.displayName === "explorer" && member.state !== "removed")).toHaveLength(1);

				const persisted = await readCrewAddRequestReplay?.(created.roomDir, "req-identical-replay");
				expect(persisted).toMatchObject({
					request_id: "req-identical-replay",
					spawn_task_id: "spawn-request-replay-1",
					member_name: first.member.name,
					metadata: { source: "first-call", ordinal: 1 },
					activation: "manual",
					hold_timeout_ms: 45_000,
				});
			});
		});

		it("repairs missing anchors before replaying a duplicate crew:add retry", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-request-replay-repair",
					cwd: tempDir,
					ownerPid: process.pid,
				});

				const first = await createSpawningMember(created.roomDir, {
					displayName: "worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-request-repair-1",
					bootstrapToken: "repair-bootstrap-token",
					requestReplay: {
						requestId: "req-repair-replay",
						requestedName: "worker",
						type: "worker",
						model: null,
						task: "repair me",
						transient: false,
						metadata: { source: "first-call" },
						activation: "immediate",
						holdTimeoutMs: null,
					},
				} as never);

				await fs.rm(getRoomMemberStatePath(created.roomDir, first.member.name), { force: true });
				await fs.rm(getRoomSpawnJobPath(created.roomDir, first.job.taskId), { force: true });
				expect(await loadRoomMemberState(created.roomDir, first.member.name).catch(() => null)).toBeNull();
				expect(await readSpawnJob(created.roomDir, first.job.taskId)).toBeNull();

				const replayed = await queueCrewAdd(
					{
						request_id: "req-repair-replay",
						name: "worker",
						type: "worker",
						task: "repair me",
						activation: "immediate",
						metadata: { source: "retry-call" },
					},
					{
						activeRoom: {
							role: "owner",
							roomDir: created.roomDir,
							roomId: created.metadata.roomId,
							memberName: "owner",
							sessionId: created.metadata.ownerSessionId,
						} as any,
						sessionId: created.metadata.ownerSessionId,
						ctx: {
							cwd: tempDir,
							hasUI: false,
						} as any,
						adapters: {
							pi: {
								kind: "pi",
								async spawn() {
									throw new Error("duplicate replay should not spawn");
								},
							},
							paseo: {
								kind: "paseo",
								async spawn() {
									throw new Error("duplicate replay should not spawn");
								},
							},
						},
					} as never,
				);

				expect(replayed.replayed).toBe(true);
				expect(replayed.memberName).toBe(first.member.name);
				expect(replayed.taskId).toBe(first.job.taskId);
				await expect(loadRoomMemberState(created.roomDir, first.member.name)).resolves.toMatchObject({
					name: first.member.name,
					requestId: "req-repair-replay",
					bootstrapToken: "repair-bootstrap-token",
				});
				await expect(readSpawnJob(created.roomDir, first.job.taskId)).resolves.toMatchObject({
					taskId: first.job.taskId,
					requestId: "req-repair-replay",
					bootstrapToken: "repair-bootstrap-token",
				});
			});
		});

		it("rebuilds a missing replay file from the matching member job only", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-request-replay-rebuild",
					cwd: tempDir,
					ownerPid: process.pid,
				});

				const first = await createSpawningMember(created.roomDir, {
					displayName: "worker",
					type: "worker",
					backend: "pi",
					taskId: "z-request-replay-real-job",
					requestReplay: {
						requestId: "req-rebuild-replay",
						requestedName: "worker",
						type: "worker",
						model: null,
						task: "rebuild me",
						transient: false,
						metadata: { source: "first-call" },
						activation: "manual",
						holdTimeoutMs: null,
					},
				} as never);

				const bystander = await createSpawningMember(created.roomDir, {
					displayName: "bystander",
					type: "worker",
					backend: "pi",
					taskId: "a-request-replay-wrong-job",
				} as never);
				await storage.writeSpawnJob(created.roomDir, {
					...bystander.job,
					requestId: "req-rebuild-replay",
					updatedAt: new Date().toISOString(),
				});

				await fs.rm(storage.getCrewAddRequestReplayPath(created.roomDir, "req-rebuild-replay"), { force: true });

				const replayed = await createSpawningMember(created.roomDir, {
					displayName: "worker",
					type: "worker",
					backend: "pi",
					taskId: "retry-request-replay-real-job",
					requestReplay: {
						requestId: "req-rebuild-replay",
						requestedName: "worker",
						type: "worker",
						model: null,
						task: "rebuild me",
						transient: false,
						metadata: { source: "retry-call" },
						activation: "manual",
						holdTimeoutMs: null,
					},
				} as never);

				expect(replayed.replayed).toBe(true);
				expect(replayed.member.name).toBe(first.member.name);
				expect(replayed.job.memberName).toBe(first.member.name);
				expect(replayed.job.taskId).toBe(first.job.taskId);
				expect(replayed.replayRecord?.spawn_task_id).toBe(first.job.taskId);
			});
		});

		it("treats omitted activation and explicit immediate as the same replay identity", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-request-replay-immediate-default",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const readCrewAddRequestReplay = (storage as {
					readCrewAddRequestReplay?: (roomDir: string, requestId: string) => Promise<any>;
				}).readCrewAddRequestReplay;

				const first = await createSpawningMember(created.roomDir, {
					displayName: "worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-request-immediate-default-1",
					requestReplay: {
						requestId: "req-immediate-default",
						requestedName: "worker",
						type: "worker",
						model: null,
						task: "same request",
						transient: false,
						metadata: { source: "first-call" },
						activation: null,
						holdTimeoutMs: null,
					},
				} as never);

				await expect(readCrewAddRequestReplay?.(created.roomDir, "req-immediate-default")).resolves.toMatchObject({
					request_id: "req-immediate-default",
					activation: "immediate",
				});

				const replayed = await queueCrewAdd(
					{
						request_id: "req-immediate-default",
						name: "worker",
						type: "worker",
						task: "same request",
						activation: "immediate",
						metadata: { source: "retry-call" },
					},
					{
						activeRoom: {
							role: "owner",
							roomDir: created.roomDir,
							roomId: created.metadata.roomId,
							memberName: "owner",
							sessionId: created.metadata.ownerSessionId,
						} as any,
						sessionId: created.metadata.ownerSessionId,
						ctx: {
							cwd: tempDir,
							hasUI: false,
						} as any,
						adapters: {
							pi: {
								kind: "pi",
								async spawn() {
									throw new Error("immediate replay should not spawn");
								},
							},
							paseo: {
								kind: "paseo",
								async spawn() {
									throw new Error("immediate replay should not spawn");
								},
							},
						},
					} as never,
				);

				expect(replayed.replayed).toBe(true);
				expect(replayed.taskId).toBe(first.job.taskId);
				expect(replayed.activation).toBe("immediate");
			});
		});

		it("applies the default manual hold lease when hold_timeout_ms is omitted", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-manual-default-hold",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const readCrewAddRequestReplay = (storage as {
					readCrewAddRequestReplay?: (roomDir: string, requestId: string) => Promise<any>;
				}).readCrewAddRequestReplay;
				expect(readCrewAddRequestReplay).toBeTypeOf("function");

				const spawn = vi.fn(async () => ({
					runtimeId: "runtime-manual-default-hold",
					backend: "pi" as const,
				}));
				const queueOptions = {
					activeRoom: {
						role: "owner",
						roomDir: created.roomDir,
						roomId: created.metadata.roomId,
						memberName: "owner",
						sessionId: created.metadata.ownerSessionId,
					} as any,
					sessionId: created.metadata.ownerSessionId,
					ctx: {
						cwd: tempDir,
						hasUI: false,
					} as any,
					adapters: {
						pi: {
							kind: "pi" as const,
							spawn,
						},
						paseo: {
							kind: "paseo" as const,
							isAvailable: async () => false,
							async spawn() {
								throw new Error("manual default hold test should not select paseo");
							},
						},
					},
				} as never;

				const queued = await queueCrewAdd(
					{
						request_id: "req-manual-default-hold",
						name: "worker",
						type: "worker",
						task: "same request",
						transient: true,
						activation: "manual",
						metadata: { source: "first-call" },
					},
					queueOptions,
				);

				expect(queued.replayed).toBe(false);
				expect(queued.activation).toBe("manual");
				expect(queued.hold_timeout_ms).toBe(30_000);
				expect(spawn).toHaveBeenCalledTimes(1);

				const persisted = await readCrewAddRequestReplay?.(created.roomDir, "req-manual-default-hold");
				expect(persisted).toMatchObject({
					request_id: "req-manual-default-hold",
					activation: "manual",
					hold_timeout_ms: 30_000,
				});

				const job = await readSpawnJob(created.roomDir, queued.taskId);
				expect(job?.deliveryActivation).toBe("manual");
				expect(job?.holdExpiresAt).toEqual(expect.any(String));
				expect(new Date(job?.holdExpiresAt ?? 0).getTime()).toBeGreaterThan(Date.now());

				const replayed = await queueCrewAdd(
					{
						request_id: "req-manual-default-hold",
						name: "worker",
						type: "worker",
						task: "same request",
						transient: true,
						activation: "manual",
						hold_timeout_ms: 30_000,
						metadata: { source: "retry-call" },
					},
					queueOptions,
				);

				expect(replayed.replayed).toBe(true);
				expect(replayed.taskId).toBe(queued.taskId);
				expect(replayed.hold_timeout_ms).toBe(30_000);
				expect(spawn).toHaveBeenCalledTimes(1);
			});
		});

		it("rejects conflicting reuse of an existing request_id", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-request-replay-conflict",
					cwd: tempDir,
					ownerPid: process.pid,
				});

				await createSpawningMember(created.roomDir, {
					displayName: "explorer",
					type: "worker",
					backend: "pi",
					taskId: "spawn-request-conflict-1",
					requestReplay: {
						requestId: "req-conflict-replay",
						requestedName: "explorer",
						type: "worker",
						model: null,
						task: "ship it",
						transient: false,
						metadata: { source: "first-call" },
						activation: "immediate",
						holdTimeoutMs: null,
					},
				} as never);

				await expect(createSpawningMember(created.roomDir, {
					displayName: "explorer",
					type: "worker",
					backend: "pi",
					taskId: "spawn-request-conflict-2",
					requestReplay: {
						requestId: "req-conflict-replay",
						requestedName: "explorer",
						type: "worker",
						model: null,
						task: "do something else",
						transient: false,
						metadata: { source: "second-call" },
						activation: "immediate",
						holdTimeoutMs: null,
					},
				} as never)).rejects.toThrow(/request_id|conflict/i);
			});
		});

		it("keeps replay state current through proxy-mediated lifecycle writes", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-request-replay-proxy",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const readCrewAddRequestReplay = (storage as {
					readCrewAddRequestReplay?: (roomDir: string, requestId: string) => Promise<any>;
				}).readCrewAddRequestReplay;
				expect(readCrewAddRequestReplay).toBeTypeOf("function");

				const proxy = new MutationProxyServer(created.roomDir);
				const client = new MutationClient(created.roomDir);
				await proxy.start();
				await client.connect({ retryTimeoutMs: 1_000 });

				try {
					await client.send({
						kind: "create_spawning_member",
						payload: {
							name: "proxy-worker",
							displayName: "proxy-worker",
							type: "worker",
							backend: "paseo",
							taskId: "spawn-request-proxy-1",
							bootstrapToken: "proxy-replay-token",
							requestReplay: {
								requestId: "req-proxy-replay",
								requestedName: "proxy-worker",
								type: "worker",
								model: "gpt-5-mini",
								task: "proxy task",
								transient: false,
								metadata: { source: "proxy" },
								activation: "manual",
								holdTimeoutMs: 60_000,
							},
						} as any,
					});

					await client.send({
						kind: "claim_member_session",
						payload: {
							bootstrap: {
								version: 1,
								roomId: created.metadata.roomId,
								roomDir: created.roomDir,
								memberName: "proxy-worker",
								memberType: "worker",
								ownerName: "owner",
								ownerSessionId: "owner-session-request-replay-proxy",
								token: "proxy-replay-token",
								spawnTaskId: "spawn-request-proxy-1",
							},
							sessionId: "proxy-member-session",
						},
					});

					await client.send({
						kind: "finalize_member_runtime",
						payload: {
							memberName: "proxy-worker",
							taskId: "spawn-request-proxy-1",
							runtimeId: "agent-proxy-1",
							backend: "paseo",
						},
					});

					const persisted = await readCrewAddRequestReplay?.(created.roomDir, "req-proxy-replay");
					expect(persisted).toMatchObject({
						request_id: "req-proxy-replay",
						spawn_task_id: "spawn-request-proxy-1",
						member_name: "proxy-worker",
						metadata: { source: "proxy" },
					});
					expect(persisted?.replay).toMatchObject({
						event: "claimed",
						phase: "delivery",
						member_state: "idle",
						job_state: "completed",
						runtime_id: "agent-proxy-1",
						spawn_task_id: "spawn-request-proxy-1",
						delivery_state: "held",
						delivery: {
							activation: "manual",
							state: "held",
						},
					});
				} finally {
					client.disconnect();
					await proxy.stop();
				}
			});
		});

		it("persists explicit delivery-gate state when immediate delivery first opens", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-request-replay-immediate-open",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const readCrewAddRequestReplay = (storage as {
					readCrewAddRequestReplay?: (roomDir: string, requestId: string) => Promise<any>;
				}).readCrewAddRequestReplay;

				await createSpawningMember(created.roomDir, {
					name: "immediate-worker",
					displayName: "immediate-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-request-immediate-open",
					bootstrapToken: "bootstrap-immediate-open",
					requestReplay: {
						requestId: "req-immediate-open",
						requestedName: "immediate-worker",
						type: "worker",
						model: null,
						task: null,
						transient: false,
						metadata: { source: "immediate-open" },
						activation: "immediate",
						holdTimeoutMs: null,
					},
				} as never);

				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "immediate-worker",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "bootstrap-immediate-open",
						spawnTaskId: "spawn-request-immediate-open",
					},
					sessionId: "immediate-open-session",
					runtimeId: "runtime-immediate-open",
					backend: "pi",
				});

				const persisted = await readCrewAddRequestReplay?.(
					created.roomDir,
					"req-immediate-open",
				);
				expect(persisted?.replay).toMatchObject({
					event: "enabled",
					phase: "delivery",
					delivery_state: "enabled",
				});
				expect(persisted?.replay?.delivery).toMatchObject({
					activation: "immediate",
					state: "enabled",
					hold_expires_at: null,
					released_at: null,
					aborted_at: null,
					ended_at: null,
				});
				expect(persisted?.replay?.delivery?.opened_at).toEqual(
					persisted?.replay?.updated_at,
				);
			});
		});

		it("keeps held task assignment queued on the board without mutating member task state", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-held-assignment",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const readCrewAddRequestReplay = (storage as {
					readCrewAddRequestReplay?: (roomDir: string, requestId: string) => Promise<any>;
				}).readCrewAddRequestReplay;

				const spawned = await createSpawningMember(created.roomDir, {
					name: "held-worker",
					displayName: "held-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-request-held-assignment",
					bootstrapToken: "bootstrap-held-assignment",
					requestReplay: {
						requestId: "req-held-assignment",
						requestedName: "held-worker",
						type: "worker",
						model: null,
						task: null,
						transient: false,
						metadata: { source: "held-assignment" },
						activation: "manual",
						holdTimeoutMs: 30_000,
					},
				} as never);

				await storage.persistCrewAddReplayEvent?.({
					roomDir: created.roomDir,
					requestId: "req-held-assignment",
					event: buildCrewLifecycleEvent({
						event: "spawned",
						phase: "spawn",
						request_id: "req-held-assignment",
						command_id: null,
						requested_name: "held-worker",
						member_target: "held-worker",
						member_type: "worker",
						room_id: created.metadata.roomId,
						spawn_task_id: "spawn-request-held-assignment",
						runtime_id: null,
						activation: "manual",
						metadata: { source: "held-assignment" },
						delivery_state: "held",
						hold_expires_at: "2026-05-26T00:01:00.000Z",
						error: null,
						reason: null,
					}),
					member: spawned.member,
					job: spawned.job,
				});
				await expect(
					readCrewAddRequestReplay?.(created.roomDir, "req-held-assignment"),
				).resolves.toMatchObject({
					replay: {
						event: "spawned",
						delivery_state: "held",
						delivery: { state: "held" },
					},
				});

				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "held-worker",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "bootstrap-held-assignment",
						spawnTaskId: "spawn-request-held-assignment",
					},
					sessionId: "held-assignment-session",
					runtimeId: "runtime-held-assignment",
					backend: "pi",
				});
				await expect(
					readCrewAddRequestReplay?.(created.roomDir, "req-held-assignment"),
				).resolves.toMatchObject({
					replay: {
						delivery_state: "held",
						delivery: { state: "held" },
					},
				});

				const appended = await appendMessage(created.roomDir, {
					from: "owner",
					to: "held-worker",
					broadcast: false,
					replyTo: null,
					kind: "task",
					summary: "Wait behind the hold gate",
				});
				expect(appended.summary).toBe("Wait behind the hold gate");

				await expect(loadRoomMemberState(created.roomDir, "held-worker")).resolves.toMatchObject({
					currentTask: null,
					currentTaskMessageId: null,
					state: "idle",
				});
				const persisted = await readCrewAddRequestReplay?.(
					created.roomDir,
					"req-held-assignment",
				);
				expect(persisted?.replay?.delivery).toMatchObject({
					activation: "manual",
					state: "held",
					hold_expires_at: "2026-05-26T00:01:00.000Z",
					opened_at: null,
				});
			});
		});

		it("updates replay state when timeout reconciliation aborts a delayed spawn", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-request-replay-timeout",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const readCrewAddRequestReplay = (storage as {
					readCrewAddRequestReplay?: (roomDir: string, requestId: string) => Promise<any>;
				}).readCrewAddRequestReplay;

				await createSpawningMember(created.roomDir, {
					name: "timeout-worker",
					displayName: "timeout-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-request-timeout-1",
					requestReplay: {
						requestId: "req-timeout-replay",
						requestedName: "timeout-worker",
						type: "worker",
						model: null,
						task: "slow spawn",
						transient: false,
						metadata: { source: "timeout" },
						activation: "immediate",
						holdTimeoutMs: null,
					},
				} as never);
				const staleTimestamp = new Date(Date.now() - 60_000).toISOString();
				const seededJob = await readSpawnJob(created.roomDir, "spawn-request-timeout-1");
				expect(seededJob).not.toBeNull();
				await writeJsonAtomic(getRoomSpawnJobPath(created.roomDir, "spawn-request-timeout-1"), {
					...seededJob,
					createdAt: staleTimestamp,
					updatedAt: staleTimestamp,
				});
				await updateRoomMemberState(created.roomDir, "timeout-worker", {
					updatedAt: staleTimestamp,
				});

				await reconcileSpawnTimeouts(created.roomDir, {
					pi: {
						kind: "pi",
						async spawn() {
							throw new Error("not used");
						},
					},
					paseo: {
						kind: "paseo",
						async spawn() {
							throw new Error("not used");
						},
					},
				}, { joinTimeoutMs: 1 });

				const persisted = await readCrewAddRequestReplay?.(created.roomDir, "req-timeout-replay");
				expect(persisted?.replay).toMatchObject({
					event: "ended",
					phase: "delivery",
					reason: "spawn-failed",
					member_state: "error",
					job_state: "failed",
				});
			});
		});

		it("does not re-materialize missing anchors for terminal replay states", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-request-replay-terminal-skip",
					cwd: tempDir,
					ownerPid: process.pid,
				});

				await createSpawningMember(created.roomDir, {
					name: "terminal-worker",
					displayName: "terminal-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-request-terminal-1",
					bootstrapToken: "terminal-bootstrap-token",
					requestReplay: {
						requestId: "req-terminal-replay",
						requestedName: "terminal-worker",
						type: "worker",
						model: null,
						task: "terminal task",
						transient: false,
						metadata: { source: "terminal" },
						activation: "immediate",
						holdTimeoutMs: null,
					},
				} as never);
				const staleTimestamp = new Date(Date.now() - 60_000).toISOString();
				await transitionSpawnJob(created.roomDir, "spawn-request-terminal-1", {
					state: "failed",
					error: "spawn failed before claim",
					updatedAt: staleTimestamp,
				});
				await updateRoomMemberState(created.roomDir, "terminal-worker", {
					state: "error",
					lastError: "spawn failed before claim",
					updatedAt: staleTimestamp,
				});

				await fs.rm(getRoomMemberStatePath(created.roomDir, "terminal-worker"), { force: true });
				await fs.rm(getRoomSpawnJobPath(created.roomDir, "spawn-request-terminal-1"), { force: true });

				const replayed = await queueCrewAdd(
					{
						request_id: "req-terminal-replay",
						name: "terminal-worker",
						type: "worker",
						task: "terminal task",
						activation: "immediate",
						metadata: { source: "retry-terminal" },
					},
					{
						activeRoom: {
							role: "owner",
							roomDir: created.roomDir,
							roomId: created.metadata.roomId,
							memberName: "owner",
							sessionId: created.metadata.ownerSessionId,
						} as any,
						sessionId: created.metadata.ownerSessionId,
						ctx: {
							cwd: tempDir,
							hasUI: false,
						} as any,
						adapters: {
							pi: {
								kind: "pi",
								async spawn() {
									throw new Error("terminal replay should not spawn");
								},
							},
							paseo: {
								kind: "paseo",
								async spawn() {
									throw new Error("terminal replay should not spawn");
								},
							},
						},
					} as never,
				);

				expect(replayed.replayed).toBe(true);
				expect(await loadRoomMemberState(created.roomDir, "terminal-worker").catch(() => null)).toBeNull();
				expect(await readSpawnJob(created.roomDir, "spawn-request-terminal-1")).toBeNull();
			});
		});

		it("replays persisted terminated outcomes without re-materializing anchors", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-request-replay-terminated",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const emitCrewTerminatedOutcome = (storage as {
					emitCrewTerminatedOutcome?: (options: {
						roomDir: string;
						requestId?: string;
						spawnTaskId?: string;
						memberName?: string;
						reason: string;
					}) => Promise<any>;
				}).emitCrewTerminatedOutcome;
				expect(emitCrewTerminatedOutcome).toBeTypeOf("function");

				await createSpawningMember(created.roomDir, {
					name: "terminated-worker",
					displayName: "terminated-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-request-terminated-1",
					bootstrapToken: "terminated-bootstrap-token",
					requestReplay: {
						requestId: "req-terminated-replay",
						requestedName: "terminated-worker",
						type: "worker",
						model: null,
						task: "terminal task",
						transient: false,
						metadata: { source: "terminated" },
						activation: "immediate",
						holdTimeoutMs: null,
					},
				} as never);
				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "terminated-worker",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "terminated-bootstrap-token",
						spawnTaskId: "spawn-request-terminated-1",
					},
					sessionId: "terminated-worker-session",
					runtimeId: String(process.pid),
					backend: "pi",
				});
				await updateRoomMemberState(created.roomDir, "terminated-worker", {
					state: "removed",
					runtimeId: null,
					sessionId: null,
					spawnTaskId: null,
					updatedAt: new Date().toISOString(),
				});

				const terminated = await emitCrewTerminatedOutcome?.({
					roomDir: created.roomDir,
					requestId: "req-terminated-replay",
					spawnTaskId: "spawn-request-terminated-1",
					memberName: "terminated-worker",
					reason: "removed",
				});
				expect(terminated).toMatchObject({
					event: "terminated",
					phase: "delivery",
					request_id: "req-terminated-replay",
					spawn_task_id: "spawn-request-terminated-1",
					reason: "removed",
					delivery_state: "ended",
				});

				await fs.rm(getRoomMemberStatePath(created.roomDir, "terminated-worker"), { force: true });
				await fs.rm(getRoomSpawnJobPath(created.roomDir, "spawn-request-terminated-1"), { force: true });

				const replayed = await queueCrewAdd(
					{
						request_id: "req-terminated-replay",
						name: "terminated-worker",
						type: "worker",
						task: "terminal task",
						activation: "immediate",
						metadata: { source: "retry-terminated" },
					},
					{
						activeRoom: {
							role: "owner",
							roomDir: created.roomDir,
							roomId: created.metadata.roomId,
							memberName: "owner",
							sessionId: created.metadata.ownerSessionId,
						} as any,
						sessionId: created.metadata.ownerSessionId,
						ctx: {
							cwd: tempDir,
							hasUI: false,
						} as any,
						adapters: {
							pi: {
								kind: "pi",
								async spawn() {
									throw new Error("terminated replay should not spawn");
								},
							},
							paseo: {
								kind: "paseo",
								async spawn() {
									throw new Error("terminated replay should not spawn");
								},
							},
						},
					} as never,
				);

				expect(replayed.replayed).toBe(true);
				expect(replayed.replayedLifecycleEvent).toMatchObject({
					event: "terminated",
					phase: "delivery",
					request_id: "req-terminated-replay",
					spawn_task_id: "spawn-request-terminated-1",
					reason: "removed",
				});
				expect(await loadRoomMemberState(created.roomDir, "terminated-worker").catch(() => null)).toBeNull();
				expect(await readSpawnJob(created.roomDir, "spawn-request-terminated-1")).toBeNull();
			});
		});

		it("emits terminated for request-less generations by spawn task id", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-requestless-terminated",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const emitCrewTerminatedOutcome = (storage as {
					emitCrewTerminatedOutcome?: (options: {
						roomDir: string;
						requestId?: string;
						spawnTaskId?: string;
						memberName?: string;
						reason: string;
					}) => Promise<any>;
				}).emitCrewTerminatedOutcome;
				expect(emitCrewTerminatedOutcome).toBeTypeOf("function");

				await createSpawningMember(created.roomDir, {
					name: "requestless-worker",
					displayName: "requestless-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-requestless-terminal",
					bootstrapToken: "requestless-terminal-bootstrap-token",
				} as never);
				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "requestless-worker",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "requestless-terminal-bootstrap-token",
						spawnTaskId: "spawn-requestless-terminal",
					},
					sessionId: "requestless-worker-session",
					runtimeId: String(process.pid),
					backend: "pi",
				});
				await updateRoomMemberState(created.roomDir, "requestless-worker", {
					state: "removed",
					runtimeId: null,
					sessionId: null,
					spawnTaskId: null,
					updatedAt: new Date().toISOString(),
				});

				const terminated = await emitCrewTerminatedOutcome?.({
					roomDir: created.roomDir,
					spawnTaskId: "spawn-requestless-terminal",
					memberName: "requestless-worker",
					reason: "removed",
				});
				expect(terminated).toMatchObject({
					event: "terminated",
					phase: "delivery",
					request_id: null,
					member_target: "requestless-worker",
					spawn_task_id: "spawn-requestless-terminal",
					reason: "removed",
					delivery_state: "ended",
				});
			});
		});

		it("dedupes repeated terminal reconciliation for the same generation", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-terminal-dedupe",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const emitCrewTerminatedOutcome = (storage as {
					emitCrewTerminatedOutcome?: (options: {
						roomDir: string;
						requestId?: string;
						spawnTaskId?: string;
						memberName?: string;
						reason: string;
					}) => Promise<any>;
				}).emitCrewTerminatedOutcome;
				const readCrewAddRequestReplay = (storage as {
					readCrewAddRequestReplay?: (roomDir: string, requestId: string) => Promise<any>;
				}).readCrewAddRequestReplay;
				expect(emitCrewTerminatedOutcome).toBeTypeOf("function");

				await createSpawningMember(created.roomDir, {
					name: "dedupe-worker",
					displayName: "dedupe-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-request-terminal-dedupe",
					bootstrapToken: "dedupe-bootstrap-token",
					requestReplay: {
						requestId: "req-terminal-dedupe",
						requestedName: "dedupe-worker",
						type: "worker",
						model: null,
						task: null,
						transient: false,
						metadata: { source: "terminal-dedupe" },
						activation: "immediate",
						holdTimeoutMs: null,
					},
				} as never);
				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "dedupe-worker",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "dedupe-bootstrap-token",
						spawnTaskId: "spawn-request-terminal-dedupe",
					},
					sessionId: "dedupe-worker-session",
					runtimeId: String(process.pid),
					backend: "pi",
				});
				await updateRoomMemberState(created.roomDir, "dedupe-worker", {
					state: "error",
					runtimeId: null,
					sessionId: null,
					spawnTaskId: null,
				});

				const first = await emitCrewTerminatedOutcome?.({
					roomDir: created.roomDir,
					requestId: "req-terminal-dedupe",
					spawnTaskId: "spawn-request-terminal-dedupe",
					memberName: "dedupe-worker",
					reason: "session_shutdown",
				});
				const second = await emitCrewTerminatedOutcome?.({
					roomDir: created.roomDir,
					requestId: "req-terminal-dedupe",
					spawnTaskId: "spawn-request-terminal-dedupe",
					memberName: "dedupe-worker",
					reason: "removed",
				});

				expect(first).toMatchObject({
					event: "terminated",
					request_id: "req-terminal-dedupe",
					spawn_task_id: "spawn-request-terminal-dedupe",
				});
				expect(second).toBeNull();
				expect(await readCrewAddRequestReplay?.(created.roomDir, "req-terminal-dedupe")).toMatchObject({
					replay: {
						event: "terminated",
						reason: "session_shutdown",
						delivery_state: "ended",
					},
				});
			});
		});

		it("replays hold_expired abort outcomes for later add and abort retries", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-request-replay-expired-hold",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const applyCrewControlCommand = (storage as {
					applyCrewControlCommand?: (options: {
						roomDir: string;
						verb: "release" | "abort";
						spawnTaskId: string;
						commandId?: string;
						requestId?: string;
						reason?: string;
					}) => Promise<any>;
				}).applyCrewControlCommand;
				expect(applyCrewControlCommand).toBeTypeOf("function");

				await createSpawningMember(created.roomDir, {
					name: "expired-hold-worker",
					displayName: "expired-hold-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-request-expired-hold",
					bootstrapToken: "expired-hold-bootstrap-token",
					requestReplay: {
						requestId: "req-expired-hold",
						requestedName: "expired-hold-worker",
						type: "worker",
						model: null,
						task: null,
						transient: false,
						metadata: { source: "expired-hold" },
						activation: "manual",
						holdTimeoutMs: 45_000,
					},
				} as never);
				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "expired-hold-worker",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "expired-hold-bootstrap-token",
						spawnTaskId: "spawn-request-expired-hold",
					},
					sessionId: "expired-hold-worker-session",
					runtimeId: String(process.pid),
					backend: "pi",
				});

				const expired = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "abort",
					spawnTaskId: "spawn-request-expired-hold",
					requestId: "req-expired-hold",
					reason: "hold_expired",
				});
				expect(expired).toMatchObject({
					event: "aborted",
					phase: "activation",
					request_id: "req-expired-hold",
					spawn_task_id: "spawn-request-expired-hold",
					reason: "hold_expired",
					delivery_state: "ended",
				});

				await fs.rm(getRoomMemberStatePath(created.roomDir, "expired-hold-worker"), { force: true });
				await fs.rm(getRoomSpawnJobPath(created.roomDir, "spawn-request-expired-hold"), { force: true });

				const replayedAdd = await queueCrewAdd(
					{
						request_id: "req-expired-hold",
						name: "expired-hold-worker",
						type: "worker",
						activation: "manual",
						hold_timeout_ms: 45_000,
						metadata: { source: "retry-expired-hold" },
					},
					{
						activeRoom: {
							role: "owner",
							roomDir: created.roomDir,
							roomId: created.metadata.roomId,
							memberName: "owner",
							sessionId: created.metadata.ownerSessionId,
						} as any,
						sessionId: created.metadata.ownerSessionId,
						ctx: {
							cwd: tempDir,
							hasUI: false,
						} as any,
						adapters: {
							pi: {
								kind: "pi",
								async spawn() {
									throw new Error("expired hold replay should not spawn");
								},
							},
							paseo: {
								kind: "paseo",
								async spawn() {
									throw new Error("expired hold replay should not spawn");
								},
							},
						},
					} as never,
				);
				expect(replayedAdd.replayed).toBe(true);
				expect(replayedAdd.replayedLifecycleEvent).toMatchObject({
					event: "aborted",
					phase: "activation",
					request_id: "req-expired-hold",
					spawn_task_id: "spawn-request-expired-hold",
					reason: "hold_expired",
				});
				expect(await loadRoomMemberState(created.roomDir, "expired-hold-worker").catch(() => null)).toBeNull();
				expect(await readSpawnJob(created.roomDir, "spawn-request-expired-hold")).toBeNull();

				const replayedAbort = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "abort",
					spawnTaskId: "spawn-request-expired-hold",
					commandId: "abort-after-expiry",
					requestId: "req-expired-hold",
				});
				expect(replayedAbort).toMatchObject({
					event: "aborted",
					phase: "activation",
					command_id: "abort-after-expiry",
					reason: "hold_expired",
					spawn_task_id: "spawn-request-expired-hold",
				});
			});
		});

		it("releases request-less held generations by spawn_task_id", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-requestless-release",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const applyCrewControlCommand = (storage as {
					applyCrewControlCommand?: (options: {
						roomDir: string;
						verb: "release" | "abort";
						spawnTaskId: string;
						commandId?: string;
						requestId?: string;
						reason?: string;
					}) => Promise<any>;
				}).applyCrewControlCommand;
				expect(applyCrewControlCommand).toBeTypeOf("function");

				await createSpawningMember(created.roomDir, {
					name: "requestless-held-release-worker",
					displayName: "requestless-held-release-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-requestless-release",
					bootstrapToken: "bootstrap-requestless-release",
					activation: "manual",
					holdExpiresAt: new Date(Date.now() + 45_000).toISOString(),
				} as never);
				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "requestless-held-release-worker",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "bootstrap-requestless-release",
						spawnTaskId: "spawn-requestless-release",
					},
					sessionId: "requestless-held-release-session",
					runtimeId: "requestless-held-release-runtime",
					backend: "pi",
				});

				const first = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "release",
					spawnTaskId: "spawn-requestless-release",
					commandId: "requestless-release-command",
				});
				const replayed = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "release",
					spawnTaskId: "spawn-requestless-release",
					commandId: "requestless-release-command",
				});

				expect(first).toMatchObject({
					event: "activated",
					phase: "activation",
					request_id: null,
					command_id: "requestless-release-command",
					spawn_task_id: "spawn-requestless-release",
					delivery_state: "enabled",
				});
				expect(replayed).toEqual(first);
				await expect(readSpawnJob(created.roomDir, "spawn-requestless-release")).resolves.toMatchObject({
					deliveryActivation: "manual",
					deliveryState: "enabled",
					holdExpiresAt: null,
				});
			});
		});

		it("aborts request-less held generations and replays identical command_ids", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-requestless-abort",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const applyCrewControlCommand = (storage as {
					applyCrewControlCommand?: (options: {
						roomDir: string;
						verb: "release" | "abort";
						spawnTaskId: string;
						commandId?: string;
						requestId?: string;
						reason?: string;
					}) => Promise<any>;
				}).applyCrewControlCommand;
				expect(applyCrewControlCommand).toBeTypeOf("function");

				await createSpawningMember(created.roomDir, {
					name: "requestless-held-abort-worker",
					displayName: "requestless-held-abort-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-requestless-abort",
					bootstrapToken: "bootstrap-requestless-abort",
					activation: "manual",
					holdExpiresAt: new Date(Date.now() + 45_000).toISOString(),
				} as never);
				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "requestless-held-abort-worker",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "bootstrap-requestless-abort",
						spawnTaskId: "spawn-requestless-abort",
					},
					sessionId: "requestless-held-abort-session",
					runtimeId: "requestless-held-abort-runtime",
					backend: "pi",
				});

				const first = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "abort",
					spawnTaskId: "spawn-requestless-abort",
					commandId: "requestless-abort-command",
					reason: "caller_abort",
				});
				const replayed = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "abort",
					spawnTaskId: "spawn-requestless-abort",
					commandId: "requestless-abort-command",
				});

				expect(first).toMatchObject({
					event: "aborted",
					phase: "activation",
					request_id: null,
					command_id: "requestless-abort-command",
					spawn_task_id: "spawn-requestless-abort",
					reason: "caller_abort",
					delivery_state: "ended",
				});
				expect(replayed).toEqual(first);
				await expect(loadRoomMemberState(created.roomDir, "requestless-held-abort-worker")).resolves.toMatchObject({
					state: "removed",
					sessionId: null,
					runtimeId: null,
				});
				await expect(readSpawnJob(created.roomDir, "spawn-requestless-abort")).resolves.toMatchObject({
					deliveryActivation: "manual",
					deliveryState: "ended",
					lifecycleEvent: "aborted",
					lifecycleReason: "caller_abort",
				});
			});
		});

		it("persists release control replay records and replays identical command_ids", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-control-release",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const readCrewAddRequestReplay = (storage as {
					readCrewAddRequestReplay?: (roomDir: string, requestId: string) => Promise<any>;
				}).readCrewAddRequestReplay;
				const applyCrewControlCommand = (storage as {
					applyCrewControlCommand?: (options: {
						roomDir: string;
						verb: "release" | "abort";
						spawnTaskId: string;
						commandId?: string;
						requestId?: string;
						reason?: string;
					}) => Promise<any>;
				}).applyCrewControlCommand;
				const readCrewControlReplay = (storage as {
					readCrewControlReplay?: (roomDir: string, options: {
						verb: "release" | "abort";
						spawnTaskId: string;
						commandId: string;
					}) => Promise<any>;
				}).readCrewControlReplay;
				expect(applyCrewControlCommand).toBeTypeOf("function");
				expect(readCrewControlReplay).toBeTypeOf("function");

				await createSpawningMember(created.roomDir, {
					name: "held-control-worker",
					displayName: "held-control-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-control-release",
					bootstrapToken: "bootstrap-control-release",
					requestReplay: {
						requestId: "req-control-release",
						requestedName: "held-control-worker",
						type: "worker",
						model: null,
						task: null,
						transient: false,
						metadata: { source: "control-release" },
						activation: "manual",
						holdTimeoutMs: 45_000,
					},
				} as never);
				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "held-control-worker",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "bootstrap-control-release",
						spawnTaskId: "spawn-control-release",
					},
					sessionId: "held-control-worker-session",
					runtimeId: "held-control-worker-runtime",
					backend: "pi",
				});

				const first = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "release",
					spawnTaskId: "spawn-control-release",
					commandId: "release-command-1",
					requestId: "req-control-release",
				});
				const replayed = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "release",
					spawnTaskId: "spawn-control-release",
					commandId: "release-command-1",
					requestId: "req-control-release",
				});

				expect(first).toMatchObject({
					event: "activated",
					phase: "activation",
					command_id: "release-command-1",
					spawn_task_id: "spawn-control-release",
					delivery_state: "enabled",
				});
				expect(replayed).toMatchObject({
					event_id: first?.event_id,
					event: "activated",
					phase: "activation",
					command_id: "release-command-1",
				});
				expect(await readCrewControlReplay?.(created.roomDir, {
					verb: "release",
					spawnTaskId: "spawn-control-release",
					commandId: "release-command-1",
				})).toMatchObject({
					verb: "release",
					spawn_task_id: "spawn-control-release",
					command_id: "release-command-1",
					outcome: {
						event: "activated",
						phase: "activation",
					},
				});
				expect(await readCrewAddRequestReplay?.(created.roomDir, "req-control-release")).toMatchObject({
					replay: {
						event: "activated",
						phase: "activation",
						delivery_state: "enabled",
						delivery: {
							state: "enabled",
						},
					},
				});
			});
		});

		it("replays an identical command_id even when the original outcome was unknown-generation failure", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-control-unknown-replay",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const applyCrewControlCommand = (storage as {
					applyCrewControlCommand?: (options: {
						roomDir: string;
						verb: "release" | "abort";
						spawnTaskId: string;
						commandId?: string;
						requestId?: string;
						reason?: string;
					}) => Promise<any>;
				}).applyCrewControlCommand;
				expect(applyCrewControlCommand).toBeTypeOf("function");

				const first = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "release",
					spawnTaskId: "spawn-control-unknown-replay",
					commandId: "unknown-command-id",
					requestId: "req-control-unknown-replay-first",
				});
				expect(first).toMatchObject({
					event: "failed",
					phase: "activation",
					reason: "unknown-generation",
					command_id: "unknown-command-id",
					request_id: "req-control-unknown-replay-first",
					spawn_task_id: "spawn-control-unknown-replay",
				});

				const replayed = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "release",
					spawnTaskId: "spawn-control-unknown-replay",
					commandId: "unknown-command-id",
					requestId: "req-control-unknown-replay-second",
				});
				expect(replayed).toMatchObject({
					event_id: first?.event_id,
					event: "failed",
					phase: "activation",
					reason: "unknown-generation",
					command_id: "unknown-command-id",
					request_id: "req-control-unknown-replay-first",
					spawn_task_id: "spawn-control-unknown-replay",
				});
			});
		});

		it("persists explicit aborted delivery metadata for control aborts", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-control-abort",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const readCrewAddRequestReplay = (storage as {
					readCrewAddRequestReplay?: (roomDir: string, requestId: string) => Promise<any>;
				}).readCrewAddRequestReplay;
				const applyCrewControlCommand = (storage as {
					applyCrewControlCommand?: (options: {
						roomDir: string;
						verb: "release" | "abort";
						spawnTaskId: string;
						commandId?: string;
						requestId?: string;
						reason?: string;
					}) => Promise<any>;
				}).applyCrewControlCommand;
				expect(applyCrewControlCommand).toBeTypeOf("function");

				await createSpawningMember(created.roomDir, {
					name: "held-abort-worker",
					displayName: "held-abort-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-control-abort",
					bootstrapToken: "bootstrap-control-abort",
					requestReplay: {
						requestId: "req-control-abort",
						requestedName: "held-abort-worker",
						type: "worker",
						model: null,
						task: null,
						transient: false,
						metadata: { source: "control-abort" },
						activation: "manual",
						holdTimeoutMs: 45_000,
					},
				} as never);
				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "held-abort-worker",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "bootstrap-control-abort",
						spawnTaskId: "spawn-control-abort",
					},
					sessionId: "held-abort-worker-session",
					runtimeId: "held-abort-worker-runtime",
					backend: "pi",
				});

				const aborted = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "abort",
					spawnTaskId: "spawn-control-abort",
					commandId: "abort-command-1",
					requestId: "req-control-abort",
				});

				expect(aborted).toMatchObject({
					event: "aborted",
					phase: "activation",
					reason: "caller_abort",
					delivery_state: "ended",
					command_id: "abort-command-1",
				});
				const persisted = await readCrewAddRequestReplay?.(created.roomDir, "req-control-abort");
				expect(persisted?.replay).toMatchObject({
					event: "aborted",
					phase: "activation",
					reason: "caller_abort",
					delivery_state: "ended",
				});
				expect(persisted?.replay?.delivery).toMatchObject({
					activation: "manual",
					state: "ended",
				});
				expect(typeof persisted?.replay?.delivery?.aborted_at).toBe("string");
				expect(typeof persisted?.replay?.delivery?.ended_at).toBe("string");
			});
		});

		it("replays activated for later same-verb release retries after activation", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-control-release-retry",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const applyCrewControlCommand = (storage as {
					applyCrewControlCommand?: (options: {
						roomDir: string;
						verb: "release" | "abort";
						spawnTaskId: string;
						commandId?: string;
						requestId?: string;
						reason?: string;
					}) => Promise<any>;
				}).applyCrewControlCommand;
				const readCrewControlReplay = (storage as {
					readCrewControlReplay?: (roomDir: string, options: {
						verb: "release" | "abort";
						spawnTaskId: string;
						commandId: string;
					}) => Promise<any>;
				}).readCrewControlReplay;
				expect(applyCrewControlCommand).toBeTypeOf("function");
				expect(readCrewControlReplay).toBeTypeOf("function");

				await createSpawningMember(created.roomDir, {
					name: "release-retry-worker",
					displayName: "release-retry-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-control-release-retry",
					bootstrapToken: "bootstrap-control-release-retry",
					requestReplay: {
						requestId: "req-control-release-retry",
						requestedName: "release-retry-worker",
						type: "worker",
						model: null,
						task: null,
						transient: false,
						metadata: { source: "control-release-retry" },
						activation: "manual",
						holdTimeoutMs: 45_000,
					},
				} as never);
				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "release-retry-worker",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "bootstrap-control-release-retry",
						spawnTaskId: "spawn-control-release-retry",
					},
					sessionId: "release-retry-worker-session",
					runtimeId: "release-retry-worker-runtime",
					backend: "pi",
				});

				const first = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "release",
					spawnTaskId: "spawn-control-release-retry",
					commandId: "release-command-first",
					requestId: "req-control-release-retry",
				});
				const replayed = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "release",
					spawnTaskId: "spawn-control-release-retry",
					commandId: "release-command-second",
					requestId: "req-control-release-retry",
				});

				expect(first).toMatchObject({
					event: "activated",
					phase: "activation",
				});
				expect(replayed).toMatchObject({
					event: "activated",
					phase: "activation",
					spawn_task_id: "spawn-control-release-retry",
				});
				expect(await readCrewControlReplay?.(created.roomDir, {
					verb: "release",
					spawnTaskId: "spawn-control-release-retry",
					commandId: "release-command-second",
				})).toMatchObject({
					outcome: {
						event: "activated",
						phase: "activation",
					},
				});
			});
		});

		it("replays aborted for later same-verb abort retries after abort", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-control-abort-retry",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const applyCrewControlCommand = (storage as {
					applyCrewControlCommand?: (options: {
						roomDir: string;
						verb: "release" | "abort";
						spawnTaskId: string;
						commandId?: string;
						requestId?: string;
						reason?: string;
					}) => Promise<any>;
				}).applyCrewControlCommand;
				const readCrewControlReplay = (storage as {
					readCrewControlReplay?: (roomDir: string, options: {
						verb: "release" | "abort";
						spawnTaskId: string;
						commandId: string;
					}) => Promise<any>;
				}).readCrewControlReplay;
				expect(applyCrewControlCommand).toBeTypeOf("function");
				expect(readCrewControlReplay).toBeTypeOf("function");

				await createSpawningMember(created.roomDir, {
					name: "abort-retry-worker",
					displayName: "abort-retry-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-control-abort-retry",
					bootstrapToken: "bootstrap-control-abort-retry",
					requestReplay: {
						requestId: "req-control-abort-retry",
						requestedName: "abort-retry-worker",
						type: "worker",
						model: null,
						task: null,
						transient: false,
						metadata: { source: "control-abort-retry" },
						activation: "manual",
						holdTimeoutMs: 45_000,
					},
				} as never);
				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "abort-retry-worker",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "bootstrap-control-abort-retry",
						spawnTaskId: "spawn-control-abort-retry",
					},
					sessionId: "abort-retry-worker-session",
					runtimeId: "abort-retry-worker-runtime",
					backend: "pi",
				});

				const first = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "abort",
					spawnTaskId: "spawn-control-abort-retry",
					commandId: "abort-command-first",
					requestId: "req-control-abort-retry",
				});
				const replayed = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "abort",
					spawnTaskId: "spawn-control-abort-retry",
					commandId: "abort-command-second",
					requestId: "req-control-abort-retry",
				});

				expect(first).toMatchObject({
					event: "aborted",
					phase: "activation",
				});
				expect(replayed).toMatchObject({
					event: "aborted",
					phase: "activation",
					spawn_task_id: "spawn-control-abort-retry",
				});
				expect(await readCrewControlReplay?.(created.roomDir, {
					verb: "abort",
					spawnTaskId: "spawn-control-abort-retry",
					commandId: "abort-command-second",
				})).toMatchObject({
					outcome: {
						event: "aborted",
						phase: "activation",
					},
				});
			});
		});

		it("returns activation-phase failures for conflicting command reuse and opposite-terminal control", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-control-failures",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				const readCrewAddRequestReplay = (storage as {
					readCrewAddRequestReplay?: (roomDir: string, requestId: string) => Promise<any>;
				}).readCrewAddRequestReplay;
				const applyCrewControlCommand = (storage as {
					applyCrewControlCommand?: (options: {
						roomDir: string;
						verb: "release" | "abort";
						spawnTaskId: string;
						commandId?: string;
						requestId?: string;
						reason?: string;
					}) => Promise<any>;
				}).applyCrewControlCommand;
				expect(applyCrewControlCommand).toBeTypeOf("function");

				await createSpawningMember(created.roomDir, {
					name: "held-failure-worker",
					displayName: "held-failure-worker",
					type: "worker",
					backend: "pi",
					taskId: "spawn-control-failures",
					bootstrapToken: "bootstrap-control-failures",
					requestReplay: {
						requestId: "req-control-failures",
						requestedName: "held-failure-worker",
						type: "worker",
						model: null,
						task: null,
						transient: false,
						metadata: { source: "control-failures" },
						activation: "manual",
						holdTimeoutMs: 45_000,
					},
				} as never);
				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "held-failure-worker",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "bootstrap-control-failures",
						spawnTaskId: "spawn-control-failures",
					},
					sessionId: "held-failure-worker-session",
					runtimeId: "held-failure-worker-runtime",
					backend: "pi",
				});
				await createSpawningMember(created.roomDir, {
					name: "held-failure-worker-2",
					displayName: "held-failure-worker-2",
					type: "worker",
					backend: "pi",
					taskId: "spawn-control-failures-2",
					bootstrapToken: "bootstrap-control-failures-2",
					requestReplay: {
						requestId: "req-control-failures-2",
						requestedName: "held-failure-worker-2",
						type: "worker",
						model: null,
						task: null,
						transient: false,
						metadata: { source: "control-failures-2" },
						activation: "manual",
						holdTimeoutMs: 45_000,
					},
				} as never);
				await markMemberJoined({
					bootstrap: {
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "held-failure-worker-2",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: created.metadata.ownerSessionId,
						token: "bootstrap-control-failures-2",
						spawnTaskId: "spawn-control-failures-2",
					},
					sessionId: "held-failure-worker-session-2",
					runtimeId: "held-failure-worker-runtime-2",
					backend: "pi",
				});

				const activated = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "release",
					spawnTaskId: "spawn-control-failures",
					commandId: "shared-command-id",
					requestId: "req-control-failures",
				});
				const conflict = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "abort",
					spawnTaskId: "spawn-control-failures",
					commandId: "shared-command-id",
					requestId: "req-control-failures",
				});
				const spawnConflict = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "release",
					spawnTaskId: "spawn-control-failures-2",
					commandId: "shared-command-id",
					requestId: "req-control-failures-2",
				});
				const oppositeTerminal = await applyCrewControlCommand?.({
					roomDir: created.roomDir,
					verb: "abort",
					spawnTaskId: "spawn-control-failures",
					commandId: "opposite-terminal-id",
					requestId: "req-control-failures",
				});

				expect(activated?.event).toBe("activated");
				expect(conflict).toMatchObject({
					event: "failed",
					phase: "activation",
					command_id: "shared-command-id",
					spawn_task_id: "spawn-control-failures",
				});
				expect(spawnConflict).toMatchObject({
					event: "failed",
					phase: "activation",
					command_id: "shared-command-id",
					spawn_task_id: "spawn-control-failures-2",
				});
				expect(oppositeTerminal).toMatchObject({
					event: "failed",
					phase: "activation",
					command_id: "opposite-terminal-id",
					spawn_task_id: "spawn-control-failures",
				});
				expect(await readCrewAddRequestReplay?.(created.roomDir, "req-control-failures")).toMatchObject({
					replay: {
						event: "activated",
						phase: "activation",
						delivery_state: "enabled",
					},
				});
			});
		});
	});

	it("creates valid internal names and keeps them unique across historical members", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-member-internal-id",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			const createInternalMemberName = (storage as {
				createInternalMemberName?: (roomDir: string, displayName: string) => Promise<string> | string;
			}).createInternalMemberName;
			expect(createInternalMemberName).toBeTypeOf("function");

			await writeRoomMemberState(created.roomDir, {
				name: "explorer_legacy",
				displayName: "explorer",
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
			} as never);

			const first = await createInternalMemberName?.(created.roomDir, "explorer");
			const second = await createInternalMemberName?.(created.roomDir, "explorer");

			expect(typeof first).toBe("string");
			expect(first).not.toBe("explorer_legacy");
			expect(storage.isValidRoomMemberName(String(first))).toBe(true);
			expect(first).not.toBe(second);
		});
	});

	it("falls back to name as alias for legacy members without displayName", async () => {
		const getMemberDisplayName = (storage as {
			getMemberDisplayName?: (member: { name: string; displayName?: string | null }) => string;
		}).getMemberDisplayName;

		expect(getMemberDisplayName).toBeTypeOf("function");
		expect(getMemberDisplayName?.({ name: "explorer_legacy" })).toBe("explorer_legacy");
	});

	it("detects duplicate active display aliases but ignores removed members", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-duplicate-display-name",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			const assertDisplayAliasAvailable = (storage as {
				assertDisplayAliasAvailable?: (roomDir: string, displayName: string) => Promise<void>;
			}).assertDisplayAliasAvailable;
			expect(assertDisplayAliasAvailable).toBeTypeOf("function");

			for (const state of ["idle", "running", "error", "spawning", "stopping"] as const) {
				await writeRoomMemberState(created.roomDir, {
					name: `explorer_${state}`,
					displayName: "explorer",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state,
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
				} as never);

				await expect(assertDisplayAliasAvailable?.(created.roomDir, "explorer")).rejects.toThrow(/explorer/i);
			}

			await writeRoomMemberState(created.roomDir, {
				name: "explorer_removed",
				displayName: "explorer",
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
			} as never);

			await expect(assertDisplayAliasAvailable?.(created.roomDir, "other-explorer")).resolves.toBeUndefined();
		});
	});

	it("rejects display aliases that shadow an active internal id and resolves display labels", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-target-resolution",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			await writeRoomMemberState(created.roomDir, {
				name: "explorer_1234",
				displayName: "explorer",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: null,
			} as never);

			const assertDisplayAliasAvailable = (storage as {
				assertDisplayAliasAvailable?: (roomDir: string, displayName: string) => Promise<void>;
			}).assertDisplayAliasAvailable;
			const formatMemberLabel = (storage as {
				formatMemberLabel?: (member: { name: string; displayName?: string | null }) => string;
			}).formatMemberLabel;
			const resolveMemberTarget = (storage as {
				resolveMemberTarget?: (roomDir: string, input: string) => Promise<{ name: string; displayName?: string | null }>;
			}).resolveMemberTarget;

			expect(formatMemberLabel).toBeTypeOf("function");
			expect(resolveMemberTarget).toBeTypeOf("function");
			await expect(assertDisplayAliasAvailable?.(created.roomDir, "explorer_1234")).rejects.toThrow(/explorer_1234/i);
			expect(formatMemberLabel?.({ name: "explorer_1234", displayName: "explorer" })).toBe("explorer#1234");
			await expect(resolveMemberTarget?.(created.roomDir, "explorer#1234")).resolves.toMatchObject({
				name: "explorer_1234",
				displayName: "explorer",
			});
		});
	});

	it("atomically rejects concurrent spawning members with the same display alias", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-concurrent-alias",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			const attempts = await Promise.allSettled([
				createSpawningMember(created.roomDir, {
					displayName: "explorer",
					type: "worker",
					backend: "pi",
					taskId: "spawn-1",
				} as never),
				createSpawningMember(created.roomDir, {
					displayName: "explorer",
					type: "worker",
					backend: "pi",
					taskId: "spawn-2",
				} as never),
			]);

			const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
			const rejected = attempts.filter((attempt) => attempt.status === "rejected");
			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/explorer/i);

			const members = await listRoomMembers(created.roomDir);
			const activeExplorers = members.filter((member) => member.state !== "removed" && member.displayName === "explorer");
			expect(activeExplorers).toHaveLength(1);
		});
	});

	it("rejects reusing a removed internal member id", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-removed-internal-id",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			await writeRoomMemberState(created.roomDir, {
				name: "explorer_legacy",
				displayName: "explorer",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "removed",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 7,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				heartbeatAt: new Date().toISOString(),
				pendingSelfAckMessageId: "old-message",
				sessionId: null,
			} as never);

			await expect(createSpawningMember(created.roomDir, {
				name: "explorer_legacy",
				displayName: "explorer",
				type: "worker",
				backend: "pi",
				taskId: "spawn-reuse-removed-internal-id",
			} as never)).rejects.toThrow(/already exists/i);
		});
	});
});

describe("Task lookup helpers", () => {
	it("resolves task seqs from preloaded board entries without re-reading room storage", async () => {
		const entries = [
			{ id: "msg-1", seq: 1 },
			{ id: "msg-2", seq: 2 },
		] as const;

		expect(storage.resolveTaskSeqByMessageIdFromEntries(entries, "msg-2")).toBe(2);
		expect(storage.resolveTaskSeqByMessageIdFromEntries(entries, "missing")).toBeNull();
	});
});

describe("Task target availability", () => {
	it("rejects assigning a new task to an errored member until it recovers", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-error-task-gate",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			await writeRoomMemberState(created.roomDir, {
				name: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-runtime-error-gate",
				state: "error",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: "runtime failed",
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-session-error-gate",
			});

			await expect(appendMessage(created.roomDir, {
				from: "owner",
				to: "worker",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "Should wait for recovery",
			})).rejects.toThrow(/state is error/i);
		});
	});
});
