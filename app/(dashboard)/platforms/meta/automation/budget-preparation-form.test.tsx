/**
 * PRE-DEPLOY AUDIT — the mounted budget automation preparation form.
 *
 * The route action `save_budget_automation_config` shipped in D088 C3 with
 * ZERO callers. Activation readiness demands a persisted control row whose
 * dry-run guardrail is lifted and whose budget policy keys carry real numbers;
 * five of the six target businesses have no control row at all, and nothing on
 * any screen could write one. The documented ceremony therefore ended at a
 * button that could only ever answer "not ready", and the only way forward was
 * a hand-run SQL statement — the thing an activation ceremony exists to
 * replace.
 *
 * These cases hold the two ends that pull against each other: the form must be
 * usable enough to actually prepare a business, and it must be incapable of
 * enabling one or of inventing a value nobody chose.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { BudgetWriteReadinessModel } from "@/lib/meta/budget-write-readiness";
import {
  BUDGET_PREPARATION_READ_CONTRACT,
  everyFieldAt,
  projectStoredGuardrails,
  unpreparedFields,
  type BudgetPreparationView,
} from "@/lib/meta/budget-preparation-contract";
import { D087_ACTIVATION_BLOCKERS } from "@/lib/meta/budget-write-capability";
import type { BudgetMasterSwitchAuthorization } from "./viewer-envelope";
import { BudgetWriteReadinessSection } from "./automation-view";

const ADMIN_DESKTOP: BudgetMasterSwitchAuthorization = {
  canConfigure: true,
  canDisable: true,
  reason: null,
  reasonCode: null,
  surface: "desktop" as const,
};
const COLLABORATOR: BudgetMasterSwitchAuthorization = {
  canConfigure: false,
  canDisable: false,
  reason: "Only an admin may change automatic execution.",
  // The real code the envelope emits for a non-admin viewer.
  reasonCode: "insufficient_role" as const,
  surface: "desktop" as const,
};
const MOBILE_READ_ONLY: BudgetMasterSwitchAuthorization = {
  canConfigure: false,
  canDisable: false,
  reason: "This pane is read-only.",
  reasonCode: "read_only_surface" as const,
  surface: "mobile_read_only" as const,
};

const prepared = (
  over: Partial<BudgetPreparationView> = {},
): BudgetPreparationView => ({
  contract: BUDGET_PREPARATION_READ_CONTRACT,
  rowRead: true,
  rowExists: true,
  dryRunOnly: { state: "persisted", value: false },
  budgetMinHoursBetweenChanges: { state: "persisted", value: 12 },
  budgetMaxChangesPer7d: { state: "persisted", value: 3 },
  budgetMaxAccountConcentrationPct: { state: "persisted", value: 40 },
  maxBudgetIncreasePct: { state: "persisted", value: 25 },
  perActionSpendCeilingMinor: { state: "persisted", value: 500000 },
  perActionSpendCeilingCurrency: { state: "persisted", value: "TRY" },
  ...over,
});

const model = (
  preparation: BudgetPreparationView | null,
): BudgetWriteReadinessModel => ({
  contract: "meta.budget-write-readiness.v1",
  businessId: "b1",
  providerAccountId: "act_1",
  proposal: null,
  execution: {
    executionEnabled: false,
    capabilityPrepared: true,
    activationBlockers: D087_ACTIVATION_BLOCKERS,
    preflightBlockers: ["automation_disabled"],
    readbackState: "not_attempted",
    rollbackEligible: false,
    lastAttemptAt: null,
    proposalState: null,
    claimState: null,
    reconcileState: null,
    activatedProviderAccountId: null,
    activationReadyBlockers: ["global_gate_closed"],
  },
  unavailableReason: "No budget proposal is available.",
  preparation,
});

const render = (
  preparation: BudgetPreparationView | null,
  authorization: BudgetMasterSwitchAuthorization = ADMIN_DESKTOP,
  execution: Partial<BudgetWriteReadinessModel["execution"]> = {},
) => {
  const readiness = model(preparation);
  return renderToStaticMarkup(
    <BudgetWriteReadinessSection
      readiness={{
        ...readiness,
        execution: { ...readiness.execution, ...execution },
      }}
      authorization={authorization}
    />,
  );
};

const SOURCE = readFileSync(
  "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
  "utf8",
);

describe("preparation form — it is mounted at all", () => {
  it("renders on the surface the canonical route actually serves", () => {
    /*
      The whole defect: the action existed and no surface called it. This
      asserts the form is inside the section the mounted automation body
      renders, not merely that a component exists somewhere.
    */
    expect(render(prepared())).toContain(
      'data-testid="budget-preparation-form"',
    );
    expect(SOURCE).toContain('action: "save_budget_automation_config"');
  });

  it("posts to the existing route and contract, inventing no endpoint", () => {
    expect(SOURCE).toMatch(
      /fetch\(`\/api\/meta\/automation\?\$\{query\.toString\(\)\}`/,
    );
    // It sends the PARSED config, so the body is the contract's shape.
    expect(SOURCE).toContain("...parsed.config");
  });
});

