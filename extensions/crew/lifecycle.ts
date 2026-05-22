import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseRoomBootstrapBlock } from "./bootstrap.ts";
import {
	applyIncomingMessageState,
	applyOutgoingMessageState,
	deliverRoomMessagesBatch,
	isMessageTargetedToMember,
	shouldDeliverMessage,
} from "./dispatch.ts";
import {
	appendMessage,
	claimMemberSession,
	formatMemberLabel,
	getRoomMutationClient,
	listBoardEntries,
	listRoomMembers,
	listBoardEntriesAfterSeq,
	loadRoomMemberState,
	readMessage,
	readSpawnJob,
	markMemberJoined,
	resolveTaskSeqByMessageId,
	setRoomMutationClient,
	updateRoomMemberState,
	writeMemberHeartbeat,
} from "./storage.ts";
import { allDepsReady, extractInputDeps } from "./deps.ts";
import {
	getMemberHeartbeatIntervalMs,
	getMemberHeartbeatStaleMs,
	getOwnerHeartbeatIntervalMs,
	getOwnerHeartbeatStaleMs,
	handleStaleOwnerForMember,
	reconcileMemberLiveness,
	reconcileSpawnTimeouts,
	writeOwnerHeartbeat,
} from "./watchdog.ts";
import type {
	RoomMemberState,
	RoomMessage,
	RoomMetadata,
	RoomSpawnAdapter,
} from "./types.ts";
import type { RoomMutationProxy } from "./storage.ts";
import type { MutationClient } from "./mutation-client.ts";
import { createMutationClient } from "./mutation-client.ts";
import { createRoomLogger } from "./logger.ts";
import { ensureOwnerInfrastructure, ensureOwnerRoom } from "./owner-room.ts";

export interface ActiveRoomContext {
	role: "owner" | "member";
	roomDir: string;
	roomId: string;
	memberName: string;
	/** Agent type (e.g. "researcher", "explorer") — set for member sessions so
	 *  before_agent_start can determine allowed tools without relying on the
	 *  bootstrap block in the system prompt (which is lost after setActiveTools
	 *  rebuilds _baseSystemPrompt). */
	memberType?: string;
	sessionId: string;
	pollTimer: NodeJS.Timeout | null;
	heartbeatTimer: NodeJS.Timeout | null;
	pendingPoll: Promise<void> | null;
	pendingHeartbeat: Promise<void> | null;
	pendingToolTasks: Set<Promise<unknown>>;
	shuttingDown: boolean;
	proxyServer?: RoomMutationProxy;
	mutationClient?: MutationClient;
	beforeDeliverMessage?: (context: {
		roomDir: string;
		memberName: string;
		message: RoomMessage;
	}) => Promise<void> | void;
	staleReapScheduled?: boolean;
	/** Messages accumulated during the debounce window, delivered as a single batch. */
	pendingDeliveryBatch: Array<{ message: RoomMessage; isNewTask: boolean }>;
	/** Debounce timer for batch delivery. Null when no delivery is pending. */
	deliveryTimer: ReturnType<typeof setTimeout> | null;
}

const activeRooms = new Map<string, ActiveRoomContext>();
const ownerClassificationUnavailableSessions = new Set<string>();
const ownerClassificationReadySessions = new Set<string>();

export function getActiveRoom(sessionId: string): ActiveRoomContext | null {
	return activeRooms.get(sessionId) ?? null;
}

export function setActiveRoom(context: ActiveRoomContext): ActiveRoomContext {
	if (context.role === "member") {
		for (const [sessionId, existing] of activeRooms.entries()) {
			if (
				sessionId !== context.sessionId &&
				existing.role === "member" &&
				existing.roomDir === context.roomDir &&
				existing.memberName === context.memberName
			) {
				clearActiveRoom(sessionId);
			}
		}
	}

	const existing = activeRooms.get(context.sessionId);
	if (existing && existing !== context) {
		if (existing.pollTimer) clearInterval(existing.pollTimer);
		if (existing.heartbeatTimer) clearInterval(existing.heartbeatTimer);
		if (existing.deliveryTimer) clearTimeout(existing.deliveryTimer);
	}
	ownerClassificationUnavailableSessions.delete(context.sessionId);
	if (context.role !== "owner") {
		ownerClassificationReadySessions.delete(context.sessionId);
	}
	activeRooms.set(context.sessionId, context);
	return context;
}

