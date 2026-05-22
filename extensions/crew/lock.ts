import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LockTimeoutError } from "./errors.ts";

interface LockFilePayload {
	pid: number;
	hostname: string;
	createdAt: string;
	updatedAt?: string;
	roomId: string;
	token?: string;
}

interface FileLockTestHooks {
	beforeRenewWrite?: () => Promise<void> | void;
}

export interface FileLockOptions {
	staleMs?: number;
	retryIntervalMs?: number;
	timeoutMs?: number;
}

let fileLockTestHooks: FileLockTestHooks | null = null;

function getHeartbeatPath(lockPath: string, token: string): string {
	return `${lockPath}.${token}.heartbeat`;
}

async function readHeartbeat(lockPath: string, token: string | undefined): Promise<string | null> {
	if (!token) return null;
	try {
		const raw = await fs.readFile(getHeartbeatPath(lockPath, token), "utf8");
		return raw.trim() || null;
	} catch {
		return null;
	}
}

async function removeHeartbeat(lockPath: string, token: string | undefined): Promise<void> {
	if (!token) return;
	await fs.rm(getHeartbeatPath(lockPath, token), { force: true }).catch(() => {});
}

async function removeLockIfOwned(lockPath: string, token: string | undefined): Promise<void> {
	if (!token) {
		await fs.rm(lockPath, { force: true });
		return;
	}
	const current = await readPayload(lockPath);
	if (!current?.token || current.token !== token) {
		return;
	}
	await fs.rm(lockPath, { force: true });
}

export function setFileLockTestHooksForTests(hooks: FileLockTestHooks | null): void {
	fileLockTestHooks = hooks;
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readPayload(lockPath: string): Promise<LockFilePayload | null> {
	try {
		return JSON.parse(await fs.readFile(lockPath, "utf8")) as LockFilePayload;
	} catch {
		return null;
	}
}

async function isStale(lockPath: string, payload: LockFilePayload | null, staleMs: number): Promise<boolean> {
	if (!payload) return true;
	const heartbeat = await readHeartbeat(lockPath, payload.token);
	const renewedAt = Date.parse(heartbeat ?? payload.updatedAt ?? payload.createdAt);
	if (!Number.isFinite(renewedAt)) return true;
	if (payload.hostname === os.hostname()) {
		return !isProcessAlive(payload.pid);
	}
	return Date.now() - renewedAt > staleMs;
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withFileLock<T>(
	lockPath: string,
	roomId: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const staleMs = options.staleMs ?? 5_000;
	const retryIntervalMs = options.retryIntervalMs ?? 25;
	const timeoutMs = options.timeoutMs ?? 5_000;
	const deadline = Date.now() + timeoutMs;
	await fs.mkdir(path.dirname(lockPath), { recursive: true });

	while (true) {
		try {
			const handle = await fs.open(lockPath, "wx");
			const createdAt = new Date().toISOString();
			const token = randomUUID();
			const heartbeatPath = getHeartbeatPath(lockPath, token);
			const buildPayload = (): LockFilePayload => ({
				pid: process.pid,
				hostname: os.hostname(),
				createdAt,
				updatedAt: new Date().toISOString(),
				roomId,
				token,
			});
			const writeHeartbeat = async (): Promise<void> => {
				const updatedAt = new Date().toISOString();
				const tempPath = `${heartbeatPath}.${process.pid}.renew.tmp`;
				try {
					await fs.writeFile(tempPath, updatedAt, "utf8");
					await fs.rename(tempPath, heartbeatPath);
				} finally {
					await fs.rm(tempPath, { force: true }).catch(() => {});
				}
			};
			try {
				await handle.writeFile(JSON.stringify(buildPayload()));
				await writeHeartbeat();
			} finally {
				await handle.close();
			}

			const renewIntervalMs = Math.max(25, Math.floor(staleMs / 2));
			let released = false;
			let renewInFlight = false;
			const renewTimer = setInterval(() => {
				if (released || renewInFlight) return;
				renewInFlight = true;
				void (async () => {
					try {
						await fileLockTestHooks?.beforeRenewWrite?.();
						if (released) return;
						await writeHeartbeat();
					} finally {
						renewInFlight = false;
					}
				})().catch(() => {});
			}, renewIntervalMs);
			if (typeof renewTimer.unref === "function") {
				renewTimer.unref();
			}

			try {
				return await fn();
			} finally {
				released = true;
				clearInterval(renewTimer);
				await removeLockIfOwned(lockPath, token);
				await removeHeartbeat(lockPath, token);
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;

			const payload = await readPayload(lockPath);
			if (await isStale(lockPath, payload, staleMs)) {
				await removeLockIfOwned(lockPath, payload?.token);
				await removeHeartbeat(lockPath, payload?.token);
				continue;
			}

			if (Date.now() >= deadline) {
				throw new LockTimeoutError(lockPath);
			}

			await sleep(retryIntervalMs);
		}
	}
}