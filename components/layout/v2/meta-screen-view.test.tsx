import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { INSTRUMENTATION_SURFACE_BY_SURFACE_ID } from "@/components/meta/use-screen-view";
import { PRODUCT_INSTRUMENTATION_SURFACES } from "@/lib/product-instrumentation";
import { META_SURFACES, metaSurfaceForPathname } from "@/lib/meta/surface-registry";

/**
 * WP17 — "her mounted Meta yüzeyi screen_view".
 *
 * Until now this was unmeetable rather than unmet: the vendored leaf ledger
 * declares `event: "screen_view"` for every leaf, and the runtime vocabulary had
 * no such name, so nothing could emit one.
 */
describe("screen_view coverage", () => {
  it("maps every registry surface to an allowed instrumentation surface", () => {
    for (const surface of META_SURFACES) {
      // The public share is unauthenticated and outside the client shell, so it
      // has no business scope to attribute a view to.
      if (surface.role === "public") continue;
      const mapped = INSTRUMENTATION_SURFACE_BY_SURFACE_ID[surface.surfaceId];
      expect(mapped, `${surface.surfaceId} has no instrumentation surface`).toBeTruthy();
      expect(PRODUCT_INSTRUMENTATION_SURFACES).toContain(mapped);
    }
  });

  it("does not invent a surface name the sink would reject", () => {
    for (const mapped of Object.values(INSTRUMENTATION_SURFACE_BY_SURFACE_ID)) {
      expect(PRODUCT_INSTRUMENTATION_SURFACES).toContain(mapped);
    }
  });

  it("resolves the two D3 rail rows to their own surfaces", () => {
    // Both routes have worked all along; neither had a surface name here, so
    // nothing they emitted could be attributed to them.
    expect(
      INSTRUMENTATION_SURFACE_BY_SURFACE_ID[
        metaSurfaceForPathname("/c/biz_1/meta/intelligence")!.surfaceId
      ],
    ).toBe("meta_intelligence");
    expect(
      INSTRUMENTATION_SURFACE_BY_SURFACE_ID[
        metaSurfaceForPathname("/c/biz_1/meta/history")!.surfaceId
      ],
    ).toBe("meta_history");
  });

  it("is mounted by the shell, so no body has to own the once-per-screen rule", () => {
    const frame = readFileSync("components/layout/dashboard-frame.tsx", "utf8");
    expect(frame).toContain("<MetaScreenView />");
  });

  it("emits nothing on a path the registry does not know", () => {
    // Falling back to a real surface name would attribute a view to the wrong
    // screen, which is worse than not counting it.
    const source = readFileSync(
      "components/layout/v2/meta-screen-view.tsx",
      "utf8",
    );
    expect(source).toContain("ready: Boolean(instrumentationSurface)");
  });

  it("keys the emission on surface AND business, not on render", () => {
    // A screen_view that fires on every state change stops counting screens and
    // starts counting renders — a different number that looks like the same one.
    const source = readFileSync("components/meta/use-screen-view.ts", "utf8");
    expect(source).toContain("`${input.surface}:${businessId}`");
    expect(source).toContain("emittedFor.current === key");
  });
});
