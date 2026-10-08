import { runMetaSnapshotForBusiness } from "@/lib/meta/snapshot";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { assertDbGrowthFenceAdmits, describeGrowthFenceRefusal } from "@/lib/sync/db-growth-fence";

export type MetaSnapshotRefreshReason =
  | "manual"
  | "campaign_labels_updated"
  | "commercial_truth_updated";

export type MetaSnapshotRefreshStatus =
  | "ran"
  | "already_running"
  | "cooldown"
  | "blocked"
  | "failed";

export interface MetaSnapshotRefreshResult {
  ok: boolean;
  status: MetaSnapshotRefreshStatus;
  businessId: string;
  snapshotDate: string;
  reason: MetaSnapshotRefreshReason;
  cooldownUntil: string | null;
  message: string;
  blockedReason?: string;
  admission?: { allowed: false; reason: string; evaluatedAt: string };
  result?: Awaited<ReturnType<typeof runMetaSnapshotForBusiness>>;
}

export const META_SNAPSHOT_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

const inflightRefreshes = new Map<string, Promise<MetaSnapshotRefreshResult>>();
const lastRefreshStartedAt = new Map<string, number>();

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function cooldownUntil(startedAt: number, cooldownMs: number) {
  return new Date(startedAt + cooldownMs).toISOString();
}

export async function requestMetaSnapshotRefreshForBusiness(input: {
  businessId: string;
  /**
   * One assigned account, or omitted for "every assigned account".
   *
   * A selected-account manual control passes its account so the refresh is the
   * same per-account computation the surface reads. Omitted keeps the
   * whole-business orchestration, which still computes each account
   * independently — it is the ENTRY POINT that is business-wide, never the
   * computation.
   */
  providerAccountId?: string | null;
  reason: MetaSnapshotRefreshReason;
  snapshotDate?: string | null;
  cooldownMs?: number;
  force?: boolean;
}): Promise<MetaSnapshotRefreshResult> {
  const businessId = input.businessId.trim();
  const snapshotDate = input.snapshotDate?.trim() || todayISO();
  const cooldownMs = input.cooldownMs ?? META_SNAPSHOT_REFRESH_COOLDOWN_MS;
  const blocked = (blockedReason: string, message: string): MetaSnapshotRefreshResult => ({
    ok: false, status: "blocked", businessId, snapshotDate, reason: input.reason,
    cooldownUntil: null, blockedReason, message,
  });
  // Selected scope and admission precede cooldown, inflight success and the
  // calibration/backfill writes. force cannot bypass either boundary. Typed
  // refusal also lets callers report settings saved / refresh blocked.
  if (input.providerAccountId?.trim()) {
    try {
      const assignment = await getProviderAccountAssignments(businessId, "meta");
      if (!assignment?.account_ids.includes(input.providerAccountId.trim())) {
        return blocked("provider_account_not_assigned", "This Meta account is no longer assigned to this workspace. Select an assigned account before refreshing decisions.");
      }
    } catch {
      return blocked("account_scope_unavailable", "The selected Meta account could not be verified. Decision generation has not started.");
    }
  }
  try {
    await assertDbGrowthFenceAdmits("meta.snapshot_refresh");
  } catch (error) {
    const refusal = describeGrowthFenceRefusal(error);
    const reason = refusal?.decision.reason ?? "fence_read_failed";
    return {
      ...blocked(reason, reason === "fence_read_failed"
        ? "Decision generation safety checks could not be verified. No refresh has started; retry after admission can be verified."
        : "Database capacity currently prevents new decision generation. Existing decisions remain available for review. Re-evaluate after admission is restored."),
      admission: { allowed: false, reason, evaluatedAt: refusal?.decision.evaluatedAt ?? new Date().toISOString() },
    };
  }
  /*
   * The key carries the ACCOUNT, when one was asked for.
   *
   * Generation is per assigned account now, and a business-wide key made two
   * accounts share one in-flight promise and one five-minute cooldown: a
   * request for account B returned account A's promise as
   * `{ok: true, status: "already_running"}` — a success response for a run
   * that never touched B — or parked B in a cooldown it never asked for.
   */
  const accountKey = input.providerAccountId?.trim() || "*";
  const key = `${businessId}:${accountKey}:${snapshotDate}`;
  const running = inflightRefreshes.get(key);
  if (running) {
    return {
      ok: true,
      status: "already_running",
      businessId,
      snapshotDate,
      reason: input.reason,
      cooldownUntil: null,
      message: "A Meta recommendation snapshot refresh is already running for this business.",
    };
  }

  const lastStartedAt = lastRefreshStartedAt.get(key);
  const now = Date.now();
  if (!input.force && lastStartedAt != null && now - lastStartedAt < cooldownMs) {
    return {
      ok: true,
      status: "cooldown",
      businessId,
      snapshotDate,
      reason: input.reason,
      cooldownUntil: cooldownUntil(lastStartedAt, cooldownMs),
      message: "Meta recommendation snapshot refresh is in cooldown.",
    };
  }

  lastRefreshStartedAt.set(key, now);
  const refresh = runMetaSnapshotForBusiness(
    businessId,
    snapshotDate,
    input.providerAccountId ?? null,
  )
    .then((result) => ({
      ok: true,
      status: "ran" as const,
      businessId,
      snapshotDate,
      reason: input.reason,
      cooldownUntil: cooldownUntil(now, cooldownMs),
      message: "Meta recommendation snapshot refreshed.",
      result,
    }))
    .catch((error) => {
      lastRefreshStartedAt.delete(key);
      return {
        ok: false,
        status: "failed" as const,
        businessId,
        snapshotDate,
        reason: input.reason,
        cooldownUntil: null,
        message: error instanceof Error ? error.message : "Meta recommendation snapshot refresh failed.",
      };
    })
    .finally(() => {
      inflightRefreshes.delete(key);
    });

  inflightRefreshes.set(key, refresh);
  return refresh;
}
