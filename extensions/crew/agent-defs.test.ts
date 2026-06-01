import { describe, it, expect } from "vitest";
import { parseAgentDefinitionForTest } from "./agent-defs";

describe("parseAgentDefinitionForTest", () => {
	it("parses disabled_tools as comma-separated string", () => {
		const def = parseAgentDefinitionForTest(`---
name: test-agent
disabled_tools: bash, edit, write
---
System prompt here.`);
		expect(def.disabled_tools).toEqual(["bash", "edit", "write"]);
	});

	it("parses disabled_tools as YAML list", () => {
		const def = parseAgentDefinitionForTest(`---
name: test-agent
disabled_tools:
  - bash
  - edit
---
System prompt here.`);
		expect(def.disabled_tools).toEqual(["bash", "edit"]);
	});

	it("returns undefined when disabled_tools is not set", () => {
		const def = parseAgentDefinitionForTest(`---
name: test-agent
tools: read, grep
---
System prompt here.`);
		expect(def.disabled_tools).toBeUndefined();
	});

	it("parses both tools and disabled_tools together", () => {
		const def = parseAgentDefinitionForTest(`---
name: test-agent
tools:
  - read
  - grep
  - bash
  - edit
disabled_tools:
  - bash
  - edit
---
System prompt here.`);
		expect(def.tools).toEqual(["read", "grep", "bash", "edit"]);
		expect(def.disabled_tools).toEqual(["bash", "edit"]);
	});

	it("parses disabled_tools with empty value as undefined", () => {
		const def = parseAgentDefinitionForTest(`---
name: test-agent
disabled_tools:
---
System prompt here.`);
		expect(def.disabled_tools).toBeUndefined();
	});
});
