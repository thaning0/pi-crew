import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RoomMemberState, RoomMessage } from "./types.ts";
import { createRoomLogger } from "./logger.ts";
import { extractInputDeps } from "./deps.ts";

const dispatchLog = createRoomLogger(null, "dispatch");
type RoomNameFormatter = (name: string) => string;

function formatRoomActor(name: string, formatter?: RoomNameFormatter): string {
	return formatter ? formatter(name) : name;
}

export function isMessageTargetedToMember(message: RoomMessage, memberName: string): boolean {
	if (message.to === memberName) return true;
	if (message.kind === "task" && message.to !== "room") return false;
	if (message.mentions?.includes(memberName) ?? false) return true;
	return false;
}

export interface ContentOptions {
	offset?: number;
	limit?: number;
	tail?: boolean;
}

export function formatRoomMessageContent(message: RoomMessage, replyToSeq?: number, formatter?: RoomNameFormatter, contentOptions?: ContentOptions): string {
	const lines = [
		`Seq: #${message.seq}`,
		`From: ${formatRoomActor(message.from, formatter)}`,
		`To: ${message.to === "room" ? "room" : formatRoomActor(message.to, formatter)}`,
		`Summary: ${message.summary}`,
	];
	if (message.replyTo && replyToSeq !== undefined) lines.push(`ReplyTo: #${replyToSeq}`);
	if (message.mentions?.length) lines.push(`Mentions: ${message.mentions.map((name) => formatRoomActor(name, formatter)).join(", ")}`);
	if (message.content && message.content.trim()) {
		lines.push("");
		const trimmed = message.content.trim();
		const applied = applyContentOptions(trimmed, contentOptions);
		lines.push(applied.content);
		if (applied.notice) lines.push(applied.notice);
	}
	if (message.kind === "task") {
		lines.push("");
		lines.push(`⚠️  When finished, you MUST call: crew_reply(seq=#${message.seq}, kind="completion", summary="one-line result", content="full report")`);
		lines.push("Do NOT output final results as plain text — only crew_reply delivers them to the owner.");
	}
	return lines.join("\n");
}

function applyContentOptions(content: string, opts?: ContentOptions): { content: string; notice?: string } {
	if (!opts || (!hasValidLimit(opts) && opts.offset === undefined && !opts.tail)) {
		return { content };
	}

	const allLines = content.split("\n");
	const total = allLines.length;

	if (opts.tail && hasValidLimit(opts)) {
		const limit = opts.limit!;
		const start = Math.max(0, total - limit);
		const end = total;
		const sliced = allLines.slice(start, end).join("\n");
		const shown = end - start;
		const notice = shown >= total
			? undefined
			: `[Last ${shown} lines of ${total}. Use offset=1 to read from beginning.]`;
		return { content: sliced, notice };
	}

	// head / offset mode
	const offset = opts.offset ?? 1;
	const startIdx = Math.max(0, offset - 1);
	if (startIdx >= total) {
		return { content: "", notice: `[Offset ${offset} is beyond end of content (${total} lines total).]` };
	}

	const endIdx = hasValidLimit(opts) ? Math.min(startIdx + opts.limit!, total) : total;
	const sliced = allLines.slice(startIdx, endIdx).join("\n");

	if (endIdx < total) {
		// endIdx is 0-based exclusive → 1-based last shown line is endIdx
		const notice = `[Lines ${startIdx + 1}-${endIdx} of ${total}. Use offset=${endIdx + 1} to continue.]`;
		return { content: sliced, notice };
	}

	if (opts.offset !== undefined && opts.offset > 1) {
		// Reached end via offset — show range without continuation hint
		return { content: sliced, notice: `[Lines ${startIdx + 1}-${endIdx} of ${total}.]` };
	}

	return { content: sliced };
}

function hasValidLimit(opts: ContentOptions): boolean {
	return opts.limit !== undefined && opts.limit !== null && opts.limit > 0;
}

export function deliverRoomMessage(pi: Pick<ExtensionAPI, "sendMessage">, message: RoomMessage, formatter?: RoomNameFormatter): void {
	pi.sendMessage(
		{ customType: "mail", content: formatRoomMessageContent(message, undefined, formatter), display: true },
		{ deliverAs: "steer", triggerTurn: true },
	);
}

