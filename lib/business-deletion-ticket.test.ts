import { describe,expect,it } from "vitest";
import { issueBusinessDeletionTicket,verifyBusinessDeletionTicket } from "./business-deletion-ticket";

describe("session-bound stateless deletion read receipt",()=>{
  const key="fixture-session-secret",business="business-a",session="session-a",now=1_000_000;
  it("survives business/job removal without a stored tombstone",()=>{
    const ticket=issueBusinessDeletionTicket(key,business,session,now);
    expect(verifyBusinessDeletionTicket(ticket,key,business,session,now+30_000)).toBe(true);
  });
  it("rejects another business, session, key, tampering and expiry",()=>{
    const ticket=issueBusinessDeletionTicket(key,business,session,now);
    expect(verifyBusinessDeletionTicket(ticket,key,"other",session,now)).toBe(false);
    expect(verifyBusinessDeletionTicket(ticket,key,business,"other",now)).toBe(false);
    expect(verifyBusinessDeletionTicket(ticket,"other",business,session,now)).toBe(false);
    expect(verifyBusinessDeletionTicket(ticket+"x",key,business,session,now)).toBe(false);
    expect(verifyBusinessDeletionTicket(ticket,key,business,session,now+60*60_000)).toBe(false);
    expect(verifyBusinessDeletionTicket("a.b.c",key,business,session,now)).toBe(false);
  });
});
