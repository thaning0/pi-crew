import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRoomLogger, consoleError } from "./logger.ts";
import { updateRoomMemberState } from "./storage.ts";
import type { MemberLivenessObservation, RoomExecutionContext, RoomMemberState, RoomSpawnAdapter, SpawnMemberRequest, SpawnMemberResult } from "./types.ts";
import { AdapterUnavailableError, SpawnFailedError } from "./errors.ts";

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
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

async function terminatePid(
	pid: number,
	options: { graceMs?: number; remove?: boolean; requireExit?: boolean } = {},
): Promise<void> {
	if (!Number.isFinite(pid) || pid <= 0) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}

	const graceMs = options.graceMs ?? (options.remove ? 500 : 500);
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return;
		await sleep(25);
	}

	if ((options.remove || options.requireExit) && isProcessAlive(pid)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			if (!isProcessAlive(pid)) return;
			throw new SpawnFailedError(String(pid), `failed to stop process`);
		}

		const killDeadline = Date.now() + 500;
		while (Date.now() < killDeadline) {
			if (!isProcessAlive(pid)) return;
			await sleep(25);
		}
	}

	if (options.requireExit && isProcessAlive(pid)) {
		throw new SpawnFailedError(String(pid), `process did not exit`);
	}
}

interface PaseoDaemonHelpers {
	connectToDaemon: (options?: { host?: string }) => Promise<{
		createAgent: (options: Record<string, unknown>) => Promise<{ id: string; model?: string }>;
		cancelAgent?: (agentId: string) => Promise<void>;
		deleteAgent?: (agentId: string) => Promise<void>;
		fetchAgent?: (agentId: string) => Promise<{ agent: { status: string } } | null>;
		close?: () => Promise<void>;
	}>;
}

export type PaseoSpawnRecoveryContract = "fallback";

const PASEO_SPAWN_RECOVERY_CONTRACT: PaseoSpawnRecoveryContract = "fallback";
const PASEO_PARENT_AGENT_LABEL = "paseo.parent-agent-id";

async function resolvePaseoParentAgentId(request: SpawnMemberRequest): Promise<string | null> {
	const envParentAgentId = process.env.PASEO_AGENT_ID?.trim();
	if (envParentAgentId) return envParentAgentId;

	const parentSessionId = request.parentSessionId?.trim();
	if (!parentSessionId) return null;

	const agentsRoot = path.join(os.homedir(), ".paseo", "agents");
	try {
		const buckets = await fsp.readdir(agentsRoot, { withFileTypes: true });
		for (const bucket of buckets) {
			if (!bucket.isDirectory()) continue;
			const bucketPath = path.join(agentsRoot, bucket.name);
			const entries = await fsp.readdir(bucketPath, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
				const recordPath = path.join(bucketPath, entry.name);
				try {
					const record = JSON.parse(await fsp.readFile(recordPath, "utf8")) as {
						id?: string;
						runtimeInfo?: { sessionId?: string | null };
					};
					if (record.runtimeInfo?.sessionId !== parentSessionId) continue;
					const recordId = record.id?.trim();
					return recordId && recordId.length > 0 ? recordId : entry.name.replace(/\.json$/, "");
				} catch {
					continue;
				}
			}
		}
	} catch {
		return null;
	}

	return null;
}

/**
 * Task 0 gate result: the current paseo daemon helper surface only supports
 * create/cancel/delete/fetch by agent id. There is no stable label scan or
 * late-handle recovery API, so timeout/orphan cleanup must stay on the
 * fallback contract until a discovery surface is added.
 */
export function getPaseoSpawnRecoveryContract(): PaseoSpawnRecoveryContract {
	return PASEO_SPAWN_RECOVERY_CONTRACT;
}

export function supportsPaseoOrphanRediscovery(): boolean {
	return false;
}

let paseoDaemonHelpersPromise: Promise<PaseoDaemonHelpers> | null = null;
let paseoDaemonHelpersRoot: string | null = null;

function resolveRoomExtensionPath(): string {
	// Resolve relative to this extension's own location — self-contained package
	return fileURLToPath(new URL("./index.ts", import.meta.url));
}

function normalizeCliOverride(): string | null {
	const roomOverride = process.env.PI_ROOM_PASEO_CLI_PATH?.trim();
	if (roomOverride) return roomOverride;
	const subagentOverride = process.env.PI_SUBAGENT_PASEO_CLI_PATH?.trim();
	return subagentOverride || null;
}

function resolveInstalledPaseoCliPath(): string | null {
	const override = normalizeCliOverride();
	if (override) return override;

	const result = spawnSync("bash", ["-lc", 'readlink -f "$(command -v paseo)"'], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0) return null;
	const resolved = result.stdout.trim().split(/\r?\n/).find((line) => line.trim().length > 0);
	return resolved ?? null;
}

