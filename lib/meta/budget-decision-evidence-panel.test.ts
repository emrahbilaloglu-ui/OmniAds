import { describe, expect, it } from "vitest";

import {
  META_BUDGET_DECISION_EVIDENCE_PANEL_CONTRACT,
  projectBudgetDecisionEvidencePanel,
  unavailableEvidencePanel,
} from "@/lib/meta/budget-decision-evidence-panel";
import {
  BUDGET_DECISION_GATE_CODES,
  META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
  type BudgetDecisionGateCode,
  type BudgetDecisionGateVerdict,
} from "@/lib/meta/budget-decision-gates";

const verdict = (over: Partial<BudgetDecisionGateVerdict> = {}): BudgetDecisionGateVerdict => ({
  contractVersion: META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
  authority: "blocked",
  blockerCodes: ["commercial_anchor_not_hard_action_eligible", "threshold_not_owner_approved"],
  reasons: [
    { code: "commercial_anchor_not_hard_action_eligible", reason: "the canonical profile reports the commercial anchor is not hard-action eligible" },
    { code: "threshold_not_owner_approved", reason: "every threshold here is proposed governance and no owner has approved it" },
  ],
  intent: null,
  intentKey: null,
  intentRejections: [],
  intentReasons: [],
  primaryBlocker: {
    code: "commercial_anchor_not_hard_action_eligible",
    reason: "the canonical profile reports the commercial anchor is not hard-action eligible",
  },
  lineage: {
    gateContract: META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
    commercialAuthority: "AccountDecisionProfile.hardActionEligibility",
    commercialProfileContract: "account-decision-profile.v1",
    commercialSelectedAction: null, commercialSelectedEligible: null, commercialSelectedCode: null, commercialSelectedActionReason: null,
    commercialAnchorExplanation: null, commercialProfileUnavailable: null,
    intentContractDelegated: false,
    evaluatedAtOriginMs: 0,
  },
  executable: false,
  ...over,
});

