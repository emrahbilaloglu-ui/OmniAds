/** Actual native projection SQL against isolated PostgreSQL temp tables.
 * The canonical decision/launch child calls this inside its own transaction.
 */
import { NATIVE_AD_PAUSE_PROJECTION_SQL } from "@/lib/meta/automation-proposals";

type Query = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

export async function verifyNativeProposalLifecycleFixtures(query: Query): Promise<number> {
  const business = "c9a30000-0000-4000-8000-0000000000b1";
  const otherBusiness = "c9a30000-0000-4000-8000-0000000000b2";
  const account = "act_native_1";
  const otherAccount = "act_native_2";
  const day = "2026-09-06";
  const marker = "native_ad_decision_withdrawn";
  let assertions = 0;
  function equal(actual: unknown, expected: unknown, label: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    assertions += 1;
  }
  await query(`CREATE TEMP TABLE engine_v3_ad_decision_snapshots_daily (
    id UUID DEFAULT gen_random_uuid(), evaluation_id UUID DEFAULT gen_random_uuid(),
    business_id TEXT, provider_account_id TEXT, ad_id TEXT, creative_id TEXT,
    as_of_date DATE, computed_at TIMESTAMPTZ, engine_version TEXT, label TEXT,
    authorized_action TEXT, reason TEXT, decision_hash TEXT, roas NUMERIC,
    spend NUMERIC, effective_target_roas NUMERIC
  ) ON COMMIT DROP`);
  await query(`CREATE TEMP TABLE meta_ad_dimensions (
    business_id TEXT, provider_account_id TEXT, ad_id TEXT, ad_name_current TEXT,
    ad_status TEXT, UNIQUE(business_id, provider_account_id, ad_id)
  ) ON COMMIT DROP`);
  await query(`CREATE TEMP TABLE meta_automation_proposals (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY, business_id UUID,
    provider_account_id TEXT, origin TEXT, decision_key TEXT, scope_type TEXT,
    scope_id TEXT, rec_id TEXT, rec_type TEXT, snapshot_date DATE,
    engine_version TEXT, decision_label TEXT, proposed_action TEXT,
    action_label TEXT, primary_caption TEXT, entity_label TEXT, reason TEXT,
    evidence_label TEXT, evidence_ref JSONB, expires_at TIMESTAMPTZ,
    status TEXT, decision_note TEXT, claim_token UUID, claimed_at TIMESTAMPTZ,
    claimed_by UUID, dispatch_started_at TIMESTAMPTZ, decided_by UUID,
    decided_at TIMESTAMPTZ, receipt_json JSONB, updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(business_id, provider_account_id, decision_key, rec_type, snapshot_date),
    CHECK(reason IS DISTINCT FROM 'fixture-insert-failure')
  ) ON COMMIT DROP`);
  await query(`CREATE UNIQUE INDEX native_fixture_open_slot ON meta_automation_proposals
    (business_id, provider_account_id, decision_key, proposed_action)
    WHERE status IN ('pending', 'claimed', 'reconcile')`);

  let version = 0;
  async function decision(ad: string, label: string, options: {
    accountId?: string; authorized?: string | null; reason?: string;
  } = {}) {
    version += 1;
    const providerAccountId = options.accountId ?? account;
    await query(`INSERT INTO pg_temp.meta_ad_dimensions VALUES ($1,$2,$3,$3,'ACTIVE')
      ON CONFLICT DO NOTHING`, [business, providerAccountId, ad]);
    const rows = await query(`INSERT INTO pg_temp.engine_v3_ad_decision_snapshots_daily (
      business_id, provider_account_id, ad_id, creative_id, as_of_date,
      computed_at, engine_version, label, authorized_action, reason, decision_hash,
      roas, spend, effective_target_roas
    ) VALUES ($1,$2,$3,$4,$5,'2026-09-06'::timestamptz + $6::int * interval '1 hour',
      $7,$8,$9,$10,$11,0.5,100,2.2) RETURNING id::text, evaluation_id::text`,
    [business, providerAccountId, ad, `creative-${version}`, day, version,
      `engine-${version}`, label, options.authorized === undefined ? label : options.authorized,
      options.reason ?? `reason-${version}`, `hash-${version}`]);
    return { id: rows[0]!.id, evaluation_id: rows[0]!.evaluation_id, version };
  }
  const run = (providerAccountId: string | null = account) =>
    query(NATIVE_AD_PAUSE_PROJECTION_SQL, [business, day, "Approve & apply", "24 hours", providerAccountId]);
  async function proposal(ad: string, providerAccountId = account) {
    return (await query(`SELECT *, id::text AS id, rec_id::text AS rec_id
      FROM pg_temp.meta_automation_proposals WHERE business_id=$1::uuid
      AND provider_account_id=$2 AND decision_key=$3 AND snapshot_date=$4::date`,
    [business, providerAccountId, `ad:${ad}`, day]))[0];
  }

  await decision("cycle", "cut");
  equal((await run()).length, 1, "initial cut offered");
  const originalId = (await proposal("cycle")).id;
  const refreshed = await decision("cycle", "cut");
  await run();
  let current = await proposal("cycle");
  equal([current.id, current.rec_id, current.engine_version],
    [originalId, refreshed.evaluation_id, `engine-${refreshed.version}`], "top-level lineage refreshed");
  equal([(current.evidence_ref as Record<string, unknown>).snapshotId,
    (current.evidence_ref as Record<string, unknown>).evaluationId,
    (current.evidence_ref as Record<string, unknown>).decisionHash,
    (current.evidence_ref as Record<string, unknown>).creativeId,
    (current.evidence_ref as Record<string, unknown>).engineVersion],
  [refreshed.id, refreshed.evaluation_id, `hash-${refreshed.version}`,
    `creative-${refreshed.version}`, `engine-${refreshed.version}`], "evidence identity matches refreshed lineage");

  await decision("cycle", "keep");
  equal((await run()).length, 0, "latest keep wins over an older cut from another engine version");
  current = await proposal("cycle");
  equal([current.status, current.decision_note], ["expired", marker], "old pending cut withdrawn");
  const returned = await decision("cycle", "cut");
  await run();
  current = await proposal("cycle");
  equal([current.id, current.status, current.decision_note, current.rec_id],
    [originalId, "pending", null, returned.evaluation_id], "same-day cut reappears on its original unique row");
  await decision("cycle", "watch", { authorized: "cut" });
  await run();
  equal((await proposal("cycle")).status, "expired", "watch is not an authorized cut label");
  await decision("cycle", "cut", { authorized: null });
  await run();
  equal((await proposal("cycle")).status, "expired", "withheld cut authority does not re-offer");
  await decision("cycle", "cut");
  await run();
  await run();
  equal((await proposal("cycle")).status, "pending", "second return and rerun preserve pending offer");
  equal((await query("SELECT count(*)::int AS n FROM pg_temp.meta_automation_proposals"))[0]?.n, 1,
    "withdrawal/reappearance never duplicates the projection key");

  await decision("cycle", "cut", { accountId: otherAccount });
  await run(otherAccount);
  await decision("cycle", "keep");
  await run();
  equal([(await proposal("cycle")).status, (await proposal("cycle", otherAccount)).status],
    ["expired", "pending"], "account-scoped withdrawal preserves the other account's same ad id");

  // The full tuple and state are copied before and after the next projection.
  // These rows cover other business/day, manual origin, terminal states and
  // outstanding provider outcomes, even when their old cut has disappeared.
  const preserved = ["claimed", "reconcile", "approved", "dismissed", "modified", "failed", "expired"];
  for (const status of preserved) {
    await decision(`preserve-${status}`, "cut");
    await run();
    await query("UPDATE pg_temp.meta_automation_proposals SET status=$2 WHERE decision_key=$1", [`ad:preserve-${status}`, status]);
    await decision(`preserve-${status}`, "keep");
  }
  await query(`INSERT INTO pg_temp.meta_automation_proposals (
    business_id,provider_account_id,origin,decision_key,scope_type,scope_id,
    rec_type,snapshot_date,proposed_action,status,expires_at
  ) VALUES
    ($1,$3,'engine_decision','ad:other-day','ad','other-day','native_ad_cut','2026-09-05','pause','pending',now()+interval '1 day'),
    ($2,$3,'engine_decision','ad:other-business','ad','other-business','native_ad_cut',$4,'pause','pending',now()+interval '1 day'),
    ($1,$3,'operator_action','ad:manual','ad','manual','native_ad_cut',$4,'pause','pending',now()+interval '1 day')`,
  [business, otherBusiness, account, day]);
  const preservedRows = () => query(`SELECT to_jsonb(p) AS row FROM pg_temp.meta_automation_proposals p
    WHERE decision_key <> 'ad:cycle' ORDER BY decision_key`);
  const before = await preservedRows();
  await run();
  equal(await preservedRows(), before, "claimed/reconcile/terminal/manual/other-business/day rows remain byte-equivalent");
  for (const status of preserved) await decision(`preserve-${status}`, "cut");
  await run();
  equal(await preservedRows(), before, "returning cuts cannot revive operator decisions or generic expired rows");

  // A same-day native cut is still blocked by an unresolved prior-day pause.
  await query(`INSERT INTO pg_temp.meta_automation_proposals (
    business_id,provider_account_id,origin,decision_key,scope_type,scope_id,
    rec_type,snapshot_date,proposed_action,status,receipt_json
  ) VALUES ($1,$2,'engine_decision','ad:unresolved','ad','unresolved','native_ad_cut','2026-09-05','pause','reconcile','{"unknown":true}')`, [business, account]);
  await decision("unresolved", "cut");
  await run();
  equal(await proposal("unresolved"), undefined, "prior-day reconcile keeps its open slot");

  await decision("missing", "cut");
  await run();
  await query("DELETE FROM pg_temp.engine_v3_ad_decision_snapshots_daily WHERE ad_id='missing'");
  await run();
  equal((await proposal("missing")).status, "expired", "successfully observed source absence withdraws its pending cut");

  await decision("attempted-marker", "cut");
  await run();
  await decision("attempted-marker", "keep");
  await run();
  await query(`UPDATE pg_temp.meta_automation_proposals SET dispatch_started_at=now(),
    receipt_json='{"unknown":true}' WHERE decision_key='ad:attempted-marker'`);
  const attempted = await proposal("attempted-marker");
  await decision("attempted-marker", "cut");
  await run();
  equal(await proposal("attempted-marker"), attempted, "a withdrawal marker cannot revive provider-attempt history");

  await decision("rollback", "cut");
  await run();
  await decision("rollback", "keep");
  const beforeFailure = await proposal("rollback");
  await query("SAVEPOINT native_read_failure");
  await query("ALTER TABLE pg_temp.engine_v3_ad_decision_snapshots_daily RENAME COLUMN decision_hash TO unreadable_hash");
  let readFailed = false;
  try { await run(); } catch { readFailed = true; }
  await query("ROLLBACK TO SAVEPOINT native_read_failure");
  equal(readFailed, true, "unreadable source query rejects");
  equal(await proposal("rollback"), beforeFailure, "unreadable source retires no pending row");

  await decision("insert-failure", "cut", { reason: "fixture-insert-failure" });
  await query("SAVEPOINT native_write_failure");
  let writeFailed = false;
  try { await run(); } catch { writeFailed = true; }
  await query("ROLLBACK TO SAVEPOINT native_write_failure");
  equal(writeFailed, true, "late insert constraint failure rejects the projection");
  equal(await proposal("rollback"), beforeFailure, "withdrawal rolls back with a failed re-offer write");
  await decision("insert-failure", "keep");
  await run();
  equal((await proposal("rollback")).status, "expired", "retry completes withdrawal after storage recovery");
  return assertions;
}
