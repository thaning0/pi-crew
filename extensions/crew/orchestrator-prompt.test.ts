import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetActiveRoomsForTests, setActiveRoom } from "./lifecycle.ts";

type RegisteredHandler = (event: unknown, ctx?: unknown) => unknown;

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crew-orchestrator-prompt-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

async function writePrompt(rootDir: string, relativePath: string, content: string): Promise<void> {
	const filePath = path.join(rootDir, relativePath);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf8");
}

function createHarness(
	roomExtension: typeof import("./index.ts").default,
	allTools: any[] = [],
) {
	const lifecycleHandlers = new Map<string, RegisteredHandler>();
	const pi = {
		events: {
			on: vi.fn(),
			emit: vi.fn(async () => undefined),
		},
		on: vi.fn((name: string, handler: RegisteredHandler) => {
			lifecycleHandlers.set(name, handler);
		}),
		registerTool: vi.fn(),
		sendMessage: vi.fn(),
		setActiveTools: vi.fn(),
		getAllTools: vi.fn(() => allTools),
		getThinkingLevel: vi.fn(),
	} as any;
	roomExtension(pi, {});
	return { lifecycleHandlers, pi };
}

function setOwnerRoom(sessionId: string): void {
	setActiveRoom({
		role: "owner",
		roomDir: "/tmp/room",
		roomId: "room-1",
		memberName: "lead",
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

async function invokeBeforeAgentStart(
	lifecycleHandlers: Map<string, RegisteredHandler>,
	options: { cwd: string; sessionId: string; systemPrompt?: string },
): Promise<string> {
	const beforeAgentStart = lifecycleHandlers.get("before_agent_start");
	expect(beforeAgentStart).toBeTypeOf("function");
	const systemPrompt = options.systemPrompt ?? "BASE SYSTEM PROMPT";
	const result = await beforeAgentStart?.(
		{ systemPrompt },
		{
			cwd: options.cwd,
			getSystemPrompt: () => systemPrompt,
			sessionManager: { getSessionId: () => options.sessionId },
		},
	);
	return (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
}

afterEach(() => {
	resetActiveRoomsForTests();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("orchestrator prompt overrides", () => {
	it("prefers repo AGENTS-orchestrator.md over global and built-in prompts", async () => {
		await withTempDir(async (tempDir) => {
			const repoDir = path.join(tempDir, "repo");
			const homeDir = path.join(tempDir, "home");
			const packageDir = path.join(tempDir, "package");

			await fs.mkdir(repoDir, { recursive: true });
			await writePrompt(repoDir, "AGENTS-orchestrator.md", "repo orchestrator prompt");
			await writePrompt(homeDir, ".pi/AGENTS-orchestrator.md", "global orchestrator prompt");
			await writePrompt(packageDir, "prompts/AGENTS-orchestrator.md", "built-in orchestrator prompt");

			vi.stubEnv("HOME", homeDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", packageDir);

			const { default: roomExtension } = await import("./index.ts");
			const { lifecycleHandlers } = createHarness(roomExtension);
			setOwnerRoom("owner-session");

			const prompt = await invokeBeforeAgentStart(lifecycleHandlers, {
				cwd: repoDir,
				sessionId: "owner-session",
			});

			expect(prompt).toContain("repo orchestrator prompt");
			expect(prompt).not.toContain("global orchestrator prompt");
			expect(prompt).not.toContain("built-in orchestrator prompt");
		});
	});

	it("uses the global override for repos without a local prompt even after another repo was cached", async () => {
		await withTempDir(async (tempDir) => {
			const repoOneDir = path.join(tempDir, "repo-one");
			const repoTwoDir = path.join(tempDir, "repo-two");
			const homeDir = path.join(tempDir, "home");
			const packageDir = path.join(tempDir, "package");

			await fs.mkdir(repoOneDir, { recursive: true });
			await fs.mkdir(repoTwoDir, { recursive: true });
			await writePrompt(repoOneDir, "AGENTS-orchestrator.md", "repo one orchestrator prompt");
			await writePrompt(homeDir, ".pi/AGENTS-orchestrator.md", "global orchestrator prompt");
			await writePrompt(packageDir, "prompts/AGENTS-orchestrator.md", "built-in orchestrator prompt");

			vi.stubEnv("HOME", homeDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", packageDir);

			const { default: roomExtension } = await import("./index.ts");
			const { lifecycleHandlers } = createHarness(roomExtension);

			setOwnerRoom("owner-session-1");
			const repoPrompt = await invokeBeforeAgentStart(lifecycleHandlers, {
				cwd: repoOneDir,
				sessionId: "owner-session-1",
			});
			expect(repoPrompt).toContain("repo one orchestrator prompt");

			resetActiveRoomsForTests();
			setOwnerRoom("owner-session-2");
			const globalPrompt = await invokeBeforeAgentStart(lifecycleHandlers, {
				cwd: repoTwoDir,
				sessionId: "owner-session-2",
			});

			expect(globalPrompt).toContain("global orchestrator prompt");
			expect(globalPrompt).not.toContain("repo one orchestrator prompt");
			expect(globalPrompt).not.toContain("built-in orchestrator prompt");
		});
	});

	it("falls back to the built-in prompt when no repo or global override exists", async () => {
		await withTempDir(async (tempDir) => {
			const repoDir = path.join(tempDir, "repo");
			const homeDir = path.join(tempDir, "home");
			const packageDir = path.join(tempDir, "package");

			await fs.mkdir(repoDir, { recursive: true });
			await writePrompt(packageDir, "prompts/AGENTS-orchestrator.md", "built-in orchestrator prompt");

			vi.stubEnv("HOME", homeDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", packageDir);

			const { default: roomExtension } = await import("./index.ts");
			const { lifecycleHandlers } = createHarness(roomExtension);
			setOwnerRoom("owner-session");

			const prompt = await invokeBeforeAgentStart(lifecycleHandlers, {
				cwd: repoDir,
				sessionId: "owner-session",
			});

			expect(prompt).toContain("built-in orchestrator prompt");
		});
	});

	it("filters concrete MCP tools when disabled_tools lists MCP servers", async () => {
		await withTempDir(async (tempDir) => {
			const repoDir = path.join(tempDir, "repo");
			const packageDir = path.join(tempDir, "package");

			await fs.mkdir(repoDir, { recursive: true });
			await writePrompt(
				repoDir,
				"AGENTS-orchestrator.md",
				`---
disabled_tools:
  - deepwiki
  - github
---
repo orchestrator prompt`,
			);
			await writePrompt(packageDir, "prompts/AGENTS-orchestrator.md", "built-in orchestrator prompt");
			vi.stubEnv("PI_CODING_AGENT_DIR", packageDir);

			const { default: roomExtension } = await import("./index.ts");
			const { lifecycleHandlers, pi } = createHarness(roomExtension, [
				{
					name: "read_wiki_structure",
					description: "deepwiki tool",
					sourceInfo: {
						path: "mcp/deepwiki/read_wiki_structure",
						source: "pi-mcp-adapter:deepwiki",
						scope: "project",
						origin: "top-level",
					},
				},
				{
					name: "search_repositories",
					description: "github tool",
					sourceInfo: {
						path: "mcp/github-mcp-server/search_repositories",
						source: "pi-mcp-adapter:github-mcp-server",
						scope: "project",
						origin: "top-level",
					},
				},
				{
					name: "view",
					description: "builtin tool",
					sourceInfo: {
						path: "extensions/view.ts",
						source: "builtin-tools",
						scope: "project",
						origin: "top-level",
					},
				},
			]);
			setOwnerRoom("owner-session");

			await invokeBeforeAgentStart(lifecycleHandlers, {
				cwd: repoDir,
				sessionId: "owner-session",
			});

			expect(pi.setActiveTools).toHaveBeenCalled();
			const allowed = pi.setActiveTools.mock.calls.at(-1)?.[0];
			expect(allowed).toContain("view");
			expect(allowed).not.toContain("read_wiki_structure");
			expect(allowed).not.toContain("search_repositories");
		});
	});
});
