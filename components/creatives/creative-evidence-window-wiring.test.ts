import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

const PLATFORM_PAGE = read("components/meta/redesign/MetaPlatformPage.tsx");
const COPIES_PAGE = read("app/(dashboard)/platforms/meta/copies/legacy-page.tsx");
const STUDIO_OS_VIEW = read("components/creatives/StudioOsView.tsx");

describe("Creative evidence window route wiring", () => {
  it("mounts the exact evidence window on the design's own trigger", () => {
    expect(PLATFORM_PAGE).toContain(
      'import { CreativeEvidenceWindowExact } from "@/components/creatives/CreativeEvidenceWindowExact"',
    );
    expect(PLATFORM_PAGE).toContain("<CreativeEvidenceWindowExact");
    expect(PLATFORM_PAGE).toContain("buildCreativeEvidenceWindowExactViewModel({");
    expect(PLATFORM_PAGE).not.toContain("MetaCreativeEvidenceDrawer");
  });

  it("keeps both served decision envelopes instead of discarding the presentation one", () => {
    expect(PLATFORM_PAGE).toContain(
      "setCreativeDrill({ decision, canonical: canonicalDecision })",
    );
    expect(PLATFORM_PAGE).toContain("decision: creativeDrill.decision,");
    expect(PLATFORM_PAGE).toContain("canonical: creativeDrill.canonical,");
  });

  it("reads ad-grain evidence from the authorized creatives route, scoped to one creative", () => {
    expect(PLATFORM_PAGE).toContain("fetchCreativeEvidenceAdRows");
    expect(PLATFORM_PAGE).toContain('groupBy: "ad"');
    expect(PLATFORM_PAGE).toContain("creativeId: input.creativeId");
    expect(PLATFORM_PAGE).toContain("/api/meta/creatives?");
    expect(PLATFORM_PAGE).toContain("meta-creative-evidence-ad-rows");
  });

  it("reads the sparkline pair as a real per-ad daily series, scoped to one ad", () => {
    expect(PLATFORM_PAGE).toContain("fetchCreativeEvidenceAdSeries");
    expect(PLATFORM_PAGE).toContain("/api/meta/ads/series?");
    expect(PLATFORM_PAGE).toContain("meta-creative-evidence-series");
    expect(PLATFORM_PAGE).toContain("adIds: [creativeEvidenceAdId!]");
    expect(PLATFORM_PAGE).toContain("adSeries: creativeEvidenceSeriesQuery.data,");
  });

  it("gives the footer the decision's own action, Compare in Studio and Ads Manager", () => {
    expect(PLATFORM_PAGE).toContain("creativeEvidenceLaunchpadHref");
    expect(PLATFORM_PAGE).toContain("creativeEvidenceStudioHref");
    expect(PLATFORM_PAGE).toContain("buildMetaAdsManagerHref");
  });

  it("does not hand the drawer a second, unguarded provider-write trigger", () => {
    // The primary only gets a destination for draft-routing decisions; the
    // confirmation ceremony stays on the decision row.
    expect(PLATFORM_PAGE).toContain('code === "plan_promotion"');
    expect(PLATFORM_PAGE).toContain('code === "refresh_creative"');
    expect(PLATFORM_PAGE).not.toContain("/api/meta/decision-action\", { method");
  });

  it("leaves exactly one evidence window in the app", () => {
    expect(STUDIO_OS_VIEW).not.toContain("renderUsageDrawer");
    expect(STUDIO_OS_VIEW).not.toContain("openUsageDrawer");
    expect(STUDIO_OS_VIEW).not.toContain("Exact ad usages");
    expect(STUDIO_OS_VIEW).not.toContain("Trends (7 / 28 / 90d)");
    expect(STUDIO_OS_VIEW).not.toContain("Take to Decisions");
  });

  it("converges every Decision Center route family on the same body", () => {
    expect(read("app/(dashboard)/platforms/meta/page.tsx")).toContain(
      'import LegacyBody from "./legacy-page"',
    );
    expect(read("app/c/[businessId]/meta/decisions/page.tsx")).toContain(
      'import LegacyMetaPage from "@/app/(dashboard)/platforms/meta/legacy-page"',
    );
    expect(read("app/app/[[...path]]/page.tsx")).toContain(
      '"meta/decisions": () => import("@/app/c/[businessId]/meta/decisions/page")',
    );
  });
});

describe("Copy detail drawer route wiring", () => {
  it("mounts the exact copy drawer from the Creative Studio copies table", () => {
    expect(COPIES_PAGE).toContain(
      'import { CopyDetailDrawerExact } from "@/components/creatives/CopyDetailDrawerExact"',
    );
    expect(COPIES_PAGE).toContain("<CopyDetailDrawerExact");
    expect(COPIES_PAGE).toContain("buildCopyDetailDrawerExactViewModel({");
    expect(COPIES_PAGE).toContain("onOpenRow: setDetailRowId");
  });

  it("feeds the account medians from the same served rows the table renders", () => {
    expect(COPIES_PAGE).toContain("const drawerPeers = useMemo(() => rows.map(toCopyDrawerRow)");
    expect(COPIES_PAGE).toContain("peers: drawerPeers");
  });

  it("keeps see-more and engagement unserved rather than substituting other metrics", () => {
    expect(COPIES_PAGE).toContain("seeMore: null");
    expect(COPIES_PAGE).toContain("engagement: null");
    expect(COPIES_PAGE).not.toContain('label="Spend"');
    expect(COPIES_PAGE).not.toContain('label="CPA"');
  });

  it("converges every copies route family on the same body", () => {
    expect(read("app/(dashboard)/platforms/meta/copies/page.tsx")).toContain(
      'import LegacyBody from "./legacy-page"',
    );
    expect(read("app/c/[businessId]/creative/copies/page.tsx")).toContain(
      'import LegacyCreativeCopiesPage from "@/app/(dashboard)/platforms/meta/copies/legacy-page"',
    );
    expect(read("app/app/[[...path]]/page.tsx")).toContain(
      '"creative/copies": () => import("@/app/c/[businessId]/creative/copies/page")',
    );
  });
});
