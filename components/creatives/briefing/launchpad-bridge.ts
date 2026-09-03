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

export function canOpenBriefingCardInLaunchpad(
  _card: BriefingCreativeCard,
  _mode: LaunchpadBridgeMode,
) {
  // D074b acceptance correction: Launchpad's wizard can reach provider
  // writes, and it does not yet serialize and server-validate the exact
  // source snapshot/evaluation/hash authority tuple. Canonical cards
  // therefore may not fall through to it — and a legacy/manual card is
  // strictly WORSE: it carries no automatic-role provenance at all, so the
  // absence of a blockedActionType is not authority. Every route is
  // review-only until the canonical launch-authority contract exists.
  // Nothing about a card — label text, campaignKind, primary kind — may
  // open a provider-capable flow from the client.
  return false;
}

export function canOpenBriefingCardsInLaunchpad(
  cards: BriefingCreativeCard[],
  mode: LaunchpadBridgeMode,
) {
  return (
    cards.length > 0 &&
    cards.every((card) => canOpenBriefingCardInLaunchpad(card, mode))
  );
}

export function buildLaunchpadBridgeHref(
  card: BriefingCreativeCard | BriefingCreativeCard[],
  mode: LaunchpadBridgeMode,
  options: LaunchpadBridgeHrefOptions = {},
) {
  const cards = Array.isArray(card) ? card : [card];
  if (!canOpenBriefingCardsInLaunchpad(cards, mode)) {
    throw new Error(
      "Launchpad navigation blocked (canonical_launch_authority_contract_required).",
    );
  }
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
  // D074b acceptance correction: the client never derives a provider-capable
  // Launchpad mode. The pre-correction fallbacks — primary-kind passthrough,
  // primary-label TEXT parsing, and `label === "scale" &&
  // campaignKind === "test" → promote` — turned unauthenticated card fields
  // into provider-write routing. A mode may exist again only when the server
  // serializes a validated automatic-role decision plus the exact
  // provider/action authority contract, and canOpenBriefingCardInLaunchpad
  // proves it; until that contract exists this always answers null and the
  // surfaces stay review-only (evidence drawer), which is what they already
  // do for canonical cards.
  const primaryKind = card.primary?.kind?.trim().toLowerCase();
  if (
    primaryKind &&
    LAUNCHPAD_MODES.has(primaryKind as LaunchpadOverlayMode) &&
    canOpenBriefingCardInLaunchpad(card, primaryKind as LaunchpadOverlayMode)
  ) {
    return primaryKind as LaunchpadOverlayMode;
  }
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

// Server-supplied decision-center execution CTA (D019). Display and routing
// only - the UI never derives the action. promote_to_main routes to the
// launchpad promote flow; budget-type actions (scale_budget,
// controlled_scale) intentionally open evidence instead: budget execution
// lives at ad set/campaign level, not on the creative card.
export const EXECUTION_ACTION_DISPLAY: Record<string, string> = {
  promote_to_main: "Promote to main",
  // Budget-type actions open the evidence drawer (budget execution lives at
  // ad set/campaign level), so the copy is review-framed - a button must not
  // promise an action its click does not perform.
  scale_budget: "Review scale budget",
  controlled_scale: "Review structure & scale",
};

export function executionActionDisplay(value: string | null | undefined) {
  if (!value) return null;
  return Object.prototype.hasOwnProperty.call(EXECUTION_ACTION_DISPLAY, value)
    ? EXECUTION_ACTION_DISPLAY[value]
    : null;
}

export function mapExecutionActionToLaunchpadMode(
  value: string | null | undefined,
): LaunchpadOverlayMode | null {
  return value === "promote_to_main" ? "promote" : null;
}
