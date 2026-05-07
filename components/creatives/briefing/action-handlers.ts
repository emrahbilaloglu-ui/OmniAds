import type { DecisionLabel } from "@/components/common/briefing/types";
import type { LaunchpadOverlayMode } from "@/components/common/briefing/LaunchpadOverlay";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import { asDecisionLabel, cardName } from "@/components/creatives/briefing/card-utils";

export interface BriefingToastLink {
  href: string;
  label: string;
}

export interface BriefingToast {
  type: "success" | "error" | "info";
  message: string;
  link?: BriefingToastLink | null;
}

export interface PauseBriefingCardResult {
  ok: boolean;
  action?: string;
  adId?: string | null;
  status?: string | null;
  adsManagerUrl?: string | null;
}

type FetchLike = typeof fetch;

export function getCreativeScopeId(card: BriefingCreativeCard) {
  return card.creativeId?.trim() || card.id;
}

export function getBriefingAdActionInputId(card: BriefingCreativeCard) {
  return (
    card.realAdId?.trim() ||
    card.adId?.trim() ||
    card.metaAdId?.trim() ||
    card.effectiveAdId?.trim() ||
    card.creativeId?.trim() ||
    card.id
  );
}

export function isCutPrimaryAction(card: BriefingCreativeCard) {
  const primaryKind = card.primary?.kind?.trim().toLowerCase();
  const primaryLabel = card.primary?.label?.trim().toLowerCase();
  const label = asDecisionLabel(card.label) as DecisionLabel;
  return (
    primaryKind === "cut" ||
    primaryKind === "pause" ||
    primaryLabel === "cut" ||
    (!primaryKind && label === "cut")
  );
}

export function buildMetaAdsManagerUrlForBriefingCard(
  card: BriefingCreativeCard,
  resolvedAdId?: string | null,
) {
  const accountId = (
    card.providerAccountId ||
    card.accountId ||
    card.metaAccountId ||
    ""
  )
    .replace(/^act_/, "")
    .trim();
  const adId = (
    resolvedAdId ||
    card.realAdId ||
    card.adId ||
    card.metaAdId ||
    card.effectiveAdId ||
    ""
  ).trim();
  if (!accountId || !adId) return null;
  const params = new URLSearchParams({
    act: accountId,
    selected_ad_ids: adId,
  });
  return `https://adsmanager.facebook.com/adsmanager/manage/ads/edit?${params.toString()}`;
}

export function buildCutSuccessToast(
  card: BriefingCreativeCard,
  result: PauseBriefingCardResult,
): BriefingToast {
  return {
    type: "success",
    message: `Cut applied · ${cardName(card)}`,
    link: buildMetaAdsManagerUrlForBriefingCard(card, result.adId) ?
      {
        href: buildMetaAdsManagerUrlForBriefingCard(card, result.adId)!,
        label: "Open in Meta",
      }
      : null,
  };
}

export function buildLaunchpadOpenToast(mode: LaunchpadOverlayMode): BriefingToast {
  return {
    type: "info",
    message: `Launchpad bridge opened · ${mode.replace(/_/g, " ")}`,
  };
}

export async function pauseBriefingCard(input: {
  businessId: string;
  card: BriefingCreativeCard;
  fetchImpl?: FetchLike;
}): Promise<PauseBriefingCardResult> {
  const targetId = getBriefingAdActionInputId(input.card);
  const fetcher = input.fetchImpl ?? fetch;
  const response = await fetcher(`/api/meta/ads/${encodeURIComponent(targetId)}/pause`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify({ businessId: input.businessId }),
  });
  const payload = (await response.json().catch(() => null)) as
    | (PauseBriefingCardResult & { error?: { message?: string } })
    | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message ?? `Pause failed (${response.status})`);
  }
  return payload;
}
