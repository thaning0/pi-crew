declare module "@mariozechner/pi-agent-core" {
	export type ThinkingLevel =
		| "off"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "xhigh";
}

declare module "@mariozechner/pi-coding-agent" {
	import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
	import type { EventBus } from "@mariozechner/pi-coding-agent";

	export interface ExtensionContext {
		cwd?: string;
		getSystemPrompt?: () => string | undefined;
		model?: {
			provider: string;
			id: string;
		};
		sessionManager?: {
			getSessionId?: () => string;
		};
	}

	export interface ToolInfo {
		name: string;
		description: string;
	}

	export interface SendMessagePayload {
		customType?: string;
		content: string;
		display?: boolean;
	}

	export interface SendMessageOptions {
		deliverAs?: string;
		triggerTurn?: boolean;
	}

	export interface ExtensionEvent {
		systemPrompt?: string;
		toolName?: string;
		details?: unknown;
		input?: unknown;
		message?: unknown;
		toolResults?: unknown[];
	}

	export interface ExtensionAPI {
		events: EventBus;
		on(
			event: string,
			handler: (
				event: ExtensionEvent,
				ctx: ExtensionContext,
			) => unknown | Promise<unknown>,
		): void;
		setActiveTools(toolNames: string[]): void;
		getAllTools(): ToolInfo[];
		sendMessage(
			message: SendMessagePayload,
			options?: SendMessageOptions,
		): void;
		registerTool(definition: unknown): void;
		getThinkingLevel(): ThinkingLevel | undefined;
	}
}
