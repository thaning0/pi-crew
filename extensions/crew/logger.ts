/**
 * Structured JSON-line logger for the subagent extension.
 *
 * Usage:
 *   const log = createRoomLogger(roomDir, "spawn");
 *   log.info("pi member spawned", { memberName, pid });
 *   log.error("spawn failed", { memberName, error: String(err) });
 *
 * When roomDir is null, falls back to stderr.
 * - error: always logged
 * - warn:  always logged
 * - info:  logged by default; suppressed when PI_ROOM_LOG_LEVEL=silent
 * - debug: logged only when PI_ROOM_LOG_LEVEL=debug
 *
 * Uses an append-only WritableStream for async, non-blocking I/O.
 * Streams are pooled by logPath so all loggers targeting the same room
 * share a single file descriptor.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface RoomLogger {
	info(message: string, data?: Record<string, unknown>): void;
	warn(message: string, data?: Record<string, unknown>): void;
	error(message: string, data?: Record<string, unknown>): void;
	debug(message: string, data?: Record<string, unknown>): void;
}

/** Pool of append-only streams keyed by log file path. */
const logStreams = new Map<string, fs.WriteStream>();

/** Whether the process-level exit handler has been registered. */
let exitHandlerRegistered = false;

/** Register a one-time process exit handler that closes all log streams. */
function ensureExitHandler(): void {
	if (exitHandlerRegistered) return;
	exitHandlerRegistered = true;
	process.on("exit", () => {
		// Synchronous close on exit — we can't await, so use destroy()
		// which closes the underlying fd immediately.
		for (const stream of logStreams.values()) {
			if (!stream.destroyed) {
				stream.destroy();
			}
		}
		logStreams.clear();
	});
}

function getOrCreateLogStream(logPath: string): fs.WriteStream {
	let stream = logStreams.get(logPath);
	if (!stream || stream.destroyed) {
		ensureExitHandler();
		const createdStream = fs.createWriteStream(logPath, { flags: "a" });
		createdStream.on("error", (err) => {
			// Remove from pool so a fresh stream is created on next write.
			if (logStreams.get(logPath) === createdStream) {
				logStreams.delete(logPath);
			}
			createdStream.destroy();
			process.stderr.write(
				JSON.stringify({
					timestamp: new Date().toISOString(),
					level: "error",
					component: "logger",
					message: "log stream write failed",
					data: { file: logPath, error: String(err) },
				}) + "\n",
			);
		});
		stream = createdStream;
		logStreams.set(logPath, stream);
	}
	return stream;
}

export function createRoomLogger(
	roomDir: string | null,
	component: string,
): RoomLogger {
	const logPath = roomDir ? path.join(roomDir, "agent.log") : null;
	const logStream = logPath ? getOrCreateLogStream(logPath) : null;

	function write(entry: Record<string, unknown>): void {
		const line = JSON.stringify(entry);
		if (logStream && !logStream.destroyed && logStream.writable) {
			logStream.write(line + "\n");
		} else {
			process.stderr.write(line + "\n");
		}
	}

	function error(message: string, data?: Record<string, unknown>): void {
		const entry: Record<string, unknown> = {
			timestamp: new Date().toISOString(),
			level: "error",
			component,
			message,
		};
		if (data) entry.data = data;
		write(entry);
	}

	function warn(message: string, data?: Record<string, unknown>): void {
		const entry: Record<string, unknown> = {
			timestamp: new Date().toISOString(),
			level: "warn",
			component,
			message,
		};
		if (data) entry.data = data;
		write(entry);
	}

	function info(message: string, data?: Record<string, unknown>): void {
		if (process.env.PI_ROOM_LOG_LEVEL === "silent") return;
		const entry: Record<string, unknown> = {
			timestamp: new Date().toISOString(),
			level: "info",
			component,
			message,
		};
		if (data) entry.data = data;
		write(entry);
	}

	function debug(message: string, data?: Record<string, unknown>): void {
		if (process.env.PI_ROOM_LOG_LEVEL !== "debug") return;
		const entry: Record<string, unknown> = {
			timestamp: new Date().toISOString(),
			level: "debug",
			component,
			message,
		};
		if (data) entry.data = data;
		write(entry);
	}

	return { info, warn, error, debug };
}

/** Close and remove the log stream for a roomDir. Call when a room is reaped or a session ends. */
export function closeLogStream(roomDir: string): Promise<void> {
	const logPath = path.join(roomDir, "agent.log");
	const stream = logStreams.get(logPath);
	if (!stream) return Promise.resolve();
	logStreams.delete(logPath);
	return new Promise<void>((resolve) => {
		if (stream.destroyed) {
			resolve();
			return;
		}
		stream.end(() => resolve());
	});
}

/**
 * Close all pooled log streams gracefully using async `end()`.
 *
 * Use this during controlled shutdowns where data completeness matters
 * (e.g. daemon restart, integration test teardown).  For crash/unclean
 * exit scenarios the `ensureExitHandler` (process.on("exit")) path uses
 * synchronous `destroy()` instead — see ensureExitHandler above.
 *
 * This function is exported for external daemon lifecycle code. It is
 * NOT called automatically by any session or room lifecycle hook — those
 * close streams per-room via `closeLogStream(roomDir)`.
 */
export function closeAllLogStreamsGracefully(): Promise<void[]> {
	const closings: Promise<void>[] = [];
	for (const [logPath, stream] of logStreams.entries()) {
		logStreams.delete(logPath);
		if (!stream.destroyed) {
			closings.push(
				new Promise<void>((resolve) => {
					stream.end(() => resolve());
				}),
			);
		}
	}
	return Promise.all(closings);
}

/** Fallback when no roomDir is available — writes to stderr. */
export function consoleError(
	component: string,
	message: string,
	data?: Record<string, unknown>,
): void {
	const entry: Record<string, unknown> = {
		timestamp: new Date().toISOString(),
		level: "error",
		component,
		message,
	};
	if (data) entry.data = data;
	process.stderr.write(JSON.stringify(entry) + "\n");
}
