import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, vi } from "vitest";
import roomExtension from "./index.ts";
import * as storageModule from "./storage.ts";
import {
	buildRoomBootstrapBlock,
	parseRoomBootstrapBlock,
	type RoomBootstrap,
} from "./bootstrap.ts";
import {
	deliverRoomMessage,
	formatRoomMessageContent,
} from "./dispatch.ts";
import {
	appendMessage,
	createRoom,
	createSpawningMember,
	deleteRoomMutationClient,
	findRoomByOwnerSessionId,
	getRoomHeartbeatPath,
	getRoomMemberStatePath,
	getRoomPath,
	getRoomMutationClient,
	initializeRoomRuntime,
	listBoardEntries,
	listRoomMembers,
	loadRoomMemberState,
	loadRoomMetadata,
	readMessage,
	readSpawnJob,
	setRoomMutationClient,
	writeJsonAtomic,
	writeMemberHeartbeat,
	writeRoomMemberState,
	writeRoomMetadata,
} from "./storage.ts";
import { MutationProxyServer } from "./mutation-proxy.ts";
import { createMutationClient } from "./mutation-client.ts";
import * as loggerModule from "./logger.ts";
import { appendTerminalTaskReplyAndNotify, recordTerminalTaskState } from "./task-terminal.ts";
import { executeCrewBatch, waitForMembersReady, waitForTaskTerminalReplies } from "./batch.ts";
import {
	createPiMemberAdapter,
	createPaseoPiMemberAdapter,
	getPiInvocation,
} from "./spawn.ts";
import { executeCrewRemove, executeCrewAdd, executeCrewStop, executeCrewMessages, executeCrewWho, executeCrewReply, executeCrewTell, executeCrewMerge, deriveMergeReadiness, collectCrewWhoEntries, queueCrewAdd, queueCrewTell } from "./tools.ts";
import { activateBootstrapRoom, clearActiveRoom, getActiveRoom, isOwnerClassificationReady, isOwnerClassificationUnavailable, processUnreadMessages, resetActiveRoomsForTests, setActiveRoom } from "./lifecycle.ts";
import { clearRoomDeps } from "./deps.ts";
import {
	reconcileMemberLiveness,
} from "./watchdog.ts";
import { createWorktree, git, persistWorktreeSnapshot } from "./worktree.ts";
import type { QueuedTaskHandle, RoomMemberState, RoomMetadata, RoomMessage, RoomSpawnAdapter } from "./types.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "room-feasibility-test-"));
	try {
		return await fn(dir);
	} finally {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			try {
				await fs.rm(dir, { recursive: true, force: true });
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (attempt === 19 || (code !== "ENOTEMPTY" && code !== "EBUSY")) throw error;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
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

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

type SnapshotMemberState = RoomMemberState & {
	lastSnapshotOid?: string | null;
	lastSnapshotTaskSeq?: number | null;
	lastSnapshotSummary?: string | null;
	lastSnapshotAt?: string | null;
	pendingTerminalReply?: {
		taskSeq: number;
		kind: string;
		snapshotOid: string | null;
		replyMessageId: string | null;
		handoffState: string;
	} | null;
};

async function initTestGitRepo(dir: string): Promise<string> {
	await git(["init"], dir, 10_000);
	await git(["config", "user.name", "Test Agent"], dir, 10_000);
	await git(["config", "user.email", "test-agent@example.com"], dir, 10_000);
	await fs.writeFile(path.join(dir, "README.md"), "seed\n", "utf8");
	await git(["add", "README.md"], dir, 10_000);
	await git(["commit", "-m", "seed"], dir, 10_000);
	return git(["rev-parse", "HEAD"], dir, 10_000);
}

async function countCommits(dir: string, ref = "HEAD"): Promise<number> {
	return parseInt(await git(["rev-list", "--count", ref], dir, 10_000), 10);
}

async function loadMemberByAlias(roomDir: string, alias: string): Promise<RoomMemberState | null> {
	const members = await listRoomMembers(roomDir);
	const match = members.find((member) => member.displayName === alias || member.name === alias);
	if (!match) return null;
	return await loadRoomMemberState(roomDir, match.name).catch(() => null);
}

async function waitForProcessExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
	if (child.exitCode !== null) return;
	try {
		await waitFor(() => child.exitCode !== null, timeoutMs);
		return;
	} catch {
		if (child.exitCode === null) {
			try {
				child.kill("SIGKILL");
			} catch {
				return;
			}
		}
		await waitFor(() => child.exitCode !== null, 1_000).catch(() => {});
	}
}

function hasRealPaseoRuntime(): boolean {
	if (process.env.PI_ROOM_SKIP_REAL_PASEO === "1") return false;
	const cliCheck = spawnSync("bash", ["-lc", "command -v paseo >/dev/null"], { stdio: "ignore" });
	if (cliCheck.status !== 0) return false;
	const daemonCheck = spawnSync("bash", ["-lc", "pgrep -f '@getpaseo/server/dist/server/server/index.js' >/dev/null"], { stdio: "ignore" });
	return daemonCheck.status === 0;
}

function isStrictRealPaseoEnabled(): boolean {
	return process.env.PI_ROOM_STRICT_REAL_PASEO === "1";
}

function createHarness(systemPrompt: string, options: { runtimeRoot?: string; extensionOptions?: Record<string, unknown> } = {}) {
	const lifecycleListeners = new Map<string, Array<(event?: unknown, ctx?: unknown) => void | Promise<void>>>();
	const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
	const registeredTools: Array<{ name: string; [key: string]: unknown }> = [];

	roomExtension({
		on(eventName: string, handler: (event?: unknown, ctx?: unknown) => void | Promise<void>) {
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
		registerTool(definition: { name: string; [key: string]: unknown }) {
			registeredTools.push(definition);
			return undefined;
		},
		sendMessage(message: unknown, options?: unknown) {
			sentMessages.push({ message, options });
		},
	} as any, {
		...options.extensionOptions,
		runtimeRoot: options.runtimeRoot ?? (options.extensionOptions as { runtimeRoot?: string } | undefined)?.runtimeRoot,
	});

	return {
		registeredTools,
		sentMessages,
		async emit(eventName: string, sessionId = "room-feasibility-session", event: Record<string, unknown> = {}) {
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

describe("crew_batch tool surface", () => {
	it("registers crew_batch", () => {
		const harness = createHarness("");
		expect(harness.registeredTools.map((tool) => tool.name)).toContain("crew_batch");
	});

	it("describes supported crew_batch templates in the tool surface", () => {
		const harness = createHarness("");
		const crewBatch = harness.registeredTools.find((tool) => tool.name === "crew_batch");
		expect((crewBatch?.parameters as { type?: string } | undefined)?.type).toBe("object");
		expect((crewBatch?.parameters as { oneOf?: Array<{ properties?: { template?: { const?: string } } }> } | undefined)?.oneOf?.map((entry) => entry.properties?.template?.const)).toEqual([
			"parallel-work-aggregate",
			"plan-review-loop",
			"implement-review-loop",
		]);
		expect(crewBatch?.description).toContain("parallel-work-aggregate");
		expect(crewBatch?.description).toContain("plan-review-loop");
		expect(crewBatch?.description).toContain("implement-review-loop");
		const templateDescriptions = (crewBatch?.parameters as { oneOf?: Array<{ properties?: { template?: { description?: string } } }> } | undefined)?.oneOf?.map((entry) => entry.properties?.template?.description ?? "") ?? [];
		expect(templateDescriptions.join(" ")).toContain("parallel-work-aggregate");
		expect(templateDescriptions.join(" ")).toContain("plan-review-loop");
		expect(templateDescriptions.join(" ")).toContain("implement-review-loop");
	});

	it("does not expose timeout params in crew_batch template schemas", () => {
		const harness = createHarness("");
		const crewBatch = harness.registeredTools.find((tool) => tool.name === "crew_batch");
		const variants = (crewBatch?.parameters as { oneOf?: Array<{ properties?: { params?: { properties?: Record<string, unknown> } } }> } | undefined)?.oneOf ?? [];
		expect(variants.length).toBeGreaterThan(0);
		for (const variant of variants) {
			const paramKeys = Object.keys(variant.properties?.params?.properties ?? {});
			expect(paramKeys).not.toContain("timeoutMs");
			expect(paramKeys).not.toContain("pollIntervalMs");
		}
	});

	it("keeps the renamed crew_cancel surface", () => {
		const harness = createHarness("");
		const toolNames = harness.registeredTools.map((tool) => tool.name);
		expect(toolNames).toContain("crew_cancel");
		expect(toolNames).not.toContain("crew_stop");
	});

	it("rejects unknown crew_batch templates", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const result = await executeCrewBatch(
				{ template: "unknown-template", params: {} },
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "",
					sessionManager: { getSessionId: () => "crew-batch-unknown-template" },
				},
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{ ownerName: "owner" },
			);
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text ?? "").toMatch(/unknown crew_batch template/i);
		});
	});

	it("rejects public timeout params for review-loop templates", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "crew-batch-reject-timeout",
				rootDir: tempDir,
				ownerCwd: tempDir,
			});
			setOwnerActiveRoomContext(created, "crew-batch-reject-timeout");
			try {
				const result = await executeCrewBatch(
					{
						template: "implement-review-loop",
						params: {
							author: { name: "coder", type: "worker" },
							reviewers: [{ name: "inspector", type: "reviewer" }],
							initialAuthorTask: "Implement the task",
							maxRounds: 3,
							timeoutMs: 60_000,
						},
					},
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "",
						sessionManager: { getSessionId: () => "crew-batch-reject-timeout" },
					},
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{ ownerName: "owner" },
				);
				expect(result.isError).toBeUndefined();
				expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "implement-review-loop"/i);
				const finalAggregate = await waitForBatchMessage(
					created.roomDir,
					(message) => message.kind === "error"
						&& /crew_batch template "implement-review-loop" failed/i.test(message.summary),
				);
				expect(finalAggregate.content ?? "").toMatch(/does not accept .*timeoutMs/i);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("rejects public timeout params for parallel template", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "crew-batch-reject-timeout-parallel",
				rootDir: tempDir,
				ownerCwd: tempDir,
			});
			setOwnerActiveRoomContext(created, "crew-batch-reject-timeout-parallel");
			try {
				const result = await executeCrewBatch(
					{
						template: "parallel-work-aggregate",
						params: {
							workers: [{ name: "alpha", type: "worker", task: "Do work" }],
							timeoutMs: 60_000,
						},
					},
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "",
						sessionManager: { getSessionId: () => "crew-batch-reject-timeout-parallel" },
					},
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{ ownerName: "owner" },
				);
				expect(result.isError).toBeUndefined();
				expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "parallel-work-aggregate"/i);
				const finalAggregate = await waitForBatchMessage(
					created.roomDir,
					(message) => message.kind === "error"
						&& /crew_batch template "parallel-work-aggregate" failed/i.test(message.summary),
				);
				expect(finalAggregate.content ?? "").toMatch(/does not accept .*timeoutMs/i);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	function createDeferredPromise(): { promise: Promise<void>; resolve: () => void } {
		let resolve!: () => void;
		const promise = new Promise<void>((resolvePromise) => {
			resolve = resolvePromise;
		});
		return { promise, resolve };
	}

	async function waitForBatchMessage(
		roomDir: string,
		predicate: (message: RoomMessage) => boolean,
		timeoutMs = 2_000,
	): Promise<RoomMessage> {
		let matched: RoomMessage | undefined;
		await waitFor(async () => {
			const board = await listBoardEntries(roomDir, Number.MAX_SAFE_INTEGER);
			matched = board.find(predicate);
			return Boolean(matched);
		}, timeoutMs);
		return matched!;
	}

	async function listVisibleOwnerMessages(
		roomDir: string,
		ownerName = "owner",
	): Promise<RoomMessage[]> {
		return (await listBoardEntries(roomDir, Number.MAX_SAFE_INTEGER)).filter((message) =>
			!message.silent
			&& (
				(message.broadcast && message.to === "room")
				|| message.to === ownerName
			));
	}

	function createParallelWorkAggregateAdapters(
		options: {
			roomDir: string;
			releaseReplies?: Promise<void>;
		},
	): { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter; memberJobs: Promise<void>[] } {
		const memberJobs: Promise<void>[] = [];
		return {
			memberJobs,
			pi: {
				kind: "pi",
				async isAvailable() {
					return true;
				},
				async spawn(request) {
					const alias = request.memberLabel?.split("#")[0] ?? request.memberName;
					const memberSessionId = `member-session-${request.memberName}`;
					memberJobs.push((async () => {
						await activateBootstrapRoom(
							{ sendMessage() { return undefined; } } as any,
							request.systemPrompt ?? "",
							memberSessionId,
							{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
						);
						if (!request.initialTask?.boardMessageSeq) {
							return;
						}
						await waitFor(async () => {
							const board = await listBoardEntries(options.roomDir, Number.MAX_SAFE_INTEGER);
							return board.some((message) =>
								message.seq === request.initialTask?.boardMessageSeq
								&& message.kind === "task"
								&& message.to === request.memberName);
						}, 2_000);
						await (options.releaseReplies ?? Promise.resolve());
						const board = await listBoardEntries(options.roomDir, Number.MAX_SAFE_INTEGER);
						const task = board.find((message) =>
							message.seq === request.initialTask?.boardMessageSeq
							&& message.kind === "task"
							&& message.to === request.memberName);
						if (!task) {
							return;
						}
						await appendMessage(options.roomDir, {
							from: request.memberName,
							to: task.from,
							silent: task.batchId ? true : undefined,
							batchId: task.batchId ?? undefined,
							broadcast: false,
							replyTo: task.id,
							kind: "completion",
							summary: `${alias} done`,
							content: `${alias} complete`,
						});
						const currentMember = await loadRoomMemberState(options.roomDir, request.memberName);
						await writeRoomMemberState(options.roomDir, {
							...currentMember,
							state: "idle",
							currentTask: null,
							currentTaskMessageId: null,
							lastCompletedTask: `${alias} done`,
							lastError: null,
							updatedAt: new Date().toISOString(),
						});
					})());
					return { runtimeId: `runtime-${request.memberName}`, backend: "pi" };
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
	}

	it("crew_batch returns immediately with an acknowledgment and appends one started aggregate message", async () => {
		await withTempDir(async (tempDir) => {
			const releaseReplies = createDeferredPromise();
			let memberJobs: Promise<void>[] = [];
			let trackedTasks: Promise<unknown>[] = [];
			try {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const ownerSessionId = "owner-session-parallel-work-aggregate";
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId,
					cwd: tempDir,
					ownerPid: process.pid,
				});
				setOwnerActiveRoomContext(created, ownerSessionId);
				const adapters = createParallelWorkAggregateAdapters({
					roomDir: created.roomDir,
					releaseReplies: releaseReplies.promise,
				});
				memberJobs = adapters.memberJobs;

				const result = await executeCrewBatch(
					{
						template: "parallel-work-aggregate",
						params: {
							workers: [
								{ name: "alpha", type: "worker", task: "Draft alpha findings" },
								{ name: "beta", type: "worker", task: "Draft beta findings" },
								{ name: "gamma", type: "worker" },
							],
						},
					},
					{
						sendMessage(message: unknown, options?: unknown) {
							sentMessages.push({ message, options });
							return undefined;
						},
					} as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "",
						sessionManager: { getSessionId: () => ownerSessionId },
					},
					runtimeRoot,
					adapters,
					{ ownerName: "owner" },
				);

				expect(result.isError).toBeUndefined();
				expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "parallel-work-aggregate"/i);
				trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
				expect(trackedTasks).toHaveLength(1);
				const started = await waitForBatchMessage(
					created.roomDir,
					(message) =>
						message.kind === "info"
						&& message.broadcast
						&& /started crew_batch template "parallel-work-aggregate"/i.test(message.summary),
				);
				expect(started.replyTo).toBeNull();
				const publicBatchMessages = (await listBoardEntries(created.roomDir, Number.MAX_SAFE_INTEGER))
					.filter((message) =>
						message.broadcast
						&& !message.silent
						&& /crew_batch template "parallel-work-aggregate"/i.test(message.summary));
				expect(publicBatchMessages).toHaveLength(1);
			} finally {
				releaseReplies.resolve();
				await Promise.allSettled(memberJobs);
				await Promise.allSettled(trackedTasks);
				resetActiveRoomsForTests();
			}
		});
	});

	it("crew_batch no longer blocks until final worker replies", async () => {
		await withTempDir(async (tempDir) => {
			const releaseReplies = createDeferredPromise();
			let memberJobs: Promise<void>[] = [];
			let trackedTasks: Promise<unknown>[] = [];
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-parallel-work-aggregate-non-blocking";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const adapters = createParallelWorkAggregateAdapters({
				roomDir: created.roomDir,
				releaseReplies: releaseReplies.promise,
			});
			memberJobs = adapters.memberJobs;

			const batchPromise = executeCrewBatch(
				{
					template: "parallel-work-aggregate",
					params: {
						workers: [
							{ name: "alpha", type: "worker", task: "Draft alpha findings" },
						],
					},
				},
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "",
					sessionManager: { getSessionId: () => ownerSessionId },
				},
				runtimeRoot,
				adapters,
				{ ownerName: "owner" },
			);

			try {
				const raced = await Promise.race([
					batchPromise.then((result) => ({ kind: "returned" as const, result })),
					new Promise<{ kind: "timeout" }>((resolve) => {
						setTimeout(() => resolve({ kind: "timeout" }), 25);
					}),
				]);
				expect(raced.kind).toBe("returned");
				const result = raced.kind === "returned" ? raced.result : await batchPromise;
				expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "parallel-work-aggregate"/i);
				trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
				expect(trackedTasks).toHaveLength(1);
				const started = await waitForBatchMessage(
					created.roomDir,
					(message) =>
						message.kind === "info"
						&& /started crew_batch template "parallel-work-aggregate"/i.test(message.summary),
				);
				const board = await listBoardEntries(created.roomDir, Number.MAX_SAFE_INTEGER);
				expect(board.find((message) =>
					message.replyTo === started.id
					&& (message.kind === "completion" || message.kind === "error"))).toBeUndefined();
			} finally {
				releaseReplies.resolve();
				await Promise.allSettled([batchPromise]);
				await Promise.allSettled(memberJobs);
				await Promise.allSettled(trackedTasks);
				resetActiveRoomsForTests();
			}
		});
	});

	it("crew_batch final aggregate replies to the started aggregate for public correlation", async () => {
		await withTempDir(async (tempDir) => {
			const releaseReplies = createDeferredPromise();
			let memberJobs: Promise<void>[] = [];
			let trackedTasks: Promise<unknown>[] = [];
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-parallel-work-aggregate-final-aggregate";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const adapters = createParallelWorkAggregateAdapters({
				roomDir: created.roomDir,
				releaseReplies: releaseReplies.promise,
			});
			memberJobs = adapters.memberJobs;

			try {
				const result = await executeCrewBatch(
					{
						template: "parallel-work-aggregate",
						params: {
							workers: [
								{ name: "alpha", type: "worker", task: "Draft alpha findings" },
								{ name: "beta", type: "worker" },
							],
						},
					},
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "",
						sessionManager: { getSessionId: () => ownerSessionId },
					},
					runtimeRoot,
					adapters,
					{ ownerName: "owner" },
				);

				expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "parallel-work-aggregate"/i);
				trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
				expect(trackedTasks).toHaveLength(1);
				const started = await waitForBatchMessage(
					created.roomDir,
					(message) =>
						message.kind === "info"
						&& /started crew_batch template "parallel-work-aggregate"/i.test(message.summary),
				);
				releaseReplies.resolve();
				await Promise.all(memberJobs);
				await Promise.allSettled(trackedTasks);
				const finalAggregate = await waitForBatchMessage(
					created.roomDir,
					(message) =>
						message.replyTo === started.id
						&& (message.kind === "completion" || message.kind === "error"),
				);
				expect(finalAggregate.replyTo).toBe(started.id);
				expect(finalAggregate.content ?? "").toContain("crew_batch template: parallel-work-aggregate");
				expect(finalAggregate.content ?? "").toContain("alpha");
				expect(finalAggregate.content ?? "").toContain("task=completion");
			} finally {
				releaseReplies.resolve();
				await Promise.allSettled(memberJobs);
				await Promise.allSettled(trackedTasks);
				resetActiveRoomsForTests();
			}
		});
	});

	it("parallel-work-aggregate pushes one final aggregate message to the lead", async () => {
		await withTempDir(async (tempDir) => {
			const releaseReplies = createDeferredPromise();
			let memberJobs: Promise<void>[] = [];
			let trackedTasks: Promise<unknown>[] = [];
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-parallel-work-aggregate-final-message";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const adapters = createParallelWorkAggregateAdapters({
				roomDir: created.roomDir,
				releaseReplies: releaseReplies.promise,
			});
			memberJobs = adapters.memberJobs;

			try {
				const result = await executeCrewBatch(
					{
						template: "parallel-work-aggregate",
						params: {
							workers: [
								{ name: "aggregate_alpha", type: "worker", task: "Draft alpha findings" },
								{ name: "aggregate_beta", type: "worker", task: "Draft beta findings" },
							],
						},
					},
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "",
						sessionManager: { getSessionId: () => ownerSessionId },
					},
					runtimeRoot,
					adapters,
					{ ownerName: "owner" },
				);

				expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "parallel-work-aggregate"/i);
				trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
				expect(trackedTasks).toHaveLength(1);
				const started = await waitForBatchMessage(
					created.roomDir,
					(message) =>
						message.kind === "info"
						&& /started crew_batch template "parallel-work-aggregate"/i.test(message.summary),
				);
				releaseReplies.resolve();
				await Promise.all(memberJobs);
				await Promise.allSettled(trackedTasks);

				const finalAggregate = await waitForBatchMessage(
					created.roomDir,
					(message) => message.replyTo === started.id && message.kind === "completion",
				);
				expect(finalAggregate.content ?? "").toContain("aggregate_alpha");
				expect(finalAggregate.content ?? "").toContain("aggregate_beta");

				const visibleOwnerMessages = await listVisibleOwnerMessages(created.roomDir);
				expect(visibleOwnerMessages.map((message) => ({
					kind: message.kind,
					summary: message.summary,
					replyTo: message.replyTo,
				}))).toEqual([
					{
						kind: "info",
						summary: started.summary,
						replyTo: null,
					},
					{
						kind: "completion",
						summary: finalAggregate.summary,
						replyTo: started.id,
					},
				]);
			} finally {
				releaseReplies.resolve();
				await Promise.allSettled(memberJobs);
				await Promise.allSettled(trackedTasks);
				resetActiveRoomsForTests();
			}
		});
	});

	it("logs background batch failures that escape final aggregate publishing", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-parallel-work-aggregate-logging";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const adapters = createParallelWorkAggregateAdapters({
				roomDir: created.roomDir,
			});
			const originalAppendMessage = storageModule.appendMessage;
			const aggregateError = new Error("aggregate append exploded");
			const appendSpy = vi.spyOn(storageModule, "appendMessage")
				.mockImplementation(async (...args: Parameters<typeof storageModule.appendMessage>) => {
					const [, message] = args;
					if (
						message.from === "system"
						&& message.broadcast
						&& message.replyTo
						&& /crew_batch template "parallel-work-aggregate" completed/i.test(message.summary)
					) {
						throw aggregateError;
					}
					return await originalAppendMessage(...args);
				});
			const log = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			};
			const loggerSpy = vi.spyOn(loggerModule, "createRoomLogger")
				.mockReturnValue(log as any);
			let trackedTasks: Promise<unknown>[] = [];

			try {
				const result = await executeCrewBatch(
					{
						template: "parallel-work-aggregate",
						params: {
							workers: [
								{ name: "alpha", type: "worker", task: "Draft alpha findings" },
							],
						},
					},
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "",
						sessionManager: { getSessionId: () => ownerSessionId },
					},
					runtimeRoot,
					adapters,
					{ ownerName: "owner" },
				);

				expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "parallel-work-aggregate"/i);
				trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
				expect(trackedTasks).toHaveLength(1);
				await Promise.allSettled(adapters.memberJobs);
				await Promise.allSettled(trackedTasks);

				expect(log.error).toHaveBeenCalledWith(
					"crew_batch final aggregate publishing failed",
					{
						template: "parallel-work-aggregate",
						batchId: expect.any(String),
						error: String(aggregateError),
					},
				);
			} finally {
				appendSpy.mockRestore();
				loggerSpy.mockRestore();
				await Promise.allSettled(adapters.memberJobs);
				await Promise.allSettled(trackedTasks);
				resetActiveRoomsForTests();
			}
		});
	});

	function createReviewLoopAdapters(
		roomDir: string,
		scripts: Record<string, Array<{ kind: "completion" | "error" | "cancelled"; summary: string; content?: string }>>,
	): { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter; memberJobs: Promise<void>[] } {
		const memberJobs: Promise<void>[] = [];
		return {
			memberJobs,
			pi: {
				kind: "pi",
				async isAvailable() {
					return true;
				},
				async spawn(request) {
					const alias = request.memberLabel?.split("#")[0] ?? request.memberName;
					const memberSessionId = `member-session-${request.memberName}`;
					const replies = [...(scripts[alias] ?? [])];
					memberJobs.push((async () => {
						await activateBootstrapRoom(
							{ sendMessage() { return undefined; } } as any,
							request.systemPrompt ?? "",
							memberSessionId,
							{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
						);
						const repliedTaskIds = new Set<string>();
						await waitFor(async () => {
							const board = await listBoardEntries(roomDir, Number.MAX_SAFE_INTEGER);
							for (const message of board) {
								if (
									message.kind !== "task"
									|| message.to !== request.memberName
									|| repliedTaskIds.has(message.id)
									|| replies.length === 0
								) {
									continue;
								}
								repliedTaskIds.add(message.id);
								const nextReply = replies.shift()!;
								await appendMessage(roomDir, {
									from: request.memberName,
									to: message.from,
									silent: message.batchId ? true : undefined,
									batchId: message.batchId ?? undefined,
									broadcast: false,
									replyTo: message.id,
									kind: nextReply.kind,
									summary: nextReply.summary,
									content: nextReply.content,
								});
								const currentMember = await loadRoomMemberState(roomDir, request.memberName);
								await writeRoomMemberState(roomDir, {
									...currentMember,
									state: "idle",
									currentTask: null,
									currentTaskMessageId: null,
									lastCompletedTask: nextReply.kind === "completion"
										? nextReply.summary
										: currentMember.lastCompletedTask,
									lastError: nextReply.kind === "error"
										? nextReply.summary
										: null,
									updatedAt: new Date().toISOString(),
								});
							}
							return replies.length === 0;
						}, 2_000);
					})());
					return { runtimeId: `runtime-${request.memberName}`, backend: "pi" };
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
	}

	async function waitForQueuedJobSet(
		memberJobs: Promise<void>[],
		trackedTasks: Promise<unknown>[],
	): Promise<void> {
		let previousCount = -1;
		while (memberJobs.length !== previousCount) {
			previousCount = memberJobs.length;
			await Promise.allSettled(trackedTasks);
			await Promise.allSettled([...memberJobs]);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	it("injects explicit reviewer verdict instructions", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-review-loop-instructions";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const adapters = createReviewLoopAdapters(created.roomDir, {
				author: [
					{ kind: "completion", summary: "Plan draft v1", content: "Initial plan draft." },
				],
				reviewer: [
					{ kind: "completion", summary: "VERDICT: PASS — Looks good", content: "Pass." },
				],
			});

			const result = await executeCrewBatch(
				{
					template: "plan-review-loop",
					params: {
						author: { name: "author", type: "worker" },
						reviewers: [{ name: "reviewer", type: "worker" }],
						initialAuthorTask: "Draft the execution plan.",
						maxRounds: 1,
					},
				},
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "",
					sessionManager: { getSessionId: () => ownerSessionId },
				},
				runtimeRoot,
				adapters,
				{ ownerName: "owner" },
			);

			expect(result.isError).toBeUndefined();
			const trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
			expect(trackedTasks).toHaveLength(1);
			await waitForQueuedJobSet(adapters.memberJobs, trackedTasks);

			const board = await listBoardEntries(created.roomDir, Number.MAX_SAFE_INTEGER);
			const reviewerTask = board.find((entry) =>
				entry.kind === "task"
				&& entry.to.startsWith("reviewer_")
				&& entry.summary === "Plan review task round 1");
			expect(reviewerTask?.content ?? "").toContain('crew_reply(kind="completion", summary="VERDICT: PASS — ');
			expect(reviewerTask?.content ?? "").toContain('crew_reply(kind="completion", summary="VERDICT: FAIL — ');
			expect(reviewerTask?.content ?? "").toContain("error/cancelled means review execution failed");
			expect(reviewerTask?.content ?? "").toContain("missing or malformed verdict is a protocol failure");
		});
	});

	it("plan-review-loop iterates after reviewer rejection, then succeeds when reviewers pass", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-plan-review-loop";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const adapters = createReviewLoopAdapters(created.roomDir, {
				author: [
					{ kind: "completion", summary: "Plan draft v1", content: "Initial plan draft." },
					{ kind: "completion", summary: "Plan draft v2", content: "Revised plan draft." },
				],
				reviewerA: [
					{ kind: "completion", summary: "VERDICT: FAIL — Needs stronger rollback plan", content: "Reject until rollback steps are explicit." },
					{ kind: "completion", summary: "VERDICT: PASS — Rollback plan now looks good", content: "Pass." },
				],
				reviewerB: [
					{ kind: "completion", summary: "VERDICT: PASS — Looks fine after revision", content: "Pass." },
					{ kind: "completion", summary: "VERDICT: PASS — Still good", content: "Pass." },
				],
			});

			const result = await executeCrewBatch(
				{
					template: "plan-review-loop",
					params: {
						author: { name: "author", type: "worker" },
						reviewers: [
							{ name: "reviewerA", type: "worker" },
							{ name: "reviewerB", type: "worker" },
						],
						initialAuthorTask: "Draft the execution plan.",
						maxRounds: 3,
					},
				},
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "",
					sessionManager: { getSessionId: () => ownerSessionId },
				},
				runtimeRoot,
				adapters,
				{ ownerName: "owner" },
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "plan-review-loop"/i);
			const trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
			expect(trackedTasks).toHaveLength(1);
			const started = await waitForBatchMessage(
				created.roomDir,
				(message) =>
					message.kind === "info"
					&& /started crew_batch template "plan-review-loop"/i.test(message.summary),
			);
			await waitForQueuedJobSet(adapters.memberJobs, trackedTasks);
			const finalAggregate = await waitForBatchMessage(
				created.roomDir,
				(message) => message.replyTo === started.id && message.kind === "completion",
			);
			const text = finalAggregate.content ?? "";
			expect(text).toContain("crew_batch template: plan-review-loop");
			expect(text).toContain("status: passed");
			expect(text).toContain("rounds: 2/3");
			expect(text).toContain("VERDICT: FAIL — Needs stronger rollback plan");
			expect(text).toContain("VERDICT: PASS — Rollback plan now looks good");
			expect(text).toContain("Plan draft v2");
		});
	});

	it("review-loop treats completion plus VERDICT: FAIL as needs revision", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-review-loop-verdict-fail";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const adapters = createReviewLoopAdapters(created.roomDir, {
				author: [
					{ kind: "completion", summary: "Plan draft v1", content: "Initial plan draft." },
					{ kind: "completion", summary: "Plan draft v2", content: "Revised plan draft." },
				],
				reviewer: [
					{ kind: "completion", summary: "VERDICT: FAIL — Needs stronger rollback plan", content: "Reject until rollback steps are explicit." },
					{ kind: "completion", summary: "VERDICT: PASS — Rollback plan now looks good", content: "Pass." },
				],
			});

			const result = await executeCrewBatch(
				{
					template: "plan-review-loop",
					params: {
						author: { name: "author", type: "worker" },
						reviewers: [{ name: "reviewer", type: "worker" }],
						initialAuthorTask: "Draft the execution plan.",
						maxRounds: 3,
					},
				},
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "",
					sessionManager: { getSessionId: () => ownerSessionId },
				},
				runtimeRoot,
				adapters,
				{ ownerName: "owner" },
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "plan-review-loop"/i);
			const trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
			expect(trackedTasks).toHaveLength(1);
			const started = await waitForBatchMessage(
				created.roomDir,
				(message) =>
					message.kind === "info"
					&& /started crew_batch template "plan-review-loop"/i.test(message.summary),
			);
			await waitForQueuedJobSet(adapters.memberJobs, trackedTasks);
			const finalAggregate = await waitForBatchMessage(
				created.roomDir,
				(message) => message.replyTo === started.id && message.kind === "completion",
			);
			const text = finalAggregate.content ?? "";
			expect(text).toContain("status: passed");
			expect(text).toContain("rounds: 2/3");
			expect(text).toContain("VERDICT: FAIL — Needs stronger rollback plan");
			expect(text).toContain("VERDICT: PASS — Rollback plan now looks good");

			const board = await listBoardEntries(created.roomDir, Number.MAX_SAFE_INTEGER);
			const authorTasks = board.filter((entry) =>
				entry.kind === "task"
				&& entry.from === "owner"
				&& (entry.summary === "Plan author task round 1" || entry.summary === "Plan revision round 2"));
			expect(authorTasks.map((entry) => entry.summary)).toEqual([
				"Plan author task round 1",
				"Plan revision round 2",
			]);
		});
	});

	it("review-loop treats completion plus VERDICT: PASS as pass", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-review-loop-verdict-pass";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const adapters = createReviewLoopAdapters(created.roomDir, {
				author: [
					{ kind: "completion", summary: "Plan draft v1", content: "Initial plan draft." },
				],
				reviewer: [
					{ kind: "completion", summary: "VERDICT: PASS — Looks good", content: "Pass." },
				],
			});

			const result = await executeCrewBatch(
				{
					template: "plan-review-loop",
					params: {
						author: { name: "author", type: "worker" },
						reviewers: [{ name: "reviewer", type: "worker" }],
						initialAuthorTask: "Draft the execution plan.",
						maxRounds: 2,
					},
				},
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "",
					sessionManager: { getSessionId: () => ownerSessionId },
				},
				runtimeRoot,
				adapters,
				{ ownerName: "owner" },
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "plan-review-loop"/i);
			const trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
			expect(trackedTasks).toHaveLength(1);
			const started = await waitForBatchMessage(
				created.roomDir,
				(message) =>
					message.kind === "info"
					&& /started crew_batch template "plan-review-loop"/i.test(message.summary),
			);
			await waitForQueuedJobSet(adapters.memberJobs, trackedTasks);
			const finalAggregate = await waitForBatchMessage(
				created.roomDir,
				(message) => message.replyTo === started.id && message.kind === "completion",
			);
			const text = finalAggregate.content ?? "";
			expect(text).toContain("status: passed");
			expect(text).toContain("rounds: 1/2");
			expect(text).toContain("VERDICT: PASS — Looks good");
		});
	});

	it("review-loop treats completion without explicit verdict as terminal protocol failure", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-review-loop-explicit-verdict";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const adapters = createReviewLoopAdapters(created.roomDir, {
				author: [
					{ kind: "completion", summary: "Plan draft v1", content: "Initial plan draft." },
				],
				reviewer: [
					{ kind: "completion", summary: "Looks good", content: "Pass." },
				],
			});

			const result = await executeCrewBatch(
				{
					template: "plan-review-loop",
					params: {
						author: { name: "author", type: "worker" },
						reviewers: [{ name: "reviewer", type: "worker" }],
						initialAuthorTask: "Draft the execution plan.",
						maxRounds: 3,
					},
				},
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "",
					sessionManager: { getSessionId: () => ownerSessionId },
				},
				runtimeRoot,
				adapters,
				{ ownerName: "owner" },
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "plan-review-loop"/i);
			const trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
			expect(trackedTasks).toHaveLength(1);
			const started = await waitForBatchMessage(
				created.roomDir,
				(message) =>
					message.kind === "info"
					&& /started crew_batch template "plan-review-loop"/i.test(message.summary),
			);
			await waitForQueuedJobSet(adapters.memberJobs, trackedTasks);
			const finalAggregate = await waitForBatchMessage(
				created.roomDir,
				(message) => message.replyTo === started.id && message.kind === "error",
			);
			const text = finalAggregate.content ?? "";
			expect(text).toContain("status: protocol-failed");
			expect(text).toContain("violated the verdict contract");
			expect(text).toMatch(/reviewer reviewer_[a-z0-9]+ ended round 1 without a valid verdict/);
			expect(text).not.toContain("Plan revision round 2");

			const board = await listBoardEntries(created.roomDir, Number.MAX_SAFE_INTEGER);
			const authorTasks = board.filter((entry) =>
				entry.kind === "task"
				&& entry.from === "owner"
				&& (entry.summary === "Plan author task round 1" || entry.summary === "Plan revision round 2"));
			expect(authorTasks.map((entry) => entry.summary)).toEqual([
				"Plan author task round 1",
			]);
		});
	});

	it("review-loop treats reviewer execution failure as terminal batch failure", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-review-loop-execution-failure";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const adapters = createReviewLoopAdapters(created.roomDir, {
				author: [
					{ kind: "completion", summary: "Plan draft v1", content: "Initial plan draft." },
					{ kind: "completion", summary: "Plan draft v2", content: "Unexpected extra revision." },
				],
				reviewer: [
					{ kind: "error", summary: "Review process crashed", content: "Tooling failed before verdict." },
				],
			});

			const result = await executeCrewBatch(
				{
					template: "plan-review-loop",
					params: {
						author: { name: "author", type: "worker" },
						reviewers: [{ name: "reviewer", type: "worker" }],
						initialAuthorTask: "Draft the execution plan.",
						maxRounds: 3,
					},
				},
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "",
					sessionManager: { getSessionId: () => ownerSessionId },
				},
				runtimeRoot,
				adapters,
				{ ownerName: "owner" },
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "plan-review-loop"/i);
			const trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
			expect(trackedTasks).toHaveLength(1);
			const started = await waitForBatchMessage(
				created.roomDir,
				(message) =>
					message.kind === "info"
					&& /started crew_batch template "plan-review-loop"/i.test(message.summary),
			);
			await waitForQueuedJobSet(adapters.memberJobs, trackedTasks);
			const finalAggregate = await waitForBatchMessage(
				created.roomDir,
				(message) => message.replyTo === started.id && message.kind === "error",
			);
			const text = finalAggregate.content ?? "";
			expect(text).toContain("status: review-execution-failed");
			expect(text).toContain("Review process crashed");
			expect(text).toContain("ended round 1 with error");

			const board = await listBoardEntries(created.roomDir, Number.MAX_SAFE_INTEGER);
			const authorTasks = board.filter((entry) =>
				entry.kind === "task"
				&& entry.from === "owner"
				&& (entry.summary === "Plan author task round 1" || entry.summary === "Plan revision round 2"));
			expect(authorTasks.map((entry) => entry.summary)).toEqual([
				"Plan author task round 1",
			]);
		});
	});

	it("implement-review-loop uses the same engine and returns a final aggregated summary", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-implement-review-loop";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const adapters = createReviewLoopAdapters(created.roomDir, {
				implementer: [
					{ kind: "completion", summary: "Patch applied", content: "Implemented the fix." },
				],
				reviewer: [
					{ kind: "completion", summary: "VERDICT: PASS — Fix passes review", content: "Pass." },
				],
			});

			const result = await executeCrewBatch(
				{
					template: "implement-review-loop",
					params: {
						author: { name: "implementer", type: "worker" },
						reviewers: [{ name: "reviewer", type: "worker" }],
						initialAuthorTask: "Implement the approved fix.",
						maxRounds: 2,
					},
				},
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "",
					sessionManager: { getSessionId: () => ownerSessionId },
				},
				runtimeRoot,
				adapters,
				{ ownerName: "owner" },
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "implement-review-loop"/i);
			const trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
			expect(trackedTasks).toHaveLength(1);
			const started = await waitForBatchMessage(
				created.roomDir,
				(message) =>
					message.kind === "info"
					&& /started crew_batch template "implement-review-loop"/i.test(message.summary),
			);
			await waitForQueuedJobSet(adapters.memberJobs, trackedTasks);
			const finalAggregate = await waitForBatchMessage(
				created.roomDir,
				(message) => message.replyTo === started.id && message.kind === "completion",
			);
			const text = finalAggregate.content ?? "";
			expect(text).toContain("crew_batch template: implement-review-loop");
			expect(text).toContain("status: passed");
			expect(text).toContain("rounds: 1/2");
			expect(text).toContain("Patch applied");
			expect(text).toContain("VERDICT: PASS — Fix passes review");
		});
	});

	it("plan-review-loop reports a final rejection when reviewers reject the author's last allowed round", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-plan-review-loop-final-rejection";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const adapters = createReviewLoopAdapters(created.roomDir, {
				author: [
					{ kind: "completion", summary: "Plan draft v1", content: "Initial draft." },
					{ kind: "completion", summary: "Plan draft v2", content: "Final allowed draft." },
				],
				reviewer: [
					{ kind: "completion", summary: "VERDICT: FAIL — Needs revision", content: "Reject round 1." },
					{ kind: "completion", summary: "VERDICT: FAIL — Still rejected", content: "Reject final round." },
				],
			});

			const result = await executeCrewBatch(
				{
					template: "plan-review-loop",
					params: {
						author: { name: "author", type: "worker" },
						reviewers: [{ name: "reviewer", type: "worker" }],
						initialAuthorTask: "Draft the batch plan.",
						maxRounds: 2,
					},
				},
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "",
					sessionManager: { getSessionId: () => ownerSessionId },
				},
				runtimeRoot,
				adapters,
				{ ownerName: "owner" },
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "plan-review-loop"/i);
			const trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
			expect(trackedTasks).toHaveLength(1);
			const started = await waitForBatchMessage(
				created.roomDir,
				(message) =>
					message.kind === "info"
					&& /started crew_batch template "plan-review-loop"/i.test(message.summary),
			);
			await waitForQueuedJobSet(adapters.memberJobs, trackedTasks);
			const finalAggregate = await waitForBatchMessage(
				created.roomDir,
				(message) => message.replyTo === started.id && message.kind === "error",
			);
			const text = finalAggregate.content ?? "";
			expect(text).toContain("status: max-rounds-exhausted");
			expect(text).toContain("rounds: 2/2");
			expect(text).toContain("VERDICT: FAIL — Still rejected");
			expect(text).toContain("final round 2 was rejected");

			const board = await listBoardEntries(created.roomDir, Number.MAX_SAFE_INTEGER);
			const authorTasks = board.filter((entry) =>
				entry.kind === "task"
				&& entry.from === "owner"
				&& (entry.summary === "Plan author task round 1" || entry.summary === "Plan revision round 2"));
			expect(authorTasks.map((entry) => entry.summary)).toEqual([
				"Plan author task round 1",
				"Plan revision round 2",
			]);
		});
	});

	it("review-loop pushes started + final aggregate only, without extra public owner noise", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-plan-review-loop-final-message";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const adapters = createReviewLoopAdapters(created.roomDir, {
				author_final_message: [
					{ kind: "completion", summary: "Plan draft v1", content: "Initial plan draft." },
					{ kind: "completion", summary: "Plan draft v2", content: "Revised plan draft." },
				],
				reviewer_final_message: [
					{ kind: "completion", summary: "VERDICT: FAIL — Needs stronger rollback plan", content: "Reject until rollback steps are explicit." },
					{ kind: "completion", summary: "VERDICT: PASS — Rollback plan now looks good", content: "Pass." },
				],
			});

			const result = await executeCrewBatch(
				{
					template: "plan-review-loop",
					params: {
						author: { name: "author_final_message", type: "worker" },
						reviewers: [{ name: "reviewer_final_message", type: "worker" }],
						initialAuthorTask: "Draft the execution plan.",
						maxRounds: 3,
					},
				},
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "",
					sessionManager: { getSessionId: () => ownerSessionId },
				},
				runtimeRoot,
				adapters,
				{ ownerName: "owner" },
			);

			expect(result.content[0]?.text ?? "").toMatch(/started crew_batch template "plan-review-loop"/i);
			const trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
			expect(trackedTasks).toHaveLength(1);
			const started = await waitForBatchMessage(
				created.roomDir,
				(message) =>
					message.kind === "info"
					&& /started crew_batch template "plan-review-loop"/i.test(message.summary),
			);
			await waitForQueuedJobSet(adapters.memberJobs, trackedTasks);
			const finalAggregate = await waitForBatchMessage(
				created.roomDir,
				(message) => message.replyTo === started.id && message.kind === "completion",
			);

			const visibleOwnerMessages = await listVisibleOwnerMessages(created.roomDir);
			expect(visibleOwnerMessages.map((message) => ({
				kind: message.kind,
				summary: message.summary,
				replyTo: message.replyTo,
			}))).toEqual([
				{
					kind: "info",
					summary: started.summary,
					replyTo: null,
				},
				{
					kind: "completion",
					summary: finalAggregate.summary,
					replyTo: started.id,
				},
			]);
		});
	});

	it("two concurrent async batches are publicly distinguishable through started/final reply threading", async () => {
		await withTempDir(async (tempDir) => {
			const releaseFirst = createDeferredPromise();
			const releaseSecond = createDeferredPromise();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const ownerSessionId = "owner-session-parallel-work-aggregate-concurrent-threading";
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId,
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, ownerSessionId);
			const memberJobs: Promise<void>[] = [];
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
						initialTask?: { boardMessageSeq?: number };
					}) {
						const alias = request.memberLabel?.split("#")[0] ?? request.memberName;
						const memberSessionId = `member-session-${request.memberName}`;
						const release = alias === "first_batch_worker" ? releaseFirst.promise : releaseSecond.promise;
						memberJobs.push((async () => {
							await activateBootstrapRoom(
								{ sendMessage() { return undefined; } } as any,
								request.systemPrompt ?? "",
								memberSessionId,
								{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
							);
							if (!request.initialTask?.boardMessageSeq) {
								return;
							}
							await waitFor(async () => {
								const board = await listBoardEntries(created.roomDir, Number.MAX_SAFE_INTEGER);
								return board.some((message) =>
									message.seq === request.initialTask?.boardMessageSeq
									&& message.kind === "task"
									&& message.to === request.memberName);
							}, 2_000);
							await release;
							const board = await listBoardEntries(created.roomDir, Number.MAX_SAFE_INTEGER);
							const task = board.find((message) =>
								message.seq === request.initialTask?.boardMessageSeq
								&& message.kind === "task"
								&& message.to === request.memberName);
							if (!task) {
								return;
							}
							await appendMessage(created.roomDir, {
								from: request.memberName,
								to: task.from,
								silent: task.batchId ? true : undefined,
								batchId: task.batchId ?? undefined,
								broadcast: false,
								replyTo: task.id,
								kind: "completion",
								summary: `${alias} done`,
								content: `${alias} complete`,
							});
						})());
						return { runtimeId: `runtime-${request.memberName}`, backend: "pi" as const };
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
			} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };

			try {
				const firstResult = await executeCrewBatch(
					{
						template: "parallel-work-aggregate",
						params: {
							workers: [
								{ name: "first_batch_worker", type: "worker", task: "Draft first findings" },
							],
						},
					},
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "",
						sessionManager: { getSessionId: () => ownerSessionId },
					},
					runtimeRoot,
					adapters,
					{ ownerName: "owner" },
				);
				const secondResult = await executeCrewBatch(
					{
						template: "parallel-work-aggregate",
						params: {
							workers: [
								{ name: "second_batch_worker", type: "worker", task: "Draft second findings" },
							],
						},
					},
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "",
						sessionManager: { getSessionId: () => ownerSessionId },
					},
					runtimeRoot,
					adapters,
					{ ownerName: "owner" },
				);

				expect(firstResult.content[0]?.text ?? "").toMatch(/started crew_batch template "parallel-work-aggregate"/i);
				expect(secondResult.content[0]?.text ?? "").toMatch(/started crew_batch template "parallel-work-aggregate"/i);
				const trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
				expect(trackedTasks).toHaveLength(2);

				await waitFor(async () => {
					const startedMessages = await listVisibleOwnerMessages(created.roomDir);
					return startedMessages.filter((message) =>
						message.kind === "info"
						&& /started crew_batch template "parallel-work-aggregate"/i.test(message.summary)
					).length === 2;
				});
				const startedMessages = (await listVisibleOwnerMessages(created.roomDir)).filter((message) =>
					message.kind === "info"
					&& /started crew_batch template "parallel-work-aggregate"/i.test(message.summary)
				);
				expect(startedMessages).toHaveLength(2);
				const [firstStarted, secondStarted] = startedMessages;

				releaseSecond.resolve();
				const secondFinal = await waitForBatchMessage(
					created.roomDir,
					(message) => message.replyTo === secondStarted!.id && message.kind === "completion",
				);
				expect(secondFinal.content ?? "").toContain("second_batch_worker");

				releaseFirst.resolve();
				const firstFinal = await waitForBatchMessage(
					created.roomDir,
					(message) => message.replyTo === firstStarted!.id && message.kind === "completion",
				);
				expect(firstFinal.content ?? "").toContain("first_batch_worker");

				await Promise.all(memberJobs);
				await Promise.allSettled(trackedTasks);

				const finalAggregates = (await listBoardEntries(created.roomDir, Number.MAX_SAFE_INTEGER)).filter((message) =>
					message.kind === "completion"
					&& (message.replyTo === firstStarted!.id || message.replyTo === secondStarted!.id)
					&& /crew_batch template "parallel-work-aggregate" completed/i.test(message.summary)
				);
				expect(finalAggregates).toHaveLength(2);
				expect(finalAggregates.map((message) => message.replyTo).sort()).toEqual(
					[firstStarted!.id, secondStarted!.id].sort(),
				);
			} finally {
				releaseFirst.resolve();
				releaseSecond.resolve();
				await Promise.allSettled(memberJobs);
				await Promise.allSettled(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? []);
				resetActiveRoomsForTests();
			}
		});
	});
});

