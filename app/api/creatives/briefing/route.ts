import { createHash } from "node:crypto";
import { latestCanonicalComputedAt } from "@/lib/creatives/briefing-observed-at";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isDemoBusiness } from "@/lib/business-mode.server";
import {
  getDemoMetaCreatives,
  getDemoProviderAccounts,
} from "@/lib/demo-business";
import {
  NATIVE_AD_ENGINE_VERSION,
  type CreativeInput,
} from "@/lib/creative-decision-engine";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import {
  buildMetaCreativesAccountScopeMetadata,
  resolveMetaCreativesAccountScope,
} from "@/lib/meta/creatives-warehouse";
import {
  isInBriefing,
  parseBriefingStatusFilter,
} from "@/lib/meta/briefing-filter";
import { toISODate } from "@/lib/meta/creatives-row-mappers";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import {
  applyMetaExecutionGovernanceToCanonicalDecisions,
  readMetaNativeCanonicalDecisionInventory,
} from "@/lib/meta/decisions-workspace-read-model";
import { readEffectiveMetaWriteGovernance } from "@/lib/meta/automation-control-plane";
import {
  buildMetaDecisionPipelineHealthFromCanonicalInventory,
  readMetaDecisionPipelineOperationalHealth,
} from "@/lib/meta/decision-pipeline-health";
import { readDemoNativeCanonicalDecisionInventory } from "@/lib/meta/demo-native-canonical-fixture";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import { readTriageState } from "@/lib/triage-events";
import { CREATIVE_DECISION_ENGINE_CONFIG_VERSION } from "@/lib/creative-decision-engine/config-values";
import { safeNumber } from "./card-serialization";
import {
  BRIEFING_CANONICAL_NATIVE_AD_CONTRACT_VERSION,
  projectCanonicalNativeAdDecisionToBriefing,
} from "./canonical-projection";
import {
  assembleDecisionCenterSnapshot,
  auditDecisionCenterSnapshotInvariants,
  buildDecisionCenterObservabilityEvents,
  buildDecisionCenterAggregateDecisions,
  CREATIVE_DECISION_CENTER_ADAPTER_VERSION,
  DECISION_CENTER_OBSERVABILITY_LOG_MARKER,
  validateDecisionCenterSnapshot,
  type CreativeDecisionCenterAggregateDecision,
  type CreativeDecisionCenterAggregateCandidate,
  type CreativeDecisionCenterRowDecision,
  type CreativeDecisionCenterFreshnessStatus,
  type DecisionCenterSnapshot,
} from "@/lib/creative-decision-center";
import type {
  BriefingCreativeCard,
  BriefingCanonicalInventorySource,
  BriefingLaneSummary,
  CreativesBriefingMeasurementReconciliation,
  CreativesBriefingResponse,
} from "@/components/creatives/briefing/types";

export const dynamic = "force-dynamic";

type BriefingLane = "action" | "watching" | "healthy";

const DECISION_CENTER_OBSERVABILITY_ROUTE = "GET /api/creatives/briefing";
const LOCAL_DECISION_CENTER_OBSERVABILITY_SALT =
  "creative-decision-center.observability.v1.local-default";
