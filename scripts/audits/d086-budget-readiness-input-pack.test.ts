/**
 * D086 — the artifact, the readiness read model, and the honesty rules that keep
 * both from overstating what was measured.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { ACCOUNT_DECISION_PROFILE_CONTRACT } from "@/lib/creative-decision-engine/account-decision-profile";
import { REQUIRED_SEAM_CASES, runD086PostgresSeam } from "@/scripts/ephemeral-postgres-d086-readiness-seam";
import { ISO_4217_REGISTRY_SOURCE, ISO_4217_REGISTRY_VERSION } from "@/lib/currency/iso-4217-minor-units";
import {
  BUDGET_READINESS_CONTRACT,
  D086_STATE_BUDGET_SQL,
  D086_COMPLETE_RUN_SQL,
  D086_PROFILE_LATEST_SQL,
  D086_ROLE_LATEST_SQL,
  coverageStatus,
  parsePopulationTotal,
  readBudgetReadiness,
  sanitiseReadFailure,
  type BudgetReadinessScope,
} from "@/lib/meta/budget-readiness-read-model";
import {
  D086_ADDITIVE_MIGRATION_SQL,
  D086_REQUIRED_PROFILE_COLUMNS,
  D086_REQUIRED_INDEXES,
  D086_REQUIRED_PARTITION_COLUMNS,
  D086_REQUIRED_RAW_OBSERVATION_COLUMNS,
  D086_CAPABILITY_PROBE_SQL,
  D086_REQUIRED_RUN_COLUMNS,
  D086_REQUIRED_RECEIPT_COLUMNS,
  D086_REQUIRED_STATE_COLUMNS,
  D086_REQUIRED_TOMBSTONE_COLUMNS,
  D086_REQUIRED_ROLE_COLUMNS,
  D086_RETENTION_CONTRACT,
} from "@/lib/meta/budget-readiness-retention";
import {
  D086_CONTRACT_ID,
  D086_FROZEN_ARTIFACTS,
  D086_HORIZONS,
  D086_JSON_OUT,
  D086_PINNED_SOURCES,
  D086_REJECTED_REVISIONS,
  D086_REVISION,
  assertWritableArtifactPath,
  buildD086Artifact,
  d086ArtifactPathFor,
  d086Digest,
  d086TrustedPath,
  d086TrustedReader,
  verifyD086Artifact,
} from "@/scripts/audits/d086-budget-readiness-input-pack";

/** By KEY, never by position — inserting a pinned source must not repoint a test. */
const pinned = (key: string) => {
  const found = D086_PINNED_SOURCES.find((s) => s.key === key);
  if (!found) throw new Error(`no pinned source named ${key}`);
  return found;
};

const published = () =>
  JSON.parse(readFileSync(d086TrustedPath(D086_JSON_OUT), "utf8")) as Record<string, any>;

describe("D086 — the published artifact reproduces and verifies", () => {
  it("verifies against the pinned sources", () => {
    const result = verifyD086Artifact(published());
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toContain("reconstruction");
    expect(result.checked).toContain("pinnedSources");
  });

  it("is byte-complete and round-trips exactly", () => {
    const raw = readFileSync(d086TrustedPath(D086_JSON_OUT));
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    expect(Buffer.from(`${JSON.stringify(parsed, null, 1)}\n`, "utf8")).toEqual(raw);
  });

  it("every pinned source hashes to its pin", () => {
    for (const source of D086_PINNED_SOURCES) {
      const observed = createHash("sha256").update(d086TrustedReader(source.path)).digest("hex");
      expect(observed, source.path).toBe(source.sha256);
    }
  });

  it("FAILS when a pinned source drifts — proven with an injected reader", () => {
    const tampered = (path: string): Buffer =>
      path === pinned("d086_live_census").path
        ? Buffer.from("{}", "utf8")
        : d086TrustedReader(path);
    const result = verifyD086Artifact(published(), tampered);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" | ")).toMatch(/pinned source drift|pinnedSources|reconstruction/);
  });

  it("the output path derives from the contract revision and refuses anything else", () => {
    expect(D086_JSON_OUT).toBe(d086ArtifactPathFor(D086_REVISION));
    expect(D086_CONTRACT_ID).toBe(`d086.budget-readiness-input-pack.v${D086_REVISION}`);
    expect(assertWritableArtifactPath(D086_JSON_OUT)).toBe(D086_JSON_OUT);
    expect(() => assertWritableArtifactPath("docs/audits/generated/elsewhere.json")).toThrow();
    expect(() => assertWritableArtifactPath("package.json")).toThrow();
    // Every earlier revision is frozen, derived — never a hand-kept list.
    expect([...D086_FROZEN_ARTIFACTS]).toEqual(
      Array.from({ length: D086_REVISION - 1 }, (_, i) => d086ArtifactPathFor(i + 1)),
    );
    for (const frozen of D086_FROZEN_ARTIFACTS) {
      expect(() => assertWritableArtifactPath(frozen), frozen).toThrow(/frozen history/);
    }
  });

  it("PINNING IS THE FREEZE: no pinned revision can be written, ever", () => {
    /*
      The derived frozen range only covers revisions BELOW the current one, so a
      revision stays writable while it is current — and running `assemble`
      before bumping the revision overwrites bytes already pinned elsewhere. That
      is how r3 was destroyed during Correction 3, and how r11 was destroyed in
      D085 Correction 11. Being pinned is now itself the freeze.
    */
    for (const rejected of D086_REJECTED_REVISIONS) {
      expect(() => assertWritableArtifactPath(rejected.path), rejected.path)
        .toThrow(/PINNED|frozen history/);
    }
    // The current target is still writable, or nothing could ever be published.
    expect(assertWritableArtifactPath(D086_JSON_OUT)).toBe(D086_JSON_OUT);
    // ...and the current revision is never itself pinned.
    expect(D086_REJECTED_REVISIONS.map((r) => r.revision)).not.toContain(D086_REVISION);
  });

  it("r1 stays byte-identical to the bytes it was rejected with", () => {
    for (const rejected of D086_REJECTED_REVISIONS) {
      const observed = createHash("sha256").update(d086TrustedReader(rejected.path)).digest("hex");
      expect(observed, rejected.path).toBe(rejected.fileSha256);
    }
  });

  it("the verifier FAILS on injected drift of a frozen revision", () => {
    const tampered = (path: string): Buffer =>
      path === pinned("d086_r1_rejected").path
        ? Buffer.from("{\"tampered\":true}\n", "utf8")
        : d086TrustedReader(path);
    const result = verifyD086Artifact(published(), tampered);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" | ")).toMatch(/frozenRevisions|pinnedSources|reconstruction/);
  });

  it("refuses to overwrite any accepted D085 artifact", () => {
    for (let r = 1; r <= 16; r += 1) {
      const path = r === 1
        ? "docs/audits/generated/d085-budget-proposal-dry-run-2026-09-01.json"
        : `docs/audits/generated/d085-budget-proposal-dry-run-2026-09-01.r${r}.json`;
      expect(() => assertWritableArtifactPath(path), path).toThrow();
    }
  });
});

describe("D086 — the six-business denominators are the real ones", () => {
  it("publishes six businesses and seven provider accounts", () => {
    const a = published();
    expect(a.readiness.totals.businesses).toBe(6);
    expect(a.readiness.totals.providerAccounts).toBe(7);
    expect(a.readiness.perBusiness.map((b: any) => b.business).sort()).toEqual([
      "Bilsem Zeka", "ColorFullWorldsTR", "Grandmix", "IwaStore", "IwaTR", "TheSwaf",
    ]);
  });

  it("every business reports its own measured coverage, not a fleet average", () => {
    const a = published();
    const rows = a.readiness.perBusiness as Array<Record<string, any>>;
    expect(rows).toHaveLength(6);
    // Distinct denominators: a single shared number would mean nothing was measured.
    const configCounts = rows.map((b) => b.budgetFactRetention.configRowsExamined);
    expect(new Set(configCounts).size).toBe(6);
    for (const b of rows) {
      expect(b.budgetFactRetention.rowsCarryingAUnit, b.business).toBe(0);
      expect(b.roleAuthorityRetention.qualifyingRows, b.business).toBe(0);
      expect(b.profileOutputRetention.retainedVerdicts, b.business).toBe(0);
      expect(b.roleAuthorityRetention.accountScopedRows, b.business).toBe(0);
      expect(b.roleAuthorityRetention.compiledResolverVersionRows, b.business).toBe(0);
    }
    // The totals are the sum of the parts, not a separately typed number.
    expect(a.readiness.totals.configRowsExamined)
      .toBe(rows.reduce((n, b) => n + b.budgetFactRetention.configRowsExamined, 0));
    expect(a.readiness.totals.roleRowsExamined)
      .toBe(rows.reduce((n, b) => n + b.roleAuthorityRetention.rowsExamined, 0));
  });

  it("the best retained role row still fails on account scope AND resolver version", () => {
    // The most favourable retained row — system_inferred, high — qualifies for nothing.
    for (const b of published().readiness.perBusiness as Array<Record<string, any>>) {
      const blockers: string[] = b.roleAuthorityRetention.bestCaseRowBlockers;
      expect(blockers, b.business).toContain("role_provider_account_scope_missing");
      expect(blockers, b.business).toContain("role_resolver_version_not_compiled");
    }
  });
});

