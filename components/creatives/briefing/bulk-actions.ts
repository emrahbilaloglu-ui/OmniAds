import type {
  CompareDrawerItem,
} from "@/components/common/briefing/CompareDrawer";
import {
  buildLaunchpadBridgeHref,
  type LaunchpadBridgeMode,
} from "@/components/creatives/briefing/launchpad-bridge";
import {
  buildBriefingDecisionOriginAdActionRequest,
  getBriefingAdActionInputId,
  getCreativeScopeId,
  getManualBriefingAdActionCandidateIds,
  hasNativeDecisionOriginLineage,
  isCutPrimaryAction,
  type DecisionOriginBriefingCard,
} from "@/components/creatives/briefing/action-handlers";
import {
  asDecisionLabel,
  cardId,
  cardName,
  numberOrZero,
} from "@/components/creatives/briefing/card-utils";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import { DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION } from "@/lib/creative-decision-engine/execution-safety";

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

function cleanErrorMessage(value: string | null | undefined) {
  const message = value?.trim();
  return message ? message : null;
}

export function summarizeBulkPauseFailure(result: BulkPauseResult) {
  const failedResults = (result.results ?? []).filter((item) => !item.ok);
  const firstFailure = failedResults[0];
  const firstResultMessage = cleanErrorMessage(firstFailure?.error?.message);
  if (firstResultMessage) {
    const suffix =
      failedResults.length > 1 ? ` (+${failedResults.length - 1} more)` : "";
    return `${firstResultMessage}${suffix}`;
  }
  const firstErrorMessage = cleanErrorMessage(result.errors?.[0]?.message);
  if (firstErrorMessage) return firstErrorMessage;
  if (result.failedCount) return `Bulk cut failed for ${result.failedCount} creatives.`;
  return "Bulk cut failed.";
}

export function successfulBulkPauseCardIds(
  cards: BriefingCreativeCard[],
  result: BulkPauseResult,
) {
  const successfulResults = (result.results ?? []).filter((item) => item.ok);
  if (successfulResults.length === 0) return [];
  return cards.flatMap((card) => {
    const candidateIds = getManualBriefingAdActionCandidateIds(card);
    const candidateIdSet = new Set(candidateIds);
    const inputAdId = getBriefingAdActionInputId(card) || candidateIds[0];
    if (!inputAdId) return [];

    const matched = successfulResults.some((item) => {
      if (item.inputAdId?.trim() !== inputAdId) return false;
      const resolvedAdId = item.adId?.trim();
      if (!resolvedAdId || resolvedAdId === inputAdId) return true;
      if (hasNativeDecisionOriginLineage(card)) return false;
      if (candidateIdSet.has(resolvedAdId)) return true;
      const resolvedFromCandidate = item.attemptedIds?.at(-1)?.trim();
      return Boolean(
        resolvedFromCandidate && candidateIdSet.has(resolvedFromCandidate),
      );
    });
    return matched ? [cardId(card)] : [];
  });
}

export function buildBulkPauseRequestBody(input: {
  businessId: string;
  cards: DecisionOriginBriefingCard[];
  idempotencyKey?: string;
}) {
  input.cards.forEach((card) => {
    if (!isCutPrimaryAction(card)) {
      throw new Error("Every bulk card must carry a server-authorized cut action.");
    }
  });
  const nativeLineageCount = input.cards.filter(
    hasNativeDecisionOriginLineage,
  ).length;
  if (nativeLineageCount > 0 && nativeLineageCount < input.cards.length) {
    throw new Error(
      "Bulk cut cannot mix native decision lineage with legacy briefing cards.",
    );
  }

  if (nativeLineageCount === 0) {
    const adsById = new Map<
      string,
      {
        adId: string;
        candidateAdIds: string[];
        creativeId: string;
        name: string | null;
      }
    >();
    input.cards.forEach((card) => {
      const candidateAdIds = getManualBriefingAdActionCandidateIds(card);
      const adId = candidateAdIds[0] ?? "";
      if (!adId) {
        throw new Error(
          "Every legacy bulk card requires at least one Meta ad candidate.",
        );
      }
      adsById.set(adId, {
        adId,
        candidateAdIds,
        creativeId: getCreativeScopeId(card),
        name: cardName(card),
      });
    });
    const ads = Array.from(adsById.values());
    const providerAccountIds = new Set(
      input.cards
        .map((card) => card.providerAccountId?.trim())
        .filter((value): value is string => Boolean(value)),
    );
    if (providerAccountIds.size > 1) {
      throw new Error(
        "Bulk legacy execution requires exactly one provider account.",
      );
    }
    const stableBulkKey = `manual-legacy-bulk-pause:${input.businessId}:${ads
      .map((ad) => ad.adId)
      .sort()
      .join("|")}`;
    return {
      businessId: input.businessId,
      providerAccountId: Array.from(providerAccountIds)[0],
      action: "pause" as const,
      idempotencyKey: input.idempotencyKey?.trim() || stableBulkKey,
      ads,
    };
  }

  const adsById = new Map<
    string,
    ReturnType<typeof buildBriefingDecisionOriginAdActionRequest> & {
      name: string | null;
    }
  >();
  input.cards.forEach((card) => {
    const request = buildBriefingDecisionOriginAdActionRequest({
      businessId: input.businessId,
      card,
      action: "pause",
    });
    const existing = adsById.get(request.adId);
    const next = { ...request, name: cardName(card) };
    if (existing && existing.idempotencyKey !== next.idempotencyKey) {
      throw new Error(
        `Conflicting decision lineage was supplied for ad ${request.adId}.`,
      );
    }
    adsById.set(request.adId, next);
  });

  const ads = Array.from(adsById.values());
  const providerAccountIds = new Set(
    ads.map((ad) => ad.providerAccountId),
  );
  if (providerAccountIds.size !== 1) {
    throw new Error(
      "Bulk decision-origin execution requires exactly one provider account.",
    );
  }
  const stableBulkKey = `decision-origin-bulk-pause:${ads
    .map((ad) => ad.idempotencyKey)
    .sort()
    .join("|")}`;

  return {
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: input.businessId,
    providerAccountId: ads[0]?.providerAccountId ?? "",
    action: "pause",
    idempotencyKey: input.idempotencyKey?.trim() || stableBulkKey,
    ads,
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
