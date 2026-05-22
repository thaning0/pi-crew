import { loadAgentDefinition, listAgentTypes, type AgentDefinition } from "./agent-defs.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RoomBootstrap } from "./types.ts";

const START_MARKER = "<!-- PI_ROOM_BOOTSTRAP";
const END_MARKER = "PI_ROOM_BOOTSTRAP -->";
/** Marker embedded in room member system prompt so session_start can filter
 *  tools even before the bootstrap block is available (paseo timing). */
const TOOLS_MARKER = "<!-- PI_ROOM_TOOLS:";
const TOOLS_MARKER_END = "PI_ROOM_TOOLS -->";

let roomMemberSkillBody: string | null = null;

function getRoomMemberSkillBody(): string {
	if (roomMemberSkillBody !== null) return roomMemberSkillBody;
	try {
		const skillPath = fileURLToPath(new URL("../../skills/room-member/SKILL.md", import.meta.url));
		const raw = readFileSync(skillPath, "utf8");
		// Strip YAML frontmatter (--- ... ---)
		roomMemberSkillBody = raw.replace(/^---[\s\S]*?---\n*/, "").trim();
	} catch {
		roomMemberSkillBody = "";
	}
	return roomMemberSkillBody;
}

export type TypedRoomAgentDefinition = AgentDefinition;

export function loadTypedRoomAgentDefinition(memberType: string): TypedRoomAgentDefinition | null {
	return loadAgentDefinition(memberType);
}

export function listRoomAgentTypes(): Array<{ type: string; description: string; tools?: string[] }> {
	return listAgentTypes();
}

function isRoomBootstrap(value: unknown): value is RoomBootstrap {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.version === 1 &&
		typeof candidate.roomId === "string" &&
		typeof candidate.roomDir === "string" &&
		typeof candidate.memberName === "string" &&
		typeof candidate.memberType === "string" &&
		typeof candidate.ownerName === "string" &&
		typeof candidate.ownerSessionId === "string" &&
		typeof candidate.token === "string" &&
		(candidate.spawnTaskId === undefined || candidate.spawnTaskId === null || typeof candidate.spawnTaskId === "string")
	);
}

export function buildRoomBootstrapBlock(bootstrap: RoomBootstrap): string {
	return `${START_MARKER}\n${JSON.stringify(bootstrap)}\n${END_MARKER}`;
}

export function buildRoomMemberSystemPrompt(
	bootstrap: RoomBootstrap,
	typedAgent: TypedRoomAgentDefinition | null = loadTypedRoomAgentDefinition(bootstrap.memberType),
	memberLabel?: string,
): string {
	const skillBody = getRoomMemberSkillBody();
	const crewMessageToolNames = ["crew_tell", "crew_messages", "crew_reply", "crew_read", "crew_who", "crew_tasks"];
	const allowedTools = typedAgent?.tools && typedAgent.tools.length > 0
		? [...new Set([...typedAgent.tools, ...crewMessageToolNames])]
		: null;
	return [
		`You are "${bootstrap.memberName}", a room member of type "${bootstrap.memberType}" in coordination room "${bootstrap.roomId}".`,
		memberLabel && memberLabel !== bootstrap.memberName
			? `Your user-facing room label is "${memberLabel}". Use the internal room member name "${bootstrap.memberName}" for protocol and bootstrap operations.`
			: null,
		`IMPORTANT: When your task is complete, report results via crew_reply — use summary for a one-line result, and content for the full report. Do not describe your final results in plain text; that output is not automatically delivered to the task owner. During work, normal tool use and progress output is fine.`,
		skillBody || null,
		typedAgent?.systemPrompt ? `---\n## Your Role-Specific Instructions\n${typedAgent.systemPrompt}` : null,
		// Embed allowed tools as a marker so session_start can filter even
		// before the bootstrap block is parsed (needed for paseo timing).
		allowedTools ? `${TOOLS_MARKER}${allowedTools.join(",")}${TOOLS_MARKER_END}` : null,
		buildRoomBootstrapBlock(bootstrap),
	].filter((section): section is string => Boolean(section && section.trim().length > 0)).join("\n\n");
}

/** Parse the tools marker embedded by buildRoomMemberSystemPrompt.
 *  Returns allowed tool names, or null if no marker found. */
export function parseRoomToolsMarker(systemPrompt: string | null | undefined): string[] | null {
	if (!systemPrompt) return null;
	const startIndex = systemPrompt.indexOf(TOOLS_MARKER);
	if (startIndex === -1) return null;
	const contentStart = startIndex + TOOLS_MARKER.length;
	const endIndex = systemPrompt.indexOf(TOOLS_MARKER_END, contentStart);
	if (endIndex === -1) return null;
	const raw = systemPrompt.slice(contentStart, endIndex).trim();
	if (!raw) return null;
	return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

export function parseRoomBootstrapBlock(systemPrompt: string | null | undefined): RoomBootstrap | null {
	if (!systemPrompt) return null;
	const startIndex = systemPrompt.indexOf(START_MARKER);
	if (startIndex === -1) return null;
	const jsonStart = startIndex + START_MARKER.length;
	const endIndex = systemPrompt.indexOf(END_MARKER, jsonStart);
	if (endIndex === -1) return null;

	const raw = systemPrompt.slice(jsonStart, endIndex).trim();
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw);
		return isRoomBootstrap(parsed) ? parsed : null;
	} catch {
		return null;
	}
}