import * as net from "node:net";
import { randomUUID } from "node:crypto";
import {
	encodeFrame,
	createFrameParser,
	getProxySocketPath,
	PROXY_PROTOCOL_VERSION,
	type FrameParser,
	type MutationCommand,
	type ProxyRequest,
	type ProxyResponse,
} from "./mutation-proxy-types.ts";
import { createRoomLogger } from "./logger.ts";

const SEND_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 5000;
const DEGRADE_CONSECUTIVE_TIMEOUTS = 2;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_MULTIPLIER = 2;
const RECONNECT_OVERALL_TIMEOUT_MS = 30000;

export type ClientState = "connected" | "degraded" | "reconnecting";

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (reason: unknown) => void;
	timer: NodeJS.Timeout;
}

/**
 * MutationClient — agent-side proxy client for sending mutation commands
 * to the owner process via Unix domain socket.
 *
 * State machine (reviewer Finding 3):
 *   CONNECTED ──(2 consecutive timeouts / disconnect)──→ DEGRADED
 *   DEGRADED  ──(exponential backoff: 1s,2s,4s,max 30s)──→ RECONNECTING
 *   RECONNECTING ──(success)──→ CONNECTED
 *   RECONNECTING ──(30s overall timeout)──→ DEGRADED (keeps retrying)
 *
 * When PI_MUTATION_PROXY_DISABLE=1, the client stays in DEGRADED permanently.
 */
export class MutationClient {
	private roomDir: string;
	private state: ClientState = "degraded";
	private socket: net.Socket | null = null;
	private frameParser: FrameParser | null = null;
	private pending = new Map<string, PendingRequest>();
	private consecutiveTimeouts = 0;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private reconnectDelay = RECONNECT_BASE_DELAY_MS;
	private reconnectStartedAt = 0;
	private log: ReturnType<typeof createRoomLogger>;

	constructor(roomDir: string) {
		this.roomDir = roomDir;
		this.log = createRoomLogger(roomDir, "mutation-client");
	}

	/** Returns the current state of the client. */
	getState(): ClientState {
		return this.state;
	}

	/**
	 * Connect to the mutation proxy Unix socket.
	 *
	 * @param options.retryTimeoutMs - If > 0, retry with exponential backoff
	 *   until connected or timeout. Default 0 (single attempt, legacy behavior).
	 *
	 * Resolves on successful connection. On single-attempt failure, rejects
	 * and starts background reconnection. On retry timeout, throws.
	 * If already connected, returns immediately.
	 * If PI_MUTATION_PROXY_DISABLE=1, stays degraded.
	 */
	async connect(options?: { retryTimeoutMs?: number }): Promise<void> {
		if (process.env.PI_MUTATION_PROXY_DISABLE === "1") {
			this.state = "degraded";
			this.log.warn("mutation proxy disabled via env, staying degraded");
			return;
		}

		if (this.state === "connected" && this.socket && !this.socket.destroyed) {
			return;
		}

		const retryTimeoutMs = options?.retryTimeoutMs ?? 0;
		if (retryTimeoutMs > 0) {
			return this.connectWithRetry(retryTimeoutMs);
		}

		return this.connectOnce({ startReconnectOnFailure: true });
	}

	/**
	 * Single connection attempt. Rejects on failure; caller may retry.
	 * On failure, starts background reconnection via startReconnect().
	 *
	 * If already connected (e.g. background reconnect succeeded between
	 * explicit retry attempts in connectWithRetry), returns immediately
	 * without destroying the working connection.
	 */
	private connectOnce(options?: { startReconnectOnFailure?: boolean }): Promise<void> {
		// Avoid a race where connectWithRetry's explicit retry destroys a
		// socket that the background reconnect just established. If we are
		// already connected, return immediately — no need to reconnect.
		if (this.state === "connected" && this.socket && !this.socket.destroyed) {
			return Promise.resolve();
		}

		const socketPath = getProxySocketPath(this.roomDir);
		const startReconnectOnFailure = options?.startReconnectOnFailure ?? true;
		this.stopReconnect();
		this.state = "reconnecting";
		this.cleanupSocket();

		return new Promise<void>((resolve, reject) => {
			const socket = net.createConnection(socketPath);
			this.socket = socket;

			const connectTimer = setTimeout(() => {
				socket.destroy();
				reject(new Error(`Connect timeout to ${socketPath}`));
			}, CONNECT_TIMEOUT_MS);

			const fp = createFrameParser();
			this.frameParser = fp;
			fp.onFrame = (obj: unknown) => {
				this.handleFrame(obj);
			};

			socket.on("data", (chunk: Buffer) => {
				fp.feed(chunk);
			});

			socket.on("connect", () => {
				clearTimeout(connectTimer);
				this.state = "connected";
				this.consecutiveTimeouts = 0;
				this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
				this.reconnectStartedAt = 0;
				this.log.info("connected to proxy", { socketPath });
				resolve();
			});

			socket.on("error", (err: Error) => {
				clearTimeout(connectTimer);
				this.state = "degraded";
				this.cleanupSocket();
				this.log.warn("connect error", { socketPath, error: String(err) });
				reject(err);
				// Start background reconnection
				if (startReconnectOnFailure) {
					this.startReconnect();
				}
			});

			socket.on("close", () => {
				clearTimeout(connectTimer);
				if (this.state === "connected") {
					this.handleDisconnect();
				}
			});
		});
	}

