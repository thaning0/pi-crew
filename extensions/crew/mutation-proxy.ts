/**
 * Mutation Proxy Server
 *
 * Runs in the owner process. Accepts Unix domain socket connections from
 * agent processes and serializes all room writes through a p-queue
 * (concurrency=1), eliminating file-lock contention.
 *
 * Agents connect → send ProxyRequest frames (length-prefixed JSON) →
 * server queues them serially → executes storage mutations → responds
 * with ProxyResponse frames.
 */

import * as net from "node:net";
import * as fs from "node:fs/promises";
import PQueue, { TimeoutError } from "p-queue";
import {
  type ProxyRequest,
  type ProxyResponse,
  type MutationCommand,
  type SpawnAgentPayload,
  createFrameParser,
  encodeFrame,
  getProxySocketPath,
  PROXY_PROTOCOL_VERSION,
} from "./mutation-proxy-types.ts";
import {
  appendMessage,
  updateRoomMemberState,
  writeRoomMetadata,
  claimMemberSession,
  finalizeMemberRuntime,
  markMemberJoined,
  createSpawningMember,
  createSpawnJob,
  writeSpawnJob,
  updateSpawnJob,
  deleteRoomMemberState,
  emitCrewTerminatedOutcome,
  loadRoomMemberState,
  writeRoomMemberState,
  formatMemberLabel,
  runInsideProxyContext,
} from "./storage.ts";
import { createRoomLogger } from "./logger.ts";
import { RoomError, ValidationError } from "./errors.ts";
import type { RoomSpawnJobState } from "./types.ts";
import { recordTerminalTaskState } from "./task-terminal.ts";

const MAX_QUEUE_SIZE = 100;
const SHUTDOWN_TIMEOUT_MS = 10_000;

export class MutationProxyServer {
  private readonly roomDir: string;
  private readonly socketPath: string;
  private readonly queue: PQueue;
  private readonly logger: ReturnType<typeof createRoomLogger>;
  private server: net.Server | null = null;
  private readonly connections = new Set<net.Socket>();
  private accepting = false;
  private spawnHandler: ((payload: SpawnAgentPayload) => Promise<void>) | null = null;

  constructor(roomDir: string) {
    this.roomDir = roomDir;
    this.socketPath = getProxySocketPath(roomDir);
    this.queue = new PQueue({
      concurrency: 1,
      timeout: 10_000,
    });
    this.logger = createRoomLogger(roomDir, "mutation-proxy");
  }

  // -----------------------------------------------------------------------
  // Public: enqueue arbitrary fn through the serial queue (owner short-circuit)
  // -----------------------------------------------------------------------

