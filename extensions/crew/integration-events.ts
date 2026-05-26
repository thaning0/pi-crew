import { createHash } from "node:crypto";

export type CrewAddActivation = "immediate" | "manual";
export type CrewDeliveryState = "pending" | "held" | "enabled" | "ended";

export interface CrewLifecycleEvent {
	event_id: string;
	request_id: string;
	command_id: string;
	requested_name: string;
	member_target: string;
	spawn_task_id: string;
	activation: CrewAddActivation | null;
	delivery_state: CrewDeliveryState;
	hold_expires_at: string | null;
	error: string | null;
	reason: string | null;
}

export type CrewLifecycleEventInput = Omit<CrewLifecycleEvent, "event_id">;

interface CrewLifecycleEventSeed {
	request_id: string;
	command_id: string;
	requested_name: string;
	member_target: string;
	spawn_task_id: string;
	activation?: CrewAddActivation | null;
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
		request_id: input.request_id,
		command_id: input.command_id,
		requested_name: input.requested_name,
		member_target: input.member_target,
		spawn_task_id: input.spawn_task_id,
		activation: input.activation ?? null,
		delivery_state: input.delivery_state,
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

function buildCrewLifecycleEvent(
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
	delivery_state: CrewDeliveryState,
	overrides: Partial<
		Pick<CrewLifecycleEventInput, "hold_expires_at" | "error" | "reason">
	> = {},
): CrewLifecycleEventInput {
	return normalizeLifecycleEvent({
		request_id: seed.request_id,
		command_id: seed.command_id,
		requested_name: seed.requested_name,
		member_target: seed.member_target,
		spawn_task_id: seed.spawn_task_id,
		activation: seed.activation ?? null,
		delivery_state,
		hold_expires_at: overrides.hold_expires_at ?? null,
		error: overrides.error ?? seed.error ?? null,
		reason: overrides.reason ?? seed.reason ?? null,
	});
}

export function createCrewPendingLifecycleEvent(
	seed: CrewLifecycleEventSeed,
): CrewLifecycleEventInput {
	return createCrewLifecycleEvent(seed, "pending");
}

export function createCrewHeldLifecycleEvent(
	seed: CrewLifecycleEventSeed & { hold_expires_at: string },
): CrewLifecycleEventInput {
	return createCrewLifecycleEvent(seed, "held", {
		hold_expires_at: seed.hold_expires_at,
	});
}

export function createCrewEnabledLifecycleEvent(
	seed: CrewLifecycleEventSeed,
): CrewLifecycleEventInput {
	return createCrewLifecycleEvent(seed, "enabled");
}

export function createCrewEndedLifecycleEvent(
	seed: CrewLifecycleEventSeed,
): CrewLifecycleEventInput {
	return createCrewLifecycleEvent(seed, "ended");
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
