import { describe, expect, it } from "vitest";
import {
  getProviderScopeWorkerObservation,
  getProviderSharedProcessObservation,
  selectProviderWorkerForBusiness,
} from "@/lib/sync/worker-health";

describe("selectProviderWorkerForBusiness", () => {
  it("prefers the active lease owner when available", () => {
    const worker = selectProviderWorkerForBusiness({
      businessId: "grandmix",
      activeLeaseOwner: "worker-2",
      workers: [
        {
          workerId: "worker-1",
          lastBusinessId: "other-biz",
          lastConsumedBusinessId: "other-biz",
          metaJson: { currentBusinessId: "other-biz" },
        },
        {
          workerId: "worker-2",
          lastBusinessId: "grandmix",
          lastConsumedBusinessId: "grandmix",
          metaJson: { currentBusinessId: "grandmix" },
        },
      ],
    });

    expect(worker?.workerId).toBe("worker-2");
  });

  it("matches provider-scoped heartbeat rows to the base lease owner", () => {
    const worker = selectProviderWorkerForBusiness({
      businessId: "grandmix",
      activeLeaseOwner: "worker-2",
      workers: [
        {
          workerId: "worker-1:meta",
          lastBusinessId: "other-biz",
          lastConsumedBusinessId: "other-biz",
          metaJson: { currentBusinessId: "other-biz" },
        },
        {
          workerId: "worker-2:meta",
          lastBusinessId: "grandmix",
          lastConsumedBusinessId: "grandmix",
          metaJson: { currentBusinessId: "grandmix" },
        },
      ],
    });

    expect(worker?.workerId).toBe("worker-2:meta");
  });

  it("falls back to current or batched business matches before the newest unrelated worker", () => {
    const worker = selectProviderWorkerForBusiness({
      businessId: "grandmix",
      workers: [
        {
          workerId: "worker-1",
          lastBusinessId: "other-biz",
          lastConsumedBusinessId: "other-biz",
          metaJson: { currentBusinessId: "other-biz" },
        },
        {
          workerId: "worker-2",
          lastBusinessId: "another-biz",
          lastConsumedBusinessId: "another-biz",
          metaJson: { batchBusinessIds: ["foo", "grandmix", "bar"] },
        },
      ],
    });

    expect(worker?.workerId).toBe("worker-2");
  });

  it("does not fall back to the newest unrelated worker when no business match exists", () => {
    const worker = selectProviderWorkerForBusiness({
      businessId: "grandmix",
      workers: [
        {
          workerId: "worker-1",
          lastBusinessId: "other-biz",
          lastConsumedBusinessId: "other-biz",
          metaJson: { currentBusinessId: "other-biz" },
        },
        {
          workerId: "worker-2",
          lastBusinessId: "another-biz",
          lastConsumedBusinessId: "another-biz",
          metaJson: { batchBusinessIds: ["foo", "bar"] },
        },
      ],
    });

    expect(worker).toBeNull();
  });
});