  /**
   * Enqueue a function through the serial mutation queue.
   * Used by `withRoomMutationLock` on the owner process to replace
   * file-lock serialization with p-queue serialization.
   */
  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return await this.queue.add(fn) as T;
  }

  // -----------------------------------------------------------------------
  // Handler Registration
  // -----------------------------------------------------------------------

  setSpawnHandler(handler: (payload: SpawnAgentPayload) => Promise<void>): void {
    this.spawnHandler = handler;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    // Clean up stale socket file from previous run
    await fs.unlink(this.socketPath).catch(() => {});

    return new Promise<void>((resolve, reject) => {
      this.server = net.createServer(
        { allowHalfOpen: false },
        (socket) => this.handleConnection(socket),
      );

      this.server.on("error", (err) => {
        this.logger.error("proxy server error", { error: String(err) });
        reject(err);
      });

      this.server.listen(this.socketPath, 32, () => {
        fs.chmod(this.socketPath, 0o600)
          .then(() => {
            this.accepting = true;
            this.logger.info("mutation proxy started", {
              socketPath: this.socketPath,
            });
            resolve();
          })
          .catch((err) => {
            reject(err);
          });
      });
    });
  }

  async stop(): Promise<void> {
    this.logger.info("mutation proxy stopping");
    this.accepting = false;

    // Reject any new connection attempts
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();

    // Wait for queued operations to finish (max 10s)
    try {
      const drained = new Promise<void>((resolve) => {
        const check = () => {
          if (this.queue.size === 0 && this.queue.pending === 0) resolve();
          else setTimeout(check, 50);
        };
        check();
      });
      await Promise.race([drained, new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))]);
    } catch {
      this.logger.warn("queue did not drain before shutdown timeout");
    }

    // Stop accepting and close server
    if (this.server) {
      this.queue.pause();
      this.queue.clear();

      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });

      // Clean up socket file
      await fs.unlink(this.socketPath).catch(() => {});
      this.server = null;
    }

    this.logger.info("mutation proxy stopped");
  }

  // -----------------------------------------------------------------------
  // Connection handling
  // -----------------------------------------------------------------------

  private handleConnection(socket: net.Socket): void {
    if (!this.accepting) {
      socket.destroy();
      return;
    }

    this.connections.add(socket);
    this.logger.debug("proxy client connected");

    const parser = createFrameParser();
    parser.onFrame = (obj) => {
      const request = obj as ProxyRequest;
      this.handleRequest(request, socket);
    };

    socket.on("data", (chunk: Buffer) => {
      try {
        parser.feed(chunk);
      } catch (err) {
        this.logger.warn("frame parse error", { error: String(err) });
        const response: ProxyResponse = {
          requestId: "unknown",
          ok: false,
          error: `Frame parse error: ${err instanceof Error ? err.message : String(err)}`,
        };
        this.sendResponse(socket, response);
      }
    });

    socket.on("close", () => {
      this.connections.delete(socket);
      this.logger.debug("proxy client disconnected");
    });

    socket.on("error", (err) => {
      this.logger.warn("proxy client socket error", { error: String(err) });
      this.connections.delete(socket);
    });
  }

  // -----------------------------------------------------------------------
  // Request processing
  // -----------------------------------------------------------------------

  private async handleRequest(
    request: ProxyRequest,
    socket: net.Socket,
  ): Promise<void> {
    // Validate protocol version
    if (request.protocolVersion !== PROXY_PROTOCOL_VERSION) {
      const response: ProxyResponse = {
        requestId: request.requestId,
        ok: false,
        error: `Unsupported protocol version ${request.protocolVersion}. Expected ${PROXY_PROTOCOL_VERSION}.`,
      };
      this.sendResponse(socket, response);
      return;
    }

    // Backpressure: reject if queue is too deep
    if (this.queue.size + this.queue.pending > MAX_QUEUE_SIZE) {
      const response: ProxyResponse = {
        requestId: request.requestId,
        ok: false,
        error: `Server busy: queue depth ${this.queue.size + this.queue.pending} exceeds limit ${MAX_QUEUE_SIZE}.`,
      };
      this.sendResponse(socket, response);
      return;
    }

    try {
      const result = await this.queue.add(async () => {
        return await runInsideProxyContext(() => this.executeCommand(request.command));
      });

      const response: ProxyResponse = {
        requestId: request.requestId,
        ok: true,
        value: result,
      };
      this.sendResponse(socket, response);
    } catch (err) {
      const code = (err instanceof RoomError) ? err.code : undefined;
      const message =
        err instanceof TimeoutError
          ? "Request timed out (>10s)"
          : err instanceof Error
            ? err.message
            : String(err);

      const response: ProxyResponse = {
        requestId: request.requestId,
        ok: false,
        error: message,
        code,
      };
      this.sendResponse(socket, response);
    }
  }

  // -----------------------------------------------------------------------
  // Response dispatch
  // -----------------------------------------------------------------------

  private sendResponse(socket: net.Socket, response: ProxyResponse): void {
    if (socket.destroyed) return;
    try {
      socket.write(encodeFrame(response));
    } catch (err) {
      this.logger.warn("failed to send response", {
        requestId: response.requestId,
        error: String(err),
      });
    }
  }

  // -----------------------------------------------------------------------
  // Command dispatch
  // -----------------------------------------------------------------------

  private async executeCommand(command: MutationCommand): Promise<unknown> {
    switch (command.kind) {
      case "append_message": {
        const msg = await appendMessage(
          this.roomDir,
          command.payload.message,
        );
        this.logger.debug("append_message done", {
          seq: msg.seq,
          id: msg.id,
        });
        return msg;
      }

      case "update_member": {
        const { memberName, patch } = command.payload;
        const updated = await updateRoomMemberState(
          this.roomDir,
          memberName,
          patch,
        );
        this.logger.debug("update_member done", { memberName });
        return updated;
      }

      case "write_metadata": {
        await writeRoomMetadata(this.roomDir, command.payload.metadata);
        this.logger.debug("write_metadata done");
        return undefined;
      }

      case "claim_member_session": {
        const result = await claimMemberSession(command.payload);
        if (result.backend === "paseo" && result.runtimeId && result.spawnTaskId) {
          const finalized = await finalizeMemberRuntime({
            roomDir: this.roomDir,
            memberName: result.name,
            taskId: result.spawnTaskId,
            runtimeId: result.runtimeId,
            backend: result.backend,
          });
          this.logger.debug("claim_member_session auto-finalized", {
            memberName: finalized.member.name,
            taskId: finalized.job.taskId,
          });
          return {
            ...finalized.member,
            claimedEvent: result.claimedEvent,
            activatedEvent: result.activatedEvent,
          };
        }
        this.logger.debug("claim_member_session done", {
          memberName: result.name,
        });
        return result;
      }

      case "finalize_member_runtime": {
        const result = await finalizeMemberRuntime({
          roomDir: this.roomDir,
          ...command.payload,
        });
        this.logger.debug("finalize_member_runtime done", {
          memberName: result.member.name,
          taskId: result.job.taskId,
        });
        return result;
      }

      case "mark_member_joined": {
        const result = await markMemberJoined(command.payload);
        if (result.backend === "paseo" && result.runtimeId && result.spawnTaskId) {
          const finalized = await finalizeMemberRuntime({
            roomDir: this.roomDir,
            memberName: result.name,
            taskId: result.spawnTaskId,
            runtimeId: result.runtimeId,
            backend: result.backend,
          });
          this.logger.debug("mark_member_joined auto-finalized", {
            memberName: finalized.member.name,
            taskId: finalized.job.taskId,
          });
          return {
            ...finalized.member,
            claimedEvent: result.claimedEvent,
            activatedEvent: result.activatedEvent,
          };
        }
        this.logger.debug("mark_member_joined done", {
          memberName: result.name,
        });
        return result;
      }

      case "create_spawning_member": {
        if (!command.payload.displayName) {
          throw new ValidationError("create_spawning_member requires displayName so the owner can reserve a unique internal member identity.");
        }
        const result = await createSpawningMember(
          this.roomDir,
          command.payload,
        );
        this.logger.debug("create_spawning_member done", {
          memberName: result.member.name,
        });
        return result;
      }

      case "create_spawn_job": {
        const { state, ...rest } = command.payload;
        const result = await createSpawnJob(this.roomDir, {
          ...rest,
          state: state as RoomSpawnJobState,
        });
        this.logger.debug("create_spawn_job done", {
          taskId: result.taskId,
        });
        return result;
      }

      case "write_spawn_job": {
        await writeSpawnJob(this.roomDir, command.payload.job);
        this.logger.debug("write_spawn_job done", {
          taskId: command.payload.job.taskId,
        });
        return undefined;
      }

      case "update_spawn_job": {
        const { taskId, patch } = command.payload;
        const result = await updateSpawnJob(
          this.roomDir,
          taskId,
          patch,
        );
        this.logger.debug("update_spawn_job done", { taskId });
        return result;
      }

      case "delete_member": {
        await deleteRoomMemberState(
          this.roomDir,
          command.payload.memberName,
        );
        this.logger.debug("delete_member done", {
          memberName: command.payload.memberName,
        });
        return undefined;
      }

      case "notify_deps": {
        await recordTerminalTaskState({
          roomDir: this.roomDir,
          upstreamSeq: command.payload.upstreamSeq,
          taskMessageId: command.payload.taskMessageId,
          status: command.payload.status,
          logContext: {
            upstreamSeq: command.payload.upstreamSeq,
            source: "mutation-proxy",
          },
        });
        return undefined;
      }

      case "remove_transient_member": {
        const { memberName, taskSummary, replyKind, errorSummary } = command.payload;
        const member = await loadRoomMemberState(this.roomDir, memberName).catch(() => null);
        if (!member || member.state === "removed") {
          this.logger.debug("remove_transient_member skipped (already removed)", { memberName });
          return undefined;
        }
        // Cancel spawn job if still pending
        if (member.spawnTaskId) {
          await updateSpawnJob(this.roomDir, member.spawnTaskId, {
            state: "cancelled",
            error: null,
          }).catch((err) => {
            this.logger.warn("remove_transient_member cancel spawn job failed", { memberName, error: String(err) });
          });
        }
        // Write "removed" state
        await writeRoomMemberState(this.roomDir, {
          ...member,
          state: "removed",
          lastCompletedTask: replyKind === "completion" ? taskSummary : member.lastCompletedTask,
          lastError: replyKind === "error" ? (errorSummary ?? taskSummary) : member.lastError,
          currentTask: null,
          currentTaskMessageId: null,
          runtimeId: null,
          sessionId: null,
          chatBusy: null,
          spawnTaskId: null,
          spawnBatchId: null,
          todoProgress: null,
          updatedAt: new Date().toISOString(),
        });
        await emitCrewTerminatedOutcome({
          roomDir: this.roomDir,
          requestId: member.requestId ?? undefined,
          spawnTaskId: member.spawnTaskId ?? undefined,
          memberName,
          reason: "transient_removed",
        }).catch((err) =>
          this.logger.error("failed to emit transient terminal outcome", {
            memberName,
            error: String(err),
          }),
        );
        // Board notification
        const memberLabel = formatMemberLabel(member);
        await appendMessage(this.roomDir, {
          from: "system",
          to: "room",
          replyTo: null,
          kind: "info",
          summary: `Transient agent ${memberLabel} completed and was removed.`,
          broadcast: false,
        });
        this.logger.info("remove_transient_member done", { memberName });
        return undefined;
      }

      case "spawn_agent": {
        if (!this.spawnHandler) {
          throw new Error("spawn_agent handler not registered");
        }
        // Fire-and-forget: spawn is async and may take >10s (process creation,
        // bootstrap claim, finalization). Blocking the PQueue for the full
        // duration causes the agent's MutationClient send() to time out
        // (SEND_TIMEOUT_MS). The agent only needs to know the command was
        // received; the spawned explorer reports results independently via the
        // board (crew_messages).
        this.spawnHandler(command.payload).catch((err) => {
          this.logger.error("spawn_agent background handler failed", { error: String(err) });
        });
        return undefined;
      }

      case "run_locked_fn": {
        // Placeholder for agent-side generic fn execution via proxy.
        // Currently, generic fn() cannot be serialized over the socket,
        // so agent processes fall back to file locks for `withRoomMutationLock`.
        // This command is reserved for future use where known fnIds can be dispatched.
        this.logger.warn("run_locked_fn not supported via proxy socket", {
          fnId: command.payload.fnId,
        });
        throw new Error(
          `run_locked_fn (${command.payload.fnId}) is not supported via proxy socket. Use specific mutation commands instead.`,
        );
      }

      default: {
        const _exhaustive: never = command;
        throw new Error(`Unknown command: ${(_exhaustive as MutationCommand).kind}`);
      }
    }
  }
}

// -----------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------

export function createMutationProxy(roomDir: string): MutationProxyServer {
  return new MutationProxyServer(roomDir);
}
