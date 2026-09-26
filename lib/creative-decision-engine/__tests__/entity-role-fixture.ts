import type { AdDecisionInput } from "../types";
import type { CampaignContextMap } from "../campaign-context/source";
import {
  adsetRoleKey,
  declaredEntityRoleEntry,
  ENTITY_ROLE_DECLARATION_CONTRACT_VERSION,
} from "../campaign-context/entity-role";

/**
 * D118 test fixture — each Ad's OWN ad set role, as an explicit declaration
 * built through the production projection.
 *
 * An Ad's role-dependent authority reads its ad set, never its campaign, so a
 * fixture that means "this Ad's role is fully trusted" must name the ad set's
 * declaration. A trusted campaign context alone now reaches an Ad only as a
 * capped suggestion.
 */
export function declaredAdsetRoleMap(
  adInputs: ReadonlyArray<
    Pick<AdDecisionInput, "providerAccountId" | "adsetId" | "campaignId">
  >,
  input: { businessId: string; asOf: string; role?: "main" | "test" },
): CampaignContextMap {
  const entries = new Map<string, ReturnType<typeof declaredEntityRoleEntry>>();
  for (const ad of adInputs) {
    const adsetId = ad.adsetId?.trim();
    if (!adsetId) continue;
    entries.set(
      adsetRoleKey(ad.providerAccountId, adsetId),
      declaredEntityRoleEntry({
        mode: "automatic",
        declaration: {
          id: `declaration-${ad.providerAccountId}-${adsetId}`,
          businessId: input.businessId,
          providerAccountId: ad.providerAccountId,
          entityType: "adset",
          entityId: adsetId,
          parentCampaignId: ad.campaignId ?? null,
          event: "declare",
          declaredRole: input.role ?? "main",
          effectiveFrom: input.asOf,
          declaredAt: `${input.asOf}T00:30:00.000Z`,
          declaredBy: "operator-fixture",
          reason: null,
          contractVersion: ENTITY_ROLE_DECLARATION_CONTRACT_VERSION,
        },
      }),
    );
  }
  return entries;
}
