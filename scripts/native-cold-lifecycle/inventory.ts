import { readFile,readdir,writeFile } from "node:fs/promises";
import { resolve,join } from "node:path";
import { archiveCanonical,archiveDigest } from "../../lib/business-archive-configuration";
import { need } from "../native-storage-batch/common";
import { BATCH_FILES,ADMISSION_FILES,PINNED_LIBRARY_FILES } from "../native-storage-batch/source-pack";
const ROOT=resolve(__dirname,"../..");
export const COLD_INVENTORY_PATH="scripts/native-cold-lifecycle/source-inventory.json";
type Entry={path:string;sha256:string;bytes:number};
interface Inventory {contract:"native-cold-source-inventory.v1";files:Entry[];sourceInventorySha256:string}
export async function buildColdSourceInventory(root=ROOT):Promise<Inventory>{
  const ledger=JSON.parse(await readFile(join(root,"docs/architecture/native-retained-reader-ledger.json"),"utf8"));
  const rawLedger=JSON.parse(await readFile(join(root,"docs/architecture/raw-payload-reader-ledger.json"),"utf8"));
  const own=(await readdir(join(root,"scripts/native-cold-lifecycle"))).filter(n=>/\.(?:ts|py)$/.test(n)&&
    !n.includes(".test.")&&!n.endsWith("-test.py")).map(n=>`scripts/native-cold-lifecycle/${n}`);
  const extra=["docker-compose.yml","Dockerfile",".dockerignore","package.json","package-lock.json","scripts/business-archive-erasure-worker.ts","lib/business-archive-erasure-worker.ts",
    "lib/business-archive-configuration.ts","lib/business-deletion-files.ts","lib/native-tenant-erasure.ts",
    "lib/native-cold-erasure.ts","lib/native-cold-session.ts","lib/business-deletion-jobs.ts",
    "lib/native-cold-owner-status.ts","lib/admin-system-capacity.ts","app/admin/system-capacity/legacy-page.tsx",
    "lib/creative-decision-engine/native-tenant-catalog.ts","lib/creative-decision-engine/native-tenant-catalog-store.ts",
    "lib/sync/global-kill-switch.ts","lib/sync/raw-payload-storage.ts","lib/sync/raw-payload-compaction.ts",
    "lib/sync/raw-payload-reusable-space.ts","lib/sync/worker-health.ts",
    "lib/meta/status-types.ts","app/api/meta/status/route.ts","app/api/meta/account-pulse/route.ts"];
  const files:Entry[]=[];
  for(const path of [...new Set<string>([...BATCH_FILES,...ADMISSION_FILES,...PINNED_LIBRARY_FILES,...own,...extra,
    ...ledger.entries.map((e:{path:string})=>e.path),...rawLedger.entries.map((e:{path:string})=>e.path)])].sort()){
    need(!path.split("/").includes("..")&&/^[a-zA-Z0-9_./[\]-]+$/.test(path),"FIXED_SOURCE_INVENTORY_PATH");
    const b=await readFile(join(root,path));files.push({path,sha256:archiveDigest(b),bytes:b.length});
  }
  const body={contract:"native-cold-source-inventory.v1" as const,files};
  return {...body,sourceInventorySha256:archiveDigest(archiveCanonical(body))};
}
export async function writeColdSourceInventory(){
  const value=await buildColdSourceInventory();await writeFile(join(ROOT,COLD_INVENTORY_PATH),JSON.stringify(value,null,2)+"\n");
  return {sourceInventorySha256:value.sourceInventorySha256,files:value.files.length};
}
export async function verifyRuntimeColdInventory(){
  const value=JSON.parse(await readFile(join(ROOT,COLD_INVENTORY_PATH),"utf8")) as Inventory;
  const {sourceInventorySha256,...body}=value;
  need(value.contract==="native-cold-source-inventory.v1"&&/^[a-f0-9]{64}$/.test(sourceInventorySha256)&&
    sourceInventorySha256===process.env.NATIVE_COLD_SOURCE_INVENTORY_SHA256&&
    sourceInventorySha256===archiveDigest(archiveCanonical(body))&&value.files.length>0&&value.files.length<1024,
    "REVIEWED_COLD_SOURCE_INVENTORY_REQUIRED");
  const seen=new Set<string>();
  for(const e of value.files){
    need(typeof e.path==="string"&&!e.path.split("/").includes("..")&&/^[a-zA-Z0-9_./[\]-]+$/.test(e.path)&&
      !seen.has(e.path)&&/^[a-f0-9]{64}$/.test(e.sha256)&&Number.isSafeInteger(e.bytes)&&e.bytes>0,"EXACT_COLD_SOURCE_ENTRY");
    seen.add(e.path);const b=await readFile(join(ROOT,e.path));
    need(b.length===e.bytes&&archiveDigest(b)===e.sha256,"COLD_SOURCE_DRIFT");
  }
  return sourceInventorySha256;
}
