import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSINESS_ERASURE_REFERENCE_INDEXES, BUSINESS_ERASURE_FULL_BINDING_INDEXES, ensureBusinessErasureReferenceIndexes, ensureBusinessErasureFullBindingIndexes } from "@/lib/business-deletion-reference-indexes";
import { assertBusinessErasureFullBindingIndexCapacity } from "@/lib/migrations";

const first = BUSINESS_ERASURE_REFERENCE_INDEXES[0];
const healthy = { relation_kind: "r", key_type: 2950, reference_foreign_key: true, lookup_ready: true, named_index_conflict: false };
function fixture(overrides: Record<string, unknown> = {}, completes = true) {
  let built = false;
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    if (text.startsWith("CREATE INDEX")) { built = completes; return []; }
    const selected = params?.[0] === first.table && params?.[1] === first.column;
    return [{ ...healthy, key_type: params?.[3] === "hash" ? 17 : 2950, ...(selected ? overrides : {}), ...(selected && built ? { lookup_ready: true } : {}) }];
  });
  return { query };
}

describe("additive whole-business FK access schema", () => {
  it("adopts usable existing leading indexes without capacity reservation or DDL", async () => {
    const sql = fixture(), admit = vi.fn();
    await expect(ensureBusinessErasureReferenceIndexes(sql as never, admit)).resolves.toMatchObject({ built: [] });
    expect(admit).not.toHaveBeenCalled();
    expect(sql.query.mock.calls.every(([q]) => !q.startsWith("CREATE"))).toBe(true);
  });
  it("builds one missing nullable reference only after admission and verifies it", async () => {
    const sql = fixture({ lookup_ready: false }), admit = vi.fn();
    const result = await ensureBusinessErasureReferenceIndexes(sql as never, admit);
    expect(admit).toHaveBeenCalledExactlyOnceWith(`public.${first.table}`, "btree", first.column);
    expect(result.built).toEqual([first.index]);
    expect(sql.query.mock.calls.find(([q]) => q.startsWith("CREATE"))?.[0]).toContain("CREATE INDEX CONCURRENTLY");
  });
  it("uses only the reviewed hash reference with a distinct admission basis", async () => {
    let built = false;
    const admit = vi.fn();
    const query = vi.fn(async (q: string, params?: unknown[]) => {
      if (q.startsWith("CREATE")) { built = true; return []; }
      return [{ ...healthy, key_type: params?.[3] === "hash" ? 17 : 2950,
        lookup_ready: params?.[3] !== "hash" || built }];
    });
    const result = await ensureBusinessErasureReferenceIndexes({ query } as never, admit);
    expect(result.built).toEqual(["idx_biz_erase_campaign_reference"]);
    expect(admit).toHaveBeenCalledExactlyOnceWith("public.engine_v3_ad_decision_evaluations", "hash", "campaign_context_ref");
    expect(query.mock.calls.find(([q]) => q.startsWith("CREATE"))?.[0]).toContain("USING hash (campaign_context_ref)");
  });
  it("uses supported parent/leaf DDL for a partitioned relation", async () => {
    const sql = fixture({ relation_kind: "p", lookup_ready: false });
    await ensureBusinessErasureReferenceIndexes(sql as never, vi.fn());
    expect(sql.query.mock.calls.find(([q]) => q.startsWith("CREATE"))?.[0]).not.toContain("CONCURRENTLY");
  });
  it("reserves each missing account UUID lookup with its exact column before additive DDL", async () => {
    const entries = BUSINESS_ERASURE_REFERENCE_INDEXES.filter(e => e.column === "provider_account_ref_id");
    expect(entries).toHaveLength(9);
    const built = new Set<string>(), admit = vi.fn();
    const query = vi.fn(async (q: string, params?: unknown[]) => {
      if (q.startsWith("CREATE")) { const e = entries.find(e => q.includes(e.index))!; built.add(e.table); return []; }
      return [{ ...healthy, key_type: params?.[3] === "hash" ? 17 : 2950,
        lookup_ready: params?.[1] !== "provider_account_ref_id" || built.has(String(params[0])) }];
    });
    const result = await ensureBusinessErasureReferenceIndexes({query} as never,admit);
    expect(result.verified).toBe(49);
    expect(result.built).toEqual(entries.map(e => e.index));
    for (const e of entries) expect(admit).toHaveBeenCalledWith(`public.${e.table}`,"btree","provider_account_ref_id");
    expect(query.mock.calls.filter(([q]) => q.startsWith("CREATE")).every(([q]) => q.includes("(provider_account_ref_id) WHERE provider_account_ref_id IS NOT NULL"))).toBe(true);
  });
  it("propagates physical refusal before creating any index", async () => {
    const sql = fixture({ lookup_ready: false });
    await expect(ensureBusinessErasureReferenceIndexes(sql as never, async () => { throw Error("physical refusal"); })).rejects.toThrow("physical refusal");
    expect(sql.query.mock.calls.every(([q]) => !q.startsWith("CREATE"))).toBe(true);
  });
  it.each([
    { key_type: 25 }, { reference_foreign_key: false }, { reference_foreign_key: "true" },
    { named_index_conflict: true }, { named_index_conflict: undefined },
    { lookup_ready: "true" }, { relation_kind: "v" },
  ])("refuses unsupported/ambiguous catalog evidence %j without mutation", async overrides => {
    const sql = fixture(overrides), admit = vi.fn();
    await expect(ensureBusinessErasureReferenceIndexes(sql as never, admit)).rejects.toThrow("business_erasure_reference_index_contract");
    expect(admit).not.toHaveBeenCalled();
    expect(sql.query.mock.calls.every(([q]) => !q.startsWith("CREATE"))).toBe(true);
  });
  it("does not announce success when an acknowledged DDL leaves the lookup unusable", async () => {
    await expect(ensureBusinessErasureReferenceIndexes(fixture({ lookup_ready: false }, false) as never, vi.fn())).rejects.toThrow("reference_index_not_ready");
  });
  it("propagates catalog/DDL failure without repairing or dropping unknown indexes", async () => {
    const sql = fixture({ lookup_ready: false });
    sql.query.mockImplementation(async (q, params) => { if (q.startsWith("CREATE")) throw Error("DDL failed"); return [{ ...healthy, key_type: params?.[3] === "hash" ? 17 : 2950, lookup_ready: false }]; });
    await expect(ensureBusinessErasureReferenceIndexes(sql as never, vi.fn())).rejects.toThrow("DDL failed");
    expect(sql.query.mock.calls.every(([q]) => !q.startsWith("DROP"))).toBe(true);
  });
});

