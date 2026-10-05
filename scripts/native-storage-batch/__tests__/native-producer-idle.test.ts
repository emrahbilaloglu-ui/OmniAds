import { describe, expect, it } from "vitest";
import { NATIVE_AD_ENGINE_VERSION } from "../../../lib/creative-decision-engine/types";
import { hashAdvisoryLock } from "../../../lib/creative-decision-engine/jobs/advisory-lock";
import { NATIVE_JOB } from "../common";
import type { Q } from "../capture";
import { NATIVE_RUNNING_LEDGER_LIMIT, readNativeProducerIdle } from "../native-producer-idle";

const now = "2026-10-05T10:00:00Z";
const old = { id: "11111111-1111-4111-8111-111111111111", business_ref_id: "22222222-2222-4222-8222-222222222222",
  business_id: "22222222-2222-4222-8222-222222222222", job_name: NATIVE_JOB, as_of_date: "2026-09-26",
  engine_version: "v3-ad-2026-09-24-cut-proof-floor-story-shadow", started_at: "2026-09-26T10:00:00Z",
  updated_at: "2026-09-26T10:00:01Z", unfinished: true };
function fixture(rows: Record<string, unknown>[], locks = 0) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const db = { query: async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes("clock_timestamp()::text")) return { rows: [{ observed_at: now }] };
    if (sql.includes("FROM public.engine_v3_job_runs")) return { rows };
    if (sql.includes("FROM pg_locks")) return { rows: [{ n: locks }] };
    throw new Error("Unexpected statement");
  } } as Q;
  return { db, calls };
}
describe("maintenance producer idle preserves active work and original ledger rows", () => {
  it("distinguishes the observed stale retired metadata without any write or lock acquisition", async () => {
    const { db, calls } = fixture([{ ...old }]);
    expect(await readNativeProducerIdle(db, true)).toMatchObject({ nativeProducerIdle: true, qualifiedRetiredMetadata: 1,
      ledgerWrites: 0, lockAcquisitionAttempted: false, currentEpoch: NATIVE_AD_ENGINE_VERSION });
    expect(calls.every(x => x.sql.trim().startsWith("SELECT"))).toBe(true);
    expect(calls[1].values?.[1]).toBe(NATIVE_RUNNING_LEDGER_LIMIT + 1);
    expect(calls[2].values).toEqual([[hashAdvisoryLock(`${old.job_name}:${old.business_id}:${old.as_of_date}`).toString(),
      hashAdvisoryLock(`engine_v3_native_ad_shadow_business_chain:${old.business_id}:${old.as_of_date}`).toString()]]);
  });
  it.each([NATIVE_JOB, "engine_v3_native_ad_calibration_shadow_job"])("always refuses current running %s even when old", async job_name => {
    const { db, calls } = fixture([{ ...old, job_name, engine_version: NATIVE_AD_ENGINE_VERSION }]);
    expect(await readNativeProducerIdle(db, true)).toMatchObject({ nativeProducerIdle: false, reason: "current_epoch_running" });
    expect(calls).toHaveLength(2);
  });
  it("checks the actual versioned retired calibration ownership key as well as the conservative keys", async () => {
    const row = { ...old, job_name: "engine_v3_native_ad_calibration_shadow_job",
      engine_version: "v3-ad-2026-07-18-decision-presentation-hardening-shadow" };
    const { db, calls } = fixture([row], 1);
    expect((await readNativeProducerIdle(db, true)).nativeProducerIdle).toBe(false);
    expect(calls[2].values).toEqual([[hashAdvisoryLock(`${row.job_name}:${row.business_id}:${row.as_of_date}`).toString(),
      hashAdvisoryLock(`engine_v3_native_ad_shadow_business_chain:${row.business_id}:${row.as_of_date}`).toString(),
      hashAdvisoryLock(`${row.job_name}:${row.business_id}:${row.as_of_date}:${row.engine_version}`).toString()]]);
  });
  it.each([
    { started_at: "2026-10-05T09:40:00Z", updated_at: "2026-10-05T09:40:01Z" },
    { updated_at: "2026-10-05T09:40:00Z" },
    { updated_at: "2026-10-05T09:30:00Z" },
    { updated_at: "2026-09-25T10:00:00Z" },
    { started_at: null }, { updated_at: "invalid" }, { engine_version: "unknown-retired-epoch" },
    { unfinished: false }, { business_id: "different" }, { id: "invalid" },
  ])("refuses fresh, malformed or unknown legacy identity %j", async change => {
    const { db, calls } = fixture([{ ...old, ...change }]);
    expect((await readNativeProducerIdle(db, true)).nativeProducerIdle).toBe(false);
    expect(calls).toHaveLength(2);
  });
  it("refuses either canonical ownership lock or waiter", async () => {
    const { db, calls } = fixture([{ ...old }], 1);
    expect(await readNativeProducerIdle(db, true)).toMatchObject({ nativeProducerIdle: false,
      reason: "retired_canonical_job_or_chain_lock_present" });
    expect(calls[2].sql).toContain("l.database=");
    expect(calls[2].sql).not.toContain("l.granted");
  });
  it("keeps the bounded result fail-closed rather than silently dropping other producers", async () => {
    const { db } = fixture(Array.from({ length: NATIVE_RUNNING_LEDGER_LIMIT + 1 }, () => ({ ...old })));
    expect(await readNativeProducerIdle(db, true)).toMatchObject({ nativeProducerIdle: false, reason: "running_ledger_bound_or_clock" });
  });
  it("requires separately checked role and consumer identities for retired metadata", async () => {
    expect((await readNativeProducerIdle(fixture([{ ...old }]).db, false)).nativeProducerIdle).toBe(false);
    expect((await readNativeProducerIdle(fixture([]).db, false)).nativeProducerIdle).toBe(true);
  });
});
