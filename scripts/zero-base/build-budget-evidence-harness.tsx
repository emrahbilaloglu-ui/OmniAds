/**
 * D084 Correction 3 — real-layout harness for the budget-decision evidence.
 *
 * WHY THIS EXISTS. r3 claimed a responsive proof from a stylesheet regex plus
 * jsdom node presence. jsdom applies no CSS at all, so neither check could ever
 * observe a column count, a bounding box, an overlap or an overflow. This
 * renders the REAL `MetaDecisionCenterExact` surface, with the REAL
 * `MetaDecisionCenterExact.module.css`, to a static page a browser can measure.
 *
 * No server, no database, no credentials: the surface is a pure function of its
 * view model, so a real CSS engine is all the layout contract needs.
 *
 * Output goes to `playwright/.harness/`, which is generated evidence, not source.
 */
import "./css-module-stub";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MetaDecisionCenterExact } from "@/components/meta/decision-center/MetaDecisionCenterExact";
import type { MetaBudgetDecisionEvidenceByDirection } from "@/lib/meta/budget-decision-evidence-panel";

const ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "playwright", ".harness");

export const BUDGET_EVIDENCE_WIDTHS = [1440, 390] as const;

export function budgetEvidenceHarnessFileName(width: number): string {
  return `budget-evidence-${width}.html`;
}

/** Distinct per-direction lineage, so a swap or a merge would be visible. */
const EVIDENCE: MetaBudgetDecisionEvidenceByDirection = {
  contractVersion: "meta-budget-decision-evidence-directional.v3",
  directionSelected: null,
  directionSelectedWhy:
    "this panel is account-scoped and no proposal direction has been selected; both directions are published for review and neither is proposed",
  directionToAction: { increase: "scale", decrease: "cut" },
  directionToActionWhy:
    "an increase is a scale decision and a decrease is a cut decision; refresh is never a budget-direction substitute",
  increase: {
    contractVersion: "meta-budget-decision-evidence-panel.v4",
    status: "resolved",
    unavailableReason: null,
    authority: "blocked",
    primaryBlocker: {
      code: "budget_fact_absent",
      reason: "no canonical budget fact was resolved for this entity at this origin",
    },
    commercialLineage: {
      selectedAction: "scale",
      eligible: false,
      code: "SCALE_CODE",
      reason: "SCALE-SPECIFIC: no operator AOV accompanies the retained Target ROAS",
      anchorExplanation: { spendUnit: null, spendUnitSource: "unresolved", missingInputs: ["aov_assumption"] },
      contractVersion: "adsecute.account-decision-profile.v1",
      availability: { status: "resolved" },
    },
    sections: [
      { section: "input_integrity", blockerCodes: [], reasons: [], clear: true },
      {
        section: "commercial_target",
        blockerCodes: ["commercial_anchor_not_hard_action_eligible"],
        reasons: ["the canonical profile reports the commercial anchor is not hard-action eligible"],
        clear: false,
      },
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
    executionReadiness: { state: "not_executable", why: "at least one local gate is unmet", ctaEnabled: false },
    counterfactual: null,
  },
  decrease: {
    contractVersion: "meta-budget-decision-evidence-panel.v4",
    status: "resolved",
    unavailableReason: null,
    authority: "blocked",
    primaryBlocker: {
      code: "change_safety_history_unavailable",
      reason: "recent-change history for at least one declared scope was not read",
    },
    commercialLineage: {
      selectedAction: "cut",
      eligible: null,
      code: null,
      reason: null,
      anchorExplanation: null,
      contractVersion: null,
      availability: {
        status: "read_failed",
        reason: "CUT-SPECIFIC: the account decision profile read failed",
        expectedContract: "adsecute.account-decision-profile.v1",
        observedContract: null,
      },
    },
    sections: [
      { section: "input_integrity", blockerCodes: [], reasons: [], clear: true },
      {
        section: "commercial_target",
        blockerCodes: ["commercial_profile_unavailable"],
        reasons: ["the account decision profile could not be resolved, so commercial authority is unknown"],
        clear: false,
      },
      { section: "evidence_floor", blockerCodes: [], reasons: [], clear: true },
      {
        section: "change_safety",
        blockerCodes: ["change_safety_history_unavailable"],
        reasons: ["recent-change history for at least one declared scope was not read"],
        clear: false,
      },
      { section: "execution_capability", blockerCodes: [], reasons: [], clear: true },
    ],
    executionReadiness: { state: "not_executable", why: "at least one local gate is unmet", ctaEnabled: false },
    counterfactual: null,
  },
};

function surfaceCss(): string {
  // The surface's OWN module, appended verbatim. `css-module-stub` leaves class
  // names unhashed, so these selectors match the rendered markup exactly.
  return readFileSync(
    path.join(ROOT, "components", "meta", "decision-center", "MetaDecisionCenterExact.module.css"),
    "utf8",
  );
}

export function buildBudgetEvidenceHarness(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const body = renderToStaticMarkup(
    <MetaDecisionCenterExact viewModel={{ budgetEvidence: EVIDENCE }} />,
  );
  for (const width of BUDGET_EVIDENCE_WIDTHS) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Budget decision evidence — ${width}px</title>
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${surfaceCss()}</style>
</head><body>${body}</body></html>`;
    writeFileSync(path.join(OUT_DIR, budgetEvidenceHarnessFileName(width)), html);
  }
  console.log(
    JSON.stringify({
      phase: "budget-evidence-harness",
      widths: [...BUDGET_EVIDENCE_WIDTHS],
      outDir: path.relative(ROOT, OUT_DIR),
    }),
  );
}

buildBudgetEvidenceHarness();
