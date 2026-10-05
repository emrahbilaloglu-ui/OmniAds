import { randomUUID } from "node:crypto";
import { NATIVE_REFERENCE_ARCHIVE_TABLES } from "../../lib/creative-decision-engine/native-evidence-archive";
import { NATIVE_CALIBRATION_PARENT_TABLES } from "../../lib/creative-decision-engine/native-calibration-parent-archive";
import type { reassembleNativeReferenceArchive } from "../../lib/creative-decision-engine/native-reference-archive-segments";
import { UNIT_TABLES, ident, need, rowSetHash, same } from "./common";
import type { Q, UnitConfig } from "./capture";

/** Generic port of the reviewed D5 independent restore (FK-key-order corrected
 * schema-columns/schema-fks semantics). The caller owns a NEW credential-free
 * database that was migrated by the real run-migrations; this function never
 * connects to the source, writes files or drops anything. */
function canonicalColumns(columns: unknown) {
  if (!Array.isArray(columns) || !columns.length) return null;
  const seen = new Set<string>(), out: { name: string; type: string; nullable: boolean }[] = [];
  for (const c of columns as Record<string, unknown>[]) {
    if (!c || Object.keys(c).sort().join(",") !== "name,nullable,type" || typeof c.name !== "string" ||
        !/^[a-z_][a-z0-9_]*$/.test(c.name) || typeof c.type !== "string" || !c.type || typeof c.nullable !== "boolean" ||
        seen.has(c.name)) return null;
    seen.add(c.name); out.push({ name: c.name, type: c.type, nullable: c.nullable });
  }
  return out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
export const sameNamedColumnSchema = (a: unknown, b: unknown) => {
  const x = canonicalColumns(a), y = canonicalColumns(b); return x !== null && y !== null && same(x, y);
};
function fkTuples(rows: unknown) {
  if (!Array.isArray(rows)) return null;
  const out: string[][] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || Object.keys(r).sort().join(",") !== "childTable,definition,parentTable" || typeof r.childTable !== "string" ||
        !/^[a-z_][a-z0-9_]*$/.test(r.childTable) || typeof r.parentTable !== "string" || !/^[a-z_][a-z0-9_]*$/.test(r.parentTable) ||
        typeof r.definition !== "string" || !r.definition) return null;
    out.push([r.childTable, r.parentTable, r.definition]);
  }
  return out;
}
export const sameForeignKeySchema = (a: unknown, b: unknown) => {
  const x = fkTuples(a), y = fkTuples(b); return x !== null && y !== null && same(x, y);
};

