import { createHmac } from "node:crypto";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { issueBusinessDeletionTicket,verifyBusinessDeletionTicket } from "./business-deletion-ticket";

describe("session-bound stateless deletion read receipt",()=>{
  beforeEach(()=>vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY","fixture-server-master-key"));
  afterEach(()=>vi.unstubAllEnvs());
  const key="fixture-session-secret",business="business-a",session="session-a",now=1_000_000;
  it("survives business/job removal without a stored tombstone",()=>{
    const ticket=issueBusinessDeletionTicket(key,business,session,now);
    expect(verifyBusinessDeletionTicket(ticket,key,business,session,now+30_000)).toBe(true);
  });
  it("rejects a receipt forged with the caller-known cookie key",()=>{
    const payload=Buffer.from(JSON.stringify({businessId:business,sessionId:session,expiresAt:now+60*60_000})).toString("base64url");
    const forged=payload+"."+createHmac("sha256",key).update(payload).digest("base64url");
    expect(verifyBusinessDeletionTicket(forged,key,business,session,now)).toBe(false);
  });
  it("requires the server master and rejects its replacement",()=>{
    const ticket=issueBusinessDeletionTicket(key,business,session,now);
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY","other-server-master");
    expect(verifyBusinessDeletionTicket(ticket,key,business,session,now)).toBe(false);
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY","");
    expect(verifyBusinessDeletionTicket(ticket,key,business,session,now)).toBe(false);
    expect(()=>issueBusinessDeletionTicket(key,business,session,now)).toThrow(/INTEGRATION_TOKEN_ENCRYPTION_KEY/);
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
