import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRoomBootstrapFromEnv } from "./bootstrap.ts";
import { buildPaseoRoomEnv, createPiMemberAdapter } from "./spawn.ts";
import type { RoomBootstrap } from "./types.ts";

function createBootstrap(roomDir: string): RoomBootstrap {
	return {
		version: 1,
		roomId: "room-env-test",
		roomDir,
		memberName: "worker",
		memberType: "worker",
		ownerName: "lead",
		ownerSessionId: "owner-session",
		token: "bootstrap-token",
		spawnTaskId: "spawn-task-1",
	};
}

function createSpawnedChild(pid = 12345): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	Object.assign(child, {
		pid,
		stdin: { destroy: vi.fn() },
	});
	queueMicrotask(() => {
		child.emit("spawn");
	});
	return child;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crew-spawn-env-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("spawn env passthrough", () => {
	it("injects PI_ROOM_EXTENSION_PAYLOAD from the spawn request for pi members", async () => {
		await withTempDir(async (tempDir) => {
			const payload = { source: "plugin", ticket: "AUTH-42", nested: { mode: "sync" } };
			const spawnCalls: Array<{ options: { env?: Record<string, string> } }> = [];
			const adapter = createPiMemberAdapter({
				spawnProcess: ((command: string, args: string[], options: { env?: Record<string, string> }) => {
					spawnCalls.push({ options });
					return createSpawnedChild();
				}) as any,
			});

			await adapter.spawn({
				roomDir: tempDir,
				roomId: "room-env-test",
				memberName: "worker",
				memberType: "worker",
				cwd: tempDir,
				systemPrompt: "",
				extensionPath: "/tmp/fake-extension.ts",
				bootstrap: createBootstrap(tempDir),
				extensionPayload: payload,
			} as any);

			expect(spawnCalls).toHaveLength(1);
			expect(spawnCalls[0]?.options.env?.PI_ROOM_EXTENSION_PAYLOAD).toBe(JSON.stringify(payload));
		});
	});

	it("builds PI_ROOM_EXTENSION_PAYLOAD for paseo members from a separate opaque payload", () => {
		const bootstrap = createBootstrap("/tmp/crew-room");
		const payload = { source: "plugin", scope: ["child", "bootstrap"] };
		const env = (buildPaseoRoomEnv as any)(bootstrap, payload);

		expect(env.PI_ROOM_EXTENSION_PAYLOAD).toBe(JSON.stringify(payload));
	});

	it("parses only crew-owned bootstrap vars and ignores opaque extension payload env", () => {
		vi.stubEnv("PI_ROOM_ID", "room-1");
		vi.stubEnv("PI_ROOM_DIR", "/tmp/room-1");
		vi.stubEnv("PI_ROOM_MEMBER_NAME", "worker");
		vi.stubEnv("PI_ROOM_MEMBER_TYPE", "worker");
		vi.stubEnv("PI_ROOM_BOOTSTRAP_TOKEN", "bootstrap-token");
		vi.stubEnv("PI_ROOM_OWNER_NAME", "lead");
		vi.stubEnv("PI_ROOM_OWNER_SESSION_ID", "owner-session");
		vi.stubEnv("PI_ROOM_EXTENSION_PAYLOAD", JSON.stringify({ source: "plugin" }));

		const bootstrap = parseRoomBootstrapFromEnv();
		expect(bootstrap).toMatchObject({
			roomId: "room-1",
			roomDir: "/tmp/room-1",
			memberName: "worker",
			memberType: "worker",
			ownerName: "lead",
			ownerSessionId: "owner-session",
			token: "bootstrap-token",
		});
		expect(bootstrap).not.toHaveProperty("extensionPayload");
	});
});
