import { GOOGLE_CONFIG } from "@/lib/oauth/google-config";
import { fetchWithTimeout } from "@/lib/http-fetch-with-timeout";
import { logRuntimeDebug } from "@/lib/runtime-logging";

export interface GoogleAdsCustomerNormalized {
  id: string;
  rawId: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  isManager: boolean;
}

export interface GoogleAdsAccountsFetchResult {
  ok: boolean;
  error?: string;
  quotaExhausted?: boolean;
  customers: GoogleAdsCustomerNormalized[];
}

const GOOGLE_ADS_FETCH_FAILED_MESSAGE =
  "Could not load accessible Google Ads accounts.";
const GOOGLE_ADS_TIMEOUT_MS = 12_000;

interface GoogleAdsErrorPayload {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

interface GoogleAdsHttpResult {
  ok: boolean;
  status: number;
  isJson: boolean;
  bodyText: string;
  payload: unknown;
}

interface GoogleAdsDiscoveryDiagnostics {
  hasAccessToken: boolean;
  hasDeveloperToken: boolean;
  scopePresent?: boolean;
}

function normalizeGoogleAdsCustomerId(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.length !== 10) return input.trim();
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function classifyGoogleAdsError(payload: unknown, status: number) {
  const message = getGoogleAdsErrorMessage(payload);
  const upper = message?.toUpperCase() ?? "";

  logRuntimeDebug("google-ads-accounts", "classified_error", {
    status,
    message,
  });

  if (upper.includes("DEVELOPER_TOKEN_NOT_APPROVED")) {
    return "Your Google Ads developer token is not approved for this request.";
  }
  if (upper.includes("AUTHENTICATION_ERROR")) {
    return "Google rejected the OAuth credentials for Google Ads.";
  }
  if (upper.includes("PERMISSION_DENIED")) {
    return "This Google login does not have permission to access Google Ads accounts.";
  }
  if (upper.includes("CUSTOMER_NOT_FOUND")) {
    return "Google Ads could not find an accessible customer for this login.";
  }
  if (status === 429 || upper.includes("RESOURCE_EXHAUSTED") || upper.includes("QUOTA")) {
    return "Google Ads API quota exceeded. Account list will refresh automatically later today.";
  }
  if (status === 401) {
    return "Google Ads rejected the current OAuth access token.";
  }
  if (status === 403) {
    return "Google Ads denied access. Check developer token approval and account permissions.";
  }
  return message;
}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresIn: number;
}> {
  const res = await fetchWithTimeout(
    GOOGLE_CONFIG.tokenUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CONFIG.clientId,
        client_secret: GOOGLE_CONFIG.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
    { timeoutMs: 30_000, label: "Google token refresh" },
  );

  const data = await res.json();

  if (data.error) {
    throw new Error(
      data.error_description ||
        data.error ||
        "Failed to refresh Google access token.",
    );
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 3600,
  };
}

/**
 * Google Ads discovery flow:
 * 1) POST customers:listAccessibleCustomers
 * 2) POST customers/{id}/googleAds:search (FROM customer)
 */
