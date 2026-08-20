import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Doc-code consistency guard for docs/meta-page-ui-contract.md.
//
// Origin: the contract doc was rewritten while three code fixes landed in
// parallel, and the doc's caveats went stale against the code in the same
// commit (Codex follow-up review). These assertions pin the doc to the
// source for exactly those claims, and fail whichever side regresses.
const DOC_PATH = "docs/meta-page-ui-contract.md";
const PAGE_PATH = "components/meta/redesign/MetaPlatformPage.tsx";
const EXACT_PATH =
  "components/meta/decision-center/MetaDecisionCenterExact.tsx";
const ADAPTER_PATH =
  "components/meta/decision-center/meta-decision-center-exact-adapter.ts";

describe("meta page UI contract doc stays consistent with code", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  const page = readFileSync(PAGE_PATH, "utf8");
  const exact = readFileSync(EXACT_PATH, "utf8");
  const adapter = readFileSync(ADAPTER_PATH, "utf8");

  /*
   * The page's write surface, pinned in BOTH directions.
   *
   * This assertion used to require the sentence "The served hint carries no
   * canonical provider-write authority" in the page, and the doc's matching
   * claim that the page performs no direct provider write. That stopped being
   * true when the exact-Ad pause landed: the page now issues one real Meta
   * mutation. The sentence was deleted from the source and the doc was not
   * updated, so the doc asserted an absence the code had already contradicted
   * — which is the exact failure this file exists to catch, and it caught it.
   *
   * Re-adding the old sentence would have made the guard green by making the
   * code lie instead of the doc. So the pin moved to the new truth: EXACTLY
   * ONE write, at the ad grain, through the named module — and still none at
   * the ad-set or campaign grain, which is the part that must not drift.
   */
  it("the page's only provider write is the exact-Ad pause, and the doc says so", () => {
    expect(page).toContain("executeMetaNativeAdPause");
    expect(page).toContain("authorizeMetaNativeAdPause");
    expect(doc).toContain("exactly one direct Meta provider write");
    expect(doc).toContain("/api/meta/ads/{adId}/pause");
    expect(doc).toContain("Campaign and ad-set recommendations remain advisory");

    // The grains that still have no execution-authority contract. A write
    // endpoint for either appearing in this page is the regression.
    expect(page).not.toMatch(/\/api\/meta\/adsets\/.*\/apply-bid/);
    expect(page).not.toMatch(/\/api\/meta\/adsets\/.*\/pause/);
    expect(page).not.toMatch(/\/api\/meta\/campaigns\/.*\/resume/);

    /*
     * The ad-grain WRITE may exist only inside the module that carries the
     * authority check; a bare fetch from the page would bypass
     * `authorizeMetaNativeAdPause` entirely.
     *
     * Scoped to the mutating verbs on purpose. `/api/meta/ads/series` is a
     * READ this page legitimately calls for the evidence sparklines, so a
     * blanket ban on the prefix would forbid the wrong thing.
     */
    expect(page).not.toMatch(/\/api\/meta\/ads\/[^"'`\s]*\/(pause|resume|status)/);

    expect(doc).toContain("defensively normalized");
    expect(doc).not.toMatch(/Three writes execute from this page/);
    expect(doc).not.toContain(
      "The recommendation page performs **no direct Meta provider write**",
    );
  });

  it("dataReadiness: page renders through the workspace posture stack and the doc must not call it payload-only", () => {
    expect(page).toContain("MetaWorkspacePostureBanners");
    expect(page).toContain('id: "data_readiness"');
    expect(page).toContain('data-banner-id={banner.id}');
    expect(doc).not.toMatch(/dataReadiness[^.\n]*payload-only/i);
    expect(doc).not.toMatch(/dataReadiness[^.\n]*(never|not) render/i);
    // The first stale copy hid two paragraphs apart from the field name -
    // the phrase itself is banned while the banner exists in code.
    expect(doc).not.toMatch(/not currently rendered/i);
  });

  it("symbols the doc cites as code must exist in the source they cite", () => {
    // MetaArchiveTable was removed; the doc must not resurrect it, and any
    // future 'dead code' caveat naming a page symbol must match reality.
    expect(page).not.toContain("function MetaArchiveTable");
    expect(doc).not.toContain("MetaArchiveTable");
  });

  it("stale caveat phrases cannot return while the code has the fix", () => {
    // Currency: every money value on the band is formatted through the
    // adapter's currency-aware formatter, never a hardcoded symbol; the doc
    // must not claim the archive table / 7d-avg sublabel still use legacy $.
    expect(adapter).toContain("function formatMoney(");
    expect(adapter).not.toMatch(/["'`]\$["'`]\s*\+/);
    expect(doc).not.toMatch(/archive table[^.\n]*still use[^.\n]*formatCurrency/i);
    expect(doc).not.toMatch(/Currency-awareness is partial/);
    // Anomalies: endDate scoping exists; the old blanket sentence is banned.
    expect(doc).not.toMatch(/does not scope by window or status filter/i);
  });

  it("anomaly status scoping: code supports it and the doc must not deny it", () => {
    const anomaliesLib = readFileSync("lib/meta/anomalies.ts", "utf8");
    expect(anomaliesLib).toContain("export function anomalyMatchesStatusFilter");
    expect(doc).toContain("anomalyMatchesStatusFilter");
    // Pre-fix caveat sentences are banned while the capability exists.
    expect(doc).not.toMatch(/status filter cannot scope this feed/i);
    expect(doc).not.toMatch(/carry no per-entity briefing status/i);
    expect(doc).not.toMatch(/not window- or status-filter-scoped/i);
  });

  it("unified as-of contract: exact source identity and queue snapshot remain payload-bound", () => {
    expect(exact).toContain("data-meta-exact-source-identity");
    expect(exact).toContain("data-meta-exact-queue-snapshot");
    expect(adapter).toContain("workspace.pulse.lastSyncAt");
    expect(adapter).toContain("workspace.decisionReadModel.source.snapshotAsOf");
    expect(adapter).toContain("workspace.lanes.snapshotDate");
    expect(doc).toContain("unified as-of contract");
    expect(doc).toContain("data-meta-exact-source-identity");
    expect(doc).toContain("data-meta-exact-queue-snapshot");
    expect(doc).not.toContain("meta-anomaly-asof");
    // Pre-fix wording (snapshotDate as the requested range end) is banned.
    expect(doc).not.toMatch(/snapshotDate[^.\n]*requested range end(?![^.\n]*used to echo)/i);
    const laneRoute = readFileSync("app/api/meta/lane-classify/route.ts", "utf8");
    expect(laneRoute).toContain("snapshot?.snapshotDate ?? null");
    expect(laneRoute).toContain("snapshotCreatedAt");
  });

  it("doc references to the page's key contracts stay alive in code", () => {
    for (const symbol of [
      "isTrackingWriteBlocked",
      "ExactKpiBand",
      "MetaWorkspacePostureBanners",
      "mid_confidence",
    ]) {
      expect(doc, `doc must document ${symbol}`).toContain(symbol);
    }
    for (const symbol of ["isTrackingWriteBlocked", "MetaWorkspacePostureBanners"]) {
      expect(page, `page must still define/use ${symbol}`).toContain(symbol);
    }
    // The KPI band moved out of the page and into the exact component; the doc
    // cites it there, so that is where it has to exist.
    expect(exact, "the exact component must still define ExactKpiBand").toContain(
      "function ExactKpiBand(",
    );
    expect(page, "the retired pulse strip must not come back").not.toContain(
      "FinalMetaPulse",
    );
  });
});
