// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BudgetDecisionEvidencePanel } from "./BudgetDecisionEvidencePanel";
import {
  unavailableEvidencePanel,
  type MetaBudgetDecisionEvidenceByDirection,
  type MetaBudgetDecisionEvidencePanel as PanelModel,
} from "@/lib/meta/budget-decision-evidence-panel";

afterEach(cleanup);

const panel = (over: Partial<PanelModel> = {}): PanelModel => ({
  contractVersion: "meta-budget-decision-evidence-panel.v4",
  status: "resolved",
  unavailableReason: null,
  authority: "blocked",
  primaryBlocker: {
    code: "budget_fact_absent",
    reason: "no canonical budget fact was resolved for this entity at this origin",
  },
  sections: [
    { section: "input_integrity", blockerCodes: [], reasons: [], clear: true },
    { section: "commercial_target", blockerCodes: [], reasons: [], clear: true },
    {
      section: "evidence_floor",
      blockerCodes: ["budget_fact_absent"],
      reasons: ["no canonical budget fact was resolved for this entity at this origin"],
      clear: false,
    },
    {
      section: "change_safety",
      blockerCodes: ["change_safety_history_unavailable"],
      reasons: ["recent-change history for at least one declared scope was not read"],
      clear: false,
    },
    { section: "execution_capability", blockerCodes: [], reasons: [], clear: true },
  ],
  commercialLineage: {
    selectedAction: "scale",
    eligible: false,
    code: "commercial_anchor_not_hard_action_eligible",
    reason: "the canonical profile reports scale ineligible",
    anchorExplanation: { spendUnitSource: "unresolved" },
    contractVersion: "adsecute.account-decision-profile.v1",
    availability: { status: "resolved" },
  },
  executionReadiness: { state: "not_executable", why: "at least one local gate is unmet", ctaEnabled: false },
  counterfactual: null,
  ...over,
});

const evidence = (over: Partial<MetaBudgetDecisionEvidenceByDirection> = {}): MetaBudgetDecisionEvidenceByDirection => ({
  contractVersion: "meta-budget-decision-evidence-directional.v3",
  directionToAction: { increase: "scale", decrease: "cut" },
  directionToActionWhy: "an increase is a scale decision and a decrease is a cut decision",
  directionSelected: null,
  directionSelectedWhy: "this panel is account-scoped and no proposal direction has been selected",
  increase: panel(),
  decrease: panel(),
  ...over,
});

const root = () => document.querySelector('[data-el="budget-decision-evidence"]');
const direction = (d: "increase" | "decrease") =>
  document.querySelector(`[data-el="budget-decision-direction"][data-direction="${d}"]`);

