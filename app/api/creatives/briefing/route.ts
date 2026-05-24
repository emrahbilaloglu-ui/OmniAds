import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoMetaCreatives } from "@/lib/demo-business";
import {
  decideCreative,
  resolveAccountDecisionProfile,
  type CreativeInput,
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
  cardForDecision,
  safeNumber,
} from "./card-serialization";
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

export const dynamic = "force-dynamic";

type BriefingLane = "action" | "watching" | "healthy";

const DECISION_CENTER_OBSERVABILITY_ROUTE = "GET /api/creatives/briefing";
const LOCAL_DECISION_CENTER_OBSERVABILITY_SALT =
  "creative-decision-center.observability.v1.local-default";

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

function decisionLane(
  decision: DecisionOutput,
  deferred: boolean,
): BriefingLane {
  if (deferred) return "watching";
  if (
    decision.label === "diagnose" &&
    decision.blockedActionType === "cut" &&
    decision.campaignLabelStatus === "unlabeled"
  ) {
    return "action";
  }
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
