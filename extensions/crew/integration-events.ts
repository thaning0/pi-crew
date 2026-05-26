import { createHash } from "node:crypto";
import type { CrewAddActivation } from "./types.ts";

export type CrewDeliveryState = "pending" | "held" | "enabled" | "ended";
export type CrewLifecyclePhase = "request" | "spawn" | "delivery" | "activation";
export type CrewLifecycleEventName =
	| CrewDeliveryState
	| "activated"
	| "aborted"
	| "claimed"
	| "rejected"
	| "spawned"
	| "failed";

export interface CrewLifecycleEvent {
	event_id: string;
	event: CrewLifecycleEventName;
	phase: CrewLifecyclePhase;
	request_id: string | null;
	command_id: string | null;
	requested_name: string | null;
	member_target: string | null;
	member_type: string | null;
	room_id: string | null;
	spawn_task_id: string | null;
	runtime_id: string | null;
	activation: CrewAddActivation | null;
	metadata: Record<string, unknown> | null;
	delivery_state: CrewDeliveryState | null;
	hold_expires_at: string | null;
	error: string | null;
	reason: string | null;
}

export type CrewLifecycleEventInput = Omit<CrewLifecycleEvent, "event_id">;

interface CrewLifecycleEventSeed {
	request_id?: string | null;
	command_id?: string | null;
	requested_name?: string | null;
	member_target?: string | null;
	member_type?: string | null;
	room_id?: string | null;
	spawn_task_id?: string | null;
	runtime_id?: string | null;
	activation?: CrewAddActivation | null;
	metadata?: Record<string, unknown> | null;
	error?: string | null;
	reason?: string | null;
}

type CrewEventEmitter = (
	payload: CrewLifecycleEvent,
) => void | Promise<void>;

let crewEventEmitter: CrewEventEmitter | null = null;

function normalizeLifecycleEvent(
	input: CrewLifecycleEventInput,
): CrewLifecycleEventInput {
	return {
		event: input.event,
		phase: input.phase,
		request_id: input.request_id ?? null,
		command_id: input.command_id ?? null,
		requested_name: input.requested_name ?? null,
		member_target: input.member_target ?? null,
		member_type: input.member_type ?? null,
		room_id: input.room_id ?? null,
		spawn_task_id: input.spawn_task_id ?? null,
		runtime_id: input.runtime_id ?? null,
		activation: input.activation ?? null,
		metadata: input.metadata ?? null,
		delivery_state: input.delivery_state ?? null,
		hold_expires_at: input.hold_expires_at ?? null,
		error: input.error ?? null,
		reason: input.reason ?? null,
	};
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, entryValue]) =>
					`${JSON.stringify(key)}:${stableSerialize(entryValue)}`,
			);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function buildCrewLifecycleEvent(
	input: CrewLifecycleEventInput,
): CrewLifecycleEvent {
	const normalized = normalizeLifecycleEvent(input);
	const event_id = `crew-event-${createHash("sha256")
		.update(stableSerialize(normalized))
		.digest("hex")
		.slice(0, 24)}`;
	return {
		event_id,
		...normalized,
	};
}

function createCrewLifecycleEvent(
	seed: CrewLifecycleEventSeed,
	event: CrewLifecycleEventName,
	phase: CrewLifecyclePhase,
	delivery_state: CrewDeliveryState,
	overrides: Partial<
		Pick<CrewLifecycleEventInput, "hold_expires_at" | "error" | "reason">
	> = {},
): CrewLifecycleEventInput {
	return normalizeLifecycleEvent({
		event,
		phase,
		request_id: seed.request_id,
		command_id: seed.command_id,
		requested_name: seed.requested_name,
		member_target: seed.member_target,
		member_type: seed.member_type,
		room_id: seed.room_id,
		spawn_task_id: seed.spawn_task_id,
		runtime_id: seed.runtime_id,
		activation: seed.activation ?? null,
		metadata: seed.metadata ?? null,
		delivery_state,
		hold_expires_at: overrides.hold_expires_at ?? null,
		error: overrides.error ?? seed.error ?? null,
		reason: overrides.reason ?? seed.reason ?? null,
	});
}

