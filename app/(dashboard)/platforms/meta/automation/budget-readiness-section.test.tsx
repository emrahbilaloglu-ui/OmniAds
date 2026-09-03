/**
 * D086 — the readiness surface renders the SERVER's verdict verbatim.
 *
 * The rule this holds is the one the architecture states twice: the UI must not
 * compute `buyerAction`, a role, eligibility or confidence. Here it must not
 * compute readiness either — it prints what the server measured, including the
 * unattractive states, and offers nothing that could start a capture.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { BudgetReadinessReadModel } from "@/lib/meta/budget-readiness-read-model";
import { BudgetReadinessSection } from "./automation-view";

const model = (over: Partial<BudgetReadinessReadModel> = {}): BudgetReadinessReadModel => ({
  contract: "d086.budget-readiness-read-model.v9",
  businessId: "b1",
  providerAccountId: "act_1",
  scopeBlocker: null,
  compiledResolverVersion: "campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01",
  dimensions: [
    {
      key: "budget_fact_retention",
      closesBlocker: "currency_exponent_not_captured",
      status: "forward_only_after_deploy",
      evidence: "No column in this database carries a currency exponent for a budget value.",
      source: "information_schema.columns",
      asOf: null,
      coverage: {
        qualifying: 0, examined: 149643, population: 400000, conflicts: 3, truncated: true,
        universe: {
          retainedRows: 500000, applicable: 149643, provenNonApplicable: 350000,
          ownerUnknown: 42, uncoveredApplicable: 7, hierarchyContradictions: 5,
          completeRunAttested: false, expectedCampaigns: 900, expectedAdsets: 4000,
          observedCampaigns: 880, observedAdsets: 3900,
          cohortId: "cohort-abc", manifestCampaignMembers: 900, manifestAdsetMembers: 4000,
        },
      },
      blocker: "currency_exponent_not_captured",
      preconditions: ["deploy the prepared additive columns", "clear the ingestion fence"],
    },
    {
      key: "profile_output_retention",
      closesBlocker: "canonical_profile_output_not_retained",
      status: "unknown",
      evidence: "measurement_failed:connection reset",
      source: "d086_readiness_probe",
      asOf: null,
      coverage: null,
      blocker: "readiness_measurement_unavailable",
      preconditions: ["repeat the readiness measurement"],
    },
    {
      key: "role_authority_retention",
      closesBlocker: "automatic_role_authority_absent",
      status: "ready",
      evidence: "12 of 40 retained role rows qualify for automatic authority.",
      source: "engine_v3_campaign_context_daily",
      asOf: "2026-08-22",
      coverage: { qualifying: 12, examined: 40, population: 40, conflicts: 0, truncated: false },
      blocker: null,
      preconditions: [],
    },
  ],
  blockers: ["currency_exponent_not_captured", "readiness_measurement_unavailable"],
  ...over,
});

describe("D086 — the budget-readiness section renders server facts verbatim", () => {
  it("prints each dimension's status, evidence, source, as-of, coverage and blocker", () => {
    const html = renderToStaticMarkup(<BudgetReadinessSection readiness={model()} />);
    expect(html).toContain('data-testid="budget-readiness-budget_fact_retention"');
    expect(html).toContain('data-status="forward_only_after_deploy"');
    expect(html).toContain("No column in this database carries a currency exponent");
    expect(html).toContain("information_schema.columns");
    expect(html).toContain('data-field="qualifying"');
    expect(html).toContain('data-field="population"');
    expect(html).toContain("currency_exponent_not_captured");
    expect(html).toContain("deploy the prepared additive columns; clear the ingestion fence");
  });

  it("renders FORWARD-ONLY as its own state, not as pending or ready", () => {
    const html = renderToStaticMarkup(<BudgetReadinessSection readiness={model()} />);
    expect(html).toContain("forward_only_after_deploy");
    // The word the operator must not be shown for this state.
    expect(html).not.toMatch(/data-status="pending"/);
  });

  it("an UNKNOWN measurement renders as unknown, never as ready or zero-coverage", () => {
    const html = renderToStaticMarkup(<BudgetReadinessSection readiness={model()} />);
    expect(html).toContain('data-status="unknown"');
    expect(html).toContain("measurement_failed:connection reset");
    // Coverage is unknown, not zero — a failed read is not an empty result.
    expect(html).toContain(">unknown<");
  });

  it("a missing read model renders unavailable, never ready", () => {
    const html = renderToStaticMarkup(<BudgetReadinessSection readiness={null} />);
    expect(html).toContain('data-testid="budget-readiness-unavailable"');
    expect(html).toContain("Readiness read unavailable");
    expect(html).not.toContain("ready");
  });

  it("renders a READY dimension with no blocker without inventing one", () => {
    const html = renderToStaticMarkup(<BudgetReadinessSection readiness={model()} />);
    expect(html).toContain('data-status="ready"');
    expect(html).toContain('data-field="examined"');
    expect(html).toContain(">none<");
  });

  it("computes nothing: the markup contains only strings the server supplied", () => {
    /*
      The structural version of "the UI must not compute buyerAction". Every value
      rendered above appears verbatim in the model; the component adds labels and
      separators only. A component that derived a status would produce a token no
      model field contains.
    */
    const m = model();
    const html = renderToStaticMarkup(<BudgetReadinessSection readiness={m} />);
    for (const dimension of m.dimensions) {
      expect(html).toContain(dimension.status);
      expect(html).toContain(dimension.evidence);
      expect(html).toContain(dimension.source);
    }
    // No decision vocabulary and no buyer-facing label language may appear.
    for (const forbidden of [
      "buyerAction", "scale", "cut", "refresh", "Promote to main",
      "brief_variation", "Test campaign", "Main campaign", "label",
    ]) {
      expect(html, forbidden).not.toContain(forbidden);
    }
  });


  it("#10 renders population, truncation and conflicts as STRUCTURED fields", () => {
    /*
      r3 rendered only "qualifying of examined" while the population, the
      truncation state and the conflict count lived in an English sentence — so a
      truncated or conflicted measurement was indistinguishable from a clean one.
    */
    const html = renderToStaticMarkup(<BudgetReadinessSection readiness={model()} />);
    for (const field of ["qualifying", "examined", "population", "truncated", "conflicts"]) {
      expect(html, field).toContain(`data-field="${field}"`);
    }
    expect(html).toContain(">400000<");
    expect(html).toContain('data-truncated="true"');
    expect(html).toContain('data-conflicts="3"');
  });

  it("#10 an unmeasurable population renders unknown, never zero", () => {
    const m = model();
    const html = renderToStaticMarkup(
      <BudgetReadinessSection
        readiness={{
          ...m,
          dimensions: [{ ...m.dimensions[0], coverage: { qualifying: 1, examined: 1, population: null, conflicts: 0, truncated: false } }],
        }}
      />,
    );
    expect(html).toMatch(/data-field="population"[^>]*>unknown</);
  });

  it("#10 the heading covers all three input dimensions, not only budget", () => {
    const html = renderToStaticMarkup(<BudgetReadinessSection readiness={model()} />);
    expect(html).toContain("Decision-input retention readiness");
  });


  it("#5 renders EVERY universe count as a structured field", () => {
    /*
      r4 added `coverage.universe` to the model and rendered none of it: the
      counts survived only inside an English sentence, so an uncovered or
      uncaptured owner was invisible to a reader scanning the numbers.
    */
    const html = renderToStaticMarkup(<BudgetReadinessSection readiness={model()} />);
    for (const [field, value] of [
      ["retained-rows", "500000"],
      ["applicable", "149643"],
      ["proven-non-applicable", "350000"],
      ["owner-unknown", "42"],
      ["uncovered-applicable", "7"],
      ["hierarchy-contradictions", "5"],
      ["complete-run-attested", "false"],
      ["campaigns-expected-observed", "900 / 880"],
      ["adsets-expected-observed", "4000 / 3900"],
    ] as const) {
      expect(html, field).toContain(`data-field="${field}"`);
      expect(html, `${field}=${value}`).toMatch(new RegExp(`data-field="${field}"[^>]*>${value}<`));
    }
  });

  it("#5 a dimension with no universe renders the other fields without inventing one", () => {
    const m = model();
    const html = renderToStaticMarkup(
      <BudgetReadinessSection
        readiness={{
          ...m,
          dimensions: [{
            ...m.dimensions[2],
            coverage: { qualifying: 1, examined: 1, population: 1, conflicts: 0, truncated: false },
          }],
        }}
      />,
    );
    expect(html).toContain('data-field="population"');
    expect(html).not.toContain('data-field="applicable"');
    expect(html).not.toContain('data-field="uncovered-applicable"');
  });

  it("offers no affordance: no form, no button, no link, no token", () => {
    const html = renderToStaticMarkup(<BudgetReadinessSection readiness={model()} />);
    for (const forbidden of ["<button", "<form", "<input", "<a ", "href=", "token"]) {
      expect(html, forbidden).not.toContain(forbidden);
    }
    expect(html).toContain('data-display-only="true"');
  });
});
