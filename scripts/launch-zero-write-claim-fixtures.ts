/** Actual store transitions against temporary PostgreSQL tables in one seam transaction. */
import {
  markMetaLaunchIntentExecuting,
  restoreMetaLaunchIntentBeforeProviderMutation,
} from "@/lib/launchpad/meta-launch-intent-store";

type Query = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

export async function verifyLaunchZeroWriteClaimFixtures(query: Query): Promise<number> {
  await query("SET LOCAL TIME ZONE 'UTC'");
  await query(`CREATE TEMP TABLE meta_launch_intents (
    id UUID, business_id UUID, request_fingerprint TEXT, status TEXT,
    started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
    result_receipt_json JSONB, error_receipt_json JSONB, activation_approval_json JSONB
  ) ON COMMIT DROP`);
  await query(`CREATE TEMP TABLE meta_ads_action_log (
    id UUID, business_id UUID, launch_intent_id UUID, status TEXT,
    error_code TEXT, payload_response JSONB, resulting_ad_id TEXT,
    verification_payload JSONB, verified_at TIMESTAMPTZ
  ) ON COMMIT DROP`);
  const businessId = "c9b20000-0000-4000-8000-000000000001";
  const id = "c9b20000-0000-4000-8000-000000000002";
  const logId = "c9b20000-0000-4000-8000-000000000003";
  const otherLogId = "c9b20000-0000-4000-8000-000000000004";
  const fullPrecision = "2026-09-06 10:00:00.123456+00";
  let cases = 0;
  const fail = (message: string) => { throw new Error(`Launch zero-write claim: ${message}`); };
  async function reset() {
    await query("TRUNCATE pg_temp.meta_launch_intents, pg_temp.meta_ads_action_log");
    await query(`INSERT INTO pg_temp.meta_launch_intents
      (id,business_id,request_fingerprint,status,started_at,activation_approval_json)
      VALUES ($1,$2,'fingerprint','executing',$3,'{"revokedAt":"later-edit"}')`, [id, businessId, fullPrecision]);
    await query(`INSERT INTO pg_temp.meta_ads_action_log
      (id,business_id,launch_intent_id,status,error_code,payload_response)
      VALUES ($1,$2,$3,'failure','provider_mutation_withheld','{"provider_mutation_attempted":false}')`, [logId, businessId, id]);
  }
  const restore = (overrides: Partial<Parameters<typeof restoreMetaLaunchIntentBeforeProviderMutation>[0]> = {}) =>
    restoreMetaLaunchIntentBeforeProviderMutation({ businessId, id, requestFingerprint: "fingerprint",
      startedAt: fullPrecision, refusedActionLogId: logId, ...overrides });

  await reset();
  await query("UPDATE pg_temp.meta_launch_intents SET status='ready', started_at=NULL");
  const claimed = await markMetaLaunchIntentExecuting({ businessId, id });
  if (typeof claimed.startedAt !== "string") fail("claim must return full-precision text, not pg's Date");
  const exact = await query("SELECT started_at = $1::timestamptz AS exact FROM pg_temp.meta_launch_intents", [claimed.startedAt]);
  if (exact[0]?.exact !== true) fail("returned claim lost timestamp precision");
  let duplicateClaimed = false;
  try { await markMetaLaunchIntentExecuting({ businessId, id }); duplicateClaimed = true; } catch { /* expected */ }
  if (duplicateClaimed) fail("a second executor claimed the executing intent");
  cases += 1;

  await reset();
  const restored = await restore();
  if (restored.status !== "ready" || restored.startedAt !== null) fail("owned zero-write claim did not restore");
  if ((restored.activationApproval as { revokedAt?: string })?.revokedAt !== "later-edit") fail("restoration erased an approval edit");
  // One next claim is admitted; the first claim's version cannot restore it.
  await markMetaLaunchIntentExecuting({ businessId, id });
  let staleRestored = false;
  try { await restore(); staleRestored = true; } catch { /* expected */ }
  if (staleRestored) fail("stale executor restored a newer claim");
  cases += 1;

  const guards: Array<{ label: string; mutate?: () => Promise<unknown>; override?: Parameters<typeof restore>[0] }> = [
    { label: "millisecond-truncated claim", override: { startedAt: "2026-09-06T10:00:00.123Z" } },
    { label: "wrong business", override: { businessId: "c9b20000-0000-4000-8000-000000000099" } },
    { label: "different payload", override: { requestFingerprint: "different" } },
    { label: "missing refused log", override: { refusedActionLogId: otherLogId } },
    { label: "unsettled log", mutate: () => query("UPDATE pg_temp.meta_ads_action_log SET status='pending'") },
    { label: "ambiguous log", mutate: () => query("UPDATE pg_temp.meta_ads_action_log SET status='silent_failure',error_code='provider_outcome_ambiguous'") },
    { label: "attempted provider write", mutate: () => query("UPDATE pg_temp.meta_ads_action_log SET payload_response='{\"provider_mutation_attempted\":true}'") },
    { label: "unproven no-write log", mutate: () => query("UPDATE pg_temp.meta_ads_action_log SET payload_response=NULL") },
    { label: "returned provider identity", mutate: () => query("UPDATE pg_temp.meta_ads_action_log SET resulting_ad_id='provider-ad'") },
    { label: "provider verification", mutate: () => query("UPDATE pg_temp.meta_ads_action_log SET verification_payload='{}'") },
    { label: "existing result receipt", mutate: () => query("UPDATE pg_temp.meta_launch_intents SET result_receipt_json='{\"campaignId\":\"provider-campaign\"}'") },
    { label: "existing ambiguous receipt", mutate: () => query("UPDATE pg_temp.meta_launch_intents SET error_receipt_json='{\"code\":\"provider_outcome_ambiguous\"}'") },
    { label: "other pending action", mutate: () => query(`INSERT INTO pg_temp.meta_ads_action_log
      (id,business_id,launch_intent_id,status) VALUES ($1,$2,$3,'pending')`, [otherLogId, businessId, id]) },
  ];
  for (const guard of guards) {
    await reset();
    await guard.mutate?.();
    let wronglyRestored = false;
    try { await restore(guard.override); wronglyRestored = true; } catch { /* expected refused CAS */ }
    if (wronglyRestored) fail(`${guard.label} was requeued`);
    const [row] = await query("SELECT status, started_at::text FROM pg_temp.meta_launch_intents");
    if (row?.status !== "executing" || row.started_at !== fullPrecision) fail(`${guard.label} altered the held claim`);
    cases += 1;
  }
  return cases;
}
