import {
  type AccountDecisionProfile,
  type CreativeInput,
  type DecisionBadge,
  type DecisionLabel,
  type DecisionOutput,
} from "@/lib/creative-decision-engine";
import type { DecisionBacktestSummary } from "@/lib/creative-decision-engine/backtest";
import { creativeAutomationReadiness } from "@/lib/creative-decision-engine/automation-readiness";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

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
    if (badge.type === "stop_loss_review") return ["stop_loss_review"];
    if (badge.type === "delivery_no_spend_24h")
      return ["delivery_no_spend_24h"];
    if (badge.type === "policy_blocked") return ["policy_blocked"];
    if (badge.type === "launch_monitoring") return ["launch_monitoring"];
    return [];
  });
}

function primaryActionForDecision(decision: DecisionOutput): {
  kind: string;
  label: string;
} {
  if (
    decision.label === "diagnose" &&
    decision.blockedActionType === "cut" &&
    decision.campaignLabelStatus === "unlabeled"
  ) {
    return { kind: "review", label: "Cut review" };
  }
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

export function safeNumber(value: number | null | undefined) {
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

export function cardForDecision(input: {
  decision: DecisionOutput;
  creativeInput?: CreativeInput;
  row?: MetaCreativeApiRow | null;
  sourceAsOf?: string | null;
  sourceDataSource?: string | null;
  profileScope?: string | null;
  accountProfile?: AccountDecisionProfile | null;
  backtestSummary?: DecisionBacktestSummary | null;
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
    truthSource: decision.truthSource,
    spendUnitSource: input.accountProfile?.spendUnitSource ?? null,
    spendUnitConfidence: input.accountProfile?.spendUnitConfidence ?? null,
    metaAovQuality: input.accountProfile?.quality.metaAovQuality ?? null,
    thresholdQuality: input.accountProfile?.quality.thresholdQuality ?? null,
    badges: badgeLabels(decision.badges),
    blockers: decision.blockers ?? null,
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
    automationReadiness: creativeAutomationReadiness({
      decision,
      backtestSummary: input.backtestSummary ?? null,
    }),
    status: creativeInput?.effectiveStatus ?? row?.effective_status ?? null,
    ageDays: creativeInput?.ageDays ?? null,
    firstSeenAt: creativeInput?.firstSeenAt ?? null,
    firstSpendAt: creativeInput?.firstSpendAt ?? null,
    spend24h: creativeInput?.spend24h ?? null,
    impressions24h: creativeInput?.impressions24h ?? null,
    reviewStatus: creativeInput?.reviewStatus ?? null,
    disapprovalReason: creativeInput?.disapprovalReason ?? null,
    limitedReason: creativeInput?.limitedReason ?? null,
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