export function clearActiveRoom(sessionId: string): void {
	const activeRoom = activeRooms.get(sessionId);
	if (activeRoom?.pollTimer) clearInterval(activeRoom.pollTimer);
	if (activeRoom?.heartbeatTimer) clearInterval(activeRoom.heartbeatTimer);
	if (activeRoom?.deliveryTimer) clearTimeout(activeRoom.deliveryTimer);
	activeRoom?.pendingToolTasks.clear();
	activeRooms.delete(sessionId);
	ownerClassificationUnavailableSessions.delete(sessionId);
}

export function markOwnerClassificationUnavailable(sessionId: string): void {
	ownerClassificationReadySessions.delete(sessionId);
	ownerClassificationUnavailableSessions.add(sessionId);
}

export function markOwnerClassificationReady(sessionId: string): void {
	ownerClassificationUnavailableSessions.delete(sessionId);
	ownerClassificationReadySessions.add(sessionId);
}

export function clearOwnerClassificationUnavailable(sessionId: string): void {
	ownerClassificationUnavailableSessions.delete(sessionId);
}

export function clearOwnerClassificationReady(sessionId: string): void {
	ownerClassificationReadySessions.delete(sessionId);
}

export function isOwnerClassificationUnavailable(sessionId: string): boolean {
	return ownerClassificationUnavailableSessions.has(sessionId);
}

export function isOwnerClassificationReady(sessionId: string): boolean {
	return ownerClassificationReadySessions.has(sessionId);
}

export function getDeliveryDebounceMs(): number {
	const raw = Number(process.env.PI_ROOM_DELIVERY_DEBOUNCE_MS ?? "1000");
	return Number.isFinite(raw) && raw > 0 ? raw : 1000;
}

/**
 * Resolve the room poll interval (how often `startPolling` checks for
 * unread messages, spawn timeouts, and member liveness).
 *
 * Default: 2000ms (2 seconds).  Override with PI_ROOM_POLL_INTERVAL_MS.
 * The previous hardcoded 200ms was too aggressive for idle rooms and
 * contributed to elevated CPU usage when combined with Paseo WebSocket
 * frontend polling.
 */
export function getPollIntervalMs(): number {
	const raw = Number(process.env.PI_ROOM_POLL_INTERVAL_MS ?? "2000");
	return Number.isFinite(raw) && raw > 0 ? raw : 2000;
}

function createRoomNameFormatter(
	members: RoomMemberState[],
): (name: string) => string {
	const labels = new Map(
		members.map((member) => [member.name, formatMemberLabel(member)]),
	);
	return (name: string) => labels.get(name) ?? name;
}

export function resetActiveRoomsForTests(): void {
	for (const sessionId of [...activeRooms.keys()]) {
		clearActiveRoom(sessionId);
	}
	ownerClassificationUnavailableSessions.clear();
	ownerClassificationReadySessions.clear();
}

export function getSessionId(ctx: {
	sessionManager?: { getSessionId?: () => string };
}): string {
	return ctx.sessionManager?.getSessionId?.() ?? `room-session-${randomUUID()}`;
}

export function getOwnerShutdownTaskGraceMs(): number {
	const raw = Number(process.env.PI_ROOM_OWNER_SHUTDOWN_TASK_GRACE_MS ?? "250");
	return Number.isFinite(raw) && raw >= 0 ? raw : 250;
}

