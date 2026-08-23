// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

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
  });

  it("survives a remount, which a ref did not", () => {
    /**
     * The guard was a `useRef`, which only remembers inside one component
     * instance. On the mounted routes the shell's emitter is remounted during
     * the first load, and every Meta surface emitted the identical
     * `screen_view` twice — so every adoption number built on the event was
     * doubled. Module scope is what makes "once per surface and business" true
     * of the page rather than of a component instance.
     */
    const source = readFileSync("components/meta/use-screen-view.ts", "utf8");
    expect(source).toContain("let lastEmittedScreenViewKey");
    expect(source).not.toContain("useRef");
  });
});

describe("one screen_view per surface and business, across remounts", () => {
  /**
   * Behavioural, not a source read: the hook is driven twice, exactly as the
   * shell drives it when it remounts, and the emitter is counted.
   */
  it("emits once when the same surface mounts twice, and again after a real move", async () => {
    const emitted: { surface: string; businessId: string | null }[] = [];
    vi.resetModules();
    vi.doMock("@/lib/product-instrumentation-client", () => ({
      emitProductInstrumentation: (input: { surface: string; businessId: string | null }) => {
        emitted.push({ surface: input.surface, businessId: input.businessId });
      },
    }));

    const { useScreenView, resetScreenViewForTest } = await import(
      "@/components/meta/use-screen-view"
    );
    const { renderHook, cleanup } = await import("@testing-library/react");
    resetScreenViewForTest();

    const mount = (surface: string, businessId: string) =>
      renderHook(() =>
        useScreenView({
          surface: surface as never,
          businessId,
          ready: true,
        }),
      );

    mount("meta_decisions", "biz_1");
    cleanup();
    // The remount the shell performs during first load.
    mount("meta_decisions", "biz_1");
    cleanup();
    expect(emitted).toEqual([{ surface: "meta_decisions", businessId: "biz_1" }]);

    // A different surface is a different view.
    mount("meta_history", "biz_1");
    cleanup();
    // And coming back is a third view, not a suppressed repeat.
    mount("meta_decisions", "biz_1");
    cleanup();
    expect(emitted).toEqual([
      { surface: "meta_decisions", businessId: "biz_1" },
      { surface: "meta_history", businessId: "biz_1" },
      { surface: "meta_decisions", businessId: "biz_1" },
    ]);

    vi.doUnmock("@/lib/product-instrumentation-client");
    vi.resetModules();
  });
});
