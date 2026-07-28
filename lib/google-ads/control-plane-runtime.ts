import { resolveSyncControlPlaneKey } from "@/lib/sync/control-plane-key";
import type {
  GoogleAdsSyncStateRecord,
  GoogleAdsWarehouseScope,
} from "@/lib/google-ads/warehouse-types";
import type { GoogleAdsCompletionState } from "@/lib/google-ads/completion-semantics";
import type { GoogleAdsFreshnessSnapshot } from "@/lib/google-ads/freshness-read";

const GOOGLE_ADS_CONTROL_PLANE_SCOPES = [
  "account_daily",
  "campaign_daily",
  "search_term_daily",
  "product_daily",
  "asset_group_daily",
  "asset_daily",
  "geo_daily",
  "device_daily",
  "audience_daily",
] as const;

const GOOGLE_ADS_CORE_RELEASE_SCOPES = new Set(["account_daily", "campaign_daily"]);

/** The core scopes as an ordered list, for the one bulk freshness read. */
const GOOGLE_ADS_CORE_FRESHNESS_SCOPES: readonly GoogleAdsWarehouseScope[] = [
  "account_daily",
  "campaign_daily",
];

function isGoogleAdsCoreReleaseScope(scope: unknown) {
  return GOOGLE_ADS_CORE_RELEASE_SCOPES.has(String(scope ?? ""));
}

/**
 * Mirrors the ordering used by `weakestGoogleAdsCompletion`.
 *
 * Duplicated rather than imported because that helper lives in the DB-backed
 * read module and the pure half of this one must stay importable without a
 * database. The duplication is compile-checked: `Record<GoogleAdsCompletionState,
 * number>` fails to build if the state union ever grows and this table is not
 * updated.
 */
const COMPLETION_RANK: Record<GoogleAdsCompletionState, number> = {
  unknown: 0,
  missing: 1,
  provisional: 2,
  converging: 3,
  settled: 4,
};

/**
 * The states that mean EVERY day in the measured range was re-read after it
 * closed.
 *
 * Deliberately not `settled` alone. A rolling range always holds its most
 * recent ~30 days inside the conversion window, so `settled` is unreachable for
 * it, and demanding it would pin every healthy workspace as never-ready
 * forever. `converging` is the honest bar for a GREEN token; `settled` stays
 * the only basis for claiming COMPLETION. The two are never merged — see
 * `isGoogleAdsFreshnessSettled`.
 */
const GOOGLE_ADS_POST_CLOSE_OBSERVED_STATES: ReadonlySet<GoogleAdsCompletionState> =
  new Set<GoogleAdsCompletionState>(["converging", "settled"]);

/**
 * The freshness verdict, as an EXPLICIT INPUT to the pure control-plane truth.
 *
 * WHY A PARAMETER AND NOT A READ. `resolveGoogleAdsControlPlaneSyncTruth` is a
 * pure function called from a request path and from a cron pass; hiding a query
 * inside it would put a per-business round trip behind an innocent-looking
 * call and, worse, would make the decision untestable without a warehouse. The
 * evidence is gathered once, in bulk, by `readGoogleAdsCoreFreshnessEvidence`
 * and handed in.
 *
 * OMITTING IT IS NOT NEUTRAL. A caller that passes nothing is treated as
 * "we could not look", i.e. `unknown` — non-green and retryable. There is no
 * arrangement of arguments that yields a green verdict without evidence.
 */
export interface GoogleAdsFreshnessEvidence {
  /**
   * False when the evidence could not be read at all. Distinct from `missing`:
   * missing is a fact about the data, unavailable is an admission about us.
   * Both are non-green; only this one means "ask again".
   */
  evidenceAvailable: boolean;
  /** The weakest verdict state across the required scopes. */
  state: GoogleAdsCompletionState;
  /** Per-scope states behind `state`. A required scope absent here is `unknown`. */
  scopeStates: Record<string, GoogleAdsCompletionState>;
  unavailableReason: string | null;
  /** The closed-day range the verdict was measured over, for the gate record. */
  measuredStartDate: string | null;
  measuredEndDate: string | null;
}

/** The fail-closed verdict. Never a terminal failure — callers must retry. */
export function unknownGoogleAdsFreshnessEvidence(
  reason: string,
): GoogleAdsFreshnessEvidence {
  return {
    evidenceAvailable: false,
    state: "unknown",
    scopeStates: {},
    unavailableReason: reason,
    measuredStartDate: null,
    measuredEndDate: null,
  };
}

