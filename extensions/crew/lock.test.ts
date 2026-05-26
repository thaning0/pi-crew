import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { setFileLockTestHooksForTests, withFileLock } from "./lock.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "room-lock-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Race between two lock attempts ─────────────────────────────────────────

describe("withFileLock race", () => {
	it("second lock attempt on same path times out while first holds it", async () => {
		await withTempDir(async (tempDir) => {
			const lockPath = path.join(tempDir, "locks", "race.lock");
			let releaseFirst: () => void;
			const firstBlocked = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});

			const firstHolder = withFileLock(
				lockPath,
				"race-room",
				async () => {
					await firstBlocked;
					return "first-wins";
				},
				{ staleMs: 5_000, retryIntervalMs: 5, timeoutMs: 200 },
			);

			// Give the first holder time to acquire
			await sleep(50);

			await assert.rejects(
				() =>
					withFileLock(
						lockPath,
						"race-room",
						async () => "should-not-reach",
						{ staleMs: 5_000, retryIntervalMs: 5, timeoutMs: 100 },
					),
				/Timed out acquiring lock/,
			);

			releaseFirst!();
			const result = await firstHolder;
			expect(result).toBe("first-wins");
		});
	});
});

// ── Lock release after fn throws ───────────────────────────────────────────

describe("withFileLock release on throw", () => {
	it("releases lock after the critical function throws", async () => {
		await withTempDir(async (tempDir) => {
			const lockPath = path.join(tempDir, "locks", "throw.lock");

			await assert.rejects(
				() =>
					withFileLock(
						lockPath,
						"throw-room",
						async () => {
							throw new Error("critical section failed");
						},
						{ staleMs: 1_000, timeoutMs: 500 },
					),
				/critical section failed/,
			);

			// After throw, the lock should be released — a second attempt should succeed
			const result = await withFileLock(
				lockPath,
				"throw-room",
				async () => "second-succeeds",
				{ staleMs: 1_000, timeoutMs: 500 },
			);
			expect(result).toBe("second-succeeds");
		});
	});
});

// ── Stale lock takeover ────────────────────────────────────────────────────

describe("withFileLock stale takeover", () => {
	it("cross-hostname stale lock is taken over", async () => {
		await withTempDir(async (tempDir) => {
			const lockPath = path.join(tempDir, "locks", "cross-host.lock");

			// Write a fake lock file from a different hostname
			await fs.mkdir(path.dirname(lockPath), { recursive: true });
			const oldPayload = {
				pid: 999_999,
				hostname: "other-machine",
				createdAt: new Date(Date.now() - 30_000).toISOString(),
				updatedAt: new Date(Date.now() - 30_000).toISOString(),
				roomId: "cross-host-room",
				token: "old-token",
			};
			await fs.writeFile(lockPath, JSON.stringify(oldPayload));

			// Should take over the stale lock
			const result = await withFileLock(
				lockPath,
				"cross-host-room",
				async () => "taken-over",
				{ staleMs: 1_000, timeoutMs: 500 },
			);
			expect(result).toBe("taken-over");
		});
	});

	it("same-hostname stale lock (dead PID) is taken over", async () => {
		await withTempDir(async (tempDir) => {
			const lockPath = path.join(tempDir, "locks", "same-host.lock");

			// Write a fake lock file from the same hostname with a dead PID
			await fs.mkdir(path.dirname(lockPath), { recursive: true });
			const oldPayload = {
				pid: 999_999,
				hostname: os.hostname(),
				createdAt: new Date(Date.now() - 30_000).toISOString(),
				updatedAt: new Date(Date.now() - 30_000).toISOString(),
				roomId: "same-host-room",
				token: "old-token",
			};
			await fs.writeFile(lockPath, JSON.stringify(oldPayload));

			// Should take over because PID 999_999 is not alive
			const result = await withFileLock(
				lockPath,
				"same-host-room",
				async () => "taken-over-dead-pid",
				{ staleMs: 1_000, timeoutMs: 500 },
			);
			expect(result).toBe("taken-over-dead-pid");
		});
	});

	it("same-hostname live PID prevents stale takeover by time alone", async () => {
		await withTempDir(async (tempDir) => {
			const lockPath = path.join(tempDir, "locks", "live-pid.lock");

			// Acquire lock with the current (live) PID
			const firstResult = await withFileLock(
				lockPath,
				"live-pid-room",
				async () => {
					// Simulate a long critical section
					await sleep(50);
					return "first-holds";
				},
				{ staleMs: 1_000, timeoutMs: 500 },
			);
			expect(firstResult).toBe("first-holds");

			// After first releases, second should succeed
			const secondResult = await withFileLock(
				lockPath,
				"live-pid-room",
				async () => "second-succeeds",
				{ staleMs: 1_000, timeoutMs: 500 },
			);
			expect(secondResult).toBe("second-succeeds");
		});
	});
});
