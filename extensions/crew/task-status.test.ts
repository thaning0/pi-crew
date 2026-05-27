import { describe, expect, it } from "vitest";
import { classifyIdleTaskStatus, idleStatusToEventName } from "./task-status.ts";

describe("classifyIdleTaskStatus", () => {
	it("no deps + idle member → assigned", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: false,
			depsReady: true,
			hasError: false,
			hasCancelled: false,
		})).toBe("assigned");
	});

	it("unresolved deps + idle member → waiting_deps", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: false,
			hasError: false,
			hasCancelled: false,
		})).toBe("waiting_deps");
	});

	it("failed upstream + idle member → blocked_failed", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: true,
			hasError: true,
			hasCancelled: false,
		})).toBe("blocked_failed");
	});

	it("cancelled upstream + idle member → blocked_failed", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: true,
			hasError: false,
			hasCancelled: true,
		})).toBe("blocked_failed");
	});

	it("all deps resolved (no errors) + idle member → assigned", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: true,
			hasError: false,
			hasCancelled: false,
		})).toBe("assigned");
	});

	it("hasError takes priority over unresolved deps", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: false,
			hasError: true,
			hasCancelled: false,
		})).toBe("blocked_failed");
	});

	it("hasCancelled takes priority over unresolved deps", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: false,
			hasError: false,
			hasCancelled: true,
		})).toBe("blocked_failed");
	});

	it("both error and cancelled → blocked_failed", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: true,
			hasError: true,
			hasCancelled: true,
		})).toBe("blocked_failed");
	});
});

describe("idleStatusToEventName", () => {
	it("maps assigned → task:assigned", () => {
		expect(idleStatusToEventName("assigned")).toBe("task:assigned");
	});

	it("maps waiting_deps → task:waiting_deps", () => {
		expect(idleStatusToEventName("waiting_deps")).toBe("task:waiting_deps");
	});

	it("maps blocked_failed → task:blocked_failed", () => {
		expect(idleStatusToEventName("blocked_failed")).toBe("task:blocked_failed");
	});
});