describe("D086 — honesty rules", () => {
  it("no closure claims observed authority", () => {
    for (const c of published().closures as Array<Record<string, any>>) {
      expect(c.closureClass, c.dimension).toBe("forward_only_after_deploy");
      expect(c.preconditions.length, c.dimension).toBeGreaterThan(0);
    }
  });

  it("the provider-write blocker stays CLOSED and unchanged", () => {
    const residual = published().residualBlockers as Array<Record<string, any>>;
    const writePath = residual.find((r) => r.blocker === "no_provider_write_path_exists");
    expect(writePath?.state).toMatch(/^CLOSED/);
    /*
      ...and no source in this slice REACHES a provider write. Linkage, not prose:
      the residual-blocker text names `MUTATION_ENDPOINTS` in order to say it is
      untouched, and a substring scan would fire on that sentence. String literals
      and comments are stripped first, exactly as the D085 C15 comment scan does.
    */
    const strip = (text: string) => text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    const reachesProviderWrite = (text: string) =>
      /\b(?:from|import)\s*\(?\s*["'][^"']*(?:dispatch-contract|meta-write|provider-write)/.test(text)
      || /\bMUTATION_ENDPOINTS\b/.test(text)
      || /\bfetch\s*\(/.test(text)
      || /\bgraph\.facebook\.com/.test(text);
    for (const file of [
      "scripts/audits/d086-budget-readiness-input-pack.ts",
      "lib/meta/budget-readiness-retention.ts",
      "lib/meta/budget-readiness-read-model.ts",
    ]) {
      expect(reachesProviderWrite(strip(readFileSync(d086TrustedPath(file), "utf8"))), file).toBe(false);
    }
    // POSITIVE CONTROL: the detector fires on real linkage, so this cannot pass vacuously.
    expect(reachesProviderWrite(`import { MUTATION_ENDPOINTS } from "@/lib/zero-base/meta/dispatch-contract";`)).toBe(true);
    expect(reachesProviderWrite(`await fetch(url);`)).toBe(true);
    expect(reachesProviderWrite(strip(`// MUTATION_ENDPOINTS is untouched`))).toBe(false);
  });

  it("the side-effect ledger is all zeros", () => {
    const ledger = published().sideEffectLedger as Record<string, unknown>;
    for (const key of [
      "databaseWritesIssued", "ddlStatementsExecuted", "migrationsApplied", "extensionsInstalled",
      "providerApiCalls", "providerWritesAttempted", "browserOrLocalhostProbes", "automationFlagsSet",
    ]) {
      expect(ledger[key], key).toBe(0);
    }
    expect(ledger.filesWritten).toEqual([D086_JSON_OUT]);
  });

  it("every current prepared statement is registered, while this artifact applies nothing", () => {
    expect(published().preparedMigrations.applied).toBe(false);
    expect(published().preparedMigrations.statements).toBe(D086_ADDITIVE_MIGRATION_SQL.length);
    expect(published().preparedMigrations.sqlDigest).toBe(d086Digest(D086_ADDITIVE_MIGRATION_SQL));
    let registry = readFileSync(d086TrustedPath("lib/migrations.ts"), "utf8")
      + readFileSync(d086TrustedPath("lib/meta/observation-receipt-schema.ts"), "utf8");
    for (const match of registry.matchAll(/const (DELTA_INDEX_KEY|RECEIPT_FRESHNESS_KEY|RECEIPT_COHORT_KEY) =\s*"([^"]+)"/g)) {
      registry = registry.replaceAll("${" + match[1] + "}", match[2]!);
    }
    const normalise = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ").replace(/\bCONCURRENTLY\b/g, " ").replace(/\s+/g, " ").trim();
    for (const statement of D086_ADDITIVE_MIGRATION_SQL) {
      expect(normalise(registry), statement).toContain(normalise(statement));
    }
    expect(D086_ADDITIVE_MIGRATION_SQL.join("\n")).not.toContain("budget_fact_contract");
  });

  it("every prepared statement is additive and idempotent", () => {
    for (const sql of D086_ADDITIVE_MIGRATION_SQL) {
      /*
        ── ROUND 19, ITEM C8 ────────────────────────────────────────────────
        `DROP INDEX IF EXISTS <legacy occurrence>` is the one exception, and it
        is admitted deliberately rather than by loosening the rule for
        everything. It is idempotent by its own `IF EXISTS`, it removes an INDEX
        rather than data, and it is the statement that retires the four-column
        occurrence key whose recreation would 23505 against multi-attempt
        receipts. Every other statement is still required to be `IF NOT EXISTS`
        and free of destructive verbs.
      */
      const isLegacyIndexRetirement =
        /^\s*DROP INDEX IF EXISTS meta_entity_observation_receipts_occurrence\s*$/i.test(
          sql,
        );
      if (isLegacyIndexRetirement) continue;
      expect(sql, sql.slice(0, 60)).toMatch(/IF NOT EXISTS/);
      // No statement may drop, rename, truncate or rewrite existing data.
      // `ON DELETE RESTRICT` is a foreign-key ACTION, not a delete. Stripping it
      // first keeps the destructive-verb rule exact instead of merely strict.
      const withoutFkActions = sql.replace(/ON\s+DELETE\s+(RESTRICT|NO\s+ACTION|CASCADE|SET\s+NULL)/gi, "");
      expect(withoutFkActions).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|RENAME|ALTER COLUMN)\b/i);
    }
  });

  it("the fleet-replay number is ZERO and says why", () => {
    /*
      The number that would be easiest to inflate. Every cell surviving the
      write-scope gate dies at `no_concrete_entity_selected`, which precedes every
      gate these closures address, so the closures clear nothing at this grain.
    */
    for (const row of published().simulation as Array<Record<string, any>>) {
      expect(row.cellsClearedAtReplayGrain, row.horizon).toBe(0);
      expect(row.evaluationsClearedAtReplayGrain, row.horizon).toBe(0);
      expect(row.replayGrainNote).toMatch(/no_concrete_entity_selected/);
    }
  });

  it("the conditional lane is complete: removed + remaining = the whole census", () => {
    const d085 = JSON.parse(
      d086TrustedReader(pinned("d085_r16_accepted").path).toString("utf8"),
    ) as Record<string, any>;
    const allCodes = (d085.analysis.blockerCensus as Array<{ code: string }>).map((c) => c.code).sort();
    for (const row of published().simulation as Array<Record<string, any>>) {
      const partition = [
        ...row.codesRemovedConditional,
        ...row.codesRemovedOnlyForActionBearing,
        ...row.codesRemainingConditional,
      ].sort();
      expect(partition, row.horizon).toEqual(allCodes);
      // The provider-write blocker is never in the removed set.
      expect(row.codesRemovedConditional).not.toContain("no_provider_write_path_exists");
      expect(row.codesRemovedOnlyForActionBearing).not.toContain("no_provider_write_path_exists");
      /*
        r1 claimed retention removes `owner_mode_unknown`. It does not: that code
        clears only for an action-bearing observation, and it is reported in its
        own bucket rather than folded into the unconditional set.
      */
      expect(row.codesRemovedConditional).not.toContain("owner_mode_unknown");
      expect(row.codesRemovedOnlyForActionBearing).toContain("owner_mode_unknown");
      expect(row.codesRemainingConditional).toContain("no_provider_write_path_exists");
    }
  });

  it("the horizons are several, and each carries the measurement that chose it", () => {
    expect(D086_HORIZONS.length).toBeGreaterThanOrEqual(5);
    for (const h of D086_HORIZONS) {
      expect(h.why.length, h.key).toBeGreaterThan(30);
    }
    // Not one arbitrary month: they span more than three months of real time.
    const spanMs = Date.parse(D086_HORIZONS.at(-1)!.cutoffIso) - Date.parse(D086_HORIZONS[0].cutoffIso);
    expect(spanMs).toBeGreaterThan(90 * 86_400_000);
  });

  it("no causal claim appears anywhere in the artifact", () => {
    const text = JSON.stringify(published()).toLowerCase();
    for (const forbidden of ["roas lift", "revenue lift", "profit lift", "caused", "incremental revenue"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("no buyer-facing label vocabulary appears anywhere in the artifact", () => {
    const text = JSON.stringify(published());
    for (const forbidden of ["brief_variation", "Test campaign", "Main campaign", "manual label", "Promote to main"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("the live read provenance is published, including its transaction properties", () => {
    const p = published().provenance.liveRead as Record<string, unknown>;
    expect(p.transactionReadOnly).toBe("on");
    expect(p.transactionIsolation).toBe("repeatable read");
    expect(p.writesIssued).toBe(0);
    expect(p.ddlIssued).toBe(0);
    expect(p.providerCalls).toBe(0);
    expect(String(p.readAtUtc)).toMatch(/^2026-09-02T/);
  });

  it("the ingestion fence is published as the operator-owned precondition it is", () => {
    const residual = published().residualBlockers as Array<Record<string, any>>;
    const fence = residual.find((r) => r.blocker === "ingestion_admission_refused");
    expect(fence?.state).toMatch(/OPERATOR-OWNED/);
    expect(fence?.evidence).toMatch(/40,960 bytes/);
  });
});

// ---------------------------------------------------------------------------
// The readiness read model
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const fakeDb = (handler: (sql: string, params?: unknown[]) => Row[] | Error) => ({
  query: async <T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]> => {
    const out = handler(sql, params);
    if (out instanceof Error) throw out;
    return out as T[];
  },
});

const NOW = "2026-09-02T13:43:00Z";
const BIZ = "b1";
const ACCT = "act_1";
const scope = (over: Partial<BudgetReadinessScope> = {}): BudgetReadinessScope => ({
  businessId: BIZ,
  providerAccountId: ACCT,
  nowIso: NOW,
  approvedResolverVersion: null,
  ...over,
});

const noCapability = {
  partition_columns: 0, raw_observation_columns: 0, profile_columns: 0, role_columns: 0,
};
const fullCapability = {
  // C8: the cohort's own seams. The config-history counts are gone with the
  // query that read them.
  partition_columns: D086_REQUIRED_PARTITION_COLUMNS.length,
  raw_observation_columns: D086_REQUIRED_RAW_OBSERVATION_COLUMNS.length,
  profile_columns: D086_REQUIRED_PROFILE_COLUMNS.length,
  role_columns: D086_REQUIRED_ROLE_COLUMNS.length,
  // C7: the universe prerequisites are part of capability now.
  run_columns: D086_REQUIRED_RUN_COLUMNS.length,
  receipt_columns: D086_REQUIRED_RECEIPT_COLUMNS.length,
  state_columns: D086_REQUIRED_STATE_COLUMNS.length,
  tombstone_columns: D086_REQUIRED_TOMBSTONE_COLUMNS.length,
};

/**
 * A catalog in which every required index exists AND carries the exact
 * expressions the query orders by. Definitions are built from the contract so a
 * fixture cannot drift from the gate it is meant to satisfy.
 */
const satisfiedIndexCatalog: Row[] = D086_REQUIRED_INDEXES.map((index) => ({
  indexname: index.indexName,
  indexdef:
    `CREATE INDEX ${index.indexName} ON public.x USING btree `
    + `(${index.mustContain.filter((f) => f !== "UNIQUE").join(", ")})`
    + (index.mustContain.includes("UNIQUE") ? " -- UNIQUE" : ""),
  /*
    ── ROUND 19, ITEM C8 ──────────────────────────────────────────────────────
    The catalogue no longer reads `pg_indexes`, which reports EXISTENCE only. It
    joins `pg_index` and requires `indisvalid`, `indisready` and `indislive`,
    because an interrupted `CREATE INDEX CONCURRENTLY` leaves a row that is
    named correctly, carries the right definition, and is INVALID — PostgreSQL
    refuses to use it while the readiness gate reported satisfied.

    A fixture that omits these flags is now UNUSABLE by design, so they are
    supplied here rather than defaulted anywhere.
  */
  indisvalid: true,
  indisready: true,
  indislive: true,
}));

/** A retained config row that IS a valid canonical budget fact. */
const validBudgetRow = (over: Row = {}): Row => ({
  /*
    C7: this is a STATE HISTORY row, because that is what the readiness read now
    projects through D083's canonical boundary. The r7 fixture was a
    config-history row, and config history's only writer records transitions and
    never stamps `source_run_id` — so no such row could ever have attested.
  */
  grain: "campaign",
  entity_id: "23851",
  campaign_id: "23851",
  presence: "present",
  run_completeness: "complete",
  configured_status: "ACTIVE",
  effective_status: "ACTIVE",
  budget_origin: "campaign",
  budget_currency: "TRY",
  budget_currency_exponent: 2,
  budget_currency_registry_version: ISO_4217_REGISTRY_VERSION,
  // The CAPTURED shape. Absent, the canonical fact refuses for
  // `budget_shape_not_observed`, which is the fail-closed direction.
  budget_shape_support: "supported",
  campaign_daily_budget_raw: "250000",
  campaign_lifetime_budget_raw: null,
  adset_daily_budget_raw: null,
  adset_lifetime_budget_raw: null,
  campaign_start_time: null,
  campaign_end_time: null,
  adset_start_time: null,
  adset_end_time: null,
  provider_api_version: "v22.0",
  state_hash: "a".repeat(64),
  observation_id: "obs-1",
  field_coverage_json: { configuredStatus: true, effectiveStatus: true },
  provider_updated_at: "2026-09-01T02:00:00.000Z",
  observed_on: "2026-09-01",
  observed_at: "2026-09-01T03:00:00.000Z",
  captured_at: "2026-09-01T03:00:00.000Z",
  created_at: "2026-09-01T03:00:05.000Z",
  id: "state-1",
  run_id: CAMPAIGN_RUN,
  // Full provenance: D083 refuses a fact whose subject provenance is
  // incomplete, and it is right to.
  source_snapshot_id: "snap-1",
  payload_hash: "b".repeat(64),
  run_hash: "c".repeat(64),
  // The single statement returns these with every row.
  distinct_truths: 1,
  population_total: 1,
  ...over,
});

/*
  C7: the ownership shapes, stated as the OBSERVED amounts that produce them.

  D083 resolves the owner from where the money actually is and cross-checks the
  stored origin against it; there is no `budget_owner_mode` column to assert any
  more, and asserting one was how r7 built a budget authority parallel to D083's.
*/
/** A campaign that carries its own daily budget: the CBO owner. */
const cboCampaign = (over: Row = {}): Row => validBudgetRow(over);

/** A campaign that carries no budget at all: it defers to its ad-sets. */
const aboCampaign = (over: Row = {}): Row => validBudgetRow({
  campaign_daily_budget_raw: null,
  budget_origin: "not_applicable",
  ...over,
});

/** An ad-set under a CBO campaign: carries nothing, defers upward. */
const deferringAdset = (over: Row = {}): Row => validBudgetRow({
  grain: "adset", entity_id: "as1", campaign_id: "23851",
  // The ad-set endpoint produces its OWN payload, so its rows cite the ad-set
  // snapshot; the two grains are tied together by the cohort, not the snapshot.
  source_snapshot_id: "snap-2",
  campaign_daily_budget_raw: null, adset_daily_budget_raw: null,
  budget_origin: "not_applicable", run_id: ADSET_RUN,
  ...over,
});

/** An ad-set that carries its own budget: the ABO owner. */
const owningAdset = (over: Row = {}): Row => validBudgetRow({
  grain: "adset", entity_id: "as1", campaign_id: "23851",
  // The ad-set endpoint produces its OWN payload, so its rows cite the ad-set
  // snapshot; the two grains are tied together by the cohort, not the snapshot.
  source_snapshot_id: "snap-2",
  campaign_daily_budget_raw: null, adset_daily_budget_raw: "90000",
  budget_origin: "adset", run_id: ADSET_RUN,
  ...over,
});

/** A row whose captured origin is unusable: the owner is genuinely unknown. */
const unknownOwner = (over: Row = {}): Row => validBudgetRow({
  budget_origin: null, ...over,
});

/** A retained profile row that IS usable at serve time. */
const validProfileRow = (over: Row = {}): Row => ({
  contract: D086_RETENTION_CONTRACT,
  profile_contract: ACCOUNT_DECISION_PROFILE_CONTRACT,
  business_id: BIZ,
  provider_account_id: ACCT,
  action: "cut",
  engine_epoch: ENGINE_VERSION,
  engine_version: ENGINE_VERSION,
  input_fingerprint: "a".repeat(64),
  source_fingerprint: "b".repeat(64),
  eligible: false,
  blocker_code: "break_even_roas_missing",
  as_of_date: "2026-09-02",
  effective_at: "2026-09-02T09:00:00.000Z",
  recorded_at: "2026-09-02T09:00:00.000Z",
  tied_rows: 1,
  distinct_truths: 1,
  population_total: 1,
  ...over,
});

/** A retained AUTHORITY row that qualifies. */
const validRoleRow = (over: Row = {}): Row => ({
  contract: D086_RETENTION_CONTRACT,
  business_id: BIZ,
  provider_account_id: ACCT,
  campaign_id: "c1",
  as_of_date: "2026-09-01",
  inferred_kind: "main",
  kind_source: "system_inferred",
  resolver_version: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  confidence_class: "high",
  evidence_hash: "e".repeat(64),
  input_hash: "f".repeat(64),
  effective_at: "2026-09-01T00:00:00.000Z",
  recorded_at: "2026-09-01T00:00:00.000Z",
  provenance: "engine_v3_campaign_role_authority",
  tied_rows: 1,
  distinct_truths: 1,
  population_total: 1,
  ...over,
});

const CAMPAIGN_RUN = "11111111-1111-4111-8111-111111111111";
const ADSET_RUN = "22222222-2222-4222-8222-222222222222";

const COHORT = "33333333-3333-4333-8333-333333333333";
/** The base run a genuine delta manifest inherits its unchanged members from. */
const BASE_RUN = "44444444-4444-4444-8444-444444444444";
const SNAPSHOT_REF = "55555555-5555-4555-8555-555555555555";
const SNAPSHOT_REF_ADSET = "66666666-6666-4666-8666-666666666666";

/**
 * A complete, successful, cohort-bound manifest for both grains, carrying the
 * EXACT reconstructed member identities. Correction 6 made counts insufficient.
 */
const manifest = (campaignIds: string[], adsetIds: string[], over: Row = {}): Row[] => [
  { entity_type: "campaign", run_id: CAMPAIGN_RUN, endpoint: "campaign_configs",
    run_endpoint: "campaign_configs", capture_status: "complete",
    completeness: "complete", manifest_kind: "full", row_count: campaignIds.length,
    provider_row_count: campaignIds.length, run_reused: false,
    persisted_members: campaignIds.length, tombstoned_members: 0, member_ids: campaignIds,
    captured_at: "2026-09-01T00:00:00.000Z", receipt_captured_at: "2026-09-01T00:00:00.000Z",
    source_snapshot_id: "snap-1", source_snapshot_ref_id: SNAPSHOT_REF,
    partition_id: COHORT, run_succeeded: true,
    tied_at_clock: 1, tied_distinct_truths: 1,
    // C8: the cohort's provenance, as the query validates it.
    partition_present: true, partition_scope_ok: true, partition_lane_ok: true,
    snapshot_present: true, snapshot_partition_ok: true, snapshot_endpoint_ok: true,
    snapshot_occurrence_ok: true,
    member_run_ids: [CAMPAIGN_RUN], ...over },
  { entity_type: "adset", run_id: ADSET_RUN, endpoint: "adset_configs",
    run_endpoint: "adset_configs", capture_status: "complete",
    completeness: "complete", manifest_kind: "full", row_count: adsetIds.length,
    provider_row_count: adsetIds.length, run_reused: false,
    persisted_members: adsetIds.length, tombstoned_members: 0, member_ids: adsetIds,
    captured_at: "2026-09-01T00:00:00.000Z", receipt_captured_at: "2026-09-01T00:00:00.000Z",
    source_snapshot_id: "snap-2", source_snapshot_ref_id: SNAPSHOT_REF_ADSET,
    partition_id: COHORT, run_succeeded: true,
    tied_at_clock: 1, tied_distinct_truths: 1,
    partition_present: true, partition_scope_ok: true, partition_lane_ok: true,
    snapshot_present: true, snapshot_partition_ok: true, snapshot_endpoint_ok: true,
    snapshot_occurrence_ok: true,
    member_run_ids: [ADSET_RUN], ...over },
];

const route = (rows: {
  capability?: Row; budget?: Row[]; profile?: Row[]; role?: Row[]; legacy?: Row[]; runs?: Row[];
  indexes?: Row[]; timeZone?: string;
}) => fakeDb((sql) => {
  if (sql.includes("information_schema")) return [rows.capability ?? noCapability];
  if (sql.includes("pg_index")) return rows.indexes ?? satisfiedIndexCatalog;
  if (sql.includes("business_provider_accounts")) {
    return [{ account_timezone: rows.timeZone ?? "Europe/Istanbul" }];
  }
  // The attestation reads RECEIPTS; the budget facts read STATE HISTORY. Both
  // mention the run table, so the receipt clause has to be tested first.
  if (sql.includes("meta_entity_observation_receipts")) return rows.runs ?? [];
  if (sql.includes("meta_entity_state_history")) return rows.budget ?? [];
  if (sql.includes("engine_v3_account_profile_output")) return rows.profile ?? [];
  if (sql.includes("engine_v3_campaign_role_authority")) return rows.role ?? [];
  if (sql.includes("engine_v3_campaign_context_daily")) return rows.legacy ?? [];
  return [];
});

/** SQL prose is not SQL: assertions about a statement must not read comments. */
const stripSqlComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

const dim = (m: Awaited<ReturnType<typeof readBudgetReadiness>>, key: string) =>
  m.dimensions.find((d) => d.key === key)!;

describe("D086 C1 #2 — readiness is account-scoped and never aggregated", () => {
  it("fails CLOSED when no single assigned account resolves", async () => {
    /*
      r1 took a business id only. TheSwaf has TWO provider accounts, so a
      business-wide read would have blended two accounts into one verdict.
    */
    const m = await readBudgetReadiness(route({}), scope({ providerAccountId: null }));
    expect(m.providerAccountId).toBeNull();
    expect(m.scopeBlocker).toBe("readiness_scope_unresolved");
    expect(m.dimensions).toHaveLength(3);
    for (const d of m.dimensions) {
      expect(d.status, d.key).toBe("unavailable");
      expect(d.blocker, d.key).toBe("readiness_scope_unresolved");
      expect(d.evidence).toMatch(/never aggregated across accounts/);
    }
  });

  it("passes the selected account into EVERY account-scoped query", async () => {
    const seen: unknown[][] = [];
    const db = fakeDb((sql, params) => {
      if (sql.includes("information_schema")) return [fullCapability];
      // The index catalog reads the SCHEMA, not this account's rows; it takes
      // index names and has no account to be scoped to.
      if (sql.includes("pg_index")) return satisfiedIndexCatalog;
      seen.push([...(params ?? [])]);
      return [];
    });
    await readBudgetReadiness(db, scope());
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const params of seen) {
      expect(params[0], JSON.stringify(params)).toBe(BIZ);
      expect(params[1], JSON.stringify(params)).toBe(ACCT);
    }
  });

  it("a FOREIGN-account row cannot become readiness even if the query returns it", async () => {
    // Defence in depth: the SQL filters, and the canonical validator checks again.
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, runs: manifest(["23851"], []), budget: [validBudgetRow({ provider_account_id: "act_OTHER" })] }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    /*
      C7: the refusal now comes from D083's own scope validation, so the row is
      not an applicable owner at all — it is reported as OUT OF SCOPE by name
      rather than being adopted into this account's denominator and then failing
      some later gate.
    */
    expect(budget.status).not.toBe("ready");
    expect(budget.coverage?.qualifying).toBe(0);
    expect(budget.coverage?.universe?.applicable).toBe(0);
    expect(budget.coverage?.universe?.ownerUnknown).toBe(1);
    expect(budget.evidence).toMatch(/budget_row_out_of_scope/);
  });

  it("the model reports the exact account it measured", async () => {
    const m = await readBudgetReadiness(route({}), scope());
    expect(m.providerAccountId).toBe(ACCT);
    expect(m.scopeBlocker).toBeNull();
  });
});

describe("D086 C1 #3 — the authority table is the authority", () => {
  it("a VALID new-table row qualifies and makes the dimension ready", async () => {
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, role: [validRoleRow()] }),
      scope({ approvedResolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION }),
    );
    const role = dim(m, "role_authority_retention");
    expect(role.source).toMatch(/engine_v3_campaign_role_authority/);
    expect(role.coverage).toEqual({ qualifying: 1, examined: 1, population: 1, conflicts: 0, truncated: false });
    expect(role.status).toBe("ready");
    expect(role.blocker).toBeNull();
  });

  it("a LEGACY row can never produce ready authority", async () => {
    /*
      r1 computed the role-table capability and then ignored it, always reading
      the legacy daily table and fabricating empty hashes — so a valid authority
      row could not qualify and a legacy row was the only thing ever measured.
    */
    const m = await readBudgetReadiness(
      route({
        capability: { ...fullCapability, role_columns: 0 },
        legacy: [{ provider_account_id: ACCT, resolver_version: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
          confidence_class: "high", kind_source: "system_inferred", as_of_date: "2026-09-01",
          population_total: 1 }],
      }),
      scope({ approvedResolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION }),
    );
    const role = dim(m, "role_authority_retention");
    expect(role.status).toBe("forward_only_after_deploy");
    expect(role.coverage).toEqual({ qualifying: 0, examined: 1, population: 1, conflicts: 0, truncated: false });
    expect(role.source).toMatch(/legacy migration evidence/);
    expect(role.evidence).toMatch(/never authority-bearing/);
  });

  it("the authority query is exact account scope", async () => {
    let params: unknown[] = [];
    const db = fakeDb((sql, p) => {
      if (sql.includes("information_schema")) return [fullCapability];
      if (sql.includes("engine_v3_campaign_role_authority")) { params = [...(p ?? [])]; return []; }
      return [];
    });
    await readBudgetReadiness(db, scope());
    expect(params.slice(0, 2)).toEqual([BIZ, ACCT]);
  });

  it("an unapproved gate keeps a valid row review-only", async () => {
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, role: [validRoleRow()] }),
      scope({ approvedResolverVersion: null }),
    );
    const role = dim(m, "role_authority_retention");
    expect(role.status).not.toBe("ready");
    expect(role.evidence).toMatch(/role_resolver_authority_gate_unset/);
  });
});