export async function ensureRoomMutationClientConnected(
	roomDir: string,
	reason: string,
): Promise<MutationClient> {
	const log = createRoomLogger(roomDir, "room");
	const existingClient = getRoomMutationClient(roomDir);
	if (existingClient) {
		if (existingClient.getState() !== "connected") {
			await existingClient.connect({ retryTimeoutMs: 30000 });
			log.info(`mutation client reconnected to owner proxy (${reason})`);
		}
		return existingClient;
	}
	const client = createMutationClient(roomDir);
	await client.connect({ retryTimeoutMs: 30000 });
	setRoomMutationClient(roomDir, client);
	log.info(`mutation client connected to owner proxy (${reason})`);
	return client;
}

export async function waitForSettledWithGrace(
	promises: Promise<unknown>[],
	timeoutMs: number,
): Promise<void> {
	if (promises.length === 0) return;
	await Promise.race([
		Promise.allSettled(promises),
		new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			if (typeof timer.unref === "function") {
				timer.unref();
			}
		}),
	]);
}

export function trackActiveRoomTask<T>(
	sessionId: string,
	work: Promise<T>,
): Promise<T> {
	const activeRoom = getActiveRoom(sessionId);
	if (!activeRoom) return work;
	let tracked: Promise<T>;
	tracked = work.finally(() => {
		activeRoom.pendingToolTasks.delete(tracked as Promise<unknown>);
	});
	activeRoom.pendingToolTasks.add(tracked as Promise<unknown>);
	return tracked;
}

export function startMemberHeartbeat(sessionId: string): void {
	const activeRoom = getActiveRoom(sessionId);
	if (!activeRoom || activeRoom.role !== "member") return;
	const log = createRoomLogger(activeRoom.roomDir, "room");
	if (activeRoom.heartbeatTimer) clearInterval(activeRoom.heartbeatTimer);
	const write = () => {
		const current = getActiveRoom(sessionId);
		if (!current || current.role !== "member" || current.shuttingDown)
			return Promise.resolve();
		if (current.pendingHeartbeat) return current.pendingHeartbeat;
		let pending: Promise<void>;
		pending = writeMemberHeartbeat(current.roomDir, current.memberName)
			.catch((err) =>
				log.error("member heartbeat failed", { error: String(err) }),
			)
			.finally(() => {
				const latest = getActiveRoom(sessionId);
				if (latest === current && latest.pendingHeartbeat === pending) {
					latest.pendingHeartbeat = null;
				}
			});
		current.pendingHeartbeat = pending;
		return pending;
	};
	void write();
	activeRoom.heartbeatTimer = setInterval(() => {
		const current = getActiveRoom(sessionId);
		if (!current || current.role !== "member") return;
		void write();
	}, getMemberHeartbeatIntervalMs());
	if (typeof activeRoom.heartbeatTimer.unref === "function") {
		activeRoom.heartbeatTimer.unref();
	}
}

export function startOwnerHeartbeat(
	sessionId: string,
	beforeOwnerHeartbeatWrite?: (context: {
		roomDir: string;
		roomId: string;
		sessionId: string;
	}) => Promise<void> | void,
): void {
	const activeRoom = getActiveRoom(sessionId);
	if (!activeRoom || activeRoom.role !== "owner") return;
	const log = createRoomLogger(activeRoom.roomDir, "room");
	if (activeRoom.heartbeatTimer) clearInterval(activeRoom.heartbeatTimer);
	const write = () => {
		const current = getActiveRoom(sessionId);
		if (!current || current.role !== "owner" || current.shuttingDown)
			return Promise.resolve();
		if (current.pendingHeartbeat) return current.pendingHeartbeat;
		let pending: Promise<void>;
		pending = Promise.resolve(
			beforeOwnerHeartbeatWrite?.({
				roomDir: current.roomDir,
				roomId: current.roomId,
				sessionId: current.sessionId,
			}),
		)
			.then(async () => {
				const latest = getActiveRoom(sessionId);
				if (
					!latest ||
					latest !== current ||
					latest.role !== "owner" ||
					latest.shuttingDown
				)
					return;
				await writeOwnerHeartbeat(
					latest.roomDir,
					latest.sessionId,
					process.pid,
				);
			})
			.catch((err) =>
				log.error("owner heartbeat failed", { error: String(err) }),
			)
			.finally(() => {
				const latest = getActiveRoom(sessionId);
				if (latest === current && latest.pendingHeartbeat === pending) {
					latest.pendingHeartbeat = null;
				}
			});
		current.pendingHeartbeat = pending;
		return pending;
	};
	void write();
	activeRoom.heartbeatTimer = setInterval(() => {
		const current = getActiveRoom(sessionId);
		if (!current || current.role !== "owner") return;
		void write();
	}, getOwnerHeartbeatIntervalMs());
	if (typeof activeRoom.heartbeatTimer.unref === "function") {
		activeRoom.heartbeatTimer.unref();
	}
}

