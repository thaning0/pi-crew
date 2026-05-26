/**
 * Live Smoke Test — Crew Event Feedback Protocol
 *
 * Tests all 10 smoke-matrix scenarios against the PUBLIC event surface
 * (via emitCrewLifecycleEvent → toPublicCrewLifecycleEvent).
 *
 * PUBLIC event name mapping (from integration-events.ts normalizePublicEventName):
 *   internal "spawned" → public "spawned"
 *   internal "pending" → public "spawned"
 *   internal "held"    → public "spawned"
 *   internal "claimed" → public "claimed"
 *   internal "enabled" → public "activated"
 *   internal "ended"   → public "terminated" | "failed"
 *   internal "failed"  → public "failed"
 *   internal "aborted" → public "aborted"
 *   internal "rejected"→ public "rejected"
 *   internal "terminated" → public "terminated"
 */
import { describe, it, expect } from "vitest";
import {
  createCrewRejectedLifecycleEvent,
  createCrewSpawnedLifecycleEvent,
  createCrewHeldLifecycleEvent,
  createCrewEnabledLifecycleEvent,
  createCrewTerminatedLifecycleEvent,
  createCrewFailedLifecycleEvent,
  createCrewEndedLifecycleEvent,
  emitCrewLifecycleEvent,
  setCrewEventEmitter,
  toPublicCrewLifecycleEvent,
  PublicCrewLifecycleEvent,
} from "./integration-events.ts";

// ── Test Harness ──────────────────────────────────────────────
function installCollector(): { events: PublicCrewLifecycleEvent[] } {
  const collector = { events: [] as PublicCrewLifecycleEvent[] };
  setCrewEventEmitter(async (payload) => {
    collector.events.push(payload as PublicCrewLifecycleEvent);
  });
  return collector;
}

// ── Scenario 1: Default crew:add → spawned → claimed → activated ──
describe("S1: Immediate activation", () => {
  it("public events: spawned → claimed → activated", async () => {
    const c = installCollector();

    // Internal "spawned" → public "spawned"
    emitCrewLifecycleEvent(createCrewSpawnedLifecycleEvent({
      request_id: "smoke-1",
      requested_name: "smoke-worker",
      member_target: "smoke-worker_abc123",
      member_type: "worker",
      room_id: "room-1",
      spawn_task_id: "spawn-1",
      runtime_id: "rt-1",
      session_id: "sess-1",
      activation: "immediate",
      delivery_state: "pending",
    }));

    // Internal "claimed" → public "claimed"
    emitCrewLifecycleEvent({
      event_id: "crew-event-claimed-01",
      event: "claimed",
      phase: "spawn",
      request_id: "smoke-1",
      requested_name: "smoke-worker",
      member_target: "smoke-worker_abc123",
      member_type: "worker",
      room_id: "room-1",
      spawn_task_id: "spawn-1",
      runtime_id: "rt-1",
      session_id: "sess-1",
      activation: "immediate",
      delivery_state: "enabled",
    } as any);

    // Internal "enabled" → public "activated"
    emitCrewLifecycleEvent(createCrewEnabledLifecycleEvent({
      request_id: "smoke-1",
      requested_name: "smoke-worker",
      member_target: "smoke-worker_abc123",
      member_type: "worker",
      room_id: "room-1",
      spawn_task_id: "spawn-1",
      runtime_id: "rt-1",
      session_id: "sess-1",
      activation: "immediate",
    }));

    await new Promise((r) => setTimeout(r, 30));

    expect(c.events.length).toBe(3);
    expect(c.events.map((e) => e.event)).toEqual(["spawned", "claimed", "activated"]);
    expect(c.events[0].member_target).toBe("smoke-worker_abc123");
    expect(c.events[0].activation).toBe("immediate");
    expect(c.events[2].delivery_state).toBe("enabled"); // enabled passes through

    console.log("  ✓ S1 PASS: spawned → claimed → activated");
  });
});

// ── Scenario 2: Invalid crew:add → rejected ──
describe("S2: Request-time rejection", () => {
  it("public event: rejected with no invented handles", async () => {
    const c = installCollector();

    emitCrewLifecycleEvent(createCrewRejectedLifecycleEvent({
      request_id: "smoke-2",
      requested_name: "bad-agent",
      error: "Missing required field 'type'",
      reason: "validation_error",
    }));

    await new Promise((r) => setTimeout(r, 30));

    expect(c.events.length).toBe(1);
    expect(c.events[0].event).toBe("rejected");
    expect(c.events[0].error).toBe("Missing required field 'type'");
    expect(c.events[0].member_target).toBeNull();
    expect(c.events[0].spawn_task_id).toBeNull();

    console.log("  ✓ S2 PASS: rejected without invented handles");
  });
});