const DECISION_CENTER_SNAPSHOT_MAX_AGE_HOURS = 26;

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
  const normalized =
    process.env.DECISION_CENTER_DEFAULT_DISABLED?.trim().toLowerCase();
  return (
    normalized === "1" || normalized === "true" || normalized === "enabled"
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
    normalized === "1" || normalized === "true" || normalized === "enabled"
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
  if (
    !input.decisionCenterRequested ||
    !isDecisionCenterObservabilityEnabled()
  ) {
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
  snapshotLatest?: CreativesBriefingMeasurementReconciliation["snapshotLatest"];
  rowDecisions?: CreativeDecisionCenterRowDecision[];
  aggregateDecisions?: CreativeDecisionCenterAggregateDecision[];
}): DecisionCenterSnapshot | null {
  if (!parseDateOnly(input.asOf)) return null;
  const generatedAt = new Date().toISOString();
  const latestSnapshotAsOf = input.snapshotLatest?.asOfDate ?? null;
  const snapshotAgeHours = latestSnapshotAsOf
    ? hoursBetweenUtcDates(latestSnapshotAsOf, generatedAt)
    : null;
  const dataFreshnessStatus: CreativeDecisionCenterFreshnessStatus =
    latestSnapshotAsOf === null
      ? "unknown"
      : input.dataHealthDegraded ||
          (snapshotAgeHours !== null &&
            snapshotAgeHours > DECISION_CENTER_SNAPSHOT_MAX_AGE_HOURS) ||
          (input.snapshotLatest?.staleRows ?? 0) > 0
        ? "stale"
        : "fresh";
  const { snapshot } = assembleDecisionCenterSnapshot({
    engineVersion: input.engineVersion,
    adapterVersion:
      input.adapterVersion ?? CREATIVE_DECISION_CENTER_ADAPTER_VERSION,
    configVersion: CREATIVE_DECISION_ENGINE_CONFIG_VERSION,
    generatedAt,
    dataFreshness: {
      status: dataFreshnessStatus,
      maxAgeHours: DECISION_CENTER_SNAPSHOT_MAX_AGE_HOURS,
      latestSnapshotAsOf,
      snapshotAgeHours,
    },
    rowDecisions: input.rowDecisions ?? [],
    aggregateDecisions: input.aggregateDecisions ?? [],
  });
  const validation = validateDecisionCenterSnapshot(snapshot);
  if (!validation.ok) return null;
  if (auditDecisionCenterSnapshotInvariants(snapshot).length > 0) return null;
  return snapshot;
}