	/**
	 * Retry connectOnce() with exponential backoff until connected or timeout.
	 * Throws on overall timeout.
	 */
	private async connectWithRetry(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		let delay = RECONNECT_BASE_DELAY_MS;
		let lastError: unknown;

		while (Date.now() < deadline) {
			try {
				await this.connectOnce({ startReconnectOnFailure: false });
				return; // Connected successfully
			} catch (err) {
				lastError = err;
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				this.log.warn("connect attempt failed, retrying", {
					error: String(err),
					nextDelayMs: Math.min(delay, remaining),
					remainingMs: Math.max(0, remaining),
				});
				await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
				delay = Math.min(delay * RECONNECT_MULTIPLIER, RECONNECT_MAX_DELAY_MS);
			}
		}

		this.stopReconnect();
		this.cleanupSocket();
		this.state = "degraded";
		const msg = `Failed to connect to mutation proxy after ${timeoutMs}ms` +
			(lastError ? `: ${String(lastError)}` : "");
		throw new Error(msg);
	}

	/**
	 * Send a mutation command through the proxy.
	 *
	 * In CONNECTED state: encodes the request as a length-prefixed frame,
	 * sends it over the Unix socket, and returns the deserialized response.
	 *
	 * In DEGRADED or RECONNECTING state: rejects immediately.
	 * The caller (storage.ts integration) should fall back to file lock.
	 *
	 * @param command - The mutation command name (e.g. "append_message")
	 * @param payload - Command-specific payload (must be JSON-serializable)
	 * @returns The deserialized return value from the proxy server
	 */
	send<T>(command: MutationCommand): Promise<T> {
		if (this.state === "degraded" || this.state === "reconnecting") {
			return Promise.reject(
				new Error(`Mutation proxy unavailable (state: ${this.state})`),
			);
		}

		if (!this.socket || this.socket.destroyed) {
			this.handleDisconnect();
			return Promise.reject(new Error("No active proxy connection"));
		}

		const requestId = randomUUID();
		const request: ProxyRequest = { requestId, command, protocolVersion: PROXY_PROTOCOL_VERSION };

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				this.consecutiveTimeouts++;
				this.log.warn("send timeout", {
					requestId,
					command,
					consecutiveTimeouts: this.consecutiveTimeouts,
				});

				if (this.consecutiveTimeouts >= DEGRADE_CONSECUTIVE_TIMEOUTS) {
					this.handleDisconnect();
				}

				reject(new Error(`Request timeout (${SEND_TIMEOUT_MS}ms)`));
			}, SEND_TIMEOUT_MS);

			this.pending.set(requestId, { resolve, reject, timer });

			try {
				const frame = encodeFrame(request);
				this.socket!.write(frame);
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(requestId);
				this.handleDisconnect();
				reject(err);
			}
		});
	}

	/**
	 * Gracefully disconnect from the proxy.
	 * Cleans up socket, frame parser, pending requests, and reconnect timers.
	 */
	disconnect(): void {
		this.stopReconnect();
		this.rejectAllPending(new Error("Client disconnected"));
		this.cleanupSocket();
		this.state = "degraded";
		this.reconnectStartedAt = 0;
		this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
	}

	/** Handle an incoming frame from the socket. */
	private handleFrame(obj: unknown): void {
		const response = obj as ProxyResponse;
		if (!response || typeof response.requestId !== "string") return;

		const pendingReq = this.pending.get(response.requestId);
		if (!pendingReq) return;

		this.pending.delete(response.requestId);
		clearTimeout(pendingReq.timer);

		if (response.ok) {
			pendingReq.resolve(response.value);
		} else {
			const err = new Error(response.error ?? "Unknown proxy error");
			(err as NodeJS.ErrnoException).code = response.code || "PROXY_ERROR";
			pendingReq.reject(err);
		}
	}

	/**
	 * Handle unexpected socket disconnect while in CONNECTED state.
	 * Transitions to DEGRADED, rejects all in-flight requests, starts reconnection.
	 */
	private handleDisconnect(): void {
		if (this.state !== "connected") return;
		this.state = "degraded";
		this.log.warn("socket disconnected, entering degraded mode");
		this.rejectAllPending(new Error("Proxy disconnected"));
		this.cleanupSocket();
		this.startReconnect();
	}

	/**
	 * Start exponential backoff reconnection.
	 * Transitions through DEGRADED → RECONNECTING → CONNECTED on success,
	 * or RECONNECTING → DEGRADED (retry) on overall timeout.
	 */
	private startReconnect(): void {
		if (this.reconnectTimer || process.env.PI_MUTATION_PROXY_DISABLE === "1") return;
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		this.stopReconnect();
		// Stay in DEGRADED while waiting for the timer
		this.reconnectStartedAt = this.reconnectStartedAt || Date.now();

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.state = "reconnecting";
			this.log.info("attempting reconnection", { delay: this.reconnectDelay });

			const socketPath = getProxySocketPath(this.roomDir);
			this.cleanupSocket();

			const socket = net.createConnection(socketPath);
			this.socket = socket;

			const connectTimer = setTimeout(() => {
				socket.destroy();
			}, CONNECT_TIMEOUT_MS);

			const fp = createFrameParser();
			this.frameParser = fp;
			fp.onFrame = (obj: unknown) => {
				this.handleFrame(obj);
			};

			socket.on("data", (chunk: Buffer) => {
				fp.feed(chunk);
			});

			socket.on("connect", () => {
				clearTimeout(connectTimer);
				this.state = "connected";
				this.consecutiveTimeouts = 0;
				this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
				this.reconnectStartedAt = 0;
				this.log.info("reconnection successful");
			});

			socket.on("error", (err: Error) => {
				clearTimeout(connectTimer);
				this.cleanupSocket();
				this.log.warn("reconnection failed", { error: String(err) });

				const elapsed = Date.now() - this.reconnectStartedAt;
				if (elapsed >= RECONNECT_OVERALL_TIMEOUT_MS) {
					// Overall timeout reached — go back to DEGRADED, reset
					// counters, and schedule the next retry cycle.
					this.state = "degraded";
					this.reconnectStartedAt = 0;
					this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
					this.log.warn("reconnect overall timeout, staying degraded, will retry");
				} else {
					this.reconnectDelay = Math.min(
						this.reconnectDelay * RECONNECT_MULTIPLIER,
						RECONNECT_MAX_DELAY_MS,
					);
				}
				this.scheduleReconnect();
			});

			socket.on("close", () => {
				clearTimeout(connectTimer);
				// If we didn't reach CONNECTED, treat as failure
				if (this.state === "reconnecting") {
					// The error handler above already handles the retry logic,
					// but if close fires without error, trigger error handling.
					this.cleanupSocket();

					const elapsed = Date.now() - this.reconnectStartedAt;
					if (elapsed >= RECONNECT_OVERALL_TIMEOUT_MS) {
						this.state = "degraded";
						this.reconnectStartedAt = 0;
						this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
					} else {
						this.reconnectDelay = Math.min(
							this.reconnectDelay * RECONNECT_MULTIPLIER,
							RECONNECT_MAX_DELAY_MS,
						);
					}
					this.scheduleReconnect();
				}
			});
		}, this.reconnectDelay);
	}

	private stopReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private rejectAllPending(reason: unknown): void {
		for (const [, pendingReq] of this.pending) {
			clearTimeout(pendingReq.timer);
			pendingReq.reject(reason);
		}
		this.pending.clear();
	}

	private cleanupSocket(): void {
		if (this.socket) {
			this.socket.removeAllListeners();
			if (!this.socket.destroyed) {
				this.socket.destroy();
			}
			this.socket = null;
		}
		this.frameParser = null;
	}
}

/**
 * Factory function to create a MutationClient instance.
 * @param roomDir - Path to the room directory
 * @param runtimeRoot - Path to the runtime root (reserved for future use)
 */
export function createMutationClient(
	roomDir: string,
): MutationClient {
	return new MutationClient(roomDir);
}