/**
 * Did we re-read every day in the range after it closed?
 *
 * This — not row existence, not "a job finished" — is what a green token, a
 * serving-ready workspace and a passing release gate are allowed to rest on.
 */
export function isGoogleAdsPostCloseObserved(
  evidence?: GoogleAdsFreshnessEvidence | null,
): boolean {
  if (!evidence?.evidenceAvailable) return false;
  return GOOGLE_ADS_POST_CLOSE_OBSERVED_STATES.has(evidence.state);
}

/**
 * The strongest state we will ever claim, and still not "final".
 *
 * Kept separate from `isGoogleAdsPostCloseObserved` on purpose: a `converging`
 * range may serve and may pass the gate, but it has NOT completed — conversions
 * can still land inside the lookback window. Nothing here means immutable;
 * Google publishes no such instant.
 */
export function isGoogleAdsFreshnessSettled(
  evidence?: GoogleAdsFreshnessEvidence | null,
): boolean {
  return Boolean(evidence?.evidenceAvailable) && evidence?.state === "settled";
}

/**
 * Reduce a bulk freshness snapshot to the core-scope evidence the control plane
 * consumes. Pure; the read happens in `readGoogleAdsCoreFreshnessEvidence`.
 */
export function toGoogleAdsCoreFreshnessEvidence(
  snapshot: GoogleAdsFreshnessSnapshot | null | undefined,
  requiredScopes: readonly string[] = GOOGLE_ADS_CORE_FRESHNESS_SCOPES,
): GoogleAdsFreshnessEvidence {
  if (!snapshot) {
    return unknownGoogleAdsFreshnessEvidence(
      "Google Ads freshness evidence could not be read.",
    );
  }
  if (!snapshot.evidenceAvailable) {
    return {
      ...unknownGoogleAdsFreshnessEvidence(
        snapshot.unavailableReason ??
          "Google Ads freshness evidence could not be read.",
      ),
      measuredStartDate: snapshot.startDate ?? null,
      measuredEndDate: snapshot.endDate ?? null,
    };
  }
  if (requiredScopes.length === 0) {
    return unknownGoogleAdsFreshnessEvidence(
      "No Google Ads core scopes were measured.",
    );
  }

  const scopeStates: Record<string, GoogleAdsCompletionState> = {};
  let weakest: GoogleAdsCompletionState = "settled";
  for (const scope of requiredScopes) {
    // A required scope the snapshot never measured is `unknown`, not absent:
    // we cannot vouch for a surface we did not look at.
    const state = snapshot.scopes[scope]?.verdict.state ?? "unknown";
    scopeStates[scope] = state;
    if (COMPLETION_RANK[state] < COMPLETION_RANK[weakest]) weakest = state;
  }

  return {
    evidenceAvailable: weakest !== "unknown",
    state: weakest,
    scopeStates,
    unavailableReason:
      weakest === "unknown"
        ? "At least one Google Ads core scope has no freshness verdict."
        : null,
    measuredStartDate: snapshot.startDate,
    measuredEndDate: snapshot.endDate,
  };
}

export type GoogleAdsControlPlaneBusiness = {
  businessId: string;
  businessName: string | null;
  assignedAccountCount: number;
  backfillIncomplete?: boolean;
  incompleteScopeCount?: number;
  latestSuccessfulSyncAt?: string | null;
};