describe("D086 C1 #4 — READY means every row validated, not counted", () => {
  it("POSITIVE CONTROL: a complete valid budget row is ready", async () => {
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, runs: manifest(["23851"], []), budget: [validBudgetRow()] }), scope(),
    );
    expect(dim(m, "budget_fact_retention").status).toBe("ready");
  });

  /*
    C7: the same refusals, stated in the vocabulary of the row the read model
    actually consumes. Each override removes or corrupts one thing D083 needs;
    the canonical fact must refuse, and readiness must not be READY.
  */
  it.each([
    ["a missing budget amount", { campaign_daily_budget_raw: null }],
    ["both budget shapes at once",
      { campaign_daily_budget_raw: "250000", campaign_lifetime_budget_raw: "900000" }],
    ["a major-unit float amount", { campaign_daily_budget_raw: "2500.5" }],
    ["a missing currency", { budget_currency: null }],
    ["an uncaptured currency exponent", { budget_currency_exponent: null }],
    ["an unrecognised registry version", { budget_currency_registry_version: "not-a-version" }],
    ["an unobserved budget shape", { budget_shape_support: null }],
    ["an origin that disagrees with the amounts", { budget_origin: "adset" }],
    ["a missing provider API version", { provider_api_version: null }],
    ["a missing run identity", { run_id: null }],
    ["incomplete provenance", { run_hash: null }],
    ["a post-cutoff observation",
      { observed_at: "2026-09-03T00:00:00.000Z", captured_at: "2026-09-03T00:00:00.000Z",
        observed_on: "2026-09-03" }],
    ["an ad-set row with no parent", { grain: "adset", campaign_id: null }],
  ])("%s prevents READY", async (_label, over) => {
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, runs: manifest(["23851"], []), budget: [validBudgetRow(over)] }), scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.status, JSON.stringify(over)).not.toBe("ready");
    expect(budget.coverage?.qualifying).toBe(0);
  });

  it("an UNKNOWN owner mode is retained but is NOT ready", async () => {
    /*
      r1's conditional lane claimed retention removes `owner_mode_unknown`. It
      does not: a fact whose observed owner mode is unknown is retained as honest
      evidence, and a blocker about not knowing the owner cannot be cleared by
      evidence that does not know the owner.
    */
    for (const mode of ["unknown", "mixed"]) {
      const m = await readBudgetReadiness(
        route({
          capability: fullCapability,
          runs: manifest(["23851"], []),
          budget: [unknownOwner({ budget_origin: mode === "mixed" ? "mixed" : null })],
        }),
        scope(),
      );
      const budget = dim(m, "budget_fact_retention");
      expect(budget.status, mode).not.toBe("ready");
      // EXAMINED is now the APPLICABLE-owner denominator: an uncaptured owner is
      // not an applicable owner, and it is reported in the universe instead.
      expect(budget.coverage?.universe?.ownerUnknown, mode).toBe(1);
      expect(budget.coverage?.examined, mode).toBe(0);
      // The universe reports it as uncaptured ownership, not as a validator refusal.
      expect(budget.evidence, mode).toMatch(/owner uncaptured 1/);
    }
  });

  it("an ad-set deferring to a campaign that is NOT in the evidence is uncovered", async () => {
    /*
      C4 #4: a proven non-owner is no longer run through the applicable-owner
      validator as a refusal. Here the campaign it defers to is absent, so the
      owner is UNCOVERED — the honest state — rather than a refusal about a row
      that was correctly not an owner.
    */
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest([], ["as1"]),
        budget: [deferringAdset({ campaign_id: "c_absent" })],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.status).not.toBe("ready");
    expect(budget.coverage?.universe?.uncoveredApplicable).toBe(1);
    expect(budget.evidence).toMatch(/budget_owner_universe_unproven/);
  });

  it("one bad row among good ones is PARTIAL, never ready", async () => {
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851", "c2"], []),
        budget: [
          validBudgetRow({ population_total: 2 }),
          validBudgetRow({ entity_id: "2", budget_currency_exponent: null, population_total: 2 }),
        ],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.coverage).toMatchObject({ qualifying: 1, examined: 2, population: 2, conflicts: 0, truncated: false });
    expect(budget.status).toBe("partial");
    expect(budget.blocker).not.toBeNull();
  });

  it("an INCOMPLETE prerequisite blocks the dimension, and NAMES which one", async () => {
    /*
      C7: capability is the universe's prerequisites now — the runs, the capture
      receipts, the state history and the tombstones — not the config-history
      columns, which readiness no longer reads. Each shortfall must name itself,
      because a generic answer sends an operator to the wrong table.
    */
    for (const [capability, expected] of [
      [{ ...fullCapability, receipt_columns: D086_REQUIRED_RECEIPT_COLUMNS.length - 1 },
        /capture receipts: \d+ of \d+ columns/],
      [{ ...fullCapability, tombstone_columns: 0 }, /entity tombstones: 0 of \d+ columns/],
      [{ ...fullCapability, run_columns: 1 }, /observation runs: 1 of \d+ columns/],
      [{ ...fullCapability, state_columns: 2 }, /entity state history: 2 of \d+ columns/],
    ] as const) {
      const m = await readBudgetReadiness(
        route({ capability, budget: [validBudgetRow()] }), scope());
      const budget = dim(m, "budget_fact_retention");
      expect(budget.status, JSON.stringify(capability)).toBe("forward_only_after_deploy");
      expect(budget.evidence).toMatch(expected);
    }
  });

  it("a required index that is ABSENT or UNUSABLE blocks the dimension by name", async () => {
    /*
      r7's catalog gate checked plain clock columns while the query ranked on
      heartbeat-effective expressions, so it validated an index that could not
      serve the read it claimed to serve. Absence and unusability are separate.
    */
    const absent = await readBudgetReadiness(
      route({ capability: fullCapability, indexes: satisfiedIndexCatalog.slice(1) }), scope());
    expect(dim(absent, "budget_fact_retention").evidence).toMatch(/index absent: /);

    const unusable = await readBudgetReadiness(
      route({
        capability: fullCapability,
        indexes: satisfiedIndexCatalog.map((row, i) => i === 0
          ? { ...row, indexdef: "CREATE INDEX x ON public.y USING btree (captured_at DESC)" }
          : row),
      }),
      scope(),
    );
    expect(dim(unusable, "budget_fact_retention").evidence).toMatch(/index unusable: /);
  });

  it("the budget read covers BOTH the campaign and the ad-set grain", async () => {
    let sql = "";
    const db = fakeDb((text) => {
      if (text.includes("information_schema")) return [fullCapability];
      if (text.includes("pg_index")) return satisfiedIndexCatalog;
      // The attestation query joins state history too; match the receipts
      // first so this captures the BUDGET read and not that one.
      if (text.includes("meta_entity_observation_receipts")) return [];
      if (text.includes("meta_entity_state_history")) { sql = text; return []; }
      return [];
    });
    await readBudgetReadiness(db, scope());
    expect(sql).toContain("meta_entity_state_history");
    expect(sql).toContain("state.entity_type IN ('campaign', 'adset')");
  });

  it("POSITIVE CONTROL: verdicts for all three actions are ready", async () => {
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        profile: [
          validProfileRow({ action: "cut", population_total: 3 }),
          validProfileRow({ action: "scale", blocker_code: "target_roas_missing", population_total: 3 }),
          validProfileRow({ action: "refresh", eligible: true, blocker_code: null, population_total: 3 }),
        ],
      }),
      // Identity agreement is REQUIRED; without it nothing is ready (C2 #1).
      scope({
        expectedProfileInputFingerprint: "a".repeat(64),
        expectedProfileSourceFingerprint: "b".repeat(64),
      }),
    );
    expect(dim(m, "profile_output_retention").status).toBe("ready");
  });

  it("verdicts for only SOME actions are PARTIAL, never ready", async () => {
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, profile: [validProfileRow({ action: "cut" })] }),
      scope({
        expectedProfileInputFingerprint: "a".repeat(64),
        expectedProfileSourceFingerprint: "b".repeat(64),
      }),
    );
    const profile = dim(m, "profile_output_retention");
    expect(profile.status).toBe("partial");
    expect(profile.evidence).toMatch(/actions covered: cut/);
  });

  it.each([
    ["a foreign contract", { contract: "something.else.v1" }],
    ["a retired engine epoch", { engine_epoch: "v2-old" }],
    ["a missing input fingerprint", { input_fingerprint: "" }],
    ["a missing source fingerprint", { source_fingerprint: "" }],
    ["a stale record", { recorded_at: "2026-08-01T00:00:00.000Z" }],
    ["an eligible row carrying a code", { eligible: true, blocker_code: "target_roas_missing" }],
    ["an ineligible row with no code", { eligible: false, blocker_code: null }],
    ["a foreign account", { provider_account_id: "act_OTHER" }],
    ["a foreign business", { business_id: "other" }],
  ])("%s prevents profile READY", async (_label, over) => {
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, profile: [validProfileRow(over)] }),
      scope({
        expectedProfileInputFingerprint: "a".repeat(64),
        expectedProfileSourceFingerprint: "b".repeat(64),
      }),
    );
    const profile = dim(m, "profile_output_retention");
    expect(profile.status, JSON.stringify(over)).not.toBe("ready");
    expect(profile.coverage?.qualifying).toBe(0);
  });
});

