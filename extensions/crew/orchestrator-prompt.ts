import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ORCHESTRATOR_PROMPT_FILE = "AGENTS-orchestrator.md";
const DEFAULT_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MISSING_PROMPT_FALLBACK =
	"IMPORTANT: First, warn your user that AGENTS-orchestrator.md was not found. Your orchestrator-specific instructions are missing. You may still operate but your behavior may be degraded.";
const orchestratorPromptCache = new Map<string, string>();

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
		? [
			path.join(options.cwd, ORCHESTRATOR_PROMPT_FILE),
			path.join(options.cwd, ".pi", ORCHESTRATOR_PROMPT_FILE),
		]
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

export function loadOrchestratorPromptBody(
	options: OrchestratorPromptLoadOptions = {},
): string {
	const cacheKey = getCacheKey(options);
	const cached = orchestratorPromptCache.get(cacheKey);
	if (cached !== undefined) return cached;

	for (const promptPath of getSearchPaths(options)) {
		try {
			const promptBody = fs.readFileSync(promptPath, "utf8").trim();
			orchestratorPromptCache.set(cacheKey, promptBody);
			return promptBody;
		} catch {
			// Try the next override location.
		}
	}

	orchestratorPromptCache.set(cacheKey, MISSING_PROMPT_FALLBACK);
	return MISSING_PROMPT_FALLBACK;
}