describe("the evidence panel is server-owned and never enables a CTA", () => {
  it("never renders an enabled CTA, in any state", () => {
    for (const panel of [
      projectBudgetDecisionEvidencePanel({ verdict: verdict() }),
      projectBudgetDecisionEvidencePanel({ verdict: verdict({ authority: "validated_only", blockerCodes: [], reasons: [] }) }),
      unavailableEvidencePanel("gate_verdict_absent"),
    ]) {
      expect(panel.executionReadiness.ctaEnabled).toBe(false);
      expect(panel.executionReadiness.state).toBe("not_executable");
    }
  });

  it("keeps an unavailable panel from reading as clear or eligible", () => {
    const panel = unavailableEvidencePanel("gate_verdict_absent");
    expect(panel.status).toBe("unavailable");
    expect(panel.authority).toBeNull();
    // Absence is never "nothing is blocking".
    for (const section of panel.sections) expect(section.clear).toBe(false);
    expect(panel.primaryBlocker).toBeNull();
  });

  it("refuses an unsupported gate contract rather than rendering it", () => {
    const panel = projectBudgetDecisionEvidencePanel({
      verdict: verdict({ contractVersion: "something.else" as never }),
    });
    expect(panel.status).toBe("unavailable");
    expect(panel.unavailableReason).toBe("gate_contract_unsupported");
  });

  it("names exactly one primary blocker, and it is the gate layer's first", () => {
    const panel = projectBudgetDecisionEvidencePanel({ verdict: verdict() });
    // The pair travels together: the code and the sentence that explains it.
    expect(panel.primaryBlocker?.code).toBe("commercial_anchor_not_hard_action_eligible");
    expect(panel.primaryBlocker?.reason).toContain("not hard-action eligible");
  });

  it("routes each code to its section and never invents a reason", () => {
    const panel = projectBudgetDecisionEvidencePanel({ verdict: verdict() });
    const commercial = panel.sections.find((s) => s.section === "commercial_target")!;
    const change = panel.sections.find((s) => s.section === "change_safety")!;
    const evidence = panel.sections.find((s) => s.section === "evidence_floor")!;
    expect(commercial.blockerCodes).toEqual(["commercial_anchor_not_hard_action_eligible"]);
    expect(change.blockerCodes).toEqual(["threshold_not_owner_approved"]);
    expect(evidence.clear).toBe(true);
    // Every rendered sentence came from the server, none was composed here.
    for (const reason of [...commercial.reasons, ...change.reasons]) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("marks a clear section only when nothing in it is unmet", () => {
    const panel = projectBudgetDecisionEvidencePanel({
      verdict: verdict({ authority: "validated_only", blockerCodes: [], reasons: [] }),
    });
    for (const section of panel.sections) expect(section.clear).toBe(true);
    // ...and validated_only is still not executable.
    expect(panel.executionReadiness.ctaEnabled).toBe(false);
    expect(panel.authority).toBe("validated_only");
  });

  it("labels a counterfactual and never grants it authority", () => {
    const panel = projectBudgetDecisionEvidencePanel({
      verdict: verdict(),
      counterfactualLabel: "D083 capture fields assumed available",
    });
    expect(panel.counterfactual?.neverActionAuthority).toBe(true);
    expect(panel.counterfactual?.label).toContain("assumed");
    // No counterfactual by default.
    expect(projectBudgetDecisionEvidencePanel({ verdict: verdict() }).counterfactual).toBeNull();
  });

  it("never restates the persisted generic blocker family", () => {
    const panel = projectBudgetDecisionEvidencePanel({ verdict: verdict() });
    expect(JSON.stringify(panel)).not.toContain("profile_hard_action_ineligible");
  });

  it("never renders retired commercial vocabulary", () => {
    const text = JSON.stringify(projectBudgetDecisionEvidencePanel({ verdict: verdict() }));
    expect(text).not.toContain("CPA ceiling");
    expect(text).not.toContain("AOV floor");
  });

  it("pins its contract version so a surface cannot silently drift", () => {
    expect(projectBudgetDecisionEvidencePanel({ verdict: verdict() }).contractVersion).toBe(
      META_BUDGET_DECISION_EVIDENCE_PANEL_CONTRACT,
    );
  });
});

/**
 * Correction 1 — the section map must be TOTAL.
 *
 * Five codes used to map to `null`, so they appeared in no section at all
 * while remaining eligible to be the primary blocker. A surface could then
 * name a blocker that every section it rendered denied having.
 */
describe("every gate code is renderable in exactly one section", () => {
  const verdictWith = (codes: readonly BudgetDecisionGateCode[]) => ({
    contractVersion: META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
    authority: "blocked" as const,
    blockerCodes: [...codes],
    reasons: codes.map((code) => ({ code, reason: `reason for ${code}` })),
    primaryBlocker: { code: codes[0]!, reason: `reason for ${codes[0]!}` },
    intent: null,
    intentKey: null,
    intentRejections: [],
    intentReasons: [],
    lineage: {
      gateContract: META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
      commercialAuthority: "AccountDecisionProfile.hardActionEligibility" as const,
      commercialProfileContract: null,
      commercialSelectedAction: null,
      commercialSelectedEligible: null,
      commercialSelectedCode: null,
      commercialSelectedActionReason: null,
      commercialAnchorExplanation: null,
      commercialProfileUnavailable: null,
      intentContractDelegated: false,
      evaluatedAtOriginMs: 0,
    },
    executable: false as const,
  });

  it("places every declared code in a section, with its own sentence", () => {
    const panel = projectBudgetDecisionEvidencePanel({
      verdict: verdictWith(BUDGET_DECISION_GATE_CODES),
    });
    const placed = panel.sections.flatMap((s) => s.blockerCodes);
    expect([...placed].sort()).toEqual([...BUDGET_DECISION_GATE_CODES].sort());
    // Exactly one section, never two.
    expect(placed.length).toBe(BUDGET_DECISION_GATE_CODES.length);
    for (const section of panel.sections) {
      expect(section.reasons.length, section.section).toBe(section.blockerCodes.length);
      section.blockerCodes.forEach((code, index) => {
        // The sentence in slot i belongs to the code in slot i.
        expect(section.reasons[index], code).toBe(`reason for ${code}`);
      });
    }
  });

  it("can render whichever code becomes the primary blocker, one at a time", () => {
    for (const code of BUDGET_DECISION_GATE_CODES) {
      const panel = projectBudgetDecisionEvidencePanel({ verdict: verdictWith([code]) });
      expect(panel.primaryBlocker?.code, code).toBe(code);
      const owning = panel.sections.find((s) => s.blockerCodes.includes(code));
      expect(owning, `${code} is in no section`).toBeTruthy();
      expect(owning!.reasons).toContain(panel.primaryBlocker!.reason);
      // And the sections that do not own it must report themselves clear.
      for (const other of panel.sections.filter((s) => s !== owning)) {
        expect(other.clear, `${code}/${other.section}`).toBe(true);
      }
    }
  });
});

describe("the new change-safety code is renderable like every other", () => {
  it("places change_safety_history_unavailable in the change-safety section", () => {
    const panel = projectBudgetDecisionEvidencePanel({
      verdict: {
        contractVersion: META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
        authority: "blocked",
        blockerCodes: ["change_safety_history_unavailable"],
        reasons: [{ code: "change_safety_history_unavailable", reason: "history was not read" }],
        primaryBlocker: { code: "change_safety_history_unavailable", reason: "history was not read" },
        intent: null, intentKey: null, intentRejections: [], intentReasons: [],
        lineage: {
          gateContract: META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
          commercialAuthority: "AccountDecisionProfile.hardActionEligibility",
          commercialProfileContract: null,
      commercialSelectedAction: null, commercialSelectedEligible: null, commercialSelectedCode: null, commercialSelectedActionReason: null,
      commercialAnchorExplanation: null, commercialProfileUnavailable: null,
      intentContractDelegated: false, evaluatedAtOriginMs: 0,
        },
        executable: false,
      },
    });
    const owning = panel.sections.find((s) => s.blockerCodes.includes("change_safety_history_unavailable"));
    expect(owning?.section).toBe("change_safety");
    expect(owning?.reasons).toContain("history was not read");
  });
});
