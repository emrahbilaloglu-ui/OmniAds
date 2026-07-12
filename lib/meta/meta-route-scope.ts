export interface MetaRouteScope {
  businessId?: string | null;
  providerAccountId?: string | null;
}

export function buildMetaScopedHref(
  href: string,
  scope: MetaRouteScope,
  extraParams: Record<string, string | null | undefined> = {},
): string {
  const [hrefWithoutHash, hash = ""] = href.split("#", 2);
  const [pathname, rawQuery = ""] = hrefWithoutHash.split("?", 2);
  const params = new URLSearchParams(rawQuery);
  const businessId = scope.businessId?.trim();
  const providerAccountId = scope.providerAccountId?.trim();

  if (businessId) params.set("businessId", businessId);
  if (providerAccountId) params.set("providerAccountId", providerAccountId);

  for (const [key, rawValue] of Object.entries(extraParams)) {
    const value = rawValue?.trim();
    if (value) params.set(key, value);
    else params.delete(key);
  }

  const query = params.toString();
  const suffix = hash ? `#${hash}` : "";
  return query ? `${pathname}?${query}${suffix}` : `${pathname}${suffix}`;
}
