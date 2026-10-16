import { spawn } from "node:child_process";
import { lstat,mkdir,readdir,realpath,statfs } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { assertSafeArchiveDirectory } from "../../lib/business-archive-configuration";
import { restoreIntoOwnedNewDatabase } from "../native-storage-batch/restore";
import { need,sha256 } from "../native-storage-batch/common";
import type { UnitConfig } from "../native-storage-batch/capture";
import type { reassembleNativeReferenceArchive } from "../../lib/creative-decision-engine/native-reference-archive-segments";

export const PRIVATE_RESTORE_SOCKET="/run/adsecute-native-restore-socket";
export const PRIVATE_RESTORE_PORT=25432;
const CONTROL="/run/adsecute-business-erasure/cold";
const ROLE="native_restore";
export function privateRestoreDatabaseName(purpose:string){need(/^[a-f0-9]{12}$/.test(purpose),"EXACT_RESTORE_PURPOSE");return `nc_restore_${purpose}`;}
export function privateRestoreUrl(database:string){
  need(database==="postgres"||/^nc_(?:tpl_[a-f0-9]{20}|restore_[a-f0-9]{12})$/.test(database),"EXACT_PRIVATE_DATABASE");
  return `postgresql://${ROLE}@localhost/${database}?host=${encodeURIComponent(PRIVATE_RESTORE_SOCKET)}&port=${PRIVATE_RESTORE_PORT}`;
}
export function validatePrivateRestoreUrl(url:string,database:string){
  const u=new URL(url);need(u.hostname==="localhost"&&u.username===ROLE&&!u.password&&u.pathname===`/${database}`&&
    u.searchParams.get("host")===PRIVATE_RESTORE_SOCKET&&u.searchParams.get("port")===String(PRIVATE_RESTORE_PORT)&&
    u.searchParams.size===2&&url===privateRestoreUrl(database),"PRIVATE_SOCKET_ONLY");
}
async function client(database:string){
  validatePrivateRestoreUrl(privateRestoreUrl(database),database);
  need(await realpath(PRIVATE_RESTORE_SOCKET)===PRIVATE_RESTORE_SOCKET,"PRIVATE_SOCKET_CANONICAL");
  const socket=await lstat(join(PRIVATE_RESTORE_SOCKET,`.s.PGSQL.${PRIVATE_RESTORE_PORT}`));
  need(socket.isSocket()&&!socket.isSymbolicLink()&&(socket.mode&0o077)===0,"PRIVATE_SOCKET_PERMISSIONS");
  const c=new Client({host:PRIVATE_RESTORE_SOCKET,port:PRIVATE_RESTORE_PORT,user:ROLE,database,ssl:false,
    application_name:"native-cold-private-restore",connectionTimeoutMillis:4000,query_timeout:30_000});
  c.on("error",()=>undefined);await c.connect();
  try{
    const r=(await c.query(`SELECT current_user u,current_database() d,current_setting('listen_addresses') ip,
      current_setting('port') p,current_setting('server_version_num') v,pg_is_in_recovery() recovery`)).rows[0];
    need(r.u===ROLE&&r.d===database&&r.ip===""&&r.p===String(PRIVATE_RESTORE_PORT)&&
      Number(r.v)>=160000&&Number(r.v)<170000&&r.recovery===false,"PRIVATE_RESTORE_SERVER_IDENTITY");
    return c;
  }catch(e){await c.end();throw e;}
}
async function bootstrapTelemetry(database:string){
  const c=await client(database);
  try{
    const fs=await statfs(PRIVATE_RESTORE_SOCKET);
    need(fs.bavail*fs.bsize>=8*1024**3+512*1024**2,"PRIVATE_RESTORE_APP_RESERVE");
    await c.query(`CREATE TABLE public.system_capacity_snapshots (
      id BIGSERIAL PRIMARY KEY,source TEXT NOT NULL,hostname TEXT,payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      sampled_at TIMESTAMPTZ NOT NULL DEFAULT now(),created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await c.query(`INSERT INTO system_capacity_snapshots(source,hostname,payload)
      VALUES('db_host_healthcheck','private-restore-companion',$1::jsonb)`,[JSON.stringify({database:{name:database},
      disks:[{path:"/var/lib/postgresql",totalBytes:fs.blocks*fs.bsize,usedBytes:(fs.blocks-fs.bfree)*fs.bsize,
        availableBytes:fs.bavail*fs.bsize}],privateRestoreCompanion:true,
      volumeProof:"installer verified data and socket bind directories share the app-root filesystem"})]);
  }finally{await c.end();}
}
async function migrations(database:string){
  const work=join(CONTROL,"restore","work");
  for(const p of [join(CONTROL,"restore"),work]){await mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=="EEXIST")throw e;});await assertSafeArchiveDirectory(p);}
  need((await readdir(work)).length===0,"EMPTY_PRIVATE_MIGRATION_CWD_REQUIRED");
  const url=privateRestoreUrl(database);validatePrivateRestoreUrl(url,database);
  // No production/provider credentials or env files can reach this child.
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH??"/usr/bin:/bin",NODE_ENV:"production",HOME:work,
    TSX_TSCONFIG_PATH:"/app/tsconfig.json",DATABASE_URL:url,DATABASE_URL_UNPOOLED:url,DB_SSL_MODE:"disable",
    ENABLE_RUNTIME_MIGRATIONS:"1",NATIVE_COLD_RESTORE_CHILD:"1"};
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,["--import","/app/node_modules/tsx/dist/loader.mjs","/app/scripts/run-migrations.ts"],
      {cwd:work,env,stdio:"ignore"});
    const timer=setTimeout(()=>{child.kill("SIGKILL");reject(Error("PRIVATE_FULL_MIGRATION_DEADLINE"));},150_000);
    child.once("error",e=>{clearTimeout(timer);reject(e);});
    child.once("close",code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error("PRIVATE_FULL_MIGRATION_FAILED"));});
  });
}

/** Real full-schema template, versioned to the immutable image. A successful
 * receipt is never inferred from a database or file merely existing. */
async function template(build:string){
  need(/^[a-f0-9]{40}$/.test(build)&&build===process.env.APP_BUILD_ID&&build===process.env.ADSECUTE_IMAGE_BUILD_ID,
    "EXACT_RESTORE_IMAGE");
  const name=`nc_tpl_${build.slice(0,20)}`,admin=await client("postgres");
  try{
    need((await admin.query("SELECT pg_try_advisory_lock(1948017421,0) held")).rows[0].held===true,"PRIVATE_TEMPLATE_BUSY");
    const exists=(await admin.query("SELECT datname FROM pg_database WHERE datname=$1",[name])).rows.length===1;
    if(exists){
      const c=await client(name);
      try{const r=(await c.query("SELECT obj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
        need(r.marker===`native-cold-full-ddl:${build}`,"PRIVATE_TEMPLATE_UNACKNOWLEDGED");}
      finally{await c.end();}
      return name;
    }
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    await bootstrapTelemetry(name);await migrations(name);
    await admin.query(`COMMENT ON DATABASE "${name}" IS 'native-cold-full-ddl:${build}'`);
    return name;
  }finally{await admin.query("SELECT pg_advisory_unlock(1948017421,0)").catch(()=>undefined);await admin.end();}
}

/** Only derived plaintext targets of this exact purpose; never source URLs,
 * source tables, archive copies or a general user-selected database name. */
export async function dropPrivateRestore(purpose:string){
  const name=privateRestoreDatabaseName(purpose),admin=await client("postgres");
  try{
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    need((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1",[name])).rows.length===0,"PRIVATE_PLAINTEXT_TARGET_SURVIVES");
  }finally{await admin.end();}
}
export async function restoreOriginalPrivately(whole:ReturnType<typeof reassembleNativeReferenceArchive>,config:UnitConfig,purpose:string){
  const build=process.env.APP_BUILD_ID??"",tpl=await template(build),name=privateRestoreDatabaseName(purpose);
  const admin=await client("postgres");
  try{
    need((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1",[name])).rows.length===0,"NEW_PRIVATE_TARGET_REQUIRED");
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${tpl}"`);
  }finally{await admin.end();}
  let result:Awaited<ReturnType<typeof restoreIntoOwnedNewDatabase>>;
  try{
    const c=await client(name);
    try{result=await restoreIntoOwnedNewDatabase(c,whole,config);}finally{await c.end();}
  }finally{await dropPrivateRestore(purpose);}
  return {...result,plaintextRestoreDropped:true,templateBuildId:build,
    restoredProofSha256:sha256(JSON.stringify(result.tableHashes)),privateSocketOnly:true,fullDisasterRecovery:false};
}
