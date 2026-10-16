import { nativeArchiveByteDigest, openImmutableNativeHistoricalArchiveCatalog,
  NATIVE_HISTORICAL_COMPACT_ROOT_CATALOG_CONTRACT } from "./native-historical-archive";
import { decodeNativeHistoricalRoutingRoot, decodeNativeHistoricalRoutingShard, decodeNativeHistoricalRoutingLeaf,
  nativeHistoricalGenerationBucket, NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT, NATIVE_HISTORICAL_TENANT_LEAF_LAYOUT,
  NATIVE_HISTORICAL_SHARD_CONTRACT, NATIVE_HISTORICAL_ROUTING_BOUNDS as bounds,
  type NativeHistoricalMetadataKind, type NativeHistoricalRoutingRoot, type NativeHistoricalRoutingShard } from "./native-historical-catalog-routing";

/** Pure metadata preparation. No filesystem, activation, DB or removal rights.
 * A shared content-addressed store writes each original leaf once. Appending
 * reads only the independently pinned root and ONE exact hash bucket, rather
 * than copying all previous leaves into a new directory on every generation. */
export type TenantCatalogFile = { kind: NativeHistoricalMetadataKind; sha256: string; bytes: number;
  content: Buffer; businessId?: string };
export type TenantCatalogDelta = { contract: typeof NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT;
  previousRootSha256: string; root: { sha256: string; bytes: number }; files: TenantCatalogFile[];
  providerAuthority: false; reclaimEligible: false };
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function need(value:unknown):asserts value {if(!value)throw new Error("native_tenant_catalog_refused");}
const cap={root:bounds.rootBytes,shard:bounds.shardBytes,leaf:bounds.leafBytes,legacy:bounds.legacyBytes};
function file(kind:NativeHistoricalMetadataKind,content:Buffer,businessId?:string):TenantCatalogFile {
  need(content.length>0&&content.length<=cap[kind]&&(!businessId||kind==="leaf"&&UUID.test(businessId)));
  return {kind,sha256:nativeArchiveByteDigest(content),bytes:content.length,content:Buffer.from(content),...(businessId?{businessId}:{})};
}
const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value));
const jobs=(content:Buffer)=>[...new Set(openImmutableNativeHistoricalArchiveCatalog(content,nativeArchiveByteDigest(content)).entries.map(e=>e.generation.jobRunId))].sort();
function verifyLegacy(root:NativeHistoricalRoutingRoot,content:Buffer) {
  need(content.length===root.legacy.bytes&&nativeArchiveByteDigest(content)===root.legacy.sha256&&
    JSON.stringify(jobs(content))===JSON.stringify(root.legacy.jobRunIds));
}
function finish(previousRootSha256:string,legacy:NativeHistoricalRoutingRoot["legacy"],
  shards:NativeHistoricalRoutingRoot["shards"],files:TenantCatalogFile[]):TenantCatalogDelta {
  const content=bytes({contract:NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT,leafLayout:NATIVE_HISTORICAL_TENANT_LEAF_LAYOUT,
    legacy,shards:[...shards].sort((a,b)=>a.bucket.localeCompare(b.bucket))});
  const f=file("root",content);decodeNativeHistoricalRoutingRoot(content,f.sha256,legacy.sha256);
  return {contract:NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT,previousRootSha256,root:{sha256:f.sha256,bytes:f.bytes},
    files:[...files,f],providerAuthority:false,reclaimEligible:false};
}
function readShards(root:NativeHistoricalRoutingRoot,contents:Buffer[]) {
  need(contents.length===root.shards.length);
  const bySha=new Map(contents.map(content=>[nativeArchiveByteDigest(content),content]));
  need(bySha.size===contents.length);
  return root.shards.map(ref=>{const content=bySha.get(ref.sha256);need(content);return {
    ref,content,decoded:decodeNativeHistoricalRoutingShard(content,ref,root.legacy.jobRunIds)};});
}

/** Copy-only conversion of the small legacy forest. Every old root/shard/leaf
 * and its full generation is verified; leaf contents and ciphertext pointers
 * remain byte-identical. The caller supplies the actual complete old graph. */
export function prepareTenantCatalogMigration(input:{root:Buffer;rootSha256:string;legacy:Buffer;shards:Buffer[];leaves:Buffer[]}) {
  const root=decodeNativeHistoricalRoutingRoot(input.root,input.rootSha256,nativeArchiveByteDigest(input.legacy));
  verifyLegacy(root,input.legacy);need(root.contract!==NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT);
  const shards=readShards(root,input.shards),records=shards.flatMap(s=>s.decoded.records);
  need(records.length===input.leaves.length&&input.leaves.length<=256);
  const leaves=new Map(input.leaves.map(content=>[nativeArchiveByteDigest(content),content]));need(leaves.size===records.length);
  const files:TenantCatalogFile[]=[file("legacy",input.legacy),...shards.map(s=>file("shard",s.content))];
  for(const r of records){const content=leaves.get(r.leaf.sha256);need(content);
    decodeNativeHistoricalRoutingLeaf(content,r.leaf.sha256,r.generation,r.leaf.bytes);
    files.push(file("leaf",content,r.generation.businessId));}
  return finish(input.rootSha256,root.legacy,root.shards,files);
}

