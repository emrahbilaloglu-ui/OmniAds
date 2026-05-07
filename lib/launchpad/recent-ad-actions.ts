import type { MetaCreativeRow } from "@/components/creatives/metricConfig";

export interface LaunchpadRecentAdAction {
  action: "launch_ad" | "duplicate";
  requestedAt: string;
  sourceAdId: string | null;
  sourceName: string | null;
  resultingAdId: string;
  creativeId: string | null;
  adName: string | null;
  status: string | null;
  accountId: string | null;
  targetCampaignId: string | null;
  targetCampaignName: string | null;
  targetAdsetId: string | null;
  targetAdsetName: string | null;
}

export function resolveLaunchpadAdActionId(row: MetaCreativeRow) {
  return row.realAdId?.trim() || row.id;
}

export function applyRecentAdActionsToRows(
  rows: MetaCreativeRow[],
  actions: LaunchpadRecentAdAction[],
  currency: string,
) {
  if (actions.length === 0) return rows;
  const actionByAdId = new Map(
    actions
      .filter((action) => action.resultingAdId?.trim())
      .map((action) => [action.resultingAdId.trim(), action]),
  );
  const sourceByCreativeId = new Map<string, MetaCreativeRow>();
  const sourceByAdId = new Map<string, MetaCreativeRow>();
  rows.forEach((row) => {
    if (!sourceByCreativeId.has(row.creativeId)) sourceByCreativeId.set(row.creativeId, row);
    const adId = resolveLaunchpadAdActionId(row);
    if (adId && !sourceByAdId.has(adId)) sourceByAdId.set(adId, row);
  });
  const seenAdIds = new Set<string>();
  const annotated = rows.map((row) => {
    const adId = resolveLaunchpadAdActionId(row);
    const action = actionByAdId.get(adId);
    if (!action) return row;
    seenAdIds.add(action.resultingAdId);
    const source =
      action.sourceAdId
        ? sourceByAdId.get(action.sourceAdId) ?? null
        : action.creativeId
          ? sourceByCreativeId.get(action.creativeId) ?? null
          : null;
    const sourceDisplayName = source?.name ?? action.sourceName ?? null;
    return {
      ...row,
      name: sourceDisplayName ?? row.name,
      launchpadRecentAction: {
        action: action.action,
        requestedAt: action.requestedAt,
        resultingAdId: action.resultingAdId,
        sourceAdId: action.sourceAdId,
        sourceName: sourceDisplayName,
        targetCampaignId: action.targetCampaignId,
        targetCampaignName: action.targetCampaignName,
        targetAdsetId: action.targetAdsetId,
        targetAdsetName: action.targetAdsetName,
      },
    };
  });
  const syntheticRows = actions.flatMap((action): MetaCreativeRow[] => {
    if (!action.resultingAdId || seenAdIds.has(action.resultingAdId)) return [];
    const source =
      action.sourceAdId
        ? sourceByAdId.get(action.sourceAdId) ?? null
        : action.creativeId
          ? sourceByCreativeId.get(action.creativeId) ?? null
          : null;
    if (!source && !action.creativeId && !action.sourceName) return [];
    const creativeId = action.creativeId ?? source?.creativeId ?? action.resultingAdId;
    const sourceDisplayName = source?.name ?? action.sourceName ?? null;
    return [
      {
        ...(source ?? {
          id: `recent:${action.resultingAdId}`,
          creativeId,
          name: sourceDisplayName ?? action.adName ?? `Meta ad ${action.resultingAdId}`,
          associatedAdsCount: 1,
          accountId: action.accountId,
          accountName: null,
          currency,
          format: "image" as const,
          creativeType: "feed" as const,
          creativeTypeLabel: "Feed",
          creativeDeliveryType: "standard" as const,
          creativeVisualFormat: "image" as const,
          creativePrimaryType: "standard" as const,
          creativePrimaryLabel: "Standard",
          creativeSecondaryType: null,
          creativeSecondaryLabel: null,
          thumbnailUrl: null,
          previewUrl: null,
          imageUrl: null,
          isCatalog: false,
          previewState: "unavailable" as const,
          preview: {
            render_mode: "unavailable" as const,
            image_url: null,
            video_url: null,
            poster_url: null,
            source: null,
            is_catalog: false,
          },
          launchDate: action.requestedAt.slice(0, 10),
          tags: [],
          aiTags: {},
          spend: 0,
          purchaseValue: 0,
          roas: 0,
          cpa: 0,
          cpcLink: 0,
          cpm: 0,
          ctrAll: 0,
          linkCtr: 0,
          purchases: 0,
          impressions: 0,
          clicks: 0,
          linkClicks: 0,
          landingPageViews: 0,
          addToCart: 0,
          initiateCheckout: 0,
          leads: 0,
          messages: 0,
          thumbstop: 0,
          clickToAddToCart: 0,
          clickToPurchase: 0,
          seeMoreRate: 0,
          video25: 0,
          video50: 0,
          video75: 0,
          video100: 0,
          atcToPurchaseRatio: 0,
        }),
        id: `recent:${action.resultingAdId}`,
        realAdId: action.resultingAdId,
        creativeId,
        name: sourceDisplayName ?? action.adName ?? `Meta ad ${action.resultingAdId}`,
        accountId: action.accountId ?? source?.accountId ?? null,
        campaignId: action.targetCampaignId,
        campaignName: action.targetCampaignName,
        adSetId: action.targetAdsetId,
        adSetName: action.targetAdsetName,
        effectiveStatus: action.status ?? "PAUSED",
        launchDate: action.requestedAt.slice(0, 10),
        spend: 0,
        purchaseValue: 0,
        roas: 0,
        cpa: 0,
        cpcLink: 0,
        cpm: 0,
        ctrAll: 0,
        linkCtr: 0,
        purchases: 0,
        impressions: 0,
        clicks: 0,
        linkClicks: 0,
        landingPageViews: 0,
        addToCart: 0,
        initiateCheckout: 0,
        leads: 0,
        messages: 0,
        thumbstop: 0,
        clickToAddToCart: 0,
        clickToPurchase: 0,
        seeMoreRate: 0,
        video25: 0,
        video50: 0,
        video75: 0,
        video100: 0,
        atcToPurchaseRatio: 0,
        launchpadRecentAction: {
          action: action.action,
          requestedAt: action.requestedAt,
          resultingAdId: action.resultingAdId,
          sourceAdId: action.sourceAdId,
          sourceName: sourceDisplayName,
          targetCampaignId: action.targetCampaignId,
          targetCampaignName: action.targetCampaignName,
          targetAdsetId: action.targetAdsetId,
          targetAdsetName: action.targetAdsetName,
        },
      },
    ];
  });
  return [...annotated, ...syntheticRows];
}
