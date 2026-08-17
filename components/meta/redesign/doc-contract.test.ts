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

  it("legacy execute hints are review-only and the doc must not claim direct provider writes", () => {
    expect(page).toContain(
      "This legacy execution hint is not a canonical provider-write authority.",
    );
    expect(page).not.toMatch(/\/api\/meta\/adsets\/.*\/apply-bid/);
    expect(page).not.toMatch(/\/api\/meta\/adsets\/.*\/pause/);
    expect(page).not.toMatch(/\/api\/meta\/campaigns\/.*\/resume/);
    expect(doc).toContain("The recommendation page performs **no direct Meta provider write**");
    expect(doc).toContain("defensively normalized");
    expect(doc).not.toMatch(/Three writes execute from this page/);
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
    // Currency: the page formats money through formatMoney; the doc must
    // not claim the archive table / 7d-avg sublabel still use legacy $.
    expect(page).toContain("formatMoney(avg7dSpend, moneyCurrency)");
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
      "FinalMetaPulse",
      "MetaWorkspacePostureBanners",
      "mid_confidence",
    ]) {
      expect(doc, `doc must document ${symbol}`).toContain(symbol);
    }
    for (const symbol of [
      "isTrackingWriteBlocked",
      "FinalMetaPulse",
      "MetaWorkspacePostureBanners",
    ]) {
      expect(page, `page must still define/use ${symbol}`).toContain(symbol);
    }
  });
});