export function resolveGoogleAdsControlPlaneSyncTruth(input: {
  latestSyncStatus?: string | null;
  latestSyncScope?: string | null;
  queueDepth: number;
  deadLetterPartitions: number;
  scopeStates: GoogleAdsSyncStateRecord[];
  recentWindowMinutes?: number;
  nowMs?: number;
  /**
   * Post-close observation evidence for the core scopes, from
   * `readGoogleAdsCoreFreshnessEvidence`. Optional in the TYPE only so that
   * callers this change does not own keep compiling; omitting it is read as
   * `unknown` and fails closed.
   */
  freshness?: GoogleAdsFreshnessEvidence | null;
}) {
  const recentWindowMinutes = Math.max(1, input.recentWindowMinutes ?? 20);
  const nowMs = input.nowMs ?? Date.now();
  const latestSuccessfulScopeSyncAt =
    input.scopeStates
      .map((row) => row.latestSuccessfulSyncAt)
      .filter((value): value is string => Boolean(value))
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0] ?? null;
  const hasRecentSuccessfulScopeSync =
    latestSuccessfulScopeSyncAt != null &&
    nowMs - latestSuccessfulScopeSyncAt <= recentWindowMinutes * 60_000;
  const freshness =
    input.freshness ??
    unknownGoogleAdsFreshnessEvidence(
      "Google Ads freshness evidence was not supplied to the control plane.",
    );
  const corePostCloseObserved = isGoogleAdsPostCloseObserved(freshness);
  /**
   * DATA AVAILABILITY, and nothing else: is there anything at all to serve?
   *
   * This is the old `coreServingReady` body, renamed to what it actually
   * measures. `completedDays > 0` is row existence and `latestSuccessfulSyncAt`
   * is "a job finished" — neither says a closed day was ever re-read, so
   * neither may carry a green token on its own. Kept because "there is nothing
   * to serve" is still a real, separate answer.
   */
  const coreDataAvailable = ["account_daily", "campaign_daily"].every((scope) =>
    input.scopeStates.some(
      (row) =>
        row.scope === scope &&
        (row.completedDays ?? 0) > 0 &&
        Boolean(row.latestSuccessfulSyncAt),
    ),
  );
  // Availability AND freshness. Either alone was the defect.
  const coreServingReady = coreDataAvailable && corePostCloseObserved;
  const latestFailedBlocksCore =
    input.latestSyncStatus === "failed" &&
    (input.latestSyncScope == null ||
      isGoogleAdsCoreReleaseScope(input.latestSyncScope));
  const releaseLatestSyncStatus =
    input.latestSyncStatus === "failed" && !latestFailedBlocksCore
      ? null
      : input.latestSyncStatus;
  // Deliberately NOT influenced by freshness. Unreadable or provisional
  // freshness is a reason to withhold "ready", never a reason to report a sync
  // as failed: a fail-closed gate must stay retryable, not become an incident.
  const effectiveLatestSyncStatus =
    latestFailedBlocksCore
      ? "failed"
      : input.queueDepth === 0 &&
          input.deadLetterPartitions === 0 &&
          hasRecentSuccessfulScopeSync
        ? "succeeded"
        : releaseLatestSyncStatus ?? null;

  const servingReady =
    input.deadLetterPartitions === 0 &&
    effectiveLatestSyncStatus !== "failed" &&
    coreServingReady;

  /**
   * The PIPELINE shape: queue drained, nothing dead-lettered, latest run not
   * failed, and something to serve.
   *
   * A worker-MOTION answer, deliberately carrying no freshness claim. It exists
   * because progress and stall classification ask "is anything stuck?", and
   * feeding a freshness refusal into that question labels a perfectly healthy,
   * idle workspace as `stalled` — inventing an incident out of "we have not
   * re-read yesterday yet". It is NOT readiness: it never reaches
   * `coreServingReady`, `servingReady`, `truthReady`, `fullyReady` or the gate.
   */
  const pipelineDrained =
    input.queueDepth === 0 &&
    input.deadLetterPartitions === 0 &&
    effectiveLatestSyncStatus !== "failed" &&
    (effectiveLatestSyncStatus === "succeeded" ||
      hasRecentSuccessfulScopeSync ||
      coreDataAvailable);

  return {
    effectiveLatestSyncStatus,
    hasRecentSuccessfulScopeSync,
    /** "Is there anything to serve" — availability, never a freshness claim. */
    coreDataAvailable,
    /** Every core day re-read after it closed (`converging` or `settled`). */
    corePostCloseObserved,
    coreFreshnessState: freshness.state,
    coreFreshnessEvidenceAvailable: freshness.evidenceAvailable,
    coreFreshnessUnavailableReason: freshness.unavailableReason,
    /** Strongest state we claim. Still not final, and still not "immutable". */
    coreFreshnessSettled: isGoogleAdsFreshnessSettled(freshness),
    /**
     * Freshness is what is withholding readiness. ALWAYS retryable: more
     * observation clears it, and it never maps to a failed sync.
     */
    freshnessBlocksReadiness: !corePostCloseObserved,
    coreServingReady,
    servingReady,
    /** The single value fed to the release gate as `truthReady`. */
    truthReady: servingReady,
    /** Worker motion only. Never a readiness or freshness claim. */
    pipelineDrained,
    fullyReady: pipelineDrained && corePostCloseObserved,
  };
}

/**
 * How many closed days the release gate measures freshness over.
 *
 * A window, not "everything": the gate asks whether the recent core frontier
 * has been re-read, and a 730-day range would be dominated by history the gate
 * is not deciding about.
 */