describe("both review-only directions are rendered", () => {
  it("renders an increase and a decrease panel, and names neither as selected", () => {
    render(<BudgetDecisionEvidencePanel evidence={evidence()} />);
    expect(root()).toBeTruthy();
    expect(root()?.getAttribute("data-direction-selected")).toBe("none");
    expect(direction("increase")).toBeTruthy();
    expect(direction("decrease")).toBeTruthy();
  });

  it("states which profile action each direction depends on", () => {
    render(<BudgetDecisionEvidencePanel evidence={evidence()} />);
    expect(direction("increase")?.textContent).toContain("scale");
    expect(direction("decrease")?.textContent).toContain("cut");
  });

  it("renders each direction's own verdict, not one shared verdict", () => {
    render(
      <BudgetDecisionEvidencePanel
        evidence={evidence({
          increase: panel({ authority: "validated_only", primaryBlocker: null }),
          decrease: panel({ authority: "blocked" }),
        })}
      />,
    );
    expect(direction("increase")?.querySelector('[data-el="authority"]')?.getAttribute("data-authority")).toBe("validated_only");
    expect(direction("decrease")?.querySelector('[data-el="authority"]')?.getAttribute("data-authority")).toBe("blocked");
    expect(direction("increase")?.querySelector('[data-el="primary-blocker"]')).toBeNull();
    expect(direction("decrease")?.querySelector('[data-el="primary-blocker"]')).toBeTruthy();
  });

  it("keeps each blocker code beside its OWN sentence", () => {
    render(<BudgetDecisionEvidencePanel evidence={evidence()} />);
    const primary = direction("increase")?.querySelector('[data-el="primary-blocker"]');
    expect(primary?.getAttribute("data-code")).toBe("budget_fact_absent");
    expect(primary?.textContent).toContain("no canonical budget fact");
    // And inside the sections, each code carries its own reason.
    for (const node of Array.from(direction("increase")?.querySelectorAll('[data-el="section-reason"]') ?? [])) {
      const code = node.getAttribute("data-code")!;
      if (code === "budget_fact_absent") expect(node.textContent).toContain("no canonical budget fact");
      if (code === "change_safety_history_unavailable") expect(node.textContent).toContain("history");
    }
  });

  it("shows the unavailable-history blocker where a reader can see it", () => {
    render(<BudgetDecisionEvidencePanel evidence={evidence()} />);
    const section = direction("increase")?.querySelector('[data-section="change_safety"]');
    expect(section?.getAttribute("data-clear")).toBe("false");
    expect(section?.textContent).toContain("history");
  });

  it("renders nothing at all when the server sent nothing", () => {
    render(<BudgetDecisionEvidencePanel evidence={null} />);
    expect(root()).toBeNull();
  });

  it("renders an unavailable direction as unavailable, never as clear", () => {
    // Built from the REAL projection, not by overriding `status` on a resolved
    // fixture. r5's version left a resolved commercial lineage attached to an
    // "unavailable" panel — an object the server can never produce — and then
    // asserted only the generic sentence.
    const real = unavailableEvidencePanel("gate_verdict_absent");
    render(<BudgetDecisionEvidencePanel evidence={evidence({ increase: real })} />);
    expect(direction("increase")?.getAttribute("data-status")).toBe("unavailable");
    expect(direction("increase")?.textContent).toContain("could not be resolved");
    expect(direction("increase")?.querySelector('[data-el="section"][data-clear="true"]')).toBeNull();
  });

  it("shows the exact GATE-level lineage for a missing verdict", () => {
    const real = unavailableEvidencePanel("gate_verdict_absent");
    render(<BudgetDecisionEvidencePanel evidence={evidence({ increase: real })} />);
    const node = direction("increase")!;
    // The reason the panel is unavailable, visibly.
    expect(node.querySelector('[data-el="unavailable-reason"]')?.getAttribute("data-reason"))
      .toBe("gate_verdict_absent");
    expect(node.textContent).toContain("gate_verdict_absent");
    // A GATE-level availability status, not a profile-level one.
    const avail = node.querySelector('[data-el="commercial-availability"]')!;
    expect(avail.getAttribute("data-status")).toBe("gate_not_evaluated");
    expect(avail.textContent).toContain("no gate verdict was produced for this account");
    // Unknown eligibility and code, said out loud rather than left blank.
    expect(node.querySelector('[data-el="commercial-code"]')?.textContent).toContain("Canonical code: none");
    expect(node.querySelector('[data-el="commercial-eligible"]')?.textContent)
      .toContain("Canonical eligibility: unknown");
    expect(node.querySelector('[data-el="commercial-contract"]')?.textContent)
      .toContain("expected adsecute.account-decision-profile.v1, observed none");
    expect(node.querySelector('[data-el="execution-readiness"]')?.getAttribute("data-cta-enabled")).toBe("false");
  });

  it("distinguishes an unsupported GATE contract from a missing verdict", () => {
    const real = unavailableEvidencePanel("gate_contract_unsupported");
    render(<BudgetDecisionEvidencePanel evidence={evidence({ increase: real })} />);
    const node = direction("increase")!;
    expect(node.querySelector('[data-el="unavailable-reason"]')?.getAttribute("data-reason"))
      .toBe("gate_contract_unsupported");
    expect(node.querySelector('[data-el="commercial-availability"]')?.textContent)
      .toContain("the gate contract version served is not the one this surface reads");
    // The two unavailable causes must not render the same sentence.
    const other = unavailableEvidencePanel("gate_verdict_absent");
    const reasonOf = (p: PanelModel): string | null =>
      p.commercialLineage.availability.status === "resolved"
        ? null
        : p.commercialLineage.availability.reason;
    expect(reasonOf(other)).not.toBe(reasonOf(real));
    expect(reasonOf(real)).not.toBeNull();
  });

  it("keeps the four resolved profile-source states visibly distinct", () => {
    const seen = new Set<string>();
    for (const status of ["read_failed", "output_not_retained", "action_not_published", "resolved"] as const) {
      cleanup();
      const p = panel({
        commercialLineage: {
          selectedAction: "scale", eligible: null, code: null, reason: null,
          anchorExplanation: null, contractVersion: null,
          availability: {
            status,
            reason: `profile source status is ${status}`,
            expectedContract: "adsecute.account-decision-profile.v1",
            observedContract: null,
          },
        },
      });
      render(<BudgetDecisionEvidencePanel evidence={evidence({ increase: p })} />);
      const avail = direction("increase")?.querySelector('[data-el="commercial-availability"]');
      expect(avail?.getAttribute("data-status")).toBe(status);
      seen.add(String(avail?.getAttribute("data-status")));
    }
    expect(seen.size).toBe(4);
  });

  it("never enables a call to action in either direction", () => {
    render(<BudgetDecisionEvidencePanel evidence={evidence()} />);
    const buttons = root()?.querySelectorAll("button") ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of Array.from(buttons)) expect(button.hasAttribute("disabled")).toBe(true);
    for (const d of ["increase", "decrease"] as const) {
      expect(direction(d)?.querySelector('[data-el="execution-readiness"]')?.getAttribute("data-state")).toBe("not_executable");
    }
  });

  it("does no arithmetic and derives no buyer action, role or threshold", () => {
    const source = readFileSync(resolve("components/meta/decision-center/BudgetDecisionEvidencePanel.tsx"), "utf8");
    // Comment prose is not code: strip block comments and JSX comments before
    // looking for arithmetic, or every "* " in a JSDoc line reads as a
    // multiplication.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const forbidden of [/Math\./, /\breduce\(/, /parseFloat/, /\bNumber\(/, /[)\w]\s[-+*/]\s[(\w]/]) {
      expect(forbidden.test(code), String(forbidden)).toBe(false);
    }
    expect(code).not.toMatch(/buyerAction|inferredKind|campaignRole|threshold\s*=/i);
    // Every rendered verdict comes from props; none is computed here. JSX
    // attribute names like `data-eligible={...}` are rendering, not derivation,
    // so the check targets local assignment rather than any occurrence.
    expect(code).not.toMatch(/(?:const|let|var)\s+(?:eligible|authority)\s*=/);
    // And the direction-to-action mapping must no longer live in this file.
    expect(code).not.toMatch(/DIRECTION_ACTION/);
  });
});

describe("the layout is responsive by stylesheet, not by component logic", () => {
  const css = readFileSync(resolve("components/meta/decision-center/MetaDecisionCenterExact.module.css"), "utf8");

  it("uses the surface's own tokens and grid idiom for the two directions", () => {
    expect(css).toContain(".budgetEvidenceDirections");
    expect(css).toMatch(/\.budgetEvidenceDirections\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit/);
  });

  it("collapses to one column at the surface's existing mobile breakpoint", () => {
    const mobile = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(mobile).toContain(".budgetEvidenceDirections");
    expect(mobile).toMatch(/\.budgetEvidenceDirections\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  });

  it("holds no breakpoint or viewport logic in the component itself", () => {
    const source = readFileSync(resolve("components/meta/decision-center/BudgetDecisionEvidencePanel.tsx"), "utf8");
    expect(source).not.toMatch(/matchMedia|innerWidth|useEffect|useState|window\./);
  });
});
