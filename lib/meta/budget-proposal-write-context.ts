/**
 * D088 C1 — the Meta write context a budget execution needs, built from the
 * EXISTING credential boundary.
 *
 * `MetaAdsWriteContext` requires a token AND the connection generation it was
 * read under, because the pre-POST authority check compares that generation
 * again. Building it here, once, means the runtime never assembles a partial
 * context — and when the credential or the generation is unavailable it returns
 * `null` rather than a context missing the field the guard depends on.
 */
import { getMetaAccountContext } from "@/lib/meta/account-context";
import type { MetaAdsWriteContext } from "@/lib/meta/ads-write";

export async function buildMetaWriteContextForProposal(input: {
  businessId: string;
  providerAccountId: string;
}): Promise<MetaAdsWriteContext | null> {
  const context = await getMetaAccountContext(input.businessId).catch(() => null);
  if (!context) return null;
  const credentials = context as unknown as {
    accessToken?: string | null;
    connectionGeneration?: string | null;
    accountProfiles?: Record<string, unknown>;
  };
  const accessToken = credentials.accessToken?.trim() ?? "";
  const connectionGeneration = credentials.connectionGeneration?.trim() ?? "";
  // The account must still be one this business holds, and BOTH authority
  // fields must be present: an absent generation is the "nothing to check"
  // state the write guard exists to refuse.
  if (!accessToken || !connectionGeneration) return null;
  if (!credentials.accountProfiles?.[input.providerAccountId]) return null;
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    accessToken,
    connectionGeneration,
  };
}
