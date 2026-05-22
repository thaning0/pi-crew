import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRoomLogger, closeLogStream } from "./logger.ts";
import { withFileLock } from "./lock.ts";
import {
	clearOwnerRoomIndex,
	deleteRoomMemberState,
	getRoomCleanupLockPath,
	getRoomHeartbeatPath,
	getRoomJobsDir,
	getRoomSpawnJobPath,
	getLastDeliverableMessageSeq,
	listRoomMembers,
	loadRoomMemberState,
	loadRoomMetadata,
	readJsonFile,
	readMemberHeartbeat,
	readMessage,
	readSpawnJob,
	transitionSpawnJobRecord,
	updateRoomMemberState,
	withSerializedOwnerRoomMutation,
	withRoomMutationLock,
	writeJsonAtomic,
	writeRoomMemberState,
	writeRoomMetadata,
} from "./storage.ts";
import type { MemberLivenessObservation, RoomMemberState, RoomSpawnAdapter, RoomSpawnJob } from "./types.ts";
import { loadTypedRoomAgentDefinition } from "./bootstrap.ts";
import { pruneWorktrees, git } from "./worktree.ts";
import { archiveMemberWorktreeCleanup } from "./worktree-cleanup.ts";
import { clearRoomDeps } from "./deps.ts";
import { appendTerminalTaskReplyAndNotify } from "./task-terminal.ts";

interface OwnerHeartbeat {
	roomId: string;
	ownerSessionId: string;
	ownerPid: number;
	updatedAt: string;
}

interface RoomAdapterMap {
	pi: RoomSpawnAdapter;
	paseo: RoomSpawnAdapter;
}

interface WatchdogOptions {
	heartbeatStaleMs?: number;
	joinTimeoutMs?: number;
	memberHeartbeatStaleMs?: number;
	paseoExternalCreateTimeoutMs?: number;
	paseoBootstrapClaimTimeoutMs?: number;
	excludeRoomIds?: Set<string>;
	excludeOwnerSessionIds?: Set<string>;
}

interface ObservedMemberLiveness {
	member: RoomMemberState;
	live: boolean;
	authoritative: boolean;
	source: MemberLivenessObservation["source"];
	detail: string | null;
	heartbeatFresh: boolean;
	heartbeatPidAlive: boolean;
	fallbackFresh: boolean;
	memberStaleMs: number;
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

async function readHeartbeat(roomDir: string): Promise<OwnerHeartbeat | null> {
	try {
		return JSON.parse(await fs.readFile(getRoomHeartbeatPath(roomDir), "utf8")) as OwnerHeartbeat;
	} catch {
		return null;
	}
}

function getAdapter(member: RoomMemberState, adapters: RoomAdapterMap): RoomSpawnAdapter {
	return member.backend === "paseo" ? adapters.paseo : adapters.pi;
}

async function observeMemberLiveness(
	roomDir: string,
	member: RoomMemberState,
	adapters: RoomAdapterMap,
	options: WatchdogOptions = {},
): Promise<ObservedMemberLiveness> {
	const memberStaleMs = options.memberHeartbeatStaleMs ?? getMemberHeartbeatStaleMsFor(member.type);
	const hb = await readMemberHeartbeat(roomDir, member.name).catch(() => null);
	const heartbeatPidAlive = hb ? isProcessAlive(hb.pid) : false;
	const heartbeatFresh = hb
		? (Date.now() - Date.parse(hb.updatedAt) <= memberStaleMs)
		: false;
	const fallbackFresh = !heartbeatFresh
		? (Date.now() - Date.parse(member.heartbeatAt ?? member.updatedAt) <= memberStaleMs)
		: false;

	if (member.backend === "paseo") {
		const adapter = getAdapter(member, adapters);
		if (adapter.observeLiveness) {
			const observed = await adapter.observeLiveness(member);
			return {
				member,
				live: observed.live,
				authoritative: observed.authoritative,
				source: observed.source,
				detail: observed.detail ?? null,
				heartbeatFresh,
				heartbeatPidAlive,
				fallbackFresh,
				memberStaleMs,
			};
		}
		if (adapter.checkLiveness) {
			try {
				const live = await adapter.checkLiveness(member);
				return {
					member,
					live,
					authoritative: true,
					source: "paseo-daemon",
					detail: "legacy checkLiveness",
					heartbeatFresh,
					heartbeatPidAlive,
					fallbackFresh,
					memberStaleMs,
				};
			} catch (error) {
				return {
					member,
					live: false,
					authoritative: false,
					source: "optimistic",
					detail: String(error),
					heartbeatFresh,
					heartbeatPidAlive,
					fallbackFresh,
					memberStaleMs,
				};
			}
		}
		return {
			member,
			live: false,
			authoritative: false,
			source: "optimistic",
			detail: "adapter does not implement observeLiveness",
			heartbeatFresh,
			heartbeatPidAlive,
			fallbackFresh,
			memberStaleMs,
		};
	}

	const live = member.runtimeId ? isProcessAlive(Number(member.runtimeId)) : false;
	return {
		member,
		live,
		authoritative: true,
		source: "pi-pid",
		detail: member.runtimeId ? null : "missing runtimeId",
		heartbeatFresh,
		heartbeatPidAlive,
		fallbackFresh,
		memberStaleMs,
	};
}

async function cancelPendingSpawnJobsLocked(roomDir: string, reason: string): Promise<void> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(getRoomJobsDir(roomDir));
	} catch {
		return;
	}

	for (const entry of entries.filter((candidate) => candidate.startsWith("spawn-") && candidate.endsWith(".json")).sort()) {
		const jobPath = `${getRoomJobsDir(roomDir)}/${entry}`;
		const job = await readJsonFile<RoomSpawnJob>(jobPath).catch(() => null);
		if (!job || job.state === "completed" || job.state === "cancelled" || job.state === "failed") continue;

		const updatedAt = new Date().toISOString();
		await transitionSpawnJobRecord(roomDir, job, {
			state: "cancelled",
			updatedAt,
			error: reason,
		});

		const member = await loadRoomMemberState(roomDir, job.memberName).catch(() => null);
		if (!member || member.state !== "spawning" || member.spawnTaskId !== job.taskId) continue;

		await writeRoomMemberState(roomDir, {
			...member,
			state: "error",
			spawnTaskId: null,
			currentTask: null,
			currentTaskMessageId: null,
			sessionId: null,
			lastError: reason,
			updatedAt,
		});
	}
}

