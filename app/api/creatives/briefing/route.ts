import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoMetaCreatives } from "@/lib/demo-business";
import {
  decideCreative,
  resolveAccountDecisionProfile,
  type CreativeInput,
  type DecisionBadge,
  type DecisionLabel,
  type DecisionOutput,
} from "@/lib/creative-decision-engine";
import {
  applyCreativeCampaignLabelGuard,
  buildCreativeCampaignLabelMap,
  withCreativeCampaignLabelContext,
} from "@/lib/creative-decision-engine/campaign-label-guard";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { resolveDataSource } from "@/app/api/creatives/decision-engine-v3/data-source";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import {
  isInBriefing,
  parseBriefingStatusFilter,
} from "@/lib/meta/briefing-filter";
import { nDaysAgo, toISODate } from "@/lib/meta/creatives-row-mappers";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import { readTriageState } from "@/lib/triage-events";
import { CREATIVE_DECISION_ENGINE_CONFIG_VERSION } from "@/lib/creative-decision-engine/config-values";
import {
  adaptCreativeDecisionsToRows,
  assembleDecisionCenterSnapshot,
  auditDecisionCenterSnapshotInvariants,
  buildDecisionCenterObservabilityEvents,
  buildDecisionCenterAggregateDecisions,
  CREATIVE_DECISION_CENTER_ADAPTER_VERSION,
  CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION,
  DECISION_CENTER_OBSERVABILITY_LOG_MARKER,
  bridgeV3DecisionToAdapterInput,
  validateDecisionCenterSnapshot,
  type CreativeDecisionCenterAggregateDecision,
  type CreativeDecisionCenterRowDecision,
  type CreativeDecisionCenterFreshnessStatus,
  type DecisionCenterSnapshot,
} from "@/lib/creative-decision-center";
import type {
  BriefingCreativeCard,
  CreativesBriefingResponse,
} from "@/components/creatives/briefing/types";
import type { MetaAutomationReadiness } from "@/lib/meta/automation-readiness";

export const dynamic = "force-dynamic";

type BriefingLane = "action" | "watching" | "healthy";

const DECISION_CENTER_OBSERVABILITY_ROUTE = "GET /api/creatives/briefing";
const LOCAL_DECISION_CENTER_OBSERVABILITY_SALT =
  "creative-decision-center.observability.v1.local-default";

function creativeReadOnlyAutomationReadiness(
  decision: DecisionOutput,
): MetaAutomationReadiness {
  return {
    contractVersion: "meta-automation-readiness.v1",
    tier: "read_only",
    autoExecuteEligible: false,
    operatorReviewRequired: true,
    decisionLabel: decision.label as MetaAutomationReadiness["decisionLabel"],
    blockers: [
      "no_empirical_outcome_model",
      "missing_live_preflight",
      "missing_rollback_plan",
    ],
    missingEvidence: [
      "creative_empirical_outcome_model",
      "creative_live_preflight",
      "creative_rollback_plan",
    ],
    requiredEvidence: [
      "creative_empirical_outcome_model",
      "creative_live_preflight",
      "creative_rollback_plan",
    ],
    reason: "Creative-side automation evidence not yet implemented.",
  };
}

type DecisionCenterParamState = "truthy" | "falsy" | "unset";

function decisionCenterParamState(
  value: string | null,
): DecisionCenterParamState {
  if (value == null) return "unset";
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return "truthy";
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "off" ||
    normalized === "no"
  ) {
    return "falsy";
  }
  return "unset";
}

function resolveDecisionCenterParamState(
  searchParams: URLSearchParams,
): DecisionCenterParamState {
  const camel = decisionCenterParamState(searchParams.get("decisionCenter"));
  if (camel !== "unset") return camel;
  return decisionCenterParamState(searchParams.get("decision_center"));
}

function isDecisionCenterExplicitlyRequested(
  searchParams: URLSearchParams,
): boolean {
  return resolveDecisionCenterParamState(searchParams) === "truthy";
}

