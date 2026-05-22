/**
 * Typed error hierarchy for the subagent extension.
 *
 * All room-related errors extend RoomError and carry a machine-readable `code`
 * so callers can programmatically distinguish failure modes.
 */

export class RoomError extends Error {
	constructor(
		message: string,
		public readonly code: string,
	) {
		super(message);
		this.name = "RoomError";
	}
}

export class RoomNotFoundError extends RoomError {
	constructor(roomId: string) {
		super(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
		this.name = "RoomNotFoundError";
	}
}

export class MemberNotAvailableError extends RoomError {
	constructor(memberName: string, reason: string) {
		super(
			`Member ${memberName} is not available: ${reason}`,
			"MEMBER_NOT_AVAILABLE",
		);
		this.name = "MemberNotAvailableError";
	}
}

export class MemberNotFoundError extends RoomError {
	constructor(memberName: string) {
		super(`Member ${memberName} not found`, "MEMBER_NOT_FOUND");
		this.name = "MemberNotFoundError";
	}
}

export class SpawnFailedError extends RoomError {
	constructor(memberName: string, reason: string) {
		super(
			`Spawn failed for ${memberName}: ${reason}`,
			"SPAWN_FAILED",
		);
		this.name = "SpawnFailedError";
	}
}

export class LockTimeoutError extends RoomError {
	constructor(lockPath: string) {
		super(`Timed out acquiring lock ${lockPath}`, "LOCK_TIMEOUT");
		this.name = "LockTimeoutError";
	}
}

export class BootstrapTokenError extends RoomError {
	constructor(memberName: string) {
		super(
			`Bootstrap token does not match member ${memberName}`,
			"BOOTSTRAP_TOKEN_MISMATCH",
		);
		this.name = "BootstrapTokenError";
	}
}

export class RoomNotClaimableError extends RoomError {
	constructor(roomId: string, state: string) {
		super(
			`Room ${roomId} is not claimable (${state})`,
			"ROOM_NOT_CLAIMABLE",
		);
		this.name = "RoomNotClaimableError";
	}
}

/** General validation error for room-related inputs. */
export class ValidationError extends RoomError {
	constructor(message: string) {
		super(message, "VALIDATION_ERROR");
		this.name = "ValidationError";
	}
}

/** Thrown when a member already exists and cannot be re-created. */
export class MemberAlreadyExistsError extends RoomError {
	constructor(memberName: string) {
		super(`Member ${memberName} already exists`, "MEMBER_ALREADY_EXISTS");
		this.name = "MemberAlreadyExistsError";
	}
}

/** Thrown when a member attempts to create a room (only owners may do so). */
export class MemberCannotCreateRoomError extends RoomError {
	constructor() {
		super("Only the room owner may create rooms", "MEMBER_CANNOT_CREATE_ROOM");
		this.name = "MemberCannotCreateRoomError";
	}
}

/** Thrown when a subagent backend adapter cannot be reached or loaded. */
export class AdapterUnavailableError extends RoomError {
	constructor(backend: string, detail?: string) {
		super(
			`Adapter ${backend} not available${detail ? ": " + detail : ""}`,
			"ADAPTER_UNAVAILABLE",
		);
		this.name = "AdapterUnavailableError";
	}
}

/** Thrown when an agent process attempts a storage operation without a live proxy connection. */
export class AgentProxyDisconnectedError extends RoomError {
	constructor(message?: string) {
		super(
			message ?? "Agent mutation client is not connected to owner proxy. Storage operations require a live proxy connection.",
			"AGENT_PROXY_DISCONNECTED",
		);
		this.name = "AgentProxyDisconnectedError";
	}
}
