import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { requireIntegrationSecretKey } from "@/lib/integration-secrets";

function deletionMonitorKey(sessionToken: string) {
  // A cookie is known to its holder, so it cannot be a server signature key.
  // Derive an independent-purpose key from the existing server master; bind the
  // derivation to this session without changing credentials or configuration.
  return Buffer.from(hkdfSync("sha256", requireIntegrationSecretKey(),
    "adsecute.business-deletion-monitor.v1", sessionToken, 32));
}

// A stateless, session-bound read receipt survives removal of the job and its
// business. It grants no mutation authority and leaves no deletion tombstone.
export function issueBusinessDeletionTicket(key: string, businessId: string, sessionId: string,
  now = Date.now()) {
  if (!key || !sessionId) throw new Error("deletion_monitor_session_missing");
  const payload = Buffer.from(JSON.stringify({ businessId, sessionId, expiresAt: now + 60 * 60_000 })).toString("base64url");
  return payload + "." + createHmac("sha256", deletionMonitorKey(key)).update(payload).digest("base64url");
}

export function verifyBusinessDeletionTicket(ticket: unknown, key: string, businessId: string, sessionId: string,
  now = Date.now()) {
  if (typeof ticket !== "string" || ticket.length > 1024 || !key || !sessionId) return false;
  const [payload, signature, extra] = ticket.split(".");
  if (!payload || !signature || extra !== undefined) return false;
  let expected: Buffer;
  try { expected = createHmac("sha256", deletionMonitorKey(key)).update(payload).digest(); }
  catch { return false; }
  const received = Buffer.from(signature, "base64url");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.businessId === businessId && data.sessionId === sessionId
      && typeof data.expiresAt === "number" && data.expiresAt > now && data.expiresAt <= now + 60 * 60_000;
  } catch { return false; }
}