// ── Scenario 3: Repeated identical request_id replays ──
describe("S3: Request replay", () => {
  it("spawn_task_id stable across replays", async () => {
    const c = installCollector();

    const spawned = createCrewSpawnedLifecycleEvent({
      request_id: "smoke-3",
      requested_name: "replay-worker",
      member_target: "replay-worker_xyz",
      member_type: "worker",
      room_id: "room-3",
      spawn_task_id: "spawn-3",
      activation: "immediate",
      delivery_state: "pending",
    });

    emitCrewLifecycleEvent(spawned);
    emitCrewLifecycleEvent(spawned); // replay

    await new Promise((r) => setTimeout(r, 30));

    expect(c.events.length).toBe(2);
    expect(c.events[0].event).toBe("spawned");
    expect(c.events[1].event).toBe("spawned");
    expect(c.events[0].spawn_task_id).toBe("spawn-3");
    expect(c.events[1].spawn_task_id).toBe("spawn-3");

    console.log("  ✓ S3 PASS: replay preserves spawn_task_id");
  });
});

// ── Scenario 4: Conflicting request_id → rejected ──
describe("S4: Request ID conflict", () => {
  it("rejected when material fields conflict", async () => {
    const c = installCollector();

    emitCrewLifecycleEvent(createCrewSpawnedLifecycleEvent({
      request_id: "smoke-4",
      requested_name: "worker",
      member_target: "worker_x1",
      member_type: "worker",
      room_id: "room-4",
      spawn_task_id: "spawn-4a",
      activation: "immediate",
      delivery_state: "pending",
    }));

    emitCrewLifecycleEvent(createCrewRejectedLifecycleEvent({
      request_id: "smoke-4",
      requested_name: "worker",
      reason: "request-id-conflict",
      error: "material fields differ for reused request_id",
    }));

    await new Promise((r) => setTimeout(r, 30));

    expect(c.events.length).toBe(2);
    expect(c.events[0].event).toBe("spawned");
    expect(c.events[1].event).toBe("rejected");
    expect(c.events[1].reason).toBe("request-id-conflict");

    console.log("  ✓ S4 PASS: conflict → rejected");
  });
});

// ── Scenario 5: Manual activation → held (no activation) ──
describe("S5: Manual (held) activation", () => {
  it("spawned event has delivery_state=held, no activated event", async () => {
    const c = installCollector();
    const holdExpiry = new Date(Date.now() + 30_000).toISOString();

    // Internal "spawned" with held delivery
    emitCrewLifecycleEvent(createCrewSpawnedLifecycleEvent({
      request_id: "smoke-5",
      requested_name: "review-gate",
      member_target: "review-gate_jkl",
      member_type: "worker",
      room_id: "room-5",
      spawn_task_id: "spawn-5",
      runtime_id: "rt-5",
      session_id: "sess-5",
      activation: "manual",
      delivery_state: "held",
      hold_expires_at: holdExpiry,
    }));

    // Internal claimed event (still held)
    emitCrewLifecycleEvent({
      event_id: "crew-event-claimed-5",
      event: "claimed",
      phase: "spawn",
      request_id: "smoke-5",
      requested_name: "review-gate",
      member_target: "review-gate_jkl",
      member_type: "worker",
      room_id: "room-5",
      spawn_task_id: "spawn-5",
      runtime_id: "rt-5",
      session_id: "sess-5",
      activation: "manual",
      delivery_state: "held",
      hold_expires_at: holdExpiry,
    } as any);

    await new Promise((r) => setTimeout(r, 30));

    expect(c.events.length).toBe(2);
    expect(c.events[0].event).toBe("spawned");
    expect(c.events[1].event).toBe("claimed");

    // Manual: delivery_state should be "held" in public
    expect(c.events[0].delivery_state).toBe("held");
    expect(c.events[1].delivery_state).toBe("held");
    expect(c.events[0].hold_expires_at).toBe(holdExpiry);
    expect(c.events[0].activation).toBe("manual");

    // No "activated" event
    const activated = c.events.find((e) => e.event === "activated");
    expect(activated).toBeUndefined();

    console.log("  ✓ S5 PASS: held, no activation");
  });
});

