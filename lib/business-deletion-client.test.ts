import { afterEach,describe,expect,it,vi } from "vitest";
import { awaitBusinessDeletion } from "./business-deletion-client";

afterEach(()=>{vi.unstubAllGlobals();});
describe("background deletion confirmation",()=>{
  it("waits through queued/running and accepts only atomic completion",async()=>{
    const fetcher=vi.fn();
    for(const status of ["queued","running","ok"]) fetcher.mockResolvedValueOnce({ok:true,json:async()=>({status})});
    vi.stubGlobal("fetch",fetcher);const pending=vi.fn();
    await awaitBusinessDeletion("biz",{status:"queued",monitorTicket:"fixture-ticket"},pending,{pollMs:1,maxWaitMs:1000});
    expect(pending.mock.calls.map(c=>c[0])).toEqual(["queued","queued","running"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([,init])=>init.method==="POST")).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe("/api/businesses/biz/deletion-status");
  });
  it("does not call a 202 completed without its status receipt",async()=>{
    await expect(awaitBusinessDeletion("biz",{status:"queued"})).rejects.toThrow("background status could not be read");
  });
  it("preserves a specific failure and never repeats DELETE",async()=>{
    const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({status:"failed",message:"Active work blocks erasure."})});
    vi.stubGlobal("fetch",fetcher);
    await expect(awaitBusinessDeletion("biz",{status:"running",monitorTicket:"fixture"},undefined,{pollMs:1})).rejects.toThrow("Active work blocks erasure.");
    expect(fetcher.mock.calls[0][1].method).toBe("POST");
  });
  it("does not infer completion from an unreadable status endpoint",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:false,json:async()=>({})}));
    await expect(awaitBusinessDeletion("biz",{status:"running",monitorTicket:"fixture"},undefined,{pollMs:1})).rejects.toThrow("may still be running");
  });
});
