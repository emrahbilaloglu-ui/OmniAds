import {
  KLAVIYO_CONFIG,
  klaviyoBasicAuthHeader,
} from "@/lib/oauth/klaviyo-config";

/**
 * The Klaviyo REST client.
 *
 * READ-ONLY BY CONSTRUCTION. Every exported call below is a GET, or the one
 * POST Klaviyo requires for its reporting endpoint (`/api/flow-values-reports`,
 * which computes a report and mutates nothing). There is no create, update,
 * archive or send anywhere in this module, and the OAuth scopes requested in
 * `lib/oauth/klaviyo-config.ts` are `:read` only, so a write cannot be
 * smuggled in later without also widening the grant.
 */

export class KlaviyoApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "KlaviyoApiError";
    this.code = code;
    this.status = status;
  }
}

interface KlaviyoTokenResponse {
  accessToken: string;
  /** Klaviyo ROTATES the refresh token on every grant; the new one must be stored. */
  refreshToken: string | null;
  expiresIn: number;
  scope: string | null;
}

function readTokenPayload(payload: unknown): KlaviyoTokenResponse {
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const accessToken =
    typeof record.access_token === "string" ? record.access_token : "";
  if (!accessToken) {
    const description =
      typeof record.error_description === "string"
        ? record.error_description
        : typeof record.error === "string"
          ? record.error
          : "Klaviyo returned no access token.";
    throw new KlaviyoApiError("klaviyo_token_exchange_failed", description, 502);
  }
  return {
    accessToken,
    refreshToken:
      typeof record.refresh_token === "string" && record.refresh_token.trim()
        ? record.refresh_token
        : null,
    // Klaviyo access tokens are short-lived. When the provider omits the field
    // we do NOT invent a long life: an hour is the documented default and
    // under-estimating only costs one extra refresh.
    expiresIn:
      typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
        ? record.expires_in
        : 3600,
    scope: typeof record.scope === "string" ? record.scope : null,
  };
}

async function postToken(body: URLSearchParams): Promise<KlaviyoTokenResponse> {
  const response = await fetch(KLAVIYO_CONFIG.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: klaviyoBasicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const record =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {};
    const description =
      typeof record.error_description === "string"
        ? record.error_description
        : typeof record.error === "string"
          ? record.error
          : `Klaviyo token endpoint returned ${response.status}.`;
    throw new KlaviyoApiError(
      "klaviyo_token_exchange_failed",
      description,
      response.status,
    );
  }
  return readTokenPayload(payload);
}

/** Authorization-code leg, with the PKCE verifier the start route minted. */
export function exchangeKlaviyoAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
}): Promise<KlaviyoTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: KLAVIYO_CONFIG.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  );
}

/** Refresh leg. The response's refresh token replaces the stored one. */
export function refreshKlaviyoAccessToken(
  refreshToken: string,
): Promise<KlaviyoTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

async function klaviyoRequest(
  path: string,
  init: {
    accessToken: string;
    method?: "GET" | "POST";
    body?: unknown;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  const method = init.method ?? "GET";
  const response = await fetch(`${KLAVIYO_CONFIG.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${init.accessToken}`,
      Accept: "application/vnd.api+json",
      revision: KLAVIYO_CONFIG.apiRevision,
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/vnd.api+json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
    signal: init.signal,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new KlaviyoApiError(
      response.status === 401 || response.status === 403
        ? "klaviyo_reconnect_required"
        : "klaviyo_request_failed",
      `Klaviyo ${method} ${path} returned ${response.status}.`,
      response.status,
    );
  }
  return payload;
}

function dataArray(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  return data.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object",
  );
}

