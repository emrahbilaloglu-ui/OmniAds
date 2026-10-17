import { toSafeByteCount } from "./state-history-effective-size";
import { RAW_PAYLOAD_STORAGE_TABLES, type RawPayloadStorageTable } from "./raw-payload-storage";
import type { NativeReusableHeapAccounting } from "./native-reusable-heap";

export interface RawPayloadReusableTable {
  rawBytes: number; reusableBytes: number; effectiveBytes: number;
  measuredDatabaseBytes?: number;
  metric: "visible_map_free" | "raw_fallback"; fallbackReason: string | null;
  heaps: { kind: "main" | "toast"; oid: number; heapBytes: number; visibleFreeBytes: number }[];
}
export type RawPayloadReusableSpace = Record<RawPayloadStorageTable, RawPayloadReusableTable>;

/** Only visibility/free-space maps, not payloads/heap tuples or indexes. Credit
 * only all-visible pages with at least half a block free; ignore all other
 * pages. Never extrapolate samples or count dead/unvacuumed tuples. */
export const RAW_PAYLOAD_REUSABLE_SPACE_SQL = `
 WITH owner AS MATERIALIZED (
   SELECT c.oid,c.reltoastrelid,pg_total_relation_size(c.oid)::bigint raw_bytes
   FROM pg_class c WHERE c.oid=to_regclass($1) AND c.relkind='r'
 ), heaps AS MATERIALIZED (
   SELECT 'main'::text kind,oid,pg_relation_size(oid)::bigint heap_bytes FROM owner
   UNION ALL
   SELECT 'toast',reltoastrelid,pg_relation_size(reltoastrelid)::bigint FROM owner WHERE reltoastrelid<>0
 ), proof AS MATERIALIZED (
   SELECT h.*,CASE WHEN h.heap_bytes<=64::bigint*1024*1024*1024 THEN
     (SELECT COALESCE(sum(CASE WHEN f.avail>=4096 THEN
       CASE WHEN (public.pg_visibility_map(h.oid::regclass,f.blkno)).all_visible THEN f.avail ELSE 0 END
       ELSE 0 END),0)::bigint FROM public.pg_freespace(h.oid::regclass) f)
     ELSE NULL END visible_free_bytes
   FROM heaps h
 ) SELECT (SELECT raw_bytes FROM owner) raw_bytes,pg_database_size(current_database())::bigint database_bytes,
   jsonb_agg(jsonb_build_object('kind',kind,'oid',oid,'heap_bytes',heap_bytes,'visible_free_bytes',visible_free_bytes)) heaps
 FROM proof`;

export function deriveRawPayloadReusableTable(rawBytes: number, row: Record<string, unknown> | null,
  error = "measurement_unavailable"): RawPayloadReusableTable {
  const fallback = (reason: string): RawPayloadReusableTable => ({ rawBytes, reusableBytes: 0, effectiveBytes: rawBytes,
    metric: "raw_fallback", fallbackReason: reason, heaps: [] });
  if (toSafeByteCount(rawBytes) === null) return fallback("raw_measurement_invalid");
  if (!row) return fallback(error);
  const measuredRaw = toSafeByteCount(row.raw_bytes);
  const database = toSafeByteCount(row.database_bytes);
  if (measuredRaw === null || database === null || database < measuredRaw || !Array.isArray(row.heaps) || row.heaps.length < 1 || row.heaps.length > 2)
    return fallback("map_proof_invalid");
  const heaps: RawPayloadReusableTable["heaps"] = [], seen = new Set<number>();
  for (const value of row.heaps) {
    if (!value || typeof value !== "object") return fallback("map_proof_invalid");
    const p = value as Record<string, unknown>, oid = toSafeByteCount(p.oid), length = toSafeByteCount(p.heap_bytes),
      free = toSafeByteCount(p.visible_free_bytes);
    if (oid === null || oid === 0 || seen.has(oid) || !["main", "toast"].includes(String(p.kind)) ||
      length === null || free === null || length % 8192 !== 0 || free > length || length > 64 * 1024 ** 3 ||
      heaps.some(x => x.kind === p.kind)) return fallback("map_proof_invalid");
    seen.add(oid); heaps.push({ kind: p.kind as "main" | "toast", oid, heapBytes: length, visibleFreeBytes: free });
  }
  const raw = Math.max(rawBytes, measuredRaw), allocated = heaps.reduce((n,h) => n+h.heapBytes,0);
  if (!heaps.some(h => h.kind === "main") || allocated > raw) return fallback("map_proof_invalid");
  // A full extra MiB per measured heap remains uncredited for map/concurrent
  // measurement boundaries. The existing global physical512MiB reserve and
  // whole-headroom reservation remain independently enforced.
  const reusable = heaps.reduce((n,h) => n+Math.max(0,h.visibleFreeBytes-1024**2),0);
  return { rawBytes: raw, measuredDatabaseBytes: database, reusableBytes: reusable, effectiveBytes: raw-reusable,
    metric: "visible_map_free", fallbackReason: null, heaps };
}

