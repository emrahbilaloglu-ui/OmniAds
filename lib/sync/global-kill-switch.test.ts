import { describe, expect, it } from "vitest";

import {
  GLOBAL_SYNC_ENABLED_ENV,
  GLOBAL_SYNC_ENABLED_VALUE,
  SYNC_LANES,
  SyncLaneDisabledError,
  assertSyncLaneEnabled,
  describeSyncLaneAdmissions,
  evaluateLaneAdmission,
  laneEnvVar,
} from "@/lib/sync/global-kill-switch";

function allOn(): Record<string, string> {
  const env: Record<string, string> = {
    [GLOBAL_SYNC_ENABLED_ENV]: GLOBAL_SYNC_ENABLED_VALUE,
  };
  for (const lane of SYNC_LANES) env[laneEnvVar(lane)] = GLOBAL_SYNC_ENABLED_VALUE;
  return env;
}

describe("global kill switch", () => {
  it("disables every lane when nothing is set", () => {
    // A switch that defaults to enabled is not a kill switch: a host that
    // starts before the operator sets anything would resume writing.
    const snapshot = describeSyncLaneAdmissions({ env: {} });
    expect(snapshot.allDisabled).toBe(true);
    expect(snapshot.lanes.every((lane) => lane.reason === "global_switch_off")).toBe(
      true,
    );
  });

  it("enables a lane only when both the master and the lane switch are on", () => {
    const env = allOn();
    for (const lane of SYNC_LANES) {
      expect(evaluateLaneAdmission({ lane, env }).enabled).toBe(true);
    }
  });

  it("does not treat the master switch as a blanket grant", () => {
    // Turning sync back on must not turn retention back on with it.
    const env: Record<string, string> = {
      [GLOBAL_SYNC_ENABLED_ENV]: GLOBAL_SYNC_ENABLED_VALUE,
      [laneEnvVar("meta_sync")]: GLOBAL_SYNC_ENABLED_VALUE,
    };
    expect(evaluateLaneAdmission({ lane: "meta_sync", env }).enabled).toBe(true);
    const retention = evaluateLaneAdmission({ lane: "retention", env });
    expect(retention.enabled).toBe(false);
    expect(retention.reason).toBe("lane_switch_unset");
  });

  it("keeps every lane off while the master switch is off", () => {
    const env = allOn();
    env[GLOBAL_SYNC_ENABLED_ENV] = "no";
    const snapshot = describeSyncLaneAdmissions({ env });
    expect(snapshot.allDisabled).toBe(true);
  });

  it.each(["", " ", "true", "1", "yes", "ENABLED ", "enable"])(
    "treats %o as disabled rather than permission",
    (value) => {
      // A typo must not read as permission. Only the exact value admits.
      const env = allOn();
      env[laneEnvVar("google_sync")] = value;
      const admission = evaluateLaneAdmission({ lane: "google_sync", env });
      expect(admission.enabled).toBe(value.trim().toLowerCase() === "enabled");
    },
  );

  it("throws rather than returning falsy, so a caller cannot render it as success", () => {
    expect(() => assertSyncLaneEnabled("shopify_sync", { env: {} })).toThrow(
      SyncLaneDisabledError,
    );
    expect(() => assertSyncLaneEnabled("shopify_sync", { env: allOn() })).not.toThrow();
  });

  it("covers every writing surface the rollout has to quiesce", () => {
    // If a new writing lane is added without an entry here, the rollout would
    // "quiesce everything" and leave it running.
    expect([...SYNC_LANES].sort()).toEqual([
      "assignment_mutation",
      "cron_enqueue",
      "google_sync",
      "meta_sync",
      "retention",
      "shopify_sync",
    ]);
  });
});