describe("full-binding physical capacity and key bounds",()=>{
  afterEach(()=>vi.unstubAllEnvs());
  const relation="public.engine_v3_ad_decision_evaluations",floor=40*1024**3;
  function capacityFixture(input:{parent?:unknown;lengths?:unknown[];pk?:unknown;available?:number;age?:number}={}){
    return {query:vi.fn(async(q:string)=>{
      if(q.includes("AS full_binding_parent_bytes"))return [{parent_bytes:input.parent??"8192"}];
      if(q.includes("octet_length(business_id)"))return input.lengths??[{business_bytes:36,account_bytes:24}];
      if(q.includes("AS account_binding_full_pk_bytes"))return input.pk===null?[]:[{relation_bytes:input.pk??"8192",database_bytes:"1048576"}];
      if(q.includes("FROM (SELECT to_regclass('system_capacity_snapshots')"))return [{payload:{disks:[{path:"/var/lib/postgresql",availableBytes:input.available??floor+8192*12}]},age_seconds:input.age??0}];
      throw Error("Unexpected capacity query");
    })};
  }
  it("uses full UUID PK coverage and the same40GiB floor with the larger12x tuple reserve",async()=>{
    vi.stubEnv("NODE_ENV","production");const sql=capacityFixture();
    expect((await assertBusinessErasureFullBindingIndexCapacity(sql,relation)).engaged).toBe(true);
    expect(sql.query.mock.calls.some(([q])=>q.includes("pg_total_relation_size"))).toBe(false);
  });
  it.each(["public.meta_creative_lineage_edges","public.meta_entity_observation_runs"])("requires fresh physical admission for the reviewed Meta binding %s",async metaRelation=>{
    vi.stubEnv("NODE_ENV","production");
    expect((await assertBusinessErasureFullBindingIndexCapacity(capacityFixture(),metaRelation)).engaged).toBe(true);
    await expect(assertBusinessErasureFullBindingIndexCapacity(capacityFixture({available:floor+8192*12-1}),metaRelation)).rejects.toThrow("migration_capacity_refused");
  });
  it.each([{parent:"8388609"},{parent:"-1"},{parent:true},{lengths:Array.from({length:1025},()=>({business_bytes:36,account_bytes:20}))},
    {lengths:[{business_bytes:37,account_bytes:20}]},{lengths:[{business_bytes:36,account_bytes:25}]}])("refuses unbounded parent/key evidence %j before size reservation",async input=>{
    const sql=capacityFixture(input);
    await expect(assertBusinessErasureFullBindingIndexCapacity(sql,relation)).rejects.toThrow(/parent_census_refused|key_width_refused/);
    expect(sql.query.mock.calls.some(([q])=>q.includes("AS account_binding_full_pk_bytes"))).toBe(false);
  });
  it.each([{pk:null},{available:floor+8192*12-1},{age:901}])("refuses missing coverage or fresh physical headroom %j even with an override",async input=>{
    vi.stubEnv("NODE_ENV","production");vi.stubEnv("ADSECUTE_MIGRATION_CAPACITY_OVERRIDE","cannot bypass");
    await expect(assertBusinessErasureFullBindingIndexCapacity(capacityFixture(input),relation)).rejects.toThrow(/primary_coverage_refused|migration_capacity_refused/);
  });
});