export const GOOGLE_ADS_RELEASE_FRESHNESS_WINDOW_DAYS = 14;
const GOOGLE_ADS_RELEASE_FRESHNESS_TIMEOUT_MS = 8_000;

/**
 * The read modules, loaded ONCE per process rather than once per business.
 *
 * They stay behind `import()` so this module's static graph — which the worker
 * imports for its tick list — does not pull the warehouse in. Memoising the
 * promise means a pass over N businesses issues one module load and N reads,
 * not N of each.
 */
let googleAdsFreshnessDeps:
  | Promise<{
      addDaysToIsoDateUtc: typeof import("@/lib/provider-platform-date")["addDaysToIsoDateUtc"];
      getProviderPlatformDateBoundaries: typeof import("@/lib/provider-platform-date")["getProviderPlatformDateBoundaries"];
      readProviderAccountSnapshot: typeof import("@/lib/provider-account-snapshots")["readProviderAccountSnapshot"];
      readProviderConnectionGenerationToken: typeof import("@/lib/provider-account-snapshots")["readProviderConnectionGenerationToken"];
      readGoogleAdsFreshness: typeof import("@/lib/google-ads/freshness-read")["readGoogleAdsFreshness"];
    }>
  | null = null;

function loadGoogleAdsFreshnessDeps() {
  if (!googleAdsFreshnessDeps) {
    googleAdsFreshnessDeps = Promise.all([
      import("@/lib/provider-platform-date"),
      import("@/lib/provider-account-snapshots"),
      import("@/lib/google-ads/freshness-read"),
    ])
      .then(([platformDate, snapshots, freshness]) => ({
        addDaysToIsoDateUtc: platformDate.addDaysToIsoDateUtc,
        getProviderPlatformDateBoundaries: platformDate.getProviderPlatformDateBoundaries,
        readProviderAccountSnapshot: snapshots.readProviderAccountSnapshot,
        readProviderConnectionGenerationToken:
          snapshots.readProviderConnectionGenerationToken,
        readGoogleAdsFreshness: freshness.readGoogleAdsFreshness,
      }))
      .catch((error) => {
        // Never memoise a failed load, or one bad tick poisons the process.
        googleAdsFreshnessDeps = null;
        throw error;
      });
  }
  return googleAdsFreshnessDeps;
}

/**
 * The ONE bulk freshness read behind the control plane's verdict.
 *
 * One call per business per pass, covering both core scopes in a single
 * `readGoogleAdsFreshness` (which itself issues two bounded statements
 * regardless of scope count). Never per scope, never per date.
 *
 * FAIL CLOSED, STAY RETRYABLE. No connection row, a connection that is not
 * `connected`, a snapshot captured under a superseded connection generation, no
 * assigned accounts, an account whose timezone we cannot trust, or any read
 * failure — every one returns `unknown`. Never green, never a terminal failure.
 */