describe("preparation form — role and surface gating", () => {
  it("is absent for a collaborator", () => {
    const html = render(prepared(), COLLABORATOR);
    expect(html).not.toContain('data-testid="budget-preparation-form"');
    expect(html).toContain('data-field="master-switch-refusal"');
  });

  it("is absent on the read-only mobile pane", () => {
    expect(render(prepared(), MOBILE_READ_ONLY)).not.toContain(
      'data-testid="budget-preparation-form"',
    );
  });

  it("is gated on canConfigure, not on canDisable", () => {
    /*
      STOP is never gated — a stop that can be refused is not a stop — so the
      disable button is offered to anyone who may disable. Preparation WRITES
      policy, so it follows the admin key instead. A viewer who may only stop
      must not be able to rewrite the guardrails.
    */
    const disableOnly = {
      ...ADMIN_DESKTOP,
      canConfigure: false,
      canDisable: true,
    };
    const html = render(prepared(), disableOnly, {
      executionEnabled: true,
      activatedProviderAccountId: "act_1",
    });
    expect(html).toContain('data-testid="budget-activation-disable"');
    expect(html).not.toContain('data-testid="budget-preparation-form"');
  });
});

describe("preparation form — persisted values, or an explicit unknown", () => {
  it("seeds the operator-facing limit fields from persisted values", () => {
    const html = render(prepared());
    expect(html).toMatch(/data-testid="preparation-min-hours"[^>]*value="12"/);
    expect(html).toMatch(/data-testid="preparation-max-changes"[^>]*value="3"/);
    expect(html).toMatch(
      /data-testid="preparation-ceiling-minor"[^>]*value="5000\.00"/,
    );
    expect(html).toMatch(
      /data-testid="preparation-ceiling-currency"[^>]*value="TRY"/,
    );
    expect(html).not.toContain("minor units");
    expect(html).not.toContain("saved:");
    expect(html).toContain('data-row-exists="true"');
  });

  it("uses the selected currency scale instead of assuming two decimals", () => {
    const html = render(
      prepared({
        perActionSpendCeilingMinor: {
          state: "persisted",
          value: 500000,
        },
        perActionSpendCeilingCurrency: {
          state: "persisted",
          value: "JPY",
        },
      }),
    );

    expect(html).toMatch(
      /data-testid="preparation-ceiling-minor"[^>]*value="500000"/,
    );
    expect(html).toContain('aria-label="Per-action spend limit (JPY)"');
  });

  it("leaves a missing limit empty without exposing field provenance", () => {
    const html = render(
      prepared({
        budgetMaxChangesPer7d: { state: "unset", value: null },
      }),
    );
    expect(html).not.toContain('data-state="unset"');
    // The input stays EMPTY. A pre-filled plausible number is the failure this
    // form exists to avoid: it lets an admin persist a default as a decision.
    expect(html).toMatch(/data-testid="preparation-max-changes"[^>]*value=""/);
  });

  it("locks the form with a short recovery message when limits are unreadable", () => {
    const unreadable: BudgetPreparationView = {
      contract: BUDGET_PREPARATION_READ_CONTRACT,
      rowRead: false,
      rowExists: false,
      ...everyFieldAt("unknown"),
    };
    const html = render(unreadable);
    expect(html).not.toContain('data-state="unknown"');
    expect(html).toContain("Saved limits are unavailable");
    expect(html).toContain('data-field="preparation-unreadable"');
    expect(html).toContain('data-row-read="false"');
    expect(html).toContain('data-fields-locked="true"');
  });

  it("renders an absent preparation block as unknown, never as unset", () => {
    // An older caller that supplies no block must not read as "nothing is
    // configured" — that would invite a save over a row nobody looked at.
    const html = render(null);
    expect(html).toContain('data-testid="budget-preparation-form"');
    expect(html).toContain("Saved limits are unavailable");
    expect(html).not.toContain('data-state="unset"');
  });

  it("names the prerequisites that are not yet prepared", () => {
    const html = render(
      prepared({
        maxBudgetIncreasePct: { state: "unset", value: null },
        dryRunOnly: { state: "unset", value: null },
      }),
    );
    expect(html).toContain('data-field="preparation-missing"');
    expect(html).toContain("preview setting");
    expect(html).toContain("maximum increase per change");
  });

  it("does not treat a clearable spend ceiling as a missing prerequisite", () => {
    const view = prepared({
      perActionSpendCeilingMinor: { state: "unset", value: null },
      perActionSpendCeilingCurrency: { state: "unset", value: null },
    });
    expect(unpreparedFields(view)).toEqual([]);
    expect(render(view)).not.toContain('data-field="preparation-missing"');
  });
});

