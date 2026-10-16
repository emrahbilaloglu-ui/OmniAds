import { gzipSync,gunzipSync } from "node:zlib";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { archiveCanonical,archiveDigest } from "../../lib/business-archive-configuration";
import { openImmutableNativeHistoricalArchiveCatalog,openNativeHistoricalArchiveEnvelope,
  NATIVE_HISTORICAL_COMPACT_ROOT_CATALOG_CONTRACT } from "../../lib/creative-decision-engine/native-historical-archive";
import { reassembleNativeReferenceArchive } from "../../lib/creative-decision-engine/native-reference-archive-segments";
import type { NativeCalibrationParentBundle } from "../../lib/creative-decision-engine/native-calibration-parent-archive";
import type { NativeArchiveGeneration } from "../../lib/creative-decision-engine/native-evidence-archive";
import type { UnitConfig,sealWholeOriginal } from "../native-storage-batch/capture";
import { unitScope } from "../native-storage-batch/retire";
import { COMPACT_UNIT_CONFIG_CONTRACT,canonicalSha,need,privateDirectory,readExact,same,SHA,writeExclusive } from "../native-storage-batch/common";

/** Cold-only private format. Runtime served v4 and legacy finite/private
 * formats are unchanged. The v4 leaf stores its root/trust ONCE, rather than
 * repeating that same root in every private part's trust.json and capture. */
export const COLD_PRIVATE_ORIGINAL="native-cold-private-original.v1";
export interface ColdPrivateDescriptor {contract:typeof COLD_PRIVATE_ORIGINAL;generation:NativeArchiveGeneration;
  proofSha256:string;manifestHash:string;schemaHash:string;coverageRootSha256:string;leafSha256:string;leafBytes:number;
  config:{sha256:string;decodedSha256:string;bytes:number;decodedBytes:number};
  parts:{ciphertextSha256:string;ciphertextBytes:number}[]}
