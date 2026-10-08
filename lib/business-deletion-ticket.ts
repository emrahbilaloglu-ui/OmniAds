import { createHmac, timingSafeEqual } from "node:crypto";

// A stateless, session-bound read receipt survives removal of the job and its
// business. It grants no mutation authority and leaves no deletion tombstone.
export function issueBusinessDeletionTicket(key: string, businessId: string, sessionId: string,
  now = Date.now()) {
  if (!key || !sessionId) throw new Error("deletion_monitor_session_missing");
  const payload = Buffer.from(JSON.stringify({ businessId, sessionId, expiresAt: now + 60 * 60_000 })).toString("base64url");
  return payload + "." + createHmac("sha256", key).update(payload).digest("base64url");
}

export function verifyBusinessDeletionTicket(ticket: unknown, key: string, businessId: string, sessionId: string,
  now = Date.now()) {
  if (typeof ticket !== "string" || ticket.length > 1024 || !key || !sessionId) return false;
  const [payload, signature, extra] = ticket.split(".");
  if (!payload || !signature || extra !== undefined) return false;
  const expected = createHmac("sha256", key).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.businessId === businessId && data.sessionId === sessionId
      && typeof data.expiresAt === "number" && data.expiresAt > now && data.expiresAt <= now + 60 * 60_000;
  } catch { return false; }
}
