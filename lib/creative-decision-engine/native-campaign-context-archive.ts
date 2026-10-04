import { createHash } from "node:crypto";
import { NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION } from "./native-campaign-context-storage";

const BYTEA = /^\\x[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function refuse(reason: string): never { throw new Error(`Native campaign archive refused: ${reason}`); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("original object absent");
  return value as Record<string, unknown>;
}

/** Slice one original PostgreSQL JSONB value. JSON.parse validates syntax but
 * must never reserialize a bigint/decimal payload to establish its digest. */
export function originalJsonbMemberText(bytes: string, wanted: string): string {
  record(JSON.parse(bytes));
  let i = 0;
  const space = () => { while (/\s/.test(bytes[i] ?? "") && i < bytes.length) i++; };
  space(); if (bytes[i++] !== "{") refuse("original row object absent");
  const seen = new Set<string>();
  let found: string | undefined;
  while (true) {
    space(); if (bytes[i] === "}") { i++; break; }
    const keyStart = i;
    if (bytes[i++] !== '"') refuse("original member key invalid");
    let escaped = false;
    while (i < bytes.length) {
      const c = bytes[i++]!;
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') break;
    }
    const name: unknown = JSON.parse(bytes.slice(keyStart, i));
    if (typeof name !== "string" || seen.has(name)) refuse("duplicate original member");
    seen.add(name); space();
    if (bytes[i++] !== ":") refuse("original member colon absent");
    space(); const start = i;
    let nesting = 0, inString = false;
    escaped = false;
    while (i < bytes.length) {
      const c = bytes[i]!;
      if (inString) {
        i++;
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{" || c === "[") nesting++;
      else if (c === "}" || c === "]") {
        if (nesting === 0) break;
        nesting--;
      } else if (c === "," && nesting === 0) break;
      i++;
    }
    if (name === wanted) found = bytes.slice(start, i).trimEnd();
    space();
    if (bytes[i] === ",") { i++; continue; }
    if (bytes[i] !== "}") refuse("original member delimiter invalid");
  }
  space();
  if (i !== bytes.length || found === undefined) refuse("original member absent");
  return found;
}

export interface ArchivedCampaignContext {
  /** Original payload_json::text (or original inline value), never normalized. */
  payloadJson: string;
  /** Original shared table to_jsonb(row)::text. NULL for original inline rows. */
  objectRowJson: string | null;
}

/** Copy/integrity only. Shared roots can still be referenced by other live jobs.
 * Exact selected membership never grants shared-object GC or provider authority. */
export function verifyNativeCampaignContextArchive(evaluations: readonly string[],
  objects: readonly string[], businessId: string): ReadonlyMap<string, ArchivedCampaignContext> {
  if (!UUID.test(businessId)) refuse("tenant identity invalid");
  const roots = new Map<string, ArchivedCampaignContext>();
  for (const raw of objects) {
    if (Buffer.byteLength(raw, "utf8") > 1048576 + 4096) refuse("shared row outside bound");
    const row = record(JSON.parse(raw));
    if (row.business_ref_id !== businessId || typeof row.payload_sha256 !== "string" ||
        !BYTEA.test(row.payload_sha256)) refuse("shared tenant/digest invalid");
    if (row.storage_encoding_version !== NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION)
      refuse("shared encoding unsupported");
    record(row.payload_json);
    const payload = originalJsonbMemberText(raw, "payload_json");
    if (!payload.startsWith("{") || !payload.endsWith("}")) refuse("shared original object invalid");
    const byteLength = Buffer.byteLength(payload, "utf8");
    const hash = createHash("sha256").update(payload, "utf8").digest("hex");
    if (row.payload_sha256 !== "\\x" + hash || row.byte_length !== byteLength ||
        byteLength < 1 || byteLength > 1048576) refuse("shared original bytes/digest/length differ");
    if (roots.has(row.payload_sha256)) refuse("duplicate shared tenant/digest");
    roots.set(row.payload_sha256, { payloadJson: payload, objectRowJson: raw });
  }
  const used = new Set<string>(), resolved = new Map<string, ArchivedCampaignContext>();
  for (const raw of evaluations) {
    const row = record(JSON.parse(raw));
    if (row.business_ref_id !== businessId || typeof row.id !== "string" || !row.id ||
        resolved.has(row.id)) refuse("evaluation tenant/identity invalid");
    const ref = row.campaign_context_ref, inline = row.campaign_context_json;
    if (ref === null) {
      record(inline);
      resolved.set(row.id, { payloadJson: originalJsonbMemberText(raw, "campaign_context_json"),
                            objectRowJson: null });
    } else {
      if (inline !== null || typeof ref !== "string" || !BYTEA.test(ref)) refuse("reference XOR/digest invalid");
      const value = roots.get(ref); if (!value) refuse("original shared root missing");
      used.add(ref); resolved.set(row.id, { ...value });
    }
  }
  if (used.size !== roots.size) refuse("unreferenced shared root");
  return resolved;
}