describe("waitForTaskTerminalReplies", () => {
	it("waits without a default timeout when timeoutMs is omitted", async () => {
		const handle: QueuedTaskHandle = { messageId: "task-no-timeout", seq: 1, targetName: "worker-no-timeout" };
		const task: RoomMessage = {
			seq: 1,
			id: "task-no-timeout",
			from: "owner",
			to: "worker-no-timeout",
			broadcast: false,
			replyTo: null,
			kind: "task",
			summary: "Keep going",
			createdAt: "2026-05-20T00:00:00.000Z",
		};
		const reply: RoomMessage = {
			seq: 2,
			id: "reply-no-timeout",
			from: "worker-no-timeout",
			to: "owner",
			broadcast: false,
			replyTo: "task-no-timeout",
			kind: "completion",
			summary: "Done later",
			createdAt: "2026-05-20T00:00:01.000Z",
		};
		const listBoardEntriesSpy = vi.spyOn(storageModule, "listBoardEntries")
			.mockResolvedValueOnce([task])
			.mockResolvedValue([task, reply]);
		const dateNowSpy = vi.spyOn(Date, "now");
		let nowCallCount = 0;
		dateNowSpy.mockImplementation(() => {
			nowCallCount += 1;
			if (nowCallCount === 1) {
				return 0;
			}
			return 30_001;
		});

		try {
			const [result] = await waitForTaskTerminalReplies("ignored-room-dir", [handle], {
				pollIntervalMs: 1,
			});

			expect(result.state).toBe("completion");
			expect(result.task).toEqual(task);
			expect(result.reply).toEqual(reply);
		} finally {
			dateNowSpy.mockRestore();
			listBoardEntriesSpy.mockRestore();
		}
	});

	it("does not mark a task missing when it appears on a later poll", async () => {
		const handle: QueuedTaskHandle = { messageId: "task-1", seq: 1, targetName: "worker-1" };
		const task: RoomMessage = {
			seq: 1,
			id: "task-1",
			from: "owner",
			to: "worker-1",
			broadcast: false,
			replyTo: null,
			kind: "task",
			summary: "Do the work",
			createdAt: "2026-05-20T00:00:00.000Z",
		};
		const reply: RoomMessage = {
			seq: 2,
			id: "reply-1",
			from: "worker-1",
			to: "owner",
			broadcast: false,
			replyTo: "task-1",
			kind: "completion",
			summary: "Done",
			createdAt: "2026-05-20T00:00:01.000Z",
		};
		const listBoardEntriesSpy = vi.spyOn(storageModule, "listBoardEntries")
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([task, reply])
			.mockResolvedValue([task, reply]);

		try {
			const [result] = await waitForTaskTerminalReplies("ignored-room-dir", [handle], {
				timeoutMs: 50,
				pollIntervalMs: 1,
			});

			expect(result.state).toBe("completion");
			expect(result.task).toEqual(task);
			expect(result.reply).toEqual(reply);
		} finally {
			listBoardEntriesSpy.mockRestore();
		}
	});

	it("checks one last time for a terminal reply before returning timeout", async () => {
		const handle: QueuedTaskHandle = { messageId: "task-2", seq: 1, targetName: "worker-2" };
		const task: RoomMessage = {
			seq: 1,
			id: "task-2",
			from: "owner",
			to: "worker-2",
			broadcast: false,
			replyTo: null,
			kind: "task",
			summary: "Do the other work",
			createdAt: "2026-05-20T00:00:00.000Z",
		};
		const reply: RoomMessage = {
			seq: 2,
			id: "reply-2",
			from: "worker-2",
			to: "owner",
			broadcast: false,
			replyTo: "task-2",
			kind: "completion",
			summary: "Also done",
			createdAt: "2026-05-20T00:00:01.000Z",
		};
		let ignoredRoomPollCount = 0;
		const originalListBoardEntries = storageModule.listBoardEntries;
		const listBoardEntriesSpy = vi.spyOn(storageModule, "listBoardEntries")
			.mockImplementation(async (queriedRoomDir: string, limit: number) => {
				if (queriedRoomDir !== "ignored-room-dir") {
					return originalListBoardEntries(queriedRoomDir, limit);
				}
				ignoredRoomPollCount += 1;
				if (ignoredRoomPollCount === 1) {
					return [task];
				}
				return [task, reply];
			});

		try {
			const [result] = await waitForTaskTerminalReplies("ignored-room-dir", [handle], {
				timeoutMs: 1,
				pollIntervalMs: 10,
			});

			expect(result.state).toBe("completion");
			expect(result.task).toEqual(task);
			expect(result.reply).toEqual(reply);
		} finally {
			listBoardEntriesSpy.mockRestore();
		}
	});
});

