import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ORCHESTRATOR_PROMPT_FILE = "AGENTS-orchestrator.md";
const DEFAULT_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MISSING_PROMPT_FALLBACK =
	"IMPORTANT: First, warn your user that AGENTS-orchestrator.md was not found. Your orchestrator-specific instructions are missing. You may still operate but your behavior may be degraded.";
export interface OrchestratorConfig {
	disabled_tools?: string[];
}

interface OrchestratorPromptResult {
	body: string;
	config: OrchestratorConfig;
}

const orchestratorPromptCache = new Map<string, OrchestratorPromptResult>();

interface OrchestratorPromptLoadOptions {
	cwd?: string;
	homeDir?: string;
	packageRoot?: string;
}

function resolvePackageRoot(override?: string): string {
	if (override !== undefined) return override;
	const envOverride = process.env.PI_CODING_AGENT_DIR?.trim();
	return envOverride && envOverride.length > 0 ? envOverride : DEFAULT_PACKAGE_ROOT;
}

function resolveHomeDir(override?: string): string {
	return override ?? os.homedir();
}

function getSearchPaths(options: OrchestratorPromptLoadOptions): string[] {
	const repoPaths = options.cwd
		? [path.join(options.cwd, ORCHESTRATOR_PROMPT_FILE)]
		: [];
	const homeDir = resolveHomeDir(options.homeDir);
	const globalPath = path.join(homeDir, ".pi", ORCHESTRATOR_PROMPT_FILE);
	const builtInPath = path.join(
		resolvePackageRoot(options.packageRoot),
		"prompts",
		ORCHESTRATOR_PROMPT_FILE,
	);
	return [...new Set([...repoPaths, globalPath, builtInPath])];
}

function getCacheKey(options: OrchestratorPromptLoadOptions): string {
	return [
		options.cwd ?? "__no_cwd__",
		resolveHomeDir(options.homeDir),
		resolvePackageRoot(options.packageRoot),
	].join("::");
}

function parseOrchestratorFrontmatter(rawContent: string): { frontmatter: Record<string, unknown>; body: string } {
	const normalized = rawContent.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { frontmatter: {}, body: normalized.trim() };
	}
	const endIdx = normalized.indexOf("\n---\n", 4);
	if (endIdx === -1) {
		return { frontmatter: {}, body: normalized.trim() };
	}
	const frontmatterBlock = normalized.slice(4, endIdx);
	const body = normalized.slice(endIdx + 5).trim();
	const frontmatter: Record<string, unknown> = {};
	let currentArrayKey: string | null = null;
	let currentArray: string[] = [];
	for (const line of frontmatterBlock.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const arrayMatch = trimmed.match(/^-\s+(.+)$/);
		if (arrayMatch && currentArrayKey) {
			currentArray.push(arrayMatch[1].trim());
			continue;
		}
		if (currentArrayKey) {
			frontmatter[currentArrayKey] = [...currentArray];
			currentArrayKey = null;
			currentArray = [];
		}
		const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
		if (!kvMatch) continue;
		const [, key, value] = kvMatch;
		if (value.length === 0) {
			currentArrayKey = key;
			currentArray = [];
		} else {
			frontmatter[key] = value.trim();
		}
	}
	if (currentArrayKey) {
		frontmatter[currentArrayKey] = currentArray;
	}
	return { frontmatter, body };
}

function normalizeDisabledTools(value: unknown): string[] | undefined {
	const raw = Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: typeof value === "string"
			? value.split(",")
			: [];
	const tools = raw.map((entry) => entry.trim()).filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

export function loadOrchestratorConfig(
	options: OrchestratorPromptLoadOptions = {},
): { body: string; config: OrchestratorConfig } {
	const cacheKey = getCacheKey(options);
	const cached = orchestratorPromptCache.get(cacheKey);
	if (cached !== undefined) return cached;

	for (const promptPath of getSearchPaths(options)) {
		try {
			const raw = fs.readFileSync(promptPath, "utf8");
			const { frontmatter, body } = parseOrchestratorFrontmatter(raw);
			if (!body.trim() && !normalizeDisabledTools(frontmatter.disabled_tools)) {
				// Empty file with no config — treat as not found, try next path
				continue;
			}
			const result: OrchestratorPromptResult = {
				body,
				config: {
					disabled_tools: normalizeDisabledTools(frontmatter.disabled_tools),
				},
			};
			orchestratorPromptCache.set(cacheKey, result);
			return result;
		} catch {
			// Try the next override location.
		}
	}

	const fallback: OrchestratorPromptResult = {
		body: MISSING_PROMPT_FALLBACK,
		config: {},
	};
	orchestratorPromptCache.set(cacheKey, fallback);
	return fallback;
}

export function loadOrchestratorPromptBody(
	options: OrchestratorPromptLoadOptions = {},
): string {
	return loadOrchestratorConfig(options).body;
}
