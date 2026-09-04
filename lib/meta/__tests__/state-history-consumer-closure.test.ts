// D075 consumer-sweep closure guard: every literal reference to
// `meta_entity_state_history` in the active tree must be accounted for in
// the per-file exact-count ledger below, and every classified content
// consumer's D075-safety predicates are byte-pinned so a regression cannot
// return silently. The full verdict matrix with call paths and evidence
// lives in docs/audits/D075_STATE_HISTORY_CONSUMER_SWEEP_2026-08-30.md —
// update BOTH when a reference is added, moved, or removed.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const TABLE = "meta_entity_state_history";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "archive")
      continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const ACTIVE_FILES = [
  ...walk(join(ROOT, "app")),
  ...walk(join(ROOT, "components")),
  ...walk(join(ROOT, "lib")),
  ...walk(join(ROOT, "scripts")),
];

/**
 * Categories:
 *  - content-reader: serves entity content; MUST satisfy D075 semantics
 *    (absence-aware winners, manifest-kind-aware membership, confirmation
 *    clocks) — each carries byte pins below.
 *  - writer: the persistence layer itself (D075 write contract).
 *  - central-helper: the shared as-of read helpers (presence-returning;
 *    callers own the presence guard).
 *  - ddl: migrations / schema verification.
 *  - size-only: byte/占用 measurement; never reads content.
 *  - compaction-d077: D077 planner/executor family (classified, not
 *    changed in D075 packages).
 *  - admission: sync admission/fence context; comment or capability only.
 *  - harness: ephemeral-Postgres seams and the migrations harness.
 *  - frozen-offline: SELECT-only frozen evidence bundles (H11B).
 *  - operational-verifier: active verification tooling (content semantics
 *    binding — fixed to manifest-kind-aware membership in this sweep).
 *  - comment-only: documentation references, no query.
 *  - test: vitest fixtures/pins.
 */
