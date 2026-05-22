import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { CrewAddSchema, CrewStopSchema, CrewRemoveSchema, CrewRolesSchema, CrewMergeSchema, CrewTellSchema, CrewMessagesSchema, CrewReplySchema, CrewReadSchema, CrewWhoSchema, CrewTasksSchema } from "./schemas.ts";
import { createWorktree, persistWorktreeSnapshot, pruneWorktrees, git } from "./worktree.ts";
import { archiveMemberWorktreeCleanup } from "./worktree-cleanup.ts";

/**
 * Per-room spawn serialization to prevent concurrent paseo daemon createAgent RPCs.
 * The paseo backend processes createAgent serially; concurrent calls can fail.
 * This Promise-based queue ensures spawns execute one at a time per room.
 */
const roomSpawnSerials = new Map<string, Promise<unknown>>();

function serializeRoomSpawn<T>(roomDir: string, fn: () => Promise<T>): Promise<T> {
	const prev = roomSpawnSerials.get(roomDir) ?? Promise.resolve();
	// Chain next spawn after previous settles (success or failure), so a
	// failed spawn does not stall the queue.
	const next = prev.then(() => fn(), () => fn()).finally(() => {
		// Clean up the serial entry once the chain settles and no new spawn
		// has been queued behind it. Otherwise the Map accumulates resolved
		// Promises for every roomDir ever seen.
		if (roomSpawnSerials.get(roomDir) === next) {
			roomSpawnSerials.delete(roomDir);
		}
	});
	roomSpawnSerials.set(roomDir, next);
	return next;
}

// ── Context injection cache ──────────────────────────────────────────────

/** Module-level cache for context files to avoid re-reading on every tell. */
const contextFileCache = new Map<string, string>();

/** Load a context markdown file from skills/room-member/contexts/.
 *  Uses a module-level cache so each file is only read once per process. */
function loadContextFile(name: string): string {
	const cached = contextFileCache.get(name);
	if (cached !== undefined) return cached;
	try {
		const contextPath = fileURLToPath(new URL(`../../skills/room-member/contexts/${name}.md`, import.meta.url));
		const body = readFileSync(contextPath, "utf8").trim();
		contextFileCache.set(name, body);
		return body;
	} catch {
		createRoomLogger(null, "tools").warn("failed to load context file", { file: `${name}.md` });
		return "";
	}
}