export function prepareTenantCatalogAppend(input:{root:Buffer;rootSha256:string;legacySha256:string;shard:Buffer|null;leaf:Buffer}) {
  const root=decodeNativeHistoricalRoutingRoot(input.root,input.rootSha256,input.legacySha256);
  need(root.contract===NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT);
  const leaf=file("leaf",input.leaf),catalog=decodeNativeHistoricalRoutingLeaf(input.leaf,leaf.sha256);
  need(catalog.contract===NATIVE_HISTORICAL_COMPACT_ROOT_CATALOG_CONTRACT);
  const generation=catalog.entries[0]!.generation,bucket=nativeHistoricalGenerationBucket(generation.jobRunId);
  const reference=root.shards.find(s=>s.bucket===bucket);
  need(Boolean(reference)===Boolean(input.shard)&&!root.legacy.jobRunIds.includes(generation.jobRunId));
  const prior=reference?decodeNativeHistoricalRoutingShard(input.shard!,reference,root.legacy.jobRunIds).records:[];
  need(!prior.some(r=>r.generation.jobRunId===generation.jobRunId));
  const records=[...prior,{generation,leaf:{sha256:leaf.sha256,bytes:leaf.bytes}}].sort((a,b)=>a.generation.jobRunId.localeCompare(b.generation.jobRunId));
  const next=file("shard",bytes({contract:NATIVE_HISTORICAL_SHARD_CONTRACT,bucket,records}));
  const ref={bucket,sha256:next.sha256,bytes:next.bytes};decodeNativeHistoricalRoutingShard(next.content,ref,root.legacy.jobRunIds);
  return finish(input.rootSha256,root.legacy,[...root.shards.filter(s=>s.bucket!==bucket),ref],
    [{...leaf,businessId:generation.businessId},next]);
}

/** Business offboarding removes only that tenant's records. Every current
 * shard is independently verified; foreign records and leaf pointers are kept.
 * Selected leaf/ciphertext/copy removal is a separate durable saga. */
export function prepareTenantCatalogBusinessRemoval(input:{root:Buffer;rootSha256:string;legacy:Buffer;shards:Buffer[];businessId:string}) {
  need(UUID.test(input.businessId));
  const root=decodeNativeHistoricalRoutingRoot(input.root,input.rootSha256,nativeArchiveByteDigest(input.legacy));
  need(root.contract===NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT);verifyLegacy(root,input.legacy);
  const original=openImmutableNativeHistoricalArchiveCatalog(input.legacy,root.legacy.sha256);
  const raw=JSON.parse(input.legacy.toString("utf8"));
  raw.entries=raw.entries.filter((e:{generation:{businessId:string}})=>e.generation.businessId!==input.businessId);
  if(raw.groups)raw.groups=raw.groups.filter((g:{coverageRootSha256:string})=>{
    const verified=original.groups?.find(r=>r.coverageRootSha256===g.coverageRootSha256);need(verified);
    return verified.coverageRoot.core.generation.businessId!==input.businessId;});
  const legacy=file("legacy",bytes(raw)),verified=openImmutableNativeHistoricalArchiveCatalog(legacy.content,legacy.sha256);
  need(JSON.stringify(verified.entries)===JSON.stringify(original.entries.filter(e=>e.generation.businessId!==input.businessId)));
  const files:TenantCatalogFile[]=[legacy],references:NativeHistoricalRoutingRoot["shards"]=[];
  const removed:NativeHistoricalRoutingShard["records"]=[];
  for(const s of readShards(root,input.shards)){
    const records=s.decoded.records.filter(r=>r.generation.businessId!==input.businessId);
    removed.push(...s.decoded.records.filter(r=>r.generation.businessId===input.businessId));
    if(records.length===s.decoded.records.length){references.push(s.ref);continue;}
    if(!records.length)continue;
    const f=file("shard",bytes({...s.decoded,records})),ref={bucket:s.ref.bucket,sha256:f.sha256,bytes:f.bytes};
    decodeNativeHistoricalRoutingShard(f.content,ref,jobs(legacy.content));files.push(f);references.push(ref);
  }
  return {...finish(input.rootSha256,{sha256:legacy.sha256,bytes:legacy.bytes,jobRunIds:jobs(legacy.content)},references,files),removed};
}