export async function cancelPendingSpawnJobs(roomDir: string, reason: string): Promise<void> {
	await withRoomMutationLock(roomDir, async () => {
		await cancelPendingSpawnJobsLocked(roomDir, reason);
	});
}

export function getOwnerHeartbeatIntervalMs(): number {
	const raw = Number(process.env.PI_ROOM_OWNER_HEARTBEAT_INTERVAL_MS ?? "1000");
	return Number.isFinite(raw) && raw > 0 ? raw : 1000;
}

export function getOwnerHeartbeatStaleMs(): number {
	const raw = Number(process.env.PI_ROOM_OWNER_HEARTBEAT_STALE_MS ?? "5000");
	return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

export function getMemberHeartbeatIntervalMs(): number {
	const raw = Number(process.env.PI_ROOM_MEMBER_HEARTBEAT_INTERVAL_MS ?? "1000");
	return Number.isFinite(raw) && raw > 0 ? raw : 1000;
}

export function getMemberHeartbeatStaleMs(): number {
	const raw = Number(process.env.PI_ROOM_MEMBER_HEARTBEAT_STALE_MS ?? "5000");
	return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

/**
 * Resolve the per-member heartbeat stale timeout.
 * Checks, in order: agent definition's heartbeatStaleMs, env override, global default.
 */
export function getMemberHeartbeatStaleMsFor(memberType: string): number {
	const agentDef = loadTypedRoomAgentDefinition(memberType);
	if (agentDef?.heartbeatStaleMs && agentDef.heartbeatStaleMs > 0) {
		return agentDef.heartbeatStaleMs;
	}
	return getMemberHeartbeatStaleMs();
}

export function getRoomSpawnJoinTimeoutMs(): number {
	const raw = Number(process.env.PI_ROOM_SPAWN_JOIN_TIMEOUT_MS ?? "15000");
	return Number.isFinite(raw) && raw > 0 ? raw : 15000;
}

export function getRoomPaseoExternalCreateTimeoutMs(): number {
	const raw = Number(process.env.PI_ROOM_PASEO_EXTERNAL_CREATE_TIMEOUT_MS ?? "45000");
	return Number.isFinite(raw) && raw > 0 ? raw : 45000;
}

export function getRoomPaseoBootstrapClaimTimeoutMs(): number {
	const raw = Number(process.env.PI_ROOM_PASEO_BOOTSTRAP_CLAIM_TIMEOUT_MS ?? "15000");
	return Number.isFinite(raw) && raw > 0 ? raw : 15000;
}

export async function writeOwnerHeartbeat(roomDir: string, ownerSessionId: string, ownerPid: number): Promise<void> {
	const metadata = await loadRoomMetadata(roomDir).catch(() => null);
	const roomId = metadata?.roomId ?? roomDir.split("/").pop() ?? roomDir;
	await writeJsonAtomic(getRoomHeartbeatPath(roomDir), {
		roomId,
		ownerSessionId,
		ownerPid,
		updatedAt: new Date().toISOString(),
	});
}

export async function isOwnerHeartbeatStale(roomDir: string, options: WatchdogOptions = {}): Promise<boolean> {
	const staleMs = options.heartbeatStaleMs ?? getOwnerHeartbeatStaleMs();
	const heartbeat = await readHeartbeat(roomDir);
	if (!heartbeat) {
		const metadata = await loadRoomMetadata(roomDir).catch(() => null);
		return metadata ? !isProcessAlive(metadata.ownerPid) : true;
	}

	const updatedAt = Date.parse(heartbeat.updatedAt);
	if (!Number.isFinite(updatedAt)) return true;
	if (!isProcessAlive(heartbeat.ownerPid)) return true;
	return Date.now() - updatedAt > staleMs;
}

async function writeAgentLostBoardMessage(
	roomDir: string,
	memberName: string,
	taskMessageId: string,
	taskSummary: string,
): Promise<void> {
	const log = createRoomLogger(roomDir, "watchdog");
	await appendTerminalTaskReplyAndNotify({
		roomDir,
		taskMessageId,
		from: "system",
		to: "room",
		kind: "error",
		summary: `Agent lost: ${taskSummary}`,
		logContext: { memberName, source: "watchdog" },
	}).catch((err) => log.error("agent lost board message failed", {
		memberName, error: String(err),
	}));
}

export async function handleStaleOwnerForMember(
	roomDir: string,
	memberName: string,
	adapters: RoomAdapterMap,
	options: WatchdogOptions = {},
): Promise<boolean> {
	if (!(await isOwnerHeartbeatStale(roomDir, options))) return false;

	const log = createRoomLogger(roomDir, "watchdog");
	log.info("owner heartbeat stale, member cleanup start", { memberName });

	// Capture task info before updateRoomMemberState (TOCTOU acceptable — board message is best-effort)
	const preUpdateMember = await loadRoomMemberState(roomDir, memberName).catch(() => null);
	const pendingLostInfo: { taskMessageId: string; taskSummary: string } | null =
		preUpdateMember?.currentTaskMessageId && preUpdateMember?.currentTask
			? { taskMessageId: preUpdateMember.currentTaskMessageId, taskSummary: preUpdateMember.currentTask }
			: null;

	const member = await updateRoomMemberState(roomDir, memberName, {
		state: "error",
		currentTask: null,
		currentTaskMessageId: null,
		lastError: "Owner heartbeat stale; member entered orphan cleanup.",
		spawnTaskId: null,
	}).catch((err) => { log.error("mark member error on stale owner failed", { memberName, error: String(err) }); return null; });
	if (!member) return false;
	log.info("member set to error from stale owner", { memberName });

	// Write agent-lost board message (best-effort)
	if (pendingLostInfo && member) {
		await writeAgentLostBoardMessage(roomDir, member.name, pendingLostInfo.taskMessageId, pendingLostInfo.taskSummary);
	}

	const adapter = getAdapter(member, adapters);
	if (!member.runtimeId) {
		await updateRoomMemberState(roomDir, memberName, {
			state: "error",
			runtimeId: null,
			sessionId: null,
			currentTask: null,
			currentTaskMessageId: null,
			spawnTaskId: null,
			updatedAt: new Date().toISOString(),
		}).catch((err) => log.error("mark member removed failed", { memberName, error: String(err) }));
		return true;
	}

	if (adapter.stopKeepsRuntime === false || member.backend === "pi") {
		if (adapter.stop) {
			try {
				await adapter.stop(member);
				log.info("cleanup ok", { memberName, runtimeId: member.runtimeId });
				await updateRoomMemberState(roomDir, memberName, {
					state: "error",
					runtimeId: null,
					sessionId: null,
					currentTask: null,
					currentTaskMessageId: null,
					spawnTaskId: null,
					updatedAt: new Date().toISOString(),
				}).catch((err) => log.error("mark runtimeId null failed", { memberName, error: String(err) }));
			} catch (err) {
				log.error("cleanup failed", { memberName, error: String(err) });
				await updateRoomMemberState(roomDir, memberName, {
					state: "error",
					currentTask: null,
					currentTaskMessageId: null,
					spawnTaskId: null,
					lastError: "Owner heartbeat stale; member stop failed and requires reaping.",
				}).catch((err) => log.error("mark member error after stop failed", { memberName, error: String(err) }));
			}
		}
		await updateRoomMemberState(roomDir, memberName, {
			state: "error",
			sessionId: null,
			currentTask: null,
			currentTaskMessageId: null,
			spawnTaskId: null,
			updatedAt: new Date().toISOString(),
		}).catch((err) => log.error("mark member error after stale owner cleanup", { memberName, error: String(err) }));
		// Eventual consistency: runtimeId is intentionally preserved so the next
		// reconcileMemberLiveness cycle can attempt cleanup with accurate state.
		if (member.runtimeId && adapter.stop) {
			return true;
		}
		return true;
	}

	let cleanupConfirmed = false;
	if (member.backend === "paseo" && adapter.remove) {
		try {
			await adapter.remove(member);
			cleanupConfirmed = true;
			log.info("cleanup ok", { memberName, runtimeId: member.runtimeId });
		} catch (err) {
			cleanupConfirmed = false;
			log.error("cleanup failed", { memberName, error: String(err) });
		}
	} else if (adapter.stop) {
		try {
			await adapter.stop(member);
			cleanupConfirmed = true;
			log.info("cleanup ok", { memberName, runtimeId: member.runtimeId });
		} catch (err) {
			cleanupConfirmed = false;
			log.error("cleanup failed", { memberName, error: String(err) });
		}
	}

	if (cleanupConfirmed) {
		await updateRoomMemberState(roomDir, memberName, {
			state: "error",
			runtimeId: null,
			sessionId: null,
			currentTask: null,
			currentTaskMessageId: null,
			spawnTaskId: null,
			updatedAt: new Date().toISOString(),
		}).catch((err) => log.error("mark member error failed", { memberName, error: String(err) }));
	}
	return true;
}

export async function reconcileSpawnTimeouts(
	roomDir: string,
	adapters: RoomAdapterMap,
	options: WatchdogOptions = {},
): Promise<void> {
	const log = createRoomLogger(roomDir, "watchdog");
	const joinTimeoutMs = options.joinTimeoutMs ?? getRoomSpawnJoinTimeoutMs();
	const paseoExternalCreateTimeoutMs = options.paseoExternalCreateTimeoutMs ?? getRoomPaseoExternalCreateTimeoutMs();
	const paseoBootstrapClaimTimeoutMs = options.paseoBootstrapClaimTimeoutMs ?? getRoomPaseoBootstrapClaimTimeoutMs();
	const members = await listRoomMembers(roomDir).catch(() => []);
	for (const member of members) {
		if (member.state !== "spawning" || !member.spawnTaskId) continue;
		let pendingLostInfo: { taskMessageId: string; taskSummary: string; memberName: string } | null = null;
		const timedOut = await withRoomMutationLock(roomDir, async () => {
			const current = await loadRoomMemberState(roomDir, member.name).catch(() => null);
			if (!current || current.state !== "spawning" || !current.spawnTaskId) return null;

			const job = await readSpawnJob(roomDir, current.spawnTaskId).catch(() => null);
			if (job && (job.state === "completed" || job.state === "cancelled" || job.state === "failed" || job.state === "timed_out_pending_external_resolution" || job.state === "timed_out_pending_member_claim")) {
				return null;
			}

			if ((job?.backend ?? current.backend) === "paseo") {
				const phase = job?.state ?? "starting";
				const phaseStartedAt = Date.parse((phase === "starting" ? job?.createdAt : job?.updatedAt) ?? current.updatedAt);
				const timeoutMs = phase === "starting"
					? paseoExternalCreateTimeoutMs
					: (phase === "external_created" || phase === "claimed")
						? paseoBootstrapClaimTimeoutMs
						: null;
				if (!timeoutMs || !Number.isFinite(phaseStartedAt) || Date.now() - phaseStartedAt < timeoutMs) {
					return null;
				}

				const nextState = phase === "starting"
					? "timed_out_pending_external_resolution"
					: "timed_out_pending_member_claim";
				const errorMessage = phase === "starting"
					? "Spawn timed out waiting for external agent creation."
					: "Spawn timed out waiting for member bootstrap claim.";
				await transitionSpawnJobRecord(roomDir, job ?? {
					taskId: current.spawnTaskId,
					memberName: current.name,
					backend: current.backend,
					runtimeId: current.runtimeId,
					createdAt: current.updatedAt,
					updatedAt: current.updatedAt,
					error: null,
				}, {
					state: nextState,
					updatedAt: new Date().toISOString(),
					error: errorMessage,
				});
				return {
					kind: "paseo-pending" as const,
					member: current,
					previousState: phase,
					nextState,
					errorMessage,
				};
			}

			const startedAt = Date.parse(job?.createdAt ?? current.updatedAt);
			if (!Number.isFinite(startedAt) || Date.now() - startedAt < joinTimeoutMs) return null;

			// Capture task info before clearing (spawning members have null currentTaskMessageId,
			// so this is typically a no-op, but included for correctness)
			if (current.currentTaskMessageId && current.currentTask) {
				pendingLostInfo = {
					taskMessageId: current.currentTaskMessageId,
					taskSummary: current.currentTask,
					memberName: current.name,
				};
			}

			const errorMessage = "Spawn timed out before bootstrap claim.";
			const failedJob: RoomSpawnJob = {
				taskId: current.spawnTaskId,
				memberName: current.name,
				backend: current.backend,
				runtimeId: current.runtimeId,
				state: "failed",
				createdAt: job?.createdAt ?? current.updatedAt,
				updatedAt: new Date().toISOString(),
				error: errorMessage,
			};
			await transitionSpawnJobRecord(roomDir, failedJob, {
				state: "failed",
				updatedAt: failedJob.updatedAt,
				error: errorMessage,
			});
			return {
				kind: "legacy-failed" as const,
				member: current,
				errorMessage,
			};
		});
		if (pendingLostInfo) {
			await writeAgentLostBoardMessage(roomDir, pendingLostInfo.memberName, pendingLostInfo.taskMessageId, pendingLostInfo.taskSummary);
			pendingLostInfo = null;
		}
		if (!timedOut) continue;
		if (timedOut.kind === "paseo-pending") {
			log.info("spawn phase transition", {
				memberName: timedOut.member.name,
				taskId: timedOut.member.spawnTaskId,
				backend: timedOut.member.backend,
				from: timedOut.previousState,
				to: timedOut.nextState,
				reason: timedOut.errorMessage,
			});
			continue;
		}
		const spawnTaskId = timedOut.member.spawnTaskId;
		if (!spawnTaskId) continue;
		log.info("spawn timed out", { memberName: timedOut.member.name, spawnTaskId });

		if (!timedOut.member.runtimeId) {
			await withRoomMutationLock(roomDir, async () => {
				const current = await loadRoomMemberState(roomDir, timedOut.member.name).catch(() => null);
				if (!current || current.state === "removed" || current.spawnTaskId !== spawnTaskId) return;
				const job = await readSpawnJob(roomDir, spawnTaskId).catch(() => null);
				if (job?.state === "cancelled") return;
				const protectedSeq = await getLastDeliverableMessageSeq(roomDir, timedOut.member.name).catch(() => current.lastSeenSeq);
				await writeRoomMemberState(roomDir, {
					...current,
					state: "error",
					lastError: timedOut.errorMessage,
					currentTask: null,
					currentTaskMessageId: null,
					spawnTaskId: null,
					lastSeenSeq: Math.max(current.lastSeenSeq, protectedSeq),
					runtimeId: null,
					sessionId: null,
					updatedAt: new Date().toISOString(),
				});
			}).catch((err) => log.error("reconcile spawn timeout cleanup lock failed", { memberName: timedOut.member.name, error: String(err) }));
			continue;
		}

		let cleanupConfirmed = false;
		try {
			const adapter = getAdapter(timedOut.member, adapters);
			if (adapter.remove) {
				await adapter.remove(timedOut.member);
				cleanupConfirmed = true;
			} else if (adapter.stop) {
				await adapter.stop(timedOut.member);
				cleanupConfirmed = true;
			}
			log.info("cleanup ok", { memberName: timedOut.member.name, runtimeId: timedOut.member.runtimeId });
		} catch (err) {
			cleanupConfirmed = false;
			log.error("cleanup failed", { memberName: timedOut.member.name, error: String(err) });
		}

		if (cleanupConfirmed) {
			await withRoomMutationLock(roomDir, async () => {
				const current = await loadRoomMemberState(roomDir, timedOut.member.name).catch(() => null);
				if (!current || current.state === "removed" || current.spawnTaskId !== spawnTaskId) return;
				const job = await readSpawnJob(roomDir, spawnTaskId).catch(() => null);
				if (job?.state === "cancelled") return;
				const protectedSeq = await getLastDeliverableMessageSeq(roomDir, timedOut.member.name).catch(() => current.lastSeenSeq);
				await writeRoomMemberState(roomDir, {
					...current,
					state: "error",
					lastError: timedOut.errorMessage,
					currentTask: null,
					currentTaskMessageId: null,
					spawnTaskId: null,
					lastSeenSeq: Math.max(current.lastSeenSeq, protectedSeq),
					runtimeId: null,
					sessionId: null,
					updatedAt: new Date().toISOString(),
				});
			}).catch((err) => log.error("mark member error after cleanup failed", { memberName: timedOut.member.name, error: String(err) }));
			continue;
		}

		await withRoomMutationLock(roomDir, async () => {
			const current = await loadRoomMemberState(roomDir, timedOut.member.name).catch(() => null);
			if (!current || current.state === "removed" || current.spawnTaskId !== spawnTaskId) return;
			const job = await readSpawnJob(roomDir, spawnTaskId).catch(() => null);
			if (job?.state === "cancelled") return;
			await writeRoomMemberState(roomDir, {
				...current,
				state: "error",
				lastError: timedOut.errorMessage,
				currentTask: null,
				currentTaskMessageId: null,
				spawnTaskId: null,
				updatedAt: new Date().toISOString(),
			});
		}).catch((err) => log.error("mark member error after cleanup failed", { memberName: timedOut.member.name, error: String(err) }));
	}
}

export async function reconcileMemberLiveness(
	roomDir: string,
	adapters: RoomAdapterMap,
	options: WatchdogOptions = {},
): Promise<void> {
	const log = createRoomLogger(roomDir, "watchdog");
	const members = await listRoomMembers(roomDir).catch(() => []);
	let jobsPendingExternalCleanup = 0;
	try {
		const jobEntries = await fs.readdir(getRoomJobsDir(roomDir));
		for (const entry of jobEntries.filter((candidate) => candidate.startsWith("spawn-") && candidate.endsWith(".json"))) {
			const job = await readJsonFile<RoomSpawnJob>(`${getRoomJobsDir(roomDir)}/${entry}`).catch(() => null);
			if (job?.state === "timed_out_pending_external_resolution" || job?.state === "timed_out_pending_member_claim") {
				jobsPendingExternalCleanup += 1;
			}
		}
	} catch {
		jobsPendingExternalCleanup = 0;
	}
	log.debug("reconcileMemberLiveness tick", {
		activeMembers: members.filter((member) => member.state !== "spawning" && member.state !== "removed").length,
		spawningMembers: members.filter((member) => member.state === "spawning").length,
		removedMembers: members.filter((member) => member.state === "removed").length,
		jobsPendingExternalCleanup,
	});
	for (const member of members) {
		if (member.type === "owner" || member.state === "spawning" || member.state === "removed") continue;

		const observed = await observeMemberLiveness(roomDir, member, adapters, options);

		let pendingLostInfo: { taskMessageId: string; taskSummary: string; memberName: string } | null = null;

		const reconciled = await withRoomMutationLock(roomDir, async () => {
			const current = await loadRoomMemberState(roomDir, member.name).catch(() => null);
			if (!current || current.type === "owner" || current.state === "spawning"
				|| current.state === "removed") return null;

			if (
				current.updatedAt !== observed.member.updatedAt ||
				current.state !== observed.member.state ||
				current.spawnTaskId !== observed.member.spawnTaskId ||
				current.sessionId !== observed.member.sessionId ||
				current.bootstrapClaimedAt !== observed.member.bootstrapClaimedAt
			) {
				return null;
			}

			let effectiveIsLive: boolean;
			if (current.backend === "paseo") {
				const localHeartbeatDefinitelyDead =
					!observed.heartbeatFresh &&
					!observed.fallbackFresh &&
					!observed.heartbeatPidAlive;
				if (!observed.authoritative) {
					if (localHeartbeatDefinitelyDead) {
						log.warn("paseo liveness inconclusive with stale dead heartbeat", {
							memberName: current.name,
							runtimeId: current.runtimeId,
							detail: observed.detail,
						});
						effectiveIsLive = false;
					} else {
					log.debug("paseo liveness inconclusive", {
						memberName: current.name,
						runtimeId: current.runtimeId,
						detail: observed.detail,
					});
						return null;
					}
				} else {
					effectiveIsLive = observed.live;
					if (effectiveIsLive) {
						log.debug("paseo liveness authoritative positive", {
							memberName: current.name,
							runtimeId: current.runtimeId,
							detail: observed.detail,
						});
					}
				}
			} else {
				effectiveIsLive =
					(observed.heartbeatFresh && observed.heartbeatPidAlive) ||
					(!observed.heartbeatFresh && observed.fallbackFresh && observed.live);
			}

			// Self-heal: error-state members whose liveness is confirmed (including
			// checkLiveness for paseo backend) should transition back to idle rather
			// than staying permanently broken. Using effectiveIsLive ensures paseo
			// agents that checkLiveness has confirmed dead are NOT self-healed.
			if (current.state === "error" && effectiveIsLive) {
				const claimStillMatches = current.backend !== "paseo" || (
					(Boolean(observed.member.sessionId) && observed.member.sessionId === current.sessionId) ||
					(Boolean(observed.member.bootstrapClaimedAt) && observed.member.bootstrapClaimedAt === current.bootstrapClaimedAt)
				);
				if (!observed.authoritative || !claimStillMatches) {
					return null;
				}
				// P1: Only self-heal in active rooms.
				const metadata = await loadRoomMetadata(roomDir).catch(() => null);
				if (!metadata || metadata.state !== "active") {
					return null;
				}

				const protectedSeq = await getLastDeliverableMessageSeq(
					roomDir, current.name,
				).catch(() => current.lastSeenSeq);

				const healed: RoomMemberState = {
					...current,
					state: "idle",
					lastError: null,
					runtimeId: current.runtimeId,
					// P0-1: Keep original sessionId, NEVER synthesize
					sessionId: current.sessionId,
					lastSeenSeq: Math.max(current.lastSeenSeq, protectedSeq),
					updatedAt: new Date().toISOString(),
				};
				await writeRoomMemberState(roomDir, healed);
				log.info("member self-healed from error", { memberName: current.name });
				return healed;
			}

			if (effectiveIsLive) return null;

			// Capture currentTask info before clearing it in the next state
			if (current.currentTaskMessageId && current.currentTask) {
				pendingLostInfo = {
					taskMessageId: current.currentTaskMessageId,
					taskSummary: current.currentTask,
					memberName: current.name,
				};
			}

			const reason = !observed.heartbeatPidAlive && observed.live
				? "Member heartbeat PID is not alive."
				: observed.heartbeatFresh === false && observed.fallbackFresh === false
					? "Member heartbeat stale."
					: current.runtimeId && !observed.live
						? "Member runtime is not alive."
						: "Member heartbeat stale.";

			const protectedSeq = await getLastDeliverableMessageSeq(roomDir, current.name)
				.catch(() => current.lastSeenSeq);

			if (current.transient) {
				const removed: RoomMemberState = {
					...current,
					state: "removed",
					runtimeId: null,
					sessionId: null,
					currentTask: null,
					currentTaskMessageId: null,
					spawnTaskId: null,
					lastSeenSeq: Math.max(current.lastSeenSeq, protectedSeq),
					lastError: reason,
					updatedAt: new Date().toISOString(),
				};
				await writeRoomMemberState(roomDir, removed);
				return removed;
			}

			const next: RoomMemberState = {
				...current,
				state: "error",
				runtimeId: current.backend === "paseo"
					? current.runtimeId
					: (observed.live ? current.runtimeId : null),
				sessionId: null,
				currentTask: null,
				currentTaskMessageId: null,
				spawnTaskId: null,
				lastSeenSeq: Math.max(current.lastSeenSeq, protectedSeq),
				lastError: reason,
				updatedAt: new Date().toISOString(),
			};
			await writeRoomMemberState(roomDir, next);
			return next;
		});

		// Write agent-lost board message after lock release
		if (pendingLostInfo) {
			await writeAgentLostBoardMessage(roomDir, pendingLostInfo.memberName, pendingLostInfo.taskMessageId, pendingLostInfo.taskSummary);
			pendingLostInfo = null;
		}

		// Once liveness cleanup confirms the runtime is gone and did not recover,
		// reclaim the isolated worktree as part of the same watchdog path. If the
		// worktree contains changes, commit them onto the member branch before
		// removing the worktree. This keeps agent-lost cleanup self-contained.

		let cleanupOk = false;
		if (reconciled?.runtimeId) {
			try {
				const adapter = getAdapter(reconciled, adapters);
				if (adapter.remove) { await adapter.remove(reconciled); cleanupOk = true; }
				else if (adapter.stop) { await adapter.stop(reconciled); cleanupOk = true; }
			} catch (err) {
				log.error("cleanup failed", { memberName: reconciled.name, error: String(err) });
			}
		} else if (reconciled) {
			cleanupOk = true;
		}

		if (!reconciled || !cleanupOk) continue;

		if (reconciled.state === "removed") {
			if (reconciled.worktree?.path) {
				const metadata = await loadRoomMetadata(roomDir).catch(() => null);
				const cwd = metadata?.cwd ?? process.cwd();
				try {
					await archiveMemberWorktreeCleanup(
						roomDir,
						cwd,
						reconciled,
						{
							branchLabel: reconciled.name,
							commitMessage: `pi-agent: auto-cleanup for transient ${reconciled.name} (agent lost)`,
						},
					);
				} catch {
					// Best-effort: transient auto-removal follows the same semantics as remove.
				}
			}
			continue;
		}

		const freshHb = await readMemberHeartbeat(roomDir, reconciled.name);
		let recovered = freshHb
			&& Date.now() - Date.parse(freshHb.updatedAt) <= observed.memberStaleMs
			&& isProcessAlive(freshHb.pid);
		// For paseo backend, heartbeat PID belongs to daemon (not the agent),
		// so validate recovery via checkLiveness to avoid false recovery.
		if (recovered && reconciled.backend === "paseo") {
			const adapter = getAdapter(reconciled, adapters);
			if (adapter.observeLiveness) {
				const recoveryObservation = await adapter.observeLiveness(reconciled).catch(() => null);
				recovered = recoveryObservation ? (recoveryObservation.authoritative && recoveryObservation.live) : false;
			} else if (adapter.checkLiveness) {
				recovered = await adapter.checkLiveness(reconciled).catch(() => true);
			}
		}
		if (recovered && freshHb) {
			log.info("member recovered during cleanup, skipping remove",
				{ memberName: reconciled.name });
			await updateRoomMemberState(roomDir, reconciled.name, {
				state: "idle",
				lastError: null,
				runtimeId: reconciled.backend === "pi" ? String(freshHb.pid) : reconciled.runtimeId,
			}).catch((err) => createRoomLogger(roomDir, "watchdog").warn("recovery update failed", { memberName: reconciled.name, error: String(err) }));
			continue;
		}

		if (reconciled.worktree?.path) {
			const metadata = await loadRoomMetadata(roomDir).catch(() => null);
			const cwd = metadata?.cwd ?? process.cwd();
			try {
				await archiveMemberWorktreeCleanup(
					roomDir,
					cwd,
					reconciled,
					{
						branchLabel: reconciled.name,
						commitMessage: `pi-agent: agentlost auto-cleanup for ${reconciled.name} (may be incomplete)`,
					},
				);
			} catch {
				// Best-effort: agent-lost cleanup follows the same semantics as remove.
			}
		}

		const finalSeq = await getLastDeliverableMessageSeq(roomDir, reconciled.name)
			.catch(() => reconciled.lastSeenSeq);
		await updateRoomMemberState(roomDir, reconciled.name, {
			state: "error",
			runtimeId: null,
			sessionId: null,
			currentTask: null,
			currentTaskMessageId: null,
			spawnTaskId: null,
			worktree: null,
			lastSeenSeq: Math.max(reconciled.lastSeenSeq, finalSeq),
			updatedAt: new Date().toISOString(),
		}).catch((err) => log.error("mark error failed",
			{ memberName: reconciled.name, error: String(err) }));
	}

	// Prune orphaned worktrees (crash recovery, best-effort).
	// NOTE: `git worktree prune` is a global operation — it removes all
	// dangling worktrees across the entire repository, not just this room's.
	// This is intentional for crash recovery but may affect other rooms
	// sharing the same cwd (which should not normally happen).
	const metadata = await loadRoomMetadata(roomDir).catch(() => null);
	const cwd = metadata?.cwd ?? process.cwd();
	pruneWorktrees(cwd).catch(() => {});
}

export async function reapRoom(roomDir: string, adapters: RoomAdapterMap): Promise<boolean> {
	const metadata = await loadRoomMetadata(roomDir).catch(() => null);
	if (!metadata) return false;
	const log = createRoomLogger(roomDir, "watchdog");
	let deleted = false;
	const isStillStale = async (): Promise<boolean> => {
		return await withRoomMutationLock(roomDir, async () => {
			const currentMetadata = await loadRoomMetadata(roomDir).catch(() => null);
			if (!currentMetadata) return false;
			if (currentMetadata.ownerSessionId !== metadata.ownerSessionId) return false;
			return currentMetadata.state === "closing" || (await isOwnerHeartbeatStale(roomDir));
		});
	};

	await withSerializedOwnerRoomMutation(path.dirname(roomDir), metadata.ownerSessionId, [roomDir], async () => {
		const snapshot = await withRoomMutationLock(roomDir, async () => {
			const currentMetadata = await loadRoomMetadata(roomDir).catch(() => null);
			if (!currentMetadata) return null;
			if (currentMetadata.ownerSessionId !== metadata.ownerSessionId) return null;
			const stale = currentMetadata.state === "closing" || (await isOwnerHeartbeatStale(roomDir));
			if (!stale) return null;
			await cancelPendingSpawnJobsLocked(roomDir, `Room ${currentMetadata.roomId} is closing.`);
			return {
				metadata: currentMetadata,
				members: (await listRoomMembers(roomDir).catch(() => [])).filter((member) => member.type !== "owner"),
			};
		});
		if (!snapshot) return;
		if (!(await isStillStale())) {
			log.info("room no longer stale before member cleanup", { roomId: snapshot.metadata.roomId });
			return;
		}

		let cleanupFailed = false;
		for (const member of snapshot.members) {
			if (!(await isStillStale())) {
				log.info("room no longer stale during member cleanup", { roomId: snapshot.metadata.roomId, memberName: member.name });
				return;
			}
			if (!member.runtimeId) continue;
			const adapter = getAdapter(member, adapters);
			try {
				if (adapter.remove) {
					await adapter.remove(member);
				} else {
					await adapter.stop?.(member);
				}
			} catch {
				cleanupFailed = true;
			}
		}

		// ── Worktree cleanup: remove any orphaned worktrees left behind ──
		// Agents that were removed/stopped normally already had their worktrees
		// cleaned up. This handles the case where an agent became unhealthy and
		// the worktree was intentionally left intact (watchdog no longer commits
		// on behalf of unhealthy agents — that's the user's decision via remove/merge).
		const cwd = snapshot.metadata.cwd;
		for (const member of snapshot.members) {
			if (!member.worktree?.path) continue;
			try {
				await git(["worktree", "remove", "--force", member.worktree.path], cwd, 10_000);
			} catch {
				// Best-effort: orphaned worktree on disk is harmless
			}
		}

		if (cleanupFailed) {
			log.error("room cleanup failed, orphaned", { roomId: metadata.roomId });
			await withRoomMutationLock(roomDir, async () => {
				const currentMetadata = await loadRoomMetadata(roomDir).catch(() => null);
				if (!currentMetadata) return;
				if (currentMetadata.ownerSessionId !== metadata.ownerSessionId) return;
				const stillStale = currentMetadata.state === "closing" || (await isOwnerHeartbeatStale(roomDir));
				if (!stillStale) {
					log.info("room recovered before orphaning after cleanup failure", { roomId: currentMetadata.roomId });
					return;
				}
				await cancelPendingSpawnJobsLocked(roomDir, `Room ${currentMetadata.roomId} cleanup failed.`);
				await writeRoomMetadata(roomDir, { ...currentMetadata, state: "orphaned" }).catch((err) => log.error("write orphaned metadata failed", { roomId: metadata.roomId, error: String(err) }));
			});
			return;
		}

		let stillStale = false;
		await withRoomMutationLock(roomDir, async () => {
			const currentMetadata = await loadRoomMetadata(roomDir).catch(() => null);
			if (!currentMetadata) return;
			if (currentMetadata.ownerSessionId !== metadata.ownerSessionId) return;
			stillStale = currentMetadata.state === "closing" || (await isOwnerHeartbeatStale(roomDir));
			if (!stillStale) {
				log.info("room no longer stale during reap finalization", { roomId: currentMetadata.roomId });
				return;
			}
			await writeRoomMetadata(roomDir, { ...currentMetadata, state: "reaped" }).catch((err) => log.error("write reaped metadata failed", { roomId: metadata.roomId, error: String(err) }));
		});
		if (!stillStale) {
			return;
		}
		log.info("room reaped", { roomId: metadata.roomId });
		await closeLogStream(roomDir);
		// Clean up module-level dependency index entries for this room (H2)
		clearRoomDeps(roomDir);
		await clearOwnerRoomIndex(path.dirname(roomDir), snapshot.metadata.ownerSessionId, snapshot.metadata.roomId).catch((err) => {
			log.error("clear owner room index failed", { roomId: snapshot.metadata.roomId, error: String(err) });
		});
		await fs.rm(roomDir, { recursive: true, force: true });
		deleted = true;
	});

	return deleted;
}

export async function reapStaleRooms(
	runtimeRoot: string,
	adapters: RoomAdapterMap,
	options: WatchdogOptions = {},
): Promise<string[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(runtimeRoot);
	} catch {
		return [];
	}

	const log = createRoomLogger(null, "watchdog");
	const reaped: string[] = [];
	for (const entry of entries.sort()) {
		const roomDir = `${runtimeRoot}/${entry}`;
		const metadata = await loadRoomMetadata(roomDir).catch(() => null);
		if (!metadata) continue;
		if (options.excludeRoomIds?.has(metadata.roomId)) continue;
		if (options.excludeOwnerSessionIds?.has(metadata.ownerSessionId)) continue;
		const stale = metadata.state === "closing" || (await isOwnerHeartbeatStale(roomDir, options));
		if (!stale) continue;
		if (await reapRoom(roomDir, adapters)) {
			log.info("stale room reaped", { roomId: metadata.roomId });
			reaped.push(metadata.roomId);
		}
	}

	return reaped;
}