const CONFIG_MAX=4*1024**2,CONFIG_GZIP_MAX=2*1024**2;
function descriptor(d:ColdPrivateDescriptor){
  need(d.contract===COLD_PRIVATE_ORIGINAL&&[d.proofSha256,d.manifestHash,d.schemaHash,d.coverageRootSha256,d.leafSha256,
    d.config?.sha256,d.config?.decodedSha256].every(x=>SHA.test(x))&&
    Number.isSafeInteger(d.leafBytes)&&d.leafBytes>0&&d.leafBytes<=944*1024&&
    Number.isSafeInteger(d.config.bytes)&&d.config.bytes>0&&d.config.bytes<=CONFIG_GZIP_MAX&&
    Number.isSafeInteger(d.config.decodedBytes)&&d.config.decodedBytes>0&&d.config.decodedBytes<=CONFIG_MAX&&
    Array.isArray(d.parts)&&d.parts.length>=1&&d.parts.length<=16&&new Set(d.parts.map(p=>p.ciphertextSha256)).size===d.parts.length&&
    d.parts.every(p=>SHA.test(p.ciphertextSha256)&&Number.isSafeInteger(p.ciphertextBytes)&&p.ciphertextBytes>0&&p.ciphertextBytes<=2*1024**2),
    "EXACT_COMPACT_PRIVATE_DESCRIPTOR");return d;
}
export async function persistColdPrivateOriginal(directory:string,sealed:ReturnType<typeof sealWholeOriginal>,config:UnitConfig){
  await privateDirectory(directory);unitScope(config,sealed.metadata.proofSha256);
  need(config.contract===COMPACT_UNIT_CONFIG_CONTRACT&&same(config.generation,sealed.metadata.generation),"COMPACT_PRIVATE_CONFIG_REQUIRED");
  // Preserve original property order too: legacy C3 proofs compare some
  // structured measurement tuples with JSON.stringify. The existing canonical
  // unit digest still binds their values; this gzip round-trips original bytes.
  const decoded=Buffer.from(JSON.stringify(config)),compressed=gzipSync(decoded,{level:9});
  need(decoded.length<=CONFIG_MAX&&compressed.length<=CONFIG_GZIP_MAX,"PRIVATE_CONFIG_COMPRESSION_BOUND");
  const d:ColdPrivateDescriptor=descriptor({contract:COLD_PRIVATE_ORIGINAL,generation:config.generation,
    proofSha256:sealed.metadata.proofSha256,manifestHash:sealed.metadata.manifestHash,schemaHash:sealed.metadata.schemaHash,
    coverageRootSha256:sealed.metadata.coverageRootSha256,leafSha256:sealed.metadata.leafSha256,leafBytes:sealed.leaf.length,
    config:{sha256:archiveDigest(compressed),decodedSha256:archiveDigest(decoded),bytes:compressed.length,decodedBytes:decoded.length},
    parts:sealed.metadata.parts.map(p=>({ciphertextSha256:p.ciphertextSha256,ciphertextBytes:p.ciphertextBytes}))});
  for(const p of sealed.sealedParts)await writeExclusive(join(directory,`${p.trust.ciphertextSha256}.bin`),p.bytes);
  await writeExclusive(join(directory,`leaf-${d.leafSha256}.json`),sealed.leaf);
  await writeExclusive(join(directory,"config.json.gz"),compressed);
  // Completion descriptor is LAST; its existence alone is never a restore or
  // source-retirement receipt. All files are independently re-read below.
  await writeExclusive(join(directory,"capture.json"),archiveCanonical(d));return d;
}
export async function readColdPrivateConfig(directory:string,expectedProof:string){
  const d=descriptor(JSON.parse((await readExact(join(directory,"capture.json"),32768)).toString("utf8")));
  need(d.proofSha256===expectedProof,"PRIVATE_ORIGINAL_PROOF_BINDING");
  const bytes=await readExact(join(directory,"config.json.gz"),CONFIG_GZIP_MAX);
  need(bytes.length===d.config.bytes&&archiveDigest(bytes)===d.config.sha256,"PRIVATE_CONFIG_CIPHERTEXT_HASH");
  const plain=gunzipSync(bytes,{maxOutputLength:CONFIG_MAX});
  need(plain.length===d.config.decodedBytes&&archiveDigest(plain)===d.config.decodedSha256,"PRIVATE_CONFIG_DECODED_HASH");
  const config=JSON.parse(plain.toString("utf8")) as UnitConfig;unitScope(config,expectedProof);
  need(config.contract===COMPACT_UNIT_CONFIG_CONTRACT&&archiveCanonical(config.generation)===archiveCanonical(d.generation)&&canonicalSha(config)===expectedProof,
    "PRIVATE_CONFIG_SOURCE_SCOPE");return {config,descriptor:d};
}
export async function verifyColdPrivateOriginal(directories:[string,string],held:Buffer,expectedProof:string){
  need(held.length===32,"PRIVATE_ORIGINAL_KEY");
  const copies=await Promise.all(directories.map(p=>readColdPrivateConfig(p,expectedProof))),first=copies[0]!;
  need(archiveCanonical(first)===archiveCanonical(copies[1]),"PRIVATE_ORIGINAL_COPY_METADATA_DRIFT");
  const d=first.descriptor,files=["capture.json","config.json.gz",`leaf-${d.leafSha256}.json`,...d.parts.map(p=>`${p.ciphertextSha256}.bin`)].sort();
  for(const dir of directories)need(same((await readdir(dir)).sort(),files),"COMPLETE_PRIVATE_ORIGINAL_FILE_SET");
  const leaves=await Promise.all(directories.map(dir=>readExact(join(dir,`leaf-${d.leafSha256}.json`),944*1024)));
  need(leaves.every(b=>b.length===d.leafBytes&&archiveDigest(b)===d.leafSha256),"PRIVATE_LEAF_COPY_HASH");
  const catalog=openImmutableNativeHistoricalArchiveCatalog(leaves[0]!,d.leafSha256);
  need(catalog.contract===NATIVE_HISTORICAL_COMPACT_ROOT_CATALOG_CONTRACT&&catalog.entries.length===d.parts.length&&
    catalog.entries.every(e=>archiveCanonical(e.generation)===archiveCanonical(d.generation)&&e.object.layout==="tenant.v1"&&e.segment?.coverageRootSha256===d.coverageRootSha256),
    "PRIVATE_LEAF_ORIGINAL_COVERAGE");
  const parts:NativeCalibrationParentBundle[]=[];
  for(const p of d.parts){
    const e=catalog.entries.find(e=>e.ciphertextSha256===p.ciphertextSha256);need(e&&e.ciphertextBytes===p.ciphertextBytes,"PRIVATE_COMPLETE_PART_SET");
    const content=await Promise.all(directories.map(dir=>readExact(join(dir,`${p.ciphertextSha256}.bin`),2*1024**2)));
    need(content.every(b=>b.length===p.ciphertextBytes&&archiveDigest(b)===p.ciphertextSha256),"PRIVATE_ORIGINAL_CIPHER_HASH");
    parts.push(openNativeHistoricalArchiveEnvelope(content[0]!,e,held,d.generation).bundle);
  }
  const root=catalog.entries[0]!.segment!.coverageRoot;
  const whole=reassembleNativeReferenceArchive(parts,root,d.coverageRootSha256);
  need(whole.manifestHash===d.manifestHash&&whole.bundle.manifest.schemaHash===d.schemaHash&&
    Buffer.byteLength(JSON.stringify(whole.bundle))<=64*1024**2,"PRIVATE_WHOLE_ORIGINAL_PARITY");
  return {whole,config:first.config,descriptor:d,files:files.length,
    privateBytes:d.parts.reduce((n,p)=>n+p.ciphertextBytes,0)+d.leafBytes+d.config.bytes+Buffer.byteLength(archiveCanonical(d))};
}
