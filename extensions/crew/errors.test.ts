import { describe, it, expect } from "vitest";
import {
	AdapterUnavailableError,
	BootstrapTokenError,
	LockTimeoutError,
	MemberAlreadyExistsError,
	MemberNotAvailableError,
	MemberNotFoundError,
	RoomError,
	RoomNotFoundError,
	RoomNotClaimableError,
	SpawnFailedError,
	ValidationError,
} from "./errors.ts";

describe("RoomError base class", () => {
	it("has correct name and code", () => {
		const err = new RoomError("test message", "TEST_CODE");
		expect(err.name).toBe("RoomError");
		expect(err.code).toBe("TEST_CODE");
		expect(err.message).toBe("test message");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(RoomError);
	});
});

describe("RoomNotFoundError", () => {
	it("has correct name and code", () => {
		const err = new RoomNotFoundError("room-123");
		expect(err.name).toBe("RoomNotFoundError");
		expect(err.code).toBe("ROOM_NOT_FOUND");
		expect(err.message).toBe("Room room-123 not found");
	});
	it("is instanceof base RoomError", () => {
		const err = new RoomNotFoundError("room-abc");
		expect(err).toBeInstanceOf(RoomError);
		expect(err).toBeInstanceOf(Error);
	});
});

describe("MemberNotAvailableError", () => {
	it("has correct name and code", () => {
		const err = new MemberNotAvailableError("worker-1", "already busy");
		expect(err.name).toBe("MemberNotAvailableError");
		expect(err.code).toBe("MEMBER_NOT_AVAILABLE");
		expect(err.message).toBe("Member worker-1 is not available: already busy");
	});
	it("is instanceof base RoomError", () => {
		const err = new MemberNotAvailableError("worker-1", "busy");
		expect(err).toBeInstanceOf(RoomError);
		expect(err).toBeInstanceOf(Error);
	});
});

describe("MemberNotFoundError", () => {
	it("has correct name and code", () => {
		const err = new MemberNotFoundError("worker-1");
		expect(err.name).toBe("MemberNotFoundError");
		expect(err.code).toBe("MEMBER_NOT_FOUND");
		expect(err.message).toBe("Member worker-1 not found");
	});
	it("is instanceof base RoomError", () => {
		const err = new MemberNotFoundError("worker-1");
		expect(err).toBeInstanceOf(RoomError);
		expect(err).toBeInstanceOf(Error);
	});
});

describe("SpawnFailedError", () => {
	it("has correct name and code", () => {
		const err = new SpawnFailedError("worker-1", "command not found");
		expect(err.name).toBe("SpawnFailedError");
		expect(err.code).toBe("SPAWN_FAILED");
		expect(err.message).toBe("Spawn failed for worker-1: command not found");
	});
	it("is instanceof base RoomError", () => {
		const err = new SpawnFailedError("worker-1", "timeout");
		expect(err).toBeInstanceOf(RoomError);
		expect(err).toBeInstanceOf(Error);
	});
});

describe("LockTimeoutError", () => {
	it("has correct name and code", () => {
		const err = new LockTimeoutError("/tmp/my.lock");
		expect(err.name).toBe("LockTimeoutError");
		expect(err.code).toBe("LOCK_TIMEOUT");
		expect(err.message).toBe("Timed out acquiring lock /tmp/my.lock");
	});
	it("is instanceof base RoomError", () => {
		const err = new LockTimeoutError("/tmp/my.lock");
		expect(err).toBeInstanceOf(RoomError);
		expect(err).toBeInstanceOf(Error);
	});
});

describe("BootstrapTokenError", () => {
	it("has correct name and code", () => {
		const err = new BootstrapTokenError("worker-1");
		expect(err.name).toBe("BootstrapTokenError");
		expect(err.code).toBe("BOOTSTRAP_TOKEN_MISMATCH");
		expect(err.message).toBe("Bootstrap token does not match member worker-1");
	});
	it("is instanceof base RoomError", () => {
		const err = new BootstrapTokenError("worker-1");
		expect(err).toBeInstanceOf(RoomError);
		expect(err).toBeInstanceOf(Error);
	});
});

describe("RoomNotClaimableError", () => {
	it("has correct name and code", () => {
		const err = new RoomNotClaimableError("room-456", "closing");
		expect(err.name).toBe("RoomNotClaimableError");
		expect(err.code).toBe("ROOM_NOT_CLAIMABLE");
		expect(err.message).toBe("Room room-456 is not claimable (closing)");
	});
	it("is instanceof base RoomError", () => {
		const err = new RoomNotClaimableError("room-456", "closing");
		expect(err).toBeInstanceOf(RoomError);
		expect(err).toBeInstanceOf(Error);
	});
});

describe("ValidationError", () => {
	it("has correct name and code", () => {
		const err = new ValidationError("invalid input");
		expect(err.name).toBe("ValidationError");
		expect(err.code).toBe("VALIDATION_ERROR");
		expect(err.message).toBe("invalid input");
	});
	it("is instanceof base RoomError", () => {
		const err = new ValidationError("bad data");
		expect(err).toBeInstanceOf(RoomError);
		expect(err).toBeInstanceOf(Error);
	});
});

describe("MemberAlreadyExistsError", () => {
	it("has correct name and code", () => {
		const err = new MemberAlreadyExistsError("worker-1");
		expect(err.name).toBe("MemberAlreadyExistsError");
		expect(err.code).toBe("MEMBER_ALREADY_EXISTS");
		expect(err.message).toBe("Member worker-1 already exists");
	});
	it("is instanceof base RoomError", () => {
		const err = new MemberAlreadyExistsError("worker-1");
		expect(err).toBeInstanceOf(RoomError);
		expect(err).toBeInstanceOf(Error);
	});
});

describe("AdapterUnavailableError", () => {
	it("has correct name and code", () => {
		const err = new AdapterUnavailableError("paseo", "CLI not found");
		expect(err.name).toBe("AdapterUnavailableError");
		expect(err.code).toBe("ADAPTER_UNAVAILABLE");
		expect(err.message).toBe("Adapter paseo not available: CLI not found");
	});
	it("omits detail when not provided", () => {
		const err = new AdapterUnavailableError("paseo");
		expect(err.message).toBe("Adapter paseo not available");
	});
	it("is instanceof base RoomError", () => {
		const err = new AdapterUnavailableError("paseo");
		expect(err).toBeInstanceOf(RoomError);
		expect(err).toBeInstanceOf(Error);
	});
});
