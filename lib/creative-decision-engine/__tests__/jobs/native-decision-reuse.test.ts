import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db";
import { readEquivalentNativeGeneration, nativeDecisionReusePolicyHash,
  READ_NATIVE_GENERATION_REUSE_HEADER_SQL, READ_NATIVE_GENERATION_REUSE_ROWS_SQL,
  authoritativeHydrationReceipts, nativeGenerationReuseSlotStart,
  readCompletedNativeReuse, READ_NATIVE_REUSE_COMPLETION_SQL } from "../../jobs/native-decision-reuse";
import { AD_DECISION_EVALUATION_CONTRACT_VERSION } from "../../evaluation-store";

const previous="00000000-0000-4000-8000-000000000002";
const snapshot={business_ref_id:"00000000-0000-4000-8000-000000000001",business_id:"00000000-0000-4000-8000-000000000001",
  provider_account_ref_id:"00000000-0000-4000-8000-000000000003",provider_account_id:"act_1",
  decision_entity_type:"ad",decision_entity_id:"123",ad_id:"123",scope_type:"account",scope_id:"act_1",
  job_run_id:previous,evaluation_id:"00000000-0000-4000-8000-000000000004",computed_at:"2026-09-28T03:00:00Z",
  input_hash:"a".repeat(64),decision_hash:"b".repeat(64),spend:100,authorized_action:null,
  authority_blocker:"config_source_authority",creative_evidence_lifecycle_row_id:null};
const context="c".repeat(64), policy="d".repeat(64);
const errorJson={metadata:{hydration_receipts:[{provider_account_ref_id:snapshot.provider_account_ref_id,
  provider_account_id:"act_1",expected_ad_count:1,hydrated_ad_count:1,expected_manifest_hash:"e".repeat(64),
  hydrated_manifest_hash:"e".repeat(64),source_complete:true,hydration_complete:true,authoritative_for_prune:true,reason:null}]}};
const input={businessId:snapshot.business_id,asOf:"2026-09-28",currentJobRunId:"00000000-0000-4000-8000-000000000005",
  cutoff:"2026-09-28T03:20:00Z",slotStart:"2026-09-28T03:00:00.000Z",policyHash:policy,candidates:[{contextHash:context,snapshot:{...snapshot,
    computed_at:"2026-09-28T03:20:00Z",job_run_id:"00000000-0000-4000-8000-000000000005"}}],hydrationReceiptJson:errorJson};
