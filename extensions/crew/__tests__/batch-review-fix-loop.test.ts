import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseReviewFixLoopParams, type CrewBatchToolResult } from "../batch.ts";
import { ValidationError } from "../errors.ts";

// ── Module mocks (vi.hoisted for hoisting safety) ────────────

const { mockFindIdleMemberByAlias, mockFormatMemberLabel, mockLoadRoomMemberState, mockListBoardEntries } = vi.hoisted(() => ({
	mockFindIdleMemberByAlias: vi.fn(),
	mockFormatMemberLabel: vi.fn((m: { name: string; type: string }) => m.name),
	mockLoadRoomMemberState: vi.fn(),
	mockListBoardEntries: vi.fn(),
}));

const { mockQueueCrewAdd, mockQueueCrewTell, mockTextResult } = vi.hoisted(() => ({
	mockQueueCrewAdd: vi.fn(),
	mockQueueCrewTell: vi.fn(),
	mockTextResult: vi.fn((text: string, isError?: boolean) => ({
		content: [{ type: "text" as const, text }],
		isError,
	})),
}));

vi.mock("../storage.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../storage.ts")>();
	return {
		...actual,
		findIdleMemberByAlias: mockFindIdleMemberByAlias,
		formatMemberLabel: mockFormatMemberLabel,
		loadRoomMemberState: mockLoadRoomMemberState,
		listBoardEntries: mockListBoardEntries,
	};
});

vi.mock("../tools.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../tools.ts")>();
	return {
		...actual,
		queueCrewAdd: mockQueueCrewAdd,
		queueCrewTell: mockQueueCrewTell,
		textResult: mockTextResult,
	};
});

// ── Helpers ─────────────────────────────────────────────────

function makeMsg(overrides: Record<string, unknown> = {}) {
	const now = new Date().toISOString();
	return {
		seq: (overrides.seq as number) ?? 1,
		id: (overrides.id as string) ?? "msg-1",
		from: (overrides.from as string) ?? "test-member",
		to: (overrides.to as string) ?? "room",
		broadcast: (overrides.broadcast as boolean) ?? false,
		replyTo: (overrides.replyTo as string | null) ?? null,
		kind: (overrides.kind as string) ?? "task",
		summary: (overrides.summary as string) ?? "",
		content: (overrides.content as string | undefined) ?? undefined,
		createdAt: now,
	};
}

function completionMsg(summary: string, content?: string) {
	return makeMsg({ kind: "completion", summary, content });
}

function passMsg() {
	return completionMsg("VERDICT: PASS — looks good");
}

function failMsg(content?: string) {
	return completionMsg("VERDICT: FAIL — needs work", content ?? "some issues");
}

function invalidVerdictMsg() {
	return completionMsg("no verdict here");
}

function errorMsg(summary?: string) {
	return makeMsg({ kind: "error", summary: summary ?? "something went wrong" });
}

function handle(msg: ReturnType<typeof makeMsg>, targetName: string) {
	return { messageId: msg.id, seq: msg.seq, targetName, batchId: null };
}

function makeMember(name: string, type: string) {
	return {
		name,
		displayName: name,
		type,
		backend: "pi" as const,
		runtimeId: "rt-1",
		state: "idle" as const,
		spawnTaskId: "task-1",
		spawnBatchId: null,
		transient: false,
		currentTask: null,
		currentTaskMessageId: null,
		lastCompletedTask: null,
		lastError: null,
		lastSeenSeq: 1,
		joinedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		sessionId: "sess-1",
		bootstrapToken: null,
	};
}

function mockQueuedAdd(name: string) {
	return {
		memberName: name,
		memberLabel: name,
		taskId: "task-1",
		backend: "pi" as const,
		transient: false,
		initialTask: undefined,
		unresolvedMentions: [] as string[],
	};
}

const mockActiveRoom = {
	role: "owner" as const,
	roomDir: "/tmp/test-room",
	roomId: "room-1",
	memberName: "lead",
	sessionId: "session-1",
	shuttingDown: false,
	pollTimer: null as unknown as NodeJS.Timeout,
	heartbeatTimer: null as unknown as NodeJS.Timeout,
	pendingPoll: null,
	pendingHeartbeat: null,
	pendingToolTasks: new Set(),
	pendingDeliveryBatch: [],
	deliveryTimer: null,
};

const mockBatchContext = {
	id: "batch-1",
	silentOwnerDelivery: true,
};

// ── Param Parsing Tests ────────────────────────────────────

