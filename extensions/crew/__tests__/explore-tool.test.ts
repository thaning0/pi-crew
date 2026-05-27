import { describe, it, expect } from "vitest";
import { ExploreSchema, CrewMessagesSchema } from "../schemas.ts";
import type { RoomMemberState, RoomMessage } from "../types.ts";

// --- Helpers ---

function makeMsg(overrides: Partial<RoomMessage> = {}): RoomMessage {
    return {
        seq: 1,
        id: "msg-1",
        from: "test-agent",
        to: "room",
        kind: "info",
        summary: "test",
        broadcast: false,
        replyTo: null,
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

function makeMember(overrides: Partial<RoomMemberState> = {}): RoomMemberState {
    return {
        name: "test-agent",
        displayName: null,
        type: "default",
        backend: "pi",
        runtimeId: null,
        state: "idle",
        spawnTaskId: null,
        currentTask: null,
        lastCompletedTask: null,
        lastError: null,
        lastSeenSeq: 0,
        joinedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sessionId: null,
        ...overrides,
    };
}

/**
 * Pure function: filter board entries to only those from explorer-typed members.
 * Mirrors the filter logic in executeCrewMessages.
 */
function filterExplorerMessages(
    entries: RoomMessage[],
    members: RoomMemberState[],
): RoomMessage[] {
    const explorerNames = new Set(
        members
            .filter((m) => m.type === "explorer")
            .map((m) => m.name),
    );
    return entries.filter((e) => explorerNames.has(e.from));
}

// --- Tests ---

describe("ExploreSchema", () => {
    it("validates and accepts a valid query object", () => {
        expect(ExploreSchema.type).toBe("object");
        expect(ExploreSchema.required).toEqual(["query"]);
        expect(ExploreSchema.additionalProperties).toBe(false);

        const propQuery = ExploreSchema.properties?.query;
        expect(propQuery).toBeDefined();
        expect((propQuery as { type: string }).type).toBe("string");
    });

    it("rejects missing query parameter via schema required field", () => {
        expect(ExploreSchema.required).toContain("query");
    });

    it("rejects extra properties via additionalProperties:false", () => {
        expect(ExploreSchema.additionalProperties).toBe(false);
    });
});

describe("CrewMessagesSchema filter enum", () => {
    it("includes 'explorer' in filter enum options", () => {
        const filterEnum = (CrewMessagesSchema.properties?.filter as { enum: string[] }).enum;
        expect(filterEnum).toContain("explorer");
    });
});

describe("filterExplorerMessages (core logic)", () => {
    it("returns empty when no explorer members exist", () => {
        const entries = [makeMsg({ from: "agent-a" })];
        const members = [makeMember({ name: "agent-a", type: "default" })];
        expect(filterExplorerMessages(entries, members)).toEqual([]);
    });

    it("filters to only explorer-typed member messages", () => {
        const members = [
            makeMember({ name: "agent-a", type: "default" }),
            makeMember({ name: "explorer_abc", type: "explorer" }),
            makeMember({ name: "explorer_def", type: "explorer" }),
        ];
        const entries = [
            makeMsg({ seq: 1, from: "agent-a", summary: "not explorer" }),
            makeMsg({ seq: 2, from: "explorer_abc", summary: "explorer result 1" }),
            makeMsg({ seq: 3, from: "explorer_def", summary: "explorer result 2" }),
            makeMsg({ seq: 4, from: "agent-a", summary: "another" }),
        ];

        const result = filterExplorerMessages(entries, members);
        expect(result).toHaveLength(2);
        expect(result[0].summary).toBe("explorer result 1");
        expect(result[1].summary).toBe("explorer result 2");
    });

    it("returns empty when explorers exist but have no messages", () => {
        const members = [
            makeMember({ name: "explorer_abc", type: "explorer" }),
        ];
        const entries = [
            makeMsg({ seq: 1, from: "agent-a", summary: "owner message" }),
        ];
        expect(filterExplorerMessages(entries, members)).toEqual([]);
    });

    it("includes messages regardless of kind (info, completion, error)", () => {
        const members = [
            makeMember({ name: "explorer_abc", type: "explorer" }),
        ];
        const entries = [
            makeMsg({ seq: 1, from: "explorer_abc", kind: "info" }),
            makeMsg({ seq: 2, from: "explorer_abc", kind: "completion" }),
            makeMsg({ seq: 3, from: "explorer_abc", kind: "error" }),
        ];
        expect(filterExplorerMessages(entries, members)).toHaveLength(3);
    });
});

describe("silent: the message contract", () => {
    it("RoomMessage.silent field exists and accepts true", () => {
        const msg: RoomMessage = {
            seq: 1,
            id: "msg-1",
            from: "explorer_abc",
            to: "room",
            kind: "task",
            summary: "find auth module",
            broadcast: false,
            replyTo: null,
            createdAt: new Date().toISOString(),
            silent: true,
        };
        expect(msg.silent).toBe(true);
    });
});
