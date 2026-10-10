import {spawn,spawnSync} from "node:child_process";
import {mkdtemp,readFile,realpath,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";

it("starts the actual image entry command, emits anonymous health while disabled, and shuts down cleanly",async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"archive-role-entry-")));
  const env={...process.env,DATABASE_URL:"",BUSINESS_ARCHIVE_ERASURE_ENABLED:"false",
    ENGINE_V3_NATIVE_ARCHIVE_ACTIVE_POINTER:join(root,"active.json"),APP_BUILD_ID:"f".repeat(40),ADSECUTE_IMAGE_BUILD_ID:"f".repeat(40)};
  const child=spawn(process.execPath,["--import","tsx","scripts/business-archive-erasure-worker.ts"],{env,stdio:"pipe"});
  let stderr="";child.stderr.on("data",b=>{stderr+=b;});
  const exit=new Promise<number|null>(resolve=>child.once("exit",resolve));
  try{
    let health:Record<string,unknown>|undefined;
    for(let n=0;n<40;n++){
      try{health=JSON.parse(await readFile(join(root,"health.json"),"utf8"));break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    expect(stderr).toBe("");expect(health).toMatchObject({contract:"business-archive-erasure-health.v1",outcome:"disabled",reason:null});
    expect(Object.keys(health!).sort()).toEqual(["buildId","contract","observedAt","outcome","reason"]);
    expect(spawnSync(process.execPath,["--import","tsx","scripts/business-archive-erasure-healthcheck.ts"],{env}).status).toBe(0);
    await writeFile(join(root,"health.json"),JSON.stringify({...health,observedAt:"2020-01-01T00:00:00Z"}));
    expect(spawnSync(process.execPath,["--import","tsx","scripts/business-archive-erasure-healthcheck.ts"],{env}).status).toBe(1);
    child.kill("SIGTERM");expect(await exit).toBe(0);
  }finally{if(child.exitCode===null)child.kill("SIGKILL");await exit;await rm(root,{recursive:true,force:true});}
});
