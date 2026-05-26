/**
 * mutation-client.test.ts — Proxy Client Unit Tests
 *
 * Tests: normal request/response, degrade/reconnect state machine,
 * send timeout, PI_MUTATION_PROXY_DISABLE, disconnect cleanup.
 */

import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MutationClient } from "./mutation-client.ts";
import {
  encodeFrame,
  createFrameParser,
  type MutationCommand,
  type ProxyRequest,
  type ProxyResponse,
} from "./mutation-proxy-types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "room-client-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates a mock Unix socket server that echoes back responses.
 * The handler receives each ProxyRequest and must return a ProxyResponse
 * (or null to simulate timeout).
 */
async function createMockServer(
  tempDir: string,
  handler: (req: ProxyRequest) => ProxyResponse | null,
): Promise<{ socketPath: string; server: net.Server; getReceivedRequests: () => ProxyRequest[] }> {
  const socketPath = path.join(tempDir, "mock.sock");

  // Clean stale socket if exists
  await fs.unlink(socketPath).catch(() => {});

  const received: ProxyRequest[] = [];

  const server = net.createServer((socket) => {
    const parser = createFrameParser();
    parser.onFrame = (obj) => {
      const req = obj as ProxyRequest;
      received.push(req);
      const resp = handler(req);
      if (resp) {
        socket.write(encodeFrame(resp));
      }
      // If handler returns null, don't respond (simulate timeout)
    };

    socket.on("data", (chunk: Buffer) => parser.feed(chunk));
  });

  return new Promise((resolve, reject) => {
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        server,
        getReceivedRequests: () => [...received],
      });
    });
    server.on("error", reject);
  });
}

// ── 1. Normal Communication ─────────────────────────────────────────────────

describe("MutationClient normal communication", () => {
  let mockServer: net.Server;
  let mockSocketPath: string;
  let client: MutationClient;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "room-client-normal-"));
    // The client connects to roomDir/proxy.sock
    // We'll make the mock server listen on that exact path
    const roomDir = path.join(tempDir, "room");
    await fs.mkdir(path.join(roomDir, "logs"), { recursive: true });
    mockSocketPath = path.join(roomDir, "proxy.sock");

    const mock = await createMockServerOnPath(
      mockSocketPath,
      (req) => ({
        requestId: req.requestId,
        ok: true,
        value: { echoed: req.command.kind, id: req.requestId },
      }),
    );

    mockServer = mock.server;

    client = new MutationClient(roomDir);
    cleanup = async () => {
      client.disconnect();
      mockServer.close();
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  it("sends a command and receives response", async () => {
    await client.connect();
    expect(client.getState()).toBe("connected");

    const result = await client.send<{ echoed: string; id: string }>({
      kind: "append_message",
      payload: {
        message: {
          from: "owner",
          to: "worker",
          broadcast: false,
          replyTo: null,
          kind: "info",
          summary: "test",
        },
      },
    });

    expect(result).toEqual({ echoed: "append_message", id: expect.any(String) });
  });

  it("rejects when server responds with ok: false", async () => {
    // Create a new mock that returns errors
    mockServer.close();
    const mock = await createMockServerOnPath(mockSocketPath, (req) => ({
      requestId: req.requestId,
      ok: false,
      error: "simulated server error",
    }));
    mockServer = mock.server;

    // Reconnect with new mock
    client.disconnect();
    await client.connect();

    await expect(
      client.send({
        kind: "append_message",
        payload: {
          message: {
            from: "owner",
            to: "worker",
            broadcast: false,
            replyTo: null,
            kind: "info",
            summary: "should fail",
          },
        },
      }),
    ).rejects.toThrow("simulated server error");
  });
});

