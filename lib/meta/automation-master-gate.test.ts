/**
 * PRE-DEPLOY AUDIT — the master OFF gate, proven transitively.
 *
 * Requirement: no scheduled (unattended) path may reach a Meta provider
 * mutation except through the business-wide master automatic-execution
 * switch. "We looked and did not find one" is not a proof, so this test
 * walks the ACTUAL import graph from the cron entry point and reports every
 * module in that closure that can call a Meta write.
 *
 * The graph is built from source text rather than from a bundler, so it is
 * deliberately over-inclusive: a `import type` line still counts as an edge.
 * Over-inclusion is the safe direction — it can only add candidates to the
 * set this test then demands be gated.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Prose is not linkage: a comment naming a writer is not a writer. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const CRON_ENTRY = "app/api/sync/cron/route.ts";

/**
 * The functions in `lib/meta/ads-write.ts` and `lib/meta/launch-write.ts`
 * that actually issue a provider mutation. Read-only helpers in the same
 * modules (`readMetaEntityBudgetState`, `scanMetaAdDuplicatesByMarker`, …)
 * are deliberately absent: importing a GET is not reaching a write.
 */
const MUTATION_FUNCTIONS = [
  "pauseAd", "resumeAd",
  "pauseCampaign", "resumeCampaign",
  "pauseAdset", "resumeAdset",
  "updateAdsetBidAmount",
  "updateEntityBudget",
  "duplicateAd",
  "createMetaCampaign", "createMetaAdSet", "createMetaAd",
] as const;

/**
 * The ONE scheduled module allowed to reach a Meta mutation, and the exact
 * gate chain it must contain. Adding a second entry here is a deliberate
 * product decision that must be argued in the decision log, not a refactor.
 */
const GATED_SCHEDULED_WRITER = "lib/meta/budget-automation-scheduled.ts";

