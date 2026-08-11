import { describe, expect, it } from "vitest";

import {
  MIN_TARGET_PX,
  NON_TOKEN_REFERENCE_COLOURS,
  compareFrame,
  type FidelityFinding,
} from "@/scripts/zero-base/verify-reference-fidelity";
import type { VisualFact, VisualSnapshot } from "@/lib/zero-base/visual-facts";

/**
 * G10 fidelity — mutation controls.
 *
 * The gate this replaced passed whenever `data-el="home-kpis"` appeared
 * anywhere in generated HTML. Each case here is a way a frame can be wrong
 * while still containing every marker string, and each must fail.
 */

const TYPE_SCALE = [12, 13, 14, 16, 20];
const TOKENS = new Set(["rgb(36, 32, 26)", "rgb(252, 252, 249)"]);

function fact(overrides: Partial<VisualFact> & { key: string }): VisualFact {
  return {
    owner: null,
    orderInOwner: 0,
    visible: true,
    clipped: false,
    box: { x: 0, y: 0, width: 0.5, height: 0.2 },
    pixels: { width: 200, height: 40 },
    tag: "div",
    fontFamily: "Schibsted Grotesk, sans-serif",
    fontSizePx: 13,
    fontWeight: 400,
    lineHeightPx: 19,
    color: "rgb(36, 32, 26)",
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderRadiusPx: 8,
    borderTopWidthPx: 1,
    boxShadow: "none",
    paddingPx: { top: 8, right: 8, bottom: 8, left: 8 },
    ...overrides,
  };
}

function snapshot(facts: VisualFact[], palette: string[] = ["rgb(36, 32, 26)"]): VisualSnapshot {
  return { id: "H03", width: 1440, theme: "light", facts, typeScale: [13], palette };
}

const run = (
  reference: VisualSnapshot,
  implementation: VisualSnapshot,
): FidelityFinding[] => compareFrame(reference, implementation, TYPE_SCALE, TOKENS);

const kinds = (findings: FidelityFinding[]) => findings.map((finding) => finding.kind);