describe("MutationClient spawn protocol commands", () => {
  it("sends claim_member_session and finalize_member_runtime payloads unchanged", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "room-client-proto-"));
    const roomDir = path.join(tempDir, "room");
    await fs.mkdir(path.join(roomDir, "logs"), { recursive: true });
    const socketPath = path.join(roomDir, "proxy.sock");
    const received: ProxyRequest[] = [];

    const mock = await createMockServerOnPath(socketPath, (req) => {
      received.push(req);
      return {
        requestId: req.requestId,
        ok: true,
        value: req.command.kind,
      };
    });

    const client = new MutationClient(roomDir);
    const bootstrap = {
      version: 1,
      roomId: "room-client-proto",
      roomDir,
      memberName: "worker",
      memberType: "worker",
      ownerName: "owner",
      ownerSessionId: "client-proto-session",
      token: "client-proto-token",
      spawnTaskId: "spawn-client-proto",
    };

    await client.connect();

    await expect(
      client.send<string>({
        kind: "claim_member_session",
        payload: {
          bootstrap,
          sessionId: "member-session",
        },
      } as any),
    ).resolves.toBe("claim_member_session");

    await expect(
      client.send<string>({
        kind: "finalize_member_runtime",
        payload: {
          memberName: "worker",
          taskId: "spawn-client-proto",
          runtimeId: "agent-client-1",
          backend: "paseo",
        },
      } as any),
    ).resolves.toBe("finalize_member_runtime");

    expect(received.map((req) => req.command.kind)).toEqual([
      "claim_member_session",
      "finalize_member_runtime",
    ]);
    expect((received[0].command as any).payload.sessionId).toBe("member-session");
    expect((received[1].command as any).payload.runtimeId).toBe("agent-client-1");

    client.disconnect();
    mock.server.close();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
});

// ── 2. Degrade / Reconnect State Machine ─────────────────────────────────────

describe("MutationClient state machine", () => {
  it("transitions to degraded on disconnect and reconnects on server restart", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "room-client-sm-"));
    const roomDir = path.join(tempDir, "room");
    await fs.mkdir(path.join(roomDir, "logs"), { recursive: true });
    const socketPath = path.join(roomDir, "proxy.sock");

    // Track connections so we can close them
    const connections = new Set<net.Socket>();

    // Start first mock server
    let mockServer = net.createServer((socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
      const parser = createFrameParser();
      parser.onFrame = (obj) => {
        const req = obj as ProxyRequest;
        socket.write(
          encodeFrame({
            requestId: req.requestId,
            ok: true,
            value: "ok",
          }),
        );
      };
      socket.on("data", (chunk: Buffer) => parser.feed(chunk));
    });

    await new Promise<void>((resolve) => mockServer.listen(socketPath, resolve));

    const client = new MutationClient(roomDir);
    await client.connect();
    expect(client.getState()).toBe("connected");

    // Kill the server — also destroy all active connections
    for (const conn of connections) conn.destroy();
    mockServer.close();
    mockServer.unref();
    await sleep(200);

    // Client should transition to degraded when trying to send
    await expect(
      client.send({
        kind: "append_message",
        payload: {
          message: {
            from: "owner",
            to: "worker",
            broadcast: false,
            replyTo: null,
            kind: "info",
            summary: "after server death",
          },
        },
      }),
    ).rejects.toThrow();
    expect(client.getState()).not.toBe("connected");

    // Start new mock server
    const newConnections = new Set<net.Socket>();
    mockServer = net.createServer((socket) => {
      newConnections.add(socket);
      socket.on("close", () => newConnections.delete(socket));
      const parser = createFrameParser();
      parser.onFrame = (obj) => {
        const req = obj as ProxyRequest;
        socket.write(
          encodeFrame({
            requestId: req.requestId,
            ok: true,
            value: "restored",
          }),
        );
      };
      socket.on("data", (chunk: Buffer) => parser.feed(chunk));
    });

    await new Promise<void>((resolve) => mockServer.listen(socketPath, resolve));

    // Client should reconnect. Force a clean reconnect cycle.
    client.disconnect();
    await client.connect();
    expect(client.getState()).toBe("connected");

    // Now send should work again
    const result = await client.send<string>({
      kind: "append_message",
      payload: {
        message: {
          from: "owner",
          to: "worker",
          broadcast: false,
          replyTo: null,
          kind: "info",
          summary: "after reconnect",
        },
      },
    });
    expect(result).toBe("restored");

    client.disconnect();
    for (const conn of newConnections) conn.destroy();
    mockServer.close();

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("does not keep a background reconnect loop after blocking connect timeout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "room-client-blocking-timeout-"));
    const roomDir = path.join(tempDir, "room");
    await fs.mkdir(path.join(roomDir, "logs"), { recursive: true });
    const socketPath = path.join(roomDir, "proxy.sock");

    const client = new MutationClient(roomDir);
    await expect(client.connect({ retryTimeoutMs: 1200 })).rejects.toThrow(/Failed to connect to mutation proxy/i);
    expect(client.getState()).toBe("degraded");

    const mockServer = net.createServer((socket) => {
      const parser = createFrameParser();
      parser.onFrame = (obj) => {
        const req = obj as ProxyRequest;
        socket.write(
          encodeFrame({
            requestId: req.requestId,
            ok: true,
            value: "connected-later",
          }),
        );
      };
      socket.on("data", (chunk: Buffer) => parser.feed(chunk));
    });

    await new Promise<void>((resolve) => mockServer.listen(socketPath, resolve));
    await sleep(1500);
    expect(client.getState()).toBe("degraded");

    await client.connect();
    expect(client.getState()).toBe("connected");
    await expect(
      client.send<string>({
        kind: "append_message",
        payload: {
          message: {
            from: "owner",
            to: "worker",
            broadcast: false,
            replyTo: null,
            kind: "info",
            summary: "connected after explicit retry",
          },
        },
      }),
    ).resolves.toBe("connected-later");

    client.disconnect();
    mockServer.close();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
});

