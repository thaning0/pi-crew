import { randomUUID } from "node:crypto";
import { appendMessage, readMessage, readMessageBySeq, loadRoomMetadata, loadRoomMemberState, upsertTaskLifecycleReplay } from "./storage.ts";
import { consoleError } from "./logger.ts";
import {
	isTaskClosed,
	markTaskClosed,
	notifyBlockedDependentsOnTerminalFailure,
	notifyDependentsIfAllReady,
	setTaskState,
} from "./deps.ts";
import { emitTaskLifecycleEvent } from "./task-integration-events.ts";

type TerminalTaskStatus = "completed" | "error" | "cancelled";
type TerminalTaskReplyKind = "completion" | "error" | "cancelled";

function terminalTaskStatusFromKind(kind: TerminalTaskReplyKind): TerminalTaskStatus {
	return kind === "completion" ? "completed" : kind;
}

interface TerminalTaskRef {
	roomDir: string;
	upstreamSeq?: number;
	taskMessageId?: string;
}

interface ResolvedTerminalTaskRef {
	upstreamSeq: number;
	taskMessageId: string;
}

async function resolveTerminalTaskRef({
	roomDir,
	upstreamSeq,
	taskMessageId,
}: TerminalTaskRef): Promise<ResolvedTerminalTaskRef | null> {
	if (typeof upstreamSeq === "number" && taskMessageId) {
		return { upstreamSeq, taskMessageId };
	}

	if (typeof upstreamSeq === "number") {
		const original = await readMessageBySeq(roomDir, upstreamSeq).catch(() => null);
		return original ? { upstreamSeq, taskMessageId: original.id } : null;
	}

	if (taskMessageId) {
		const original = await readMessage(roomDir, taskMessageId).catch(() => null);
		return original ? { upstreamSeq: original.seq, taskMessageId } : null;
	}

	return null;
}

// ── Terminal event emission ──────────────────────────────────────────────

async function emitTaskTerminalEvent(
	roomDir: string,
	opts: {
		taskSeq: number;
		taskMessageId: string;
		replyMessageId?: string;
		terminalStatus: "completed" | "error" | "cancelled";
		memberName: string;
	},
): Promise<void> {
	// Load task message
	const taskMsg = await readMessage(roomDir, opts.taskMessageId);
	if (!taskMsg) return;

	// Load reply message for summary if available
	let replySummary: string | null = null;
	if (opts.replyMessageId) {
		const replyMsg = await readMessage(roomDir, opts.replyMessageId).catch(() => null);
		replySummary = replyMsg?.summary ?? null;
	}

	// Load member state for correlation
	const member = await loadRoomMemberState(roomDir, opts.memberName).catch(() => null);
	const metadata = await loadRoomMetadata(roomDir).catch(() => null);
	if (!metadata) return;

	const eventName = opts.terminalStatus === "completed" ? "task:completed" as const
		: opts.terminalStatus === "error" ? "task:failed" as const
		: "task:cancelled" as const;

	// Check replay for dedup
	const replay = await upsertTaskLifecycleReplay(roomDir, {
		event: eventName,
		task_message_id: opts.taskMessageId,
		task_seq: opts.taskSeq,
		room_id: metadata.roomId,
		member_target: opts.memberName,
		member_type: member?.type ?? null,
		request_id: member?.requestId ?? null,
		spawn_task_id: member?.spawnTaskId ?? null,
		runtime_id: member?.runtimeId ?? null,
		session_id: member?.sessionId ?? null,
		task_summary: taskMsg.summary,
		reply_message_id: opts.replyMessageId ?? null,
	});

	if (replay.is_replay) return;

	await emitTaskLifecycleEvent({
		event: eventName,
		task_status: opts.terminalStatus,
		room_id: metadata.roomId,
		member_target: opts.memberName,
		member_type: member?.type ?? null,
		request_id: member?.requestId ?? null,
		spawn_task_id: member?.spawnTaskId ?? null,
		runtime_id: member?.runtimeId ?? null,
		session_id: member?.sessionId ?? null,
		task_seq: opts.taskSeq,
		task_message_id: opts.taskMessageId,
		task_summary: taskMsg.summary,
		reply_message_id: opts.replyMessageId ?? null,
		reply_summary: replySummary,
		content_ref: {
			room_id: metadata.roomId,
			message_id: opts.replyMessageId ?? opts.taskMessageId,
			seq: opts.taskSeq,
			kind: "room_message",
		},
	});
}

