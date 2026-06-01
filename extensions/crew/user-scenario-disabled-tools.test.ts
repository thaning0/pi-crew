import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// Direct import of orchestrator-prompt to test parsing
import { loadOrchestratorConfig } from "../../extensions/crew/orchestrator-prompt.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crew-test-"));
    try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

describe("User scenario: comma-separated disabled_tools", () => {
    it("parses user's exact disabled_tools format correctly", async () => {
        await withTempDir(async (tempDir) => {
            const repoDir = path.join(tempDir, "repo");
            await fs.mkdir(repoDir, { recursive: true });

            // User's exact file content
            const userContent = `---
disabled_tools: bash, edit, write, bash_monitor, bash_write, bash_read, bash_list, bash_stop, record_candidate, evaluate, advance_backtest, status, init_experiment, run_experiment, log_experiment, web_search, web_fetch, mcp
---

You are a **factor research supervisor**. Delegate tasks to sub-agents.
`;

            await fs.writeFile(path.join(repoDir, "AGENTS-orchestrator.md"), userContent, "utf8");

            const result = loadOrchestratorConfig({ cwd: repoDir });
            
            console.log("disabled_tools:", JSON.stringify(result.config.disabled_tools));
            console.log("body:", JSON.stringify(result.body));

            // Verify disabled_tools is not undefined
            expect(result.config.disabled_tools).toBeDefined();
            expect(result.config.disabled_tools!.length).toBeGreaterThan(0);

            // Verify all expected tools are in the list
            expect(result.config.disabled_tools).toContain("bash");
            expect(result.config.disabled_tools).toContain("edit");
            expect(result.config.disabled_tools).toContain("write");
            expect(result.config.disabled_tools).toContain("bash_monitor");
            expect(result.config.disabled_tools).toContain("record_candidate");
            expect(result.config.disabled_tools).toContain("evaluate");
            expect(result.config.disabled_tools).toContain("advance_backtest");
            expect(result.config.disabled_tools).toContain("status");
            expect(result.config.disabled_tools).toContain("init_experiment");
            expect(result.config.disabled_tools).toContain("run_experiment");
            expect(result.config.disabled_tools).toContain("log_experiment");
            expect(result.config.disabled_tools).toContain("web_search");
            expect(result.config.disabled_tools).toContain("web_fetch");
            expect(result.config.disabled_tools).toContain("mcp");

            // Verify body is parsed correctly
            expect(result.body).toContain("factor research supervisor");

            // Should have 18 tools
            expect(result.config.disabled_tools!.length).toBe(18);
        });
    });

    it("returns undefined disabled_tools when not specified", async () => {
        await withTempDir(async (tempDir) => {
            const repoDir = path.join(tempDir, "repo");
            await fs.mkdir(repoDir, { recursive: true });

            // No disabled_tools in frontmatter
            const content = `---
name: some-config
---

Some body text.
`;

            await fs.writeFile(path.join(repoDir, "AGENTS-orchestrator.md"), content, "utf8");

            const result = loadOrchestratorConfig({ cwd: repoDir });
            
            console.log("disabled_tools (no config):", JSON.stringify(result.config.disabled_tools));

            expect(result.config.disabled_tools).toBeUndefined();
            expect(result.body).toContain("Some body text");
        });
    });
});
