/**
 * Klaviyo OAuth configuration.
 *
 * Shaped exactly like `lib/oauth/google-config.ts`: env-var reads behind
 * getters that throw a named error when the variable is absent, a derived
 * redirect URI off `NEXT_PUBLIC_APP_URL`, and a fixed scope list.
 *
 * Required env vars — this repo holds NONE of them today:
 *   KLAVIYO_CLIENT_ID      – the Klaviyo OAuth app's client id
 *   KLAVIYO_CLIENT_SECRET  – the Klaviyo OAuth app's client secret
 *   NEXT_PUBLIC_APP_URL    – e.g. https://app.adsecute.com (already used)
 * Optional:
 *   KLAVIYO_API_REVISION   – pins the `revision` header; defaults below
 *
 * `isKlaviyoOAuthConfigured()` is the honest boundary R7 asks for: without both
 * secrets the start route answers 501 and the Integrations card shows no
 * button, rather than offering a Connect click that cannot possibly succeed.
 */

function readKlaviyoClientId() {
  const value = process.env.KLAVIYO_CLIENT_ID;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readKlaviyoClientSecret() {
  const value = process.env.KLAVIYO_CLIENT_SECRET;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * True only when BOTH halves of the client credential are present.
 *
 * A client id without a secret cannot complete the token exchange, so treating
 * it as "configured" would move the failure from a clear 501 at the start of
 * the flow to an opaque error after the user has already authorized in
 * Klaviyo's UI.
 */
export function isKlaviyoOAuthConfigured(): boolean {
  return readKlaviyoClientId() != null && readKlaviyoClientSecret() != null;
}

/** The env vars an operator must set, named once so the 501 can list them. */
export const KLAVIYO_REQUIRED_ENV_VARS = [
  "KLAVIYO_CLIENT_ID",
  "KLAVIYO_CLIENT_SECRET",
] as const;

/**
 * Read-only scopes, and read-only deliberately.
 *
 * The design's Klaviyo screen carries a "BETA — read-only analysis" chip
 * (design 1700) and this subsystem performs no provider write of any kind, so
 * requesting a `:write` scope would grant an authority the product does not
 * use and the guarded-write path does not cover.
 */
export const KLAVIYO_SCOPES = [
  "accounts:read",
  "flows:read",
  "metrics:read",
] as const;

/** Klaviyo dates its API by header; pinned so a server-side default cannot move under us. */
const DEFAULT_KLAVIYO_API_REVISION = "2024-10-15";

export const KLAVIYO_CONFIG = {
  get clientId() {
    const value = readKlaviyoClientId();
    if (!value) {
      throw new Error(
        "KLAVIYO_CLIENT_ID is not set in environment variables.",
      );
    }
    return value;
  },
  get clientSecret() {
    const value = readKlaviyoClientSecret();
    if (!value) {
      throw new Error(
        "KLAVIYO_CLIENT_SECRET is not set in environment variables.",
      );
    }
    return value;
  },
  get redirectUri() {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    return `${base}/api/oauth/klaviyo/callback`;
  },
  get apiRevision() {
    const raw = process.env.KLAVIYO_API_REVISION;
    return typeof raw === "string" && raw.trim() !== ""
      ? raw.trim()
      : DEFAULT_KLAVIYO_API_REVISION;
  },
  authUrl: "https://www.klaviyo.com/oauth/authorize",
  tokenUrl: "https://a.klaviyo.com/oauth/token",
  apiBase: "https://a.klaviyo.com/api",
  scopes: KLAVIYO_SCOPES,
} as const;

/**
 * The token endpoint authenticates the CLIENT with HTTP Basic, not with body
 * parameters, so the secret never appears in a form body that a proxy log
 * might capture.
 */
export function klaviyoBasicAuthHeader(): string {
  const credential = `${KLAVIYO_CONFIG.clientId}:${KLAVIYO_CONFIG.clientSecret}`;
  return `Basic ${Buffer.from(credential, "utf8").toString("base64")}`;
}
