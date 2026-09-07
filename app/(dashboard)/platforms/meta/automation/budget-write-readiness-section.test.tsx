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

const model = (
  over: Partial<BudgetWriteReadinessModel> = {},
): BudgetWriteReadinessModel => ({
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
  canConfigure: true,
  canDisable: true,
  reason: null,
  reasonCode: null,
  surface: "desktop" as const,
};

describe("D087 — automatic actions stay truthful without backend detail", () => {
  it("shows the operator state and omits proposal internals", () => {
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={model()}
        authorization={ADMIN_DESKTOP}
      />,
    );
    for (const field of [
      "owner-grain",
      "entity-id",
      "budget-field",
      "before-amount-minor",
      "intended-amount-minor",
      "currency",
      "change-percent",
      "evidence-as-of",
      "evidence-age-hours",
      "readback-state",
      "rollback-eligible",
      "proposal-state",
      "claim-state",
      "reconcile-state",
    ]) {
      expect(html, field).not.toContain(`data-field="${field}"`);
    }
    expect(html).toContain("Automatic actions");
    expect(html).toContain(
      'data-field="business-master-switch" data-value="false"',
    );
    expect(html).not.toContain("250000");
    expect(html).not.toContain("300000");
    expect(html).not.toContain("Transport prepared");
  });

  it("declares automatic actions off and lists human-readable requirements", () => {
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={model()}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(html).toContain('data-execution-enabled="false"');
    expect(html).toContain('data-capability-prepared="true"');
    expect(html).toContain('data-field="activation-ready-blockers"');
    expect(html).toContain('data-blocker-code="global_gate_closed"');
    expect(html).toContain("Automatic Meta actions are not available yet.");
    expect(html).toContain('data-blocker-code="budget_mode_not_auto"');
    expect(html).toContain("Set Budget to Automatic.");
    expect(html).not.toContain("automation_disabled");
    expect(html).not.toContain("live-write capability");
  });

  it("offers no DISPATCH affordance; its controls change a CONTROL ROW, not a budget", () => {
    /*
      D088 C1 added a real enable control. It is not a dispatch: it cannot write
      a budget, it can only ask the server to change a persisted control, and it
      is disabled by the server's own verdict rather than by a constant — so the
      day that verdict is clean, it works with no code change.
    */
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={model()}
        authorization={ADMIN_DESKTOP}
      />,
    );
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
    // The current account is off, so a business-wide-looking Disable would lie.
    expect(html).not.toContain('data-testid="budget-activation-disable"');
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
    expect(html).not.toMatch(
      /data-testid="budget-activation-enable"[^>]*disabled=""/,
    );
  });

  it("does not expose proposal values or compute a buyer action", () => {
    const m = model();
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={m}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(html).not.toContain(m.proposal!.entityId);
    expect(html).not.toContain(m.proposal!.budgetField);
    // Whole words: "execution" legitimately contains "cut", and a substring
    // test that failed on it would be measuring English, not authority.
    for (const forbidden of [
      "buyerAction",
      "scale",
      "cut",
      "refresh",
      "Promote to main",
      "Test campaign",
      "Main campaign",
      "brief_variation",
    ]) {
      expect(html, forbidden).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it("does not surface raw proposal measurements when they are unknown", () => {
    const m = model();
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={{
          ...m,
          proposal: {
            ...m.proposal!,
            changePercent: null,
            evidenceAgeHours: null,
          },
        }}
      />,
    );
    expect(html).not.toContain('data-field="change-percent"');
    expect(html).not.toContain('data-field="evidence-age-hours"');
  });

  it("keeps the control usable without exposing a backend unavailable reason", () => {
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={{
          ...model(),
          proposal: null,
          unavailableReason: "The baseline must carry a retained amount.",
        }}
      />,
    );
    expect(html).toContain("Automatic actions");
    expect(html).not.toContain('data-field="unavailable-reason"');
    expect(html).not.toContain("The baseline must carry a retained amount.");
    expect(html).not.toContain('data-field="intended-amount-minor"');
  });

  it("a missing model renders unavailable, never enabled", () => {
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={null}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(html).toContain('data-testid="budget-write-readiness-unavailable"');
    expect(html).not.toContain('data-execution-enabled="true"');
  });
});

