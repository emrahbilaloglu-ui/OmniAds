import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBusinessErasureStateRunIndexCapacity, assertBusinessErasureScalarIndexCapacity, RELEASE_GATE_PROVIDER_INDEX_CONTRACTS, releaseGateProviderScopeIsCurrent, runReleaseGateProviderScopeMigration } from "@/lib/migrations";

vi.mock("@/lib/startup-diagnostics", () => ({ logStartupEvent: vi.fn(), logStartupError: vi.fn() }));
afterEach(() => vi.unstubAllEnvs());
const complete = () => RELEASE_GATE_PROVIDER_INDEX_CONTRACTS.map(x => ({ index_name: x.index_name, index_satisfied: true, column_satisfied: true, obsolete_index_absent: true }));
function fixture(statuses: unknown = complete(), badPlan = false, wrongRow = false) {
  const query = vi.fn(async (text: string) => {
    if (text.includes("AS index_satisfied")) return statuses;
    if (text.startsWith("EXPLAIN")) return [{ "QUERY PLAN": [{ Plan: badPlan ? { "Node Type": "Seq Scan", "Relation Name": "sync_release_gates" } : { "Node Type": "Limit", Plans: [{ "Node Type": "Index Only Scan", "Relation Name": "sync_release_gates", "Index Name": "idx_sync_release_gates_kind_latest", "Index Cond": "gate_kind = 'deploy_gate' AND provider_scope > 'global'" }] } }] }];
    if (text.includes("SELECT 1 FROM public.sync_release_gates")) return wrongRow ? [{ found: 1 }] : [];
    if (text.includes("COALESCE(pg_total_relation_size")) return [{ relation_bytes: "2610200576", database_bytes: "175192964119" }];
    if (text.includes("s.payload")) return [{ payload: { disks: [{ path: "/var/lib/postgresql", availableBytes: 49048449024 }] }, age_seconds: "1" }];
    throw Error("unexpected migration mutation/query");
  });
  return Object.assign(vi.fn(async () => { throw Error("unexpected DDL"); }), { query });
}

describe("completed provider-scope replay", () => {
  it("preserves the exact completed indexes and data without size/sample reservation or mutation", async () => {
    const sql = fixture();
    await runReleaseGateProviderScopeMigration(sql as never);
    expect(sql.query.mock.calls.every(([q]) => q.trim().startsWith("SELECT") || q.startsWith("EXPLAIN"))).toBe(true);
    expect(sql).not.toHaveBeenCalled();
  });
  it.each(["missing", "duplicate", "invalid", "wrong-column", "obsolete", "string-true"])("never infers completion from %s evidence", async kind => {
    const rows = complete();
    if (kind === "missing") rows.pop();
    if (kind === "duplicate") rows[0] = { ...rows[1]! };
    if (kind === "invalid") rows[0]!.index_satisfied = false;
    if (kind === "wrong-column") rows[0]!.column_satisfied = false;
    if (kind === "obsolete") rows[0]!.obsolete_index_absent = false;
    if (kind === "string-true") (rows[0] as unknown as Record<string, unknown>).index_satisfied = "true";
    const sql = fixture(rows);
    await expect(runReleaseGateProviderScopeMigration(sql as never)).rejects.toThrow("migration_capacity_refused:sync_release_gates_provider_scope");
    expect(sql).not.toHaveBeenCalled();
  });
  it("refuses a nonindexed witness before reading data", async () => {
    const sql = fixture(complete(), true);
    expect(await releaseGateProviderScopeIsCurrent(sql as never)).toBe(false);
    expect(sql.query.mock.calls.some(([q]) => q.includes("SELECT 1 FROM public.sync_release_gates") && !q.startsWith("EXPLAIN"))).toBe(false);
  });
  it("retains the old physical guard when a mislabelled deploy row is witnessed", async () => {
    const sql = fixture(complete(), false, true);
    await expect(runReleaseGateProviderScopeMigration(sql as never)).rejects.toThrow("migration_capacity_refused");
    expect(sql).not.toHaveBeenCalled();
  });
});

function capacity(free = 50 * 1024 ** 3, age = 1, relationCount = 1, heap = "1073741824") {
  return { query: vi.fn(async (q: string) => {
    if (q.includes("WITH RECURSIVE relations")) return [{ relation_bytes: heap, database_bytes: "175192964119", relation_count: relationCount }];
    if (q.includes("s.payload")) return [{ payload: { disks: [{ path: "/var/lib/postgresql", availableBytes: free }] }, age_seconds: age }];
    throw Error("unexpected capacity query");
  }) };
}

