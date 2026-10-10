import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, withPinnedDbClient } from "@/lib/db";
import { listUserBusinesses, findMembership } from "@/lib/access-membership";
import { archiveDigest } from "@/lib/business-archive-configuration";
import { prepareBusinessArchiveErasurePlan } from "@/lib/business-archive-erasure";
import { runBusinessArchiveErasureTick } from "@/lib/business-archive-erasure-worker";
import { enqueueBusinessDeletion, runBusinessDeletionWorkerTick } from "@/lib/business-deletion-jobs";
import { BUSINESS_ERASURE_LOCK_NAMESPACE, deleteBusinessWithData } from "@/lib/business-deletion";
import { businessArchiveFixture } from "../scripts/fixtures/business-archive-erasure";
import { addObservedProductionReferenceIndex, seedCalibration, seedGeneration, seedTenant } from "../scripts/native-storage-batch/owned-fixture";

// Only physical capacity observation is substituted. Schema, PostgreSQL locks,
// queue, source fingerprints, crypto/filesystem and deletion are real.
vi.mock("@/lib/sync/db-growth-fence", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/sync/db-growth-fence")>(),
  evaluateDbGrowthFence: vi.fn(async () => ({ allowed: false, reason: "database_budget_exceeded",
    physical: { admitted: true }, overridden: false })),
}));
const seam = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
if (seam) {
  const u = new URL(process.env.DATABASE_URL!);
  if (u.hostname !== "127.0.0.1" || ["", "5432", "15432"].includes(u.port)) throw Error("Unsafe archive erasure database");
}
let base: string, root: string; let owned: string[] = [];
async function tenant() {
  const db = getDb(), [user] = await db`INSERT INTO users(name,email,password_hash)
    VALUES('Owned archive QA',${`${randomUUID()}@example.invalid`},'fixture') RETURNING id`;
  const [business] = await db`INSERT INTO businesses(name,owner_id) VALUES('Owned archive QA',${user!.id}) RETURNING id`;
  const id = String(business!.id); owned.push(id);
  await db`INSERT INTO memberships(user_id,business_id,role,status) VALUES(${user!.id},${id},'admin','active')`;
  return { id, user: String(user!.id) };
}
async function hotInput() {
  const hash = randomBytes(32).toString("hex"), db = getDb();
  await db`INSERT INTO engine_v3_ad_decision_input_evidence(contract_version,input_hash,input_evidence_json)
    VALUES('fixture.v1',${hash},'{}'::jsonb)`;
  return (await db.query<{row_json:string}>("SELECT to_jsonb(i)::text AS row_json FROM engine_v3_ad_decision_input_evidence i WHERE contract_version='fixture.v1' AND input_hash=$1::character(64)",[hash]))[0]!.row_json;
}
async function archive(business: string, inputEvidenceRowJson?: string) {
  const f = await businessArchiveFixture(business,{inputEvidenceRowJson});
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID", f.keyId);
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX", f.key.toString("hex"));
  await mkdir(dirname(join(root,f.entry.object.key)),{recursive:true,mode:0o700});
  await writeFile(join(root,f.entry.object.key),f.bytes,{mode:0o440});
  const bytes=Buffer.from(JSON.stringify({contract:"native-historical-archive-catalog.v2",entries:[f.entry]}));
  const filename=join(root,"catalogs",`${archiveDigest(bytes)}.json`);
  await mkdir(dirname(filename),{mode:0o700});await writeFile(filename,bytes,{mode:0o600});
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH",filename);
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256",archiveDigest(bytes));
  return f;
}
describe.skipIf(!seam)("automatic archive erasure on the actual migrated PostgreSQL schema",()=>{
  beforeEach(async()=>{
    owned=[];base=await realpath(await mkdtemp(join(tmpdir(),"archive-erasure-db-")));root=join(base,"archive");
    await mkdir(root,{mode:0o700});await mkdir(join(base,"control"),{mode:0o700});
    vi.stubEnv("BUSINESS_ARCHIVE_ERASURE_ENABLED","true");vi.stubEnv("BUSINESS_ARCHIVE_ERASURE_ROLE","1");
    vi.stubEnv("ADSECUTE_SYNC_GLOBAL_ENABLED","enabled");vi.stubEnv("ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED","enabled");
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT","filesystem");vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT",root);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED","false");
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ACTIVE_POINTER",join(base,"control","active.json"));
  });
  afterEach(async()=>{
    vi.unstubAllEnvs();await rm(base,{recursive:true,force:true});
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED="enabled";process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED="enabled";
    for(const id of owned) if((await getDb().query("SELECT 1 FROM businesses WHERE id=$1::uuid",[id])).length) await deleteBusinessWithData(id);
  });
  it("stores an additive nullable checkpoint and preserves existing jobs on an idempotent enqueue",async()=>{
    const t=await tenant();await archive(t.id);const first=await enqueueBusinessDeletion(t.id),second=await enqueueBusinessDeletion(t.id);
    expect(second.attempt_id).toBe(first.attempt_id);
    const [row]=await getDb().query("SELECT archive_state,archive_attempts,erasure_started_at,hidden_at IS NOT NULL AS hidden FROM business_deletion_jobs WHERE business_ref_id=$1::uuid",[t.id]);
    expect(row).toMatchObject({archive_state:null,archive_attempts:0,erasure_started_at:null,hidden:true});
  });
  it("hides immediately, skips unprepared jobs, automatically purges archived-only hot inputs and cascades the checkpoint",async()=>{
    const t=await tenant(),input=JSON.parse(await hotInput()),f=await archive(t.id,JSON.stringify(input));
    await enqueueBusinessDeletion(t.id);
    expect((await listUserBusinesses(t.user)).some(b=>b.id===t.id)).toBe(false);expect(await findMembership({userId:t.user,businessId:t.id})).toBeNull();
    expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"idle"});
    expect(await runBusinessArchiveErasureTick()).toMatchObject({outcome:"prepared"});
    await expect(readFile(join(root,f.entry.object.key))).rejects.toMatchObject({code:"ENOENT"});
    const [checkpoint]=await getDb().query("SELECT archive_state FROM business_deletion_jobs WHERE business_ref_id=$1::uuid",[t.id]);
    expect(checkpoint!.archive_state.prepared).toBe(true);expect(checkpoint!.archive_state.plan.inputKeys[0].frozenRowSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"ok"});
    expect(await getDb().query("SELECT 1 FROM businesses WHERE id=$1::uuid",[t.id])).toEqual([]);
    expect(await getDb().query("SELECT 1 FROM business_deletion_jobs WHERE business_ref_id=$1::uuid",[t.id])).toEqual([]);
    expect(await getDb().query("SELECT 1 FROM engine_v3_ad_decision_input_evidence WHERE contract_version=$1 AND input_hash=$2::character(64)",[input.contract_version,input.input_hash])).toEqual([]);
  });
  it("preserves an archived key and foreign evaluations byte for byte when a GLOBAL hot reference still exists",async()=>{
    const t=await tenant(),db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
    try{
      await addObservedProductionReferenceIndex(db);const foreign=await seedTenant(db,1);owned.push(foreign.business);
      const producer=await seedCalibration(db,foreign,"2026-09-23","2026-09-23T12:00:00Z");
      await seedGeneration(db,foreign,{date:"2026-09-23",clock:"2026-09-23T12:01:00Z",finishedAt:"2026-09-23T12:02:00Z",producer,perAccount:[1],tag:"archive-shared"});
      const {rows:[row]}=await db.query("SELECT to_jsonb(i)::text AS row_json FROM engine_v3_ad_decision_input_evidence i JOIN engine_v3_ad_decision_evaluations e USING(contract_version,input_hash) WHERE e.business_ref_id=$1::uuid LIMIT 1",[foreign.business]);
      const evaluations=(await db.query("SELECT to_jsonb(e)::text AS bytes FROM engine_v3_ad_decision_evaluations e WHERE business_ref_id=$1::uuid ORDER BY id",[foreign.business])).rows;
      await archive(t.id,row.row_json);await enqueueBusinessDeletion(t.id);
      expect(await runBusinessArchiveErasureTick()).toMatchObject({outcome:"prepared"});expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"ok"});
      const input=JSON.parse(row.row_json);
      expect((await db.query("SELECT to_jsonb(i)::text AS row_json FROM engine_v3_ad_decision_input_evidence i WHERE contract_version=$1 AND input_hash=$2::character(64)",[input.contract_version,input.input_hash])).rows).toEqual([row]);
      expect((await db.query("SELECT to_jsonb(e)::text AS bytes FROM engine_v3_ad_decision_evaluations e WHERE business_ref_id=$1::uuid ORDER BY id",[foreign.business])).rows).toEqual(evaluations);
    }finally{await db.end();}
  });
  it("refuses newly introduced input drift after archive preparation, keeps access closed, and preserves the plan on owner retry",async()=>{
    const t=await tenant();await archive(t.id);await enqueueBusinessDeletion(t.id);expect(await runBusinessArchiveErasureTick()).toMatchObject({outcome:"prepared"});
    const [before]=await getDb().query("SELECT archive_state FROM business_deletion_jobs WHERE business_ref_id=$1::uuid",[t.id]);
    const key=before!.archive_state.plan.inputKeys[0];
    await getDb().query("INSERT INTO engine_v3_ad_decision_input_evidence(contract_version,input_hash,input_evidence_json) VALUES($1,$2::character(64),'{}'::jsonb)",[key.contractVersion,key.inputHash]);
    expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"failed"});
    const [failed]=await getDb().query("SELECT status,error_code,error_tables,archive_state FROM business_deletion_jobs WHERE business_ref_id=$1::uuid",[t.id]);
    expect(failed).toMatchObject({status:"failed",error_code:"scope_conflict",error_tables:["archived_input_source_drift"]});
    expect(await findMembership({userId:t.user,businessId:t.id})).toBeNull();await enqueueBusinessDeletion(t.id);
    const [retried]=await getDb().query("SELECT archive_state,archive_attempts,erasure_started_at FROM business_deletion_jobs WHERE business_ref_id=$1::uuid",[t.id]);
    expect(retried).toEqual({...before,archive_attempts:0,erasure_started_at:null});
  });
  it("resumes the durable plan after publication/unlink interruption without losing archived input keys",async()=>{
    const t=await tenant();await archive(t.id,await hotInput());await enqueueBusinessDeletion(t.id);
    const plan=await withPinnedDbClient(client=>prepareBusinessArchiveErasurePlan(t.id,client));
    await getDb().query("UPDATE business_deletion_jobs SET status='running',archive_attempts=1,archive_state=$2::jsonb,erasure_started_at=now() WHERE business_ref_id=$1::uuid",[t.id,JSON.stringify({plan,prepared:false})]);
    // Simulates a process loss before publication; persisted source proof must
    // be reused, not rediscovered from possibly incomplete files.
    expect(await runBusinessArchiveErasureTick()).toMatchObject({outcome:"prepared"});
    expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"ok"});
    expect(await getDb().query("SELECT 1 FROM business_deletion_jobs WHERE business_ref_id=$1::uuid",[t.id])).toEqual([]);
  });
  it("honors the shared global lock and aggregate deadline before any archive mutation",async()=>{
    const t=await tenant(),f=await archive(t.id);await enqueueBusinessDeletion(t.id);
    const blocker=new Client({connectionString:process.env.DATABASE_URL});await blocker.connect();
    try{await blocker.query("SELECT pg_advisory_lock($1::int,0)",[BUSINESS_ERASURE_LOCK_NAMESPACE]);expect(await runBusinessArchiveErasureTick()).toMatchObject({outcome:"busy"});}
    finally{await blocker.query("SELECT pg_advisory_unlock($1::int,0)",[BUSINESS_ERASURE_LOCK_NAMESPACE]);await blocker.end();}
    await getDb().query("UPDATE business_deletion_jobs SET erasure_started_at=now()-interval '31 minutes' WHERE business_ref_id=$1::uuid",[t.id]);
    expect(await runBusinessArchiveErasureTick()).toMatchObject({outcome:"failed",phase:"planning"});
    expect(await readFile(join(root,f.entry.object.key))).toEqual(f.bytes);
    await enqueueBusinessDeletion(t.id);expect(await runBusinessArchiveErasureTick()).toMatchObject({outcome:"prepared"});expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"ok"});
  });
  it("serializes whole sagas so later preparation cannot consume an earlier frozen archived-only key",async()=>{
    const first=await tenant(),second=await tenant();await archive(first.id,await hotInput());
    await enqueueBusinessDeletion(first.id);await enqueueBusinessDeletion(second.id);
    expect(await runBusinessArchiveErasureTick()).toMatchObject({outcome:"prepared"});
    expect(await runBusinessArchiveErasureTick()).toMatchObject({outcome:"awaiting_database"});
    const [waiting]=await getDb().query("SELECT archive_state FROM business_deletion_jobs WHERE business_ref_id=$1::uuid",[second.id]);
    expect(waiting!.archive_state).toBeNull();expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"ok"});
    expect(await runBusinessArchiveErasureTick()).toMatchObject({outcome:"prepared"});expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"ok"});
  });
  it("retains frozen archived-only keys when preparation is disabled for rollback and refuses unprepared persisted plans",async()=>{
    const t=await tenant(),input=JSON.parse(await hotInput());await archive(t.id,JSON.stringify(input));await enqueueBusinessDeletion(t.id);
    const plan=await withPinnedDbClient(client=>prepareBusinessArchiveErasurePlan(t.id,client));
    await getDb().query("UPDATE business_deletion_jobs SET archive_state=$2::jsonb WHERE business_ref_id=$1::uuid",[t.id,JSON.stringify({plan,prepared:false})]);
    vi.stubEnv("BUSINESS_ARCHIVE_ERASURE_ENABLED","false");
    expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"idle"});
    await expect(deleteBusinessWithData(t.id)).rejects.toMatchObject({code:"external_cleanup_required"});
    vi.stubEnv("BUSINESS_ARCHIVE_ERASURE_ENABLED","true");expect(await runBusinessArchiveErasureTick()).toMatchObject({outcome:"prepared"});
    vi.stubEnv("BUSINESS_ARCHIVE_ERASURE_ENABLED","false");expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"ok"});
    expect(await getDb().query("SELECT 1 FROM engine_v3_ad_decision_input_evidence WHERE contract_version=$1 AND input_hash=$2::character(64)",[input.contract_version,input.input_hash])).toEqual([]);
  });
});