describe("complete account-binding lookup admission", () => {
  const healthyFull = {full_binding_shape_valid:true,full_binding_lineage_valid:true,lookup_ready:true,named_index_conflict:false};
  it("keeps usable full-binding indexes without DDL or new capacity reservations", async () => {
    const sql={query:vi.fn(async()=>[healthyFull])},admit=vi.fn();
    expect(await ensureBusinessErasureFullBindingIndexes(sql as never,admit)).toEqual({built:[],verified:7});
    expect(admit).not.toHaveBeenCalled();
  });
  it("adds only missing exact three-key indexes after their independent capacity admission", async () => {
    const built=new Set<string>(),admit=vi.fn();
    const query=vi.fn(async(q:string,p?:unknown[])=>{
      if(q.startsWith("CREATE")){built.add(BUSINESS_ERASURE_FULL_BINDING_INDEXES.find(e=>q.includes(e.index))!.table);return [];}
      return [{...healthyFull,lookup_ready:built.has(String(p?.[0]))}];
    });
    expect((await ensureBusinessErasureFullBindingIndexes({query} as never,admit)).built).toEqual(BUSINESS_ERASURE_FULL_BINDING_INDEXES.map(e=>e.index));
    for(const e of BUSINESS_ERASURE_FULL_BINDING_INDEXES)expect(admit).toHaveBeenCalledWith(`public.${e.table}`);
    expect(query.mock.calls.filter(([q])=>q.startsWith("CREATE")).every(([q])=>q.includes("(provider_account_ref_id, business_id, provider_account_id) WHERE provider_account_ref_id IS NOT NULL"))).toBe(true);
  });
  it.each([{full_binding_shape_valid:false},{full_binding_lineage_valid:false},{named_index_conflict:true},{lookup_ready:"true"}])("rejects malformed full FK/index evidence %j before mutation",async change=>{
    const sql={query:vi.fn(async()=>[{...healthyFull,...change}])},admit=vi.fn();
    await expect(ensureBusinessErasureFullBindingIndexes(sql as never,admit)).rejects.toThrow("full_binding_index_contract");
    expect(admit).not.toHaveBeenCalled();
  });
  it("does not build after physical refusal",async()=>{
    const query=vi.fn(async()=>[{...healthyFull,lookup_ready:false}]);
    await expect(ensureBusinessErasureFullBindingIndexes({query} as never,async()=>{throw Error("physical refusal");})).rejects.toThrow("physical refusal");
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("requires post-DDL usability",async()=>{
    const query=vi.fn(async(q:string)=>q.startsWith("CREATE")?[]:[{...healthyFull,lookup_ready:false}]);
    await expect(ensureBusinessErasureFullBindingIndexes({query} as never,async()=>{})).rejects.toThrow("full_binding_index_not_ready");
  });
});
