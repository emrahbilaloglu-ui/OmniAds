import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { originalJsonbMemberText, verifyNativeCampaignContextArchive } from "../native-campaign-context-archive";
import { NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE, NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION } from "../native-campaign-context-storage";
import { buildNativeReferenceEvidenceArchive, openNativeReferenceEvidenceArchive,
  buildNativeEvidenceArchive, openNativeEvidenceArchive, NATIVE_ARCHIVE_TABLES,
  type NativeArchiveTableInput } from "../native-evidence-archive";

const business = "00000000-0000-4000-8000-000000000001", job = "00000000-0000-4000-8000-000000000002";
const generation = { businessId: business, jobRunId: job, asOfDate: "2026-10-03", engineVersion: "reference-archive-fixture" };
const payload = '{"decimal": 9007199254740993.123456789, "text": "a,}b\\\\\\"c", "nested": {"k": [1, {"x": "}" }]}}';
const digest = createHash("sha256").update(payload).digest("hex"), ref = "\\x" + digest;
function sharedRow(changes: Record<string, unknown> = {}) {
  const row = { business_ref_id: business, payload_sha256: ref,
    storage_encoding_version: NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION, payload_json: "__ORIGINAL__",
    byte_length: Buffer.byteLength(payload), created_at: "2026-10-03T01:00:00.000001+00:00", ...changes };
  return JSON.stringify(row).replace('"__ORIGINAL__"', payload);
}
const evaluation = { id: "evaluation", business_ref_id: business,
  campaign_context_json: null, campaign_context_ref: ref };

function input() {
  const common = { business_ref_id: business, business_id: business, as_of_date: generation.asOfDate,
    engine_version: generation.engineVersion, job_run_id: job, provider_account_ref_id: "account-ref",
    provider_account_id: "act_1", scope_type: "account", scope_id: "act_1" };
  const e = { ...common, ...evaluation, context_id: "context", contract_version: "archive-fixture",
    input_hash: "a".repeat(64), decision_hash: "b".repeat(64), decision_entity_type: "ad", decision_entity_id: "ad_1", ad_id: "ad_1" };
  const rows = [
    JSON.stringify({ ...common, id: job, job_name: "engine_v3_native_ad_decisions_shadow_job", status: "success",
      row_count: 1, finished_at: "2026-10-03T02:00:00.000001+00:00" }),
    JSON.stringify({ ...common, id: "context", contract_version: "archive-fixture", context_json: {} }),
    JSON.stringify(e),
    JSON.stringify({ contract_version: "archive-fixture", input_hash: e.input_hash, input_evidence_json: {} }),
    JSON.stringify({ ...e, id: "snapshot", evaluation_id: e.id }),
    sharedRow(),
  ];
  const names = [...NATIVE_ARCHIVE_TABLES, NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE] as const;
  return { generation, capturedAt: "2026-10-03T03:00:00.000002Z", sourceRevision: "a".repeat(40),
    sourceWorkspaceDirty: false, tables: names.map((table, i) => ({ table, rowJson: [rows[i]!] })),
    schema: { tables: names.map((table, i) => ({ table,
      columns: Object.keys(JSON.parse(rows[i]!)).map(name => ({ name, type: "fixture", nullable: true })) })), foreignKeys: [] } };
}