describe("parseReviewFixLoopParams", () => {
	it("accepts valid params: reviewer + fixer + initialReviewTask", () => {
		const result = parseReviewFixLoopParams({
			reviewer: { name: "rev", type: "worker" },
			fixer: { name: "fix", type: "worker" },
			initialReviewTask: "Review this code",
		});
		expect(result.reviewer).toEqual({ name: "rev", type: "worker" });
		expect(result.fixer).toEqual({ name: "fix", type: "worker" });
		expect(result.initialReviewTask).toBe("Review this code");
		expect(result.maxRounds).toBe(3);
	});

	it("defaults maxRounds to 3 when omitted", () => {
		const result = parseReviewFixLoopParams({
			reviewer: { name: "rev", type: "worker" },
			fixer: { name: "fix", type: "worker" },
			initialReviewTask: "Review this code",
		});
		expect(result.maxRounds).toBe(3);
	});

	it("accepts custom maxRounds", () => {
		const result = parseReviewFixLoopParams({
			reviewer: { name: "rev", type: "worker" },
			fixer: { name: "fix", type: "worker" },
			initialReviewTask: "Review this code",
			maxRounds: 5,
		});
		expect(result.maxRounds).toBe(5);
	});

	it("throws ValidationError when reviewer is missing", () => {
		expect(() =>
			parseReviewFixLoopParams({
				fixer: { name: "fix", type: "worker" },
				initialReviewTask: "Review this code",
			}),
		).toThrow(ValidationError);
	});

	it("throws ValidationError when fixer is missing", () => {
		expect(() =>
			parseReviewFixLoopParams({
				reviewer: { name: "rev", type: "worker" },
				initialReviewTask: "Review this code",
			}),
		).toThrow(ValidationError);
	});

	it("throws ValidationError when initialReviewTask is missing", () => {
		expect(() =>
			parseReviewFixLoopParams({
				reviewer: { name: "rev", type: "worker" },
				fixer: { name: "fix", type: "worker" },
			}),
		).toThrow(ValidationError);
	});

	it("throws ValidationError when initialReviewTask is empty", () => {
		expect(() =>
			parseReviewFixLoopParams({
				reviewer: { name: "rev", type: "worker" },
				fixer: { name: "fix", type: "worker" },
				initialReviewTask: "",
			}),
		).toThrow(ValidationError);
	});

	it("throws ValidationError when maxRounds is 0", () => {
		expect(() =>
			parseReviewFixLoopParams({
				reviewer: { name: "rev", type: "worker" },
				fixer: { name: "fix", type: "worker" },
				initialReviewTask: "Review this code",
				maxRounds: 0,
			}),
		).toThrow(ValidationError);
	});

	it("throws ValidationError when maxRounds is negative", () => {
		expect(() =>
			parseReviewFixLoopParams({
				reviewer: { name: "rev", type: "worker" },
				fixer: { name: "fix", type: "worker" },
				initialReviewTask: "Review this code",
				maxRounds: -1,
			}),
		).toThrow(ValidationError);
	});

	it("throws ValidationError for unexpected param keys", () => {
		expect(() =>
			parseReviewFixLoopParams({
				reviewer: { name: "rev", type: "worker" },
				fixer: { name: "fix", type: "worker" },
				initialReviewTask: "Review this code",
				unexpectedKey: "value",
			}),
		).toThrow(ValidationError);
	});

	it("throws ValidationError when reviewer is not an object", () => {
		expect(() =>
			parseReviewFixLoopParams({
				reviewer: "not-an-object",
				fixer: { name: "fix", type: "worker" },
				initialReviewTask: "Review this code",
			}),
		).toThrow(ValidationError);
	});

	it("throws ValidationError when fixer is not an object", () => {
		expect(() =>
			parseReviewFixLoopParams({
				reviewer: { name: "rev", type: "worker" },
				fixer: ["invalid"],
				initialReviewTask: "Review this code",
			}),
		).toThrow(ValidationError);
	});
});

// ── Flow Tests ──────────────────────────────────────────────

