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
  dryRun?: boolean;
  adsManagerUrl?: string | null;
  attemptedIds?: string[];
}

type FetchLike = typeof fetch;

export function getCreativeScopeId(card: BriefingCreativeCard) {
  return card.creativeId?.trim() || card.id;
}

function nonEmptyId(value: string | null | undefined) {
  const id = value?.trim();
  return id ? id : null;
}

function uniqueIds(ids: Array<string | null | undefined>) {
  const seen = new Set<string>();
  return ids.flatMap((id) => {
    const normalized = nonEmptyId(id);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}

export function getBriefingAdActionCandidateIds(card: BriefingCreativeCard) {
  return uniqueIds([
    card.realAdId,
    card.metaAdId,
    card.effectiveAdId,
    card.adId,
    card.creativeId,
    card.id,
  ]);
}

export function getBriefingAdActionInputId(card: BriefingCreativeCard) {
  return getBriefingAdActionCandidateIds(card)[0] ?? "";
}

export function isCutPrimaryAction(card: BriefingCreativeCard) {
  const primaryKind = card.primary?.kind?.trim().toLowerCase();
  const primaryLabel = card.primary?.label?.trim().toLowerCase();
  const label = asDecisionLabel(card.label) as DecisionLabel;
  return (
    primaryKind === "cut" ||
    primaryKind === "pause" ||
    primaryKind?.includes("pause") ||
    primaryLabel === "cut" ||
    primaryLabel?.includes("pause") ||
    (!primaryKind && label === "cut")
  );
}

function isAdNotFoundResponse(payload: { error?: { code?: string } } | null) {
  return payload?.error?.code === "ad_not_found";
}

export function metaAdActionFailureMessage(
  payload: { error?: { code?: string; message?: string }; message?: string } | null,
  status: number,
) {
  if (payload?.error?.code === "kill_switch_engaged") {
    return "Meta writes are temporarily disabled (kill switch). Try again later.";
  }
  return payload?.error?.message ?? payload?.message ?? `Pause failed (${status})`;
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
  if (result.dryRun) {
    return {
      type: "info",
      message: `Dry run completed · ${cardName(card)}`,
      link: null,
    };
  }
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
  if (!isCutPrimaryAction(input.card)) {
    throw new Error("This card does not carry a server-authorized cut action.");
  }
  const candidateIds = getBriefingAdActionCandidateIds(input.card);
  const fetcher = input.fetchImpl ?? fetch;
  if (candidateIds.length === 0) {
    throw new Error("No actionable Meta ad id was available for this creative.");
  }

  const attemptedIds: string[] = [];
  let lastMessage = "Pause failed.";
  for (const targetId of candidateIds) {
    attemptedIds.push(targetId);
    const response = await fetcher(`/api/meta/ads/${encodeURIComponent(targetId)}/pause`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        businessId: input.businessId,
        recIdOrigin: getCreativeScopeId(input.card),
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | (PauseBriefingCardResult & { error?: { code?: string; message?: string } })
      | null;
    if (response.ok && payload?.ok) {
      return { ...payload, attemptedIds };
    }

    const message = metaAdActionFailureMessage(payload, response.status);
    lastMessage = message;
    if (isAdNotFoundResponse(payload)) {
      continue;
    }
    throw new Error(message);
  }

  throw new Error(`${lastMessage} Tried ${attemptedIds.join(", ")}.`);
}
