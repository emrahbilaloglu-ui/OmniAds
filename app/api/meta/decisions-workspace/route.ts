import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type {
  MetaDecisionsOsWorkspacePayload,
  MetaDecisionsWorkspacePayload,
  MetaLanePayload,
  MetaPulsePayload,
  MetaWindowKey,
} from "@/components/meta/redesign/types";
import { requireBusinessAccess } from "@/lib/access";
import {
  fetchMetaActiveAdConfigsReceipt,
  resolveMetaCredentials,
} from "@/lib/api/meta";
import { getDb } from "@/lib/db";
import {
  classifyDecisionDateFallback,
  describeDecisionDateFallback,
  isExpectedCapabilityGate,
} from "@/lib/meta/decision-date-fallback";
import { logRuntimeInfo, logRuntimeWarn } from "@/lib/runtime-logging";
import {
  META_DECISIONS_AD_CANDIDATE_LIMIT,
  META_DECISIONS_AD_CANDIDATE_MAX_LIMIT,
  type MetaDecisionsWorkspaceReadModel,
} from "@/lib/meta/decisions-workspace-contract";
import {
  buildUnavailableMetaDecisionsWorkspaceReadModel,
  readMetaDecisionCampaignContextRows,
  readMetaDecisionsWorkspaceReadModel,
  type MetaCurrentAdStatusSourceRow,
  type MetaDecisionCampaignContextSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import {
  buildMetaOsDecisionsPresentation,
  revalidateMetaStructureLanesForCurrentTargets,
} from "@/lib/meta/decisions-os-presentation";
import type { MetaOsWorkspaceBanner } from "@/lib/meta/decisions-os-contract";
import {
  hasMetaHardActionAnchor,
  readMetaCommercialTargets,
  type MetaCommercialTargets,
} from "@/lib/meta/commercial-targets";
import {
  metaDecisionCampaignContextScopeKey,
  normalizeMetaDecisionCampaignContextIds,
} from "@/lib/meta/decisions-workspace-cache-scope";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { isReviewerEmail } from "@/lib/reviewer-access";
import { getCachedValue } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

type UpstreamName = "account-pulse" | "lane-classify";
// The composed route still has a bounded deadline, but production avoids a
// network hairpin by invoking both read-only route handlers in-process.
const WORKSPACE_UPSTREAM_TIMEOUT_MS =
  process.env.NODE_ENV === "production" ? 15_000 : 45_000;

class UpstreamError extends Error {
  constructor(
    readonly source: UpstreamName,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(`Meta decisions workspace upstream failed: ${source}`);
  }
}

interface CurrentMetaAdsResult {
  rows: MetaCurrentAdStatusSourceRow[];
  complete: boolean;
  unavailableReason: string | null;
}

function inputAdScopeKey(input: CurrentMetaAdsResult) {
  if (!input.complete) return "unavailable";
  const ids = [...new Set(input.rows.map((row) => row.adId.trim()).filter(Boolean))].sort();
  return ids.length > 0
    ? createHash("sha256").update(ids.join("\n"), "utf8").digest("hex")
    : "empty";
}

async function loadCurrentMetaAds(input: {
  businessId: string;
  providerAccountId: string | null;
}): Promise<CurrentMetaAdsResult> {
  if (!input.providerAccountId) {
    return {
      rows: [],
      complete: false,
      unavailableReason: "provider_account_required",
    };
  }
  try {
    const credentials = await resolveMetaCredentials(input.businessId);
    if (
      !credentials ||
      !credentials.accountIds.includes(input.providerAccountId)
    ) {
      return {
        rows: [],
        complete: false,
        unavailableReason: "provider_account_credentials_unavailable",
      };
    }
    const receipt = await fetchMetaActiveAdConfigsReceipt(
      input.providerAccountId,
      credentials.accessToken,
    );
    if (!receipt.complete) {
      return {
        rows: [],
        complete: false,
        unavailableReason: `provider_ad_inventory_incomplete:${receipt.termination}`,
      };
    }
    const fetchedAt = new Date().toISOString();
    return {
      complete: true,
      unavailableReason: null,
      rows: receipt.rows.map((row) => ({
        providerAccountId: input.providerAccountId!,
        adId: row.id,
        adName: row.name ?? null,
        campaignId: row.campaign_id ?? null,
        campaignName: row.campaign?.name ?? null,
        adsetId: row.adset_id ?? null,
        creativeId: row.creative?.id ?? null,
        configuredStatus: row.status ?? null,
        effectiveStatus: row.effective_status ?? null,
        providerUpdatedAt: row.updated_time ?? null,
        fetchedAt,
      })),
    };
  } catch (error) {
    return {
      rows: [],
      complete: false,
      unavailableReason:
        error instanceof Error
          ? `provider_ad_inventory_failed:${error.message}`
          : "provider_ad_inventory_failed",
    };
  }
}

async function readCurrentMetaAds(input: {
  businessId: string;
  providerAccountId: string | null;
}): Promise<CurrentMetaAdsResult> {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return loadCurrentMetaAds(input);
  }
  return (
    await getCachedValue({
      key: `meta-current-active-ads-v2:${input.businessId}:${input.providerAccountId ?? "none"}`,
      ttlMs: 60_000,
      staleWhileRevalidateMs: 240_000,
      loader: () => loadCurrentMetaAds(input),
    })
  ).value;
}

