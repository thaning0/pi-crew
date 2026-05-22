/**
 * Built-in Tools Extension
 *
 * Registers grep, find, and ls as LLM-callable tools.
 * These tools exist in pi-coding-agent's SDK but are not enabled by default
 * (default tools are only read, bash, edit, write).
 *
 * This extension imports them from the SDK and registers them so the LLM
 * can call them directly instead of needing to go through bash.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createGrepTool,
	createFindTool,
	createLsTool,
} from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// Register grep tool
	const grepTool = createGrepTool(cwd);
	pi.registerTool({
		name: grepTool.name,
		label: grepTool.label ?? "Grep",
		description: grepTool.description,
		parameters: grepTool.parameters,
		execute: grepTool.execute,
	});

	// Register find tool
	const findTool = createFindTool(cwd);
	pi.registerTool({
		name: findTool.name,
		label: findTool.label ?? "Find",
		description: findTool.description,
		parameters: findTool.parameters,
		execute: findTool.execute,
	});

	// Register ls tool
	const lsTool = createLsTool(cwd);
	pi.registerTool({
		name: lsTool.name,
		label: lsTool.label ?? "Ls",
		description: lsTool.description,
		parameters: lsTool.parameters,
		execute: lsTool.execute,
	});
}
