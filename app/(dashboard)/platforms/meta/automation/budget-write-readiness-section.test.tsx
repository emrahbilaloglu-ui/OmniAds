/**
 * D087 — the budget write panel prints the server's verdict and offers nothing.
 *
 * The same rule the D086 panel holds: the UI must not compute `buyerAction`, a
 * role, an entity, a magnitude or eligibility. Here it must additionally not
 * compute whether execution is possible, and it must not render anything an
 * operator could press — because in this slice there is nothing to dispatch.
 */
import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { D087_ACTIVATION_BLOCKERS } from "@/lib/meta/budget-write-capability";
import type { BudgetWriteReadinessModel } from "@/lib/meta/budget-write-readiness";
import { BudgetWriteReadinessSection } from "./automation-view";

const model = (over: Partial<BudgetWriteReadinessModel> = {}): BudgetWriteReadinessModel => ({
  contract: "meta.budget-write-readiness.v1",
  businessId: "b1",
  providerAccountId: "act_1",
  proposal: {
    proposalId: "11111111-1111-4111-8111-111111111111",
    ownerGrain: "campaign",
    entityId: "c_100",
    budgetField: "daily_budget",
    currency: "TRY",
    currencyExponent: 2,
    beforeAmountMinor: 250000,
    intendedAmountMinor: 300000,
    changePercent: 20,
    evidenceAsOf: "2026-08-30T09:06:00.000Z",
    evidenceAgeHours: 0.9,
  },
  execution: {
    executionEnabled: false,
    capabilityPrepared: true,
    activationBlockers: D087_ACTIVATION_BLOCKERS,
    preflightBlockers: ["automation_disabled"],
    readbackState: "not_attempted",
    rollbackEligible: false,
    lastAttemptAt: null,
    proposalState: "pending",
    claimState: "unclaimed",
    reconcileState: "none",
    activatedProviderAccountId: null,
    activationReadyBlockers: ["global_gate_closed", "budget_mode_not_auto"],
  },
  unavailableReason: null,
  ...over,
});

const ADMIN_DESKTOP = {
  canConfigure: true, canDisable: true,
  reason: null, reasonCode: null, surface: "desktop" as const,
};

