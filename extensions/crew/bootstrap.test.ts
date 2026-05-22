import { describe, it, expect } from "vitest";
import * as agentDefinitionsModule from "./agent-defs.ts";
import {
	parseRoomBootstrapBlock,
	buildRoomBootstrapBlock,
	buildRoomMemberSystemPrompt,
	loadTypedRoomAgentDefinition,
	listRoomAgentTypes,
} from "./bootstrap.ts";
import type { RoomBootstrap } from "./types.ts";

const validBootstrap: RoomBootstrap = {
	version: 1,
	roomId: "room-abc-123",
	roomDir: "/tmp/rooms/room-abc-123",
	memberName: "worker-1",
	memberType: "worker",
	ownerName: "owner",
	ownerSessionId: "session-xyz",
	token: "token-secret",
	spawnTaskId: "spawn-task-42",
};

// ── parseRoomBootstrapBlock ────────────────────────────────────────────────

describe("parseRoomBootstrapBlock", () => {
	it("parses a valid bootstrap block correctly", () => {
		const block = buildRoomBootstrapBlock(validBootstrap);
		const parsed = parseRoomBootstrapBlock(block);
		expect(parsed).not.toBeNull();
		expect(parsed!.version).toBe(1);
		expect(parsed!.roomId).toBe("room-abc-123");
		expect(parsed!.roomDir).toBe("/tmp/rooms/room-abc-123");
		expect(parsed!.memberName).toBe("worker-1");
		expect(parsed!.memberType).toBe("worker");
		expect(parsed!.ownerName).toBe("owner");
		expect(parsed!.ownerSessionId).toBe("session-xyz");
		expect(parsed!.token).toBe("token-secret");
		expect(parsed!.spawnTaskId).toBe("spawn-task-42");
	});

	it("parses a bootstrap block with null spawnTaskId", () => {
		const b = { ...validBootstrap, spawnTaskId: null };
		const block = buildRoomBootstrapBlock(b);
		const parsed = parseRoomBootstrapBlock(block);
		expect(parsed).not.toBeNull();
		expect(parsed!.spawnTaskId).toBeNull();
	});

	it("parses a bootstrap block with undefined spawnTaskId", () => {
		const { spawnTaskId: _, ...withoutSpawn } = validBootstrap;
		const b = withoutSpawn as RoomBootstrap;
		const block = buildRoomBootstrapBlock(b);
		const parsed = parseRoomBootstrapBlock(block);
		expect(parsed).not.toBeNull();
		expect(parsed!.spawnTaskId).toBeUndefined();
	});

	it("returns null for null input", () => {
		expect(parseRoomBootstrapBlock(null)).toBeNull();
	});

	it("returns null for undefined input", () => {
		expect(parseRoomBootstrapBlock(undefined)).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseRoomBootstrapBlock("")).toBeNull();
	});

	it("returns null when start marker is missing", () => {
		const block = buildRoomBootstrapBlock(validBootstrap);
		// Remove the opening marker
		const tampered = block.replace("<!-- PI_ROOM_BOOTSTRAP", "<!-- WRONG_MARKER");
		expect(parseRoomBootstrapBlock(tampered)).toBeNull();
	});

	it("returns null when end marker is missing", () => {
		const block = buildRoomBootstrapBlock(validBootstrap);
		// Remove the closing marker
		const tampered = block.replace("PI_ROOM_BOOTSTRAP -->", "WRONG_END");
		expect(parseRoomBootstrapBlock(tampered)).toBeNull();
	});

	it("returns null for invalid JSON in the block", () => {
		const invalidBlock = "<!-- PI_ROOM_BOOTSTRAP\n{not valid json}\nPI_ROOM_BOOTSTRAP -->";
		expect(parseRoomBootstrapBlock(invalidBlock)).toBeNull();
	});

	it("returns null for valid JSON that is not a RoomBootstrap (wrong version)", () => {
		const wrongVersion = {
			...validBootstrap,
			version: 2,
		};
		const block = `<!-- PI_ROOM_BOOTSTRAP\n${JSON.stringify(wrongVersion)}\nPI_ROOM_BOOTSTRAP -->`;
		expect(parseRoomBootstrapBlock(block)).toBeNull();
	});

	it("returns null for valid JSON with missing required fields", () => {
		const incomplete = { version: 1, roomId: "x" };
		const block = `<!-- PI_ROOM_BOOTSTRAP\n${JSON.stringify(incomplete)}\nPI_ROOM_BOOTSTRAP -->`;
		expect(parseRoomBootstrapBlock(block)).toBeNull();
	});

	it("returns null for valid JSON that is not an object", () => {
		const block = `<!-- PI_ROOM_BOOTSTRAP\n"just a string"\nPI_ROOM_BOOTSTRAP -->`;
		expect(parseRoomBootstrapBlock(block)).toBeNull();
	});

	it("returns null for null JSON value", () => {
		const block = `<!-- PI_ROOM_BOOTSTRAP\nnull\nPI_ROOM_BOOTSTRAP -->`;
		expect(parseRoomBootstrapBlock(block)).toBeNull();
	});

	it("parses bootstrap from within a larger system prompt", () => {
		const block = buildRoomBootstrapBlock(validBootstrap);
		const systemPrompt = [
			"You are a helper.",
			"IMPORTANT: Follow the rules.",
			block,
		].join("\n\n");
		const parsed = parseRoomBootstrapBlock(systemPrompt);
		expect(parsed).not.toBeNull();
		expect(parsed!.memberName).toBe("worker-1");
	});
});