export async function readGoogleAdsCoreFreshnessEvidence(input: {
  businessId: string;
  windowDays?: number;
  now?: Date;
  timeoutMs?: number;
}): Promise<GoogleAdsFreshnessEvidence> {
  let addDaysToIsoDateUtc: Awaited<
    ReturnType<typeof loadGoogleAdsFreshnessDeps>
  >["addDaysToIsoDateUtc"];
  let getProviderPlatformDateBoundaries: Awaited<
    ReturnType<typeof loadGoogleAdsFreshnessDeps>
  >["getProviderPlatformDateBoundaries"];
  let readProviderAccountSnapshot: Awaited<
    ReturnType<typeof loadGoogleAdsFreshnessDeps>
  >["readProviderAccountSnapshot"];
  let readProviderConnectionGenerationToken: Awaited<
    ReturnType<typeof loadGoogleAdsFreshnessDeps>
  >["readProviderConnectionGenerationToken"];
  let readGoogleAdsFreshness: Awaited<
    ReturnType<typeof loadGoogleAdsFreshnessDeps>
  >["readGoogleAdsFreshness"];
  try {
    ({
      addDaysToIsoDateUtc,
      getProviderPlatformDateBoundaries,
      readProviderAccountSnapshot,
      readProviderConnectionGenerationToken,
      readGoogleAdsFreshness,
    } = await loadGoogleAdsFreshnessDeps());
  } catch {
    return unknownGoogleAdsFreshnessEvidence(
      "The Google Ads freshness reader could not be loaded.",
    );
  }

  const windowDays = Math.max(
    1,
    Math.floor(input.windowDays ?? GOOGLE_ADS_RELEASE_FRESHNESS_WINDOW_DAYS),
  );

  let snapshot: Awaited<ReturnType<typeof readProviderAccountSnapshot>>;
  let connectionGeneration: string | null;
  try {
    [snapshot, connectionGeneration] = await Promise.all([
      readProviderAccountSnapshot({
        businessId: input.businessId,
        provider: "google",
      }),
      readProviderConnectionGenerationToken(input.businessId, "google"),
    ]);
  } catch {
    return unknownGoogleAdsFreshnessEvidence(
      "The Google Ads connection state could not be read.",
    );
  }

  // A deleted business or a removed integration leaves no connection row at
  // all. That is not "fresh by default"; it is an unanswerable question.
  if (!connectionGeneration) {
    return unknownGoogleAdsFreshnessEvidence(
      "This business has no Google Ads connection row.",
    );
  }
  if (!connectionGeneration.endsWith(":connected")) {
    return unknownGoogleAdsFreshnessEvidence(
      "The Google Ads connection is not connected.",
    );
  }
  if (!snapshot) {
    return unknownGoogleAdsFreshnessEvidence(
      "No Google Ads account snapshot is available for this business.",
    );
  }
  const snapshotGeneration = snapshot.meta.connectionFingerprint ?? null;
  // A snapshot captured before a reconnect describes accounts, timezones and
  // day boundaries for a credential that no longer exists.
  if (snapshotGeneration && snapshotGeneration !== connectionGeneration) {
    return unknownGoogleAdsFreshnessEvidence(
      "The Google Ads account snapshot was captured under a superseded connection generation.",
    );
  }

  let boundaries: Awaited<ReturnType<typeof getProviderPlatformDateBoundaries>>;
  try {
    boundaries = await getProviderPlatformDateBoundaries({
      provider: "google",
      businessId: input.businessId,
      snapshot,
    });
  } catch {
    return unknownGoogleAdsFreshnessEvidence(
      "Google Ads account day boundaries could not be resolved.",
    );
  }
  if (boundaries.length === 0) {
    return unknownGoogleAdsFreshnessEvidence(
      "No Google Ads accounts are assigned to this business.",
    );
  }
  // "default" means UTC was assumed. Any decision about day CLOSURE must refuse
  // it, or a Los Angeles day settles seven hours early.
  if (boundaries.some((boundary) => boundary.timeZoneSource !== "account")) {
    return unknownGoogleAdsFreshnessEvidence(
      "At least one Google Ads account has no trustworthy timezone, so its day boundary is unknown.",
    );
  }

  // The last day that has CLOSED for every assigned account. Ending the range
  // on an open day would cap the verdict at `provisional` forever, which would
  // pin a healthy workspace as never-ready — the opposite failure to the one
  // this change closes, and just as wrong.
  const endDate = boundaries
    .map((boundary) => boundary.previousDate)
    .sort()[0] as string;
  const startDate = addDaysToIsoDateUtc(endDate, -(windowDays - 1));

  try {
    return toGoogleAdsCoreFreshnessEvidence(
      await readGoogleAdsFreshness({
        businessId: input.businessId,
        scopes: GOOGLE_ADS_CORE_FRESHNESS_SCOPES,
        startDate,
        endDate,
        providerAccountIds: boundaries
          .map((boundary) => boundary.providerAccountId)
          .filter((id): id is string => Boolean(id)),
        now: input.now,
        timeoutMs: input.timeoutMs ?? GOOGLE_ADS_RELEASE_FRESHNESS_TIMEOUT_MS,
      }),
    );
  } catch {
    // `readGoogleAdsFreshness` never throws, but a throw here would still have
    // to fail closed rather than take the pass down with it.
    return unknownGoogleAdsFreshnessEvidence(
      "Google Ads freshness evidence could not be read.",
    );
  }
}