describe("preparation form — saving keeps automatic actions off", () => {
  it("states the consequence before the fields", () => {
    const html = render(prepared());
    expect(html).toContain('data-field="preparation-warning"');
    expect(html).toContain("turns automatic actions off");
    // Ordering: the warning precedes the first input in the document.
    expect(html.indexOf('data-field="preparation-warning"')).toBeLessThan(
      html.indexOf('data-testid="preparation-dry-run-only"'),
    );
  });

  it("labels the form and button in operator language", () => {
    const html = render(prepared());
    expect(html).toContain("Save limits");
    expect(html).toContain("Automation limits");
  });
});

describe("preparation form — validation is the SERVER's, not a second opinion", () => {
  it("uses the route's own parser, imported from a db-free module", () => {
    expect(SOURCE).toContain(
      'from "@/lib/meta/budget-automation-config-contract"',
    );
    expect(SOURCE).toContain("parseBudgetAutomationConfig(candidate)");
    // A client component must never reach the database module.
    expect(SOURCE).not.toContain(
      'from "@/lib/meta/budget-automation-configuration"',
    );
    expect(SOURCE).not.toContain('from "@/lib/meta/budget-preparation-read"');
  });

  it("shows the route's own rejection code and holds the button", () => {
    // Every numeric key unset: the shared parser rejects by name, and the
    // operator sees the code the route would have answered with.
    const blank = prepared({
      budgetMinHoursBetweenChanges: { state: "unset", value: null },
      budgetMaxChangesPer7d: { state: "unset", value: null },
      budgetMaxAccountConcentrationPct: { state: "unset", value: null },
      maxBudgetIncreasePct: { state: "unset", value: null },
    });
    const html = render(blank);
    expect(html).toContain('data-field="preparation-rejection"');
    expect(html).toContain("min_hours_between_changes_invalid");
    expect(html).toContain(
      'data-testid="preparation-save" data-enabled="false"',
    );
    expect(html).toContain('disabled=""');
  });

  it("enables the button only when the parse succeeds", () => {
    expect(render(prepared())).toContain(
      'data-testid="preparation-save" data-enabled="true"',
    );
  });
});