export function createCrewPendingLifecycleEvent(
	seed: CrewLifecycleEventSeed,
): CrewLifecycleEventInput {
	return createCrewLifecycleEvent(seed, "pending", "delivery", "pending");
}

export function createCrewHeldLifecycleEvent(
	seed: CrewLifecycleEventSeed & { hold_expires_at: string },
): CrewLifecycleEventInput {
	return createCrewLifecycleEvent(seed, "held", "delivery", "held", {
		hold_expires_at: seed.hold_expires_at,
	});
}

export function createCrewEnabledLifecycleEvent(
	seed: CrewLifecycleEventSeed,
): CrewLifecycleEventInput {
	return createCrewLifecycleEvent(seed, "enabled", "delivery", "enabled");
}

export function createCrewEndedLifecycleEvent(
	seed: CrewLifecycleEventSeed,
): CrewLifecycleEventInput {
	return createCrewLifecycleEvent(seed, "ended", "delivery", "ended");
}

export function createCrewRejectedLifecycleEvent(
	seed: CrewLifecycleEventSeed,
): CrewLifecycleEventInput {
	return normalizeLifecycleEvent({
		event: "rejected",
		phase: "request",
		request_id: seed.request_id ?? null,
		command_id: seed.command_id ?? null,
		requested_name: seed.requested_name ?? null,
		member_target: null,
		member_type: null,
		room_id: null,
		spawn_task_id: null,
		runtime_id: null,
		activation: seed.activation ?? null,
		metadata: null,
		delivery_state: null,
		hold_expires_at: null,
		error: seed.error ?? null,
		reason: seed.reason ?? null,
	});
}

export function createCrewSpawnedLifecycleEvent(
	seed: CrewLifecycleEventSeed & {
		delivery_state?: CrewDeliveryState | null;
		hold_expires_at?: string | null;
	},
): CrewLifecycleEventInput {
	return normalizeLifecycleEvent({
		event: "spawned",
		phase: "spawn",
		request_id: seed.request_id ?? null,
		command_id: seed.command_id ?? null,
		requested_name: seed.requested_name ?? null,
		member_target: seed.member_target ?? null,
		member_type: seed.member_type ?? null,
		room_id: seed.room_id ?? null,
		spawn_task_id: seed.spawn_task_id ?? null,
		runtime_id: seed.runtime_id ?? null,
		activation: seed.activation ?? null,
		metadata: seed.metadata ?? null,
		delivery_state: seed.delivery_state ?? null,
		hold_expires_at: seed.hold_expires_at ?? null,
		error: null,
		reason: seed.reason ?? null,
	});
}

export function createCrewFailedLifecycleEvent(
	seed: CrewLifecycleEventSeed,
): CrewLifecycleEventInput {
	return normalizeLifecycleEvent({
		event: "failed",
		phase: "spawn",
		request_id: seed.request_id ?? null,
		command_id: seed.command_id ?? null,
		requested_name: seed.requested_name ?? null,
		member_target: seed.member_target ?? null,
		member_type: seed.member_type ?? null,
		room_id: seed.room_id ?? null,
		spawn_task_id: seed.spawn_task_id ?? null,
		runtime_id: seed.runtime_id ?? null,
		activation: seed.activation ?? null,
		metadata: seed.metadata ?? null,
		delivery_state: null,
		hold_expires_at: null,
		error: seed.error ?? null,
		reason: seed.reason ?? null,
	});
}

export function setCrewEventEmitter(
	emitter: CrewEventEmitter | null | undefined,
): void {
	crewEventEmitter = emitter ?? null;
}

export async function emitCrewLifecycleEvent(
	input: CrewLifecycleEventInput,
): Promise<CrewLifecycleEvent> {
	const payload = buildCrewLifecycleEvent(input);
	if (!crewEventEmitter) {
		return payload;
	}

	try {
		await crewEventEmitter(payload);
	} catch {
		// Best-effort only: lifecycle handling must not fail because outbound feedback failed.
	}
	return payload;
}
