import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as storage from "./storage.ts";
import { describe, it, expect, beforeEach } from "vitest";
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
						event: "held",
						phase: "delivery",
						member_state: "idle",
						job_state: "completed",
						runtime_id: "agent-proxy-1",
						spawn_task_id: "spawn-request-proxy-1",
					});
				} finally {
					client.disconnect();
					await proxy.stop();
				}
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
