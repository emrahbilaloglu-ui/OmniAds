import { describe, expect, it } from "vitest";
import { buildMetaSyncCapability, deriveMetaOperationsBlockReason } from "@/lib/meta/status-operations";

describe("sync capability does not infer work from liveness or readable data", () => {
  const at = "2026-10-08T06:00:00Z";
  const now = Date.parse(at);
  it("reports capacity idle even with healthy heartbeat and no queued work", () => {
    const capability = buildMetaSyncCapability({ allowed: false, reason: "database_budget_exceeded", evaluatedAt: at }, now);
    expect(capability).toMatchObject({ state: "capacity_refused", canStartSync: false, reason: "database_budget_exceeded" });
    expect(deriveMetaOperationsBlockReason({ workerHealthy: true, queueDepth: 0, leasedPartitions: 0, syncCapability: capability })).toBe("capacity_refused");
  });
  it("does not promote absent, stale, future or failed admission to capability", () => {
    for (const decision of [null,
      { allowed: true, reason: "ready" as const, evaluatedAt: "2026-10-08T05:58:00Z" },
      { allowed: true, reason: "ready" as const, evaluatedAt: "2026-10-08T06:00:01Z" },
      { allowed: false, reason: "fence_read_failed" as const, evaluatedAt: at }]) {
      expect(buildMetaSyncCapability(decision, now)).toMatchObject({ state: "unknown", canStartSync: false });
    }
  });
  it("admits the positive control without claiming a worker or a sync ran", () => {
    expect(buildMetaSyncCapability({ allowed: true, reason: "ready", evaluatedAt: at }, now)).toMatchObject({ state: "admitted", canStartSync: true });
  });
});

describe("deriveMetaOperationsBlockReason", () => {
  it("returns worker_offline when queue exists but worker is unhealthy", () => {
    expect(
      deriveMetaOperationsBlockReason({
        workerHealthy: false,
        queueDepth: 5,
        leasedPartitions: 0,
      })
    ).toBe("worker_offline");
  });

  it("returns lease_denied when worker is healthy but lease was denied", () => {
    expect(
      deriveMetaOperationsBlockReason({
        workerHealthy: true,
        queueDepth: 5,
        leasedPartitions: 0,
        consumeStage: "lease_denied",
      })
    ).toBe("lease_denied");
  });

  it("returns queue_backlogged when queue exists without leases and activity is stale", () => {
    expect(
      deriveMetaOperationsBlockReason({
        workerHealthy: true,
        queueDepth: 12,
        leasedPartitions: 0,
        heartbeatAgeMs: 60_000,
        latestActivityAt: "2026-03-30T16:00:00.000Z",
        historicalCoreQueued: 6,
        nowMs: new Date("2026-03-30T17:00:00.000Z").getTime(),
      })
    ).toBe("queue_backlogged");
  });

  it("does not report queue_backlogged for maintenance-only pressure", () => {
    expect(
      deriveMetaOperationsBlockReason({
        workerHealthy: true,
        queueDepth: 12,
        leasedPartitions: 0,
        heartbeatAgeMs: 60_000,
        latestActivityAt: "2026-03-30T16:00:00.000Z",
        maintenanceQueued: 12,
        nowMs: new Date("2026-03-30T17:00:00.000Z").getTime(),
      })
    ).toBeNull();
  });

  it("returns null when queue is actively leased", () => {
    expect(
      deriveMetaOperationsBlockReason({
        workerHealthy: true,
        queueDepth: 8,
        leasedPartitions: 2,
        consumeStage: "consume_started",
      })
    ).toBeNull();
  });
});
