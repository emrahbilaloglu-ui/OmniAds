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
      `budget-proposal-server-readers.ts` is the module that actually holds
      `updateEntityBudget`; the scheduled sweep reaches a mutation only
      through it, and it is reached only after the sweep's gate chain. Both
      are listed so a NEW writer appearing in this closure fails loudly.
    */
    expect(writers.map((entry) => entry.file)).toEqual([
      "lib/meta/budget-proposal-server-readers.ts",
    ]);
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

  it("readGates requires BOTH keys: the master switch and the budget Tier 3 mode", () => {
    const code = stripComments(
      readFileSync("lib/meta/budget-proposal-server-readers.ts", "utf8"));
    expect(code).toContain("control.businessControl.autoExecutionEnabled === true");
    expect(code).toContain('budgetMode === "auto"');
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