describe("D086 C1 — the read model's own honesty rules", () => {
  it("no capture schema at all reports forward-only on every dimension", async () => {
    const m = await readBudgetReadiness(route({}), scope());
    expect(m.contract).toBe(BUDGET_READINESS_CONTRACT);
    expect(m.compiledResolverVersion).toBe(CAMPAIGN_CONTEXT_RESOLVER_VERSION);
    for (const d of m.dimensions) {
      expect(d.status, d.key).toBe("forward_only_after_deploy");
      expect(d.preconditions.length, d.key).toBeGreaterThan(0);
    }
    expect(m.blockers).toEqual([
      "automatic_role_authority_absent",
      "canonical_profile_output_not_retained",
      "currency_exponent_not_captured",
    ]);
  });

  it("a failed measurement is UNKNOWN, never ready and never an empty default", async () => {
    const m = await readBudgetReadiness(fakeDb(() => new Error("connection reset")), scope());
    for (const d of m.dimensions) {
      expect(d.status, d.key).toBe("unknown");
      expect(d.evidence).toMatch(/measurement_failed/);
      expect(d.blocker).toBe("readiness_measurement_unavailable");
      expect(d.coverage).toBeNull();
    }
    expect(m.dimensions.some((d) => d.status === "ready")).toBe(false);
  });

  it("returns nothing executable: no token, no mutation, no approval field", async () => {
    const m = await readBudgetReadiness(route({}), scope());
    const text = JSON.stringify(m).toLowerCase();
    for (const forbidden of ["token", "approve", "execute", "apply", "mutation", "endpoint"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Correction 2 — the query contract, latest-per-identity, and truncation
// ---------------------------------------------------------------------------

describe("D086 C2 #4 — the budget query is valid SQL", () => {
  it("the EXECUTED budget query is one parseable statement, not a set operation", () => {
    /*
      C8: `D086_BUDGET_LATEST_SQL` is gone — it read transition-only config
      history that readiness no longer consumes, and certifying its shape was
      certifying a statement nothing executed. The rule it encoded still holds
      for the query that DOES run: no bare ORDER BY / LIMIT inside an operand.
    */
    expect(D086_STATE_BUDGET_SQL).not.toMatch(/ORDER\s+BY[^()]*LIMIT\s+\$\d+\s+UNION/i);
    expect(D086_STATE_BUDGET_SQL).toMatch(/WITH scoped AS \(/);
    expect(D086_STATE_BUDGET_SQL).toMatch(/ranked AS \(/);
    expect(D086_STATE_BUDGET_SQL).toMatch(/latest AS \(/);
  });

  it("#6 the profile and role truth tuples carry their scope columns", () => {
    /*
      r4's tuples omitted scope columns, so two rows with identical clocks and
      different scopes coalesced as one truth and the heap chose which to
      believe. The STATE tuple is asserted in the C8 block against the query
      that actually runs.
    */
    expect(D086_PROFILE_LATEST_SQL).toMatch(/count\(DISTINCT \(contract, profile_contract, business_id, provider_account_id,/);
    expect(D086_ROLE_LATEST_SQL).toMatch(/count\(DISTINCT \(contract, business_id, provider_account_id,/);
  });

  it("#8 the legacy branch counts its population atomically and admits truncation", async () => {
    /*
      r4 published `rows.length` — a 500-row LIMIT — as the whole population with
      `truncated: false`. TheSwaf has 758 legacy rows in the pinned census, so the
      production-facing branch would have shown 500 as the total.
    */
    const legacyRows = Array.from({ length: 500 }, (_, i) => ({
      provider_account_id: null, resolver_version: "campaign-context-resolver.v1-shadow-2026-07-06",
      confidence_class: "high", kind_source: "system_inferred", as_of_date: "2026-08-22",
      population_total: 758,
    }));
    const m = await readBudgetReadiness(
      route({ capability: { ...fullCapability, role_columns: 0 }, legacy: legacyRows }),
      scope(),
    );
    const role = dim(m, "role_authority_retention");
    expect(role.coverage?.population).toBe(758);
    expect(role.coverage?.examined).toBe(500);
    expect(role.coverage?.truncated).toBe(true);
    expect(role.source).toMatch(/BUSINESS-level legacy migration evidence, not account authority/);
    expect(role.status).not.toBe("ready");
  });

  it("ranks by CLOCK and exposes ties, rather than picking one by heap order", () => {
    /*
      r3 used `DISTINCT ON` with an incomplete ORDER BY, so which row won was
      decided by insertion order. `rank()` keeps every row tied at the top clock
      so a disagreement is visible instead of adjudicated.
    */
    for (const sql of [D086_PROFILE_LATEST_SQL, D086_ROLE_LATEST_SQL]) {
      expect(sql).not.toContain("DISTINCT ON");
      expect(sql).toMatch(/rank\(\) OVER \(PARTITION BY/);
      expect(sql).toContain("clock_rank = 1");
      expect(sql).toContain("distinct_truths");
      expect(sql).toContain("population_total");
    }
  });

  it("#8 sample and total come from ONE statement", () => {
    // r3 read them separately, so a concurrent change could combine snapshots.
    for (const sql of [D086_PROFILE_LATEST_SQL, D086_ROLE_LATEST_SQL]) {
      expect(sql).toMatch(/\(SELECT count\(\*\) FROM per_identity\) AS population_total/);
    }
    const mod = readFileSync(d086TrustedPath("lib/meta/budget-readiness-read-model.ts"), "utf8");
    expect(mod).not.toContain("POPULATION_SQL");
  });

  it("selects the STORED unit provenance rather than re-deriving it", () => {
    // C8: from the state-history read, which is the one that runs.
    for (const column of [
      "budget_currency", "budget_currency_exponent",
      "budget_currency_registry_version", "budget_shape_support",
    ]) {
      expect(D086_STATE_BUDGET_SQL, column).toContain(column);
    }
  });

  it("every query is account-scoped by parameter, never by interpolation", () => {
    for (const sql of [D086_STATE_BUDGET_SQL, D086_COMPLETE_RUN_SQL,
      D086_PROFILE_LATEST_SQL, D086_ROLE_LATEST_SQL]) {
      expect(sql).toContain("business_id = $1");
      expect(sql).toContain("provider_account_id = $2");
      expect(sql).not.toMatch(/\$\{/);
    }
  });

  it("a read failure becomes a STABLE code, never raw driver text", () => {
    expect(sanitiseReadFailure(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" })))
      .toBe("db_error_econnrefused");
    expect(sanitiseReadFailure(new Error("password authentication failed for user \"x\""))).
      toBe("db_error_unavailable");
    expect(sanitiseReadFailure("postgres://user:secret@host/db")).toBe("db_error_unavailable");
  });
});

describe("D086 C2 #7/#8 — latest governs, and truncation is never READY", () => {
  it("a stale superseded row does not poison the fresh latest row", async () => {
    /*
      The query returns the latest per identity, so an aged predecessor is not in
      the result at all. This asserts the CONSUMER honours that: one latest row
      per entity, judged on its own.
    */
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, runs: manifest(["23851"], []), budget: [validBudgetRow({ population_total: 1 })] }),
      scope(),
    );
    expect(dim(m, "budget_fact_retention").status).toBe("ready");
  });

  it("a BAD latest row is not rescued by a good older one", async () => {
    // Only the latest reaches the consumer; if it is bad, the dimension is not ready.
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851"], []),
        budget: [validBudgetRow({ budget_currency_exponent: null, population_total: 1 })],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    // C3 #9: rows exist and fail validation — an observed invalid state.
    expect(budget.status).toBe("unavailable");
    // The blocker is D083's own, because D083 is the authority now.
    expect(budget.evidence).toMatch(/currency_exponent_not_captured/);
  });

  it("a population LARGER than the sample can never be READY", async () => {
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, runs: manifest(["23851"], ["as1"]), budget: [validBudgetRow({ population_total: 5000 })] }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.coverage).toMatchObject({ qualifying: 1, examined: 1, population: 5000, conflicts: 0, truncated: true });
    expect(budget.status).toBe("partial");
    // Structured, not prose: r3 buried truncation in an English sentence.
    expect(budget.coverage?.truncated).toBe(true);
  });

  it("the role dimension applies the same truncation rule", async () => {
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, role: [validRoleRow({ population_total: 9000 })] }),
      scope({ approvedResolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION }),
    );
    const role = dim(m, "role_authority_retention");
    expect(role.coverage?.population).toBe(9000);
    expect(role.status).toBe("partial");
  });
});

describe("D086 C2 #1 — profile identity agreement is required", () => {
  it("without external fingerprints the dimension is NOT ready, with a stable code", async () => {
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        profile: [
          validProfileRow({ action: "cut", population_total: 3 }),
          validProfileRow({ action: "scale", blocker_code: "target_roas_missing", population_total: 3 }),
          validProfileRow({ action: "refresh", eligible: true, blocker_code: null, population_total: 3 }),
        ],
      }),
      scope(),
    );
    const profile = dim(m, "profile_output_retention");
    expect(profile.status).not.toBe("ready");
    expect(profile.evidence).toMatch(/profile_identity_agreement_unavailable/);
  });

  it("WITH matching external fingerprints all three actions become ready", async () => {
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        profile: [
          validProfileRow({ action: "cut", population_total: 3 }),
          validProfileRow({ action: "scale", blocker_code: "target_roas_missing", population_total: 3 }),
          validProfileRow({ action: "refresh", eligible: true, blocker_code: null, population_total: 3 }),
        ],
      }),
      scope({
        expectedProfileInputFingerprint: "a".repeat(64),
        expectedProfileSourceFingerprint: "b".repeat(64),
      }),
    );
    expect(dim(m, "profile_output_retention").status).toBe("ready");
  });

  it("a DRIFTED source fingerprint is refused even when the input agrees", async () => {
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, profile: [validProfileRow()] }),
      scope({
        expectedProfileInputFingerprint: "a".repeat(64),
        expectedProfileSourceFingerprint: "9".repeat(64),
      }),
    );
    const profile = dim(m, "profile_output_retention");
    expect(profile.status).not.toBe("ready");
    expect(profile.evidence).toMatch(/source_mismatch/);
  });
});