describe("executeReviewFixLoop flow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	async function setupBothReady() {
		mockFindIdleMemberByAlias.mockResolvedValue(null);
		mockQueueCrewAdd
			.mockResolvedValueOnce(mockQueuedAdd("reviewer"))
			.mockResolvedValueOnce(mockQueuedAdd("fixer"));

		// Make loadRoomMemberState return idle members so waitForMembersReady finds them instantly
		mockLoadRoomMemberState.mockImplementation(async (_roomDir: string, memberName: string) => {
			if (memberName === "reviewer") return makeMember("reviewer", "worker");
			if (memberName === "fixer") return makeMember("fixer", "worker");
			return null;
		});

		// Make listBoardEntries return empty list so waitForTaskTerminalReplies doesn't poll prematurely
		mockListBoardEntries.mockResolvedValue([]);
	}

	// ── Test 8: Reviewer passes round 1 ────────────────────
	it("reviewer passes round 1 → status passed, finalRound 1", async () => {
		await setupBothReady();

		const r1Msg = makeMsg({ id: "r1-msg", seq: 2, from: "lead", to: "reviewer" });
		mockQueueCrewTell.mockResolvedValueOnce({ message: r1Msg, unresolvedMentions: [] });

		// listBoardEntries returns the reviewer's pass reply
		const pass = passMsg();
		pass.replyTo = r1Msg.id;
		mockListBoardEntries.mockResolvedValue([pass]);

		const batch = await import("../batch.ts");

		const result = await batch.executeReviewFixLoop(
			{ reviewer: { name: "reviewer", type: "worker" }, fixer: { name: "fixer", type: "worker" }, initialReviewTask: "Review this" },
			mockActiveRoom as any,
			{} as any,
			{ pi: {} as any, paseo: {} as any },
			mockBatchContext,
		) as CrewBatchToolResult;

		const text = result.content[0].text;
		expect(text).toContain("status: passed");
		expect(text).toContain("rounds: 1/3");
	});

	// ── Test 9: Reviewer protocol failure r1 ───────────────
	it("reviewer protocol failure round 1 → protocol-failed", async () => {
		await setupBothReady();

		const r1Msg = makeMsg({ id: "r1-msg", seq: 2, from: "lead", to: "reviewer" });
		mockQueueCrewTell.mockResolvedValueOnce({ message: r1Msg, unresolvedMentions: [] });

		const invalid = invalidVerdictMsg();
		invalid.replyTo = r1Msg.id;
		mockListBoardEntries.mockResolvedValue([invalid]);

		const batch = await import("../batch.ts");

		const result = await batch.executeReviewFixLoop(
			{ reviewer: { name: "reviewer", type: "worker" }, fixer: { name: "fixer", type: "worker" }, initialReviewTask: "Review this" },
			mockActiveRoom as any,
			{} as any,
			{ pi: {} as any, paseo: {} as any },
			mockBatchContext,
		) as CrewBatchToolResult;

		const text = result.content[0].text;
		expect(text).toContain("status: protocol-failed");
		expect(text).toContain("rounds: 1/3");
	});

	// ── Test 12: Setup failure (fixer queue fails) ──────────
	it("fixer queue fails → setup-failed", async () => {
		mockFindIdleMemberByAlias.mockResolvedValue(null);
		mockQueueCrewAdd.mockResolvedValueOnce(mockQueuedAdd("reviewer"));
		mockQueueCrewAdd.mockRejectedValueOnce(new Error("fixer spawn failed"));

		const batch = await import("../batch.ts");

		const result = await batch.executeReviewFixLoop(
			{ reviewer: { name: "reviewer", type: "worker" }, fixer: { name: "fixer", type: "worker" }, initialReviewTask: "Review this" },
			mockActiveRoom as any,
			{} as any,
			{ pi: {} as any, paseo: {} as any },
			mockBatchContext,
		) as CrewBatchToolResult;

		const text = result.content[0].text;
		expect(text).toContain("status: setup-failed");
		expect(text).toContain("rounds: 0/3");
		expect(text).toContain("fixer fixer could not be queued");
	});

	// ── Test 15: Reviewer not ready ─────────────────────────
	it("reviewer not ready → ready-timeout", async () => {
		mockFindIdleMemberByAlias.mockResolvedValue(null);
		mockQueueCrewAdd
			.mockResolvedValueOnce(mockQueuedAdd("reviewer"))
			.mockResolvedValueOnce(mockQueuedAdd("fixer"));

		// Make loadRoomMemberState return fixer but NOT reviewer
		// waitForMembersReady with no timeout will poll until deadline null → infinite
		// But the function checks if member state is "idle" or "running".
		// If we return an error state, it marks as "failed"
		mockLoadRoomMemberState.mockImplementation(async (_roomDir: string, memberName: string) => {
			if (memberName === "reviewer") return { ...makeMember("reviewer", "worker"), state: "error" as const, lastError: "spawn crashed" };
			if (memberName === "fixer") return makeMember("fixer", "worker");
			return null;
		});

		const batch = await import("../batch.ts");

		const result = await batch.executeReviewFixLoop(
			{ reviewer: { name: "reviewer", type: "worker" }, fixer: { name: "fixer", type: "worker" }, initialReviewTask: "Review this" },
			mockActiveRoom as any,
			{} as any,
			{ pi: {} as any, paseo: {} as any },
			mockBatchContext,
		) as CrewBatchToolResult;

		const text = result.content[0].text;
		expect(text).toContain("status: ready-timeout");
		expect(text).toContain("rounds: 0/3");
	});
});