export async function recordTerminalTaskState(ref: TerminalTaskRef & {
	status: TerminalTaskStatus;
	replyMessageId?: string;
	logContext?: Record<string, unknown>;
}): Promise<boolean> {
	const resolved = await resolveTerminalTaskRef(ref);
	if (!resolved) return false;
	if (isTaskClosed(ref.roomDir, resolved.taskMessageId)) return false;

	markTaskClosed(ref.roomDir, resolved.taskMessageId);
	setTaskState(ref.roomDir, resolved.upstreamSeq, ref.status);

	// Load the task message to get member target for terminal event emission
	const taskMsg = await readMessage(ref.roomDir, resolved.taskMessageId).catch(() => null);
	if (taskMsg && taskMsg.to && taskMsg.to !== "room") {
		await emitTaskTerminalEvent(ref.roomDir, {
			taskSeq: resolved.upstreamSeq,
			taskMessageId: resolved.taskMessageId,
			replyMessageId: ref.replyMessageId,
			terminalStatus: ref.status,
			memberName: taskMsg.to,
		}).catch((err) => {
			consoleError("task-terminal", "terminal event emission failed", {
				roomDir: ref.roomDir,
				upstreamSeq: resolved.upstreamSeq,
				status: ref.status,
				error: String(err),
			});
		});
	}

	// If this task entered a terminal failure state, proactively notify
	// all downstream tasks that depend on it without waiting for the
	// remaining dependencies to complete.
	if (ref.status === "error" || ref.status === "cancelled") {
		await notifyBlockedDependentsOnTerminalFailure(
			ref.roomDir,
			resolved.upstreamSeq,
			ref.status,
		).catch((err) => {
			consoleError("task-terminal", "blocked failure notification failed", {
				roomDir: ref.roomDir,
				upstreamSeq: resolved.upstreamSeq,
				status: ref.status,
				error: String(err),
				...(ref.logContext ?? {}),
			});
		});
	}

	await notifyDependentsIfAllReady(ref.roomDir, resolved.upstreamSeq).catch((err) => {
		consoleError("task-terminal", "dep notification failed", {
			roomDir: ref.roomDir,
			upstreamSeq: resolved.upstreamSeq,
			status: ref.status,
			error: String(err),
			...(ref.logContext ?? {}),
		});
	});
	return true;
}

export async function appendTerminalTaskReplyAndNotify(options: TerminalTaskRef & {
	from: string;
	to: string;
	kind: TerminalTaskReplyKind;
	summary: string;
	content?: string;
	mentions?: string[];
	logContext?: Record<string, unknown>;
}): Promise<boolean> {
	const resolved = await resolveTerminalTaskRef(options);
	if (!resolved) return false;
	if (isTaskClosed(options.roomDir, resolved.taskMessageId)) return false;
	const originalTask = await readMessage(options.roomDir, resolved.taskMessageId);
	if (!originalTask) return false;

	const requestedMessageId = `m${randomUUID()}`;
	const reply = await appendMessage(options.roomDir, {
		id: requestedMessageId,
		from: options.from,
		to: options.to,
		batchId: originalTask.batchId,
		mentions: options.mentions,
		silent: originalTask.batchId ? true : undefined,
		broadcast: false,
		replyTo: resolved.taskMessageId,
		kind: options.kind,
		summary: options.summary,
		content: options.content,
	});

	const status = terminalTaskStatusFromKind(reply.kind as TerminalTaskReplyKind);
	if (reply.id !== requestedMessageId && isTaskClosed(options.roomDir, resolved.taskMessageId)) {
		return false;
	}

	return await recordTerminalTaskState({
		roomDir: options.roomDir,
		upstreamSeq: resolved.upstreamSeq,
		taskMessageId: resolved.taskMessageId,
		status,
		replyMessageId: reply.id,
		logContext: options.logContext,
	});
}