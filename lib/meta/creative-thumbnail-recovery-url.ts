/** The authenticated thumbnail read is scoped to an observed business/account/creative. */
export function metaCreativeThumbnailRecoveryUrl(input: {
  businessId: string;
  providerAccountId: string | null | undefined;
  creativeId: string | null | undefined;
}): string | null {
  if (!/^act_\d+$/.test(input.providerAccountId ?? "") ||
      !/^\d+$/.test(input.creativeId ?? "")) return null;
  return `/api/meta/creative-thumbnail?${new URLSearchParams({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId!,
    creativeId: input.creativeId!,
  })}`;
}
