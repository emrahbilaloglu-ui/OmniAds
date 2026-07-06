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

describe("meta page UI contract doc stays consistent with code", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  const page = readFileSync(PAGE_PATH, "utf8");

  it("execute_bid tracking gate: code gates it and the doc must not deny it", () => {
    const gateBlock = page.slice(
      page.indexOf("const isTrackingSensitiveRec"),
      page.indexOf("};", page.indexOf("const isTrackingSensitiveRec")),
    );
    expect(gateBlock).toContain('"execute_bid"');
    expect(doc).not.toMatch(/execute_bid[^.\n]*not tracking/i);
    // The gating section must list execute_bid among intercepted primaries.
    expect(doc).toMatch(/isTrackingSensitiveRec/);
    const gatingSection = doc.slice(
      doc.indexOf("isTrackingSensitiveRec") - 400,
      doc.indexOf("isTrackingSensitiveRec") + 400,
    );
    expect(gatingSection).toContain("execute_bid");
  });

  it("dataReadiness: page renders the banner and the doc must not call it payload-only", () => {
    expect(page).toContain('data-testid="meta-data-readiness"');
    expect(doc).not.toMatch(/dataReadiness[^.\n]*payload-only/i);
    expect(doc).not.toMatch(/dataReadiness[^.\n]*(never|not) render/i);
  });

  it("symbols the doc cites as code must exist in the source they cite", () => {
    // MetaArchiveTable was removed; the doc must not resurrect it, and any
    // future 'dead code' caveat naming a page symbol must match reality.
    expect(page).not.toContain("function MetaArchiveTable");
    expect(doc).not.toContain("MetaArchiveTable");
  });

  it("doc references to the page's key contracts stay alive in code", () => {
    for (const symbol of [
      "isTrackingWriteBlocked",
      "FinalMetaPulse",
      "ReadinessNotice",
      "mid_confidence",
    ]) {
      expect(doc, `doc must document ${symbol}`).toContain(symbol);
    }
    for (const symbol of ["isTrackingWriteBlocked", "FinalMetaPulse", "ReadinessNotice"]) {
      expect(page, `page must still define/use ${symbol}`).toContain(symbol);
    }
  });
});