describe("preparation form — it computes no decision authority", () => {
  it("does not compute buyerAction, readiness or a blocker set", () => {
    /*
      The standing rule for every Meta surface: the UI prints the server's
      verdict. This form additionally sends an intent — but it must not decide
      whether the business is ready, and it must not derive an action.
    */
    const form = SOURCE.slice(SOURCE.indexOf("function BudgetPreparationForm"));
    expect(form).not.toContain("buyerAction");
    expect(form).not.toContain("activationReadyBlockers");
    expect(form).not.toMatch(/\bconfirmationPhrase\b/);
    // It re-reads the server after saving rather than assuming the outcome.
    expect(form).toContain("onSaved?.()");
  });

  it("does not weaken the enable ceremony beside it", () => {
    const html = render(prepared());
    // The phrase input and the enable button still carry their own gating.
    expect(html).toContain('data-testid="budget-activation-phrase"');
    expect(html).toContain(
      'data-testid="budget-activation-enable" data-enabled="false"',
    );
    // A stop is offered only when automatic actions are actually on here.
    expect(html).not.toContain('data-testid="budget-activation-disable"');
  });
});

describe("preparation form — mobile", () => {
  it("lays out one column that grows, with inputs that can shrink", () => {
    const html = render(prepared());
    // `auto-fit`/`minmax` is one column on a narrow pane and two when there is
    // room; `width:100%` + `min-width:0` is what stops an input from forcing a
    // horizontal scroll inside it.
    expect(html).toContain(
      "grid-template-columns:repeat(auto-fit, minmax(220px, 1fr))",
    );
    expect(html).toMatch(/min-width:0/);
    expect(html).toMatch(
      /data-testid="preparation-save"[^>]*style="[^"]*width:100%/,
    );
  });

  it("gives every input an accessible name and a numeric keypad where numeric", () => {
    const html = render(prepared());
    expect(html).toContain('aria-label="Minimum hours between changes"');
    expect(html).toContain('aria-label="Per-action spend limit (TRY)"');
    expect(html).toContain('aria-label="Spend-limit currency"');
    // React preserves the camelCase spelling in server markup, so the match is
    // case-insensitive rather than pinned to one renderer's normalisation.
    expect(html.match(/inputmode="numeric"/gi) ?? []).toHaveLength(4);
    expect(html.match(/inputmode="decimal"/gi) ?? []).toHaveLength(1);
  });
});

describe("preparation projection — the pure part", () => {
  it("reports a stored document field by field", () => {
    const view = projectStoredGuardrails({
      dryRunOnly: false,
      budgetMinHoursBetweenChanges: 12,
      budgetMaxChangesPer7d: 3,
      budgetMaxAccountConcentrationPct: 40,
      maxBudgetIncreasePct: 25,
      perActionSpendCeilingMinor: 500000,
      perActionSpendCeilingCurrency: "TRY",
    });
    expect(view.dryRunOnly).toEqual({ state: "persisted", value: false });
    expect(view.perActionSpendCeilingCurrency).toEqual({
      state: "persisted",
      value: "TRY",
    });
  });

  it("reports a WRONG-TYPED stored value as unset rather than showing it", () => {
    /*
      A stored `"12"` is not a number the runtime honours, and the validator
      would reject it. Rendering it as persisted would tell an admin their
      cooldown is configured when it is not.
    */
    const view = projectStoredGuardrails({
      budgetMinHoursBetweenChanges: "12",
      dryRunOnly: "false",
      perActionSpendCeilingCurrency: "try",
    });
    expect(view.budgetMinHoursBetweenChanges.state).toBe("unset");
    expect(view.dryRunOnly.state).toBe("unset");
    expect(view.perActionSpendCeilingCurrency.state).toBe("unset");
  });

  it("treats a null, array or scalar document as every field unset", () => {
    for (const stored of [null, undefined, [], 7, "config"]) {
      const view = projectStoredGuardrails(stored);
      expect(view.dryRunOnly.state, JSON.stringify(stored)).toBe("unset");
    }
  });
});
