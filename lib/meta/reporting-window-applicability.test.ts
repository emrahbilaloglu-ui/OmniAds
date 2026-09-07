import { describe, expect, it } from "vitest";

import {
  META_SURFACES,
  metaSurfaceForPathname,
  reportingWindowApplicability,
  surfaceUsesReportingWindow,
} from "@/lib/meta/surface-registry";

/**
 * §8.2 — the topbar date picker must not look active over data it cannot
 * re-scope.
 *
 * Automation, Integrations and the Shares ledger answer "what is true right
 * now". A range picked above them changed nothing below, so the operator read
 * control state through a window that was doing no work — and had every reason
 * to believe the state shown was the state during those days. That is the
 * plan's §5.1 finding 7.
 */
describe("metaSurfaceForPathname", () => {
  it("resolves a surface in all three route families", () => {
    expect(metaSurfaceForPathname("/c/biz_1/meta/automation")?.surfaceId).toBe(
      "meta-automation",
    );
    expect(metaSurfaceForPathname("/app/meta/automation")?.surfaceId).toBe(
      "meta-automation",
    );
    expect(metaSurfaceForPathname("/platforms/meta/automation")?.surfaceId).toBe(
      "meta-automation",
    );
  });

  it("matches a dynamic segment without matching a different route length", () => {
    expect(metaSurfaceForPathname("/c/biz_1/creative/abc123")?.surfaceId).toBe(
      "creative-detail",
    );
    // A concrete tab wins over the dynamic detail pattern of the same length.
    expect(metaSurfaceForPathname("/c/biz_1/creative/copies")?.surfaceId).toBe(
      "creative-copies",
    );
    expect(metaSurfaceForPathname("/c/biz_1/creative")).toBeNull();
  });

  it("ignores query and hash", () => {
    expect(
      metaSurfaceForPathname("/c/biz_1/meta/history?window=28d#top")?.surfaceId,
    ).toBe("meta-history");
  });

  it("is null for a path outside the Meta family", () => {
    for (const path of ["/app/home", "/app/reports", "/login", "/"]) {
      expect(metaSurfaceForPathname(path), path).toBeNull();
    }
  });
});

describe("reportingWindowApplicability", () => {
  it("withholds the picker when the surface does not read the global range", () => {
    for (const path of [
      "/c/biz_1/meta/automation",
      "/c/biz_1/meta/launchpad",
      "/app/manage/integrations",
      "/c/biz_1/creative/shares",
      "/c/biz_1/creative/briefs",
    ]) {
      const result = reportingWindowApplicability(path);
      expect(result.applies, path).toBe(false);
      expect(result.comparisonApplies, path).toBe(false);
      expect(result.note, path).toContain("not used");
    }
  });

  it("keeps the picker on metric, event and mixed surfaces", () => {
    for (const path of [
      "/c/biz_1/creative/performance",
      "/c/biz_1/creative/copies",
      "/c/biz_1/meta/history",
      "/c/biz_1/meta/decisions",
    ]) {
      const result = reportingWindowApplicability(path);
      expect(result.applies, path).toBe(true);
      expect(result.note, path).toBeNull();
    }
  });

  it("keeps event windows selectable without offering an unused comparison", () => {
    const result = reportingWindowApplicability("/c/biz_1/meta/history");
    expect(result.applies).toBe(true);
    expect(result.comparisonApplies).toBe(false);
  });

  it("leaves an unregistered path fully active", () => {
    // Conservative on purpose: the picker keeps working everywhere outside the
    // Meta family, and an unregistered surface is not silently stripped of a
    // control it may need.
    const result = reportingWindowApplicability("/app/reports");
    expect(result.applies).toBe(true);
    expect(result.comparisonApplies).toBe(true);
    expect(result.surfaceId).toBeNull();
    expect(result.note).toBeNull();
  });

  it("agrees with the registry's own capability for every surface", () => {
    // The registry is the single authority; this is what stops the topbar
    // growing a second opinion about which surfaces take a window.
    for (const surface of META_SURFACES) {
      if (surface.role === "public") continue;
      const path = surface.canonicalRoute.replace("[businessId]", "biz_1");
      if (path.includes("[")) continue;
      expect(reportingWindowApplicability(path).applies, surface.surfaceId).toBe(
        surfaceUsesReportingWindow(surface),
      );
    }
  });
});