/** Auto-detect {input:#N} patterns in content. */
function hasInputDeps(content?: string): boolean {
	return typeof content === "string" && /\{input:\s*#\d+\s*\}/.test(content);
}

/** Load and format the input-deps context block. Returns empty string on failure. */
function loadInputDepsContext(): string {
	const body = loadContextFile("input-deps");
	return body ? "\n\n---\n" + body : "";
}

import {
	getActiveRoom,
	getSessionId,
	resolveAccessibleRoom,
	startOwnerHeartbeat,
	startPolling,
	trackActiveRoomTask,
	type ActiveRoomContext,
} from "./lifecycle.ts";

import type {
	QueuedCrewAddResult,
	QueuedCrewTellResult,
	QueuedTaskHandle,
	RoomExecutionContext,
	RoomMemberState,
	RoomMessage,
	RoomMessageKind,
	RoomSpawnAdapter,
	RoomToolParams,
} from "./types.ts";
import {
	appendDirectedTaskMessage,
	appendMessage,
	createSpawningMember,
	deleteRoomMemberState,
	deleteRoomMemberStateFile,
	finalizeMemberRuntime,
	formatMemberLabel,
	getMemberDisplayName,
	getLastDeliverableMessageSeq,
	getRoomSpawnJobPath,
	isValidMemberTargetInput,
	isValidRoomMemberName,
	listBoardEntries,
	listRoomMembers,
	loadRoomMemberState,
	normalizeMemberDisplayName,
	resolveMemberTarget,
	resolveMemberTargetForMerge,
	readMessage,
	readMessageBySeq,
	readSpawnJob,
	transitionSpawnJob,
	transitionSpawnJobRecord,
	updateRoomMemberState,
	writeJsonAtomic,
	writeRoomMemberState,
} from "./storage.ts";
import {
	buildRoomMemberSystemPrompt,
	listRoomAgentTypes,
	loadTypedRoomAgentDefinition,
} from "./bootstrap.ts";

import {
	applyOutgoingMessageState,
	formatRoomMessageContent,
	kindEmoji,
} from "./dispatch.ts";
import { withRoomMutationLock } from "./storage.ts";
import { consoleError, createRoomLogger } from "./logger.ts";

import {
	registerDeps,
	clearRoomDeps,
	allDepsReady,
	extractInputDeps,
	annotateMultiDepHint,
	checkAndNotifyIfReady,
	isTaskClosed,
	markTaskClosed,
	setTaskState,
} from "./deps.ts";
import { tryNotifyDepsViaProxy, tryRemoveTransientViaProxy } from "./storage.ts";
import { MemberAlreadyExistsError, MemberNotFoundError, SpawnFailedError, ValidationError } from "./errors.ts";
import { ensureOwnerInfrastructure } from "./owner-room.ts";
import {
	appendTerminalTaskReplyAndNotify,
	recordTerminalTaskState,
} from "./task-terminal.ts";

// ── Derived state helpers (pure / near-pure functions) ────────────────────

/** Expanded task status including derived intermediate states. */
export type TaskStatus =
	"assigned" | "waiting_deps" | "blocked_failed" |
	"running" | "completed" | "error" | "cancelled" | "agentLost";

/**
 * Derive the task status for a given task message based on its reply,
 * dependency state, and the target member's lifecycle state.
 *
 * Decision order (must be strictly followed):
 * 1. Terminal reply (completion/error/cancelled) → terminal status
 * 2. Member lost / no longer holds task → agentLost
 * 3. Has {input:#N} deps → blocked_failed or waiting_deps
 * 4. Member idle but holding task → assigned
 * 5. Otherwise → running
 */
async function deriveTaskStatus(
	roomDir: string,
	task: RoomMessage,
	allMessages: RoomMessage[],
	members: RoomMemberState[],
): Promise<TaskStatus> {
	// 1. Check for terminal reply
	const reply = allMessages.find((m) =>
		m.replyTo === task.id &&
		["completion", "error", "cancelled"].includes(m.kind),
	);
	if (reply) {
		if (reply.kind === "completion") return "completed";
		if (reply.kind === "error") return "error";
		return "cancelled";
	}

	// 2. Check agentLost: target member gone, removed, or in error state
	if (task.to !== "room") {
		const member = members.find((m) => m.name === task.to);
		if (!member) {
			return "agentLost";
		}
		if (
			(member.state === "removed" || member.state === "error")
			&& member.currentTaskMessageId !== task.id
		) {
			return "agentLost";
		}

		// 3. Check dependency state
		const deps = extractInputDeps(task.content);
		if (deps.length > 0) {
			const { ready, hasError, hasCancelled } = await allDepsReady(roomDir, task.content);
			if (hasError || hasCancelled) return "blocked_failed";
			if (!ready) return "waiting_deps";
		}

		// 4. Member holds task but raw state is still idle → assigned
		if (member.state === "idle") {
			return "assigned";
		}
	}

	// 5. Default: running
	return "running";
}

/**
 * Derive the display state for a member shown in crew_who output.
 *
 * Priority order:
 * 1. Lifecycle states (removed/stopping/error/spawning) → passthrough
 * 2. member.state === "running" → running
 * 3. idle + chatBusy → chatting
 * 4. idle + currentTaskMessageId → derive from task status:
 *    - blocked_failed / waiting_deps / assigned
 * 5. Otherwise → idle
 */
async function deriveMemberDisplayState(
	member: RoomMemberState,
	roomDir: string,
	allMessages: RoomMessage[],
	allMembers: RoomMemberState[],
): Promise<string> {
	// 1. Lifecycle states passthrough
	if (
		member.state === "removed" ||
		member.state === "stopping" ||
		member.state === "error" ||
		member.state === "spawning"
	) {
		return member.state;
	}

	// 2. Running
	if (member.state === "running") {
		return "running";
	}

	// 3. Idle but chatting
	if (member.state === "idle" && member.chatBusy === true) {
		return "chatting";
	}

	// 4. Idle but holding a task — derive task status
	if (member.state === "idle" && member.currentTaskMessageId) {
		const task = allMessages.find((m) => m.id === member.currentTaskMessageId);
		if (task) {
			const taskStatus = await deriveTaskStatus(roomDir, task, allMessages, allMembers);
			if (taskStatus === "blocked_failed") return "blocked_failed";
			if (taskStatus === "waiting_deps") return "waiting_deps";
			return "assigned";
		}
	}

	// 5. Otherwise: idle
	return "idle";
}

// Re-exported for consumers that import from tools.ts
export { CrewAddSchema, CrewStopSchema, CrewRemoveSchema, CrewRolesSchema, CrewMergeSchema, CrewTellSchema, CrewMessagesSchema, CrewReplySchema, CrewReadSchema, CrewWhoSchema, CrewTasksSchema };

export function textResult(text: string, isError = false): { content: Array<{ type: "text"; text: string }>; isError?: true } {
	return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

function createRoomNameFormatter(members: RoomMemberState[]): (name: string) => string {
	const labels = new Map(members.map((member) => [member.name, formatMemberLabel(member)]));
	return (name: string) => labels.get(name) ?? name;
}

async function loadRoomNameFormatter(roomDir: string): Promise<(name: string) => string> {
	return createRoomNameFormatter(await listRoomMembers(roomDir).catch(() => []));
}

function formatRoomTargetName(target: string, formatter: (name: string) => string): string {
	return target === "room" ? "room" : formatter(target);
}

function terminalTaskStatusFromKind(kind: RoomMessageKind): "completed" | "error" | "cancelled" | null {
	if (kind === "completion") return "completed";
	if (kind === "error" || kind === "cancelled") return kind;
	return null;
}

function buildTerminalReplySnapshotCommitMessage(options: {
	memberName: string;
	taskSeq: number;
	kind: Extract<RoomMessageKind, "completion" | "error" | "cancelled">;
	summary: string;
}): string {
	const normalizedSummary = options.summary.trim().replace(/\s+/g, " ");
	const base = `pi-agent reply snapshot: ${options.memberName} task #${options.taskSeq} ${options.kind}`;
	return normalizedSummary ? `${base} — ${normalizedSummary}`.slice(0, 240) : base;
}

async function prepareTerminalReplySnapshot(options: {
	roomDir: string;
	memberName: string;
	taskSeq: number;
	kind: Extract<RoomMessageKind, "completion" | "error" | "cancelled">;
	summary: string;
	replyMessageId?: string;
}): Promise<{ replyMessageId?: string; snapshotOid?: string }> {
	const member = await loadRoomMemberState(options.roomDir, options.memberName).catch(() => null);
	if (!member?.worktree?.path) {
		return { replyMessageId: options.replyMessageId };
	}

	const pending = member.pendingTerminalReply;
	const isRetryForSameTask = pending
		&& pending.taskSeq === options.taskSeq
		&& pending.kind === options.kind;
	if (isRetryForSameTask && pending.snapshotOid && pending.handoffState !== "snapshot_pending") {
		const nextReplyMessageId = pending.replyMessageId ?? options.replyMessageId;
		if (nextReplyMessageId !== pending.replyMessageId) {
			await updateRoomMemberState(options.roomDir, options.memberName, {
				pendingTerminalReply: {
					...pending,
					replyMessageId: nextReplyMessageId ?? null,
				},
			});
		}
		return {
			replyMessageId: nextReplyMessageId,
			snapshotOid: pending.snapshotOid,
		};
	}

	await updateRoomMemberState(options.roomDir, options.memberName, {
		pendingTerminalReply: {
			taskSeq: options.taskSeq,
			kind: options.kind,
			snapshotOid: null,
			replyMessageId: options.replyMessageId ?? null,
			handoffState: "snapshot_pending",
		},
	});

	const snapshot = await persistWorktreeSnapshot(member.worktree.path, {
		commitMessage: buildTerminalReplySnapshotCommitMessage(options),
	});
	if (!snapshot.commitOid) {
		throw new Error("Snapshot persistence did not return a commit OID.");
	}

	await updateRoomMemberState(options.roomDir, options.memberName, {
		lastSnapshotOid: snapshot.commitOid,
		lastSnapshotAt: snapshot.committedAt ?? new Date().toISOString(),
		lastSnapshotSummary: snapshot.summary ?? null,
		lastSnapshotTaskSeq: options.taskSeq,
		pendingTerminalReply: {
			taskSeq: options.taskSeq,
			kind: options.kind,
			snapshotOid: snapshot.commitOid,
			replyMessageId: options.replyMessageId ?? null,
			handoffState: "snapshot_done",
		},
	});

	return {
		replyMessageId: options.replyMessageId,
		snapshotOid: snapshot.commitOid,
	};
}

async function updatePendingTerminalReplyState(options: {
	roomDir: string;
	memberName: string;
	taskSeq: number;
	kind: Extract<RoomMessageKind, "completion" | "error" | "cancelled">;
	replyMessageId?: string;
	handoffState: "reply_appended" | "owner_handoff_done";
	clear?: boolean;
}): Promise<void> {
	const member = await loadRoomMemberState(options.roomDir, options.memberName).catch(() => null);
	const pending = member?.pendingTerminalReply;
	if (!member || !pending || pending.taskSeq !== options.taskSeq || pending.kind !== options.kind) {
		return;
	}
	await updateRoomMemberState(options.roomDir, options.memberName, {
		pendingTerminalReply: options.clear
			? null
			: {
				...pending,
				replyMessageId: options.replyMessageId ?? pending.replyMessageId ?? null,
				handoffState: options.handoffState,
			},
	});
}

function resolveTargetErrorText(error: unknown, input: string): string {
	if (error instanceof MemberNotFoundError || error instanceof ValidationError) {
		return error.message;
	}
	if (error instanceof Error && error.message.trim()) {
		return error.message;
	}
	return `Member ${input} not found.`;
}

export function ownerOnlyError(): { content: Array<{ type: "text"; text: string }>; isError?: true } {
	return textResult("Only the lead may call create, spawn, stop, or remove.", true) as { content: Array<{ type: "text"; text: string }>; isError?: true };
}

export function ownerRoomUnavailableError(): { content: Array<{ type: "text"; text: string }>; isError?: true } {
	return textResult("Lead session has not been initialized for this session, or owner classification is unavailable.", true);
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

type RoomExecCtx = RoomExecutionContext & {
	currentModel?: string;
	currentThinkingLevel?: ThinkingLevel;
	getSystemPrompt?: () => string | undefined;
	sessionManager?: { getSessionId?: () => string | null | undefined };
};

type QueueBatchContext = {
	id: string;
	silentOwnerDelivery: boolean;
};

type QueueCrewAddOptions = {
	activeRoom: ActiveRoomContext;
	sessionId: string;
	ctx: RoomExecCtx;
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };
	batchContext?: QueueBatchContext;
};

type QueueCrewTellOptions = {
	activeRoom: ActiveRoomContext;
	batchContext?: QueueBatchContext;
};

export function extractSummaryMentions(summary: string, senderName: string): string[] {
	const mentions = new Set<string>();
	const pattern = /(^|[^A-Za-z0-9_-])@([A-Za-z0-9][A-Za-z0-9_-]*(?:#[A-Za-z0-9][A-Za-z0-9_-]*)?)/g;
	for (const match of summary.matchAll(pattern)) {
		const mention = match[2]?.trim();
		if (mention && mention !== senderName) {
			mentions.add(mention);
		}
	}
	return [...mentions];
}

async function resolveSummaryMentions(
	roomDir: string,
	mentions: string[],
	senderName?: string,
): Promise<{ validMentions: string[]; unresolvedMentions: string[] }> {
	const validMentions = new Set<string>();
	const unresolvedMentions: string[] = [];
	for (const mention of mentions) {
		try {
			const resolved = await resolveMemberTarget(roomDir, mention);
			if (resolved.name === senderName) {
				continue;
			}
			validMentions.add(resolved.name);
		} catch (error) {
			if (error instanceof MemberNotFoundError || error instanceof ValidationError) {
				unresolvedMentions.push(mention);
				continue;
			}
			throw error;
		}
	}
	return { validMentions: [...validMentions], unresolvedMentions };
}

function formatSummaryMentionWarning(unresolvedMentions: string[]): string {
	if (unresolvedMentions.length === 0) {
		return "";
	}
	return `\nwarning: skipped unresolved summary mentions: ${unresolvedMentions.map((mention) => `@${mention}`).join(", ")}`;
}

function formatRelativeTime(timestamp: string): string {
	const deltaMs = Date.now() - new Date(timestamp).getTime();
	if (!Number.isFinite(deltaMs)) {
		return timestamp;
	}
	if (deltaMs < 60_000) {
		return `${Math.max(0, Math.floor(deltaMs / 1000))}s ago`;
	}
	if (deltaMs < 3_600_000) {
		return `${Math.floor(deltaMs / 60_000)}m ago`;
	}
	if (deltaMs < 86_400_000) {
		return `${Math.floor(deltaMs / 3_600_000)}h ago`;
	}
	return `${Math.floor(deltaMs / 86_400_000)}d ago`;
}

function formatElapsed(startedAt: string, endedAt?: string): string {
	const startMs = new Date(startedAt).getTime();
	const endMs = endedAt ? new Date(endedAt).getTime() : Date.now();
	const deltaMs = endMs - startMs;
	if (!Number.isFinite(deltaMs) || deltaMs < 0) {
		return "0s";
	}
	if (deltaMs < 60_000) {
		return `${Math.floor(deltaMs / 1000)}s`;
	}
	if (deltaMs < 3_600_000) {
		const minutes = Math.floor(deltaMs / 60_000);
		const seconds = Math.floor((deltaMs % 60_000) / 1000);
		return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	}
	if (deltaMs < 86_400_000) {
		const hours = Math.floor(deltaMs / 3_600_000);
		const minutes = Math.floor((deltaMs % 3_600_000) / 60_000);
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	const days = Math.floor(deltaMs / 86_400_000);
	const hours = Math.floor((deltaMs % 86_400_000) / 3_600_000);
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

async function selectSpawnAdapter(
	ctx: RoomExecutionContext,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
): Promise<RoomSpawnAdapter> {
	if (ctx.hasUI) {
		return adapters.pi;
	}

	const paseoAvailable = (await adapters.paseo.isAvailable?.(ctx)) ?? true;
	if (paseoAvailable) {
		return adapters.paseo;
	}

	return adapters.pi;
}

function getAdapterForBackend(backend: RoomMemberState["backend"], adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter }): RoomSpawnAdapter {
	return backend === "paseo" ? adapters.paseo : adapters.pi;
}

function getBatchMessageOptions(batchContext?: QueueBatchContext): {
	batchId?: string;
	silent?: true;
} {
	return {
		batchId: batchContext?.id,
		silent: batchContext?.silentOwnerDelivery ? true : undefined,
	};
}

function getBatchDirectedTaskMessageOptions(batchContext?: QueueBatchContext): {
	batchId?: string;
} {
	return {
		batchId: batchContext?.id,
	};
}

function toQueuedTaskHandle(message: RoomMessage): QueuedTaskHandle {
	return {
		messageId: message.id,
		seq: message.seq,
		targetName: message.to === "room" ? "room" : message.to,
		batchId: message.batchId ?? null,
	};
}

export async function resolveRoomAndSession(
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: { ownerName?: string; beforeDeliverMessage?: (context: { roomDir: string; memberName: string; message: RoomMessage }) => Promise<void> | void; beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void },
): Promise<{ sessionId: string; room: ActiveRoomContext | null; currentRole: string | null }> {
	const sessionId = getSessionId(ctx);
	const room = await resolveAccessibleRoom(pi, ctx, runtimeRoot, adapters, options.ownerName, options.beforeDeliverMessage, options.beforeOwnerHeartbeatWrite);
	const currentRole = getActiveRoom(sessionId)?.role ?? room?.role ?? null;
	if (room?.role === "owner") {
		await ensureOwnerInfrastructure({
			pi,
			runtimeRoot,
			sessionId,
			activeRoom: room,
			adapters,
			startPolling,
			startOwnerHeartbeat,
			beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
		});
	}
	return { sessionId, room, currentRole };
}

export async function queueCrewAdd(
	params: { name: string; type: string; model?: string; task?: string; transient?: boolean },
	options: QueueCrewAddOptions,
): Promise<QueuedCrewAddResult> {
	if (!isNonEmptyString(params.name) || !isNonEmptyString(params.type)) {
		throw new ValidationError("Spawn requires non-empty name and type.");
	}
	if (!isValidRoomMemberName(params.name)) {
		throw new ValidationError("Agent aliases must start with a letter or number and use only letters, numbers, hyphens, or underscores.");
	}
	if (options.activeRoom.role !== "owner") {
		throw new Error("Only the lead may call create, spawn, stop, or remove.");
	}
	if (params.transient === true && !isNonEmptyString(params.task)) {
		throw new ValidationError("transient requires a task parameter.");
	}

	const { activeRoom, sessionId, ctx, adapters, batchContext } = options;
	const transient = params.transient === true && isNonEmptyString(params.task);
	const log = createRoomLogger(activeRoom.roomDir, "room");
	const batchMessageOptions = getBatchMessageOptions(batchContext);
	const displayName = normalizeMemberDisplayName(params.name);
	const taskId = randomUUID();
	const bootstrapToken = randomUUID();
	const spawnNonce = randomUUID().replace(/-/g, "").slice(0, 6);

	const typedAgent = loadTypedRoomAgentDefinition(params.type, options.ctx.cwd);
	if (!typedAgent) {
		throw new ValidationError(`Agent type ${params.type} not found.`);
	}

	const effectiveModel = params.model?.trim() || typedAgent.model || ctx.currentModel;
	const effectiveThinkingLevel = typedAgent.thinking ?? ctx.currentThinkingLevel;
	const adapter = await selectSpawnAdapter(
		{ cwd: ctx.cwd, hasUI: ctx.hasUI, model: effectiveModel, sessionId },
		adapters,
	);
	let internalName: string;
	let memberLabel: string;
	try {
		const created = await createSpawningMember(activeRoom.roomDir, {
			displayName,
			type: typedAgent.type,
			backend: adapter.kind,
			taskId,
			spawnBatchId: batchContext?.id ?? null,
			transient: transient ? true : null,
			bootstrapToken,
		});
		internalName = created.member.name;
		memberLabel = formatMemberLabel(created.member);
	} catch (error) {
		if (error instanceof ValidationError || error instanceof MemberAlreadyExistsError) throw error;
		throw error;
	}

	const bootstrap = {
		version: 1 as const,
		roomId: activeRoom.roomId,
		roomDir: activeRoom.roomDir,
		memberName: internalName,
		memberType: typedAgent.type,
		ownerName: activeRoom.memberName,
		ownerSessionId: sessionId,
		token: bootstrapToken,
		spawnTaskId: taskId,
	};
	const roomDir = activeRoom.roomDir;
	const roomId = activeRoom.roomId;
	const ownerName = activeRoom.memberName;

	// Write initial task to board before spawning, so we can embed the message seq
	// in the agent's first prompt. This avoids a race where the task is delivered
	// as a separate prompt() call while the agent is still processing its initialPrompt.
	let initialTask: QueuedTaskHandle | undefined;
	let initialTaskBoard: { boardMessageSeq: number } | null = null;
	let initialTaskBoardError: string | null = null;
	let initialTaskUnresolvedMentions: string[] = [];
	if (params.task) {
		try {
			const truncated = params.task.length > 50
				? params.task.slice(0, 50) + "… — read context for task detail"
				: params.task;
			const annotated = annotateMultiDepHint(truncated, params.task);
			// Auto-inject dependency handling context when task contains {input:#N}
			const finalContent = hasInputDeps(params.task)
				? annotated.content + loadInputDepsContext()
				: annotated.content;
			const { validMentions: taskMentions, unresolvedMentions } = await resolveSummaryMentions(
				activeRoom.roomDir,
				extractSummaryMentions(annotated.summary, activeRoom.memberName),
				activeRoom.memberName,
			);
			initialTaskUnresolvedMentions = unresolvedMentions;
			const taskMsg = await appendDirectedTaskMessage(activeRoom.roomDir, {
				from: activeRoom.memberName,
				to: internalName,
				mentions: taskMentions.length > 0 ? taskMentions : undefined,
				...getBatchDirectedTaskMessageOptions(batchContext),
				replyTo: null,
				summary: annotated.summary,
				content: finalContent,
			});
			initialTask = toQueuedTaskHandle(taskMsg);
			initialTaskBoard = { boardMessageSeq: taskMsg.seq };
			registerDeps(roomDir, taskMsg.seq, finalContent, internalName);
			checkAndNotifyIfReady(roomDir, taskMsg.seq, finalContent)
				.catch((err) => { consoleError("tools", "dep check failed (spawn)", { roomDir, taskSeq: taskMsg.seq, error: String(err) }); });
		} catch (error) {
			initialTaskBoardError = error instanceof Error ? error.message : String(error);
			log.error("initial task board write failed, spawning without embedded task", {
				memberName: internalName,
				error: initialTaskBoardError,
			});
		}
	}

	// ── Async spawn: fire-and-forget, tracked for shutdown ──
	const spawnWork = (async () => {
		try {
			const crewMessageToolNames = ["crew_tell", "crew_messages", "crew_reply", "crew_read", "crew_who", "crew_tasks"];

			// ── Worktree isolation: create detached worktree for the agent ──
			let effectiveCwd = ctx.cwd;
			let worktreeInfo: { path: string; branch: string } | undefined;
			if (typedAgent.worktree === true) {
				try {
					worktreeInfo = await createWorktree(internalName, ctx.cwd, spawnNonce);
					if (worktreeInfo) {
						effectiveCwd = worktreeInfo.path;
						await updateRoomMemberState(roomDir, internalName, {
							worktree: { path: worktreeInfo.path, branch: worktreeInfo.branch },
						}).catch(() => {});
					}
				} catch {
					// Graceful degradation: agent runs in normal cwd
				}
			}

			const spawned = await serializeRoomSpawn(roomDir, () => adapter.spawn({
				roomDir,
				roomId,
				memberName: internalName,
				memberType: typedAgent.type,
				parentSessionId: sessionId,
				cwd: effectiveCwd,
				systemPrompt: buildRoomMemberSystemPrompt(bootstrap, typedAgent, memberLabel),
				memberLabel,
				model: effectiveModel,
				thinkingLevel: effectiveThinkingLevel,
				tools: typedAgent.tools
					? [...typedAgent.tools, ...crewMessageToolNames]
					: typedAgent.tools,
				...(initialTaskBoard
					? { initialTask: { task: params.task!, boardMessageSeq: initialTaskBoard.boardMessageSeq } }
					: {}),
			}));

			const handleTimedOutExternalLateSuccess = async (): Promise<"cleanup-complete" | "retry-finalize"> => {
				const lateCleanupDecision = await withRoomMutationLock(roomDir, async () => {
					const currentMember = await loadRoomMemberState(roomDir, internalName).catch(() => null);
					const currentJob = await readSpawnJob(roomDir, taskId).catch(() => null);
					if (
						currentJob?.state !== "timed_out_pending_external_resolution"
						|| !currentMember
						|| currentMember.state === "removed"
						|| currentMember.spawnTaskId !== taskId
					) {
						return { kind: "recheck" as const };
					}
					if (currentMember.sessionId || currentMember.bootstrapClaimedAt) {
						return { kind: "finalize" as const };
					}
					const updatedAt = new Date().toISOString();
					await transitionSpawnJobRecord(roomDir, currentJob, {
						state: "cancelled",
						runtimeId: spawned.runtimeId,
						updatedAt,
						error: "Late spawn success cleanup pending after external-create timeout.",
					});
					await writeRoomMemberState(roomDir, {
						...currentMember,
						state: "stopping",
						runtimeId: spawned.runtimeId,
						sessionId: null,
						spawnTaskId: null,
						spawnBatchId: null,
						currentTask: null,
						currentTaskMessageId: null,
						lastError: "Late spawn success cleanup pending after external-create timeout.",
						updatedAt,
					});
					return { kind: "cleanup" as const };
				});
				if (lateCleanupDecision.kind !== "cleanup") {
					return "retry-finalize";
				}

				const lateMember: RoomMemberState = {
					name: internalName,
					displayName,
					type: typedAgent.type,
					backend: spawned.backend,
					runtimeId: spawned.runtimeId,
					state: "stopping",
					spawnTaskId: null,
					spawnBatchId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
				};
				try {
					await getAdapterForBackend(spawned.backend, adapters).remove?.(lateMember);
					await withRoomMutationLock(roomDir, async () => {
						const currentMember = await loadRoomMemberState(roomDir, internalName).catch(() => null);
						const currentJob = await readSpawnJob(roomDir, taskId).catch(() => null);
						if (currentJob?.state === "cancelled") {
							await transitionSpawnJobRecord(roomDir, currentJob, {
								state: "cancelled",
								runtimeId: spawned.runtimeId,
								updatedAt: new Date().toISOString(),
								error: "Late spawn success cleaned up after external-create timeout.",
							});
						}
						if (currentMember && currentMember.state === "stopping" && currentMember.runtimeId === spawned.runtimeId) {
							await writeRoomMemberState(roomDir, {
								...currentMember,
								state: "error",
								runtimeId: null,
								sessionId: null,
								spawnTaskId: null,
								spawnBatchId: null,
								currentTask: null,
								currentTaskMessageId: null,
								lastError: "Late spawn success cleaned up after external-create timeout.",
								updatedAt: new Date().toISOString(),
							});
						}
					});
					log.info("late spawn success cleaned up", {
						memberName: internalName,
						taskId,
						runtimeId: spawned.runtimeId,
						backend: spawned.backend,
					});
				} catch (error) {
					await withRoomMutationLock(roomDir, async () => {
						const currentMember = await loadRoomMemberState(roomDir, internalName).catch(() => null);
						const currentJob = await readSpawnJob(roomDir, taskId).catch(() => null);
						if (currentJob?.state === "cancelled") {
							await transitionSpawnJobRecord(roomDir, currentJob, {
								state: "cancelled",
								runtimeId: spawned.runtimeId,
								updatedAt: new Date().toISOString(),
								error: `Late spawn success cleanup failed: ${String(error)}`,
							});
						}
						if (currentMember && currentMember.runtimeId === spawned.runtimeId) {
							await writeRoomMemberState(roomDir, {
								...currentMember,
								state: "error",
								runtimeId: spawned.runtimeId,
								sessionId: null,
								spawnTaskId: null,
								spawnBatchId: null,
								currentTask: null,
								currentTaskMessageId: null,
								lastError: `Late spawn success cleanup failed: ${String(error)}`,
								updatedAt: new Date().toISOString(),
							});
						}
					}).catch(() => {});
					log.error("late spawn success cleanup failed", {
						memberName: internalName,
						taskId,
						runtimeId: spawned.runtimeId,
						error: String(error),
					});
				}
				return "cleanup-complete";
			};

			// Finalize spawn record under the owner authority boundary.
			let finalized: { cancelled: true; reason: string } | { cancelled: false; completed: boolean };
			try {
				if (spawned.backend === "paseo") {
					const jobBeforeFinalize = await readSpawnJob(roomDir, taskId).catch(() => null);
					if (jobBeforeFinalize?.state === "timed_out_pending_external_resolution" && await handleTimedOutExternalLateSuccess() === "cleanup-complete") {
						return;
					}
					try {
						const finalizedRuntime = await finalizeMemberRuntime({
							roomDir,
							memberName: internalName,
							taskId,
							runtimeId: spawned.runtimeId,
							backend: spawned.backend,
						});
						finalized = {
							cancelled: false,
							completed: finalizedRuntime.job.state === "completed",
						};
					} catch (error) {
						if (error instanceof SpawnFailedError && error.message.includes("requires cleanup")) {
							if (await handleTimedOutExternalLateSuccess() === "cleanup-complete") {
								return;
							}
							const finalizedRuntime = await finalizeMemberRuntime({
								roomDir,
								memberName: internalName,
								taskId,
								runtimeId: spawned.runtimeId,
								backend: spawned.backend,
							});
							finalized = {
								cancelled: false,
								completed: finalizedRuntime.job.state === "completed",
							};
						} else if (error instanceof MemberNotFoundError || error instanceof SpawnFailedError) {
							finalized = { cancelled: true, reason: error.message };
						} else {
							throw error;
						}
					}
			} else {
					finalized = await withRoomMutationLock(roomDir, async () => {
						const currentMember = await loadRoomMemberState(roomDir, internalName).catch(() => null);
						const currentJob = await readSpawnJob(roomDir, taskId).catch(() => null);
						if (!currentMember || currentMember.state === "removed" || currentJob?.state === "cancelled" || currentJob?.state === "failed") {
							return {
								cancelled: true,
								reason: currentJob?.state ?? (currentMember ? currentMember.state : "removed"),
							};
						}

						await writeRoomMemberState(roomDir, {
							...currentMember,
							backend: spawned.backend,
							runtimeId: spawned.runtimeId,
							updatedAt: new Date().toISOString(),
						});
						if (currentJob) {
							await transitionSpawnJobRecord(roomDir, currentJob, {
								state: currentJob.state,
								backend: spawned.backend,
								runtimeId: spawned.runtimeId,
								updatedAt: new Date().toISOString(),
								error: null,
							});
						}

						return { cancelled: false as const, completed: true };
					});
				}
			} catch (error) {
				if (!(error instanceof Error) || !error.message.includes("Room metadata not found")) {
					throw error;
				}
				finalized = { cancelled: true, reason: "removed" };
			}

			if (finalized.cancelled) {
				const lateMember: RoomMemberState = {
					name: internalName,
					displayName,
					type: typedAgent.type,
					backend: spawned.backend,
					runtimeId: spawned.runtimeId,
					state: "spawning",
					spawnTaskId: taskId,
					spawnBatchId: batchContext?.id ?? null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
				};
				try {
					await getAdapterForBackend(spawned.backend, adapters).remove?.(lateMember);
				} catch {
					// best-effort cleanup
				}
				if (!transient) {
					appendMessage(roomDir, {
						from: "system",
						to: "room",
						...batchMessageOptions,
						replyTo: null,
						kind: "error",
						summary: `Spawn cancelled: ${memberLabel} (${finalized.reason})`,
						broadcast: false,
					}).catch(() => {});
				} else {
					throw new SpawnFailedError(internalName, `Spawn cancelled: ${finalized.reason}`);
				}
				return;
			}
			const completed = "completed" in finalized ? finalized.completed : false;

			log.info("spawn succeeded", {
				memberName: internalName,
				taskId,
				agentId: spawned.runtimeId,
				backend: spawned.backend,
				model: effectiveModel,
				completed,
			});
			// Notify owner via board (skip for transient agents)
			if (!transient) {
				appendMessage(roomDir, {
					from: "system",
					to: "room",
					...batchMessageOptions,
					replyTo: null,
					kind: "info",
					summary: completed
						? `Agent ${memberLabel} ready (${spawned.runtimeId})`
						: `Agent ${memberLabel} spawned externally; awaiting bootstrap claim`,
					broadcast: true,
				}).catch(() => {});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error("spawn failed", { memberName: internalName, taskId, error: message });

			// Mark spawn job failed
			const stagedFailure = await withRoomMutationLock(roomDir, async () => {
				const current = await loadRoomMemberState(roomDir, internalName).catch(() => null);
				if (!current || current.state === "removed") {
					return { member: current, skip: true };
				}
				if (current.spawnTaskId !== taskId) {
					return { member: current, skip: true };
				}
				const job = await readSpawnJob(roomDir, taskId).catch(() => null);
				if (job?.state === "cancelled") {
					return { member: current, skip: true };
				}
				if (current.spawnTaskId) {
					await transitionSpawnJobRecord(roomDir, job ?? {
						taskId: current.spawnTaskId,
						memberName: current.name,
						backend: current.backend,
						runtimeId: current.runtimeId,
						bootstrapToken: current.bootstrapToken ?? null,
						createdAt: current.joinedAt,
						updatedAt: current.updatedAt,
						error: null,
					}, {
						state: "failed",
						updatedAt: new Date().toISOString(),
						error: message,
					});
				}
				return { member: current, skip: false };
			});

			if (stagedFailure.skip) {
				log.info("spawn failure ignored after state handoff", {
					memberName: internalName,
					taskId,
				});
				return;
			}

			const existingMember = stagedFailure.member;
			if (!existingMember) {
				return;
			}
			if (existingMember.runtimeId) {
					const cleanupAdapter = getAdapterForBackend(existingMember.backend, adapters);
					let cleanupOk = false;
					try {
						if (cleanupAdapter.remove) {
							await cleanupAdapter.remove(existingMember);
							cleanupOk = true;
						} else if (cleanupAdapter.stop) {
							await cleanupAdapter.stop(existingMember);
							cleanupOk = true;
						}
					} catch { /* best-effort */ }

					if (cleanupOk) {
						await withRoomMutationLock(roomDir, async () => {
							const cur = await loadRoomMemberState(roomDir, internalName).catch(() => null);
							if (!cur || cur.state === "removed" || cur.spawnTaskId !== taskId) return;
							const job = await readSpawnJob(roomDir, taskId).catch(() => null);
							if (job?.state === "cancelled") return;
							const dlq = await getLastDeliverableMessageSeq(roomDir, cur.name).catch(() => cur.lastSeenSeq);
							await writeRoomMemberState(roomDir, {
								...cur,
								state: "error",
								lastError: message,
								currentTask: null,
								currentTaskMessageId: null,
								spawnTaskId: null,
								spawnBatchId: null,
								lastSeenSeq: Math.max(cur.lastSeenSeq, dlq),
								runtimeId: null,
								sessionId: null,
								updatedAt: new Date().toISOString(),
							});
						}).catch((err) => log.error("spawn cleanup write failed", { memberName: internalName, error: String(err) }));
					} else {
						await withRoomMutationLock(roomDir, async () => {
							const cur = await loadRoomMemberState(roomDir, internalName).catch(() => null);
							if (!cur || cur.state === "removed" || cur.spawnTaskId !== taskId) return;
							const job = await readSpawnJob(roomDir, taskId).catch(() => null);
							if (job?.state === "cancelled") return;
							await writeRoomMemberState(roomDir, {
								...cur,
								state: "error",
								lastError: message,
								currentTask: null,
								currentTaskMessageId: null,
								spawnTaskId: null,
								spawnBatchId: null,
								updatedAt: new Date().toISOString(),
							});
						}).catch((err) => log.error("spawn fallback write failed", { memberName: internalName, error: String(err) }));
					}
				} else {
					await withRoomMutationLock(roomDir, async () => {
						const cur = await loadRoomMemberState(roomDir, internalName).catch(() => null);
						if (!cur || cur.state === "removed" || cur.spawnTaskId !== taskId) return;
						const job = await readSpawnJob(roomDir, taskId).catch(() => null);
						if (job?.state === "cancelled") return;
						const dlq = await getLastDeliverableMessageSeq(roomDir, cur.name).catch(() => cur.lastSeenSeq);
						if (
							cur.currentTaskMessageId ||
							cur.currentTask ||
							dlq > cur.lastSeenSeq ||
							cur.lastSeenSeq > 0
						) {
							await writeRoomMemberState(roomDir, {
								...cur,
								state: "error",
								lastError: message,
								currentTask: null,
								currentTaskMessageId: null,
								spawnTaskId: null,
								spawnBatchId: null,
								lastSeenSeq: Math.max(cur.lastSeenSeq, dlq),
								runtimeId: null,
								sessionId: null,
								updatedAt: new Date().toISOString(),
							});
						} else {
							await writeRoomMemberState(roomDir, {
								...cur,
								state: "error",
								lastError: message,
								currentTask: null,
								currentTaskMessageId: null,
								spawnTaskId: null,
								spawnBatchId: null,
								runtimeId: null,
								sessionId: null,
								updatedAt: new Date().toISOString(),
							});
						}
					}).catch((err) => log.error("spawn cleanup write failed", { memberName: internalName, error: String(err) }));
				}

			// Notify owner via board (skip for transient agents)
			if (!transient) {
				appendMessage(roomDir, {
					from: "system",
					to: "room",
					...batchMessageOptions,
					replyTo: null,
					kind: "error",
					summary: `Spawn failed: ${memberLabel}`,
					broadcast: false,
				}).catch(() => {});
			} else {
				throw error;
			}
		}
	})();

	if (transient) {
		await spawnWork;
	} else {
		trackActiveRoomTask(sessionId, spawnWork);
	}

	return {
		memberName: internalName,
		memberLabel,
		taskId,
		backend: adapter.kind,
		transient,
		initialTask,
		initialTaskBoardError,
		unresolvedMentions: initialTaskUnresolvedMentions,
	};
}

export async function executeCrewAdd(
	rawParams: unknown,
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: { ownerName: string; beforeDeliverMessage?: (context: { roomDir: string; memberName: string; message: RoomMessage }) => Promise<void> | void; beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	const { sessionId, room } = await resolveRoomAndSession(pi, ctx, runtimeRoot, adapters, options);
	const activeRoom = room ?? getActiveRoom(sessionId);
	if (!activeRoom) return ownerRoomUnavailableError();
	try {
		const queued = await queueCrewAdd(rawParams as { name: string; type: string; model?: string; task?: string; transient?: boolean }, {
			activeRoom,
			sessionId,
			ctx,
			adapters,
		});
		return textResult(
			queued.transient
				? `Dispatched ${queued.memberLabel} (${(rawParams as { type: string }).type}) via ${queued.backend}.`
				: `Spawn ${queued.taskId} queued for ${queued.memberLabel} (${(rawParams as { type: string }).type}) via ${queued.backend}. Target: ${queued.memberLabel}.` +
				(queued.initialTaskBoardError ? ` (initial task will be delivered later: ${queued.initialTaskBoardError})` : "") +
				formatSummaryMentionWarning(queued.unresolvedMentions),
		);
	} catch (error) {
		return textResult(error instanceof Error ? error.message : String(error), true);
	}
}

export async function executeCrewStop(
	rawParams: unknown,
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: { ownerName: string; beforeDeliverMessage?: (context: { roomDir: string; memberName: string; message: RoomMessage }) => Promise<void> | void; beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	const params = rawParams as { name: string };

	if (!isNonEmptyString(params.name)) {
		return textResult("Stop requires a non-empty member target.", true);
	}
	if (!isValidMemberTargetInput(params.name)) {
		return textResult("Member targets must be a valid alias, internal id, or label like alias#1234.", true);
	}

	const { sessionId, room } = await resolveRoomAndSession(pi, ctx, runtimeRoot, adapters, options);
	const activeRoom = room ?? getActiveRoom(sessionId);
	if (!activeRoom) return ownerRoomUnavailableError();
	if (activeRoom.role !== "owner") return ownerOnlyError();

	let resolvedStopTarget: RoomMemberState;
	try {
		resolvedStopTarget = await resolveMemberTarget(activeRoom.roomDir, params.name);
	} catch (error) {
		return textResult(resolveTargetErrorText(error, params.name), true);
	}
	const stopName = resolvedStopTarget.name;
	const stopLabel = formatMemberLabel(resolvedStopTarget);
	if (stopName === activeRoom.memberName) {
		return textResult("The room owner cannot stop itself; end the owner session to close the room.", true);
	}

	const log = createRoomLogger(activeRoom.roomDir, "room");
	let pendingCancelledTask: { taskMessageId: string; taskSummary: string } | null = null;

	const stagedStop = await withRoomMutationLock(activeRoom.roomDir, async () => {
		const current = await loadRoomMemberState(activeRoom.roomDir, stopName).catch(() => null);
		if (!current || current.state === "removed") {
			return { kind: "missing" as const };
		}
		// Capture currentTask info before next nullifies them
		if (current.currentTaskMessageId && current.currentTask) {
			pendingCancelledTask = {
				taskMessageId: current.currentTaskMessageId,
				taskSummary: current.currentTask,
			};
		} else if (!current.currentTaskMessageId && current.state === "running") {
			log.warn("stop on running member with no currentTaskMessageId", {
				memberName: current.name,
			});
		}
		const protectedSeq = await getLastDeliverableMessageSeq(activeRoom.roomDir, current.name).catch(() => current.lastSeenSeq);
		if (current.spawnTaskId) {
			const job = await readSpawnJob(activeRoom.roomDir, current.spawnTaskId).catch(() => null);
			if (job && job.state !== "completed" && job.state !== "cancelled" && job.state !== "failed") {
				await transitionSpawnJobRecord(activeRoom.roomDir, job, {
					state: "cancelled",
					updatedAt: new Date().toISOString(),
					error: null,
				});
			}
		}
		const next = {
			...current,
			state: "stopping" as const,
			spawnBatchId: null,
			currentTask: null,
			currentTaskMessageId: null,
			chatBusy: false,
			todoProgress: null,
			lastSeenSeq: Math.max(current.lastSeenSeq, protectedSeq),
			updatedAt: new Date().toISOString(),
		};
		await writeRoomMemberState(activeRoom.roomDir, next);
		return { kind: "ok" as const, member: next };
	});
	if (stagedStop.kind === "missing") return textResult(`Member ${params.name} not found.`, true);
	const member = stagedStop.member;
	const adapter = getAdapterForBackend(member.backend, adapters);
	let stopFailure: string | null = null;
	let stopDegraded = false;
	if (member.runtimeId) {
		try {
			if (member.spawnTaskId && adapter.remove) {
				await adapter.remove(member);
			} else {
				await adapter.stop?.(member);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Paseo daemon may not send cancel_agent_response when agent already
			// cleaned up, causing a 15s timeout. Treat this as a degraded stop
			// rather than a hard failure — the agent runtime is likely gone.
			if (message.includes("Timeout waiting for message")) {
				stopDegraded = true;
				log.warn("stop rpc timed out, treating as degraded stop", {
					memberName: member.name,
					runtimeId: member.runtimeId,
				});
			} else {
				stopFailure = message;
			}
		}
	}
	if (stopFailure) {
		await withRoomMutationLock(activeRoom.roomDir, async () => {
			const current = await loadRoomMemberState(activeRoom.roomDir, member.name).catch(() => null);
			if (!current || current.state === "removed") return;
			await writeRoomMemberState(activeRoom.roomDir, {
				...current,
				state: "error",
				currentTask: null,
				currentTaskMessageId: null,
				spawnTaskId: null,
				spawnBatchId: null,
				sessionId: null,
				lastError: stopFailure,
				updatedAt: new Date().toISOString(),
			});
		}).catch((err) => log.error("stop failure write failed", { memberName: member.name, error: String(err) }));
		return textResult(`Stop failed: ${stopFailure}`, true);
	}
	if (stopDegraded) {
		await withRoomMutationLock(activeRoom.roomDir, async () => {
			const current = await loadRoomMemberState(activeRoom.roomDir, member.name).catch(() => null);
			if (!current || current.state === "removed") return;
			// Clear runtimeId so finalizedStop sees it as needing respawn
			await writeRoomMemberState(activeRoom.roomDir, {
				...current,
				runtimeId: null,
				spawnBatchId: null,
				sessionId: null,
				updatedAt: new Date().toISOString(),
			});
		}).catch((err) => log.error("stop degraded runtimeId cleanup failed", { memberName: member.name, error: String(err) }));
	}
	const shouldArchiveStoppedWorktree = Boolean(member.worktree?.path)
		&& (Boolean(member.spawnTaskId) || !member.runtimeId || adapter.stopKeepsRuntime === false || stopDegraded);
	if (shouldArchiveStoppedWorktree) {
		try {
			await archiveMemberWorktreeCleanup(activeRoom.roomDir, ctx.cwd, member);
		} catch {
			// Best-effort: stop should still complete even if archival cleanup fails.
		}
	}

	if (pendingCancelledTask) {
			await appendTerminalTaskReplyAndNotify({
				roomDir: activeRoom.roomDir,
				taskMessageId: pendingCancelledTask.taskMessageId,
				from: activeRoom.memberName,
				to: stopName,
				kind: "cancelled",
				summary: `Task cancelled: ${pendingCancelledTask.taskSummary}`,
				logContext: { memberName: stopName, source: "crew_stop" },
			}).catch((err) => log.error("failed to write cancelled message", { memberName: stopName, error: String(err) }));
		}
	const finalizedStop = await withRoomMutationLock(activeRoom.roomDir, async () => {
		const current = await loadRoomMemberState(activeRoom.roomDir, member.name).catch(() => null);
		if (!current || current.state === "removed") return null;
		// After stopDegraded, current.runtimeId may have been cleared;
		// finalizedStop should use the latest state as authoritative.
		const protectedSeq = await getLastDeliverableMessageSeq(activeRoom.roomDir, current.name).catch(() => current.lastSeenSeq);

		// Transient members: cancel = remove
		if (current.transient) {
			const removed: RoomMemberState = {
				...current,
				state: "removed",
				currentTask: null,
				currentTaskMessageId: null,
				todoProgress: null,
				spawnTaskId: null,
				spawnBatchId: null,
				chatBusy: false,
				lastSeenSeq: Math.max(current.lastSeenSeq, protectedSeq),
				runtimeId: null,
				sessionId: null,
				lastError: "Task cancelled (transient auto-removal).",
				updatedAt: new Date().toISOString(),
			};
			await writeRoomMemberState(activeRoom.roomDir, removed);
			return { memberName: current.name, requiresRespawn: false, transientRemoved: true };
		}

		const stopRequiresRespawn = Boolean(current.spawnTaskId) || !current.runtimeId || adapter.stopKeepsRuntime === false;
		if (stopRequiresRespawn) {
			const next = {
				...current,
				state: "error" as const,
				currentTask: null,
				currentTaskMessageId: null,
				todoProgress: null,
				spawnTaskId: null,
				spawnBatchId: null,
				chatBusy: false,
				lastSeenSeq: Math.max(current.lastSeenSeq, protectedSeq),
				runtimeId: null,
				sessionId: null,
				lastError: "Stop ended this runtime. Remove this member before reusing its alias, or spawn a different alias.",
				updatedAt: new Date().toISOString(),
			};
			await writeRoomMemberState(activeRoom.roomDir, next);
			return { memberName: current.name, requiresRespawn: true };
		}
		const next = {
			...current,
			state: "idle" as const,
			currentTask: null,
			currentTaskMessageId: null,
			todoProgress: null,
			spawnTaskId: null,
			spawnBatchId: null,
			chatBusy: false,
			lastSeenSeq: Math.max(current.lastSeenSeq, protectedSeq),
			updatedAt: new Date().toISOString(),
		};
		await writeRoomMemberState(activeRoom.roomDir, next);
		return { memberName: current.name, requiresRespawn: false };
	});

	// Write owner confirmation message
	if (finalizedStop?.transientRemoved) {
		// Transient cleanup: worktree archival + board notification
		if (member.worktree?.path) {
			await archiveMemberWorktreeCleanup(activeRoom.roomDir, ctx.cwd, member).catch(() => {});
		}
		await appendMessage(activeRoom.roomDir, {
			from: "system",
			to: "room",
			replyTo: null,
			kind: "info",
			summary: `Transient agent ${stopLabel} was cancelled and removed.`,
			broadcast: false,
		}).catch((err) => log.error("failed to write transient removal notification", { memberName: member.name, error: String(err) }));
	} else {
		await appendMessage(activeRoom.roomDir, {
			from: "system",
			to: "room",
			replyTo: null,
			kind: "info",
			summary: `Agent ${stopLabel} has been stopped.`,
			broadcast: false,
		}).catch((err) => log.error("failed to write stop confirmation", { memberName: member.name, error: String(err) }));
	}

	if (!finalizedStop) {
		return textResult(`Stopped member ${stopLabel}.`);
	}
	if (finalizedStop.transientRemoved) {
		return textResult(`Cancelled and removed transient agent ${stopLabel}.`);
	}
	if (finalizedStop.requiresRespawn) {
		return textResult(`Stopped member ${stopLabel}. It cannot receive new tasks again; remove it before reusing this alias, or spawn a different alias.`);
	}
	return textResult(`Stopped member ${stopLabel}.`);
}

export async function executeCrewRemove(
	rawParams: unknown,
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: { ownerName: string; beforeDeliverMessage?: (context: { roomDir: string; memberName: string; message: RoomMessage }) => Promise<void> | void; beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	const params = rawParams as { name: string };

	if (!isNonEmptyString(params.name)) {
		return textResult("Remove requires a non-empty member target.", true);
	}
	if (!isValidMemberTargetInput(params.name)) {
		return textResult("Member targets must be a valid alias, internal id, or label like alias#1234.", true);
	}

	const { sessionId, room } = await resolveRoomAndSession(pi, ctx, runtimeRoot, adapters, options);
	const activeRoom = room ?? getActiveRoom(sessionId);
	if (!activeRoom) return ownerRoomUnavailableError();
	if (activeRoom.role !== "owner") return ownerOnlyError();

	let resolvedRemoveTarget: RoomMemberState;
	try {
		resolvedRemoveTarget = await resolveMemberTarget(activeRoom.roomDir, params.name);
	} catch (error) {
		return textResult(resolveTargetErrorText(error, params.name), true);
	}
	const removeName = resolvedRemoveTarget.name;
	const removeLabel = formatMemberLabel(resolvedRemoveTarget);
	if (removeName === activeRoom.memberName) {
		return textResult("The room owner cannot remove itself; end the owner session to close the room.", true);
	}

	const log = createRoomLogger(activeRoom.roomDir, "room");
	let pendingCancelledTask: { taskMessageId: string; taskSummary: string } | null = null;
	const stagedRemove = await withRoomMutationLock(activeRoom.roomDir, async () => {
		const current = await loadRoomMemberState(activeRoom.roomDir, removeName).catch(() => null);
		if (!current) {
			return { kind: "missing" as const };
		}
		if (current.currentTaskMessageId && current.currentTask) {
			pendingCancelledTask = {
				taskMessageId: current.currentTaskMessageId,
				taskSummary: current.currentTask,
			};
		} else if (!current.currentTaskMessageId && current.state === "running") {
			log.warn("remove on running member with no currentTaskMessageId", {
				memberName: current.name,
			});
		}
		const protectedSeq = await getLastDeliverableMessageSeq(activeRoom.roomDir, current.name).catch(() => current.lastSeenSeq);
		if (current.spawnTaskId) {
			const job = await readSpawnJob(activeRoom.roomDir, current.spawnTaskId).catch(() => null);
			if (job && job.state !== "completed" && job.state !== "cancelled" && job.state !== "failed") {
				await transitionSpawnJobRecord(activeRoom.roomDir, job, {
					state: "cancelled",
					updatedAt: new Date().toISOString(),
					error: null,
				});
			}
		}
		const next = {
			...current,
			state: "stopping" as const,
			spawnBatchId: null,
			currentTask: null,
			currentTaskMessageId: null,
			todoProgress: null,
			lastSeenSeq: Math.max(current.lastSeenSeq, protectedSeq),
			updatedAt: new Date().toISOString(),
		};
		await writeRoomMemberState(activeRoom.roomDir, next);
		return { kind: "ok" as const, member: next };
	});
	if (stagedRemove.kind === "missing") return textResult(`Member ${params.name} not found.`, true);
	const member = stagedRemove.member;
	if (member.runtimeId) {
		try {
			await getAdapterForBackend(member.backend, adapters).remove?.(member);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await withRoomMutationLock(activeRoom.roomDir, async () => {
				const current = await loadRoomMemberState(activeRoom.roomDir, member.name).catch(() => null);
				if (!current || current.state === "removed") return;
				await writeRoomMemberState(activeRoom.roomDir, {
					...current,
					state: "error",
					currentTask: null,
					currentTaskMessageId: null,
					todoProgress: null,
					spawnTaskId: null,
					spawnBatchId: null,
					sessionId: null,
					lastError: message,
					updatedAt: new Date().toISOString(),
				});
			}).catch((err) => log.error("remove failure write failed", { memberName: member.name, error: String(err) }));
			return textResult(`Remove failed: ${message}`, true);
		}
	}

	if (pendingCancelledTask) {
		await appendTerminalTaskReplyAndNotify({
			roomDir: activeRoom.roomDir,
			taskMessageId: pendingCancelledTask.taskMessageId,
			from: activeRoom.memberName,
			to: removeName,
			kind: "cancelled",
			summary: `Task cancelled: ${pendingCancelledTask.taskSummary}`,
			logContext: { memberName: removeName, source: "crew_remove" },
		}).catch((err) => log.error("failed to write cancelled message during remove", { memberName: removeName, error: String(err) }));
	}

	// ── Worktree cleanup before removal ──
	if (member.worktree?.path) {
		try {
			await archiveMemberWorktreeCleanup(activeRoom.roomDir, ctx.cwd, member);
		} catch {
			// Best-effort: worktree cleanup failure must not block remove
		}
	}

	const finalizedRemove = await withRoomMutationLock(activeRoom.roomDir, async () => {
		const current = await loadRoomMemberState(activeRoom.roomDir, member.name).catch(() => null);
		if (!current) return member.name;
		const protectedSeq = await getLastDeliverableMessageSeq(activeRoom.roomDir, current.name).catch(() => current.lastSeenSeq);
		await writeRoomMemberState(activeRoom.roomDir, {
			...current,
			state: "removed",
			currentTask: null,
			currentTaskMessageId: null,
			todoProgress: null,
			spawnTaskId: null,
			spawnBatchId: null,
			lastSeenSeq: Math.max(current.lastSeenSeq, protectedSeq),
			runtimeId: null,
			sessionId: null,
			updatedAt: new Date().toISOString(),
		});
		return current.name;
	});
	return textResult(`Removed member ${removeLabel}.`);
}

/**
 * Derive merge readiness from the member's current snapshot state and git reality.
 *
 * Returns true when the member has a fixed snapshot commit that exists in the
 * repository and has not yet been recorded as merged (lastMergedOid).
 *
 * Rules:
 * - If no snapshot OID is available → false
 * - pendingTerminalReply.snapshotOid takes priority over lastSnapshotOid
 * - If effective OID === lastMergedOid → false (already merged / idempotent)
 * - If the commit OID does not exist in the repository → false
 */
export async function deriveMergeReadiness(member: RoomMemberState, cwd: string): Promise<boolean> {
	const effectiveOid =
		member.pendingTerminalReply?.snapshotOid
		?? member.lastSnapshotOid
		?? member.worktreeResult?.snapshotOid
		?? null;
	if (!effectiveOid) return false;
	if (member.lastMergedOid && effectiveOid === member.lastMergedOid) return false;
	try {
		await git(["cat-file", "-e", `${effectiveOid}^{commit}`], cwd, 5_000);
		return true;
	} catch {
		return false;
	}
}

export async function executeCrewMerge(
	rawParams: unknown,
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: { ownerName: string; beforeDeliverMessage?: (context: { roomDir: string; memberName: string; message: RoomMessage }) => Promise<void> | void; beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	const params = rawParams as { name: string; strategy?: "merge" | "rebase" | "ff-only"; deleteBranchAfterMerge?: boolean; commitMessage?: string };

	if (!isNonEmptyString(params.name)) {
		return textResult("Merge requires a non-empty member target.", true);
	}
	if (!isValidMemberTargetInput(params.name)) {
		return textResult("Member targets must be a valid alias, internal id, or label like alias#1234.", true);
	}

	const { sessionId, room } = await resolveRoomAndSession(pi, ctx, runtimeRoot, adapters, options);
	const activeRoom = room ?? getActiveRoom(sessionId);
	if (!activeRoom) return ownerRoomUnavailableError();
	if (activeRoom.role !== "owner") return ownerOnlyError();

	const log = createRoomLogger(activeRoom.roomDir, "room");
	const strategy = params.strategy ?? "merge";
	const deleteBranchAfterMerge = params.deleteBranchAfterMerge ?? false;
	let resolvedMergeTarget: RoomMemberState;
	try {
		resolvedMergeTarget = await resolveMemberTargetForMerge(activeRoom.roomDir, params.name);
	} catch (error) {
		return textResult(resolveTargetErrorText(error, params.name), true);
	}
	const mergeLabel = formatMemberLabel(resolvedMergeTarget);

	const member = await loadRoomMemberState(activeRoom.roomDir, resolvedMergeTarget.name).catch(() => null);
	if (!member) {
		return textResult(`Member ${params.name} not found.`, true);
	}

	// State gates: reject unstable / busy members
	const unstableStates = ["running", "spawning", "stopping"] as const;
	if ((unstableStates as readonly string[]).includes(member.state)) {
		return textResult(
			`Cannot merge ${mergeLabel}: member is currently ${member.state}. Wait for the member to reach a stable state (idle or error) before merging.`,
			true,
		);
	}
	const cwd = ctx.cwd;

	// Fixed OID priority: pendingTerminalReply.snapshotOid → lastSnapshotOid → archived snapshotOid
	const snapshotOid: string | null =
		member.pendingTerminalReply?.snapshotOid ??
		member.lastSnapshotOid ??
		member.worktreeResult?.snapshotOid ??
		null;

	// Gap 2: readiness gate — reject when there is no unmerged snapshot
	// (still allows the idempotent repair path when snapshot is already ancestor of HEAD,
	//  which deriveMergeReadiness returns true for since lastMergedOid wouldn't match)
	if (snapshotOid) {
		const ready = await deriveMergeReadiness(member, cwd);
		if (!ready) {
			if (member.lastMergedOid && snapshotOid === member.lastMergedOid) {
				return textResult(
					`No unmerged snapshot for ${mergeLabel}: snapshot ${snapshotOid.slice(0, 12)} has already been merged (lastMergedOid matches). Nothing to do.`,
					true,
				);
			}
			return textResult(
				`No unmerged snapshot for ${mergeLabel}: snapshot ${snapshotOid.slice(0, 12)} is not available in the repository.`,
				true,
			);
		}
	}

	if (!snapshotOid) {
		return textResult(
			`No merge target found for ${mergeLabel}. The member has no mergeable snapshot OID. ` +
			`Ensure the member has completed a task with a recorded worktree snapshot before merging.`,
			true,
		);
	}

	const mergeRef = snapshotOid;
	const resolvedMergedOid = snapshotOid;
	// keep branch name for optional delete-branch-after-merge
	const branch = member.worktree?.branch ?? member.worktreeResult?.branch ?? null;

	// Idempotent repair: if snapshot is already an ancestor of HEAD, repair state and return early
	if (snapshotOid) {
		const isAncestor = await git(["merge-base", "--is-ancestor", snapshotOid, "HEAD"], cwd, 5_000)
			.then(() => true)
			.catch(() => false);
		if (isAncestor) {
			await updateRoomMemberState(activeRoom.roomDir, member.name, { lastMergedOid: snapshotOid });
			const shortOid = snapshotOid.slice(0, 12);
			return textResult(
				`Snapshot ${shortOid} for ${mergeLabel} is already an ancestor of HEAD. State repaired (lastMergedOid updated). No merge needed.`,
			);
		}
	}

	// Execute the chosen merge strategy
	try {
		if (strategy === "rebase") {
			await git(["rebase", mergeRef], cwd);
		} else if (strategy === "ff-only") {
			await git(["merge", "--ff-only", mergeRef], cwd);
		} else {
			const commitMsg = params.commitMessage ?? `pi-agent merge: ${params.name}`;
			await git(["merge", "--no-ff", "-m", commitMsg, mergeRef], cwd);
		}

		// Update lastMergedOid after successful merge
		if (resolvedMergedOid) {
			try {
				await updateRoomMemberState(activeRoom.roomDir, member.name, { lastMergedOid: resolvedMergedOid });
			} catch (stateError) {
				const stateMessage = stateError instanceof Error ? stateError.message : String(stateError);
				log.error("worktree merge state update failed", {
					memberName: resolvedMergeTarget.name,
					mergeRef,
					strategy,
					error: stateMessage,
				});
				return textResult(
					`Merged snapshot ${snapshotOid.slice(0, 12)} for ${mergeLabel}, but failed to record merge state: ${stateMessage}. ` +
					`Rerun crew_merge to repair lastMergedOid.`,
					true,
				);
			}
		}

		let branchDisposition = "no branch";
		if (branch) {
			if (deleteBranchAfterMerge) {
				try {
					await git(["branch", "-d", branch], cwd);
				} catch {
					try { await git(["branch", "-D", branch], cwd); } catch { /* best-effort */ }
				}
				const branchStillExists = await git(["show-ref", "--verify", `refs/heads/${branch}`], cwd, 5_000)
					.then(() => true)
					.catch(() => false);
				const worktreeStillActive = member.worktree?.branch === branch && Boolean(member.worktree?.path);
				branchDisposition = !branchStillExists
					? "branch deleted"
					: worktreeStillActive
						? "branch deletion deferred (worktree still active)"
						: "branch retained";
			} else {
				branchDisposition = "branch retained";
			}
		}

		const mergeCommitOid = await git(["rev-parse", "HEAD"], cwd, 5_000).catch(() => "");
		return textResult(
			`Successfully merged snapshot ${snapshotOid.slice(0, 12)} for ${mergeLabel} `
			+ `(strategy: ${strategy}, branch: ${branch ?? "none"}, merge commit: ${mergeCommitOid.slice(0, 12) || "unknown"}, ${branchDisposition}).`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		// Check for merge conflicts
		try {
			const conflictFiles = await git(["diff", "--diff-filter=U", "--name-only"], cwd);
			if (conflictFiles) {
				const files = conflictFiles.split("\n").filter(Boolean);
				return textResult(
					`Merge conflict for ${mergeLabel} (${snapshotOid ? `snapshot ${snapshotOid.slice(0, 12)}` : `branch "${branch}"`}, strategy: ${strategy}).\n${files.length} conflicted file(s):\n${files.map((f) => `  - ${f}`).join("\n")}\n\nResolve conflicts manually, then:\n  git add . && git commit\nOr abort: git merge --abort / git rebase --abort`,
					true,
				);
			}
		} catch { /* fall through to generic error */ }

		log.error("worktree merge failed", { memberName: resolvedMergeTarget.name, mergeRef, strategy, error: message });
		return textResult(`Merge failed for ${mergeLabel} (${snapshotOid ? `snapshot ${snapshotOid.slice(0, 12)}` : `branch "${branch}"`}, strategy: ${strategy}): ${message}`, true);
	}
}

export async function executeCrewRoles(
	_rawParams: unknown,
	_pi: ExtensionAPI,
	_ctx: RoomExecCtx,
	_runtimeRoot: string,
	_adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	_options: { ownerName: string; beforeDeliverMessage?: (context: { roomDir: string; memberName: string; message: RoomMessage }) => Promise<void> | void; beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	const types = listRoomAgentTypes(_ctx.cwd);
	const text = types.length === 0
		? "(no agent types found)"
		: types.map((t) => `- ${t.type}: ${t.description}${t.tools ? ` [tools: ${t.tools.join(", ")}]` : ""}`).join("\n");
	return textResult(text);
}

export async function queueCrewTell(
	params: { to?: string; summary: string; content?: string; broadcast?: boolean; replyTo?: string; kind?: RoomMessageKind },
	options: QueueCrewTellOptions,
): Promise<QueuedCrewTellResult> {
	if (!isNonEmptyString(params.summary)) {
		throw new ValidationError("Send requires a non-empty summary.");
	}
	if (params.to !== undefined && params.to !== "room" && !isNonEmptyString(params.to)) {
		throw new ValidationError("Send target must be 'room' or a non-empty member target.");
	}
	if (isNonEmptyString(params.to) && params.to !== "room" && !isValidMemberTargetInput(params.to)) {
		throw new ValidationError("Member targets must be a valid alias, internal id, or label like alias#1234.");
	}

	const { activeRoom, batchContext } = options;
	const log = createRoomLogger(activeRoom.roomDir, "room");
	let effectiveTarget: "room" | string = params.to ?? "room";
	if (effectiveTarget !== "room") {
		let resolvedTarget: RoomMemberState;
		try {
			resolvedTarget = await resolveMemberTarget(activeRoom.roomDir, effectiveTarget);
		} catch (error) {
			throw new Error(resolveTargetErrorText(error, effectiveTarget));
		}
		effectiveTarget = resolvedTarget.name;
	}
	log.info("send starting", { to: effectiveTarget, kind: params.kind ?? "info", replyTo: params.replyTo });
	const { validMentions: summaryMentions, unresolvedMentions } = await resolveSummaryMentions(
		activeRoom.roomDir,
		extractSummaryMentions(params.summary, activeRoom.memberName),
		activeRoom.memberName,
	);
	if (effectiveTarget === "room" && params.broadcast && activeRoom.role !== "owner") {
		throw new Error("Only the lead may broadcast to the room.");
	}

	const annotated = annotateMultiDepHint(params.summary, params.content);

	// Auto-inject dependency handling context when task contains {input:#N}
	const effectiveContent = (params.kind === "task" && hasInputDeps(params.content))
		? (annotated.content || "") + loadInputDepsContext()
		: annotated.content;

	let message;
	try {
		message = params.kind === "task" && effectiveTarget !== "room"
			? await appendDirectedTaskMessage(activeRoom.roomDir, {
				from: activeRoom.memberName,
				to: effectiveTarget,
				mentions: summaryMentions.length > 0 ? summaryMentions : undefined,
				...getBatchDirectedTaskMessageOptions(batchContext),
				replyTo: params.replyTo ?? null,
				summary: annotated.summary,
				content: effectiveContent,
			})
			: await appendMessage(activeRoom.roomDir, {
				from: activeRoom.memberName,
				to: effectiveTarget,
				mentions: summaryMentions.length > 0 ? summaryMentions : undefined,
				...getBatchMessageOptions(batchContext),
				broadcast: params.broadcast ?? false,
				replyTo: params.replyTo ?? null,
				kind: params.kind ?? "info",
				summary: annotated.summary,
				content: effectiveContent,
			});
	} catch (error) {
		log.error("send failed", { error: String(error) });
		throw error;
	}

	log.info("message sent", { seq: message.seq, kind: message.kind, from: activeRoom.memberName, to: effectiveTarget });

	// Register dependencies from {input:#N} placeholders at task creation time.
	//
	// Phase 1 (owner-only directed tasks): Only the owner's depIndex is
	// authoritative; member agents must not populate their local (empty)
	// depIndex. If a member sends a task with {input:#N} placeholders, deps
	// are silently skipped until an explicit proxy command for member-side
	// task creation is added (future work).
	//
	// Phase 2 (member-originated dependent tasks): Not yet implemented.
	// When added, member tasks with {input:#N} should either use a dedicated
	// mutation proxy command (register_deps / append_task_with_deps) or
	// forward through the owner authoritative path.
	//
	// See docs/plans/2026-05-06-member-task-state-optimization-plan.md §6.12
	// for the full Phase 1 / Phase 2 scope definition.
	if (message.kind === "task" && effectiveTarget !== "room" && activeRoom.role === "owner") {
		registerDeps(activeRoom.roomDir, message.seq, annotated.content, effectiveTarget);
		checkAndNotifyIfReady(activeRoom.roomDir, message.seq, annotated.content)
			.catch((err) => { consoleError("tools", "dep check failed (send)", { roomDir: activeRoom.roomDir, taskSeq: message.seq, error: String(err) }); });
	}

	// Update sender's lastActiveAt on every message send
	await updateRoomMemberState(activeRoom.roomDir, activeRoom.memberName, {
		lastActiveAt: new Date().toISOString(),
	}).catch(() => {});

	if (activeRoom.role === "member" && (message.kind === "completion" || message.kind === "error") && message.from === activeRoom.memberName) {
		const currentMember = await loadRoomMemberState(activeRoom.roomDir, activeRoom.memberName).catch(() => null);
		if (currentMember) {
			const next = applyOutgoingMessageState(currentMember, message);
			if (next !== currentMember) {
				await updateRoomMemberState(activeRoom.roomDir, activeRoom.memberName, {
					...next,
					pendingSelfAckMessageId: message.id,
					updatedAt: new Date().toISOString(),
				}).catch((err) => {
					log.error("state transition write failed (tell)", { error: String(err) });
				});
			}
		}
	}

	return {
		message,
		unresolvedMentions,
	};
}

export async function executeCrewTell(
	rawParams: unknown,
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: { ownerName?: string; beforeDeliverMessage?: (context: { roomDir: string; memberName: string; message: RoomMessage }) => Promise<void> | void; beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	const { sessionId, room } = await resolveRoomAndSession(pi, ctx, runtimeRoot, adapters, options);
	const activeRoom = room ?? getActiveRoom(sessionId);
	if (!activeRoom) {
		return textResult("No active room for this session.", true);
	}
	try {
		const queued = await queueCrewTell(rawParams as { to?: string; summary: string; content?: string; broadcast?: boolean; replyTo?: string; kind?: RoomMessageKind }, {
			activeRoom,
		});
		return textResult(`seq: ${queued.message.seq}${formatSummaryMentionWarning(queued.unresolvedMentions)}`);
	} catch (error) {
		return textResult(error instanceof Error ? error.message : String(error), true);
	}
}

export async function executeCrewMessages(
	rawParams: unknown,
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: { ownerName?: string; beforeDeliverMessage?: (context: { roomDir: string; memberName: string; message: RoomMessage }) => Promise<void> | void; beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	const params = rawParams as { limit?: number; before?: number; filter?: string };

	const { sessionId, room } = await resolveRoomAndSession(pi, ctx, runtimeRoot, adapters, options);
	const activeRoom = room ?? getActiveRoom(sessionId);
	if (!activeRoom) {
		return textResult("No active room for this session.", true);
	}

	const limit = params.limit ?? 20;
	const before = params.before;
	const filter = params.filter ?? "all";
	let entries = await listBoardEntries(activeRoom.roomDir, 0);
	if (before !== undefined) {
		entries = entries.filter((e) => e.seq < before);
	}
	entries = entries.slice(-Math.max(limit, 1));
	if (filter === "me") {
		entries = entries.filter((e) =>
			e.from === activeRoom.memberName ||
			e.to === activeRoom.memberName ||
			(e.mentions?.includes(activeRoom.memberName) ?? false),
		);
	} else if (filter !== "all") {
		entries = entries.filter((e) => e.kind === filter);
	}
	const formatName = await loadRoomNameFormatter(activeRoom.roomDir);
	const text = entries.length === 0
		? "(empty)"
		: entries.map((entry) => {
			const kind = kindEmoji(entry.kind);
			const target = entry.to === "room"
			? (entry.mentions?.length ? entry.mentions.map((name) => formatName(name)).join(", ") : "all")
			: formatRoomTargetName(entry.to, formatName);
			return `#${entry.seq} ${kind} from: ${formatName(entry.from)} to: ${target} - ${entry.summary}`;
		}).join("\n");
	return textResult(text);
}

export async function executeCrewReply(
	rawParams: unknown,
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: { ownerName?: string; beforeDeliverMessage?: (context: { roomDir: string; memberName: string; message: RoomMessage }) => Promise<void> | void; beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	const params = rawParams as { seq: number; summary: string; content?: string; kind?: RoomMessageKind };

	if (!isNonEmptyString(params.summary)) {
		return textResult("Reply requires a non-empty summary.", true);
	}

	const { sessionId, room } = await resolveRoomAndSession(pi, ctx, runtimeRoot, adapters, options);
	const activeRoom = room ?? getActiveRoom(sessionId);
	if (!activeRoom) {
		return textResult("No active room for this session.", true);
	}

	const log = createRoomLogger(activeRoom.roomDir, "room");
	const original = await readMessageBySeq(activeRoom.roomDir, params.seq);
	if (!original) {
		return textResult(`Message #${params.seq} not found.`, true);
	}
	const kind = params.kind ?? "completion";
	const isTerminalReply = kind === "completion" || kind === "error" || kind === "cancelled";
	let terminalSnapshotContext:
		| { replyMessageId?: string; snapshotOid?: string }
		| undefined;

	// Prevent re-closing an already-closed task via in-memory closedTaskIds.
	if (isTerminalReply) {
		if (isTaskClosed(activeRoom.roomDir, original.id)) {
			log.info("reply blocked: task already closed", { seq: params.seq, originalId: original.id });
			return textResult(`Task #${params.seq} is already closed. Cannot reply again with ${kind}.`, true);
		}
	}

	log.info("reply sending", { seq: params.seq, kind, to: original.from });
	const { validMentions: replyMentions, unresolvedMentions } = await resolveSummaryMentions(
		activeRoom.roomDir,
		extractSummaryMentions(params.summary, activeRoom.memberName),
		activeRoom.memberName,
	);
	const requestedReplyId = isTerminalReply ? `m${randomUUID()}` : undefined;
	if (isTerminalReply && activeRoom.role === "member") {
		try {
			terminalSnapshotContext = await prepareTerminalReplySnapshot({
				roomDir: activeRoom.roomDir,
				memberName: activeRoom.memberName,
				taskSeq: params.seq,
				kind,
				summary: params.summary,
				replyMessageId: requestedReplyId,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error("reply snapshot failed", {
				seq: params.seq,
				memberName: activeRoom.memberName,
				error: message,
			});
			return textResult(`Failed to persist a fixed worktree snapshot for task #${params.seq}: ${message}`, true);
		}
	}
	const msg = await appendMessage(activeRoom.roomDir, {
		id: terminalSnapshotContext?.replyMessageId ?? requestedReplyId,
		from: activeRoom.memberName,
		to: original.from,
		batchId: original.batchId,
		mentions: replyMentions.length > 0 ? replyMentions : undefined,
		silent: original.batchId ? true : undefined,
		broadcast: false,
		replyTo: original.id,
		kind,
		summary: params.summary,
		content: params.content,
	});
	if (isTerminalReply && activeRoom.role === "member" && terminalSnapshotContext?.snapshotOid) {
		await updatePendingTerminalReplyState({
			roomDir: activeRoom.roomDir,
			memberName: activeRoom.memberName,
			taskSeq: params.seq,
			kind,
			replyMessageId: msg.id,
			handoffState: "reply_appended",
		}).catch((err) => log.warn("failed to update pending terminal reply state", { seq: params.seq, kind, handoffState: "reply_appended", error: String(err) }));
	}
	const effectiveTaskState = terminalTaskStatusFromKind(msg.kind);
	const appendedTerminalReply = !isTerminalReply || msg.id === requestedReplyId;
	if (isTerminalReply && !effectiveTaskState) {
		return textResult(`Task #${params.seq} is already closed.`, true);
	}
	if (isTerminalReply && !appendedTerminalReply) {
		log.info("reply coalesced to existing terminal reply", {
			seq: params.seq,
			requestedKind: kind,
			effectiveKind: msg.kind,
			existingMessageId: msg.id,
		});
	}

	// After sending a completion/error/cancelled reply:
	// 1. Record the closure in-memory to prevent duplicate closure attempts.
	// 2. Update task state in the taskStates table (incremental, no disk IO).
	// 3. Check whether any downstream tasks now have all deps ready.
	if (isTerminalReply && effectiveTaskState) {
		if (activeRoom.role === "owner") {
			await recordTerminalTaskState({
				roomDir: activeRoom.roomDir,
				upstreamSeq: params.seq,
				taskMessageId: original.id,
				status: effectiveTaskState,
				logContext: { source: "crew_reply" },
			});
		} else {
			const notifiedOwner = await tryNotifyDepsViaProxy(activeRoom.roomDir, params.seq, original.id, effectiveTaskState)
				.catch((err) => {
					consoleError("tools", "dep proxy notification failed (reply)", { roomDir: activeRoom.roomDir, upstreamSeq: params.seq, error: String(err) });
					return false;
				});
			if (!notifiedOwner) {
				return textResult(`seq: ${msg.seq} recorded, but failed to notify the room owner because the mutation proxy is unavailable. Retry the same crew_reply after reconnecting.`, true);
			}

			// Member process: once the owner handoff succeeds, keep the local
			// fast-path dedup state in sync for subsequent retries.
			markTaskClosed(activeRoom.roomDir, original.id);
			setTaskState(activeRoom.roomDir, params.seq, effectiveTaskState);
		}
		if (activeRoom.role === "member" && terminalSnapshotContext?.snapshotOid) {
			await updatePendingTerminalReplyState({
				roomDir: activeRoom.roomDir,
				memberName: activeRoom.memberName,
				taskSeq: params.seq,
				kind,
				replyMessageId: msg.id,
				handoffState: "owner_handoff_done",
				clear: true,
			}).catch((err) => log.warn("failed to clear pending terminal reply state", { seq: params.seq, kind, handoffState: "owner_handoff_done", error: String(err) }));
		}
	}

	let currentMember: RoomMemberState | null = null;
	let transientCleanupNeeded = false;
	if (activeRoom.role === "member" && (msg.kind === "completion" || msg.kind === "error") && msg.from === activeRoom.memberName) {
		currentMember = await loadRoomMemberState(activeRoom.roomDir, activeRoom.memberName).catch(() => null);
		if (currentMember) {
			const next = applyOutgoingMessageState(currentMember, msg);
			if (next !== currentMember) {
				if (currentMember.transient) {
				// Request removal through the mutation proxy — the owner process
				// executes the actual state write. This is the only writer path.
				const removed = await tryRemoveTransientViaProxy(
					activeRoom.roomDir,
					activeRoom.memberName,
					msg.summary,
					msg.kind === "completion" ? "completion" : "error",
					msg.kind === "error" ? msg.summary : undefined,
				);
				if (removed) {
					log.info("transient removal: proxy command sent", { memberName: activeRoom.memberName });
					transientCleanupNeeded = true;
				} else {
					// Proxy unavailable — fall back to writing idle state so the
					// member doesn't stay stuck in "running". Removal will not happen
					// but at least the task is closed.
					log.warn("transient removal: proxy unavailable, falling back to idle", { memberName: activeRoom.memberName });
					await updateRoomMemberState(activeRoom.roomDir, activeRoom.memberName, {
						...next,
						pendingSelfAckMessageId: msg.id,
						updatedAt: new Date().toISOString(),
					}).catch((err) => {
						log.error("transient removal: fallback idle write failed", { error: String(err) });
					});
				}
			} else {
				await updateRoomMemberState(activeRoom.roomDir, activeRoom.memberName, {
					...next,
					pendingSelfAckMessageId: msg.id,
					updatedAt: new Date().toISOString(),
				}).catch((err) => {
					log.error("state transition write failed (reply)", { error: String(err) });
				});
			}
		}
	}
}

	// Auto-remove transient agents after task completion or error.
	// For proxy-based removal, the owner already wrote the board notification
	// and removed state. The member just needs to clean up its own worktree
	// and optionally signal its runtime to exit.
	if (transientCleanupNeeded) {
		// Clean worktree (best-effort)
		if (currentMember!.worktree?.path) {
			await archiveMemberWorktreeCleanup(activeRoom.roomDir, ctx.cwd, currentMember!).catch(() => {});
		}
		// Try to stop our own runtime via adapter (best-effort)
		const memberAdapter = getAdapterForBackend(currentMember!.backend, adapters);
		await memberAdapter.remove?.(currentMember!).catch(() => {});
	}

	log.info("message sent", { seq: msg.seq, kind: msg.kind, from: activeRoom.memberName, to: original.from });

	// Update sender's lastActiveAt on every reply
	await updateRoomMemberState(activeRoom.roomDir, activeRoom.memberName, {
		lastActiveAt: new Date().toISOString(),
	}).catch(() => {});

	return textResult(`seq: ${msg.seq}${formatSummaryMentionWarning(unresolvedMentions)}`);
}

export async function executeCrewRead(
	rawParams: unknown,
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: { ownerName?: string; beforeDeliverMessage?: (context: { roomDir: string; memberName: string; message: RoomMessage }) => Promise<void> | void; beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	const params = rawParams as { seq: number; offset?: number; limit?: number; tail?: boolean };

	const { sessionId, room } = await resolveRoomAndSession(pi, ctx, runtimeRoot, adapters, options);
	const activeRoom = room ?? getActiveRoom(sessionId);
	if (!activeRoom) {
		return textResult("No active room for this session.", true);
	}

	const message = await readMessageBySeq(activeRoom.roomDir, params.seq);
	if (!message) {
		return textResult(`Message #${params.seq} not found.`, true);
	}
	let replyToSeq: number | undefined;
	if (message.replyTo) {
		const original = await readMessage(activeRoom.roomDir, message.replyTo);
		replyToSeq = original?.seq;
	}
	const formatName = await loadRoomNameFormatter(activeRoom.roomDir);
	return textResult(formatRoomMessageContent(message, replyToSeq, formatName, {
		offset: params.offset,
		limit: params.limit ?? 50,
		tail: params.tail,
	}));
}

const STATE_EMOJI: Record<string, string> = {
	chatting: "💬",
	idle: "😴",
	running: "🏃",
	error: "❌",
	spawning: "⏳",
	stopping: "🛑",
	assigned: "⏸️",
	waiting_deps: "⤵️",
	blocked_failed: "🚫",
};

function stateEmoji(state: string): string {
	return STATE_EMOJI[state] ?? "❓";
}

export interface CrewWhoEntry {
	name: string;
	displayName: string;
	label: string;
	target: string;
	type: string;
	state: string;
	currentTask: string | null;
	lastCompletedTask: string | null;
	lastError: string | null;
	lastActiveAt: string | undefined;
	progress?: string;
	lastSnapshotAt?: string | null;
	lastSnapshotSummary?: string | null;
	lastMergedOid?: string | null;
	mergeReady: boolean;
}

export async function collectCrewWhoEntries(
	roomDir: string,
	cwd: string,
): Promise<CrewWhoEntry[]> {
	const members = await listRoomMembers(roomDir);
	const visibleMembers = members.filter((member) => member.state !== "removed");
	if (visibleMembers.length === 0) return [];

	const allMessages = await listBoardEntries(roomDir, 0);
	const entries: CrewWhoEntry[] = [];

	for (const member of visibleMembers) {
		const isOwner = member.type === "owner";
		const displayState = await deriveMemberDisplayState(member, roomDir, allMessages, members);
		const progress = member.todoProgress ? `[${member.todoProgress.done}/${member.todoProgress.total}] ${member.todoProgress.lastText}` : undefined;
		const label = isOwner ? member.displayName ?? member.name : formatMemberLabel(member);
		const mergeReady = await deriveMergeReadiness(member, cwd).catch(() => false);

		entries.push({
			name: member.name,
			displayName: getMemberDisplayName(member),
			label,
			target: label,
			type: member.type,
			state: displayState,
			currentTask: member.currentTask,
			lastCompletedTask: member.lastCompletedTask,
			lastError: member.lastError,
			lastActiveAt: member.lastActiveAt ? formatRelativeTime(member.lastActiveAt) : undefined,
			...(progress ? { progress } : {}),
			...(member.lastSnapshotAt !== undefined ? { lastSnapshotAt: member.lastSnapshotAt ?? null } : {}),
			...(member.lastSnapshotSummary !== undefined ? { lastSnapshotSummary: member.lastSnapshotSummary ?? null } : {}),
			...(member.lastMergedOid !== undefined ? { lastMergedOid: member.lastMergedOid ?? null } : {}),
			mergeReady,
		});
	}

	return entries;
}

function formatCrewWhoEntries(entries: CrewWhoEntry[]): string {
	const lines: string[] = [];
	for (const entry of entries) {
		const isOwner = entry.type === "owner";
		const roleTag = isOwner ? "owner" : entry.type;
		const activeAgo = entry.lastActiveAt ?? "—";
		const emoji = stateEmoji(entry.state);

		lines.push(`${emoji} ${entry.label} (${roleTag}) · ${entry.state} · ${activeAgo}`);

		if (!isOwner) {
			if (entry.currentTask) {
				lines.push(`   task: ${entry.currentTask}${entry.progress ? ` · ${entry.progress}` : ""}`);
			}
			if (entry.lastCompletedTask) {
				lines.push(`   last: ${entry.lastCompletedTask}`);
			}
			if (entry.lastError) {
				lines.push(`   error: ${entry.lastError}`);
			}
			if (entry.mergeReady) {
				const snapLine = entry.lastSnapshotSummary
					? `📦 merge ready: ${entry.lastSnapshotSummary}`
					: "📦 merge ready";
				lines.push(`   ${snapLine}`);
			}
			if (entry.lastMergedOid) {
				const short = entry.lastMergedOid.slice(0, 9);
				lines.push(`   merged: ${short}${entry.lastSnapshotSummary ? ` — ${entry.lastSnapshotSummary}` : ""}`);
			}
		}
	}
	return lines.join("\n");
}

export async function executeCrewWho(
	_rawParams: unknown,
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: { ownerName?: string; beforeDeliverMessage?: (context: { roomDir: string; memberName: string; message: RoomMessage }) => Promise<void> | void; beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	const { sessionId, room } = await resolveRoomAndSession(pi, ctx, runtimeRoot, adapters, options);
	const activeRoom = room ?? getActiveRoom(sessionId);
	if (!activeRoom) {
		return textResult("No active room for this session.", true);
	}

	const entries = await collectCrewWhoEntries(activeRoom.roomDir, ctx.cwd);
	if (entries.length === 0) {
		return textResult("(no members)");
	}
	return textResult(formatCrewWhoEntries(entries));
}

export async function executeCrewTasks(
	rawParams: unknown,
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: { ownerName?: string; beforeDeliverMessage?: (context: { roomDir: string; memberName: string; message: RoomMessage }) => Promise<void> | void; beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	const params = rawParams as { limit?: number; before?: number; status?: string };

	const { sessionId, room } = await resolveRoomAndSession(pi, ctx, runtimeRoot, adapters, options);
	const activeRoom = room ?? getActiveRoom(sessionId);
	if (!activeRoom) {
		return textResult("No active room for this session.", true);
	}

	const limit = params.limit ?? 20;
	const status = params.status;
	const before = params.before;

	const allMessages = await listBoardEntries(activeRoom.roomDir, 0);

	// Filter to task messages only
	let tasks = allMessages.filter((m) => m.kind === "task");

	// Apply before cursor
	if (before !== undefined) {
		tasks = tasks.filter((t) => t.seq < before);
	}

	// Sort newest first
	tasks.sort((a, b) => b.seq - a.seq);

	// Resolve status for each task using the derived TaskStatus helper
	const members = await listRoomMembers(activeRoom.roomDir);
	const resolved = await Promise.all(tasks.map(async (task) => {
		const taskStatus = await deriveTaskStatus(activeRoom.roomDir, task, allMessages, members);
		const reply = allMessages.find((m) =>
			m.replyTo === task.id && ["completion", "error", "cancelled"].includes(m.kind)
		);
		let todoProgress: { done: number; total: number; lastText: string } | null = null;
		if (task.to !== "room") {
			const member = members.find((m) => m.name === task.to);
			todoProgress = member?.todoProgress ?? null;
		}
		return { task, status: taskStatus, todoProgress, completedAt: reply?.createdAt ?? null };
	}));

	// Apply status filter (supports all 8 TaskStatus values)
	let filtered = status ? resolved.filter((r) => r.status === status) : resolved;

	// Apply limit
	filtered = filtered.slice(0, limit);

	if (filtered.length === 0) {
		return textResult("(no tasks)");
	}
	const formatName = await loadRoomNameFormatter(activeRoom.roomDir);

	const text = filtered.map((r) => {
		const emoji = r.status === "completed" ? "✅"
		: r.status === "error" ? "❌"
		: r.status === "cancelled" ? "🛑"
		: r.status === "agentLost" ? "💀"
		: r.status === "waiting_deps" ? "⏸️"
		: r.status === "blocked_failed" ? "🚫"
		: r.status === "assigned" ? "⏳"
		: "🏃"; // running
		const assignee = formatRoomTargetName(r.task.to, formatName);
		// Attach todo progress for non-terminal tasks
		let progress = "";
		if ((r.status === "running" || r.status === "assigned" || r.status === "waiting_deps" || r.status === "blocked_failed") && r.todoProgress) {
			const p = r.todoProgress;
			progress = ` - [${p.done}/${p.total}] ${p.lastText}`;
		}
		// Compute elapsed time
		let elapsed = "";
		if (r.status === "running" || r.status === "assigned" || r.status === "waiting_deps") {
			elapsed = ` [${formatElapsed(r.task.createdAt)}]`;
		} else if (r.status === "agentLost" || r.status === "blocked_failed") {
			elapsed = ` [${formatElapsed(r.task.createdAt)}+]`;
		} else if ((r.status === "completed" || r.status === "error" || r.status === "cancelled") && r.completedAt) {
			elapsed = ` [${formatElapsed(r.task.createdAt, r.completedAt)}]`;
		}
		return `#${r.task.seq} 📋 ${r.task.summary}${progress} → ${emoji} ${r.status} (${assignee})${elapsed}`;
	}).join("\n");
	return textResult(text);
}