export async function fetchGoogleAdsAccounts(
  accessToken: string,
  options?: {
    scopePresent?: boolean;
  },
): Promise<GoogleAdsAccountsFetchResult> {
  let developerToken: string;
  try {
    developerToken = GOOGLE_CONFIG.developerToken;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[google-ads-accounts] developer token missing", {
      message: detail,
    });
    return {
      ok: false,
      error: `${GOOGLE_ADS_FETCH_FAILED_MESSAGE} (developer token missing)`,
      customers: [],
    };
  }
  const diagnostics: GoogleAdsDiscoveryDiagnostics = {
    hasAccessToken: Boolean(accessToken),
    hasDeveloperToken: Boolean(developerToken),
    scopePresent: options?.scopePresent,
  };
  logRuntimeDebug("google-ads-accounts", "discovery_start", diagnostics);

  const baseCandidates = buildAdsApiBaseCandidates();
  let listResult: GoogleAdsHttpResult | null = null;
  let selectedBase: string | null = null;
  const attemptLogs: Array<{ base: string; status: number; isJson: boolean }> =
    [];

  for (const base of baseCandidates) {
    const attempt = await googleAdsRequest({
      url: `${base}/customers:listAccessibleCustomers`,
      method: "GET",
      accessToken,
      developerToken,
      logLabel: `customers:listAccessibleCustomers base=${base}`,
    });

    attemptLogs.push({ base, status: attempt.status, isJson: attempt.isJson });
    listResult = attempt;
    selectedBase = base;
    const shouldTryNextBase =
      !attempt.ok &&
      attempt.status === 404 &&
      !attempt.isJson &&
      (attempt.bodyText.includes("<!DOCTYPE html") ||
        attempt.bodyText.includes("<html"));

    if (!shouldTryNextBase) break;
  }

  if (!listResult || !selectedBase) {
    return {
      ok: false,
      error: `${GOOGLE_ADS_FETCH_FAILED_MESSAGE} (request did not execute)`,
      customers: [],
    };
  }

  if (!listResult.ok || hasGoogleAdsError(listResult.payload)) {
    const apiMessage = getGoogleAdsErrorMessage(listResult.payload);
    const classifiedMessage = classifyGoogleAdsError(
      listResult.payload,
      listResult.status,
    );
    const isLikelyHtml =
      !listResult.isJson &&
      (listResult.bodyText.includes("<!DOCTYPE html") ||
        listResult.bodyText.includes("<html"));
    const detail = !listResult.ok
      ? `listAccessibleCustomers HTTP ${listResult.status}${isLikelyHtml ? " (non-JSON response)" : ""}`
      : `listAccessibleCustomers API error${apiMessage ? `: ${apiMessage}` : ""}`;

    console.error("[google-ads-accounts] accessible customers request failed", {
      status: listResult.status,
      isJson: listResult.isJson,
      apiMessage,
      classifiedMessage,
      bodyExcerpt: listResult.bodyText.slice(0, 250),
      attempts: attemptLogs,
      diagnostics,
    });
    return {
      ok: false,
      error: `${classifiedMessage ?? GOOGLE_ADS_FETCH_FAILED_MESSAGE} (${detail}; attempts=${attemptLogs.map((a) => `${a.base}=>${a.status}/${a.isJson ? "json" : "non-json"}`).join(",")})`,
      quotaExhausted: listResult.status === 429,
      customers: [],
    };
  }

  const resourceNames = readResourceNames(listResult.payload);
  logRuntimeDebug("google-ads-accounts", "accessible_customers_loaded", {
    count: resourceNames.length,
    sample: resourceNames.slice(0, 5),
  });

  const customerIds = resourceNames
    .map((resourceName) => resourceName.replace("customers/", "").trim())
    .filter((id) => /^\d+$/.test(id));

  if (customerIds.length === 0) {
    return { ok: true, customers: [] };
  }

  const detailResults = await Promise.all(
    customerIds.map((customerId) =>
      fetchCustomerDetails({
        customerId,
        accessToken,
        developerToken,
        loginCustomerIds: customerIds,
        adsApiBase: selectedBase,
      }),
    ),
  );

  const customers = detailResults.map((detail, index) => {
    const fallbackId = customerIds[index];
    return (
      detail ?? {
        id: normalizeGoogleAdsCustomerId(fallbackId),
        rawId: fallbackId,
        name: normalizeGoogleAdsCustomerId(fallbackId),
        currency: null,
        timezone: null,
        isManager: false,
      }
    );
  });

  logRuntimeDebug("google-ads-accounts", "customer_details_fetched", {
    requested: customerIds.length,
    succeeded: detailResults.filter((item) => item !== null).length,
  });

  if (customers.length === 0 && customerIds.length > 0) {
    return {
      ok: false,
      error: `${GOOGLE_ADS_FETCH_FAILED_MESSAGE} (customer detail lookups failed for all accessible customers)`,
      customers: [],
    };
  }

  return { ok: true, customers };
}

