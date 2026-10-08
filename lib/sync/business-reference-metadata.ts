import type { getDb } from "@/lib/db";

/** Recognise business identity fields, not unrelated job/partition UUIDs. */
export function metadataBusinessIds(value: unknown): string[] {
  const ids = new Set<string>();
  let visited = 0;
  function walk(item: unknown, identity = false, depth = 0) {
    if (++visited > 100_000 || depth > 32) throw new Error("business_metadata_limit");
    if (item == null) return;
    if (Array.isArray(item)) { for (const child of item) walk(child, identity, depth + 1); return; }
    if (typeof item === "object") {
      for (const [key, child] of Object.entries(item)) walk(child,
        /(?:businessid|businessrefid|businessids|businessrefids|businesses)$/.test(key.replaceAll("_", "").toLowerCase()), depth + 1);
      return;
    }
    if (!identity) return;
    if (typeof item !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(item))
      throw new Error("business_metadata_identity_invalid");
    ids.add(item.toLowerCase());
    if (ids.size > 256) throw new Error("business_metadata_limit");
  }
  walk(value);
  return [...ids].sort();
}

/** Caller holds its destination table's ROW EXCLUSIVE lock first. */
export async function metadataBusinessesAreLive(sql: ReturnType<typeof getDb>, value: unknown) {
  const ids = metadataBusinessIds(value);
  if (!ids.length) return true;
  const rows = await sql.query("SELECT id FROM businesses WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE", [ids]);
  return rows.length === ids.length;
}

export async function assertLiveMetadataBusinesses(sql: ReturnType<typeof getDb>, value: unknown) {
  if (!await metadataBusinessesAreLive(sql,value)) throw new Error("control_metadata_business_removed");
}