describe("waitForMembersReady", () => {
	it("waits without a default timeout when timeoutMs is omitted", async () => {
		const handle = { memberName: "worker-ready-late", memberLabel: "worker-ready-late" };
		const member: RoomMemberState = {
			id: "member-ready-late",
			name: "worker-ready-late",
			type: "worker",
			state: "idle",
			createdAt: "2026-05-20T00:00:00.000Z",
			lastHeartbeatAt: "2026-05-20T00:00:01.000Z",
			ownerPID: null,
			sessionId: null,
			model: null,
			task: null,
			branch: null,
			worktree: null,
			lastError: null,
			pid: null,
			joinedAt: null,
			spawnBatchId: null,
			taskStartedAt: null,
			taskUpdatedAt: null,
			currentTask: null,
			currentTaskMessageId: null,
			pendingTask: null,
			pendingTaskMessageId: null,
		};
		const loadRoomMemberStateSpy = vi.spyOn(storageModule, "loadRoomMemberState")
			.mockResolvedValueOnce(null as any)
			.mockResolvedValue(member);
		const dateNowSpy = vi.spyOn(Date, "now");
		let nowCallCount = 0;
		dateNowSpy.mockImplementation(() => {
			nowCallCount += 1;
			if (nowCallCount === 1) {
				return 0;
			}
			return 30_001;
		});

		try {
			const [result] = await waitForMembersReady("ignored-room-dir", [handle], {
				pollIntervalMs: 1,
			});

			expect(result.state).toBe("ready");
			expect(result.member).toEqual(member);
		} finally {
			dateNowSpy.mockRestore();
			loadRoomMemberStateSpy.mockRestore();
		}
	});
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

function setMemberActiveRoomContext(created: Awaited<ReturnType<typeof createRoom>>, sessionId: string, memberName: string): void {
	setActiveRoom({
		role: "member",
		roomDir: created.roomDir,
		roomId: created.metadata.roomId,
		memberName,
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

async function createSeedRoom(tempDir: string, memberName: string): Promise<{ roomDir: string; bootstrap: RoomBootstrap }> {
	const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
	const roomId = "room-feasibility";
	const roomDir = getRoomPath(runtimeRoot, roomId);
	const metadata: RoomMetadata = {
		roomId,
		ownerName: "owner",
		ownerSessionId: "owner-session",
		ownerPid: process.pid,
		cwd: tempDir,
		createdAt: new Date().toISOString(),
		state: "active",
		nextSeq: 1,
	};
	const memberState: RoomMemberState = {
		name: memberName,
		type: "worker",
		backend: "pi",
		runtimeId: null,
		state: "spawning",
		spawnTaskId: "spawn-test",
		currentTask: null,
		lastCompletedTask: null,
		lastError: null,
		lastSeenSeq: 0,
		joinedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		sessionId: null,
		bootstrapToken: "join-token",
	};
	await initializeRoomRuntime(runtimeRoot, metadata, memberState);
	const bootstrap: RoomBootstrap = {
		version: 1,
		roomId,
		roomDir,
		memberName,
		memberType: "worker",
		ownerName: "owner",
		ownerSessionId: "owner-session",
		token: "join-token",
		spawnTaskId: "spawn-test",
	};
	return { roomDir, bootstrap };
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
			globalThis.__roomPaseoCreateAgentOptions = options;
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

async function main(): Promise<void> {
	const bootstrap: RoomBootstrap = {
		version: 1,
		roomId: "room-1",
		roomDir: "/tmp/room-1",
		memberName: "worker",
		memberType: "worker",
		ownerName: "owner",
		ownerSessionId: "owner-session",
		token: "join-token",
		spawnTaskId: "spawn-1",
	};
	const prompt = [
		"System instructions",
		buildRoomBootstrapBlock(bootstrap),
		"More instructions",
	].join("\n\n");
	assert.deepEqual(parseRoomBootstrapBlock(prompt), bootstrap);

	const formatted = formatRoomMessageContent({
		seq: 1,
		id: "m1",
		from: "owner",
		to: "worker",
		broadcast: false,
		replyTo: null,
		kind: "task",
		summary: "Investigate room delivery",
		content: "Please verify the new room path works.",
		createdAt: new Date().toISOString(),
	});
	assert.match(formatted, /Investigate room delivery/);
	assert.match(formatted, /Please verify the new room path works/);

	const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
	deliverRoomMessage(
		{
			sendMessage(message: unknown, options?: unknown) {
				sentMessages.push({ message, options });
			},
		} as any,
		{
			seq: 2,
			id: "m2",
			from: "owner",
			to: "worker",
			broadcast: false,
			replyTo: null,
			kind: "task",
			summary: "Check delivery",
			content: "body",
			createdAt: new Date().toISOString(),
		},
	);
	assert.equal(sentMessages.length, 1);
	assert.equal((sentMessages[0]?.options as any)?.deliverAs, "steer");
	assert.equal((sentMessages[0]?.options as any)?.triggerTurn, true);

	await withTempDir(async (tempDir) => {
		const previousCwd = process.cwd();
		try {
			process.chdir(tempDir);
			const seed = await createSeedRoom(tempDir, "worker");
			const harness = createHarness(buildRoomBootstrapBlock(seed.bootstrap));
			await harness.emit("session_start", "member-session-1");
			const memberPath = getRoomMemberStatePath(seed.roomDir, "worker");
			const updatedMember = await readJson<RoomMemberState>(memberPath);
			assert.equal(updatedMember.state, "idle");
			assert.equal(updatedMember.sessionId, "member-session-1");
			assert.equal(updatedMember.runtimeId, String(process.pid));
		} finally {
			process.chdir(previousCwd);
		}
	});

	await withTempDir(async (tempDir) => {
		const previousCwd = process.cwd();
		try {
			process.chdir(tempDir);
			const seed = await createSeedRoom(tempDir, "worker-closing-room");
			await writeRoomMetadata(seed.roomDir, {
				...(await loadRoomMetadata(seed.roomDir)),
				state: "closing",
			});
			const harness = createHarness(buildRoomBootstrapBlock(seed.bootstrap));
			await assert.rejects(() => harness.emit("session_start", "member-session-closing-room"), /not claimable|closing/i);
		} finally {
			process.chdir(previousCwd);
		}
	});

	await withTempDir(async (tempDir) => {
		const previousCwd = process.cwd();
		try {
			process.chdir(tempDir);
			const seed = await createSeedRoom(tempDir, "worker-idempotent-activation");
			const memberPath = getRoomMemberStatePath(seed.roomDir, "worker-idempotent-activation");
			const harness = createHarness(buildRoomBootstrapBlock(seed.bootstrap));
			await harness.emit("session_start", "member-session-idempotent-activation");
			const joined = await readJson<RoomMemberState>(memberPath);
			await fs.writeFile(memberPath, JSON.stringify({
				...joined,
				state: "running",
				currentTask: "Preserve active task",
				currentTaskMessageId: "m-preserve-active-task",
				lastError: "preserve-error",
			}, null, 2), "utf8");
			await harness.emit("before_agent_start", "member-session-idempotent-activation");
			const preserved = await readJson<RoomMemberState>(memberPath);
			assert.equal(preserved.state, "running");
			assert.equal(preserved.currentTask, "Preserve active task");
			assert.equal(preserved.currentTaskMessageId, "m-preserve-active-task");
			assert.equal(preserved.lastError, "preserve-error");
		} finally {
			process.chdir(previousCwd);
		}
	});

	await withTempDir(async (tempDir) => {
		const previousCwd = process.cwd();
		const previousDisable = process.env.PI_MUTATION_PROXY_DISABLE;
		let seededRoomDir: string | null = null;
		try {
			process.chdir(tempDir);
			process.env.PI_MUTATION_PROXY_DISABLE = "1";
			const seed = await createSeedRoom(tempDir, "worker-before-agent-proxy-required");
			seededRoomDir = seed.roomDir;
			const memberPath = getRoomMemberStatePath(seed.roomDir, "worker-before-agent-proxy-required");
			const harness = createHarness(buildRoomBootstrapBlock(seed.bootstrap));
			await assert.rejects(
				() => harness.emit("before_agent_start", "member-session-before-agent-proxy-required"),
				/live proxy connection|owner proxy|mutation client/i,
			);
			const member = await readJson<RoomMemberState>(memberPath);
			assert.equal(member.state, "spawning");
			assert.equal(member.sessionId, null);
		} finally {
			if (seededRoomDir) deleteRoomMutationClient(seededRoomDir);
			if (previousDisable === undefined) delete process.env.PI_MUTATION_PROXY_DISABLE;
			else process.env.PI_MUTATION_PROXY_DISABLE = previousDisable;
			process.chdir(previousCwd);
		}
	});

	await withTempDir(async (tempDir) => {
		const previousCwd = process.cwd();
		let seededRoomDir: string | null = null;
		let proxy: MutationProxyServer | null = null;
		let client: ReturnType<typeof createMutationClient> | null = null;
		try {
			process.chdir(tempDir);
			const seed = await createSeedRoom(tempDir, "worker-before-agent-reconnect");
			seededRoomDir = seed.roomDir;
			const memberPath = getRoomMemberStatePath(seed.roomDir, "worker-before-agent-reconnect");
			proxy = new MutationProxyServer(seed.roomDir);
			await proxy.start();
			client = createMutationClient(seed.roomDir);
			await client.connect();
			setRoomMutationClient(seed.roomDir, client);
			client.disconnect();

			const harness = createHarness(buildRoomBootstrapBlock(seed.bootstrap));
			await harness.emit("before_agent_start", "member-session-before-agent-reconnect");
			const member = await readJson<RoomMemberState>(memberPath);
			assert.equal(member.state, "idle");
			assert.equal(member.sessionId, "member-session-before-agent-reconnect");
			assert.equal(getRoomMutationClient(seed.roomDir)?.getState(), "connected");
		} finally {
			client?.disconnect();
			if (seededRoomDir) deleteRoomMutationClient(seededRoomDir);
			await proxy?.stop().catch(() => {});
			process.chdir(previousCwd);
		}
	});

	await withTempDir(async (tempDir) => {
		const previousCwd = process.cwd();
		try {
			process.chdir(tempDir);
			const seed = await createSeedRoom(tempDir, "worker-missing-anchor");
			await fs.rm(getRoomMemberStatePath(seed.roomDir, "worker-missing-anchor"), { force: true });
			const harness = createHarness(buildRoomBootstrapBlock(seed.bootstrap));
			await assert.rejects(() => harness.emit("session_start", "member-session-missing-anchor"), /persisted member claim/i);
		} finally {
			process.chdir(previousCwd);
		}
	});

	await withTempDir(async (tempDir) => {
		const previousCwd = process.cwd();
		try {
			process.chdir(tempDir);
			const seed = await createSeedRoom(tempDir, "worker-invalid-token");
			const harness = createHarness(buildRoomBootstrapBlock({
				...seed.bootstrap,
				token: "wrong-token",
			}));
			await assert.rejects(() => harness.emit("session_start", "member-session-invalid-token"), /token/i);
		} finally {
			process.chdir(previousCwd);
		}
	});

	await withTempDir(async (tempDir) => {
		const previousCwd = process.cwd();
		try {
			process.chdir(tempDir);
			const seed = await createSeedRoom(tempDir, "worker-invalid-owner");
			const harness = createHarness(buildRoomBootstrapBlock({
				...seed.bootstrap,
				ownerSessionId: "wrong-owner-session",
			}));
			await assert.rejects(() => harness.emit("session_start", "member-session-invalid-owner"), /owner session/i);
		} finally {
			process.chdir(previousCwd);
		}
	});

	await withTempDir(async (tempDir) => {
		const previousCwd = process.cwd();
		try {
			process.chdir(tempDir);
			const seed = await createSeedRoom(tempDir, "worker-recovered");
			await fs.writeFile(
				path.join(seed.roomDir, "jobs", "spawn-spawn-test.json"),
				JSON.stringify({
					taskId: "spawn-test",
					memberName: "worker-recovered",
					backend: "pi",
					bootstrapToken: "join-token",
					runtimeId: null,
					state: "starting",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					error: null,
				}),
				"utf8",
			);
			await fs.rm(getRoomMemberStatePath(seed.roomDir, "worker-recovered"), { force: true });
			const harness = createHarness(buildRoomBootstrapBlock(seed.bootstrap));
			await harness.emit("session_start", "member-session-recovered");
			const recovered = await readJson<RoomMemberState>(getRoomMemberStatePath(seed.roomDir, "worker-recovered"));
			assert.equal(recovered.state, "idle");
			assert.equal(recovered.sessionId, "member-session-recovered");
		} finally {
			process.chdir(previousCwd);
		}
	});

	await withTempDir(async (tempDir) => {
		const previousCwd = process.cwd();
		try {
			process.chdir(tempDir);
			const seed = await createSeedRoom(tempDir, "worker-paseo-recovered");
			await fs.writeFile(
				path.join(seed.roomDir, "jobs", "spawn-spawn-test.json"),
				JSON.stringify({
					taskId: "spawn-test",
					memberName: "worker-paseo-recovered",
					backend: "paseo",
					bootstrapToken: "join-token",
					runtimeId: "paseo-runtime-recovered",
					state: "starting",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					error: null,
				}),
				"utf8",
			);
			await fs.rm(getRoomMemberStatePath(seed.roomDir, "worker-paseo-recovered"), { force: true });
			const harness = createHarness(buildRoomBootstrapBlock(seed.bootstrap));
			await harness.emit("session_start", "member-session-paseo-recovered");
			const recovered = await readJson<RoomMemberState>(getRoomMemberStatePath(seed.roomDir, "worker-paseo-recovered"));
			assert.equal(recovered.backend, "paseo");
			assert.equal(recovered.runtimeId, "paseo-runtime-recovered");
		} finally {
			process.chdir(previousCwd);
		}
	});

	await withTempDir(async (tempDir) => {
		const previousCwd = process.cwd();
		try {
			process.chdir(tempDir);
			const seed = await createSeedRoom(tempDir, "worker-cancelled");
			await fs.writeFile(
				path.join(seed.roomDir, "jobs", "spawn-spawn-test.json"),
				JSON.stringify({
					taskId: "spawn-test",
					memberName: "worker-cancelled",
					backend: "pi",
					bootstrapToken: "join-token",
					runtimeId: "cancelled-runtime",
					state: "cancelled",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					error: null,
				}),
				"utf8",
			);
			await fs.rm(getRoomMemberStatePath(seed.roomDir, "worker-cancelled"), { force: true });
			const harness = createHarness(buildRoomBootstrapBlock(seed.bootstrap));
			await assert.rejects(() => harness.emit("session_start", "member-session-cancelled"), /claim|cancelled|failed/i);
			await assert.rejects(() => readJson<RoomMemberState>(getRoomMemberStatePath(seed.roomDir, "worker-cancelled")));
		} finally {
			process.chdir(previousCwd);
		}
	});

	await withTempDir(async (tempDir) => {
		const previousCwd = process.cwd();
		try {
			process.chdir(tempDir);
			const seed = await createSeedRoom(tempDir, "worker-failed");
			await fs.writeFile(
				path.join(seed.roomDir, "jobs", "spawn-spawn-test.json"),
				JSON.stringify({
					taskId: "spawn-test",
					memberName: "worker-failed",
					backend: "pi",
					bootstrapToken: "join-token",
					runtimeId: "failed-runtime",
					state: "failed",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					error: "timed out",
				}),
				"utf8",
			);
			await fs.rm(getRoomMemberStatePath(seed.roomDir, "worker-failed"), { force: true });
			const harness = createHarness(buildRoomBootstrapBlock(seed.bootstrap));
			await assert.rejects(() => harness.emit("session_start", "member-session-failed"), /claim|cancelled|failed/i);
			await assert.rejects(() => readJson<RoomMemberState>(getRoomMemberStatePath(seed.roomDir, "worker-failed")));
		} finally {
			process.chdir(previousCwd);
		}
	});

	await withTempDir(async (tempDir) => {
		const previousCwd = process.cwd();
		try {
			process.chdir(tempDir);
			const seed = await createSeedRoom(tempDir, "worker-removed");
			await fs.writeFile(
				path.join(seed.roomDir, "jobs", "spawn-spawn-test.json"),
				JSON.stringify({
					taskId: "spawn-test",
					memberName: "worker-removed",
					backend: "pi",
					bootstrapToken: "join-token",
					runtimeId: "completed-runtime",
					state: "completed",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					error: null,
				}),
				"utf8",
			);
			await fs.rm(getRoomMemberStatePath(seed.roomDir, "worker-removed"), { force: true });
			const harness = createHarness(buildRoomBootstrapBlock(seed.bootstrap));
			await assert.rejects(() => harness.emit("session_start", "member-session-removed"), /claim|cancelled|failed|completed/i);
			await assert.rejects(() => readJson<RoomMemberState>(getRoomMemberStatePath(seed.roomDir, "worker-removed")));
		} finally {
			process.chdir(previousCwd);
		}
	});

	await withTempDir(async (tempDir) => {
		const seed = await createSeedRoom(tempDir, "rpc-worker");
		const roomExtensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
		const promptPath = path.join(tempDir, "bootstrap.md");
		await fs.writeFile(promptPath, buildRoomBootstrapBlock(seed.bootstrap), "utf8");

		const adapter = createPiMemberAdapter();
		const child = (await adapter.spawn({
			roomDir: seed.roomDir,
			roomId: seed.bootstrap.roomId,
			memberName: seed.bootstrap.memberName,
			memberType: seed.bootstrap.memberType,
			cwd: tempDir,
			systemPromptPath: promptPath,
			extensionPath: roomExtensionPath,
			getInvocation: getPiInvocation,
		})) as { process: ChildProcess; runtimeId: string };

		await waitFor(async () => {
			const member = await readJson<RoomMemberState>(getRoomMemberStatePath(seed.roomDir, "rpc-worker"));
			return member.state === "idle" && member.sessionId !== null;
		}, 10_000);
		const joinedMember = await readJson<RoomMemberState>(getRoomMemberStatePath(seed.roomDir, "rpc-worker"));
		assert.equal(joinedMember.backend, "pi");
		assert.equal(joinedMember.runtimeId, child.runtimeId);
		assert.equal(child.process.exitCode, null);
		child.process.kill("SIGTERM");
		await waitForProcessExit(child.process);
	});

	await withTempDir(async (tempDir) => {
		if (hasRealPaseoRuntime()) {
			const seed = await createSeedRoom(tempDir, "paseo-worker");
			const adapter = createPaseoPiMemberAdapter();
			let result: Awaited<ReturnType<typeof adapter.spawn>> | null = null;
			try {
				result = await adapter.spawn({
					roomDir: seed.roomDir,
					roomId: seed.bootstrap.roomId,
					memberName: seed.bootstrap.memberName,
					memberType: seed.bootstrap.memberType,
					cwd: tempDir,
					systemPrompt: buildRoomBootstrapBlock(seed.bootstrap),
				});

				await waitFor(async () => {
					const member = await readJson<RoomMemberState>(getRoomMemberStatePath(seed.roomDir, "paseo-worker"));
					return member.state === "idle" && member.sessionId !== null && typeof member.runtimeId === "string" && member.runtimeId.length > 0;
				}, 15_000);
				const joinedMember = await readJson<RoomMemberState>(getRoomMemberStatePath(seed.roomDir, "paseo-worker"));
				assert.equal(joinedMember.backend, "paseo");
				assert.equal(joinedMember.runtimeId, result.runtimeId);
				assert.match(result.runtimeId, /\S+/);

				await adapter.remove?.({
					...(await readJson<RoomMemberState>(getRoomMemberStatePath(seed.roomDir, "paseo-worker"))),
					backend: "paseo",
					runtimeId: result.runtimeId,
				});
				return;
			} catch (error) {
				if (result?.runtimeId) {
					await adapter.remove?.({
						name: seed.bootstrap.memberName,
						type: seed.bootstrap.memberType,
						backend: "paseo",
						runtimeId: result.runtimeId,
						state: "spawning",
						spawnTaskId: seed.bootstrap.spawnTaskId ?? null,
						currentTask: null,
						lastCompletedTask: null,
						lastError: null,
						lastSeenSeq: 0,
						joinedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						sessionId: null,
					}).catch(() => {});
				}

				if (isStrictRealPaseoEnabled()) {
					throw error;
				}
			}
		}

		const fakeCliPath = await writeFakePaseoCli(path.join(tempDir, "fake-paseo"));
		const previousCliPath = process.env.PI_ROOM_PASEO_CLI_PATH;
		process.env.PI_ROOM_PASEO_CLI_PATH = fakeCliPath;
		try {
			const seed = await createSeedRoom(tempDir, "paseo-worker-fake");
			const adapter = createPaseoPiMemberAdapter();
			await adapter.spawn({
				roomDir: seed.roomDir,
				roomId: seed.bootstrap.roomId,
				memberName: seed.bootstrap.memberName,
				memberType: seed.bootstrap.memberType,
				cwd: tempDir,
				systemPrompt: buildRoomBootstrapBlock(seed.bootstrap),
			});
			const createAgentOptions = (globalThis as any).__roomPaseoCreateAgentOptions;
			assert.ok(createAgentOptions, "expected fake paseo createAgent to be called");
			assert.match(createAgentOptions.systemPrompt ?? "", /PI_ROOM_BOOTSTRAP/);

			const harness = createHarness(createAgentOptions.systemPrompt ?? "");
			await harness.emit("before_agent_start", "fake-paseo-session");
			const joinedMember = await readJson<RoomMemberState>(getRoomMemberStatePath(seed.roomDir, "paseo-worker-fake"));
			assert.equal(joinedMember.backend, "paseo");
			assert.equal(joinedMember.runtimeId, "fake-paseo-agent");
			assert.equal(joinedMember.state, "idle");
			assert.equal(joinedMember.sessionId, "fake-paseo-session");
		} finally {
			if (previousCliPath === undefined) delete process.env.PI_ROOM_PASEO_CLI_PATH;
			else process.env.PI_ROOM_PASEO_CLI_PATH = previousCliPath;
		}
	});
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

describe("owner room lifecycle gating", () => {
	it("defers owner room materialization from session_start to before_agent_start", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const sessionId = "owner-session-defers-room-materialization";
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const harness = createHarness("", { runtimeRoot });
				await harness.emit("session_start", sessionId);
				expect(getActiveRoom(sessionId)).toBeNull();
				expect(await findRoomByOwnerSessionId(runtimeRoot, sessionId)).toBeNull();

				await harness.emit("before_agent_start", sessionId, { systemPrompt: "Owner session prompt" });
				expect(getActiveRoom(sessionId)?.role).toBe("owner");
				expect((await findRoomByOwnerSessionId(runtimeRoot, sessionId))?.metadata.ownerSessionId).toBe(sessionId);
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("fails closed when neither before_agent_start nor ctx provides a prompt", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const sessionId = "owner-session-missing-prompts-fail-closed";
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const harness = createHarness("", { runtimeRoot });
				await harness.emit("before_agent_start", sessionId);
				expect(getActiveRoom(sessionId)).toBeNull();
				expect(await findRoomByOwnerSessionId(runtimeRoot, sessionId)).toBeNull();
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("does not misclassify bootstrap members when event.systemPrompt carries the bootstrap", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "member-session-event-bootstrap";
			let proxy: MutationProxyServer | null = null;
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const seed = await createSeedRoom(tempDir, "worker-event-bootstrap");
				proxy = new MutationProxyServer(seed.roomDir);
				await proxy.start();
				const harness = createHarness("", { runtimeRoot });
				await harness.emit("before_agent_start", sessionId, {
					systemPrompt: buildRoomBootstrapBlock(seed.bootstrap),
				});

				expect(getActiveRoom(sessionId)?.role).toBe("member");
				expect(await findRoomByOwnerSessionId(runtimeRoot, sessionId)).toBeNull();
				expect((await loadRoomMemberState(seed.roomDir, "worker-event-bootstrap")).sessionId).toBe(sessionId);
			} finally {
				resetActiveRoomsForTests();
				await proxy?.stop().catch(() => {});
				process.chdir(previousCwd);
			}
		});
	});

	it("does not misclassify bootstrap members when an empty event.systemPrompt falls back to ctx.getSystemPrompt", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "member-session-ctx-bootstrap";
			let proxy: MutationProxyServer | null = null;
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const seed = await createSeedRoom(tempDir, "worker-ctx-bootstrap");
				proxy = new MutationProxyServer(seed.roomDir);
				await proxy.start();
				const harness = createHarness(buildRoomBootstrapBlock(seed.bootstrap), { runtimeRoot });
				await harness.emit("before_agent_start", sessionId, { systemPrompt: "" });

				expect(getActiveRoom(sessionId)?.role).toBe("member");
				expect(await findRoomByOwnerSessionId(runtimeRoot, sessionId)).toBeNull();
				expect((await loadRoomMemberState(seed.roomDir, "worker-ctx-bootstrap")).sessionId).toBe(sessionId);
			} finally {
				resetActiveRoomsForTests();
				await proxy?.stop().catch(() => {});
				process.chdir(previousCwd);
			}
		});
	});

	it("materializes owner room when an empty event.systemPrompt falls back to ctx.getSystemPrompt", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-ctx-only-prompt";
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const harness = createHarness("Owner session prompt from ctx", { runtimeRoot });
				await harness.emit("before_agent_start", sessionId, { systemPrompt: "" });

				expect(getActiveRoom(sessionId)?.role).toBe("owner");
				expect((await findRoomByOwnerSessionId(runtimeRoot, sessionId))?.metadata.ownerSessionId).toBe(sessionId);
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("fails fast for owner-only tools before before_agent_start materializes a room", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-tool-before-materialize";
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const result = await executeCrewAdd(
					{ name: "worker", type: "worker" },
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "",
						sessionManager: { getSessionId: () => sessionId },
					},
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{ ownerName: "owner" },
				);

				expect(result.isError).toBe(true);
				expect(result.content[0]?.text ?? "").toMatch(/owner room|classification unavailable|initialized/i);
				expect(getActiveRoom(sessionId)).toBeNull();
				expect(await findRoomByOwnerSessionId(runtimeRoot, sessionId)).toBeNull();
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("clears fail-closed classification state on session_shutdown when no room was materialized", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-fail-closed-shutdown-cleanup";
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const harness = createHarness("", { runtimeRoot });
				await harness.emit("before_agent_start", sessionId);

				expect(isOwnerClassificationUnavailable(sessionId)).toBe(true);
				expect(isOwnerClassificationReady(sessionId)).toBe(false);

				await harness.emit("session_shutdown", sessionId);

				expect(isOwnerClassificationUnavailable(sessionId)).toBe(false);
				expect(isOwnerClassificationReady(sessionId)).toBe(false);
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("does not adopt an indexed owner room before owner classification has run", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-tool-before-classification";
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: sessionId,
					cwd: tempDir,
					ownerPid: process.pid,
				});

				const result = await executeCrewAdd(
					{ name: "worker", type: "worker" },
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "",
						sessionManager: { getSessionId: () => sessionId },
					},
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{ ownerName: "owner" },
				);

				expect(result.isError).toBe(true);
				expect(result.content[0]?.text ?? "").toMatch(/owner room|classification unavailable|initialized/i);
				expect(getActiveRoom(sessionId)).toBeNull();
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("keeps owner-only tools fail-closed even when an indexed owner room already exists", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-tool-fail-closed-index-hit";
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: sessionId,
					cwd: tempDir,
					ownerPid: process.pid,
				});

				const harness = createHarness("", { runtimeRoot });
				await harness.emit("before_agent_start", sessionId);

				const result = await executeCrewAdd(
					{ name: "worker", type: "worker" },
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "",
						sessionManager: { getSessionId: () => sessionId },
					},
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{ ownerName: "owner" },
				);

				expect(result.isError).toBe(true);
				expect(result.content[0]?.text ?? "").toMatch(/owner room|classification unavailable|initialized/i);
				expect(getActiveRoom(sessionId)).toBeNull();
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("initializes the first system board message with the room id in before_agent_start", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-board-init";
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const harness = createHarness("", { runtimeRoot });
				await harness.emit("before_agent_start", sessionId, { systemPrompt: "Owner session prompt" });

				const activeRoom = getActiveRoom(sessionId);
				expect(activeRoom?.role).toBe("owner");
				const board = await listBoardEntries(activeRoom!.roomDir, 10);
				expect(board).toHaveLength(1);
				expect(board[0]).toMatchObject({
					seq: 1,
					from: "system",
					kind: "info",
				});
				expect(board[0]?.summary ?? "").toContain(activeRoom!.roomId);
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("allows owner-only tools after before_agent_start materializes the room", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-tool-happy-path";
			const toolAdapters = {
				pi: {
					kind: "pi",
					async isAvailable() {
						return true;
					},
					async spawn() {
						return { runtimeId: "fake-runtime", backend: "pi" };
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
			} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const harness = createHarness("", { runtimeRoot });
				await harness.emit("before_agent_start", sessionId, { systemPrompt: "Owner session prompt" });

				const result = await executeCrewAdd(
					{ name: "worker", type: "worker" },
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "Owner session prompt",
						sessionManager: { getSessionId: () => sessionId },
					},
					runtimeRoot,
					toolAdapters,
					{ ownerName: "owner" },
				);

				expect(result.isError).toBeUndefined();
				expect(result.content[0]?.text ?? "").toMatch(/queued/i);
				await waitFor(async () => (await loadMemberByAlias(getActiveRoom(sessionId)!.roomDir, "worker"))?.runtimeId === "fake-runtime", 2_000);
				await Promise.allSettled([...(getActiveRoom(sessionId)?.pendingToolTasks ?? [])]);
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("recovers a classified owner room through the shared helper before running owner-only tools", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-tool-recover";
			const toolAdapters = {
				pi: {
					kind: "pi",
					async isAvailable() {
						return true;
					},
					async spawn() {
						return { runtimeId: "fake-runtime-recover", backend: "pi" };
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
			} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const harness = createHarness("", { runtimeRoot });
				await harness.emit("before_agent_start", sessionId, { systemPrompt: "Owner session prompt" });

				const activeRoom = getActiveRoom(sessionId);
				expect(activeRoom?.role).toBe("owner");
				await writeRoomMetadata(activeRoom!.roomDir, {
					...(await loadRoomMetadata(activeRoom!.roomDir)),
					state: "closing",
					ownerPid: 999_999,
				});
				await writeJsonAtomic(getRoomHeartbeatPath(activeRoom!.roomDir), {
					roomId: activeRoom!.roomId,
					ownerSessionId: sessionId,
					ownerPid: 999_999,
					updatedAt: new Date(Date.now() - 60_000).toISOString(),
				});
				clearActiveRoom(sessionId);

				const result = await executeCrewAdd(
					{ name: "worker", type: "worker" },
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "Owner session prompt",
						sessionManager: { getSessionId: () => sessionId },
					},
					runtimeRoot,
					toolAdapters,
					{ ownerName: "owner" },
				);

				expect(result.isError).toBeUndefined();
				expect(getActiveRoom(sessionId)?.role).toBe("owner");
				const refreshedMetadata = await loadRoomMetadata(activeRoom!.roomDir);
				const refreshedHeartbeat = await readJson<{ ownerPid: number; updatedAt: string }>(getRoomHeartbeatPath(activeRoom!.roomDir));
				expect(refreshedMetadata.state).toBe("active");
				expect(refreshedMetadata.ownerPid).toBe(process.pid);
				expect(refreshedHeartbeat.ownerPid).toBe(process.pid);
				await waitFor(async () => (await loadMemberByAlias(activeRoom!.roomDir, "worker"))?.runtimeId === "fake-runtime-recover", 2_000);
				await Promise.allSettled([...(getActiveRoom(sessionId)?.pendingToolTasks ?? [])]);
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("keeps classified owner recovery available when before_agent_start repeats with no prompt", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-repeat-empty-before-start";
			const toolAdapters = {
				pi: {
					kind: "pi",
					async isAvailable() {
						return true;
					},
					async spawn() {
						return { runtimeId: "fake-runtime-repeat", backend: "pi" };
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
			} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const harness = createHarness("", { runtimeRoot });
				await harness.emit("before_agent_start", sessionId, { systemPrompt: "Owner session prompt" });
				clearActiveRoom(sessionId);
				await harness.emit("before_agent_start", sessionId);

				const result = await executeCrewAdd(
					{ name: "worker", type: "worker" },
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "",
						sessionManager: { getSessionId: () => sessionId },
					},
					runtimeRoot,
					toolAdapters,
					{ ownerName: "owner" },
				);

				expect(result.isError).toBeUndefined();
				expect(getActiveRoom(sessionId)?.role).toBe("owner");
				await waitFor(async () => (await loadMemberByAlias(getActiveRoom(sessionId)!.roomDir, "worker"))?.runtimeId === "fake-runtime-repeat", 2_000);
				await Promise.allSettled([...(getActiveRoom(sessionId)?.pendingToolTasks ?? [])]);
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("reaps the owner room on session_shutdown even after the active room is cleared", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-shutdown-recover";
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const harness = createHarness("", { runtimeRoot });
				await harness.emit("before_agent_start", sessionId, { systemPrompt: "Owner session prompt" });
				const activeRoom = getActiveRoom(sessionId);
				expect(activeRoom?.role).toBe("owner");
				clearActiveRoom(sessionId);
				await harness.emit("session_shutdown", sessionId);

				expect(await fs.stat(activeRoom!.roomDir).then(() => true).catch(() => false)).toBe(false);
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("refreshes metadata and owner heartbeat when reusing a closing owner room", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-refresh-closing-room";
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: sessionId,
					cwd: tempDir,
					ownerPid: 999_999,
				});
				await writeRoomMetadata(created.roomDir, {
					...(await loadRoomMetadata(created.roomDir)),
					state: "closing",
					ownerPid: 999_999,
				});
				await writeJsonAtomic(getRoomHeartbeatPath(created.roomDir), {
					roomId: created.metadata.roomId,
					ownerSessionId: sessionId,
					ownerPid: 999_999,
					updatedAt: new Date(Date.now() - 60_000).toISOString(),
				});

				const harness = createHarness("", { runtimeRoot });
				await harness.emit("before_agent_start", sessionId, { systemPrompt: "Owner session prompt" });

				const refreshedMetadata = await loadRoomMetadata(created.roomDir);
				const refreshedHeartbeat = await readJson<{ ownerPid: number; updatedAt: string }>(getRoomHeartbeatPath(created.roomDir));
				expect(getActiveRoom(sessionId)?.role).toBe("owner");
				expect(refreshedMetadata.state).toBe("active");
				expect(refreshedMetadata.ownerPid).toBe(process.pid);
				expect(refreshedHeartbeat.ownerPid).toBe(process.pid);
				expect(Date.now() - Date.parse(refreshedHeartbeat.updatedAt)).toBeLessThan(5_000);
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("schedules stale reap in the background and skips the current owner session", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-background-reap";
			let releaseRemove: (() => void) | null = null;
			const removeBlocked = new Promise<void>((resolve) => {
				releaseRemove = resolve;
			});
			const removedMembers: string[] = [];
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const staleOther = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-other-stale",
					cwd: tempDir,
					ownerPid: 999_999,
				});
				await writeRoomMemberState(staleOther.roomDir, {
					name: "other-worker",
					type: "worker",
					backend: "pi",
					runtimeId: "pi-runtime-other-worker",
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: "other-worker-session",
				});
				const staleShadow = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: sessionId,
					cwd: tempDir,
					ownerPid: 999_999,
				});
				await writeRoomMemberState(staleShadow.roomDir, {
					name: "shadow-worker",
					type: "worker",
					backend: "pi",
					runtimeId: "pi-runtime-shadow-worker",
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: "shadow-worker-session",
				});
				for (const room of [staleOther, staleShadow]) {
					await writeJsonAtomic(getRoomHeartbeatPath(room.roomDir), {
						roomId: room.metadata.roomId,
						ownerSessionId: room.metadata.ownerSessionId,
						ownerPid: room.metadata.ownerPid,
						updatedAt: new Date(Date.now() - 60_000).toISOString(),
					});
				}

				const harness = createHarness("", {
					runtimeRoot,
					extensionOptions: {
						adapters: {
							pi: {
								kind: "pi",
								async spawn() {
									throw new Error("not used");
								},
								async remove(member: RoomMemberState) {
									removedMembers.push(member.name);
									await removeBlocked;
								},
							},
							paseo: {
								kind: "paseo",
								async spawn() {
									throw new Error("not used");
								},
							},
						},
					},
				});

				await harness.emit("before_agent_start", sessionId, { systemPrompt: "Owner session prompt" });
				expect(getActiveRoom(sessionId)?.role).toBe("owner");

				await waitFor(() => removedMembers.includes("other-worker"), 2_000);
				expect(await fs.stat(staleShadow.roomDir).then(() => true).catch(() => false)).toBe(true);

				releaseRemove?.();
				await waitFor(() => fs.stat(staleOther.roomDir).then(() => false).catch(() => true), 2_000);
				expect(await fs.stat(staleShadow.roomDir).then(() => true).catch(() => false)).toBe(true);
			} finally {
				releaseRemove?.();
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("does not rerun the one-shot background reap on later owner tool calls", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-one-shot-reap";
			const removedMembers: string[] = [];
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const firstStale = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-first-stale",
					cwd: tempDir,
					ownerPid: 999_999,
				});
				await writeRoomMemberState(firstStale.roomDir, {
					name: "first-stale-worker",
					type: "worker",
					backend: "pi",
					runtimeId: "pi-runtime-first-stale",
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: "first-stale-worker-session",
				});
				await writeJsonAtomic(getRoomHeartbeatPath(firstStale.roomDir), {
					roomId: firstStale.metadata.roomId,
					ownerSessionId: firstStale.metadata.ownerSessionId,
					ownerPid: firstStale.metadata.ownerPid,
					updatedAt: new Date(Date.now() - 60_000).toISOString(),
				});

				const harness = createHarness("", {
					runtimeRoot,
					extensionOptions: {
						adapters: {
							pi: {
								kind: "pi",
								async spawn() {
									throw new Error("not used");
								},
								async remove(member: RoomMemberState) {
									removedMembers.push(member.name);
								},
							},
							paseo: {
								kind: "paseo",
								async spawn() {
									throw new Error("not used");
								},
							},
						},
					},
				});

				await harness.emit("before_agent_start", sessionId, { systemPrompt: "Owner session prompt" });
				await waitFor(() => removedMembers.includes("first-stale-worker"), 2_000);
				await waitFor(() => fs.stat(firstStale.roomDir).then(() => false).catch(() => true), 2_000);

				const secondStale = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-second-stale",
					cwd: tempDir,
					ownerPid: 999_999,
				});
				await writeRoomMemberState(secondStale.roomDir, {
					name: "second-stale-worker",
					type: "worker",
					backend: "pi",
					runtimeId: "pi-runtime-second-stale",
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: "second-stale-worker-session",
				});
				await writeJsonAtomic(getRoomHeartbeatPath(secondStale.roomDir), {
					roomId: secondStale.metadata.roomId,
					ownerSessionId: secondStale.metadata.ownerSessionId,
					ownerPid: secondStale.metadata.ownerPid,
					updatedAt: new Date(Date.now() - 60_000).toISOString(),
				});

				const result = await executeCrewMessages(
					{ limit: 1 },
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "Owner session prompt",
						sessionManager: { getSessionId: () => sessionId },
					},
					runtimeRoot,
					{
						pi: {
							kind: "pi",
							async spawn() {
								throw new Error("not used");
							},
							async remove(member: RoomMemberState) {
								removedMembers.push(member.name);
							},
						},
						paseo: {
							kind: "paseo",
							async spawn() {
								throw new Error("not used");
							},
						},
					},
					{ ownerName: "owner" },
				);

				expect(result.isError).toBeUndefined();
				await new Promise((resolve) => setTimeout(resolve, 300));
				expect(await fs.stat(secondStale.roomDir).then(() => true).catch(() => false)).toBe(true);
				expect(removedMembers).not.toContain("second-stale-worker");
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});

	it("keeps owner materialization available even when background reap cleanup fails", async () => {
		await withTempDir(async (tempDir) => {
			const previousCwd = process.cwd();
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-background-reap-failure";
			try {
				process.chdir(tempDir);
				resetActiveRoomsForTests();
				const staleOther = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-background-reap-failure-other",
					cwd: tempDir,
					ownerPid: 999_999,
				});
				await writeRoomMemberState(staleOther.roomDir, {
					name: "failing-worker",
					type: "worker",
					backend: "pi",
					runtimeId: "pi-runtime-failing-worker",
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: "failing-worker-session",
				});
				await writeJsonAtomic(getRoomHeartbeatPath(staleOther.roomDir), {
					roomId: staleOther.metadata.roomId,
					ownerSessionId: staleOther.metadata.ownerSessionId,
					ownerPid: staleOther.metadata.ownerPid,
					updatedAt: new Date(Date.now() - 60_000).toISOString(),
				});

				const harness = createHarness("", {
					runtimeRoot,
					extensionOptions: {
						adapters: {
							pi: {
								kind: "pi",
								async spawn() {
									throw new Error("not used");
								},
								async remove() {
									throw new Error("simulated cleanup failure");
								},
							},
							paseo: {
								kind: "paseo",
								async spawn() {
									throw new Error("not used");
								},
							},
						},
					},
				});

				await harness.emit("before_agent_start", sessionId, { systemPrompt: "Owner session prompt" });
				expect(getActiveRoom(sessionId)?.role).toBe("owner");
				await waitFor(async () => (await loadRoomMetadata(staleOther.roomDir).catch(() => null))?.state === "orphaned", 2_000);
			} finally {
				resetActiveRoomsForTests();
				process.chdir(previousCwd);
			}
		});
	});
});

