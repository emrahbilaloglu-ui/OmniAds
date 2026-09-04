/**
 * D088 C3 — a static regression over the AUTHORITATIVE paths.
 *
 * Each pattern below is an exact fake default a previous revision shipped. They
 * are asserted absent from the modules that decide whether a write may happen,
 * because every one of them was a permission nobody granted.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Prose is not linkage: a comment naming a defect is not the defect. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const AUTHORITATIVE = [
  "lib/meta/budget-proposal-server-readers.ts",
  "lib/meta/budget-proposal-source-loader.ts",
  "lib/meta/budget-proposal-server-runtime.ts",
  "lib/meta/budget-proposal-runtime.ts",
  "lib/meta/budget-proposal-producer.ts",
  "lib/meta/budget-execution-composition.ts",
  "lib/meta/budget-execution-lifecycle.ts",
  "lib/meta/budget-automation-scheduled.ts",
  "lib/meta/budget-write-safety-projection.ts",
] as const;

describe("D088 C3 — no fabricated authority survives on an authoritative path", () => {
  it.each(AUTHORITATIVE)("%s invents no role, profile or safety verdict", (file) => {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const forbidden of [
      // A role confidence or producer nobody resolved.
      'confidence: "high"',
      "satisfiesRoleAuthority: true",
      'producer: "automatic_inference"',
      // A profile eligibility nobody classified.
      "evidenceFloorsClear: true",
      "changeSafetyClear: true",
      // A concentration nobody measured, and a ceiling that is not one.
      "accountConcentrationPercent: 0",
      "maxAccountConcentrationPercent: 100",
      // A write-safety map asserted rather than derived.
      '[step, "satisfied" as const]',
      // The circular decision identity.
      "decisionHash: envelope.fingerprint",
    ]) {
      expect(code, `${file}: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it.each(AUTHORITATIVE)("%s coalesces no unknown count to zero", (file) => {
    const code = stripComments(readFileSync(file, "utf8"));
    // `COALESCE(x, 0)` over a journal or population read turns "unknown" into
    // the one value that passes every threshold.
    expect(code, file).not.toMatch(/COALESCE\([^)]*concentration[^)]*,\s*0\)/i);
    expect(code, file).not.toContain("?? 0)) : 0");
  });

  it("the concentration denominator is the retained population, not the journal", () => {
    const code = readFileSync("lib/meta/budget-proposal-server-readers.ts", "utf8");
    // The population comes from state history, owner-deduplicated.
    expect(code).toContain("FROM meta_entity_state_history");
    expect(code).toContain("budget_origin IN ('campaign', 'adset')");
    // ...and the share is PROSPECTIVE.
    expect(code).toContain("prospectiveTotal");
    // A journal-over-journal ratio is exactly what C2 shipped.
    expect(code).not.toMatch(/share\.entity_minor \/ share\.account_minor/);
  });

  it("the policy comes from EXPLICIT persisted keys, never derived caps", () => {
    const code = readFileSync("lib/meta/budget-proposal-server-readers.ts", "utf8");
    expect(code).toContain("guardrails.budgetMinHoursBetweenChanges === null");
    expect(code).toContain("guardrails.budgetMaxChangesPer7d === null");
    expect(code).toContain("guardrails.budgetMaxAccountConcentrationPct === null");
    // C2 derived a cooldown from the daily action cap.
    expect(code).not.toContain("24 / guardrails.dailyAutoActionCap");
  });

  it("the canonical role RESOLVER decides, not a raw row", () => {
    const code = readFileSync("lib/meta/budget-proposal-server-readers.ts", "utf8");
    expect(code).toContain("resolveCampaignRoleAuthority(");
    expect(code).toContain("isCampaignContextResolverAuthorityValidated");
    expect(code).toContain("roleResolution.satisfiesRoleAuthority");
  });

  it("the EXACT profile action row is classified, not an aggregate dimension", () => {
    const code = readFileSync("lib/meta/budget-proposal-server-readers.ts", "utf8");
    expect(code).toContain("classifyRetainedProfile(");
    expect(code).toContain('row.action === profileAction');
    expect(code).not.toContain('dimension("profile_output_retention")');
  });

  it("activation is bound to the EXACT provider account", () => {
    const runtime = readFileSync("lib/meta/budget-proposal-server-runtime.ts", "utf8");
    expect(runtime).toContain("enabledProviderAccountId !== proposal.providerAccountId");
    expect(runtime).toContain("account_not_activated");
    const readers = readFileSync("lib/meta/budget-proposal-server-readers.ts", "utf8");
    expect(readers).toContain("auto_execution_provider_account_id");
    expect(readers).toContain("auto_execution_enabled_by");
    expect(readers).not.toContain("THEN controls.updated_by");
    expect(readers).toContain("SELECT 1 FROM memberships m");
    expect(readers).toContain("m.role = 'admin'");
    expect(readers).toContain("m.status = 'active'");
  });

  it("the scheduler authorises with the enabling admin, never a text sentinel", () => {
    const code = stripComments(
      readFileSync("lib/meta/budget-automation-scheduled.ts", "utf8"));
    expect(code).toContain("verdict.enablingActorUserId");
    // The sweep's own name must never reach a UUID column.
    expect(code).not.toContain("decidedBy: BUDGET_SWEEP_ACTOR");
  });

  it("manual approval is authorised by CONFIRMATION, not by auto enablement", () => {
    const runtime = readFileSync("lib/meta/budget-proposal-server-runtime.ts", "utf8");
    expect(runtime).toContain('input.authorization.kind === "manual"');
    expect(runtime).toContain("manual_confirmation_absent");
    const route = readFileSync("app/api/meta/automation/proposals/route.ts", "utf8");
    expect(route).toContain("runClaimedProposalExecution(");
    expect(route).toContain('kind: "manual"');
  });

  it("the canonical fact's OWN provenance travels, not subject[0] or today", () => {
    const code = stripComments(
      readFileSync("lib/meta/budget-execution-composition.ts", "utf8"));
    // The owner row's clocks, run and API version.
    expect(code).toContain("ownerProv.recordedAtMs");
    expect(code).toContain("ownerProv.sourceRunId");
    expect(code).toContain("ownerProv.providerApiVersion");
    // The role resolver's own as-of IS the authority evidence date.
    expect(code).toContain("authorityEvidenceAsOf: roleAsOfDay");
    // C2's restatements.
    expect(code).not.toContain("subject[0]!.sourceRunId");
    expect(code).not.toContain("knowledgeAsOf: asOf,");
    expect(code).not.toContain("evidenceWindow: { from: asOf, to: asOf }");
  });

  it("the producer's loader can actually reach a provider baseline", () => {
    const code = stripComments(
      readFileSync("lib/meta/budget-proposal-source-loader.ts", "utf8"));
    // A real GET-only read through the existing write-context boundary...
    expect(code).toContain("buildMetaBudgetWriteContextForProposal(");
    expect(code).toContain("readMetaEntityBudgetState(");
    // ...gated by persisted posture, so defaults contact nothing.
    expect(code).toContain("providerContactPermitted");
    expect(code).toContain('control.businessControl.source === "persisted"');
    // The dead seams C2 shipped.
    expect(code).not.toContain("providerBaseline: null,");
    expect(code).not.toContain('flag(false, "no execution claim exists at projection time")');
    expect(code).not.toContain("hash: null,");
  });

  it("a budget approval settles and ledgers exactly ONCE", () => {
    const route = stripComments(
      readFileSync("app/api/meta/automation/proposals/route.ts", "utf8"));
    // The route defers to the lifecycle's settlement instead of repeating it.
    expect(route).toContain("budgetLifecycle = lifecycle");
    expect(route).toContain("proposal: lifecycle.settled");
    // ...and does not stamp a dispatch marker on a budget approval that may
    // still be withheld before any provider contact.
    expect(route).toContain("const budgetApproval = input.proposal.proposedAction");
    expect(route).toContain("dispatchMarked = budgetApproval");
  });

  it("the scheduler acts under the enabling ADMIN, and fails closed without one", () => {
    const code = stripComments(
      readFileSync("lib/meta/budget-automation-scheduled.ts", "utf8"));
    expect(code).toContain("claimedBy: enablingActor");
    expect(code).toContain("actorUserId: enablingActor");
    expect(code).toContain("decidedBy: enablingActor");
    expect(code).toContain("UUID_PATTERN.test(enablingActor)");
    expect(code).toContain("verdict.enabledProviderAccountId !== providerAccountId");
    // The sentinel must not reach a UUID column on any of the three paths.
    expect(code).not.toContain("claimedBy: BUDGET_SWEEP_ACTOR");
    expect(code).not.toContain("actorUserId: BUDGET_SWEEP_ACTOR,\n            markDispatchStarted");
  });

  it("the write-safety and conflict facts come from THIS attempt", () => {
    const code = stripComments(
      readFileSync("lib/meta/budget-proposal-server-readers.ts", "utf8"));
    expect(code).toContain("explicitlyApproved: explicitlyApproved === true");
    expect(code).not.toContain("explicitlyApproved: proposal.decidedBy !== null");
    expect(code).not.toContain("conflict: flagFor(\n            proposal.claimToken !== null");
  });

  it("the dispatch marker is fired at the pre-POST boundary and can veto", () => {
    const adapter = readFileSync("lib/meta/ads-write.ts", "utf8");
    const budgetAdapter = adapter.slice(adapter.indexOf("export async function updateEntityBudget"));
    expect(budgetAdapter).toContain("beforeProviderPost");
    expect(budgetAdapter).toContain("dispatch_marker_unavailable");
    expect(budgetAdapter).toContain("beforeMutationAttempt: input.beforeProviderPost");
    expect(budgetAdapter).toContain("beforeProviderMutation: async ()");
    expect(budgetAdapter.indexOf("beforeMutationAttempt: input.beforeProviderPost"))
      .toBeLessThan(budgetAdapter.indexOf("beforeProviderMutation: async ()"));
    expect(budgetAdapter.indexOf("beforeProviderMutation: async ()"))
      .toBeLessThan(budgetAdapter.indexOf("const before = await readBack(null)"));
    const lifecycle = readFileSync("lib/meta/budget-execution-lifecycle.ts", "utf8");
    expect(lifecycle).toContain("markerFailed");
  });
});
