import { Client } from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildNativeEvidenceArchive, openNativeEvidenceArchive, NATIVE_ARCHIVE_TABLES,
  buildNativeSupersededEvidenceArchive, openNativeSupersededEvidenceArchive,
  type NativeArchiveBundle, type NativeArchiveSchema } from "@/lib/creative-decision-engine/native-evidence-archive";
import { prepareNativeArchivePinFixtureLeaves, readSupersededFixturePinCensus } from "./native-archive-pin-census-seam";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`native archive seam FAILED: ${message}`);
}
function identifier(value: string): string {
  assert(/^[a-z_][a-z0-9_]*$/.test(value), "unexpected catalog identifier");
  return `"${value}"`;
}
/** Called only from the owned ephemeral native producer seam. Never uses DATABASE_URL. */
export async function verifyNativeArchiveRoundTrip(client: Client, businessId: string, superseded = false) {
  const connection = (client as Client & { connectionParameters: { database: string; host: string; port: number } }).connectionParameters;
  assert(connection.database === "native_ad_seam" && connection.host === "127.0.0.1" &&
    ![5432, 15432].includes(connection.port), "not the isolated native seam server");
  const core = [...NATIVE_ARCHIVE_TABLES];
  if (superseded) await prepareNativeArchivePinFixtureLeaves(client, "public");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout='7500ms'");
  let built: ReturnType<typeof buildNativeEvidenceArchive>;
  let allParents: { name: string; rowJson: string[] }[];
  let foreignKeys: { name: string; childTable: string; parentTable: string; definition: string }[];
  try {
    const [generation] = (await client.query(superseded ? `SELECT j.id,j.as_of_date::text,j.engine_version
      FROM engine_v3_job_runs j WHERE j.business_ref_id=$1::uuid AND j.status='success'
        AND j.job_name='engine_v3_native_ad_decisions_shadow_job' AND j.row_count>0
        AND j.row_count=(SELECT count(*) FROM engine_v3_ad_decision_evaluations e WHERE e.job_run_id=j.id)
        AND NOT EXISTS (SELECT 1 FROM engine_v3_ad_decision_snapshots_daily s WHERE s.job_run_id=j.id)
        AND EXISTS (SELECT 1 FROM engine_v3_job_runs later WHERE later.business_ref_id=j.business_ref_id
          AND later.as_of_date=j.as_of_date AND later.engine_version=j.engine_version
          AND later.job_name=j.job_name AND later.status='success' AND later.finished_at>j.finished_at)
      ORDER BY j.finished_at LIMIT 1` : `SELECT j.id, j.as_of_date::text, j.engine_version
      FROM engine_v3_job_runs j JOIN engine_v3_ad_decision_snapshots_daily s ON s.job_run_id=j.id
      WHERE j.business_ref_id=$1::uuid AND j.status='success'
        AND j.job_name='engine_v3_native_ad_decisions_shadow_job'
      GROUP BY j.id HAVING count(*)=j.row_count AND j.row_count>0
      ORDER BY j.finished_at DESC LIMIT 1`, [businessId])).rows;
    assert(generation, "no complete original fixture generation");
    const columns = (await client.query(`SELECT c.relname AS table, a.attname AS name,
      format_type(a.atttypid,a.atttypmod) AS type, NOT a.attnotnull AS nullable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attnum`, [core])).rows;
    const catalogFks = (await client.query(`SELECT con.conname AS name, child.relname AS "childTable",
      parent.relname AS "parentTable", pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid
      JOIN pg_class parent ON parent.oid=con.confrelid
      JOIN pg_namespace n ON n.oid=child.relnamespace
      WHERE con.contype='f' AND n.nspname='public'
      ORDER BY child.relname,con.conname`)).rows as typeof foreignKeys;
    const closure = new Set<string>(core);
    for (let previous = -1; previous !== closure.size;) {
      previous = closure.size;
      for (const fk of catalogFks) if (closure.has(fk.childTable)) closure.add(fk.parentTable);
    }
    foreignKeys = catalogFks.filter(fk => closure.has(fk.childTable));
    const schema: NativeArchiveSchema = {
      tables: core.map(table => ({ table, columns: columns.filter(c => c.table === table)
        .map(c => ({ name: c.name as string, type: c.type as string, nullable: c.nullable as boolean })) })),
      // Include incoming catalog pins too. They are not migrated by a core-only bundle.
      foreignKeys: catalogFks.filter(fk => core.includes(fk.childTable as typeof core[number]) || core.includes(fk.parentTable as typeof core[number]))
        .map(({ childTable, parentTable, definition }) => ({ childTable, parentTable, definition })),
    };
    const tables = [];
    for (const table of core) {
      const predicate = table === "engine_v3_job_runs" ? "t.id=$1::uuid" :
        table === "engine_v3_ad_decision_input_evidence" ? `(t.contract_version,t.input_hash) IN
          (SELECT contract_version,input_hash FROM engine_v3_ad_decision_evaluations WHERE job_run_id=$1::uuid)` : "t.job_run_id=$1::uuid";
      const rows = (await client.query(`SELECT to_jsonb(t)::text AS bytes FROM public.${identifier(table)} t WHERE ${predicate}`, [generation.id])).rows;
      tables.push({ table, rowJson: rows.map(r => r.bytes as string) });
    }
    allParents = [];
    for (const name of [...closure].filter(n => !core.includes(n as typeof core[number]))) {
      const rows = (await client.query(`SELECT to_jsonb(t)::text AS bytes FROM public.${identifier(name)} t`)).rows;
      allParents.push({ name, rowJson: rows.map(r => r.bytes as string) });
    }
    const input = { generation: { businessId, jobRunId: generation.id,
      asOfDate: generation.as_of_date, engineVersion: generation.engine_version },
      capturedAt: (await client.query("SELECT transaction_timestamp()::text AS captured")).rows[0].captured,
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      sourceWorkspaceDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
      schema, tables };
    if (superseded) {
      // This local core copy is not a candidate for removal: shared evidence may
      // still be live. The separate census seam proves every pin veto. Real
      // same-day producer jobs and exact core bytes are retained here.
      const pinCensus = await readSupersededFixturePinCensus(client, input.generation);
      assert(pinCensus, "superseded historical census absent");
      input.capturedAt = pinCensus.observedAt;
      built = buildNativeSupersededEvidenceArchive({ ...input, pinCensus });
    } else built = buildNativeEvidenceArchive(input);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-native-core-archive-"));
  const schemaName = superseded ? "native_superseded_restore_fixture" : "native_archive_restore_fixture";
  try {
    const file = path.join(temp, "bundle.json");
    fs.writeFileSync(file, JSON.stringify(built.bundle), { mode: 0o600 });
    const downloaded = JSON.parse(fs.readFileSync(file, "utf8")) as NativeArchiveBundle;
    const expected = { manifestHash: built.manifestHash, schemaHash: built.bundle.manifest.schemaHash,
      generation: built.bundle.manifest.generation };
    const reader = superseded ? openNativeSupersededEvidenceArchive(downloaded, expected) : openNativeEvidenceArchive(downloaded, expected);
    assert(reader.providerAuthority === false && reader.reclaimEligible === false, "archive granted authority/reclaim");
    await client.query("BEGIN");
    try {
      await client.query(`CREATE SCHEMA ${identifier(schemaName)}`);
      for (const name of [...allParents.map(t => t.name), ...core]) {
        await client.query(`CREATE TABLE ${identifier(schemaName)}.${identifier(name)}
          (LIKE public.${identifier(name)} INCLUDING ALL)`);
      }
      // This is sandbox prerequisite setup, not part of the archive or a full-DB restore claim.
      const inserts = [...allParents, ...core.map(name => ({ name, rowJson: reader.readTable(name).map(r => r.rowJson) }))];
      for (const table of inserts) {
        if (!table.rowJson.length) continue;
        const relation = `${identifier(schemaName)}.${identifier(table.name)}`;
        await client.query(`INSERT INTO ${relation} SELECT * FROM jsonb_populate_recordset(NULL::${relation},$1::jsonb)`,
          [`[${table.rowJson.join(",")}]`]);
      }
      for (const fk of foreignKeys) {
        const definition = fk.definition.replace(/REFERENCES (?:public\.)?"?[a-z_][a-z0-9_]*"?\s*\(/,
          `REFERENCES ${identifier(schemaName)}.${identifier(fk.parentTable)} (`);
        assert(definition !== fk.definition, "FK was not rebound to isolated restore schema");
        await client.query(`ALTER TABLE ${identifier(schemaName)}.${identifier(fk.childTable)} ADD CONSTRAINT ${identifier(fk.name)} ${definition} NOT VALID`);
        await client.query(`ALTER TABLE ${identifier(schemaName)}.${identifier(fk.childTable)} VALIDATE CONSTRAINT ${identifier(fk.name)}`);
      }
      for (const table of core) {
        const restored = (await client.query(`SELECT to_jsonb(t)::text AS bytes FROM ${identifier(schemaName)}.${identifier(table)} t`)).rows.map(r => r.bytes as string).sort();
        const original = reader.readTable(table).map(r => r.rowJson).sort();
        assert(JSON.stringify(restored) === JSON.stringify(original), `${table} exact full-row/clock/hash parity failed`);
      }
      // Test child-lineage rejection and parent-delete RESTRICT separately.
      // The original bulk UPDATE changed every unique evaluation_id to one ID;
      // its first failure can be a uniqueness check, not the intended FK check.
      const snapshots = `${identifier(schemaName)}.engine_v3_ad_decision_snapshots_daily`;
      const evaluations = `${identifier(schemaName)}.engine_v3_ad_decision_evaluations`;
      if (!superseded) {
      const snapshot = JSON.parse(reader.readTable("engine_v3_ad_decision_snapshots_daily")[0]!.rowJson);
      const foreignId = "00000000-0000-4000-8000-999999999999";
      assert((await client.query(`SELECT count(*)::int AS count FROM ${snapshots} WHERE id=$1::uuid`, [snapshot.id])).rows[0].count === 1,
        "child fault probe must select exactly one restored snapshot");
      assert((await client.query(`SELECT count(*)::int AS count FROM ${evaluations} WHERE id=$1::uuid`, [foreignId])).rows[0].count === 0,
        "foreign evaluation probe identity already exists");
      const probe = async (name: string, sql: string, values: string[], expectedCode: string) => {
        await client.query("SAVEPOINT archive_fault_probe");
        let code: string | undefined, constraint: string | undefined, rowCount: number | null = null;
        try {
          rowCount = (await client.query(sql, values)).rowCount;
        } catch (error) {
          ({ code, constraint } = error as { code?: string; constraint?: string });
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT archive_fault_probe");
          await client.query("RELEASE SAVEPOINT archive_fault_probe");
        }
        console.log(`[native-archive-seam] fault ${JSON.stringify({ name, code: code ?? null, constraint: constraint ?? null, rowCount })}`);
        assert(code === expectedCode, `${name}: expected SQLSTATE${expectedCode}, received ${code ?? `accepted (${rowCount} rows)`}`);
      };
      assert(reader.readTable("engine_v3_ad_decision_snapshots_daily").length > 1,
        "bulk-UPDATE diagnosis requires multiple unique snapshot evaluations");
      await probe("original_bulk_update_shape", `UPDATE ${snapshots} SET evaluation_id=$1::uuid`, [foreignId], "23505");
      await probe("single_child_foreign_evaluation", `UPDATE ${snapshots} SET evaluation_id=$1::uuid WHERE id=$2::uuid`,
        [foreignId, snapshot.id], "23503");
      await probe("parent_delete_restrict", `DELETE FROM ${evaluations} WHERE id=$1::uuid`, [snapshot.evaluation_id], "23503");
      }
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    }
    console.log(`[native-archive-seam] PASS: serialized ${superseded ? "superseded zero-serving-snapshot" : "last-served"} core bundle/trusted digest, ${reader.readTable("engine_v3_ad_decision_evaluations").length} real producer evaluations, five-table exact JSONB/clock/hash parity, ${foreignKeys.length} outgoing actual FKs rebound/validated with copied sandbox parents. Incoming migration/independent parent completeness/eviction/reader-switch/physical reclaim NOT proven. manifest=${built.manifestHash}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