describe("shared process availability does not advance provider evidence", () => {
  const nowMs = Date.parse("2026-10-18T00:00:00Z");
  function workers() {
    const boot = { workerBuildId: "current-build", workerStartedAt: "2026-10-17T23:00:00Z" };
    return [
      { workerId: "worker:meta", providerScope: "meta", status: "idle", workerFreshnessState: "stale" as const,
        lastHeartbeatAt: "2026-10-17T23:50:00Z", metaJson: { ...boot } },
      { workerId: "worker", providerScope: "all", status: "running", workerFreshnessState: "online" as const,
        lastHeartbeatAt: "2026-10-17T23:59:45Z", metaJson: { ...boot, activeProviderScope: "google_ads" } },
    ];
  }
  it("recognizes an exact live boot working another provider while Meta's own clock stays stale", () => {
    const rows = workers();
    expect(getProviderSharedProcessObservation({ providerScope: "meta", staleThresholdMs: 180000, nowMs, workers: rows }))
      .toMatchObject({ workerId: "worker", waitingForProviderTurn: true, heartbeatAgeMs: 15000 });
    expect(getProviderScopeWorkerObservation({ providerScope: "meta", staleThresholdMs: 180000, nowMs, workers: rows }))
      .toMatchObject({ hasFreshHeartbeat: false, lastHeartbeatAt: "2026-10-17T23:50:00.000Z" });
  });
  it.each(["different_process", "different_build", "different_boot", "stale_process", "future_process", "stopped_process", "disabled_provider", "same_scope", "missing_provider", "admission_refused"])
    ("refuses an unproven shared process: %s", (reason) => {
      const rows = workers();
      if (reason === "different_process") rows[1]!.workerId = "other-worker";
      if (reason === "different_build") rows[1]!.metaJson.workerBuildId = "old-build";
      if (reason === "different_boot") rows[1]!.metaJson.workerStartedAt = "2026-10-17T22:00:00Z";
      if (reason === "stale_process") rows[1]!.lastHeartbeatAt = "2026-10-17T23:50:00Z";
      if (reason === "future_process") rows[1]!.lastHeartbeatAt = "2026-10-18T00:01:00Z";
      if (reason === "stopped_process") rows[1]!.status = "stopped";
      if (reason === "disabled_provider") rows[0]!.status = "disabled";
      if (reason === "same_scope") Object.assign(rows[1]!.metaJson, { activeProviderScope: "meta" });
      if (reason === "missing_provider") rows.shift();
      if (reason === "admission_refused") Object.assign(rows[1]!.metaJson, { businessAdmitted: false });
      expect(getProviderSharedProcessObservation({ providerScope: "meta", staleThresholdMs: 180000, nowMs, workers: rows }).waitingForProviderTurn).toBe(false);
    });
});

describe("business consume metadata belongs to available workers", () => {
  it("does not reuse an outgoing worker's stale business stage ahead of a current batch", () => {
    const old = { workerId: "old:meta", workerFreshnessState: "stale" as const, lastBusinessId: "grandmix", lastConsumedBusinessId: "grandmix" };
    const current = { workerId: "current:meta", workerFreshnessState: "online" as const, lastBusinessId: "other", metaJson: { batchBusinessIds: ["grandmix"] } };
    expect(selectProviderWorkerForBusiness({ businessId: "grandmix", workers: [old, current] })?.workerId).toBe("current:meta");
    expect(selectProviderWorkerForBusiness({ businessId: "grandmix", workers: [old] })).toBeNull();
    expect(selectProviderWorkerForBusiness({ businessId: "grandmix", activeLeaseOwner: "old", workers: [old, current] })?.workerId).toBe("old:meta");
  });
});

describe("getProviderScopeWorkerObservation", () => {
  it.each(["stopped", "staged"] as const)("does not treat a fresh %s row as available", (workerFreshnessState) => {
    expect(getProviderScopeWorkerObservation({ providerScope: "meta", staleThresholdMs: 180000,
      nowMs: Date.parse("2026-10-18T00:00:00Z"), workers: [{ workerId: "worker:meta", providerScope: "meta", workerFreshnessState, lastHeartbeatAt: "2026-10-18T00:00:00Z" }] }).hasFreshHeartbeat).toBe(false);
  });
  it("returns the freshest worker heartbeat for the provider scope", () => {
    const observation = getProviderScopeWorkerObservation({
      providerScope: "meta",
      staleThresholdMs: 3 * 60_000,
      nowMs: new Date("2026-04-15T10:00:00.000Z").getTime(),
      workers: [
        {
          workerId: "worker-1:meta",
          providerScope: "meta",
          workerFreshnessState: "stale",
          lastHeartbeatAt: "2026-04-15T09:40:00.000Z",
          metaJson: {},
        },
        {
          workerId: "worker-2:meta",
          providerScope: "meta",
          workerFreshnessState: "online",
          lastHeartbeatAt: "2026-04-15T09:59:30.000Z",
          metaJson: {},
        },
        {
          workerId: "worker-3:google_ads",
          providerScope: "google_ads",
          workerFreshnessState: "online",
          lastHeartbeatAt: "2026-04-15T09:59:45.000Z",
          metaJson: {},
        },
      ],
    });

    expect(observation).toMatchObject({
      workerId: "worker-2:meta",
      hasFreshHeartbeat: true,
      lastHeartbeatAt: "2026-04-15T09:59:30.000Z",
      workerFreshnessState: "online",
    });
  });
});