export function startPolling(
	pi: ExtensionAPI,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	sessionId: string,
): void {
	const activeRoom = getActiveRoom(sessionId);
	if (!activeRoom) return;
	const log = createRoomLogger(activeRoom.roomDir, "room");
	if (activeRoom.pollTimer) clearInterval(activeRoom.pollTimer);
	const poll = () => {
		const current = getActiveRoom(sessionId);
		if (!current || current.shuttingDown) return;
		if (current.pendingPoll) return;
		let pending: Promise<void>;
		pending = (async () => {
			if (current.role === "owner") {
				await reconcileSpawnTimeouts(current.roomDir, adapters).catch((err) =>
					log.error("reconcile spawn timeouts failed", { error: String(err) }),
				);
				await reconcileMemberLiveness(current.roomDir, adapters, {
					memberHeartbeatStaleMs: getMemberHeartbeatStaleMs(),
				}).catch((err) =>
					log.error("reconcile member liveness failed", { error: String(err) }),
				);
			}
			if (current.role === "member") {
				const orphaned = await handleStaleOwnerForMember(
					current.roomDir,
					current.memberName,
					adapters,
					{
						heartbeatStaleMs: getOwnerHeartbeatStaleMs(),
					},
				);
				if (orphaned) {
					log.info("owner heartbeat stale, entering orphan cleanup");
					clearActiveRoom(sessionId);
					return;
				}
			}
			const latest = getActiveRoom(sessionId);
			if (latest && latest === current && !latest.shuttingDown) {
				await processUnreadMessages(pi, latest);
			}
		})()
			.catch((err) => log.error("poll cycle failed", { error: String(err) }))
			.finally(() => {
				const latest = getActiveRoom(sessionId);
				if (latest === current && latest.pendingPoll === pending) {
					latest.pendingPoll = null;
				}
			});
		current.pendingPoll = pending;
	};
	activeRoom.pollTimer = setInterval(() => {
		poll();
	}, getPollIntervalMs());
	if (typeof activeRoom.pollTimer.unref === "function") {
		activeRoom.pollTimer.unref();
	}
}

