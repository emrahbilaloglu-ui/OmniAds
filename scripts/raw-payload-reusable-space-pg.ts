import assert from "node:assert/strict";
import type { Client } from "pg";
import { deriveRawPayloadReusableTable, RAW_PAYLOAD_REUSABLE_SPACE_SQL } from "../lib/sync/raw-payload-reusable-space";

/** Actual map SQL on an owned fixture. Never vacuum a production relation. */
export async function verifyRawPayloadReusableSpacePg(db: Client) {
  const { rows: [identity] } = await db.query("SELECT current_database() db,host(inet_server_addr()) host,inet_server_port() port");
  assert(["sync_retention_seam", "raw_payload_owned_qa"].includes(identity.db));
  assert(["127.0.0.1", "::1"].includes(identity.host) && ![5432,15432].includes(identity.port));
  await db.query("CREATE EXTENSION IF NOT EXISTS pg_freespacemap;CREATE EXTENSION IF NOT EXISTS pg_visibility");
  await db.query("CREATE TABLE public.raw_payload_map_owned(id integer PRIMARY KEY,payload text) WITH(autovacuum_enabled=false)");
  try {
    const measure = async () => {
      await db.query("BEGIN READ ONLY;SET LOCAL statement_timeout='3s'");
      try {
        const { rows: [row] } = await db.query(RAW_PAYLOAD_REUSABLE_SPACE_SQL, ["public.raw_payload_map_owned"]);
        return deriveRawPayloadReusableTable(Number(row.raw_bytes), row);
      } finally { await db.query("ROLLBACK"); }
    };
    assert.equal((await measure()).reusableBytes, 0, "empty heap must not generate negative/out-of-range blocks");
    await db.query("ALTER TABLE public.raw_payload_map_owned ALTER payload SET STORAGE PLAIN");
    await db.query("INSERT INTO public.raw_payload_map_owned SELECT g,repeat(md5(g::text),60) FROM generate_series(1,5000) g");
    await db.query("DELETE FROM public.raw_payload_map_owned WHERE id%2=0");
    assert.equal((await measure()).reusableBytes, 0, "unvacuumed dead tuples are not reusable credit");
    await db.query("VACUUM public.raw_payload_map_owned");
    const proof = await measure();
    assert.equal(proof.metric, "visible_map_free");
    assert(proof.reusableBytes > 1024 ** 2, "actual vacuum must expose reusable visible pages");
    assert.equal(proof.rawBytes - proof.effectiveBytes, proof.reusableBytes);
    const { rows: [allocated] } = await db.query("SELECT pg_total_relation_size('public.raw_payload_map_owned')::bigint raw_bytes,pg_indexes_size('public.raw_payload_map_owned')::bigint index_bytes");
    assert.equal(proof.rawBytes, Number(allocated.raw_bytes));
    assert(proof.effectiveBytes >= Number(allocated.index_bytes), "indexes remain fully charged");
  } finally { await db.query("DROP TABLE public.raw_payload_map_owned"); }
  console.log("[raw-payload-reusable-space] PASS actual read-only SQL: empty heap, no dead credit, vacuumed visible free, full index cost");
}
