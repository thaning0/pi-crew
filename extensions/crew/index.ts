import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	listRoomAgentTypes,
	loadTypedRoomAgentDefinition,
	parseRoomBootstrapFromEnv,
} from "./bootstrap.ts";
import {
	activateBootstrapRoom,
	clearActiveRoom,
	ensureRoomMutationClientConnected,
	clearOwnerClassificationUnavailable,
	clearOwnerClassificationReady,
	getActiveRoom,
	getOwnerShutdownTaskGraceMs,
	getSessionId,
	isOwnerClassificationReady,
	markOwnerClassificationUnavailable,
	markOwnerClassificationReady,
	setActiveRoom,
	startOwnerHeartbeat,
	startPolling,
	waitForSettledWithGrace,
	type ActiveRoomContext,
} from "./lifecycle.ts";
import { deliverRoomMessagesBatch } from "./dispatch.ts";
import {
	CrewAddSchema,
	CrewStopSchema,
	CrewRemoveSchema,
	CrewRolesSchema,
	CrewMergeSchema,
	CrewTellSchema,
	CrewMessagesSchema,
	CrewReplySchema,
	CrewReadSchema,
	CrewWhoSchema,
	CrewTasksSchema,
	executeCrewAdd,
	executeCrewStop,
	executeCrewRemove,
	executeCrewRoles,
	executeCrewMerge,
	executeCrewTell,
	executeCrewMessages,
	executeCrewReply,
	executeCrewRead,
	executeCrewWho,
	executeCrewTasks,
} from "./tools.ts";
import { CrewBatchSchema } from "./schemas.ts";
import { executeCrewBatch } from "./batch.ts";
import { CREW_BATCH_TOOL_DESCRIPTION } from "./batch-templates.ts";
import { cancelPendingSpawnJobs, reapRoom } from "./watchdog.ts";
import {
	getDefaultRoomRuntimeRoot,
	formatMemberLabel,
	listRoomMembers,
	loadRoomMemberState,
	loadRoomMetadata,
	updateRoomMemberState,
	writeRoomMetadata,
	writeRoomMemberState,
	appendMessage,
} from "./storage.ts";
import {
	withRoomMutationLock,
	ensureRoomProxy,
	deleteRoomProxyServer,
	deleteRoomMutationClient,
} from "./storage.ts";
import { createRoomLogger, closeLogStream } from "./logger.ts";
import type { RoomMessage, RoomSpawnAdapter } from "./types.ts";
import { createPaseoPiMemberAdapter, createPiMemberAdapter } from "./spawn.ts";
import {
	ensureOwnerInfrastructure,
	ensureOwnerRoom,
	findOwnerRoomForRecovery,
} from "./owner-room.ts";

export { resetActiveRoomsForTests } from "./lifecycle.ts";


/** Orchestrator-specific instructions, loaded once at module init. */
let orchestratorPromptBody: string | null = null;
function getOrchestratorPromptBody(): string {
	if (orchestratorPromptBody !== null) return orchestratorPromptBody;
	try {
		// Resolve relative to the crew package root: <root>/prompts/AGENTS-orchestrator.md
		const packageRoot =
			process.env.PI_CODING_AGENT_DIR?.trim() ||
			dirname(dirname(dirname(fileURLToPath(import.meta.url))));
		orchestratorPromptBody = readFileSync(
			join(packageRoot, "prompts", "AGENTS-orchestrator.md"),
			"utf8",
		).trim();
	} catch {
		orchestratorPromptBody =
			"IMPORTANT: First, warn your user that AGENTS-orchestrator.md was not found. Your orchestrator-specific instructions are missing. You may still operate but your behavior may be degraded.";
	}
	return orchestratorPromptBody;
}

