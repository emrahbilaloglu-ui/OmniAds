import { NATIVE_AD_ENGINE_VERSION } from "../../lib/creative-decision-engine/types";
import { hashAdvisoryLock } from "../../lib/creative-decision-engine/jobs/advisory-lock";
import type { Q } from "./capture";
import { NATIVE_JOB, UUID } from "./common";

/** Only the three retired epochs in the actual bounded 2026-10-05 diagnosis.
 * Unknown epochs, active current runs and fresh/owned legacy runs veto. This
 * is a read-only maintenance assessment, never a reaper or terminal rewrite. */
const RETIRED_EPOCHS = new Set([
  "v3-ad-2026-07-18-decision-presentation-hardening-shadow",
  "v3-ad-2026-09-07-held-verdict-authority-shadow",
  "v3-ad-2026-09-24-cut-proof-floor-story-shadow",
]);
export const NATIVE_RUNNING_LEDGER_LIMIT = 64;
// Same conservative age as the native producer's canonical 30-minute reaper;
// unlike that reaper, this helper never acquires locks or changes rows.
const LEGACY_STALE_MS = 30 * 60 * 1000;
const CALIBRATION_JOB = "engine_v3_native_ad_calibration_shadow_job";

export async function readNativeProducerIdle(db: Q, allowRetiredMetadata: boolean) {
  const sample = (await db.query("SELECT clock_timestamp()::text observed_at")).rows[0];
  const now = Date.parse(sample.observed_at);
  const rows = (await db.query(`SELECT id::text,business_ref_id::text business_ref_id,business_id,
      job_name,as_of_date::text as_of_date,engine_version,
      to_jsonb(started_at)#>>'{}' started_at,to_jsonb(updated_at)#>>'{}' updated_at,
      finished_at IS NULL unfinished
    FROM public.engine_v3_job_runs WHERE status='running' AND job_name=ANY($1::text[])
    ORDER BY started_at,id LIMIT $2`, [[NATIVE_JOB, CALIBRATION_JOB], NATIVE_RUNNING_LEDGER_LIMIT + 1])).rows;
  const base = { contract: "native-maintenance-producer-idle.v1", observedAt: sample.observed_at as string,
    examined: rows.length, currentEpoch: NATIVE_AD_ENGINE_VERSION,
    currentRunning: rows.filter(r => r.engine_version === NATIVE_AD_ENGINE_VERSION).length,
    qualifiedRetiredMetadata: 0, lockAcquisitionAttempted: false as const, ledgerWrites: 0 as const };
  const refuse = (reason: string) => ({ ...base, nativeProducerIdle: false, reason });
  if (!Number.isFinite(now) || rows.length > NATIVE_RUNNING_LEDGER_LIMIT) return refuse("running_ledger_bound_or_clock");
  if (base.currentRunning > 0) return refuse("current_epoch_running");
  if (rows.length === 0) return { ...base, nativeProducerIdle: true, reason: "no_running_native_ledger" };
  if (!allowRetiredMetadata) return refuse("retired_runtime_or_consumer_identity_unproved");
  const keys: string[] = [];
  for (const r of rows) {
    const start = Date.parse(r.started_at), updated = Date.parse(r.updated_at);
    if (!RETIRED_EPOCHS.has(r.engine_version) || !UUID.test(r.id) || !UUID.test(r.business_ref_id)
      || r.business_id !== r.business_ref_id || !/^\d{4}-\d{2}-\d{2}$/.test(r.as_of_date)
      || ![NATIVE_JOB, CALIBRATION_JOB].includes(r.job_name) || r.unfinished !== true
      || !Number.isFinite(start) || !Number.isFinite(updated) || updated < start
      || start >= now - LEGACY_STALE_MS || updated >= now - LEGACY_STALE_MS) return refuse("unqualified_retired_running_metadata");
    keys.push(hashAdvisoryLock(`${r.job_name}:${r.business_ref_id}:${r.as_of_date}`).toString(),
      hashAdvisoryLock(`engine_v3_native_ad_shadow_business_chain:${r.business_ref_id}:${r.as_of_date}`).toString());
    if (r.job_name === CALIBRATION_JOB) keys.push(hashAdvisoryLock(
      `${r.job_name}:${r.business_ref_id}:${r.as_of_date}:${r.engine_version}`).toString());
  }
  // Pure catalog SELECT: decision job (unversioned), calibration job (versioned)
  // and chain keys. The old unversioned calibration key is also kept as a
  // conservative veto. Granted owners and waiters both veto. No try-lock.
  const locks = (await db.query(`SELECT count(*)::int n FROM pg_locks l
    JOIN unnest($1::bigint[]) k(key) ON l.locktype='advisory' AND l.objsubid=1
      AND l.classid::bigint=((k.key>>32)&4294967295::bigint)
      AND l.objid::bigint=(k.key&4294967295::bigint)
    WHERE l.database=(SELECT oid FROM pg_database WHERE datname=current_database())`, [keys])).rows[0];
  if (locks.n !== 0) return refuse("retired_canonical_job_or_chain_lock_present");
  return { ...base, qualifiedRetiredMetadata: rows.length, nativeProducerIdle: true,
    reason: "retired_stale_unowned_metadata_only" };
}
