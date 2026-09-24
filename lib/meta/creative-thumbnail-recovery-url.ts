/** The authenticated thumbnail read is scoped to an observed business/account/creative. */
export function metaCreativeThumbnailRecoveryUrl(input: {
  businessId: string;
  providerAccountId: string | null | undefined;
  creativeId: string | null | undefined;
  adId?: string | null | undefined;
  providerAccountRefId?: string | null | undefined;
}): string | null {
  if (!/^act_\d+$/.test(input.providerAccountId ?? "") ||
      !/^\d+$/.test(input.creativeId ?? "")) return null;
  const params = new URLSearchParams({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId!,
    creativeId: input.creativeId!,
  });
  if (/^\d+$/.test(input.adId ?? "") &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        input.providerAccountRefId ?? "",
      )) {
    params.set("adId", input.adId!);
    params.set("providerAccountRefId", input.providerAccountRefId!);
  }
  return `/api/meta/creative-thumbnail?${params}`;
}
