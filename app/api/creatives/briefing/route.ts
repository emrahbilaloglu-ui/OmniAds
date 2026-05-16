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
import { isInBriefing, parseBriefingStatusFilter } from "@/lib/meta/briefing-filter";
import { nDaysAgo, toISODate } from "@/lib/meta/creatives-row-mappers";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import { readTriageState } from "@/lib/triage-events";
import type {
  BriefingCreativeCard,
  CreativesBriefingResponse,
} from "@/components/creatives/briefing/types";

export const dynamic = "force-dynamic";

type BriefingLane = "action" | "watching" | "healthy";

function badgeLabels(badges: DecisionBadge[]) {
  return badges.flatMap((badge) => {
    if (badge.type === "below_breakeven") return ["below_breakeven"];
    if (badge.type === "fatigue_watch" || badge.type === "fatigue_fatigued") return ["fatigue"];
    if (badge.type === "unlabeled_campaign_context") return ["unlabeled_campaign_context"];
    return [];
  });
}

function primaryActionForDecision(decision: DecisionOutput): { kind: string; label: string } {
  if (decision.label === "cut") return { kind: "cut", label: "Cut" };
  if (decision.label === "scale") return { kind: "promote", label: "Promote to main" };
  if (decision.label === "refresh") return { kind: "fresh_test", label: "Launch fresh test" };
  if (decision.label === "test_more") return { kind: "fresh_test", label: "Launch new test" };
  if (decision.label === "diagnose") return { kind: "review", label: "Open evidence" };
  return { kind: "review", label: "Review" };
}

function safeNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function decisionLane(decision: DecisionOutput, deferred: boolean): BriefingLane {
  if (deferred) return "watching";
  if (decision.label === "keep") return "healthy";
  if (
    decision.confidence >= 70 &&
    (decision.label === "scale" || decision.label === "cut" || decision.label === "refresh")
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

function cardForDecision(input: {
  decision: DecisionOutput;
  creativeInput?: CreativeInput;
  row?: MetaCreativeApiRow | null;
}): BriefingCreativeCard {
  const { decision, creativeInput, row } = input;
  const label = decision.label as DecisionLabel;
  const name = row?.name || decision.creativeName || creativeInput?.creativeName || decision.creativeId;
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
    campaign: row?.campaign_name ?? row?.campaign_id ?? creativeInput?.campaignId ?? null,
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
    status: row?.effective_status ?? creativeInput?.effectiveStatus ?? null,
    ageDays: creativeInput?.ageDays ?? null,
    campaignKind: decision.campaignKind ?? null,
    campaignTestDimension: decision.campaignTestDimension ?? null,
    campaignLabelStatus: decision.campaignLabelStatus ?? null,
    blockedActionType: decision.blockedActionType ?? null,
    labelTransform: decision.labelTransform ?? null,
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
  const payload = await getMetaCreativesApiPayload({
    request: input.request,
    requestStartedAt: Date.now(),
    businessId: input.businessId,
    mediaMode: "metadata",
    groupBy: "creative",
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
    enableThumbnailBackfill: false,
    enableCardThumbnailBackfill: false,
    enableImageHashLookup: false,
    enableMediaRecovery: false,
    enableMediaCache: true,
    enableDeepAudit: false,
    perAccountSampleLimit: 5,
  });
  return payload.rows ?? [];
}

function buildRowMap(rows: MetaCreativeApiRow[]) {
  const map = new Map<string, MetaCreativeApiRow>();
  for (const row of rows) {
    map.set(row.id, row);
    map.set(row.creative_id, row);
  }
  return map;
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const asOf = request.nextUrl.searchParams.get("asOf")?.trim() || toISODate(new Date());
  const campaignId = request.nextUrl.searchParams.get("campaignId")?.trim() || undefined;
  const statusFilter = parseBriefingStatusFilter(request.nextUrl.searchParams.get("status_filter"));

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
    return NextResponse.json({
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
    } satisfies CreativesBriefingResponse & {
      status: "disabled";
      reason: string;
      statusFilter: typeof statusFilter;
    });
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
  const creativeIds = creativeRows.map((row) => row.creative_id).filter(Boolean);
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
    return isInBriefing(
      {
        status: row?.effective_status ?? input.effectiveStatus ?? null,
        effective_status: row?.effective_status ?? null,
        effectiveStatus: row?.effective_status ?? input.effectiveStatus ?? null,
      },
      statusFilter,
    );
  });
  const scopedInputByCreativeId = new Map(scopedInputs.map((input) => [input.creativeId, input]));
  const creativeRowsById = buildRowMap(
    creativeRows.filter((row) =>
      isInBriefing(
        {
          status: row.effective_status ?? scopedInputByCreativeId.get(row.creative_id)?.effectiveStatus ?? null,
          effective_status: row.effective_status ?? null,
          effectiveStatus: row.effective_status ?? scopedInputByCreativeId.get(row.creative_id)?.effectiveStatus ?? null,
        },
        statusFilter,
      ),
    ),
  );
  const deferredIds = new Set(
    triageState.rows
      .filter((row) => row.action === "deferred" && row.scopeType === "creative")
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
    const card = cardForDecision({ decision, creativeInput, row });
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

  return NextResponse.json(
    {
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
        engineVersion: decisions[0]?.engineVersion ?? flags.presetOverride ?? "Engine v3",
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
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
