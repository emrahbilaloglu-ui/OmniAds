import { EventEmitter } from "node:events";
import { beforeEach,expect,it,vi } from "vitest";
const scenario=vi.hoisted(()=>({code:""}));
vi.mock("node:child_process",()=>({spawn:()=>{
  const p=new EventEmitter() as EventEmitter&{stdout:EventEmitter;stderr:EventEmitter;stdin:EventEmitter&{write:(s:string)=>boolean;end:()=>void};kill:()=>boolean};
  p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdin=Object.assign(new EventEmitter(),{
    write:()=>{queueMicrotask(()=>p.stdout.emit("data",Buffer.from(JSON.stringify({type:"error",code:scenario.code,sqlState:null})+"\n")));return true;},end:()=>undefined});
  p.kill=()=>{queueMicrotask(()=>p.emit("close",1));return true;};return p;
}}));
import { runColdChild } from "./child";
beforeEach(()=>{scenario.code="";});
it("preserves actual typed retained-pin codes containing reviewed lowercase table/class identifiers",async()=>{
  scenario.code="RETAINED_PIN_VETO:job_dependencies:non_terminal";
  await expect(runColdChild({} as never,"capture")).rejects.toThrow(scenario.code);
});
it("does not expose arbitrary free-form diagnostics or credential-like content",async()=>{
  scenario.code="database failed with https://user:secret@example.invalid/db";
  await expect(runColdChild({} as never,"capture")).rejects.toThrow("COLD_CHILD_REFUSED");
});
