import type { NextRequest } from "next/server";

/**
 * The client IP, taken only from a header the edge actually controls.
 *
 * nginx sets `X-Real-IP $remote_addr` (deploy/nginx/adsecute.conf:11), which
 * OVERWRITES anything the client sent, and the app publishes only
 * 127.0.0.1:3000 (docker-compose.yml), so nginx is the sole ingress and that
 * header is trustworthy.
 *
 * X-Forwarded-For is deliberately NOT used. nginx builds it with
 * `$proxy_add_x_forwarded_for`, which APPENDS the real address to whatever the
 * caller supplied — so its first entry, the value most implementations read, is
 * entirely attacker-controlled. Keying a limiter on it would let one client
 * mint unlimited identities with a header.
 */
export function getTrustedClientIp(request: NextRequest): string | null {
  const raw = request.headers.get("x-real-ip")?.trim();
  if (!raw || raw.length > 45) return null;
  return /^[0-9a-fA-F:.]+$/.test(raw) ? raw : null;
}
