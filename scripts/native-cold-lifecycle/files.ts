import { constants } from "node:fs";
import { lstat,mkdir,open,realpath,rename,unlink } from "node:fs/promises";
import { dirname,isAbsolute,join,relative } from "node:path";
import { archiveCanonical,archiveDigest,assertSafeArchiveDirectory,readSafeArchiveFile } from "../../lib/business-archive-configuration";
import { need } from "../native-storage-batch/common";
export const COLD_ROOT="/run/adsecute-business-erasure/cold";
export const COLD_COPY_ROOT=join(COLD_ROOT,"copies");
export function assertColdWriter(){
  need(process.env.BUSINESS_ARCHIVE_ERASURE_ROLE==="1"&&/^[a-f0-9]{40}$/.test(process.env.APP_BUILD_ID??"")&&
    process.env.APP_BUILD_ID===process.env.ADSECUTE_IMAGE_BUILD_ID,"EXACT_ARCHIVE_ONLY_ROLE");
}
export function coldPath(...parts:string[]){
  need(parts.every(p=>typeof p==="string"&&p.length>0&&!p.includes("/")&&p!=="."&&p!==".."),"FIXED_COLD_PATH_COMPONENTS");
  return join(COLD_ROOT,...parts);
}
export async function coldDirectory(path:string){
  assertColdWriter();need(isAbsolute(path)&&relative(COLD_ROOT,path).split("/").every(p=>p!=="..")&&
    (path===COLD_ROOT||path.startsWith(COLD_ROOT+"/")),"OWNED_COLD_DIRECTORY");
  await assertSafeArchiveDirectory(dirname(COLD_ROOT));let parent=dirname(COLD_ROOT);
  for(const name of relative(parent,path).split("/")){parent=join(parent,name);
    await mkdir(parent,{mode:0o700}).catch(e=>{if(e.code!=="EEXIST")throw e;});
    await assertSafeArchiveDirectory(parent);const s=await lstat(parent);need(s.uid===process.getuid?.(),"COLD_DIRECTORY_OWNER");}
  return path;
}
export async function coldJson<T>(path:string,maximum=4*1024**2):Promise<T>{
  need(path.startsWith(COLD_ROOT+"/")&&await realpath(dirname(path))===dirname(path),"OWNED_COLD_READ");
  return JSON.parse((await readSafeArchiveFile(path,maximum)).toString("utf8")) as T;
}
export async function writeColdJson(path:string,value:unknown,immutable=false){
  assertColdWriter();need(path.startsWith(COLD_ROOT+"/")&&relative(COLD_ROOT,path).split("/").every(p=>p!==".."),"OWNED_COLD_WRITE");
  await coldDirectory(dirname(path));const bytes=Buffer.from(archiveCanonical(value));need(bytes.length>0&&bytes.length<=4*1024**2,"COLD_METADATA_BOUND");
  if(immutable){try{await readSafeArchiveFile(path,bytes.length,archiveDigest(bytes));return archiveDigest(bytes);}
    catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
  const pending=path+".pending";
  try{const s=await lstat(pending);need(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid?.()&&s.nlink===1&&!(s.mode&0o077),"OWNED_PENDING_METADATA");await unlink(pending);}
  catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  const f=await open(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
  await rename(pending,path);
  const d=await open(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await d.sync();}finally{await d.close();}
  return archiveDigest(bytes);
}
