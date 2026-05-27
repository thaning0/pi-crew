import * as path from "node:path";
import type {
	CrewAddReplaySeed,
	RoomMessage,
	RoomMemberState,
	RoomMetadata,
	RoomSpawnJob,
	RoomBootstrap,
	RoomBackend,
	RoomSpawnJobState,
} from "./types.ts";

// ── Protocol Constants ──────────────────────────────────────────────────────

export const PROXY_PROTOCOL_VERSION = 1;
export const PROXY_DISABLE_ENV = "PI_MUTATION_PROXY_DISABLE";

// ── Mutation Commands ────────────────────────────────────────────────────────

export interface ClaimMemberSessionPayload {
	bootstrap: RoomBootstrap;
	sessionId: string | null;
	memberPid?: number | null;
}

export interface FinalizeMemberRuntimePayload {
	memberName: string;
	taskId: string;
	runtimeId: string;
	backend: RoomBackend;
}

export interface SpawnAgentPayload {
	name: string;
	type: string;
	task: string;
	transient: boolean;
	silent: boolean;
}

export type MutationCommand =
	| { kind: "append_message"; payload: { message: Omit<RoomMessage, "seq" | "id" | "createdAt"> & Partial<Pick<RoomMessage, "id" | "createdAt">> } }
	| { kind: "update_member"; payload: { memberName: string; patch: Partial<RoomMemberState> } }
	| { kind: "write_metadata"; payload: { metadata: RoomMetadata } }
	| { kind: "claim_member_session"; payload: ClaimMemberSessionPayload }
	| { kind: "finalize_member_runtime"; payload: FinalizeMemberRuntimePayload }
	| { kind: "mark_member_joined"; payload: { bootstrap: RoomBootstrap; sessionId: string | null; runtimeId: string; backend?: RoomMemberState["backend"] } }
	| { kind: "create_spawning_member"; payload: { name?: string; displayName: string; type: string; backend: RoomBackend; taskId: string; bootstrapToken?: string | null; sessionId?: string | null; requestReplay?: CrewAddReplaySeed | null } }
	| { kind: "create_spawn_job"; payload: { taskId: string; memberName: string; backend: RoomBackend; state?: RoomSpawnJobState; error?: string | null } }
	| { kind: "write_spawn_job"; payload: { job: RoomSpawnJob } }
	| { kind: "update_spawn_job"; payload: { taskId: string; patch: Partial<Omit<RoomSpawnJob, "taskId" | "memberName" | "backend" | "createdAt">> } }
	| { kind: "delete_member"; payload: { memberName: string } }
	| { kind: "run_locked_fn"; payload: { fnId: string; args?: unknown } }
	| { kind: "notify_deps"; payload: { upstreamSeq: number; taskMessageId?: string; status: "completed" | "error" | "cancelled" } }
	| { kind: "remove_transient_member"; payload: { memberName: string; taskSummary: string; replyKind: "completion" | "error"; errorSummary?: string } }
	| { kind: "spawn_agent"; payload: SpawnAgentPayload };

// ── Wire Protocol Messages ────────────────────────────────────────────────────

export interface ProxyRequest {
	requestId: string;
	command: MutationCommand;
	protocolVersion: number;
}

export interface ProxyResponse {
	requestId: string;
	ok: boolean;
	value?: unknown;
	error?: string;
	/** Machine-readable error code (RoomError.code) for business-logic errors.
	 *  Absent for infrastructure errors (timeout, queue-full, etc.). */
	code?: string;
}

// ── Length-Prefixed Frame Codec (reviewer Finding 1) ──────────────────────────
//
// Frame format: [4 bytes BE uint32 length] [JSON payload bytes]
// Avoids newline-related message truncation (vs plain JSON-line).

export function encodeFrame(obj: unknown): Buffer {
	const json = JSON.stringify(obj);
	const jsonBuffer = Buffer.from(json, "utf8");
	const lengthBuffer = Buffer.alloc(4);
	lengthBuffer.writeUInt32BE(jsonBuffer.length, 0);
	return Buffer.concat([lengthBuffer, jsonBuffer]);
}

export interface FrameParser {
	feed(chunk: Buffer): void;
	onFrame: ((obj: unknown) => void) | null;
}

export function createFrameParser(): FrameParser {
	let buffer = Buffer.alloc(0);
	const parser: FrameParser = {
		onFrame: null,
		feed(chunk: Buffer): void {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 4) {
				const frameLength = buffer.readUInt32BE(0);
				if (buffer.length < 4 + frameLength) break;
				const frameData = buffer.subarray(4, 4 + frameLength);
				buffer = buffer.subarray(4 + frameLength);
				try {
					parser.onFrame?.(JSON.parse(frameData.toString("utf8")));
				} catch {
					// Skip malformed frames
				}
			}
		},
	};
	return parser;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function getProxySocketPath(roomDir: string): string {
	return path.join(roomDir, "proxy.sock");
}
