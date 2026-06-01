import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

const FRONTMATTER_BOUNDARY = "---\n";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS_DIR = path.join(packageRoot, "prompts", "agents");
const agentDefinitionCache = new Map<string, AgentDefinition | null>();

const VALID_THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function normalizeThinking(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (VALID_THINKING_LEVELS.has(trimmed)) return trimmed as ThinkingLevel;
	return undefined;
}

function normalizeHeartbeatStaleMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	if (typeof value === "string") {
		const num = Number(value.trim());
		if (Number.isFinite(num) && num > 0) return num;
	}
	return undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const trimmed = value.trim().toLowerCase();
		if (trimmed === "true") return true;
		if (trimmed === "false") return false;
	}
	return undefined;
}

export interface AgentDefinition {
	type: string;
	systemPrompt: string | null;
	tools?: string[];
	/** Tools to exclude from the agent's default tool set.
	 *  Applied as a blacklist after the tools whitelist (if any).
	 *  Crew messaging tools (crew_tell, etc.) are never removable. */
	disabled_tools?: string[];
	model?: string;
	worktree?: boolean;
	/** Thinking level: off, minimal, low, medium, high, xhigh. When unset, inherits from orchestrator. */
	thinking?: ThinkingLevel;
	/** Per-agent-type heartbeat stale timeout in milliseconds.
	 *  When set, overrides the global PI_ROOM_MEMBER_HEARTBEAT_STALE_MS default (5000ms).
	 *  Use for slow-starting agent types (e.g. flash-model agents behind rate-limited providers). */
	heartbeatStaleMs?: number;
}

function getGlobalAgentsDir(): string {
	return path.join(os.homedir(), ".pi", "crew_agents");
}

function getRepoAgentsDir(cwd: string): string {
	return path.join(cwd, ".pi", "crew_agents");
}

function getSearchDirs(cwd?: string): string[] {
	const dirs: string[] = [];
	if (cwd !== undefined) {
		dirs.push(getRepoAgentsDir(cwd));
	}
	dirs.push(getGlobalAgentsDir());
	dirs.push(AGENTS_DIR);
	return dirs;
}

function normalizeAgentType(agentType: string): string | null {
	const normalizedType = agentType.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9_-]*$/.test(normalizedType) ? normalizedType : null;
}

function normalizeToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: typeof value === "string"
			? value.split(",")
			: [];
	const tools = raw.map((entry) => entry.trim()).filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function parseFrontmatterBlock(block: string): Record<string, unknown> {
	const frontmatter: Record<string, unknown> = {};
	let currentArrayKey: string | null = null;
	let currentArray: string[] = [];

	const flushArray = () => {
		if (!currentArrayKey) return;
		frontmatter[currentArrayKey] = [...currentArray];
		currentArrayKey = null;
		currentArray = [];
	};

	for (const rawLine of block.split("\n")) {
		const line = rawLine.trimEnd();
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const arrayItem = line.match(/^\s*-\s+(.*)$/);
		if (arrayItem && currentArrayKey) {
			currentArray.push(arrayItem[1].trim());
			continue;
		}

		flushArray();

		const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!entry) continue;

		const [, key, value] = entry;
		if (value.length === 0) {
			currentArrayKey = key;
			currentArray = [];
			continue;
		}

		frontmatter[key] = value.trim();
	}

	flushArray();
	return frontmatter;
}

function buildAgentDefinition(
	normalizedType: string,
	frontmatter: Record<string, unknown>,
	body: string,
): AgentDefinition {
	return {
		type: normalizedType,
		systemPrompt: body.trim().length > 0 ? body.trim() : null,
		tools: normalizeToolList(frontmatter.tools),
		disabled_tools: normalizeToolList(frontmatter.disabled_tools),
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		worktree: normalizeBoolean(frontmatter.worktree),
		thinking: normalizeThinking(frontmatter.thinking),
		heartbeatStaleMs: normalizeHeartbeatStaleMs(frontmatter["heartbeat-stale-ms"]),
	};
}

function parseMarkdownFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith(FRONTMATTER_BOUNDARY)) {
		return { frontmatter: {}, body: normalized.trim() };
	}

	const endIndex = normalized.indexOf("\n---", FRONTMATTER_BOUNDARY.length);
	if (endIndex === -1) {
		return { frontmatter: {}, body: normalized.trim() };
	}

	return {
		frontmatter: parseFrontmatterBlock(normalized.slice(FRONTMATTER_BOUNDARY.length, endIndex)),
		body: normalized.slice(endIndex + 4).trim(),
	};
}

export function loadAgentDefinition(agentType: string, cwd?: string): AgentDefinition | null {
	const normalizedType = normalizeAgentType(agentType);
	if (!normalizedType) return null;

	const cacheKey = `${cwd ?? "__no_cwd__"}::${normalizedType}`;
	if (agentDefinitionCache.has(cacheKey)) {
		return agentDefinitionCache.get(cacheKey) ?? null;
	}

	const searchDirs = getSearchDirs(cwd);
	for (const dir of searchDirs) {
		try {
			const content = fs.readFileSync(path.join(dir, `${normalizedType}.md`), "utf8");
			const { frontmatter, body } = parseMarkdownFrontmatter(content);
			const definition = buildAgentDefinition(normalizedType, frontmatter, body);
			agentDefinitionCache.set(cacheKey, definition);
			return definition;
		} catch {
			// Try next directory
		}
	}

	agentDefinitionCache.set(cacheKey, null);
	return null;
}

export function parseAgentDefinitionForTest(content: string): AgentDefinition {
	const { frontmatter, body } = parseMarkdownFrontmatter(content);
	return buildAgentDefinition("test-agent", frontmatter, body);
}

export function listAgentTypes(cwd?: string): Array<{ type: string; description: string; tools?: string[] }> {
	const seen = new Set<string>();
	const results: Array<{ type: string; description: string; tools?: string[] }> = [];

	const searchDirs = getSearchDirs(cwd);
	for (const dir of searchDirs) {
		let entries: string[] = [];
		try {
			entries = fs.readdirSync(dir).sort();
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const type = entry.slice(0, -3);
			if (!normalizeAgentType(type) || seen.has(type)) continue;
			seen.add(type);
			try {
				const content = fs.readFileSync(path.join(dir, entry), "utf8");
				const { frontmatter } = parseMarkdownFrontmatter(content);
				results.push({
					type,
					description: typeof frontmatter.description === "string" ? frontmatter.description : "",
					tools: normalizeToolList(frontmatter.tools),
				});
			} catch {
				results.push({ type, description: "", tools: undefined });
			}
		}
	}
	results.sort((a, b) => a.type.localeCompare(b.type));
	return results;
}