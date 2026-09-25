/**
 * Meta's generic thumbnail for a catalog (template) creative.
 *
 * A catalog creative renders product images chosen per viewer, so it has no
 * fixed image of its own, and the Graph creative `thumbnail_url` returns one
 * shared placeholder instead: a 150×120 light-grey tile (#EAE9E6 on ~95% of
 * its pixels) with a small image glyph. The Studio drew it as a real
 * thumbnail, which read as an image that failed to load.
 *
 * MEASURED read-only on production `meta_creative_daily`, 2026-08-26..09-25:
 * 63 of 65 catalog creatives, across 10 businesses and several CDN hosts,
 * carry exactly this file as their thumbnail; every creative carrying it is a
 * catalog creative. The other two catalog creatives are video catalog ads with
 * their own poster frame. On Grandmix 2026-09-18..24 it is 22 of 53 creatives.
 *
 * The match is the file name alone (hosts and signed query strings vary). If
 * Meta changes the file, the placeholder is simply drawn again, as before.
 */
const META_CATALOG_TEMPLATE_PLACEHOLDER_FILE =
  "75341531_494485104475166_2751028116179648512_n.png";

export function isMetaCatalogTemplatePlaceholderUrl(
  url: string | null | undefined,
): boolean {
  const value = url?.trim();
  if (!value) return false;
  try {
    const path = new URL(value).pathname;
    return path.slice(path.lastIndexOf("/") + 1) ===
      META_CATALOG_TEMPLATE_PLACEHOLDER_FILE;
  } catch {
    return false;
  }
}

/**
 * The first provider image that is not Meta's catalog placeholder. A catalog
 * row whose only images are the placeholder gets no image and a
 * `catalog_template` note, so the surface can say why; any other row keeps
 * the provider's image exactly as before.
 */
export function selectCreativeThumbnail(input: {
  candidates: ReadonlyArray<string | null | undefined>;
  isCatalog: boolean;
}): { imageUrl: string | null; imageNote: "catalog_template" | null } {
  let placeholder: string | null = null;
  for (const candidate of input.candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    if (isMetaCatalogTemplatePlaceholderUrl(value)) {
      placeholder ??= value;
      continue;
    }
    return { imageUrl: value, imageNote: null };
  }
  if (placeholder && input.isCatalog) {
    return { imageUrl: null, imageNote: "catalog_template" };
  }
  return { imageUrl: placeholder, imageNote: null };
}
