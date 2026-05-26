import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	shouldDeliverMessage,
	shouldQueueCallerDirectedMessage,
} from "./dispatch.ts";
import { withFileLock, type FileLockOptions } from "./lock.ts";
import { createRoomLogger } from "./logger.ts";
import { buildCrewLifecycleEvent } from "./integration-events.ts";
import type {
	CrewAddActivation,
	CrewAddReplayDeliveryGate,
	CrewAddReplayableEvent,
	CrewAddReplayLifecycleSnapshot,
	CrewAddReplayRecord,
	CrewAddReplaySeed,
	CrewControlReplayRecord,
	CrewControlVerb,
	CrewReplayDeliveryState,
	CrewReplayLifecycleEventName,
	RoomBackend,
	RoomBootstrap,
	RoomMemberState,
	RoomMessage,
	RoomMetadata,
	RoomSpawnJob,
	RoomSpawnJobState,
} from "./types.ts";
import { loadTypedRoomAgentDefinition } from "./bootstrap.ts";
import type { MutationClient } from "./mutation-client.ts";

// ── Mutation Proxy Registry ──────────────────────────────────────────────
// Stores proxy server instances by roomDir for owner-side short-circuit.
// Avoids circular dependency between storage.ts and mutation-proxy.ts.

export interface RoomMutationProxy {
	enqueue<T>(fn: () => Promise<T>): Promise<T>;
	stop(): Promise<void>;
}

export type SessionClaimMutationResult = RoomMemberState & {
	claimedEvent: CrewAddReplayableEvent | null;
	activatedEvent: CrewAddReplayableEvent | null;
};

const roomProxyServers = new Map<string, RoomMutationProxy>();
const roomProxyInitPromises = new Map<string, Promise<RoomMutationProxy>>();

/**
 * Ensure a mutation proxy server is started for the room.
 * Idempotent and concurrency-safe: concurrent callers either
 * wait for the same init promise or get the already-registered proxy.
 */
export async function ensureRoomProxy(roomDir: string): Promise<RoomMutationProxy> {
	const existing = getRoomProxyServer(roomDir);
	if (existing) return existing;

	const pending = roomProxyInitPromises.get(roomDir);
	if (pending) return pending;

	const promise = (async () => {
		const { createMutationProxy } = await import("./mutation-proxy.ts");
		const proxyServer = createMutationProxy(roomDir);
		await proxyServer.start();
		setRoomProxyServer(roomDir, proxyServer);
		return proxyServer;
	})();

	roomProxyInitPromises.set(roomDir, promise);
	try {
		return await promise;
	} finally {
		roomProxyInitPromises.delete(roomDir);
	}
}

/** Register a mutation proxy for a room. Called from index.ts after proxy starts. */
export function setRoomProxyServer(roomDir: string, proxy: RoomMutationProxy): void {
	roomProxyServers.set(roomDir, proxy);
}

/** Unregister a mutation proxy. Called from index.ts after proxy stops. */
export function deleteRoomProxyServer(roomDir: string): void {
	roomProxyServers.delete(roomDir);
}

function getRoomProxyServer(roomDir: string): RoomMutationProxy | undefined {
	return roomProxyServers.get(roomDir);
}

// ── Mutation Client Registry (agent-side socket proxy) ────────────────────
// Agent processes connect to the owner's proxy via Unix socket.
// The MutationClient routes appends, updates, and joins through the socket
// instead of competing for the file lock.

const roomMutationClients = new Map<string, MutationClient>();

/** Register a mutation client for a room. Called from index.ts after agent connects. */
export function setRoomMutationClient(roomDir: string, client: MutationClient): void {
	roomMutationClients.set(roomDir, client);
}

/** Unregister a mutation client. Called from index.ts on shutdown. */
export function deleteRoomMutationClient(roomDir: string): void {
	roomMutationClients.delete(roomDir);
}

export function getRoomMutationClient(roomDir: string): MutationClient | undefined {
	return roomMutationClients.get(roomDir);
}

/**
 * Send a notify_deps command through the mutation proxy (agent → owner).
 *
 * The proxy handler will:
 *   1. Update the upstream task's state in the Owner's taskStates table
 *   2. Notify downstream dependent tasks using the owner-authoritative helper
 *
 * Returns `true` if dispatched, `false` if proxy unavailable.
 *
 * Used by executeCrewReply on member processes.
 */
export async function tryNotifyDepsViaProxy(
	roomDir: string,
	upstreamSeq: number,
	taskMessageId: string | undefined,
	status: "completed" | "error" | "cancelled",
): Promise<boolean> {
	const client = getRoomMutationClient(roomDir);
	if (!client || client.getState() !== "connected") return false;
	await client.send<void>({
		kind: "notify_deps",
		payload: { upstreamSeq, taskMessageId, status },
	});
	return true;
}

/**
 * Send a remove_transient_member command through the mutation proxy (agent → owner).
 * The owner proxy handler will write the member state as "removed", cancel any
 * pending spawn job, and write a board notification.
 *
 * Returns true if dispatched, false if proxy unavailable.
 */
export async function tryRemoveTransientViaProxy(
	roomDir: string,
	memberName: string,
	taskSummary: string,
	replyKind: "completion" | "error",
	errorSummary?: string,
): Promise<boolean> {
	const client = getRoomMutationClient(roomDir);
	if (!client || client.getState() !== "connected") return false;
	await client.send<void>({
		kind: "remove_transient_member",
		payload: { memberName, taskSummary, replyKind, errorSummary },
	});
	return true;
}

/**
 * Compute the heartbeat stale timeout for a member.
 * Checks agent definition's heartbeatStaleMs first, then env, then default 5000ms.
 */
