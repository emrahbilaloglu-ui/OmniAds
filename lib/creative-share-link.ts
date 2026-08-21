const CREATIVE_SHARE_TOKEN = /^[a-f0-9]{32}$/;

export interface CreativeShareLinkResponse {
  token?: unknown;
  path?: unknown;
  url?: unknown;
}

export function normalizeCreativeShareToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  return CREATIVE_SHARE_TOKEN.test(token) ? token : null;
}

export function creativeSharePath(tokenValue: unknown): string | null {
  const token = normalizeCreativeShareToken(tokenValue);
  return token ? `/share/creative/${token}` : null;
}

function tokenFromPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, "https://share.invalid");
    const match = url.pathname.match(/^\/share\/creative\/([^/]+)\/?$/);
    return normalizeCreativeShareToken(match?.[1]);
  } catch {
    return null;
  }
}

/**
 * Turn a share response into a portable URL.
 *
 * The server intentionally returns a path, not an origin derived from an
 * untrusted Host header. The signed-in browser owns the canonical origin and
 * reconstructs the URL from the opaque token. A server-supplied absolute URL
 * is therefore never trusted as the destination.
 */
export function resolveCreativeShareUrl(
  response: CreativeShareLinkResponse,
  browserOrigin: string,
): string | null {
  const token =
    normalizeCreativeShareToken(response.token) ??
    tokenFromPath(response.path) ??
    tokenFromPath(response.url);
  const path = creativeSharePath(token);
  if (!path) return null;

  try {
    const origin = new URL(browserOrigin);
    if (origin.protocol !== "https:" && origin.protocol !== "http:") return null;
    return new URL(path, origin.origin).toString();
  } catch {
    return null;
  }
}
