import type { ToolInfo } from "@mariozechner/pi-coding-agent";

function normalizeIdentifier(value: string): string {
	return value.trim().toLowerCase();
}

function addNormalizedVariants(raw: string, candidates: Set<string>): void {
	const normalized = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (!normalized) return;
	candidates.add(normalized);
	const parts = normalized.split("-").filter(Boolean);
	let prefix = "";
	for (const part of parts) {
		prefix = prefix ? `${prefix}-${part}` : part;
		candidates.add(prefix);
	}
}

function addToolIdentifiers(raw: string | undefined, candidates: Set<string>): void {
	if (!raw) return;
	const normalized = normalizeIdentifier(raw);
	if (!normalized) return;
	candidates.add(normalized);
	addNormalizedVariants(normalized, candidates);
	for (const segment of normalized.split(/[\\/:]+/).filter(Boolean)) {
		candidates.add(segment);
		addNormalizedVariants(segment, candidates);
	}
}

function buildDisabledSet(disabledTools: readonly string[]): Set<string> {
	return new Set(disabledTools.map(normalizeIdentifier).filter(Boolean));
}

export function isMcpTool(tool: Pick<ToolInfo, "sourceInfo">): boolean {
	return [tool.sourceInfo?.path, tool.sourceInfo?.source]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.some((value) => normalizeIdentifier(value).includes("pi-mcp-adapter"));
}

export function createDisabledToolPredicate(
	disabledTools: readonly string[],
): (tool: Pick<ToolInfo, "name" | "sourceInfo">) => boolean {
	const disabledSet = buildDisabledSet(disabledTools);
	return (tool) => {
		if (disabledSet.size === 0) return false;
		if (disabledSet.has("mcp") && isMcpTool(tool)) return true;
		const candidates = new Set<string>();
		addToolIdentifiers(tool.name, candidates);
		addToolIdentifiers(tool.sourceInfo?.path, candidates);
		addToolIdentifiers(tool.sourceInfo?.source, candidates);
		for (const candidate of candidates) {
			if (disabledSet.has(candidate)) return true;
		}
		return false;
	};
}

export function filterAllowedToolNames(
	tools: readonly ToolInfo[],
	disabledTools: readonly string[],
): string[] {
	const isDisabled = createDisabledToolPredicate(disabledTools);
	return tools.filter((tool) => !isDisabled(tool)).map((tool) => tool.name);
}

export function filterExplicitToolNames(
	toolNames: readonly string[],
	allTools: readonly ToolInfo[],
	disabledTools: readonly string[],
): string[] {
	const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
	const isDisabled = createDisabledToolPredicate(disabledTools);
	return toolNames.filter((toolName) => {
		const tool = toolsByName.get(toolName);
		return !isDisabled(tool ?? { name: toolName });
	});
}
