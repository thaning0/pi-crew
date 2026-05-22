import * as fs from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createRoomLogger } from "./logger.ts";
import {
	appendMessage,
	ensureRoomProxy,
	findOrCreateRoomForOwnerSession,
	findRoomByOwnerSessionId,
	loadRoomMetadata,
	withRoomMutationLock,
	withSerializedOwnerRoomMutation,
	writeRoomMetadata,
} from "./storage.ts";
import {
	getOwnerHeartbeatStaleMs,
	reapStaleRooms,
	writeOwnerHeartbeat,
} from "./watchdog.ts";
import type { RoomMetadata, RoomSpawnAdapter } from "./types.ts";
import { RoomNotFoundError } from "./errors.ts";

const pendingStaleRoomReaps = new Map<string, Promise<void>>();

async function writeOwnerHeartbeatWithHook(
	roomDir: string,
	roomId: string,
	sessionId: string,
	beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void,
): Promise<void> {
	await beforeOwnerHeartbeatWrite?.({ roomDir, roomId, sessionId });
	await writeOwnerHeartbeat(roomDir, sessionId, process.pid);
}

async function initializeOwnerRoomBoard(roomDir: string, roomId: string): Promise<void> {
	await appendMessage(roomDir, {
		from: "system",
		to: "room",
		broadcast: false,
		replyTo: null,
		kind: "info",
		summary: `Room initialized: ${roomId}`,
		silent: true,
	});
}

