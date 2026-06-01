import { describe, expect, it } from "vitest";
import { filterAllowedToolNames, filterExplicitToolNames } from "./tool-blacklist.ts";

const deepwikiTool = {
	name: "read_wiki_structure",
	description: "deepwiki tool",
	sourceInfo: {
		path: "mcp/deepwiki/read_wiki_structure",
		source: "pi-mcp-adapter:deepwiki",
		scope: "project" as const,
		origin: "top-level" as const,
	},
};

const githubTool = {
	name: "search_repositories",
	description: "github tool",
	sourceInfo: {
		path: "mcp/github-mcp-server/search_repositories",
		source: "pi-mcp-adapter:github-mcp-server",
		scope: "project" as const,
		origin: "top-level" as const,
	},
};

const viewTool = {
	name: "view",
	description: "builtin tool",
	sourceInfo: {
		path: "extensions/view.ts",
		source: "builtin-tools",
		scope: "project" as const,
		origin: "top-level" as const,
	},
};

describe("tool blacklist matching", () => {
	it("matches MCP server identifiers against concrete tool metadata", () => {
		expect(
			filterAllowedToolNames([deepwikiTool, githubTool, viewTool], ["deepwiki", "github"]),
		).toEqual(["view"]);
	});

	it("filters explicit tool-name lists by looking up their registered metadata", () => {
		expect(
			filterExplicitToolNames(
				["read_wiki_structure", "view"],
				[deepwikiTool, viewTool],
				["deepwiki"],
			),
		).toEqual(["view"]);
	});

	it("keeps the existing mcp keyword behavior for disabling all MCP tools", () => {
		expect(filterAllowedToolNames([deepwikiTool, githubTool, viewTool], ["mcp"])).toEqual([
			"view",
		]);
	});
});
