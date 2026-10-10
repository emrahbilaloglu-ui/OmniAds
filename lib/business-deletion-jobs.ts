import { randomUUID } from "node:crypto";
import { getDb, withPinnedDbClient } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { isDemoBusinessId } from "@/lib/demo-business";
import { BUSINESS_ERASURE_LOCK_NAMESPACE, BusinessDeletionError, deleteBusinessWithData } from "@/lib/business-deletion";

export type BusinessDeletionJob = {
  business_ref_id: string; attempt_id: string; status: "queued" | "running" | "failed";
  error_code: string | null; error_tables: string[]; attempts: number;
  erasure_started_at?: string | null;
};

/** Admin authorization is required by the caller. Active work is idempotent;
 * only a failed attempt can be explicitly reset by another authorized DELETE. */
export async function enqueueBusinessDeletion(businessId: string) {
  assertSyncLaneEnabled("assignment_mutation");
  if (isDemoBusinessId(businessId)) throw new BusinessDeletionError("protected_history");
  const sql = getDb();
  const [existing] = await sql.query<BusinessDeletionJob>("SELECT * FROM business_deletion_jobs WHERE business_ref_id=$1::uuid", [businessId]);
  if (existing && existing.status !== "failed") {
    await sql.query("UPDATE business_deletion_jobs SET hidden_at=COALESCE(hidden_at,now()) WHERE business_ref_id=$1::uuid",[businessId]);
    return existing;
  }
  const [job] = await sql.query<BusinessDeletionJob>(`INSERT INTO business_deletion_jobs (business_ref_id,attempt_id,status,hidden_at)
    VALUES($1::uuid,$2::uuid,'queued',now()) ON CONFLICT(business_ref_id) DO UPDATE
    SET attempt_id=EXCLUDED.attempt_id,status='queued',attempts=0,archive_attempts=0,erasure_started_at=NULL,error_code=NULL,error_tables='{}',started_at=NULL,updated_at=now(),hidden_at=COALESCE(business_deletion_jobs.hidden_at,now())
    WHERE business_deletion_jobs.status='failed' RETURNING *`, [businessId, randomUUID()]);
  // Another admin may have enqueued the same business after our initial read.
  if (job) return job;
  const [concurrent] = await sql.query<BusinessDeletionJob>("SELECT * FROM business_deletion_jobs WHERE business_ref_id=$1::uuid", [businessId]);
  if (!concurrent) throw new BusinessDeletionError("not_found");
  return concurrent;
}

/** Called only after fresh physical admission in the long-lived WEB process,
 * which owns the actual media cache and mounted historical archive. The sync
 * worker has neither and must never infer their absence from its own filesystem.
 * One pinned PostgreSQL session owns the global exclusion AND the actual erasure
 * transaction: connection/process loss releases the lock and rolls it back.
 * A running row can then be reclaimed, at most three interrupted attempts. */
export async function runBusinessDeletionWorkerTick() {
  assertSyncLaneEnabled("assignment_mutation");
  const ready = await getDbSchemaReadiness({ tables: ["business_deletion_jobs"] });
  if (!ready.ready) return { outcome: "schema_not_ready" };
  return withPinnedDbClient(async (client) => {
    const { rows: [lock] } = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::int,0) AS acquired", [BUSINESS_ERASURE_LOCK_NAMESPACE]);
    if (!lock?.acquired) return { outcome: "busy" };
    try {
      const { rows: [job] } = await client.query<BusinessDeletionJob>(`UPDATE business_deletion_jobs
        SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'running' END,
          error_code=CASE WHEN attempts>=3 THEN 'interrupted' ELSE NULL END,
          attempts=attempts+1,started_at=now(),erasure_started_at=COALESCE(erasure_started_at,now()),updated_at=now()
        WHERE business_ref_id=(SELECT business_ref_id FROM business_deletion_jobs
          WHERE status IN ('queued','running')
            AND ($1::boolean=false OR COALESCE((archive_state->>'prepared')::boolean,false)=true)
          ORDER BY created_at,business_ref_id LIMIT 1)
        RETURNING *`, [process.env.BUSINESS_ARCHIVE_ERASURE_ENABLED === "true"]);
      if (!job) return { outcome: "idle" };
      if (job.status === "failed") return { outcome: "interrupted" };
      try {
        if (isDemoBusinessId(job.business_ref_id)) throw new BusinessDeletionError("protected_history");
        await deleteBusinessWithData(job.business_ref_id, { client,
          deadlineAtMs: job.erasure_started_at ? new Date(job.erasure_started_at).getTime() + 30 * 60_000 : undefined });
        // The job is erased in the same COMMIT as its business. No completed
        // row, business name, request payload or historical tombstone remains.
        console.info("[business erasure worker] completed");
        return { outcome: "completed" };
      } catch (error) {
        const code = error instanceof BusinessDeletionError ? error.code : "delete_failed";
        const tables = error instanceof BusinessDeletionError ? error.tables : [];
        await client.query(`UPDATE business_deletion_jobs SET status='failed',error_code=$3,error_tables=$4::text[],updated_at=now()
          WHERE business_ref_id=$1::uuid AND attempt_id=$2::uuid`, [job.business_ref_id,job.attempt_id,code,tables]);
        console.error("[business erasure worker] failed", { code });
        return { outcome: "failed", code };
      }
    } finally {
      const { rows: [unlocked] } = await client.query<{ released: boolean }>(
        "SELECT pg_advisory_unlock($1::int,0) AS released", [BUSINESS_ERASURE_LOCK_NAMESPACE]);
      if (!unlocked?.released) throw new Error("business_erasure_lock_lost");
    }
  }, { timeoutMs: 30_000 });
}

