import { describe, it, expect } from "vitest";
import {
	isMessageTargetedToMember,
	shouldDeliverMessage,
	applyIncomingMessageState,
	applyOutgoingMessageState,
	formatRoomMessageContent,
} from "./dispatch.ts";
import type { RoomMemberState, RoomMessage } from "./types.ts";

function makeMessage(overrides: Partial<RoomMessage> = {}): RoomMessage {
	return {
		seq: 1,
		id: "msg-1",
		from: "owner",
		to: "worker-1",
		mentions: undefined,
		broadcast: false,
		replyTo: null,
		kind: "task",
		summary: "Test task",
		content: undefined,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function makeMember(overrides: Partial<RoomMemberState> = {}): RoomMemberState {
	return {
		name: "worker-1",
		type: "worker",
		backend: "pi",
		runtimeId: "pi-runtime-1",
		state: "idle",
		spawnTaskId: null,
		currentTask: null,
		currentTaskMessageId: null,
		lastCompletedTask: null,
		lastError: null,
		lastSeenSeq: 0,
		joinedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		sessionId: "session-1",
		...overrides,
	};
}

// ── isMessageTargetedToMember ──────────────────────────────────────────────

describe("isMessageTargetedToMember", () => {
	it("returns true for direct match (to === memberName)", () => {
		const msg = makeMessage({ to: "worker-1" });
		expect(isMessageTargetedToMember(msg, "worker-1")).toBe(true);
	});

	it("returns true for mention match on non-task messages", () => {
		const msg = makeMessage({ to: "worker-2", kind: "info", mentions: ["worker-1", "worker-2"] });
		expect(isMessageTargetedToMember(msg, "worker-1")).toBe(true);
	});

	it("returns false for mention-only match on directed task messages", () => {
		const msg = makeMessage({ to: "worker-2", mentions: ["worker-1", "worker-2"] });
		expect(isMessageTargetedToMember(msg, "worker-1")).toBe(false);
	});

	it("returns false when message is to room without mentions", () => {
		const msg = makeMessage({ to: "room", mentions: undefined });
		expect(isMessageTargetedToMember(msg, "worker-1")).toBe(false);
	});

	it("returns false for message sent to a different member (no mention)", () => {
		const msg = makeMessage({ to: "worker-2", mentions: undefined });
		expect(isMessageTargetedToMember(msg, "worker-1")).toBe(false);
	});

	it("returns false for self-message (no mention of self)", () => {
		const msg = makeMessage({ from: "worker-1", to: "worker-2" });
		expect(isMessageTargetedToMember(msg, "worker-1")).toBe(false);
	});

	it("returns false when mentions array is empty", () => {
		const msg = makeMessage({ to: "worker-2", mentions: [] });
		expect(isMessageTargetedToMember(msg, "worker-1")).toBe(false);
	});
});

// ── shouldDeliverMessage ───────────────────────────────────────────────────

describe("shouldDeliverMessage", () => {
	it("delivers targeted message to the recipient", () => {
		const msg = makeMessage({ to: "worker-1", from: "owner" });
		expect(shouldDeliverMessage(msg, "worker-1")).toBe(true);
	});

	it("does NOT deliver targeted message to the sender themselves", () => {
		const msg = makeMessage({ to: "worker-1", from: "worker-1" });
		expect(shouldDeliverMessage(msg, "worker-1")).toBe(false);
	});

	it("delivers broadcast room message to a member who is not the sender", () => {
		const msg = makeMessage({ to: "room", from: "owner", broadcast: true });
		expect(shouldDeliverMessage(msg, "worker-1")).toBe(true);
	});

	it("does NOT deliver broadcast room message to the sender", () => {
		const msg = makeMessage({ to: "room", from: "worker-1", broadcast: true });
		expect(shouldDeliverMessage(msg, "worker-1")).toBe(false);
	});

	it("does NOT deliver non-broadcast room message to non-targeted member", () => {
		const msg = makeMessage({ to: "room", from: "owner", broadcast: false });
		expect(shouldDeliverMessage(msg, "worker-1")).toBe(false);
	});

	it("does NOT deliver system broadcast to subagent members (only owner gets system messages)", () => {
		const msg = makeMessage({ to: "room", from: "system", kind: "info", broadcast: true, summary: "Agent worker-2 ready" });
		expect(shouldDeliverMessage(msg, "worker-1")).toBe(false);
	});

	it.each([
		"All dependencies ready for task #42",
		"Dependency failed — some upstream tasks for #42 ended with error",
		"Dependency cancelled — some upstream tasks for #42 were cancelled",
	])("delivers targeted dependency control message '%s' before the system-message filter", (summary) => {
		const msg = makeMessage({ to: "worker-1", from: "system", kind: "info", broadcast: false, summary });
		expect(shouldDeliverMessage(msg, "worker-1")).toBe(true);
	});
});

// ── applyIncomingMessageState ──────────────────────────────────────────────

describe("applyIncomingMessageState", () => {
	it("transitions idle member to running on task message", () => {
		const member = makeMember({ state: "idle" });
		const msg = makeMessage({ kind: "task", to: "worker-1", id: "task-42", summary: "Build feature X" });
		const result = applyIncomingMessageState(member, msg);
		expect(result.state).toBe("running");
		expect(result.currentTask).toBe("Build feature X");
		expect(result.currentTaskMessageId).toBe("task-42");
		expect(result.lastError).toBeNull();
	});

	it("clears lastError when receiving a task", () => {
		const member = makeMember({ state: "error", lastError: "previous failure" });
		const msg = makeMessage({ kind: "task", to: "worker-1", id: "task-43", summary: "Retry" });
		const result = applyIncomingMessageState(member, msg);
		expect(result.state).toBe("running");
		expect(result.lastError).toBeNull();
	});

	it("keeps an idle member idle when the targeted task still has input dependencies", () => {
		const member = makeMember({ state: "idle" });
		const msg = makeMessage({
			kind: "task",
			to: "worker-1",
			id: "task-44",
			summary: "Wait for upstream",
			content: "Use {input:#12} before starting.",
		});
		const result = applyIncomingMessageState(member, msg);
		expect(result.state).toBe("idle");
		expect(result.currentTask).toBe("Wait for upstream");
		expect(result.currentTaskMessageId).toBe("task-44");
	});

	it("drops a task-free running member back to idle when a dependency-gated task is assigned", () => {
		const member = makeMember({ state: "running", currentTask: null, currentTaskMessageId: null });
		const msg = makeMessage({
			kind: "task",
			to: "worker-1",
			id: "task-44a",
			summary: "Wait before resuming",
			content: "Use {input:#12} before starting.",
		});
		const result = applyIncomingMessageState(member, msg);
		expect(result.state).toBe("idle");
		expect(result.currentTaskMessageId).toBe("task-44a");
	});

	it("preserves an errored member lifecycle when a dependency-gated task is folded into local state", () => {
		const member = makeMember({ state: "error", lastError: "previous failure" });
		const msg = makeMessage({
			kind: "task",
			to: "worker-1",
			id: "task-45",
			summary: "Retry after upstream completes",
			content: "Use {input:#12} before starting.",
		});
		const result = applyIncomingMessageState(member, msg);
		expect(result.state).toBe("error");
		expect(result.lastError).toBeNull();
		expect(result.currentTaskMessageId).toBe("task-45");
	});

	it("returns to idle when cancelled message matches currentTaskMessageId", () => {
		const member = makeMember({ state: "running", currentTask: "task A", currentTaskMessageId: "msg-5" });
		const msg = makeMessage({ kind: "cancelled", to: "worker-1", replyTo: "msg-5" });
		const result = applyIncomingMessageState(member, msg);
		expect(result.state).toBe("idle");
		expect(result.currentTask).toBeNull();
		expect(result.currentTaskMessageId).toBeNull();
		expect(result.lastError).toBe("Task was cancelled.");
	});

	it("does NOT cancel when cancelled message replyTo does not match current task", () => {
		const member = makeMember({ state: "running", currentTask: "task A", currentTaskMessageId: "msg-5" });
		const msg = makeMessage({ kind: "cancelled", to: "worker-1", replyTo: "msg-99" });
		const result = applyIncomingMessageState(member, msg);
		expect(result.state).toBe("running");
		expect(result.currentTaskMessageId).toBe("msg-5");
	});

	it("does NOT change state on info message", () => {
		const member = makeMember({ state: "running", currentTask: "task A", currentTaskMessageId: "msg-5" });
		const msg = makeMessage({ kind: "info", to: "worker-1" });
		const result = applyIncomingMessageState(member, msg);
		expect(result.state).toBe("running");
		expect(result.currentTask).toBe("task A");
	});

	it("ignores message not targeted to the member", () => {
		const member = makeMember({ state: "idle" });
		const msg = makeMessage({ kind: "task", to: "worker-2" });
		const result = applyIncomingMessageState(member, msg);
		expect(result).toBe(member); // same reference
	});
});

// ── applyOutgoingMessageState ──────────────────────────────────────────────

describe("applyOutgoingMessageState", () => {
	it("transitions to idle on completion matching replyTo", () => {
		const member = makeMember({ state: "running", currentTask: "task A", currentTaskMessageId: "msg-5" });
		const msg = makeMessage({ kind: "completion", from: "worker-1", replyTo: "msg-5", summary: "Done" });
		const result = applyOutgoingMessageState(member, msg);
		expect(result.state).toBe("idle");
		expect(result.lastCompletedTask).toBe("Done");
		expect(result.currentTask).toBeNull();
		expect(result.currentTaskMessageId).toBeNull();
	});

	it("transitions to idle on error matching replyTo, preserves lastError", () => {
		const member = makeMember({ state: "running", currentTask: "task A", currentTaskMessageId: "msg-5" });
		const msg = makeMessage({ kind: "error", from: "worker-1", replyTo: "msg-5", summary: "Failed" });
		const result = applyOutgoingMessageState(member, msg);
		expect(result.state).toBe("idle");
		expect(result.lastError).toBe("Failed");
		expect(result.currentTask).toBeNull();
		expect(result.currentTaskMessageId).toBeNull();
	});

	it("does NOT change state on stale completion replyTo", () => {
		const member = makeMember({ state: "running", currentTask: "task A", currentTaskMessageId: "msg-5" });
		const msg = makeMessage({ kind: "completion", from: "worker-1", replyTo: "msg-99" });
		const result = applyOutgoingMessageState(member, msg);
		expect(result).toBe(member); // same reference
	});

	it("does NOT change state on stale error replyTo", () => {
		const member = makeMember({ state: "running", currentTask: "task A", currentTaskMessageId: "msg-5" });
		const msg = makeMessage({ kind: "error", from: "worker-1", replyTo: "msg-99" });
		const result = applyOutgoingMessageState(member, msg);
		expect(result).toBe(member);
	});

	it("does NOT change state when message has no replyTo", () => {
		const member = makeMember({ state: "running", currentTask: "task A", currentTaskMessageId: "msg-5" });
		const msg = makeMessage({ kind: "completion", from: "worker-1", replyTo: null });
		const result = applyOutgoingMessageState(member, msg);
		expect(result).toBe(member);
	});

	it("does NOT change state when message is from a different member", () => {
		const member = makeMember({ state: "running", currentTask: "task A", currentTaskMessageId: "msg-5" });
		const msg = makeMessage({ kind: "completion", from: "worker-2", replyTo: "msg-5" });
		const result = applyOutgoingMessageState(member, msg);
		expect(result).toBe(member);
	});
});

// ── formatRoomMessageContent ───────────────────────────────────────────────

describe("formatRoomMessageContent", () => {
	it("formats a message with all fields", () => {
		const msg = makeMessage({
			seq: 7,
			from: "owner",
			to: "worker-1",
			summary: "Task summary",
			content: "Full content here",
			replyTo: "msg-3",
			mentions: ["worker-1"],
		});
		const formatted = formatRoomMessageContent(msg, 3);
		expect(formatted).toContain("Seq: #7");
		expect(formatted).toContain("From: owner");
		expect(formatted).toContain("To: worker-1");
		expect(formatted).toContain("Summary: Task summary");
		expect(formatted).toContain("ReplyTo: #3");
		expect(formatted).toContain("Mentions: worker-1");
		expect(formatted).toContain("Full content here");
	});

	it("omits ReplyTo line when message has no replyTo", () => {
		const msg = makeMessage({ replyTo: null });
		const formatted = formatRoomMessageContent(msg, undefined);
		expect(formatted).not.toContain("ReplyTo:");
	});

	it("omits Mentions line when mentions are empty", () => {
		const msg = makeMessage({ mentions: [] });
		const formatted = formatRoomMessageContent(msg);
		expect(formatted).not.toContain("Mentions:");
	});

	it("omits content block when content is empty", () => {
		const msg = makeMessage({ content: "" });
		const formatted = formatRoomMessageContent(msg);
		// Should omit the blank-content block but include the task reply instruction
		expect(formatted).not.toContain("\n\nHello");
		expect(formatted).toContain("crew_reply(seq=#1");
	});

	it("omits content block when content is whitespace only", () => {
		const msg = makeMessage({ content: "   " });
		const formatted = formatRoomMessageContent(msg);
		expect(formatted).not.toContain("\n\nHello");
		expect(formatted).toContain("crew_reply(seq=#1");
	});

	it("includes blank line and content body when content is provided", () => {
		const msg = makeMessage({ content: "Hello world" });
		const formatted = formatRoomMessageContent(msg);
		expect(formatted).toContain("\n\nHello world");
	});

	it("formats member identities with display labels when a formatter is provided", () => {
		const msg = makeMessage({
			from: "worker_1234",
			to: "reviewer_5678",
			mentions: ["worker_1234"],
		});
		const formatted = formatRoomMessageContent(msg, undefined, (name) => {
			if (name === "worker_1234") return "worker#1234";
			if (name === "reviewer_5678") return "reviewer#5678";
			return name;
		});
		expect(formatted).toContain("From: worker#1234");
		expect(formatted).toContain("To: reviewer#5678");
		expect(formatted).toContain("Mentions: worker#1234");
	});

	// ── content pagination ─────────────────────────────────────────────

	it("limits content to first N lines and appends continuation notice", () => {
		const msg = makeMessage({ content: "line1\nline2\nline3\nline4\nline5" });
		const formatted = formatRoomMessageContent(msg, undefined, undefined, { limit: 2 });
		expect(formatted).toContain("line1\nline2");
		expect(formatted).not.toContain("line3");
		expect(formatted).toContain("[Lines 1-2 of 5. Use offset=3 to continue.]");
	});

	it("returns full content when limit exceeds total lines", () => {
		const msg = makeMessage({ content: "a\nb\nc" });
		const formatted = formatRoomMessageContent(msg, undefined, undefined, { limit: 10 });
		expect(formatted).toContain("a\nb\nc");
		expect(formatted).not.toContain("Use offset");
	});

	it("starts at offset and returns remaining content", () => {
		const msg = makeMessage({ content: "line1\nline2\nline3\nline4\nline5" });
		const formatted = formatRoomMessageContent(msg, undefined, undefined, { offset: 3 });
		expect(formatted).toContain("line3\nline4\nline5");
		expect(formatted).not.toContain("line1");
		expect(formatted).not.toContain("line2");
		expect(formatted).toContain("[Lines 3-5 of 5.]");
	});

	it("combines offset and limit for a slice from the middle", () => {
		const msg = makeMessage({ content: "line1\nline2\nline3\nline4\nline5" });
		const formatted = formatRoomMessageContent(msg, undefined, undefined, { offset: 2, limit: 2 });
		expect(formatted).toContain("line2\nline3");
		expect(formatted).not.toContain("line1");
		expect(formatted).not.toContain("line4");
		expect(formatted).toContain("[Lines 2-3 of 5. Use offset=4 to continue.]");
	});

	it("returns empty content when offset is beyond end", () => {
		const msg = makeMessage({ content: "a\nb" });
		const formatted = formatRoomMessageContent(msg, undefined, undefined, { offset: 5 });
		expect(formatted).toContain("[Offset 5 is beyond end of content (2 lines total).]");
	});

	it("returns last N lines in tail mode", () => {
		const msg = makeMessage({ content: "line1\nline2\nline3\nline4\nline5" });
		const formatted = formatRoomMessageContent(msg, undefined, undefined, { limit: 2, tail: true });
		expect(formatted).toContain("line4\nline5");
		expect(formatted).not.toContain("line1");
		expect(formatted).not.toContain("line2");
		expect(formatted).toContain("[Last 2 lines of 5. Use offset=1 to read from beginning.]");
	});

	it("returns all lines in tail mode when limit >= total", () => {
		const msg = makeMessage({ content: "a\nb\nc" });
		const formatted = formatRoomMessageContent(msg, undefined, undefined, { limit: 10, tail: true });
		expect(formatted).toContain("a\nb\nc");
		expect(formatted).not.toContain("Last");
	});

	it("tail mode ignores offset", () => {
		const msg = makeMessage({ content: "line1\nline2\nline3" });
		const formatted = formatRoomMessageContent(msg, undefined, undefined, { offset: 2, limit: 1, tail: true });
		expect(formatted).toContain("line3");
		expect(formatted).not.toContain("line2");
	});

	it("returns full content when no options are provided", () => {
		const msg = makeMessage({ content: "line1\nline2\nline3" });
		const formatted = formatRoomMessageContent(msg, undefined, undefined, {});
		expect(formatted).toContain("line1\nline2\nline3");
		expect(formatted).not.toContain("Use offset");
	});

	it("offset=1 with no limit returns full content without continuation", () => {
		const msg = makeMessage({ content: "a\nb\nc" });
		const formatted = formatRoomMessageContent(msg, undefined, undefined, { offset: 1 });
		expect(formatted).toContain("a\nb\nc");
		expect(formatted).not.toContain("Use offset");
		expect(formatted).not.toContain("Lines");
	});

	it("continuation notice appears for offset-only reads that end mid-content", () => {
		const msg = makeMessage({ content: "line1\nline2\nline3\nline4" });
		const formatted = formatRoomMessageContent(msg, undefined, undefined, { offset: 2 });
		expect(formatted).toContain("line2\nline3\nline4");
		expect(formatted).toContain("[Lines 2-4 of 4.]");
	});

	it("treats limit=0 as no limit (returns full content)", () => {
		const msg = makeMessage({ content: "line1\nline2\nline3" });
		const formatted = formatRoomMessageContent(msg, undefined, undefined, { limit: 0 });
		expect(formatted).toContain("line1\nline2\nline3");
		expect(formatted).not.toContain("Use offset");
	});
});
