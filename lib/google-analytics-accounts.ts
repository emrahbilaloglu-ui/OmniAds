import { GA_CONFIG } from "@/lib/oauth/google-analytics-config";

// ── Types ──────────────────────────────────────────────────────────

export interface GA4PropertySummary {
  /** Resource name, e.g. "properties/123456789" */
  property: string;
  /** Human-readable name */
  displayName: string;
  /** "PROPERTY_TYPE_ORDINARY" etc. */
  propertyType?: string;
  /** Parent account resource name */
  parent?: string;
}

export interface GA4AccountSummary {
  /** Resource name, e.g. "accountSummaries/123" */
  name: string;
  /** Account resource name, e.g. "accounts/123" */
  account: string;
  /** Human-readable account name */
  displayName: string;
  /** Properties under this account */
  propertySummaries?: GA4PropertySummary[];
}

/** Flattened property for UI display */
export interface GA4PropertyOption {
  propertyId: string;
  propertyName: string;
  accountId: string;
  accountName: string;
}

export interface GA4PropertyMetadata {
  propertyId: string;
  timeZone: string | null;
  /**
   * ISO 4217 code the Admin API reports for this property (`Property.currencyCode`).
   * Every GA4 money metric — `purchaseRevenue`, `itemRevenue`, `totalRevenue` —
   * is denominated in it, so without it a served revenue number has no unit.
   * `null` when the provider omitted it or returned something that is not a
   * three-letter code; never defaulted.
   */
  currencyCode: string | null;
}

export interface GA4PropertiesFetchResult {
  ok: boolean;
  error?: string;
  status?: number;
  properties: GA4PropertyOption[];
}

const GA4_PROPERTIES_TIMEOUT_MS = 10_000;

// ── Token Refresh ──────────────────────────────────────────────────

export async function refreshGA4AccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresIn: number;
}> {
  const res = await fetch(GA_CONFIG.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GA_CONFIG.clientId,
      client_secret: GA_CONFIG.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(
      data.error_description ||
        data.error ||
        "Failed to refresh Google Analytics access token.",
    );
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 3600,
  };
}

// ── Fetch GA4 Account Summaries ────────────────────────────────────

/**
 * Fetches all GA4 account summaries (accounts + properties) accessible
 * by the authenticated user. Uses the Analytics Admin API v1beta.
 *
 * Handles pagination automatically.
 */
export async function fetchGA4Properties(
  accessToken: string,
): Promise<GA4PropertiesFetchResult> {
  const allSummaries: GA4AccountSummary[] = [];
  let pageToken: string | undefined;

  try {
    do {
      const url = new URL(`${GA_CONFIG.adminApiBase}/accountSummaries`);
      url.searchParams.set("pageSize", "200");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GA4_PROPERTIES_TIMEOUT_MS);

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const errorBody = await res.text();
        console.error("[ga4-properties] API error", {
          status: res.status,
          body: errorBody,
        });

        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            status: res.status,
            error:
              "Access denied. The Google Analytics scope may not be authorized, or the token is invalid.",
            properties: [],
          };
        }

        return {
          ok: false,
          status: res.status,
          error: `Google Analytics API returned status ${res.status}.`,
          properties: [],
        };
      }

      const data = await res.json();
      const summaries: GA4AccountSummary[] = data.accountSummaries ?? [];
      allSummaries.push(...summaries);
      pageToken = data.nextPageToken;
    } while (pageToken);

    // Flatten into property options
    const properties: GA4PropertyOption[] = [];
    for (const account of allSummaries) {
      for (const prop of account.propertySummaries ?? []) {
        properties.push({
          propertyId: prop.property,
          propertyName: prop.displayName,
          accountId: account.account,
          accountName: account.displayName,
        });
      }
    }

    return { ok: true, properties };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Unknown error fetching GA4 properties.";
    console.error("[ga4-properties] fetch error", { message });
    return { ok: false, status: 500, error: message, properties: [] };
  }
}

/**
 * Validates that a property ID exists in the given list of accessible properties.
 */
export function isPropertyAccessible(
  propertyId: string,
  properties: GA4PropertyOption[],
): boolean {
  return properties.some((p) => p.propertyId === propertyId);
}

function normalizeTimezone(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * ISO 4217 alphabetic codes only. `Intl.NumberFormat` throws a RangeError on
 * anything else, and a stored non-code would take a revenue table down rather
 * than render the missing value, so a shape we do not recognise is stored as
 * absent instead of being passed through.
 */
export function normalizeCurrencyCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(trimmed) ? trimmed : null;
}

export async function fetchGA4PropertyMetadata(
  accessToken: string,
  propertyId: string,
): Promise<GA4PropertyMetadata> {
  const normalizedPropertyId = propertyId.startsWith("properties/")
    ? propertyId
    : `properties/${propertyId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GA4_PROPERTIES_TIMEOUT_MS);
  try {
    const response = await fetch(`${GA_CONFIG.adminApiBase}/${normalizedPropertyId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        body || `Google Analytics property metadata request failed (${response.status}).`,
      );
    }
    const payload = (await response.json().catch(() => null)) as
      | { timeZone?: string | null; currencyCode?: string | null }
      | null;
    return {
      propertyId: normalizedPropertyId,
      timeZone: normalizeTimezone(payload?.timeZone),
      currencyCode: normalizeCurrencyCode(payload?.currencyCode),
    };
  } finally {
    clearTimeout(timeout);
  }
}