function isDecisionCenterDefaultDisabled(): boolean {
  const normalized = process.env.DECISION_CENTER_DEFAULT_DISABLED?.trim()
    .toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "enabled"
  );
}

/**
 * D027: response-inclusion gate only. This does not control resolver execution
 * or decision semantics; it controls whether the already computed
 * `decisionCenter` snapshot is serialized into the briefing response.
 */
function shouldIncludeDecisionCenter(searchParams: URLSearchParams): boolean {
  const explicit = resolveDecisionCenterParamState(searchParams);
  if (explicit === "truthy") return true;
  if (explicit === "falsy") return false;
  return !isDecisionCenterDefaultDisabled();
}

function isDecisionCenterObservabilityEnabled(): boolean {
  const value = process.env.DECISION_CENTER_OBSERVABILITY;
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "enabled"
  );
}

function hashDecisionCenterObservabilityId(
  kind: "business" | "account" | "snapshot",
  value: string | null | undefined,
): string | null {
  const text = value?.trim();
  if (!text) return null;
  const envSalt = process.env.DECISION_CENTER_OBSERVABILITY_SALT?.trim();
  const salt = envSalt || LOCAL_DECISION_CENTER_OBSERVABILITY_SALT;
  const saltState = envSalt ? "salted" : "unsalted";
  const digest = createHash("sha256")
    .update(`${salt}:${kind}:${text}`)
    .digest("hex")
    .slice(0, 24);
  return `${saltState}:${kind}:${digest}`;
}