export function kindEmoji(kind: RoomMessage["kind"]): string {
	return kind === "task" ? "📋"
		: kind === "completion" ? "✅"
		: kind === "error" ? "❌"
		: kind === "question" ? "❓"
		: kind === "cancelled" ? "🛑"
		: kind === "progress" ? "📊"
		: "💬";
}

/**
 * Deliver multiple room messages as a single batched steer message.
 * Only triggers one LLM turn, avoiding notification noise from bulk
 * spawns, bulk stops, or room broadcasts.
 *
 * Falls back to single-message delivery when the batch contains only one
 * item, preserving backward-compatible message format for simple cases.
 */
export function deliverRoomMessagesBatch(
	pi: Pick<ExtensionAPI, "sendMessage">,
	messages: Array<{ message: RoomMessage; isNewTask: boolean }>,
	formatter?: RoomNameFormatter,
): void {
	if (messages.length === 0) return;

	if (messages.length === 1) {
		deliverRoomMessage(pi, messages[0].message, formatter);
		return;
	}

	const lines = [`📬 ${messages.length} room messages:`];
	for (const { message } of messages) {
		const from = formatRoomActor(message.from, formatter);
		const to = message.to === "room" ? "room" : formatRoomActor(message.to, formatter);
		lines.push(`  #${message.seq} ${kindEmoji(message.kind)} ${from} → ${to}: ${message.summary}`);
	}

	pi.sendMessage(
		{ customType: "mail-batch", content: lines.join("\n"), display: true },
		{ deliverAs: "steer", triggerTurn: true },
	);
}

export function shouldDeliverMessage(message: RoomMessage, memberName: string): boolean {
	if (message.kind === "progress") return false;
	if (message.silent === true) return false;
	if (isMessageTargetedToMember(message, memberName) && message.from !== memberName) return true;
	// System broadcasts (spawn/stop notifications) are informational and should
	// only reach the owner (handled via processUnreadMessages owner path).
	// Exclude them here to avoid waking idle subagents with irrelevant messages.
	//
	// IMPORTANT: Targeted member delivery (checked above) takes priority over
	// this system filter. Dependency-ready notifications ("All dependencies
	// ready for task #N") are sent as target@member system info messages and
	// therefore reach the member via the isMessageTargetedToMember branch above.
	// This ordering must be preserved — do not move isMessageTargetedToMember
	// below the system filter.
	if (message.from === "system") return false;
	return message.to === "room" && message.broadcast && message.from !== memberName;
}

export function applyIncomingMessageState(member: RoomMemberState, message: RoomMessage): RoomMemberState {
	if (!isMessageTargetedToMember(message, member.name)) return member;

	if (message.kind === "task") {
		const deps = extractInputDeps(message.content);
		const hasDeps = deps.length > 0;
		const nextState = hasDeps && member.state === "running" ? "idle" : hasDeps ? member.state : "running";
		return {
			...member,
			state: nextState,
			currentTask: message.summary,
			currentTaskMessageId: message.id,
			lastError: null,
			taskClosureSteeredMessageId: null,
			todoProgress: null,
		};
	}

	if (message.kind === "cancelled" && message.replyTo === member.currentTaskMessageId) {
		return {
			...member,
			state: "idle",
			currentTask: null,
			currentTaskMessageId: null,
			taskClosureSteeredMessageId: null,
			lastError: "Task was cancelled.",
			todoProgress: null,
		};
	}

	return member;
}

export function applyOutgoingMessageState(member: RoomMemberState, message: RoomMessage): RoomMemberState {
	if (message.from !== member.name || !message.replyTo) return member;
	if (message.replyTo !== member.currentTaskMessageId) {
		if (message.kind === "completion" || message.kind === "error") {
			dispatchLog.warn(
				`Ignoring stale room ${message.kind} replyTo ${message.replyTo} for ${member.name}; active task is ${member.currentTaskMessageId ?? "none"}.`,
			);
		}
		return member;
	}

	if (message.kind === "completion") {
		return {
			...member,
			state: "idle",
			lastCompletedTask: message.summary,
			currentTask: null,
			currentTaskMessageId: null,
			taskClosureSteeredMessageId: null,
			todoProgress: null,
		};
	}

	if (message.kind === "error") {
		return {
			...member,
			state: "idle",
			lastError: message.summary,
			currentTask: null,
			currentTaskMessageId: null,
			taskClosureSteeredMessageId: null,
			todoProgress: null,
		};
	}

	return member;
}