// ── 3. Send Timeout ─────────────────────────────────────────────────────────

describe("MutationClient send timeout", () => {
  it("rejects with timeout error after SEND_TIMEOUT_MS (5s)", { timeout: 10000 }, async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "room-client-to-"));
    const roomDir = path.join(tempDir, "room");
    await fs.mkdir(path.join(roomDir, "logs"), { recursive: true });
    const socketPath = path.join(roomDir, "proxy.sock");

    // Create a mock server that never responds
    const mockServer = net.createServer((socket) => {
      const parser = createFrameParser();
      parser.onFrame = (_obj) => {
        // Intentionally never respond — simulate hung server
      };
      socket.on("data", (chunk: Buffer) => parser.feed(chunk));
    });

    await new Promise<void>((resolve) => mockServer.listen(socketPath, resolve));

    const client = new MutationClient(roomDir);
    await client.connect();

    const start = Date.now();
    await expect(
      client.send({
        kind: "append_message",
        payload: {
          message: {
            from: "owner",
            to: "worker",
            broadcast: false,
            replyTo: null,
            kind: "info",
            summary: "timeout test",
          },
        },
      }),
    ).rejects.toThrow(/timeout/i);

    const elapsed = Date.now() - start;
    // Should be around 5000ms
    expect(elapsed).toBeGreaterThanOrEqual(4500);
    expect(elapsed).toBeLessThan(6000);

    client.disconnect();
    mockServer.close();

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
});

// ── 4. PI_MUTATION_PROXY_DISABLE ────────────────────────────────────────────