function emitDecisionCenterObservability(input: {
  decisionCenterRequested: boolean;
  snapshot: DecisionCenterSnapshot | null;
  businessId: string;
  creativeRows: MetaCreativeApiRow[];
}) {
  if (!input.decisionCenterRequested || !isDecisionCenterObservabilityEnabled()) {
    return;
  }
  if (!input.snapshot) return;

  try {
    const businessIdHash = hashDecisionCenterObservabilityId(
      "business",
      input.businessId,
    );
    if (!businessIdHash) return;
    const accountIdHashes = Array.from(
      new Set(
        input.creativeRows
          .map((row) =>
            hashDecisionCenterObservabilityId("account", row.account_id),
          )
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort((left, right) => left.localeCompare(right));
    const snapshotId =
      hashDecisionCenterObservabilityId(
        "snapshot",
        [
          input.businessId,
          input.snapshot.generatedAt,
          input.snapshot.engineVersion,
          input.snapshot.adapterVersion,
        ].join(":"),
      ) ?? "unsalted:snapshot:unknown";
    const events = buildDecisionCenterObservabilityEvents({
      snapshot: input.snapshot,
      businessIdHash,
      accountIdHashes,
      snapshotId,
      route: DECISION_CENTER_OBSERVABILITY_ROUTE,
      decisionCenterRequested: input.decisionCenterRequested,
    });
    for (const event of events) {
      console.info(
        DECISION_CENTER_OBSERVABILITY_LOG_MARKER,
        JSON.stringify(event),
      );
    }
  } catch {
    // Passive telemetry must never affect the briefing response.
  }
}

/**
 * Assemble a validated `DecisionCenterSnapshot` for the additive response
 * shape. The snapshot is now part of the production-default response surface;
 * callers can still opt out with `?decisionCenter=0` for rollback/debugging.
 */
function buildDecisionCenterSnapshot(input: {
  asOf: string;
  engineVersion: string;
  adapterVersion?: string;
  dataHealthDegraded: boolean;
  rowDecisions?: CreativeDecisionCenterRowDecision[];
  aggregateDecisions?: CreativeDecisionCenterAggregateDecision[];
}): DecisionCenterSnapshot | null {
  const dataFreshnessStatus: CreativeDecisionCenterFreshnessStatus =
    input.dataHealthDegraded ? "stale" : "fresh";
  const generatedAtDate = new Date(`${input.asOf}T00:00:00.000Z`);
  if (!Number.isFinite(generatedAtDate.getTime())) return null;
  const generatedAt = generatedAtDate.toISOString();
  const { snapshot } = assembleDecisionCenterSnapshot({
    engineVersion: input.engineVersion,
    adapterVersion: input.adapterVersion ?? CREATIVE_DECISION_CENTER_ADAPTER_VERSION,
    configVersion: CREATIVE_DECISION_ENGINE_CONFIG_VERSION,
    generatedAt,
    dataFreshness: { status: dataFreshnessStatus, maxAgeHours: null },
    rowDecisions: input.rowDecisions ?? [],
    aggregateDecisions: input.aggregateDecisions ?? [],
  });
  const validation = validateDecisionCenterSnapshot(snapshot);
  if (!validation.ok) return null;
  if (auditDecisionCenterSnapshotInvariants(snapshot).length > 0) return null;
  return snapshot;
}

const DECISION_CENTER_BRIDGED_ADAPTER_VERSION =
  `${CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION}+${CREATIVE_DECISION_CENTER_ADAPTER_VERSION}`;

function badgeLabels(badges: DecisionBadge[]) {
  return badges.flatMap((badge) => {
    if (badge.type === "below_breakeven") return ["below_breakeven"];
    if (badge.type === "fatigue_watch" || badge.type === "fatigue_fatigued")
      return ["fatigue"];
    if (badge.type === "unlabeled_campaign_context")
      return ["unlabeled_campaign_context"];
    if (badge.type === "scale_readiness_blocked")
      return ["scale_readiness_blocked"];
    if (badge.type === "scale_calibration_thin")
      return ["scale_calibration_thin"];
    return [];
  });
}

function primaryActionForDecision(decision: DecisionOutput): {
  kind: string;
  label: string;
} {
  if (decision.label === "cut") return { kind: "cut", label: "Cut" };
  if (decision.label === "scale") {
    if (decision.campaignKind === "test") {
      return { kind: "promote", label: "Promote to main" };
    }
    if (decision.campaignKind === "main") {
      return { kind: "scale_budget", label: "Scale budget" };
    }
    if (decision.campaignKind === "mixed") {
      return { kind: "controlled_scale", label: "Review structure & scale" };
    }
    return { kind: "review", label: "Label campaign before scaling" };
  }
  if (decision.label === "refresh")
    return { kind: "fresh_test", label: "Launch fresh test" };
  if (decision.label === "test_more")
    return { kind: "fresh_test", label: "Launch new test" };
  if (decision.label === "diagnose")
    return { kind: "review", label: "Open evidence" };
  return { kind: "review", label: "Review" };
}

function safeNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function previewForRow(row: MetaCreativeApiRow | null | undefined) {
  const source =
    row?.preview && typeof row.preview === "object" && !Array.isArray(row.preview)
      ? (row.preview as unknown as Record<string, unknown>)
      : null;
  const image =
    safeString(source?.image_url) ??
    safeString(source?.poster_url) ??
    safeString(row?.card_preview_url) ??
    safeString(row?.image_url) ??
    safeString(row?.preview_url) ??
    safeString(row?.cached_thumbnail_url) ??
    safeString(row?.thumbnail_url) ??
    safeString(row?.table_thumbnail_url);
  const video = safeString(source?.video_url);
  return {
    render_mode: video ? ("video" as const) : image ? ("image" as const) : ("unavailable" as const),
    image_url: image,
    video_url: video,
    poster_url:
      safeString(source?.poster_url) ??
      safeString(row?.table_thumbnail_url) ??
      safeString(row?.cached_thumbnail_url) ??
      safeString(row?.thumbnail_url) ??
      image,
    source: safeString(source?.source) ?? (image ? "briefing_row" : null),
    is_catalog: Boolean(row?.is_catalog ?? source?.is_catalog),
  };
}

function decisionLane(
  decision: DecisionOutput,
  deferred: boolean,
): BriefingLane {
  if (deferred) return "watching";
  if (
    decision.label === "keep" &&
    decision.badges.some((badge) => badge.type === "scale_readiness_blocked")
  ) {
    return "watching";
  }
  if (decision.label === "keep") return "healthy";
  if (
    decision.confidence >= 70 &&
    (decision.label === "scale" ||
      decision.label === "cut" ||
      decision.label === "refresh")
  ) {
    return "action";
  }
  return "watching";
}

function rowForDecision(
  decision: DecisionOutput,
  input: CreativeInput | undefined,
  creativeRowsById: Map<string, MetaCreativeApiRow>,
): MetaCreativeApiRow | null {
  return (
    creativeRowsById.get(decision.creativeId) ??
    (input?.creativeId ? creativeRowsById.get(input.creativeId) : undefined) ??
    null
  );
}

function buildDecisionCenterRows(input: {
  decisions: DecisionOutput[];
  inputsByCreativeId: Map<string, CreativeInput>;
  creativeRowsById: Map<string, MetaCreativeApiRow>;
  dataHealthDegraded: boolean;
}): CreativeDecisionCenterRowDecision[] {
  const adapterInputs = input.decisions.flatMap((decision) => {
    const creativeInput = input.inputsByCreativeId.get(decision.creativeId);
    const row = rowForDecision(
      decision,
      creativeInput,
      input.creativeRowsById,
    );
    const adapterInput = bridgeV3DecisionToAdapterInput({
      decision,
      context: {
        creativeId: decision.creativeId,
        rowId: row?.id,
        identityGrain: "creative",
        familyId: null,
        campaignKind: decision.campaignKind ?? creativeInput?.campaignKind ?? null,
        dataHealthDegraded: input.dataHealthDegraded,
      },
    });
    return adapterInput ? [adapterInput] : [];
  });

  return adaptCreativeDecisionsToRows(adapterInputs).map((result) => result.row);
}

function buildBridgedDecisionCenterSnapshot(input: {
  asOf: string;
  engineVersion: string;
  decisions: DecisionOutput[];
  inputsByCreativeId: Map<string, CreativeInput>;
  creativeRowsById: Map<string, MetaCreativeApiRow>;
  dataHealthDegraded: boolean;
}): DecisionCenterSnapshot | null {
  try {
    const rowDecisions = buildDecisionCenterRows({
      decisions: input.decisions,
      inputsByCreativeId: input.inputsByCreativeId,
      creativeRowsById: input.creativeRowsById,
      dataHealthDegraded: input.dataHealthDegraded,
    });
    const { aggregateDecisions } = buildDecisionCenterAggregateDecisions({
      candidates: [],
    });
    return buildDecisionCenterSnapshot({
      asOf: input.asOf,
      engineVersion: input.engineVersion,
      adapterVersion: DECISION_CENTER_BRIDGED_ADAPTER_VERSION,
      dataHealthDegraded: input.dataHealthDegraded,
      rowDecisions,
      aggregateDecisions,
    });
  } catch {
    return null;
  }
}

function cardForDecision(input: {
  decision: DecisionOutput;
  creativeInput?: CreativeInput;
  row?: MetaCreativeApiRow | null;
  sourceAsOf?: string | null;
  sourceDataSource?: string | null;
  profileScope?: string | null;
}): BriefingCreativeCard {
  const { decision, creativeInput, row } = input;
  const label = decision.label as DecisionLabel;
  const name =
    row?.name ||
    decision.creativeName ||
    creativeInput?.creativeName ||
    decision.creativeId;
  const spend = safeNumber(row?.spend ?? decision.metrics.spend);
  const purchases = safeNumber(row?.purchases ?? decision.metrics.purchases);
  const roas = row?.roas ?? decision.metrics.roas ?? 0;
  const ctr = row?.ctr_all ?? creativeInput?.ctr ?? null;
  const recentRoas = decision.metrics.recent7dRoas ?? roas;

  return {
    id: row?.id || decision.creativeId,
    creativeId: decision.creativeId,
    adId: row?.real_ad_id ?? row?.id ?? null,
    realAdId: row?.real_ad_id ?? null,
    accountId: row?.account_id ?? null,
    providerAccountId: row?.account_id ?? null,
    campaign:
      row?.campaign_name ??
      row?.campaign_id ??
      creativeInput?.campaignId ??
      null,
    campaignName: row?.campaign_name ?? null,
    adset: row?.adset_name ?? row?.adset_id ?? null,
    adsetName: row?.adset_name ?? null,
    name,
    creativeName: name,
    brand: row?.account_name ?? "Meta",
    label,
    badges: badgeLabels(decision.badges),
    confidence: decision.confidence,
    reason: decision.reason,
    predictive: null,
    spend,
    roas,
    ctr,
    cpa: row?.cpa ?? creativeInput?.cpa ?? null,
    purchases,
    impressions: safeNumber(row?.impressions ?? creativeInput?.impressions),
    linkClicks: safeNumber(row?.link_clicks ?? creativeInput?.linkClicks),
    addToCart: safeNumber(row?.add_to_cart ?? creativeInput?.addToCart),
    frequency: row?.frequency ?? creativeInput?.frequency ?? null,
    fatigue: decision.badges.some((badge) => badge.type === "fatigue_fatigued"),
    sparkline: [safeNumber(recentRoas), safeNumber(roas)],
    ctrFunnel: {
      value: ctr,
      p50: null,
    },
    primary: primaryActionForDecision(decision),
    automationReadiness: creativeReadOnlyAutomationReadiness(decision),
    status: creativeInput?.effectiveStatus ?? row?.effective_status ?? null,
    ageDays: creativeInput?.ageDays ?? null,
    campaignKind: decision.campaignKind ?? null,
    campaignTestDimension: decision.campaignTestDimension ?? null,
    campaignLabelStatus: decision.campaignLabelStatus ?? null,
    blockedActionType: decision.blockedActionType ?? null,
    labelTransform: decision.labelTransform ?? null,
    engineVersion: decision.engineVersion ?? null,
    sourceAsOf: input.sourceAsOf ?? null,
    sourceDataSource: input.sourceDataSource ?? null,
    profileScope: input.profileScope ?? null,
    mediaPreviewUrl:
      row?.card_preview_url ??
      row?.image_url ??
      row?.preview_url ??
      row?.cached_thumbnail_url ??
      row?.thumbnail_url ??
      row?.table_thumbnail_url ??
      null,
    thumbnailUrl: row?.thumbnail_url ?? null,
    tableThumbnailUrl: row?.table_thumbnail_url ?? row?.thumbnail_url ?? null,
    cardPreviewUrl:
      row?.card_preview_url ??
      row?.image_url ??
      row?.cached_thumbnail_url ??
      row?.thumbnail_url ??
      row?.preview_url ??
      null,
    previewUrl: row?.preview_url ?? null,
    imageUrl: row?.image_url ?? null,
    cachedThumbnailUrl: row?.cached_thumbnail_url ?? null,
    preview: previewForRow(row),
    previewState:
      row?.preview_state === "preview" || row?.preview_state === "catalog"
        ? row.preview_state
        : row?.card_preview_url || row?.preview_url || row?.thumbnail_url || row?.image_url || row?.cached_thumbnail_url || row?.table_thumbnail_url
          ? "preview"
          : "unavailable",
    isCatalog: row?.is_catalog ?? false,
    format: row?.format ?? null,
    creativeDeliveryType: row?.creative_delivery_type ?? null,
    creativeVisualFormat: row?.creative_visual_format ?? null,
    creativePrimaryType: row?.creative_primary_type ?? null,
    creativePrimaryLabel: row?.creative_primary_label ?? null,
    creativeSecondaryType: row?.creative_secondary_type ?? null,
    creativeSecondaryLabel: row?.creative_secondary_label ?? null,
    taxonomySource: row?.taxonomy_source ?? null,
    taxonomyReconciledByVideoEvidence:
      row?.taxonomy_reconciled_by_video_evidence ?? null,
  };
}

async function readCreativeRows(input: {
  request: NextRequest;
  businessId: string;
  start: string;
  end: string;
}): Promise<MetaCreativeApiRow[]> {
  if (await isDemoBusiness(input.businessId)) {
    return getDemoMetaCreatives().rows as unknown as MetaCreativeApiRow[];
  }
  const basePayloadInput = {
    request: input.request,
    requestStartedAt: Date.now(),
    businessId: input.businessId,
    mediaMode: "full",
    format: "all",
    sort: "spend",
    start: input.start,
    end: input.end,
    debugPreview: false,
    debugThumbnail: false,
    debugPerf: false,
    snapshotBypass: false,
    snapshotWarm: false,
    enableCopyRecovery: false,
    enableCreativeBasicsFallback: false,
    enableCreativeDetails: false,
    enableThumbnailBackfill: true,
    enableCardThumbnailBackfill: true,
    enableImageHashLookup: true,
    enableMediaRecovery: true,
    enableMediaCache: true,
    enableDeepAudit: false,
    perAccountSampleLimit: 5,
  } as const;
  const payload = await getMetaCreativesApiPayload({
    ...basePayloadInput,
    groupBy: "creative",
  });
  const rows = payload.rows ?? [];

  if (!rows.some((row) => !usableMetaAdId(row.real_ad_id))) {
    return rows;
  }

  const adPayload = await getMetaCreativesApiPayload({
    ...basePayloadInput,
    requestStartedAt: Date.now(),
    groupBy: "ad",
  }).catch(() => null);

  return hydrateCreativeRowsWithRealAdIds(rows, adPayload?.rows ?? []);
}

function buildRowMap(rows: MetaCreativeApiRow[]) {
  const map = new Map<string, MetaCreativeApiRow>();
  for (const row of rows) {
    map.set(row.id, row);
    map.set(row.creative_id, row);
  }
  return map;
}

function usableMetaAdId(value: string | null | undefined) {
  const text = value?.trim();
  if (!text) return null;
  if (text.startsWith("creative_") || text.startsWith("adset_")) return null;
  return text;
}

function hydrateCreativeRowsWithRealAdIds(
  creativeRows: MetaCreativeApiRow[],
  adRows: MetaCreativeApiRow[],
) {
  if (adRows.length === 0) return creativeRows;
  const adIdByCreativeId = new Map<string, string>();
  for (const row of adRows) {
    const creativeId = row.creative_id?.trim();
    const realAdId = usableMetaAdId(row.real_ad_id) ?? usableMetaAdId(row.id);
    if (creativeId && realAdId && !adIdByCreativeId.has(creativeId)) {
      adIdByCreativeId.set(creativeId, realAdId);
    }
  }
  if (adIdByCreativeId.size === 0) return creativeRows;

  return creativeRows.map((row) => {
    if (usableMetaAdId(row.real_ad_id)) return row;
    const realAdId = adIdByCreativeId.get(row.creative_id);
    return realAdId ? { ...row, real_ad_id: realAdId } : row;
  });
}

export async function GET(request: NextRequest) {
  const businessId =
    request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const asOf =
    request.nextUrl.searchParams.get("asOf")?.trim() || toISODate(new Date());
  const campaignId =
    request.nextUrl.searchParams.get("campaignId")?.trim() || undefined;
  const statusFilter = parseBriefingStatusFilter(
    request.nextUrl.searchParams.get("status_filter"),
  );
  const decisionCenterExplicitlyRequested = isDecisionCenterExplicitlyRequested(
    request.nextUrl.searchParams,
  );
  const includeDecisionCenter = shouldIncludeDecisionCenter(
    request.nextUrl.searchParams,
  );

  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const resolvedBusinessId = access.membership.businessId;
  const flags = await resolveEngineV3Flags(resolvedBusinessId);
  if (!flags.enabled) {
    const disabledBody: CreativesBriefingResponse & {
      status: "disabled";
      reason: string;
      statusFilter: typeof statusFilter;
    } = {
      status: "disabled",
      reason: "engine_v3_disabled_for_business",
      statusFilter,
      actionNow: [],
      watching: [],
      healthy: [],
      deferredCount: 0,
      pulse: {
        matureCount: 0,
        engineVersion: "disabled",
        trackingAnomalyActive: false,
      },
    };
    if (includeDecisionCenter) {
      disabledBody.decisionCenter = buildDecisionCenterSnapshot({
        asOf,
        engineVersion: "disabled",
        dataHealthDegraded: false,
      });
    }
    return NextResponse.json(disabledBody);
  }

  const { instance: dataSource, label: dataSourceLabel } = resolveDataSource();
  const [profile, dataHealth, creativeRows, triageState] = await Promise.all([
    resolveAccountDecisionProfile({
      businessId: resolvedBusinessId,
      asOf,
      dataSource,
      flags,
      campaignId,
    }),
    dataSource.getDataHealth({ businessId: resolvedBusinessId, asOf }),
    readCreativeRows({
      request,
      businessId: resolvedBusinessId,
      start: toISODate(nDaysAgo(29)),
      end: asOf,
    }).catch(() => [] as MetaCreativeApiRow[]),
    readTriageState({
      businessId: resolvedBusinessId,
      scopeType: "creative",
    }).catch(() => ({ rows: [], deferredCount: 0 })),
  ]);
  const creativeIds = creativeRows
    .map((row) => row.creative_id)
    .filter(Boolean);
  const inputs = await dataSource.listCreativeInputs({
    businessId: resolvedBusinessId,
    asOf,
    creativeIds: creativeIds.length > 0 ? creativeIds : undefined,
  });
  const campaignScopedInputs = campaignId
    ? inputs.filter((input) => input.campaignId === campaignId)
    : inputs;
  const allCreativeRowsById = buildRowMap(creativeRows);
  const scopedInputs = campaignScopedInputs.filter((input) => {
    const row = allCreativeRowsById.get(input.creativeId);
    const status = input.effectiveStatus ?? row?.effective_status ?? null;
    return isInBriefing(
      {
        status,
        effective_status: row?.effective_status ?? null,
        effectiveStatus: status,
      },
      statusFilter,
    );
  });
  const scopedInputByCreativeId = new Map(
    scopedInputs.map((input) => [input.creativeId, input]),
  );
  const creativeRowsById = buildRowMap(
    creativeRows.filter((row) => {
      const input = scopedInputByCreativeId.get(row.creative_id);
      const status = input?.effectiveStatus ?? row.effective_status ?? null;
      return isInBriefing(
        {
          status,
          effective_status: row.effective_status ?? null,
          effectiveStatus: status,
        },
        statusFilter,
      );
    }),
  );
  const deferredIds = new Set(
    triageState.rows
      .filter(
        (row) => row.action === "deferred" && row.scopeType === "creative",
      )
      .map((row) => row.scopeId),
  );
  const campaignIds = Array.from(
    new Set(
      scopedInputs
        .map((input) => input.campaignId?.trim() || "")
        .filter(Boolean),
    ),
  );
  const campaignLabelsById = buildCreativeCampaignLabelMap(
    campaignIds.length > 0
      ? await readMetaCampaignLabels({
          businessId: resolvedBusinessId,
          campaignIds,
        })
      : [],
  );

  const lanes: Record<BriefingLane, BriefingCreativeCard[]> = {
    action: [],
    watching: [],
    healthy: [],
  };
  const enrichedInputs = scopedInputs.map((creativeInput) =>
    withCreativeCampaignLabelContext(creativeInput, campaignLabelsById),
  );
  const inputByCreativeId = new Map(
    enrichedInputs.map((input) => [input.creativeId, input]),
  );
  const decisions = enrichedInputs.map((creativeInput) =>
    applyCreativeCampaignLabelGuard({
      decision: decideCreative(creativeInput, profile, dataHealth),
      input: creativeInput,
      campaignLabelsById,
    }),
  );

  for (const decision of decisions) {
    const creativeInput = inputByCreativeId.get(decision.creativeId);
    const row = rowForDecision(decision, creativeInput, creativeRowsById);
    const card = cardForDecision({
      decision,
      creativeInput,
      row,
      sourceAsOf: asOf,
      sourceDataSource: dataSourceLabel,
      profileScope: `${profile.scope.type}:${profile.scope.id}`,
    });
    const deferred =
      deferredIds.has(decision.creativeId) ||
      deferredIds.has(card.id) ||
      (row?.id ? deferredIds.has(row.id) : false);
    lanes[decisionLane(decision, deferred)].push(card);
  }

  const sortCards = (left: BriefingCreativeCard, right: BriefingCreativeCard) =>
    safeNumber(right.confidence) - safeNumber(left.confidence) ||
    safeNumber(right.spend) - safeNumber(left.spend);
  lanes.action.sort(sortCards);
  lanes.watching.sort(sortCards);
  lanes.healthy.sort(sortCards);

  const trackingAnomalyActive = decisions.some((decision) =>
    decision.badges.some((badge) => badge.type === "tracking_anomaly"),
  );

  const responseEngineVersion =
    decisions[0]?.engineVersion ?? flags.presetOverride ?? "Engine v3";

  const responseBody: CreativesBriefingResponse & {
    statusFilter: typeof statusFilter;
  } = {
    actionNow: lanes.action,
    watching: lanes.watching,
    healthy: lanes.healthy,
    statusFilter,
    deferredCount: triageState.deferredCount,
    pulse: {
      matureCount: lanes.healthy.length + lanes.action.length,
      spendTarget: null,
      spendHistory: null,
      rolling7dRoasTarget: profile.spendUnitEvidence.targetRoas,
      engineVersion: responseEngineVersion,
      calibratedAgo: dataHealth.calibration.computedAt ?? null,
      trackingAnomalyActive,
      trackingDetail: trackingAnomalyActive
        ? "Engine v3 flagged a tracking anomaly in the decision set."
        : dataHealth.degraded
          ? "Engine v3 is running with degraded data health."
          : null,
    },
    trackingAnomalyActive,
    trackingBlocked: trackingAnomalyActive,
    trackingDetail: trackingAnomalyActive
      ? "Engine v3 flagged a tracking anomaly in the decision set."
      : null,
    source: {
      dataSource: dataSourceLabel,
      asOf,
      dataHealth,
      accountProfile: profile,
    },
  };

  if (includeDecisionCenter) {
    const decisionCenterSnapshot = buildBridgedDecisionCenterSnapshot({
      asOf,
      engineVersion: responseEngineVersion,
      decisions,
      inputsByCreativeId: inputByCreativeId,
      creativeRowsById,
      dataHealthDegraded: Boolean(dataHealth.degraded),
    });
    responseBody.decisionCenter = decisionCenterSnapshot;
    emitDecisionCenterObservability({
      decisionCenterRequested: decisionCenterExplicitlyRequested,
      snapshot: decisionCenterSnapshot,
      businessId: resolvedBusinessId,
      creativeRows,
    });
  }

  return NextResponse.json(responseBody, {
    headers: { "Cache-Control": "no-store" },
  });
}
