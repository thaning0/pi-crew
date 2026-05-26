import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRoomLogger, closeLogStream } from "./logger.ts";

describe("createRoomLogger", () => {
	const tmpDir = path.join(os.tmpdir(), "logger-test-" + Date.now());
	const roomDir = path.join(tmpDir, "room");
	const logPath = path.join(roomDir, "agent.log");

	function readLogLines(): string[] {
		if (!fs.existsSync(logPath)) return [];
		return fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
	}

	function parseLine(line: string): Record<string, unknown> {
		return JSON.parse(line);
	}

	afterEach(() => {
		vi.unstubAllEnvs();
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch { /* ignore */ }
	});

	it("info writes to file when roomDir set", async () => {
		fs.mkdirSync(roomDir, { recursive: true });
		vi.stubEnv("PI_ROOM_LOG_LEVEL", "");
		const log = createRoomLogger(roomDir, "test");
		log.info("hello info", { key: "val" });
		await closeLogStream(roomDir);

		const lines = readLogLines();
		expect(lines).toHaveLength(1);
		const entry = parseLine(lines[0]);
		expect(entry.level).toBe("info");
		expect(entry.component).toBe("test");
		expect(entry.message).toBe("hello info");
		expect(entry.data).toEqual({ key: "val" });
	});

	it("info suppressed when PI_ROOM_LOG_LEVEL=silent", async () => {
		fs.mkdirSync(roomDir, { recursive: true });
		vi.stubEnv("PI_ROOM_LOG_LEVEL", "silent");
		const log = createRoomLogger(roomDir, "test");
		log.info("should not appear");
		await closeLogStream(roomDir);

		const lines = readLogLines();
		expect(lines).toHaveLength(0);
	});

	it("error always writes", async () => {
		fs.mkdirSync(roomDir, { recursive: true });
		vi.stubEnv("PI_ROOM_LOG_LEVEL", "silent");
		const log = createRoomLogger(roomDir, "test");
		log.error("critical failure", { code: 500 });
		await closeLogStream(roomDir);

		const lines = readLogLines();
		expect(lines).toHaveLength(1);
		const entry = parseLine(lines[0]);
		expect(entry.level).toBe("error");
		expect(entry.component).toBe("test");
		expect(entry.message).toBe("critical failure");
		expect(entry.data).toEqual({ code: 500 });
	});

	it("error always writes even when PI_ROOM_LOG_LEVEL=debug", async () => {
		fs.mkdirSync(roomDir, { recursive: true });
		vi.stubEnv("PI_ROOM_LOG_LEVEL", "debug");
		const log = createRoomLogger(roomDir, "test");
		log.error("an error");
		await closeLogStream(roomDir);

		const lines = readLogLines();
		expect(lines).toHaveLength(1);
		expect(parseLine(lines[0]).level).toBe("error");
	});

	it("debug only writes when PI_ROOM_LOG_LEVEL=debug", async () => {
		fs.mkdirSync(roomDir, { recursive: true });
		vi.stubEnv("PI_ROOM_LOG_LEVEL", "debug");
		const log = createRoomLogger(roomDir, "test");
		log.debug("trace detail", { x: 1 });
		await closeLogStream(roomDir);

		const lines = readLogLines();
		expect(lines).toHaveLength(1);
		const entry = parseLine(lines[0]);
		expect(entry.level).toBe("debug");
		expect(entry.component).toBe("test");
		expect(entry.message).toBe("trace detail");
		expect(entry.data).toEqual({ x: 1 });
	});

	it("debug suppressed when PI_ROOM_LOG_LEVEL is not debug (default)", async () => {
		fs.mkdirSync(roomDir, { recursive: true });
		vi.stubEnv("PI_ROOM_LOG_LEVEL", "");
		const log = createRoomLogger(roomDir, "test");
		log.debug("should not appear");
		await closeLogStream(roomDir);

		const lines = readLogLines();
		expect(lines).toHaveLength(0);
	});

	it("debug suppressed when PI_ROOM_LOG_LEVEL=silent", async () => {
		fs.mkdirSync(roomDir, { recursive: true });
		vi.stubEnv("PI_ROOM_LOG_LEVEL", "silent");
		const log = createRoomLogger(roomDir, "test");
		log.debug("should not appear");
		await closeLogStream(roomDir);

		const lines = readLogLines();
		expect(lines).toHaveLength(0);
	});

	it("warn always writes", async () => {
		fs.mkdirSync(roomDir, { recursive: true });
		vi.stubEnv("PI_ROOM_LOG_LEVEL", "silent");
		const log = createRoomLogger(roomDir, "test");
		log.warn("deprecation notice", { old: "x", new: "y" });
		await closeLogStream(roomDir);

		const lines = readLogLines();
		expect(lines).toHaveLength(1);
		const entry = parseLine(lines[0]);
		expect(entry.level).toBe("warn");
		expect(entry.component).toBe("test");
		expect(entry.message).toBe("deprecation notice");
		expect(entry.data).toEqual({ old: "x", new: "y" });
	});

	it("warn writes without optional data", async () => {
		fs.mkdirSync(roomDir, { recursive: true });
		vi.stubEnv("PI_ROOM_LOG_LEVEL", "");
		const log = createRoomLogger(roomDir, "test");
		log.warn("no data");
		await closeLogStream(roomDir);

		const lines = readLogLines();
		expect(lines).toHaveLength(1);
		const entry = parseLine(lines[0]);
		expect(entry.level).toBe("warn");
		expect(entry.message).toBe("no data");
		expect(entry.data).toBeUndefined();
	});

	it("info falls back to stderr when roomDir is null", () => {
		vi.stubEnv("PI_ROOM_LOG_LEVEL", "");
		const originalWrite = process.stderr.write.bind(process.stderr);
		let captured = "";
		process.stderr.write = (chunk: unknown, _encoding?: any, _cb?: any): boolean => {
			captured += String(chunk);
			return true;
		};
		try {
			createRoomLogger(null, "test").info("stderr fallback");
			const parsed = JSON.parse(captured.trim());
			expect(parsed).toMatchObject({ level: "info", component: "test", message: "stderr fallback" });
			expect(parsed.data).toBeUndefined();
		} finally {
			process.stderr.write = originalWrite;
		}
	});

	it("error falls back to stderr when roomDir is null", () => {
		vi.stubEnv("PI_ROOM_LOG_LEVEL", "");
		const originalWrite = process.stderr.write.bind(process.stderr);
		let captured = "";
		process.stderr.write = (chunk: unknown, _encoding?: any, _cb?: any): boolean => {
			captured += String(chunk);
			return true;
		};
		try {
			createRoomLogger(null, "test").error("stderr error", { code: 42 });
			const parsed = JSON.parse(captured.trim());
			expect(parsed).toMatchObject({ level: "error", component: "test", message: "stderr error" });
			expect(parsed.data).toEqual({ code: 42 });
		} finally {
			process.stderr.write = originalWrite;
		}
	});
});