// ---------------------------------------------------------------------------
// Correction 3 — real PostgreSQL, totals, universe, honest status
// ---------------------------------------------------------------------------

describe("D086 C3 #5/#6 — the DDL and every query against a REAL PostgreSQL 16", () => {
  it(
    "applies all prepared DDL and executes every query against a real cluster",
    { timeout: 300_000 },
    async () => {
      /*
        The DDL/parse/index proof. The CASE-BY-CASE outcomes are asserted by name
        in the Correction 6 block below, which is where a shape change would
        actually be caught.
      */
      const report = await runD086PostgresSeam();
      expect(report.serverVersion).toMatch(/PostgreSQL 16/);
      /*
        C7: the schema is no longer applied by a hand-written DDL list — the
        REAL migration registry builds it, so the proof that the D086 statements
        parse and are reachable is that the receipt table, the tombstone table
        and every required index exist in that cluster's catalog.
      */
      expect(report.capabilityProbe.partition_columns)
        .toBe(String(D086_REQUIRED_PARTITION_COLUMNS.length));
      expect(report.capabilityProbe.raw_observation_columns)
        .toBe(String(D086_REQUIRED_RAW_OBSERVATION_COLUMNS.length));
      expect(report.capabilityProbe.receipt_columns)
        .toBe(String(D086_REQUIRED_RECEIPT_COLUMNS.length));
      expect(report.capabilityProbe.run_columns)
        .toBe(String(D086_REQUIRED_RUN_COLUMNS.length));
      expect(report.capabilityProbe.state_columns)
        .toBe(String(D086_REQUIRED_STATE_COLUMNS.length));
      expect(report.capabilityProbe.tombstone_columns)
        .toBe(String(D086_REQUIRED_TOMBSTONE_COLUMNS.length));
      // Reversed insertion order, same answer.
      const forward = report.populatedReads.find(
        (r) => r.name === "true_tie_forward_insertion");
      const reversed = report.populatedReads.find(
        (r) => r.name === "true_tie_reversed_insertion");
      expect(forward).toBeDefined();
      expect(reversed).toBeDefined();
      expect(reversed!.status).toBe(forward!.status);
      expect(reversed!.blocker).toBe(forward!.blocker);
      // C8: a GENUINE same-clock tie, so the shared verdict is the conflict.
      expect(forward!.blocker).toBe("budget_universe_manifest_conflict");
      // Each case records HOW it was produced, not only what it produced.
      for (const read of report.populatedReads) {
        expect(read.mechanics.length, read.name).toBeGreaterThan(20);
      }
      expect(report.ok).toBe(true);
    },
  );

  it("#D current query columns are provided by the registered and prepared schema", () => {
    /*
      The mechanical parity check. A selected column that no ALTER or CREATE
      provides is exactly how r3 shipped a query that could never run.
    */
    const ddl = D086_ADDITIVE_MIGRATION_SQL.join("\n") + readFileSync(d086TrustedPath("lib/migrations.ts"), "utf8");
    const missing: string[] = [];
    for (const column of [
      ...D086_REQUIRED_STATE_COLUMNS,
      ...D086_REQUIRED_RECEIPT_COLUMNS,
      ...D086_REQUIRED_RUN_COLUMNS,
      ...D086_REQUIRED_PROFILE_COLUMNS,
      ...D086_REQUIRED_ROLE_COLUMNS,
    ]) {
      // Base columns the ALTERs extend are provided by the existing tables.
      if (["business_id", "provider_account_id", "campaign_id", "as_of_date", "action"].includes(column)) continue;
      if (!new RegExp(`\\b${column}\\b`).test(ddl)) missing.push(column);
    }
    expect(missing, "selected columns with no prepared DDL").toEqual([]);
    // ...and specifically the one r3 omitted.
    expect(ddl).toContain("profile_contract");
  });
});