export async function measureRawPayloadReusableSpace(sql: { query(text: string, args: unknown[]): Promise<Record<string, unknown>[]> },
  tableBytes: Record<string, number>): Promise<RawPayloadReusableSpace> {
  const result = {} as RawPayloadReusableSpace;
  const oids = new Set<number>();
  for (const table of RAW_PAYLOAD_STORAGE_TABLES) {
    try {
      const rows = await sql.query(RAW_PAYLOAD_REUSABLE_SPACE_SQL, [`public.${table}`]);
      const proof = deriveRawPayloadReusableTable(tableBytes[table]!, rows.length === 1 ? rows[0]! : null);
      // The two owners must not receive credit for any shared physical heap.
      if (proof.heaps.some(h => oids.has(h.oid))) {
        for (const previous of RAW_PAYLOAD_STORAGE_TABLES) if (result[previous])
          result[previous] = deriveRawPayloadReusableTable(tableBytes[previous]!, null, "overlapping_heap_proof");
        result[table] = deriveRawPayloadReusableTable(tableBytes[table]!, null, "overlapping_heap_proof");
      } else { result[table] = proof; for (const h of proof.heaps) oids.add(h.oid); }
    } catch { result[table] = deriveRawPayloadReusableTable(tableBytes[table]!, null); }
  }
  return result;
}

export function mergeRawPayloadReusableAccounting(native: NativeReusableHeapAccounting, raw: RawPayloadReusableSpace): NativeReusableHeapAccounting {
  const components = RAW_PAYLOAD_STORAGE_TABLES.flatMap(table => {
    const p = raw[table]; return p.metric === "visible_map_free" ? p.heaps.map(h => ({
      relation: `${table}:${h.kind}`, provenFreeBytes: Math.max(0,h.visibleFreeBytes-1024**2),
    })) : [];
  }).filter(x => x.provenFreeBytes > 0);
  if (!components.length) return native;
  const nativeBytes = native.metric === "raw_minus_proven_native_heap_free" && native.fallbackReason === null
    ? native.provenReusableHeapBytes ?? native.reusableHeapBytes : 0;
  if (nativeBytes > 0) components.unshift({ relation: "engine_v3_ad_decision_evaluations", provenFreeBytes: nativeBytes });
  const proven = components.reduce((n,c) => n+c.provenFreeBytes,0);
  if (!Number.isSafeInteger(proven) || proven > native.rawDatabaseBytes) return native;
  return { metric: "raw_minus_proven_disjoint_heap_free", relation: "disjoint_native_and_raw_heaps",
    rawDatabaseBytes: native.rawDatabaseBytes, accountedDatabaseBytes: native.rawDatabaseBytes-proven,
    reusableHeapBytes: proven, fallbackReason: null, components };
}