describe("G10 fidelity mutation controls", () => {
  const REFERENCE = snapshot([
    fact({ key: "el:home-kpis" }),
    fact({ key: "el:source-readiness", box: { x: 0, y: 0.5, width: 0.5, height: 0.2 } }),
    fact({
      key: "collection:sources",
      owner: "el:source-readiness",
      box: { x: 0, y: 0.55, width: 0.4, height: 0.1 },
    }),
    fact({ key: "ctl:live:chart-table-toggle", tag: "button", pixels: { width: 90, height: 32 } }),
  ]);

  const MATCHING = snapshot([
    fact({ key: "el:home-kpis" }),
    fact({ key: "el:source-readiness", box: { x: 0, y: 0.5, width: 0.5, height: 0.2 } }),
    fact({
      key: "collection:sources",
      owner: "el:source-readiness",
      box: { x: 0, y: 0.55, width: 0.4, height: 0.1 },
    }),
    fact({ key: "ctl:live:chart-table-toggle", tag: "button", pixels: { width: 90, height: 32 } }),
  ]);

  it("a faithful frame produces no findings", () => {
    expect(run(REFERENCE, MATCHING)).toEqual([]);
  });

  it("REGRESSION: a missing region fails", () => {
    const without = snapshot(MATCHING.facts.filter((f) => f.key !== "el:source-readiness"));
    expect(kinds(run(REFERENCE, without))).toContain("missing");
  });

  it("REGRESSION: marker injection on an invisible element fails", () => {
    // The old gate's exact blind spot: the string is present, the region is
    // not. A zero-size or display:none marker is not a region.
    const injected = snapshot(
      MATCHING.facts.map((f) =>
        f.key === "el:source-readiness"
          ? fact({ ...f, visible: false, pixels: { width: 0, height: 0 } })
          : f,
      ),
    );
    expect(kinds(run(REFERENCE, injected))).toContain("invisible");
  });

  it("REGRESSION: a clipped control fails", () => {
    const clipped = snapshot(
      MATCHING.facts.map((f) =>
        f.key === "ctl:live:chart-table-toggle" ? fact({ ...f, clipped: true }) : f,
      ),
    );
    expect(kinds(run(REFERENCE, clipped))).toContain("clipped");
  });

  it("REGRESSION: the wrong parent fails", () => {
    const reparented = snapshot(
      MATCHING.facts.map((f) =>
        f.key === "collection:sources" ? fact({ ...f, owner: "el:home-kpis" }) : f,
      ),
    );
    expect(kinds(run(REFERENCE, reparented))).toContain("wrong-owner");
  });

  it("a region moved to the root where the reference nests it fails", () => {
    const orphaned = snapshot(
      MATCHING.facts.map((f) => (f.key === "collection:sources" ? fact({ ...f, owner: null }) : f)),
    );
    expect(kinds(run(REFERENCE, orphaned))).toContain("wrong-owner");
  });

  it("REGRESSION: reordered siblings fail", () => {
    const reference = snapshot([
      fact({ key: "el:panel" }),
      fact({ key: "ctl:live:a", owner: "el:panel", tag: "button", box: { x: 0, y: 0.1, width: 0.2, height: 0.05 } }),
      fact({ key: "ctl:live:b", owner: "el:panel", tag: "button", box: { x: 0, y: 0.4, width: 0.2, height: 0.05 } }),
    ]);
    // Same markers, same parent, swapped vertically.
    const swapped = snapshot([
      fact({ key: "el:panel" }),
      fact({ key: "ctl:live:a", owner: "el:panel", tag: "button", box: { x: 0, y: 0.4, width: 0.2, height: 0.05 } }),
      fact({ key: "ctl:live:b", owner: "el:panel", tag: "button", box: { x: 0, y: 0.1, width: 0.2, height: 0.05 } }),
    ]);
    expect(kinds(run(reference, swapped))).toContain("placement");
    // …and the faithful order does not.
    expect(kinds(run(reference, reference))).not.toContain("placement");
  });

  it("REGRESSION: a control on a non-control element fails", () => {
    const asDiv = snapshot(
      MATCHING.facts.map((f) =>
        f.key === "ctl:live:chart-table-toggle" ? fact({ ...f, tag: "div" }) : f,
      ),
    );
    expect(kinds(run(REFERENCE, asDiv))).toContain("not-a-control");
  });

  it("REGRESSION: an undersized target fails", () => {
    const tiny = snapshot(
      MATCHING.facts.map((f) =>
        f.key === "ctl:live:chart-table-toggle"
          ? fact({ ...f, pixels: { width: 90, height: MIN_TARGET_PX - 1 } })
          : f,
      ),
    );
    expect(kinds(run(REFERENCE, tiny))).toContain("target-too-small");
  });

  it("REGRESSION: a size off the reference type scale fails", () => {
    const offScale = snapshot(
      MATCHING.facts.map((f) => (f.key === "el:home-kpis" ? fact({ ...f, fontSizePx: 12.5 }) : f)),
    );
    const findings = run(REFERENCE, offScale);
    expect(findings.some((f) => f.kind === "typography" && f.detail.includes("12.5"))).toBe(true);
  });

  it("REGRESSION: a face outside the Ledger pair fails", () => {
    const arial = snapshot(
      MATCHING.facts.map((f) => (f.key === "el:home-kpis" ? fact({ ...f, fontFamily: "Arial" }) : f)),
    );
    expect(
      run(REFERENCE, arial).some((f) => f.kind === "typography" && f.detail.includes("arial")),
    ).toBe(true);
  });

  it("REGRESSION: collapsed line-height fails", () => {
    const cramped = snapshot(
      MATCHING.facts.map((f) =>
        f.key === "el:home-kpis" ? fact({ ...f, fontSizePx: 13, lineHeightPx: 13 }) : f,
      ),
    );
    expect(kinds(run(REFERENCE, cramped))).toContain("line-height");
  });

  it("REGRESSION: a colour no Ledger token produces fails", () => {
    const offToken = snapshot(MATCHING.facts, ["rgb(1, 2, 3)"]);
    expect(kinds(run(REFERENCE, offToken))).toContain("untokenised-colour");
  });

  it("a declared one-off chart colour does not fail", () => {
    // Classified from the reference rather than waved through: the chart series
    // colours are drawn inline by the design and no token owns them.
    const chart = snapshot(MATCHING.facts, [...NON_TOKEN_REFERENCE_COLOURS]);
    expect(kinds(run(REFERENCE, chart))).not.toContain("untokenised-colour");
  });

  it("transparent backgrounds are not colours", () => {
    const transparent = snapshot(MATCHING.facts, ["rgba(0, 0, 0, 0)"]);
    expect(kinds(run(REFERENCE, transparent))).not.toContain("untokenised-colour");
  });

  it("collections match on their kind, not the artboard's label for them", () => {
    // The reference names the same table h03-sources on one artboard and
    // b01-sources on another; the implementation has one component.
    const reference = snapshot([fact({ key: "collection:b01-sources" })]);
    const implementation = snapshot([fact({ key: "collection:sources" })]);
    expect(run(reference, implementation)).toEqual([]);
  });

  it("the design's own template placeholders are not requirements", () => {
    const reference = snapshot([fact({ key: "ctl:{{ a.ctl }}" })]);
    expect(run(reference, snapshot([]))).toEqual([]);
  });
});