export function businessDeletionFailureMessage(code: string, tr: boolean, tables: string[] = [], offboarded = false) {
  if(offboarded){
    const reasons:Record<string,string>={
      protected_history:tr?"İncelenmemiş bir koruma kuralı temizliği engelliyor.":"An unreviewed protection rule blocks cleanup.",
      schema_not_ready:tr?"Mevcut şema güvenli temizliğe uygun değil.":"The current schema is not ready for safe cleanup.",
      scope_conflict:tr?"Sahiplik veya dondurulmuş kaynak kanıtı değişti; kanıt yeniden incelenmeli.":"Ownership or frozen source evidence changed; review the evidence.",
      business_busy:tr?"Aktif iş veya kilit var; işler kapandıktan sonra yeniden deneyin.":"Active work or a lock remains; retry after it closes.",
      control_reference_in_use:tr?"Canlı yapılandırma veya worker referansı kaldırılmadan temizlik tamamlanamaz.":"Cleanup requires removal of the live runtime or worker reference.",
      external_cleanup_required:tr?"Arşiv/dosya temizliği doğrulanamadı; owner hata aşamasını incelemeli.":"Archive/file cleanup could not be verified; review the owner error phase.",
      interrupted:tr?"Otomatik kesinti toparlama sınırına ulaşıldı; uygulama sahibi yeniden denemeli.":"Automatic interruption recovery is exhausted; the application owner must retry.",
    };
    return (tr?"İşletme erişime kapalı; arka plan temizliği tamamlanmadı. ":"Business access is closed; background cleanup is incomplete. ")
      +(reasons[code]??(tr?"İş kaydı uygulama sahibi tarafından incelenmeli.":"The application owner must inspect the job."));
  }
  const messages: Record<string, string> = {
    not_found: tr ? "İşletme bulunamadı." : "Business not found.",
    protected_history: tr ? "İncelenmemiş bir veri koruma kuralı silmeyi engelliyor. İşletme ve veritabanı kayıtları korundu. Destek ile iletişime geçin."
      : "An unreviewed data protection rule prevents deletion. The business and database records were preserved. Contact support.",
    schema_not_ready: tr ? "İşletmenin tüm verileri güvenle kaldırılamıyor. Hiçbir veri silinmedi. Destek ile iletişime geçin."
      : "The business data cannot be safely removed with the current schema. No data was deleted. Contact support.",
    scope_conflict: tr ? "İşletme verilerindeki sahiplik uyuşmazlığı silmeyi engelliyor. Hiçbir veri silinmedi. Destek ile iletişime geçin."
      : "Conflicting business ownership prevents deletion. No data was deleted. Contact support.",
    business_busy: tr ? "Aktif bir veri işi veya kilit kaydı silmeyi engelliyor. Hiçbir veri silinmedi. İşler kapandığında yeniden deneyin."
      : "Active data work or a lease prevents deletion. No data was deleted. Try again after the work is closed.",
    control_reference_in_use: tables.includes("sync_runtime_instances")
      ? tr ? "İşletme güncel canlı yapılandırmada referans alınıyor. İlgili yapılandırma referansı kaldırılmadan silinemez. İşletme ve veritabanı kayıtları korundu."
        : "A current runtime configuration references this business. Remove that configuration reference before deleting. The business and database records were preserved."
      : tr ? "Son 5 dakika içinde çalışan bir worker bu işletmeye işaret ediyor. İşletme ve veritabanı kayıtları korundu; iş kapandıktan sonra yeniden deneyin."
        : "A running worker seen within the last 5 minutes references this business. The business and database records were preserved; retry after the work is closed.",
    external_cleanup_required: tr ? "İşletme erişime kapalı. Arşiv veya dosya temizliği doğrulanamadı; uygulama sahibinin müdahalesi gerekiyor."
      : "Business access is closed. Archive or file cleanup could not be verified; application-owner intervention is required.",
    interrupted: tr ? "İşletme erişime kapalı. Arka plan temizliği tekrar tekrar kesildi; uygulama sahibi işi yeniden denemeli."
      : "Business access is closed. Background cleanup was repeatedly interrupted; the application owner must retry the job.",
  };
  return messages[code] ?? (tr ? "İşletme silme sonucu doğrulanamadı. Listeyi yenileyerek işletmenin durumunu kontrol edin."
    : "Business deletion could not be confirmed. Refresh the business list to check its status.");
}