describe("D086 C3 #7 — the total is a fail-closed count contract", () => {
  it.each([
    ["garbage", "garbage"],
    ["a negative", -1],
    ["a fraction", 0.5],
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["an object", {}],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
  ])("%s is not a population", (_l, value) => {
    // r3 used `Number(value)`, so "garbage", -1 and 0 all produced READY and -1
    // was even published as the population.
    expect(parsePopulationTotal(value)).toBeNull();
  });

  it.each([[0, 0], [7, 7], ["7", 7], [BigInt(9), 9]])("%s parses to %s", (input, expected) => {
    expect(parsePopulationTotal(input)).toBe(expected);
  });

  it("an unmeasurable or inconsistent total can never be READY", async () => {
    for (const total of ["garbage", -1, 0, null, 0.5]) {
      const m = await readBudgetReadiness(
        route({ capability: fullCapability, budget: [validBudgetRow({ population_total: total })] }),
        scope(),
      );
      const budget = dim(m, "budget_fact_retention");
      expect(budget.status, JSON.stringify(total)).not.toBe("ready");
      // The published population is honest about being unmeasurable.
      if (total !== 0) expect(budget.coverage?.population, JSON.stringify(total)).toBeNull();
    }
  });

  it("a total SMALLER than what was examined is measurement-unknown", () => {
    expect(coverageStatus({ qualifying: 2, examined: 2, population: 1, conflicts: 0 })).toBe("unknown");
  });
});

describe("D086 C3 #9 — existing invalid rows are not 'waiting for deploy'", () => {
  it("rows that exist and all fail are UNAVAILABLE, not forward-only", () => {
    expect(coverageStatus({ qualifying: 0, examined: 3, population: 3, conflicts: 0 })).toBe("unavailable");
  });

  it("no rows at all IS forward-only", () => {
    expect(coverageStatus({ qualifying: 0, examined: 0, population: 0, conflicts: 0 })).toBe("forward_only_after_deploy");
  });

  it("a conflict is PARTIAL, never ready and never forward-only", () => {
    expect(coverageStatus({ qualifying: 3, examined: 3, population: 3, conflicts: 1 })).toBe("partial");
  });
});

describe("D086 C3 #11 — the denominator is an honest universe", () => {
  it("a proven non-owner row neither qualifies nor poisons", async () => {
    /*
      A CBO campaign's ad-set holds no budget: it is correctly not an owner, so
      it must leave both sides of the ratio rather than permanently forcing
      partial.
    */
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851"], ["as1"]),
        budget: [
          cboCampaign({ population_total: 2 }),
          deferringAdset({ population_total: 2 }),
        ],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.coverage?.universe).toMatchObject({
      retainedRows: 2, applicable: 1, provenNonApplicable: 1, ownerUnknown: 0, uncoveredApplicable: 0,
    });
    expect(budget.status).toBe("ready");
  });

  it("an ABO account: the campaign row is the proven non-owner", async () => {
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851"], ["as1"]),
        budget: [
          aboCampaign({ population_total: 2 }),
          owningAdset({ population_total: 2 }),
        ],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.coverage?.universe).toMatchObject({
      retainedRows: 2, applicable: 1, provenNonApplicable: 1, ownerUnknown: 0, uncoveredApplicable: 0,
    });
    expect(budget.status).toBe("ready");
  });

  it("#2 an ABO campaign whose ad-set owner is MISSING is never READY", async () => {
    /*
      The exact r4 false-READY fixture: a campaign declaring `adset_budget` with
      no retained ad-set owner. r4 called it proven non-applicable, dropped it
      from the denominator, and reported READY on the one row that remained.
    */
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851", "c2"], []),
        budget: [
          validBudgetRow({ entity_id: "cbo", population_total: 2 }),
          aboCampaign({ entity_id: "abo_missing_adset", population_total: 2 }),
        ],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.status).not.toBe("ready");
    expect(budget.blocker).not.toBeNull();
    expect(budget.coverage?.universe).toMatchObject({
      retainedRows: 2, applicable: 1, provenNonApplicable: 0, ownerUnknown: 0, uncoveredApplicable: 1,
    });
    expect(budget.evidence).toMatch(/budget_owner_universe_unproven/);
  });

  it("an UNCAPTURED owner never disappears from the denominator", async () => {
    for (const mode of ["unknown", "mixed", null]) {
      const m = await readBudgetReadiness(
        route({
          capability: fullCapability,
          runs: manifest(["23851", "c2"], []),
          budget: [
            validBudgetRow({ population_total: 2 }),
            unknownOwner({ entity_id: "c2", budget_origin: mode, population_total: 2 }),
          ],
        }),
        scope(),
      );
      const budget = dim(m, "budget_fact_retention");
      expect(budget.coverage?.universe?.ownerUnknown, String(mode)).toBe(1);
      expect(budget.status, String(mode)).toBe("partial");
    }
  });

  it("never filters down to the rows that already look good", async () => {
    // One applicable row failing validation is still counted against readiness.
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851", "c2"], []),
        budget: [
          validBudgetRow({ population_total: 2 }),
          validBudgetRow({ entity_id: "c2", budget_currency_exponent: null, population_total: 2 }),
        ],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.coverage?.universe?.applicable).toBe(2);
    expect(budget.coverage?.qualifying).toBe(1);
    expect(budget.status).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// Correction 5 — the complete-run universe, through the production read model
// ---------------------------------------------------------------------------

describe("D086 C5 — readiness rests on an attested complete run, not on row presence", () => {
  const owner = (over: Row = {}) => cboCampaign(over);
  const child = (over: Row = {}) => deferringAdset(over);

  it("#1 the MUTUAL ownership contradiction is never READY", async () => {
    /*
      r5's concrete false READY: a campaign deferring to its ad-sets and an
      ad-set deferring back to that campaign were counted as TWO proven
      non-owners, leaving one unrelated row as the entire applicable population.
      Neither points at itself, so neither is proven to be a non-owner.
    */
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["cbo_ok", "abo_points_to_adset"], ["as_points_back"]),
        budget: [
          owner({ entity_id: "cbo_ok", population_total: 3 }),
          aboCampaign({ entity_id: "abo_points_to_adset", population_total: 3 }),
          deferringAdset({ entity_id: "as_points_back", campaign_id: "abo_points_to_adset", population_total: 3 }),
        ],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.status).not.toBe("ready");
    expect(budget.blocker).toBe("budget_owner_hierarchy_contradiction");
    expect(budget.coverage?.universe?.hierarchyContradictions).toBeGreaterThan(0);
    expect(budget.coverage?.universe?.provenNonApplicable).toBe(0);
  });

  it("#2 a complement from a DIFFERENT source run is never READY", async () => {
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851"], ["as1"]),
        budget: [
          owner({ population_total: 2 }),
          child({ run_id: "99999999-9999-4999-8999-999999999999", population_total: 2 }),
        ],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.status).not.toBe("ready");
    expect(budget.blocker).toBe("budget_owner_run_incoherent");
  });

  it("#3 conflicting non-null snapshot identities are never READY", async () => {
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851", "c2"], []),
        budget: [
          owner({ entity_id: "c1", source_snapshot_id: "44444444-4444-4444-8444-444444444444", population_total: 2 }),
          owner({ entity_id: "c2", source_snapshot_id: "55555555-5555-4555-8555-555555555555", population_total: 2 }),
        ],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.status).not.toBe("ready");
    expect(budget.blocker).toBe("budget_owner_snapshot_incoherent");
  });

  it("#4 a RAW total smaller than the retained rows is UNKNOWN, never clamped", async () => {
    /*
      r5's `Math.max(0, total - provenNonApplicable)` clamped away the proof that
      the measured total was smaller than what was retained, producing a
      substantive `unavailable` verdict from a measurement failure.
    */
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851"], ["as1"]),
        budget: [owner({ population_total: 1 }), child({ population_total: 1 })],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.status).toBe("unknown");
    expect(budget.blocker).toBe("budget_population_inconsistent");
    expect(budget.coverage?.universe?.retainedRows).toBe(2);
    expect(budget.coverage?.population).toBe(1);
  });

  it("#5 a coherent, complete, attested CBO run IS ready", async () => {
    // READY must stay reachable — the fix is not "never ready again".
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851"], ["as1"]),
        budget: [owner({ population_total: 2 }), child({ population_total: 2 })],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.status).toBe("ready");
    expect(budget.blocker).toBeNull();
    expect(budget.coverage?.universe?.completeRunAttested).toBe(true);
    expect(budget.coverage?.universe).toMatchObject({
      applicable: 1, provenNonApplicable: 1, uncoveredApplicable: 0, hierarchyContradictions: 0,
    });
  });

  it("#6 a coherent, complete, attested ABO run IS ready when every child owns", async () => {
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851"], ["as1", "as2"]),
        budget: [
          aboCampaign({ population_total: 3 }),
          owningAdset({ entity_id: "as1", population_total: 3 }),
          owningAdset({ entity_id: "as2", population_total: 3 }),
        ],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.status).toBe("ready");
    expect(budget.coverage?.universe).toMatchObject({ applicable: 2, provenNonApplicable: 1 });
  });

  it("#6b an ABO campaign with ONE owning child and one deferring child is not READY", async () => {
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851"], ["as1", "as2"]),
        budget: [
          aboCampaign({ population_total: 3 }),
          owningAdset({ entity_id: "as1", population_total: 3 }),
          deferringAdset({ entity_id: "as2", population_total: 3 }),
        ],
      }),
      scope(),
    );
    expect(dim(m, "budget_fact_retention").status).not.toBe("ready");
    expect(dim(m, "budget_fact_retention").blocker).toBe("budget_owner_hierarchy_contradiction");
  });

  it.each([
    /*
      C7: the causes are named separately now. r7 filtered a wrong-endpoint, a
      partial and a failed capture out of its selection and reported all three
      as "no run", so an operator could not tell an absent sync from a broken
      one, and an older complete run silently won over a newer failure.
    */
    ["a missing capture", [] as Row[], /no_campaign_capture|no_adset_capture/],
    ["a failed capture", manifest(["23851"], ["as1"], { capture_status: "failed" }),
      /campaign_capture_failed/],
    ["a partial capture", manifest(["23851"], ["as1"], { capture_status: "partial" }),
      /campaign_capture_partial/],
    ["a point-lookup capture", manifest(["23851"], ["as1"], { capture_status: "point_lookup" }),
      /campaign_capture_not_full_scan/],
    ["a run the receipt names but that is unreadable",
      manifest(["23851"], ["as1"], { run_endpoint: null }), /campaign_run_unreadable/],
    ["a receipt and run that disagree about the endpoint",
      manifest(["23851"], ["as1"], { run_endpoint: "ad_configs" }),
      /receipt_run_endpoint_disagreement/],
    ["a failed run under a complete receipt",
      manifest(["23851"], ["as1"], { run_succeeded: false }), /campaign_run_failed/],
    ["an incomplete run", manifest(["23851"], ["as1"], { completeness: "partial" }), /run_incomplete/],
    ["a non-UUID run identity", manifest(["23851"], ["as1"], { run_id: "run_2026-09-01" }), /run_identity/],
  ])("#7 %s is never READY", async (_l, runs, expected) => {
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, runs, budget: [owner({ population_total: 2 }), child({ population_total: 2 })] }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.status).not.toBe("ready");
    expect(String(budget.blocker)).toMatch(expected);
  });

  it("#8 an expected/observed entity count mismatch is never READY", async () => {
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        // The manifest enumerated five campaigns; only one was retained.
        runs: manifest(["23851", "c2", "c3", "c4", "c5"], ["as1"]),
        budget: [owner({ population_total: 2 }), child({ population_total: 2 })],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.status).not.toBe("ready");
    expect(budget.blocker).toBe("budget_universe_count_mismatch");
    expect(budget.coverage?.universe).toMatchObject({
      expectedCampaigns: 5, observedCampaigns: 1, expectedAdsets: 1, observedAdsets: 1,
    });
  });

  it("#9 an uncaptured owner mode is never READY even under a good manifest", async () => {
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851", "c2"], []),
        budget: [
          owner({ entity_id: "c1", population_total: 2 }),
          unknownOwner({ entity_id: "c2", budget_origin: "mixed", population_total: 2 }),
        ],
      }),
      scope(),
    );
    expect(dim(m, "budget_fact_retention").status).not.toBe("ready");
    expect(dim(m, "budget_fact_retention").coverage?.universe?.ownerUnknown).toBe(1);
  });

  it("#10 the artifact carries neither stale sentence and cannot self-contradict", () => {
    const a = published();
    /*
      The LIVE claims are the limitations. A rejected-revision `why` legitimately
      QUOTES the defect it condemns — including the phrase "DISTINCT ON" — and a
      whole-document scan would fire on that history, the prose-versus-linkage
      trap this programme has already corrected three times.
    */
    const live = JSON.stringify({
      limitations: a.limitations,
      localPostgresVerification: a.localPostgresVerification,
      preparedMigrations: a.preparedMigrations,
      sideEffectLedger: a.sideEffectLedger,
      closures: a.closures,
      residualBlockers: a.residualBlockers,
    });
    expect(live).not.toContain("The readiness layer does not call the currency registry");
    expect(live).not.toContain("have never been executed against any database");
    expect(live).not.toContain("No SQL in this slice has been executed against any database");
    expect(live).not.toContain("DISTINCT ON");
    // ...and the historical record DOES still name what it rejected.
    expect(JSON.stringify(a.rejectedRevisions)).toContain("DISTINCT ON");

    // The SQL scope is stated once, consistently, in both places that mention it.
    expect(a.localPostgresVerification.productionStatementsExecuted).toBe(0);
    expect(a.localPostgresVerification.preparedStatementsApplied).toBeGreaterThan(0);
    expect(a.sideEffectLedger.scope).toMatch(/artifact assembly and production/);
    expect(a.sideEffectLedger.ddlStatementsExecuted).toBe(0);
    // ...and no limitation may claim nothing ever ran while the section says it did.
    const limitations = JSON.stringify(a.limitations);
    expect(limitations).toMatch(/ephemeral PostgreSQL|ephemeral local seam/);
    expect(limitations).not.toMatch(/never been executed|no SQL in this slice/i);
  });
});