function resolveInstalledPaseoCliRoot(): string | null {
	const cliPath = resolveInstalledPaseoCliPath();
	if (!cliPath) return null;
	return path.dirname(path.dirname(cliPath));
}

async function loadPaseoDaemonHelpers(): Promise<PaseoDaemonHelpers> {
	const cliRoot = resolveInstalledPaseoCliRoot();
	if (!cliRoot) {
		throw new AdapterUnavailableError("paseo", "CLI not found on PATH");
	}

	if (paseoDaemonHelpersRoot !== cliRoot) {
		paseoDaemonHelpersPromise = null;
		paseoDaemonHelpersRoot = cliRoot;
	}

	if (!paseoDaemonHelpersPromise) {
		paseoDaemonHelpersPromise = (async () => {
			const clientModulePath = path.join(cliRoot, "dist", "utils", "client.js");
			if (!fs.existsSync(clientModulePath)) {
				throw new AdapterUnavailableError("paseo", `daemon client helper not found at ${clientModulePath}`);
			}

			const clientModule = await import(pathToFileURL(clientModulePath).href);
			if (typeof clientModule.connectToDaemon !== "function") {
				throw new AdapterUnavailableError("paseo", "daemon client helper does not export connectToDaemon");
			}

			return {
				connectToDaemon: clientModule.connectToDaemon as PaseoDaemonHelpers["connectToDaemon"],
			};
		})().catch((error) => {
			paseoDaemonHelpersPromise = null;
			paseoDaemonHelpersRoot = null;
			consoleError("spawn", "paseo daemon helpers load failed", { error: String(error), cliRoot });
			throw error;
		});
	}

	return await paseoDaemonHelpersPromise;
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	const isPiCliRuntime = process.env.PI_CODING_AGENT === "true";
	if (currentScript && !isBunVirtualScript && isPiCliRuntime && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}


/**
 * Clean up stale temporary prompt directories left behind by crashed
 * spawn processes. Runs lazily on the first spawn after startup.
 * Only removes directories older than 24 hours to avoid racing with
 * in-flight spawns on the same machine.
 */
async function cleanupStalePromptDirs(): Promise<void> {
	const tmpDir = os.tmpdir();
	const prefix = "pi-room-prompt-";
	const deadline = Date.now() - 24 * 60 * 60 * 1000;
	try {
		const entries = await fsp.readdir(tmpDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
			const dirPath = path.join(tmpDir, entry.name);
			try {
				const stat = await fsp.stat(dirPath);
				if (stat.mtimeMs < deadline) {
					await fsp.rm(dirPath, { recursive: true, force: true });
				}
			} catch {
				// skip if stat/rm fails (race with concurrent spawn)
			}
		}
	} catch {
		// best-effort; tmpdir read can fail in sandboxed environments
	}
}

async function materializeSystemPrompt(request: SpawnMemberRequest): Promise<{ promptPath: string | null; tempDir: string | null }> {
	// Fire-and-forget: clean up stale temp dirs from crashed spawns.
	// Awaited at the end of this function so it doesn't slow down spawn.
	const _cleanupPromise = cleanupStalePromptDirs().catch(() => {});
	if (request.systemPromptPath) {
		return { promptPath: request.systemPromptPath, tempDir: null };
	}
	if (!request.systemPrompt) {
		return { promptPath: null, tempDir: null };
	}

	const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-room-prompt-"));
	const promptPath = path.join(tempDir, `${request.memberName}-${randomUUID()}.md`);
	await fsp.writeFile(promptPath, request.systemPrompt, { encoding: "utf8", mode: 0o600 });
	return { promptPath, tempDir };
}

async function writeRuntimeIdentity(
	roomDir: string,
	memberName: string,
	runtimeId: string,
	backend?: RoomMemberState["backend"],
): Promise<void> {
	await updateRoomMemberState(roomDir, memberName, {
		runtimeId,
		...(backend ? { backend } : {}),
		updatedAt: new Date().toISOString(),
	}).catch((err) => createRoomLogger(roomDir, "spawn").warn("writeRuntimeIdentity failed", { memberName, error: String(err) }));
}

export function createPiMemberAdapter(options?: {
	spawnProcess?: typeof spawn;
}): RoomSpawnAdapter & {
	spawn: (request: SpawnMemberRequest) => Promise<SpawnMemberResult & { process: ChildProcess }>;
} {
	const spawnProcess = options?.spawnProcess ?? spawn;

	return {
		kind: "pi",
		stopKeepsRuntime: false,
		async isAvailable(_ctx: RoomExecutionContext): Promise<boolean> {
			return true;
		},
		async spawn(request: SpawnMemberRequest): Promise<SpawnMemberResult & { process: ChildProcess }> {
			const log = createRoomLogger(request.roomDir, "spawn");
			const extensionPath = request.extensionPath ?? resolveRoomExtensionPath();
			const materialized = await materializeSystemPrompt(request);
			const args = ["--mode", "rpc", "--no-session", "--extension", extensionPath];
			if (request.model) args.push("--model", request.model);
			if (request.thinkingLevel) args.push("--thinking", request.thinkingLevel);
			if (request.tools && request.tools.length > 0) args.push("--tools", request.tools.join(","));
			if (materialized.promptPath) args.push("--append-system-prompt", materialized.promptPath);

			const invocation = (request.getInvocation ?? getPiInvocation)(args);
			const child = spawnProcess(invocation.command, invocation.args, {
				cwd: request.cwd,
				shell: false,
				stdio: ["pipe", "ignore", "ignore"],
				env: { ...process.env },
			});

			try {
				await new Promise<void>((resolve, reject) => {
					const onSpawn = () => {
						child.off("error", onError);
						resolve();
					};
					const onError = (error: Error) => {
						child.off("spawn", onSpawn);
						reject(error);
					};
					child.once("spawn", onSpawn);
					child.once("error", onError);
				});
			} catch (error) {
				log.error("pi member spawn failed", { memberName: request.memberName, error: String(error) });
				if (materialized.tempDir) {
					await fsp.rm(materialized.tempDir, { recursive: true, force: true }).catch(() => {});
				}
				throw error;
			}

			if (child.pid) {
				await writeRuntimeIdentity(request.roomDir, request.memberName, String(child.pid), "pi");
			}

			// Keep stdin open — RPC mode reads JSON-RPC commands from stdin
			// and triggers shutdown() on EOF. Destroying stdin would kill the
			// sub-agent immediately.

			log.info("pi member spawned", { memberName: request.memberName, pid: child.pid });

			child.once("exit", async () => {
				log.info("pi member process exited", { memberName: request.memberName });
				if (materialized.tempDir) {
					await fsp.rm(materialized.tempDir, { recursive: true, force: true }).catch(() => {});
				}
			});

			return {
				runtimeId: child.pid ? String(child.pid) : "",
				backend: "pi",
				process: child,
			};
		},
		async stop(member: RoomMemberState): Promise<void> {
			const log = createRoomLogger(null, "spawn");
			const pid = Number(member.runtimeId ?? "");
			log.info("pi member stopping", { memberName: member.name, pid });
			try {
				await terminatePid(pid, { requireExit: true });
				log.info("pi member stopped", { memberName: member.name, pid });
			} catch (error) {
				log.error("pi member stop failed", { memberName: member.name, pid, error: String(error) });
				throw error;
			}
		},
		async remove(member: RoomMemberState): Promise<void> {
			const log = createRoomLogger(null, "spawn");
			const pid = Number(member.runtimeId ?? "");
			log.info("pi member removing", { memberName: member.name, pid });
			try {
				await terminatePid(pid, { remove: true });
				log.info("pi member removed", { memberName: member.name, pid });
			} catch (error) {
				log.error("pi member remove failed", { memberName: member.name, pid, error: String(error) });
				throw error;
			}
		},
	};
}

export function createPaseoPiMemberAdapter(): RoomSpawnAdapter {
	const observePaseoLiveness = async (member: RoomMemberState): Promise<MemberLivenessObservation> => {
		if (!member.runtimeId) {
			return {
				live: false,
				authoritative: false,
				source: "paseo-daemon",
				detail: "missing runtimeId",
			};
		}

		const log = createRoomLogger(null, "spawn");
		try {
			const helpers = await loadPaseoDaemonHelpers();
			const client = await helpers.connectToDaemon({ host: process.env.PASEO_HOST });
			if (!client.fetchAgent) {
				return {
					live: false,
					authoritative: false,
					source: "paseo-daemon",
					detail: "fetchAgent unavailable",
				};
			}
			try {
				const result = await withTimeout(
					client.fetchAgent(member.runtimeId),
					5000,
					`checkLiveness fetchAgent for ${member.name}`,
				);
				if (!result || !result.agent) {
					return {
						live: false,
						authoritative: true,
						source: "paseo-daemon",
						detail: "not found",
					};
				}
				const status: string = result.agent.status ?? "";
				return {
					live: status !== "closed" && status !== "archived",
					authoritative: true,
					source: "paseo-daemon",
					detail: status,
				};
			} finally {
				await client.close?.().catch(() => {});
			}
		} catch (error) {
			const detail = String(error);
			if (/not found|agent not found|no such agent/i.test(detail)) {
				log.info("paseo checkLiveness detected dead agent", {
					memberName: member.name,
					runtimeId: member.runtimeId,
					error: detail,
				});
				return {
					live: false,
					authoritative: true,
					source: "paseo-daemon",
					detail,
				};
			}
			log.warn("paseo checkLiveness inconclusive", {
				memberName: member.name,
				runtimeId: member.runtimeId,
				error: detail,
			});
			return {
				live: false,
				authoritative: false,
				source: "paseo-daemon",
				detail,
			};
		}
	};

	return {
		kind: "paseo",
		stopKeepsRuntime: true,
		async isAvailable(_ctx: RoomExecutionContext): Promise<boolean> {
			if (resolveInstalledPaseoCliRoot() === null) return false;
			try {
				const helpers = await loadPaseoDaemonHelpers();
				const client = await helpers.connectToDaemon({ host: process.env.PASEO_HOST });
				await client.close?.().catch(() => {});
				return true;
			} catch (error) {
				consoleError("spawn", "paseo daemon not available", { error: String(error) });
				return false;
			}
		},
		async spawn(request: SpawnMemberRequest): Promise<SpawnMemberResult> {
			const log = createRoomLogger(request.roomDir, "spawn");
			let helpers: PaseoDaemonHelpers;
			try {
				helpers = await loadPaseoDaemonHelpers();
			} catch (error) {
				log.error("paseo daemon helpers load failed", { memberName: request.memberName, error: String(error) });
				throw error;
			}
			const client = await helpers.connectToDaemon({ host: process.env.PASEO_HOST });
			try {
				const systemPrompt =
					request.systemPrompt ??
					(request.systemPromptPath ? await fsp.readFile(request.systemPromptPath, "utf8") : undefined) ??
					"";
				const parentAgentId = await resolvePaseoParentAgentId(request);

				const initialPrompt = request.initialTask
					? `Your assigned task: ${request.initialTask.task}\n\nWhen finished, call: crew_reply(seq=#${request.initialTask.boardMessageSeq}, kind="completion", summary="one-line result", content="full detailed report")`
					: `You are "${request.memberLabel ?? request.memberName}". Wait for messages.`;

				const snapshot = await client.createAgent({
					provider: "pi",
					cwd: request.cwd,
					...(request.model ? { model: request.model } : {}),
					...(request.thinkingLevel ? { thinkingOptionId: request.thinkingLevel } : {}),
					...(parentAgentId ? { labels: { [PASEO_PARENT_AGENT_LABEL]: parentAgentId } } : {}),
					systemPrompt,
					title: request.memberLabel ?? request.memberName,
					initialPrompt,
				});
				log.info("paseo member spawned", { memberName: request.memberName, agentId: snapshot.id });
				return {
					runtimeId: snapshot.id,
					backend: "paseo",
				};
			} catch (error) {
				log.error("paseo member spawn failed", { memberName: request.memberName, error: String(error) });
				throw error;
			} finally {
				await client.close?.().catch(() => {});
			}
		},
		async stop(member: RoomMemberState): Promise<void> {
			if (!member.runtimeId) return;
			const log = createRoomLogger(null, "spawn");
			try {
				const helpers = await loadPaseoDaemonHelpers();
				const client = await helpers.connectToDaemon({ host: process.env.PASEO_HOST });
				try {
					await client.cancelAgent?.(member.runtimeId);
					log.info("paseo member stopped", { memberName: member.name, runtimeId: member.runtimeId });
				} finally {
					await client.close?.().catch(() => {});
				}
			} catch (error) {
				log.error("paseo member stop failed", { memberName: member.name, runtimeId: member.runtimeId, error: String(error) });
				throw error;
			}
		},
		async remove(member: RoomMemberState): Promise<void> {
			if (!member.runtimeId) return;
			const log = createRoomLogger(null, "spawn");
			try {
				const helpers = await loadPaseoDaemonHelpers();
				const client = await helpers.connectToDaemon({ host: process.env.PASEO_HOST });
				try {
					await client.deleteAgent?.(member.runtimeId);
					log.info("paseo member removed", { memberName: member.name, runtimeId: member.runtimeId });
				} finally {
					await client.close?.().catch(() => {});
				}
			} catch (error) {
				log.error("paseo member remove failed", { memberName: member.name, runtimeId: member.runtimeId, error: String(error) });
				throw error;
			}
		},
		async observeLiveness(member: RoomMemberState): Promise<MemberLivenessObservation> {
			return await observePaseoLiveness(member);
		},
		async checkLiveness(member: RoomMemberState): Promise<boolean> {
			const observation = await observePaseoLiveness(member);
			return observation.authoritative ? observation.live : true;
		},
	};
}