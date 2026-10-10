import { createHmac } from "node:crypto";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { NextRequest,NextResponse } from "next/server";
import { issueBusinessDeletionTicket } from "@/lib/business-deletion-ticket";
vi.mock("@/lib/admin-auth",()=>({requireAdmin:vi.fn()}));
vi.mock("@/lib/db",()=>({getDb:vi.fn()}));
vi.mock("@/lib/request-language",()=>({resolveRequestLanguage:vi.fn(async()=>"en")}));
vi.mock("@/lib/business-deletion-jobs",async original=>({...await original<typeof import("@/lib/business-deletion-jobs")>(),enqueueBusinessDeletion:vi.fn()}));
const access=await import("@/lib/admin-auth"),db=await import("@/lib/db");
const jobs=await import("@/lib/business-deletion-jobs");
const {POST,GET}=await import("./route");
describe("authorized deletion status after membership erasure",()=>{
  const key="fixture-session-cookie",business="75f65b18-97e5-426c-a791-a8f693d34c84",session="fixture-session";
  const query=vi.fn();
  function request(ticket:unknown=issueBusinessDeletionTicket(key,business,session)) {
    return new NextRequest("https://example.invalid/api/businesses/"+business+"/deletion-status",{
      method:"POST",headers:{Cookie:"omniads_session="+key,"Content-Type":"application/json"},body:JSON.stringify({monitorTicket:ticket}),
    });
  }
  beforeEach(()=>{
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY","fixture-server-master-key");vi.resetAllMocks();vi.mocked(access.requireAdmin).mockResolvedValue({session:{sessionId:session} as never});
    vi.mocked(db.getDb).mockReturnValue({query} as never);query.mockResolvedValue([]);
  });
  afterEach(()=>vi.unstubAllEnvs());
  it("requires a current authenticated session before any lookup",async()=>{
    vi.mocked(access.requireAdmin).mockResolvedValue({error:NextResponse.json({}, {status:401})});
    expect((await POST(request(),{params:Promise.resolve({businessId:business})})).status).toBe(401);expect(query).not.toHaveBeenCalled();
  });
  it("denies an ordinary customer's old valid ticket and GET before exposing cleanup state", async () => {
    vi.mocked(access.requireAdmin).mockResolvedValue({error:NextResponse.json({}, {status:403})});
    expect((await POST(request(),{params:Promise.resolve({businessId:business})})).status).toBe(403);
    expect((await GET(request(),{params:Promise.resolve({businessId:business})})).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
  it("lets only the currently authorized application owner monitor without a customer receipt", async () => {
    const r=await GET(request(),{params:Promise.resolve({businessId:business})});
    expect(await r.json()).toEqual({status:"ok"});
  });
  it("lets the current application owner retry a hidden failed job without a customer monitoring credential",async()=>{
    vi.mocked(jobs.enqueueBusinessDeletion).mockResolvedValue({status:"queued"} as never);
    const req=new NextRequest("https://example.invalid/api/businesses/"+business+"/deletion-status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"retry"})});
    const r=await POST(req,{params:Promise.resolve({businessId:business})});
    expect(r.status).toBe(202);expect(await r.json()).toEqual({status:"queued"});expect(jobs.enqueueBusinessDeletion).toHaveBeenCalledWith(business);
    vi.mocked(access.requireAdmin).mockResolvedValue({error:NextResponse.json({}, {status:403})});vi.mocked(jobs.enqueueBusinessDeletion).mockClear();
    expect((await POST(req,{params:Promise.resolve({businessId:business})})).status).toBe(403);expect(jobs.enqueueBusinessDeletion).not.toHaveBeenCalled();
  });
  it("refuses forged, wrong-session and wrong-business receipts before any lookup",async()=>{
    for(const ticket of ["forged",issueBusinessDeletionTicket(key,business,"other"),issueBusinessDeletionTicket(key,"other",session)]) {
      expect((await POST(request(ticket),{params:Promise.resolve({businessId:business})})).status).toBe(403);
    }
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects caller-cookie signatures for arbitrary businesses before any database read",async()=>{
    const payload=Buffer.from(JSON.stringify({businessId:business,sessionId:session,expiresAt:Date.now()+60*60_000})).toString("base64url");
    const forged=payload+"."+createHmac("sha256",key).update(payload).digest("base64url");
    expect((await POST(request(forged),{params:Promise.resolve({businessId:business})})).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
  it("confirms the erased root with no job/membership/tombstone remaining",async()=>{
    const r=await POST(request(),{params:Promise.resolve({businessId:business})});
    expect(await r.json()).toEqual({status:"ok"});expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each(["queued","running"])("keeps %s distinct from completion",async status=>{
    query.mockResolvedValue([{status}]);expect(await (await POST(request(),{params:Promise.resolve({businessId:business})})).json()).toEqual({status});
  });
  it("exposes the concrete rollback reason and refuses an orphaned status",async()=>{
    query.mockResolvedValue([{status:"failed",error_code:"scope_conflict",error_tables:[]}]);
    expect(await (await POST(request(),{params:Promise.resolve({businessId:business})})).json()).toMatchObject({status:"failed",error:"scope_conflict"});
    query.mockResolvedValue([{status:null}]);
    expect(await (await POST(request(),{params:Promise.resolve({businessId:business})})).json()).toMatchObject({status:"failed"});
  });
});