// ---------------------------------------------------------------------------
// Correction 6 — the seam's exact cases, bound by name/status/blocker
// ---------------------------------------------------------------------------

describe("D086 C6 — the PostgreSQL matrix is asserted by NAME, not by count", () => {
  it("every required case ran with its exact status and blocker", { timeout: 300_000 }, async () => {
    /*
      r6 asserted `populatedReads.length === 10`, which cannot distinguish a
      passing matrix from a differently-shaped one, and named none of the C5
      cases. Each case is bound here to the outcome it must produce.
    */
    const report = await runD086PostgresSeam();
    expect(report.serverVersion).toMatch(/PostgreSQL 16/);
    for (const expected of REQUIRED_SEAM_CASES) {
      const actual = report.populatedReads.find((r) => r.name === expected.name);
      expect(actual, `${expected.name} did not run`).toBeDefined();
      expect(actual!.status, expected.name).toBe(expected.status);
      expect(actual!.blocker ?? null, expected.name).toBe(expected.blocker);
    }
    // READY must still be reachable for a coherent CBO and a coherent ABO.
    expect(report.populatedReads.filter((r) => r.status === "ready").length).toBeGreaterThanOrEqual(2);
    // The catalog gate covers the new manifest/cohort selection path.
    /*
      ── ROUND 19, ITEM C8 ──────────────────────────────────────────────────
      SEVEN, not six. Round 15 renamed the three receipt indexes (occurrence ->
      attempt-scoped, freshness/cohort -> _v2) and Round 17 added the delta
      membership access path. Pinned by exact name so a future rename fails
      here rather than silently in a readiness gate.
    */
    expect(report.indexes).toHaveLength(D086_REQUIRED_INDEXES.length);
    expect([...report.indexes].map((i) => i.name).sort()).toEqual(
      [
        "idx_meta_entity_observation_receipts_cohort_v2",
        "idx_meta_entity_observation_receipts_freshness_v2",
        "idx_meta_entity_observation_runs_d086_payload",
        "idx_meta_entity_state_history_d086_latest",
        "idx_meta_entity_state_history_manifest_delta",
        "idx_meta_entity_tombstones_d086_latest",
        "meta_entity_observation_receipts_attempt_occurrence",
        "meta_entity_observation_receipts_occurrence",
      ].sort(),
    );
    for (const index of report.indexes) {
      expect(index.carriesFullRank, `${index.name}: ${index.definition}`).toBe(true);
    }
    expect(report.ok).toBe(true);
  });

  it("the pinned evidence document matches what the seam produced", () => {
    const pinnedEvidence = pinned("d086_r15_postgres_evidence");
    expect(pinnedEvidence.path).toBe(
      "docs/audits/generated/d086-local-postgres-evidence-2026-09-02.r5.json",
    );
    const bytes = d086TrustedReader(pinnedEvidence.path);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(pinnedEvidence.sha256);
    const evidence = JSON.parse(bytes.toString("utf8")) as {
      ok: boolean; cases: Array<{ name: string; status: string; blocker: string | null }>;
      indexCatalog: Array<{
        indexname: string;
        indisvalid: boolean;
        indisready: boolean;
        indislive: boolean;
      }>;
    };
    expect(evidence.ok).toBe(true);
    expect(evidence.indexCatalog).toHaveLength(D086_REQUIRED_INDEXES.length);
    expect(evidence.indexCatalog).toHaveLength(D086_REQUIRED_INDEXES.length);
    expect(evidence.indexCatalog.map((row) => row.indexname).sort()).toEqual(
      D086_REQUIRED_INDEXES.map((index) => index.indexName).sort(),
    );
    for (const row of evidence.indexCatalog) {
      expect(row.indisvalid, row.indexname).toBe(true);
      expect(row.indisready, row.indexname).toBe(true);
      expect(row.indislive, row.indexname).toBe(true);
    }
    for (const expected of REQUIRED_SEAM_CASES) {
      const actual = evidence.cases.find((c) => c.name === expected.name);
      expect(actual, expected.name).toBeDefined();
      expect(actual!.status, expected.name).toBe(expected.status);
      expect(actual!.blocker, expected.name).toBe(expected.blocker);
    }
  });

  it("the artifact BINDS its PostgreSQL claims to that evidence", () => {
    const a = published();
    const v = a.localPostgresVerification;
    /*
      ROUND 25: r13 binds to r4, whose catalogue is the current seven-index set
      with pg_index validity flags. r3 stays pinned as frozen history -- it is
      named by the D077 manifest -- and the artifact records it as superseded
      rather than dropping it.
    */
    expect(v.evidenceSha256).toBe(pinned("d086_r15_postgres_evidence").sha256);
    expect(v.evidencePath).toContain("d086-local-postgres-evidence-2026-09-02.r5.json");
    expect(v.supersedes.sha256).toBe(pinned("d086_r13_postgres_evidence").sha256);
    expect(v.casesExercised).toBe(REQUIRED_SEAM_CASES.length);
    expect(v.requiredIndexes).toBe(D086_REQUIRED_INDEXES.length);
    expect(v.requiredIndexes).toBe(8);
    expect(v.seamOk).toBe(true);
    expect(v.productionStatementsExecuted).toBe(0);
    // ...and the r6 limitation that denied owning a census is gone.
    expect(JSON.stringify(a.limitations))
      .not.toContain("does not possess an independent account/entity ownership census");
    expect(JSON.stringify(a.limitations)).toMatch(/canonical observation manifest/);
  });

  it("the verifier FAILS when the pinned evidence drifts", () => {
    const pinnedEvidence = pinned("d086_r15_postgres_evidence");
    const evidence = JSON.parse(d086TrustedReader(pinnedEvidence.path).toString("utf8")) as {
      indexCatalog: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    const firstIndexName = String(evidence.indexCatalog[0]?.indexname);
    evidence.indexCatalog[0] = { ...evidence.indexCatalog[0], indisvalid: false };
    const tampered = (path: string): Buffer =>
      path === pinnedEvidence.path
        ? Buffer.from(`${JSON.stringify(evidence)}\n`, "utf8")
        : d086TrustedReader(path);
    const result = verifyD086Artifact(published(), tampered);
    expect(result.ok).toBe(false);
    expect(result.checked).toContain("localEvidence");
    expect(result.failures).toContain(
      `localEvidence: ${firstIndexName} reports indisvalid=false; the index is not usable and existence alone never proved it was`,
    );
  });
});

// ---------------------------------------------------------------------------
// Correction 8 — the receipt/state proof must be real, PIT-correct and
// self-consistent. Each case below reproduces one independently verified defect
// in r8 before it is fixed.
// ---------------------------------------------------------------------------

describe("D086 C8 — population is the CURRENT identity count, not row history", () => {
  it("#2 counts latest-per-identity, so an ordinary changed capture stays READY", async () => {
    /*
      r8 computed `count(*) OVER ()` in the `ranked` CTE — BEFORE `clock_rank = 1`
      — so the population was every historical state row. One ordinary changed
      capture made population 2 against 1 retained identity, `population_total`
      exceeded the retained rows, and the account became permanently `partial`
      through a measurement that was never about measurement.
    */
    const older = validBudgetRow({
      id: "state-0", observed_at: "2026-08-30T03:00:00.000Z",
      captured_at: "2026-08-30T03:00:00.000Z", created_at: "2026-08-30T03:00:05.000Z",
      observed_on: "2026-08-30", campaign_daily_budget_raw: "100000",
    });
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851"], []),
        // The read model receives only the LATEST row per identity; the
        // population travels with it and must describe identities, not rows.
        budget: [validBudgetRow({ population_total: 1 })],
      }),
      scope(),
    );
    void older;
    const budget = dim(m, "budget_fact_retention");
    expect(budget.status).toBe("ready");
    expect(budget.coverage?.population).toBe(1);
  });

  it("#2 the SQL takes the population AFTER latest-per-identity, in one statement", () => {
    // Comments are stripped so the assertion is about the STATEMENT, never
    // about prose that happens to mention the thing it warns against.
    const sql = stripSqlComments(D086_STATE_BUDGET_SQL);
    expect(sql).toMatch(/latest AS \(\s*SELECT \* FROM ranked WHERE clock_rank = 1/);
    expect(sql).toMatch(/count\(\*\) OVER \(\) AS population_total FROM latest/);
    // ...and never over the unfiltered rank set.
    expect(sql.slice(sql.indexOf("ranked AS ("), sql.indexOf("latest AS (")))
      .not.toContain("population_total");
    // The current inventory only: an entity whose latest word is an absence is
    // not a denominator.
    expect(sql).toContain("clock_rank = 1 AND presence = 'present'");
  });
});

