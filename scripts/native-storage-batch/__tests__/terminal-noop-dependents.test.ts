import { describe, expect, it } from "vitest";
import { rowSetHash } from "../common";
import { RETAINED_DEPENDENTS_CONTRACT, TERMINAL_NOOP_DEPENDENT, classifyTerminalNoopDependents } from "../capture";

const g = { businessId: "22222222-2222-4222-8222-222222222222", jobRunId: "33333333-3333-4333-8333-333333333333",
  asOfDate: "2026-10-02", engineVersion: "v3-ad-2026-09-29-current-shadow" };
const observedAt = "2026-10-05T12:00:00.000000+00:00";
const SELF_FK = { name: "engine_v3_job_runs_dependency_run_id_fkey", childColumns: ["dependency_run_id"], parentColumns: ["id"] };
// to_jsonb(engine_v3_job_runs) shape of recordNativeProposalProjectionRun for a manual-mode slot.
const row = (id: string, o: Record<string, unknown> = {}) => ({ id, job_name: TERMINAL_NOOP_DEPENDENT.jobName, business_ref_id: g.businessId,
  business_id: g.businessId, as_of_date: g.asOfDate, engine_version: g.engineVersion, status: "skipped", dependency_run_id: g.jobRunId,
  started_at: "2026-10-02T03:10:00+00:00", finished_at: "2026-10-02T03:10:01+00:00", duration_ms: 1000, row_count: 0,
  source_min_date: null, source_max_date: null, source_max_updated_at: null, input_hash: null, retry_count: 0, error_code: null,
  error_message: "standing_mode_manual", error_json: null, created_at: "2026-10-02T03:10:01+00:00", updated_at: "2026-10-02T03:10:01+00:00", ...o });
const ids = ["44444444-4444-4444-8444-444444444441", "44444444-4444-4444-8444-444444444442"];
const dependents = (rows = ids.map(id => row(id))) => rows.map(r => ({ id: String(r.id), bytes: JSON.stringify(r) }));
const census = (total: number, edges: { constraint: string; childTable: string; count: string }[]) => ({
  counts: [{ pinClass: "job_dependencies", count: String(total) }],
  foreignKeyReferences: edges.map(e => ({ childSchema: "public", parentSchema: "public", parentTable: "engine_v3_job_runs", pinClass: "job_dependencies", ...e })),
}) as never;
const selfEdge = (count: number) => ({ constraint: SELF_FK.name, childTable: "engine_v3_job_runs", count: String(count) });
const lifecycleEdge = (count: number) => ({ constraint: "engine_v3_creative_lifecycle_daily_job_run_id_fkey", childTable: "engine_v3_creative_lifecycle_daily", count: String(count) });
const classify = (o: Partial<Parameters<typeof classifyTerminalNoopDependents>[0]> = {}) => classifyTerminalNoopDependents({
  census: census(4, [selfEdge(2), lifecycleEdge(0)]), generation: g, observedAt, selfForeignKeys: [SELF_FK], dependents: dependents(), ...o });
const code = (fn: () => unknown) => { try { fn(); return "NO_REFUSAL"; } catch (e) { return (e as Error).message; } };

describe("terminal NO-OP proposal-projection dependents of a retained original job", () => {
  it("retains exactly the typed records with frozen full bytes; the self-FK edge plus the explicit count is 2N", () => {
    const d = dependents();
    expect(classify()).toEqual({ contract: RETAINED_DEPENDENTS_CONTRACT, jobIds: ids, rows: 2,
      rowByteSetSha256: rowSetHash(d.map(x => x.bytes)), dependencyForeignKey: SELF_FK.name });
    expect(classify({ census: census(2, [lifecycleEdge(0)]), selfForeignKeys: [] }).dependencyForeignKey).toBeNull();
    expect(classify({ census: census(0, [selfEdge(0)]), dependents: [] })).toMatchObject({ jobIds: [], rows: 0 });
  });
  it("refuses any count the dependents do not exactly explain, and every other dependency FK class", () => {
    const unexplained = "RETAINED_PIN_VETO:job_dependencies:unexplained_count";
    expect(code(() => classify({ census: census(3, [selfEdge(2)]) }))).toBe(unexplained);
    expect(code(() => classify({ census: census(4, [selfEdge(1)]) }))).toBe(unexplained);
    expect(code(() => classify({ census: census(2, []) }))).toBe(unexplained);
    expect(code(() => classify({ census: census(2, [selfEdge(0)]), dependents: [] }))).toBe(unexplained);
    expect(code(() => classify({ census: census(5, [selfEdge(2), lifecycleEdge(1)]) }))).toBe("RETAINED_PIN_VETO:job_dependencies:foreign_edge");
    expect(code(() => classify({ census: census(4, [{ ...selfEdge(2), constraint: "other_job_fk" }]) }))).toBe("RETAINED_PIN_VETO:job_dependencies:foreign_edge");
    expect(code(() => classify({ selfForeignKeys: [SELF_FK, { ...SELF_FK, name: "duplicate_fk" }] }))).toBe("RETAINED_PIN_VETO:job_dependencies:catalog");
    const nine = Array.from({ length: 9 }, (_, i) => row(`44444444-4444-4444-8444-44444444445${i}`));
    expect(code(() => classify({ census: census(18, [selfEdge(9)]), dependents: dependents(nine) }))).toBe("RETAINED_PIN_VETO:job_dependencies:bound");
  });
  it.each([
    ["real projection", { status: "success", row_count: 3, error_message: null }], ["other error", { error_message: "standing_mode_unreadable" }],
    ["running", { status: "running", finished_at: null }], ["failed", { status: "failed" }], ["nonzero rows", { row_count: 1 }],
    ["error code", { error_code: "x" }], ["reuse metadata", { error_json: { metadata: { reused_job_run_id: g.jobRunId } } }],
    ["retried", { retry_count: 1 }], ["input hash", { input_hash: "h" }], ["source window", { source_max_date: "2026-10-02" }],
    ["cross tenant", { business_ref_id: "55555555-5555-4555-8555-555555555555" }], ["text tenant", { business_id: "other" }],
    ["other day", { as_of_date: "2026-10-03" }], ["other epoch", { engine_version: "v3-ad-other" }],
    ["other dependency", { dependency_run_id: "66666666-6666-4666-8666-666666666666" }], ["other job", { job_name: "engine_v3_native_ad_operator_response_shadow_job" }],
    ["fresh update", { updated_at: "2026-10-05T11:45:00+00:00" }], ["future finish", { finished_at: "2026-10-06T00:00:00+00:00" }],
    ["inverted clock", { started_at: "2026-10-02T03:20:00+00:00" }], ["missing column", { error_code: undefined }],
  ])("refuses a %s dependent", (_name, o) => {
    expect(code(() => classify({ dependents: dependents([row(ids[0]!, o), row(ids[1]!)]) }))).toBe("RETAINED_PIN_VETO:job_dependencies:unqualified_dependent");
  });
  it("refuses a dependent whose bytes do not name its own id or an unsorted/duplicate set", () => {
    expect(code(() => classify({ dependents: [{ id: ids[0]!, bytes: JSON.stringify(row(ids[1]!)) }, dependents()[1]!] }))).toBe("RETAINED_PIN_VETO:job_dependencies:unqualified_dependent");
    expect(code(() => classify({ dependents: dependents([row(ids[1]!), row(ids[0]!)]) }))).toBe("RETAINED_PIN_VETO:job_dependencies:unqualified_dependent");
  });
});