async function fetchCustomerDetails({
  customerId,
  accessToken,
  developerToken,
  loginCustomerIds,
  adsApiBase,
}: {
  customerId: string;
  accessToken: string;
  developerToken: string;
  loginCustomerIds: string[];
  adsApiBase: string;
}): Promise<GoogleAdsCustomerNormalized | null> {
  logRuntimeDebug("google-ads-accounts", "customer_detail_discovery_start", {
    customerId,
    loginCustomerCandidateCount: loginCustomerIds.length,
  });
  // Try the direct customer endpoint first.
  const customerResourceResult = await googleAdsRequest({
    url: `${adsApiBase}/customers/${customerId}`,
    method: "GET",
    accessToken,
    developerToken,
    logLabel: `customers.get customer=${customerId}`,
  });

  if (
    customerResourceResult.ok &&
    !hasGoogleAdsError(customerResourceResult.payload)
  ) {
    const fromResource = readCustomerFromResourcePayload(
      customerResourceResult.payload,
    );
    if (fromResource) {
      return {
        id: normalizeGoogleAdsCustomerId(fromResource.id || customerId),
        rawId: fromResource.id || customerId,
        name:
          fromResource.name ||
          normalizeGoogleAdsCustomerId(fromResource.id || customerId),
        currency: fromResource.currency,
        timezone: fromResource.timezone,
        isManager: fromResource.isManager,
      };
    }
  }

  // Fallback to GAQL search, trying optional login-customer-id combinations.
  const searchUrl = `${adsApiBase}/customers/${customerId}/googleAds:search`;
  const query =
    "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer";
  const managerLoginCandidates = loginCustomerIds.filter(
    (id) => id !== customerId,
  );
  const orderedLoginHeaderCandidates = Array.from(
    new Set([...managerLoginCandidates, customerId]),
  ).slice(0, 25);

  for (const loginCustomerId of [undefined, ...orderedLoginHeaderCandidates]) {
    const result = await googleAdsRequest({
      url: searchUrl,
      method: "POST",
      accessToken,
      developerToken,
      body: { query },
      extraHeaders: loginCustomerId
        ? { "login-customer-id": loginCustomerId }
        : undefined,
      logLabel: `googleAds:search customer=${customerId}${loginCustomerId ? ` login=${loginCustomerId}` : ""}`,
    });

    if (!result.ok || hasGoogleAdsError(result.payload)) {
      console.warn("[google-ads-accounts] customer detail request failed", {
        customerId,
        loginCustomerId: loginCustomerId ?? null,
        status: result.status,
        isJson: result.isJson,
        apiMessage: getGoogleAdsErrorMessage(result.payload),
        bodyExcerpt: result.bodyText.slice(0, 200),
      });
      continue;
    }

    const customer = readCustomerFromSearchPayload(result.payload);
    if (!customer) continue;

    logRuntimeDebug("google-ads-accounts", "customer_detail_resolved", {
      customerId,
      loginCustomerId: loginCustomerId ?? null,
      resolvedName: customer.name || null,
      isManager: customer.isManager,
    });

    return {
      id: normalizeGoogleAdsCustomerId(customer.id || customerId),
      rawId: customer.id || customerId,
      name:
        customer.name ||
        normalizeGoogleAdsCustomerId(customer.id || customerId),
      currency: customer.currency,
      timezone: customer.timezone,
      isManager: customer.isManager,
    };
  }

  return null;
}

function buildAdsApiBaseCandidates(): string[] {
  const configured = normalizeApiBase(GOOGLE_CONFIG.adsApiBase);
  const defaults = [
    "https://googleads.googleapis.com/v23",
    "https://googleads.googleapis.com/v22",
    "https://googleads.googleapis.com/v21",
  ];
  return Array.from(
    new Set([configured, ...defaults].filter(Boolean)),
  ) as string[];
}

function normalizeApiBase(input: string): string {
  const raw = input.trim();
  const match = raw.match(/https:\/\/googleads\.googleapis\.com\/v\d+/i);
  if (match) return match[0].replace(/\/+$/, "");
  return raw.replace(/\/+$/, "");
}