describe("D086 C8 — the same-clock conflict tuple covers every authority fact", () => {
  it("#8 includes the unit, registry, shape, schedule, provider and run facts", () => {
    const tuple = D086_STATE_BUDGET_SQL.slice(
      D086_STATE_BUDGET_SQL.indexOf("count(DISTINCT ("),
      D086_STATE_BUDGET_SQL.indexOf("AS distinct_truths"),
    );
    for (const field of [
      "budget_origin", "budget_currency", "budget_currency_exponent",
      "budget_currency_registry_version", "budget_shape_support",
      "campaign_start_time", "campaign_end_time", "adset_start_time", "adset_end_time",
      "provider_api_version", "run_id", "source_snapshot_id", "state_hash",
      "campaign_daily_budget_raw", "campaign_lifetime_budget_raw",
      "adset_daily_budget_raw", "adset_lifetime_budget_raw",
      "configured_status", "effective_status", "presence", "campaign_id",
    ]) {
      expect(tuple, field).toContain(field);
    }
    // Physical identity and the tie-break clock are deliberately NOT in it:
    // every row differs on those, so including them would make every clock a
    // conflict and the rule would never fire.
    expect(tuple).not.toMatch(/\bcreated_at\b/);
    expect(tuple).not.toMatch(/\(id,|, id[,)]/);
  });
});

describe("D086 C8 — a historical read cannot be erased by a later heartbeat", () => {
  it("#9 the run join uses IMMUTABLE payload clocks, never the heartbeat", () => {
    const stripped = stripSqlComments(D086_COMPLETE_RUN_SQL);
    const join = stripped.slice(
      stripped.indexOf("LEFT JOIN meta_entity_observation_runs run"),
      stripped.indexOf("), members AS ("),
    );
    // The mutable heartbeat columns must not gate readability at the cutoff.
    expect(join).not.toContain("last_captured_at");
    expect(join).not.toContain("last_seen_at");
    expect(join).toMatch(/run\.captured_at\s*<=\s*\$3/);
    expect(join).toMatch(/run\.observed_at\s*<=\s*\$3/);
  });
});

describe("D086 C8 — a receipt attests only with a real partition and snapshot", () => {
  const withLinkage = (over: Row = {}) => manifest(["23851"], [], over);

  it.each([
    ["a partition that does not exist", { partition_present: false },
      /partition_absent/],
    ["a partition belonging to another account", { partition_scope_ok: false },
      /partition_scope_mismatch/],
    ["a partition outside the core lane", { partition_lane_ok: false },
      /partition_lane_mismatch/],
    ["no linked raw snapshot", { snapshot_present: false }, /snapshot_absent/],
    ["a snapshot recorded under a different partition", { snapshot_partition_ok: false },
      /snapshot_partition_mismatch/],
    ["a snapshot recorded for a different endpoint", { snapshot_endpoint_ok: false },
      /snapshot_endpoint_mismatch/],
  ])("#1 %s never attests", async (_label, over, expected) => {
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: withLinkage(over),
        budget: [validBudgetRow()],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.status, JSON.stringify(over)).not.toBe("ready");
    expect(String(budget.blocker), JSON.stringify(over)).toMatch(expected);
    expect(budget.coverage?.universe?.completeRunAttested).toBe(false);
  });

  it("#1 the query VALIDATES the partition and the snapshot, it does not filter them", () => {
    // Filtering a bad receipt away would let an older success win silently.
    expect(D086_COMPLETE_RUN_SQL).toContain("meta_sync_partitions");
    expect(D086_COMPLETE_RUN_SQL).toContain("meta_raw_snapshot_observations");
    expect(D086_COMPLETE_RUN_SQL).toContain("LEFT JOIN meta_sync_partitions");
    /*
      A LATERAL aggregate, not a plain join: raw snapshots are content-addressed,
      so one snapshot can carry several occurrence receipts and a join on
      snapshot_id alone fans a single capture receipt into several rows.
    */
    expect(D086_COMPLETE_RUN_SQL).toMatch(
      /LEFT JOIN LATERAL \([\s\S]*meta_raw_snapshot_observations o[\s\S]*\) obs ON TRUE/);
    expect(D086_COMPLETE_RUN_SQL).toContain("snapshot_occurrence_ok");
  });
});

describe("D086 C8 — a genuine delta is coherent without the newest run id", () => {
  it("#5 unchanged members inherited from the base run do not break coherence", async () => {
    /*
      r8's coherence rule demanded that every latest state row carry the attested
      run's id. A real delta stores only changed/new/exited states, so unchanged
      members keep the BASE run's id and a genuine delta could never be READY.
      Coherence must instead prove the contributing runs are the manifest's own
      chain: right endpoint, complete lane, at or before its payload clock.
    */
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851"], ["as1"], {
          manifest_kind: "delta",
          // The manifest names every run that contributed a member.
          member_run_ids: [CAMPAIGN_RUN, BASE_RUN],
        }),
        budget: [
          // Unchanged member, inherited from the BASE run.
          cboCampaign({ run_id: BASE_RUN, population_total: 2 }),
          deferringAdset({ population_total: 2 }),
        ],
      }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.blocker).not.toBe("budget_owner_run_incoherent");
    expect(budget.status).toBe("ready");
  });

  it("#5 a member from a run OUTSIDE the manifest chain is still incoherent", async () => {
    const m = await readBudgetReadiness(
      route({
        capability: fullCapability,
        runs: manifest(["23851"], ["as1"], {
          manifest_kind: "delta", member_run_ids: [CAMPAIGN_RUN, BASE_RUN],
        }),
        budget: [
          cboCampaign({ run_id: "88888888-8888-4888-8888-888888888888", population_total: 2 }),
          deferringAdset({ population_total: 2 }),
        ],
      }),
      scope(),
    );
    expect(dim(m, "budget_fact_retention").blocker).toBe("budget_owner_run_incoherent");
  });
});

describe("D086 C8 — capability covers exactly what the executed queries need", () => {
  it("#7 the state contract names every D083 field the query selects", () => {
    for (const column of [
      "budget_currency_exponent", "budget_currency_registry_version",
      "budget_shape_support", "campaign_start_time", "campaign_end_time",
      "adset_start_time", "adset_end_time", "provider_api_version", "state_hash",
    ]) {
      expect(D086_REQUIRED_STATE_COLUMNS, column).toContain(column);
    }
  });

  it("#7 the probe covers the partition and raw-observation seams", () => {
    expect(D086_CAPABILITY_PROBE_SQL).toContain("meta_sync_partitions");
    expect(D086_CAPABILITY_PROBE_SQL).toContain("meta_raw_snapshot_observations");
  });

  it("#7 the dead config-history budget query and its probe are GONE", async () => {
    const pack = await import("@/lib/meta/budget-readiness-read-model");
    expect(Object.keys(pack)).not.toContain("D086_BUDGET_LATEST_SQL");
    // ...and the config columns are no longer part of D086's own gate.
    expect(D086_CAPABILITY_PROBE_SQL).not.toContain("meta_campaign_config_history");
    expect(D086_CAPABILITY_PROBE_SQL).not.toContain("meta_adset_config_history");
  });

  it("#7 the state latest path has a catalog-validated index", () => {
    const names = D086_REQUIRED_INDEXES.map((index) => index.indexName);
    expect(names).toContain("idx_meta_entity_state_history_d086_latest");
    // ...and the obsolete effective-clock index claim is gone with the
    // predicate it used to serve.
    expect(names).not.toContain("idx_meta_entity_observation_runs_d086_effective");
  });
});

describe("D086 C8 — the UI and the artifact describe the query that actually runs", () => {
  it("#1 the dimension source names the state-history read, not config history", async () => {
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, runs: manifest(["23851"], []), budget: [validBudgetRow()] }),
      scope(),
    );
    const budget = dim(m, "budget_fact_retention");
    expect(budget.source).toContain("meta_entity_state_history");
    expect(budget.source).not.toContain("meta_campaign_config_history");
    expect(budget.source).not.toContain("meta_adset_config_history");
  });

  it("#1 an empty account says no OBSERVATION has been retained, not no config row", async () => {
    const m = await readBudgetReadiness(
      route({ capability: fullCapability, runs: [], budget: [] }), scope());
    const budget = dim(m, "budget_fact_retention");
    expect(budget.evidence).not.toContain("config row");
  });
});