function parseDateOnly(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const date = new Date(`${text.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
}

function subtractDaysDateOnly(value: string, days: number): string | null {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function hoursBetweenUtcDates(startDateOnly: string, endIso: string) {
  const start = new Date(`${startDateOnly}T00:00:00.000Z`);
  const end = new Date(endIso);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return null;
  }
  return Math.max(
    0,
    Number(((end.getTime() - start.getTime()) / 3_600_000).toFixed(2)),
  );
}

function coverage(present: number, total: number): number | null {
  return total > 0 ? Number((present / total).toFixed(4)) : null;
}

function hasPresentValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function buildDataCompletenessSummary(
  inputs: readonly CreativeInput[],
): CreativesBriefingMeasurementReconciliation["dataCompleteness"] {
  const fields = {
    reviewStatus: (input: CreativeInput) => input.reviewStatus,
    policyReason: (input: CreativeInput) => input.policyReason,
    disapprovalReason: (input: CreativeInput) => input.disapprovalReason,
    limitedReason: (input: CreativeInput) => input.limitedReason,
    firstSeenAt: (input: CreativeInput) => input.firstSeenAt,
    firstSpendAt: (input: CreativeInput) => input.firstSpendAt,
    spend24h: (input: CreativeInput) => input.spend24h,
    impressions24h: (input: CreativeInput) => input.impressions24h,
    ctr: (input: CreativeInput) => input.ctr,
    cpm: (input: CreativeInput) => input.cpm,
    frequency: (input: CreativeInput) => input.frequency,
  } as const;
  const total = inputs.length;
  const criticalForActionsByField: Record<string, string[]> = {
    reviewStatus: ["fix_policy", "unused_approved_creatives"],
    policyReason: ["fix_policy", "unused_approved_creatives"],
    disapprovalReason: ["fix_policy"],
    limitedReason: ["fix_policy"],
    firstSeenAt: ["watch_launch"],
    firstSpendAt: ["watch_launch", "fix_delivery"],
    spend24h: ["fix_delivery", "watch_launch"],
    impressions24h: ["fix_delivery", "watch_launch"],
    ctr: ["refresh", "diagnose_data"],
    cpm: ["refresh", "diagnose_data"],
    frequency: ["refresh", "diagnose_data"],
  };
  const entries = Object.entries(fields).map(([field, read]) => {
    const present = inputs.filter((input) =>
      hasPresentValue(read(input)),
    ).length;
    return [
      field,
      {
        present,
        total,
        coverage: coverage(present, total),
        criticalForActions: criticalForActionsByField[field] ?? [],
      },
    ] as const;
  });
  return {
    totalInputs: total,
    fields: Object.fromEntries(entries),
  };
}

function buildLaneSummary(input: {
  lanes: Record<BriefingLane, BriefingCreativeCard[]>;
  deferredCount: number;
}): BriefingLaneSummary {
  const watching = input.lanes.watching;
  const totalDecisions =
    input.lanes.action.length + watching.length + input.lanes.healthy.length;
  const bucketCounts = {
    nearAction: 0,
    testMaturing: 0,
    diagnostic: 0,
    waitingOnLabels: 0,
    other: 0,
  };

  for (const card of watching) {
    if (card.watchingSubBucket === "near_action") {
      bucketCounts.nearAction += 1;
    } else if (card.watchingSubBucket === "test_maturing") {
      bucketCounts.testMaturing += 1;
    } else if (card.watchingSubBucket === "diagnostic") {
      bucketCounts.diagnostic += 1;
    } else if (
      card.watchingSubBucket === "waiting_on_role_resolution" ||
      card.watchingSubBucket === "waiting_on_labels"
    ) {
      bucketCounts.waitingOnLabels += 1;
    } else {
      bucketCounts.other += 1;
    }
  }

  return {
    actionNow: input.lanes.action.length,
    watching: {
      total: watching.length,
      ...bucketCounts,
    },
    healthy: input.lanes.healthy.length,
    deferred: input.deferredCount,
    totalDecisions,
    coveragePct: totalDecisions > 0 ? 1 : null,
  };
}

async function readCreativeRows(input: {
  request: NextRequest;
  businessId: string;
  providerAccountId: string;
  start: string;
  end: string;
}): Promise<MetaCreativeApiRow[]> {
  if (await isDemoBusiness(input.businessId)) {
    return getDemoMetaCreatives().rows.filter(
      (row) => row.account_id === input.providerAccountId,
    ) as unknown as MetaCreativeApiRow[];
  }
  const basePayloadInput = {
    request: input.request,
    requestStartedAt: Date.now(),
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
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
    groupBy: "ad",
  });
  return payload.rows ?? [];
}

function buildExactAdRowMap(rows: MetaCreativeApiRow[]) {
  const map = new Map<string, MetaCreativeApiRow>();
  for (const row of rows) {
    // `readCreativeRows` explicitly requests ad grain, whose mapper persists
    // `real_ad_id`. Do not infer provider identity from a generic row id at a
    // serving boundary; an absent exact Ad id simply withholds enrichment.
    const adId = usableMetaAdId(row.real_ad_id);
    if (adId) map.set(adId, row);
  }
  return map;
}

function usableMetaAdId(value: string | null | undefined) {
  const text = value?.trim();
  if (!text) return null;
  if (text.startsWith("creative_") || text.startsWith("adset_")) return null;
  return text;
}

function canonicalNativeDecisionCreativeScopeId(
  decision: MetaCanonicalDecision,
) {
  return (
    decision.parentChain.creative?.id?.trim() ||
    decision.parentChain.ad?.id?.trim() ||
    null
  );
}

export async function GET(request: NextRequest) {
  const requestEvaluatedAt = new Date();
  const businessId =
    request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const asOf =
    request.nextUrl.searchParams.get("asOf")?.trim() || toISODate(new Date());
  const requestedStart = parseDateOnly(
    request.nextUrl.searchParams.get("start"),
  );
  const parsedAsOf = parseDateOnly(asOf);
  const currentFallbackStart = new Date();
  currentFallbackStart.setUTCDate(currentFallbackStart.getUTCDate() - 29);
  const start =
    requestedStart && (!parsedAsOf || requestedStart <= parsedAsOf)
      ? requestedStart
      : ((parsedAsOf ? subtractDaysDateOnly(parsedAsOf, 29) : null) ??
        toISODate(currentFallbackStart));
  const campaignId =
    request.nextUrl.searchParams.get("campaignId")?.trim() || undefined;
  const requestedProviderAccountId =
    request.nextUrl.searchParams.get("providerAccountId")?.trim() || null;
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
  const demoBusiness = await isDemoBusiness(resolvedBusinessId);
  const assignedAccountIds = demoBusiness
    ? getDemoProviderAccounts("meta").map((account) => account.id)
    : await fetchAssignedAccountIds(resolvedBusinessId);
  const accountScope = resolveMetaCreativesAccountScope({
    assignedAccountIds,
    requestedProviderAccountId,
  });
  if (!accountScope.ok) {
    return NextResponse.json(
      {
        error: accountScope.status,
        message:
          accountScope.status === "account_not_assigned"
            ? "The requested Meta account is not assigned to this business."
            : accountScope.status === "provider_account_required"
              ? "providerAccountId is required when multiple Meta accounts are assigned."
              : "No Meta account is assigned to this business.",
        actionNow: [],
        watching: [],
        healthy: [],
        ...buildMetaCreativesAccountScopeMetadata(accountScope),
      },
      {
        status:
          accountScope.status === "account_not_assigned"
            ? 403
            : accountScope.status === "provider_account_required"
              ? 400
              : 200,
      },
    );
  }
  const providerAccountId = accountScope.providerAccountId;
  const accountScopeMetadata =
    buildMetaCreativesAccountScopeMetadata(accountScope);
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
    return NextResponse.json({ ...disabledBody, ...accountScopeMetadata });
  }

  const liveCanonicalInventoryPromise = demoBusiness
    ? null
    : readMetaNativeCanonicalDecisionInventory({
        businessId: resolvedBusinessId,
        providerAccountId,
        asOfDate: parsedAsOf ?? undefined,
        generatedAt: requestEvaluatedAt.toISOString(),
      });
  const liveExecutionGovernancePromise = demoBusiness
    ? null
    : readEffectiveMetaWriteGovernance({ businessId: resolvedBusinessId });
  const liveOperationalPipelineHealthPromise = demoBusiness
    ? null
    : readMetaDecisionPipelineOperationalHealth({
        businessId: resolvedBusinessId,
        providerAccountId,
        now: requestEvaluatedAt,
      });
  const [creativeRows, triageState] = await Promise.all([
    readCreativeRows({
      request,
      businessId: resolvedBusinessId,
      providerAccountId,
      start,
      end: asOf,
    }).catch(() => [] as MetaCreativeApiRow[]),
    readTriageState({
      businessId: resolvedBusinessId,
      scopeType: "creative",
    }).catch(() => ({ rows: [], deferredCount: 0 })),
  ]);
  const rawCanonicalInventory = demoBusiness
    ? readDemoNativeCanonicalDecisionInventory({
      businessId: resolvedBusinessId,
      providerAccountId,
      rows: creativeRows,
    })
    : await liveCanonicalInventoryPromise!;
  const canonicalInventory =
    demoBusiness || rawCanonicalInventory.status === "unavailable"
      ? rawCanonicalInventory
      : await (async () => {
          const [governance, operational] = await Promise.all([
            liveExecutionGovernancePromise!,
            liveOperationalPipelineHealthPromise!,
          ]);
          const pipelineHealth =
            buildMetaDecisionPipelineHealthFromCanonicalInventory({
              operational,
              inventory: rawCanonicalInventory,
              now: requestEvaluatedAt,
            });
          return {
            ...rawCanonicalInventory,
            items: applyMetaExecutionGovernanceToCanonicalDecisions({
              decisions: rawCanonicalInventory.items,
              governance,
              pipeline: {
                verified: pipelineHealth.overall !== "unavailable",
                executionReady: pipelineHealth.executionReady,
              },
              now: requestEvaluatedAt,
            }),
          };
        })();

  const unavailableResponse = (reason: string) => {
    const canonicalDecisionInventory: BriefingCanonicalInventorySource = {
      contractVersion: BRIEFING_CANONICAL_NATIVE_AD_CONTRACT_VERSION,
      status: "unavailable",
      unavailableReason: reason,
      generation: null,
      itemCount: 0,
    };
    const emptyLanes: Record<BriefingLane, BriefingCreativeCard[]> = {
      action: [],
      watching: [],
      healthy: [],
    };
    const measurementReconciliation: CreativesBriefingMeasurementReconciliation =
      {
        durationMs: 0,
        queryCount: 0,
        briefingCounts: { actionNow: 0, watching: 0, healthy: 0, total: 0 },
        decisionCenterRowCount: includeDecisionCenter ? 0 : null,
        snapshotLatest: null,
        outcome: null,
        dataCompleteness: buildDataCompletenessSummary([]),
        notes: ["native_ad_generation_unavailable", reason],
      };
    const decisionCenterSnapshot = includeDecisionCenter
      ? buildDecisionCenterSnapshot({
          asOf,
          engineVersion: "native_unavailable",
          adapterVersion: BRIEFING_CANONICAL_NATIVE_AD_CONTRACT_VERSION,
          dataHealthDegraded: true,
          rowDecisions: [],
          aggregateDecisions: [],
        })
      : undefined;
    const body: CreativesBriefingResponse & {
      statusFilter: typeof statusFilter;
    } = {
      ...accountScopeMetadata,
      actionNow: emptyLanes.action,
      watching: emptyLanes.watching,
      healthy: emptyLanes.healthy,
      statusFilter,
      deferredCount: 0,
      pulse: {
        matureCount: 0,
        engineVersion: "native_unavailable",
        calibratedAgo: null,
        trackingAnomalyActive: false,
        trackingDetail: `Canonical ad decision bundle unavailable: ${reason}.`,
      },
      trackingAnomalyActive: false,
      trackingBlocked: true,
      trackingDetail: `Canonical ad decision bundle unavailable: ${reason}.`,
      source: {
        dataSource: "native_ad_generation",
        asOf,
        dataHealth: null,
        accountProfile: null,
        measurementReconciliation,
        laneSummary: buildLaneSummary({ lanes: emptyLanes, deferredCount: 0 }),
        aggregateSuppressionTrace: null,
        canonicalDecisionInventory,
      },
    };
    if (includeDecisionCenter) {
      body.decisionCenter = decisionCenterSnapshot ?? null;
      emitDecisionCenterObservability({
        decisionCenterRequested: decisionCenterExplicitlyRequested,
        snapshot: decisionCenterSnapshot ?? null,
        businessId: resolvedBusinessId,
        creativeRows,
      });
    }
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  };

  if (canonicalInventory.status === "unavailable") {
    return unavailableResponse(canonicalInventory.unavailableReason);
  }

  const creativeRowsByAdId = buildExactAdRowMap(creativeRows);
  const deferredIds = new Set(
    triageState.rows
      .filter(
        (row) => row.action === "deferred" && row.scopeType === "creative",
      )
      .map((row) => row.scopeId),
  );

  const lanes: Record<BriefingLane, BriefingCreativeCard[]> = {
    action: [],
    watching: [],
    healthy: [],
  };
  const projectedInventory = canonicalInventory.items.map((decision) => {
    const adId = usableMetaAdId(decision.parentChain.ad?.id);
    const creativeScopeId = canonicalNativeDecisionCreativeScopeId(decision);
    const projection = projectCanonicalNativeAdDecisionToBriefing({
      decision,
      row: adId ? creativeRowsByAdId.get(adId) : null,
      deferred: creativeScopeId ? deferredIds.has(creativeScopeId) : false,
    });
    return { decision, projection, creativeScopeId };
  });
  if (projectedInventory.some(({ projection }) => projection === null)) {
    return unavailableResponse(
      "native_canonical_briefing_projection_incomplete",
    );
  }

  const scopedProjectedInventory = projectedInventory
    .map(({ decision, projection, creativeScopeId }) => ({
      decision,
      projection: projection!,
      creativeScopeId,
    }))
    .filter(({ decision }) => {
      if (campaignId && decision.parentChain.campaign?.id !== campaignId) {
        return false;
      }
      return isInBriefing(
        { status: decision.deliveryScope?.adStatus ?? null },
        statusFilter,
      );
    });
  for (const { projection } of scopedProjectedInventory) {
    const card = includeDecisionCenter
      ? projection.card
      : { ...projection.card, decisionCenterRow: null };
    lanes[projection.lane].push(card);
  }

  const sortCards = (left: BriefingCreativeCard, right: BriefingCreativeCard) =>
    safeNumber(right.priorityScore?.score) -
      safeNumber(left.priorityScore?.score) ||
    safeNumber(right.confidence) - safeNumber(left.confidence) ||
    safeNumber(right.spend) - safeNumber(left.spend);
  lanes.action.sort(sortCards);
  lanes.watching.sort(sortCards);
  lanes.healthy.sort(sortCards);

  const trackingAnomalyActive = scopedProjectedInventory.some(
    ({ projection }) =>
      projection.presentationDecision.badges.some(
        (badge) => badge.type === "tracking_anomaly",
      ),
  );
  const responseEngineVersion =
    canonicalInventory.items[0]?.sourceDecision.engineVersion ??
    NATIVE_AD_ENGINE_VERSION;
  const canonicalTargetRoasValues = Array.from(
    new Set(
      canonicalInventory.items.flatMap((decision) => {
        const value = decision.metrics.effectiveTargetRoas;
        return typeof value === "number" && Number.isFinite(value)
          ? [value]
          : [];
      }),
    ),
  );
  // Tier-0 as-of: latest canonical computation timestamp, never the calendar
  // label. See lib/creatives/briefing-observed-at.ts.
  const canonicalComputedAt = latestCanonicalComputedAt(
    canonicalInventory.items,
  );
  const aggregateBuild = buildDecisionCenterAggregateDecisions({
    candidates: [],
  });
  const scopedDeferredCount = scopedProjectedInventory.filter(
    ({ creativeScopeId }) =>
      creativeScopeId ? deferredIds.has(creativeScopeId) : false,
  ).length;
  const laneSummary = buildLaneSummary({
    lanes,
    deferredCount: scopedDeferredCount,
  });
  const snapshotLatest: NonNullable<
    CreativesBriefingMeasurementReconciliation["snapshotLatest"]
  > = {
    asOfDate: canonicalInventory.generation.asOfDate,
    observedAt: canonicalComputedAt,
    engineVersion: responseEngineVersion,
    rowCount: canonicalInventory.items.length,
    conflictingGroups: 0,
    staleRows: 0,
    lifecycleRowCount: null,
  };
  const decisionCenterRows = includeDecisionCenter
    ? scopedProjectedInventory.flatMap(({ projection }) =>
        projection.decisionCenterRow ? [projection.decisionCenterRow] : [],
      )
    : [];
  const measurementReconciliation: CreativesBriefingMeasurementReconciliation =
    {
      durationMs: 0,
      queryCount: 0,
      briefingCounts: {
        actionNow: lanes.action.length,
        watching: lanes.watching.length,
        healthy: lanes.healthy.length,
        total:
          lanes.action.length + lanes.watching.length + lanes.healthy.length,
      },
      decisionCenterRowCount: includeDecisionCenter
        ? decisionCenterRows.length
        : null,
      snapshotLatest,
      outcome: null,
      dataCompleteness: buildDataCompletenessSummary([]),
      notes: [
        demoBusiness
          ? "demo_synthetic_review_only_authority"
          : "native_ad_generation_authority",
        "request_time_profile_and_data_health_not_serving_authority",
      ],
    };
  let decisionCenterSnapshot: DecisionCenterSnapshot | null | undefined;
  if (includeDecisionCenter) {
    decisionCenterSnapshot = buildDecisionCenterSnapshot({
      asOf: canonicalInventory.generation.asOfDate,
      engineVersion: responseEngineVersion,
      adapterVersion: BRIEFING_CANONICAL_NATIVE_AD_CONTRACT_VERSION,
      dataHealthDegraded: false,
      snapshotLatest,
      rowDecisions: decisionCenterRows,
      aggregateDecisions: aggregateBuild.aggregateDecisions,
    });
  }
  measurementReconciliation.decisionCenterRowCount =
    decisionCenterSnapshot === undefined
      ? null
      : (decisionCenterSnapshot?.rowDecisions.length ?? null);

  const responseBody: CreativesBriefingResponse & {
    statusFilter: typeof statusFilter;
  } = {
    ...accountScopeMetadata,
    actionNow: lanes.action,
    watching: lanes.watching,
    healthy: lanes.healthy,
    statusFilter,
    deferredCount: scopedDeferredCount,
    pulse: {
      matureCount: lanes.healthy.length + lanes.action.length,
      spendTarget: null,
      spendHistory: null,
      rolling7dRoasTarget:
        canonicalTargetRoasValues.length === 1
          ? canonicalTargetRoasValues[0]
          : null,
      engineVersion: responseEngineVersion,
      calibratedAgo: canonicalComputedAt,
      trackingAnomalyActive,
      trackingDetail: trackingAnomalyActive
        ? "The persisted native decision set flagged a tracking anomaly."
        : null,
    },
    trackingAnomalyActive,
    trackingBlocked: trackingAnomalyActive,
    trackingDetail: trackingAnomalyActive
      ? "The persisted native decision set flagged a tracking anomaly."
      : null,
    source: {
      dataSource: "native_ad_generation",
      asOf: canonicalInventory.generation.asOfDate,
      dataHealth: null,
      accountProfile: null,
      measurementReconciliation,
      laneSummary,
      aggregateSuppressionTrace: aggregateBuild.trace,
      canonicalDecisionInventory: {
        contractVersion: BRIEFING_CANONICAL_NATIVE_AD_CONTRACT_VERSION,
        status: "available",
        unavailableReason: null,
        generation: {
          jobRunId: canonicalInventory.generation.jobRunId,
          asOfDate: canonicalInventory.generation.asOfDate,
          providerAccountRefId:
            canonicalInventory.generation.providerAccountRefId,
          manifestHash: canonicalInventory.generation.manifestHash,
          expectedAdCount: canonicalInventory.generation.expectedAdCount,
          authorityStatus: demoBusiness
            ? "demo_synthetic_review_only"
            : "native_exact",
        },
        itemCount: canonicalInventory.items.length,
      },
    },
  };

  if (includeDecisionCenter) {
    responseBody.decisionCenter = decisionCenterSnapshot ?? null;
    emitDecisionCenterObservability({
      decisionCenterRequested: decisionCenterExplicitlyRequested,
      snapshot: decisionCenterSnapshot ?? null,
      businessId: resolvedBusinessId,
      creativeRows,
    });
  }

  return NextResponse.json(responseBody, {
    headers: { "Cache-Control": "no-store" },
  });
}