const STATE_HISTORY_REFERENCE_LEDGER: ReadonlyArray<{
  file: string;
  category: string;
  count: number;
}> = [
  { file: "lib/api/meta.ts", category: "content-reader", count: 3 },
  { file: "lib/creative-decision-engine/ad-operator-response-detection.ts", category: "content-reader", count: 2 },
  { file: "lib/creative-decision-engine/data-source.ts", category: "content-reader", count: 5 },
  { file: "lib/creative-decision-engine/jobs/ad-decision-outcomes-job.ts", category: "content-reader", count: 3 },
  { file: "lib/creative-decision-engine/jobs/ad-operator-response-job.ts", category: "content-reader", count: 17 },
  { file: "lib/meta/decisions-workspace-read-model.ts", category: "content-reader", count: 7 },
  { file: "lib/meta/history-read-model.ts", category: "content-reader", count: 4 },
  { file: "lib/meta/history-contract.ts", category: "content-reader", count: 1 },
  { file: "lib/meta/entity-state-history.ts", category: "writer", count: 15 },
  { file: "lib/migrations.ts", category: "ddl", count: 32 },
  /*
    D086 correction 7. Readiness stopped reading transition-only config history
    and reads the observation state history the real capture path writes. Its
    read is grain-scoped, account-scoped, cutoff-bounded and latest-per-identity,
    and every budget judgment on the rows is D083's `buildCanonicalBudgetFact` —
    so it is a content reader with no independent budget authority of its own.
  */
  { file: "lib/meta/budget-readiness-read-model.ts", category: "content-reader", count: 4 },
  // Names the table only inside the required-column contract and the capability
  // probe, both of which are schema statements, not content reads.
  { file: "lib/meta/budget-readiness-retention.ts", category: "schema-contract", count: 5 },
  // The artifact records which queries ran; the test drives the read model over
  // fixtures shaped like that table. Neither reads production content.
  { file: "scripts/audits/d086-budget-readiness-input-pack.ts", category: "reporting-only", count: 4 },
  { file: "scripts/audits/d086-budget-readiness-input-pack.test.ts", category: "test-fixture", count: 5 },
  /*
    D086 correction 8. The capture-to-readiness seam drives the REAL writers
    against an ephemeral cluster, so it names the table where it asserts what
    the writer stored; the seam wrapper names it only in a comment about what
    the delta case proves. Neither reads production content.
  */
  { file: "scripts/d086-capture-to-readiness-child.ts", category: "local-seam", count: 3 },
  { file: "scripts/ephemeral-postgres-d086-readiness-seam.ts", category: "local-seam", count: 1 },
  { file: "lib/sync/db-growth-fence.ts", category: "size-only", count: 14 },
  { file: "lib/sync/state-history-effective-size.ts", category: "size-only", count: 2 },
  // 10th reference (correction 3): the strict count-parser LABEL
  // "live_rows census of meta_entity_state_history" names the table in its
  // refusal message — a diagnostic string, not a new reader.
  { file: "lib/meta/state-history-compaction.ts", category: "compaction-d077", count: 10 },
  { file: "lib/meta/state-history-compaction-executor.ts", category: "compaction-d077", count: 7 },
  { file: "lib/meta/briefing-filter.ts", category: "comment-only", count: 1 },
  { file: "lib/meta/current-evidence-gate.ts", category: "comment-only", count: 1 },
  { file: "lib/sync/staged-worker-predicate.ts", category: "comment-only", count: 1 },
  { file: "lib/sync/worker-runtime.ts", category: "comment-only", count: 1 },
  { file: "scripts/creative-decision-center/h11b-context-lifecycle-bundle.ts", category: "frozen-offline", count: 2 },
  { file: "scripts/creative-decision-center/native-ad-natural-wave-operational-verifier.ts", category: "operational-verifier", count: 3 },
  // D078 evidence bundle: one pg_total_relation_size() literal — a byte
  // measurement for the frozen audit bundle, never a content read.
  { file: "scripts/audits/d078-six-business-evidence-bundle.ts", category: "size-only", count: 1 },
  // D077 recovery preflight: read-only audit evidence collector — relation
  // size/stat probes, schema-presence checks, and the global
  // last-accepted-write clock inside one REPEATABLE READ READ ONLY
  // transaction that ends in ROLLBACK. No content consumer, no writer.
  { file: "scripts/audits/d077-production-recovery-readonly-preflight.ts", category: "size-only", count: 11 },
  // Correction-1 artifact generator: emits the operator approval packets;
  // its 4 literals are SQL SHAPES and prose inside packet text (VACUUM
  // read-back command, executor DELETE description). It executes no SQL at
  // all — not a reader, not a writer.
  { file: "scripts/audits/d077-correction1-artifact-generator.ts", category: "size-only", count: 4 },
  { file: "scripts/ephemeral-postgres-entity-state-history-seam-child.ts", category: "harness", count: 23 },
  { file: "scripts/ephemeral-postgres-entrypoint-admission-seam.ts", category: "harness", count: 1 },
  { file: "scripts/ephemeral-postgres-migrations-check.ts", category: "harness", count: 19 },
  { file: "scripts/audits/d080-meta-budget-edit-evidence.ts", category: "read-only-audit", count: 21 },
  { file: "scripts/audits/d080b-meta-budget-policy-simulation.ts", category: "read-only-audit", count: 6 },
  { file: "scripts/audits/d083-meta-budget-fact-observation.ts", category: "read-only-audit", count: 7 },
  { file: "scripts/audits/d083-meta-budget-fact-observation.test.ts", category: "read-only-audit", count: 2 },
  { file: "lib/meta/budget-fact.ts", category: "comment-only", count: 1 },
  { file: "scripts/ephemeral-postgres-schema-upgrade-seam.ts", category: "harness", count: 1 },
  { file: "scripts/ephemeral-postgres-native-ad-decision-seam.ts", category: "harness", count: 5 },
  { file: "scripts/ephemeral-postgres-provider-fixture-seam.ts", category: "harness", count: 1 },
  { file: "scripts/ephemeral-postgres-state-history-compaction-seam-child.ts", category: "harness", count: 8 },
  { file: "scripts/ephemeral-postgres-sync-retention-seam.ts", category: "harness", count: 1 },
  { file: "app/api/meta/decisions-workspace/route.test.ts", category: "test", count: 1 },
  { file: "components/meta/decision-center/meta-decision-center-exact-adapter.test.ts", category: "test", count: 2 },
  { file: "lib/api/meta-campaign-status-fallback.test.ts", category: "test", count: 1 },
  { file: "lib/api/meta.test.ts", category: "test", count: 1 },
  { file: "lib/creative-decision-engine/__tests__/jobs/ad-operator-response-job.test.ts", category: "test", count: 1 },
  { file: "lib/meta/briefing-filter.test.ts", category: "test", count: 1 },
  { file: "lib/meta/decision-pipeline-health.test.ts", category: "test", count: 2 },
  { file: "lib/meta/decisions-os-presentation.test.ts", category: "test", count: 2 },
  { file: "lib/meta/decisions-workspace-read-model.test.ts", category: "test", count: 2 },
  { file: "lib/meta/history-external-change-levels.test.ts", category: "test", count: 3 },
  { file: "lib/meta/__tests__/state-history-compaction-observation-order.test.ts", category: "test", count: 1 },
  // PRE-DEPLOY AUDIT 2026-09-03 — the provider-family collateral-admission
  // slice (installMetaTableOverBudget() fixture + its 4 dependent tests)
  // added 7 more literal references, 11 -> 18. All fixture/assertion
  // strings; no new query. See D075_STATE_HISTORY_CONSUMER_SWEEP addendum.
  { file: "lib/sync/db-growth-fence.test.ts", category: "test", count: 18 },
  { file: "lib/sync/staged-worker-predicate.test.ts", category: "test", count: 1 },
  { file: "lib/sync/worker-boot-growth-fence.test.ts", category: "test", count: 3 },
  /*
    PRE-DEPLOY AUDIT 2026-09-03 — the D087/D088 budget slice, classified.

    `budget-proposal-server-readers.ts` is a content reader: its one query over
    this table is `readMeasuredBudgetHistory`, which reconstructs the
    owner-deduplicated retained budget population for the prospective account
    concentration. It is latest-per-entity (`DISTINCT ON (entity_type,
    entity_id) … ORDER BY captured_at DESC, created_at DESC, id DESC`),
    cutoff-bounded (`captured_at <= now()`), and presence-guarded (`presence =
    'present'`), so an absent winner is excluded rather than resurrected — the
    D075 serving corollary. It never serves entity CONTENT to a surface; it
    sums owned amounts and returns null when the population is not provable.

    `budget-write-safety-projection.ts` names the table only inside a
    provenance STRING that says which tables a measured policy flag was read
    from. It issues no query.
  */
  { file: "lib/meta/budget-proposal-server-readers.ts", category: "content-reader", count: 1 },
  { file: "lib/meta/budget-write-safety-projection.ts", category: "comment-only", count: 1 },
  { file: "lib/meta/budget-production-path.c3.test.ts", category: "test", count: 1 },
  { file: "lib/meta/budget-no-fabricated-defaults.test.ts", category: "test", count: 1 },
  { file: "app/api/meta/automation/proposals/budget-execution-paths.c3.test.ts", category: "test", count: 1 },
];
const LEDGER = new Map(
  STATE_HISTORY_REFERENCE_LEDGER.map((entry) => [entry.file, entry]),
);
// This guard file references the table too (in strings above); exempt self.
const SELF = "lib/meta/__tests__/state-history-consumer-closure.test.ts";

