import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import * as bootstrapModule from "./bootstrap.ts";
import { buildRoomBootstrapBlock } from "./bootstrap.ts";
import roomExtension from "./index.ts";
import { getActiveRoom, resetActiveRoomsForTests, setActiveRoom } from "./lifecycle.ts";
import { createPaseoPiMemberAdapter } from "./spawn.ts";
import { executeCrewRemove, executeCrewAdd } from "./tools.ts";
import { reconcileSpawnTimeouts } from "./watchdog.ts";
import * as worktreeModule from "./worktree.ts";
import {
	claimMemberSession,
	createRoom,
	createSpawningMember,
	finalizeMemberRuntime,
	listBoardEntries,
	listRoomMembers,
	loadRoomMemberState,
	readSpawnJob,
	writeRoomMemberState,
} from "./storage.ts";
import type { RoomBootstrap, RoomMemberState } from "./types.ts";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const originalHomeEnv = process.env.HOME;

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "room-spawn-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Timed out waiting for condition");
}

function parseSpawnTaskIdFromEntry(entry: string): string {
	return entry.replace(/^spawn-/, "").replace(/\.json$/, "");
}

function createLifecycleHarness(systemPrompt: string, runtimeRoot: string) {
	const lifecycleListeners = new Map<string, Array<(event?: unknown, ctx?: unknown) => Promise<void> | void>>();
	roomExtension({
		on(eventName: string, handler: (event?: unknown, ctx?: unknown) => Promise<void> | void) {
			const current = lifecycleListeners.get(eventName) ?? [];
			current.push(handler);
			lifecycleListeners.set(eventName, current);
		},
		getAllTools() {
			return [];
		},
		setActiveTools() {
			return undefined;
		},
		registerTool() {
			return undefined;
		},
		sendMessage() {
			return undefined;
		},
	} as any, { runtimeRoot });

	return {
		async emit(eventName: string, sessionId: string, event: Record<string, unknown> = {}) {
			const ctx = {
				cwd: process.cwd(),
				hasUI: false,
				getSystemPrompt: () => systemPrompt,
				sessionManager: {
					getSessionId: () => sessionId,
				},
			};
			for (const handler of lifecycleListeners.get(eventName) ?? []) {
				await handler(event, ctx);
			}
		},
	};
}

async function writeFakePaseoCli(rootDir: string): Promise<string> {
	const cliPath = path.join(rootDir, "bin", "paseo");
	const clientModulePath = path.join(rootDir, "dist", "utils", "client.js");
	await fs.mkdir(path.dirname(cliPath), { recursive: true });
	await fs.mkdir(path.dirname(clientModulePath), { recursive: true });
	await fs.writeFile(cliPath, "#!/usr/bin/env bash\nexit 0\n", { encoding: "utf8", mode: 0o755 });
	await fs.writeFile(
		clientModulePath,
		`export async function connectToDaemon() {
	return {
		async createAgent(options) {
			globalThis.__spawnTestCreateAgentOptions = options;
			return { id: "fake-paseo-agent" };
		},
		async close() {},
		async cancelAgent() {},
		async deleteAgent() {},
	};
}
`,
		"utf8",
	);
	return cliPath;
}

afterEach(() => {
	resetActiveRoomsForTests();
	vi.restoreAllMocks();
	delete process.env.PI_ROOM_PASEO_CLI_PATH;
	delete process.env.PASEO_AGENT_ID;
	if (originalHomeEnv === undefined) delete process.env.HOME;
	else process.env.HOME = originalHomeEnv;
	delete (globalThis as Record<string, unknown>).__spawnTestCreateAgentOptions;
});