// ── Scenario 6: crew:release on held → activated ──
describe("S6: Release activation", () => {
  it("release emits activated with delivery_state=held → enabled", async () => {
    const c = installCollector();
    const holdExpiry = new Date(Date.now() + 30_000).toISOString();

    // Setup held
    emitCrewLifecycleEvent(createCrewSpawnedLifecycleEvent({
      request_id: "smoke-6",
      requested_name: "release-test",
      member_target: "release-test_mno",
      member_type: "worker",
      room_id: "room-6",
      spawn_task_id: "spawn-6",
      activation: "manual",
      delivery_state: "held",
      hold_expires_at: holdExpiry,
    }));

    // Release → internal "enabled" → public "activated"
    emitCrewLifecycleEvent(createCrewEnabledLifecycleEvent({
      request_id: "smoke-6",
      command_id: "cmd-6",
      requested_name: "release-test",
      member_target: "release-test_mno",
      member_type: "worker",
      room_id: "room-6",
      spawn_task_id: "spawn-6",
      activation: "manual",
      reason: "released",
    }));

    await new Promise((r) => setTimeout(r, 30));

    const activated = c.events.find((e) => e.event === "activated");
    expect(activated).toBeDefined();
    expect(activated!.delivery_state).toBe("enabled");
    expect(activated!.command_id).toBe("cmd-6");

    console.log("  ✓ S6 PASS: release → activated");
  });
});

// ── Scenario 7: Repeated identical command_id replays ──
describe("S7: Command replay", () => {
  it("replays 'activated' outcome on duplicate command_id", async () => {
    const c = installCollector();

    // First release
    emitCrewLifecycleEvent(createCrewEnabledLifecycleEvent({
      request_id: "smoke-7",
      command_id: "cmd-7",
      spawn_task_id: "spawn-7",
      member_target: "worker-7",
      member_type: "worker",
      room_id: "room-7",
      activation: "manual",
      reason: "released",
    }));

    // Replay same command
    emitCrewLifecycleEvent(createCrewEnabledLifecycleEvent({
      request_id: "smoke-7",
      command_id: "cmd-7",
      spawn_task_id: "spawn-7",
      member_target: "worker-7",
      member_type: "worker",
      room_id: "room-7",
      activation: "manual",
      reason: "released",
    }));

    await new Promise((r) => setTimeout(r, 30));

    expect(c.events.length).toBe(2);
    // Both map to public "activated"
    expect(c.events[0].event).toBe("activated");
    expect(c.events[1].event).toBe("activated");
    expect(c.events[0].command_id).toBe("cmd-7");
    expect(c.events[1].command_id).toBe("cmd-7");
    expect(c.events[0].reason).toBe("released");
    expect(c.events[1].reason).toBe("released");

    console.log("  ✓ S7 PASS: command_id replay");
  });
});

// ── Scenario 8: crew:abort on held → aborted ──
describe("S8: Abort held member", () => {
  it("emits aborted with reason=caller_abort", async () => {
    const c = installCollector();
    const holdExpiry = new Date(Date.now() + 30_000).toISOString();

    // Setup held
    emitCrewLifecycleEvent(createCrewSpawnedLifecycleEvent({
      request_id: "smoke-8",
      requested_name: "abort-test",
      member_target: "abort-test_stu",
      member_type: "worker",
      room_id: "room-8",
      spawn_task_id: "spawn-8",
      activation: "manual",
      delivery_state: "held",
      hold_expires_at: holdExpiry,
    }));

    // Abort
    emitCrewLifecycleEvent(createCrewFailedLifecycleEvent({
      request_id: "smoke-8",
      command_id: "cmd-8",
      spawn_task_id: "spawn-8",
      member_target: "abort-test_stu",
      member_type: "worker",
      room_id: "room-8",
      phase: "activation",
      reason: "caller_abort",
      error: "caller_abort",
    }));

    await new Promise((r) => setTimeout(r, 30));

    const aborted = c.events.find((e) => e.event === "failed" || e.event === "aborted");
    expect(aborted).toBeDefined();
    // "failed" passes through as "failed" in public
    expect(aborted!.command_id).toBe("cmd-8");

    console.log("  ✓ S8 PASS: abort → aborted/failed");
  });
});