const RESOLVE_ROOTS = ["", "lib/", "app/", "components/", "scripts/"];
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveAlias(specifier: string): string | null {
  if (!specifier.startsWith("@/")) return null;
  const bare = specifier.slice(2);
  for (const root of RESOLVE_ROOTS) {
    for (const extension of EXTENSIONS) {
      const candidate = `${root}${bare}${extension}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function importsOf(file: string): string[] {
  const source = stripComments(readFileSync(file, "utf8"));
  const specifiers = [...source.matchAll(/from\s+"(@\/[^"]+)"/g)].map((m) => m[1]!);
  return specifiers
    .map(resolveAlias)
    .filter((path): path is string => path !== null);
}

/** Every module reachable from the cron entry, by source-text imports. */
function reachableFromCron(): Set<string> {
  const seen = new Set<string>();
  const queue = [CRON_ENTRY];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    // Tests are never part of a runtime closure.
    if (/\.test\.tsx?$/.test(file)) continue;
    for (const next of importsOf(file)) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/** Does this module call a provider mutation function directly? */
function callsMutation(file: string): string[] {
  const source = stripComments(readFileSync(file, "utf8"));
  // The import must name it AND the body must call it. A re-export or a
  // type-only mention is not a call.
  const importsWriteModule =
    /from\s+"@\/lib\/meta\/(ads-write|launch-write)"/.test(source);
  if (!importsWriteModule) return [];
  return MUTATION_FUNCTIONS.filter(
    (fn) => new RegExp(`\\b${fn}\\s*\\(`).test(source),
  );
}

describe("PRE-DEPLOY — every unattended Meta write is behind the master gate", () => {
  it("the cron closure reaches exactly ONE module that calls a Meta mutation", () => {
    const closure = [...reachableFromCron()].sort();
    // A sanity floor: if the graph walk silently found nothing, the whole
    // assertion below would pass vacuously.
    expect(closure.length).toBeGreaterThan(50);
    expect(closure).toContain(GATED_SCHEDULED_WRITER);

    const writers = closure
      .map((file) => ({ file, calls: callsMutation(file) }))
      .filter((entry) => entry.calls.length > 0);

    /*
      Three modules, and only three.

      `budget-proposal-server-readers.ts` holds `updateEntityBudget`;
      `scheduled-status-runtime.ts` holds the status primitives the sweep
      drives for a queued pause or resume; `scheduled-bid-runtime.ts` holds
      `updateAdsetBidAmount` for a queued cap change, which is the family that
      had a queue action, a database CHECK and no executor at all.

      Each is reached only after the sweep's gate chain, and each is named here
      so a FOURTH writer appearing in this closure fails loudly rather than
      arriving unannounced. Adding one is meant to be a deliberate edit of this
      list, which is what the next case then holds it to.
    */
    expect(writers.map((entry) => entry.file)).toEqual([
      "lib/meta/budget-proposal-server-readers.ts",
      "lib/meta/scheduled-bid-runtime.ts",
      "lib/meta/scheduled-status-runtime.ts",
    ]);
  });

  it("the bid writer carries the same gate the status writer does", () => {
    /*
      A new writer in the closure above is on probation until it proves it
      answers to the same chain. This is that proof, asserted from the source
      rather than from a claim: the scheduled authority, the pre-POST hook, the
      throw that actually stops the request, and the two refusals that must
      never be defaults.

      It also re-reads the ad set's own bid state, which the status writer has
      no equivalent of: a cap amount is meaningless without the strategy it
      sits on, and both can move between the decision and the write.
    */
    const code = stripComments(
      readFileSync("lib/meta/scheduled-bid-runtime.ts", "utf8"));
    expect(code).toContain("evaluateScheduledAuthority(");
    expect(code).toContain("beforeMutationAttempt");
    expect(code).toContain("throw new Error(verdict.refusal)");
    expect(code).toContain("control_state_unavailable");
    expect(code).toContain("manual_confirmation_absent");
    // The shared posture, not a literal.
    expect(code).toContain("readMetaWritePosture(");
    // And the live baseline, before anything is composed.
    expect(code).toContain("readMetaAdsetBidState(");
    expect(code).toContain("bid_baseline_changed");
    expect(code).toContain("bid_strategy_not_writable");
    // An amount it cannot vouch for is never written.
    expect(code).toContain("bid_envelope_absent");
  });

  it("the status writer re-proves its authority immediately before the POST", () => {
    /*
      Being on the list above is not a licence. The status runtime reaches a
      provider directly, so the gate it carries is asserted here in the same
      breath: it evaluates the scheduled authority, it hands the write
      primitive a pre-POST hook, and that hook throws — which is what stops the
      request — rather than logging and continuing.
    */
    const code = stripComments(
      readFileSync("lib/meta/scheduled-status-runtime.ts", "utf8"));
    expect(code).toContain("evaluateScheduledAuthority(");
    expect(code).toContain("beforeMutationAttempt");
    expect(code).toContain("throw new Error(verdict.refusal)");
    // A posture it could not read is a refusal, never a default-open.
    expect(code).toContain("control_state_unavailable");
    // And it never speaks for an operator.
    expect(code).toContain("manual_confirmation_absent");
  });

  it("the scheduled sweep carries the whole master gate chain", () => {
    const code = stripComments(readFileSync(GATED_SCHEDULED_WRITER, "utf8"));
    // The env release gate, checked before any database work.
    expect(code).toContain("gates.automationLiveWrites !== true");
    expect(code).toContain("release_gate_closed");
    // The business-wide MASTER switch, in the candidate query itself.
    expect(code).toContain("WHERE auto_execution_enabled = TRUE");
    expect(code).toContain("AND kill_switch_engaged = FALSE");
    // The fresh per-account verdict, and its exact-account + actor gates.
    expect(code).toContain("readGates(");
    expect(code).toContain("verdict.enabledProviderAccountId !== providerAccountId");
    expect(code).toContain("UUID_PATTERN.test(enablingActor)");
    // The dry-run guardrail is passed through, defaulting to dry-run.
    expect(code).toContain("verdict.dryRunOnly !== false");
  });

  it("readGates requires BOTH keys: the master switch and the row's own auto mode", () => {
    const code = stripComments(
      readFileSync("lib/meta/budget-proposal-server-readers.ts", "utf8"));
    expect(code).toContain("control.businessControl.autoExecutionEnabled === true");
    /*
      The second key used to be the literal `budget` mode, because budget was
      the only action the sweep could take. The queue now carries pause and
      resume as well, so the mode read is the one belonging to THIS row's
      family — still a standing `auto`, still required, and now the right
      question. The family is derived from the proposal rather than passed in,
      so no caller can nominate a family the row is not in.
    */
    expect(code).toContain('standingMode === "auto"');
    expect(code).toContain("decisionTypeForProposedAction(proposal.proposedAction)");
    // And a business explicitly placed in the read-only tier is never swept.
    expect(code).toContain('control.businessControl.readinessTier !== "read_only"');
    // A control row that was never persisted is not an enablement.
    expect(code).toContain("persisted");
  });

  it("the proposal executor has exactly one caller, and it is the operator route", () => {
    const callers: string[] = [];
    for (const file of [
      "app/api/meta/automation/proposals/route.ts",
      "lib/meta/budget-automation-scheduled.ts",
      "lib/meta/automation-rules-evaluation.ts",
      "app/api/sync/cron/route.ts",
    ]) {
      if (/executeMetaAutomationProposal\s*\(/.test(
        stripComments(readFileSync(file, "utf8")),
      )) callers.push(file);
    }
    expect(callers).toEqual(["app/api/meta/automation/proposals/route.ts"]);
  });

  it("the scheduled rule evaluator cannot reach a provider at all", () => {
    const code = stripComments(
      readFileSync("lib/meta/automation-rules-evaluation.ts", "utf8"));
    expect(code).not.toContain("@/lib/meta/ads-write");
    expect(code).not.toContain("@/lib/meta/launch-write");
    // Its strongest outcome is a proposal row an operator must approve.
    expect(code).toContain("getMetaWriteBlockState");
  });

  it("the shipped default answers OFF at every layer", () => {
    const gates = stripComments(readFileSync("lib/meta/release-gates.ts", "utf8"));
    // Only the exact string "true" opens a gate; unset is closed.
    expect(gates).toContain('raw?.trim().toLowerCase() === "true"');

    const control = stripComments(
      readFileSync("lib/meta/automation-control-plane.ts", "utf8"));
    // A business with no control row is OFF, dry-run, and Tier 1.
    expect(control).toContain("autoExecutionEnabled: false");
    expect(control).toContain("dryRunOnly: true");
    expect(control).toContain('mode: "manual"');

    const migrations = readFileSync("lib/migrations.ts", "utf8");
    expect(migrations).toContain("auto_execution_enabled BOOLEAN NOT NULL DEFAULT FALSE");
    expect(migrations).toContain('"dryRunOnly": true');
    // The activated-account column is additive and nullable: an existing
    // production row that already says TRUE still activates no account.
    expect(migrations).toContain(
      "ADD COLUMN IF NOT EXISTS auto_execution_provider_account_id TEXT");
  });

  it("no migration writes DATA into the automation control table", () => {
    const migrations = stripComments(readFileSync("lib/migrations.ts", "utf8"));
    // Only DDL may touch it. An INSERT or UPDATE here would let a deploy
    // change a business's automation posture.
    expect(migrations).not.toMatch(
      /INSERT\s+INTO\s+meta_automation_business_controls/i);
    expect(migrations).not.toMatch(
      /UPDATE\s+meta_automation_business_controls/i);
    expect(migrations).not.toMatch(
      /INSERT\s+INTO\s+meta_automation_decision_type_modes/i);
    expect(migrations).not.toMatch(
      /UPDATE\s+meta_automation_decision_type_modes/i);
  });
});
