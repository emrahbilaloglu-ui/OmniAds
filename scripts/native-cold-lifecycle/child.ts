import { spawn } from "node:child_process";
import { join } from "node:path";
import { need } from "../native-storage-batch/common";
import type { ColdUnitState } from "./types";

/** One bounded child and, for C3 only, one real parent challenge. No arbitrary
 * operation/command/path/SQL, dynamic bundle, detached promise or plaintext
 * source row may cross this protocol. State intent is persisted by the caller. */
export async function runColdChild(state:ColdUnitState,op:"capture"|"restore"|"retire"|"pins"|"readback",
  parent?:(prepared:Record<string,unknown>)=>Promise<Record<string,unknown>>){
  const base={contract:"native-cold-unit-child.v1",op,purpose:state.purpose,businessId:state.businessId,
    jobRunId:state.jobRunId,sourceInventorySha256:state.sourceInventorySha256};
  const request=op==="capture"?{...base,generation:state.generation,evaluations:state.evaluations,contexts:state.contexts}:
    {...base,proofSha256:state.capture?.proofSha256};
  need(op==="capture"||!!state.capture,"CAPTURE_PROOF_BEFORE_STAGE");
  const timeout=op==="capture"?150_000:op==="restore"?240_000:op==="retire"?75_000:45_000;
  return new Promise<any>((resolve,reject)=>{
    const child=spawn(process.execPath,["--max-old-space-size=512","--import","/app/node_modules/tsx/dist/loader.mjs",
      join("/app/scripts/native-cold-lifecycle","unit-child.ts")],{cwd:"/app",env:process.env,stdio:["pipe","pipe","pipe"]});
    let buffer="",result:unknown,completed=false,prepared=false,error:Error|null=null,processing=Promise.resolve();
    const timer=setTimeout(()=>{error=Error("COLD_CHILD_DEADLINE_STATUS_ONLY");child.kill("SIGKILL");},timeout);
    const handle=async(line:string)=>{
      const value=JSON.parse(line);
      if(value.type==="prepared"){
        need(op==="retire"&&parent&&!prepared&&!completed,"EXACT_SINGLE_COLD_PARENT_CHALLENGE");prepared=true;
        const challenge=await parent(value);child.stdin.write(JSON.stringify(challenge)+"\n");
      }else if(value.type==="result"){
        need(!completed,"ONE_COLD_CHILD_RESULT");completed=true;result=value.value;child.stdin.end();
      }else{error=Object.assign(Error(typeof value.code==="string"&&/^[A-Za-z0-9_:,-]{1,160}$/.test(value.code)?value.code:"COLD_CHILD_REFUSED"),
        {code:/^[A-Z0-9]{5}$/.test(value.sqlState??"")?value.sqlState:undefined});child.kill("SIGTERM");}
    };
    child.stdout.on("data",(c:Buffer)=>{
      buffer+=c.toString("utf8");if(buffer.length>4*1024**2){error=Error("COLD_CHILD_PROTOCOL_BOUND");child.kill("SIGKILL");return;}
      let at:number;while((at=buffer.indexOf("\n"))!==-1){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
        processing=processing.then(()=>handle(line)).catch(e=>{error=e;child.kill("SIGKILL");});}
    });
    // Child diagnostics never include tokens, env or source rows. Consume to
    // avoid a pipe deadlock; the typed failure/SQLSTATE is the only public log.
    child.stderr.on("data",()=>undefined);
    child.once("error",e=>{clearTimeout(timer);reject(e);});
    child.once("close",code=>{clearTimeout(timer);void processing.then(()=>{
      if(error)reject(error);else if(code===0&&completed&&buffer.length===0)resolve(result);
      else reject(Error("COLD_CHILD_EXIT_WITHOUT_ACK_STATUS_ONLY"));
    },reject);});
    child.stdin.on("error",()=>undefined);child.stdin.write(JSON.stringify(request)+"\n");
  });
}