describe("exact original JSONB shared campaign transport", () => {
  it("slices original numeric, nested and escaped bytes without Javascript reserialization", () => {
    expect(originalJsonbMemberText(sharedRow(), "payload_json")).toBe(payload);
    expect(JSON.stringify(JSON.parse(payload))).not.toContain("9007199254740993.123456789");
    expect(() => originalJsonbMemberText('{"payload_json": {}, "payload_json": {}}', "payload_json")).toThrow(/duplicate/);
  });
  it("resolves original tenant-bound content and preserves every shared row byte and clock", () => {
    const rows = verifyNativeCampaignContextArchive([JSON.stringify(evaluation)], [sharedRow()], business);
    expect(rows.get(evaluation.id)).toEqual({ payloadJson: payload, objectRowJson: sharedRow() });
  });
  it("preserves Turkish and astral UTF8 bytes, refusing character-count or UTF16 digest substitutes", () => {
    const original = '{"campaignName": "İstanbul şğı 🚀", "decimal": 9007199254740993.123456789}';
    const unicodeRef = "\\x" + createHash("sha256").update(original, "utf8").digest("hex");
    const row = (changes: Record<string, unknown> = {}) => JSON.stringify({
      business_ref_id: business, payload_sha256: unicodeRef,
      storage_encoding_version: NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION, payload_json: "__ORIGINAL__",
      byte_length: Buffer.byteLength(original, "utf8"), created_at: "2026-10-03T01:00:00.000001+00:00", ...changes,
    }).replace('"__ORIGINAL__"', original);
    const selected = JSON.stringify({ ...evaluation, campaign_context_ref: unicodeRef });
    expect(Buffer.byteLength(original, "utf8")).toBeGreaterThan(original.length);
    expect(originalJsonbMemberText(row(), "payload_json")).toBe(original);
    expect(verifyNativeCampaignContextArchive([selected], [row()], business).get(evaluation.id))
      .toEqual({ payloadJson: original, objectRowJson: row() });
    expect(() => verifyNativeCampaignContextArchive([selected], [row({ byte_length: original.length })], business))
      .toThrow(/bytes\/digest\/length/);
    expect(() => verifyNativeCampaignContextArchive([selected], [row({
      payload_sha256: "\\x" + createHash("sha256").update(original, "utf16le").digest("hex"),
    })], business)).toThrow(/bytes\/digest\/length/);
  });
  it.each([
    ["foreign tenant", { business_ref_id: job }],
    ["unsupported version", { storage_encoding_version: "future" }],
    ["changed digest", { payload_sha256: "\\x" + "c".repeat(64) }],
    ["changed byte length", { byte_length: Buffer.byteLength(payload) + 1 }],
    ["non-object", { payload_json: [] }],
  ])("refuses %s despite complete selected membership", (_name, changes) => {
    expect(() => verifyNativeCampaignContextArchive([JSON.stringify(evaluation)], [sharedRow(changes)], business)).toThrow(/refused/);
  });
  it("refuses missing, duplicate and unreferenced shared roots without a live fallback", () => {
    expect(() => verifyNativeCampaignContextArchive([JSON.stringify(evaluation)], [], business)).toThrow(/missing/);
    expect(() => verifyNativeCampaignContextArchive([JSON.stringify(evaluation)], [sharedRow(), sharedRow()], business)).toThrow(/duplicate/);
    expect(() => verifyNativeCampaignContextArchive([], [sharedRow()], business)).toThrow(/unreferenced/);
  });
  it.each([
    { campaign_context_json: {}, campaign_context_ref: ref },
    { campaign_context_json: null, campaign_context_ref: null },
    { campaign_context_ref: digest },
    { business_ref_id: job },
  ])("refuses contradictory/foreign evaluation storage %#", changes => {
    expect(() => verifyNativeCampaignContextArchive([JSON.stringify({ ...evaluation, ...changes })], [sharedRow()], business)).toThrow(/refused/);
  });
  it("keeps an original inline object inline in a mixed selected generation", () => {
    const inline = JSON.stringify({ ...evaluation, id: "inline", campaign_context_json: { note: "original" }, campaign_context_ref: null });
    const rows = verifyNativeCampaignContextArchive([JSON.stringify(evaluation), inline], [sharedRow()], business);
    expect(rows.get("inline")).toEqual({ payloadJson: '{"note":"original"}', objectRowJson: null });
  });
  it("binds the separate six-table core contract and makes historical shared payload available", () => {
    const source = input(), built = buildNativeReferenceEvidenceArchive(source);
    const view = openNativeReferenceEvidenceArchive(built.bundle, { manifestHash: built.manifestHash,
      schemaHash: built.bundle.manifest.schemaHash, generation });
    expect(view).toMatchObject({ authority: "historical_read_only", providerAuthority: false, reclaimEligible: false });
    expect(view.readTable(NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE)[0]!.rowJson).toBe(sharedRow());
    expect(view.readCampaignContext("evaluation")).toEqual({ payloadJson: payload, objectRowJson: sharedRow() });
    expect(JSON.parse(view.readTable("engine_v3_ad_decision_evaluations")[0]!.rowJson).campaign_context_json).toBeNull();
    expect(() => openNativeEvidenceArchive(built.bundle, { manifestHash: built.manifestHash,
      schemaHash: built.bundle.manifest.schemaHash, generation })).toThrow(/contract/);
  });
  it("keeps the original five-table reader refusing references or silently omitted shared roots", () => {
    const source = input(); source.tables.pop(); source.schema.tables.pop();
    expect(() => buildNativeEvidenceArchive({ ...source, tables: source.tables as NativeArchiveTableInput[] })).toThrow(/reference/);
  });
});
