import type {
  LaunchpadOverlayItem,
  LaunchpadOverlayMode,
} from "@/components/common/briefing/LaunchpadOverlay";
import type { DecisionLabel } from "@/components/common/briefing/types";
import {
  asDecisionLabel,
  cardAdset,
  cardCampaign,
  cardName,
} from "@/components/creatives/briefing/card-utils";
import { getCreativeScopeId } from "@/components/creatives/briefing/action-handlers";
import type {
  BriefingCreativeCard,
  BriefingPlacement,
} from "@/components/creatives/briefing/types";

export type LaunchpadBridgeMode = LaunchpadOverlayMode | "add_existing";

const LAUNCHPAD_MODES = new Set<LaunchpadOverlayMode>([
  "promote",
  "demote",
  "fresh_test",
  "rebuild",
  "duplicate",
  "apply_bid",
]);

interface LaunchpadBridgeHrefOptions {
  basePath?: string;
}

export interface LaunchpadOpenPayload {
  card: BriefingCreativeCard;
  mode: LaunchpadOverlayMode;
}

export function buildLaunchpadBridgeHref(
  card: BriefingCreativeCard | BriefingCreativeCard[],
  mode: LaunchpadBridgeMode,
  options: LaunchpadBridgeHrefOptions = {},
) {
  const basePath = options.basePath ?? "/platforms/meta/launchpad";
  const creativeIds = Array.isArray(card)
    ? Array.from(new Set(card.flatMap(getLaunchpadBridgeCreativeIds)))
    : getLaunchpadBridgeCreativeIds(card);
  const params = [
    ["creativeIds", creativeIds.map(encodeURIComponent).join(",")],
    ["mode", encodeURIComponent(mode)],
    ["fromBriefing", "true"],
  ];
  return `${basePath}?${params.map(([key, value]) => `${key}=${value}`).join("&")}`;
}

export function mapBriefingPrimaryToLaunchpadMode(
  card: BriefingCreativeCard,
): LaunchpadOverlayMode | null {
  const primaryKind = card.primary?.kind?.trim().toLowerCase();
  if (primaryKind && LAUNCHPAD_MODES.has(primaryKind as LaunchpadOverlayMode)) {
    return primaryKind as LaunchpadOverlayMode;
  }

  const primaryLabel = card.primary?.label?.trim().toLowerCase() ?? "";
  if (primaryLabel.includes("fresh test")) return "fresh_test";
  if (primaryLabel.includes("promote")) return "promote";
  if (primaryLabel.includes("demote")) return "demote";
  if (primaryLabel.includes("rebuild")) return "rebuild";
  if (primaryLabel.includes("duplicate")) return "duplicate";

  const label = asDecisionLabel(card.label) as DecisionLabel;
  if (label === "scale" && card.campaignKind === "test") return "promote";
  if (label === "test_more") return "fresh_test";
  if (label === "rebuild") return "rebuild";

  return null;
}

export function buildLaunchpadOverlayItem(
  card: BriefingCreativeCard,
): LaunchpadOverlayItem {
  return {
    id: getCreativeScopeId(card),
    name: cardName(card),
    scopeName: card.bestPlacement || cardAdset(card),
    brand: card.brand || undefined,
    campaign: cardCampaign(card),
    label: asDecisionLabel(card.label),
  };
}

export function getLaunchpadBridgeCreativeIds(card: BriefingCreativeCard) {
  const placementIds = shouldUseRollupPlacementIds(card)
    ? (card.placementList ?? []).map(placementCreativeId).filter(Boolean)
    : [];
  const ids = placementIds.length > 0 ? placementIds : [getCreativeScopeId(card)];
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

function shouldUseRollupPlacementIds(card: BriefingCreativeCard) {
  const placements = card.placementList ?? [];
  if (placements.length === 0 || card.mixed) return false;
  const labels = new Set(
    placements
      .map((placement) => placement.label)
      .filter(Boolean)
      .map((label) => asDecisionLabel(label)),
  );
  return labels.size <= 1;
}

function placementCreativeId(placement: BriefingPlacement) {
  return (
    placement.creativeId?.trim() ||
    placement.creative_id?.trim() ||
    placement.id?.trim() ||
    ""
  );
}