async function refreshOwnerRoomForReuse(
	runtimeRoot: string,
	roomDir: string,
	sessionId: string,
	beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void,
) {
	let refreshed = await loadRoomMetadata(roomDir).catch(() => null);
	try {
		await withSerializedOwnerRoomMutation(runtimeRoot, sessionId, [roomDir], async () => {
			await withRoomMutationLock(roomDir, async () => {
				const current = await loadRoomMetadata(roomDir).catch(() => null);
				if (!current) {
					refreshed = null;
					return;
				}
				refreshed = { ...current, state: "active", ownerPid: process.pid };
				await writeRoomMetadata(roomDir, refreshed);
				await writeOwnerHeartbeatWithHook(roomDir, current.roomId, sessionId, beforeOwnerHeartbeatWrite);
			});
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (!(error instanceof RoomNotFoundError) && code !== "ENOENT") {
			throw error;
		}
		refreshed = null;
		const metadataPath = `${roomDir}/room.json`;
		const metadataExists = await fs.stat(metadataPath).then(() => true).catch(() => false);
		if (!metadataExists) {
			await fs.rm(roomDir, { recursive: true, force: true }).catch(() => {});
		}
	}
	return refreshed;
}

export async function findOwnerRoomForRecovery(
	runtimeRoot: string,
	ownerSessionId: string,
): Promise<{ roomDir: string; metadata: RoomMetadata } | null> {
	return await findRoomByOwnerSessionId(runtimeRoot, ownerSessionId);
}

export async function ensureOwnerRoom<T>(options: {
	runtimeRoot: string;
	ownerName: string;
	sessionId: string;
	cwd: string;
	allowCreate: boolean;
	createActiveRoom: (roomDir: string, metadata: RoomMetadata, sessionId: string) => T;
	setActiveRoom: (context: T) => T;
	beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void;
}): Promise<{ activeRoom: T; created: boolean } | null> {
	const { runtimeRoot, ownerName, sessionId, cwd, allowCreate, beforeOwnerHeartbeatWrite } = options;
	let resolved:
		| { roomDir: string; metadata: RoomMetadata; created: boolean }
		| null = null;

	if (allowCreate) {
		const created = await findOrCreateRoomForOwnerSession({
			runtimeRoot,
			ownerName,
			ownerSessionId: sessionId,
			cwd,
			ownerPid: process.pid,
			onCreate: async ({ roomDir, metadata }) => {
				await initializeOwnerRoomBoard(roomDir, metadata.roomId);
				await writeOwnerHeartbeatWithHook(roomDir, metadata.roomId, sessionId, beforeOwnerHeartbeatWrite);
			},
		});
		resolved = {
			roomDir: created.roomDir,
			metadata: created.metadata,
			created: created.created,
		};
	} else {
		const existing = await findOwnerRoomForRecovery(runtimeRoot, sessionId);
		if (!existing) {
			return null;
		}
		resolved = {
			roomDir: existing.roomDir,
			metadata: existing.metadata,
			created: false,
		};
	}

	let metadata = resolved.metadata;
	if (!resolved.created) {
		const refreshed = await refreshOwnerRoomForReuse(runtimeRoot, resolved.roomDir, sessionId, beforeOwnerHeartbeatWrite);
		if (!refreshed) {
			if (!allowCreate) {
				const existing = await findOwnerRoomForRecovery(runtimeRoot, sessionId);
				if (!existing) {
					return null;
				}
				const retried = await refreshOwnerRoomForReuse(runtimeRoot, existing.roomDir, sessionId, beforeOwnerHeartbeatWrite);
				if (!retried) {
					return null;
				}
				resolved = { roomDir: existing.roomDir, metadata: retried, created: false };
				metadata = retried;
			} else {
				const recreated = await findOrCreateRoomForOwnerSession({
					runtimeRoot,
					ownerName,
					ownerSessionId: sessionId,
					cwd,
					ownerPid: process.pid,
					onCreate: async ({ roomDir, metadata }) => {
						await initializeOwnerRoomBoard(roomDir, metadata.roomId);
						await writeOwnerHeartbeatWithHook(roomDir, metadata.roomId, sessionId, beforeOwnerHeartbeatWrite);
					},
				});
				resolved = {
					roomDir: recreated.roomDir,
					metadata: recreated.metadata,
					created: recreated.created,
				};
				metadata = recreated.created
					? recreated.metadata
					: await refreshOwnerRoomForReuse(runtimeRoot, recreated.roomDir, sessionId, beforeOwnerHeartbeatWrite) ?? null;
				if (!metadata) {
					return null;
				}
			}
		} else {
			metadata = refreshed;
		}
	}

	const activeRoom = options.setActiveRoom(options.createActiveRoom(resolved.roomDir, metadata, sessionId));
	return { activeRoom, created: resolved.created };
}

function scheduleStaleRoomReapOnce(
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	roomId: string,
	ownerSessionId: string,
): void {
	const key = `${runtimeRoot}:${ownerSessionId}`;
	if (pendingStaleRoomReaps.has(key)) {
		return;
	}
	const scheduled = Promise.resolve()
		.then(async () => {
			await reapStaleRooms(runtimeRoot, adapters, {
				heartbeatStaleMs: getOwnerHeartbeatStaleMs(),
				excludeRoomIds: new Set([roomId]),
				excludeOwnerSessionIds: new Set([ownerSessionId]),
			});
		})
		.catch((err) => { createRoomLogger(null, "owner-room").error("background stale room reap failed", { error: String(err) }); })
		.finally(() => {
			pendingStaleRoomReaps.delete(key);
		});
	pendingStaleRoomReaps.set(key, scheduled);
}

export async function ensureOwnerInfrastructure<T extends {
	role: "owner" | "member";
	roomDir: string;
	roomId: string;
	pollTimer: NodeJS.Timeout | null;
	heartbeatTimer: NodeJS.Timeout | null;
	proxyServer?: unknown;
	staleReapScheduled?: boolean;
}>(options: {
	pi: ExtensionAPI;
	runtimeRoot: string;
	sessionId: string;
	activeRoom: T | null;
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };
	startPolling: (pi: ExtensionAPI, adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter }, sessionId: string) => void;
	startOwnerHeartbeat: (
		sessionId: string,
		beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void,
	) => void;
	beforeOwnerHeartbeatWrite?: (context: { roomDir: string; roomId: string; sessionId: string }) => Promise<void> | void;
}): Promise<void> {
	const activeRoom = options.activeRoom;
	if (!activeRoom || activeRoom.role !== "owner") {
		return;
	}
	const log = createRoomLogger(activeRoom.roomDir, "room");
	await writeOwnerHeartbeatWithHook(activeRoom.roomDir, activeRoom.roomId, options.sessionId, options.beforeOwnerHeartbeatWrite).catch((err) => {
		log.error("failed to write initial owner heartbeat", { error: String(err) });
	});
	if (!activeRoom.proxyServer) {
		activeRoom.proxyServer = await ensureRoomProxy(activeRoom.roomDir).catch((err) => {
			log.error("failed to start mutation proxy", { error: String(err) });
			return undefined;
		});
		if (activeRoom.proxyServer) {
			log.info("mutation proxy started", { roomId: activeRoom.roomId });
		}
	}
	if (!activeRoom.pollTimer) {
		options.startPolling(options.pi, options.adapters, options.sessionId);
	}
	if (!activeRoom.heartbeatTimer) {
		options.startOwnerHeartbeat(options.sessionId, options.beforeOwnerHeartbeatWrite);
	}
	if (!activeRoom.staleReapScheduled) {
		activeRoom.staleReapScheduled = true;
		scheduleStaleRoomReapOnce(options.runtimeRoot, options.adapters, activeRoom.roomId, options.sessionId);
	}
}