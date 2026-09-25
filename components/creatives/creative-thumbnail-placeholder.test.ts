import { describe, expect, it } from "vitest";

import {
  isMetaCatalogTemplatePlaceholderUrl,
  selectCreativeThumbnail,
} from "@/components/creatives/creative-thumbnail-placeholder";

// The live URL shape (Grandmix, BathroomMeta-Shipping, 2026-09-24), with the
// signed query shortened. Hosts and signatures vary; the file does not.
const PLACEHOLDER =
  "https://scontent-xxc1-1.xx.fbcdn.net/v/t39.2147-6/75341531_494485104475166_2751028116179648512_n.png?_nc_cat=1&stp=c0.5000x0.5000f_dst-emg0_p150x120_q75_tt6&oe=6ABBFF44";
const PLACEHOLDER_OTHER_HOST =
  "https://scontent-iad3-2.xx.fbcdn.net/v/t39.2147-6/75341531_494485104475166_2751028116179648512_n.png?_nc_cat=1&oe=6ABC0000";
const REAL_VIDEO_POSTER =
  "https://scontent-xxc1-1.xx.fbcdn.net/v/t15.5256-10/610522250_712289618_n.jpg?oe=6ABBFF44";

describe("Meta's catalog template placeholder", () => {
  it("is recognised by its file, whatever the host or signature", () => {
    expect(isMetaCatalogTemplatePlaceholderUrl(PLACEHOLDER)).toBe(true);
    expect(isMetaCatalogTemplatePlaceholderUrl(PLACEHOLDER_OTHER_HOST)).toBe(true);
    expect(isMetaCatalogTemplatePlaceholderUrl(REAL_VIDEO_POSTER)).toBe(false);
    expect(
      isMetaCatalogTemplatePlaceholderUrl(
        "https://scontent.xx.fbcdn.net/v/t39.2147-6/75341531_494485104475166_2751028116179648512_n.png.jpg",
      ),
    ).toBe(false);
    expect(isMetaCatalogTemplatePlaceholderUrl("not a url")).toBe(false);
    expect(isMetaCatalogTemplatePlaceholderUrl(null)).toBe(false);
  });

  it("is not drawn as a catalog creative's image; the row says why instead", () => {
    expect(
      selectCreativeThumbnail({
        candidates: [PLACEHOLDER, null, PLACEHOLDER_OTHER_HOST],
        isCatalog: true,
      }),
    ).toEqual({ imageUrl: null, imageNote: "catalog_template" });
  });

  it("gives way to any real image the row carries, in the same preference order", () => {
    expect(
      selectCreativeThumbnail({
        candidates: [PLACEHOLDER, REAL_VIDEO_POSTER],
        isCatalog: true,
      }),
    ).toEqual({ imageUrl: REAL_VIDEO_POSTER, imageNote: null });
    expect(
      selectCreativeThumbnail({
        candidates: [" ", "https://cdn.example/a.jpg", "https://cdn.example/b.jpg"],
        isCatalog: false,
      }),
    ).toEqual({ imageUrl: "https://cdn.example/a.jpg", imageNote: null });
  });

  it("changes nothing for a row that is not a catalog creative", () => {
    // Every measured carrier was a catalog creative; any other row keeps the
    // provider image exactly as before rather than being reclassified.
    expect(
      selectCreativeThumbnail({ candidates: [PLACEHOLDER], isCatalog: false }),
    ).toEqual({ imageUrl: PLACEHOLDER, imageNote: null });
    expect(
      selectCreativeThumbnail({ candidates: [null, undefined], isCatalog: true }),
    ).toEqual({ imageUrl: null, imageNote: null });
  });
});
