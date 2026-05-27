import { describe, it, expect } from "vitest";

describe("explore tool", () => {
    describe("ExploreSchema", () => {
        it.todo("validates and accepts a query string");
        it.todo("rejects missing query parameter");
        it.todo("rejects extra properties");
    });

    describe("executeExplore", () => {
        it.todo("returns error when query is empty");
        it.todo("returns error when no active room");
        it.todo("emits crew:add event with explorer payload");
    });

    describe("crew_messages filter=explorer", () => {
        it.todo("filters to only explorer-typed member messages");
        it.todo("returns (empty) when no explorer members exist");
        it.todo("returns (empty) when explorers exist but have no messages");
    });

    describe("silent spawn integration", () => {
        it.todo("initial task message has silent=true");
        it.todo("transient member lifecycle suppresses agent-ready notification");
        it.todo("explorer crew_reply is delivered normally (not silent)");
    });
});