// ── buildRoomBootstrapBlock ────────────────────────────────────────────────

describe("buildRoomBootstrapBlock", () => {
	it("round-trips through parseRoomBootstrapBlock", () => {
		const block = buildRoomBootstrapBlock(validBootstrap);
		const parsed = parseRoomBootstrapBlock(block);
		expect(parsed).toEqual(validBootstrap);
	});

	it("starts with the start marker", () => {
		const block = buildRoomBootstrapBlock(validBootstrap);
		expect(block.startsWith("<!-- PI_ROOM_BOOTSTRAP\n")).toBe(true);
	});

	it("ends with the end marker", () => {
		const block = buildRoomBootstrapBlock(validBootstrap);
		expect(block.endsWith("\nPI_ROOM_BOOTSTRAP -->")).toBe(true);
	});

	it("contains valid JSON between markers", () => {
		const block = buildRoomBootstrapBlock(validBootstrap);
		const inner = block
			.replace("<!-- PI_ROOM_BOOTSTRAP\n", "")
			.replace("\nPI_ROOM_BOOTSTRAP -->", "");
		const parsed = JSON.parse(inner);
		expect(parsed.version).toBe(1);
		expect(parsed.memberName).toBe("worker-1");
	});

	it("round-trips with null spawnTaskId", () => {
		const b = { ...validBootstrap, spawnTaskId: null };
		const block = buildRoomBootstrapBlock(b);
		const parsed = parseRoomBootstrapBlock(block);
		expect(parsed).toEqual(b);
	});
});

// ── buildRoomMemberSystemPrompt ────────────────────────────────────────────

