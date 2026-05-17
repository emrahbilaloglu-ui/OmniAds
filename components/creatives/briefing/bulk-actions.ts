import type {
  CompareDrawerItem,
} from "@/components/common/briefing/CompareDrawer";
import {
  buildLaunchpadBridgeHref,
  type LaunchpadBridgeMode,
} from "@/components/creatives/briefing/launchpad-bridge";
import {
  getBriefingAdActionCandidateIds,
  getBriefingAdActionInputId,
  getCreativeScopeId,
} from "@/components/creatives/briefing/action-handlers";
import {
  asDecisionLabel,
  cardName,
  numberOrZero,
} from "@/components/creatives/briefing/card-utils";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

type FetchLike = typeof fetch;

export interface BulkPauseResult {
  ok: boolean;
  action?: string;
  status?: string;
  successCount?: number;
  failedCount?: number;
  results?: Array<{
    inputAdId: string;
    adId?: string;
    creativeId?: string | null;
    ok: boolean;
    status?: string;
    attemptedIds?: string[];
    error?: { code: string; message: string };
  }>;
  errors?: Array<{ code?: string; message: string }>;
}

export function buildBulkPauseRequestBody(input: {
  businessId: string;
  cards: BriefingCreativeCard[];
  idempotencyKey?: string;
}) {
  const adsById = new Map<
    string,
    {
      adId: string;
      candidateAdIds: string[];
      creativeId: string | null;
      name: string | null;
    }
  >();
  input.cards.forEach((card) => {
    const adId = getBriefingAdActionInputId(card).trim();
    if (!adId) return;
    adsById.set(adId, {
      adId,
      candidateAdIds: getBriefingAdActionCandidateIds(card),
      creativeId: getCreativeScopeId(card),
      name: cardName(card),
    });
  });

  return {
    businessId: input.businessId,
    action: "pause",
    idempotencyKey:
      input.idempotencyKey ?? `briefing-bulk-pause-${Date.now()}-${adsById.size}`,
    ads: Array.from(adsById.values()),
  };
}

export async function pauseBriefingCardsBulk(input: {
  businessId: string;
  cards: BriefingCreativeCard[];
  trackingBlocked?: boolean;
  idempotencyKey?: string;
  fetchImpl?: FetchLike;
}): Promise<BulkPauseResult> {
  const fetcher = input.fetchImpl ?? fetch;
  const body = buildBulkPauseRequestBody({
    businessId: input.businessId,
    cards: input.cards,
    idempotencyKey: input.idempotencyKey,
  });
  const response = await fetcher("/api/launchpad/meta/bulk-ad-status", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | (BulkPauseResult & { error?: { code?: string; message?: string } })
    | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Bulk pause failed (${response.status})`);
  }
  return {
    ok: Boolean(payload?.ok),
    action: payload?.action,
    status: payload?.status,
    successCount: payload?.successCount,
    failedCount: payload?.failedCount,
    results: payload?.results ?? [],
    errors: payload?.error
      ? [{ code: payload.error.code, message: payload.error.message ?? "Bulk pause failed." }]
      : payload?.errors,
  };
}

export function buildBulkLaunchpadHref(
  cards: BriefingCreativeCard[],
  mode: LaunchpadBridgeMode,
  options?: { basePath?: string },
) {
  return buildLaunchpadBridgeHref(cards, mode, options);
}

export function buildCompareDrawerItems(cards: BriefingCreativeCard[]): CompareDrawerItem[] {
  return cards.map((card) => ({
    id: getCreativeScopeId(card),
    name: cardName(card),
    brand: card.brand || undefined,
    label: asDecisionLabel(card.label),
    spend: numberOrZero(card.spend),
    roas: numberOrZero(card.roas),
    ctr: numberOrZero(card.ctr),
    cpa: numberOrZero(card.cpa),
    purchases: numberOrZero(card.purchases),
    frequency: numberOrZero(card.frequency),
    sparkline: card.sparkline ?? undefined,
    mediaPreviewUrl: card.mediaPreviewUrl ?? null,
    thumbnailUrl: card.thumbnailUrl ?? null,
    tableThumbnailUrl: card.tableThumbnailUrl ?? null,
    cardPreviewUrl: card.cardPreviewUrl ?? null,
    previewUrl: card.previewUrl ?? null,
    imageUrl: card.imageUrl ?? null,
    cachedThumbnailUrl: card.cachedThumbnailUrl ?? null,
    preview: card.preview ?? null,
    format: card.format ?? null,
    creativeVisualFormat: card.creativeVisualFormat ?? null,
    creativePrimaryType: card.creativePrimaryType ?? null,
    creativePrimaryLabel: card.creativePrimaryLabel ?? null,
    creativeSecondaryType: card.creativeSecondaryType ?? null,
    creativeSecondaryLabel: card.creativeSecondaryLabel ?? null,
    creativeDeliveryType: card.creativeDeliveryType ?? null,
    isCatalog: card.isCatalog ?? null,
  }));
}

export function weakestByRoas(cards: BriefingCreativeCard[]) {
  return cards.reduce<BriefingCreativeCard | null>((weakest, card) => {
    if (!weakest) return card;
    return numberOrZero(card.roas) < numberOrZero(weakest.roas) ? card : weakest;
  }, null);
}

export function strongestByRoas(cards: BriefingCreativeCard[]) {
  return cards.reduce<BriefingCreativeCard | null>((strongest, card) => {
    if (!strongest) return card;
    return numberOrZero(card.roas) > numberOrZero(strongest.roas) ? card : strongest;
  }, null);
}