function attributes(entry: Record<string, unknown>): Record<string, unknown> {
  const value = entry.attributes;
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface KlaviyoAccountIdentity {
  id: string;
  name: string | null;
  /** ISO-4217 code Klaviyo reports for the account, or null when it does not. */
  currency: string | null;
}

/** `GET /api/accounts/` — the connected account's identity, for the integration row. */
export async function fetchKlaviyoAccount(
  accessToken: string,
): Promise<KlaviyoAccountIdentity | null> {
  const payload = await klaviyoRequest("/accounts/", { accessToken });
  const first = dataArray(payload)[0];
  if (!first) return null;
  const id = optionalString(first.id);
  if (!id) return null;
  const attrs = attributes(first);
  // Klaviyo nests the organisation name under `contact_information`; read that
  // first and fall back to a flat spelling rather than inventing a label.
  const contact =
    attrs.contact_information && typeof attrs.contact_information === "object"
      ? (attrs.contact_information as Record<string, unknown>)
      : {};
  return {
    id,
    name:
      optionalString(contact.organization_name) ??
      optionalString(attrs.organization_name),
    currency: optionalString(attrs.preferred_currency),
  };
}

export interface KlaviyoFlowSummary {
  id: string;
  name: string | null;
  /** Klaviyo's own status verb, untranslated: "live" | "draft" | "manual". */
  status: string | null;
  archived: boolean;
}

/** `GET /api/flows/` — the lifecycle flows this grant can see. */
export async function fetchKlaviyoFlows(
  accessToken: string,
): Promise<KlaviyoFlowSummary[]> {
  const payload = await klaviyoRequest("/flows/", { accessToken });
  const flows: KlaviyoFlowSummary[] = [];
  for (const entry of dataArray(payload)) {
    const id = optionalString(entry.id);
    if (!id) continue;
    const attrs = attributes(entry);
    flows.push({
      id,
      name: optionalString(attrs.name),
      status: optionalString(attrs.status),
      archived: attrs.archived === true,
    });
  }
  return flows;
}

/**
 * `GET /api/metrics/` — the id of the conversion metric a value report is
 * measured against.
 *
 * Klaviyo's reporting endpoint REQUIRES a conversion metric id and has no
 * default, so without one there is no revenue figure to serve. Returning null
 * is therefore a real outcome, not a failure to handle: the revenue column
 * em-dashes and the other two statistics are still reported.
 */
export async function fetchKlaviyoConversionMetricId(
  accessToken: string,
): Promise<string | null> {
  const payload = await klaviyoRequest("/metrics/", { accessToken });
  for (const entry of dataArray(payload)) {
    const id = optionalString(entry.id);
    if (!id) continue;
    const attrs = attributes(entry);
    if (optionalString(attrs.name)?.toLowerCase() === "placed order") return id;
  }
  return null;
}

export interface KlaviyoFlowStatistics {
  flowId: string;
  /** Attributed conversion value over the window, or null when unreported. */
  conversionValue: number | null;
  /** Fraction in [0,1] as Klaviyo reports it, or null when unreported. */
  openRate: number | null;
  recipients: number | null;
}

function groupingFlowId(result: Record<string, unknown>): string | null {
  const groupings = result.groupings;
  if (!groupings || typeof groupings !== "object") return null;
  return optionalString((groupings as Record<string, unknown>).flow_id);
}

/**
 * `POST /api/flow-values-reports/` — the three statistics the design's table
 * shows, over an explicit start/end window.
 *
 * A POST that computes and returns a report. It creates no Klaviyo resource and
 * changes no flow, campaign, profile or list, which is why it is the one
 * non-GET call this read-only module makes.
 */
export async function fetchKlaviyoFlowStatistics(input: {
  accessToken: string;
  conversionMetricId: string | null;
  /** Inclusive ISO date, e.g. "2026-07-21". */
  start: string;
  /** Exclusive ISO date, e.g. "2026-08-18". */
  end: string;
}): Promise<KlaviyoFlowStatistics[]> {
  // Without a conversion metric Klaviyo rejects the request outright. There is
  // nothing to substitute, so the caller gets no statistics and every cell
  // em-dashes rather than showing a zero that would read as "earned nothing".
  if (!input.conversionMetricId) return [];

  const payload = await klaviyoRequest("/flow-values-reports/", {
    accessToken: input.accessToken,
    method: "POST",
    body: {
      data: {
        type: "flow-values-report",
        attributes: {
          statistics: ["conversion_value", "open_rate", "recipients"],
          timeframe: { start: input.start, end: input.end },
          conversion_metric_id: input.conversionMetricId,
        },
      },
    },
  });

  const data =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).data
      : null;
  const attrs =
    data && typeof data === "object"
      ? attributes(data as Record<string, unknown>)
      : {};
  const results = Array.isArray(attrs.results) ? attrs.results : [];

  const rows: KlaviyoFlowStatistics[] = [];
  for (const raw of results) {
    if (!raw || typeof raw !== "object") continue;
    const result = raw as Record<string, unknown>;
    const flowId = groupingFlowId(result);
    if (!flowId) continue;
    const statistics =
      result.statistics && typeof result.statistics === "object"
        ? (result.statistics as Record<string, unknown>)
        : {};
    rows.push({
      flowId,
      conversionValue: optionalNumber(statistics.conversion_value),
      openRate: optionalNumber(statistics.open_rate),
      recipients: optionalNumber(statistics.recipients),
    });
  }
  return rows;
}