export async function readConnectedGoogleAdsControlPlaneBusinesses() {
  const { getDb } = await import("@/lib/db");
  const sql = getDb();
  const rows = await sql`
    SELECT
      bpa.business_id,
      business.name AS business_name,
      COUNT(*)::int AS assigned_account_count,
      COALESCE(sync_state.incomplete_scope_count, 1)::int AS incomplete_scope_count,
      sync_state.latest_successful_sync_at
    FROM business_provider_accounts bpa
    INNER JOIN provider_connections connection
      ON connection.business_id = bpa.business_id
     AND connection.provider = bpa.provider
     AND connection.status = 'connected'
    -- INNER, not LEFT. This list REPLACES the worker's tick list
    -- (worker-runtime.ts), so a LEFT JOIN meant a business whose row had been
    -- deleted kept its connected accounts in the result and kept being synced
    -- every tick, against retained credentials, forever.
    INNER JOIN businesses business
      ON business.id::text = bpa.business_id
    LEFT JOIN (
      SELECT
        business_id,
        (COUNT(*) FILTER (
          WHERE completed_days < GREATEST(1, (effective_target_end - effective_target_start + 1))
        ))::int AS incomplete_scope_count,
        MAX(latest_successful_sync_at)::text AS latest_successful_sync_at
      FROM google_ads_sync_state
      GROUP BY business_id
    ) sync_state
      ON sync_state.business_id = bpa.business_id
    WHERE bpa.provider = 'google'
      -- Current selection, not historical identity. Control-plane admission
      -- and leasing decide what to WORK ON, so a deselected account must not
      -- be counted; binding rows are never deleted, so without this a deselect
      -- is invisible to scheduling.
      AND bpa.is_selected
    GROUP BY
      bpa.business_id,
      business.name,
      sync_state.incomplete_scope_count,
      sync_state.latest_successful_sync_at
    ORDER BY
      (COALESCE(sync_state.incomplete_scope_count, 1) > 0) DESC,
      sync_state.latest_successful_sync_at NULLS FIRST,
      business.name NULLS LAST,
      bpa.business_id
  ` as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    businessId: String(row.business_id),
    businessName:
      typeof row.business_name === "string" && row.business_name.trim().length > 0
        ? row.business_name.trim()
        : null,
    assignedAccountCount: Number(row.assigned_account_count ?? 0),
    incompleteScopeCount: Number(row.incomplete_scope_count ?? 0),
    backfillIncomplete: Number(row.incomplete_scope_count ?? 0) > 0,
    latestSuccessfulSyncAt:
      typeof row.latest_successful_sync_at === "string"
        ? row.latest_successful_sync_at
        : null,
  })) satisfies GoogleAdsControlPlaneBusiness[];
}

