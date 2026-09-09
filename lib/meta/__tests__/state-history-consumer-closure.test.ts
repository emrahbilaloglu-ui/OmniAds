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
  /*
    AREA R5 2026-09-07 — 3 -> 4. The Graph error-observability slice added one
    COMMENT reference and no query: the block above
    META_CAMPAIGN_SCHEDULE_FIELDS records the production measurement that
    motivated the recoverable field narrowing (this table received no `campaign`
    row for five days while `campaign_configs` returned only 400s). The file's
    classification is unchanged and set by its two `readMetaEntityStatesAsOf`
    recovery calls; the presence-guard byte pin below still holds at 2.
  */
  { file: "lib/api/meta.ts", category: "content-reader", count: 4 },
  { file: "lib/creative-decision-engine/ad-operator-response-detection.ts", category: "content-reader", count: 2 },
  { file: "lib/creative-decision-engine/data-source.ts", category: "content-reader", count: 5 },
  { file: "lib/creative-decision-engine/jobs/ad-decision-outcomes-job.ts", category: "content-reader", count: 3 },
  { file: "lib/creative-decision-engine/jobs/ad-operator-response-job.ts", category: "content-reader", count: 17 },
  { file: "lib/meta/decisions-workspace-read-model.ts", category: "content-reader", count: 7 },
  { file: "lib/meta/history-read-model.ts", category: "content-reader", count: 4 },
  { file: "lib/meta/history-contract.ts", category: "content-reader", count: 1 },
  /*
    AREA 2b 2026-09-07 — the partial-lane rewrite storm. The writer gained two
    reads of this table: the partial-manifest dedupe baseline (the exact
    `stateSelect` winner order, so suppressing a write cannot change a reader's
    answer) and the `readMetaObservationWriterPressure` per-run state probe.
    15 -> 20: two new queries plus three comment references (the dedupe
    baseline's comment records the EXPLAIN ANALYZE that rejected the
    `DISTINCT ON` spelling by name). No existing query changed, and the byte
    pins below still hold.
  */
  /*
    20 -> 28. The schedule carry-forward lateral in `stateSelect` adds four
    correlated sub-selects per query body, in two bodies. They are READS of the
    same table the file already writes, and they add no new authority: each
    resolves one schedule column to the newest row for that entity whose field
    coverage does not say the field was lost to a degraded request, so a NULL
    written by a sync that never asked for `start_time`/`stop_time` cannot erase
    a schedule the system had observed. Read-side and hash-neutral: `state_hash`
    is computed before the write, so coalescing at INSERT time would put a row
    and its own hash out of agreement.
  */
  { file: "lib/meta/entity-state-history.ts", category: "writer", count: 30 },
  // D096 38 -> 50: the migration-only index budget guard adds relation/index
  // size measurements, index catalog validation, budget lookups and diagnostic
  // labels. It reads no entity content and changes no D075 winner predicate.
  { file: "lib/migrations.ts", category: "ddl", count: 50 },
  { file: "lib/meta/__tests__/migration-relation-budget.test.ts", category: "test", count: 3 },
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
  { file: "lib/meta/budget-readiness-retention.ts", category: "schema-contract", count: 8 },
  // The artifact records which queries ran; the test drives the read model over
  // fixtures shaped like that table. Neither reads production content.
  { file: "scripts/audits/d086-budget-readiness-input-pack.ts", category: "reporting-only", count: 4 },
  { file: "scripts/audits/d086-budget-readiness-input-pack.test.ts", category: "test-fixture", count: 7 },
  /*
    D086 correction 8. The capture-to-readiness seam drives the REAL writers
    against an ephemeral cluster, so it names the table where it asserts what
    the writer stored; the seam wrapper names it only in a comment about what
    the delta case proves. Neither reads production content.
  */
  { file: "scripts/d086-capture-to-readiness-child.ts", category: "local-seam", count: 3 },
  { file: "scripts/ephemeral-postgres-d086-readiness-seam.ts", category: "local-seam", count: 2 },
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
  /*
    AREA R5 2026-09-07 — new file, 1 reference. The Graph error-observability
    suite drives the real `fetchMetaCampaignConfigsReceipt` /
    `fetchMetaAdSetConfigsReceipt` against a stubbed global fetch. Its single
    literal is prose in the comment that states the live failure the suite
    pins: this table received no `campaign` row while every `campaign_configs`
    request came back 400. It opens no database connection and issues no query.
  */
  // 1 -> 2: the Round 4 error-boundary work added a second literal reference
  // while proving the Graph envelope never leaks a provider message.
  { file: "lib/meta-graph-error-observability.test.ts", category: "test", count: 2 },
  { file: "lib/meta/decision-pipeline-health.test.ts", category: "test", count: 2 },
  { file: "lib/meta/decisions-os-presentation.test.ts", category: "test", count: 2 },
  { file: "lib/meta/decisions-workspace-read-model.test.ts", category: "test", count: 2 },
  /*
    AREA S4 2026-09-07 — 3 -> 4. The partial-storage-semantic proofs added one
    query over this table: `storedAdsetRows`, the row-level readback the
    as-of/timeline equivalence case and the provenance-clock case both compare
    against. It is a test fixture reading what the writer stored; no production
    path uses it.
  */
  // 4 -> 5: exact same-observed coalescing order is proven by a real-PG
  // transition readback; the added literal belongs only to that test query.
  { file: "lib/meta/entity-state-history-partial-delta.db.test.ts", category: "test", count: 5 },
  /*
    Codex Round 4 item 7. Names the table to seed and read back a schedule the
    provider answered with an unusable value: PostgreSQL used to be the first
    thing that looked at it, inside the transaction, so one bad string aborted
    the whole account's capture. A test reference, not a content consumer.
  */
  { file: "lib/meta/schedule-timestamp-normalization.db.test.ts", category: "test", count: 1 },
  { file: "lib/meta/history-external-change-levels.test.ts", category: "test", count: 3 },
  { file: "lib/meta/history-read-model.test.ts", category: "test", count: 1 },
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
    entity_id) … ORDER BY observed_at DESC, captured_at DESC,
    created_at DESC, id DESC`),
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
  /*
    OPERATOR-READINESS 2026-09-05 — the sizing projection source, classified.

    `intent-projection-context.ts` is a content reader in the D075 sense and
    the reason the budget and bid sizing policies have anything to reason from.
    Two literals, one query: the canonical owner-and-amount read. It is
    latest-per-entity (`DISTINCT ON (entity_type, entity_id) … ORDER BY
    observed_at DESC, captured_at DESC, created_at DESC, id DESC`),
    cutoff-bounded by the snapshot date, and presence-guarded, so an absent
    winner is excluded rather than resurrected. It serves no entity CONTENT to
    a surface: it returns owned minor units, an owner mode and a currency, and
    withholds when ownership is not provable.

    The other two are its proofs — a unit test and the throwaway-database seam
    that runs the same query against a migrated schema.
  */
  { file: "lib/meta/intent-projection-context.ts", category: "content-reader", count: 2 },
  { file: "lib/meta/intent-projection-context.test.ts", category: "test", count: 2 },
  { file: "scripts/ephemeral-postgres-intent-projection-seam-child.ts", category: "harness", count: 2 },
  /*
    OPERATOR-READINESS 2026-09-05 — the end-to-end economics seam.

    It seeds the retained budget truth the sizing policies reason from and then
    calls the REAL snapshot rather than restating any of its arithmetic. The
    fixture no longer writes this table itself: the state rows and the
    observation run now go through the shipped capture chain
    (`queueMetaSyncPartition`, `persistMetaRawSnapshot`,
    `persistMetaEntityObservation`), which is what lets
    `readMeasuredBudgetHistory` attest a complete run instead of returning
    null. The one remaining literal is prose in a comment; the seam issues no
    production query of its own.
  */
  { file: "scripts/ephemeral-postgres-economics-bid-chain-seam-child.ts", category: "harness", count: 1 },
  /*
    OPERATOR-READINESS 2026-09-05 — the mounted Decision Center harness.

    It builds a throwaway workspace in which the product's own Decision Center
    renders a populated lane, so the card-level Apply can be driven in a real
    browser instead of at a SQL seam. Two literals, both fixture: the comment
    naming the composite foreign key, and the INSERT that satisfies it — the
    row has to exist for `readMeasuredBudgetHistory` to attest anything, and
    its observation run has to exist first. It issues no production query over
    this table; the shipped snapshot does that.
  */
  { file: "scripts/meta-decision-card-apply-harness.ts", category: "harness", count: 2 },
  /*
    AREA R25 2026-09-08 — the Rounds 15-24 additions, measured rather than
    estimated. Every entry below was counted from the current tree by the same
    predicate this guard uses, and each is classified by what the reference
    actually IS, not by the file it sits in.

    None of them adds a content read of this table. Six are INDEX NAMES on it
    (the D086 catalog and the manifest-delta access path), three are fixture
    INSERTs in database seams, three are prose, and one is a test double's
    routing predicate.
  */
  /*
    ddl 5 -> 8. The Round 19 D086 index contract: the manifest-delta CREATE and
    its two `buildIndexContractQuery` / `buildInvalidIndexRepairQuery` index
    names, plus the pre-existing d086-latest pair and the column probe. No
    query over the table's rows.
  */
  /*
    writer 28 -> 30. Round 15's partial/delta manifest membership added two
    reads inside the writer's own dedupe baseline; both are the writer's
    existing `stateSelect` winner order, so no reader's answer can change.
  */
  /*
    ddl 32 -> 38. The Round 15/17 delta index: one comment recording the
    production size that motivated the CONCURRENTLY build, the repair query,
    the CREATE, the contract assertion, and the relation name each appear once.
  */
  {
    file: "lib/meta/__tests__/d086-index-catalog-validity.test.ts",
    category: "test",
    count: 2,
  },
  {
    file: "lib/meta/__tests__/index-concurrency-contract.test.ts",
    category: "test",
    count: 4,
  },
  {
    file: "lib/meta/authority-bootstrap-lifecycle.db.test.ts",
    category: "harness",
    count: 2,
  },
  {
    file: "lib/meta/recent-edit-authority-receipt.db.test.ts",
    category: "harness",
    count: 1,
  },
  {
    file: "lib/meta/recent-edit-authority.test.ts",
    category: "test",
    count: 1,
  },
  {
    file: "lib/meta/entity-signals-backfill.ts",
    category: "comment-only",
    count: 1,
  },
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

  /*
    AREA S4 2026-09-07 — the PARTIAL storage semantic, swept.

    The partial lane now writes a delta: `completeness = 'partial'`,
    `manifest_kind` NULL, a `row_count` that is the whole observed payload, and
    a physical row set that is only the entities whose content actually
    differed. A NULL `manifest_kind` is also what a legacy full-payload run
    carries, so the combination alone cannot say which of the two a reader is
    looking at — the writer therefore stamps
    `delta_stats_json.manifestContract` and the cases below pin the predicate
    in each consumer that keeps it from ever having to guess.

    These are byte pins on files this area does not own. They fail if a
    consumer's complete-lane restriction is relaxed, which is the change that
    would turn a deduped partial run into a scope claim.
  */
  it("the partial lane declares its storage contract instead of leaving it to be inferred", () => {
    const writer = readFileSync(join(ROOT, "lib/meta/entity-state-history.ts"), "utf8");
    expect(writer).toContain(
      'export const META_PARTIAL_MANIFEST_CONTRACT =\n  "d075.partial-observed-present-delta.v1" as const;',
    );
    expect(writer).toContain(
      'export const META_COMPLETE_MANIFEST_CONTRACT =\n  "d075.complete-scope-manifest.v1" as const;',
    );
    // Both lanes stamp it, so a run carrying stats never lacks the answer.
    expect(
      writer.match(/manifestContract: META_COMPLETE_MANIFEST_CONTRACT,/g) ?? [],
    ).toHaveLength(2);
    expect(
      writer.match(/manifestContract: META_PARTIAL_MANIFEST_CONTRACT,/g) ?? [],
    ).toHaveLength(1);
    // And the safety half stays structural: no scope-exit row on this lane.
    expect(writer).toContain("exitedEntityCount: 0,");
  });

  it("the D086 readiness attestation refuses a partial capture before it compares membership", () => {
    const src = readFileSync(join(ROOT, "lib/meta/budget-readiness-read-model.ts"), "utf8");
    expect(src).toContain('partial: "capture_partial",');
    const blockerAt = src.indexOf("const statusBlocker = D086_CAPTURE_STATUS_BLOCKER[run.captureStatus];");
    const unknownAt = src.indexOf('if (run.captureStatus !== "complete") {');
    const membershipAt = src.indexOf("run.persistedMembers");
    expect(blockerAt).toBeGreaterThan(-1);
    expect(unknownAt).toBeGreaterThan(blockerAt);
    expect(membershipAt).toBeGreaterThan(unknownAt);
  });

  it("the natural-wave verifier compares expected against persisted rows only on the complete lane", () => {
    const src = readFileSync(
      join(ROOT, "scripts/creative-decision-center/native-ad-natural-wave-operational-verifier.ts"),
      "utf8",
    );
    const laneGuardAt = src.indexOf('source.completeness === "complete" &&');
    const comparisonAt = src.indexOf("sourceExpected === sourcePersisted &&");
    expect(laneGuardAt).toBeGreaterThan(-1);
    expect(comparisonAt).toBeGreaterThan(laneGuardAt);
  });

  it("scope confirmation is complete-lane on every side, so a partial run neither grants nor revokes it", () => {
    const job = readFileSync(join(ROOT, "lib/creative-decision-engine/jobs/ad-operator-response-job.ts"), "utf8");
    for (const line of [
      "WHERE state.run_completeness = 'complete'",
      "AND later_run.completeness = 'complete'",
      "AND newer.run_completeness = 'complete'",
    ]) {
      expect(job).toContain(line);
    }
    const hydration = readFileSync(join(ROOT, "lib/creative-decision-engine/data-source.ts"), "utf8");
    // The run-bound membership arm can only ever see complete-lane runs,
    // because `complete_runs` is filtered before the arm is reached.
    const laneFilterAt = hydration.indexOf("AND run.completeness = 'complete'");
    const boundArmAt = hydration.indexOf("AND run.source_manifest_kind IS DISTINCT FROM 'delta'");
    expect(laneFilterAt).toBeGreaterThan(-1);
    expect(boundArmAt).toBeGreaterThan(laneFilterAt);
  });

  it("D077 compaction plans the complete lane only, and partial rows can only protect a duplicate", () => {
    const planner = readFileSync(join(ROOT, "lib/meta/state-history-compaction.ts"), "utf8");
    expect(planner).toContain("WHERE r.completeness = 'complete'");
    expect(planner).toContain("AND run_completeness = 'complete'");
    // The only role a partial row plays: it makes a complete duplicate
    // load-bearing, so fewer partial rows can only WIDEN what D077 may remove.
    expect(planner).toContain(
      "AND interleaved.run_completeness IN ('partial', 'point_lookup')",
    );
  });

  it("the semantic hash carries the failure but not the request that produced it", () => {
    const writer = readFileSync(join(ROOT, "lib/meta/entity-state-history.ts"), "utf8");
    // Request identity is stripped before the truth is hashed, or every retry
    // of a repeating provider failure is a distinct observation and the run and
    // receipt tables grow one row per attempt with no per-table fence.
    expect(writer).toContain("error: canonicalizeSemanticError(input.error ?? null),");
    for (const field of ['"fbtraceId"', '"message"', '"pageUrl"', '"attempts"']) {
      expect(writer).toContain(field);
    }
    // The run hash and the stored receipt stay byte-faithful to what arrived.
    expect(writer).toContain("    error: input.error ?? null,\n  });");
    // The input rule changed, so the version key changed with it.
    expect(writer).toContain('contractVersion: "meta-entity-observation-semantic.v2",');
  });

  it("the status-recovery callers guard on presence before claiming a recovered status", () => {
    const src = readFileSync(join(ROOT, "lib/api/meta.ts"), "utf8");
    const guards = src.match(/if \(state\.presence !== "present"\) continue;/g) ?? [];
    expect(guards.length).toBe(2);
  });
});
