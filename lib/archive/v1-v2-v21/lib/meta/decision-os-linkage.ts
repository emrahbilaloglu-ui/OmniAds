import type { CreativeDecisionOsV1Response } from "@/lib/creative-decision-os";
import type { MetaDecisionOsV1Response } from "@/lib/meta/decision-os";

function summarizeCreativeCandidates(labels: string[]) {
  if (labels.length === 0) return null;
  return {
    count: labels.length,
    labels,
    summary:
      labels.length === 1
        ? `${labels[0]} is aligned as the current creative candidate for this lane.`
        : `${labels.length} creative candidates are aligned for this lane: ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? "..." : ""}`,
  };
}

export function attachCreativeLinkage(
  metaPayload: MetaDecisionOsV1Response,
  creativePayload: CreativeDecisionOsV1Response,
): MetaDecisionOsV1Response {
  const queueReadyCreatives = creativePayload.creatives.filter(
    (creative) =>
      creative.deployment.queueVerdict === "queue_ready" ||
      creative.deployment.queueVerdict === "board_only",
  );
  const blockedCreativeAsks = creativePayload.creatives.filter(
    (creative) =>
      creative.deployment.queueVerdict === "blocked" ||
      creative.primaryAction === "refresh_replace" ||
      creative.primaryAction === "keep_in_test",
  );
  const matchedCampaigns = metaPayload.campaigns.map((campaign) => {
    const lane = campaign.laneLabel;
    const creativeLabels = queueReadyCreatives
      .filter((creative) =>
        lane
          ? creative.deployment.targetLane === lane
          : creative.deployment.targetLane === null,
      )
      .slice(0, 4)
      .map((creative) => creative.name);
    const missingCreativeAsk = blockedCreativeAsks
      .filter((creative) =>
        lane
          ? creative.deployment.targetLane === lane ||
            (creative.deployment.eligibleLanes ?? []).includes(lane)
          : creative.deployment.targetLane === null,
      )
      .slice(0, 2)
      .map((creative) => creative.deployment.blockedReasons?.[0] ?? creative.summary);

    return {
      ...campaign,
      creativeCandidates: summarizeCreativeCandidates(creativeLabels),
      missingCreativeAsk,
    };
  });

  const matchedOpportunities = metaPayload.opportunityBoard.map((item) => {
    const desiredLane =
      item.kind === "campaign_winner_scale" || item.kind === "adset_winner_scale"
        ? "Scaling"
        : item.kind === "geo"
          ? "Validation"
          : null;
    const creativeCandidates = queueReadyCreatives
      .filter((creative) =>
        desiredLane ? creative.deployment.targetLane === desiredLane : true,
      )
      .slice(0, 4)
      .map((creative) => creative.name);
    const missingCreativeAsk = blockedCreativeAsks
      .filter((creative) =>
        desiredLane
          ? creative.deployment.targetLane === desiredLane ||
            (creative.deployment.eligibleLanes ?? []).includes(desiredLane)
          : true,
      )
      .slice(0, 2)
      .map((creative) => creative.deployment.blockedReasons?.[0] ?? creative.summary);

    return {
      ...item,
      creativeCandidates,
      missingCreativeAsk,
      queueVerdict: item.eligibilityTrace?.verdict,
    };
  });

  return {
    ...metaPayload,
    campaigns: matchedCampaigns,
    opportunityBoard: matchedOpportunities,
  };
}