const priorRow={snapshot,context_hash:context,evaluation_job_run_id:previous,evaluation_contract_version:AD_DECISION_EVALUATION_CONTRACT_VERSION};
function fixture(rows=[priorRow],header: unknown={id:previous,row_count:1,error_json:errorJson}) {
  const query=vi.fn(async (sql: string) => sql===READ_NATIVE_GENERATION_REUSE_HEADER_SQL ? [header] : sql===READ_NATIVE_GENERATION_REUSE_ROWS_SQL ? rows : []);
  return {query,db:{query} as unknown as DbClient};
}
describe("full current canonical generation equivalence",()=>{
  it("retains original identity and proof after invocation clocks change",async()=>{
    const f=fixture();expect(await readEquivalentNativeGeneration(input,f.db)).toMatchObject({jobRunId:previous,rowCount:1,proofHash:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(f.query).toHaveBeenCalledWith(READ_NATIVE_GENERATION_REUSE_HEADER_SQL,
      [input.businessId,input.asOf,expect.any(String),input.cutoff,input.currentJobRunId,policy,input.slotStart]);
  });
  it("limits header selection to the invocation slot and preserves the UTC slot boundaries",()=>{
    expect(READ_NATIVE_GENERATION_REUSE_HEADER_SQL).toContain("started_at >= $7::timestamptz");
    expect(nativeGenerationReuseSlotStart("2026-09-28T14:59:59Z")).toBe("2026-09-28T03:00:00.000Z");
    expect(nativeGenerationReuseSlotStart("2026-09-28T15:00:00Z")).toBe("2026-09-28T15:00:00.000Z");
    expect(nativeGenerationReuseSlotStart("2026-09-29T00:00:00Z")).toBe("2026-09-29T00:00:00.000Z");
  });
  it.each(["input_hash","decision_hash","spend","authorized_action","authority_blocker","creative_evidence_lifecycle_row_id"])("refuses a changed %s",async key=>{
    const f=fixture();expect(await readEquivalentNativeGeneration({...input,candidates:[{contextHash:context,snapshot:{...input.candidates[0]!.snapshot,[key]:"changed"}}]},f.db)).toBeNull();
  });
  it("refuses current context/policy legacy, missing, extra, duplicate and replaced generation cells",async()=>{
    expect(await readEquivalentNativeGeneration({...input,candidates:[{contextHash:"f".repeat(64),snapshot}]},fixture().db)).toBeNull();
    for(const rows of [[],[priorRow,priorRow],[{...priorRow,snapshot:{...snapshot,job_run_id:input.currentJobRunId}}]])
      expect(await readEquivalentNativeGeneration(input,fixture(rows).db)).toBeNull();
    expect(await readEquivalentNativeGeneration(input,fixture([priorRow],null).db)).toBeNull();
    expect(await readEquivalentNativeGeneration({...input,policyHash:"legacy"},fixture().db)).toBeNull();
  });
  it("refuses incomplete or changed account manifests and malformed counts",async()=>{
    const f=fixture();expect(await readEquivalentNativeGeneration({...input,hydrationReceiptJson:{metadata:{hydration_receipts:[]}}},f.db)).toBeNull();
    for(const value of [true,false,null,"",-1,1.5])expect(authoritativeHydrationReceipts({metadata:{hydration_receipts:[{...errorJson.metadata.hydration_receipts[0],expected_ad_count:value}]}})).toBe(false);
    const changed={metadata:{hydration_receipts:[{...errorJson.metadata.hydration_receipts[0],expected_manifest_hash:"f".repeat(64),hydrated_manifest_hash:"f".repeat(64)}]}};
    expect(await readEquivalentNativeGeneration({...input,hydrationReceiptJson:changed},f.db)).toBeNull();
  });
  it("recovers an optional SQL error before normal producer writes",async()=>{
    const f=fixture();f.query.mockImplementation(async sql=>{if(sql===READ_NATIVE_GENERATION_REUSE_HEADER_SQL)throw Object.assign(Error("timeout"),{code:"57014"});return [];});
    const onRefusal=vi.fn();
    expect(await readEquivalentNativeGeneration({...input,onRefusal},f.db)).toBeNull();
    expect(onRefusal).toHaveBeenCalledWith("comparison_query_failed");
    expect(f.query.mock.calls.map(([sql])=>sql)).toEqual(["SAVEPOINT native_canonical_generation_reuse",READ_NATIVE_GENERATION_REUSE_HEADER_SQL,"ROLLBACK TO SAVEPOINT native_canonical_generation_reuse","RELEASE SAVEPOINT native_canonical_generation_reuse"]);
  });
});

describe("completed reuse receipt",()=>{
  const calibration="00000000-0000-4000-8000-000000000006";
  const attempt={id:input.currentJobRunId,status:"skipped",dependency_run_id:calibration,
    error_json:{metadata:{reused_job_run_id:previous,reuse_proof_hash:"a".repeat(64),
      reuse_policy_hash:policy,authority_granted:false,
      reuse_basis:"complete_current_canonical_input_decision_and_snapshot_equality"}}};
  const request={attempt,businessId:input.businessId,calibrationRunId:calibration,
    cutoff:input.cutoff,slotStart:input.slotStart};
  const original={id:previous,row_count:1,total_rows:1,linked_rows:1,error_json:errorJson};
  it("resolves the immutable original without producer hydration",async()=>{
    const query=vi.fn(async()=>[original]);
    expect(await readCompletedNativeReuse(request,{query} as unknown as DbClient)).toBe(original);
    expect(query).toHaveBeenCalledWith(READ_NATIVE_REUSE_COMPLETION_SQL,expect.arrayContaining([previous,calibration,input.slotStart]));
  });
  it("invalidates changed calibration, malformed proof and claimed authority before SQL",async()=>{
    const query=vi.fn(async()=>[original]);
    const db={query} as unknown as DbClient;
    expect(await readCompletedNativeReuse({...request,calibrationRunId:previous},db)).toBeNull();
    for(const metadata of [{...attempt.error_json.metadata,reuse_proof_hash:"missing"},
      {...attempt.error_json.metadata,authority_granted:true},
      {...attempt.error_json.metadata,reused_job_run_id:"legacy"}])
      expect(await readCompletedNativeReuse({...request,attempt:{...attempt,error_json:{metadata}}},db)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it("refuses extra, replaced, missing or incomplete current generation ownership",async()=>{
    for(const row of [null,{...original,total_rows:2},{...original,linked_rows:0},
      {...original,row_count:0},{...original,error_json:{metadata:{hydration_receipts:[]}}}]){
      const query=vi.fn(async()=>row?[row]:[]);
      expect(await readCompletedNativeReuse(request,{query} as unknown as DbClient)).toBeNull();
    }
  });
});