describe("D087 — the budget write panel is truthful and unpressable", () => {
  it("renders the before, the proposal, the owner and the evidence age", () => {
    const html = renderToStaticMarkup(<BudgetWriteReadinessSection readiness={model()} authorization={ADMIN_DESKTOP} />);
    for (const field of [
      "owner-grain", "entity-id", "budget-field", "before-amount-minor",
      "intended-amount-minor", "currency", "change-percent", "evidence-as-of",
      "evidence-age-hours", "readback-state", "rollback-eligible",
      // D088: the live queue facts the operator is actually looking at.
      "proposal-state", "claim-state", "reconcile-state",
    ]) {
      expect(html, field).toContain(`data-field="${field}"`);
    }
    expect(html).toContain(">250000<");
    expect(html).toContain(">300000<");
    /*
      PRE-DEPLOY AUDIT: the single phrase became six separately rendered facts,
      so an operator can tell WHICH one is the reason.
    */
    expect(html).toContain('data-field="environment-capability"');
    expect(html).toContain("Transport prepared in this build");
    expect(html).toContain('data-field="business-master-switch" data-value="false"');
  });

  it("declares execution DISABLED and lists why", () => {
    const html = renderToStaticMarkup(<BudgetWriteReadinessSection readiness={model()} authorization={ADMIN_DESKTOP} />);
    expect(html).toContain('data-execution-enabled="false"');
    expect(html).toContain('data-capability-prepared="true"');
    for (const blocker of D087_ACTIVATION_BLOCKERS) {
      expect(html, blocker.code).toContain(`data-blocker="${blocker.code}"`);
    }
    expect(html).toContain("automation_disabled");
    // ...and the activation verdict's own named conditions.
    expect(html).toContain('data-field="activation-ready-blockers"');
    expect(html).toContain("global_gate_closed");
    expect(html).toContain("budget_mode_not_auto");
  });

  it("offers no DISPATCH affordance; its controls change a CONTROL ROW, not a budget", () => {
    /*
      D088 C1 added a real enable control. It is not a dispatch: it cannot write
      a budget, it can only ask the server to change a persisted control, and it
      is disabled by the server's own verdict rather than by a constant — so the
      day that verdict is clean, it works with no code change.
    */
    const html = renderToStaticMarkup(<BudgetWriteReadinessSection readiness={model()} authorization={ADMIN_DESKTOP} />);
    /*
      D088 C2: there IS a form now, and it is the activation ceremony — it posts
      an intent and a typed phrase to the Automation route. It cannot dispatch a
      budget: no path from here reaches a provider, and the enable control is
      disabled by the SERVER's verdict.
    */
    for (const forbidden of ["<a ", "href=", "token"]) {
      expect(html, forbidden).not.toContain(forbidden);
    }
    expect(html).toContain('data-testid="budget-activation-form"');
    expect(html).toContain('data-testid="budget-activation-phrase"');
    expect(html).toContain('data-testid="budget-activation-enable"');
    // STOP is never gated.
    expect(html).toContain('data-testid="budget-activation-disable"');
    expect(html).toContain('data-enabled="false"');
    expect(html).toContain('data-display-only="true"');
  });

  it("the enable control becomes usable when the server verdict is clean", () => {
    const m = model();
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={{
          ...m,
          execution: { ...m.execution, activationReadyBlockers: [] },
        }}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(html).toContain('data-enabled="true"');
    expect(html).not.toMatch(/data-testid="budget-activation-enable"[^>]*disabled=""/);
  });

  it("computes nothing: every value rendered came from the model", () => {
    const m = model();
    const html = renderToStaticMarkup(<BudgetWriteReadinessSection readiness={m} authorization={ADMIN_DESKTOP} />);
    expect(html).toContain(m.proposal!.entityId);
    expect(html).toContain(m.proposal!.budgetField);
    expect(html).toContain(String(m.proposal!.changePercent));
    // Whole words: "execution" legitimately contains "cut", and a substring
    // test that failed on it would be measuring English, not authority.
    for (const forbidden of [
      "buyerAction", "scale", "cut", "refresh", "Promote to main",
      "Test campaign", "Main campaign", "brief_variation",
    ]) {
      expect(html, forbidden).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it("renders an unknown change as unknown, never as zero", () => {
    const m = model();
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={{ ...m, proposal: { ...m.proposal!, changePercent: null, evidenceAgeHours: null } }}
      />,
    );
    expect(html).toMatch(/data-field="change-percent"[^>]*>unknown</);
    expect(html).toMatch(/data-field="evidence-age-hours"[^>]*>unknown</);
  });

  it("renders NO proposal as a stated reason, never as an empty panel", () => {
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={{
          ...model(),
          proposal: null,
          unavailableReason: "The baseline must carry a retained amount.",
        }}
      />,
    );
    expect(html).toContain('data-field="unavailable-reason"');
    expect(html).toContain("The baseline must carry a retained amount.");
    expect(html).not.toContain('data-field="intended-amount-minor"');
  });

  it("a missing model renders unavailable, never enabled", () => {
    const html = renderToStaticMarkup(<BudgetWriteReadinessSection readiness={null} authorization={ADMIN_DESKTOP} />);
    expect(html).toContain('data-testid="budget-write-readiness-unavailable"');
    expect(html).not.toContain('data-execution-enabled="true"');
  });
});

describe("D088 C2 — the ceremony calls the real admin route", () => {
  it("posts the intent and the phrase, and NEVER a readiness verdict", () => {
    const source = readFileSync(
      "app/(dashboard)/platforms/meta/automation/automation-view.tsx", "utf8");
    const handler = source.slice(
      source.indexOf("const submitActivation"),
      source.indexOf("      setActivationBusy(false);"),
    );
    expect(handler).toContain("new URLSearchParams");
    expect(handler).toContain("/api/meta/automation?${query.toString()}");
    expect(handler).toContain('action: "set_budget_auto_execution"');
    expect(handler).toContain("confirmationPhrase");
    // The client sends no verdict and no blockers.
    for (const forbidden of [
      "readiness:", "globalGateOpen", "canonicalFactRetentionReady", "blockers:",
    ]) {
      expect(handler, forbidden).not.toContain(forbidden);
    }
  });

  it("renders the server's refusal rather than inventing one", () => {
    const source = readFileSync(
      "app/(dashboard)/platforms/meta/automation/automation-view.tsx", "utf8");
    expect(source).toContain('data-field="activation-response"');
    expect(source).toContain("payload?.error?.code");
    expect(source).toContain("payload?.blockers");
  });

  it("names the MASTER switch and the second key, not a budget-only setting", () => {
    /*
      PRE-DEPLOY AUDIT: the control writes the business-wide
      `auto_execution_enabled` column. Copy that called it a budget setting told
      an admin they were enabling one decision type when they were enabling the
      business-wide gate. The section now states both keys.
    */
    const html = renderToStaticMarkup(<BudgetWriteReadinessSection readiness={model()} authorization={ADMIN_DESKTOP} />);
    expect(html).toContain('data-field="master-switch-scope"');
    expect(html).toContain("business-wide master switch");
    expect(html).toContain("Tier 3");
    // And it must not describe itself as budget-scoped in the heading.
    expect(html).not.toContain("Budget change capability");
  });

  it("a READ-ONLY mobile surface renders NO actionable control", () => {
    /*
      PRE-DEPLOY AUDIT: the mobile pane declares `data-read-only="true"` and
      says "Read-only" on screen, and it used to render the same live Enable
      and Disable buttons as the desktop pane.
    */
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={model()}
        authorization={{
          canConfigure: false, canDisable: false,
          reason: "This is the read-only mobile view. Open Automation on a desktop browser to change automatic execution.",
          reasonCode: "read_only_surface", surface: "mobile_read_only",
        }}
      />,
    );
    for (const control of [
      "budget-activation-form", "budget-activation-phrase",
      "budget-activation-enable", "budget-activation-disable",
      "<form", "<button", "<input",
    ]) {
      expect(html, control).not.toContain(control);
    }
    // The STATUS is still fully rendered — read-only is not blind.
    expect(html).toContain('data-field="business-master-switch"');
    expect(html).toContain('data-field="effective-write"');
    expect(html).toContain('data-field="master-switch-refusal"');
    expect(html).toContain('data-reason-code="read_only_surface"');
  });

  it("a NON-ADMIN viewer sees the concrete reason, not a dead button", () => {
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={model()}
        authorization={{
          canConfigure: false, canDisable: false,
          reason: "Changing automatic execution requires admin access on this business.",
          reasonCode: "insufficient_role", surface: "desktop",
        }}
      />,
    );
    expect(html).not.toContain("budget-activation-enable");
    expect(html).not.toContain("budget-activation-disable");
    expect(html).toContain("requires admin access");
    expect(html).toContain('data-reason-code="insufficient_role"');
  });

  it("an ABSENT authorization renders read-only, never a control", () => {
    // The safe default: a section mounted without an explicit authorization
    // must not offer the strongest control in the product.
    const html = renderToStaticMarkup(<BudgetWriteReadinessSection readiness={model()} />);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    expect(html).toContain('data-reason-code="read_only_surface"');
  });

  it("DISABLE stays available to an admin when readiness is RED", () => {
    // A stop that readiness could refuse is not a stop.
    const m = model();
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={{
          ...m,
          execution: {
            ...m.execution,
            activationReadyBlockers: ["dry_run_guardrail_engaged", "open_claim"],
          },
        }}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(html).toContain('data-testid="budget-activation-disable"');
    // ...and it is NOT disabled, while Enable is.
    const disableTag = html.slice(html.indexOf('data-testid="budget-activation-disable"'));
    expect(disableTag.slice(0, 200)).not.toContain("disabled=");
    expect(html).toContain('data-enabled="false"');
  });

  it("a MISSING control row reads OFF, and never infers enabled", () => {
    const m = model();
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={{
          ...m,
          execution: {
            ...m.execution,
            executionEnabled: false,
            activatedProviderAccountId: null,
          },
        }}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(html).toContain('data-field="business-master-switch" data-value="false"');
    expect(html).toContain(">OFF<");
    expect(html).toContain('data-field="effective-write" data-value="false"');
    expect(html).toContain("No automatic budget write can execute");
  });

  it("separates the six facts an operator needs to tell the reason apart", () => {
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection readiness={model()} authorization={ADMIN_DESKTOP} />);
    for (const field of [
      "environment-capability", "business-master-switch", "dry-run-guardrail",
      "activation-readiness", "activated-account-fact", "effective-write",
    ]) {
      expect(html, field).toContain(`data-field="${field}"`);
    }
  });
});