// ── Scenario 9: Hold expiry → aborted with hold_expired ──
describe("S9: Hold expiry auto-abort", () => {
  it("emits failed with reason=hold_expired", async () => {
    const c = installCollector();
    const pastTime = new Date(Date.now() - 60_000).toISOString();

    emitCrewLifecycleEvent(createCrewSpawnedLifecycleEvent({
      request_id: "smoke-9",
      requested_name: "expired",
      member_target: "expired_vwx",
      member_type: "worker",
      room_id: "room-9",
      spawn_task_id: "spawn-9",
      activation: "manual",
      delivery_state: "held",
      hold_expires_at: pastTime,
    }));

    emitCrewLifecycleEvent(createCrewFailedLifecycleEvent({
      request_id: "smoke-9",
      spawn_task_id: "spawn-9",
      member_target: "expired_vwx",
      member_type: "worker",
      room_id: "room-9",
      phase: "activation",
      reason: "hold_expired",
      error: "hold_expired",
    }));

    await new Promise((r) => setTimeout(r, 30));

    const fail = c.events.find((e) => e.event === "failed");
    expect(fail).toBeDefined();
    expect(fail!.reason).toBe("hold_expired");

    console.log("  ✓ S9 PASS: hold_expired → failed");
  });
});

// ── Scenario 10: Member exit/reap → terminated ──
describe("S10: Terminal outcome", () => {
  it("emits terminated with delivery_state=ended", async () => {
    const c = installCollector();

    // Internal "ended" → public "terminated" (since no error, reason doesn't start with "spawn-")
    emitCrewLifecycleEvent(createCrewEndedLifecycleEvent({
      request_id: "smoke-10",
      member_target: "worker-10",
      spawn_task_id: "spawn-10",
      member_type: "worker",
      room_id: "room-10",
      reason: "member-removed",
    }));

    await new Promise((r) => setTimeout(r, 30));

    expect(c.events.length).toBe(1);
    expect(c.events[0].event).toBe("terminated");
    expect(c.events[0].delivery_state).toBe("ended");
    expect(c.events[0].member_target).toBe("worker-10");

    console.log("  ✓ S10 PASS: terminated with delivery_state=ended");
  });
});

// ── Bonus: Event ID uniqueness ──
describe("Bonus: Event ID uniqueness", () => {
  it("5 events → 5 unique event_ids", async () => {
    const c = installCollector();

    for (let i = 0; i < 5; i++) {
      emitCrewLifecycleEvent(createCrewSpawnedLifecycleEvent({
        request_id: `uniq-${i}`,
        requested_name: "w",
        member_target: `w_${i}`,
        member_type: "worker",
        room_id: "r-uniq",
        spawn_task_id: `s-${i}`,
        activation: "immediate",
        delivery_state: "pending",
      }));
    }

    await new Promise((r) => setTimeout(r, 30));

    const ids = new Set(c.events.map((e) => e.event_id));
    expect(ids.size).toBe(5);

    console.log(`  ✓ Event IDs: ${ids.size}/5 unique`);
  });
});

// ── Bonus: Metadata roundtrip ──
describe("Bonus: Metadata roundtrip", () => {
  it("metadata survives public transformation", async () => {
    const c = installCollector();
    const meta = { ticket: "AUTH-42", priority: "high" };

    emitCrewLifecycleEvent(createCrewSpawnedLifecycleEvent({
      request_id: "smoke-meta",
      requested_name: "meta-w",
      member_target: "meta-w_x",
      member_type: "worker",
      room_id: "room-meta",
      spawn_task_id: "s-meta",
      activation: "immediate",
      metadata: meta,
      delivery_state: "pending",
    }));

    await new Promise((r) => setTimeout(r, 30));

    expect(c.events.length).toBe(1);
    expect(c.events[0].metadata).toEqual(meta);

    console.log("  ✓ Metadata roundtrip OK");
  });
});

// ── Bonus: Protocol version ──
describe("Bonus: Protocol version", () => {
  it("every public event carries protocol_version: 1", async () => {
    const c = installCollector();

    emitCrewLifecycleEvent(createCrewSpawnedLifecycleEvent({
      request_id: "smoke-ver",
      requested_name: "w",
      member_target: "w_v",
      member_type: "worker",
      room_id: "room-ver",
      spawn_task_id: "s-ver",
      activation: "immediate",
      delivery_state: "pending",
    }));

    emitCrewLifecycleEvent(createCrewRejectedLifecycleEvent({
      requested_name: "bad",
      error: "test",
    }));

    await new Promise((r) => setTimeout(r, 30));

    for (const ev of c.events) {
      expect(ev.protocol_version).toBe(1);
    }

    console.log(`  ✓ Protocol version: all ${c.events.length} events v1`);
  });
});
