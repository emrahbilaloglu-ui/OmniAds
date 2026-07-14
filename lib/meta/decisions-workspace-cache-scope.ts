import { createHash } from "node:crypto";
import type { MetaCurrentAdStatusSourceRow } from "@/lib/meta/decisions-workspace-read-model";

export function normalizeMetaDecisionCampaignContextIds(input: {
  currentAds: readonly MetaCurrentAdStatusSourceRow[];
  structureCampaignIds: readonly (string | null | undefined)[];
}): string[] {
  return [
    ...new Set(
      [
        ...input.currentAds.map((row) => row.campaignId),
        ...input.structureCampaignIds,
      ]
        .map((campaignId) => campaignId?.trim() ?? "")
        .filter(Boolean),
    ),
  ].sort();
}

export function metaDecisionCampaignContextScopeKey(
  campaignIds: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(campaignIds))
    .digest("hex")
    .slice(0, 24);
}
