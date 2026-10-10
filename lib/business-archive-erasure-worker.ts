import { getDb, withPinnedDbClient } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { DbGrowthFenceRefusal, evaluateDbGrowthFence } from "@/lib/sync/db-growth-fence";
import { BUSINESS_ERASURE_LOCK_NAMESPACE } from "@/lib/business-deletion";
import { isDemoBusinessId } from "@/lib/demo-business";
import { archiveNeed } from "@/lib/business-archive-configuration";
import { applyBusinessArchiveErasurePlan, BUSINESS_ARCHIVE_ERASURE_BOUNDS, prepareBusinessArchiveErasurePlan,
  validateBusinessArchiveErasurePlan, type BusinessArchiveErasureState } from "@/lib/business-archive-erasure";

/** Dedicated archive role only. It has the narrowly mounted writable archive;
 * web remains read-only and the provider worker has no archive filesystem. */
export async function runBusinessArchiveErasureTick() {
  if (process.env.BUSINESS_ARCHIVE_ERASURE_ENABLED !== "true") return { outcome: "disabled" };
  archiveNeed(process.env.BUSINESS_ARCHIVE_ERASURE_ROLE === "1");
  assertSyncLaneEnabled("assignment_mutation");
  const ready = await getDbSchemaReadiness({ tables: ["business_deletion_jobs"] });
  if (!ready.ready) return { outcome: "schema_not_ready" };
  // No disk/DB capacity census on an empty queue. This read grants no admission
  // or claim: both are checked again below on the lock-owning backend.
  if(!(await getDb().query("SELECT 1 FROM business_deletion_jobs WHERE hidden_at IS NOT NULL LIMIT 1")).length)
    return {outcome:"idle"};
  const capacity = await evaluateDbGrowthFence();
  if (capacity.physical?.admitted !== true || capacity.overridden
    || !capacity.allowed && !["database_budget_exceeded", "table_budget_exceeded"].includes(capacity.reason))
    throw new DbGrowthFenceRefusal(capacity, "business_archive_erasure");
  return withPinnedDbClient(async client => {
    const { rows: [lock] } = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::int,0) AS acquired", [BUSINESS_ERASURE_LOCK_NAMESPACE]);
    if (!lock?.acquired) return { outcome: "busy" };
    try {
      await client.query("SET statement_timeout='3000ms'; SET lock_timeout='1500ms'; SET enable_seqscan=off; SET enable_bitmapscan=off");
      // Serialize the entire archive -> DB saga, including owner-blocked jobs.
      // A later erasure must not collect an archived-only shared key while an
      // earlier durable checkpoint still needs its original frozen-row proof.
      const {rows:[first]}=await client.query<{business_ref_id:string;status:string;prepared:boolean}>(
        `SELECT business_ref_id,status,COALESCE((archive_state->>'prepared')::boolean,false) AS prepared
         FROM business_deletion_jobs WHERE hidden_at IS NOT NULL ORDER BY created_at,business_ref_id LIMIT 1`);
      if(!first)return {outcome:"idle"};
      if(first.status==="failed")return {outcome:"owner_attention"};
      if(first.prepared)return {outcome:"awaiting_database"};
      const { rows: [job] } = await client.query<{ business_ref_id: string; attempt_id: string; archive_state: BusinessArchiveErasureState | null; erasure_started_at: string; archive_attempts: number }>(
        `UPDATE business_deletion_jobs SET status='running',archive_attempts=archive_attempts+1,
          erasure_started_at=COALESCE(erasure_started_at,now()),updated_at=now(),error_code=NULL,error_tables='{}'
         WHERE business_ref_id=$1::uuid AND status IN ('queued','running') AND archive_attempts<3
           AND COALESCE((archive_state->>'prepared')::boolean,false)=false RETURNING *`,[first.business_ref_id]);
      if (!job) return { outcome: "idle" };
      let phase = "planning";
      try {
        archiveNeed(!isDemoBusinessId(job.business_ref_id));
        const [started] = [new Date(job.erasure_started_at).getTime()];
        archiveNeed(Number.isFinite(started));
        const deadlineAtMs = Math.min(Date.now() + BUSINESS_ARCHIVE_ERASURE_BOUNDS.phaseMs, started + 30 * 60_000);
        const plan = job.archive_state?.plan ?? await prepareBusinessArchiveErasurePlan(job.business_ref_id, client, deadlineAtMs);
        validateBusinessArchiveErasurePlan(plan, job.business_ref_id);
        archiveNeed(Date.now() < deadlineAtMs);
        // This checkpoint COMMIT precedes EVERY publication/unlink. Restarting
        // the process cannot lose the frozen input hashes or exact file proofs.
        const saved = await client.query(`UPDATE business_deletion_jobs SET archive_state=$3::jsonb,updated_at=now()
          WHERE business_ref_id=$1::uuid AND attempt_id=$2::uuid`,
        [job.business_ref_id, job.attempt_id, JSON.stringify({ plan, prepared: false })]);
        archiveNeed(saved.rowCount === 1);
        await applyBusinessArchiveErasurePlan(plan, deadlineAtMs, async next => { phase = next; });
        const completed = await client.query(`UPDATE business_deletion_jobs SET archive_state=$3::jsonb,
          status='queued',error_code=NULL,error_tables='{}',updated_at=now()
          WHERE business_ref_id=$1::uuid AND attempt_id=$2::uuid`,
        [job.business_ref_id, job.attempt_id, JSON.stringify({ plan, prepared: true })]);
        archiveNeed(completed.rowCount === 1);
        console.info("[business archive erasure] prepared");
        return { outcome: "prepared" };
      } catch {
        await client.query(`UPDATE business_deletion_jobs SET status='failed',error_code='external_cleanup_required',
          error_tables=$3::text[],updated_at=now() WHERE business_ref_id=$1::uuid AND attempt_id=$2::uuid`,
        [job.business_ref_id, job.attempt_id, [`native_archive:${phase}`]]);
        console.error("[business archive erasure] failed", { phase });
        return { outcome: "failed", phase };
      }
    } finally {
      // Interrupted preparation is finite; never leave a forever-running row
      // once its last automatic crash recovery has been consumed.
      await client.query(`UPDATE business_deletion_jobs SET status='failed',error_code='interrupted',updated_at=now()
        WHERE status='running' AND archive_attempts>=3 AND COALESCE((archive_state->>'prepared')::boolean,false)=false`);
      await client.query("RESET statement_timeout; RESET lock_timeout; RESET enable_seqscan; RESET enable_bitmapscan");
      const { rows: [unlocked] } = await client.query<{ released: boolean }>(
        "SELECT pg_advisory_unlock($1::int,0) AS released", [BUSINESS_ERASURE_LOCK_NAMESPACE]);
      if (!unlocked?.released) throw new Error("business_archive_erasure_lock_lost");
    }
  }, { timeoutMs: 30_000 });
}