describe("silent owner room initialization", () => {
	it("crew_messages still shows the silent room initialization message", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const sessionId = "owner-session-silent-mail-list";
			const harness = createHarness("Owner session prompt", { runtimeRoot });

			await harness.emit("before_agent_start", sessionId, { systemPrompt: "Owner session prompt" });

			const activeRoom = getActiveRoom(sessionId);
			expect(activeRoom).not.toBeNull();
			const board = await listBoardEntries(activeRoom!.roomDir, 20);
			expect((board.at(-1) as { silent?: boolean } | undefined)?.silent).toBe(true);

			const result = await executeCrewMessages(
				{ limit: 20 },
				{ sendMessage() { return undefined; } } as any,
				{
					cwd: tempDir,
					hasUI: false,
					getSystemPrompt: () => "Owner session prompt",
					sessionManager: { getSessionId: () => sessionId },
				},
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/Room initialized:/);
		});
	});
});

describe("direct member target resolution", () => {
	it("resolves display alias and display label in crew_tell", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-target-send",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-target-send");
			await writeRoomMemberState(created.roomDir, {
				name: "explorer_1234",
				displayName: "explorer",
				type: "worker",
				backend: "pi",
				runtimeId: "runtime-1234",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "member-session-explorer",
			});

			const aliasResult = await executeCrewTell(
				{ to: "explorer", summary: "Run alias task", kind: "task" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-target-send" } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);
			expect(aliasResult.isError).toBeUndefined();

			const labelResult = await executeCrewTell(
				{ to: "explorer#1234", summary: "Run label note", kind: "info" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-target-send" } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);
			expect(labelResult.isError).toBeUndefined();

			const board = await listBoardEntries(created.roomDir, 10);
			const directedTargets = board.filter((entry) => entry.to !== "room").map((entry) => entry.to);
			expect(directedTargets.filter((target) => target === "explorer_1234")).toHaveLength(2);
		});
	});

	describe("structured queue helpers", () => {
		it("queueCrewAdd rejects non-owner callers before reserving a member", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const sessionId = "member-session-queue-add";
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-queue-add-member",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: "runtime-1234",
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId,
				});
				setMemberActiveRoomContext(created, sessionId, "worker_1234");
				const activeRoom = getActiveRoom(sessionId);
				assert(activeRoom);
				const adapters = {
					pi: {
						kind: "pi",
						async isAvailable() {
							return true;
						},
						async spawn() {
							return { runtimeId: "should-not-spawn", backend: "pi" };
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
				} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };

				await expect(queueCrewAdd(
					{ name: "helper-should-fail", type: "worker" },
					{
						activeRoom,
						sessionId,
						ctx: { cwd: tempDir, hasUI: false },
						adapters,
					},
				)).rejects.toThrow("Only the lead may call create, spawn, stop, or remove.");
				const members = await listRoomMembers(created.roomDir);
				expect(members).toHaveLength(2);
				expect(members.map((member) => member.name)).not.toContain("helper-should-fail");
			});
		});

		it("queueCrewAdd returns structured member handles for batch orchestration", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const sessionId = "owner-session-queue-add";
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: sessionId,
					cwd: tempDir,
					ownerPid: process.pid,
				});
				setOwnerActiveRoomContext(created, sessionId);
				const activeRoom = getActiveRoom(sessionId);
				assert(activeRoom);
				const adapters = {
					pi: {
						kind: "pi",
						async isAvailable() {
							return true;
						},
						async spawn() {
							return { runtimeId: "fake-runtime-queue-add", backend: "pi" };
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
				} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };

				const queued = await queueCrewAdd(
					{ name: "worker", type: "worker", task: "Draft findings" },
					{
						activeRoom,
						sessionId,
						ctx: { cwd: tempDir, hasUI: false },
						adapters,
					},
				);

				expect(queued.memberName).toMatch(/^worker/);
				expect(queued.memberLabel).toContain("worker");
				expect(queued.initialTaskBoardError).toBeNull();
				expect(queued.initialTask?.messageId).toBeTruthy();
				expect(queued.initialTask?.seq).toBeGreaterThan(0);

				await Promise.allSettled([...(getActiveRoom(sessionId)?.pendingToolTasks ?? [])]);
			});
		});

		it("queueCrewTell returns the exact task handle needed for later reply correlation", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const sessionId = "owner-session-queue-tell";
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: sessionId,
					cwd: tempDir,
					ownerPid: process.pid,
				});
				setOwnerActiveRoomContext(created, sessionId);
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: "runtime-1234",
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: "worker-session",
				});

				const queued = await queueCrewTell(
					{ to: "worker", kind: "task", summary: "Review", content: "Check the draft" },
					{ activeRoom: getActiveRoom(sessionId)! },
				);

				expect(queued.message.id).toBeTruthy();
				expect(queued.message.seq).toBeGreaterThan(0);
				expect(queued.message.kind).toBe("task");
				expect(queued.message.to).toBe("worker_1234");
			});
		});

		it("batch-tagged spawn status messages are silent and batch-tagged", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const sessionId = "owner-session-batch-tagged-spawn";
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: sessionId,
					cwd: tempDir,
					ownerPid: process.pid,
				});
				setOwnerActiveRoomContext(created, sessionId);
				const activeRoom = getActiveRoom(sessionId);
				assert(activeRoom);
				const adapters = {
					pi: {
						kind: "pi",
						async isAvailable() {
							return true;
						},
						async spawn() {
							return { runtimeId: "fake-runtime-batch-spawn", backend: "pi" };
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
				} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };

				const queued = await queueCrewAdd(
					{ name: "worker", type: "worker", task: "Draft findings" },
					{
						activeRoom,
						sessionId,
						ctx: { cwd: tempDir, hasUI: false },
						adapters,
						batchContext: { id: "batch-spawn-1", silentOwnerDelivery: true },
					} as any,
				);

				await Promise.allSettled([...(getActiveRoom(sessionId)?.pendingToolTasks ?? [])]);

				const spawned = await loadRoomMemberState(created.roomDir, queued.memberName);
				await activateBootstrapRoom(
					{ sendMessage() { return undefined; } } as any,
					buildRoomBootstrapBlock({
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: queued.memberName,
						memberType: spawned.type,
						ownerName: "owner",
						ownerSessionId: sessionId,
						token: spawned.bootstrapToken ?? "",
						spawnTaskId: queued.taskId,
					}),
					"member-session-batch-spawn",
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				);

				const board = await listBoardEntries(created.roomDir, 20);
				const initialTask = board.find((entry) => entry.id === queued.initialTask?.messageId);
				const spawnStatus = board.find((entry) => entry.summary.includes(`Agent ${queued.memberLabel} ready`));
				const joinStatus = board.find((entry) =>
					entry.from === queued.memberName
					&& entry.to === "owner"
					&& entry.summary.includes("Ready"),
				);

				expect(initialTask?.silent).toBeUndefined();
				expect((initialTask as { batchId?: string } | undefined)?.batchId).toBe("batch-spawn-1");
				expect(spawnStatus?.silent).toBe(true);
				expect((spawnStatus as { batchId?: string } | undefined)?.batchId).toBe("batch-spawn-1");
				expect(joinStatus?.silent).toBe(true);
				expect((joinStatus as { batchId?: string } | undefined)?.batchId).toBe("batch-spawn-1");
				expect((await loadRoomMemberState(created.roomDir, queued.memberName)) as { spawnBatchId?: string | null }).toMatchObject({
					spawnBatchId: null,
				});
			});
		});

		it("does not deliver batch-tagged silent spawn status messages to the owner", async () => {
			await withTempDir(async (tempDir) => {
				process.env.PI_ROOM_DELIVERY_DEBOUNCE_MS = "5";
				try {
					const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
					const sessionId = "owner-session-batch-silent-owner-delivery";
					const created = await createRoom({
						runtimeRoot,
						ownerName: "owner",
						ownerSessionId: sessionId,
						cwd: tempDir,
						ownerPid: process.pid,
					});
					setOwnerActiveRoomContext(created, sessionId);
					const activeRoom = getActiveRoom(sessionId);
					assert(activeRoom);
					const adapters = {
						pi: {
							kind: "pi",
							async isAvailable() {
								return true;
							},
							async spawn() {
								return { runtimeId: "fake-runtime-batch-silent-owner", backend: "pi" };
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
					} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };

					const queued = await queueCrewAdd(
						{ name: "worker", type: "worker", task: "Draft findings" },
						{
							activeRoom,
							sessionId,
							ctx: { cwd: tempDir, hasUI: false },
							adapters,
							batchContext: { id: "batch-spawn-silent-owner", silentOwnerDelivery: true },
						} as any,
					);

					await Promise.allSettled([...(getActiveRoom(sessionId)?.pendingToolTasks ?? [])]);

					let spawnStatus: Awaited<ReturnType<typeof listBoardEntries>>[number] | undefined;
					await waitFor(async () => {
						spawnStatus = (await listBoardEntries(created.roomDir, 20)).find((entry) =>
							entry.summary.includes(`Agent ${queued.memberLabel} ready`)
						);
						return Boolean(spawnStatus);
					});

					const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
					await processUnreadMessages(
						{
							sendMessage(message: unknown, options?: unknown) {
								sentMessages.push({ message, options });
								return undefined;
							},
						} as any,
						activeRoom,
					);
					await new Promise((resolve) => setTimeout(resolve, 25));

					expect(spawnStatus?.silent).toBe(true);
					expect((spawnStatus as { batchId?: string } | undefined)?.batchId).toBe("batch-spawn-silent-owner");
					expect(sentMessages).toHaveLength(0);
					expect((await loadRoomMemberState(created.roomDir, created.metadata.ownerName)).lastSeenSeq).toBe(
						spawnStatus?.seq,
					);
				} finally {
					delete process.env.PI_ROOM_DELIVERY_DEBOUNCE_MS;
				}
			});
		});

		it("delivers batch-tagged directed tell tasks to the target worker", async () => {
			await withTempDir(async (tempDir) => {
				process.env.PI_ROOM_DELIVERY_DEBOUNCE_MS = "5";
				try {
					const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
					const ownerSessionId = "owner-session-batch-task-delivery";
					const memberSessionId = "worker-session-batch-task-delivery";
					const created = await createRoom({
						runtimeRoot,
						ownerName: "owner",
						ownerSessionId,
						cwd: tempDir,
						ownerPid: process.pid,
					});
					setOwnerActiveRoomContext(created, ownerSessionId);
					await writeRoomMemberState(created.roomDir, {
						name: "worker_1234",
						displayName: "worker",
						type: "worker",
						backend: "pi",
						runtimeId: "worker-runtime",
						state: "idle",
						spawnTaskId: null,
						currentTask: null,
						currentTaskMessageId: null,
						lastCompletedTask: null,
						lastError: null,
						lastSeenSeq: 0,
						joinedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						sessionId: memberSessionId,
					});
					setMemberActiveRoomContext(created, memberSessionId, "worker_1234");

					const queued = await queueCrewTell(
						{ to: "worker", kind: "task", summary: "Batch task delivery", content: "Do the thing" },
						{
							activeRoom: getActiveRoom(ownerSessionId)!,
							batchContext: { id: "batch-task-delivery-1", silentOwnerDelivery: true },
						} as any,
					);

					const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
					await processUnreadMessages(
						{
							sendMessage(message: unknown, options?: unknown) {
								sentMessages.push({ message, options });
								return undefined;
							},
						} as any,
						getActiveRoom(memberSessionId)!,
					);
					await waitFor(() => sentMessages.length === 1);

					const persistedTask = await readMessage(created.roomDir, queued.message.id);
					expect((queued.message as { batchId?: string }).batchId).toBe("batch-task-delivery-1");
					expect(queued.message.silent).toBeUndefined();
					expect((persistedTask as { batchId?: string } | null)?.batchId).toBe("batch-task-delivery-1");
					expect(persistedTask?.silent).toBeUndefined();
					expect(sentMessages).toHaveLength(1);
					expect((sentMessages[0]?.options as { deliverAs?: string } | undefined)?.deliverAs).toBe("steer");
					expect((sentMessages[0]?.options as { triggerTurn?: boolean } | undefined)?.triggerTurn).toBe(true);
					expect((sentMessages[0]?.message as { customType?: string } | undefined)?.customType).toBe("mail");
					expect((sentMessages[0]?.message as { content?: string } | undefined)?.content).toContain(
						`Summary: ${queued.message.summary}`,
					);
				} finally {
					delete process.env.PI_ROOM_DELIVERY_DEBOUNCE_MS;
				}
			});
		});

		it("batch-tagged task batchId propagates into Starting and terminal reply messages", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const ownerSessionId = "owner-session-batch-tagged-task";
				const memberSessionId = "worker-session-batch-tagged-task";
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: ownerSessionId,
					cwd: tempDir,
					ownerPid: process.pid,
				});
				setOwnerActiveRoomContext(created, ownerSessionId);
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: "worker-runtime",
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: memberSessionId,
				});
				setMemberActiveRoomContext(created, memberSessionId, "worker_1234");

				const queued = await queueCrewTell(
					{ to: "worker", kind: "task", summary: "Batch task", content: "Do the thing" },
					{
						activeRoom: getActiveRoom(ownerSessionId)!,
						batchContext: { id: "batch-task-1", silentOwnerDelivery: true },
					} as any,
				);

				await processUnreadMessages(
					{ sendMessage() { return undefined; } } as any,
					getActiveRoom(memberSessionId)!,
				);

				expect((queued.message as { batchId?: string }).batchId).toBe("batch-task-1");
				expect(queued.message.silent).toBeUndefined();
				let starting = (await listBoardEntries(created.roomDir, 20)).find(
					(entry) => entry.summary === `Starting: ${queued.message.summary}`,
				);
				await waitFor(async () => {
					starting = (await listBoardEntries(created.roomDir, 20)).find(
						(entry) => entry.summary === `Starting: ${queued.message.summary}`,
					);
					return Boolean(starting);
				});
				expect(starting?.silent).toBe(true);
				expect((starting as { batchId?: string } | undefined)?.batchId).toBe("batch-task-1");

				const reply = await executeCrewReply(
					{ seq: queued.message.seq, summary: "Done", kind: "completion" },
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						sessionManager: { getSessionId: () => ownerSessionId },
					},
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);
				expect(reply.isError).toBeUndefined();

				const board = await listBoardEntries(created.roomDir, 20);
				const terminalReply = board.find(
					(entry) => entry.replyTo === queued.message.id && entry.kind === "completion",
				);
				expect(terminalReply?.silent).toBe(true);
				expect((terminalReply as { batchId?: string } | undefined)?.batchId).toBe("batch-task-1");
			});
		});

		it("batch-tagged stale spawnBatchId is cleared on aborted spawn and remove", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const sessionId = "owner-session-batch-tagged-cleanup";
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: sessionId,
					cwd: tempDir,
					ownerPid: process.pid,
				});
				setOwnerActiveRoomContext(created, sessionId);
				const activeRoom = getActiveRoom(sessionId);
				assert(activeRoom);

				const failingAdapters = {
					pi: {
						kind: "pi",
						async isAvailable() {
							return true;
						},
						async spawn() {
							throw new Error("spawn exploded");
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
				} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };

				const queued = await queueCrewAdd(
					{ name: "broken", type: "worker" },
					{
						activeRoom,
						sessionId,
						ctx: { cwd: tempDir, hasUI: false },
						adapters: failingAdapters,
						batchContext: { id: "batch-cleanup-1", silentOwnerDelivery: true },
					} as any,
				);
				await Promise.allSettled([...(getActiveRoom(sessionId)?.pendingToolTasks ?? [])]);

				const failedMember = await loadRoomMemberState(created.roomDir, queued.memberName);
				expect((failedMember as { spawnBatchId?: string | null }).spawnBatchId).toBeNull();
				let spawnFailure = (await listBoardEntries(created.roomDir, 20)).find(
					(entry) => entry.summary === `Spawn failed: ${queued.memberLabel}`,
				);
				await waitFor(async () => {
					spawnFailure = (await listBoardEntries(created.roomDir, 20)).find(
						(entry) => entry.summary === `Spawn failed: ${queued.memberLabel}`,
					);
					return spawnFailure?.silent === true
						&& (spawnFailure as { batchId?: string } | undefined)?.batchId === "batch-cleanup-1";
				});
				expect(spawnFailure?.silent).toBe(true);
				expect((spawnFailure as { batchId?: string } | undefined)?.batchId).toBe("batch-cleanup-1");

				await writeRoomMemberState(created.roomDir, {
					name: "stale_1234",
					displayName: "stale",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					spawnBatchId: "batch-cleanup-stale",
				} as any);

				const removeResult = await executeCrewRemove(
					{ name: "stale" },
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						sessionManager: { getSessionId: () => sessionId },
					},
					runtimeRoot,
					{
						pi: { kind: "pi", async spawn() { throw new Error("not used"); } } as any,
						paseo: { kind: "paseo", async spawn() { throw new Error("not used"); } } as any,
					},
					{ ownerName: "owner" },
				);
				expect(removeResult.isError).toBeUndefined();
				const removedMember = await loadRoomMemberState(created.roomDir, "stale_1234");
				expect((removedMember as { spawnBatchId?: string | null }).spawnBatchId).toBeNull();
			});
		});

		it("batch-tagged late spawn success cleanup clears spawnBatchId without leaking stale join tags", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const sessionId = "owner-session-batch-late-cleanup";
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: sessionId,
					cwd: tempDir,
					ownerPid: process.pid,
				});
				setOwnerActiveRoomContext(created, sessionId);
				const activeRoom = getActiveRoom(sessionId);
				assert(activeRoom);

				let releaseSpawn!: () => void;
				const waitForRelease = new Promise<void>((resolve) => {
					releaseSpawn = resolve;
				});
				const cleanedMembers: RoomMemberState[] = [];
				const adapters = {
					pi: {
						kind: "pi",
						async isAvailable() {
							return true;
						},
						async spawn() {
							await waitForRelease;
							return { runtimeId: "late-cleanup-runtime", backend: "pi" as const };
						},
						async remove(member: RoomMemberState) {
							cleanedMembers.push(member);
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
				} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };

				const queued = await queueCrewAdd(
					{ name: "late", type: "worker" },
					{
						activeRoom,
						sessionId,
						ctx: { cwd: tempDir, hasUI: false },
						adapters,
						batchContext: { id: "batch-late-cleanup-1", silentOwnerDelivery: true },
					} as any,
				);

				const spawnJob = await readSpawnJob(created.roomDir, queued.taskId);
				assert(spawnJob);
				await writeJsonAtomic(
					path.join(created.roomDir, "jobs", `spawn-${queued.taskId}.json`),
					{
						...spawnJob,
						state: "timed_out_pending_external_resolution",
						error: "timed out waiting for external runtime",
						updatedAt: new Date().toISOString(),
					},
				);

				releaseSpawn();
				await Promise.allSettled([...(getActiveRoom(sessionId)?.pendingToolTasks ?? [])]);

				const cleaned = await loadRoomMemberState(created.roomDir, queued.memberName);
				expect(cleaned.spawnBatchId).toBeNull();
				expect(cleaned.state).toBe("error");
				expect(cleaned.runtimeId).toBeNull();
				expect(cleanedMembers).toHaveLength(1);

				const board = await listBoardEntries(created.roomDir, 20);
				expect(board.find((entry) => entry.summary.includes(`Agent ${queued.memberLabel} ready`))).toBeUndefined();
				expect(board.find((entry) =>
					entry.from === queued.memberName
					&& entry.to === "owner"
					&& entry.batchId === "batch-late-cleanup-1",
				)).toBeUndefined();
			});
		});

		it("logs spawnBatchId cleanup failures after member join without aborting bootstrap", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-batch-cleanup-log",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				await createSpawningMember(created.roomDir, {
					name: "worker_cleanup_log",
					type: "worker",
					backend: "pi",
					taskId: "spawn-worker-cleanup-log",
					spawnBatchId: "batch-cleanup-log-1",
					bootstrapToken: "cleanup-log-token",
				});

				const bootstrap: RoomBootstrap = {
					version: 1,
					roomId: created.metadata.roomId,
					roomDir: created.roomDir,
					memberName: "worker_cleanup_log",
					memberType: "worker",
					ownerName: "owner",
					ownerSessionId: "owner-session-batch-cleanup-log",
					token: "cleanup-log-token",
					spawnTaskId: "spawn-worker-cleanup-log",
				};

				const cleanupError = new Error("cleanup write exploded");
				const updateSpy = vi.spyOn(storageModule, "updateRoomMemberState")
					.mockRejectedValue(cleanupError);
				const log = {
					info: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(),
					debug: vi.fn(),
				};
				const loggerSpy = vi.spyOn(loggerModule, "createRoomLogger")
					.mockReturnValue(log);

				try {
					await expect(activateBootstrapRoom(
						{ sendMessage() { return undefined; } } as any,
						buildRoomBootstrapBlock(bootstrap),
						"member-session-batch-cleanup-log",
						{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					)).resolves.toBeUndefined();

					expect(log.error).toHaveBeenCalledWith(
						"member join spawnBatchId cleanup failed",
						{
							memberName: "worker_cleanup_log",
							batchId: "batch-cleanup-log-1",
							error: String(cleanupError),
						},
					);
					expect(getActiveRoom("member-session-batch-cleanup-log")?.memberName).toBe("worker_cleanup_log");
					expect((await loadRoomMemberState(created.roomDir, "worker_cleanup_log")).spawnBatchId).toBe("batch-cleanup-log-1");
				} finally {
					loggerSpy.mockRestore();
					updateSpy.mockRestore();
					clearActiveRoom("member-session-batch-cleanup-log");
				}
			});
		});

		it("preserves batch-tagged silent join notifications for paseo member claims", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-batch-paseo-join",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				await createSpawningMember(created.roomDir, {
					name: "worker_paseo_join",
					type: "worker",
					backend: "paseo",
					taskId: "spawn-worker-paseo-join",
					spawnBatchId: "batch-paseo-join-1",
					bootstrapToken: "paseo-join-token",
				});

				await activateBootstrapRoom(
					{ sendMessage() { return undefined; } } as any,
					buildRoomBootstrapBlock({
						version: 1,
						roomId: created.metadata.roomId,
						roomDir: created.roomDir,
						memberName: "worker_paseo_join",
						memberType: "worker",
						ownerName: "owner",
						ownerSessionId: "owner-session-batch-paseo-join",
						token: "paseo-join-token",
						spawnTaskId: "spawn-worker-paseo-join",
					}),
					"member-session-batch-paseo-join",
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				);

				const board = await listBoardEntries(created.roomDir, 20);
				const joinStatus = board.find((entry) =>
					entry.from === "worker_paseo_join"
					&& entry.to === "owner"
				);
				expect(joinStatus?.silent).toBe(true);
				expect(joinStatus?.batchId).toBe("batch-paseo-join-1");
				expect((await loadRoomMemberState(created.roomDir, "worker_paseo_join")).spawnBatchId).toBeNull();
			});
		});

		it("batch-tagged cancelled stop replies preserve correlation without leaking into later unrelated tasks", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const sessionId = "owner-session-batch-stop-cancelled";
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: sessionId,
					cwd: tempDir,
					ownerPid: process.pid,
				});
				setOwnerActiveRoomContext(created, sessionId);
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: "worker-stop-runtime",
					state: "running",
					spawnTaskId: null,
					spawnBatchId: "batch-stop-1",
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: "worker-stop-session",
				});
				const originalTask = await appendMessage(created.roomDir, {
					from: "owner",
					to: "worker_1234",
					broadcast: false,
					replyTo: null,
					kind: "task",
					summary: "Batch-managed task",
					batchId: "batch-stop-1",
					silent: true,
				});
				await writeRoomMemberState(created.roomDir, {
					...(await loadRoomMemberState(created.roomDir, "worker_1234")),
					currentTask: originalTask.summary,
					currentTaskMessageId: originalTask.id,
					updatedAt: new Date().toISOString(),
				});

				const stopResult = await executeCrewStop(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						sessionManager: { getSessionId: () => sessionId },
					},
					runtimeRoot,
					{
						pi: {
							kind: "pi",
							stopKeepsRuntime: true,
							async spawn() {
								throw new Error("not used");
							},
							async stop() {
								return undefined;
							},
						},
						paseo: {
							kind: "paseo",
							async spawn() {
								throw new Error("not used");
							},
						},
					},
					{ ownerName: "owner" },
				);
				expect(stopResult.isError).toBeUndefined();

				const stopped = await loadRoomMemberState(created.roomDir, "worker_1234");
				expect(stopped.spawnBatchId).toBeNull();
				expect(stopped.state).toBe("idle");

				const board = await listBoardEntries(created.roomDir, 20);
				const cancelledReply = board.find((entry) =>
					entry.replyTo === originalTask.id && entry.kind === "cancelled"
				);
				expect(cancelledReply?.replyTo).toBe(originalTask.id);
				expect(cancelledReply?.batchId).toBe("batch-stop-1");
				expect(cancelledReply?.silent).toBe(true);

				const unrelated = await queueCrewTell(
					{ to: "worker", kind: "task", summary: "Fresh unrelated task" },
					{ activeRoom: getActiveRoom(sessionId)! },
				);
				expect(unrelated.message.batchId).toBeUndefined();
				expect(unrelated.message.silent).toBeUndefined();
			});
		});

		it("batch-tagged remove clears batch-managed spawn metadata", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const sessionId = "owner-session-batch-remove-cleanup";
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: sessionId,
					cwd: tempDir,
					ownerPid: process.pid,
				});
				setOwnerActiveRoomContext(created, sessionId);
				await writeRoomMemberState(created.roomDir, {
					name: "remove_1234",
					displayName: "remove",
					type: "worker",
					backend: "pi",
					runtimeId: "remove-runtime",
					state: "idle",
					spawnTaskId: null,
					spawnBatchId: "batch-remove-1",
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: "remove-session",
				});

				const removeResult = await executeCrewRemove(
					{ name: "remove" },
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						sessionManager: { getSessionId: () => sessionId },
					},
					runtimeRoot,
					{
						pi: {
							kind: "pi",
							async spawn() {
								throw new Error("not used");
							},
							async remove() {
								return undefined;
							},
						},
						paseo: {
							kind: "paseo",
							async spawn() {
								throw new Error("not used");
							},
						},
					},
					{ ownerName: "owner" },
				);
				expect(removeResult.isError).toBeUndefined();
				const removed = await loadRoomMemberState(created.roomDir, "remove_1234");
				expect(removed.state).toBe("removed");
				expect(removed.spawnBatchId).toBeNull();
			});
		});

		it("crew_batch owner-authoritative append paths preserve batchId on raw batch-managed tasks", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const ownerSessionId = "owner-session-batch-owner-append";
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId,
					cwd: tempDir,
					ownerPid: process.pid,
				});
				setOwnerActiveRoomContext(created, ownerSessionId);

				const memberJobs: Promise<void>[] = [];
				const adapters = {
					pi: {
						kind: "pi",
						async isAvailable() {
							return true;
						},
						async spawn(request: {
							memberName: string;
							memberLabel?: string;
							systemPrompt?: string;
						}) {
							const alias = request.memberLabel?.split("#")[0] ?? request.memberName;
							const memberSessionId = `member-session-${request.memberName}`;
							const scriptedReplies = alias === "reviewer"
								? [
									{ kind: "completion" as const, summary: "VERDICT: FAIL — Needs another round" },
									{ kind: "completion" as const, summary: "VERDICT: PASS — Looks good now" },
								]
								: [
									{ kind: "completion" as const, summary: "Initial draft" },
									{ kind: "completion" as const, summary: "Revised draft" },
								];
							memberJobs.push((async () => {
								await activateBootstrapRoom(
									{ sendMessage() { return undefined; } } as any,
									request.systemPrompt ?? "",
									memberSessionId,
									{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
								);
								const repliedTaskIds = new Set<string>();
								const replies = [...scriptedReplies];
								await waitFor(async () => {
									const board = await listBoardEntries(created.roomDir, Number.MAX_SAFE_INTEGER);
									for (const message of board) {
										if (
											message.kind !== "task"
											|| message.to !== request.memberName
											|| repliedTaskIds.has(message.id)
											|| replies.length === 0
										) {
											continue;
										}
										repliedTaskIds.add(message.id);
										const nextReply = replies.shift()!;
										await appendMessage(created.roomDir, {
											from: request.memberName,
											to: message.from,
											broadcast: false,
											replyTo: message.id,
											kind: nextReply.kind,
											summary: nextReply.summary,
										});
										const currentMember = await loadRoomMemberState(created.roomDir, request.memberName);
										await writeRoomMemberState(created.roomDir, {
											...currentMember,
											state: "idle",
											currentTask: null,
											currentTaskMessageId: null,
											lastCompletedTask: nextReply.kind === "completion"
												? nextReply.summary
												: currentMember.lastCompletedTask,
											lastError: nextReply.kind === "error"
												? nextReply.summary
												: null,
											updatedAt: new Date().toISOString(),
										});
									}
									return replies.length === 0;
								}, 2_000);
							})());
							return { runtimeId: `runtime-${request.memberName}`, backend: "pi" as const };
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
				} satisfies { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };

				const result = await executeCrewBatch(
					{
						template: "plan-review-loop",
						params: {
							author: { name: "author", type: "worker" },
							reviewers: [{ name: "reviewer", type: "worker" }],
							initialAuthorTask: "Draft the batch plan.",
							maxRounds: 2,
						},
					},
					{ sendMessage() { return undefined; } } as any,
					{
						cwd: tempDir,
						hasUI: false,
						getSystemPrompt: () => "",
						sessionManager: { getSessionId: () => ownerSessionId },
					},
					runtimeRoot,
					adapters,
					{ ownerName: "owner" },
				);

				const trackedTasks = [...(getActiveRoom(ownerSessionId)?.pendingToolTasks ?? [])];
				await Promise.allSettled(trackedTasks);
				await Promise.all(memberJobs);
				expect(result.isError).toBeUndefined();

				const board = await listBoardEntries(created.roomDir, Number.MAX_SAFE_INTEGER);
				const ownerTasks = board.filter((entry) =>
					entry.kind === "task"
					&& entry.to !== "room"
					&& Boolean(entry.batchId)
				);
				expect(ownerTasks.length).toBeGreaterThanOrEqual(4);
				const batchIds = new Set(ownerTasks.map((entry) => entry.batchId).filter((value): value is string => Boolean(value)));
				expect(batchIds.size).toBe(1);
				expect(ownerTasks.every((entry) => entry.silent !== true)).toBe(true);
			});
		});
	});

	it("surfaces ambiguous alias errors instead of reporting not found", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-target-ambiguous",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-target-ambiguous");
			for (const name of ["explorer_1234", "explorer_5678"]) {
				await writeRoomMemberState(created.roomDir, {
					name,
					displayName: "explorer",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
				});
			}

			const result = await executeCrewTell(
				{ to: "explorer", summary: "Run ambiguous task", kind: "task" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-target-ambiguous" } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text ?? "").toMatch(/ambiguous/i);
			expect(result.content[0]?.text ?? "").toMatch(/explorer#1234/i);
			expect(result.content[0]?.text ?? "").toMatch(/explorer#5678/i);
		});
	});

	it("crew_tell keeps working when summary contains unresolved mentions", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-summary-mentions-send",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-summary-mentions-send");
			const internalWorkerName = "worker_1234";
			await writeRoomMemberState(created.roomDir, {
				name: internalWorkerName,
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-session",
			});

			const result = await executeCrewTell(
				{ summary: "Check @worker and @missing before publish", kind: "info" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-summary-mentions-send" } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/seq:/i);
			expect(result.content[0]?.text ?? "").toMatch(/@missing/i);

			const board = await listBoardEntries(created.roomDir, 20);
			expect(board.at(-1)?.mentions ?? []).toEqual([internalWorkerName]);
			expect(board.at(-1)?.summary).toBe("Check @worker and @missing before publish");
		});
	});

	it("crew_tell resolves display labels inside summary mentions", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-summary-mention-label-send",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-summary-mention-label-send");
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

			const result = await executeCrewTell(
				{ summary: "Check @worker#5678 before publish", kind: "info" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-summary-mention-label-send" } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/seq:/i);
			expect(result.content[0]?.text ?? "").not.toMatch(/warning:/i);

			const board = await listBoardEntries(created.roomDir, 20);
			expect(board.at(-1)?.mentions ?? []).toEqual(["worker_5678"]);
			expect(board.at(-1)?.summary).toBe("Check @worker#5678 before publish");
		});
	});

	it("crew_tell warns instead of failing on ambiguous summary mentions", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-summary-mentions-ambiguous-send",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-summary-mentions-ambiguous-send");
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

			const result = await executeCrewTell(
				{ summary: "Check @worker before publish", kind: "info" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-summary-mentions-ambiguous-send" } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/seq:/i);
			expect(result.content[0]?.text ?? "").toMatch(/warning:/i);
			expect(result.content[0]?.text ?? "").toMatch(/@worker/i);

			const board = await listBoardEntries(created.roomDir, 20);
			expect(board.at(-1)?.mentions ?? []).toEqual([]);
			expect(board.at(-1)?.summary).toBe("Check @worker before publish");
		});
	});

	it("crew_tell preserves valid summary mentions for directed tasks", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-directed-task-mentions",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-directed-task-mentions");
			await writeRoomMemberState(created.roomDir, {
				name: "explorer_1234",
				displayName: "explorer",
				type: "worker",
				backend: "pi",
				runtimeId: "explorer-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "explorer-session",
			});
			const internalWorkerName = "worker_5678";
			await writeRoomMemberState(created.roomDir, {
				name: internalWorkerName,
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-session",
			});

			const result = await executeCrewTell(
				{ to: "explorer", summary: "Pair with @worker and @missing", kind: "task" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-directed-task-mentions" } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/seq:/i);
			expect(result.content[0]?.text ?? "").toMatch(/@missing/i);

			const board = await listBoardEntries(created.roomDir, 20);
			expect(board.at(-1)?.to).toBe("explorer_1234");
			expect(board.at(-1)?.kind).toBe("task");
			expect(board.at(-1)?.mentions ?? []).toEqual([internalWorkerName]);
			expect(board.at(-1)?.summary).toBe("Pair with @worker and @missing");
			const mentionedWorker = await loadRoomMemberState(created.roomDir, internalWorkerName);
			expect(mentionedWorker.state).toBe("idle");
			expect(mentionedWorker.currentTaskMessageId).toBeNull();
		});
	});

	it("crew_reply keeps working when summary contains unresolved mentions", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-summary-mentions-reply",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-summary-mentions-reply");
			const internalWorkerName = "worker_1234";
			await writeRoomMemberState(created.roomDir, {
				name: internalWorkerName,
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-session",
			});

			const original = await appendMessage(created.roomDir, {
				from: internalWorkerName,
				to: "room",
				broadcast: false,
				replyTo: null,
				kind: "info",
				summary: "Worker update",
			});

			const result = await executeCrewReply(
				{ seq: original.seq, summary: "Done, handoff @worker and @missing", kind: "completion" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-summary-mentions-reply" } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/seq:/i);
			expect(result.content[0]?.text ?? "").toMatch(/@missing/i);

			const board = await listBoardEntries(created.roomDir, 20);
			expect(board.at(-1)?.mentions ?? []).toEqual([internalWorkerName]);
			expect(board.at(-1)?.summary).toBe("Done, handoff @worker and @missing");
		});
	});

	it("crew_reply resolves display labels inside summary mentions", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-summary-mention-label-reply",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-summary-mention-label-reply");
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

			const original = await appendMessage(created.roomDir, {
				from: "worker_1234",
				to: "room",
				broadcast: false,
				replyTo: null,
				kind: "info",
				summary: "Worker update",
			});

			const result = await executeCrewReply(
				{ seq: original.seq, summary: "Done, handoff @worker#5678", kind: "completion" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-summary-mention-label-reply" } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/seq:/i);
			expect(result.content[0]?.text ?? "").not.toMatch(/warning:/i);

			const board = await listBoardEntries(created.roomDir, 20);
			expect(board.at(-1)?.mentions ?? []).toEqual(["worker_5678"]);
			expect(board.at(-1)?.summary).toBe("Done, handoff @worker#5678");
		});
	});

	it("crew_reply warns instead of failing on ambiguous summary mentions", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-summary-mentions-ambiguous-reply",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-summary-mentions-ambiguous-reply");
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

			const original = await appendMessage(created.roomDir, {
				from: "worker_1234",
				to: "room",
				broadcast: false,
				replyTo: null,
				kind: "info",
				summary: "Worker update",
			});

			const result = await executeCrewReply(
				{ seq: original.seq, summary: "Done, handoff @worker", kind: "completion" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-summary-mentions-ambiguous-reply" } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toMatch(/seq:/i);
			expect(result.content[0]?.text ?? "").toMatch(/warning:/i);
			expect(result.content[0]?.text ?? "").toMatch(/@worker/i);

			const board = await listBoardEntries(created.roomDir, 20);
			expect(board.at(-1)?.mentions ?? []).toEqual([]);
			expect(board.at(-1)?.summary).toBe("Done, handoff @worker");
		});
	});

	it("resolves display label in crew_cancel", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-target-stop",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-target-stop");
			await writeRoomMemberState(created.roomDir, {
				name: "explorer_1234",
				displayName: "explorer",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: null,
			});

			const result = await executeCrewStop(
				{ name: "explorer#1234" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-target-stop" } },
				runtimeRoot,
				{
					pi: { kind: "pi", async spawn() { throw new Error("not used"); } } as any,
					paseo: { kind: "paseo", async spawn() { throw new Error("not used"); } } as any,
				},
				{ ownerName: "owner" },
			);
			expect(result.isError).toBeUndefined();
			expect((await loadRoomMemberState(created.roomDir, "explorer_1234")).state).toBe("error");
		});
	});

	it("resolves display alias in crew_remove", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-target-remove",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-target-remove");
			await writeRoomMemberState(created.roomDir, {
				name: "explorer_1234",
				displayName: "explorer",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: null,
			});

			const result = await executeCrewRemove(
				{ name: "explorer" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-target-remove" } },
				runtimeRoot,
				{
					pi: { kind: "pi", async spawn() { throw new Error("not used"); } } as any,
					paseo: { kind: "paseo", async spawn() { throw new Error("not used"); } } as any,
				},
				{ ownerName: "owner" },
			);
			expect(result.isError).toBeUndefined();
			expect((await loadRoomMemberState(created.roomDir, "explorer_1234")).state).toBe("removed");
		});
	});
});