describe("D075 state-history consumer closure", () => {
  it("every literal table reference matches the classified ledger exactly", () => {
    const mismatches: string[] = [];
    const seen = new Set<string>();
    for (const file of ACTIVE_FILES) {
      const rel = relative(ROOT, file);
      if (rel === SELF) continue;
      const count = readFileSync(file, "utf8").split(TABLE).length - 1;
      const entry = LEDGER.get(rel);
      if (entry) seen.add(rel);
      const allowed = entry?.count ?? 0;
      if (count !== allowed) {
        mismatches.push(`${rel}: expected ${allowed}, found ${count} — classify it in the ledger AND in docs/audits/D075_STATE_HISTORY_CONSUMER_SWEEP_2026-08-30.md`);
      }
    }
    for (const entry of STATE_HISTORY_REFERENCE_LEDGER) {
      if (!seen.has(entry.file)) mismatches.push(`${entry.file}: ledger entry has no matching file`);
    }
    expect(mismatches).toEqual([]);
  });

  it("the workspace read model never fabricates DELETED from absence and never resurrects a dimension status past an absent winner", () => {
    const src = readFileSync(join(ROOT, "lib/meta/decisions-workspace-read-model.ts"), "utf8");
    expect(src).not.toContain("ELSE 'DELETED'");
    for (const grain of ["campaign_state", "adset_state", "ad_state"]) {
      expect(src).toContain(`WHEN ${grain}.presence = 'present' THEN COALESCE(`);
    }
  });

  it("the history feed computes status transitions over present rows only", () => {
    const src = readFileSync(join(ROOT, "lib/meta/history-read-model.ts"), "utf8");
    expect(src).toContain("AND prior.presence = 'present'");
    expect(src).toContain("AND entity_state.presence = 'present'");
  });

  it("the natural-wave verifier counts manifest membership kind-aware, never run-bound for delta runs", () => {
    const src = readFileSync(
      join(ROOT, "scripts/creative-decision-center/native-ad-natural-wave-operational-verifier.ts"),
      "utf8",
    );
    expect(src).toContain("WHEN run.manifest_kind = 'delta' THEN recon.member_count");
    expect(src).toContain("run.manifest_kind IS DISTINCT FROM 'delta'");
    expect(src).toContain("AND state.captured_at <= run.captured_at");
  });

  it("the operator-response truth query certifies window-end truth from confirmed_until", () => {
    const job = readFileSync(join(ROOT, "lib/creative-decision-engine/jobs/ad-operator-response-job.ts"), "utf8");
    for (const line of [
      ") AS confirmed_until,",
      "CASE WHEN observation_run.last_captured_at <= target.cutoff",
      "AND later_run.manifest_kind = 'delta'",
      "AND newer.captured_at <= target.cutoff",
      "AND truth.confirmed_until >= truth.window_end",
      'confirmedUntil: stringValue(row.confirmed_until, "confirmed_until"),',
      // Acceptance correction 1: anti-supersession follows the EXACT D075
      // winner order and endpoint authority. A captured-at-only check let
      // an equal-captured tuple-loser and a sibling-endpoint row corrupt
      // the confirmation; these pins fail if either regresses.
      "AND (newer.captured_at, newer.created_at, newer.id)",
      "> (state.captured_at, state.created_at, state.id)",
      "WHERE newer_run.id = newer.run_id",
      "AND newer_run.endpoint = observation_run.endpoint",
      "${AD_OPERATOR_SCOPE_CONFIRMATION_LATERAL_SQL}",
    ]) {
      expect(job).toContain(line);
    }
    expect(job).not.toContain("AND newer.captured_at > state.captured_at");
    const detection = readFileSync(join(ROOT, "lib/creative-decision-engine/ad-operator-response-detection.ts"), "utf8");
    expect(detection).toContain("truthConfirmedUntil(truth) >= windowEndTime");
    expect(detection).toContain('"engine-v3-native-ad-operator-source-proof.v3"');
  });

  it("the semantic-coalescing heartbeat keeps monotonic clocks (replay-safe)", () => {
    // Acceptance correction 1 (gap B): the early coalescing UPDATE must
    // GREATEST-guard both heartbeat clocks — an accepted older exact replay
    // must not move them backward and erase confirmed_until evidence.
    const writer = readFileSync(join(ROOT, "lib/meta/entity-state-history.ts"), "utf8");
    expect(writer).toContain("SET last_seen_at = GREATEST(");
    expect(writer).toContain("COALESCE(last_seen_at, observed_at),");
    expect(writer).toContain("last_captured_at = GREATEST(");
    expect(writer).toContain("COALESCE(last_captured_at, captured_at),");
    expect(writer).not.toMatch(
      /SET last_seen_at = \$\{observedAt\}/,
    );
  });

  it("the status-recovery callers guard on presence before claiming a recovered status", () => {
    const src = readFileSync(join(ROOT, "lib/api/meta.ts"), "utf8");
    const guards = src.match(/if \(state\.presence !== "present"\) continue;/g) ?? [];
    expect(guards.length).toBe(2);
  });
});