export async function restoreIntoOwnedNewDatabase(db: Q, whole: ReturnType<typeof reassembleNativeReferenceArchive>,
  config: UnitConfig) {
  const { bundle, view } = whole;
  need(view.providerAuthority === false && view.reclaimEligible === false && bundle.manifest.sourceWorkspaceDirty === false,
    "TRUSTED_FALSE_AUTHORITY_REQUIRED");
  const names = [...new Set([...NATIVE_REFERENCE_ARCHIVE_TABLES, ...NATIVE_CALIBRATION_PARENT_TABLES])] as string[];
  const columns = (await db.query(`SELECT c.relname "table",a.attname name,format_type(a.atttypid,a.atttypmod) type,NOT a.attnotnull nullable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`, [names])).rows;
  const fks = (await db.query(`SELECT child.relname "childTable",parent.relname "parentTable",pg_get_constraintdef(con.oid) definition FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid JOIN pg_class parent ON parent.oid=con.confrelid JOIN pg_namespace n ON n.oid=child.relnamespace WHERE n.nspname='public' AND child.relname=ANY($1::text[]) AND con.contype='f' ORDER BY child.relname,con.conname`, [names])).rows;
  for (const schema of [bundle.core.manifest.schema, bundle.manifest.schema] as { tables: { table: string; columns: unknown[] }[]; foreignKeys: unknown[] }[]) {
    for (const t of schema.tables) need(sameNamedColumnSchema(t.columns, columns.filter(c => c.table === t.table)
      .map(({ name, type, nullable }) => ({ name, type, nullable }))), "SOURCE_TARGET_COLUMNS_DIFFER");
    need(sameForeignKeySchema(schema.foreignKeys, fks), "SOURCE_TARGET_FK_SCHEMA_DIFFER");
  }
  const expected = new Map<string, string[]>();
  for (const table of names) {
    const core = (NATIVE_REFERENCE_ARCHIVE_TABLES as readonly string[]).includes(table) ? view.readCoreTable(table as never).map((r: { rowJson: string }) => r.rowJson) : [];
    const parent = (NATIVE_CALIBRATION_PARENT_TABLES as readonly string[]).includes(table) ? view.readParentTable(table as never) as string[] : [];
    expected.set(table, [...core, ...parent]);
    need((await db.query(`SELECT count(*)::text n FROM public.${ident(table)}`)).rows[0].n === "0", "RESTORE_TARGET_NOT_EMPTY");
  }
  need(expected.get("engine_v3_ad_decision_evaluations")!.length === config.evaluations, "RESTORE_ORIGINAL_COUNT");
  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    return db.query(`INSERT INTO public.${ident(table)} (${cols.map(ident).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
  };
  const raw = (table: string, value: string) => db.query(`INSERT INTO public.${ident(table)} SELECT * FROM jsonb_populate_record(NULL::public.${ident(table)},$1::jsonb)`, [value]);
  let began = false, committed = false;
  try {
    await db.query("BEGIN"); began = true;
    await db.query("SET LOCAL statement_timeout='7500ms'"); await db.query("SET LOCAL lock_timeout='1000ms'"); await db.query("SET LOCAL timezone='UTC'");
    const businessId = config.generation.businessId, owner = randomUUID();
    const roots = bundle.manifest.externalIdentityRoots as { businessId: string; provider: string; providerAccountRefId: string; providerAccountId: string }[];
    need(roots.every(r => r.businessId === businessId && r.provider === "meta"), "EXTERNAL_IDENTITY_SCOPE");
    await insert("users", { id: owner, name: "Isolated restore owner", email: `${owner}@example.invalid`, password_hash: "isolated-no-auth-only" });
    await insert("businesses", { id: businessId, name: "Isolated declared archive identity", owner_id: owner });
    for (const root of roots) {
      await insert("provider_accounts", { id: root.providerAccountRefId, provider: "meta", external_account_id: root.providerAccountId });
      await insert("business_provider_accounts", { business_id: businessId, provider: "meta", provider_account_ref_id: root.providerAccountRefId,
        provider_account_id: root.providerAccountId, is_selected: true });
    }
    for (const value of view.readParentTable("engine_v3_job_runs") as string[]) await raw("engine_v3_job_runs", value);
    const batchRows = view.readParentTable("engine_v3_ad_account_calibration_batches") as string[];
    for (const value of batchRows) await db.query(`INSERT INTO public.engine_v3_ad_account_calibration_batches SELECT * FROM jsonb_populate_record(NULL::public.engine_v3_ad_account_calibration_batches,jsonb_set(jsonb_set($1::jsonb,'{completeness_status}','"writing"'::jsonb),'{completed_at}','null'::jsonb))`, [value]);
    for (const value of view.readParentTable("engine_v3_ad_account_calibration_daily") as string[]) await raw("engine_v3_ad_account_calibration_daily", value);
    for (const value of batchRows) { const row = JSON.parse(value);
      await db.query(`UPDATE public.engine_v3_ad_account_calibration_batches SET completeness_status='complete',completed_at=$2 WHERE id=$1::uuid`, [row.id, row.completed_at]); }
    const order = ["engine_v3_ad_campaign_context_objects", ...NATIVE_REFERENCE_ARCHIVE_TABLES.filter(t => t !== "engine_v3_ad_campaign_context_objects")];
    for (const table of order) { const rows = view.readCoreTable(table as never).map((x: { rowJson: string }) => x.rowJson);
      for (let i = 0; i < rows.length; i += 100) await db.query(`INSERT INTO public.${ident(table)} SELECT * FROM jsonb_populate_recordset(NULL::public.${ident(table)},$1::jsonb)`, [`[${rows.slice(i, i + 100).join(",")}]`]); }
    const tableHashes: Record<string, { rows: number; rowByteSetSha256: string }> = {};
    for (const table of names) {
      const actual = (await db.query(`SELECT to_jsonb(t)::text bytes FROM public.${ident(table)} t`)).rows.map(r => r.bytes as string).sort();
      need(same(actual, [...expected.get(table)!].sort()), "RESTORE_FULL_ROW_PARITY");
      tableHashes[table] = { rows: actual.length, rowByteSetSha256: rowSetHash(actual) };
    }
    // The restored full-DDL copy must equal the frozen whole-original proof.
    for (const table of UNIT_TABLES) need(same(tableHashes[table], config.tableHashes[table]), "RESTORE_FROZEN_PROOF_PARITY");
    const negative = async (sql: string, values: unknown[], code: string) => {
      await db.query("SAVEPOINT owned_negative"); let actual: string | undefined;
      try { await db.query(sql, values); } catch (e) { actual = (e as { code?: string }).code; }
      finally { await db.query("ROLLBACK TO SAVEPOINT owned_negative"); await db.query("RELEASE SAVEPOINT owned_negative"); }
      need(actual === code, "RESTORE_NEGATIVE_GUARD");
    };
    if (batchRows[0]) await negative("UPDATE engine_v3_ad_account_calibration_batches SET cell_set_hash=$2 WHERE id=$1::uuid", [JSON.parse(batchRows[0]).id, "b".repeat(64)], "P0001");
    const cellRows = view.readParentTable("engine_v3_ad_account_calibration_daily") as string[];
    if (cellRows[0]) await negative("UPDATE engine_v3_ad_account_calibration_daily SET computed_at=computed_at+interval '1 microsecond' WHERE id=$1::uuid", [JSON.parse(cellRows[0]).id], "P0001");
    await negative("DELETE FROM engine_v3_ad_decision_evaluation_contexts WHERE id=$1::uuid", [config.contextIds[0]], "23503");
    await db.query("COMMIT"); committed = true;
    return { restored: true, tableHashes, frozenProofParity: true, fullDisasterRecovery: false, providerAuthority: false as const };
  } finally { if (began && !committed) await db.query("ROLLBACK").catch(() => undefined); }
}