describe("mail members output", () => {
	it("returns structured JSON with copy-pasteable labels and internal ids", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-mail-members",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-mail-members");
			await writeRoomMemberState(created.roomDir, {
				name: "explorer_1234",
				displayName: "explorer",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: null,
			});

			const members = await collectCrewWhoEntries(created.roomDir, tempDir);
			const explorer = members.find((member) => member.name === "explorer_1234");
			expect(explorer).toMatchObject({
				name: "explorer_1234",
				displayName: "explorer",
				label: "explorer#1234",
				target: "explorer#1234",
				type: "worker",
				state: "idle",
			});
		});
	});

	it("returns an empty JSON array when the room has no non-removed members", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-mail-members-empty",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-mail-members-empty");
			await writeRoomMemberState(created.roomDir, {
				name: "owner",
				type: "owner",
				backend: "pi",
				runtimeId: String(process.pid),
				state: "removed",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "owner-session-mail-members-empty",
			});

			const members = await collectCrewWhoEntries(created.roomDir, tempDir);
			expect(members).toEqual([]);
		});
	});
});

describe("terminal dependency notifications", () => {
	it("notifies downstream tasks when crew_cancel cancels an upstream task", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-stop-deps",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-stop-deps");
			await writeRoomMemberState(created.roomDir, {
				name: "worker_1234",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-session",
			});
			await writeRoomMemberState(created.roomDir, {
				name: "reviewer_5678",
				displayName: "reviewer",
				type: "worker",
				backend: "pi",
				runtimeId: "reviewer-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "reviewer-session",
			});
			await writeMemberHeartbeat(created.roomDir, "worker_1234");
			await writeMemberHeartbeat(created.roomDir, "reviewer_5678");

			const upstream = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_1234",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "upstream task",
			});
			await appendMessage(created.roomDir, {
				from: "owner",
				to: "reviewer_5678",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "downstream task",
				content: `Wait for {input:#${upstream.seq}} before starting.`,
			});

			const result = await executeCrewStop(
				{ name: "worker" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-stop-deps" } },
				runtimeRoot,
				{
					pi: {
						kind: "pi",
						async spawn() { throw new Error("not used"); },
						async remove() {
							return;
						},
					} as any,
					paseo: { kind: "paseo", async spawn() { throw new Error("not used"); } } as any,
				},
				{ ownerName: "owner" },
			);
			expect(result.isError).toBeUndefined();

			const entries = await listBoardEntries(created.roomDir, 20);
			expect(entries.some((entry) => entry.to === "reviewer_5678" && /Dependency cancelled/.test(entry.summary))).toBe(true);
		});
	});

	it("notifies downstream tasks when crew_remove cancels an upstream task", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-remove-deps",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-remove-deps");
			await writeRoomMemberState(created.roomDir, {
				name: "worker_1234",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-session",
			});
			await writeRoomMemberState(created.roomDir, {
				name: "reviewer_5678",
				displayName: "reviewer",
				type: "worker",
				backend: "pi",
				runtimeId: "reviewer-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "reviewer-session",
			});

			const upstream = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_1234",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "upstream task",
			});
			await appendMessage(created.roomDir, {
				from: "owner",
				to: "reviewer_5678",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "downstream task",
				content: `Wait for {input:#${upstream.seq}} before starting.`,
			});

			const result = await executeCrewRemove(
				{ name: "worker" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-remove-deps" } },
				runtimeRoot,
				{
					pi: {
						kind: "pi",
						async spawn() { throw new Error("not used"); },
						async remove() {
							return;
						},
					} as any,
					paseo: { kind: "paseo", async spawn() { throw new Error("not used"); } } as any,
				},
				{ ownerName: "owner" },
			);
			expect(result.isError).toBeUndefined();

			const entries = await listBoardEntries(created.roomDir, 20);
			expect(entries.some((entry) => entry.to === "reviewer_5678" && /Dependency cancelled/.test(entry.summary))).toBe(true);
			expect(entries.some((entry) => entry.replyTo === upstream.id && entry.kind === "cancelled")).toBe(true);
		});
	});

	it("does not emit cancelled dependency notifications when crew_cancel fails", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-stop-failure-deps",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-stop-failure-deps");
			await writeRoomMemberState(created.roomDir, {
				name: "worker_1234",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-session",
			});
			await writeRoomMemberState(created.roomDir, {
				name: "reviewer_5678",
				displayName: "reviewer",
				type: "worker",
				backend: "pi",
				runtimeId: "reviewer-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "reviewer-session",
			});

			const upstream = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_1234",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "upstream task",
			});
			await appendMessage(created.roomDir, {
				from: "owner",
				to: "reviewer_5678",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "downstream task",
				content: `Wait for {input:#${upstream.seq}} before starting.`,
			});

			const result = await executeCrewStop(
				{ name: "worker" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-stop-failure-deps" } },
				runtimeRoot,
				{
					pi: {
						kind: "pi",
						async spawn() { throw new Error("not used"); },
						async stop() {
							throw new Error("stop failed");
						},
					} as any,
					paseo: { kind: "paseo", async spawn() { throw new Error("not used"); } } as any,
				},
				{ ownerName: "owner" },
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text ?? "").toMatch(/stop failed/i);

			const entries = await listBoardEntries(created.roomDir, 20);
			expect(entries.some((entry) => entry.to === "reviewer_5678" && /Dependency cancelled/.test(entry.summary))).toBe(false);
			expect(entries.some((entry) => entry.replyTo === upstream.id && entry.kind === "cancelled")).toBe(false);
		});
	});

	it("does not deliver new tasks to a stop tombstone after a degraded stop", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-stop-tombstone",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-stop-tombstone");
			await writeRoomMemberState(created.roomDir, {
				name: "worker_1234",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-session",
			});

			const stopResult = await executeCrewStop(
				{ name: "worker" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-stop-tombstone" } },
				runtimeRoot,
				{
					pi: {
						kind: "pi",
						async spawn() { throw new Error("not used"); },
						async stop() {
							throw new Error("Timeout waiting for message");
						},
					} as any,
					paseo: { kind: "paseo", async spawn() { throw new Error("not used"); } } as any,
				},
				{ ownerName: "owner" },
			);
			expect(stopResult.isError).toBeUndefined();

			const sendResult = await executeCrewTell(
				{ to: "worker", summary: "new task", kind: "task" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-stop-tombstone" } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{},
			);

			expect(sendResult.isError).toBe(true);
			expect(sendResult.content[0]?.text ?? "").toMatch(/not available/i);
			expect(sendResult.content[0]?.text ?? "").toMatch(/removed/i);
		});
	});

	it("archives stop cleanup fallback without replacing the terminal snapshot merge target", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-stop-snapshot-priority",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-stop-snapshot-priority");

			const worktree = await createWorktree("worker_stop", tempDir, "b4-stop-priority");
			if (!worktree) throw new Error("Failed to create worktree");
			await fs.writeFile(path.join(worktree.path, "terminal-stop.txt"), "terminal snapshot\n", "utf8");
			const terminalSnapshot = await persistWorktreeSnapshot(worktree.path, { commitMessage: "terminal stop snapshot" });
			const terminalSnapshotOid = terminalSnapshot.commitOid!;
			await fs.writeFile(path.join(worktree.path, "cleanup-stop.txt"), "cleanup fallback\n", "utf8");

			await writeRoomMemberState(created.roomDir, {
				name: "worker_1234",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: null,
				worktree,
				lastSnapshotOid: terminalSnapshotOid,
				lastMergedOid: null,
			});

			const stopResult = await executeCrewStop(
				{ name: "worker" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-stop-snapshot-priority" } },
				runtimeRoot,
				{
					pi: { kind: "pi", async spawn() { throw new Error("not used"); } } as any,
					paseo: { kind: "paseo", async spawn() { throw new Error("not used"); } } as any,
				},
				{ ownerName: "owner" },
			);
			expect(stopResult.isError).toBeUndefined();

			const stoppedMember = await loadRoomMemberState(created.roomDir, "worker_1234");
			expect(stoppedMember.state).toBe("error");
			expect(stoppedMember.worktree).toBeNull();
			expect(stoppedMember.lastSnapshotOid).toBe(terminalSnapshotOid);
			expect(stoppedMember.worktreeResult?.snapshotOid).toMatch(/^[0-9a-f]{40}$/);
			expect(stoppedMember.worktreeResult?.snapshotOid).not.toBe(terminalSnapshotOid);

			const mergeResult = await executeCrewMerge(
				{ name: "worker" },
				{ sendMessage() { return undefined; } } as any,
				{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "owner-session-stop-snapshot-priority" } },
				runtimeRoot,
				{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				{ ownerName: "owner" },
			);

			expect(mergeResult.isError).toBeUndefined();
			expect(mergeResult.content[0]?.text).toContain(terminalSnapshotOid.slice(0, 12));
			const mergedMember = await loadRoomMemberState(created.roomDir, "worker_1234");
			expect(mergedMember.lastMergedOid).toBe(terminalSnapshotOid);
		});
	});

	it("lets a member retry terminal handoff after the mutation client becomes available", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-member-retry",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			await writeRoomMemberState(created.roomDir, {
				name: "worker_1234",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-session",
			});
			await writeRoomMemberState(created.roomDir, {
				name: "reviewer_5678",
				displayName: "reviewer",
				type: "worker",
				backend: "pi",
				runtimeId: "reviewer-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "reviewer-session",
			});

			const upstream = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_1234",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "upstream task",
			});
			await appendMessage(created.roomDir, {
				from: "owner",
				to: "reviewer_5678",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "downstream task",
				content: `Wait for {input:#${upstream.seq}} before starting.`,
			});

			const proxy = new MutationProxyServer(created.roomDir);
			await proxy.start();
			setMemberActiveRoomContext(created, "worker-session", "worker_1234");
			let client: ReturnType<typeof createMutationClient> | null = null;

			try {
				const failedReply = await executeCrewReply(
					{ seq: upstream.seq, summary: "Done", kind: "completion" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "worker-session" } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);

				expect(failedReply.isError).toBe(true);
				expect(failedReply.content[0]?.text ?? "").toMatch(/mutation proxy is unavailable/i);

				let entries = await listBoardEntries(created.roomDir, 20);
				expect(entries.filter((entry) => entry.replyTo === upstream.id && entry.kind === "completion")).toHaveLength(1);
				expect(entries.some((entry) => entry.to === "reviewer_5678" && /All dependencies ready/.test(entry.summary))).toBe(false);

				client = createMutationClient(created.roomDir);
				await client.connect();
				setRoomMutationClient(created.roomDir, client);

				const retriedReply = await executeCrewReply(
					{ seq: upstream.seq, summary: "Done", kind: "completion" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "worker-session" } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);

				expect(retriedReply.isError).toBeUndefined();

				entries = await listBoardEntries(created.roomDir, 20);
				expect(entries.filter((entry) => entry.replyTo === upstream.id && entry.kind === "completion")).toHaveLength(1);
				expect(entries.some((entry) => entry.to === "reviewer_5678" && /All dependencies ready/.test(entry.summary))).toBe(true);

			} finally {
				client?.disconnect();
				deleteRoomMutationClient(created.roomDir);
				clearActiveRoom("worker-session");
				await proxy.stop();
			}
		});
	});

	it("coalesces duplicate terminal closure attempts into one board reply and one downstream notification", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-terminal-coalesce",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-terminal-coalesce");
			await writeRoomMemberState(created.roomDir, {
				name: "worker_1234",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-session",
			});
			await writeRoomMemberState(created.roomDir, {
				name: "reviewer_5678",
				displayName: "reviewer",
				type: "worker",
				backend: "pi",
				runtimeId: "reviewer-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "reviewer-session",
			});

			const upstream = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_1234",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "upstream task",
			});
			await appendMessage(created.roomDir, {
				from: "owner",
				to: "reviewer_5678",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "downstream task",
				content: `Wait for {input:#${upstream.seq}} before starting.`,
			});

			await Promise.all([
				appendTerminalTaskReplyAndNotify({
					roomDir: created.roomDir,
					taskMessageId: upstream.id,
					from: "system",
					to: "worker_1234",
					kind: "cancelled",
					summary: "Task cancelled: upstream task",
					logContext: { source: "test-cancel" },
				}),
				appendTerminalTaskReplyAndNotify({
					roomDir: created.roomDir,
					taskMessageId: upstream.id,
					from: "system",
					to: "worker_1234",
					kind: "error",
					summary: "Task failed: upstream task",
					logContext: { source: "test-error" },
				}),
			]);

			const entries = await listBoardEntries(created.roomDir, 20);
			const terminalReplies = entries.filter((entry) => {
				return entry.replyTo === upstream.id
					&& (entry.kind === "cancelled" || entry.kind === "error" || entry.kind === "completion");
			});
			expect(terminalReplies).toHaveLength(1);
			const depNotifications = entries.filter((entry) => {
				return entry.to === "reviewer_5678" && /Dependency (cancelled|failed)/.test(entry.summary);
			});
			expect(depNotifications).toHaveLength(1);
		});
	});

	it("does not re-notify downstream tasks after owner-side dependency state is rebuilt from disk", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-terminal-reload",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-session-terminal-reload");
			await writeRoomMemberState(created.roomDir, {
				name: "worker_1234",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-session",
			});
			await writeRoomMemberState(created.roomDir, {
				name: "reviewer_5678",
				displayName: "reviewer",
				type: "worker",
				backend: "pi",
				runtimeId: "reviewer-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "reviewer-session",
			});

			const upstream = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_1234",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "upstream reload task",
			});
			await appendMessage(created.roomDir, {
				from: "owner",
				to: "reviewer_5678",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "downstream reload task",
				content: `Wait for {input:#${upstream.seq}} before starting.`,
			});

			await appendTerminalTaskReplyAndNotify({
				roomDir: created.roomDir,
				taskMessageId: upstream.id,
				from: "system",
				to: "worker_1234",
				kind: "error",
				summary: "Task failed: upstream reload task",
				logContext: { source: "test-initial" },
			});
			const before = await listBoardEntries(created.roomDir, 20);
			const beforeNotifications = before.filter((entry) => {
				return entry.to === "reviewer_5678" && /Dependency failed/.test(entry.summary);
			});
			expect(beforeNotifications).toHaveLength(1);

			clearRoomDeps(created.roomDir);
			await recordTerminalTaskState({
				roomDir: created.roomDir,
				taskMessageId: upstream.id,
				status: "error",
				logContext: { source: "test-reload" },
			});

			const after = await listBoardEntries(created.roomDir, 20);
			const afterNotifications = after.filter((entry) => {
				return entry.to === "reviewer_5678" && /Dependency failed/.test(entry.summary);
			});
			expect(afterNotifications).toHaveLength(1);
		});
	});

	it("persists a fixed worktree snapshot and stores snapshot metadata on member state before reporting completion success", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);

			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-snap-meta",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			await writeRoomMemberState(created.roomDir, {
				name: "worker_snap",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-snap-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-snap-session",
			});

			const taskMsg = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_snap",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "snap task",
			});
			const worktree = await createWorktree(
				"worker_snap",
				tempDir,
				"reply-snapshot",
			);
			expect(worktree).toBeTruthy();
			if (!worktree) return;

			await writeRoomMemberState(created.roomDir, {
				name: "worker_snap",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-snap-runtime",
				state: "running",
				spawnTaskId: null,
				currentTask: "snap task",
				currentTaskMessageId: taskMsg.id,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: taskMsg.seq,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-snap-session",
				worktree,
			});

			await fs.writeFile(path.join(worktree.path, "output.txt"), "work result\n", "utf8");

			const proxy = new MutationProxyServer(created.roomDir);
			await proxy.start();
			setMemberActiveRoomContext(created, "worker-snap-session", "worker_snap");
			const client = createMutationClient(created.roomDir);
			await client.connect();
			setRoomMutationClient(created.roomDir, client);

			try {
				const result = await executeCrewReply(
					{ seq: taskMsg.seq, summary: "Done with snap", kind: "completion" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "worker-snap-session" } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);

				expect(result.isError).toBeUndefined();

				const member = await loadRoomMemberState(created.roomDir, "worker_snap") as SnapshotMemberState;

				expect(member.lastSnapshotOid).toMatch(/^[0-9a-f]{40}$/);
				expect(member.lastSnapshotTaskSeq).toBe(taskMsg.seq);
				expect(member.lastSnapshotSummary).toBeTruthy();
				expect(member.lastSnapshotAt).toBeTruthy();
				expect(await git(["rev-parse", "--verify", member.lastSnapshotOid!], tempDir, 10_000)).toBe(member.lastSnapshotOid);
				expect(member.pendingTerminalReply).toBeFalsy();
			} finally {
				client.disconnect();
				deleteRoomMutationClient(created.roomDir);
				clearActiveRoom("worker-snap-session");
				await proxy.stop();
			}
		});
	});

	it("terminal reply with clean worktree reuses current HEAD and does not create an extra commit", async () => {
		await withTempDir(async (tempDir) => {
			const seedOid = await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-clean-wt",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			const worktree = await createWorktree(
				"worker_clean_wt",
				tempDir,
				"clean-wt",
			);
			expect(worktree).toBeTruthy();
			if (!worktree) return;
			const commitsBefore = await countCommits(tempDir, worktree.branch);

			await writeRoomMemberState(created.roomDir, {
				name: "worker_clean_wt",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-clean-wt-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-clean-wt-session",
			});

			const taskMsg = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_clean_wt",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "clean worktree task",
			});

			await writeRoomMemberState(created.roomDir, {
				name: "worker_clean_wt",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-clean-wt-runtime",
				state: "running",
				spawnTaskId: null,
				currentTask: "clean worktree task",
				currentTaskMessageId: taskMsg.id,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: taskMsg.seq,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-clean-wt-session",
				worktree,
			});

			const proxy = new MutationProxyServer(created.roomDir);
			await proxy.start();
			setMemberActiveRoomContext(created, "worker-clean-wt-session", "worker_clean_wt");
			const client = createMutationClient(created.roomDir);
			await client.connect();
			setRoomMutationClient(created.roomDir, client);

			try {
				// No files written to worktree — clean state, so snapshot reuses HEAD
				const result = await executeCrewReply(
					{ seq: taskMsg.seq, summary: "Done (no changes)", kind: "completion" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "worker-clean-wt-session" } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);

				expect(result.isError).toBeUndefined();

				const commitsAfter = await countCommits(tempDir, worktree.branch);
				expect(commitsAfter).toBe(commitsBefore);
				expect(await git(["rev-parse", "--verify", worktree.branch], tempDir, 10_000)).toBe(seedOid);

				const member = await loadRoomMemberState(created.roomDir, "worker_clean_wt") as SnapshotMemberState;
				// Clean worktree: snapshotOid is current HEAD (no new commit created)
				expect(member.lastSnapshotOid).toBe(seedOid);
				expect(member.lastSnapshotTaskSeq).toBe(taskMsg.seq);
				// Journal cleared on successful owner handoff
				expect(member.pendingTerminalReply).toBeFalsy();
			} finally {
				client.disconnect();
				deleteRoomMutationClient(created.roomDir);
				clearActiveRoom("worker-clean-wt-session");
				await proxy.stop();
			}
		});
	});

	it("snapshot failure blocks the terminal reply and does not append a board entry", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-snap-fail",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			await writeRoomMemberState(created.roomDir, {
				name: "worker_snap_fail",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-snap-fail-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-snap-fail-session",
				// Non-existent path: persistWorktreeSnapshot returns { hasChanges: false }
				// with no commitOid, causing prepareTerminalReplySnapshot to throw.
				worktree: { path: path.join(tempDir, "ghost-worktree"), branch: "pi/worker_snap_fail/ghost" },
			});

			const taskMsg = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_snap_fail",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "snap fail task",
			});

			await writeRoomMemberState(created.roomDir, {
				name: "worker_snap_fail",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-snap-fail-runtime",
				state: "running",
				spawnTaskId: null,
				currentTask: "snap fail task",
				currentTaskMessageId: taskMsg.id,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: taskMsg.seq,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-snap-fail-session",
				worktree: { path: path.join(tempDir, "ghost-worktree"), branch: "pi/worker_snap_fail/ghost" },
			});

			setMemberActiveRoomContext(created, "worker-snap-fail-session", "worker_snap_fail");
			try {
				const result = await executeCrewReply(
					{ seq: taskMsg.seq, summary: "Done", kind: "completion" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "worker-snap-fail-session" } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);

				expect(result.isError).toBe(true);
				expect(result.content[0]?.text ?? "").toMatch(/Failed to persist a fixed worktree snapshot/i);

				// appendMessage was never reached — no board completion entry
				const entries = await listBoardEntries(created.roomDir, 20);
				expect(entries.filter((e) => e.replyTo === taskMsg.id && e.kind === "completion")).toHaveLength(0);
			} finally {
				clearActiveRoom("worker-snap-fail-session");
			}
		});
	});

	it("retry of terminal reply with git-backed worktree does not create a second snapshot commit and clears journal on success", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-git-retry",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			await writeRoomMemberState(created.roomDir, {
				name: "worker_git_retry",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-git-retry-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-git-retry-session",
			});
			await writeRoomMemberState(created.roomDir, {
				name: "reviewer_git_retry",
				displayName: "reviewer",
				type: "worker",
				backend: "pi",
				runtimeId: "reviewer-git-retry-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "reviewer-git-retry-session",
			});

			const upstream = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_git_retry",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "git retry task",
			});
			await appendMessage(created.roomDir, {
				from: "owner",
				to: "reviewer_git_retry",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "downstream git retry task",
				content: `Wait for {input:#${upstream.seq}} before starting.`,
			});

			const worktree = await createWorktree(
				"worker_git_retry",
				tempDir,
				"git-retry",
			);
			expect(worktree).toBeTruthy();
			if (!worktree) return;
			const commitsBefore = await countCommits(tempDir, worktree.branch);

			await writeRoomMemberState(created.roomDir, {
				name: "worker_git_retry",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-git-retry-runtime",
				state: "running",
				spawnTaskId: null,
				currentTask: "git retry task",
				currentTaskMessageId: upstream.id,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: upstream.seq,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-git-retry-session",
				worktree,
			});

			// Write output so a real snapshot commit is created on the first attempt
			await fs.writeFile(path.join(worktree.path, "result.txt"), "work output\n", "utf8");

			const proxy = new MutationProxyServer(created.roomDir);
			await proxy.start();
			setMemberActiveRoomContext(created, "worker-git-retry-session", "worker_git_retry");
			let client: ReturnType<typeof createMutationClient> | null = null;

			try {
				// First attempt: snapshot succeeds (creates commit) but owner handoff fails (no proxy client)
				const failedReply = await executeCrewReply(
					{ seq: upstream.seq, summary: "Done", kind: "completion" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "worker-git-retry-session" } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);
				expect(failedReply.isError).toBe(true);
				expect(failedReply.content[0]?.text ?? "").toMatch(/mutation proxy is unavailable/i);

				const firstMember = await loadRoomMemberState(created.roomDir, "worker_git_retry") as SnapshotMemberState;
				expect(firstMember.lastSnapshotOid).toMatch(/^[0-9a-f]{40}$/);
				expect(firstMember.pendingTerminalReply?.snapshotOid).toBe(firstMember.lastSnapshotOid);
				expect(firstMember.pendingTerminalReply?.handoffState).toBe("reply_appended");
				const snapshotOidAfterFirst = firstMember.lastSnapshotOid!;
				const commitsAfterFirst = await countCommits(tempDir, worktree.branch);
				// Verify the commit actually landed in the repo
				expect(await git(["rev-parse", "--verify", snapshotOidAfterFirst], tempDir, 10_000)).toBe(snapshotOidAfterFirst);
				expect(commitsAfterFirst).toBe(commitsBefore + 1);

				// Connect client so retry can succeed
				client = createMutationClient(created.roomDir);
				await client.connect();
				setRoomMutationClient(created.roomDir, client);

				const retriedReply = await executeCrewReply(
					{ seq: upstream.seq, summary: "Done", kind: "completion" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "worker-git-retry-session" } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);
				expect(retriedReply.isError).toBeUndefined();

				const retriedMember = await loadRoomMemberState(created.roomDir, "worker_git_retry") as SnapshotMemberState;
				// No second snapshot commit: OID is unchanged
				expect(retriedMember.lastSnapshotOid).toBe(snapshotOidAfterFirst);
				expect(await countCommits(tempDir, worktree.branch)).toBe(commitsAfterFirst);
				// Journal cleared on successful handoff
				expect(retriedMember.pendingTerminalReply).toBeFalsy();
				// Board has exactly one completion entry (not two)
				const entries = await listBoardEntries(created.roomDir, 20);
				expect(entries.filter((e) => e.replyTo === upstream.id && e.kind === "completion")).toHaveLength(1);
			} finally {
				client?.disconnect();
				deleteRoomMutationClient(created.roomDir);
				clearActiveRoom("worker-git-retry-session");
				await proxy.stop();
			}
		});
	});

	it("retry after reply append failure reuses the existing snapshot commit and clears the journal on success", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-append-retry",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			await writeRoomMemberState(created.roomDir, {
				name: "worker_append_retry",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-append-retry-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-append-retry-session",
			});

			const upstream = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_append_retry",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "append retry task",
			});

			const worktree = await createWorktree(
				"worker_append_retry",
				tempDir,
				"append-retry",
			);
			expect(worktree).toBeTruthy();
			if (!worktree) return;
			const commitsBefore = await countCommits(tempDir, worktree.branch);

			await writeRoomMemberState(created.roomDir, {
				name: "worker_append_retry",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-append-retry-runtime",
				state: "running",
				spawnTaskId: null,
				currentTask: "append retry task",
				currentTaskMessageId: upstream.id,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: upstream.seq,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-append-retry-session",
				worktree,
			});
			await fs.writeFile(path.join(worktree.path, "append-retry.txt"), "result\n", "utf8");

			const proxy = new MutationProxyServer(created.roomDir);
			await proxy.start();
			setMemberActiveRoomContext(created, "worker-append-retry-session", "worker_append_retry");
			const client = createMutationClient(created.roomDir);
			await client.connect();
			setRoomMutationClient(created.roomDir, client);

			const realAppendMessage = storageModule.appendMessage;
			const appendSpy = vi.spyOn(storageModule, "appendMessage").mockImplementation(async (...args) => {
				const [, message] = args as Parameters<typeof storageModule.appendMessage>;
				if (message.replyTo === upstream.id && message.kind === "completion") {
					throw new Error("append exploded");
				}
				return await realAppendMessage(...args as Parameters<typeof storageModule.appendMessage>);
			});

			try {
				const firstAttempt = executeCrewReply(
					{ seq: upstream.seq, summary: "Done", kind: "completion" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "worker-append-retry-session" } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);
				await expect(firstAttempt).rejects.toThrow(/append exploded/i);

				const failedMember = await loadRoomMemberState(created.roomDir, "worker_append_retry") as SnapshotMemberState;
				expect(failedMember.lastSnapshotOid).toMatch(/^[0-9a-f]{40}$/);
				expect(failedMember.pendingTerminalReply?.snapshotOid).toBe(failedMember.lastSnapshotOid);
				expect(failedMember.pendingTerminalReply?.handoffState).toBe("snapshot_done");
				const snapshotOidAfterFailure = failedMember.lastSnapshotOid!;
				const commitsAfterFailure = await countCommits(tempDir, worktree.branch);
				expect(commitsAfterFailure).toBe(commitsBefore + 1);

				appendSpy.mockRestore();

				const retryResult = await executeCrewReply(
					{ seq: upstream.seq, summary: "Done", kind: "completion" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "worker-append-retry-session" } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);

				expect(retryResult.isError).toBeUndefined();
				const retriedMember = await loadRoomMemberState(created.roomDir, "worker_append_retry") as SnapshotMemberState;
				expect(retriedMember.lastSnapshotOid).toBe(snapshotOidAfterFailure);
				expect(await countCommits(tempDir, worktree.branch)).toBe(commitsAfterFailure);
				expect(retriedMember.pendingTerminalReply).toBeFalsy();
				const entries = await listBoardEntries(created.roomDir, 20);
				expect(entries.filter((e) => e.replyTo === upstream.id && e.kind === "completion")).toHaveLength(1);
			} finally {
				appendSpy.mockRestore();
				client.disconnect();
				deleteRoomMutationClient(created.roomDir);
				clearActiveRoom("worker-append-retry-session");
				await proxy.stop();
			}
		});
	});

	it("non-terminal reply does not trigger snapshot or update pendingTerminalReply journal", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-nt-wt",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			const worktree = await createWorktree(
				"worker_nt_wt",
				tempDir,
				"nonterminal",
			);
			expect(worktree).toBeTruthy();
			if (!worktree) return;

			await writeRoomMemberState(created.roomDir, {
				name: "worker_nt_wt",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-nt-wt-runtime",
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-nt-wt-session",
			});

			const taskMsg = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_nt_wt",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "nonterminal task",
			});

			await writeRoomMemberState(created.roomDir, {
				name: "worker_nt_wt",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: "worker-nt-wt-runtime",
				state: "running",
				spawnTaskId: null,
				currentTask: "nonterminal task",
				currentTaskMessageId: taskMsg.id,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: taskMsg.seq,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: "worker-nt-wt-session",
				worktree,
			});
			await fs.writeFile(path.join(worktree.path, "progress.txt"), "still working\n", "utf8");
			const commitsBefore = await countCommits(tempDir, worktree.branch);

			setMemberActiveRoomContext(created, "worker-nt-wt-session", "worker_nt_wt");
			try {
				// progress is non-terminal: no snapshot, no dep notification, no proxy needed
				const result = await executeCrewReply(
					{ seq: taskMsg.seq, summary: "Making progress", kind: "progress" },
					{ sendMessage() { return undefined; } } as any,
					{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => "worker-nt-wt-session" } },
					runtimeRoot,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{},
				);

				expect(result.isError).toBeUndefined();

				const member = await loadRoomMemberState(created.roomDir, "worker_nt_wt") as SnapshotMemberState;
				const entries = await listBoardEntries(created.roomDir, 20);
				expect(entries.filter((e) => e.replyTo === taskMsg.id && e.kind === "progress")).toHaveLength(1);
				expect(await countCommits(tempDir, worktree.branch)).toBe(commitsBefore);
				expect(member.pendingTerminalReply).toBeFalsy();
				expect(member.lastSnapshotOid).toBeFalsy();
				expect(member.lastSnapshotTaskSeq).toBeFalsy();
				expect(member.lastSnapshotSummary).toBeFalsy();
				expect(member.lastSnapshotAt).toBeFalsy();
			} finally {
				clearActiveRoom("worker-nt-wt-session");
			}
		});
	});
});

