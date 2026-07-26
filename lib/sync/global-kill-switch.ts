/**
 * Runtime admission for every writer that can violate a sync or cutover
 * contract.
 *
 * SCOPE, precisely. This covers external-source ingestion (Meta, Google,
 * Shopify including its webhooks, GA4, Search Console), the enqueue paths that
 * create durable work, account-selection mutation, and destructive retention.
 * It does NOT claim to stop every write in the process — ordinary bookkeeping
 * such as request logs, cache rows and derived decision records is out of
 * scope, and pretending otherwise would be documentation that is broader than
 * the code.
 *
 * For the migration's true zero-writer interval, this switch is NOT the
 * authority: physically stopping web, worker and the external scheduler is.
 * A runtime flag cannot stop a process that is already inside a transaction,
 * and it takes effect only when containers are recreated. The switch's job is
 * to keep work from RESUMING once those processes come back up.
 *
 * The rollout for this change is global and one-shot: there is a single user
 * and a canary over one business would only delay the same risk while running
 * two schemas at once. What replaces the canary is the ability to stop, so the
 * order of operations is: turn everything off, migrate, deploy everywhere,
 * verify, turn everything back on in one action.
 *
 * Design constraints, each because of a specific way this can go wrong:
 *
 *  - Default is OFF for the rollout window and must be set explicitly to
 *    resume. A switch that defaults to "enabled" is not a kill switch, because
 *    a host that starts before the operator sets anything resumes writing.
 *  - Lanes are individually addressable AND globally addressable. Enabling
 *    "sync" must not silently enable retention.
 *  - Retention is separate and stays off by default even when everything else
 *    is on, because it is the only path that deletes.
 *  - An unparseable value disables. A typo must not read as permission.
 */

export const SYNC_LANES = [
  "meta_sync",
  "google_sync",
  "shopify_sync",
  /**
   * Non-Ads external-source ingestion: GA4, Search Console, and any other
   * writer that pulls from an external source into the warehouse. These were
   * outside the switch entirely, so "global OFF stops everything that writes"
   * was false for them.
   */
  "source_ingest",
  /** Cron and any enqueue path that creates durable work. */
  "cron_enqueue",
  /** Account selection mutation, which changes what everything else acts on. */
  "assignment_mutation",
  /** The only path that deletes. Deliberately last and deliberately separate. */
  "retention",
] as const;

export type SyncLane = (typeof SYNC_LANES)[number];

/** Master switch. Absent or anything other than the exact value = everything off. */
export const GLOBAL_SYNC_ENABLED_ENV = "ADSECUTE_SYNC_GLOBAL_ENABLED";
export const GLOBAL_SYNC_ENABLED_VALUE = "enabled";

export function laneEnvVar(lane: SyncLane) {
  return `ADSECUTE_SYNC_LANE_${lane.toUpperCase()}_ENABLED`;
}

export interface LaneAdmission {
  lane: SyncLane;
  enabled: boolean;
  reason:
    | "enabled"
    | "global_switch_off"
    | "lane_switch_off"
    | "lane_switch_unset";
}

function readSwitch(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
) {
  const raw = env[name];
  if (raw == null) return "unset" as const;
  return raw.trim().toLowerCase() === GLOBAL_SYNC_ENABLED_VALUE
    ? ("on" as const)
    : ("off" as const);
}

export function evaluateLaneAdmission(input: {
  lane: SyncLane;
  env?: Readonly<Record<string, string | undefined>>;
}): LaneAdmission {
  const env = input.env ?? process.env;
  const global = readSwitch(env, GLOBAL_SYNC_ENABLED_ENV);
  if (global !== "on") {
    return { lane: input.lane, enabled: false, reason: "global_switch_off" };
  }
  const lane = readSwitch(env, laneEnvVar(input.lane));
  if (lane === "unset") {
    // The master switch is not a blanket grant. Each lane is turned on
    // deliberately, so "resume sync" cannot accidentally resume retention.
    return { lane: input.lane, enabled: false, reason: "lane_switch_unset" };
  }
  if (lane === "off") {
    return { lane: input.lane, enabled: false, reason: "lane_switch_off" };
  }
  return { lane: input.lane, enabled: true, reason: "enabled" };
}

export class SyncLaneDisabledError extends Error {
  readonly code = "SYNC_LANE_DISABLED";
  readonly admission: LaneAdmission;
  constructor(admission: LaneAdmission) {
    super(`Sync lane '${admission.lane}' is disabled (${admission.reason}).`);
    this.name = "SyncLaneDisabledError";
    this.admission = admission;
  }
}

/**
 * Throws when the lane is off.
 *
 * Throws rather than returning falsy for the same reason the capacity fence
 * does: a caller cannot accidentally render "disabled" as benign success, and
 * a route that catches it can answer truthfully.
 */
export function assertSyncLaneEnabled(
  lane: SyncLane,
  options?: { env?: Readonly<Record<string, string | undefined>> },
): LaneAdmission {
  const admission = evaluateLaneAdmission({ lane, env: options?.env });
  if (!admission.enabled) {
    throw new SyncLaneDisabledError(admission);
  }
  return admission;
}

/** Snapshot of every lane, for a readiness endpoint or a rollout check. */
export function describeSyncLaneAdmissions(options?: {
  env?: Readonly<Record<string, string | undefined>>;
}): { allDisabled: boolean; lanes: LaneAdmission[] } {
  const lanes = SYNC_LANES.map((lane) =>
    evaluateLaneAdmission({ lane, env: options?.env }),
  );
  return { allDisabled: lanes.every((entry) => !entry.enabled), lanes };
}

/**
 * Outer admission for EVERY destructive retention path, including the legacy
 * per-provider policies that carry their own `*_RETENTION_EXECUTION_ENABLED`
 * flags and a `forceExecute` argument.
 *
 * The retention lane has to sit OUTSIDE those, or "global off stops all
 * deletion" is false: the worker loop invokes the legacy Google and Meta
 * policies directly, and either of their own flags — or a caller passing
 * forceExecute — would delete while the lane said stop.
 *
 * Downgrades to dry-run rather than throwing. A throw would break the worker
 * loop and remove the dry-run visibility the rollout depends on; a dry run
 * deletes nothing, which is the property that actually matters.
 */
export function resolveDestructiveRetentionMode(input: {
  /** What the caller's own flags/arguments asked for. */
  requestedExecute: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}): {
  mode: "execute" | "dry_run";
  laneAdmission: LaneAdmission;
  downgradedByLane: boolean;
} {
  const laneAdmission = evaluateLaneAdmission({ lane: "retention", env: input.env });
  const downgradedByLane = input.requestedExecute && !laneAdmission.enabled;
  if (downgradedByLane) {
    console.warn("[sync-kill-switch] retention execution downgraded to dry run", {
      reason: laneAdmission.reason,
    });
  }
  return {
    mode: input.requestedExecute && laneAdmission.enabled ? "execute" : "dry_run",
    laneAdmission,
    downgradedByLane,
  };
}