export async function processUnreadMessages(
	pi: ExtensionAPI,
	context: ActiveRoomContext,
): Promise<void> {
	const log = createRoomLogger(context.roomDir, "room");

	// Read state and messages outside any lock (reads are naturally concurrent-safe).
	// The mutation client (or owner proxy) serializes the final write.
	const current = await loadRoomMemberState(
		context.roomDir,
		context.memberName,
	).catch(() => null);
	if (!current) return;
	if (context.role === "member" && current.sessionId !== context.sessionId) {
		log.info("member session mismatch, clearing stale active context", {
			memberName: context.memberName,
			contextSessionId: context.sessionId,
			storedSessionId: current.sessionId,
		});
		clearActiveRoom(context.sessionId);
		return;
	}

	const unreadMessages = await listBoardEntriesAfterSeq(
		context.roomDir,
		current.lastSeenSeq,
	);

	if (unreadMessages.length === 0) return;

	let member = current;
	let boardEntriesCache: RoomMessage[] | null = null;
	const deliverable: Array<{ message: RoomMessage; isNewTask: boolean }> = [];

	for (const message of unreadMessages) {
		const alreadyAcknowledgedSelfReply =
			context.role === "member" &&
			message.from === context.memberName &&
			member.pendingSelfAckMessageId === message.id;

		if (alreadyAcknowledgedSelfReply) {
			member = { ...member, lastSeenSeq: message.seq };
			continue;
		}

		if (message.silent === true) {
			member = { ...member, lastSeenSeq: message.seq };
			continue;
		}

		const prevState = member.state;
		member = applyIncomingMessageState(
			applyOutgoingMessageState(member, message),
			message,
		);

		// Async readiness check: when member receives their current task and
		// it has {input:#N} dependencies, check whether all deps are already
		// satisfied. This handles the "ready-at-assignment" case where
		// upstream tasks completed before the member first polls.
		const isTargetedTask =
			isMessageTargetedToMember(message, context.memberName) &&
			message.kind === "task" &&
			member.currentTaskMessageId === message.id;

		if (isTargetedTask) {
			const deps = extractInputDeps(message.content);
			if (deps.length > 0) {
				const readiness = await allDepsReady(context.roomDir, message.content);
				if (readiness.ready) {
					member = { ...member, state: "running" };
				}
			}
		}

		// Handle system dependency-ready notifications.
		// When a targeted system info message announces deps are ready,
		// resolve the member's current task seq and transition to running.
		if (
			message.from === "system" &&
			message.kind === "info" &&
			member.currentTaskMessageId
		) {
			const readyMatch = message.summary.match(
				/^All dependencies ready for task #(\d+)$/,
			);
			if (readyMatch) {
				const notifiedSeq = Number(readyMatch[1]);
				if (!boardEntriesCache) {
					boardEntriesCache = await listBoardEntries(
						context.roomDir,
						Number.MAX_SAFE_INTEGER,
					);
				}
				const activeSeq = await resolveTaskSeqByMessageId(
					context.roomDir,
					member.currentTaskMessageId,
					boardEntriesCache,
				);
				if (
					activeSeq !== null &&
					activeSeq === notifiedSeq &&
					member.state === "idle"
				) {
					member = { ...member, state: "running" };
				}
			}
		}

		const shouldDeliver =
			shouldDeliverMessage(message, context.memberName) ||
			(message.to === "room" &&
				context.role === "owner" &&
				message.from !== context.memberName &&
				message.kind !== "progress");

		if (shouldDeliver) {
			if (!isTargetedTask && message.kind !== "task") {
				deliverable.push({ message, isNewTask: false });
			} else if (isTargetedTask) {
				deliverable.push({ message, isNewTask: true });
			}
		}

		member = { ...member, lastSeenSeq: message.seq };
	}

	// Write updated state via updateRoomMemberState (goes through mutation
	// client in agent processes or proxy p-queue in owner, avoiding file lock).
	if (member !== current) {
		const patch: Partial<RoomMemberState> = {
			updatedAt: new Date().toISOString(),
		};
		for (const key of Object.keys(member) as Array<
			keyof RoomMemberState & string
		>) {
			if (member[key] !== current[key]) {
				(patch as Record<string, unknown>)[key] = member[key];
			}
		}
		const result = await updateRoomMemberState(
			context.roomDir,
			context.memberName,
			patch,
		).catch(() => null);
		if (!result) return;
	}

	if (deliverable.length === 0) return;

	// Write auto-confirm board message when the member actually transitions to
	// running. This follows becameRunning (member's lifecycle state change),
	// not isNewTask (task delivery). Dependency-waiting tasks keep the member
	// idle; Starting: is only sent when the member enters running — either
	// immediately for no-deps tasks or later when deps become ready.
	// Skipped for transient members (no notifications).
	if (
		!member.transient &&
		member.state === "running" &&
		current.state !== "running" &&
		member.currentTaskMessageId
	) {
		const taskMsg = await readMessage(
			context.roomDir,
			member.currentTaskMessageId,
		);
		if (taskMsg) {
			log.info("member became running", { memberName: context.memberName });
			appendMessage(context.roomDir, {
				from: context.memberName,
				to: taskMsg.from,
				batchId: taskMsg.batchId,
				replyTo: taskMsg.id,
				kind: "info",
				summary: `Starting: ${taskMsg.summary}`,
				silent: taskMsg.batchId ? true : undefined,
				broadcast: false,
			}).catch((err) =>
				log.error("auto-confirm failed", { error: String(err) }),
			);
		}
	}

	// Batch + debounce delivery to avoid flooding the agent with individual
	// steer messages during bulk spawns, bulk stops, or room broadcasts.
	// Uses a fixed 1-second window from the first message: subsequent messages
	// that arrive within the window are appended to the same batch.
	context.pendingDeliveryBatch.push(...deliverable);

	if (!context.deliveryTimer) {
		const debounceMs = getDeliveryDebounceMs();
		context.deliveryTimer = setTimeout(async () => {
			const latest = getActiveRoom(context.sessionId);
			if (!latest || latest !== context || latest.shuttingDown) return;

			const batch = context.pendingDeliveryBatch.splice(0);
			context.deliveryTimer = null;
			if (batch.length === 0) return;
			const formatter = createRoomNameFormatter(
				await listRoomMembers(context.roomDir).catch(() => []),
			);

			log.info("delivering batch", { count: batch.length });
			deliverRoomMessagesBatch(pi, batch, formatter);
		}, debounceMs);
	}
}