describe("buildRoomMemberSystemPrompt", () => {
	it("includes the bootstrap block", () => {
		const prompt = buildRoomMemberSystemPrompt(validBootstrap);
		expect(prompt).toContain("<!-- PI_ROOM_BOOTSTRAP");
		expect(prompt).toContain("PI_ROOM_BOOTSTRAP -->");
	});

	it("includes the member name and type", () => {
		const prompt = buildRoomMemberSystemPrompt(validBootstrap);
		expect(prompt).toContain('"worker-1"');
		expect(prompt).toContain('"worker"');
		expect(prompt).toContain('"room-abc-123"');
	});

	it("includes the room-member skill body", () => {
		const prompt = buildRoomMemberSystemPrompt(validBootstrap);
		expect(prompt).toContain("close the loop");
		expect(prompt).toContain("crew_reply");
	});

	it("includes role-specific instructions when agent definition is available", () => {
		const prompt = buildRoomMemberSystemPrompt(validBootstrap);
		// The worker agent definition should inject "Your Role-Specific Instructions"
		expect(prompt).toContain("Your Role-Specific Instructions");
		expect(prompt).toContain("worker agent");
	});

	it("does NOT include role-specific heading when agent has no systemPrompt", () => {
		// Pass a typed agent with null systemPrompt
		const prompt = buildRoomMemberSystemPrompt(validBootstrap, {
			type: "worker",
			systemPrompt: null,
		});
		expect(prompt).not.toContain("Your Role-Specific Instructions");
	});

	it("can be parsed back from the full system prompt", () => {
		const prompt = buildRoomMemberSystemPrompt(validBootstrap);
		const parsed = parseRoomBootstrapBlock(prompt);
		expect(parsed).toEqual(validBootstrap);
	});

	it("does not produce blank sections when skill body is empty (fallback)", () => {
		// buildRoomMemberSystemPrompt filters empty sections — test that it's still valid
		const prompt = buildRoomMemberSystemPrompt(validBootstrap);
		// Should not have double newlines where sections were omitted
		expect(prompt).not.toContain("\n\n\n");
	});

	it("works with spawnTaskId missing", () => {
		const { spawnTaskId: _, ...b } = validBootstrap;
		const prompt = buildRoomMemberSystemPrompt(b as RoomBootstrap);
		const parsed = parseRoomBootstrapBlock(prompt);
		expect(parsed).not.toBeNull();
		expect(parsed!.memberName).toBe("worker-1");
	});
});

// ── loadTypedRoomAgentDefinition ───────────────────────────────────────────

describe("loadTypedRoomAgentDefinition", () => {
	it("loads an existing agent type (worker)", () => {
		const def = loadTypedRoomAgentDefinition("worker");
		expect(def).not.toBeNull();
		expect(def!.type).toBe("worker");
		expect(def!.systemPrompt).toBeTruthy();
		expect(def!.systemPrompt).toContain("worker agent");
	});

	it("returns null for a non-existent agent type", () => {
		const def = loadTypedRoomAgentDefinition("nonexistent-agent-type-xyz");
		expect(def).toBeNull();
	});

	it("returns null for an empty string type", () => {
		const def = loadTypedRoomAgentDefinition("");
		expect(def).toBeNull();
	});

	it("normalizes whitespace in agent type", () => {
		const def = loadTypedRoomAgentDefinition("  worker  ");
		expect(def).not.toBeNull();
		expect(def!.type).toBe("worker");
	});

	it("loads another existing agent type (explorer)", () => {
		const def = loadTypedRoomAgentDefinition("explorer");
		expect(def).not.toBeNull();
		expect(def!.type).toBe("explorer");
	});

	it("loads worker worktree opt-in from frontmatter", () => {
		const def = loadTypedRoomAgentDefinition("worker");
		expect((def as { worktree?: boolean } | null)?.worktree ?? false).toBe(true);
	});

	it("parses explicit worktree frontmatter", () => {
		const parsed = (agentDefinitionsModule as { parseAgentDefinitionForTest?: (content: string) => { worktree?: boolean } }).parseAgentDefinitionForTest?.(`---\nworktree: true\n---\nbody`);
		expect(parsed?.worktree).toBe(true);
	});

	it("defaults worktree to false when frontmatter omits it", () => {
		const parsed = (agentDefinitionsModule as { parseAgentDefinitionForTest?: (content: string) => { worktree?: boolean } }).parseAgentDefinitionForTest?.(`---\nname: custom\n---\nbody`);
		expect(parsed?.worktree ?? false).toBe(false);
	});
});

// ── listRoomAgentTypes ─────────────────────────────────────────────────────

describe("listRoomAgentTypes", () => {
	it("returns a non-empty array", () => {
		const types = listRoomAgentTypes();
		expect(Array.isArray(types)).toBe(true);
		expect(types.length).toBeGreaterThan(0);
	});

	it("includes worker in the list", () => {
		const types = listRoomAgentTypes();
		const worker = types.find((t) => t.type === "worker");
		expect(worker).toBeDefined();
		expect(worker!.description).toBeTruthy();
	});
});
