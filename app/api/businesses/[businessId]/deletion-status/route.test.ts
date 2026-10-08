import { beforeEach,describe,expect,it,vi } from "vitest";
import { NextRequest,NextResponse } from "next/server";
import { issueBusinessDeletionTicket } from "@/lib/business-deletion-ticket";
vi.mock("@/lib/access",()=>({requireAuthedRequest:vi.fn()}));
vi.mock("@/lib/db",()=>({getDb:vi.fn()}));
vi.mock("@/lib/request-language",()=>({resolveRequestLanguage:vi.fn(async()=>"en")}));
const access=await import("@/lib/access"),db=await import("@/lib/db");
const {POST}=await import("./route");
describe("authorized deletion status after membership erasure",()=>{
  const key="fixture-session-cookie",business="75f65b18-97e5-426c-a791-a8f693d34c84",session="fixture-session";
  const query=vi.fn();
  function request(ticket:unknown=issueBusinessDeletionTicket(key,business,session)) {
    return new NextRequest("https://example.invalid/api/businesses/"+business+"/deletion-status",{
      method:"POST",headers:{Cookie:"omniads_session="+key,"Content-Type":"application/json"},body:JSON.stringify({monitorTicket:ticket}),
    });
  }
  beforeEach(()=>{
    vi.resetAllMocks();vi.mocked(access.requireAuthedRequest).mockResolvedValue({session:{sessionId:session} as never});
    vi.mocked(db.getDb).mockReturnValue({query} as never);query.mockResolvedValue([]);
  });
  it("requires a current authenticated session before any lookup",async()=>{
    vi.mocked(access.requireAuthedRequest).mockResolvedValue({error:NextResponse.json({}, {status:401})});
    expect((await POST(request(),{params:Promise.resolve({businessId:business})})).status).toBe(401);expect(query).not.toHaveBeenCalled();
  });
  it("refuses forged, wrong-session and wrong-business receipts before any lookup",async()=>{
    for(const ticket of ["forged",issueBusinessDeletionTicket(key,business,"other"),issueBusinessDeletionTicket(key,"other",session)]) {
      expect((await POST(request(ticket),{params:Promise.resolve({businessId:business})})).status).toBe(403);
    }
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