// === heartbeat/mutation lock isolation tests ===

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function runMessageLoop(roomDir: string, intervalMs: number): { stop: () => void } {
	let stopped = false;
	(async () => {
		while (!stopped) {
			try {
				await appendMessage(roomDir, {
					from: "owner",
					to: "room",
					broadcast: false,
					replyTo: null,
					kind: "info",
					summary: `msg-${Date.now()}`,
				});
			} catch {
				// ignore append failures under load
			}
			await sleep(intervalMs);
		}
	})();
	return { stop: () => { stopped = true; } };
}

function runHeartbeatLoop(
	roomDir: string,
	memberName: string,
	intervalMs: number,
	onResult: (ok: boolean) => void,
): { stop: () => void } {
	let stopped = false;
	(async () => {
		while (!stopped) {
			try {
				await writeMemberHeartbeat(roomDir, memberName);
				onResult(true);
			} catch {
				onResult(false);
			}
			await sleep(intervalMs);
		}
	})();
	return { stop: () => { stopped = true; } };
}

async function createTestRoomWithOwner(tempDir: string): Promise<string> {
	const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
	const sessionId = "hb-e2e-" + Math.random().toString(36).slice(2);
	const created = await createRoom({
		runtimeRoot,
		ownerName: "owner",
		ownerSessionId: sessionId,
		cwd: tempDir,
		ownerPid: process.pid,
	});
	return created.roomDir;
}

