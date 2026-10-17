import assert from "node:assert/strict";
import { Client } from "pg";
import { assertRawPayloadStorageReady, RAW_PAYLOAD_STORAGE_TABLES } from "../lib/sync/raw-payload-storage";
import { internRawPayloadPage } from "../lib/sync/raw-payload-compaction";

/** Real source functions and caller, restricted to the two owned seam DBs.
 * No production connection or customer fixture is accepted. */
export async function verifyRawPayloadStoragePg(db: Client) {
  const { rows: [identity] } = await db.query("SELECT current_user username,current_database() db,host(inet_server_addr()) host,inet_server_port() port");
  assert(["sync_retention_seam", "raw_payload_owned_qa"].includes(identity.db));
  assert(["127.0.0.1", "::1"].includes(identity.host) && ![5432,15432].includes(identity.port));
  await assertRawPayloadStorageReady(db);
  const payload = Array.from({ length: 400 }, (_, i) => ({ id: String(i), value: `stable-${i * 7927}-same-provider-data` }));
  for (const table of RAW_PAYLOAD_STORAGE_TABLES) {
    const fn = table === "meta_raw_snapshots" ? "adsecute_meta_raw_payload" : "adsecute_shopify_raw_payload";
    const business = "8ab00000-0000-4000-8000-000000000001", foreign = "8ab00000-0000-4000-8000-000000000002";
    const ids = [1,2,3,4,5,6,7,8].map(n => `8ac00000-0000-4000-8000-${String(n).padStart(12,"0")}`);
    // Real oldest-tail skew plus the competing production retention index:
    // a literal cutoff can prefer a tiny date range without scope bounds.
    await db.query(`CREATE INDEX IF NOT EXISTS idx_${table}_retention ON public.${table}(fetched_at,id${table==="meta_raw_snapshots"?",partition_id":""})`);
    await db.query(`INSERT INTO public.${table}(id,business_id,provider_account_id,endpoint_name,entity_scope,start_date,end_date,
      payload_json,payload_hash,fetched_at,created_at,updated_at,payload_storage_state)
      SELECT gen_random_uuid(),'raw-owner-plan-future-fixture','future-account','orders','fixture','2099-01-01','2099-01-01',
        'null'::jsonb,md5(g::text),'2099-01-01'::timestamptz+g*interval '1 second',
        '2099-01-01'::timestamptz,'2099-01-01'::timestamptz,1 FROM generate_series(1,3000)g`);
    await db.query(`ANALYZE public.${table}`);
    await db.query("BEGIN;SET LOCAL enable_seqscan=off");
    try {
      for (let i = 0; i < ids.length; i++) await db.query(`INSERT INTO public.${table}
        (id,business_id,provider_account_id,endpoint_name,entity_scope,start_date,end_date,payload_json,payload_hash,fetched_at,created_at,updated_at)
        VALUES($1::uuid,$2,$3,'orders','scope','2020-01-01','2020-01-01',$4::jsonb,$5,$6::timestamptz,$6::timestamptz,$6::timestamptz)`,
      [ids[i], i === 3 ? foreign : business, i === 4 ? "other-account" : "qa-account",
        i>=6?JSON.stringify({numeric:1,items:payload}).replace('"numeric":1,',i===7?'"numeric":1.0,':'"numeric":1,'):
          JSON.stringify(i === 1 || i === 5 ? { changed: payload } : payload),
        i>=6?"hash-numeric":i === 1 ? "hash-b" : "hash-a", `2020-01-0${i === 2 ? 9 : i+1}T01:00:00Z`]);
      const before = (await db.query(`SELECT id::text,payload_json::text payload,
        (to_jsonb(s)-ARRAY['payload_json','payload_ref_id','payload_ref_sha256','payload_storage_state'])::text metadata
        FROM public.${table} s WHERE id=ANY($1::uuid[]) ORDER BY id`, [ids])).rows;
      let converted = 0;
      // Other old owned fixtures may precede ours; keep the owned pass finite.
      for (let i = 0; i < 128; i++) {
        const result = await internRawPayloadPage(db, table); converted += result.interned;
        if (!(await db.query(`SELECT 1 FROM public.${table} WHERE id=ANY($1::uuid[]) AND payload_storage_state=0 LIMIT 1`, [ids])).rowCount) break;
      }
      assert(converted >= 1);
      const after = (await db.query(`SELECT id::text,public.${fn}(s)::text payload,
        (to_jsonb(s)-ARRAY['payload_json','payload_ref_id','payload_ref_sha256','payload_storage_state'])::text metadata
        FROM public.${table} s WHERE id=ANY($1::uuid[]) ORDER BY id`, [ids])).rows;
      assert.deepEqual(after, before, `${table}: payload or original observation bytes changed`);
      const physical = (await db.query(`SELECT id::text,payload_ref_id::text,payload_storage_state FROM public.${table} WHERE id=ANY($1::uuid[]) ORDER BY id`, [ids])).rows;
      assert.equal(physical.find(r => r.id === ids[2]).payload_ref_id, ids[0]);
      for (const i of [0,1,3,4,5,6,7]) assert.equal(physical.find(r => r.id === ids[i]).payload_ref_id, null);
      // Even an exhausted queue keeps a real date Index Cond. A volatile
      // clock_timestamp() would leave only a Filter and scan future rows.
      if(identity.db==="raw_payload_owned_qa")assert.equal((await internRawPayloadPage(db,table)).selected,0);
      // All three A→B→A clocks/IDs remain distinct. Equal hashes across scope or
      // unequal payloads never cause sharing; the actual JSONB equality rules.
      for (const [label, sql, args] of [
        ["hash drift", `UPDATE public.${table} SET payload_ref_sha256=repeat('0',64) WHERE id=$1::uuid`, [ids[2]]],
        ["foreign scope", `UPDATE public.${table} SET payload_ref_id=$2::uuid WHERE id=$1::uuid`, [ids[2],ids[3]]],
        ["nested reference", `UPDATE public.${table} SET payload_storage_state=2,payload_json='null'::jsonb,payload_ref_id=$2::uuid,payload_ref_sha256=repeat('0',64) WHERE id=$1::uuid`, [ids[0],ids[1]]],
      ] as const) {
        await db.query("SAVEPOINT drift"); await db.query(sql, [...args]);
        const refusal = await db.query(`SELECT public.${fn}(s) FROM public.${table} s WHERE id=$1::uuid`, [ids[2]])
          .then(() => null, e => e.code);
        assert.equal(refusal, "22000", label); await db.query("ROLLBACK TO SAVEPOINT drift");
      }
      await db.query("COMMIT");
      if (identity.db === "sync_retention_seam" && table === "meta_raw_snapshots") {
        const { getLatestMetaRawSnapshot } = await import("../lib/meta/warehouse");
        const { readMetaRawSnapshotAsOf } = await import("../lib/meta/raw-snapshot-observations");
        const latest = await getLatestMetaRawSnapshot({ businessId: business, providerAccountId: "qa-account", endpointName: "orders" });
        assert.equal(latest?.id,ids[2]); assert.deepEqual(latest?.payload_json,payload);
        assert.equal((await readMetaRawSnapshotAsOf({ businessId:business,providerAccountId:"qa-account",endpointName:"orders",asOf:"2020-01-03T00:00:00Z" }))?.snapshotId,ids[1]);
        assert.equal((await readMetaRawSnapshotAsOf({ businessId:business,providerAccountId:"qa-account",endpointName:"orders",asOf:"2020-01-10T00:00:00Z" }))?.snapshotId,ids[2]);
      }
      if(identity.db==="sync_retention_seam"&&table==="shopify_raw_snapshots") {
        const {readShopifyRawSnapshotOriginal}=await import("../lib/shopify/warehouse");
        const original=await readShopifyRawSnapshotOriginal({businessId:business,providerAccountId:"qa-account",snapshotId:ids[2]!});
        assert.equal(original?.id,ids[2]);assert.deepEqual(original?.payload_json,payload);
        assert.equal(await readShopifyRawSnapshotOriginal({businessId:foreign,providerAccountId:"qa-account",snapshotId:ids[2]!}),null);
      }
      const competitor=new Client({host:identity.host,port:identity.port,database:identity.db,user:identity.username});
      await competitor.connect();
      try {
        await db.query("BEGIN");
        await db.query(`SELECT id FROM public.${table} WHERE id=$1::uuid FOR KEY SHARE`,[ids[0]]);
        await competitor.query("BEGIN;SET LOCAL lock_timeout='100ms'");
        assert.equal(await competitor.query(`DELETE FROM public.${table} WHERE id=$1::uuid`,[ids[0]])
          .then(()=>null,e=>e.code),"55P03","concurrent retention bypassed the actual owner key-share lock");
        await competitor.query("ROLLBACK");await db.query("ROLLBACK");
      } finally {await competitor.end();}
      const deletionRefusal = await db.query(`DELETE FROM public.${table} WHERE id=$1::uuid`, [ids[0]])
        .then(() => null, e => e.code);
      assert.equal(deletionRefusal, "23503", `${table}: owner collected while still referenced`);
      // Business offboarding may delete roots before their aliases, provided
      // the existing transaction removes the whole business before COMMIT.
      await db.query("BEGIN");
      await db.query(`DELETE FROM public.${table} WHERE id=$1::uuid`, [ids[0]]);
      await db.query(`DELETE FROM public.${table} WHERE business_id=$1`, [business]);
      await db.query("COMMIT");
      assert.equal((await db.query(`SELECT 1 FROM public.${table} WHERE business_id=$1`, [business])).rowCount, 0);
      assert.equal((await db.query(`SELECT public.${fn}(s) FROM public.${table} s WHERE id=$1::uuid`, [ids[3]])).rowCount, 1);
      await db.query(`DELETE FROM public.${table} WHERE id=$1::uuid`, [ids[3]]);
      await db.query(`DELETE FROM public.${table} WHERE business_id='raw-owner-plan-future-fixture'`);
    } catch (e) { await db.query("ROLLBACK"); throw e; }
  }
  console.log("[raw-payload-storage] PASS real caller: A-B-A original bytes/IDs/clocks, scope/hash/nesting refusal, pinned owner and deferred whole-business erasure");
}
