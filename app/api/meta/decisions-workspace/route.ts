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
import { resolveMetaSurfaceReadState } from "@/lib/meta/surface-read-state";
import { decisionsWorkspaceSources } from "@/lib/meta/decisions-workspace-read-state";
import {
  fetchMetaActiveAdConfigsReceipt,
  resolveMetaCredentials,
} from "@/lib/api/meta";
import { getDb, getDbRuntimeDiagnostics } from "@/lib/db";
import { META_ACTION_DIGEST_ROW_CAP } from "./action-digest-window";
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
  describeAccountStatePolicy,
  readMetaAssignedAccountStates,
} from "@/lib/meta/assigned-account-states";
import {
  buildUnavailableMetaDecisionsWorkspaceReadModel,
  applyMetaExecutionGovernanceToReadModel,
  readMetaDecisionCampaignContextRows,
  readMetaDecisionsWorkspaceReadModel,
  type MetaCurrentAdStatusSourceRow,
  type MetaDecisionCampaignContextSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import {
  readEffectiveMetaWriteGovernance,
  type MetaEffectiveWriteGovernance,
} from "@/lib/meta/automation-control-plane";
import {
  buildMetaOsDecisionsPresentation,
  revalidateMetaStructureLanesForCurrentTargets,
} from "@/lib/meta/decisions-os-presentation";
import type { MetaOsWorkspaceBanner } from "@/lib/meta/decisions-os-contract";
import {
  projectMetaCommercialAnchorPanel,
  tallyAuthorityBlockers,
} from "@/lib/meta/commercial-anchor-panel";
import {
  ACCOUNT_DECISION_PROFILE_CONTRACT,
  resolveAccountDecisionProfile,
} from "@/lib/creative-decision-engine/account-decision-profile";
import { evaluateBudgetDecisionGates } from "@/lib/meta/budget-decision-gates";
import { projectBudgetDecisionEvidencePanel } from "@/lib/meta/budget-decision-evidence-panel";
import {
  type DryRunInput,
  META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
  PROVIDER_CAPABILITY_TODAY,
  admissionToSafetyFlag,
  buildBudgetProposalDryRun,
  governanceToKillSwitchFlag,
  unknownSafetyFlag,
} from "@/lib/meta/budget-proposal-dry-run";
import { projectBudgetDryRunPanel } from "@/lib/meta/budget-dry-run-panel";
import { WRITE_SAFETY_STEPS } from "@/lib/meta/write-safety-contract";
import { buildWorkspaceBudgetGateInput } from "@/lib/meta/budget-decision-workspace-adapter";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import {
  AccountScopedDataSource,
  WarehouseDataSource,
  type BusinessTargetPack,
} from "@/lib/creative-decision-engine/data-source";
import {
  businessPooledMeasurementScope,
  resolveAccountProfileMeasurementScope,
  type AccountProfileMeasurementScope,
} from "@/lib/meta/account-profile-output-producer";
import type { HardActionEligibility } from "@/lib/creative-decision-engine/types";
import {
  resolveObservedShopifyAov,
  type ObservedShopifyAovEvidence,
} from "@/lib/creative-decision-engine/shopify-aov-source";
import { resolveMinorUnitExponent } from "@/lib/currency/iso-4217-minor-units";
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
import { readMetaBusinessDataPosture } from "@/lib/meta/business-data-posture";
import { META_FAILURES } from "@/lib/meta/read-state-contract";
import { metaPostureUnavailable } from "@/app/api/meta/read-posture";
import {
  buildMetaDecisionPipelineHealth,
  readMetaDecisionPipelineOperationalHealth,
  type MetaDecisionPipelineHealth,
} from "@/lib/meta/decision-pipeline-health";

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
  const ids = [
    ...new Set(input.rows.map((row) => row.adId.trim()).filter(Boolean)),
  ].sort();
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive day count for a preset key. Unknown keys read as the 28d default,
 *  which is what both upstreams' own `parseWindow` already does. */
function workspaceWindowDays(window: string | null): number {
  if (window === "7d") return 7;
  if (window === "14d") return 14;
  if (window === "90d") return 90;
  return 28;
}

function shiftIsoDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function statedIsoDate(source: URLSearchParams, key: string): string | null {
  const value = source.get(key)?.trim() ?? "";
  return ISO_DATE.test(value) ? value : null;
}

/**
 * Resolve the window ONCE, here, and hand both upstreams the same two days.
 *
 * This was the third of three disagreeing resolvers. It forwarded whatever
 * dates it was given and, when given none, filled in only an end date of its
 * own (`resolveWorkspaceEndDate`) — so a caller who picked "Last 7 days" and a
 * caller who picked it in the shell were answered for different weeks, and a
 * caller who stated a start date with no end got a window of arbitrary length
 * still labelled "7d".
 *
 * The rule is now the same one the client obeys (see
 * `DATE_WINDOW_INCLUDES_CURRENT_DAY` in `lib/dashboard/date-window-url`): a
 * stated pair of dates IS the window and travels verbatim; a half-stated or
 * unstated window is completed from the preset's own day count, anchored on
 * whichever end is known. The response echoes the dates the upstreams
 * measured, so the window named is the window served.
 */
function resolveWorkspaceWindow(
  source: URLSearchParams,
  resolvedEndDate: string,
): { startDate: string; endDate: string } {
  const statedStart = statedIsoDate(source, "startDate");
  const statedEnd = statedIsoDate(source, "endDate");
  if (statedStart && statedEnd && statedStart <= statedEnd) {
    return { startDate: statedStart, endDate: statedEnd };
  }
  const days = workspaceWindowDays(source.get("window"));
  if (statedEnd) {
    return {
      startDate: shiftIsoDate(statedEnd, -(days - 1)),
      endDate: statedEnd,
    };
  }
  if (statedStart) {
    return {
      startDate: statedStart,
      endDate: shiftIsoDate(statedStart, days - 1),
    };
  }
  return {
    startDate: shiftIsoDate(resolvedEndDate, -(days - 1)),
    endDate: resolvedEndDate,
  };
}

function workspaceParams(source: URLSearchParams, resolvedEndDate: string) {
  const params = new URLSearchParams();
  for (const key of ["businessId", "providerAccountId", "window"]) {
    const value = source.get(key);
    if (value) params.set(key, value);
  }
  // Structure is an account inventory. Action authority is still restricted
  // to live recommendations by the server presentation layer.
  params.set(
    "status_filter",
    source.get("status_filter") ??
      (source.get("surface") === "os" ? "active" : "all"),
  );
  const window = resolveWorkspaceWindow(source, resolvedEndDate);
  // Both dates always travel. Leaving `startDate` off let each upstream derive
  // its own start from its own `windowDays` table — two copies of one rule,
  // which is one copy too many for a number the operator is shown.
  params.set("startDate", window.startDate);
  params.set("endDate", window.endDate);
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
  generatedAt: string;
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
        generatedAt: input.generatedAt,
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
        generatedAt: input.generatedAt,
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
      generatedAt: input.generatedAt,
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
        generatedAt: input.generatedAt,
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
        generatedAt: input.generatedAt,
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

/**
 * The ad account's own currency, from the assignment this business holds.
 *
 * Selected rather than assumed, and read from `provider_accounts` rather than
 * from a warehouse fact row, because this is the same column the retention
 * producer reads (`readAccountCurrency` in `lib/meta/account-profile-output-producer.ts`)
 * and the serve-time answer must be able to agree with the retained one.
 *
 * With no account named, the sole SELECTED Meta assignment answers and two or
 * more answer nothing. That is the rule this repository already applies to
 * account lineage (`accountForRecommendation` in `lib/meta/snapshot.ts`):
 * "the business" and "one account" are the same fact only when there is one.
 */
async function readServeTimeAccountCurrency(input: {
  businessId: string;
  providerAccountId: string | null;
}): Promise<string | null> {
  const rows = await getDb().query<{ currency: string | null }>(
    `SELECT pa.currency
       FROM business_provider_accounts bpa
       JOIN provider_accounts pa ON pa.id = bpa.provider_account_ref_id
      WHERE bpa.business_id = $1
        AND bpa.provider = 'meta'
        AND ($2::text IS NULL OR bpa.provider_account_id = $2)
        AND ($2::text IS NOT NULL OR bpa.is_selected = TRUE)
      LIMIT 2`,
    [input.businessId, input.providerAccountId],
  );
  if (rows.length !== 1) return null;
  const currency = rows[0]?.currency;
  return typeof currency === "string" && currency.trim() !== ""
    ? currency.trim()
    : null;
}

/**
 * Store evidence for the serve-time anchor re-resolution.
 *
 * The order is the producer's, not a new one: a configured Target CPA or an
 * operator AOV assumption sits ABOVE the store in `resolveSpendUnit`'s ladder,
 * so when either exists the store is never consulted and this reads nothing.
 * ROAS stays the only required commercial target; this is what makes that true
 * on the served panel as well as in the retained row.
 *
 * Every refusal belongs to `resolveObservedShopifyAov` — a thin sample, a
 * mixed or foreign currency, a stale or incompletely covered orders sync. This
 * function converts no currency of its own.
 *
 * WHAT AN ACCOUNT CURRENCY OUTSIDE THE ISO MINOR-UNIT REGISTRY ACTUALLY DOES,
 * corrected here because the previous wording asserted the opposite.
 *
 * It does NOT yield `null`. `resolveMinorUnitExponent` refuses the code, this
 * passes `currencyExponent: null`, and `resolveObservedShopifyAov` records the
 * evidence with its own two-decimal fallback exponent. Because
 * `resolveSpendUnitProfile` then divides by that SAME recorded exponent, the
 * major amount round-trips unchanged and the derived unit is the store's AOV
 * over the target ROAS whichever exponent was recorded — so nothing is
 * rescaled, and the served answer equals what the retention producer resolves
 * from the identical inputs. `lib/meta/snapshot.ts` is stricter for the
 * benchmark it writes in MINOR units, where the exponent does not cancel: it
 * requires a resolved exponent and withholds without one. That difference
 * between the two paths is real and is stated rather than assumed away;
 * `app/api/meta/served-profile-account-scope.db.test.ts` pins the behaviour of
 * this one against a KES store and a KES account.
 */
async function resolveServeTimeObservedShopifyAov(input: {
  businessId: string;
  providerAccountId: string | null;
  targetPack: BusinessTargetPack | null;
}): Promise<ObservedShopifyAovEvidence | null> {
  if (input.targetPack?.targetCpa || input.targetPack?.operatorAovAssumption) {
    return null;
  }
  const accountCurrency = await readServeTimeAccountCurrency({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  }).catch(() => null);
  const exponent = resolveMinorUnitExponent(accountCurrency);
  return resolveObservedShopifyAov({
    businessId: input.businessId,
    accountCurrency,
    currencyExponent: exponent.status === "resolved" ? exponent.exponent : null,
  }).catch(() => null);
}

/**
 * How many served rows carry a control the operator can actually press.
 *
 * The three `executable*` counters used to be read off `rec.actionKind`, and
 * `actionKind` cannot produce them. Its only two writers in the tree are
 * `serverActionKindForRec` (`lib/meta/rec-presentation.ts`), which returns
 * `review_drill`, `route_launchpad_rebuild` or `route_launchpad_duplicate` and
 * nothing else, and the literal `'review_drill'` in
 * `lib/meta/decisions-os-presentation.ts`. So the census reported
 * `{executableBid: 0, …, reviewOnly: <every row>}` on the very same response
 * whose card carried `operatorApply {action:"bid", bidAmountMinor:1320}` —
 * including in the postures where that amount was POSTed to the provider and
 * confirmed by read-back.
 *
 * `operatorApply` is therefore what the census counts, because it is what the
 * row actually offers. `actionKind` answers a DIFFERENT question — what the
 * ENGINE authorizes — and that separation is deliberate and documented at
 * `lib/meta/rec-presentation.ts:249-267`. It is not collapsed here: the three
 * `execute_*` branches below are kept, unreached today, for the engine-
 * authorized execution path that contract describes. When that path lands its
 * rows will carry both, and the `operatorApply` test above will already have
 * counted them, so the branches stay `else if` and cannot double-count.
 */
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
      const operatorApply = rec.operatorApply ?? null;
      if (operatorApply?.action === "bid") acc.executableBid += 1;
      else if (operatorApply?.action === "pause") acc.executablePause += 1;
      else if (operatorApply?.action === "resume") acc.executableResume += 1;
      else if (rec.actionKind === "execute_pause") acc.executablePause += 1;
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
    actions: {
      verifiedCount: 0,
      silentFailureCount: 0,
      countedRowCap: META_ACTION_DIGEST_ROW_CAP,
      // Nothing was counted, so nothing was cut off. The cap is still stated:
      // it describes this reader, not this account, and a consumer that has to
      // explain its own numbers needs it in every arm.
      countsTruncated: false,
      items: [],
    },
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
        countedRowCap: META_ACTION_DIGEST_ROW_CAP,
        /**
         * BOTH COUNTS ABOVE DESCRIBE THE RETURNED ROWS, NOT THE WINDOW.
         *
         * The action-log query is ordered newest-first and bounded by
         * `META_ACTION_DIGEST_ROW_CAP`, so a full page is the query telling us
         * it stopped early: rows older than the newest N were never read and
         * cannot have been counted. That is the whole fact a consumer needs to
         * keep its sentence no wider than its measurement, and it is the only
         * one available without a second COUNT(*) over the same predicate.
         *
         * `>=` rather than `===` on purpose. It is the same claim while the
         * bound holds, and it stays TRUE rather than silently flipping to
         * "complete" if the query ever returns more than it asked for.
         */
        countsTruncated: actionRows.length >= META_ACTION_DIGEST_ROW_CAP,
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

function pipelineHealthBanner(
  health: MetaDecisionPipelineHealth,
): MetaOsWorkspaceBanner {
  const dataThrough = health.warehouse.latestFinalizedDate;
  const syncHealthy =
    health.syncActivity.status === "fresh" &&
    health.warehouse.status === "fresh" &&
    health.admission.allowed;
  const generationHealthy =
    health.decisionGeneration.status === "fresh" &&
    health.manifest.status === "fresh";

  const details = [
    syncHealthy && dataThrough
      ? `Meta facts are verified through ${dataThrough}.`
      : !syncHealthy && dataThrough
        ? `Verified Meta data ends on ${dataThrough}.`
        : null,
    health.syncActivity.status !== "fresh"
      ? (health.syncActivity.reason ??
        "Recent Meta sync activity is not fresh.")
      : null,
    health.warehouse.status !== "fresh"
      ? (health.warehouse.reason ??
        "The finalized Meta warehouse cutoff is not current.")
      : null,
    !health.admission.allowed
      ? health.admission.offender
        ? "A storage safety limit stopped new Meta observations."
        : "The sync admission gate is closed."
      : null,
    health.decisionGeneration.status !== "fresh"
      ? (health.decisionGeneration.reason ??
        "The exact-Ad decision generation is not current.")
      : null,
    health.manifest.status !== "fresh"
      ? (health.manifest.reason ??
        "The native exact-Ad generation manifest is invalid.")
      : null,
    "No current decision can execute until the stated pipeline checks recover.",
  ].filter((value): value is string => Boolean(value));

  return {
    id: "meta_decision_pipeline_health",
    tone: health.overall === "blocked" ? "danger" : "warning",
    title: !syncHealthy
      ? health.admission.allowed
        ? "Meta data is not current — decisions are review-only."
        : "Meta data sync is stopped — current decisions are unavailable."
      : !generationHealthy && health.manifest.status !== "fresh"
        ? "Decision generation manifest is invalid — decisions are review-only."
        : "Decision generation is not current — decisions are review-only.",
    detail: details.join(" "),
    blocking: true,
    action: {
      label: "Open recovery status",
      href: "/platforms/meta/automation",
    },
  };
}

function workspaceBanners(input: {
  pulse: MetaPulsePayload;
  lanes: MetaLanePayload;
  trackingBlocked: boolean;
  executionGovernance: MetaEffectiveWriteGovernance;
  viewer: MetaDecisionsWorkspacePayload["viewer"];
  commercialTargets: MetaCommercialTargets | null;
  commercialTargetsReadFailed: boolean;
  decisionReadModel: MetaDecisionsWorkspaceReadModel;
  pipelineHealth: MetaDecisionPipelineHealth;
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
  if (!input.pipelineHealth.executionReady) {
    banners.push(pipelineHealthBanner(input.pipelineHealth));
  }
  const nonFreshExactDecisions =
    input.decisionReadModel.queue?.adCandidates?.items.filter((decision) => {
      const authority = decision.sourceAuthority;
      return (
        authority?.status === "native_exact" &&
        authority.actionEligible === true &&
        authority.decisionFreshness?.status !== "fresh"
      );
    }) ?? [];
  if (nonFreshExactDecisions.length > 0) {
    const statuses = [
      ...new Set(
        nonFreshExactDecisions.map(
          (decision) =>
            decision.sourceAuthority?.decisionFreshness?.status ??
            "unavailable",
        ),
      ),
    ];
    banners.push({
      id: "exact_ad_decision_freshness",
      tone: "danger",
      title: "Exact-Ad decisions are outside the execution window.",
      detail: `${nonFreshExactDecisions.length} decision-authorized row(s) are ${statuses.join(
        ", ",
      )}. Refresh the native decision generation before attempting a provider write.`,
      blocking: true,
    });
  }
  if (input.executionGovernance.killSwitchEngaged) {
    banners.push({
      id: "meta_write_kill_switch",
      tone: "danger",
      title: "Kill switch engaged.",
      detail:
        input.executionGovernance.killSwitchReason ??
        "All active Meta write endpoints are blocked by a verified kill switch.",
      blocking: true,
    });
  } else if (
    !input.executionGovernance.verified ||
    !input.executionGovernance.controlsConfigured ||
    input.executionGovernance.writeBlocked
  ) {
    banners.push({
      id: "meta_execution_governance_unavailable",
      tone: "danger",
      title: "Meta execution governance is not ready.",
      detail:
        input.executionGovernance.blockReason ===
        "business_control_not_configured"
          ? "This business has no persisted automation control row. Decisions remain readable, but every Meta write is blocked."
          : "Automation control state could not be verified. Decisions remain readable, but every Meta write is blocked.",
      blocking: true,
    });
  }
  return banners;
}

/**
 * Collects the persisted first-authority-gate blocker of every canonical
 * decision the read model serves. Server-owned evidence only: nothing is
 * inferred from labels, badges, or reason text.
 */
function collectCanonicalAuthorityBlockers(
  model: MetaDecisionsWorkspaceReadModel,
): Array<string | null> {
  const blockers: Array<string | null> = [];
  const push = (
    items:
      | Array<{ sourceDecision?: { authorityBlocker?: string | null } }>
      | undefined,
  ) => {
    for (const item of items ?? []) {
      blockers.push(item.sourceDecision?.authorityBlocker ?? null);
    }
  };
  push(model.queue?.adCandidates?.items);
  push(model.queue?.inactiveAssets?.items);
  return blockers;
}

export async function GET(request: NextRequest) {
  const requestStartedAt = performance.now();
  const requestEvaluatedAt = new Date();
  const requestGeneratedAt = requestEvaluatedAt.toISOString();
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

  /**
   * D071: posture is resolved here, before any other work.
   *
   * Everything below this point reads live sources — workspace end date,
   * commercial targets, current Ads, campaign contexts, the decision digest,
   * and the account-pulse and lane-classify upstreams. A confirmed demo or an
   * unverified workspace must reach none of them, so both return here rather
   * than being filtered further in. Resolving posture once, at the top, is
   * also what stops a lower function re-resolving it differently.
   */
  const posture = await readMetaBusinessDataPosture(businessId);
  if (posture !== "live") {
    if (posture !== "demo") {
      return metaPostureUnavailable("meta_decisions_workspace");
    }
    /**
     * A confirmed demo workspace cannot be served a truthful workspace
     * envelope today, so it fails closed instead of being weakened.
     *
     * The committed fixture could supply a decision inventory, but it cannot
     * supply `MetaDecisionsWorkspacePayload.pulse`, whose `pacing.mtdSpend`,
     * `pacing.dayPace` and `roas.selected/d7/d14/d28` are required numbers with
     * no unavailable representation: emitting zeros there would convert source
     * absence into a measured value, which INVARIANTS forbids. Its two sources,
     * `account-pulse` and `lane-classify`, are not posture-aware and read the
     * database and provider credentials directly.
     *
     * Making them posture-aware is the shared posture layer D071 defers. Until
     * then this is a refusal, not an empty success.
     */
    return NextResponse.json(
      {
        error: "demo_workspace_envelope_unavailable",
        message: META_FAILURES.demo_workspace_envelope_unavailable.message,
        isPartial: true,
        notReadyReason:
          META_FAILURES.demo_workspace_envelope_unavailable.message,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

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
  const executionGovernancePromise = readEffectiveMetaWriteGovernance({
    businessId,
  });
  const operationalPipelineHealthPromise =
    readMetaDecisionPipelineOperationalHealth({
      businessId,
      providerAccountId,
      now: requestEvaluatedAt,
    });

  /**
   * The shell's date range scopes metrics only. It must never pin the current
   * decision inventory to the last metric day: the latest complete native
   * generation is commonly produced the following day (for example, a Sep 4
   * generation over facts finalized through Sep 3). Passing `explicitEndDate`
   * here made the normal shell URL suppress that healthy generation and serve
   * an older, sometimes invalid, manifest while claiming that the range did
   * not affect decisions.
   *
   * Keep the metric end date as the upstream window below, and resolve the
   * decision as-of independently from persisted decision evidence (D090).
   */
  const loadResolvedDecisionAsOf = () =>
    resolveWorkspaceEndDate({
      businessId,
      providerAccountId,
      explicitEndDate: null,
    });
  const decisionAsOfDate =
    process.env.VITEST === "true" || process.env.NODE_ENV === "test"
      ? await loadResolvedDecisionAsOf()
      : (
          await getCachedValue({
            key: `meta-decisions-as-of-v3:${businessId}:${providerAccountId ?? "none"}`,
            ttlMs: 5 * 60_000,
            staleWhileRevalidateMs: 60 * 60_000,
            loader: loadResolvedDecisionAsOf,
          })
        ).value;
  const endDateResolvedAt = performance.now();
  // Direct API callers without dates get the same completed-day metric window
  // as the shell. A current-day decision may still be served over it.
  const metricsEndDate =
    statedIsoDate(request.nextUrl.searchParams, "endDate") ?? previousUtcDate();
  const params = workspaceParams(request.nextUrl.searchParams, metricsEndDate);
  // The metric window and current decision date are deliberately independent.
  // Serve-time action authority is always revalidated against current
  // commercial truth (D045).
  const commercialTargetsPromise = readMetaCommercialTargets(businessId)
    .then((targets) => ({ targets, readFailed: false as const }))
    .catch(() => ({ targets: null, readFailed: true as const }));
  /**
   * The canonical account decision profile, resolved as of the current
   * decision generation rather than the metric window's final day.
   *
   * This is the SOLE authority for the commercial-anchor explanation the
   * Decision Center serves: the surface must show what the engine actually
   * decided (including a ready sampled Meta AOV or an account-history rung),
   * not a second resolver's guess from configured target fields. A failed read
   * fails closed to `eligibility: null`, which the projection renders as
   * unavailable rather than as "no anchor configured".
   *
   * AND IT IS RESOLVED AT THE SELECTED ACCOUNT'S MEASUREMENT SCOPE, which this
   * call used to skip.
   *
   * It built a plain `WarehouseDataSource`, and every measured read
   * `resolveAccountDecisionProfile` then makes — the account calibration, its
   * kind-segmented variants, the funnel pack, and the live Meta-attributed AOV
   * it falls back to — defaults to the business's whole Meta footprint. Only
   * the store evidence below was account-scoped. So on a business holding two
   * ad accounts the panel served a verdict computed from BOTH: with account A
   * carrying 6 converters and account B carrying 32, A's served anchor reported
   * `scale` ELIGIBLE — the pooled calibration clears the 30-creative
   * automation-quality floor that A's own six cannot, and the served lineage
   * carried the pooled `metaAttributedAovPurchaseCount90d: 38` and
   * `accountCpaSampleCount: 38` — while A's own retained
   * `engine_v3_account_profile_output` row for the same day said
   * `scale: false` with `scale_calibration_below_floor`. One response carrying
   * two contradictory commercial verdicts about the same account, and the
   * operator-facing half authorising a budget increase the budget path refuses.
   * Without store evidence the same pooling let an account with no purchases of
   * its own inherit a sibling's Meta-attributed average order value.
   * `app/api/meta/served-profile-account-scope.db.test.ts` drives all of it
   * against a migrated database and fails on every one of those readings if
   * this scoping is removed.
   *
   * `AccountScopedDataSource` is the same move the retention producer already
   * makes (`PinnedInputDataSource` in
   * `lib/meta/account-profile-output-producer.ts`): the MEASURED reads name the
   * account, and the CONFIGURED ones — the target pack, the calibration profile
   * and the engine flags — stay at business level, because a target ROAS is one
   * commercial policy for the business rather than a per-account setting.
   *
   * WHICH ACCOUNT SCOPE, AND WHETHER THERE IS ONE TO USE, is decided by
   * `resolveAccountProfileMeasurementScope` below — the retention producer's
   * own function, over the retention producer's own probes. The wrapper is
   * built on the `providerAccountId` that decision says the measured READERS
   * must be given, which is not always the account the answer speaks for.
   * While the calibration pass has
   * written no per-account scope for ANY account of this business, the measured
   * reads are STILL this account's — either the pooled precomputed row, where
   * that row was provably computed from this account's rows and nothing else,
   * or this account's own runtime aggregate — and the response says which in
   * `system.commercialAnchor.measurementScope` and on both budget-evidence
   * panels. That state used to be answered from the business's pooled
   * population under a `business_pooled` label, and the label was not an
   * authority boundary: account A above was served `scale` ELIGIBLE off the
   * pooled 38 while its own six could not reach the floor, and the retention
   * producer agreed with it because it read the same pooled population.
   */
  const loadCommercialAnchorProfile = async (): Promise<{
    eligibility: HardActionEligibility | null;
    readFailed: boolean;
    /**
     * The population the measured reads drew from, and why — published with the
     * answer, and preserved even when a later read throws, so a failure does
     * not erase the scope that was already resolved. A request that names no
     * physical account gets the labelled business summary; `null` only when the
     * throw happened before the scope was resolved at all.
     */
    measurement: AccountProfileMeasurementScope | null;
  }> => {
    let measurement: AccountProfileMeasurementScope | null = null;
    try {
      /*
        WHICH POPULATION THIS ACCOUNT'S MEASURED FACTS MAY COME FROM, asked of
        the warehouse before anything is read.

        `resolveAccountProfileMeasurementScope` is the retention producer's own
        decision function, called here with the retention producer's own probes,
        so the panel and the retained row cannot reach different answers about
        the same account and day. It returns four things this path needs: the
        hold (if the state forces one), whose evidence the answer is, the
        parameter the measured readers must be given to reach it, and a sentence
        saying which state it saw.

        THE FOUR OUTCOMES.

        - This account has its own retained calibration scope. The reads are
          scoped to it, which is the whole point of the wrapper below.
        - No account of this business has one — the calibration pass has never
          written the per-account dimension here — AND the warehouse holds no
          row of this business belonging to any other ad account. The pooled
          `scope_id '*'` row was then computed by the same statement over
          exactly this account's rows, so it is read as this account's own
          measurement: same numbers as a scoped read would produce, fixed for
          the day, and with the funnel and by-kind packs a scoped read would
          have found empty.
        - No account of this business has one and the business DOES hold rows
          for more than this account. The reads name this account and fall
          through to its own runtime aggregate. That is a live reading and its
          identity moves when this account's sync writes, which is a cost this
          route accepts for one calibration cycle rather than serving a sibling
          account's evidence under this account's name.
        - Sibling accounts have scopes and this one does not, or the probe
          failed. Both hold — under two DIFFERENT names, because an account the
          pass skipped and a read that failed are different facts — and the
          producer refuses the identical case, so no retained row contradicts
          the panel.

        With no `providerAccountId` the request names no physical account, so
        there is nothing to scope to and nothing to contradict: no retained
        per-account verdict speaks for "the business", and `knownBindings` below
        is published empty for exactly that reason. That request keeps the
        business-wide reading it has always had, now labelled `business_pooled`
        so the reader can see that it is one.
      */
      const warehouse = new WarehouseDataSource();
      if (providerAccountId) {
        // A source that does not model the precomputed calibration table
        // has no answer to give, which is what `unprobed` means and what
        // the producer's own reader does with the same absence.
        const status = warehouse.readAccountScopeCalibrationMaterialisation
          ? await warehouse.readAccountScopeCalibrationMaterialisation({
              businessId,
              asOf: decisionAsOfDate,
              providerAccountId,
            })
          : "unprobed";
        measurement = resolveAccountProfileMeasurementScope({
          status,
          // The equivalence proof, asked only where it can change the answer —
          // the same condition the producer applies, so the two cannot reach
          // different bases for the same account and day.
          populationBreadth:
            status === "per_account_scopes_unwritten"
            && warehouse.readBusinessAccountPopulationBreadth
              ? await warehouse.readBusinessAccountPopulationBreadth({
                  businessId,
                  providerAccountId,
                })
              : "unprobed",
          providerAccountId,
          asOfDate: decisionAsOfDate,
        });
      } else {
        // No physical account was named, so this is the business's whole Meta
        // footprint and it is labelled as such rather than left unstated.
        measurement = businessPooledMeasurementScope({
          asOfDate: decisionAsOfDate,
        });
      }
      if (measurement.hold != null) {
        return { eligibility: null, readFailed: false, measurement };
      }
      /*
        One instance, so the pack that decides whether the store is consulted
        is the same pack the profile then resolves against.

        The wrapper is built on `readProviderAccountId` — the parameter the
        measured readers are to be called with — and not on the population's own
        id. They differ in exactly one state: the business's warehouse rows all
        belong to this account, so the pooled precomputed row IS this account's
        measurement and is read unwrapped. A business-wide request has no
        account to scope to and keeps the pooled reading it has always had.
      */
      const dataSource = measurement.readProviderAccountId
        ? new AccountScopedDataSource(
            warehouse,
            measurement.readProviderAccountId,
          )
        : warehouse;
      const targetPack = await dataSource
        .getBusinessTargetPack({ businessId, asOf: decisionAsOfDate })
        .catch(() => null);
      const profile = await resolveAccountDecisionProfile({
        businessId,
        asOf: decisionAsOfDate,
        dataSource,
        flags: await resolveEngineV3Flags(businessId),
        /*
          THE STORE'S OWN AVERAGE ORDER VALUE, which this call used to omit.

          `resolveAccountDecisionProfile` does no IO for this input by design:
          it takes the store evidence from its caller. Every OTHER caller
          supplies it — the retention producer resolves it
          (`readAccountProfileRetentionInputs` in
          `lib/meta/account-profile-output-producer.ts`) and the snapshot's own
          benchmark resolution does the same (the `observedAov` block in
          `lib/meta/snapshot.ts`) — and this one did not. The effect
          was not a missing detail: with no store evidence the ladder in
          `resolveSpendUnit` falls straight past the `observed_shopify_aov`
          rung to `insufficient`, so the panel served
          `status: "blocked_missing_owner_anchor"`,
          `missingInputs: ["target_cpa", "operator_aov_assumption"]` and three
          `commercial_anchor_missing` blockers on an account whose RETAINED
          `engine_v3_account_profile_output` rows carried a resolved spend unit
          of 26.36 (58.00 Shopify AOV ÷ 2.20 target ROAS) and cut/refresh
          eligible. Two contradictory commercial verdicts in one response, and
          the operator-facing half was the wrong one — it asked for a Target CPA
          and an AOV that this product's rules declare optional.

          The gate is the producer's, byte for byte: a configured target CPA or
          operator AOV assumption short-circuits the read, because those rungs
          come first in the ladder and the store is only consulted when neither
          exists. Nothing here converts a currency, and a currency with no ISO
          exponent yields no evidence.
        */
        observedShopifyAov: await resolveServeTimeObservedShopifyAov({
          businessId,
          providerAccountId,
          targetPack,
        }),
      });
      return {
        eligibility: profile.hardActionEligibility,
        readFailed: false,
        measurement,
      };
    } catch {
      return { eligibility: null, readFailed: true, measurement };
    }
  };
  // Resolving the profile is 12-15 sequential warehouse queries and is not
  // memoised anywhere, so it is cached per business/day exactly like the
  // decision read model, with the same in-test bypass so unit tests never
  // share state across cases.
  //
  // The account is part of the key because every measured read above is now
  // scoped to it and the store evidence is only admissible in the AD ACCOUNT'S
  // currency, so two accounts of one business legitimately resolve different
  // anchors. Keying without it would have served the first account's answer to
  // the second. The version is `v5` because the cached value's shape changed
  // again — `measurement` gained `basis` and `readProviderAccountId`, a
  // business-wide request now carries a labelled summary where it used to carry
  // `null`, and a named account can no longer answer `business_pooled` at all —
  // so a `v4` entry left in a warm process (the store hangs off `globalThis`
  // and survives a module reload) would publish a scope label this release
  // cannot produce.
  //
  // The 60s TTL is also what bounds how long a bootstrap answer outlives the
  // calibration run that ends it: both probes are part of the loader, so the
  // first read after the entry expires resolves the account's materialised
  // scope.
  const commercialAnchorProfilePromise =
    process.env.VITEST === "true" || process.env.NODE_ENV === "test"
      ? loadCommercialAnchorProfile()
      : getCachedValue({
          key: `meta-decisions-anchor-profile-v5:${businessId}:${providerAccountId ?? "none"}:${decisionAsOfDate}`,
          ttlMs: 60_000,
          staleWhileRevalidateMs: 240_000,
          loader: loadCommercialAnchorProfile,
        }).then((cached) => cached.value);
  let currentAdsCompletedAt = endDateResolvedAt;
  const currentAdsPromise = readCurrentMetaAds({
    businessId,
    providerAccountId,
  }).then((result) => {
    currentAdsCompletedAt = performance.now();
    return result;
  });
  let decisionReadCompletedAt = endDateResolvedAt;
  const decisionReadPromise = currentAdsPromise.then(async (currentAds) => {
    const loadDecisionRead = () =>
      canonicalDecisionReadModel({
        businessId,
        providerAccountId,
        adCandidateLimit,
        asOfDate: decisionAsOfDate,
        currentAds,
        activeOnly: compactOsSurface,
        generatedAt: requestGeneratedAt,
      });
    const decisionRead =
      process.env.VITEST === "true" || process.env.NODE_ENV === "test"
        ? await loadDecisionRead()
        : (
            await getCachedValue({
              key: `meta-decisions-read-v8:${businessId}:${providerAccountId ?? "none"}:${decisionAsOfDate}:${adCandidateLimit}:${compactOsSurface ? "active" : "full"}:${inputAdScopeKey(currentAds)}`,
              ttlMs: 60_000,
              staleWhileRevalidateMs: 240_000,
              loader: loadDecisionRead,
              // A transient schema/query timeout is useful fail-closed truth
              // for this request, but never the next five minutes of truth.
              shouldCache: (result) =>
                result.ok && result.model.status === "available",
            })
          ).value;
    decisionReadCompletedAt = performance.now();
    return decisionRead;
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
    const scopedRecommendations = [
      ...lanes.actionNow,
      ...lanes.watching,
      ...lanes.nonSales,
    ];
    const campaignContextIds = normalizeMetaDecisionCampaignContextIds({
      currentAds: (await currentAdsPromise).rows,
      structureCampaignIds: [
        ...scopedRecommendations.map((rec) => rec.campaignId),
        ...(lanes.structureInventory ?? []).map((row) => row.campaignId),
      ],
    });
    const loadCurrentCampaignContexts = () =>
      readCurrentCampaignContexts({
        businessId,
        providerAccountId,
        snapshotAsOf: decisionAsOfDate,
        campaignIds: campaignContextIds,
      });
    const currentCampaignContextsPromise =
      process.env.VITEST === "true" || process.env.NODE_ENV === "test"
        ? loadCurrentCampaignContexts()
        : getCachedValue({
            key: `meta-decisions-context-v1:${businessId}:${providerAccountId ?? "none"}:${decisionAsOfDate}:${metaDecisionCampaignContextScopeKey(campaignContextIds)}`,
            ttlMs: 60_000,
            staleWhileRevalidateMs: 240_000,
            loader: loadCurrentCampaignContexts,
          }).then((cached) => cached.value);
    const [
      currentAds,
      decisionRead,
      currentAdCampaignContexts,
      digest,
      commercialTargetRead,
      executionGovernance,
      operationalPipelineHealth,
      commercialAnchorProfile,
    ] = await Promise.all([
      currentAdsPromise,
      decisionReadPromise,
      currentCampaignContextsPromise,
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
      executionGovernancePromise,
      operationalPipelineHealthPromise,
      commercialAnchorProfilePromise,
    ]);
    const decisionBundleCompletedAt = performance.now();
    if (!decisionRead.ok) {
      return NextResponse.json(decisionRead.payload, {
        status: decisionRead.status,
      });
    }
    const pipelineHealth = buildMetaDecisionPipelineHealth({
      operational: operationalPipelineHealth,
      decisionReadModel: decisionRead.model,
      now: requestEvaluatedAt,
    });
    const decisionReadModel = applyMetaExecutionGovernanceToReadModel({
      model: decisionRead.model,
      governance: executionGovernance,
      pipeline: {
        verified: pipelineHealth.overall !== "unavailable",
        executionReady: pipelineHealth.executionReady,
      },
      now: requestEvaluatedAt,
    });
    /*
      WHICH POPULATION EVERY COMMERCIAL NUMBER BELOW WAS MEASURED FROM.

      Published beside the panels rather than folded into them, and published
      whether the answer is account-scoped or pooled — a label that only appears
      in the unusual case is a label nobody learns to read. `scope` is whose
      evidence it is and the fact a consumer branches on; `basis` is how that
      population was reached, which is what says whether the reading is fixed
      for the day; `why` is the sentence an operator reads; `materialisation` is
      the raw warehouse state behind them, and is `null` for a request that
      named no account, where no per-account scope question applies.

      `null` only when the profile read threw before the scope was resolved at
      all, in which case `profileSourceStatus` is `read_failed` and says so
      itself.
    */
    const measurementScope = commercialAnchorProfile.measurement;
    // Server-owned commercial-anchor explanation. The client renders this
    // object; it never derives eligibility, thresholds or campaign role. The
    // measurement scope is added HERE rather than inside the projector, which
    // is a pure function of the eligibility it is given and knows nothing about
    // where the warehouse read it from.
    const commercialAnchorPanel = {
      ...projectMetaCommercialAnchorPanel({
        eligibility: commercialAnchorProfile.eligibility,
        profileReadFailed: commercialAnchorProfile.readFailed,
        currency: pulse.currency ?? null,
        blockers: tallyAuthorityBlockers(
          collectCanonicalAuthorityBlockers(decisionReadModel),
        ),
      }),
      measurementScope,
    };
    /**
     * Server-owned budget-decision evidence, as TWO review-only directional
     * projections.
     *
     * This panel is account-scoped and no proposal direction has been selected,
     * so Correction 1's hardcoded `direction: "increase"` was asserting a
     * choice nobody made — and hid the fact that an increase depends on the
     * profile's `scale` verdict while a decrease depends on `cut`. The server
     * publishes both; the client renders them and derives nothing.
     */
    const budgetGateFacts = (direction: "increase" | "decrease") =>
      buildWorkspaceBudgetGateInput({
        direction,
        originMs: requestEvaluatedAt.getTime(),
        // Per-action truth, carried verbatim. `refresh` travels for display and
        // is never consulted for a budget direction.
        profile:
          commercialAnchorProfile.readFailed ||
          !commercialAnchorProfile.eligibility
            ? null
            : {
                byAction: {
                  scale: {
                    eligible: commercialAnchorProfile.eligibility.scale,
                    code:
                      commercialAnchorProfile.eligibility.codes?.scale ?? null,
                    reason:
                      commercialAnchorProfile.eligibility.reasons?.scale ??
                      commercialAnchorProfile.eligibility.reason ??
                      null,
                  },
                  cut: {
                    eligible: commercialAnchorProfile.eligibility.cut,
                    code:
                      commercialAnchorProfile.eligibility.codes?.cut ?? null,
                    reason:
                      commercialAnchorProfile.eligibility.reasons?.cut ??
                      commercialAnchorProfile.eligibility.reason ??
                      null,
                  },
                  refresh: {
                    eligible: commercialAnchorProfile.eligibility.refresh,
                    code:
                      commercialAnchorProfile.eligibility.codes?.refresh ??
                      null,
                    reason:
                      commercialAnchorProfile.eligibility.reasons?.refresh ??
                      commercialAnchorProfile.eligibility.reason ??
                      null,
                  },
                },
                // The whole explanation, not a single field of it.
                anchorExplanation:
                  (commercialAnchorProfile.eligibility
                    .anchor as unknown as Record<string, unknown> | null) ??
                  null,
                contractVersion: ACCOUNT_DECISION_PROFILE_CONTRACT,
              },
        // Stated, not inferred: a read that succeeded but produced no
        // eligibility output is NOT a read failure.
        profileSourceStatus: commercialAnchorProfile.readFailed
          ? ("read_failed" as const)
          : commercialAnchorProfile.eligibility
            ? ("resolved" as const)
            : ("output_not_retained" as const),
        /*
          The reason, with the retention path's own hold code in it when that is
          what happened — and with the sentence that hold's own resolver wrote.

          `output_not_retained` is exactly right for the hold: the producer
          refuses to retain any verdict for this account and day under the same
          code, so there is no output to serve. Naming it here is what keeps the
          answer a HOLD WITH A NAME rather than an unexplained absence — the
          operator reads it on the budget evidence panel as
          `commercialLineage.availability.reason`.

          The sentence comes from `resolveAccountProfileMeasurementScope` rather
          than being written here, so an account the pass SKIPPED and a probe
          that FAILED cannot read the same. The previous wording asserted "this
          ad account has no retained calibration scope of its own" under both
          codes, which was simply untrue of the unreadable one: a failed probe
          establishes nothing about what the warehouse holds.
        */
        profileUnavailableWhy: commercialAnchorProfile.readFailed
          ? "the account decision profile read failed"
          : commercialAnchorProfile.eligibility
            ? null
            : commercialAnchorProfile.measurement?.hold != null
              ? `${commercialAnchorProfile.measurement.hold}: ${commercialAnchorProfile.measurement.why}`
              : "the account decision profile read succeeded but retained no hardActionEligibility output",
        commercialTarget: commercialTargetRead.readFailed
          ? null
          : {
              // `updatedAt` is `effective_at` (aliased in the pack read), so it
              // is the EFFECTIVE clock and only that. The recorded clock is not
              // exposed through this read, so the point-in-time knowable
              // instant — max(effective, recorded) — is not computable here and
              // stays null rather than borrowing the effective one.
              effectiveAtMs:
                commercialTargetRead.targets?.updatedAt != null
                  ? Date.parse(commercialTargetRead.targets.updatedAt)
                  : null,
              pitKnowableAtMs: null,
              // This read carries no cost basis, so nothing here can reconcile
              // a break-even. False is measured, not assumed.
              economicallyReconciled: false,
            },
        // A budget decision is scoped to an entity whose automatic role this
        // route has not resolved.
        roleResolved: false,
        // D081 found no observed provider budget-write compatibility fact.
        providerCompatibilityKnown: false,
        automationEnabled: false,
        // This route reads NO change history. Saying so is what stops the
        // cooldown, the four caps and the concentration control from clearing
        // on an absence.
        changeHistory: {
          readState: "not_attempted",
          readStateWhy:
            "the decisions workspace performs no recent-change history read, so no cooldown, cap or concentration control can be evaluated here",
          lastChangeAtMs: null,
          changesForEntityToday: null,
          changesInAccountToday: null,
          changesInBusinessToday: null,
          changesInFleetToday: null,
          accountChangesToday: null,
          fleetChangesToday: null,
          countSemantics: "prospective_including_candidate",
        },
        knownBindings: providerAccountId
          ? [{ businessId, providerAccountId }]
          : [],
      });
    const budgetEvidenceByDirection = {
      contractVersion: "meta-budget-decision-evidence-directional.v3" as const,
      directionSelected: null,
      directionSelectedWhy:
        "this panel is account-scoped and no proposal direction has been selected; both directions are published for review and neither is proposed",
      // The server owns this mapping; the client renders it and derives nothing.
      directionToAction: { increase: "scale", decrease: "cut" } as const,
      directionToActionWhy:
        "an increase is a scale decision and a decrease is a cut decision; refresh is a creative action and is never a budget-direction substitute",
      // The same label the anchor panel carries, on each direction, because a
      // budget increase is authorised from these numbers and the operator has
      // to be able to see that they are the business's pooled reading while
      // that is what they are.
      measurementScope,
      increase: {
        ...projectBudgetDecisionEvidencePanel({
          verdict: evaluateBudgetDecisionGates(budgetGateFacts("increase")),
          counterfactualLabel: null,
        }),
        measurementScope,
      },
      decrease: {
        ...projectBudgetDecisionEvidencePanel({
          verdict: evaluateBudgetDecisionGates(budgetGateFacts("decrease")),
          counterfactualLabel: null,
        }),
        measurementScope,
      },
    };
    /*
      D085 — the account-scoped budget dry run.

      This panel is account-scoped, so no concrete entity or direction is
      selected and the dry run is honestly blocked on exactly that, plus every
      other requirement the server can actually evaluate. The surface derives
      nothing: `buildBudgetProposalDryRun` owns every gate and every sentence.
    */
    // The governance read carries no persisted timestamp, so the request's own
    // server-owned instant is the honest as-of for it.
    const nowIso = new Date().toISOString();
    // The entrypoint now accepts `unknown` so it can be TOTAL at runtime, so
    // the ceremony type is taken from the input contract directly rather than
    // from the parameter position.
    const dryRunWriteSafety: DryRunInput["writeSafety"] = {};
    for (const step of WRITE_SAFETY_STEPS) dryRunWriteSafety[step] = "missing";
    dryRunWriteSafety.exact_business_access = "satisfied";
    dryRunWriteSafety.exact_physical_provider_account = providerAccountId
      ? "satisfied"
      : "missing";
    dryRunWriteSafety.explicit_action_origin = "satisfied";

    const budgetDryRun = buildBudgetProposalDryRun({
      contractVersion: META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
      decision: {
        id: null,
        hash: null,
        version: null,
        decidedAt: null,
        maxAgeSeconds: 86_400,
      },
      scope: {
        businessId,
        business: businessId,
        providerAccountId: providerAccountId ?? "",
        entityGrain: null,
        entityId: null,
        parentCampaignId: null,
        accountIsWriteScope: Boolean(providerAccountId),
        accountSelectionWhy: providerAccountId
          ? "the selected serving account for this business"
          : "no provider account is selected, so nothing is in write scope",
      },
      direction: null,
      percent: null,
      accountCurrency: null,
      currencyExponent: null,
      currencyRegistryVersion: null,
      unitConfidence: "unknown",
      role: {
        role: null,
        source: null,
        resolverVersion: null,
        confidence: null,
        asOf: null,
        accountScoped: true,
        businessId,
        providerAccountId: providerAccountId ?? null,
        resolved: false,
        why: "automatic role authority has no retained qualifying rows; unresolved stays unresolved",
      },
      budgetFact: {
        contractVersion: "meta.budget-fact.v4",
        available: false,
        currentMinorUnits: null,
        budgetField: null,
        ownerMode: "unknown",
        scheduleStart: null,
        scheduleEnd: null,
        observedAt: null,
        capturedAt: null,
        lineage:
          "the canonical budget-fact contract is defined; its additive columns are not applied in production",
        availabilityWhy:
          "no canonical budget fact is resolved for an account-scoped panel: no concrete entity is selected",
      },
      commercial: {
        profileContractVersion: "adsecute.account-decision-profile.v1",
        businessId,
        providerAccountId: providerAccountId ?? null,
        sourceStatus: commercialTargetRead.readFailed
          ? "read_failed"
          : "output_not_retained",
        selectedAction: null,
        eligible: null,
        code: null,
        reason: null,
        blockerCodes: [],
        evidenceFloorsClear: null,
        changeSafetyClear: null,
      },
      safety: {
        /*
          Real server-owned evidence, not a hardcoded `false`.

          The first pass wrote `false` for all five controls even though this
          same handler already held the governance read, the pipeline-health
          admission decision and an explicit `changeHistory.readState`. A
          control nobody read cannot clear a proposal, so the three this route
          does not read stay `unknown` and block as unverified.
        */
        /*
          Governance READINESS is modelled separately from the kill switch.

          r2 mapped `killSwitchEngaged === false` straight to `clear` while
          ignoring `verified` and `controlsConfigured`, so an unread governance
          state was presented as a proved-clear kill switch. A control nobody
          could verify proves nothing in either direction.
        */
        killSwitch: governanceToKillSwitchFlag({
          killSwitchEngaged: executionGovernance.killSwitchEngaged,
          killSwitchReason: executionGovernance.killSwitchReason,
          verified: executionGovernance.verified,
          controlsConfigured: executionGovernance.controlsConfigured,
          writeBlocked: executionGovernance.writeBlocked,
          blockReason: executionGovernance.blockReason,
          evaluatedAt: nowIso,
        }),
        admission: admissionToSafetyFlag({
          status: pipelineHealth.admission.status,
          allowed: pipelineHealth.admission.allowed,
          reason: pipelineHealth.admission.reason,
          evaluatedAt: pipelineHealth.admission.evaluatedAt,
          serverEvaluatedAt: nowIso,
        }),
        // This route performs no recent-change history read, so the three
        // history-derived controls are unverified — never clear.
        cap: unknownSafetyFlag(
          "the decisions workspace performs no recent-change history read, so no per-day cap can be evaluated here",
        ),
        cooldown: unknownSafetyFlag(
          "the decisions workspace performs no recent-change history read, so no cooldown window can be evaluated here",
        ),
        conflict: unknownSafetyFlag(
          "the decisions workspace acquires no claim and reads no conflict lock, so lock state is unverified here",
        ),
      },
      capability: PROVIDER_CAPABILITY_TODAY,
      rawIntent: null,
      knownBindings: [],
      intent: null,
      intentRejections: ["current_value_missing"],
      casBaseline: null,
      preflight: null,
      preflightEvidence: null,
      writeSafety: dryRunWriteSafety,
      originDate: new Date().toISOString().slice(0, 10),
      knowledgeAsOf: new Date().toISOString(),
    });

    const budgetDryRunPanel = projectBudgetDryRunPanel({
      dryRun: budgetDryRun,
      observedFacts: [
        { label: "Business", value: businessId },
        {
          label: "Provider account",
          value: providerAccountId ?? "none selected",
        },
        {
          label: "Entity",
          value: "none selected — this panel is account-scoped",
        },
        /*
          PRE-DEPLOY AUDIT: the `Automation: off` row was a constant served
          inside a section captioned as observed facts. It stayed "off" after
          an admin enabled automatic execution, so the one row an operator
          would most want to trust was the only one that was not measured.
          This route performs no control-plane read, so the honest fix is to
          stop asserting the posture here; the Automation surface owns it and
          measures it.
        */
      ],
      writeSafetyMissing: WRITE_SAFETY_STEPS.filter(
        (s) => dryRunWriteSafety[s] === "missing",
      ),
    });

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
    // D078 R4: server-owned account-coverage evidence. Fail-closed: an
    // unreadable states read serves null (rendered unavailable), never an
    // invented single-account list.
    const assignedAccountStates = await readMetaAssignedAccountStates(
      pulse.businessId,
    )
      .then((states) =>
        states.map((state) => ({
          providerAccountId: state.providerAccountId,
          accountName: state.accountName,
          selectionState: state.selectionState,
          accountCurrency: state.accountCurrency,
          accountTimezone: state.accountTimezone,
          latestFactDate: state.latestFactDate,
          spend14d: state.spend14d,
          latestDecisionAsOf: state.latestDecisionAsOf,
          latestDecisionRows: state.latestDecisionRows,
          latestDecisionAuthorizedRows: state.latestDecisionAuthorizedRows,
          policy: describeAccountStatePolicy(state),
        })),
      )
      .catch(() => null);

    const payload: MetaDecisionsWorkspacePayload & {
      decisionReadModel: MetaDecisionsWorkspaceReadModel;
    } = {
      assignedAccountStates,
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
        killSwitchEngaged: executionGovernance.killSwitchEngaged,
        killSwitchReason: executionGovernance.killSwitchReason,
        governanceVerified: executionGovernance.verified,
        businessControlsConfigured: executionGovernance.controlsConfigured,
        executionGovernanceState: executionGovernance.killSwitchEngaged
          ? "kill_switched"
          : executionGovernance.verified &&
              executionGovernance.controlsConfigured &&
              !executionGovernance.writeBlocked
            ? "ready_for_live_preflight"
            : "unavailable",
        executionGovernanceReason: executionGovernance.blockReason,
        pipelineHealth,
        commercialAnchor: commercialAnchorPanel,
        budgetEvidence: budgetEvidenceByDirection,
        budgetDryRun: budgetDryRunPanel,
      },
      viewer,
      banners: workspaceBanners({
        pulse,
        lanes: servedLanes,
        trackingBlocked,
        executionGovernance,
        viewer,
        commercialTargets: commercialTargetRead.targets,
        commercialTargetsReadFailed: commercialTargetRead.readFailed,
        decisionReadModel,
        pipelineHealth,
      }),
      digest: digest ?? {
        snapshotDate: servedLanes.snapshotDate,
        unavailableReason: "not_requested_for_compact_surface",
        labelFlips: { count: 0, publishedCount: 0, items: [] },
        actions: {
          verifiedCount: 0,
          silentFailureCount: 0,
          countedRowCap: META_ACTION_DIGEST_ROW_CAP,
          countsTruncated: false,
          items: [],
        },
        anomalies: { openedCount: 0, items: [] },
        deferrals: { dueCount: 0, items: [] },
      },
      decisionReadModel,
      /**
       * The §9 envelope, decided here and sent with the rows.
       *
       * The Decision Center reads this workspace in the browser, so the page
       * that rendered it can only state what it knew before the fetch.
       * Everything that separates `success` from `empty-proven`, `partial` and
       * `degraded` is known only at this point, and it is decided by the same
       * pure resolver the page calls — the two halves cannot disagree about
       * what a state means. The client forwards this verbatim.
       */
      readState: resolveMetaSurfaceReadState({
        businessId: pulse.businessId,
        providerAccountId,
        requiresProviderAccount: true,
        permissions: {
          role: viewer?.role ?? null,
          reviewerReadOnly: viewer?.isReviewer === true,
          demo: false,
        },
        capability: { canRead: true, canWrite: viewer?.readOnly !== true },
        sources: decisionsWorkspaceSources({
          decisionStatus: decisionReadModel.status,
          decisionUnavailableCode: decisionReadModel.unavailable?.code ?? null,
          laneRowCount:
            servedLanes.actionNow.length +
            servedLanes.watching.length +
            servedLanes.nonSales.length,
          currentAdsComplete: currentAds.complete,
          currentAdRowCount: currentAds.rows.length,
          commercialTargetsReadFailed: commercialTargetRead.readFailed,
        }),
        evidence: {
          window: { startDate: pulse.startDate, endDate: pulse.endDate },
          snapshotAt: servedLanes.snapshotCreatedAt ?? null,
          observedAt: pulse.lastSyncAt ?? null,
          // Optional on purpose: the read model's `source` block is absent in
          // the unavailable arm, and reaching through it there turned a
          // degraded decision read into a 500 for the whole workspace.
          decisionAsOf: decisionReadModel.source?.snapshotAsOf ?? null,
        },
      }),
      os: buildMetaOsDecisionsPresentation({
        actionNow: servedLanes.actionNow,
        watching: servedLanes.watching,
        nonSales: servedLanes.nonSales,
        structureInventory: servedLanes.structureInventory,
        inactiveStructure: servedLanes.archive,
        decisionReadModel,
        currentAds: currentAds.complete ? currentAds.rows : [],
        currentAdCampaignContexts,
        currency: pulse.currency ?? null,
        targetHardActionEligibility,
        pipelineHealth,
      }),
    };
    const responseReadyAt = performance.now();
    const workspaceTimings = {
      resolveEndDateMs: endDateResolvedAt - requestStartedAt,
      upstreamsMs: upstreamsCompletedAt - endDateResolvedAt,
      currentAdsMs: currentAdsCompletedAt - endDateResolvedAt,
      decisionReadMs: decisionReadCompletedAt - endDateResolvedAt,
      decisionBundleMs: decisionBundleCompletedAt - upstreamsCompletedAt,
      responseBuildMs: responseReadyAt - decisionBundleCompletedAt,
      totalMs: responseReadyAt - requestStartedAt,
    };
    const serverTiming = [
      `resolve_end_date;dur=${workspaceTimings.resolveEndDateMs.toFixed(1)}`,
      `upstreams;dur=${workspaceTimings.upstreamsMs.toFixed(1)}`,
      `current_ads;dur=${workspaceTimings.currentAdsMs.toFixed(1)}`,
      `decision_read;dur=${workspaceTimings.decisionReadMs.toFixed(1)}`,
      `decision_bundle;dur=${workspaceTimings.decisionBundleMs.toFixed(1)}`,
      `response_build;dur=${workspaceTimings.responseBuildMs.toFixed(1)}`,
      `total;dur=${workspaceTimings.totalMs.toFixed(1)}`,
    ].join(", ");
    if (workspaceTimings.totalMs >= 5_000) {
      const diagnostics = getDbRuntimeDiagnostics();
      logRuntimeWarn("meta_decisions", "slow_workspace_read", {
        ...Object.fromEntries(
          Object.entries(workspaceTimings).map(([key, value]) => [
            key,
            Number(value.toFixed(1)),
          ]),
        ),
        adCandidateLimit,
        compactOsSurface,
        dbPool: diagnostics.pool,
        dbCounters: diagnostics.counters,
      });
    }
    if (compactOsSurface) {
      const compactPayload: MetaDecisionsOsWorkspacePayload = {
        businessId: payload.businessId,
        window: payload.window,
        statusFilter: payload.statusFilter,
        startDate: payload.startDate,
        endDate: payload.endDate,
        // Forwarded, not recomputed: the pulse was already loaded above, and
        // the Decision Center header reports these directly.
        pulse: {
          lastSyncAt: payload.pulse.lastSyncAt ?? null,
          pacing: payload.pulse.pacing,
          roas: payload.pulse.roas,
          roasHistory: payload.pulse.roasHistory,
          operatingMode: payload.pulse.operatingMode,
          seasonalRegime: payload.pulse.seasonalRegime,
          trackingHealth: payload.pulse.trackingHealth,
          campaignRoleCoverage: payload.pulse.campaignRoleCoverage ?? null,
        },
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
          "Server-Timing": serverTiming,
        },
      });
    }
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "private, max-age=0",
        "Server-Timing": serverTiming,
      },
    });
  } catch (error) {
    if (error instanceof UpstreamError) {
      return NextResponse.json(
        {
          error: "upstream_failed",
          source: error.source,
          detail: error.payload,
          message: `The ${error.source} decision source could not be read. Check backend connectivity, then retry.`,
        },
        { status: error.status },
      );
    }
    const detail =
      error instanceof Error
        ? error.message
        : "Failed to build Meta decisions workspace.";
    return NextResponse.json(
      {
        error: detail,
        message:
          "The Meta decision workspace could not be assembled from its backend sources. Check backend connectivity, then retry.",
      },
      { status: 500 },
    );
  }
}
