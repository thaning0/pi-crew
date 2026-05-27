import { createHash } from "node:crypto";

export type PublicTaskLifecycleEventName =
	| "task:assigned"
	| "task:waiting_deps"
	| "task:blocked_failed"
	| "task:started"
	| "task:completed"
	| "task:failed"
	| "task:cancelled";

export type PublicTaskStatus =
	| "assigned"
	| "waiting_deps"
	| "blocked_failed"
	| "running"
	| "completed"
	| "error"
	| "cancelled";

export interface PublicTaskLifecycleEvent {
	protocol_version: 1;
	event_id: string;
	occurred_at: string;
	event: PublicTaskLifecycleEventName;
	task_status: PublicTaskStatus;
	room_id: string | null;
	member_target: string | null;
	member_type: string | null;
	request_id: string | null;
	spawn_task_id: string | null;
	runtime_id: string | null;
	session_id: string | null;
	task_seq: number;
	task_message_id: string;
	task_summary: string;
	reply_message_id: string | null;
	reply_summary: string | null;
	metadata: Record<string, unknown> | null;
	content_ref: {
		room_id: string;
		message_id: string;
		seq: number;
		kind: "room_message";
	};
	error: string | null;
	reason: string | null;
}

export interface TaskLifecycleEventInput {
	event: PublicTaskLifecycleEventName;
	task_status: PublicTaskStatus;
	room_id: string | null;
	member_target: string | null;
	member_type?: string | null;
	request_id?: string | null;
	spawn_task_id?: string | null;
	runtime_id?: string | null;
	session_id?: string | null;
	task_seq: number;
	task_message_id: string;
	task_summary: string;
	reply_message_id?: string | null;
	reply_summary?: string | null;
	metadata?: Record<string, unknown> | null;
	content_ref: {
		room_id: string;
		message_id: string;
		seq: number;
		kind: "room_message";
	};
	error?: string | null;
	reason?: string | null;
}

type TaskEventEmitter = (
	payload: PublicTaskLifecycleEvent,
) => void | Promise<void>;

let taskEventEmitter: TaskEventEmitter | null = null;

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, entryValue]) =>
					`${JSON.stringify(key)}:${stableSerialize(entryValue)}`,
			);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

function normalizeTaskLifecycleEventInput(
	input: TaskLifecycleEventInput,
): TaskLifecycleEventInput {
	return {
		event: input.event,
		task_status: input.task_status,
		room_id: input.room_id,
		member_target: input.member_target,
		member_type: input.member_type ?? null,
		request_id: input.request_id ?? null,
		spawn_task_id: input.spawn_task_id ?? null,
		runtime_id: input.runtime_id ?? null,
		session_id: input.session_id ?? null,
		task_seq: input.task_seq,
		task_message_id: input.task_message_id,
		task_summary: input.task_summary,
		reply_message_id: input.reply_message_id ?? null,
		reply_summary: input.reply_summary ?? null,
		metadata: input.metadata ?? null,
		content_ref: input.content_ref,
		error: input.error ?? null,
		reason: input.reason ?? null,
	};
}

interface TaskLifecycleEventIdentitySeed {
	event: PublicTaskLifecycleEventName;
	task_status: PublicTaskStatus;
	room_id: string | null;
	task_message_id: string;
	task_seq: number;
	member_target: string | null;
	reply_message_id: string | null;
}

function buildEventIdentitySeed(
	input: TaskLifecycleEventInput,
): TaskLifecycleEventIdentitySeed {
	return {
		event: input.event,
		task_status: input.task_status,
		room_id: input.room_id,
		task_message_id: input.task_message_id,
		task_seq: input.task_seq,
		member_target: input.member_target,
		reply_message_id: input.reply_message_id ?? null,
	};
}

export function buildTaskLifecycleEvent(
	input: TaskLifecycleEventInput,
): PublicTaskLifecycleEvent {
	const normalized = normalizeTaskLifecycleEventInput(input);
	const identitySeed = buildEventIdentitySeed(normalized);
	const event_id = `crew-task-event-${createHash("sha256")
		.update(stableSerialize(identitySeed))
		.digest("hex")
		.slice(0, 24)}`;

	return {
		protocol_version: 1,
		event_id,
		occurred_at: new Date().toISOString(),
		event: normalized.event,
		task_status: normalized.task_status,
		room_id: normalized.room_id,
		member_target: normalized.member_target,
		member_type: normalized.member_type,
		request_id: normalized.request_id,
		spawn_task_id: normalized.spawn_task_id,
		runtime_id: normalized.runtime_id,
		session_id: normalized.session_id,
		task_seq: normalized.task_seq,
		task_message_id: normalized.task_message_id,
		task_summary: normalized.task_summary,
		reply_message_id: normalized.reply_message_id,
		reply_summary: normalized.reply_summary,
		metadata: normalized.metadata,
		content_ref: normalized.content_ref,
		error: normalized.error,
		reason: normalized.reason,
	};
}

export function setTaskEventEmitter(
	emitter: TaskEventEmitter | null | undefined,
): void {
	taskEventEmitter = emitter ?? null;
}

export async function emitTaskLifecycleEvent(
	input: TaskLifecycleEventInput,
): Promise<PublicTaskLifecycleEvent> {
	const payload = buildTaskLifecycleEvent(input);
	if (!taskEventEmitter) {
		return payload;
	}

	try {
		await taskEventEmitter(payload);
	} catch {
		// Best-effort only: task lifecycle handling must not fail because outbound feedback failed.
	}
	return payload;
}
