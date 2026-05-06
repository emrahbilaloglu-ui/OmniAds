import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { CreativeDecisionOsV1Response } from "@/lib/creative-decision-os";
import type {
  CommandCenterAction,
  CommandCenterCalibrationSuggestion,
  CommandCenterFeedbackEntry,
  CommandCenterFeedbackSummary,
  CommandCenterHistoricalCampaignFamilySummary,
  CommandCenterHistoricalHotspot,
  CommandCenterHistoricalIntelligence,
  CommandCenterQueueBudgetSummary,
} from "@/lib/command-center";
import type { MetaDecisionOsV1Response } from "@/lib/meta/decision-os";
import {
  metaCampaignFamilyLabel,
  resolveMetaCampaignFamily,
} from "@/lib/meta/campaign-lanes";

const MAX_FAMILY_SUMMARIES = 4;
const MAX_HOTSPOTS = 3;

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function humanizeKey(value: string | null | undefined, fallback: string) {
  const normalized = (value ?? "").trim();
  if (!normalized) return fallback;
  return normalized
    .replaceAll(":", " ")
    .replaceAll("_", " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sourceTypeLabel(value: CommandCenterAction["sourceType"] | null) {
  if (value === "meta_adset_decision") return "Meta ad set decisions";
  if (value === "meta_budget_shift") return "Meta budget shifts";
  if (value === "meta_geo_decision") return "Meta GEO decisions";
  if (value === "meta_placement_anomaly") return "Meta placement anomalies";
  if (value === "meta_no_touch_item") return "Meta no-touch items";
  if (value === "creative_primary_decision") return "Creative primary decisions";
  return "Unlabeled feedback";
}

function buildCampaignFamilies(
  campaigns: MetaCampaignRow[],
): CommandCenterHistoricalCampaignFamilySummary[] {
  const groups = new Map<string, MetaCampaignRow[]>();
  for (const campaign of campaigns) {
    const family = resolveMetaCampaignFamily(campaign);
    groups.set(family, [...(groups.get(family) ?? []), campaign]);
  }

  return [...groups.entries()]
    .map(([family, rows]) => {
      const typedFamily = family as CommandCenterHistoricalCampaignFamilySummary["family"];
      const spend = rows.reduce((sum, row) => sum + row.spend, 0);
      const purchases = rows.reduce((sum, row) => sum + row.purchases, 0);
      const revenue = rows.reduce((sum, row) => sum + row.revenue, 0);
      const activeCampaignCount = rows.filter((row) => row.status === "ACTIVE").length;
      const familyLabel = metaCampaignFamilyLabel(typedFamily);
      const roas = spend > 0 ? revenue / spend : 0;
      return {
        family: typedFamily,
        familyLabel,
        campaignCount: rows.length,
        activeCampaignCount,
        spend: round(spend, 2),
        purchases,
        roas: round(roas, 2),
        summary: `${familyLabel} ran ${rows.length} campaign(s), ${activeCampaignCount} active, with ${spend.toFixed(0)} spend and ${roas.toFixed(2)}x blended ROAS in the selected period.`,
      } satisfies CommandCenterHistoricalCampaignFamilySummary;
    })
    .sort((left, right) => {
      if (right.spend !== left.spend) return right.spend - left.spend;
      if (right.purchases !== left.purchases) return right.purchases - left.purchases;
      return left.familyLabel.localeCompare(right.familyLabel);
    })
    .slice(0, MAX_FAMILY_SUMMARIES);
}

function buildFalsePositiveHotspots(
  feedback: CommandCenterFeedbackEntry[],
): CommandCenterHistoricalHotspot[] {
  const groups = new Map<string, CommandCenterFeedbackEntry[]>();
  for (const entry of feedback) {
    if (entry.scope !== "action" || entry.feedbackType !== "false_positive") continue;
    const key = entry.sourceType ?? "unknown";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      label: sourceTypeLabel(rows[0]?.sourceType ?? null),
      count: rows.length,
      summary: `${rows.length} false-positive report(s) landed on ${sourceTypeLabel(rows[0]?.sourceType ?? null).toLowerCase()} in the current selection.`,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, MAX_HOTSPOTS);
}

function buildFalseNegativeHotspots(
  feedback: CommandCenterFeedbackEntry[],
): CommandCenterHistoricalHotspot[] {
  const groups = new Map<string, CommandCenterFeedbackEntry[]>();
  for (const entry of feedback) {
    if (entry.scope !== "queue_gap" || entry.feedbackType !== "false_negative") continue;
    const key = `${entry.sourceSystem ?? "all"}:${entry.viewKey ?? "default_queue"}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return [...groups.entries()]
    .map(([key, rows]) => {
      const sourceLabel =
        rows[0]?.sourceSystem === "meta"
          ? "Meta"
          : rows[0]?.sourceSystem === "creative"
            ? "Creative"
            : "Cross-surface";
      const queueLabel = humanizeKey(rows[0]?.viewKey ?? "default_queue", "Default queue");
      return {
        key,
        label: `${sourceLabel} - ${queueLabel}`,
        count: rows.length,
        summary: `${rows.length} queue-gap report(s) suggest missing work in ${queueLabel.toLowerCase()} for ${sourceLabel.toLowerCase()} review.`,
      } satisfies CommandCenterHistoricalHotspot;
    })
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, MAX_HOTSPOTS);
}

export function buildCommandCenterHistoricalIntelligence(input: {
  startDate: string;
  endDate: string;
  selectedPeriodCampaigns: MetaCampaignRow[];
  actions: CommandCenterAction[];
  throughput: CommandCenterQueueBudgetSummary;
  feedbackSummary: CommandCenterFeedbackSummary;
  feedback: CommandCenterFeedbackEntry[];
  metaDecisionOs: MetaDecisionOsV1Response | null;
  creativeDecisionOs: CreativeDecisionOsV1Response | null;
}): CommandCenterHistoricalIntelligence {
  const actionCount = Math.max(input.actions.length, 1);
  const degradedActions = input.actions.filter(
    (action) => action.truthState === "degraded_missing_truth",
  );
  const missingInputs = uniqueStrings([
    ...(input.metaDecisionOs?.commercialTruthCoverage.missingInputs ?? []),
    ...(input.creativeDecisionOs?.commercialTruthCoverage.missingInputs ?? []),
  ]);
  const degradedReasons = uniqueStrings(
    degradedActions.flatMap((action) => action.trustReasons),
  ).slice(0, 4);
  const falsePositiveHotspots = buildFalsePositiveHotspots(input.feedback);
  const falseNegativeHotspots = buildFalseNegativeHotspots(input.feedback);
  const degradedShare = degradedActions.length / actionCount;
  const calibrationSuggestions: CommandCenterCalibrationSuggestion[] = [];

  if (missingInputs.length > 0) {
    calibrationSuggestions.push({
      key: "missing_truth_inputs",
      priority: "high",
      title: "Fill missing commercial truth first",
      detail:
        "The largest calibration gain still comes from completing missing business truth so review-safe actions can tighten without guessing.",
      evidence: `Missing inputs: ${missingInputs.join(", ")}.`,
    });
  }

  if (degradedShare >= 0.2) {
    calibrationSuggestions.push({
      key: "high_degraded_share",
      priority: missingInputs.length > 0 ? "medium" : "high",
      title: "Reduce degraded queue share",
      detail:
        "A large slice of the queue is trust-capped, so the safer next step is to improve truth coverage before increasing action aggressiveness.",
      evidence: `${degradedActions.length}/${input.actions.length} surfaced actions are degraded.`,
    });
  }

  if ((falsePositiveHotspots[0]?.count ?? 0) >= 2) {
    calibrationSuggestions.push({
      key: "false_positive_hotspot",
      priority: "medium",
      title: "Soften repeated false-positive families",
      detail:
        "Repeated false-positive feedback on the same source family suggests those cases should bias toward review-safe or watchlist handling.",
      evidence: falsePositiveHotspots[0]?.summary ?? "Repeated false-positive hotspots were detected.",
    });
  }

  if (input.feedbackSummary.queueGapCount >= 2) {
    calibrationSuggestions.push({
      key: "queue_gap_hotspot",
      priority: "medium",
      title: "Tune queue coverage before aggressiveness",
      detail:
        "Repeated queue-gap reports indicate missing work is escaping the surfaced queue, so coverage and view logic should be tightened before thresholds move.",
      evidence: `${input.feedbackSummary.queueGapCount} queue-gap report(s) remain open.`,
    });
  }

  if (calibrationSuggestions.length === 0) {
    calibrationSuggestions.push({
      key: "steady_state",
      priority: "low",
      title: "Keep collecting calibration evidence",
      detail:
        "Historical telemetry does not show a dominant calibration hotspot right now. Continue collecting operator feedback before shifting thresholds.",
      evidence: "No repeated degraded, false-positive, or queue-gap pressure exceeded the current guidance thresholds.",
    });
  }

  return {
    selectedWindow: {
      startDate: input.startDate,
      endDate: input.endDate,
      note: "Analysis only. Live decisions and queue selection continue to use the primary decision window.",
    },
    campaignFamilies: buildCampaignFamilies(input.selectedPeriodCampaigns),
    decisionQuality: {
      actionableCount: input.throughput.actionableCount,
      selectedCount: input.throughput.selectedCount,
      overflowCount: input.throughput.overflowCount,
      queueGapCount: input.feedbackSummary.queueGapCount,
      feedbackCount: input.feedbackSummary.totalCount,
      falsePositiveCount: input.feedbackSummary.falsePositiveCount,
      falseNegativeCount: input.feedbackSummary.falseNegativeCount,
      badRecommendationCount: input.feedbackSummary.badRecommendationCount,
      suppressionRates: {
        actionCore: round(
          input.actions.filter((action) => action.surfaceLane === "action_core").length /
            actionCount,
          4,
        ),
        watchlist: round(
          input.actions.filter((action) => action.surfaceLane === "watchlist").length /
            actionCount,
          4,
        ),
        archive: round(
          input.actions.filter((action) => action.surfaceLane === "archive_context").length /
            actionCount,
          4,
        ),
        degraded: round(degradedShare, 4),
      },
      falsePositiveHotspots,
      falseNegativeHotspots,
    },
    degradedGuidance: {
      degradedActionCount: degradedActions.length,
      missingInputs,
      reasons: degradedReasons,
      summary:
        missingInputs.length > 0
          ? `Missing truth still caps ${degradedActions.length} surfaced action(s). Fill ${missingInputs.join(", ")} before raising action aggressiveness.`
          : degradedActions.length > 0
            ? `${degradedActions.length} surfaced action(s) remain trust-capped, so the queue should stay review-safe until stronger truth arrives.`
            : "No degraded queue pressure is currently dominating the surfaced action set.",
    },
    calibrationSuggestions,
  };
}