export async function buildGoogleAdsReleaseGateCanaries(
  businesses: GoogleAdsControlPlaneBusiness[],
) {
  const {
    getGoogleAdsCheckpointHealth,
    getGoogleAdsQueueHealth,
    getGoogleAdsSyncState,
    getLatestGoogleAdsSyncHealth,
  } = await import("@/lib/google-ads/warehouse");
  const { getGoogleAdsWorkerSchedulingState } = await import("@/lib/sync/google-ads-sync");
  const {
    buildProviderProgressEvidence,
    deriveProviderActivityState,
    deriveProviderProgressState,
    deriveProviderStallFingerprints,
    deriveUnifiedSyncTruth,
  } = await import("@/lib/sync/provider-status-truth");
  const {
    buildGoogleAdsReleaseReadinessCandidate,
  } = await import("@/lib/google-ads/control-plane");

  return Promise.all(
    businesses.map(async (business) => {
      const [
        queueHealth,
        checkpointHealth,
        latestSyncHealth,
        workerState,
        coreFreshness,
        ...scopeStates
      ] = await Promise.all([
        getGoogleAdsQueueHealth({
          businessId: business.businessId,
        }),
        getGoogleAdsCheckpointHealth({
          businessId: business.businessId,
          providerAccountId: null,
        }).catch(() => null),
        getLatestGoogleAdsSyncHealth({
          businessId: business.businessId,
          providerAccountId: null,
        }).catch(() => null),
        getGoogleAdsWorkerSchedulingState({
          businessId: business.businessId,
        }).catch(() => null),
        // ONE bulk freshness read per business per pass, covering both core
        // scopes. Sits in this same `Promise.all` so it costs a round trip, not
        // a serial step, and is never issued per scope or per date.
        readGoogleAdsCoreFreshnessEvidence({
          businessId: business.businessId,
        }).catch(() =>
          unknownGoogleAdsFreshnessEvidence(
            "Google Ads freshness evidence could not be read.",
          ),
        ),
        ...GOOGLE_ADS_CONTROL_PLANE_SCOPES.map((scope) =>
          getGoogleAdsSyncState({
            businessId: business.businessId,
            scope,
          }).catch(() => []),
        ),
      ]);

      const latestGoogleActivityAt =
        queueHealth.latestCoreActivityAt ??
        queueHealth.latestExtendedActivityAt ??
        queueHealth.latestMaintenanceActivityAt ??
        null;
      const flattenedScopeStates = scopeStates.flatMap((rows) => rows);
      const progressEvidence = buildProviderProgressEvidence({
        states: flattenedScopeStates,
        checkpointUpdatedAt: checkpointHealth?.latestCheckpointUpdatedAt ?? null,
        recentActivityWindowMinutes: 20,
        aggregation: "latest",
      });
      const latestSyncStatus =
        latestSyncHealth?.status != null ? String(latestSyncHealth.status) : null;
      const latestSyncScope =
        typeof latestSyncHealth?.scope === "string"
          ? latestSyncHealth.scope
          : null;
      const totalQueueDepth = queueHealth.queueDepth;
      const releaseQueueDepth = queueHealth.coreQueueDepth;
      const releaseLeasedPartitions = queueHealth.coreLeasedPartitions;
      const blockingDeadLetterPartitions =
        queueHealth.coreBlockingDeadLetterPartitions ??
        queueHealth.blockingDeadLetterPartitions ??
        queueHealth.deadLetterPartitions;
      const controlPlaneSyncTruth = resolveGoogleAdsControlPlaneSyncTruth({
        latestSyncStatus,
        latestSyncScope,
        queueDepth: releaseQueueDepth,
        deadLetterPartitions: blockingDeadLetterPartitions,
        scopeStates: flattenedScopeStates,
        freshness: coreFreshness,
      });
      const blocked =
        blockingDeadLetterPartitions > 0 ||
        controlPlaneSyncTruth.effectiveLatestSyncStatus === "failed";
      const progressState = deriveProviderProgressState({
        queueDepth: releaseQueueDepth,
        leasedPartitions: releaseLeasedPartitions,
        checkpointLagMinutes:
          controlPlaneSyncTruth.hasRecentSuccessfulScopeSync
            ? null
            : checkpointHealth?.checkpointLagMinutes ?? null,
        latestPartitionActivityAt: latestGoogleActivityAt,
        blocked,
        // Worker motion, NOT readiness. Passing the freshness-gated
        // `fullyReady` here would classify an idle, healthy, drained workspace
        // as `partial_stuck` -> `stalled` purely because yesterday has not been
        // re-read yet, which manufactures an incident and — worse — would let a
        // freshness refusal masquerade as a queue problem.
        fullyReady: controlPlaneSyncTruth.pipelineDrained,
        staleRunPressure: 0,
        progressEvidence,
      });
      const activityState = deriveProviderActivityState({
        progressState,
        queueDepth: releaseQueueDepth,
        leasedPartitions: releaseLeasedPartitions,
        blocked,
      });
      const stallFingerprints = deriveProviderStallFingerprints({
        queueDepth: releaseQueueDepth,
        leasedPartitions: releaseLeasedPartitions,
        checkpointLagMinutes: checkpointHealth?.checkpointLagMinutes ?? null,
        latestPartitionActivityAt: latestGoogleActivityAt,
        blocked,
        staleRunPressure: 0,
        progressEvidence,
        blockedReasonCodes: blockingDeadLetterPartitions > 0
          ? ["required_dead_letter_partitions"]
          : controlPlaneSyncTruth.effectiveLatestSyncStatus === "failed"
            ? ["latest_sync_failed"]
            : [],
        historicalBacklogDepth:
          queueHealth.extendedHistoricalQueueDepth +
          queueHealth.extendedHistoricalLeasedPartitions,
      });
      const unifiedTruth = deriveUnifiedSyncTruth({
        activityState,
        progressState,
        workerOnline: workerState?.healthy ?? null,
        queueDepth: releaseQueueDepth,
        leasedPartitions: releaseLeasedPartitions,
      });
      const candidate = buildGoogleAdsReleaseReadinessCandidate({
        connected: true,
        assignedAccountCount: business.assignedAccountCount,
        activityState,
        progressState,
        workerOnline: workerState?.healthy ?? null,
        queueDepth: releaseQueueDepth,
        totalQueueDepth,
        leasedPartitions: releaseLeasedPartitions,
        retryableFailedPartitions: 0,
        deadLetterPartitions: blockingDeadLetterPartitions,
        staleLeasePartitions: 0,
        syncTruthState: unifiedTruth.syncTruthState,
        truthReady: controlPlaneSyncTruth.truthReady,
        freshness: coreFreshness,
        stallFingerprints,
      });

      return {
        businessId: business.businessId,
        businessName: business.businessName,
        pass: candidate?.pass ?? false,
        blockerClass: candidate?.blockerClass ?? "not_release_ready",
        evidence: {
          ...(candidate?.evidence ?? {}),
          totalDeadLetterPartitions: queueHealth.deadLetterPartitions,
          totalQueueDepth,
          nonBlockingQueueDepth: Math.max(0, totalQueueDepth - releaseQueueDepth),
          releaseBlockingQueueDepth: releaseQueueDepth,
          coreQueueDepth: queueHealth.coreQueueDepth,
          extendedQueueDepth: queueHealth.extendedQueueDepth,
          maintenanceQueueDepth: queueHealth.maintenanceQueueDepth,
          coreBlockingDeadLetterPartitions:
            queueHealth.coreBlockingDeadLetterPartitions ?? 0,
          quarantinedHistoricalDeadLetterPartitions:
            queueHealth.quarantinedHistoricalDeadLetterPartitions ?? 0,
          actionRequiredDeadLetterPartitions:
            queueHealth.actionRequiredBlockingDeadLetterPartitions ?? 0,
          totalActionRequiredDeadLetterPartitions:
            queueHealth.actionRequiredDeadLetterPartitions ?? 0,
          coreActionRequiredDeadLetterPartitions:
            queueHealth.coreActionRequiredBlockingDeadLetterPartitions ?? 0,
          actionRequiredDeadLetterScopes:
            queueHealth.actionRequiredBlockingDeadLetterScopes ?? [],
          replayableDeadLetterPartitions:
            queueHealth.replayableBlockingDeadLetterPartitions ?? 0,
          unknownDeadLetterPartitions:
            queueHealth.unknownBlockingDeadLetterPartitions ?? 0,
          latestSyncStatus: controlPlaneSyncTruth.effectiveLatestSyncStatus,
          // Recorded so a gate row says WHY it withheld a pass, and so a
          // reviewer can tell "we could not look" apart from "we looked and it
          // is not observed". Never rendered as a failure.
          coreFreshnessState: controlPlaneSyncTruth.coreFreshnessState,
          coreFreshnessEvidenceAvailable:
            controlPlaneSyncTruth.coreFreshnessEvidenceAvailable,
          coreFreshnessUnavailableReason:
            controlPlaneSyncTruth.coreFreshnessUnavailableReason,
          coreFreshnessScopeStates: coreFreshness.scopeStates,
          coreFreshnessMeasuredStartDate: coreFreshness.measuredStartDate,
          coreFreshnessMeasuredEndDate: coreFreshness.measuredEndDate,
          corePostCloseObserved: controlPlaneSyncTruth.corePostCloseObserved,
          coreFreshnessSettled: controlPlaneSyncTruth.coreFreshnessSettled,
          // Data availability, kept distinct from freshness on purpose.
          coreDataAvailable: controlPlaneSyncTruth.coreDataAvailable,
          freshnessBlocksReadiness:
            controlPlaneSyncTruth.freshnessBlocksReadiness,
          /** Fail-closed is never terminal: this gate may pass on a later pass. */
          freshnessRetryable: controlPlaneSyncTruth.freshnessBlocksReadiness,
        },
      };
    }),
  );
}