function computeHeartbeatStaleMs(memberType: string): number {
	const agentDef = loadTypedRoomAgentDefinition(memberType);
	if (agentDef?.heartbeatStaleMs && agentDef.heartbeatStaleMs > 0) {
		return agentDef.heartbeatStaleMs;
	}
	const raw = Number(process.env.PI_ROOM_MEMBER_HEARTBEAT_STALE_MS ?? "5000");
	return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

/**
 * Try to execute a storage op through the agent's MutationClient.
 * Returns the result on success, or undefined if no client is registered
 * (owner path — fall through to withRoomMutationLock which will use proxy).
 * Throws AgentProxyDisconnectedError if a client IS registered but not
 * connected — agent processes MUST have a live proxy connection.
 */
async function tryViaMutationClient<T>(
	roomDir: string,
	command: Parameters<MutationClient["send"]>[0],
): Promise<T | undefined> {
	if (_proxyContext.getStore() === true) return undefined;
	const client = getRoomMutationClient(roomDir);
	if (!client) return undefined;
	if (client.getState() !== "connected") {
		throw new AgentProxyDisconnectedError(
			`Mutation client is not connected to owner proxy (state: ${client.getState()}). ` +
			"Agent storage operations require a live proxy connection.",
		);
	}
	try {
		return await client.send<T>(command);
	} catch (err) {
		// If the proxy returned a business-logic error (e.g. MemberNotAvailable),
		// propagate it to the caller instead of falling back to file lock.
		// The file lock path would retry the same failing operation, wasting
		// lock-acquisition time and contributing to contention.
		// Infrastructure errors (socket disconnect, p-queue timeout, queue-full)
		// still fall through to the file-lock path.
		const code = (err as NodeJS.ErrnoException).code;
		if (code && code !== "PROXY_ERROR") {
			throw err;
		}
		const log = createRoomLogger(roomDir, "storage");
		log.warn("tryViaMutationClient: proxy send failed, falling back to file lock", {
			command: command.kind,
			error: String(err),
			code: code ?? "(none)",
			clientState: client.getState(),
		});
		return undefined;
	}
}
// ── Proxy Context Flag ───────────────────────────────────────────────────────────────────────
// When the mutation proxy server executes a command via its PQueue,
// the storage functions it calls must NOT re-enter withRoomMutationLock
// (which would create nested PQueue items and deadlock).
// We use AsyncLocalStorage to scope the flag to the PQueue item's
// async context, preventing non-PQueue code paths from accidentally
// bypassing serialization.

import { AsyncLocalStorage } from "node:async_hooks";
const _proxyContext = new AsyncLocalStorage<boolean>();

/**
 * Execute fn with the proxy-context flag set to true in this async scope.
 * Any withRoomMutationLock calls inside fn will skip both proxy
 * and file-lock serialization, executing the function directly
 * (the caller, i.e. the PQueue, is responsible for serialization).
 * Non-PQueue callers of withRoomMutationLock that happen to run
 * concurrently are NOT affected (AsyncLocalStorage scoping).
 */
export function runInsideProxyContext<T>(fn: () => Promise<T>): Promise<T> {
	return _proxyContext.run(true, fn);
}

import {
	BootstrapTokenError,
	MemberAlreadyExistsError,
	MemberNotAvailableError,
	MemberNotFoundError,
	RoomError,
	RoomNotFoundError,
	RoomNotClaimableError,
	SpawnFailedError,
	ValidationError,
	AgentProxyDisconnectedError,
} from "./errors.ts";

const SEQ_PADDING = 10;

const ROOM_MEMBER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const ROOM_MEMBER_LABEL_PATTERN = /^([^#]+)#([^#]+)$/;
const PASEO_ONLY_SPAWN_STATES = new Set<RoomSpawnJobState>([
	"external_created",
	"claimed",
	"timed_out_pending_external_resolution",
	"timed_out_pending_member_claim",
]);

export function isValidRoomMemberName(memberName: string): boolean {
	return ROOM_MEMBER_NAME_PATTERN.test(memberName);
}

function assertValidRoomMemberName(memberName: string): void {
	if (!isValidRoomMemberName(memberName)) {
		throw new ValidationError("Member names must start with a letter or number and use only letters, numbers, hyphens, or underscores.");
	}
}

export function normalizeMemberDisplayName(input: string): string {
	const normalized = input.trim();
	assertValidRoomMemberName(normalized);
	return normalized;
}

export function getMemberDisplayName(member: RoomMemberState): string {
	const displayName = member.displayName?.trim();
	return displayName && displayName.length > 0 ? displayName : member.name;
}

export function formatMemberLabel(member: RoomMemberState): string {
	const displayName = getMemberDisplayName(member);
	if (displayName === member.name) {
		return member.name;
	}
	const prefix = `${displayName}_`;
	if (!member.name.startsWith(prefix)) {
		return member.name;
	}
	const suffix = member.name.slice(prefix.length);
	if (!suffix || !isValidRoomMemberName(suffix)) {
		return member.name;
	}
	return `${displayName}#${suffix}`;
}

export function parseMemberLabel(input: string): { displayName: string; suffix: string } | null {
	const match = input.trim().match(ROOM_MEMBER_LABEL_PATTERN);
	if (!match) {
		return null;
	}
	const [, rawDisplayName, rawSuffix] = match;
	const displayName = rawDisplayName?.trim() ?? "";
	const suffix = rawSuffix?.trim() ?? "";
	if (!displayName || !suffix) {
		return null;
	}
	if (!isValidRoomMemberName(displayName) || !isValidRoomMemberName(suffix)) {
		return null;
	}
	return { displayName, suffix };
}

export function isValidMemberTargetInput(input: string): boolean {
	return isValidRoomMemberName(input.trim()) || parseMemberLabel(input) !== null;
}

function createInternalMemberNameFromSet(displayName: string, existingNames: Set<string>): string {
	const normalizedDisplayName = normalizeMemberDisplayName(displayName);
	for (;;) {
		const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toLowerCase();
		const candidate = `${normalizedDisplayName}_${suffix}`;
		if (!existingNames.has(candidate)) {
			return candidate;
		}
	}
}

export async function createInternalMemberName(roomDir: string, displayName: string): Promise<string> {
	const existingNames = new Set((await listRoomMembers(roomDir)).map((member) => member.name));
	return createInternalMemberNameFromSet(displayName, existingNames);
}

export async function findActiveMemberByDisplayName(roomDir: string, displayName: string): Promise<RoomMemberState | null> {
	const normalizedDisplayName = normalizeMemberDisplayName(displayName);
	const members = await listRoomMembers(roomDir);
	return members.find((member) => member.state !== "removed" && getMemberDisplayName(member) === normalizedDisplayName) ?? null;
}

export async function assertDisplayAliasAvailable(roomDir: string, displayName: string): Promise<void> {
	const normalizedDisplayName = normalizeMemberDisplayName(displayName);
	const members = await listRoomMembers(roomDir);
	const conflict = members.find((member) => {
		if (member.state === "removed") {
			return false;
		}
		return getMemberDisplayName(member) === normalizedDisplayName
			|| member.name === normalizedDisplayName
			|| formatMemberLabel(member) === normalizedDisplayName;
	});
	if (conflict) {
		throw new ValidationError(`Agent alias ${normalizedDisplayName} conflicts with active member ${formatMemberLabel(conflict)}.`);
	}
}

/**
 * Find an idle, non-transient member by their display alias and type.
 * Returns the member if found and idle with matching type, or null otherwise.
 *
 * Excludes:
 *  - Non-idle members (spawning, running, error, stopping, removed, chatting)
 *  - Transient members (auto-remove on completion; unsafe to reuse)
 *  - Type mismatches (prevents mixing agent roles, e.g. planner vs worker)
 */
export async function findIdleMemberByAlias(
	roomDir: string,
	displayName: string,
	memberType: string,
): Promise<RoomMemberState | null> {
	const normalized = normalizeMemberDisplayName(displayName);
	const members = await listRoomMembers(roomDir);
	const match = members.find((member) => {
		if (member.state !== "idle") return false;
		if (member.transient === true) return false;
		if (member.type !== memberType) return false;
		return getMemberDisplayName(member) === normalized;
	});
	return match ?? null;
}

export async function resolveMemberTarget(roomDir: string, input: string): Promise<RoomMemberState> {
	const trimmedInput = input.trim();
	const direct = await loadRoomMemberState(roomDir, trimmedInput).catch(() => null);
	if (direct && direct.state !== "removed") {
		return direct;
	}

	const parsedLabel = parseMemberLabel(trimmedInput);
	if (parsedLabel) {
		const byLabel = await loadRoomMemberState(roomDir, `${parsedLabel.displayName}_${parsedLabel.suffix}`).catch(() => null);
		if (byLabel && byLabel.state !== "removed" && formatMemberLabel(byLabel) === trimmedInput) {
			return byLabel;
		}
	}

	const normalizedDisplayName = normalizeMemberDisplayName(trimmedInput);
	const matches = (await listRoomMembers(roomDir)).filter((member) => {
		return member.state !== "removed" && getMemberDisplayName(member) === normalizedDisplayName;
	});
	if (matches.length === 1) {
		return matches[0]!;
	}
	if (matches.length > 1) {
		throw new ValidationError(`Member target ${trimmedInput} is ambiguous: ${matches.map((member) => formatMemberLabel(member)).join(", ")}`);
	}

	throw new MemberNotFoundError(trimmedInput);
}

export async function resolveMemberTargetForMerge(roomDir: string, input: string): Promise<RoomMemberState> {
	try {
		return await resolveMemberTarget(roomDir, input);
	} catch (error) {
		if (!(error instanceof MemberNotFoundError)) {
			throw error;
		}
	}

	const trimmedInput = input.trim();
	const direct = await loadRoomMemberState(roomDir, trimmedInput).catch(() => null);
	if (direct) {
		return direct;
	}

	const parsedLabel = parseMemberLabel(trimmedInput);
	if (parsedLabel) {
		const byLabel = await loadRoomMemberState(roomDir, `${parsedLabel.displayName}_${parsedLabel.suffix}`).catch(() => null);
		if (byLabel && formatMemberLabel(byLabel) === trimmedInput) {
			return byLabel;
		}
	}

	const normalizedDisplayName = normalizeMemberDisplayName(trimmedInput);
	const matches = (await listRoomMembers(roomDir)).filter((member) => getMemberDisplayName(member) === normalizedDisplayName);
	if (matches.length === 1) {
		return matches[0]!;
	}
	if (matches.length > 1) {
		throw new ValidationError(`Member target ${trimmedInput} is ambiguous: ${matches.map((member) => formatMemberLabel(member)).join(", ")}`);
	}

	throw new MemberNotFoundError(trimmedInput);
}

export function getDefaultRoomRuntimeRoot(): string {
	return path.join(os.homedir(), ".pi", "agent", "runtime", "rooms");
}

interface OwnerRoomIndexRecord {
	ownerSessionId: string;
	roomId: string;
	updatedAt: string;
}

interface OwnerRoomCandidate {
	roomDir: string;
	metadata: RoomMetadata;
	heartbeatFresh: boolean;
}

function encodeOwnerSessionLockKey(ownerSessionId: string): string {
	return Buffer.from(ownerSessionId).toString("hex");
}

function getOwnerIndexDir(runtimeRoot: string): string {
	return path.join(runtimeRoot, "owners");
}

function getOwnerRoomIndexPath(runtimeRoot: string, ownerSessionId: string): string {
	return path.join(getOwnerIndexDir(runtimeRoot), `${encodeOwnerSessionLockKey(ownerSessionId)}.json`);
}

function getOwnerSessionCreateLockPath(runtimeRoot: string, ownerSessionId: string): string {
	return path.join(runtimeRoot, "locks", `owner-${encodeOwnerSessionLockKey(ownerSessionId)}.lock`);
}

function getOwnerHeartbeatIndexStaleMs(): number {
	const raw = Number(process.env.PI_ROOM_OWNER_HEARTBEAT_STALE_MS ?? "5000");
	return Number.isFinite(raw) && raw > 0 ? raw : 5000;
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

async function loadOwnerRoomIndex(runtimeRoot: string, ownerSessionId: string): Promise<OwnerRoomIndexRecord | null> {
	try {
		return await readJsonFile<OwnerRoomIndexRecord>(getOwnerRoomIndexPath(runtimeRoot, ownerSessionId));
	} catch {
		return null;
	}
}

export async function writeOwnerRoomIndex(runtimeRoot: string, ownerSessionId: string, roomId: string): Promise<void> {
	await writeJsonAtomic(getOwnerRoomIndexPath(runtimeRoot, ownerSessionId), {
		ownerSessionId,
		roomId,
		updatedAt: new Date().toISOString(),
	});
}

export async function clearOwnerRoomIndex(runtimeRoot: string, ownerSessionId: string, expectedRoomId?: string): Promise<void> {
	const indexPath = getOwnerRoomIndexPath(runtimeRoot, ownerSessionId);
	if (expectedRoomId) {
		const existing = await loadOwnerRoomIndex(runtimeRoot, ownerSessionId);
		if (!existing || existing.roomId !== expectedRoomId) {
			return;
		}
	}
	await fs.rm(indexPath, { force: true });
}

async function withRoomPathLocks<T>(
	roomDirs: string[],
	getLockPath: (roomDir: string) => string,
	mutation: () => Promise<T>,
): Promise<T> {
	const uniqueRoomDirs = [...new Set(roomDirs)].sort((left, right) => left.localeCompare(right));
	const runWithRoomLocks = async (index: number): Promise<T> => {
		if (index >= uniqueRoomDirs.length) {
			return await mutation();
		}
		const roomDir = uniqueRoomDirs[index]!;
		return await withFileLock(getLockPath(roomDir), path.basename(roomDir), async () => {
			return await runWithRoomLocks(index + 1);
		});
	};

	return await runWithRoomLocks(0);
}

async function withRoomCleanupLocks<T>(roomDirs: string[], mutation: () => Promise<T>): Promise<T> {
	return await withRoomPathLocks(roomDirs, getRoomCleanupLockPath, mutation);
}

async function withRoomMutationLocks<T>(roomDirs: string[], mutation: () => Promise<T>): Promise<T> {
	return await withRoomPathLocks(roomDirs, getRoomMutationLockPath, mutation);
}

export async function withSerializedOwnerRoomMutation<T>(
	runtimeRoot: string,
	ownerSessionId: string,
	roomDirs: string[],
	mutation: () => Promise<T>,
	options: { includeMutationLocks?: boolean } = {},
): Promise<T> {
	return await withFileLock(getOwnerSessionCreateLockPath(runtimeRoot, ownerSessionId), ownerSessionId, async () => {
		return await withRoomCleanupLocks(roomDirs, async () => {
			if (!options.includeMutationLocks) {
				return await mutation();
			}
			return await withRoomMutationLocks(roomDirs, mutation);
		});
	});
}

async function repairOwnerRoomLookup(
	runtimeRoot: string,
	ownerSessionId: string,
	initialCandidates: OwnerRoomCandidate[],
	useOwnerLock: boolean,
): Promise<{ roomDir: string; metadata: RoomMetadata } | null> {
	const roomDirs = initialCandidates.map((candidate) => candidate.roomDir);
	const repair = async () => {
		const winner = selectPreferredOwnerRoom(await scanOwnerRoomCandidates(runtimeRoot, ownerSessionId));
		if (!winner) {
			await clearOwnerRoomIndex(runtimeRoot, ownerSessionId);
			return null;
		}

		await writeOwnerRoomIndex(runtimeRoot, ownerSessionId, winner.metadata.roomId);
		return { roomDir: winner.roomDir, metadata: winner.metadata };
	};

	return useOwnerLock
		? await withSerializedOwnerRoomMutation(runtimeRoot, ownerSessionId, roomDirs, repair, { includeMutationLocks: true })
		: await withRoomCleanupLocks(roomDirs, async () => await withRoomMutationLocks(roomDirs, repair));
}

async function readOwnerHeartbeat(roomDir: string): Promise<{ ownerPid?: number; updatedAt?: string } | null> {
	try {
		return await readJsonFile<{ ownerPid?: number; updatedAt?: string }>(getRoomHeartbeatPath(roomDir));
	} catch {
		return null;
	}
}

function isOwnerHeartbeatFresh(
	heartbeat: { ownerPid?: number; updatedAt?: string } | null,
	metadata: RoomMetadata,
): boolean {
	if (!heartbeat?.updatedAt) return false;
	const updatedAt = Date.parse(heartbeat.updatedAt);
	if (!Number.isFinite(updatedAt)) return false;
	const ownerPid = heartbeat.ownerPid ?? metadata.ownerPid;
	if (!isProcessAlive(ownerPid)) return false;
	return Date.now() - updatedAt <= getOwnerHeartbeatIndexStaleMs();
}

async function scanOwnerRoomCandidates(runtimeRoot: string, ownerSessionId: string): Promise<OwnerRoomCandidate[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(runtimeRoot);
	} catch {
		return [];
	}

	const candidates: OwnerRoomCandidate[] = [];
	for (const entry of entries.sort()) {
		const roomDir = path.join(runtimeRoot, entry);
		try {
			const metadata = await loadRoomMetadata(roomDir);
			if (metadata.ownerSessionId !== ownerSessionId) {
				continue;
			}
			const heartbeat = await readOwnerHeartbeat(roomDir);
			candidates.push({
				roomDir,
				metadata,
				heartbeatFresh: isOwnerHeartbeatFresh(heartbeat, metadata),
			});
		} catch {
			continue;
		}
	}

	return candidates;
}

function selectPreferredOwnerRoom(candidates: OwnerRoomCandidate[]): OwnerRoomCandidate | null {
	const viableCandidates = candidates.filter((candidate) => candidate.metadata.state !== "orphaned" && candidate.metadata.state !== "reaped");
	if (viableCandidates.length === 0) {
		return null;
	}

	return [...viableCandidates].sort((left, right) => {
		const leftPriority = left.metadata.state === "active" && left.heartbeatFresh ? 2 : left.metadata.state === "active" ? 1 : 0;
		const rightPriority = right.metadata.state === "active" && right.heartbeatFresh ? 2 : right.metadata.state === "active" ? 1 : 0;
		if (leftPriority !== rightPriority) {
			return rightPriority - leftPriority;
		}
		return left.metadata.roomId.localeCompare(right.metadata.roomId);
	})[0] ?? null;
}

export function getRoomPath(runtimeRoot: string, roomId: string): string {
	return path.join(runtimeRoot, roomId);
}

export function getRoomMetadataPath(roomDir: string): string {
	return path.join(roomDir, "room.json");
}

export function getRoomHeartbeatPath(roomDir: string): string {
	return path.join(roomDir, "heartbeat.json");
}

export function getRoomLocksDir(roomDir: string): string {
	return path.join(roomDir, "locks");
}

export function getRoomMessagesDir(roomDir: string): string {
	return path.join(roomDir, "messages");
}

export function getRoomMembersDir(roomDir: string): string {
	return path.join(roomDir, "members");
}

export function getRoomJobsDir(roomDir: string): string {
	return path.join(roomDir, "jobs");
}

export function getRoomRequestReplaysDir(roomDir: string): string {
	return path.join(roomDir, "request-replays");
}

export function getRoomControlReplaysDir(roomDir: string): string {
	return path.join(getRoomRequestReplaysDir(roomDir), "control");
}

export function getRoomHeartbeatsDir(roomDir: string): string {
	return path.join(roomDir, "heartbeats");
}

function encodeCrewAddRequestReplayKey(requestId: string): string {
	return createHash("sha256").update(requestId, "utf8").digest("hex");
}

function encodeCrewControlReplayKey(
	verb: CrewControlVerb,
	spawnTaskId: string,
	commandId: string,
): string {
	return createHash("sha256")
		.update(`${verb}\0${spawnTaskId}\0${commandId}`, "utf8")
		.digest("hex");
}

export function getCrewAddRequestReplayPath(roomDir: string, requestId: string): string {
	return path.join(getRoomRequestReplaysDir(roomDir), `${encodeCrewAddRequestReplayKey(requestId)}.json`);
}

export function getCrewControlReplayPath(
	roomDir: string,
	options: {
		verb: CrewControlVerb;
		spawnTaskId: string;
		commandId: string;
	},
): string {
	return path.join(
		getRoomControlReplaysDir(roomDir),
		`${encodeCrewControlReplayKey(options.verb, options.spawnTaskId, options.commandId)}.json`,
	);
}

export function getMemberHeartbeatPath(roomDir: string, memberName: string): string {
	assertValidRoomMemberName(memberName);
	return path.join(getRoomHeartbeatsDir(roomDir), `${memberName}.json`);
}

export function getRoomMutationLockPath(roomDir: string): string {
	return path.join(getRoomLocksDir(roomDir), "mutation.lock");
}

export function getRoomCleanupLockPath(roomDir: string): string {
	return path.join(getRoomLocksDir(roomDir), "cleanup.lock");
}

export function getRoomMemberStatePath(roomDir: string, memberName: string): string {
	assertValidRoomMemberName(memberName);
	return path.join(getRoomMembersDir(roomDir), `${memberName}.json`);
}

export function getRoomSpawnJobPath(roomDir: string, taskId: string): string {
	return path.join(getRoomJobsDir(roomDir), `spawn-${taskId}.json`);
}

function getRoomMessageFileName(seq: number, id: string): string {
	return `${String(seq).padStart(SEQ_PADDING, "0")}-${id}.json`;
}

export function getRoomMessagePath(roomDir: string, seq: number, id: string): string {
	return path.join(getRoomMessagesDir(roomDir), getRoomMessageFileName(seq, id));
}

async function getPersistedNextSeq(roomDir: string): Promise<number> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(getRoomMessagesDir(roomDir));
	} catch {
		return 1;
	}

	const lastMessageEntry = entries
		.filter((entry) => entry.endsWith(".json"))
		.sort((left, right) => left.localeCompare(right))
		.at(-1);
	if (!lastMessageEntry) return 1;

	const match = lastMessageEntry.match(/^(\d+)-/);
	if (!match) return 1;

	const persistedSeq = Number(match[1]);
	return Number.isFinite(persistedSeq) && persistedSeq >= 0 ? persistedSeq + 1 : 1;
}

export async function ensureRoomLayout(roomDir: string): Promise<void> {
	await fs.mkdir(getRoomLocksDir(roomDir), { recursive: true });
	await fs.mkdir(getRoomMessagesDir(roomDir), { recursive: true });
	await fs.mkdir(getRoomMembersDir(roomDir), { recursive: true });
	await fs.mkdir(getRoomJobsDir(roomDir), { recursive: true });
	await fs.mkdir(getRoomRequestReplaysDir(roomDir), { recursive: true });
	await fs.mkdir(getRoomControlReplaysDir(roomDir), { recursive: true });
	await fs.mkdir(getRoomHeartbeatsDir(roomDir), { recursive: true });
}

export async function writeMemberHeartbeat(
	roomDir: string,
	memberName: string,
): Promise<void> {
	await fs.mkdir(getRoomHeartbeatsDir(roomDir), { recursive: true });
	const heartbeatPath = getMemberHeartbeatPath(roomDir, memberName);
	const heartbeat = {
		memberName,
		updatedAt: new Date().toISOString(),
		pid: process.pid,
	};
	const tempPath = `${heartbeatPath}.${randomUUID()}.tmp`;
	await fs.writeFile(tempPath, JSON.stringify(heartbeat), "utf8");
	await fs.rename(tempPath, heartbeatPath);
}

export async function readMemberHeartbeat(
	roomDir: string,
	memberName: string,
): Promise<{ memberName: string; updatedAt: string; pid: number } | null> {
	try {
		return JSON.parse(
			await fs.readFile(getMemberHeartbeatPath(roomDir, memberName), "utf8"),
		);
	} catch {
		return null;
	}
}

export async function deleteMemberHeartbeat(
	roomDir: string,
	memberName: string,
): Promise<void> {
	await fs.rm(getMemberHeartbeatPath(roomDir, memberName), { force: true });
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${randomUUID()}.tmp`;
	await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
	await fs.rename(tempPath, filePath);
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
	return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

export async function initializeRoomRuntime(
	runtimeRoot: string,
	metadata: RoomMetadata,
	...members: RoomMemberState[]
): Promise<string> {
	const roomDir = getRoomPath(runtimeRoot, metadata.roomId);
	await ensureRoomLayout(roomDir);
	await writeRoomMetadata(roomDir, metadata);
	await writeJsonAtomic(getRoomHeartbeatPath(roomDir), {
		roomId: metadata.roomId,
		ownerSessionId: metadata.ownerSessionId,
		ownerPid: metadata.ownerPid,
		updatedAt: new Date().toISOString(),
	});
	for (const member of members) {
		await writeRoomMemberState(roomDir, member);
	}
	return roomDir;
}

export async function writeRoomMetadata(roomDir: string, metadata: RoomMetadata): Promise<void> {
	await writeJsonAtomic(getRoomMetadataPath(roomDir), metadata);
}

export async function loadRoomMetadata(roomDir: string): Promise<RoomMetadata> {
	return await readJsonFile<RoomMetadata>(getRoomMetadataPath(roomDir));
}

function normalizeCrewAddReplaySeed(seed: CrewAddReplaySeed & {
	requestId?: string;
	requestedName?: string;
	holdTimeoutMs?: number | null;
}): CrewAddReplaySeed {
	const requestedName = seed.requested_name ?? seed.requestedName;
	return {
		request_id: seed.request_id ?? seed.requestId ?? "",
		requested_name: normalizeMemberDisplayName(requestedName ?? ""),
		type: seed.type.trim(),
		model: seed.model?.trim() || null,
		task: seed.task?.trim() || null,
		transient: seed.transient === true,
		metadata: seed.metadata ?? null,
		activation: seed.activation === "manual" ? "manual" : "immediate",
		hold_timeout_ms: seed.hold_timeout_ms ?? seed.holdTimeoutMs ?? null,
	};
}

function normalizeReplayDeliveryGate(
	delivery: CrewAddReplayLifecycleSnapshot["delivery"],
	fallback: {
		activation: CrewAddActivation | null;
		delivery_state: CrewReplayDeliveryState | null;
		event: CrewReplayLifecycleEventName | null;
		hold_expires_at: string | null;
		updated_at: string;
	},
): CrewAddReplayDeliveryGate | null {
	const activation = delivery?.activation ?? fallback.activation;
	if (!activation) {
		return null;
	}
	const state = delivery?.state ?? fallback.delivery_state;
	if (!state) {
		return null;
	}
	const normalized: CrewAddReplayDeliveryGate = {
		activation,
		state,
		hold_expires_at:
			delivery?.hold_expires_at
			?? fallback.hold_expires_at
			?? null,
		opened_at: delivery?.opened_at ?? null,
		released_at: delivery?.released_at ?? null,
		aborted_at: delivery?.aborted_at ?? null,
		ended_at: delivery?.ended_at ?? null,
	};
	if (normalized.state === "enabled" && !normalized.opened_at) {
		normalized.opened_at = fallback.updated_at;
		if (normalized.activation === "manual") {
			normalized.released_at = normalized.released_at ?? fallback.updated_at;
		}
	}
	if (normalized.state === "ended" && !normalized.ended_at) {
		normalized.ended_at = fallback.updated_at;
	}
	if (fallback.event === "aborted" && !normalized.aborted_at) {
		normalized.aborted_at = fallback.updated_at;
	}
	if (normalized.state !== "held") {
		normalized.hold_expires_at = null;
	}
	return normalized;
}

function transitionReplayDeliveryGate(options: {
	previous?: CrewAddReplayDeliveryGate | null;
	activation: CrewAddActivation | null;
	state: CrewReplayDeliveryState | null;
	event?: CrewReplayLifecycleEventName | null;
	hold_expires_at?: string | null;
	updated_at: string;
}): CrewAddReplayDeliveryGate | null {
	const activation = options.activation ?? options.previous?.activation ?? null;
	const state = options.state ?? options.previous?.state ?? null;
	if (!activation || !state) {
		return null;
	}
	const next: CrewAddReplayDeliveryGate = {
		activation,
		state,
		hold_expires_at:
			state === "held"
				? options.hold_expires_at
					?? options.previous?.hold_expires_at
					?? null
				: null,
		opened_at: options.previous?.opened_at ?? null,
		released_at: options.previous?.released_at ?? null,
		aborted_at: options.previous?.aborted_at ?? null,
		ended_at: options.previous?.ended_at ?? null,
	};
	if (state === "enabled" && !next.opened_at) {
		next.opened_at = options.updated_at;
	}
	if (
		state === "enabled" &&
		activation === "manual" &&
		options.previous?.state !== "enabled" &&
		!next.released_at
	) {
		next.released_at = options.updated_at;
	}
	if (state === "ended" && !next.ended_at) {
		next.ended_at = options.updated_at;
	}
	if (options.event === "aborted" && !next.aborted_at) {
		next.aborted_at = options.updated_at;
	}
	return next;
}

function normalizeCrewAddReplaySnapshot(
	replay: CrewAddReplayLifecycleSnapshot,
): CrewAddReplayLifecycleSnapshot {
	const normalizedDelivery = normalizeReplayDeliveryGate(replay.delivery, {
		activation: replay.activation,
		delivery_state: replay.delivery_state,
		event: replay.event,
		hold_expires_at: replay.hold_expires_at,
		updated_at: replay.updated_at,
	});
	return {
		...replay,
		activation: replay.activation === "manual" ? "manual" : "immediate",
		delivery_state: normalizedDelivery?.state ?? replay.delivery_state,
		hold_expires_at: normalizedDelivery?.hold_expires_at ?? replay.hold_expires_at,
		delivery: normalizedDelivery,
	};
}

function normalizeCrewAddReplayRecord(record: CrewAddReplayRecord): CrewAddReplayRecord {
	return {
		...record,
		activation: record.activation === "manual" ? "manual" : "immediate",
		replay: record.replay ? normalizeCrewAddReplaySnapshot(record.replay) : null,
	};
}

function crewAddReplayMatches(record: CrewAddReplayRecord, seed: CrewAddReplaySeed): boolean {
	const normalized = normalizeCrewAddReplaySeed(seed);
	const normalizedRecord = normalizeCrewAddReplayRecord(record);
	return normalizedRecord.material.requested_name === normalized.requested_name
		&& normalizedRecord.material.type === normalized.type
		&& normalizedRecord.material.model === normalized.model
		&& normalizedRecord.material.task === normalized.task
		&& normalizedRecord.material.transient === normalized.transient
		&& normalizedRecord.activation === normalized.activation
		&& normalizedRecord.hold_timeout_ms === normalized.hold_timeout_ms;
}

function deriveCrewAddReplayReason(member: RoomMemberState | null, job: RoomSpawnJob | null): string | null {
	switch (job?.state) {
		case "failed":
			return "spawn-failed";
		case "cancelled":
			return "spawn-cancelled";
		case "timed_out_pending_external_resolution":
			return "spawn-timeout-external";
		case "timed_out_pending_member_claim":
			return "spawn-timeout-claim";
		default:
			break;
	}
	if (member?.state === "removed") {
		return "member-removed";
	}
	if (member?.state === "stopping") {
		return "member-stopping";
	}
	if (member?.state === "error") {
		return "member-error";
	}
	return null;
}

function deriveCrewAddReplayEvent(record: CrewAddReplayRecord, member: RoomMemberState | null, job: RoomSpawnJob | null) {
	const eventSeed = {
		request_id: record.request_id,
		command_id: null,
		requested_name: record.material.requested_name,
		member_target: member?.name ?? record.member_name,
		member_type: record.material.type,
		room_id: record.replay?.room_id ?? null,
		spawn_task_id: record.spawn_task_id,
		runtime_id: member?.runtimeId ?? job?.runtimeId ?? record.replay?.runtime_id ?? null,
		activation: record.activation,
		metadata: record.metadata ?? null,
	};
	const error = job?.error ?? member?.lastError ?? null;
	const terminalReason = deriveCrewAddReplayReason(member, job);
	if (terminalReason) {
		return buildCrewLifecycleEvent({
			...eventSeed,
			event: "ended",
			phase: "delivery",
			delivery_state: "ended",
			hold_expires_at: null,
			error,
			reason: terminalReason,
		});
	}
	if (record.activation === "manual" && (job?.state === "completed" || member?.state === "idle" || member?.state === "running")) {
		if (record.replay?.event === "enabled") {
			return buildCrewLifecycleEvent({
				...eventSeed,
				event: "enabled",
				phase: "delivery",
				delivery_state: "enabled",
				hold_expires_at: null,
				error: null,
				reason: null,
			});
		}
		return buildCrewLifecycleEvent({
			...eventSeed,
			event: "held",
			phase: "delivery",
			delivery_state: "held",
			hold_expires_at: null,
			error: null,
			reason: "manual-activation",
		});
	}
	if (job?.state === "completed" || member?.state === "idle" || member?.state === "running") {
		return buildCrewLifecycleEvent({
			...eventSeed,
			event: "enabled",
			phase: "delivery",
			delivery_state: "enabled",
			hold_expires_at: null,
			error: null,
			reason: null,
		});
	}
	if (
		member?.state === "spawning"
		|| job?.state === "starting"
		|| job?.state === "external_created"
		|| job?.state === "claimed"
	) {
		return buildCrewLifecycleEvent({
			...eventSeed,
			event: "pending",
			phase: "delivery",
			delivery_state: "pending",
			hold_expires_at: null,
			error: null,
			reason: null,
		});
	}
	return null;
}

function buildCrewAddReplayLifecycleSnapshot(options: {
	record: CrewAddReplayRecord;
	member?: RoomMemberState | null;
	job?: RoomSpawnJob | null;
	updatedAt?: string;
}): CrewAddReplayLifecycleSnapshot {
	const previous = options.record.replay;
	const updatedAt = options.updatedAt ?? new Date().toISOString();
	const derivedEvent = deriveCrewAddReplayEvent(options.record, options.member ?? null, options.job ?? null);
	const preservedSpawnEvent =
		previous
		&& previous.phase === "spawn"
		&& (previous.event === "spawned" || previous.event === "failed")
			? previous
			: null;
	const preservedClaimEvent =
		previous
		&& previous.phase === "delivery"
		&& previous.event === "claimed"
		&& (
			!derivedEvent
			|| derivedEvent.phase !== "delivery"
			|| derivedEvent.event !== "ended"
		)
			? previous
			: null;
	const preservedActivationEvent =
		previous
		&& previous.phase === "activation"
		&& (previous.event === "activated" || previous.event === "aborted")
			? previous
			: null;
	const previousDelivery = normalizeReplayDeliveryGate(previous?.delivery, {
		activation: previous?.activation ?? options.record.activation,
		delivery_state: previous?.delivery_state ?? null,
		event: previous?.event ?? null,
		hold_expires_at: previous?.hold_expires_at ?? null,
		updated_at: previous?.updated_at ?? updatedAt,
	});
	const effectiveEvent =
		preservedSpawnEvent
		?? preservedClaimEvent
		?? preservedActivationEvent
		?? derivedEvent
		?? previous
		?? null;
	const delivery = transitionReplayDeliveryGate({
		previous: previousDelivery,
		activation: effectiveEvent?.activation ?? options.record.activation,
		state: effectiveEvent?.delivery_state ?? null,
		event: effectiveEvent?.event ?? null,
		hold_expires_at: effectiveEvent?.hold_expires_at ?? null,
		updated_at: updatedAt,
	});
	return {
		event_id:
			preservedSpawnEvent?.event_id
			?? preservedClaimEvent?.event_id
			?? preservedActivationEvent?.event_id
			?? derivedEvent?.event_id
			?? previous?.event_id
			?? null,
		event:
			preservedSpawnEvent?.event
			?? preservedClaimEvent?.event
			?? preservedActivationEvent?.event
			?? derivedEvent?.event
			?? previous?.event
			?? null,
		phase:
			preservedSpawnEvent?.phase
			?? preservedClaimEvent?.phase
			?? preservedActivationEvent?.phase
			?? derivedEvent?.phase
			?? previous?.phase
			?? null,
		request_id: options.record.request_id,
		command_id:
			preservedSpawnEvent?.command_id
			?? preservedClaimEvent?.command_id
			?? preservedActivationEvent?.command_id
			?? derivedEvent?.command_id
			?? previous?.command_id
			?? null,
		requested_name: options.record.material.requested_name,
		member_target:
			preservedSpawnEvent?.member_target
			?? preservedClaimEvent?.member_target
			?? preservedActivationEvent?.member_target
			?? derivedEvent?.member_target
			?? options.member?.name
			?? options.record.member_name,
		member_type:
			preservedSpawnEvent?.member_type
			?? preservedClaimEvent?.member_type
			?? preservedActivationEvent?.member_type
			?? derivedEvent?.member_type
			?? options.record.material.type,
		room_id:
			preservedSpawnEvent?.room_id
			?? preservedClaimEvent?.room_id
			?? preservedActivationEvent?.room_id
			?? derivedEvent?.room_id
			?? previous?.room_id
			?? null,
		spawn_task_id: options.record.spawn_task_id,
		runtime_id:
			preservedSpawnEvent?.runtime_id
			?? preservedClaimEvent?.runtime_id
			?? preservedActivationEvent?.runtime_id
			?? derivedEvent?.runtime_id
			?? options.member?.runtimeId
			?? options.job?.runtimeId
			?? previous?.runtime_id
			?? null,
		activation: options.record.activation,
		metadata:
			preservedSpawnEvent?.metadata
			?? preservedClaimEvent?.metadata
			?? preservedActivationEvent?.metadata
			?? derivedEvent?.metadata
			?? options.record.metadata
			?? previous?.metadata
			?? null,
		delivery_state: delivery?.state ?? null,
		hold_expires_at: delivery?.hold_expires_at ?? null,
		delivery,
		error:
			preservedSpawnEvent?.error
			?? preservedClaimEvent?.error
			?? preservedActivationEvent?.error
			?? derivedEvent?.error
			?? options.job?.error
			?? options.member?.lastError
			?? null,
		reason:
			preservedSpawnEvent?.reason
			?? preservedClaimEvent?.reason
			?? preservedActivationEvent?.reason
			?? derivedEvent?.reason
			?? previous?.reason
			?? null,
		member_state: options.member?.state ?? previous?.member_state ?? null,
		job_state: options.job?.state ?? previous?.job_state ?? null,
		updated_at: updatedAt,
	};
}

function buildReplaySnapshotFromEvent(options: {
	record: CrewAddReplayRecord;
	event: CrewAddReplayableEvent;
	member: RoomMemberState | null;
	job: RoomSpawnJob | null;
	updatedAt: string;
}): CrewAddReplayLifecycleSnapshot {
	const previousDelivery = normalizeReplayDeliveryGate(options.record.replay?.delivery, {
		activation: options.record.replay?.activation ?? options.record.activation,
		delivery_state: options.record.replay?.delivery_state ?? null,
		event: options.record.replay?.event ?? null,
		hold_expires_at: options.record.replay?.hold_expires_at ?? null,
		updated_at: options.record.replay?.updated_at ?? options.updatedAt,
	});
	const delivery = transitionReplayDeliveryGate({
		previous: previousDelivery,
		activation: options.event.activation ?? options.record.activation,
		state: options.event.delivery_state ?? null,
		event: options.event.event,
		hold_expires_at: options.event.hold_expires_at ?? null,
		updated_at: options.updatedAt,
	});
	return {
		event_id: options.event.event_id,
		event: options.event.event,
		phase: options.event.phase,
		request_id: options.event.request_id ?? options.record.request_id,
		command_id: options.event.command_id,
		requested_name: options.event.requested_name ?? options.record.material.requested_name,
		member_target: options.event.member_target ?? options.member?.name ?? options.record.member_name,
		member_type: options.event.member_type ?? options.record.material.type,
		room_id: options.event.room_id ?? options.record.replay?.room_id ?? null,
		spawn_task_id: options.event.spawn_task_id ?? options.record.spawn_task_id,
		runtime_id:
			options.event.runtime_id
			?? options.member?.runtimeId
			?? options.job?.runtimeId
			?? options.record.replay?.runtime_id
			?? null,
		activation: options.event.activation ?? options.record.activation,
		metadata: options.event.metadata ?? options.record.metadata ?? null,
		delivery_state: delivery?.state ?? options.event.delivery_state ?? null,
		hold_expires_at: delivery?.hold_expires_at ?? options.event.hold_expires_at ?? null,
		delivery,
		error: options.event.error ?? null,
		reason: options.event.reason ?? null,
		member_state: options.member?.state ?? options.record.replay?.member_state ?? null,
		job_state: options.job?.state ?? options.record.replay?.job_state ?? null,
		updated_at: options.updatedAt,
	};
}

function buildCrewAddReplayRecord(options: {
	seed: CrewAddReplaySeed;
	member: RoomMemberState;
	job: RoomSpawnJob;
	backend: RoomBackend;
	updatedAt?: string;
}): CrewAddReplayRecord {
	const normalized = normalizeCrewAddReplaySeed(options.seed);
	const updatedAt = options.updatedAt ?? new Date().toISOString();
	const baseRecord: CrewAddReplayRecord = {
		request_id: normalized.request_id,
		material: {
			requested_name: normalized.requested_name,
			type: normalized.type,
			model: normalized.model,
			task: normalized.task,
			transient: normalized.transient,
		},
		metadata: normalized.metadata ?? null,
		activation: normalized.activation,
		hold_timeout_ms: normalized.hold_timeout_ms,
		member_name: options.member.name,
		member_label: formatMemberLabel(options.member),
		backend: options.backend,
		spawn_task_id: options.job.taskId,
		bootstrap_token: options.member.bootstrapToken ?? options.job.bootstrapToken ?? null,
		replay: null,
		created_at: updatedAt,
		updated_at: updatedAt,
	};
	return {
		...baseRecord,
		replay: buildCrewAddReplayLifecycleSnapshot({
			record: baseRecord,
			member: options.member,
			job: options.job,
			updatedAt,
		}),
	};
}

function isCrewAddReplayClearlyTerminal(record: CrewAddReplayRecord): boolean {
	const replay = record.replay;
	if (!replay || (replay.event !== "ended" && replay.event !== "aborted")) {
		return false;
	}
	if (
		replay.reason === "spawn-timeout-claim"
		|| replay.reason === "spawn-timeout-external"
	) {
		return false;
	}
	return replay.job_state === "failed"
		|| replay.job_state === "cancelled"
		|| replay.member_state === "removed"
		|| replay.member_state === "stopping"
		|| replay.member_state === "error";
}

function materializeReplayMember(record: CrewAddReplayRecord, member: RoomMemberState | null): RoomMemberState {
	if (member) {
		return member;
	}
	return {
		name: record.member_name,
		displayName: record.material.requested_name,
		requestId: record.request_id,
		type: record.material.type,
		backend: record.backend,
		runtimeId: record.replay?.runtime_id ?? null,
		runtimeIdentitySource: "none",
		state: record.replay?.member_state ?? "spawning",
		spawnTaskId: record.replay?.member_state === "spawning" ? record.spawn_task_id : null,
		spawnBatchId: null,
		transient: record.material.transient,
		currentTask: null,
		currentTaskMessageId: null,
		chatBusy: false,
		lastCompletedTask: null,
		lastError: record.replay?.error ?? null,
		lastSeenSeq: 0,
		joinedAt: record.created_at,
		updatedAt: record.updated_at,
		heartbeatAt: null,
		lastActiveAt: record.updated_at,
		sessionId: null,
		bootstrapToken: record.bootstrap_token ?? null,
		bootstrapClaimedAt: null,
		pendingSelfAckMessageId: null,
	};
}

function materializeReplayJob(record: CrewAddReplayRecord, job: RoomSpawnJob | null): RoomSpawnJob {
	if (job) {
		return job;
	}
	return {
		taskId: record.spawn_task_id,
		memberName: record.member_name,
		requestId: record.request_id,
		backend: record.backend,
		runtimeId: record.replay?.runtime_id ?? null,
		bootstrapToken: record.bootstrap_token ?? null,
		state: record.replay?.job_state ?? "starting",
		createdAt: record.created_at,
		updatedAt: record.updated_at,
		error: record.replay?.error ?? null,
	};
}

async function resolveCrewAddReplayAnchors(record: CrewAddReplayRecord, roomDir: string): Promise<{ member: RoomMemberState; job: RoomSpawnJob }> {
	const existingMember = await loadRoomMemberState(roomDir, record.member_name).catch(() => null);
	const existingJob = await readSpawnJob(roomDir, record.spawn_task_id).catch(() => null);
	if (isCrewAddReplayClearlyTerminal(record)) {
		return {
			member: materializeReplayMember(record, existingMember),
			job: materializeReplayJob(record, existingJob),
		};
	}
	const member = materializeReplayMember(record, existingMember);
	const job = materializeReplayJob(record, existingJob);
	if (!existingMember) {
		await writeRoomMemberState(roomDir, member);
	}
	if (!existingJob) {
		await writeSpawnJobFile(roomDir, job);
	}
	return { member, job };
}

async function writeCrewAddRequestReplayFile(roomDir: string, record: CrewAddReplayRecord): Promise<void> {
	await writeJsonAtomic(getCrewAddRequestReplayPath(roomDir, record.request_id), record);
}

export async function readCrewAddRequestReplay(roomDir: string, requestId: string): Promise<CrewAddReplayRecord | null> {
	try {
		return normalizeCrewAddReplayRecord(
			await readJsonFile<CrewAddReplayRecord>(getCrewAddRequestReplayPath(roomDir, requestId)),
		);
	} catch {
		return null;
	}
}

async function listCrewAddRequestReplays(roomDir: string): Promise<CrewAddReplayRecord[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(getRoomRequestReplaysDir(roomDir));
	} catch {
		return [];
	}
	const records = await Promise.all(
		entries
			.filter((entry) => entry.endsWith(".json"))
			.sort((left, right) => left.localeCompare(right))
			.map(async (entry) => {
				try {
					return normalizeCrewAddReplayRecord(
						await readJsonFile<CrewAddReplayRecord>(
							path.join(getRoomRequestReplaysDir(roomDir), entry),
						),
					);
				} catch {
					return null;
				}
			}),
	);
	return records.filter((record): record is CrewAddReplayRecord => record !== null);
}

async function writeCrewControlReplayFile(
	roomDir: string,
	record: CrewControlReplayRecord,
): Promise<void> {
	await fs.mkdir(getRoomControlReplaysDir(roomDir), { recursive: true });
	await writeJsonAtomic(
		getCrewControlReplayPath(roomDir, {
			verb: record.verb,
			spawnTaskId: record.spawn_task_id,
			commandId: record.command_id,
		}),
		record,
	);
}

export async function readCrewControlReplay(
	roomDir: string,
	options: {
		verb: CrewControlVerb;
		spawnTaskId: string;
		commandId: string;
	},
): Promise<CrewControlReplayRecord | null> {
	try {
		return await readJsonFile<CrewControlReplayRecord>(
			getCrewControlReplayPath(roomDir, options),
		);
	} catch {
		return null;
	}
}

async function listCrewControlReplays(roomDir: string): Promise<CrewControlReplayRecord[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(getRoomControlReplaysDir(roomDir));
	} catch {
		return [];
	}
	const records = await Promise.all(
		entries
			.filter((entry) => entry.endsWith(".json"))
			.sort((left, right) => left.localeCompare(right))
			.map(async (entry) => {
				try {
					return await readJsonFile<CrewControlReplayRecord>(
						path.join(getRoomControlReplaysDir(roomDir), entry),
					);
				} catch {
					return null;
				}
			}),
	);
	return records.filter((record): record is CrewControlReplayRecord => record !== null);
}

async function findCrewAddReplayForControl(options: {
	roomDir: string;
	spawnTaskId: string;
	requestId?: string;
}): Promise<CrewAddReplayRecord | null> {
	if (options.requestId) {
		const direct = await readCrewAddRequestReplay(options.roomDir, options.requestId);
		if (!direct) {
			return null;
		}
		return direct.spawn_task_id === options.spawnTaskId ? direct : null;
	}
	const records = await listCrewAddRequestReplays(options.roomDir);
	return records.find((record) => record.spawn_task_id === options.spawnTaskId) ?? null;
}

function buildCrewControlFailedEvent(options: {
	record: CrewAddReplayRecord | null;
	verb: CrewControlVerb;
	spawnTaskId: string;
	commandId?: string;
	requestId?: string;
	error: string;
	reason: string;
}): CrewAddReplayableEvent {
	const record = options.record;
	return buildCrewLifecycleEvent({
		event: "failed",
		phase: "activation",
		request_id: record?.request_id ?? options.requestId ?? null,
		command_id: options.commandId ?? null,
		requested_name: record?.material.requested_name ?? null,
		member_target: record?.replay?.member_target ?? record?.member_name ?? null,
		member_type: record?.material.type ?? null,
		room_id: record?.replay?.room_id ?? null,
		spawn_task_id: options.spawnTaskId,
		runtime_id: record?.replay?.runtime_id ?? null,
		activation: record?.activation ?? null,
		metadata: record?.metadata ?? null,
		delivery_state: record?.replay?.delivery_state ?? null,
		hold_expires_at: record?.replay?.hold_expires_at ?? null,
		error: options.error,
		reason: options.reason,
	});
}

function buildCrewControlLifecycleEvent(options: {
	record: CrewAddReplayRecord;
	event: "activated" | "aborted";
	commandId?: string;
	reason?: string | null;
	runtimeId?: string | null;
	roomId?: string | null;
}): CrewAddReplayableEvent {
	return buildCrewLifecycleEvent({
		event: options.event,
		phase: "activation",
		request_id: options.record.request_id,
		command_id: options.commandId ?? null,
		requested_name: options.record.material.requested_name,
		member_target: options.record.replay?.member_target ?? options.record.member_name,
		member_type: options.record.material.type,
		room_id: options.roomId ?? options.record.replay?.room_id ?? null,
		spawn_task_id: options.record.spawn_task_id,
		runtime_id: options.runtimeId ?? options.record.replay?.runtime_id ?? null,
		activation: options.record.activation,
		metadata: options.record.metadata ?? null,
		delivery_state: options.event === "activated" ? "enabled" : "ended",
		hold_expires_at: null,
		error: null,
		reason: options.reason ?? null,
	});
}

async function persistCrewControlReplayRecord(options: {
	roomDir: string;
	verb: CrewControlVerb;
	spawnTaskId: string;
	commandId?: string;
	requestId?: string | null;
	outcome: CrewAddReplayableEvent;
	updatedAt: string;
}): Promise<void> {
	if (!options.commandId) {
		return;
	}
	const existing = await readCrewControlReplay(options.roomDir, {
		verb: options.verb,
		spawnTaskId: options.spawnTaskId,
		commandId: options.commandId,
	});
	await writeCrewControlReplayFile(options.roomDir, {
		verb: options.verb,
		spawn_task_id: options.spawnTaskId,
		command_id: options.commandId,
		request_id: options.requestId ?? null,
		outcome: options.outcome,
		created_at: existing?.created_at ?? options.updatedAt,
		updated_at: options.updatedAt,
	});
}

export async function applyCrewControlCommand(options: {
	roomDir: string;
	verb: CrewControlVerb;
	spawnTaskId: string;
	commandId?: string;
	requestId?: string;
	reason?: string;
}): Promise<CrewAddReplayableEvent> {
	return await withRoomMutationLock(options.roomDir, async () => {
		const updatedAt = new Date().toISOString();
		const record = await findCrewAddReplayForControl({
			roomDir: options.roomDir,
			spawnTaskId: options.spawnTaskId,
			requestId: options.requestId,
		});
		if (!record) {
			const failed = buildCrewControlFailedEvent({
				record: null,
				verb: options.verb,
				spawnTaskId: options.spawnTaskId,
				commandId: options.commandId,
				requestId: options.requestId,
				error: `spawn_task_id ${options.spawnTaskId} does not reference a replayable held generation.`,
				reason: "unknown-generation",
			});
			await persistCrewControlReplayRecord({
				roomDir: options.roomDir,
				verb: options.verb,
				spawnTaskId: options.spawnTaskId,
				commandId: options.commandId,
				requestId: options.requestId ?? null,
				outcome: failed,
				updatedAt,
			});
			return failed;
		}
		if (options.commandId) {
			const replayed = await readCrewControlReplay(options.roomDir, {
				verb: options.verb,
				spawnTaskId: options.spawnTaskId,
				commandId: options.commandId,
			});
			if (replayed) {
				return replayed.outcome;
			}
			const conflict = (await listCrewControlReplays(options.roomDir)).find(
				(existing) =>
					existing.command_id === options.commandId
					&& (existing.verb !== options.verb || existing.spawn_task_id !== options.spawnTaskId),
			);
			if (conflict) {
				const failed = buildCrewControlFailedEvent({
					record,
					verb: options.verb,
					spawnTaskId: options.spawnTaskId,
					commandId: options.commandId,
					requestId: options.requestId ?? record.request_id,
					error: `command_id ${options.commandId} conflicts with ${conflict.verb} for spawn_task_id ${conflict.spawn_task_id}.`,
					reason: "command-id-conflict",
				});
				await persistCrewControlReplayRecord({
					roomDir: options.roomDir,
					verb: options.verb,
					spawnTaskId: options.spawnTaskId,
					commandId: options.commandId,
					requestId: record.request_id,
					outcome: failed,
					updatedAt,
				});
				return failed;
			}
		}
		let member = await loadRoomMemberState(options.roomDir, record.member_name).catch(() => null);
		let job = await readSpawnJob(options.roomDir, record.spawn_task_id).catch(() => null);
		if (!member || !job) {
			const repaired = await resolveCrewAddReplayAnchors(record, options.roomDir);
			member = member ?? repaired.member;
			job = job ?? repaired.job;
		}
		const deliveryGate = getCrewAddReplayDeliveryGate(record);
		if (deliveryGate?.state !== "held") {
			const failed = buildCrewControlFailedEvent({
				record,
				verb: options.verb,
				spawnTaskId: options.spawnTaskId,
				commandId: options.commandId,
				requestId: options.requestId ?? record.request_id,
				error: `crew:${options.verb} requires a held generation, found ${deliveryGate?.state ?? "none"}.`,
				reason: "invalid-activation-state",
			});
			await persistCrewControlReplayRecord({
				roomDir: options.roomDir,
				verb: options.verb,
				spawnTaskId: options.spawnTaskId,
				commandId: options.commandId,
				requestId: record.request_id,
				outcome: failed,
				updatedAt,
			});
			return failed;
		}
		if (options.verb === "release") {
			const activated = buildCrewControlLifecycleEvent({
				record,
				event: "activated",
				commandId: options.commandId,
				runtimeId: member?.runtimeId ?? job?.runtimeId ?? record.replay?.runtime_id ?? null,
				roomId: record.replay?.room_id ?? null,
			});
			await persistCrewAddReplayEventLocked({
				roomDir: options.roomDir,
				requestId: record.request_id,
				event: activated,
				member,
				job,
				updatedAt,
			});
			await persistCrewControlReplayRecord({
				roomDir: options.roomDir,
				verb: options.verb,
				spawnTaskId: options.spawnTaskId,
				commandId: options.commandId,
				requestId: record.request_id,
				outcome: activated,
				updatedAt,
			});
			return activated;
		}
		const abortReason = options.reason?.trim() || "caller_abort";
		const nextJob = job
			? transitionSpawnJobLocked(job, {
				state: "cancelled",
				updatedAt,
				error: abortReason,
			})
			: null;
		if (nextJob) {
			await writeSpawnJobFile(options.roomDir, nextJob);
		}
		const nextMember = member
			? {
				...member,
				state: "removed" as const,
				spawnTaskId: null,
				spawnBatchId: null,
				currentTask: null,
				currentTaskMessageId: null,
				sessionId: null,
				queuedDeliveryMessageIds: null,
				queuedTaskMessageIds: null,
				lastError: abortReason,
				updatedAt,
			}
			: null;
		if (nextMember) {
			await writeRoomMemberState(options.roomDir, nextMember);
		}
		const aborted = buildCrewControlLifecycleEvent({
			record,
			event: "aborted",
			commandId: options.commandId,
			reason: abortReason,
			runtimeId: nextMember?.runtimeId ?? nextJob?.runtimeId ?? record.replay?.runtime_id ?? null,
			roomId: record.replay?.room_id ?? null,
		});
		await persistCrewAddReplayEventLocked({
			roomDir: options.roomDir,
			requestId: record.request_id,
			event: aborted,
			member: nextMember,
			job: nextJob,
			updatedAt,
		});
		await persistCrewControlReplayRecord({
			roomDir: options.roomDir,
			verb: options.verb,
			spawnTaskId: options.spawnTaskId,
			commandId: options.commandId,
			requestId: record.request_id,
			outcome: aborted,
			updatedAt,
		});
		return aborted;
	});
}

export function getCrewAddReplayDeliveryGate(
	record: CrewAddReplayRecord | null | undefined,
): CrewAddReplayDeliveryGate | null {
	return record?.replay?.delivery ?? null;
}

export async function readMemberDeliveryGate(
	roomDir: string,
	member: RoomMemberState | string,
): Promise<CrewAddReplayDeliveryGate | null> {
	const loadedMember = typeof member === "string"
		? await loadRoomMemberState(roomDir, member).catch(() => null)
		: member;
	if (!loadedMember?.requestId) {
		return null;
	}
	const replay = await readCrewAddRequestReplay(roomDir, loadedMember.requestId);
	return getCrewAddReplayDeliveryGate(replay);
}

export async function prepareCrewAddReplay(roomDir: string, requestId: string): Promise<CrewAddReplayRecord | null> {
	return await withRoomMutationLock(roomDir, async () => {
		const record = await readCrewAddRequestReplay(roomDir, requestId);
		if (!record) {
			return null;
		}
		await resolveCrewAddReplayAnchors(record, roomDir);
		return record;
	});
}

async function listRoomSpawnJobs(roomDir: string): Promise<RoomSpawnJob[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(getRoomJobsDir(roomDir));
	} catch {
		return [];
	}
	return await Promise.all(
		entries
			.filter((entry) => entry.startsWith("spawn-") && entry.endsWith(".json"))
			.sort((left, right) => left.localeCompare(right))
			.map((entry) => readJsonFile<RoomSpawnJob>(path.join(getRoomJobsDir(roomDir), entry))),
	);
}

async function syncCrewAddReplayRecord(options: {
	roomDir: string;
	requestId: string;
	member?: RoomMemberState | null;
	job?: RoomSpawnJob | null;
	updatedAt?: string;
}): Promise<void> {
	const record = await readCrewAddRequestReplay(options.roomDir, options.requestId);
	if (!record) {
		return;
	}
	const member = options.member === undefined
		? await loadRoomMemberState(options.roomDir, record.member_name).catch(() => null)
		: options.member;
	const job = options.job === undefined
		? await readSpawnJob(options.roomDir, record.spawn_task_id).catch(() => null)
		: options.job;
	const updatedAt = options.updatedAt ?? new Date().toISOString();
	await writeCrewAddRequestReplayFile(options.roomDir, {
		...record,
		member_name: member?.name ?? record.member_name,
		member_label: member ? formatMemberLabel(member) : record.member_label,
		backend: job?.backend ?? member?.backend ?? record.backend,
		bootstrap_token:
			member?.bootstrapToken
			?? job?.bootstrapToken
			?? record.bootstrap_token
			?? null,
		replay: buildCrewAddReplayLifecycleSnapshot({
			record,
			member,
			job,
			updatedAt,
		}),
		updated_at: updatedAt,
	});
}

async function persistCrewAddReplayEventLocked(options: {
	roomDir: string;
	requestId: string;
	event: CrewAddReplayableEvent;
	member?: RoomMemberState | null;
	job?: RoomSpawnJob | null;
	updatedAt?: string;
}): Promise<void> {
	const record = await readCrewAddRequestReplay(options.roomDir, options.requestId);
	if (!record) {
		return;
	}
	const member = options.member === undefined
		? await loadRoomMemberState(options.roomDir, record.member_name).catch(() => null)
		: options.member;
	const job = options.job === undefined
		? await readSpawnJob(options.roomDir, record.spawn_task_id).catch(() => null)
		: options.job;
	const updatedAt = options.updatedAt ?? new Date().toISOString();
	await writeCrewAddRequestReplayFile(options.roomDir, {
		...record,
		member_name: member?.name ?? record.member_name,
		member_label: member ? formatMemberLabel(member) : record.member_label,
		backend: job?.backend ?? member?.backend ?? record.backend,
		bootstrap_token:
			member?.bootstrapToken
			?? job?.bootstrapToken
			?? record.bootstrap_token
			?? null,
		replay: buildReplaySnapshotFromEvent({
			record,
			event: options.event,
			member,
			job,
			updatedAt,
		}),
		updated_at: updatedAt,
	});
}

export async function persistCrewAddReplayEvent(options: {
	roomDir: string;
	requestId: string;
	event: CrewAddReplayableEvent;
	member?: RoomMemberState | null;
	job?: RoomSpawnJob | null;
	updatedAt?: string;
}): Promise<void> {
	await withRoomMutationLock(options.roomDir, async () => {
		await persistCrewAddReplayEventLocked(options);
	});
}

export async function writeRoomMemberState(roomDir: string, member: RoomMemberState): Promise<void> {
	await writeJsonAtomic(getRoomMemberStatePath(roomDir, member.name), member);
	if (member.requestId) {
		await syncCrewAddReplayRecord({
			roomDir,
			requestId: member.requestId,
			member,
			updatedAt: member.updatedAt,
		});
	}
	if (member.state === "removed") {
		await deleteMemberHeartbeat(roomDir, member.name).catch((err) => {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "ENOENT") {
				const log = createRoomLogger(roomDir, "storage");
				log.error("failed to delete heartbeat for removed member", {
					memberName: member.name,
					error: String(err),
				});
			}
		});
	}
}

async function writeSpawnJobFile(roomDir: string, job: RoomSpawnJob): Promise<void> {
	assertSpawnJobStateForBackend(job.backend, job.state);
	await writeJsonAtomic(getRoomSpawnJobPath(roomDir, job.taskId), job);
	if (job.requestId) {
		await syncCrewAddReplayRecord({
			roomDir,
			requestId: job.requestId,
			job,
			updatedAt: job.updatedAt,
		});
	}
}

export async function loadRoomMemberState(roomDir: string, memberName: string): Promise<RoomMemberState> {
	return await readJsonFile<RoomMemberState>(getRoomMemberStatePath(roomDir, memberName));
}

export async function updateRoomMemberState(
	roomDir: string,
	memberName: string,
	patch: Partial<RoomMemberState>,
): Promise<RoomMemberState> {
	// Try agent-side proxy first (eliminates file-lock contention)
	const viaClient = await tryViaMutationClient<RoomMemberState>(roomDir, {
		kind: "update_member",
		payload: { memberName, patch },
	});
	if (viaClient !== undefined) return viaClient;

	return await withRoomMutationLock(roomDir, async () => {
		const current = await loadRoomMemberState(roomDir, memberName);
		const next = {
			...current,
			...patch,
			updatedAt: patch.updatedAt ?? new Date().toISOString(),
		};
		await writeRoomMemberState(roomDir, next);
		return next;
	});
}

async function loadSpawnMutationContext(options: {
	bootstrap: RoomBootstrap;
	fallbackBackend?: RoomBackend;
}): Promise<{
	now: string;
	current: RoomMemberState | null;
	spawnJob: RoomSpawnJob | null;
	expectedBootstrapToken: string | null;
	recoveredBackend: RoomBackend;
	recoveredRuntimeId: string | null;
}> {
	const { bootstrap } = options;
	const metadata = await loadRoomMetadata(bootstrap.roomDir);
	if (metadata.state !== "active") {
		throw new RoomNotClaimableError(metadata.roomId, metadata.state);
	}
	if (bootstrap.ownerSessionId !== metadata.ownerSessionId) {
		throw new BootstrapTokenError(bootstrap.memberName);
	}
	if (bootstrap.ownerName !== metadata.ownerName) {
		throw new BootstrapTokenError(bootstrap.memberName);
	}

	const now = new Date().toISOString();
	let current: RoomMemberState | null = null;
	let spawnJob: RoomSpawnJob | null = null;
	let recoveredBackend = options.fallbackBackend ?? "pi";
	let recoveredRuntimeId: string | null = null;

	if (bootstrap.spawnTaskId) {
		try {
			spawnJob = await readJsonFile<RoomSpawnJob>(getRoomSpawnJobPath(bootstrap.roomDir, bootstrap.spawnTaskId));
			recoveredBackend = spawnJob.backend;
			recoveredRuntimeId = spawnJob.runtimeId ?? null;
		} catch {
			spawnJob = null;
		}
	}

	try {
		current = await loadRoomMemberState(bootstrap.roomDir, bootstrap.memberName);
	} catch {
		current = null;
	}

	if (!spawnJob && !current) {
		throw new MemberNotFoundError(bootstrap.memberName);
	}

	const expectedBootstrapToken = spawnJob?.bootstrapToken ?? current?.bootstrapToken ?? null;
	if (expectedBootstrapToken && bootstrap.token !== expectedBootstrapToken) {
		throw new BootstrapTokenError(bootstrap.memberName);
	}

	if (spawnJob) {
		if (spawnJob.memberName !== bootstrap.memberName) {
			throw new SpawnFailedError(bootstrap.memberName, `spawn job ${spawnJob.taskId} does not match`);
		}
		if (spawnJob.state === "cancelled" || spawnJob.state === "failed") {
			throw new SpawnFailedError(bootstrap.memberName, `spawn job ${spawnJob.taskId} is no longer claimable (${spawnJob.state})`);
		}
	}

	if (current?.state === "removed") {
		throw new MemberNotFoundError(bootstrap.memberName);
	}

	if (bootstrap.spawnTaskId && current?.spawnTaskId && current.spawnTaskId !== bootstrap.spawnTaskId) {
		throw new SpawnFailedError(bootstrap.memberName, "member belongs to a different spawn job");
	}

	return {
		now,
		current,
		spawnJob,
		expectedBootstrapToken,
		recoveredBackend,
		recoveredRuntimeId,
	};
}

function isDifferentMemberGeneration(options: {
	current: RoomMemberState | null;
	taskId: string | null;
	expectedBootstrapToken: string | null;
	recoveredRuntimeId?: string | null;
	recoveredBackend?: RoomBackend | null;
}): boolean {
	const { current, taskId, expectedBootstrapToken, recoveredRuntimeId, recoveredBackend } = options;
	if (!current) return false;
	if (taskId !== null && current.spawnTaskId === taskId) return false;
	if (expectedBootstrapToken !== null && (current.bootstrapToken ?? null) === expectedBootstrapToken) return false;
	if (expectedBootstrapToken === null && current.spawnTaskId === null) {
		if (current.runtimeId === null) return false;
		return current.runtimeId !== (recoveredRuntimeId ?? null) || (
			recoveredBackend !== undefined &&
			recoveredBackend !== null &&
			current.backend !== recoveredBackend
		);
	}
	if (taskId === null && expectedBootstrapToken === null) return false;
	return true;
}

function isSpawnJobTerminalState(state: RoomSpawnJobState): boolean {
	return state === "completed" || state === "cancelled" || state === "failed";
}

function isSpawnJobClaimTransitionState(state: RoomSpawnJobState): boolean {
	return !isSpawnJobTerminalState(state) && state !== "timed_out_pending_external_resolution";
}

function isSpawnJobDirectedDeliveryState(state: RoomSpawnJobState): boolean {
	return !isSpawnJobTerminalState(state)
		&& state !== "timed_out_pending_external_resolution"
		&& state !== "timed_out_pending_member_claim";
}

function assertSpawnJobStateForBackend(backend: RoomBackend, state: RoomSpawnJobState): void {
	if (backend !== "paseo" && PASEO_ONLY_SPAWN_STATES.has(state)) {
		throw new ValidationError(`Spawn job state ${state} is only valid for paseo backend`);
	}
}

function transitionSpawnJobLocked(
	job: RoomSpawnJob,
	patch: {
		state: RoomSpawnJobState;
		backend?: RoomBackend;
		runtimeId?: string | null;
		error?: string | null;
		updatedAt?: string;
	},
): RoomSpawnJob {
	const next: RoomSpawnJob = {
		...job,
		backend: patch.backend ?? job.backend,
		runtimeId: patch.runtimeId === undefined ? job.runtimeId : patch.runtimeId,
		state: patch.state,
		updatedAt: patch.updatedAt ?? new Date().toISOString(),
		error: patch.error ?? null,
	};
	assertSpawnJobStateForBackend(next.backend, next.state);
	return next;
}

export async function transitionSpawnJob(
	roomDir: string,
	taskId: string,
	patch: {
		state: RoomSpawnJobState;
		backend?: RoomBackend;
		runtimeId?: string | null;
		error?: string | null;
		updatedAt?: string;
	},
): Promise<RoomSpawnJob> {
	return await withRoomMutationLock(roomDir, async () => {
		const current = await readJsonFile<RoomSpawnJob>(getRoomSpawnJobPath(roomDir, taskId));
		const next = transitionSpawnJobLocked(current, patch);
		await writeSpawnJobFile(roomDir, next);
		return next;
	});
}

export async function transitionSpawnJobRecord(
	roomDir: string,
	job: RoomSpawnJob,
	patch: {
		state: RoomSpawnJobState;
		backend?: RoomBackend;
		runtimeId?: string | null;
		error?: string | null;
		updatedAt?: string;
	},
): Promise<RoomSpawnJob> {
	const next = transitionSpawnJobLocked(job, patch);
	await writeSpawnJobFile(roomDir, next);
	return next;
}

function resolveRuntimeIdentitySource(options: {
	current: RoomMemberState | null;
	backend: RoomBackend;
	runtimeId: string | null;
	memberPid?: number | null;
}): NonNullable<RoomMemberState["runtimeIdentitySource"]> {
	if (options.current?.runtimeIdentitySource === "owner") return "owner";
	if (options.runtimeId) return "owner";
	if (options.backend === "paseo" && options.memberPid !== null && options.memberPid !== undefined) {
		return "member-pid";
	}
	if (options.current?.runtimeIdentitySource) return options.current.runtimeIdentitySource;
	return "none";
}

function replayEventHasPersistedClaim(event: CrewAddReplayRecord["replay"]): boolean {
	if (!event) {
		return false;
	}
	const deliveryState = event.delivery?.state ?? event.delivery_state ?? null;
	return event.event === "claimed"
		|| event.event === "ended"
		|| deliveryState === "held"
		|| deliveryState === "enabled"
		|| deliveryState === "ended";
}

function buildCrewClaimedReplayEvent(options: {
	record: CrewAddReplayRecord;
	member: RoomMemberState;
	job: RoomSpawnJob | null;
	roomId: string;
}): CrewAddReplayableEvent {
	const previous = options.record.replay;
	const previousDeliveryState = previous?.delivery_state ?? null;
	const deliveryState =
		previousDeliveryState && previousDeliveryState !== "pending"
			? previousDeliveryState
			: (options.record.activation === "manual" ? "held" : "enabled");
	const holdExpiresAt = deliveryState === "held"
		? (previous?.hold_expires_at ?? null)
		: null;
	return buildCrewLifecycleEvent({
		event: "claimed",
		phase: "delivery",
		request_id: options.record.request_id,
		command_id: previous?.command_id ?? null,
		requested_name: options.record.material.requested_name,
		member_target: options.member.name,
		member_type: options.member.type,
		room_id: previous?.room_id ?? options.roomId,
		spawn_task_id: options.job?.taskId ?? options.record.spawn_task_id,
		runtime_id:
			options.member.runtimeId
			?? options.job?.runtimeId
			?? previous?.runtime_id
			?? null,
		activation: options.record.activation,
		metadata: previous?.metadata ?? options.record.metadata ?? null,
		delivery_state: deliveryState,
		hold_expires_at: holdExpiresAt,
		error: null,
		reason: null,
	});
}

async function maybePersistFirstClaimEventLocked(options: {
	roomDir: string;
	roomId: string;
	previousMember: RoomMemberState | null;
	nextMember: RoomMemberState;
	job: RoomSpawnJob | null;
}): Promise<{
	claimedEvent: CrewAddReplayableEvent | null;
	activatedEvent: CrewAddReplayableEvent | null;
}> {
	if (!options.nextMember.requestId || !options.nextMember.sessionId) {
		return { claimedEvent: null, activatedEvent: null };
	}
	const record = await readCrewAddRequestReplay(options.roomDir, options.nextMember.requestId);
	if (!record) {
		return { claimedEvent: null, activatedEvent: null };
	}
	const isInitialClaimFromSpawningMember =
		!options.previousMember?.sessionId && options.previousMember?.state === "spawning";
	if (
		options.previousMember?.sessionId
		|| (replayEventHasPersistedClaim(record.replay) && !isInitialClaimFromSpawningMember)
	) {
		return { claimedEvent: null, activatedEvent: null };
	}
	const previousDelivery = getCrewAddReplayDeliveryGate(record);
	const claimedEvent = buildCrewClaimedReplayEvent({
		record,
		member: options.nextMember,
		job: options.job,
		roomId: options.roomId,
	});
	const activatedEvent = record.activation === "immediate"
		? buildCrewLifecycleEvent({
			event: "enabled",
			phase: "delivery",
			request_id: claimedEvent.request_id,
			command_id: claimedEvent.command_id,
			requested_name: claimedEvent.requested_name,
			member_target: claimedEvent.member_target,
			member_type: claimedEvent.member_type,
			room_id: claimedEvent.room_id,
			spawn_task_id: claimedEvent.spawn_task_id,
			runtime_id: claimedEvent.runtime_id,
			activation: claimedEvent.activation,
			metadata: claimedEvent.metadata,
			delivery_state: "enabled",
			hold_expires_at: null,
			error: null,
			reason: null,
		})
		: null;
	const updatedAt = options.nextMember.updatedAt;
	await writeCrewAddRequestReplayFile(options.roomDir, {
		...record,
		member_name: options.nextMember.name,
		member_label: formatMemberLabel(options.nextMember),
		backend: options.job?.backend ?? options.nextMember.backend ?? record.backend,
		bootstrap_token:
			options.nextMember.bootstrapToken
			?? options.job?.bootstrapToken
			?? record.bootstrap_token
			?? null,
		replay: buildReplaySnapshotFromEvent({
			record,
			event: activatedEvent ?? claimedEvent,
			member: options.nextMember,
			job: options.job,
			updatedAt,
		}),
		updated_at: updatedAt,
	});
	return { claimedEvent, activatedEvent };
}

function hasBootstrapClaim(current: RoomMemberState, job: RoomSpawnJob): boolean {
	return Boolean(current.sessionId) || Boolean(current.bootstrapClaimedAt) || job.state === "claimed" || job.state === "completed";
}

export async function claimMemberSession(options: {
	bootstrap: RoomBootstrap;
	sessionId: string | null;
	memberPid?: number | null;
}): Promise<SessionClaimMutationResult> {
	const viaClient = await tryViaMutationClient<SessionClaimMutationResult>(options.bootstrap.roomDir, {
		kind: "claim_member_session",
		payload: options,
	});
	if (viaClient !== undefined) return viaClient;
	const log = createRoomLogger(options.bootstrap.roomDir, "storage");

	return await withRoomMutationLock(options.bootstrap.roomDir, async () => {
		const {
			now,
			current,
			spawnJob,
			expectedBootstrapToken,
			recoveredBackend,
			recoveredRuntimeId,
		} = await loadSpawnMutationContext({
			bootstrap: options.bootstrap,
			fallbackBackend: "pi",
		});

		if (spawnJob?.state === "completed" && !current) {
			throw new SpawnFailedError(options.bootstrap.memberName, `spawn job ${spawnJob.taskId} was already completed and member has been removed`);
		}

		if (isDifferentMemberGeneration({
			current,
			taskId: options.bootstrap.spawnTaskId ?? null,
			expectedBootstrapToken,
			recoveredRuntimeId,
			recoveredBackend,
		})) {
			throw new SpawnFailedError(options.bootstrap.memberName, `spawn job ${spawnJob?.taskId ?? options.bootstrap.spawnTaskId ?? "unknown"} belongs to a different member generation`);
		}

		const previousMember = current;
		const baseline: RoomMemberState = current ?? {
			name: options.bootstrap.memberName,
			type: options.bootstrap.memberType,
			requestId: spawnJob?.requestId ?? null,
			backend: recoveredBackend,
			runtimeId: recoveredRuntimeId,
			state: "spawning",
			spawnTaskId: options.bootstrap.spawnTaskId ?? null,
			spawnBatchId: null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			lastSeenSeq: 0,
			joinedAt: now,
			updatedAt: now,
			heartbeatAt: now,
			lastActiveAt: now,
			sessionId: null,
			chatBusy: false,
			bootstrapToken: expectedBootstrapToken ?? options.bootstrap.token,
			runtimeIdentitySource: "none",
			bootstrapClaimedAt: null,
		};

		const effectiveRuntimeId = baseline.runtimeId ?? recoveredRuntimeId;
		const effectiveBackend = baseline.backend ?? recoveredBackend;
		const nextJob = spawnJob && isSpawnJobClaimTransitionState(spawnJob.state)
			? transitionSpawnJobLocked(spawnJob, {
				state: "claimed",
				updatedAt: now,
				error: null,
			})
			: spawnJob;

		if (nextJob && nextJob !== spawnJob) {
			await writeSpawnJobFile(options.bootstrap.roomDir, nextJob);
			log.info("spawn phase transition", {
				memberName: options.bootstrap.memberName,
				taskId: nextJob.taskId,
				backend: nextJob.backend,
				from: spawnJob?.state ?? null,
				to: nextJob.state,
			});
		}

		const next: RoomMemberState = {
			...baseline,
			requestId: baseline.requestId ?? nextJob?.requestId ?? null,
			backend: effectiveBackend,
			runtimeId: effectiveRuntimeId,
			runtimeIdentitySource: resolveRuntimeIdentitySource({
				current: baseline,
				backend: effectiveBackend,
				runtimeId: effectiveRuntimeId,
				memberPid: options.memberPid,
			}),
			bootstrapClaimedAt: baseline.bootstrapClaimedAt ?? now,
			state: baseline.state,
			spawnTaskId: baseline.spawnTaskId ?? options.bootstrap.spawnTaskId ?? null,
			updatedAt: now,
			heartbeatAt: now,
			lastActiveAt: baseline.lastActiveAt ?? now,
			joinedAt: baseline.joinedAt || now,
			// Preserve the existing sessionId when another session attempts
			// to re-claim an already-active member.
			sessionId: baseline.sessionId != null && baseline.sessionId !== options.sessionId
			? baseline.sessionId
			: options.sessionId,
			chatBusy: false,
			bootstrapToken: expectedBootstrapToken ?? baseline.bootstrapToken ?? options.bootstrap.token,
		};

		await writeRoomMemberState(options.bootstrap.roomDir, next);
		const { claimedEvent, activatedEvent } = await maybePersistFirstClaimEventLocked({
			roomDir: options.bootstrap.roomDir,
			roomId: options.bootstrap.roomId,
			previousMember,
			nextMember: next,
			job: nextJob,
		});
		log.info("bootstrap claimed", {
			memberName: next.name,
			taskId: next.spawnTaskId ?? options.bootstrap.spawnTaskId ?? null,
			sessionId: next.sessionId,
			runtimeId: next.runtimeId,
		});
		return { ...next, claimedEvent, activatedEvent };
	});
}

export async function finalizeMemberRuntime(options: {
	roomDir: string;
	memberName: string;
	taskId: string;
	runtimeId: string;
	backend: RoomBackend;
}): Promise<{ member: RoomMemberState; job: RoomSpawnJob }> {
	const viaClient = await tryViaMutationClient<{ member: RoomMemberState; job: RoomSpawnJob }>(options.roomDir, {
		kind: "finalize_member_runtime",
		payload: {
			memberName: options.memberName,
			taskId: options.taskId,
			runtimeId: options.runtimeId,
			backend: options.backend,
		},
	});
	if (viaClient !== undefined) return viaClient;
	const log = createRoomLogger(options.roomDir, "storage");

	return await withRoomMutationLock(options.roomDir, async () => {
		const now = new Date().toISOString();
		const current = await loadRoomMemberState(options.roomDir, options.memberName).catch(() => null);
		if (!current || current.state === "removed") {
			throw new MemberNotFoundError(options.memberName);
		}

		const job = await readJsonFile<RoomSpawnJob>(getRoomSpawnJobPath(options.roomDir, options.taskId));
		if (job.memberName !== options.memberName) {
			throw new SpawnFailedError(options.memberName, `spawn job ${job.taskId} does not match`);
		}
		if (job.state === "cancelled" || job.state === "failed") {
			throw new SpawnFailedError(options.memberName, `spawn job ${job.taskId} is no longer finalizable (${job.state})`);
		}
		const differentGeneration = isDifferentMemberGeneration({
			current,
			taskId: options.taskId,
			expectedBootstrapToken: job.bootstrapToken ?? null,
			recoveredRuntimeId: options.runtimeId,
			recoveredBackend: options.backend,
		});
		const sameCompletedGeneration = job.state === "completed" && !differentGeneration;
		if (differentGeneration) {
			throw new SpawnFailedError(options.memberName, `spawn job ${job.taskId} belongs to a different member generation`);
		}
		if (current.spawnTaskId && current.spawnTaskId !== options.taskId && !sameCompletedGeneration) {
			throw new SpawnFailedError(options.memberName, "member belongs to a different spawn job");
		}

		const shouldComplete = sameCompletedGeneration || hasBootstrapClaim(current, job);
		if (job.state === "timed_out_pending_external_resolution" && !shouldComplete) {
			throw new SpawnFailedError(options.memberName, `spawn job ${job.taskId} timed out pending external resolution and requires cleanup`);
		}
		const nextJobState: RoomSpawnJobState = shouldComplete ? "completed" : "external_created";
		const nextJob = transitionSpawnJobLocked(job, {
			backend: options.backend,
			runtimeId: options.runtimeId,
			state: nextJobState,
			updatedAt: now,
			error: null,
		});
		const nextMember: RoomMemberState = {
			...current,
			requestId: current.requestId ?? job.requestId ?? null,
			backend: options.backend,
			runtimeId: options.runtimeId,
			runtimeIdentitySource: "owner",
			bootstrapClaimedAt: current.bootstrapClaimedAt ?? (current.sessionId ? now : null),
			state: shouldComplete ? (current.state === "spawning" ? "idle" : current.state) : "spawning",
			spawnTaskId: shouldComplete ? null : (current.spawnTaskId ?? options.taskId),
			updatedAt: now,
			heartbeatAt: now,
			lastActiveAt: now,
			joinedAt: current.joinedAt || now,
		};

		await writeSpawnJobFile(options.roomDir, nextJob);
				if (job.state !== nextJob.state) {
					log.info("spawn phase transition", {
						memberName: nextMember.name,
						taskId: nextJob.taskId,
						backend: nextJob.backend,
						from: job.state,
						to: nextJob.state,
					});
				}
				log.info("runtime finalized by owner", {
					memberName: nextMember.name,
					taskId: nextJob.taskId,
					backend: nextJob.backend,
					runtimeId: nextMember.runtimeId,
				});
		await writeRoomMemberState(options.roomDir, nextMember);
		return { member: nextMember, job: nextJob };
	});
}

export async function markMemberJoined(options: {
	bootstrap: RoomBootstrap;
	sessionId: string | null;
	runtimeId: string;
	backend?: RoomMemberState["backend"];
}): Promise<SessionClaimMutationResult> {
	const { bootstrap, sessionId, runtimeId } = options;
	// Try agent-side proxy first (eliminates file-lock contention)
	const viaClient = await tryViaMutationClient<SessionClaimMutationResult>(bootstrap.roomDir, {
		kind: "mark_member_joined",
		payload: { bootstrap, sessionId, runtimeId, backend: options.backend },
	});
	if (viaClient !== undefined) return viaClient;

	const now = new Date().toISOString();
	return await withRoomMutationLock(bootstrap.roomDir, async () => {
		const metadata = await loadRoomMetadata(bootstrap.roomDir);
		if (metadata.state !== "active") {
			throw new RoomNotClaimableError(metadata.roomId, metadata.state);
		}
		if (bootstrap.ownerSessionId !== metadata.ownerSessionId) {
			throw new BootstrapTokenError(bootstrap.memberName);
		}
		if (bootstrap.ownerName !== metadata.ownerName) {
			throw new BootstrapTokenError(bootstrap.memberName);
		}

		let current: RoomMemberState | null = null;
		let completedSpawnTaskId = bootstrap.spawnTaskId ?? null;
		let recoveredBackend = options.backend ?? "pi";
		let recoveredRuntimeId: string | null = null;
		let spawnJob: RoomSpawnJob | null = null;

		if (completedSpawnTaskId) {
			try {
				spawnJob = await readJsonFile<RoomSpawnJob>(getRoomSpawnJobPath(bootstrap.roomDir, completedSpawnTaskId));
				recoveredBackend = spawnJob.backend;
				recoveredRuntimeId = spawnJob.runtimeId ?? null;
			} catch {
				// Ignore missing or unreadable spawn jobs here.
			}
		}

		try {
			current = await loadRoomMemberState(bootstrap.roomDir, bootstrap.memberName);
		} catch {
			current = null;
		}

		if (!spawnJob && !current) {
			throw new MemberNotFoundError(bootstrap.memberName);
		}

		const expectedBootstrapToken = spawnJob?.bootstrapToken ?? current?.bootstrapToken ?? null;
		if (expectedBootstrapToken && bootstrap.token !== expectedBootstrapToken) {
			throw new BootstrapTokenError(bootstrap.memberName);
		}

		if (spawnJob) {
			if (spawnJob.memberName !== bootstrap.memberName) {
				throw new SpawnFailedError(bootstrap.memberName, `spawn job ${spawnJob.taskId} does not match`);
			}
			if (spawnJob.state === "cancelled" || spawnJob.state === "failed") {
				throw new SpawnFailedError(bootstrap.memberName, `spawn job ${spawnJob.taskId} is no longer claimable (${spawnJob.state})`);
			}
			if (spawnJob.state === "completed" && !current) {
				throw new SpawnFailedError(bootstrap.memberName, `spawn job ${spawnJob.taskId} was already completed and member has been removed`);
			}
		}

		if (current?.state === "removed") {
			throw new MemberNotFoundError(bootstrap.memberName);
		}

		if (isDifferentMemberGeneration({
			current,
			taskId: completedSpawnTaskId,
			expectedBootstrapToken,
			recoveredRuntimeId,
			recoveredBackend,
		})) {
			throw new SpawnFailedError(bootstrap.memberName, `spawn job ${spawnJob?.taskId ?? completedSpawnTaskId ?? "unknown"} belongs to a different member generation`);
		}

		if (completedSpawnTaskId && current?.spawnTaskId && current.spawnTaskId !== completedSpawnTaskId) {
			throw new SpawnFailedError(bootstrap.memberName, "member belongs to a different spawn job");
		}

		if (!current) {
			current = {
				name: bootstrap.memberName,
				type: bootstrap.memberType,
				requestId: spawnJob?.requestId ?? null,
				backend: recoveredBackend,
				runtimeId: recoveredRuntimeId,
				state: "spawning",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: now,
				updatedAt: now,
				heartbeatAt: now,
				sessionId: null,
				bootstrapToken: expectedBootstrapToken ?? bootstrap.token,
			};
		}

		if (!completedSpawnTaskId && current.spawnTaskId) {
			completedSpawnTaskId = current.spawnTaskId;
		}

		const backend = current.backend ?? options.backend ?? recoveredBackend ?? "pi";

		if (completedSpawnTaskId) {
			if (!spawnJob) {
				completedSpawnTaskId = null;
			} else if (backend === "paseo") {
				if (isSpawnJobClaimTransitionState(spawnJob.state)) {
					await writeSpawnJobFile(bootstrap.roomDir, transitionSpawnJobLocked(spawnJob, {
						state: "claimed",
						updatedAt: now,
						error: null,
					}));
				}
			} else if (spawnJob.state === "starting") {
				await writeSpawnJobFile(bootstrap.roomDir, transitionSpawnJobLocked(spawnJob, {
					state: "completed",
					updatedAt: now,
					error: null,
				}));
			} else if (spawnJob.state === "claimed") {
				await writeSpawnJobFile(bootstrap.roomDir, transitionSpawnJobLocked(spawnJob, {
					state: "completed",
					error: null,
				}));
			}
		}

		const effectiveRuntimeId = backend === "paseo"
			? (current.runtimeId ?? recoveredRuntimeId ?? null)
			: (runtimeId ?? current.runtimeId ?? recoveredRuntimeId);
		const isSameRuntimeReattach = current.sessionId === sessionId && current.runtimeId === effectiveRuntimeId && current.state !== "spawning";

		const next: RoomMemberState = {
			...current,
			requestId: current.requestId ?? spawnJob?.requestId ?? null,
			backend,
			runtimeId: effectiveRuntimeId,
			runtimeIdentitySource: backend === "paseo"
				? resolveRuntimeIdentitySource({
					current,
					backend,
					runtimeId: effectiveRuntimeId,
				})
				: "member-pid",
			bootstrapClaimedAt: backend === "paseo" ? (current.bootstrapClaimedAt ?? now) : (current.bootstrapClaimedAt ?? null),
			state: backend === "paseo" ? current.state : (isSameRuntimeReattach ? current.state : "idle"),
			spawnTaskId: backend === "paseo" ? current.spawnTaskId : (completedSpawnTaskId ? null : current.spawnTaskId),
			spawnBatchId: current.spawnBatchId ?? null,
			currentTask: backend === "paseo" ? current.currentTask : (isSameRuntimeReattach ? current.currentTask : null),
			currentTaskMessageId: backend === "paseo" ? current.currentTaskMessageId ?? null : (isSameRuntimeReattach ? current.currentTaskMessageId ?? null : null),
			updatedAt: now,
			heartbeatAt: now,
			lastActiveAt: now,
			joinedAt: current.joinedAt || now,
			sessionId,
			chatBusy: false,
			bootstrapToken: expectedBootstrapToken ?? current.bootstrapToken ?? bootstrap.token,
		};
		await writeRoomMemberState(bootstrap.roomDir, next);
		const { claimedEvent, activatedEvent } = await maybePersistFirstClaimEventLocked({
			roomDir: bootstrap.roomDir,
			roomId: bootstrap.roomId,
			previousMember: current,
			nextMember: next,
			job: spawnJob,
		});
		return { ...next, claimedEvent, activatedEvent };
	});
}

export async function listRoomMembers(roomDir: string): Promise<RoomMemberState[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(getRoomMembersDir(roomDir));
	} catch {
		return [];
	}

	const members = await Promise.all(
		entries
			.filter((entry) => entry.endsWith(".json"))
			.sort((left, right) => left.localeCompare(right))
			.map((entry) => readJsonFile<RoomMemberState>(path.join(getRoomMembersDir(roomDir), entry))),
	);
	return members;
}

function parseMessageSeqFromFileName(entry: string): number | null {
	const match = entry.match(/^(\d+)-.+\.json$/);
	if (!match) return null;
	const seq = Number(match[1]);
	return Number.isFinite(seq) ? seq : null;
}

export async function listBoardEntriesAfterSeq(roomDir: string, afterSeq: number): Promise<RoomMessage[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(getRoomMessagesDir(roomDir));
	} catch {
		return [];
	}

	const messages = await Promise.all(
		entries
			.filter((entry) => entry.endsWith(".json"))
			.map((entry) => ({ entry, seq: parseMessageSeqFromFileName(entry) }))
			.filter((candidate): candidate is { entry: string; seq: number } => candidate.seq !== null && candidate.seq > afterSeq)
			.sort((left, right) => left.seq - right.seq)
			.map(({ entry }) => readJsonFile<RoomMessage>(path.join(getRoomMessagesDir(roomDir), entry))),
	);
	return messages;
}

export async function withRoomMutationLock<T>(
	roomDir: string,
	fn: () => Promise<T>,
	options?: FileLockOptions,
): Promise<T> {
	// If we are already inside a proxy PQueue item (e.g. the proxy server
	// executeCommand called a storage function that wraps itself in
	// withRoomMutationLock), skip ALL locking and execute fn directly.
	// The PQueue already guarantees serialization. See runInsideProxyContext.
	if (_proxyContext.getStore()) {
		return await fn();
	}

	// Owner short-circuit (reviewer Finding 5): if a mutation proxy server
	// is available for this room, serialize via its p-queue instead of
	// acquiring a file lock. This eliminates file-lock contention on the
	// owner process where multiple storage operations run concurrently.
	const proxy = getRoomProxyServer(roomDir);
	if (proxy) {
		const log = createRoomLogger(roomDir, "storage");
		try {
			return await proxy.enqueue(fn);
		} catch (err) {
			// Business logic errors (RoomError subclasses) must propagate
			// to the caller — falling back to file lock would retry an
			// operation that should fail (e.g. MemberNotAvailable, duplicate
			// message, etc.) and cause unnecessary lock contention.
			// Only infrastructure errors (socket disconnect, p-queue timeout,
			// etc.) fall through to the file lock fallback.
			if (err instanceof RoomError) {
				throw err;
			}
			log.warn("proxy enqueue failed, falling back to file lock", { error: String(err) });
			// Fall through to file lock
		}
	}

	// Safety net: if a mutation client is registered for this room, we are in
	// an agent process that MUST route all storage operations through the proxy.
	// File lock fallback is forbidden for agents — it causes seq collisions
	// and lost state updates when racing with the owner's proxy p-queue.
	const mutationClient = getRoomMutationClient(roomDir);
	if (mutationClient) {
		throw new AgentProxyDisconnectedError(
			"Agent mutation client exists but could not route this operation. " +
			"All agent storage operations must go through the owner proxy. " +
			"This indicates the proxy connection was lost mid-session.",
		);
	}

	// Fallback: use file lock (owner process where proxy failed).
	// Agent processes should never reach this point.
	const metadata = await loadRoomMetadata(roomDir).catch(() => null);
	if (!metadata) {
		const roomId = path.basename(roomDir);
		throw new RoomNotFoundError(roomId);
	}
	return await withFileLock(getRoomMutationLockPath(roomDir), metadata.roomId, fn, options);
}

function getTaskTargetNames(message: { to: "room" | string; mentions?: string[]; kind: RoomMessage["kind"] }): string[] {
	const targets = new Set<string>();
	if (message.to !== "room") {
		targets.add(message.to);
	}
	if (message.kind !== "task" || message.to === "room") {
		for (const mention of message.mentions ?? []) {
			targets.add(mention);
		}
	}
	return [...targets];
}

function appendUniqueMessageId(
	ids: string[] | null | undefined,
	messageId: string,
): string[] {
	const next = ids ? [...ids] : [];
	if (!next.includes(messageId)) {
		next.push(messageId);
	}
	return next;
}

function removeQueuedMessageIds(
	ids: string[] | null | undefined,
	messageIds: Iterable<string>,
): string[] | null {
	if (!ids || ids.length === 0) {
		return null;
	}
	const removals = new Set(messageIds);
	const next = ids.filter((messageId) => !removals.has(messageId));
	return next.length > 0 ? next : null;
}

function hasQueuedTaskReservation(target: RoomMemberState): boolean {
	return Boolean(target.queuedTaskMessageIds?.length);
}

async function assertTaskTargetAvailable(roomDir: string, target: RoomMemberState): Promise<void> {
	// Gate on unclosed task ownership only, not on raw lifecycle state.
	// A member can be idle while holding a task (e.g. waiting for deps),
	// and that still counts as occupied.
	if (target.currentTaskMessageId || target.currentTask || hasQueuedTaskReservation(target)) {
		throw new MemberNotAvailableError(target.name, "already has an unclosed task");
	}
	if (isStoppedMemberTombstone(target)) {
		throw new MemberNotAvailableError(target.name, "member was stopped and must be removed before receiving new tasks");
	}
	// New task assignment still requires a reachable lifecycle state.
	// Error members must recover back to idle before taking another task.
	if (target.state === "error") {
		throw new MemberNotAvailableError(target.name, "state is error");
	}
	// Reachability check: member must be alive and reachable.
	// allowRunning=true because the task gate above is the sole arbiter
	// of whether the member is available for assignment.
	await assertDirectedTargetAvailable(roomDir, target, true);
}

function isStoppedMemberTombstone(target: RoomMemberState): boolean {
	const lastError = target.lastError?.trim() ?? "";
	return target.state === "error"
		&& lastError.startsWith("Stop ended this runtime.");
}

async function assertDirectedTargetAvailable(roomDir: string, target: RoomMemberState, allowRunning = true): Promise<void> {
	if (target.state === "running" && !allowRunning) {
		throw new MemberNotAvailableError(target.name, "already running a task");
	}
	if (isStoppedMemberTombstone(target)) {
		throw new MemberNotAvailableError(target.name, "member was stopped and must be removed before receiving new tasks");
	}
	const allowedStates = allowRunning
		? ["spawning", "idle", "running"]
		: ["spawning", "idle"];
	if (!allowedStates.includes(target.state)) {
		throw new MemberNotAvailableError(target.name, `state is ${target.state}`);
	}
	if (target.state === "spawning" && target.spawnTaskId) {
		const spawnJob = await readSpawnJob(roomDir, target.spawnTaskId).catch(() => null);
		if (spawnJob && !isSpawnJobDirectedDeliveryState(spawnJob.state)) {
			throw new MemberNotAvailableError(target.name, `spawn job is ${spawnJob.state}`);
		}
	}
	if (target.state !== "spawning" && !target.runtimeId && !target.sessionId) {
		// error-state members with a live heartbeat are still reachable.
		const hb = await readMemberHeartbeat(roomDir, target.name).catch(() => null);

		// Inline isProcessAlive to avoid circular dependency with watchdog.ts
		const hbPidAlive = hb ? (() => {
			if (!Number.isFinite(hb.pid) || hb.pid <= 0) return false;
			try { process.kill(hb.pid, 0); return true; }
			catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
		})() : false;

		const staleMs = computeHeartbeatStaleMs(target.type);
		const hbFresh = hb ? (Date.now() - Date.parse(hb.updatedAt) <= staleMs) : false;

		if (!(hbFresh && hbPidAlive)) {
			throw new MemberNotAvailableError(target.name, "heartbeat is stale or process not alive");
		}

		// P0-2: Mutate the target object so that appendMessage's
		// writeRoomMemberState will persist the recovered runtimeId
		// when it transitions the member to running.
		if (target.backend === "pi" && hb) {
			target.runtimeId = String(hb.pid);
		}
		// P0-1: Keep original sessionId, NEVER synthesize
		// target.sessionId stays as-is
	}
}

export async function appendMessage(
	roomDir: string,
	message: Omit<RoomMessage, "seq" | "id" | "createdAt"> & Partial<Pick<RoomMessage, "id" | "createdAt">>,
): Promise<RoomMessage> {
	// Try agent-side proxy first (eliminates file-lock contention)
	const viaClient = await tryViaMutationClient<RoomMessage>(roomDir, {
		kind: "append_message",
		payload: { message },
	});
	if (viaClient !== undefined) return viaClient;

	return await withRoomMutationLock(roomDir, async () => {
		if (
			message.replyTo
			&& (message.kind === "completion" || message.kind === "error" || message.kind === "cancelled")
		) {
			const existingTerminalReply = (await listBoardEntries(roomDir, Number.MAX_SAFE_INTEGER)).find((entry) => {
				return entry.replyTo === message.replyTo
					&& (entry.kind === "completion" || entry.kind === "error" || entry.kind === "cancelled");
			});
			if (existingTerminalReply) {
				return existingTerminalReply;
			}
		}

		const targetNames = getTaskTargetNames(message);
		const targets = await Promise.all(
			targetNames.map(async (name) => {
				const target = await loadRoomMemberState(roomDir, name).catch(() => null);
				if (!target || target.state === "removed") {
					throw new MemberNotFoundError(name);
				}
				const deliveryGate = await readMemberDeliveryGate(roomDir, target).catch(
					() => null,
				);
				if (message.kind === "task") {
					await assertTaskTargetAvailable(roomDir, target);
				} else if (message.kind !== "cancelled") {
					// cancelled is a system event record, not a message delivery.
					// It does not require the target to be in an "available" state
					// because it documents a fact (task was cancelled) rather than
					// requesting the target to take action. The basic checks above
					// (exists, not removed) are sufficient.
					await assertDirectedTargetAvailable(roomDir, target);
				}
				return { target, deliveryGate };
			}),
		);

		const metadata = await loadRoomMetadata(roomDir);
		const nextSeq = Math.max(metadata.nextSeq, await getPersistedNextSeq(roomDir));
		const complete: RoomMessage = {
			seq: nextSeq,
			id: message.id ?? `m${randomUUID()}`,
			from: message.from,
			to: message.to,
			batchId: message.batchId,
			silent: message.silent === true ? true : undefined,
			mentions: message.mentions && message.mentions.length > 0 ? [...new Set(message.mentions)] : undefined,
			broadcast: message.broadcast,
			replyTo: message.replyTo ?? null,
			kind: message.kind,
			summary: message.summary,
			content: message.content,
			createdAt: message.createdAt ?? new Date().toISOString(),
		};
		await writeJsonAtomic(getRoomMessagePath(roomDir, complete.seq, complete.id), complete);
		await writeRoomMetadata(roomDir, { ...metadata, nextSeq: nextSeq + 1 });

		await Promise.all(targets.map(({ target, deliveryGate }) => {
			const queuedWhileHeld = shouldQueueCallerDirectedMessage(
				complete,
				target.name,
				deliveryGate,
			);
			if (queuedWhileHeld) {
				return writeRoomMemberState(roomDir, {
					...target,
					queuedDeliveryMessageIds: appendUniqueMessageId(
						target.queuedDeliveryMessageIds,
						complete.id,
					),
					queuedTaskMessageIds:
						complete.kind === "task"
							? appendUniqueMessageId(target.queuedTaskMessageIds, complete.id)
							: target.queuedTaskMessageIds ?? null,
					updatedAt: new Date().toISOString(),
				});
			}
			if (complete.kind !== "task") {
				return Promise.resolve();
			}
			return writeRoomMemberState(roomDir, {
				...target,
				// Owner-side assignment never means the new task has already started.
				// If a task-free member was still marked running, normalize it back to
				// idle so dependency-gated tasks can later produce a real idle->running
				// transition (and single Starting: emission) when they become ready.
				state: target.state === "running" ? "idle" : target.state,
				currentTask: complete.summary,
				currentTaskMessageId: complete.id,
				lastError: null,
				updatedAt: new Date().toISOString(),
			});
		}));

		return complete;
	});
}

export async function appendDirectedTaskMessage(
	roomDir: string,
	message: {
		from: string;
		to: string;
		batchId?: string;
		silent?: true;
		mentions?: string[];
		summary: string;
		content?: string;
		replyTo?: string | null;
		id?: string;
		createdAt?: string;
	},
): Promise<RoomMessage> {
	return await appendMessage(roomDir, {
		from: message.from,
		to: message.to,
		batchId: message.batchId,
		silent: message.silent,
		mentions: message.mentions,
		broadcast: false,
		replyTo: message.replyTo ?? null,
		kind: "task",
		summary: message.summary,
		content: message.content,
		id: message.id,
		createdAt: message.createdAt,
	});
}

export async function listBoardEntries(roomDir: string, limit = 20): Promise<RoomMessage[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(getRoomMessagesDir(roomDir));
	} catch {
		return [];
	}

	const messages = await Promise.all(
		entries
			.filter((entry) => entry.endsWith(".json"))
			.sort((left, right) => left.localeCompare(right))
			.map((entry) => readJsonFile<RoomMessage>(path.join(getRoomMessagesDir(roomDir), entry))),
	);
	return messages.slice(-limit);
}

export async function readMessage(roomDir: string, id: string): Promise<RoomMessage | null> {
	const messages = await listBoardEntries(roomDir, Number.MAX_SAFE_INTEGER);
	return messages.find((message) => message.id === id) ?? null;
}

export async function readMessageBySeq(roomDir: string, seq: number): Promise<RoomMessage | null> {
	const messages = await listBoardEntries(roomDir, Number.MAX_SAFE_INTEGER);
	return messages.find((message) => message.seq === seq) ?? null;
}

export function resolveTaskSeqByMessageIdFromEntries(
	messages: ReadonlyArray<Pick<RoomMessage, "id" | "seq">>,
	messageId: string,
): number | null {
	const found = messages.find((message) => message.id === messageId);
	return found ? found.seq : null;
}

/**
 * Resolve a task's board seq from its message ID.
 * Performs a read-only scan of the room's message board and returns
 * the seq of the message matching the given ID, or null if not found.
 *
 * Used to align member.currentTaskMessageId (message ID) with
 * board-based seq references used in dependency notifications.
 */
export async function resolveTaskSeqByMessageId(
	roomDir: string,
	messageId: string,
	messages?: ReadonlyArray<Pick<RoomMessage, "id" | "seq">>,
): Promise<number | null> {
	if (messages) return resolveTaskSeqByMessageIdFromEntries(messages, messageId);
	const board = await listBoardEntries(roomDir, Number.MAX_SAFE_INTEGER);
	return resolveTaskSeqByMessageIdFromEntries(board, messageId);
}

export async function getLastDeliverableMessageSeq(roomDir: string, memberName: string): Promise<number> {
	const messages = await listBoardEntries(roomDir, Number.MAX_SAFE_INTEGER);
	const deliveryGate = await readMemberDeliveryGate(roomDir, memberName).catch(
		() => null,
	);
	let lastSeq = 0;
	for (const message of messages) {
		if (!shouldDeliverMessage(message, memberName, deliveryGate)) continue;
		lastSeq = Math.max(lastSeq, message.seq);
	}
	return lastSeq;
}

export async function writeSpawnJob(roomDir: string, job: RoomSpawnJob): Promise<void> {
	await withRoomMutationLock(roomDir, async () => {
		await writeSpawnJobFile(roomDir, job);
	});
}

export async function createSpawnJob(
	roomDir: string,
	job: Pick<RoomSpawnJob, "taskId" | "memberName" | "backend"> & Partial<Pick<RoomSpawnJob, "state" | "error">>,
): Promise<RoomSpawnJob> {
	return await withRoomMutationLock(roomDir, async () => {
		const now = new Date().toISOString();
		const next: RoomSpawnJob = {
			taskId: job.taskId,
			memberName: job.memberName,
			backend: job.backend,
			runtimeId: null,
			state: job.state ?? "starting",
			createdAt: now,
			updatedAt: now,
			error: job.error ?? null,
		};
		await writeSpawnJobFile(roomDir, next);
		return next;
	});
}

export async function createSpawningMember(
	roomDir: string,
	options: {
		name?: string;
		displayName?: string | null;
		type: string;
		backend: RoomBackend;
		taskId: string;
		spawnBatchId?: string | null;
		transient?: boolean | null;
		bootstrapToken?: string | null;
		sessionId?: string | null;
		requestReplay?: CrewAddReplaySeed | null;
	},
): Promise<{ member: RoomMemberState; job: RoomSpawnJob; replayed: boolean; replayRecord: CrewAddReplayRecord | null }> {
	return await withRoomMutationLock(roomDir, async () => {
		const replaySeed = options.requestReplay
			? normalizeCrewAddReplaySeed(options.requestReplay)
			: null;
		if (replaySeed) {
			const existingReplay = await readCrewAddRequestReplay(roomDir, replaySeed.request_id);
			if (existingReplay) {
				if (!crewAddReplayMatches(existingReplay, replaySeed)) {
					throw Object.assign(
						new ValidationError(`request_id ${replaySeed.request_id} conflicts with an existing crew:add request.`),
						{ crewAddReason: "request-id-conflict" },
					);
				}
				const repaired = await resolveCrewAddReplayAnchors(existingReplay, roomDir);
				return {
					member: repaired.member,
					job: repaired.job,
					replayed: true,
					replayRecord: existingReplay,
				};
			}
			const existingMember = (await listRoomMembers(roomDir))
				.find((member) => member.requestId === replaySeed.request_id) ?? null;
			const existingJob = existingMember
				? (await listRoomSpawnJobs(roomDir))
					.find((job) => job.requestId === replaySeed.request_id && job.memberName === existingMember.name) ?? null
				: null;
			if (existingMember && existingJob) {
				const recoveredRecord = buildCrewAddReplayRecord({
					seed: replaySeed,
					member: existingMember,
					job: existingJob,
					backend: existingJob.backend,
					updatedAt: existingJob.updatedAt,
				});
				await writeCrewAddRequestReplayFile(roomDir, recoveredRecord);
				return {
					member: existingMember,
					job: existingJob,
					replayed: true,
					replayRecord: recoveredRecord,
				};
			}
		}

		const normalizedDisplayName = options.displayName ? normalizeMemberDisplayName(options.displayName) : null;
		const members = await listRoomMembers(roomDir);
		const memberName = options.name ?? (normalizedDisplayName
			? createInternalMemberNameFromSet(normalizedDisplayName, new Set(members.map((member) => member.name)))
			: (() => { throw new ValidationError("Spawning members require an internal name or display alias."); })());
		const existing = await loadRoomMemberState(roomDir, memberName).catch(() => null);
		if (existing) {
			throw new MemberAlreadyExistsError(memberName);
		}

		if (normalizedDisplayName) {
			const conflict = members.find((member) => {
				if (member.state === "removed") {
					return false;
				}
				return getMemberDisplayName(member) === normalizedDisplayName
					|| member.name === normalizedDisplayName
					|| formatMemberLabel(member) === normalizedDisplayName;
			});
			if (conflict) {
				throw new ValidationError(`Agent alias ${normalizedDisplayName} conflicts with active member ${formatMemberLabel(conflict)}.`);
			}
		}

		const now = new Date().toISOString();
		const member: RoomMemberState = {
			name: memberName,
			displayName: normalizedDisplayName,
			requestId: replaySeed?.request_id ?? null,
			type: options.type,
			backend: options.backend,
			runtimeId: null,
			runtimeIdentitySource: "none",
			state: "spawning",
			spawnTaskId: options.taskId,
			spawnBatchId: options.spawnBatchId ?? null,
			transient: options.transient ?? null,
			currentTask: null,
			currentTaskMessageId: null,
			lastCompletedTask: null,
			lastError: null,
			chatBusy: false,
			lastSeenSeq: 0,
			joinedAt: now,
			updatedAt: now,
			heartbeatAt: null,
			lastActiveAt: now,
			sessionId: options.sessionId ?? null,
			bootstrapToken: options.bootstrapToken ?? null,
			bootstrapClaimedAt: null,
			pendingSelfAckMessageId: null,
		};
		const job: RoomSpawnJob = {
			taskId: options.taskId,
			memberName,
			requestId: replaySeed?.request_id ?? null,
			backend: options.backend,
			runtimeId: null,
			bootstrapToken: options.bootstrapToken ?? null,
			state: "starting",
			createdAt: now,
			updatedAt: now,
			error: null,
		};

		const replayRecord = replaySeed
			? buildCrewAddReplayRecord({
				seed: replaySeed,
				member,
				job,
				backend: options.backend,
				updatedAt: now,
			})
			: null;
		if (replayRecord) {
			await writeCrewAddRequestReplayFile(roomDir, replayRecord);
		}
		await writeRoomMemberState(roomDir, member);
		await writeSpawnJobFile(roomDir, job);
		return { member, job, replayed: false, replayRecord };
	});
}

export async function deleteRoomMemberState(roomDir: string, memberName: string): Promise<void> {
	await withRoomMutationLock(roomDir, async () => {
		await deleteRoomMemberStateFile(roomDir, memberName);
	});
}

export async function deleteRoomMemberStateFile(roomDir: string, memberName: string): Promise<void> {
	await fs.rm(getRoomMemberStatePath(roomDir, memberName), { force: true });
	await deleteMemberHeartbeat(roomDir, memberName);
}

export async function updateSpawnJob(
	roomDir: string,
	taskId: string,
	patch: Partial<Omit<RoomSpawnJob, "taskId" | "memberName" | "backend" | "createdAt">>,
): Promise<RoomSpawnJob> {
	return await withRoomMutationLock(roomDir, async () => {
		const current = await readJsonFile<RoomSpawnJob>(getRoomSpawnJobPath(roomDir, taskId));
		const next: RoomSpawnJob = {
			...current,
			...patch,
			updatedAt: patch.updatedAt ?? new Date().toISOString(),
		};
		assertSpawnJobStateForBackend(next.backend, next.state);
		await writeSpawnJobFile(roomDir, next);
		return next;
	});
}

export async function readSpawnJob(roomDir: string, taskId: string): Promise<RoomSpawnJob | null> {
	try {
		return await readJsonFile<RoomSpawnJob>(getRoomSpawnJobPath(roomDir, taskId));
	} catch {
		return null;
	}
}

export async function createRoom(options: {
	runtimeRoot?: string;
	ownerName: string;
	ownerSessionId: string;
	cwd: string;
	ownerPid?: number;
	publishOwnerIndex?: boolean;
}): Promise<{ roomDir: string; metadata: RoomMetadata; owner: RoomMemberState }> {
	const runtimeRoot = options.runtimeRoot ?? getDefaultRoomRuntimeRoot();
	const roomId = `room-${randomUUID()}`;
	const now = new Date().toISOString();
	const metadata: RoomMetadata = {
		roomId,
		ownerName: options.ownerName,
		ownerSessionId: options.ownerSessionId,
		ownerPid: options.ownerPid ?? process.pid,
		cwd: options.cwd,
		createdAt: now,
		state: "active",
		nextSeq: 1,
	};
	const owner: RoomMemberState = {
		name: options.ownerName,
		type: "owner",
		backend: "pi",
		runtimeId: String(process.pid),
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
	};
	const roomDir = await initializeRoomRuntime(runtimeRoot, metadata, owner);
	if (options.publishOwnerIndex !== false) {
		await writeOwnerRoomIndex(runtimeRoot, metadata.ownerSessionId, metadata.roomId);
	}
	return { roomDir, metadata, owner };
}

export async function findOrCreateRoomForOwnerSession(options: {
	runtimeRoot?: string;
	ownerName: string;
	ownerSessionId: string;
	cwd: string;
	ownerPid?: number;
	onCreate?: (created: { roomDir: string; metadata: RoomMetadata; owner: RoomMemberState }) => Promise<void>;
}): Promise<{ created: boolean; roomDir: string; metadata: RoomMetadata; owner: RoomMemberState }> {
	const runtimeRoot = options.runtimeRoot ?? getDefaultRoomRuntimeRoot();
	await fs.mkdir(runtimeRoot, { recursive: true });
	return await withFileLock(getOwnerSessionCreateLockPath(runtimeRoot, options.ownerSessionId), options.ownerSessionId, async () => {
		const indexed = await loadOwnerRoomIndex(runtimeRoot, options.ownerSessionId);
		let existing: { roomDir: string; metadata: RoomMetadata } | null = null;
		if (indexed?.roomId) {
			const roomDir = getRoomPath(runtimeRoot, indexed.roomId);
			try {
				const metadata = await loadRoomMetadata(roomDir);
				const heartbeatFresh = isOwnerHeartbeatFresh(await readOwnerHeartbeat(roomDir), metadata);
				if (metadata.ownerSessionId === options.ownerSessionId && metadata.state === "active" && heartbeatFresh) {
					existing = { roomDir, metadata };
				}
			} catch {
				// Fall through to scan-and-repair under the already-held owner lock.
			}
		}
		if (!existing) {
			existing = await repairOwnerRoomLookup(
				runtimeRoot,
				options.ownerSessionId,
				await scanOwnerRoomCandidates(runtimeRoot, options.ownerSessionId),
				false,
			);
		}
		if (existing) {
			const owner = await loadRoomMemberState(existing.roomDir, existing.metadata.ownerName);
			return {
				created: false,
				roomDir: existing.roomDir,
				metadata: existing.metadata,
				owner,
			};
		}

		const created = await createRoom({
			runtimeRoot,
			ownerName: options.ownerName,
			ownerSessionId: options.ownerSessionId,
			cwd: options.cwd,
			ownerPid: options.ownerPid,
			publishOwnerIndex: false,
		});
		if (options.onCreate) {
			await options.onCreate(created);
		}
		await writeOwnerRoomIndex(runtimeRoot, options.ownerSessionId, created.metadata.roomId);
		return { created: true, ...created };
	});
}

export async function findRoomByOwnerSessionId(runtimeRoot: string, ownerSessionId: string): Promise<{ roomDir: string; metadata: RoomMetadata } | null> {
	const indexed = await loadOwnerRoomIndex(runtimeRoot, ownerSessionId);
	if (indexed?.roomId) {
		const roomDir = getRoomPath(runtimeRoot, indexed.roomId);
		try {
			const metadata = await loadRoomMetadata(roomDir);
			const heartbeatFresh = isOwnerHeartbeatFresh(await readOwnerHeartbeat(roomDir), metadata);
			if (metadata.ownerSessionId === ownerSessionId && metadata.state === "active" && heartbeatFresh) {
				return { roomDir, metadata };
			}
		} catch {
			// Fall through to scan-and-repair.
		}
	}

	const initialCandidates = await scanOwnerRoomCandidates(runtimeRoot, ownerSessionId);
	return await repairOwnerRoomLookup(runtimeRoot, ownerSessionId, initialCandidates, true);
}