export async function activateBootstrapRoom(
	pi: ExtensionAPI,
	systemPrompt: string | null | undefined,
	sessionId: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	beforeDeliverMessage?: (context: {
		roomDir: string;
		memberName: string;
		message: RoomMessage;
	}) => Promise<void> | void,
): Promise<void> {
	const bootstrap = parseRoomBootstrapBlock(systemPrompt ?? "");
	if (!bootstrap) return;
	const existing = getActiveRoom(sessionId);
	if (
		existing &&
		existing.role === "member" &&
		existing.roomId === bootstrap.roomId &&
		existing.memberName === bootstrap.memberName
	) {
		await processUnreadMessages(pi, existing);
		return;
	}

	const seededMember = await loadRoomMemberState(
		bootstrap.roomDir,
		bootstrap.memberName,
	).catch(() => null);
	const spawnJob = bootstrap.spawnTaskId
		? await readSpawnJob(bootstrap.roomDir, bootstrap.spawnTaskId).catch(
				() => null,
			)
		: null;
	const bootstrapBackend = seededMember?.backend ?? spawnJob?.backend ?? "pi";
	const log = createRoomLogger(bootstrap.roomDir, "room");
	const joined =
		bootstrapBackend === "paseo"
			? await claimMemberSession({
					bootstrap,
					sessionId,
					memberPid: process.pid,
				})
			: await markMemberJoined({
					bootstrap,
					sessionId,
					runtimeId: String(process.pid),
					backend: "pi",
				});

	// Notify owner that this member has joined (skip for transient agents)
	try {
		const joinBatchId = joined.spawnBatchId ?? undefined;
		const status =
			joined.state === "spawning"
				? "Bootstrap claimed, awaiting owner finalize"
				: joined.currentTask
					? `Ready, executing: ${joined.currentTask}`
					: "Ready, awaiting task";
		if (!joined.transient) {
			await appendMessage(bootstrap.roomDir, {
				from: bootstrap.memberName,
				to: bootstrap.ownerName,
				batchId: joinBatchId,
				broadcast: false,
				replyTo: null,
				kind: "info",
				summary: `${bootstrap.memberName} (${bootstrap.memberType}) ${status}`,
				silent: joinBatchId ? true : undefined,
			});
		}
		if (joinBatchId) {
			await updateRoomMemberState(bootstrap.roomDir, bootstrap.memberName, {
				spawnBatchId: null,
				updatedAt: new Date().toISOString(),
			}).catch((err) => {
				log.error("member join spawnBatchId cleanup failed", {
					memberName: bootstrap.memberName,
					batchId: joinBatchId,
					error: String(err),
				});
			});
		}
	} catch (err) {
		// notification failure must not block the member from joining
		log.warn("join notification failed", { error: String(err) });
	}

	const activeRoom = setActiveRoom({
		role: "member",
		roomDir: bootstrap.roomDir,
		roomId: bootstrap.roomId,
		memberName: bootstrap.memberName,
		memberType: bootstrap.memberType,
		sessionId,
		pollTimer: null,
		heartbeatTimer: null,
		pendingPoll: null,
		pendingHeartbeat: null,
		pendingToolTasks: new Set<Promise<unknown>>(),
		shuttingDown: false,
		beforeDeliverMessage,
		pendingDeliveryBatch: [],
		deliveryTimer: null,
	});
	log.info("member activated", {
		memberName: bootstrap.memberName,
		role: "member",
	});
	startPolling(pi, adapters, sessionId);
	startMemberHeartbeat(sessionId);
	await processUnreadMessages(pi, activeRoom);
}