async function readCurrentCampaignContexts(input: {
  businessId: string;
  providerAccountId: string | null;
  snapshotAsOf: string;
  campaignIds: readonly string[];
}): Promise<MetaDecisionCampaignContextSourceRow[]> {
  if (!input.providerAccountId) return [];
  if (input.campaignIds.length === 0) return [];
  try {
    return await readMetaDecisionCampaignContextRows({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      campaignIds: [...input.campaignIds],
      snapshotAsOf: input.snapshotAsOf,
    });
  } catch {
    // The workspace inventory remains visible when context is unavailable.
    // Presentation keeps provisional roles untrusted for decision authority.
    return [];
  }
}

function forwardedHeaders(request: NextRequest) {
  const headers = new Headers({ accept: "application/json" });
  for (const name of ["cookie", "authorization"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function useInProcessUpstreams() {
  const override =
    process.env.META_DECISIONS_UPSTREAM_TRANSPORT?.trim().toLowerCase();
  if (override === "http") return false;
  if (override === "in_process") return true;
  return process.env.VITEST !== "true" && process.env.NODE_ENV !== "test";
}

async function invokeWorkspaceUpstream(input: {
  request: NextRequest;
  source: UpstreamName;
  url: URL;
  signal: AbortSignal;
}) {
  const headers = forwardedHeaders(input.request);
  if (!useInProcessUpstreams()) {
    return fetch(input.url, {
      cache: "no-store",
      headers,
      signal: input.signal,
    });
  }
  const upstreamRequest = new NextRequest(input.url, {
    headers,
    signal: input.signal,
  });
  if (input.source === "account-pulse") {
    const { GET: getAccountPulse } =
      await import("@/app/api/meta/account-pulse/route");
    return getAccountPulse(upstreamRequest);
  }
  const { GET: getLaneClassification } =
    await import("@/app/api/meta/lane-classify/route");
  return getLaneClassification(upstreamRequest);
}

function workspaceParams(source: URLSearchParams, resolvedEndDate: string) {
  const params = new URLSearchParams();
  for (const key of [
    "businessId",
    "providerAccountId",
    "window",
    "startDate",
    "endDate",
  ]) {
    const value = source.get(key);
    if (value) params.set(key, value);
  }
  // Structure is an account inventory. Action authority is still restricted
  // to live recommendations by the server presentation layer.
  params.set(
    "status_filter",
    source.get("status_filter") ?? (source.get("surface") === "os" ? "active" : "all"),
  );
  if (!params.has("endDate")) params.set("endDate", resolvedEndDate);
  params.set("decision_workspace", "1");
  if (source.get("surface") === "os") params.set("workspace_surface", "os");
  return params;
}

function previousUtcDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Report why a snapshot-date lookup failed.
 *
 * An expected capability gate stays at info; anything else is a warning,
 * because the resolver has quietly fallen back to yesterday and every decision
 * surface downstream then answers for the wrong day without saying so. No raw
 * identifiers are logged.
 */
function reportDecisionDateFallback(source: string, error: unknown) {
  const cause = classifyDecisionDateFallback(error);
  const details = {
    source,
    cause,
    detail: describeDecisionDateFallback(cause),
  };
  if (isExpectedCapabilityGate(cause)) {
    logRuntimeInfo("meta_decisions", "as_of_date_capability_gate", details);
    return;
  }
  logRuntimeWarn("meta_decisions", "as_of_date_lookup_failed", details);
}

async function resolveWorkspaceEndDate(input: {
  businessId: string;
  providerAccountId: string | null;
  explicitEndDate: string | null;
}) {
  if (input.explicitEndDate?.trim()) return input.explicitEndDate.trim();
  if (!input.providerAccountId) return previousUtcDate();
  try {
    const rows = await getDb().query<{ latest_as_of: string | null }>(
      `
        WITH creative_account_keys AS (
          SELECT DISTINCT business_id, provider_account_id, creative_id
          FROM meta_creative_dimensions
          WHERE business_id = $1
          UNION
          SELECT DISTINCT business_id, provider_account_id, creative_id
          FROM meta_creative_daily
          WHERE business_id = $1
        ),
        creative_account_scope AS (
          -- A creative seen under more than one account is excluded rather than
          -- attributed to one of them (ADR D070, matching history-read-model).
          SELECT creative_id
          FROM creative_account_keys
          GROUP BY creative_id
          HAVING COUNT(DISTINCT provider_account_id) = 1
             AND MIN(provider_account_id) = $2
        ),
        candidate_dates AS (
          SELECT MAX(as_of_date) AS as_of_date
          FROM engine_v3_ad_decision_snapshots_daily
          WHERE business_ref_id = $1::uuid
            AND business_id = $1
            AND provider_account_id = $2
          UNION ALL
          SELECT MAX(snapshot.as_of_date) AS as_of_date
          FROM engine_v3_decision_snapshots_daily snapshot
          INNER JOIN creative_account_scope account_scope
            ON account_scope.creative_id = snapshot.creative_id
          WHERE snapshot.business_id::text = $1
          UNION ALL
          SELECT MAX(as_of_date) AS as_of_date
          FROM engine_v3_job_runs
          WHERE business_ref_id = $1::uuid
            AND business_id = $1
            AND job_name = 'engine_v3_native_ad_decisions_shadow_job'
        )
        SELECT MAX(as_of_date)::text AS latest_as_of
        FROM candidate_dates
      `,
      [input.businessId, input.providerAccountId],
    );
    const latest = rows[0]?.latest_as_of?.trim() ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(latest)) return latest;
  } catch (error: unknown) {
    // Native tables are introduced behind a schema/capability gate, so a
    // missing relation is expected here. Anything else means this lookup is
    // failing for a reason nobody has seen, and the resolver silently falls
    // back to yesterday — so it is reported rather than swallowed.
    reportDecisionDateFallback("native_ad_snapshot_union", error);
  }
  try {
    const rows = await getDb().query<{ latest_as_of: string | null }>(
      `
        WITH creative_account_keys AS (
          SELECT DISTINCT business_id, provider_account_id, creative_id
          FROM meta_creative_dimensions
          WHERE business_id = $1
          UNION
          SELECT DISTINCT business_id, provider_account_id, creative_id
          FROM meta_creative_daily
          WHERE business_id = $1
        ),
        creative_account_scope AS (
          SELECT creative_id
          FROM creative_account_keys
          GROUP BY creative_id
          HAVING COUNT(DISTINCT provider_account_id) = 1
             AND MIN(provider_account_id) = $2
        )
        SELECT MAX(snapshot.as_of_date)::text AS latest_as_of
        FROM engine_v3_decision_snapshots_daily snapshot
        INNER JOIN creative_account_scope account_scope
          ON account_scope.creative_id = snapshot.creative_id
        WHERE snapshot.business_id::text = $1
      `,
      [input.businessId, input.providerAccountId],
    );
    const latest = rows[0]?.latest_as_of?.trim() ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(latest)) return latest;
  } catch (error: unknown) {
    // Older schemas still get the previous completed UTC day. Decisions never
    // need seven parallel current-day provider reads to serve a daily snapshot.
    reportDecisionDateFallback("legacy_decision_snapshot", error);
  }
  return previousUtcDate();
}

async function canonicalDecisionReadModel(input: {
  businessId: string;
  providerAccountId: string | null;
  adCandidateLimit: number;
  asOfDate: string;
  currentAds: CurrentMetaAdsResult;
  activeOnly: boolean;
}): Promise<
  | { ok: true; model: MetaDecisionsWorkspaceReadModel }
  | { ok: false; status: 403; payload: Record<string, unknown> }
> {
  if (!input.providerAccountId) {
    return {
      ok: true,
      model: buildUnavailableMetaDecisionsWorkspaceReadModel({
        businessId: input.businessId,
        providerAccountId: null,
        code: "provider_account_required",
        message:
          "providerAccountId is required for the canonical Meta Decisions read model.",
        adCandidateLimit: input.adCandidateLimit,
      }),
    };
  }

  let assignments: Awaited<ReturnType<typeof getProviderAccountAssignments>>;
  try {
    assignments = await getProviderAccountAssignments(input.businessId, "meta");
  } catch {
    return {
      ok: true,
      model: buildUnavailableMetaDecisionsWorkspaceReadModel({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        code: "provider_account_scope_unverified",
        message:
          "The provider-account assignment source is unavailable; no canonical decisions were read.",
        adCandidateLimit: input.adCandidateLimit,
      }),
    };
  }

  if (!assignments?.account_ids.includes(input.providerAccountId)) {
    return {
      ok: false,
      status: 403,
      payload: {
        error: "provider_account_not_assigned",
        message: "The requested Meta account is not assigned to this business.",
      },
    };
  }

  if (input.activeOnly && !input.currentAds.complete) {
    const model = buildUnavailableMetaDecisionsWorkspaceReadModel({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      code: "source_read_failed",
      message:
        "The current active-Ad inventory could not be verified, so stale or closed Ads were not substituted into Act now.",
      adCandidateLimit: input.adCandidateLimit,
    });
    if (model.source) {
      model.source.fallbackReason =
        input.currentAds.unavailableReason ??
        "current_active_ad_inventory_unavailable";
    }
    return { ok: true, model };
  }

  try {
    return {
      ok: true,
      model: await readMetaDecisionsWorkspaceReadModel({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        adCandidateLimit: input.adCandidateLimit,
        asOfDate: input.asOfDate,
        currentAds: input.currentAds.rows,
        currentAdSourceComplete: input.currentAds.complete,
        adIds: input.activeOnly
          ? input.currentAds.rows.map((row) => row.adId)
          : undefined,
      }),
    };
  } catch {
    return {
      ok: true,
      model: buildUnavailableMetaDecisionsWorkspaceReadModel({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        code: "source_read_failed",
        message:
          "The account-scoped decision sources could not be read; no decision values were fabricated.",
        adCandidateLimit: input.adCandidateLimit,
      }),
    };
  }
}

function requestedAdCandidateLimit(searchParams: URLSearchParams) {
  const parsed = Number(searchParams.get("adLimit"));
  if (!Number.isFinite(parsed)) return META_DECISIONS_AD_CANDIDATE_LIMIT;
  return Math.max(
    META_DECISIONS_AD_CANDIDATE_LIMIT,
    Math.min(Math.trunc(parsed), META_DECISIONS_AD_CANDIDATE_MAX_LIMIT),
  );
}

async function readInternalJson<T>(
  request: NextRequest,
  source: UpstreamName,
  pathname: string,
  params: URLSearchParams,
): Promise<T> {
  const url = new URL(pathname, request.nextUrl.origin);
  url.search = params.toString();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let response: Response;
  try {
    response = await Promise.race([
      invokeWorkspaceUpstream({
        request,
        source,
        url,
        signal: controller.signal,
      }),
      new Promise<Response>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(
            new UpstreamError(source, 504, {
              error: "upstream_timeout",
              timeoutMs: WORKSPACE_UPSTREAM_TIMEOUT_MS,
            }),
          );
        }, WORKSPACE_UPSTREAM_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (controller.signal.aborted) {
      throw new UpstreamError(source, 504, {
        error: "upstream_timeout",
        timeoutMs: WORKSPACE_UPSTREAM_TIMEOUT_MS,
      });
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const raw = await response.text();
  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { error: "invalid_json", raw };
    }
  }
  if (!response.ok) {
    throw new UpstreamError(source, response.status, payload);
  }
  return payload as T;
}

function isTrackingBlocked(pulse: MetaPulsePayload) {
  return (
    pulse.trackingAnomalyActive === true ||
    pulse.trackingHealth.status === "blocked" ||
    pulse.trackingHealth.status === "degraded"
  );
}

function isMetaWritesKillSwitchEngaged() {
  const value = process.env.META_ADS_WRITE_KILL_SWITCH?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function workspaceViewer(input: {
  role: NonNullable<MetaDecisionsWorkspacePayload["viewer"]>["role"];
  email: string;
}): MetaDecisionsWorkspacePayload["viewer"] {
  const role = input.role;
  const reviewer = isReviewerEmail(input.email);
  const readOnly = reviewer || role === "guest";
  return {
    role,
    isReviewer: reviewer,
    readOnly,
    readOnlyReason: reviewer
      ? "You have read-only access: all evidence is visible, write controls are downgraded to review."
      : role === "guest"
        ? "Your workspace role is Guest: all evidence is visible, write controls are downgraded to review."
        : null,
  };
}

function queueGroups(
  lanes: MetaLanePayload,
): MetaDecisionsWorkspacePayload["queue"]["groups"] {
  return [
    { key: "action", label: "Action Now", count: lanes.counts.actionNow },
    { key: "watching", label: "Watching", count: lanes.counts.watching },
    { key: "healthy", label: "Healthy", count: lanes.counts.healthy },
    { key: "nonSales", label: "Non-sales", count: lanes.counts.nonSales },
    {
      key: "archive",
      label: "Inactive assets",
      count: lanes.counts.archive,
    },
  ];
}

function actionStates(
  lanes: MetaLanePayload,
): MetaDecisionsWorkspacePayload["queue"]["actionStates"] {
  const recommendations = [
    ...lanes.actionNow,
    ...lanes.watching,
    ...lanes.nonSales,
  ];
  return recommendations.reduce<
    MetaDecisionsWorkspacePayload["queue"]["actionStates"]
  >(
    (acc, rec) => {
      if (rec.actionKind === "execute_pause") acc.executablePause += 1;
      else if (rec.actionKind === "execute_bid") acc.executableBid += 1;
      else if (rec.actionKind === "execute_resume") acc.executableResume += 1;
      else if (
        rec.actionKind === "route_launchpad_duplicate" ||
        rec.actionKind === "route_launchpad_rebuild"
      ) {
        acc.launchpadRoutes += 1;
      } else if (rec.actionKind === "review_drill") {
        acc.reviewOnly += 1;
      } else {
        acc.missingActionKind += 1;
      }
      return acc;
    },
    {
      executablePause: 0,
      executableBid: 0,
      executableResume: 0,
      launchpadRoutes: 0,
      reviewOnly: 0,
      missingActionKind: 0,
    },
  );
}

type DecisionDigest = MetaDecisionsWorkspacePayload["digest"];

type LabelFlipDigestRow = {
  rec_id: string;
  scope_id: string;
  title: string | null;
  snapshot_date: string | null;
  previous_label: string | null;
  current_label: string | null;
};

type ActionDigestRow = {
  id: string;
  action: string;
  status: "success" | "silent_failure";
  target: string | null;
  actor: string | null;
  occurred_at: string | null;
  error_code: string | null;
  error_message: string | null;
};

type AnomalyDigestRow = {
  id: string;
  title: string | null;
  status: "open" | "resolved";
  occurred_at: string | null;
};

type DeferralDigestRow = {
  rec_id: string;
  title: string | null;
  due_at: string | null;
  detail: string | null;
};

function emptyDecisionDigest(snapshotDate: string | null): DecisionDigest {
  return {
    snapshotDate,
    unavailableReason: null,
    labelFlips: { count: 0, publishedCount: 0, items: [] },
    actions: { verifiedCount: 0, silentFailureCount: 0, items: [] },
    anomalies: { openedCount: 0, items: [] },
    deferrals: { dueCount: 0, items: [] },
  };
}

function normalizeDigestLabel(value: string | null | undefined) {
  const label = value?.trim();
  return label ? label.replace(/_/g, " ") : "unknown";
}

function digestSince(
  snapshotDate: string | null,
  fallbackEndDate: string | null,
) {
  const source = snapshotDate ?? fallbackEndDate;
  if (!source) return null;
  const date = new Date(`${source.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function readDecisionDigest(input: {
  businessId: string;
  providerAccountId: string | null;
  recommendationIds: string[];
  entityIds: string[];
  snapshotDate: string | null;
  endDate: string | null;
}): Promise<DecisionDigest> {
  const digest = emptyDecisionDigest(input.snapshotDate);
  try {
    const sql = getDb();
    const since = digestSince(input.snapshotDate, input.endDate);
    const [labelRows, actionRows, anomalyRows, deferralRows] =
      await Promise.all([
        sql`
        WITH target_date AS (
          SELECT COALESCE(
            ${input.snapshotDate}::date,
            (SELECT MAX(snapshot_date) FROM meta_decision_snapshots_daily WHERE business_id = ${input.businessId})
          ) AS snapshot_date
        ),
        latest AS (
          SELECT snapshot.*
          FROM meta_decision_snapshots_daily snapshot
          JOIN target_date ON target_date.snapshot_date = snapshot.snapshot_date
          WHERE snapshot.business_id = ${input.businessId}
            AND COALESCE(snapshot.kind, 'recommendation') = 'recommendation'
            AND snapshot.rec_id = ANY(${input.recommendationIds}::text[])
        )
        SELECT
          latest.rec_id,
          latest.scope_id,
          latest.snapshot_date::text AS snapshot_date,
          COALESCE(
            NULLIF(latest.evidence->>'title', ''),
            NULLIF(latest.evidence->>'name', ''),
            NULLIF(latest.evidence->>'scope_name', ''),
            latest.scope_id
          ) AS title,
          COALESCE(NULLIF(previous.decision_label, ''), previous.decision_state) AS previous_label,
          COALESCE(NULLIF(latest.decision_label, ''), latest.decision_state) AS current_label
        FROM latest
        JOIN LATERAL (
          SELECT previous_snapshot.*
          FROM meta_decision_snapshots_daily previous_snapshot
          WHERE previous_snapshot.business_id = latest.business_id
            AND previous_snapshot.scope_type = latest.scope_type
            AND previous_snapshot.scope_id = latest.scope_id
            AND previous_snapshot.rec_type = latest.rec_type
            AND previous_snapshot.snapshot_date < latest.snapshot_date
          ORDER BY previous_snapshot.snapshot_date DESC
          LIMIT 1
        ) previous ON TRUE
        WHERE COALESCE(NULLIF(previous.decision_label, ''), previous.decision_state)
          IS DISTINCT FROM COALESCE(NULLIF(latest.decision_label, ''), latest.decision_state)
        ORDER BY latest.snapshot_date DESC, latest.created_at DESC
        LIMIT 20
      ` as Promise<LabelFlipDigestRow[]>,
        sql`
        SELECT
          log.id::text AS id,
          log.action::text AS action,
          log.status::text AS status,
          COALESCE(
            NULLIF(ad.ad_name_current, ''),
            NULLIF(ad.ad_name_historical, ''),
            NULLIF(log.payload_request->>'target_name', ''),
            NULLIF(log.payload_request->>'source_name', ''),
            NULLIF(log.payload_request->'body'->>'name', ''),
            log.resulting_ad_id,
            log.ad_id
          ) AS target,
          COALESCE(NULLIF(users.name, ''), NULLIF(users.email, ''), NULLIF(log.source, '')) AS actor,
          COALESCE(log.verified_at, log.updated_at, log.requested_at, log.created_at)::text AS occurred_at,
          log.error_code,
          log.error_message
        FROM meta_ads_action_log log
        LEFT JOIN users ON users.id = log.requested_by
        LEFT JOIN LATERAL (
          SELECT ad_name_current, ad_name_historical
          FROM meta_ad_dimensions
          WHERE business_id = ${input.businessId}
            AND ad_id = COALESCE(log.resulting_ad_id, log.ad_id)
          ORDER BY updated_at DESC
          LIMIT 1
        ) ad ON TRUE
        WHERE log.business_id::text = ${input.businessId}
          AND log.status IN ('success', 'silent_failure')
          AND (
            ${input.providerAccountId}::text IS NULL
            OR EXISTS (
              SELECT 1
              FROM meta_ad_dimensions scoped_ad
              WHERE scoped_ad.business_id = ${input.businessId}
                AND scoped_ad.provider_account_id = ${input.providerAccountId}
                AND scoped_ad.ad_id = COALESCE(log.resulting_ad_id, log.ad_id)
            )
          )
          AND (${since}::timestamptz IS NULL OR log.requested_at >= ${since}::timestamptz)
        ORDER BY COALESCE(log.verified_at, log.updated_at, log.requested_at, log.created_at) DESC
        LIMIT 20
      ` as Promise<ActionDigestRow[]>,
        sql`
        SELECT
          snapshot.rec_id AS id,
          COALESCE(
            NULLIF(snapshot.evidence->>'title', ''),
            NULLIF(snapshot.evidence->>'name', ''),
            NULLIF(snapshot.reasoning, ''),
            snapshot.scope_id
          ) AS title,
          CASE WHEN snapshot.resolved_at IS NULL THEN 'open' ELSE 'resolved' END AS status,
          COALESCE(snapshot.detected_at, snapshot.created_at)::text AS occurred_at
        FROM meta_decision_snapshots_daily snapshot
        WHERE snapshot.business_id = ${input.businessId}
          AND COALESCE(snapshot.kind, 'recommendation') = 'anomaly'
          AND snapshot.scope_id = ANY(${input.entityIds}::text[])
          AND (${since}::timestamptz IS NULL OR COALESCE(snapshot.detected_at, snapshot.created_at) >= ${since}::timestamptz)
        ORDER BY COALESCE(snapshot.detected_at, snapshot.created_at) DESC
        LIMIT 20
      ` as Promise<AnomalyDigestRow[]>,
        sql`
        WITH ranked AS (
          SELECT
            response.rec_id,
            response.action,
            response.action_subtype,
            response.reappear_at,
            response.timestamp,
            ROW_NUMBER() OVER (PARTITION BY response.rec_id ORDER BY response.timestamp DESC) AS row_number
          FROM meta_decision_responses response
          WHERE response.business_id = ${input.businessId}
            AND response.rec_id = ANY(${input.recommendationIds}::text[])
        )
        SELECT
          ranked.rec_id,
          COALESCE(NULLIF(snapshot.evidence->>'title', ''), NULLIF(snapshot.evidence->>'name', ''), ranked.rec_id) AS title,
          ranked.reappear_at::text AS due_at,
          ranked.action_subtype AS detail
        FROM ranked
        LEFT JOIN LATERAL (
          SELECT evidence
          FROM meta_decision_snapshots_daily snapshot
          WHERE snapshot.business_id = ${input.businessId}
            AND snapshot.rec_id = ranked.rec_id
          ORDER BY snapshot.snapshot_date DESC, snapshot.created_at DESC
          LIMIT 1
        ) snapshot ON TRUE
        WHERE ranked.row_number = 1
          AND ranked.action = 'deferred'
          AND ranked.reappear_at IS NOT NULL
          AND ranked.reappear_at <= NOW()
        ORDER BY ranked.reappear_at ASC
        LIMIT 20
      ` as Promise<DeferralDigestRow[]>,
      ]);

    const actions = actionRows.map((row) => ({
      id: row.id,
      action: normalizeDigestLabel(row.action),
      target: row.target?.trim() || "unknown target",
      actor: row.actor?.trim() || null,
      status:
        row.status === "silent_failure"
          ? ("silent_failure" as const)
          : ("verified" as const),
      occurredAt: row.occurred_at ?? null,
      detail:
        row.status === "silent_failure"
          ? (row.error_message ??
            row.error_code ??
            "Meta verification disagreed.")
          : null,
    }));

    return {
      snapshotDate: input.snapshotDate,
      unavailableReason: null,
      labelFlips: {
        count: labelRows.length,
        publishedCount: labelRows.length,
        items: labelRows.map((row) => ({
          id: row.rec_id,
          title: row.title?.trim() || row.scope_id,
          previousLabel: normalizeDigestLabel(row.previous_label),
          currentLabel: normalizeDigestLabel(row.current_label),
          status: "published",
          occurredAt: row.snapshot_date,
        })),
      },
      actions: {
        verifiedCount: actions.filter((item) => item.status === "verified")
          .length,
        silentFailureCount: actions.filter(
          (item) => item.status === "silent_failure",
        ).length,
        items: actions,
      },
      anomalies: {
        openedCount: anomalyRows.filter((row) => row.status === "open").length,
        items: anomalyRows.map((row) => ({
          id: row.id,
          title: row.title?.trim() || row.id,
          status: row.status,
          occurredAt: row.occurred_at ?? null,
        })),
      },
      deferrals: {
        dueCount: deferralRows.length,
        items: deferralRows.map((row) => ({
          id: row.rec_id,
          title: row.title?.trim() || row.rec_id,
          dueAt: row.due_at ?? null,
          detail: row.detail?.trim() || null,
        })),
      },
    };
  } catch {
    return {
      ...digest,
      unavailableReason:
        "Digest source tables are not available in this runtime.",
    };
  }
}

function workspaceBanners(input: {
  pulse: MetaPulsePayload;
  lanes: MetaLanePayload;
  trackingBlocked: boolean;
  killSwitchEngaged: boolean;
  viewer: MetaDecisionsWorkspacePayload["viewer"];
  commercialTargets: MetaCommercialTargets | null;
  commercialTargetsReadFailed: boolean;
}): MetaOsWorkspaceBanner[] {
  const banners: MetaOsWorkspaceBanner[] = [];
  if (input.viewer?.readOnly && input.viewer.readOnlyReason) {
    banners.push({
      id: input.viewer.isReviewer
        ? "reviewer_read_only"
        : "workspace_read_only",
      tone: "info",
      title: input.viewer.isReviewer
        ? "Reviewer access is read-only."
        : "Workspace access is read-only.",
      detail: input.viewer.readOnlyReason,
      blocking: false,
    });
  }
  const readiness = input.pulse.dataReadiness;
  if (readiness && (readiness.status !== "ok" || readiness.isPartial)) {
    banners.push({
      id: "data_readiness",
      tone: "warning",
      title: "Data is not fully ready.",
      detail:
        readiness.notReadyReason ??
        "The selected range is partially verified; numbers may be incomplete.",
      blocking: false,
    });
  }
  if (input.commercialTargetsReadFailed) {
    banners.push({
      id: "commercial_target_authority_unavailable",
      tone: "warning",
      title: "Commercial target authority could not be verified.",
      detail:
        "Target economics could not be read. Hard Scale/Cut authority remains withheld until the source is available.",
      blocking: false,
      scope: "target_hard_actions",
      action: {
        label: "Review commercial truth",
        href: "/commercial-truth",
      },
    });
  } else if (input.commercialTargets?.source === "none") {
    banners.push({
      id: "commercial_target_authority_missing",
      tone: "warning",
      title: "Commercial targets are not configured.",
      detail:
        "Set at least one valid economic anchor before hard Scale/Cut authority can be evaluated.",
      blocking: false,
      scope: "target_hard_actions",
      action: {
        label: "Set commercial truth",
        href: "/commercial-truth",
      },
    });
  } else if (
    input.commercialTargets?.source === "configured_targets" &&
    input.commercialTargets.freshness !== "fresh"
  ) {
    const freshnessUnknown = input.commercialTargets.freshness === "unknown";
    banners.push({
      id: "stale_commercial_target_authority",
      tone: "warning",
      title: freshnessUnknown
        ? "Commercial target freshness is unknown."
        : "Commercial target review is due.",
      detail: freshnessUnknown
        ? "Configured targets have no trustworthy confirmation time. Hard Scale/Cut authority is suppressed until the economics are reviewed and reconfirmed."
        : "Configured targets are older than the review interval. This is advisory only; age does not suppress the decision engine's Scale/Cut authority.",
      blocking: false,
      scope: "target_hard_actions",
      action: {
        label: "Review commercial truth",
        href: "/commercial-truth",
      },
    });
  }
  if (input.trackingBlocked) {
    banners.push({
      id: "tracking_write_gate",
      tone: "danger",
      title: "Tracking anomaly active.",
      detail: input.pulse.trackingHealth.detail,
      blocking: true,
    });
  }
  const snapshotHealth =
    input.pulse.snapshotHealth ?? input.lanes.snapshotHealth ?? null;
  if (snapshotHealth && snapshotHealth.status !== "fresh") {
    banners.push({
      id: "snapshot_health",
      tone: snapshotHealth.status === "missing" ? "danger" : "warning",
      title: "Decision snapshot is not fresh.",
      detail:
        snapshotHealth.staleReason ??
        "The served snapshot does not meet the current freshness contract.",
      blocking: snapshotHealth.status === "missing",
    });
  }
  if (input.killSwitchEngaged) {
    banners.push({
      id: "meta_write_kill_switch",
      tone: "danger",
      title: "Kill switch engaged.",
      detail:
        "All active Meta write endpoints are blocked by META_ADS_WRITE_KILL_SWITCH.",
      blocking: true,
    });
  }
  return banners;
}

export async function GET(request: NextRequest) {
  const requestStartedAt = performance.now();
  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId) {
    return NextResponse.json(
      { error: "businessId is required" },
      { status: 400 },
    );
  }
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;
  const viewer = workspaceViewer({
    role: access.membership.role,
    email: access.session.user.email,
  });
  const providerAccountId =
    request.nextUrl.searchParams.get("providerAccountId")?.trim() || null;
  const adCandidateLimit = requestedAdCandidateLimit(
    request.nextUrl.searchParams,
  );
  const compactOsSurface = request.nextUrl.searchParams.get("surface") === "os";

  const explicitEndDate = request.nextUrl.searchParams.get("endDate");
  const loadResolvedEndDate = () =>
    resolveWorkspaceEndDate({
      businessId,
      providerAccountId,
      explicitEndDate,
    });
  const resolvedEndDate =
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test" ||
    Boolean(explicitEndDate?.trim())
      ? await loadResolvedEndDate()
      : (
          await getCachedValue({
            key: `meta-decisions-end-date-v2:${businessId}:${providerAccountId ?? "none"}`,
            ttlMs: 5 * 60_000,
            staleWhileRevalidateMs: 60 * 60_000,
            loader: loadResolvedEndDate,
          })
        ).value;
  const endDateResolvedAt = performance.now();
  const params = workspaceParams(request.nextUrl.searchParams, resolvedEndDate);
  // A dated view keeps the persisted snapshot's historical target provenance,
  // but serve-time action authority must always be revalidated against current
  // commercial truth (D045).
  const commercialTargetsPromise = readMetaCommercialTargets(businessId)
    .then((targets) => ({ targets, readFailed: false as const }))
    .catch(() => ({ targets: null, readFailed: true as const }));
  let currentAdsCompletedAt = endDateResolvedAt;
  const currentAdsPromise = readCurrentMetaAds({
    businessId,
    providerAccountId,
  }).then((result) => {
    currentAdsCompletedAt = performance.now();
    return result;
  });

  try {
    const loadUpstreams = () =>
      Promise.all([
        readInternalJson<MetaPulsePayload>(
          request,
          "account-pulse",
          "/api/meta/account-pulse",
          params,
        ),
        readInternalJson<MetaLanePayload>(
          request,
          "lane-classify",
          "/api/meta/lane-classify",
          params,
        ),
      ] as const);
    const [pulse, lanes] =
      process.env.VITEST === "true" || process.env.NODE_ENV === "test"
        ? await loadUpstreams()
        : (
            await getCachedValue({
              key: `meta-decisions-upstreams-v1:${params.toString()}`,
              ttlMs: 30_000,
              staleWhileRevalidateMs: 5 * 60_000,
              loader: loadUpstreams,
            })
          ).value;
    const upstreamsCompletedAt = performance.now();
    const trackingBlocked = isTrackingBlocked(pulse);
    const killSwitchEngaged = isMetaWritesKillSwitchEngaged();
    const scopedRecommendations = [
      ...lanes.actionNow,
      ...lanes.watching,
      ...lanes.nonSales,
    ];
    const decisionReadPromise = currentAdsPromise.then(async (currentAds) => {
      const campaignContextIds = normalizeMetaDecisionCampaignContextIds({
        currentAds: currentAds.rows,
        structureCampaignIds: [
          ...scopedRecommendations.map((rec) => rec.campaignId),
          ...(lanes.structureInventory ?? []).map((row) => row.campaignId),
        ],
      });
      const loadDecisionBundle = async () => {
        const [decisionRead, currentAdCampaignContexts] = await Promise.all([
          canonicalDecisionReadModel({
            businessId,
            providerAccountId,
            adCandidateLimit,
            asOfDate: resolvedEndDate,
            currentAds,
            activeOnly: compactOsSurface,
          }),
          readCurrentCampaignContexts({
            businessId,
            providerAccountId,
            snapshotAsOf: resolvedEndDate,
            campaignIds: campaignContextIds,
          }),
        ]);
        return { currentAds, decisionRead, currentAdCampaignContexts };
      };
      if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
        return loadDecisionBundle();
      }
      return (
        await getCachedValue({
          key: `meta-decisions-bundle-v5:${businessId}:${providerAccountId ?? "none"}:${resolvedEndDate}:${adCandidateLimit}:${compactOsSurface ? "active" : "full"}:${inputAdScopeKey(currentAds)}:${metaDecisionCampaignContextScopeKey(campaignContextIds)}`,
          ttlMs: 60_000,
          staleWhileRevalidateMs: 240_000,
          loader: loadDecisionBundle,
        })
      ).value;
    });
    const [decisionBundle, digest, commercialTargetRead] = await Promise.all([
      decisionReadPromise,
      compactOsSurface
        ? Promise.resolve(null)
        : readDecisionDigest({
            businessId,
            providerAccountId,
            recommendationIds: [
              ...new Set(
                scopedRecommendations.map((rec) => rec.id).filter(Boolean),
              ),
            ],
            entityIds: [
              ...new Set(
                scopedRecommendations
                  .flatMap((rec) => [rec.campaignId, rec.adsetId])
                  .filter((value): value is string => Boolean(value)),
              ),
            ],
            snapshotDate: lanes.snapshotDate,
            endDate: lanes.endDate ?? pulse.endDate,
          }),
      commercialTargetsPromise,
    ]);
    const decisionBundleCompletedAt = performance.now();
    const { currentAds, decisionRead, currentAdCampaignContexts } =
      decisionBundle;
    if (!decisionRead.ok) {
      return NextResponse.json(decisionRead.payload, {
        status: decisionRead.status,
      });
    }
    const targetHardActionEligibility = {
      scale:
        !commercialTargetRead.readFailed &&
        hasMetaHardActionAnchor(commercialTargetRead.targets) &&
        commercialTargetRead.targets?.targetRoas != null,
      cut:
        !commercialTargetRead.readFailed &&
        hasMetaHardActionAnchor(commercialTargetRead.targets) &&
        commercialTargetRead.targets?.breakEvenRoas != null,
    };
    const servedLanes = revalidateMetaStructureLanesForCurrentTargets(
      lanes,
      targetHardActionEligibility,
    );
    const payload: MetaDecisionsWorkspacePayload & {
      decisionReadModel: MetaDecisionsWorkspaceReadModel;
    } = {
      businessId: pulse.businessId,
      window: pulse.window as MetaWindowKey,
      statusFilter: pulse.statusFilter,
      startDate: pulse.startDate,
      endDate: pulse.endDate,
      pulse,
      lanes: servedLanes,
      queue: {
        groups: queueGroups(servedLanes),
        actionStates: actionStates(servedLanes),
      },
      system: {
        trackingBlocked,
        dataReadiness: pulse.dataReadiness ?? null,
        snapshotHealth:
          pulse.snapshotHealth ?? servedLanes.snapshotHealth ?? null,
        laneSnapshotDate: servedLanes.snapshotDate,
        laneSnapshotCreatedAt: servedLanes.snapshotCreatedAt ?? null,
        engineVersion: pulse.engineVersion,
        currency: pulse.currency ?? null,
        killSwitchEngaged,
        killSwitchReason: killSwitchEngaged
          ? "META_ADS_WRITE_KILL_SWITCH"
          : null,
      },
      viewer,
      banners: workspaceBanners({
        pulse,
        lanes: servedLanes,
        trackingBlocked,
        killSwitchEngaged,
        viewer,
        commercialTargets: commercialTargetRead.targets,
        commercialTargetsReadFailed: commercialTargetRead.readFailed,
      }),
      digest: digest ?? {
        snapshotDate: servedLanes.snapshotDate,
        unavailableReason: "not_requested_for_compact_surface",
        labelFlips: { count: 0, publishedCount: 0, items: [] },
        actions: { verifiedCount: 0, silentFailureCount: 0, items: [] },
        anomalies: { openedCount: 0, items: [] },
        deferrals: { dueCount: 0, items: [] },
      },
      decisionReadModel: decisionRead.model,
      os: buildMetaOsDecisionsPresentation({
        actionNow: servedLanes.actionNow,
        watching: servedLanes.watching,
        nonSales: servedLanes.nonSales,
        structureInventory: servedLanes.structureInventory,
        inactiveStructure: servedLanes.archive,
        decisionReadModel: decisionRead.model,
        currentAds: currentAds.complete ? currentAds.rows : [],
        currentAdCampaignContexts,
        currency: pulse.currency ?? null,
        targetHardActionEligibility,
      }),
    };
    if (compactOsSurface) {
      const compactPayload: MetaDecisionsOsWorkspacePayload = {
        businessId: payload.businessId,
        window: payload.window,
        statusFilter: payload.statusFilter,
        startDate: payload.startDate,
        endDate: payload.endDate,
        pulse: { lastSyncAt: payload.pulse.lastSyncAt ?? null },
        system: payload.system,
        viewer: payload.viewer,
        banners: payload.banners,
        decisionReadModel: {
          status: payload.decisionReadModel.status,
          unavailable: payload.decisionReadModel.unavailable ?? null,
        },
        os: payload.os,
      };
      return NextResponse.json(compactPayload, {
        headers: {
          "Cache-Control": "private, max-age=0",
          "Server-Timing": [
            `resolve_end_date;dur=${(endDateResolvedAt - requestStartedAt).toFixed(1)}`,
            `upstreams;dur=${(upstreamsCompletedAt - endDateResolvedAt).toFixed(1)}`,
            `current_ads;dur=${(currentAdsCompletedAt - endDateResolvedAt).toFixed(1)}`,
            `decision_bundle;dur=${(decisionBundleCompletedAt - upstreamsCompletedAt).toFixed(1)}`,
            `total;dur=${(decisionBundleCompletedAt - requestStartedAt).toFixed(1)}`,
          ].join(", "),
        },
      });
    }
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof UpstreamError) {
      return NextResponse.json(
        {
          error: "upstream_failed",
          source: error.source,
          detail: error.payload,
        },
        { status: error.status },
      );
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to build Meta decisions workspace.",
      },
      { status: 500 },
    );
  }
}