async function createWorkerMember(roomDir: string, name: string): Promise<void> {
	await writeRoomMemberState(roomDir, {
		name,
		type: "worker",
		backend: "pi",
		runtimeId: String(process.pid),
		state: "idle",
		spawnTaskId: null,
		currentTask: null,
		currentTaskMessageId: null,
		lastCompletedTask: null,
		lastError: null,
		lastSeenSeq: 0,
		joinedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		sessionId: name + "-session",
	});
}

const hbAdapters = {
	pi: {
		kind: "pi",
		async spawn() { throw new Error("not used"); },
	} satisfies RoomSpawnAdapter,
	paseo: {
		kind: "paseo",
		async spawn() { throw new Error("not used"); },
	} satisfies RoomSpawnAdapter,
};

describe("heartbeat/mutation lock isolation", () => {
	let roomDir: string;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "room-hb-e2e-"));
		roomDir = await createTestRoomWithOwner(tempDir);
	});

	it("heartbeat 100% success under concurrent mutation lock load", { timeout: 30000 }, async () => {
		// Create 5 worker members
		for (let i = 0; i < 5; i++) {
			await createWorkerMember(roomDir, `w${i}`);
		}

		let hbFailures = 0;
		const hbResults: boolean[] = [];

		const msgLoop = runMessageLoop(roomDir, 50);
		const hbLoops = Array.from({ length: 5 }, (_, i) =>
			runHeartbeatLoop(roomDir, `w${i}`, 100, ok => {
				hbResults.push(ok);
				if (!ok) hbFailures++;
			}));

		await sleep(15000);
		msgLoop.stop();
		hbLoops.forEach(l => l.stop());

		// Allow pending async work to settle
		await sleep(200);

		expect(hbFailures).toBe(0);
		const successRate = hbResults.filter(Boolean).length / hbResults.length;
		expect(successRate).toBe(1.0);
	});

	it("members not reaped under high message throughput", { timeout: 30000 }, async () => {
		// Create 3 worker members with fresh heartbeats
		const names = ["w1", "w2", "w3"];
		for (const name of names) {
			await createWorkerMember(roomDir, name);
			await writeMemberHeartbeat(roomDir, name);
		}

		const msgLoop = runMessageLoop(roomDir, 20);
		// Also keep heartbeats fresh during the test
		const hbLoops = names.map(name =>
			runHeartbeatLoop(roomDir, name, 100, () => {}));

		for (let i = 0; i < 20; i++) {
			await reconcileMemberLiveness(roomDir, hbAdapters,
				{ memberHeartbeatStaleMs: 2000 });
			await sleep(500);
			for (const name of names) {
				const m = await loadRoomMemberState(roomDir, name).catch(() => null);
				expect(m?.state).not.toBe("error");
				expect(m?.state).not.toBe("removed");
			}
		}

		msgLoop.stop();
		hbLoops.forEach(l => l.stop());
	});
});

describe("paseo authority contract", () => {
	it("keeps fake paseo bootstrap in claimed mid-state until owner finalize runs", async () => {
		await withTempDir(async (tempDir) => {
			const fakeCliPath = await writeFakePaseoCli(path.join(tempDir, "fake-paseo-authority"));
			const previousCliPath = process.env.PI_ROOM_PASEO_CLI_PATH;
			process.env.PI_ROOM_PASEO_CLI_PATH = fakeCliPath;

			try {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session",
					cwd: tempDir,
				});
				await createSpawningMember(created.roomDir, {
					name: "fake-paseo-worker",
					type: "worker",
					backend: "paseo",
					taskId: "spawn-fake-paseo",
					bootstrapToken: "fake-paseo-token",
				});

				const bootstrap: RoomBootstrap = {
					version: 1,
					roomId: created.metadata.roomId,
					roomDir: created.roomDir,
					memberName: "fake-paseo-worker",
					memberType: "worker",
					ownerName: "owner",
					ownerSessionId: "owner-session",
					token: "fake-paseo-token",
					spawnTaskId: "spawn-fake-paseo",
				};

				const adapter = createPaseoPiMemberAdapter();
				await adapter.spawn({
					roomDir: created.roomDir,
					roomId: created.metadata.roomId,
					memberName: bootstrap.memberName,
					memberType: bootstrap.memberType,
					cwd: tempDir,
					systemPrompt: buildRoomBootstrapBlock(bootstrap),
				});
				const createAgentOptions = (globalThis as any).__roomPaseoCreateAgentOptions;
				assert.ok(createAgentOptions, "expected fake paseo createAgent to be called");

				await activateBootstrapRoom(
					{ sendMessage() { return undefined; } } as any,
					createAgentOptions.systemPrompt ?? "",
					"fake-paseo-session",
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
				);

				const member = await loadRoomMemberState(created.roomDir, "fake-paseo-worker");
				expect(member.backend).toBe("paseo");
				expect(member.runtimeId).toBeNull();
				expect(member.runtimeIdentitySource).toBe("member-pid");
				expect(member.state).toBe("spawning");
				expect(member.sessionId).toBe("fake-paseo-session");
				expect(member.spawnTaskId).toBe("spawn-fake-paseo");

				const job = await readSpawnJob(created.roomDir, "spawn-fake-paseo");
				expect(job?.state).toBe("claimed");
			} finally {
				resetActiveRoomsForTests();
				if (previousCliPath === undefined) delete process.env.PI_ROOM_PASEO_CLI_PATH;
				else process.env.PI_ROOM_PASEO_CLI_PATH = previousCliPath;
			}
		});
	});
});

// ─── Batch 3: deriveMergeReadiness helper ────────────────────────────────────

describe("deriveMergeReadiness helper", () => {
	it("returns false when member has no snapshot OID", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const member: RoomMemberState = {
				name: "w",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: null,
			};
			expect(await deriveMergeReadiness(member, tempDir)).toBe(false);
		});
	});

	it("returns false when lastSnapshotOid equals lastMergedOid", async () => {
		await withTempDir(async (tempDir) => {
			const oid = await initTestGitRepo(tempDir);
			const member: RoomMemberState = {
				name: "w",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: null,
				lastSnapshotOid: oid,
				lastMergedOid: oid,
			};
			expect(await deriveMergeReadiness(member, tempDir)).toBe(false);
		});
	});

	it("returns false when snapshot OID does not exist in git", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const fakeOid = "a".repeat(40);
			const member: RoomMemberState = {
				name: "w",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: null,
				lastSnapshotOid: fakeOid,
			};
			expect(await deriveMergeReadiness(member, tempDir)).toBe(false);
		});
	});

	it("returns true when a valid snapshot OID exists and has not been merged yet", async () => {
		await withTempDir(async (tempDir) => {
			const seedOid = await initTestGitRepo(tempDir);
			const member: RoomMemberState = {
				name: "w",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: null,
				lastSnapshotOid: seedOid,
				lastMergedOid: null,
			};
			expect(await deriveMergeReadiness(member, tempDir)).toBe(true);
		});
	});

	it("uses pendingTerminalReply.snapshotOid when comparing against lastMergedOid", async () => {
		await withTempDir(async (tempDir) => {
			const seedOid = await initTestGitRepo(tempDir);
			// pendingTerminalReply.snapshotOid === lastMergedOid → not ready even if lastSnapshotOid differs
			const member: RoomMemberState = {
				name: "w",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: null,
				lastSnapshotOid: "old-oid-does-not-matter",
				lastMergedOid: seedOid,
				pendingTerminalReply: {
					taskSeq: 1,
					kind: "completion",
					snapshotOid: seedOid,
					replyMessageId: null,
					handoffState: "snapshot_done",
				},
			};
			// pendingTerminalReply.snapshotOid === lastMergedOid → false
			expect(await deriveMergeReadiness(member, tempDir)).toBe(false);
		});
	});
});