describe("fixed scalar FK index physical reserve", () => {
  it("reserves eight times proven UUID primary coverage plus the same floor for the fixed-width campaign hash", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const sql = { query: vi.fn(async (q: string) => {
      if (q.includes("AS campaign_reference_pk_bytes")) return [{ relation_bytes: "459505664", database_bytes: "175192964119" }];
      if (q.includes("s.payload")) return [{ payload: { disks: [{ path: "/var/lib/postgresql", availableBytes: 49048449024 }] }, age_seconds: 1 }];
      throw Error("unexpected hash reserve query");
    }) };
    await expect(assertBusinessErasureScalarIndexCapacity(sql as never, "public.engine_v3_ad_decision_evaluations", "hash")).resolves.toMatchObject({ engaged: true });
    const measured = sql.query.mock.calls[0]![0];
    for (const proof of ["i.indisprimary", "i.indisunique", "i.indimmediate", "i.indpred IS NULL", "i.indnkeyatts=1", "a.atttypid=2950", "a.attnotnull", "i.indisvalid", "i.indisready", "i.indislive"]) expect(measured).toContain(proof);
  });
  it.each(["coverage", "shortfall", "stale", "unknown"])("refuses %s campaign hash admission without falling back to heap or an override", async kind => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("ADSECUTE_MIGRATION_CAPACITY_OVERRIDE", "fixture");
    const sql = { query: vi.fn(async (q: string) => {
      if (q.includes("AS campaign_reference_pk_bytes")) return kind === "coverage" ? [] : [{ relation_bytes: "459505664", database_bytes: "175192964119" }];
      if (q.includes("s.payload")) return [{ payload: { disks: [{ path: "/var/lib/postgresql", availableBytes: kind === "shortfall" ? 46_625_718_271 : kind === "unknown" ? null : 49048449024 }] }, age_seconds: kind === "stale" ? 901 : 1 }];
      throw Error("unexpected hash reserve query");
    }) };
    await expect(assertBusinessErasureScalarIndexCapacity(sql as never, "public.engine_v3_ad_decision_evaluations", "hash")).rejects.toThrow(kind === "coverage" ? "primary_coverage_refused" : "capacity_refused");
  });
  it("refuses campaign hash sizing on another relation", async () => {
    const sql = capacity();
    await expect(assertBusinessErasureScalarIndexCapacity(sql as never, "public.meta_raw_snapshots", "hash")).rejects.toThrow("hash_scope_refused");
    expect(sql.query).not.toHaveBeenCalled();
  });
  it("does not apply heap-only accounting to an unreviewed relation", async () => {
    const sql = capacity();
    await expect(assertBusinessErasureScalarIndexCapacity(sql as never, "public.unreviewed_text_index")).rejects.toThrow("scope_refused");
    expect(sql.query).not.toHaveBeenCalled();
  });
  it("reserves three times heap plus the unchanged 40GiB residual floor", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(assertBusinessErasureScalarIndexCapacity(capacity() as never, "public.meta_authoritative_reconciliation_events")).resolves.toMatchObject({ engaged: true });
  });
  it.each(["shortfall", "stale", "unknown"])("refuses %s physical evidence even with an override", async kind => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("ADSECUTE_MIGRATION_CAPACITY_OVERRIDE", "fixture");
    const free = kind === "shortfall" ? 43 * 1024 ** 3 - 1 : kind === "unknown" ? Number.NaN : 50 * 1024 ** 3;
    await expect(assertBusinessErasureScalarIndexCapacity(capacity(free, kind === "stale" ? 901 : 1) as never, "public.meta_authoritative_reconciliation_events")).rejects.toThrow("cannot bypass a physical capacity refusal");
  });
  it("includes partition leaves and refuses an unbounded relation census", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(assertBusinessErasureScalarIndexCapacity(capacity(undefined, 1, 3) as never, "public.engine_v3_ad_decision_outcomes_daily")).resolves.toMatchObject({ engaged: true });
    await expect(assertBusinessErasureScalarIndexCapacity(capacity(undefined, 1, 257) as never, "public.engine_v3_ad_decision_outcomes_daily")).rejects.toThrow("relation_census_refused");
  });
  it("does not turn malformed heap bytes into light-work admission", async () => {
    await expect(assertBusinessErasureScalarIndexCapacity(capacity(undefined, 1, 1, "NaN") as never, "public.meta_authoritative_reconciliation_events")).rejects.toThrow("heap_measurement_refused");
  });
});


describe("bounded state-run index physical reserve", () => {
  it.each(["valid", "shortfall", "stale", "coverage", "bounds"])("checks %s coverage without a heap rewrite or override", async kind => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("ADSECUTE_MIGRATION_CAPACITY_OVERRIDE", "fixture");
    const required = 139321344 * 32 + 40 * 1024 ** 3;
    const sql = { query: vi.fn(async (q: string) => {
      if (q.includes("AS lineage_valid")) return [{ shape_valid: true, bounds_valid: kind !== "bounds", lineage_valid: true, lookup_ready: false, named_index_conflict: false }];
      if (q.includes("AS state_run_pk_bytes")) return kind === "coverage" ? [] : [{ relation_bytes: "139321344", database_bytes: "175577545751" }];
      if (q.includes("s.payload")) return [{ payload: { disks: [{ path: "/var/lib/postgresql", availableBytes: kind === "shortfall" ? required - 1 : required }] }, age_seconds: kind === "stale" ? 901 : 1 }];
      throw Error("unexpected reserve query");
    }) };
    if (kind === "valid") await expect(assertBusinessErasureStateRunIndexCapacity(sql as never)).resolves.toMatchObject({ engaged: true });
    else await expect(assertBusinessErasureStateRunIndexCapacity(sql as never)).rejects.toThrow(kind === "bounds" ? "state_run_index_contract" : kind === "coverage" ? "primary_coverage_refused" : "capacity_refused");
    expect(sql.query.mock.calls.every(([q]) => !q.includes("pg_total_relation_size"))).toBe(true);
  });
});