describe("D088 C2 — the ceremony calls the real admin route", () => {
  it("posts the intent and the phrase, and NEVER a readiness verdict", () => {
    const source = readFileSync(
      "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
      "utf8",
    );
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
      "readiness:",
      "globalGateOpen",
      "canonicalFactRetentionReady",
      "blockers:",
    ]) {
      expect(handler, forbidden).not.toContain(forbidden);
    }
  });

  it("does not expose raw refusal codes or blocker lists", () => {
    const source = readFileSync(
      "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
      "utf8",
    );
    expect(source).toContain('data-field="activation-response"');
    expect(source).toContain("Automatic actions could not be changed.");
  });

  it("names automatic actions and their per-action mode", () => {
    /*
      PRE-DEPLOY AUDIT: the control writes the business-wide
      `auto_execution_enabled` column. Copy that called it a budget setting told
      an admin they were enabling one decision type when they were enabling the
      business-wide gate. The section now states both keys.
    */
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={model()}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(html).toContain('data-field="master-switch-scope"');
    expect(html).toContain("Eligible actions set to Automatic");
    // And it must not describe itself as budget-scoped in the heading.
    expect(html).not.toContain("Budget change capability");
  });

  it("a `mobile_read_only` AUTHORIZATION renders NO actionable control", () => {
    /*
      PRE-DEPLOY AUDIT: this section used to render the same live Enable and
      Disable buttons on the mobile pane as on the desktop one.

      The name of the law moved but the law did not. The mobile pane is no
      longer read-only — it carries the Meta stop and the confirmation queue —
      so the refusal now names the CONTROL rather than the pane. What is
      unchanged, and is the guard, is that a `"mobile_read_only"` authorization
      draws nothing actionable: arming automatic execution stays
      desktop-and-admin-only, and `buildBudgetMasterSwitchAuthorization`
      refuses that surface unconditionally.
    */
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={model()}
        authorization={{
          canConfigure: false,
          canDisable: false,
          reason:
            "Automatic execution is changed only in the desktop workspace. Open Automation on a desktop browser to change it.",
          reasonCode: "read_only_surface",
          surface: "mobile_read_only",
        }}
      />,
    );
    for (const control of [
      "budget-activation-form",
      "budget-activation-phrase",
      "budget-activation-enable",
      "budget-activation-disable",
      "<form",
      "<button",
      "<input",
    ]) {
      expect(html, control).not.toContain(control);
    }
    // The STATUS is still fully rendered — refused is not blind.
    expect(html).toContain(
      "Open Automation on desktop to change automatic actions.",
    );
    expect(html).not.toContain(
      "Automatic execution is changed only in the desktop workspace.",
    );
    expect(html).toContain('data-field="business-master-switch"');
    expect(html).toContain('data-effective-write="false"');
    expect(html).toContain('data-field="master-switch-refusal"');
    expect(html).toContain('data-reason-code="read_only_surface"');
  });

  it("a NON-ADMIN viewer sees the concrete reason, not a dead button", () => {
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={model()}
        authorization={{
          canConfigure: false,
          canDisable: false,
          reason:
            "Changing automatic execution requires admin access on this business.",
          reasonCode: "insufficient_role",
          surface: "desktop",
        }}
      />,
    );
    expect(html).not.toContain("budget-activation-enable");
    expect(html).not.toContain("budget-activation-disable");
    expect(html).toContain(
      "Admin access is required to change automatic actions.",
    );
    expect(html).not.toContain(
      "Changing automatic execution requires admin access on this business.",
    );
    expect(html).toContain('data-reason-code="insufficient_role"');
  });

  it("an ABSENT authorization renders read-only, never a control", () => {
    // The safe default: a section mounted without an explicit authorization
    // must not offer the strongest control in the product.
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection readiness={model()} />,
    );
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    expect(html).toContain('data-reason-code="read_only_surface"');
  });

  it("DISABLE stays available to an admin when readiness is RED", () => {
    // Once this exact account is active, readiness cannot hide its stop.
    const m = model();
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={{
          ...m,
          execution: {
            ...m.execution,
            executionEnabled: true,
            activatedProviderAccountId: "act_1",
            activationReadyBlockers: [
              "dry_run_guardrail_engaged",
              "open_claim",
            ],
          },
        }}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(html).toContain('data-testid="budget-activation-disable"');
    // ...and it is NOT disabled, while Enable is.
    const disableTag = html.slice(
      html.indexOf('data-testid="budget-activation-disable"'),
    );
    expect(disableTag.slice(0, 200)).not.toContain("disabled=");
    expect(html).not.toContain('data-testid="budget-activation-enable"');
  });

  it("names the other exact account and offers no cross-account switch", () => {
    const m = model();
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={{
          ...m,
          execution: {
            ...m.execution,
            executionEnabled: false,
            activatedProviderAccountId: "act_987654321",
            activationReadyBlockers: [],
          },
        }}
        authorization={ADMIN_DESKTOP}
      />,
    );

    expect(html).toContain("On for another account");
    expect(html).toContain('data-field="activated-account-fact"');
    expect(html).toContain("Meta ad account 987…4321");
    expect(html).not.toContain("987654321");
    expect(html).toContain("Open that account to manage them.");
    expect(html).not.toContain('data-field="activation-ready-blockers"');
    expect(html).not.toContain('data-testid="budget-activation-form"');
    expect(html).not.toContain('data-testid="budget-activation-enable"');
    expect(html).not.toContain('data-testid="budget-activation-disable"');
    expect(html).not.toContain('data-testid="budget-preparation-form"');
  });

  it("withholds every business-wide switch when the active account is unknown", () => {
    const m = model();
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={{
          ...m,
          execution: {
            ...m.execution,
            executionEnabled: true,
            activatedProviderAccountId: null,
            activationReadyBlockers: [],
          },
        }}
        authorization={ADMIN_DESKTOP}
      />,
    );

    expect(html).toContain("On — account unavailable");
    expect(html).toContain("Refresh before managing automatic actions.");
    expect(html).not.toContain('data-field="activation-ready-blockers"');
    expect(html).not.toContain('data-testid="budget-activation-form"');
    expect(html).not.toContain('data-testid="budget-activation-disable"');
    expect(html).not.toContain('data-testid="budget-preparation-form"');
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
    expect(html).toContain(
      'data-field="business-master-switch" data-value="false"',
    );
    expect(html).toContain(">Off<");
    expect(html).toContain('data-effective-write="false"');
    expect(html).not.toContain("automatic budget write");
  });

  it("keeps backend readiness facts out of the visible panel", () => {
    const html = renderToStaticMarkup(
      <BudgetWriteReadinessSection
        readiness={model()}
        authorization={ADMIN_DESKTOP}
      />,
    );
    for (const field of [
      "environment-capability",
      "dry-run-guardrail",
      "activation-readiness",
      "effective-write",
    ]) {
      expect(html, field).not.toContain(`data-field="${field}"`);
    }
    expect(html).toContain('data-field="business-master-switch"');
  });
});