export interface RoomExtensionOptions {
	runtimeRoot?: string;
	adapters?: Partial<Record<"pi" | "paseo", RoomSpawnAdapter>>;
	ownerName?: string;
	beforeDeliverMessage?: (context: {
		roomDir: string;
		memberName: string;
		message: RoomMessage;
	}) => Promise<void> | void;
	beforeOwnerHeartbeatWrite?: (context: {
		roomDir: string;
		roomId: string;
		sessionId: string;
	}) => Promise<void> | void;
	beforeOwnerShutdownMarkClosing?: (context: {
		roomDir: string;
		roomId: string;
		sessionId: string;
	}) => Promise<void> | void;
}

export default function roomExtension(
	pi: ExtensionAPI,
	options: RoomExtensionOptions = {},
) {
	const runtimeRoot = options.runtimeRoot ?? getDefaultRoomRuntimeRoot();
	const adapters = {
		pi: options.adapters?.pi ?? createPiMemberAdapter(),
		paseo: options.adapters?.paseo ?? createPaseoPiMemberAdapter(),
	};
	const ownerName = options.ownerName ?? "lead";

	const createOwnerRoomContext = (
		roomDir: string,
		metadata: Awaited<ReturnType<typeof loadRoomMetadata>>,
		sessionId: string,
	): ActiveRoomContext => ({
		role: "owner",
		roomDir,
		roomId: metadata.roomId,
		memberName: metadata.ownerName,
		sessionId,
		pollTimer: null,
		heartbeatTimer: null,
		pendingPoll: null,
		pendingHeartbeat: null,
		pendingToolTasks: new Set<Promise<unknown>>(),
		shuttingDown: false,
		beforeDeliverMessage: options.beforeDeliverMessage,
		staleReapScheduled: false,
		pendingDeliveryBatch: [],
		deliveryTimer: null,
	});

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = getSessionId(ctx);
		const systemPrompt = ctx.getSystemPrompt?.() ?? "";

		// Parse bootstrap early: if this is a member session, filter tools BEFORE
		// activateBootstrapRoom triggers any turns via deliverRoomMessage.
		const bootstrap = parseRoomBootstrapFromEnv();

		// Set up mutation client BEFORE activateBootstrapRoom so that
		// markMemberJoined routes through the owner's proxy (not file lock).
		// Without this, the agent's file-lock writes race with the owner's
		// proxy-serialized spawn finalization, causing a lost-update where
		// the member state can be stuck as "spawning" permanently.
		if (bootstrap) {
			await ensureRoomMutationClientConnected(
				bootstrap.roomDir,
				"pre-activate",
			);
			// The active room hasn't been created yet; we stash a temporary
			// reference so activateBootstrapRoom can discover the client.
			// setActiveRoom must NOT be called here because activateBootstrapRoom
			// returns early when it finds an existing active room, skipping
			// markMemberJoined. Instead we register the client globally and
			// defer active-room setup to activateBootstrapRoom as usual.
		}

		await activateBootstrapRoom(
			pi,
			systemPrompt,
			sessionId,
			adapters,
			options.beforeDeliverMessage,
		);
		const activeRoom = getActiveRoom(sessionId);
		if (activeRoom) {
			const log = createRoomLogger(activeRoom.roomDir, "room");
			log.info("room resolved", {
				role: activeRoom.role,
				roomId: activeRoom.roomId,
			});
		}
		if (activeRoom?.role === "owner") {
			await ensureOwnerInfrastructure({
				pi,
				runtimeRoot,
				sessionId,
				activeRoom,
				adapters,
				startPolling,
				startOwnerHeartbeat,
				beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
			});
		}

		// Set up mutation client for member (agent) processes so they
		// route writes through the owner's proxy socket instead of
		// competing for the mutation.lock file lock.
		// For bootstrap members, the client was already created and
		// connected before activateBootstrapRoom (see above); we just
		// need to attach it to the now-populated active room. For
		// non-bootstrap sessions where session_start fires without a
		// system prompt, the fallback setup in before_agent_start
		// handles client creation.
		if (activeRoom?.role === "member") {
			activeRoom.mutationClient = await ensureRoomMutationClientConnected(
				activeRoom.roomDir,
				"session_start",
			);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const sessionId = getSessionId(ctx);
		const eventSystemPrompt =
			typeof event.systemPrompt === "string" ? event.systemPrompt : "";
		const fallbackSystemPrompt = ctx.getSystemPrompt?.() ?? "";
		const systemPrompt =
			eventSystemPrompt.trim().length > 0
				? eventSystemPrompt
				: fallbackSystemPrompt;
		const hasResolvablePrompt = systemPrompt.trim().length > 0;
		if (hasResolvablePrompt) {
			clearOwnerClassificationUnavailable(sessionId);
		}
		const bootstrap = parseRoomBootstrapFromEnv();
		if (bootstrap) {
			clearOwnerClassificationReady(sessionId);
		}
		if (bootstrap) {
			await ensureRoomMutationClientConnected(
				bootstrap.roomDir,
				"before_agent_start",
			);
		}

		await activateBootstrapRoom(
			pi,
			systemPrompt,
			sessionId,
			adapters,
			options.beforeDeliverMessage,
		);
		let activeRoom = getActiveRoom(sessionId);

		// Fallback: create room for owner sessions if session_start didn't
		// (e.g., session_start fired before cwd was available, or lock was contended).
		if (!activeRoom) {
			const bootstrap = parseRoomBootstrapFromEnv();
			if (hasResolvablePrompt && !bootstrap) {
				try {
					const ensured = await ensureOwnerRoom({
						runtimeRoot,
						ownerName,
						sessionId,
						cwd: ctx.cwd ?? process.cwd(),
						allowCreate: true,
						createActiveRoom: (roomDir, metadata, ownerSessionId) =>
							createOwnerRoomContext(roomDir, metadata, ownerSessionId),
						setActiveRoom: (context) =>
							setActiveRoom(context as ActiveRoomContext) as typeof context,
						beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
					});
					activeRoom = ensured?.activeRoom ?? null;
					if (activeRoom?.role === "owner") {
						markOwnerClassificationReady(sessionId);
						const log = createRoomLogger(activeRoom.roomDir, "room");
						log.info("room resolved in before_agent_start", {
							roomId: activeRoom.roomId,
							created: ensured?.created ?? false,
						});
						await ensureOwnerInfrastructure({
							pi,
							runtimeRoot,
							sessionId,
							activeRoom,
							adapters,
							startPolling,
							startOwnerHeartbeat,
							beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
						});
					}
				} catch (err) {
					createRoomLogger(null, "room").error(
						"room creation fallback in before_agent_start failed",
						{ error: String(err) },
					);
				}
			} else if (
				!hasResolvablePrompt &&
				!isOwnerClassificationReady(sessionId)
			) {
				markOwnerClassificationUnavailable(sessionId);
				clearOwnerClassificationReady(sessionId);
			}
		}
		activeRoom = getActiveRoom(sessionId);

		// Set up mutation client for spawned agent processes.
		// session_start may fire before the bootstrap is available (empty
		// system prompt), causing activateBootstrapRoom to return early
		// and skip the MutationClient setup. before_agent_start always
		// carries the full system prompt, so we set up the client here
		// as a fallback to ensure spawned agents connect to the proxy.
		if (activeRoom?.role === "member" && !activeRoom.mutationClient) {
			activeRoom.mutationClient = await ensureRoomMutationClientConnected(
				activeRoom.roomDir,
				"before_agent_start_fallback",
			);
		}

		if (activeRoom?.role === "member" && event.systemPrompt) {
			// Use activeRoom.memberType (set during activateBootstrapRoom) instead
			// of parsing the bootstrap block from systemPrompt. The system prompt
			// may have been rebuilt by prior setActiveTools calls, losing the
			// bootstrap block. memberType survives across prompt rebuilds.
			const agentDef = activeRoom.memberType
				? loadTypedRoomAgentDefinition(activeRoom.memberType, ctx.cwd)
				: null;
			let allowed: string[];
			const crewMessageToolNames = [
				"crew_tell",
				"crew_messages",
				"crew_reply",
				"crew_read",
				"crew_who",
				"crew_tasks",
			];
			const crewManageToolNames = [
				"crew_add",
				"crew_cancel",
				"crew_remove",
				"crew_roles",
				"crew_merge",
				"crew_batch",
			];
			if (agentDef?.tools && agentDef.tools.length > 0) {
				allowed = [...new Set([...agentDef.tools, ...crewMessageToolNames])];
			} else {
				allowed = pi
					.getAllTools()
					.map((t) => t.name)
					.filter((name) => !crewManageToolNames.includes(name));
			}
			pi.setActiveTools(allowed);

			// Tool filtering via setActiveTools() is sufficient.
			// With no bootstrap block in the system prompt (env vars carry metadata),
			// _rebuildSystemPrompt() correctly rebuilds the tools list and guidelines.
			// No manual prompt patching needed.
		}

		// ── Owner (lead agent): inject orchestrator-specific instructions ──
		// AGENTS.md is kept generic (safe for all agents including sub-agents).
		// Orchestrator-only directives (delegation rules, memory tool usage, etc.)
		// live in AGENTS-orchestrator.md and are injected only for owner sessions.
		if (activeRoom?.role === "owner") {
			const orchestratorBody = getOrchestratorPromptBody();
			if (orchestratorBody) {
				// Build available subagents section from agent definitions so the
				// orchestrator always knows what types are available without
				// needing to call crew_roles first.
				const agentTypes = listRoomAgentTypes(ctx.cwd);
				const subagentsBlock =
					agentTypes.length > 0
						? "## Available Subagents\n" +
							agentTypes
								.map(
									(t) =>
										`- **${t.type}**: ${t.description || "(no description)"}${t.tools && t.tools.length > 0 ? ` [tools: ${t.tools.join(", ")}]` : ""}`,
								)
								.join("\n")
						: "## Available Subagents\n(no agent definitions found — check agents/ directory)";
				const currentPrompt = ctx.getSystemPrompt?.() ?? event.systemPrompt;
				return {
					systemPrompt:
						currentPrompt + "\n\n" + subagentsBlock + "\n\n" + orchestratorBody,
				};
			}
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		const sessionId = getSessionId(ctx);
		const activeRoom = getActiveRoom(sessionId);
		if (!activeRoom || activeRoom.shuttingDown) return;

		const log = createRoomLogger(activeRoom.roomDir, "room");
		await updateRoomMemberState(activeRoom.roomDir, activeRoom.memberName, {
			chatBusy: true,
			updatedAt: new Date().toISOString(),
		}).catch((err) =>
			log.error("turn_start chatBusy write failed", { error: String(err) }),
		);
	});

	pi.on("turn_end", async (event, ctx) => {
		const sessionId = getSessionId(ctx);
		const activeRoom = getActiveRoom(sessionId);
		if (!activeRoom || activeRoom.shuttingDown) return;

		const log = createRoomLogger(activeRoom.roomDir, "room");

		// Always clear chatBusy at turn end
		await updateRoomMemberState(activeRoom.roomDir, activeRoom.memberName, {
			chatBusy: false,
			updatedAt: new Date().toISOString(),
		}).catch((err) =>
			log.error("turn_end chatBusy clear failed", { error: String(err) }),
		);

		if (activeRoom.role !== "member") return;

		const member = await loadRoomMemberState(
			activeRoom.roomDir,
			activeRoom.memberName,
		).catch(() => null);
		if (!member || member.state !== "running" || !member.currentTaskMessageId)
			return;

		// Interrupted turns (e.g., paseo interrupt button) should not trigger
		// the closure-steer mechanism. The agent loop restarts and the member
		// can continue its task in the next turn.
		const stopReason = (event.message as Record<string, unknown>)?.stopReason;
		if (stopReason === "aborted") return;

		// If this turn had tool calls, reset the steered flag (member is working)
		if (event.toolResults && event.toolResults.length > 0) {
			if (member.taskClosureSteeredMessageId) {
				await updateRoomMemberState(activeRoom.roomDir, activeRoom.memberName, {
					taskClosureSteeredMessageId: null,
					updatedAt: new Date().toISOString(),
				}).catch((err) =>
					log.error("turn_end reset steer failed", { error: String(err) }),
				);
			}
			return;
		}

		// No tool calls + active task
		if (member.taskClosureSteeredMessageId === member.currentTaskMessageId) {
			// Already steered once, still not closed → mark as error
			log.error("task closure steer check failed", {
				memberName: activeRoom.memberName,
				taskMessageId: member.currentTaskMessageId,
			});
			const currentForFail = await loadRoomMemberState(
				activeRoom.roomDir,
				activeRoom.memberName,
			).catch(() => null);
			if (
				currentForFail &&
				currentForFail.state === "running" &&
				currentForFail.currentTaskMessageId === member.currentTaskMessageId
			) {
				await updateRoomMemberState(activeRoom.roomDir, activeRoom.memberName, {
					state: "error",
					lastError:
						"Task closure check failed after steer; member did not reply.",
					currentTask: null,
					currentTaskMessageId: null,
					taskClosureSteeredMessageId: null,
					todoProgress: null,
					updatedAt: new Date().toISOString(),
				}).catch((err) =>
					log.error("turn_end closure fail write failed", {
						error: String(err),
					}),
				);
			}
			return;
		}

		// First turn with no tool calls → steer prompt
		const currentForSteer = await loadRoomMemberState(
			activeRoom.roomDir,
			activeRoom.memberName,
		).catch(() => null);
		const shouldSteer =
			currentForSteer &&
			currentForSteer.state === "running" &&
			currentForSteer.currentTaskMessageId === member.currentTaskMessageId;
		if (shouldSteer) {
			await updateRoomMemberState(activeRoom.roomDir, activeRoom.memberName, {
				taskClosureSteeredMessageId: member.currentTaskMessageId,
				updatedAt: new Date().toISOString(),
			}).catch((err) => {
				log.error("turn_end steer write failed", { error: String(err) });
			});
		}

		if (shouldSteer) {
			log.info("task closure steer sent", {
				memberName: activeRoom.memberName,
			});
			pi.sendMessage(
				{
					customType: "mail-task-closure-check",
					content:
						"You have an unfinished task. Continue working on it or check whether you need to close it by replying with completion/error via crew_reply.",
					display: false,
				},
				{
					deliverAs: "steer",
					triggerTurn: true,
				},
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionId = getSessionId(ctx);
		let activeRoom = getActiveRoom(sessionId);
		if (!activeRoom && isOwnerClassificationReady(sessionId)) {
			try {
				const existing = await findOwnerRoomForRecovery(runtimeRoot, sessionId);
				if (existing) {
					activeRoom = setActiveRoom(
						createOwnerRoomContext(
							existing.roomDir,
							existing.metadata,
							sessionId,
						),
					);
				}
			} catch (err) {
				createRoomLogger(null, "room").error("owner recovery during session_shutdown failed", { error: String(err) });
			}
		}
		if (!activeRoom) {
			clearOwnerClassificationUnavailable(sessionId);
			clearOwnerClassificationReady(sessionId);
			return;
		}
		const log = createRoomLogger(activeRoom.roomDir, "room");
		log.info("session shutting down", {
			role: activeRoom.role,
			roomId: activeRoom.roomId,
		});
		activeRoom.shuttingDown = true;
		if (activeRoom.pollTimer) {
			clearInterval(activeRoom.pollTimer);
			activeRoom.pollTimer = null;
		}
		if (activeRoom.heartbeatTimer) {
			clearInterval(activeRoom.heartbeatTimer);
			activeRoom.heartbeatTimer = null;
		}
		// Flush pending delivery batch before shutdown so the owner sees
		// any notifications that arrived during the debounce window.
		if (activeRoom.deliveryTimer) {
			clearTimeout(activeRoom.deliveryTimer);
			activeRoom.deliveryTimer = null;
		}
		if (activeRoom.pendingDeliveryBatch.length > 0) {
			const members = await listRoomMembers(activeRoom.roomDir).catch(() => []);
			const formatter = new Map<string, string>(
				members.map(
					(member) => [member.name, formatMemberLabel(member)] as const,
				),
			);
			deliverRoomMessagesBatch(
				pi,
				activeRoom.pendingDeliveryBatch.splice(0),
				(name) => formatter.get(name) ?? name,
			);
		}
		if (activeRoom.role === "owner") {
			await options.beforeOwnerShutdownMarkClosing?.({
				roomDir: activeRoom.roomDir,
				roomId: activeRoom.roomId,
				sessionId,
			});
			await withRoomMutationLock(activeRoom.roomDir, async () => {
				const metadata = await loadRoomMetadata(activeRoom.roomDir).catch(
					() => null,
				);
				if (!metadata) return;
				await writeRoomMetadata(activeRoom.roomDir, {
					...metadata,
					state: "closing",
				});
			}).catch((err) =>
				log.error("shutdown mark closing failed", { error: String(err) }),
			);
			await cancelPendingSpawnJobs(
				activeRoom.roomDir,
				`Room ${activeRoom.roomId} is closing.`,
			).catch((err) =>
				log.error("shutdown cancel spawns failed", { error: String(err) }),
			);
		}
		await Promise.allSettled(
			[activeRoom.pendingPoll, activeRoom.pendingHeartbeat].filter(
				(pending): pending is Promise<void> => pending !== null,
			),
		);
		if (activeRoom.role === "owner") {
			await waitForSettledWithGrace(
				[...activeRoom.pendingToolTasks],
				getOwnerShutdownTaskGraceMs(),
			);
		} else {
			await Promise.allSettled([...activeRoom.pendingToolTasks]);
		}
		if (activeRoom.role === "member") {
			const currentMember = await loadRoomMemberState(
				activeRoom.roomDir,
				activeRoom.memberName,
			).catch(() => null);
			if (currentMember && currentMember.state !== "removed") {
				log.info("member session shutting down", {
					lastError: currentMember.lastError,
				});
				await updateRoomMemberState(activeRoom.roomDir, activeRoom.memberName, {
					state: "error",
					sessionId: null,
					currentTask: null,
					currentTaskMessageId: null,
					chatBusy: false,
					todoProgress: null,
					lastError: currentMember.lastError ?? "Member session shut down.",
				}).catch((err) =>
					log.error("shutdown member update failed", { error: String(err) }),
				);
			}
		}
		// Shut down mutation proxy if running (before reaping room, so logger still works)
		if (activeRoom.proxyServer) {
			log.info("stopping mutation proxy");
			await activeRoom.proxyServer
				.stop()
				.catch((err) =>
					log.error("mutation proxy stop failed", { error: String(err) }),
				);
			deleteRoomProxyServer(activeRoom.roomDir);
		}
		if (activeRoom.role === "owner") {
			log.info("owner session shutting down, reaping room");
			await reapRoom(activeRoom.roomDir, adapters).catch((err) =>
				log.error("shutdown reap room failed", { error: String(err) }),
			);
		}
		if (activeRoom.mutationClient) {
			activeRoom.mutationClient.disconnect();
			deleteRoomMutationClient(activeRoom.roomDir);
		}
		// Close the room's log stream to prevent FD leaks.
		// - Member sessions: this is the ONLY close point (reapRoom not called).
		// - Owner sessions: reapRoom already closed it, so closeLogStream is a
		//   safe no-op (Map entry already deleted → immediate resolve).
		closeLogStream(activeRoom.roomDir).catch((err) => {
			const log = createRoomLogger(null, "room");
			log.warn("shutdown closeLogStream failed", { error: String(err) });
		});

		clearActiveRoom(sessionId);
		clearOwnerClassificationReady(sessionId);
	});

	// ── todo progress bridge: mirror todo tool results to member state ──
	// NOTE: fires on every tool_result but early-returns cheaply for non-todo tools.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "todo") return;
		const details = event.details as
			| {
					action: string;
					todos: Array<{ id: number; text: string; done: boolean }>;
					nextId: number;
			  }
			| undefined;
		if (!details) return;

		const sessionId = getSessionId(ctx);
		const activeRoom = getActiveRoom(sessionId);
		if (!activeRoom || activeRoom.role !== "member") return;

		const done = details.todos.filter((t) => t.done).length;
		const total = details.todos.length;

		let todoProgress: { done: number; total: number; lastText: string } | null =
			null;
		let boardSummary: string | null = null;
		if (details.action === "add") {
			const added = details.todos[details.todos.length - 1];
			todoProgress = { done, total, lastText: added?.text ?? "" };
			boardSummary = null;
		} else if (details.action === "toggle") {
			const toggledId = (event.input as { id?: number } | undefined)?.id;
			const toggledTodo = toggledId
				? details.todos.find((t) => t.id === toggledId)
				: undefined;
			todoProgress = { done, total, lastText: toggledTodo?.text ?? "" };
			boardSummary = `[${done}/${total}] ${toggledTodo?.text ?? ""}`;
		} else if (details.action === "clear") {
			todoProgress = null;
			boardSummary = "Cleared all todos";
		} else {
			return;
		}

		await updateRoomMemberState(activeRoom.roomDir, activeRoom.memberName, {
			todoProgress,
			updatedAt: new Date().toISOString(),
		}).catch(() => {});

		if (boardSummary) {
			appendMessage(activeRoom.roomDir, {
				from: activeRoom.memberName,
				to: "room",
				broadcast: false,
				replyTo: null,
				kind: "progress",
				summary: boardSummary,
			}).catch(() => {});
		}
	});

	const registerTool = pi.registerTool.bind(pi) as (definition: any) => void;

	registerTool({
		name: "crew_add",
		label: "Add Agent",
		description:
			"Spawn a new sub-agent.",
		parameters: CrewAddSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const currentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			const currentThinkingLevel = pi.getThinkingLevel();
			return executeCrewAdd(
				rawParams,
				pi,
				{ ...ctx, currentModel, currentThinkingLevel },
				runtimeRoot,
				adapters,
				{
					ownerName,
					beforeDeliverMessage: options.beforeDeliverMessage,
					beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
				},
			) as any;
		},
	});

	registerTool({
		name: "crew_cancel",
		label: "Cancel Agent's task",
		description:
			"Cancel a sub-agent's task by alias, internal id, or alias#suffix label. ",
		parameters: CrewStopSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const currentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			const currentThinkingLevel = pi.getThinkingLevel();
			return executeCrewStop(
				rawParams,
				pi,
				{ ...ctx, currentModel, currentThinkingLevel },
				runtimeRoot,
				adapters,
				{
					ownerName,
					beforeDeliverMessage: options.beforeDeliverMessage,
					beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
				},
			) as any;
		},
	});

	registerTool({
		name: "crew_remove",
		label: "Remove Agent",
		description:
			"Remove a sub-agent from the crew by alias, internal id, or alias#suffix label.",
		parameters: CrewRemoveSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const currentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			const currentThinkingLevel = pi.getThinkingLevel();
			return executeCrewRemove(
				rawParams,
				pi,
				{ ...ctx, currentModel, currentThinkingLevel },
				runtimeRoot,
				adapters,
				{
					ownerName,
					beforeDeliverMessage: options.beforeDeliverMessage,
					beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
				},
			) as any;
		},
	});

	registerTool({
		name: "crew_merge",
		label: "Merge Worktree",
		description:
			"Merge an agent's worktree branch snapshot into the current branch using alias, internal id, or alias#suffix label. Supports merge, rebase, and fast-forward-only strategies.",
		parameters: CrewMergeSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const currentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			const currentThinkingLevel = pi.getThinkingLevel();
			return executeCrewMerge(
				rawParams,
				pi,
				{ ...ctx, currentModel, currentThinkingLevel },
				runtimeRoot,
				adapters,
				{
					ownerName,
					beforeDeliverMessage: options.beforeDeliverMessage,
					beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
				},
			) as any;
		},
	});

	registerTool({
		name: "crew_roles",
		label: "Agent Roles",
		description: "List available agent roles that can be added to the crew.",
		parameters: CrewRolesSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const currentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			const currentThinkingLevel = pi.getThinkingLevel();
			return executeCrewRoles(
				rawParams,
				pi,
				{ ...ctx, currentModel, currentThinkingLevel },
				runtimeRoot,
				adapters,
				{
					ownerName,
					beforeDeliverMessage: options.beforeDeliverMessage,
					beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
				},
			) as any;
		},
	});

	registerTool({
		name: "crew_tell",
		label: "Crew Tell",
		description:
			"Use when sending a message to a crew member by alias, internal id, or alias#suffix label. For task assignment, use kind: 'task'; for questions, use kind: 'question'; for info, use kind: 'info'.",
		parameters: CrewTellSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const currentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			return executeCrewTell(
				rawParams,
				pi,
				{ ...ctx, currentModel },
				runtimeRoot,
				adapters,
				{
					ownerName,
					beforeDeliverMessage: options.beforeDeliverMessage,
					beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
				},
			) as any;
		},
	});

	registerTool({
		name: "crew_messages",
		label: "Crew Messages",
		description:
			"List recent crew messages on the board. Use filter: 'me' to see messages relevant to you.",
		parameters: CrewMessagesSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const currentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			return executeCrewMessages(
				rawParams,
				pi,
				{ ...ctx, currentModel },
				runtimeRoot,
				adapters,
				{
					ownerName,
					beforeDeliverMessage: options.beforeDeliverMessage,
					beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
				},
			) as any;
		},
	});

	registerTool({
		name: "crew_reply",
		label: "Crew Reply",
		description:
			"Reply to a task message to report completion or error. This closes your current task. Put a one-line result in summary, full report in content. Include @agent-name in summary to hand off.",
		parameters: CrewReplySchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const currentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			return executeCrewReply(
				rawParams,
				pi,
				{ ...ctx, currentModel },
				runtimeRoot,
				adapters,
				{
					ownerName,
					beforeDeliverMessage: options.beforeDeliverMessage,
					beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
				},
			) as any;
		},
	});

	registerTool({
		name: "crew_read",
		label: "Crew Read",
		description:
			"Read the full content of a specific message by its sequence number.",
		parameters: CrewReadSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const currentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			return executeCrewRead(
				rawParams,
				pi,
				{ ...ctx, currentModel },
				runtimeRoot,
				adapters,
				{
					ownerName,
					beforeDeliverMessage: options.beforeDeliverMessage,
					beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
				},
			) as any;
		},
	});

	registerTool({
		name: "crew_who",
		label: "Crew Who",
		description:
			"List all crew members.",
		parameters: CrewWhoSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const currentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			return executeCrewWho(
				rawParams,
				pi,
				{ ...ctx, currentModel },
				runtimeRoot,
				adapters,
				{
					ownerName,
					beforeDeliverMessage: options.beforeDeliverMessage,
					beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
				},
			) as any;
		},
	});

	registerTool({
		name: "crew_tasks",
		label: "Crew Tasks",
		description:
			"List tasks with their current status.",
		parameters: CrewTasksSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const currentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			return executeCrewTasks(
				rawParams,
				pi,
				{ ...ctx, currentModel },
				runtimeRoot,
				adapters,
				{
					ownerName,
					beforeDeliverMessage: options.beforeDeliverMessage,
					beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
				},
			) as any;
		},
	});

	registerTool({
		name: "crew_batch",
		label: "Crew Batch",
		description: CREW_BATCH_TOOL_DESCRIPTION,
		parameters: CrewBatchSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const currentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			const currentThinkingLevel = pi.getThinkingLevel();
			return executeCrewBatch(
				rawParams,
				pi,
				{ ...ctx, currentModel, currentThinkingLevel },
				runtimeRoot,
				adapters,
				{
					ownerName,
					beforeDeliverMessage: options.beforeDeliverMessage,
					beforeOwnerHeartbeatWrite: options.beforeOwnerHeartbeatWrite,
				},
			) as any;
		},
	});
}