export async function resolveAccessibleRoom(
	pi: ExtensionAPI,
	ctx: {
		cwd: string;
		getSystemPrompt?: () => string;
		sessionManager?: { getSessionId?: () => string };
	},
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	ownerName?: string,
	beforeDeliverMessage?: (context: {
		roomDir: string;
		memberName: string;
		message: RoomMessage;
	}) => Promise<void> | void,
	beforeOwnerHeartbeatWrite?: (context: {
		roomDir: string;
		roomId: string;
		sessionId: string;
	}) => Promise<void> | void,
): Promise<ActiveRoomContext | null> {
	const sessionId = getSessionId(ctx);
	const current = getActiveRoom(sessionId);
	if (current) return current;

	const systemPrompt = ctx.getSystemPrompt?.() ?? "";
	const bootstrap = parseRoomBootstrapBlock(systemPrompt);
	if (bootstrap) {
		await ensureRoomMutationClientConnected(
			bootstrap.roomDir,
			"resolve_accessible_room",
		);
		await activateBootstrapRoom(
			pi,
			systemPrompt,
			sessionId,
			adapters,
			beforeDeliverMessage,
		);
		return getActiveRoom(sessionId);
	}
	if (
		isOwnerClassificationUnavailable(sessionId) ||
		!isOwnerClassificationReady(sessionId)
	)
		return null;
	if (!ownerName) {
		return null;
	}
	const recovered = await ensureOwnerRoom({
		runtimeRoot,
		ownerName,
		sessionId,
		cwd: ctx.cwd,
		allowCreate: false,
		createActiveRoom: (
			roomDir: string,
			metadata: RoomMetadata,
			ownerSessionId: string,
		) => ({
			role: "owner" as const,
			roomDir,
			roomId: metadata.roomId,
			memberName: metadata.ownerName,
			sessionId: ownerSessionId,
			pollTimer: null,
			heartbeatTimer: null,
			pendingPoll: null,
			pendingHeartbeat: null,
			pendingToolTasks: new Set<Promise<unknown>>(),
			shuttingDown: false,
			beforeDeliverMessage,
			staleReapScheduled: false,
			pendingDeliveryBatch: [],
			deliveryTimer: null,
		}),
		setActiveRoom: (context) =>
			setActiveRoom(context as ActiveRoomContext) as typeof context,
		beforeOwnerHeartbeatWrite,
	});
	if (!recovered) {
		return null;
	}
	await ensureOwnerInfrastructure({
		pi,
		runtimeRoot,
		sessionId,
		activeRoom: recovered.activeRoom,
		adapters,
		startPolling,
		startOwnerHeartbeat,
		beforeOwnerHeartbeatWrite,
	});
	return getActiveRoom(sessionId);
}