// ─── Batch 3: crew_who snapshot visibility ────────────────────────────────────

describe("crew_who - snapshot metadata and mergeReady visibility", () => {
	it("exposes lastSnapshotAt, lastSnapshotSummary, mergeReady, and lastMergedOid for a member with a snapshot", async () => {
		await withTempDir(async (tempDir) => {
			const seedOid = await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-who-snap-b3",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-who-snap-b3");

			const snapshotAt = new Date().toISOString();
			await writeRoomMemberState(created.roomDir, {
				name: "worker_1234",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: snapshotAt,
				updatedAt: snapshotAt,
				sessionId: null,
				lastSnapshotOid: seedOid,
				lastSnapshotAt: snapshotAt,
				lastSnapshotSummary: "did some work",
				lastMergedOid: null,
			});

			const members = await collectCrewWhoEntries(created.roomDir, tempDir);
			const worker = members.find((m) => m.name === "worker_1234");
			expect(worker?.lastSnapshotAt).toBeTruthy();
			expect(worker?.lastSnapshotSummary).toBe("did some work");
			expect(worker?.mergeReady).toBe(true);
			expect(worker?.lastMergedOid).toBeNull();
		});
	});

	it("reports mergeReady false when lastSnapshotOid equals lastMergedOid", async () => {
		await withTempDir(async (tempDir) => {
			const seedOid = await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-who-merged-b3",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setOwnerActiveRoomContext(created, "owner-who-merged-b3");

			await writeRoomMemberState(created.roomDir, {
				name: "worker_5678",
				displayName: "worker",
				type: "worker",
				backend: "pi",
				runtimeId: null,
				state: "idle",
				spawnTaskId: null,
				currentTask: null,
				currentTaskMessageId: null,
				lastCompletedTask: null,
				lastError: null,
				lastSeenSeq: 0,
				joinedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sessionId: null,
				lastSnapshotOid: seedOid,
				lastMergedOid: seedOid,
			});

			const members = await collectCrewWhoEntries(created.roomDir, tempDir);
			const worker = members.find((m) => m.name === "worker_5678");
			expect(worker?.mergeReady).toBe(false);
		});
	});
});

// ─── Batch 3: crew_merge state gates and snapshot-based merging ───────────────

describe("crew_merge batch3 - state gates and snapshot-based merging", () => {
	function makeMergeCtx(tempDir: string, sessionId: string) {
		return { cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } };
	}
	function makeMergeAdapters() {
		return {
			pi: { kind: "pi", async spawn() { throw new Error("not used"); } } as any,
			paseo: { kind: "paseo", async spawn() { throw new Error("not used"); } } as any,
		};
	}

	it("rejects merge when member state is running", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({ runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-gate-running", cwd: tempDir, ownerPid: process.pid });
			setOwnerActiveRoomContext(created, "owner-merge-gate-running");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "running",
					spawnTaskId: null,
					currentTask: "some task",
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					lastSnapshotOid: "a".repeat(40),
				});
				const result = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-gate-running"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);
				expect(result.isError).toBe(true);
				expect(result.content[0]?.text).toMatch(/running/i);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("rejects merge when member state is spawning or stopping", async () => {
		for (const state of ["spawning", "stopping"] as const) {
			await withTempDir(async (tempDir) => {
				const sessionId = `owner-merge-gate-${state}`;
				const runtimeRoot = path.join(tempDir, "r");
				const created = await createRoom({ runtimeRoot, ownerName: "owner", ownerSessionId: sessionId, cwd: tempDir, ownerPid: process.pid });
				setOwnerActiveRoomContext(created, sessionId);
				try {
					await writeRoomMemberState(created.roomDir, {
						name: "worker_1234",
						displayName: "worker",
						type: "worker",
						backend: "pi",
						runtimeId: null,
						state,
						spawnTaskId: null,
						currentTask: null,
						currentTaskMessageId: null,
						lastCompletedTask: null,
						lastError: null,
						lastSeenSeq: 0,
						joinedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						sessionId: null,
					});
					const result = await executeCrewMerge(
						{ name: "worker" },
						{ sendMessage() { return undefined; } } as any,
						makeMergeCtx(tempDir, sessionId),
						runtimeRoot,
						makeMergeAdapters(),
						{ ownerName: "owner" },
					);
					expect(result.isError).toBe(true);
					expect(result.content[0]?.text).toMatch(new RegExp(state, "i"));
				} finally {
					resetActiveRoomsForTests();
				}
			});
		}
	});

	it("allows merge when chatBusy is true as long as state is idle and snapshot exists", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({ runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-gate-busy", cwd: tempDir, ownerPid: process.pid });
			const worktree = await createWorktree("worker_chatbusy", tempDir, "b3-chatbusy");
			if (!worktree) throw new Error("Failed to create worktree");
			await fs.writeFile(path.join(worktree.path, "work.txt"), "done\n", "utf8");
			const snapshot = await persistWorktreeSnapshot(worktree.path, { commitMessage: "chatbusy snap" });
			const snapshotOid = snapshot.commitOid!;
			expect(snapshotOid).toBeTruthy();

			setOwnerActiveRoomContext(created, "owner-merge-gate-busy");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					chatBusy: true,
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					worktree,
					lastSnapshotOid: snapshotOid,
				});
				const result = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-gate-busy"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);
				expect(result.isError).toBeUndefined();
				expect(result.content[0]?.text).toContain(snapshotOid.slice(0, 12));
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("merges using lastSnapshotOid (not worktreeResult.branch) and updates lastMergedOid", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-snap-oid", cwd: tempDir, ownerPid: process.pid,
			});

			// Create a worktree and make a commit in it
			const worktree = await createWorktree("worker_snap_oid", tempDir, "b3-snap-oid");
			if (!worktree) throw new Error("Failed to create worktree");
			await fs.writeFile(path.join(worktree.path, "work.txt"), "done\n", "utf8");
			const snapshot = await persistWorktreeSnapshot(worktree.path, { commitMessage: "b3 snap" });
			const snapshotOid = snapshot.commitOid!;
			expect(snapshotOid).toBeTruthy();

			setOwnerActiveRoomContext(created, "owner-merge-snap-oid");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					worktree,
					lastSnapshotOid: snapshotOid,
					lastMergedOid: null,
					// no worktreeResult — only snapshot OID path
				});

				const result = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-snap-oid"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(result.isError).toBeUndefined();
				expect(result.content[0]?.text).toContain(snapshotOid.slice(0, 12));
				expect(result.content[0]?.text).toContain(`strategy: merge`);
				expect(result.content[0]?.text).toContain(`branch: ${worktree.branch}`);
				expect(result.content[0]?.text).toMatch(/merge commit: [0-9a-f]{12}/i);
				expect(result.content[0]?.text).toContain("branch retained");
				// Snapshot is now an ancestor of HEAD
				await git(["merge-base", "--is-ancestor", snapshotOid, "HEAD"], tempDir, 10_000);
				// lastMergedOid updated
				const updated = await loadRoomMemberState(created.roomDir, "worker_1234");
				expect(updated.lastMergedOid).toBe(snapshotOid);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("uses pendingTerminalReply.snapshotOid over lastSnapshotOid as merge target", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-pending-oid", cwd: tempDir, ownerPid: process.pid,
			});

			// Create two commits on the worktree branch
			const worktree = await createWorktree("worker_pending_oid", tempDir, "b3-pending");
			if (!worktree) throw new Error("Failed to create worktree");
			await fs.writeFile(path.join(worktree.path, "work1.txt"), "first\n", "utf8");
			const snap1 = await persistWorktreeSnapshot(worktree.path, { commitMessage: "first snap" });
			const oid1 = snap1.commitOid!;

			await fs.writeFile(path.join(worktree.path, "work2.txt"), "second\n", "utf8");
			const snap2 = await persistWorktreeSnapshot(worktree.path, { commitMessage: "second snap" });
			const oid2 = snap2.commitOid!;

			setOwnerActiveRoomContext(created, "owner-merge-pending-oid");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					worktree,
					lastSnapshotOid: oid1,       // older
					lastMergedOid: null,
					pendingTerminalReply: {       // newer pending
						taskSeq: 5,
						kind: "completion",
						snapshotOid: oid2,
						replyMessageId: null,
						handoffState: "snapshot_done",
					},
				});

				const result = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-pending-oid"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(result.isError).toBeUndefined();
				// oid2 (pendingTerminalReply.snapshotOid) is ancestor of HEAD
				await git(["merge-base", "--is-ancestor", oid2, "HEAD"], tempDir, 10_000);
				// lastMergedOid set to pendingTerminalReply.snapshotOid
				const updated = await loadRoomMemberState(created.roomDir, "worker_1234");
				expect(updated.lastMergedOid).toBe(oid2);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("repairs state and returns already-merged result when snapshot is already ancestor of HEAD", async () => {
		await withTempDir(async (tempDir) => {
			const seedOid = await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-repair", cwd: tempDir, ownerPid: process.pid,
			});

			setOwnerActiveRoomContext(created, "owner-merge-repair");
			try {
				// seedOid is already HEAD, so it's already an ancestor
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					lastSnapshotOid: seedOid,
					lastMergedOid: null, // not yet recorded, even though already in history
				});

				const result = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-repair"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(result.isError).toBeUndefined();
				expect(result.content[0]?.text).toMatch(/already|repaired|ancestor/i);
				// State repair: lastMergedOid should now be set
				const updated = await loadRoomMemberState(created.roomDir, "worker_1234");
				expect(updated.lastMergedOid).toBe(seedOid);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("preserves branch by default when deleteBranchAfterMerge is not specified", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-keep-branch", cwd: tempDir, ownerPid: process.pid,
			});

			const worktree = await createWorktree("worker_keep_br", tempDir, "b3-keep-br");
			if (!worktree) throw new Error("Failed to create worktree");
			await fs.writeFile(path.join(worktree.path, "keep.txt"), "keep\n", "utf8");
			const snapshot = await persistWorktreeSnapshot(worktree.path, { commitMessage: "keep branch snap" });
			const snapshotOid = snapshot.commitOid!;

			setOwnerActiveRoomContext(created, "owner-merge-keep-branch");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					worktree,
					lastSnapshotOid: snapshotOid,
					lastMergedOid: null,
				});

				// No deleteBranchAfterMerge param → defaults to false
				const result = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-keep-branch"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(result.isError).toBeUndefined();
				// Branch must still exist
				const branchExists = await git(["show-ref", "--verify", `refs/heads/${worktree.branch}`], tempDir, 5_000)
					.then(() => true).catch(() => false);
				expect(branchExists).toBe(true);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("reports deferred branch deletion when deleteBranchAfterMerge is true but the worktree still has the branch checked out", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-deferred-branch-delete", cwd: tempDir, ownerPid: process.pid,
			});

			const worktree = await createWorktree("worker_defer_br", tempDir, "b3-defer-br");
			if (!worktree) throw new Error("Failed to create worktree");
			await fs.writeFile(path.join(worktree.path, "defer.txt"), "defer\n", "utf8");
			const snapshot = await persistWorktreeSnapshot(worktree.path, { commitMessage: "defer branch delete snap" });
			const snapshotOid = snapshot.commitOid!;

			setOwnerActiveRoomContext(created, "owner-merge-deferred-branch-delete");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					worktree,
					lastSnapshotOid: snapshotOid,
					lastMergedOid: null,
				});

				const result = await executeCrewMerge(
					{ name: "worker", deleteBranchAfterMerge: true },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-deferred-branch-delete"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(result.isError).toBeUndefined();
				expect(result.content[0]?.text).toContain(`branch: ${worktree.branch}`);
				expect(result.content[0]?.text).toContain("branch deletion deferred (worktree still active)");
				const branchExists = await git(["show-ref", "--verify", `refs/heads/${worktree.branch}`], tempDir, 5_000)
					.then(() => true).catch(() => false);
				expect(branchExists).toBe(true);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("deletes the archived branch when deleteBranchAfterMerge is true", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-delete-branch", cwd: tempDir, ownerPid: process.pid,
			});

			const worktree = await createWorktree("worker_delete_br", tempDir, "b3-delete-br");
			if (!worktree) throw new Error("Failed to create worktree");
			await fs.writeFile(path.join(worktree.path, "delete.txt"), "delete\n", "utf8");
			const snapshot = await persistWorktreeSnapshot(worktree.path, { commitMessage: "delete branch snap" });
			const archivedSnapshotOid = snapshot.commitOid!;
			await git(["worktree", "remove", "--force", worktree.path], tempDir, 10_000);

			setOwnerActiveRoomContext(created, "owner-merge-delete-branch");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					worktreeResult: { hasChanges: true, branch: worktree.branch, snapshotOid: archivedSnapshotOid },
					lastMergedOid: null,
				});

				const result = await executeCrewMerge(
					{ name: "worker", deleteBranchAfterMerge: true },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-delete-branch"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(result.isError).toBeUndefined();
				expect(result.content[0]?.text).toContain(`branch: ${worktree.branch}`);
				expect(result.content[0]?.text).toContain("branch deleted");
				const branchExists = await git(["show-ref", "--verify", `refs/heads/${worktree.branch}`], tempDir, 5_000)
					.then(() => true).catch(() => false);
				expect(branchExists).toBe(false);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("returns merge conflict information when snapshot merge has conflicts", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-conflict", cwd: tempDir, ownerPid: process.pid,
			});

			// Create a conflicting commit on the worktree branch
			const worktree = await createWorktree("worker_conflict", tempDir, "b3-conflict");
			if (!worktree) throw new Error("Failed to create worktree");
			// Write to README.md in the worktree (same file as main)
			await fs.writeFile(path.join(worktree.path, "README.md"), "worktree version\n", "utf8");
			const snapshot = await persistWorktreeSnapshot(worktree.path, { commitMessage: "conflict snap" });
			const snapshotOid = snapshot.commitOid!;

			// Also create a diverging commit on main branch (conflict setup)
			await fs.writeFile(path.join(tempDir, "README.md"), "main version\n", "utf8");
			await git(["add", "README.md"], tempDir, 5_000);
			await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "diverge main"], tempDir, 10_000);

			setOwnerActiveRoomContext(created, "owner-merge-conflict");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					worktree,
					lastSnapshotOid: snapshotOid,
					lastMergedOid: null,
				});

				const result = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-conflict"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(result.isError).toBe(true);
				expect(result.content[0]?.text).toMatch(/conflict/i);
				// Abort the merge so cleanup works
				await git(["merge", "--abort"], tempDir, 5_000).catch(() => {});
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	// ── Gap 1: archived fallback uses fixed OID ──────────────────────────────

	it("returns clear no-merge-target error when archived branch is gone and no snapshot OID is recorded", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-archived-gone", cwd: tempDir, ownerPid: process.pid,
			});

			setOwnerActiveRoomContext(created, "owner-merge-archived-gone");
			try {
				// Archived state: worktreeResult.branch points to a non-existent branch, no snapshot OID
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					worktreeResult: { hasChanges: true, branch: "deleted-branch-gone" },
					lastMergedOid: null,
				});

				const result = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-archived-gone"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				// Must return a clear "no merge target" error, not a confusing git merge failure
				expect(result.isError).toBe(true);
				expect(result.content[0]?.text).toMatch(/no merge target/i);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("rejects archived branch-only state when no snapshot OID is recorded", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-archived-branch-only", cwd: tempDir, ownerPid: process.pid,
			});

			const worktree = await createWorktree("worker_archived_branch", tempDir, "b3-archived-branch-only");
			if (!worktree) throw new Error("Failed to create worktree");
			await fs.writeFile(path.join(worktree.path, "archived-branch-only.txt"), "archived work\n", "utf8");
			await persistWorktreeSnapshot(worktree.path, { commitMessage: "archived branch-only snap" });

			setOwnerActiveRoomContext(created, "owner-merge-archived-branch-only");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					worktreeResult: { hasChanges: true, branch: worktree.branch },
					lastMergedOid: null,
				});

				const result = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-archived-branch-only"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(result.isError).toBe(true);
				expect(result.content[0]?.text).toMatch(/no merge target|no mergeable snapshot/i);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("uses archived snapshotOid when no active snapshot OID is recorded", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-archived-oid", cwd: tempDir, ownerPid: process.pid,
			});

			// Create a worktree and commit work on it
			const worktree = await createWorktree("worker_archived", tempDir, "b3-archived");
			if (!worktree) throw new Error("Failed to create worktree");
			await fs.writeFile(path.join(worktree.path, "archived.txt"), "archived work\n", "utf8");
			const snapshot = await persistWorktreeSnapshot(worktree.path, { commitMessage: "archived snap" });
			const archivedSnapshotOid = snapshot.commitOid!;
			expect(archivedSnapshotOid).toBeTruthy();

			setOwnerActiveRoomContext(created, "owner-merge-archived-oid");
			try {
				// Archived state: no active snapshot, only archived cleanup metadata.
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					worktreeResult: { hasChanges: true, branch: worktree.branch, snapshotOid: archivedSnapshotOid },
					lastMergedOid: null,
				});

				const result = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-archived-oid"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(result.isError).toBeUndefined();
				const updated = await loadRoomMemberState(created.roomDir, "worker_1234");
				expect(updated.lastMergedOid).toBe(archivedSnapshotOid);
				expect(updated.lastMergedOid).toMatch(/^[0-9a-f]{40}$/);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("keeps the terminal snapshot mergeable after crew_remove cleanup archives fallback work", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-after-remove", cwd: tempDir, ownerPid: process.pid,
			});

			const worktree = await createWorktree("worker_removed", tempDir, "b4-remove-merge");
			if (!worktree) throw new Error("Failed to create worktree");
			await fs.writeFile(path.join(worktree.path, "terminal.txt"), "terminal snapshot\n", "utf8");
			const terminalSnapshot = await persistWorktreeSnapshot(worktree.path, { commitMessage: "terminal snapshot" });
			const terminalSnapshotOid = terminalSnapshot.commitOid!;
			await fs.writeFile(path.join(worktree.path, "cleanup-only.txt"), "cleanup fallback\n", "utf8");

			setOwnerActiveRoomContext(created, "owner-merge-after-remove");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					worktree,
					lastSnapshotOid: terminalSnapshotOid,
					lastMergedOid: null,
				});

				const removeResult = await executeCrewRemove(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-after-remove"),
					runtimeRoot,
					{
						pi: { kind: "pi", async spawn() { throw new Error("not used"); } } as any,
						paseo: { kind: "paseo", async spawn() { throw new Error("not used"); } } as any,
					},
					{ ownerName: "owner" },
				);
				expect(removeResult.isError).toBeUndefined();

				const removedMember = await loadRoomMemberState(created.roomDir, "worker_1234");
				expect(removedMember.state).toBe("removed");
				expect(removedMember.worktree).toBeNull();
				expect(removedMember.lastSnapshotOid).toBe(terminalSnapshotOid);
				expect(removedMember.worktreeResult?.snapshotOid).toMatch(/^[0-9a-f]{40}$/);
				expect(removedMember.worktreeResult?.snapshotOid).not.toBe(terminalSnapshotOid);

				const mergeResult = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-after-remove"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(mergeResult.isError).toBeUndefined();
				expect(mergeResult.content[0]?.text).toContain(terminalSnapshotOid.slice(0, 12));
				const mergedMember = await loadRoomMemberState(created.roomDir, "worker_1234");
				expect(mergedMember.lastMergedOid).toBe(terminalSnapshotOid);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("keeps the terminal snapshot as the default merge target after watchdog cleanup archives fallback work", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-after-watchdog", cwd: tempDir, ownerPid: process.pid,
			});

			const worktree = await createWorktree("worker_watchdog", tempDir, "b4-watchdog-merge");
			if (!worktree) throw new Error("Failed to create worktree");
			await fs.writeFile(path.join(worktree.path, "terminal-watchdog.txt"), "terminal snapshot\n", "utf8");
			const terminalSnapshot = await persistWorktreeSnapshot(worktree.path, { commitMessage: "watchdog terminal snapshot" });
			const terminalSnapshotOid = terminalSnapshot.commitOid!;
			await fs.writeFile(path.join(worktree.path, "cleanup-watchdog.txt"), "cleanup fallback\n", "utf8");

			setOwnerActiveRoomContext(created, "owner-merge-after-watchdog");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					heartbeatAt: new Date(Date.now() - 12_000).toISOString(),
					worktree,
					lastSnapshotOid: terminalSnapshotOid,
					lastMergedOid: null,
				});

				await reconcileMemberLiveness(
					created.roomDir,
					{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
					{ memberHeartbeatStaleMs: 1000 },
				);

				const watchedMember = await loadRoomMemberState(created.roomDir, "worker_1234");
				expect(watchedMember.state).toBe("error");
				expect(watchedMember.worktree).toBeNull();
				expect(watchedMember.lastSnapshotOid).toBe(terminalSnapshotOid);
				expect(watchedMember.worktreeResult?.snapshotOid).toMatch(/^[0-9a-f]{40}$/);
				expect(watchedMember.worktreeResult?.snapshotOid).not.toBe(terminalSnapshotOid);

				const mergeResult = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-after-watchdog"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(mergeResult.isError).toBeUndefined();
				expect(mergeResult.content[0]?.text).toContain(terminalSnapshotOid.slice(0, 12));
				const mergedMember = await loadRoomMemberState(created.roomDir, "worker_1234");
				expect(mergedMember.lastMergedOid).toBe(terminalSnapshotOid);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("rejects merge for an active member without a fixed snapshot OID", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-active-no-snapshot", cwd: tempDir, ownerPid: process.pid,
			});

			const worktree = await createWorktree("worker_no_snapshot", tempDir, "b3-no-snapshot");
			if (!worktree) throw new Error("Failed to create worktree");

			setOwnerActiveRoomContext(created, "owner-merge-active-no-snapshot");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					worktree,
					lastMergedOid: null,
				});

				const result = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-active-no-snapshot"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(result.isError).toBe(true);
				expect(result.content[0]?.text).toMatch(/no merge target|no snapshot/i);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	// ── Gap 2: readiness gating ───────────────────────────────────────────────

	it("rejects merge when snapshotOid matches lastMergedOid (already merged, no unmerged snapshot)", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-readiness-already-merged", cwd: tempDir, ownerPid: process.pid,
			});

			const worktree = await createWorktree("worker_already_merged", tempDir, "b3-already");
			if (!worktree) throw new Error("Failed to create worktree");
			await fs.writeFile(path.join(worktree.path, "done.txt"), "done\n", "utf8");
			const snapshot = await persistWorktreeSnapshot(worktree.path, { commitMessage: "snap" });
			const snapshotOid = snapshot.commitOid!;

			setOwnerActiveRoomContext(created, "owner-merge-readiness-already-merged");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					lastSnapshotOid: snapshotOid,
					lastMergedOid: snapshotOid, // already merged
				});

				const result = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-readiness-already-merged"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(result.isError).toBe(true);
				expect(result.content[0]?.text).toMatch(/already merged|no unmerged/i);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});

	it("rejects merge when snapshotOid does not exist in the repository", async () => {
		await withTempDir(async (tempDir) => {
			await initTestGitRepo(tempDir);
			const runtimeRoot = path.join(tempDir, "r");
			const created = await createRoom({
				runtimeRoot, ownerName: "owner", ownerSessionId: "owner-merge-readiness-no-commit", cwd: tempDir, ownerPid: process.pid,
			});

			setOwnerActiveRoomContext(created, "owner-merge-readiness-no-commit");
			try {
				await writeRoomMemberState(created.roomDir, {
					name: "worker_1234",
					displayName: "worker",
					type: "worker",
					backend: "pi",
					runtimeId: null,
					state: "idle",
					spawnTaskId: null,
					currentTask: null,
					currentTaskMessageId: null,
					lastCompletedTask: null,
					lastError: null,
					lastSeenSeq: 0,
					joinedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sessionId: null,
					lastSnapshotOid: "deadbeef".repeat(5), // fake OID not in repo
					lastMergedOid: null,
				});

				const result = await executeCrewMerge(
					{ name: "worker" },
					{ sendMessage() { return undefined; } } as any,
					makeMergeCtx(tempDir, "owner-merge-readiness-no-commit"),
					runtimeRoot,
					makeMergeAdapters(),
					{ ownerName: "owner" },
				);

				expect(result.isError).toBe(true);
				expect(result.content[0]?.text).toMatch(/no unmerged|not available/i);
			} finally {
				resetActiveRoomsForTests();
			}
		});
	});
});