function setOwnerActiveRoomContext(created: Awaited<ReturnType<typeof createRoom>>, sessionId: string): void {
	setActiveRoom({
		role: "owner",
		roomDir: created.roomDir,
		roomId: created.metadata.roomId,
		memberName: created.metadata.ownerName,
		sessionId,
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

async function findMemberByAlias(roomDir: string, alias: string): Promise<RoomMemberState | null> {
	const members = await listRoomMembers(roomDir);
	return members.find((member) => member.displayName === alias || member.name === alias) ?? null;
}

async function loadMemberByAlias(roomDir: string, alias: string): Promise<RoomMemberState> {
	const member = await findMemberByAlias(roomDir, alias);
	if (!member) {
		throw new Error(`Member ${alias} not found`);
	}
	return member;
}

describe("createPaseoPiMemberAdapter", () => {
	it("does not call createWorktree when agent definition explicitly disables worktree", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-worktree-disabled",
				cwd: tempDir,
			});
			setOwnerActiveRoomContext(created, "owner-session-worktree-disabled");
			vi.spyOn(bootstrapModule, "loadTypedRoomAgentDefinition").mockReturnValue({
				type: "worker",
				systemPrompt: "test",
				worktree: false,
			} as any);

			const createWorktreeSpy = vi.spyOn(worktreeModule, "createWorktree").mockResolvedValue({
				path: path.join(tempDir, "fake-worktree-disabled"),
				branch: "pi-agent-worker-disabled",
			});

			const result = await executeCrewAdd(
				{ name: "worker", type: "worker" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => "owner-session-worktree-disabled",
					},
				},
				runtimeRoot,
				{
					pi: {
						kind: "pi" as const,
						async isAvailable() {
							return true;
						},
						async spawn() {
							return { runtimeId: "spawn-no-worktree-runtime", backend: "pi" as const };
						},
					},
					paseo: {
						kind: "paseo" as const,
						async isAvailable() {
							return false;
						},
						async spawn() {
							throw new Error("not used");
						},
					},
				},
				{ ownerName: "owner" },
			);

			assert.equal(result.isError, undefined);
			await waitFor(async () => (await findMemberByAlias(created.roomDir, "worker"))?.runtimeId === "spawn-no-worktree-runtime", 2_000);
			assert.equal(createWorktreeSpy.mock.calls.length, 0);
		});
	});

	it("calls createWorktree only when agent definition enables worktree", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-worktree-enabled",
				cwd: tempDir,
			});
			setOwnerActiveRoomContext(created, "owner-session-worktree-enabled");

			vi.spyOn(bootstrapModule, "loadTypedRoomAgentDefinition").mockReturnValue({
				type: "worker",
				systemPrompt: "test",
				worktree: true,
			} as any);
			const fakeWorktree = {
				path: path.join(tempDir, "fake-worktree-enabled"),
				branch: "pi-agent-worker-enabled",
			};
			const createWorktreeSpy = vi.spyOn(worktreeModule, "createWorktree").mockResolvedValue(fakeWorktree);

			const result = await executeCrewAdd(
				{ name: "worker", type: "worker" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => "owner-session-worktree-enabled",
					},
				},
				runtimeRoot,
				{
					pi: {
						kind: "pi" as const,
						async isAvailable() {
							return true;
						},
						async spawn() {
							return { runtimeId: "spawn-worktree-runtime", backend: "pi" as const };
						},
					},
					paseo: {
						kind: "paseo" as const,
						async isAvailable() {
							return false;
						},
						async spawn() {
							throw new Error("not used");
						},
					},
				},
				{ ownerName: "owner" },
			);

			assert.equal(result.isError, undefined);
			await waitFor(async () => (await findMemberByAlias(created.roomDir, "worker"))?.runtimeId === "spawn-worktree-runtime", 2_000);
			assert.equal(createWorktreeSpy.mock.calls.length, 1);
			const member = await loadMemberByAlias(created.roomDir, "worker");
			assert.equal(createWorktreeSpy.mock.calls[0]?.[0], member.name);
			assert.equal(createWorktreeSpy.mock.calls[0]?.[1], tempDir);
			assert.deepEqual(member.worktree, fakeWorktree);
			assert.match(member.name, /^worker_[a-z0-9]+$/i);
			assert.match(String(createWorktreeSpy.mock.calls[0]?.[2] ?? ""), /^[0-9a-f]{6,}$/i);
		});
	});

	it("requires before_agent_start to materialize the owner room before spawn can succeed", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "spawn-owner-room-deferral";
			const toolAdapters = {
				pi: {
					kind: "pi",
					async isAvailable() {
						return true;
					},
					async spawn() {
						return { runtimeId: "spawn-owner-room-runtime", backend: "pi" };
					},
				},
				paseo: {
					kind: "paseo",
					async isAvailable() {
						return false;
					},
					async spawn() {
						throw new Error("not used");
					},
				},
			};
			const harness = createLifecycleHarness("Owner session prompt", runtimeRoot);

			const before = await executeCrewAdd(
				{ name: "worker", type: "worker" },
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "Owner session prompt",
					sessionManager: { getSessionId: () => sessionId },
				},
				runtimeRoot,
				toolAdapters as any,
				{ ownerName: "owner" },
			);
			assert.equal(before.isError, true);

			await harness.emit("before_agent_start", sessionId, { systemPrompt: "Owner session prompt" });
			assert.equal(getActiveRoom(sessionId)?.role, "owner");

			const after = await executeCrewAdd(
				{ name: "worker", type: "worker" },
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "Owner session prompt",
					sessionManager: { getSessionId: () => sessionId },
				},
				runtimeRoot,
				toolAdapters as any,
				{ ownerName: "owner" },
			);
			assert.equal(after.isError, undefined);
			await waitFor(async () => (await findMemberByAlias(getActiveRoom(sessionId)!.roomDir, "worker"))?.runtimeId === "spawn-owner-room-runtime", 2_000);
		});
	});

	it("spawns using a unique internal member id and routes initial tasks to that internal target", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-unique-member-id",
				cwd: tempDir,
			});
			setOwnerActiveRoomContext(created, "owner-session-unique-member-id");

			let capturedRequest: {
				memberName: string;
				memberLabel?: string;
				systemPrompt?: string;
				model?: string;
				parentSessionId?: string;
			} | null = null;
			const adapters = {
				pi: {
					kind: "pi" as const,
					async isAvailable() {
						return true;
					},
					async spawn(request: {
						memberName: string;
						memberLabel?: string;
						systemPrompt?: string;
						model?: string;
						parentSessionId?: string;
					}) {
						capturedRequest = request;
						return { runtimeId: "spawn-identity-runtime", backend: "pi" as const };
					},
				},
				paseo: {
					kind: "paseo" as const,
					async isAvailable() {
						return false;
					},
					async spawn() {
						throw new Error("not used");
					},
				},
			};

			const result = await executeCrewAdd(
				{ name: "explorer", type: "worker", task: "Inspect the room state." },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => "owner-session-unique-member-id",
					},
				},
				runtimeRoot,
				adapters,
				{ ownerName: "owner" },
			);

			assert.equal(result.isError, undefined);

			const members = (await listRoomMembers(created.roomDir)).filter((member) => member.name !== created.metadata.ownerName);
			assert.equal(members.length, 1);
			assert.equal(members[0]?.displayName, "explorer");
			assert.match(members[0]?.name ?? "", /^explorer_[a-z0-9]+$/i);

			await waitFor(() => capturedRequest !== null, 2_000);
			assert.equal(capturedRequest?.memberName, members[0]?.name);
			assert.match(capturedRequest?.memberLabel ?? "", /^explorer#/i);
			assert.match(capturedRequest?.systemPrompt ?? "", /explorer#/i);
			assert.equal(capturedRequest?.parentSessionId, "owner-session-unique-member-id");

			const board = await listBoardEntries(created.roomDir, 20);
			const initialTask = board.find((entry) => entry.kind === "task");
			assert.ok(initialTask);
			assert.equal(initialTask?.to, members[0]?.name);
			assert.match(result.content[0]?.text ?? "", /explorer#/i);
		});
	});

	it("preserves valid summary mentions for spawn initial tasks and warns on unresolved ones", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-spawn-task-mentions",
				cwd: tempDir,
			});
			setOwnerActiveRoomContext(created, "owner-session-spawn-task-mentions");
			const internalWorkerName = "worker_1234";
			await writeRoomMemberState(created.roomDir, {
				name: internalWorkerName,
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "existing-worker-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "existing-worker-session",
			});

			const result = await executeCrewAdd(
				{ name: "explorer", type: "worker", task: "Inspect with @worker and @missing" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => "owner-session-spawn-task-mentions",
					},
				},
				runtimeRoot,
				{
					pi: {
						kind: "pi" as const,
						async isAvailable() {
							return true;
						},
						async spawn() {
							return { runtimeId: "spawn-mentions-runtime", backend: "pi" as const };
						},
					},
					paseo: {
						kind: "paseo" as const,
						async isAvailable() {
							return false;
						},
						async spawn() {
							throw new Error("not used");
						},
					},
				},
				{ ownerName: "owner" },
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /@missing/i);

			const board = await listBoardEntries(created.roomDir, 20);
			const initialTask = board.find((entry) => entry.kind === "task");
			assert.ok(initialTask);
			assert.equal(initialTask?.mentions?.join(","), internalWorkerName);
			assert.equal(initialTask?.summary, "Inspect with @worker and @missing");
			const mentionedWorker = await loadRoomMemberState(created.roomDir, internalWorkerName);
			assert.equal(mentionedWorker?.state, "idle");
			assert.equal(mentionedWorker?.currentTaskMessageId, null);
		});
	});

	it("resolves display labels inside spawn initial task summary mentions", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-spawn-task-label-mentions",
				cwd: tempDir,
			});
			setOwnerActiveRoomContext(created, "owner-session-spawn-task-label-mentions");
			for (const name of ["worker_1234", "worker_5678"]) {
				await writeRoomMemberState(created.roomDir, {
					name,
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: `${name}-runtime`,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: `${name}-session`,
				});
			}

			const result = await executeCrewAdd(
				{ name: "explorer", type: "worker", task: "Inspect with @worker#5678 and @missing" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => "owner-session-spawn-task-label-mentions",
					},
				},
				runtimeRoot,
				{
					pi: {
						kind: "pi" as const,
						async isAvailable() {
							return true;
						},
						async spawn() {
							return { runtimeId: "spawn-label-mentions-runtime", backend: "pi" as const };
						},
					},
					paseo: {
						kind: "paseo" as const,
						async isAvailable() {
							return false;
						},
						async spawn() {
							throw new Error("not used");
						},
					},
				},
				{ ownerName: "owner" },
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /@missing/i);

			const board = await listBoardEntries(created.roomDir, 20);
			const initialTask = board.find((entry) => entry.kind === "task");
			assert.ok(initialTask);
			assert.equal(initialTask?.mentions?.join(","), "worker_5678");
			assert.equal(initialTask?.summary, "Inspect with @worker#5678 and @missing");
			const mentionedWorker = await loadRoomMemberState(created.roomDir, "worker_5678");
			assert.equal(mentionedWorker?.state, "idle");
			assert.equal(mentionedWorker?.currentTaskMessageId, null);
		});
	});

	it("prefers typed agent model defaults and falls back to currentModel strings", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-model-fallbacks",
				cwd: tempDir,
			});
			setOwnerActiveRoomContext(created, "owner-session-model-fallbacks");

			const capturedModels: string[] = [];
			const adapters = {
				pi: {
					kind: "pi" as const,
					async isAvailable() {
						return true;
					},
					async spawn(request: { model?: string }) {
						capturedModels.push(request.model ?? "");
						return { runtimeId: `spawn-model-runtime-${capturedModels.length}`, backend: "pi" as const };
					},
				},
				paseo: {
					kind: "paseo" as const,
					async isAvailable() {
						return false;
					},
					async spawn() {
						throw new Error("not used");
					},
				},
			};

			const typedModelResult = await executeCrewAdd(
				{ name: "explorer", type: "explorer" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					currentModel: "fallback/provider-model",
					sessionManager: {
						getSessionId: () => "owner-session-model-fallbacks",
					},
				},
				runtimeRoot,
				adapters,
				{ ownerName: "owner" },
			);
			assert.equal(typedModelResult.isError, undefined);
			await waitFor(() => capturedModels.length >= 1, 2_000);
			assert.equal(capturedModels[0], "deepseek-v4-flash");

			const currentModelResult = await executeCrewAdd(
				{ name: "worker", type: "worker" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					model: { provider: "broken", id: "object" } as never,
					currentModel: "fallback/provider-model",
					sessionManager: {
						getSessionId: () => "owner-session-model-fallbacks",
					},
				} as never,
				runtimeRoot,
				adapters,
				{ ownerName: "owner" },
			);
			assert.equal(currentModelResult.isError, undefined);
			await waitFor(() => capturedModels.length >= 2, 2_000);
			assert.equal(capturedModels[1], "fallback/provider-model");
		});
	});

	it("rejects respawning into the same internal member id after an error-state tombstone", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-no-internal-id-reuse",
				cwd: tempDir,
			});

			await writeRoomMemberState(created.roomDir, {
				name: "explorer_1234",
				displayName: "explorer",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "error",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: "spawn failed",
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: null,
			} as never);

			await assert.rejects(
				() => createSpawningMember(created.roomDir, {
					name: "explorer_1234",
					displayName: "explorer",
					type: "worker",
					backend: "pi",
					taskId: "respawn-worker",
					bootstrapToken: "respawn-token",
				} as never),
				/already exists/i,
			);
		});
	});

	it("keeps an error tombstone and reserved alias when spawn fails before runtime creation", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-spawn-fail-tombstone",
				cwd: tempDir,
			});
			setOwnerActiveRoomContext(created, "owner-session-spawn-fail-tombstone");

			const result = await executeCrewAdd(
				{ name: "worker", type: "worker" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => "owner-session-spawn-fail-tombstone",
					},
				},
				runtimeRoot,
				{
					pi: {
						kind: "pi" as const,
						async isAvailable() {
							return true;
						},
						async spawn() {
							throw new Error("simulated spawn failure");
						},
					},
					paseo: {
						kind: "paseo" as const,
						async isAvailable() {
							return false;
						},
						async spawn() {
							throw new Error("not used");
						},
					},
				},
				{ ownerName: "owner" },
			);

			assert.equal(result.isError, undefined);
			await waitFor(async () => (await loadMemberByAlias(created.roomDir, "worker"))?.state === "error", 2_000);

			const failedMember = await loadMemberByAlias(created.roomDir, "worker");
			assert.ok(failedMember);
			assert.equal(failedMember?.state, "error");

			const retry = await executeCrewAdd(
				{ name: "worker", type: "worker" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => "owner-session-spawn-fail-tombstone",
					},
				},
				runtimeRoot,
				{
					pi: {
						kind: "pi" as const,
						async isAvailable() {
							return true;
						},
						async spawn() {
							return { runtimeId: "unused", backend: "pi" as const };
						},
					},
					paseo: {
						kind: "paseo" as const,
						async isAvailable() {
							return false;
						},
						async spawn() {
							throw new Error("not used");
						},
					},
				},
				{ ownerName: "owner" },
			);

			assert.equal(retry.isError, true);
			assert.match(retry.content[0]?.text ?? "", /conflicts with active member/i);
		});
	});

	it("does not resurrect a removed member when a late spawn failure settles after removal", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-late-spawn-failure-remove";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: sessionId,
				cwd: tempDir,
			});
			setOwnerActiveRoomContext(created, sessionId);

			let rejectSpawn: ((error: Error) => void) | null = null;
			const spawnGate = new Promise<never>((_resolve, reject) => {
				rejectSpawn = reject;
			});

			const result = await executeCrewAdd(
				{ name: "worker", type: "worker" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => sessionId,
					},
				},
				runtimeRoot,
				{
					pi: {
						kind: "pi" as const,
						async isAvailable() {
							return true;
						},
						async spawn() {
							return await spawnGate;
						},
					},
					paseo: {
						kind: "paseo" as const,
						async isAvailable() {
							return false;
						},
						async spawn() {
							throw new Error("not used");
						},
					},
				},
				{ ownerName: "owner" },
			);

			assert.equal(result.isError, undefined);
			await waitFor(async () => (await loadMemberByAlias(created.roomDir, "worker"))?.state === "spawning", 2_000);

			const removed = await executeCrewRemove(
				{ name: "worker" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => sessionId,
					},
				},
				runtimeRoot,
				{
					pi: {
						kind: "pi" as const,
						async isAvailable() {
							return true;
						},
						async spawn() {
							throw new Error("not used");
						},
					},
					paseo: {
						kind: "paseo" as const,
						async isAvailable() {
							return false;
						},
						async spawn() {
							throw new Error("not used");
						},
					},
				},
				{ ownerName: "owner" },
			);
			assert.equal(removed.isError, undefined);

			rejectSpawn?.(new Error("late spawn failure"));
			await Promise.allSettled([...(getActiveRoom(sessionId)?.pendingToolTasks ?? [])]);

			const removedMember = await loadMemberByAlias(created.roomDir, "worker");
			assert.equal(removedMember?.state, "removed");

			const retry = await executeCrewAdd(
				{ name: "worker", type: "worker" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => sessionId,
					},
				},
				runtimeRoot,
				{
					pi: {
						kind: "pi" as const,
						async isAvailable() {
							return true;
						},
						async spawn() {
							return { runtimeId: "replacement-runtime", backend: "pi" as const };
						},
					},
					paseo: {
						kind: "paseo" as const,
						async isAvailable() {
							return false;
						},
						async spawn() {
							throw new Error("not used");
						},
					},
				},
				{ ownerName: "owner" },
			);

			assert.equal(retry.isError, undefined);
		});
	});

	it("returns runtime info without writing member runtime identity", async () => {
		await withTempDir(async (tempDir) => {
			const fakeCliPath = await writeFakePaseoCli(path.join(tempDir, "fake-paseo"));
			process.env.PI_ROOM_PASEO_CLI_PATH = fakeCliPath;

			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session",
				cwd: tempDir,
			});
			await createSpawningMember(created.roomDir, {
				name: "worker",
				type: "worker",
				backend: "paseo",
				taskId: "spawn-worker",
				bootstrapToken: "spawn-token",
			});

			const bootstrap: RoomBootstrap = {
				version: 1,
				roomId: created.metadata.roomId,
				roomDir: created.roomDir,
				memberName: "worker",
				memberType: "worker",
				ownerName: "owner",
				ownerSessionId: "owner-session",
				token: "spawn-token",
				spawnTaskId: "spawn-worker",
			};

			const adapter = createPaseoPiMemberAdapter();
			const result = await adapter.spawn({
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: "worker",
				memberType: "worker",
				cwd: tempDir,
				systemPrompt: buildRoomBootstrapBlock(bootstrap),
			});

			assert.equal(result.backend, "paseo");
			assert.equal(result.runtimeId, "fake-paseo-agent");

			const createAgentOptions = (globalThis as Record<string, unknown>).__spawnTestCreateAgentOptions as Record<string, unknown> | undefined;
			assert.ok(createAgentOptions);
			assert.equal(createAgentOptions.labels, undefined);

			const member = await loadRoomMemberState(created.roomDir, "worker");
			assert.equal(member.backend, "paseo");
			assert.equal(member.runtimeId, null);
			assert.equal(member.state, "spawning");
			assert.equal(member.spawnTaskId, "spawn-worker");
		});
	});

	it("ignores a blank paseo parent agent id", async () => {
		await withTempDir(async (tempDir) => {
			const fakeCliPath = await writeFakePaseoCli(path.join(tempDir, "fake-paseo"));
			process.env.PI_ROOM_PASEO_CLI_PATH = fakeCliPath;
			process.env.PASEO_AGENT_ID = "   ";

			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session",
				cwd: tempDir,
			});
			await createSpawningMember(created.roomDir, {
				name: "worker",
				type: "worker",
				backend: "paseo",
				taskId: "spawn-worker",
				bootstrapToken: "spawn-token",
			});

			const bootstrap: RoomBootstrap = {
				version: 1,
				roomId: created.metadata.roomId,
				roomDir: created.roomDir,
				memberName: "worker",
				memberType: "worker",
				ownerName: "owner",
				ownerSessionId: "owner-session",
				token: "spawn-token",
				spawnTaskId: "spawn-worker",
			};

			const adapter = createPaseoPiMemberAdapter();
			const result = await adapter.spawn({
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: "worker",
				memberType: "worker",
				cwd: tempDir,
				systemPrompt: buildRoomBootstrapBlock(bootstrap),
			});

			assert.equal(result.backend, "paseo");
			assert.equal(result.runtimeId, "fake-paseo-agent");

			const createAgentOptions = (globalThis as Record<string, unknown>).__spawnTestCreateAgentOptions as Record<string, unknown> | undefined;
			assert.ok(createAgentOptions);
			assert.equal(createAgentOptions.labels, undefined);
		});
	});

	it("passes the paseo parent label when spawned from a paseo agent", async () => {
		await withTempDir(async (tempDir) => {
			const fakeCliPath = await writeFakePaseoCli(path.join(tempDir, "fake-paseo"));
			process.env.PI_ROOM_PASEO_CLI_PATH = fakeCliPath;
			process.env.PASEO_AGENT_ID = "parent-agent-123";

			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session",
				cwd: tempDir,
			});
			await createSpawningMember(created.roomDir, {
				name: "worker",
				type: "worker",
				backend: "paseo",
				taskId: "spawn-worker",
				bootstrapToken: "spawn-token",
			});

			const bootstrap: RoomBootstrap = {
				version: 1,
				roomId: created.metadata.roomId,
				roomDir: created.roomDir,
				memberName: "worker",
				memberType: "worker",
				ownerName: "owner",
				ownerSessionId: "owner-session",
				token: "spawn-token",
				spawnTaskId: "spawn-worker",
			};

			const adapter = createPaseoPiMemberAdapter();
			const result = await adapter.spawn({
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: "worker",
				memberType: "worker",
				cwd: tempDir,
				systemPrompt: buildRoomBootstrapBlock(bootstrap),
			});

			assert.equal(result.backend, "paseo");
			assert.equal(result.runtimeId, "fake-paseo-agent");

			const createAgentOptions = (globalThis as Record<string, unknown>).__spawnTestCreateAgentOptions as Record<string, unknown> | undefined;
			assert.ok(createAgentOptions);
			assert.deepEqual(createAgentOptions.labels, {
				"paseo.parent-agent-id": "parent-agent-123",
			});
		});
	});

	it("falls back to the paseo registry session lookup when PASEO_AGENT_ID is missing", async () => {
		await withTempDir(async (tempDir) => {
			const fakeCliPath = await writeFakePaseoCli(path.join(tempDir, "fake-paseo"));
			process.env.PI_ROOM_PASEO_CLI_PATH = fakeCliPath;
			process.env.HOME = tempDir;

			await fs.mkdir(path.join(tempDir, ".paseo", "agents", "home-thn-.pi-agent"), { recursive: true });
			await fs.writeFile(
				path.join(tempDir, ".paseo", "agents", "home-thn-.pi-agent", "parent-agent-456.json"),
				JSON.stringify({
					id: "parent-agent-456",
					runtimeInfo: {
						sessionId: "parent-session-456",
					},
				}),
				"utf8",
			);

			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session",
				cwd: tempDir,
			});
			await createSpawningMember(created.roomDir, {
				name: "worker",
				type: "worker",
				backend: "paseo",
				taskId: "spawn-worker",
				bootstrapToken: "spawn-token",
			});

			const bootstrap: RoomBootstrap = {
				version: 1,
				roomId: created.metadata.roomId,
				roomDir: created.roomDir,
				memberName: "worker",
				memberType: "worker",
				ownerName: "owner",
				ownerSessionId: "owner-session",
				token: "spawn-token",
				spawnTaskId: "spawn-worker",
			};

			const adapter = createPaseoPiMemberAdapter();
			const result = await adapter.spawn({
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: "worker",
				memberType: "worker",
				parentSessionId: "parent-session-456",
				cwd: tempDir,
				systemPrompt: buildRoomBootstrapBlock(bootstrap),
			});

			assert.equal(result.backend, "paseo");
			assert.equal(result.runtimeId, "fake-paseo-agent");

			const createAgentOptions = (globalThis as Record<string, unknown>).__spawnTestCreateAgentOptions as Record<string, unknown> | undefined;
			assert.ok(createAgentOptions);
			assert.deepEqual(createAgentOptions.labels, {
				"paseo.parent-agent-id": "parent-agent-456",
			});
		});
	});

	it("keeps the paseo spawn in claimed mid-state until owner re-finalizes after claim", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session",
				cwd: tempDir,
			});
			await createSpawningMember(created.roomDir, {
				name: "worker",
				type: "worker",
				backend: "paseo",
				taskId: "spawn-worker",
				bootstrapToken: "spawn-token",
			});

			const bootstrap: RoomBootstrap = {
				version: 1,
				roomId: created.metadata.roomId,
				roomDir: created.roomDir,
				memberName: "worker",
				memberType: "worker",
				ownerName: "owner",
				ownerSessionId: "owner-session",
				token: "spawn-token",
				spawnTaskId: "spawn-worker",
			};

			await finalizeMemberRuntime({
				roomDir: created.roomDir,
				memberName: "worker",
				taskId: "spawn-worker",
				runtimeId: "agent-42",
				backend: "paseo",
			});

			await claimMemberSession({
				bootstrap,
				sessionId: "member-session",
				memberPid: 4242,
			});

			let member = await loadRoomMemberState(created.roomDir, "worker");
			assert.equal(member.backend, "paseo");
			assert.equal(member.runtimeId, "agent-42");
			assert.equal(member.runtimeIdentitySource, "owner");
			assert.equal(member.state, "spawning");
			assert.equal(member.spawnTaskId, "spawn-worker");
			assert.equal(member.sessionId, "member-session");

			let job = await readSpawnJob(created.roomDir, "spawn-worker");
			assert.equal(job?.state, "claimed");
			assert.equal(job?.runtimeId, "agent-42");

			await finalizeMemberRuntime({
				roomDir: created.roomDir,
				memberName: "worker",
				taskId: "spawn-worker",
				runtimeId: "agent-42",
				backend: "paseo",
			});

			member = await loadRoomMemberState(created.roomDir, "worker");
			assert.equal(member.state, "idle");
			assert.equal(member.spawnTaskId, null);

			job = await readSpawnJob(created.roomDir, "spawn-worker");
			assert.equal(job?.state, "completed");
			assert.equal(job?.runtimeId, "agent-42");
		});
	});

	it("rejects finalize when an external-timeout tombstone has not been claimed", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-timeout-finalize-reject",
				cwd: tempDir,
			});
			await createSpawningMember(created.roomDir, {
				name: "worker",
				type: "worker",
				backend: "paseo",
				taskId: "spawn-timeout-finalize-reject",
				bootstrapToken: "timeout-finalize-token",
			});

			await reconcileSpawnTimeouts(created.roomDir, {
				pi: {
					kind: "pi",
					async spawn() {
						throw new Error("not used");
					},
				} as any,
				paseo: {
					kind: "paseo",
					async spawn() {
						throw new Error("not used");
					},
				} as any,
			}, { paseoExternalCreateTimeoutMs: 1 });

			await assert.rejects(
				() => finalizeMemberRuntime({
					roomDir: created.roomDir,
					memberName: "worker",
					taskId: "spawn-timeout-finalize-reject",
					runtimeId: "late-unclaimed-runtime",
					backend: "paseo",
				}),
				/requires cleanup/i,
			);
		});
	});

	it("completes the paseo spawn when bootstrap claim arrives before owner finalize", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session",
				cwd: tempDir,
			});
			await createSpawningMember(created.roomDir, {
				name: "worker",
				type: "worker",
				backend: "paseo",
				taskId: "spawn-worker",
				bootstrapToken: "spawn-token",
			});

			const bootstrap: RoomBootstrap = {
				version: 1,
				roomId: created.metadata.roomId,
				roomDir: created.roomDir,
				memberName: "worker",
				memberType: "worker",
				ownerName: "owner",
				ownerSessionId: "owner-session",
				token: "spawn-token",
				spawnTaskId: "spawn-worker",
			};

			await claimMemberSession({
				bootstrap,
				sessionId: "member-session",
				memberPid: 4242,
			});

			await finalizeMemberRuntime({
				roomDir: created.roomDir,
				memberName: "worker",
				taskId: "spawn-worker",
				runtimeId: "agent-43",
				backend: "paseo",
			});

			const member = await loadRoomMemberState(created.roomDir, "worker");
			assert.equal(member.backend, "paseo");
			assert.equal(member.runtimeId, "agent-43");
			assert.equal(member.runtimeIdentitySource, "owner");
			assert.equal(member.state, "idle");
			assert.equal(member.spawnTaskId, null);
			assert.equal(member.sessionId, "member-session");

			const job = await readSpawnJob(created.roomDir, "spawn-worker");
			assert.equal(job?.state, "completed");
			assert.equal(job?.runtimeId, "agent-43");
		});
	});

	it("persists paseo runtime through owner finalize when executeCrewAdd succeeds before claim", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session",
				cwd: tempDir,
			});

			setActiveRoom({
				role: "owner",
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: created.metadata.ownerName,
				sessionId: "owner-session",
				pollTimer: null,
				heartbeatTimer: null,
				pendingPoll: null,
				pendingHeartbeat: null,
				pendingToolTasks: new Set<Promise<unknown>>(),
				shuttingDown: false,
				pendingDeliveryBatch: [],
				deliveryTimer: null,
			});

			const paseoAdapter = {
				kind: "paseo" as const,
				async isAvailable() {
					return true;
				},
				async spawn() {
					return {
						runtimeId: "agent-owner-finalized",
						backend: "paseo" as const,
					};
				},
			};

			const result = await executeCrewAdd(
				{ name: "worker", type: "worker" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => "owner-session",
					},
				},
				runtimeRoot,
				{ pi: createPaseoPiMemberAdapter(), paseo: paseoAdapter },
				{ ownerName: "owner" },
			);

			assert.match(result.content[0]?.text ?? "", /queued/i);

			try {
				await waitFor(async () => {
					const member = await findMemberByAlias(created.roomDir, "worker");
					const jobs = (await fs.readdir(path.join(created.roomDir, "jobs")).catch(() => []))
						.filter((entry) => entry.startsWith("spawn-") && entry.endsWith(".json"));
					if (!member || jobs.length !== 1) return false;
					const taskId = parseSpawnTaskIdFromEntry(jobs[0]!);
					const job = await readSpawnJob(created.roomDir, taskId);
					return member.runtimeId === "agent-owner-finalized" && job?.state === "external_created";
				});
			} catch (error) {
				const member = await findMemberByAlias(created.roomDir, "worker");
				const jobs = (await fs.readdir(path.join(created.roomDir, "jobs")).catch(() => []))
					.filter((entry) => entry.startsWith("spawn-") && entry.endsWith(".json"));
				const taskId = jobs[0] ? parseSpawnTaskIdFromEntry(jobs[0]) : null;
				const job = taskId ? await readSpawnJob(created.roomDir, taskId) : null;
				throw new Error(`waitFor failed: ${String(error)}\nmember=${JSON.stringify(member)}\njob=${JSON.stringify(job)}`);
			}

			const member = await loadMemberByAlias(created.roomDir, "worker");
			assert.equal(member.backend, "paseo");
			assert.equal(member.runtimeId, "agent-owner-finalized");
			assert.equal(member.runtimeIdentitySource, "owner");
			assert.equal(member.state, "spawning");
			assert.match(member.spawnTaskId ?? "", /\S+/);

			const jobs = (await fs.readdir(path.join(created.roomDir, "jobs"))).filter((entry) => entry.startsWith("spawn-") && entry.endsWith(".json"));
			assert.equal(jobs.length, 1);
			const taskId = parseSpawnTaskIdFromEntry(jobs[0]!);
			const job = await readSpawnJob(created.roomDir, taskId);
			assert.equal(job?.state, "external_created");
			assert.equal(job?.runtimeId, "agent-owner-finalized");
		});
	});

	it("cleans up a late paseo spawn success after external-create timeout tombstones the job", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-late-success",
				cwd: tempDir,
			});

			setActiveRoom({
				role: "owner",
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: created.metadata.ownerName,
				sessionId: "owner-session-late-success",
				pollTimer: null,
				heartbeatTimer: null,
				pendingPoll: null,
				pendingHeartbeat: null,
				pendingToolTasks: new Set<Promise<unknown>>(),
				shuttingDown: false,
				pendingDeliveryBatch: [],
				deliveryTimer: null,
			});

			let releaseSpawn!: () => void;
			const spawnBlocked = new Promise<void>((resolve) => {
				releaseSpawn = resolve;
			});
			const removedRuntimeIds: string[] = [];

			const paseoAdapter = {
				kind: "paseo" as const,
				async isAvailable() {
					return true;
				},
				async spawn() {
					await spawnBlocked;
					return {
						runtimeId: "late-agent-runtime",
						backend: "paseo" as const,
					};
				},
				async remove(member: { runtimeId: string | null }) {
					removedRuntimeIds.push(member.runtimeId ?? "");
				},
			};

			const result = await executeCrewAdd(
				{ name: "worker", type: "worker" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => "owner-session-late-success",
					},
				},
				runtimeRoot,
				{ pi: createPaseoPiMemberAdapter(), paseo: paseoAdapter },
				{ ownerName: "owner" },
			);

			assert.match(result.content[0]?.text ?? "", /queued/i);

			await waitFor(async () => {
				const jobs = (await fs.readdir(path.join(created.roomDir, "jobs")).catch(() => []))
					.filter((entry) => entry.startsWith("spawn-") && entry.endsWith(".json"));
				if (jobs.length !== 1) return false;
				const taskId = parseSpawnTaskIdFromEntry(jobs[0]!);
				const job = await readSpawnJob(created.roomDir, taskId);
				return job?.state === "starting";
			});

			await reconcileSpawnTimeouts(created.roomDir, {
				pi: {
					kind: "pi",
					async spawn() {
						throw new Error("not used");
					},
				} as any,
				paseo: paseoAdapter,
			}, { paseoExternalCreateTimeoutMs: 1 });

			releaseSpawn();

			await waitFor(() => removedRuntimeIds.includes("late-agent-runtime"));

			const member = await loadMemberByAlias(created.roomDir, "worker");
			assert.equal(member.runtimeId, null);
			assert.equal(member.state, "error");
			assert.equal(member.spawnTaskId, null);
			assert.match(member.lastError ?? "", /late spawn success cleaned up/i);

			const jobs = (await fs.readdir(path.join(created.roomDir, "jobs"))).filter((entry) => entry.startsWith("spawn-") && entry.endsWith(".json"));
			assert.equal(jobs.length, 1);
			const taskId = parseSpawnTaskIdFromEntry(jobs[0]!);
			const job = await readSpawnJob(created.roomDir, taskId);
			assert.equal(job?.state, "cancelled");
			assert.equal(job?.runtimeId, "late-agent-runtime");

			await assert.rejects(
				() => createSpawningMember(created.roomDir, {
					name: member.name,
					displayName: member.displayName ?? "worker",
					type: "worker",
					backend: "paseo",
					taskId: "respawn-worker",
					bootstrapToken: "respawn-token",
				}),
				/already exists/i,
			);
		});
	});

	it("keeps external-timeout tombstones intact when a late claim arrives before spawn settles", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-timeout-claim-race",
				cwd: tempDir,
			});
			await createSpawningMember(created.roomDir, {
				name: "worker",
				type: "worker",
				backend: "paseo",
				taskId: "spawn-timeout-claim-race",
				bootstrapToken: "timeout-claim-token",
			});

			await reconcileSpawnTimeouts(created.roomDir, {
				pi: {
					kind: "pi",
					async spawn() {
						throw new Error("not used");
					},
				} as any,
				paseo: {
					kind: "paseo",
					async spawn() {
						throw new Error("not used");
					},
				} as any,
			}, { paseoExternalCreateTimeoutMs: 1 });

			const bootstrap: RoomBootstrap = {
				version: 1,
				roomId: created.metadata.roomId,
				roomDir: created.roomDir,
				memberName: "worker",
				memberType: "worker",
				ownerName: "owner",
				ownerSessionId: "owner-session-timeout-claim-race",
				token: "timeout-claim-token",
				spawnTaskId: "spawn-timeout-claim-race",
			};

			await claimMemberSession({
				bootstrap,
				sessionId: "late-session",
				memberPid: 4242,
			});

			const job = await readSpawnJob(created.roomDir, "spawn-timeout-claim-race");
			assert.equal(job?.state, "timed_out_pending_external_resolution");
		});
	});

	it("finalizes a late-resolving spawn when the timed-out generation has already claimed bootstrap", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-timeout-claim-finalize",
				cwd: tempDir,
			});

			setActiveRoom({
				role: "owner",
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: created.metadata.ownerName,
				sessionId: "owner-session-timeout-claim-finalize",
				pollTimer: null,
				heartbeatTimer: null,
				pendingPoll: null,
				pendingHeartbeat: null,
				pendingToolTasks: new Set<Promise<unknown>>(),
				shuttingDown: false,
				pendingDeliveryBatch: [],
				deliveryTimer: null,
			});

			let releaseSpawn!: () => void;
			const spawnBlocked = new Promise<void>((resolve) => {
				releaseSpawn = resolve;
			});
			const removedRuntimeIds: string[] = [];

			const paseoAdapter = {
				kind: "paseo" as const,
				async isAvailable() {
					return true;
				},
				async spawn() {
					await spawnBlocked;
					return {
						runtimeId: "late-claimed-runtime",
						backend: "paseo" as const,
					};
				},
				async remove(member: { runtimeId: string | null }) {
					if (member.runtimeId) removedRuntimeIds.push(member.runtimeId);
				},
			};

			await executeCrewAdd(
				{ name: "worker", type: "worker" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => "owner-session-timeout-claim-finalize",
					},
				},
				runtimeRoot,
				{ pi: createPaseoPiMemberAdapter(), paseo: paseoAdapter },
				{ ownerName: "owner" },
			);

			let claimedBootstrap: RoomBootstrap | null = null;
			await waitFor(async () => {
				const member = await findMemberByAlias(created.roomDir, "worker");
				if (!member?.spawnTaskId || !member.bootstrapToken) return false;
				const job = await readSpawnJob(created.roomDir, member.spawnTaskId).catch(() => null);
				if (job?.state !== "starting") return false;
				claimedBootstrap = {
					version: 1,
					roomId: created.metadata.roomId,
					roomDir: created.roomDir,
					memberName: member.name,
					memberType: "worker",
					ownerName: "owner",
					ownerSessionId: "owner-session-timeout-claim-finalize",
					token: member.bootstrapToken,
					spawnTaskId: member.spawnTaskId,
				};
				return true;
			});
			assert.ok(claimedBootstrap);

			await reconcileSpawnTimeouts(created.roomDir, {
				pi: {
					kind: "pi",
					async spawn() {
						throw new Error("not used");
					},
				} as any,
				paseo: paseoAdapter,
			}, { paseoExternalCreateTimeoutMs: 1 });

			await claimMemberSession({
				bootstrap: claimedBootstrap,
				sessionId: "late-claim-session",
				memberPid: 4242,
			});

			releaseSpawn();

			await waitFor(async () => {
				const member = await loadMemberByAlias(created.roomDir, "worker");
				const job = await readSpawnJob(created.roomDir, claimedBootstrap!.spawnTaskId);
				return member.state === "idle" && member.runtimeId === "late-claimed-runtime" && job?.state === "completed";
			});

			const member = await loadMemberByAlias(created.roomDir, "worker");
			assert.equal(member.state, "idle");
			assert.equal(member.runtimeId, "late-claimed-runtime");
			assert.equal(member.spawnTaskId, null);
			assert.equal(member.sessionId, "late-claim-session");

			const job = await readSpawnJob(created.roomDir, claimedBootstrap.spawnTaskId);
			assert.equal(job?.state, "completed");
			assert.equal(job?.runtimeId, "late-claimed-runtime");
			assert.deepEqual(removedRuntimeIds, []);
		});
	});

	it("retains the late runtime handle in the tombstone when late cleanup fails", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-late-cleanup-fail",
				cwd: tempDir,
			});

			setActiveRoom({
				role: "owner",
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: created.metadata.ownerName,
				sessionId: "owner-session-late-cleanup-fail",
				pollTimer: null,
				heartbeatTimer: null,
				pendingPoll: null,
				pendingHeartbeat: null,
				pendingToolTasks: new Set<Promise<unknown>>(),
				shuttingDown: false,
				pendingDeliveryBatch: [],
				deliveryTimer: null,
			});

			let releaseSpawn!: () => void;
			const spawnBlocked = new Promise<void>((resolve) => {
				releaseSpawn = resolve;
			});

			const paseoAdapter = {
				kind: "paseo" as const,
				async isAvailable() {
					return true;
				},
				async spawn() {
					await spawnBlocked;
					return {
						runtimeId: "late-runtime-preserved",
						backend: "paseo" as const,
					};
				},
				async remove() {
					throw new Error("cleanup exploded");
				},
			};

			await executeCrewAdd(
				{ name: "worker", type: "worker" },
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				{
					cwd: tempDir,
					hasUI: false,
					sessionManager: {
						getSessionId: () => "owner-session-late-cleanup-fail",
					},
				},
				runtimeRoot,
				{ pi: createPaseoPiMemberAdapter(), paseo: paseoAdapter },
				{ ownerName: "owner" },
			);

			await waitFor(async () => {
				const jobs = (await fs.readdir(path.join(created.roomDir, "jobs")).catch(() => []))
					.filter((entry) => entry.startsWith("spawn-") && entry.endsWith(".json"));
				if (jobs.length !== 1) return false;
				const taskId = parseSpawnTaskIdFromEntry(jobs[0]!);
				const job = await readSpawnJob(created.roomDir, taskId);
				return job?.state === "starting";
			});

			await reconcileSpawnTimeouts(created.roomDir, {
				pi: {
					kind: "pi",
					async spawn() {
						throw new Error("not used");
					},
				} as any,
				paseo: paseoAdapter,
			}, { paseoExternalCreateTimeoutMs: 1 });

			releaseSpawn();

			await waitFor(async () => {
				const jobs = (await fs.readdir(path.join(created.roomDir, "jobs")).catch(() => []))
					.filter((entry) => entry.startsWith("spawn-") && entry.endsWith(".json"));
				if (jobs.length !== 1) return false;
				const taskId = parseSpawnTaskIdFromEntry(jobs[0]!);
				const job = await readSpawnJob(created.roomDir, taskId);
				const member = await loadMemberByAlias(created.roomDir, "worker");
				return job?.state === "cancelled"
					&& job.runtimeId === "late-runtime-preserved"
					&& member.state === "error"
					&& member.runtimeId === "late-runtime-preserved";
			});

			const jobs = (await fs.readdir(path.join(created.roomDir, "jobs"))).filter((entry) => entry.startsWith("spawn-") && entry.endsWith(".json"));
			const taskId = parseSpawnTaskIdFromEntry(jobs[0]!);
			const job = await readSpawnJob(created.roomDir, taskId);
			assert.equal(job?.state, "cancelled");
			assert.equal(job?.runtimeId, "late-runtime-preserved");

			const member = await loadMemberByAlias(created.roomDir, "worker");
			assert.equal(member.state, "error");
			assert.equal(member.runtimeId, "late-runtime-preserved");
			assert.equal(member.spawnTaskId, null);
			assert.match(member.lastError ?? "", /late spawn success cleanup failed/i);
		});
	});
});