async function googleAdsRequest({
  url,
  method,
  accessToken,
  developerToken,
  body,
  extraHeaders,
  logLabel,
}: {
  url: string;
  method: "GET" | "POST";
  accessToken: string;
  developerToken: string;
  body?: unknown;
  extraHeaders?: Record<string, string> | undefined;
  logLabel: string;
}): Promise<GoogleAdsHttpResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken,
    Accept: "application/json",
    ...(extraHeaders ?? {}),
  };

  if (method === "POST") {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_ADS_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const bodyText = await response.text().catch(() => "");
    const contentType = response.headers.get("content-type") ?? "";
    const parsed = safeJsonParse(bodyText);
    const isJson =
      contentType.toLowerCase().includes("application/json") || parsed !== null;

    logRuntimeDebug("google-ads-accounts", "request", {
      endpoint: logLabel,
      method,
      status: response.status,
      isJson,
      hasLoginCustomerId: Boolean(extraHeaders?.["login-customer-id"]),
      loginCustomerId: extraHeaders?.["login-customer-id"] ?? null,
    });

    return {
      ok: response.ok,
      status: response.status,
      isJson,
      bodyText,
      payload: parsed,
    };
  } catch (error: unknown) {
    clearTimeout(timeout);
    const message = error instanceof Error ? error.message : String(error);
    console.error("[google-ads-accounts] request threw", {
      endpoint: logLabel,
      method,
      message,
      hasLoginCustomerId: Boolean(extraHeaders?.["login-customer-id"]),
      loginCustomerId: extraHeaders?.["login-customer-id"] ?? null,
    });

    return {
      ok: false,
      status: 0,
      isJson: false,
      bodyText: message,
      payload: null,
    };
  }
}

function safeJsonParse(value: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hasGoogleAdsError(payload: unknown): payload is GoogleAdsErrorPayload {
  if (!payload || typeof payload !== "object") return false;
  return "error" in payload;
}

function getGoogleAdsErrorMessage(payload: unknown): string | null {
  if (!hasGoogleAdsError(payload)) return null;
  const message = payload.error?.message;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : null;
}

function readResourceNames(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const resourceNames = (payload as { resourceNames?: unknown }).resourceNames;
  if (!Array.isArray(resourceNames)) return [];
  return resourceNames.filter(
    (item): item is string => typeof item === "string",
  );
}

function readCustomerFromSearchPayload(payload: unknown): {
  id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  isManager: boolean;
} | null {
  if (!payload || typeof payload !== "object") return null;

  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) return null;

  const first = results[0] as { customer?: unknown };
  if (
    !first ||
    typeof first !== "object" ||
    !first.customer ||
    typeof first.customer !== "object"
  ) {
    return null;
  }

  const customer = first.customer as {
    id?: string | number;
    descriptiveName?: string;
    descriptive_name?: string;
    currencyCode?: string;
    currency_code?: string;
    timeZone?: string;
    time_zone?: string;
    manager?: boolean;
  };

  const id =
    typeof customer.id === "number"
      ? String(customer.id)
      : typeof customer.id === "string"
        ? customer.id
        : "";

  return {
    id,
    name:
      typeof customer.descriptiveName === "string"
        ? customer.descriptiveName
        : typeof customer.descriptive_name === "string"
          ? customer.descriptive_name
          : "",
    currency:
      typeof customer.currencyCode === "string"
        ? customer.currencyCode
        : typeof customer.currency_code === "string"
          ? customer.currency_code
          : null,
    timezone:
      typeof customer.timeZone === "string"
        ? customer.timeZone
        : typeof customer.time_zone === "string"
          ? customer.time_zone
          : null,
    isManager: customer.manager === true,
  };
}

function readCustomerFromResourcePayload(payload: unknown): {
  id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  isManager: boolean;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const customer = payload as {
    id?: string | number;
    descriptiveName?: string;
    descriptive_name?: string;
    currencyCode?: string;
    currency_code?: string;
    timeZone?: string;
    time_zone?: string;
    manager?: boolean;
  };

  const id =
    typeof customer.id === "number"
      ? String(customer.id)
      : typeof customer.id === "string"
        ? customer.id
        : "";
  if (!id) return null;

  return {
    id,
    name:
      typeof customer.descriptiveName === "string"
        ? customer.descriptiveName
        : typeof customer.descriptive_name === "string"
          ? customer.descriptive_name
          : "",
    currency:
      typeof customer.currencyCode === "string"
        ? customer.currencyCode
        : typeof customer.currency_code === "string"
          ? customer.currency_code
          : null,
    timezone:
      typeof customer.timeZone === "string"
        ? customer.timeZone
        : typeof customer.time_zone === "string"
          ? customer.time_zone
          : null,
    isManager: customer.manager === true,
  };
}