describe("MutationClient PI_MUTATION_PROXY_DISABLE", () => {
  const originalEnv = process.env.PI_MUTATION_PROXY_DISABLE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PI_MUTATION_PROXY_DISABLE = originalEnv;
    } else {
      delete process.env.PI_MUTATION_PROXY_DISABLE;
    }
  });

  it("stays in degraded state when PI_MUTATION_PROXY_DISABLE=1", async () => {
    process.env.PI_MUTATION_PROXY_DISABLE = "1";

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "room-client-dis-"));
    const roomDir = path.join(tempDir, "room");
    await fs.mkdir(path.join(roomDir, "logs"), { recursive: true });

    const client = new MutationClient(roomDir);
    await client.connect();

    // Should still be degraded
    expect(client.getState()).toBe("degraded");

    // Send should reject
    await expect(
      client.send({
        kind: "append_message",
        payload: {
          message: {
            from: "owner",
            to: "worker",
            broadcast: false,
            replyTo: null,
            kind: "info",
            summary: "disabled test",
          },
        },
      }),
    ).rejects.toThrow(/unavailable/i);

    client.disconnect();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("normal operation when PI_MUTATION_PROXY_DISABLE is not set", async () => {
    delete process.env.PI_MUTATION_PROXY_DISABLE;

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "room-client-enb-"));
    const roomDir = path.join(tempDir, "room");
    await fs.mkdir(path.join(roomDir, "logs"), { recursive: true });
    const socketPath = path.join(roomDir, "proxy.sock");

    const mockServer = net.createServer((socket) => {
      const parser = createFrameParser();
      parser.onFrame = (obj) => {
        const req = obj as ProxyRequest;
        socket.write(
          encodeFrame({ requestId: req.requestId, ok: true, value: "enabled" }),
        );
      };
      socket.on("data", (chunk: Buffer) => parser.feed(chunk));
    });

    await new Promise<void>((resolve) => mockServer.listen(socketPath, resolve));

    const client = new MutationClient(roomDir);
    await client.connect();
    expect(client.getState()).toBe("connected");

    const result = await client.send<string>({
      kind: "append_message",
      payload: {
        message: {
          from: "owner",
          to: "worker",
          broadcast: false,
          replyTo: null,
          kind: "info",
          summary: "enabled test",
        },
      },
    });
    expect(result).toBe("enabled");

    client.disconnect();
    mockServer.close();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
});

// ── 5. disconnect Resource Cleanup ───────────────────────────────────────────

describe("MutationClient disconnect cleanup", () => {
  it("rejects all pending requests on disconnect", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "room-client-dc-"));
    const roomDir = path.join(tempDir, "room");
    await fs.mkdir(path.join(roomDir, "logs"), { recursive: true });
    const socketPath = path.join(roomDir, "proxy.sock");

    // Create a mock server that never responds
    const mockServer = net.createServer((socket) => {
      const parser = createFrameParser();
      parser.onFrame = (_obj) => {
        // Don't respond
      };
      socket.on("data", (chunk: Buffer) => parser.feed(chunk));
    });

    await new Promise<void>((resolve) => mockServer.listen(socketPath, resolve));

    const client = new MutationClient(roomDir);
    await client.connect();

    // Fire off a request (don't await — it will hang)
    const sendPromise = client.send({
      kind: "append_message",
      payload: {
        message: {
          from: "owner",
          to: "worker",
          broadcast: false,
          replyTo: null,
          kind: "info",
          summary: "pending test",
        },
      },
    });

    // Disconnect immediately
    await sleep(50);
    client.disconnect();

    // The pending request should be rejected
    await expect(sendPromise).rejects.toThrow(/disconnected/i);
    expect(client.getState()).toBe("degraded");

    mockServer.close();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
});

// ── Helper for creating mock server on a specific path ───────────────────────

async function createMockServerOnPath(
  socketPath: string,
  handler: (req: ProxyRequest) => ProxyResponse | null,
): Promise<{ server: net.Server }> {
  await fs.unlink(socketPath).catch(() => {});

  const server = net.createServer((socket) => {
    const parser = createFrameParser();
    parser.onFrame = (obj) => {
      const req = obj as ProxyRequest;
      const resp = handler(req);
      if (resp) {
        socket.write(encodeFrame(resp));
      }
    };
    socket.on("data", (chunk: Buffer) => parser.feed(chunk));
  });

  return new Promise((resolve, reject) => {
    server.listen(socketPath, () => resolve({ server }));
    server.on("error", reject);
  });
}
