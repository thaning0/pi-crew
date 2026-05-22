import { randomUUID } from "node:crypto";
import { appendMessage, readMessage, readMessageBySeq } from "./storage.ts";
import { consoleError } from "./logger.ts";
import {
	isTaskClosed,
	markTaskClosed,
	notifyBlockedDependentsOnTerminalFailure,
	notifyDependentsIfAllReady,
	setTaskState,
} from "./deps.ts";

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

export async function recordTerminalTaskState(ref: TerminalTaskRef & {
	status: TerminalTaskStatus;
	logContext?: Record<string, unknown>;
}): Promise<boolean> {
	const resolved = await resolveTerminalTaskRef(ref);
	if (!resolved) return false;
	if (isTaskClosed(ref.roomDir, resolved.taskMessageId)) return false;

	markTaskClosed(ref.roomDir, resolved.taskMessageId);
	setTaskState(ref.roomDir, resolved.upstreamSeq, ref.status);

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
		logContext: options.logContext,
	});
}