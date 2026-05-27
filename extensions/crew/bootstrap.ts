import { loadAgentDefinition, listAgentTypes, type AgentDefinition } from "./agent-defs.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RoomBootstrap } from "./types.ts";
import { ROOM_ENV } from "./types.ts";

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

export function loadTypedRoomAgentDefinition(memberType: string, cwd?: string): TypedRoomAgentDefinition | null {
	return loadAgentDefinition(memberType, cwd);
}

export function listRoomAgentTypes(cwd?: string): Array<{ type: string; description: string; tools?: string[] }> {
	return listAgentTypes(cwd);
}

export function buildRoomMemberSystemPrompt(
	bootstrap: RoomBootstrap,
	typedAgent?: TypedRoomAgentDefinition | null,
	memberLabel?: string,
	cwd?: string,
): string {
	const effectiveTypedAgent = typedAgent !== undefined ? typedAgent : loadTypedRoomAgentDefinition(bootstrap.memberType, cwd);
	const skillBody = getRoomMemberSkillBody();
	return [
		`You are "${bootstrap.memberName}", a room member of type "${bootstrap.memberType}" in coordination room "${bootstrap.roomId}".`,
		memberLabel && memberLabel !== bootstrap.memberName
			? `Your user-facing room label is "${memberLabel}". Use the internal room member name "${bootstrap.memberName}" for protocol and bootstrap operations.`
			: null,
		`IMPORTANT: When your task is complete, report results via crew_reply — use summary for a one-line result, and content for the full report. Do not describe your final results in plain text; that output is not automatically delivered to the task owner. During work, normal tool use and progress output is fine.`,
		skillBody || null,
		effectiveTypedAgent?.systemPrompt ? `---\n## Your Role-Specific Instructions\n${effectiveTypedAgent.systemPrompt}` : null,
	].filter((section): section is string => Boolean(section && section.trim().length > 0)).join("\n\n");
}

/** Try to construct a RoomBootstrap from crew-owned environment variables.
 *  Returns null if required env vars are missing (not a room member session).
 *  Plugin-owned opaque passthrough vars such as PI_ROOM_EXTENSION_PAYLOAD are
 *  intentionally left in process.env for other extensions to read directly. */
export function parseRoomBootstrapFromEnv(): RoomBootstrap | null {
	const roomId = process.env[ROOM_ENV.ROOM_ID];
	const roomDir = process.env[ROOM_ENV.ROOM_DIR];
	const memberName = process.env[ROOM_ENV.MEMBER_NAME];
	const memberType = process.env[ROOM_ENV.MEMBER_TYPE];
	const token = process.env[ROOM_ENV.BOOTSTRAP_TOKEN];
	const ownerName = process.env[ROOM_ENV.OWNER_NAME];
	const ownerSessionId = process.env[ROOM_ENV.OWNER_SESSION_ID];

	if (!roomId || !roomDir || !memberName || !memberType) return null;

	return {
		version: 1,
		roomId,
		roomDir,
		memberName,
		memberType,
		ownerName: ownerName ?? "lead",
		ownerSessionId: ownerSessionId ?? "",
		token: token ?? "",
		spawnTaskId: null,
	};
}
