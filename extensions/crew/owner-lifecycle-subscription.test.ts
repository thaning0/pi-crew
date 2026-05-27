import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import roomExtension from "./index.ts";
import { activateBootstrapRoom, resetActiveRoomsForTests, setActiveRoom } from "./lifecycle.ts";
import { createRoom, loadRoomMemberState } from "./storage.ts";
import type { PublicCrewLifecycleEvent } from "./integration-events.ts";
import type { RoomSpawnAdapter } from "./types.ts";

type RegisteredHandler = (event: unknown, ctx?: unknown) => unknown;

function setOwnerRoom(options: {
	roomDir: string;
	roomId: string;
	sessionId: string;
	memberName?: string;
}): void {
	setActiveRoom({
		role: "owner",
		roomDir: options.roomDir,
		roomId: options.roomId,
		memberName: options.memberName ?? "owner",
		sessionId: options.sessionId,
		pollTimer: null,
		heartbeatTimer: null,
		pendingPoll: null,
		pendingHeartbeat: null,
		pendingToolTasks: new Set<Promise<unknown>>(),
		shuttingDown: false,
		pendingDeliveryBatch: [],
		deliveryTimer: null,
	});
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crew-owner-lifecycle-subscription-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

function createTestAdapters(): { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter } {
	let runtimeSeq = 0;
	return {
		pi: {
			kind: "pi",
			async spawn() {
				runtimeSeq += 1;
				return {
					runtimeId: `test-runtime-${runtimeSeq}`,
					backend: "pi",
				};
			},
		},
		paseo: {
			kind: "paseo",
			async isAvailable() {
				return false;
			},
			async spawn() {
				throw new Error("paseo adapter should not be used in owner lifecycle subscription tests");
			},
		},
	};
}

function createOwnerHarness(adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter }) {
	const eventHandlers = new Map<string, RegisteredHandler[]>();
	const lifecycleHandlers = new Map<string, RegisteredHandler>();
	const emit = vi.fn(async (name: string, payload: unknown) => {
		for (const handler of eventHandlers.get(name) ?? []) {
			await handler(payload);
		}
	});

	roomExtension(
		{
			events: {
				on: vi.fn((name: string, handler: RegisteredHandler) => {
					const existing = eventHandlers.get(name) ?? [];
					existing.push(handler);
					eventHandlers.set(name, existing);
				}),
				emit,
			},
			on: vi.fn((name: string, handler: RegisteredHandler) => {
				lifecycleHandlers.set(name, handler);
			}),
			registerTool: vi.fn(),
			sendMessage: vi.fn(),
			setActiveTools: vi.fn(),
			getAllTools: vi.fn(() => []),
			getThinkingLevel: vi.fn(),
		} as any,
		{ adapters },
	);

	return {
		onEvent(name: string, handler: RegisteredHandler): void {
			const existing = eventHandlers.get(name) ?? [];
			existing.push(handler);
			eventHandlers.set(name, existing);
		},
		async emitEvent(name: string, payload: unknown): Promise<void> {
			await emit(name, payload);
		},
		async runLifecycle(name: string, event: unknown, ctx: unknown): Promise<void> {
			const handler = lifecycleHandlers.get(name);
			expect(handler).toBeTypeOf("function");
			await handler?.(event, ctx);
		},
	};
}

function createMemberApi() {
	return {
		events: {
			on: vi.fn(),
			emit: vi.fn(async () => undefined),
		},
		sendMessage: vi.fn(),
		setActiveTools: vi.fn(),
		getAllTools: vi.fn(() => []),
		getThinkingLevel: vi.fn(),
	} as any;
}

async function waitFor(
	condition: () => boolean,
	options: { timeoutMs?: number; intervalMs?: number; message: string },
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 2_000;
	const intervalMs = options.intervalMs ?? 10;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(options.message);
}

afterEach(() => {
	resetActiveRoomsForTests();
	vi.unstubAllEnvs();
});

describe("owner-side lifecycle subscriptions", () => {
	it("delivers spawned claimed and activated to another owner-side plugin for crew:add", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-lifecycle-subscription",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			const adapters = createTestAdapters();
			const ownerHarness = createOwnerHarness(adapters);
			const pluginEvents: PublicCrewLifecycleEvent[] = [];

			await ownerHarness.runLifecycle("session_start", {}, {
				cwd: tempDir,
				getSystemPrompt: () => "",
				sessionManager: {
					getSessionId: () => created.metadata.ownerSessionId,
				},
			});
			setOwnerRoom({
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				sessionId: created.metadata.ownerSessionId,
			});

			ownerHarness.onEvent("crew:event", (payload: unknown) => {
				pluginEvents.push(payload as PublicCrewLifecycleEvent);
			});

			await ownerHarness.emitEvent("crew:add", {
				request_id: "req-owner-plugin-lifecycle",
				name: "worker",
				type: "worker",
				activation: "immediate",
				metadata: { source: "other-plugin" },
			});

			await waitFor(
				() => pluginEvents.some((event) => event.event === "spawned"),
				{ message: "expected owner-side plugin to receive spawned" },
			);

			const spawned = pluginEvents.find((event) => event.event === "spawned");
			expect(spawned).toMatchObject({
				event: "spawned",
				phase: "spawn",
				request_id: "req-owner-plugin-lifecycle",
				activation: "immediate",
			});

			const memberName = spawned?.member_target;
			expect(memberName).toBeTypeOf("string");
			const member = await loadRoomMemberState(created.roomDir, String(memberName));
			expect(member.bootstrapToken).toBeTruthy();

			vi.stubEnv("PI_ROOM_ID", created.metadata.roomId);
			vi.stubEnv("PI_ROOM_DIR", created.roomDir);
			vi.stubEnv("PI_ROOM_MEMBER_NAME", member.name);
			vi.stubEnv("PI_ROOM_MEMBER_TYPE", member.type);
			vi.stubEnv("PI_ROOM_BOOTSTRAP_TOKEN", member.bootstrapToken ?? "");
			vi.stubEnv("PI_ROOM_OWNER_NAME", created.metadata.ownerName);
			vi.stubEnv("PI_ROOM_OWNER_SESSION_ID", created.metadata.ownerSessionId);

			await activateBootstrapRoom(
				createMemberApi(),
				"",
				"member-session-owner-lifecycle-subscription",
				adapters,
			);

			await new Promise((resolve) => setTimeout(resolve, 25));

			const lifecycle = pluginEvents
				.filter((event) => event.request_id === "req-owner-plugin-lifecycle")
				.map((event) => event.event);

			expect(lifecycle).toEqual(
				expect.arrayContaining(["spawned", "claimed", "activated"]),
			);
		});
	});
});