export async function evaluateAndPersistGoogleAdsControlPlane(input?: {
  buildId?: string;
  environment?: string;
  breakGlass?: boolean;
  overrideReason?: string | null;
}) {
  const identity = resolveSyncControlPlaneKey({
    buildId: input?.buildId,
    environment: input?.environment,
    providerScope: "google_ads",
  });
  const { evaluateDeployGate, upsertSyncGateRecord } = await import("@/lib/sync/release-gates");
  const { buildGoogleAdsReleaseGateRecord } = await import("@/lib/google-ads/control-plane");

  return {
    identity,
    checkedAt: new Date().toISOString(),
    deployGate: await evaluateDeployGate({
      buildId: identity.buildId,
      environment: identity.environment,
      breakGlass: input?.breakGlass,
      overrideReason: input?.overrideReason ?? null,
      persist: true,
    }),
    releaseGate: await upsertSyncGateRecord(
      buildGoogleAdsReleaseGateRecord({
        buildId: identity.buildId,
        environment: identity.environment,
        canaries: await buildGoogleAdsReleaseGateCanaries(
          await readConnectedGoogleAdsControlPlaneBusinesses(),
        ),
        breakGlass: input?.breakGlass,
        overrideReason: input?.overrideReason ?? null,
      }),
    ),
  };
}
