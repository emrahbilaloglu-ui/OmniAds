// @vitest-environment jsdom

/**
 * D084 Correction 5 / D — the phone reads the SAME budget-decision object.
 *
 * Below 720px `app/globals.css` hides every sibling of
 * `.meta-mobile-decision-stage` with `display: none !important`. The
 * budget-decision evidence panel was mounted only inside
 * `MetaDecisionCenterExact`, which is a descendant of one of those hidden
 * siblings, so on the authenticated route at 390px both direction panels
 * measured 0x0 and the acceptance gate came back NOT_DETERMINABLE.
 *
 * The repair projects the SAME server-owned `viewModel.budgetEvidence` into
 * the mobile stage using the SAME component. These tests pin both halves of
 * that: the projection exists, and it introduces no second source of
 * commercial truth and no write authority.
 */

import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BudgetDecisionEvidencePanel } from "@/components/meta/decision-center/BudgetDecisionEvidencePanel";
import {
  META_BUDGET_DECISION_EVIDENCE_DIRECTIONAL_CONTRACT,
  projectBudgetDecisionEvidencePanel,
  type MetaBudgetDecisionEvidenceByDirection,
} from "@/lib/meta/budget-decision-evidence-panel";

afterEach(cleanup);

const PAGE = resolve("components/meta/redesign/MetaPlatformPage.tsx");
const source = readFileSync(PAGE, "utf8");

/** The `MetaMobileDecisionsScreen` body, so a desktop mount cannot satisfy this. */
function mobileScreenSource(): string {
  const start = source.indexOf("function MetaMobileDecisionsScreen(");
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf("\nfunction ", start + 10);
  return source.slice(start, next === -1 ? source.length : next);
}

describe("Correction 5 / D — mobile budget-evidence projection", () => {
  it("mounts the panel INSIDE the mobile decision stage", () => {
    const body = mobileScreenSource();
    expect(body).toContain("<BudgetDecisionEvidencePanel");
    expect(body).toContain("meta-mobile-decision-stage");
    // The evidence must be the server object off the shared view model, not a
    // locally assembled one.
    expect(body).toMatch(/evidence=\{viewModel\.budgetEvidence \?\? null\}/);
  });

  it("passes the SAME expression the desktop mount passes", () => {
    const desktop = readFileSync(
      resolve("components/meta/decision-center/MetaDecisionCenterExact.tsx"), "utf8",
    );
    const expression = "evidence={viewModel.budgetEvidence ?? null}";
    expect(desktop).toContain(expression);
    expect(mobileScreenSource()).toContain(expression);
  });

  it("re-derives no commercial truth on the mobile path", () => {
    const body = mobileScreenSource()
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    // No local direction-to-action map, no eligibility or threshold algebra,
    // no contract-version literal invented beside the panel.
    for (const forbidden of [
      /DIRECTION_ACTION/,
      /hardActionEligibility/,
      /breakEvenRoas/,
      /targetRoas\s*[<>=]/,
      /eligible\s*[=!]==?\s*(true|false)/,
      /"scale"\s*:\s*/,
      /account-decision-profile/,
    ]) {
      expect(body, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("adds no write control to the mobile stage", () => {
    const body = mobileScreenSource();
    // The projection is a render, not an action surface.
    for (const forbidden of [/onExecute/, /method:\s*"POST"/, /fetch\(/]) {
      expect(body, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("renders both directions and every canonical field from one server object", () => {
    // Built by the real projector so the object is one the server can produce.
    const evidence: MetaBudgetDecisionEvidenceByDirection = {
      contractVersion: META_BUDGET_DECISION_EVIDENCE_DIRECTIONAL_CONTRACT,
      directionSelected: null,
      directionSelectedWhy: "an account panel selects no proposal direction",
      directionToAction: { increase: "scale", decrease: "cut" },
      directionToActionWhy: "the server states which profile action each direction consulted",
      increase: projectBudgetDecisionEvidencePanel({ verdict: null }),
      decrease: projectBudgetDecisionEvidencePanel({ verdict: null }),
    };
    const { container } = render(<BudgetDecisionEvidencePanel evidence={evidence} />);
    const directions = container.querySelectorAll('[data-el="budget-decision-direction"]');
    expect(directions).toHaveLength(2);
    for (const node of Array.from(directions)) {
      expect(node.querySelector('[data-el="commercial-code"]')).not.toBeNull();
      expect(node.querySelector('[data-el="commercial-eligible"]')).not.toBeNull();
      expect(node.querySelector('[data-el="commercial-contract"]')).not.toBeNull();
      expect(node.querySelector('[data-el="commercial-availability"]')?.getAttribute("data-status"))
        .toBe("gate_not_evaluated");
    }
    // Read-only stays read-only.
    for (const button of Array.from(container.querySelectorAll("button"))) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
  });

  it("stacks to one column at the mobile breakpoint, in the shared stylesheet", () => {
    const css = readFileSync(
      resolve("components/meta/decision-center/MetaDecisionCenterExact.module.css"), "utf8",
    );
    const at720 = css.slice(css.indexOf("@media (max-width: 720px)"));
    const block = at720.slice(at720.indexOf(".budgetEvidenceDirections"));
    expect(block).toContain("grid-template-columns: minmax(0, 1fr)");
  });
});
