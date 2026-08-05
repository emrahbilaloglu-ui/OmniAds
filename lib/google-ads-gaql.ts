import { GOOGLE_CONFIG } from "@/lib/oauth/google-config";
import { getIntegration } from "@/lib/integrations";
import { resolveGoogleAccessTokenWithGeneration } from "@/lib/google-token-refresh";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { runProviderRequestWithGovernance } from "@/lib/provider-request-governance";
import { classifyGoogleRequestAuditSource } from "@/lib/google-request-audit";
import { classifyGoogleAdsSyncFailure } from "@/lib/sync/google-ads-error-classification";
import { createHash } from "node:crypto";
import { readProviderAccountSnapshot } from "@/lib/provider-account-snapshots";
import { logRuntimeDebug } from "@/lib/runtime-logging";

interface GaqlSearchResult {
  results?: Array<{
    campaign?: Record<string, unknown>;
    adGroup?: Record<string, unknown>;
    adGroupAd?: Record<string, unknown>;
    searchTermView?: Record<string, unknown>;
    shoppingProductProductView?: Record<string, unknown>;
    assetGroupAsset?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  fieldMask?: string;
}

interface GoogleAdsApiError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{
      errorCode?: {
        googleAdsFailure?: {
          errors?: Array<{
            errorCode?: string;
            message?: string;
            // Google puts the actionable part of an INVALID_ARGUMENT here: the
            // top-level message is only ever "Request contains an invalid
            // argument.", while the rejected field is named in this location.
            location?: {
              fieldPathElements?: Array<{
                fieldName?: string;
                index?: number;
              }>;
            };
          }>;
        };
      };
    }>;
  };
}

/**
 * Fold Google's per-field detail into the message the sync layer persists.
 *
 * WHY THIS EXISTS
 *
 * An INVALID_ARGUMENT arrives as `error.message = "Request contains an invalid
 * argument."` and nothing else — 22 of those a day were being stored verbatim,
 * naming neither the field nor the query, so nobody could act on them. Google
 * does say which field it rejected, but only inside `details[].location`.
 *
 * WHY IT IS GUARDED
 *
 * `last_error` is also the string the retry classifier reads. Google's detail
 * text is written for humans and can easily contain "unavailable", "timeout" or
 * "permission denied" — appending it naively can flip a TERMINAL error to
 * `transient` (retry forever) or to `account_action_required` (stop retrying a
 * recoverable one). Both were reproduced against the real classifier. So the
 * free text is kept ONLY when it provably does not move the classification;
 * otherwise just the structured parts (field, queryName) are added, which are
 * identifiers and carry no classifier vocabulary.
 */
export function buildDiagnosedGoogleAdsErrorMessage(input: {
  message: string;
  detailMessage?: string | null;
  fieldPathElements?: Array<{ fieldName?: string; index?: number }> | null;
  queryName?: string | null;
}) {
  const fieldPath = (input.fieldPathElements ?? [])
    .map((element) =>
      element?.index == null
        ? element?.fieldName
        : `${element?.fieldName}[${element.index}]`,
    )
    .filter(Boolean)
    .join(".");
  const detail =
    input.detailMessage && input.detailMessage !== input.message
      ? input.detailMessage
      : null;
  const assemble = (includeDetail: boolean) =>
    [
      input.message,
      includeDetail && detail ? `detail=${detail}` : null,
      fieldPath ? `field=${fieldPath}` : null,
      input.queryName ? `queryName=${input.queryName}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

  const baseline = classifyGoogleAdsSyncFailure({
    message: input.message,
  }).errorClass;
  const withDetail = assemble(true);
  return classifyGoogleAdsSyncFailure({ message: withDetail }).errorClass ===
    baseline
    ? withDetail
    : assemble(false);
}

export class GoogleAdsQueryError extends Error {
  status: number;
  apiStatus?: string;
  apiErrorCode?: string;
  loginCustomerId?: string;

  constructor(params: {
    message: string;
    status: number;
    apiStatus?: string;
    apiErrorCode?: string;
    loginCustomerId?: string;
  }) {
    super(params.message);
    this.name = "GoogleAdsQueryError";
    this.status = params.status;
    this.apiStatus = params.apiStatus;
    this.apiErrorCode = params.apiErrorCode;
    this.loginCustomerId = params.loginCustomerId;
  }
}

export interface GoogleAdsAccountQueryFailure {
  customerId: string;
  message: string;
  status?: number;
  apiStatus?: string;
  apiErrorCode?: string;
  loginCustomerId?: string;
}

const GOOGLE_ADS_GAQL_TIMEOUT_MS = 10_000;
const GOOGLE_ADS_SEARCH_CACHE_TTL_MS = 30_000;
const GOOGLE_ADS_OPTIONAL_SEARCH_CACHE_TTL_MS = 15_000;
const GOOGLE_ADS_LOGIN_CONTEXT_FAILURE_TTL_MS = 5 * 60_000;

// Yalnızca bu sorgular daha uzun in-memory TTL alır.
const GAQL_DB_PERSIST_QUERY_NAMES = new Set(["customer_summary", "campaign_core_basic"]);

interface CachedGaqlResult {
  expiresAt: number;
  value: GaqlSearchResult;
}

function buildGaqlRequestType(customerId: string, query: string) {
  const normalizedCustomerId = normalizeCustomerIdForRequest(customerId);
  const queryHash = createHash("sha1").update(query).digest("hex").slice(0, 12);
  return `gaql:${normalizedCustomerId}:${queryHash}`;
}

function normalizeCustomerIdForRequest(value: string) {
  return value.replace(/^customers\//, "").replace(/\D/g, "");
}

function getGaqlCacheStore() {
  const globalStore = globalThis as typeof globalThis & {
    __omniadsGoogleAdsGaqlCache?: Map<string, CachedGaqlResult>;
  };
  if (!globalStore.__omniadsGoogleAdsGaqlCache) {
    globalStore.__omniadsGoogleAdsGaqlCache = new Map();
  }
  return globalStore.__omniadsGoogleAdsGaqlCache;
}

function getLoginContextStores() {
  const globalStore = globalThis as typeof globalThis & {
    __omniadsGoogleAdsLoginContextSuccess?: Map<string, string>;
    __omniadsGoogleAdsLoginContextFailures?: Map<string, number>;
  };
  if (!globalStore.__omniadsGoogleAdsLoginContextSuccess) {
    globalStore.__omniadsGoogleAdsLoginContextSuccess = new Map();
  }
  if (!globalStore.__omniadsGoogleAdsLoginContextFailures) {
    globalStore.__omniadsGoogleAdsLoginContextFailures = new Map();
  }
  return {
    success: globalStore.__omniadsGoogleAdsLoginContextSuccess,
    failures: globalStore.__omniadsGoogleAdsLoginContextFailures,
  };
}

function buildLoginContextKey(
  businessId: string,
  customerId: string,
  loginCustomerId?: string,
) {
  return `${businessId}:${normalizeCustomerIdForRequest(customerId)}:${loginCustomerId ? normalizeCustomerIdForRequest(loginCustomerId) : "__none__"}`;
}

function getKnownGoodLoginContext(
  businessId: string,
  customerId: string,
) {
  return getLoginContextStores().success.get(
    `${businessId}:${normalizeCustomerIdForRequest(customerId)}`
  );
}

function setKnownGoodLoginContext(
  businessId: string,
  customerId: string,
  loginCustomerId?: string,
) {
  const key = `${businessId}:${normalizeCustomerIdForRequest(customerId)}`;
  getLoginContextStores().success.set(
    key,
    loginCustomerId ? normalizeCustomerIdForRequest(loginCustomerId) : "__none__"
  );
}

function markFailedLoginContext(
  businessId: string,
  customerId: string,
  loginCustomerId?: string,
) {
  getLoginContextStores().failures.set(
    buildLoginContextKey(businessId, customerId, loginCustomerId),
    Date.now() + GOOGLE_ADS_LOGIN_CONTEXT_FAILURE_TTL_MS
  );
}

function isFailedLoginContext(
  businessId: string,
  customerId: string,
  loginCustomerId?: string,
) {
  const key = buildLoginContextKey(businessId, customerId, loginCustomerId);
  const expiresAt = getLoginContextStores().failures.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    getLoginContextStores().failures.delete(key);
    return false;
  }
  return true;
}

function buildGaqlCacheKey(input: {
  businessId: string;
  customerId: string;
  query: string;
}) {
  return `${input.businessId}:${normalizeCustomerIdForRequest(input.customerId)}:${createHash("sha1")
    .update(input.query)
    .digest("hex")}`;
}

async function getLoginCustomerIdCandidates(
  businessId: string,
  customerId: string
): Promise<string[]> {
  const normalizedCustomerId = normalizeCustomerIdForRequest(customerId);
  const snapshot = await readProviderAccountSnapshot({
    businessId,
    provider: "google",
  }).catch(() => null);

  const accounts = snapshot?.accounts ?? [];
  const managerIds = accounts
    .filter((account) => account.isManager)
    .map((account) => normalizeCustomerIdForRequest(account.id))
    .filter(Boolean)
    .filter((id) => id !== normalizedCustomerId);
  return Array.from(new Set(managerIds)).slice(0, 3);
}

function shouldStopRetryingAcrossLoginContexts(error: {
  status: number;
  apiStatus?: string;
  apiErrorCode?: string;
  message: string;
}) {
  const text = `${error.apiStatus ?? ""} ${error.apiErrorCode ?? ""} ${error.message}`.toUpperCase();
  if (error.status === 429 || text.includes("RESOURCE_EXHAUSTED")) return true;
  if (error.status === 401 || text.includes("UNAUTHENTICATED")) return true;
  if (text.includes("DEVELOPER_TOKEN")) return true;
  return false;
}

export function getGoogleAdsFailureMessage(
  failures: GoogleAdsAccountQueryFailure[],
): string {
  if (failures.length === 0) {
    return "Google Ads query failed.";
  }
  const first = failures[0];
  if (first.apiErrorCode === "DEVELOPER_TOKEN_INVALID") {
    return "Google Ads developer token is invalid. Reconnect Google integration with a valid developer token.";
  }
  if (first.apiStatus === "UNAUTHENTICATED") {
    return "Google Ads authentication failed. Reconnect Google integration.";
  }
  if (first.apiStatus === "PERMISSION_DENIED") {
    return "Google Ads permission denied for the assigned account. Check account access in Integrations.";
  }
  return first.message || "Google Ads query failed.";
}

/**
 * Execute a GAQL query against a Google Ads customer account.
 * Handles token refresh if needed.
 */
export async function executeGaqlQuery(params: {
  businessId: string;
  customerId: string;
  query: string;
  queryName?: string;
  queryFamily?: string;
  source?: string;
  requestId?: string;
}): Promise<GaqlSearchResult> {
  let integration = await getIntegration(params.businessId, "google");

  if (!integration || integration.status !== "connected" || !integration.access_token) {
    throw new Error("Google Ads integration not found or not connected");
  }

  // One coherent refresh flow, shared with every other Google call site.
  //
  // The hand-rolled version here refreshed the token and never wrote it back, so
  // the next caller refreshed again — and it was bound to no generation at all,
  // so a reconnect mid-request was invisible.
  let accessToken: string;
  try {
    accessToken = (
      await resolveGoogleAccessTokenWithGeneration({
        businessId: params.businessId,
        provider: "google",
      })
    ).accessToken;
  } catch (error) {
    console.error("[google-ads-gaql] token refresh failed", error);
    throw new Error("Failed to refresh Google Ads access token");
  }

  const normalizedCustomerId = normalizeCustomerIdForRequest(params.customerId);
  const searchUrl = `${GOOGLE_CONFIG.adsApiBase}/customers/${normalizedCustomerId}/googleAds:search`;
  const cacheKey = buildGaqlCacheKey(params);
  const cacheStore = getGaqlCacheStore();
  const cached = cacheStore.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    logRuntimeDebug("google-ads-search", "cache_hit", {
      source: params.source ?? "unknown",
      requestId: params.requestId ?? null,
      businessId: params.businessId,
      customerId: normalizedCustomerId,
      queryName: params.queryName ?? "unknown",
      queryFamily: params.queryFamily ?? "unknown",
    });
    return cached.value;
  }
  if (cached && cached.expiresAt <= Date.now()) {
    cacheStore.delete(cacheKey);
  }

  const isCriticalQuery = params.queryName != null && GAQL_DB_PERSIST_QUERY_NAMES.has(params.queryName);
  const loginCustomerIdCandidates = await getLoginCustomerIdCandidates(
    params.businessId,
    params.customerId
  );
  const snapshot = await readProviderAccountSnapshot({
    businessId: params.businessId,
    provider: "google",
  }).catch(() => null);
  const accounts = snapshot?.accounts ?? [];
  const targetAccount =
    accounts.find((account) => normalizeCustomerIdForRequest(account.id) === normalizedCustomerId) ??
    null;
  const managerLoginCustomerIdCandidates = loginCustomerIdCandidates.filter((candidate) =>
    accounts.some(
      (account) =>
        account.isManager && normalizeCustomerIdForRequest(account.id) === candidate
    )
  );
  const knownGoodLoginContext = getKnownGoodLoginContext(
    params.businessId,
    params.customerId
  );
  const orderedLoginCustomerIdCandidates = Array.from(
    new Set([
      knownGoodLoginContext && knownGoodLoginContext !== "__none__"
        ? knownGoodLoginContext
        : undefined,
      ...managerLoginCustomerIdCandidates,
      targetAccount?.isManager ? normalizedCustomerId : undefined,
      managerLoginCustomerIdCandidates.length === 0 &&
      knownGoodLoginContext !== "__none__"
        ? undefined
        : undefined,
    ])
  ).filter((candidate): candidate is string => Boolean(candidate));
  const attemptSequence: Array<string | undefined> = [];
  const shouldPreferDirectAccess =
    !targetAccount?.isManager &&
    (knownGoodLoginContext === "__none__" ||
      !knownGoodLoginContext ||
      orderedLoginCustomerIdCandidates.length > 0);

  if (shouldPreferDirectAccess) {
    attemptSequence.push(undefined);
  }

  if (
    !shouldPreferDirectAccess &&
    (knownGoodLoginContext === "__none__" ||
      (managerLoginCustomerIdCandidates.length === 0 &&
        orderedLoginCustomerIdCandidates.length === 0))
  ) {
    attemptSequence.push(undefined);
  }
  attemptSequence.push(...orderedLoginCustomerIdCandidates);
  if (attemptSequence.length === 0) {
    attemptSequence.push(undefined);
  }

  return runProviderRequestWithGovernance({
    provider: "google",
    businessId: params.businessId,
    requestType: buildGaqlRequestType(params.customerId, params.query),
    requestSource: classifyGoogleRequestAuditSource(params.source),
    requestPath: params.source ?? params.queryName ?? params.queryFamily ?? "google_ads_gaql",
    execute: async () => {
      let lastError: GoogleAdsQueryError | null = null;
      // Every candidate skipped because a recent failure is still inside its TTL.
      // Recorded so an all-skipped run can say WHY nothing was attempted rather
      // than reporting an uncaptured error (see the throw at the end).
      const skippedKnownFailedContexts: string[] = [];

      logRuntimeDebug("google-ads-search", "live_start", {
        source: params.source ?? "unknown",
        requestId: params.requestId ?? null,
        businessId: params.businessId,
        customerId: params.customerId,
        normalizedCustomerId,
        searchUrl,
        queryName: params.queryName ?? "unknown",
        queryFamily: params.queryFamily ?? "unknown",
        targetAccount: targetAccount
          ? {
              id: targetAccount.id,
              name: targetAccount.name,
              isManager: Boolean(targetAccount.isManager),
            }
          : null,
        queryHash: buildGaqlRequestType(params.customerId, params.query),
        loginCustomerIdCandidates: attemptSequence.map((candidate) => candidate ?? "__none__"),
      });

      for (const loginCustomerId of attemptSequence) {
        if (isFailedLoginContext(params.businessId, params.customerId, loginCustomerId)) {
          skippedKnownFailedContexts.push(loginCustomerId ?? "__none__");
          continue;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), GOOGLE_ADS_GAQL_TIMEOUT_MS);
        const response = await fetch(searchUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "developer-token": GOOGLE_CONFIG.developerToken,
            "Content-Type": "application/json",
            ...(loginCustomerId
              ? { "login-customer-id": normalizeCustomerIdForRequest(loginCustomerId) }
              : {}),
          },
          body: JSON.stringify({
            query: params.query,
          }),
          cache: "no-store",
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const data = await response.json();

        if (response.ok) {
          const result = data as GaqlSearchResult;
          const ttl = isCriticalQuery
            ? GOOGLE_ADS_SEARCH_CACHE_TTL_MS
            : GOOGLE_ADS_OPTIONAL_SEARCH_CACHE_TTL_MS;
          cacheStore.set(cacheKey, { value: result, expiresAt: Date.now() + ttl });
          logRuntimeDebug("google-ads-search", "success", {
            source: params.source ?? "unknown",
            requestId: params.requestId ?? null,
            customerId: params.customerId,
            normalizedCustomerId,
            loginCustomerId: loginCustomerId ?? null,
            queryName: params.queryName ?? "unknown",
            queryFamily: params.queryFamily ?? "unknown",
            targetIsManager: Boolean(targetAccount?.isManager),
            rowCount: result.results?.length ?? 0,
          });
          setKnownGoodLoginContext(
            params.businessId,
            params.customerId,
            loginCustomerId,
          );
          return result;
        }

        const error = data as GoogleAdsApiError;
        const message = error.error?.message || `Google Ads API error: ${response.status}`;
        const firstDetailError =
          error.error?.details?.[0]?.errorCode?.googleAdsFailure?.errors?.[0];
        let apiErrorCode: string | undefined;
        if (
          firstDetailError?.errorCode &&
          typeof firstDetailError.errorCode === "object"
        ) {
          const entry = Object.entries(firstDetailError.errorCode).find(
            ([, value]) => Boolean(value),
          );
          if (entry) apiErrorCode = String(entry[1]);
        }

        const diagnosedMessage = buildDiagnosedGoogleAdsErrorMessage({
          message,
          detailMessage: firstDetailError?.message ?? null,
          fieldPathElements: firstDetailError?.location?.fieldPathElements ?? null,
          queryName: params.queryName ?? null,
        });

        lastError = new GoogleAdsQueryError({
          message: diagnosedMessage,
          status: response.status,
          apiStatus: error.error?.status,
          apiErrorCode,
          loginCustomerId: loginCustomerId ?? undefined,
        });

        console.warn("[google-ads-search] live_failure", {
          source: params.source ?? "unknown",
          requestId: params.requestId ?? null,
          customerId: params.customerId,
          normalizedCustomerId,
          loginCustomerId: loginCustomerId ?? null,
          queryName: params.queryName ?? "unknown",
          queryFamily: params.queryFamily ?? "unknown",
          targetIsManager: Boolean(targetAccount?.isManager),
          status: response.status,
          apiStatus: error.error?.status ?? null,
          apiErrorCode: apiErrorCode ?? null,
          message,
        });

        markFailedLoginContext(params.businessId, params.customerId, loginCustomerId);

        if (
          shouldStopRetryingAcrossLoginContexts({
            status: response.status,
            apiStatus: error.error?.status,
            apiErrorCode,
            message,
          })
        ) {
          break;
        }
      }

      if (lastError) {
        console.error("[google-ads-search] failed_after_retries", {
          source: params.source ?? "unknown",
          requestId: params.requestId ?? null,
          customerId: params.customerId,
          normalizedCustomerId,
          queryName: params.queryName ?? "unknown",
          queryFamily: params.queryFamily ?? "unknown",
          candidateCount: orderedLoginCustomerIdCandidates.length,
          targetIsManager: Boolean(targetAccount?.isManager),
          message: lastError.message,
          status: lastError.status,
          apiStatus: lastError.apiStatus ?? null,
          apiErrorCode: lastError.apiErrorCode ?? null,
          query: params.query.slice(0, 160),
        });
        throw lastError;
      }

      // The leading sentence is load-bearing: `google-ads-sync` matches it to
      // escalate an ambiguous fetch failure to `scope_action_required`. Keep it
      // verbatim and APPEND the diagnosis rather than replacing it.
      //
      // Reaching here with candidates present means every one of them was
      // skipped by the known-failed-login-context TTL, so no request was ever
      // sent. Saying "no captured error" is true but useless — it reads as a
      // mystery when the cause is recorded in memory a few lines above.
      if (skippedKnownFailedContexts.length > 0) {
        throw new Error(
          `Google Ads query failed without a captured error. No request was sent: all ${
            skippedKnownFailedContexts.length
          } login context(s) [${skippedKnownFailedContexts.join(
            ", ",
          )}] are inside the recent-failure TTL for customer ${normalizedCustomerId}, so every attempt was skipped. This clears itself when the TTL expires.`,
        );
      }
      throw new Error(
        `Google Ads query failed without a captured error. The attempt sequence for customer ${normalizedCustomerId} was empty, so no request was sent.`,
      );
    },
  });
}

/**
 * Get assigned Google Ads customer accounts for a business
 */
export async function getAssignedGoogleAccounts(
  businessId: string,
): Promise<string[]> {
  const assignment = await getProviderAccountAssignments(businessId, "google");
  return assignment?.account_ids || [];
}

export async function getConnectedAssignedGoogleAccounts(
  businessId: string,
): Promise<string[]> {
  const [integration, assignment] = await Promise.all([
    getIntegration(businessId, "google"),
    getProviderAccountAssignments(businessId, "google"),
  ]);

  if (!integration || integration.status !== "connected" || !integration.access_token) {
    return [];
  }

  return assignment?.account_ids || [];
}

export async function executeGaqlForAccounts(params: {
  businessId: string;
  customerIds: string[];
  query: string;
  queryName?: string;
  queryFamily?: string;
  source?: string;
  requestId?: string;
}): Promise<{
  results: GaqlSearchResult[];
  failures: GoogleAdsAccountQueryFailure[];
}> {
  const settled = await Promise.all(
    params.customerIds.map(async (customerId) => {
      try {
        const result = await executeGaqlQuery({
          businessId: params.businessId,
          customerId,
          query: params.query,
          queryName: params.queryName,
          queryFamily: params.queryFamily,
          source: params.source,
          requestId: params.requestId,
        });
        return { result };
      } catch (error) {
        const queryError = error as GoogleAdsQueryError;
        return {
          error: {
            customerId,
            message: queryError.message || "Google Ads query failed.",
            status: queryError.status,
            apiStatus: queryError.apiStatus,
            apiErrorCode: queryError.apiErrorCode,
            loginCustomerId: queryError.loginCustomerId,
          } satisfies GoogleAdsAccountQueryFailure,
        };
      }
    }),
  );

  return {
    results: settled
      .map((entry) => entry.result)
      .filter((entry): entry is GaqlSearchResult => Boolean(entry)),
    failures: settled.flatMap((entry) => (entry.error ? [entry.error] : [])),
  };
}

/**
 * Normalize date range parameter to YYYY-MM-DD format for GAQL
 */
export function getDateRangeForQuery(
  dateRange: "3" | "7" | "14" | "30" | "90" | "mtd" | "qtd" | "custom",
  customStart?: string,
  customEnd?: string,
): { startDate: string; endDate: string } {
  if (dateRange === "custom" && customStart && customEnd) {
    return {
      startDate: customStart,
      endDate: customEnd,
    };
  }

  const endDate = new Date();
  const startDate = new Date(endDate);
  const rollingDays = Number(dateRange);

  if (Number.isFinite(rollingDays) && rollingDays > 0) {
    endDate.setDate(endDate.getDate() - 1);
    startDate.setTime(endDate.getTime());
    startDate.setDate(endDate.getDate() - (rollingDays - 1));
  } else if (dateRange === "mtd") {
    startDate.setDate(1);
  } else if (dateRange === "qtd") {
    const month = endDate.getMonth();
    const quarterStartMonth = Math.floor(month / 3) * 3;
    startDate.setMonth(quarterStartMonth, 1);
  }

  return {
    startDate: startDate.toISOString().split("T")[0],
    endDate: endDate.toISOString().split("T")[0],
  };
}

/**
 * Normalize cost from micros to standard currency units
 */
export function normalizeCostMicros(micros: number | string): number {
  const value = typeof micros === "string" ? parseInt(micros, 10) : micros;
  return Number((value / 1000000).toFixed(2));
}

/**
 * Calculate ROAS with safe divide
 */
export function calculateRoas(
  conversionValue: number | string,
  cost: number,
): number {
  const value =
    typeof conversionValue === "string"
      ? parseFloat(conversionValue)
      : conversionValue;
  if (cost === 0) return 0;
  return Number((value / cost).toFixed(2));
}

/**
 * Calculate CPA with safe divide
 */
export function calculateCpa(
  cost: number,
  conversions: number | string,
): number {
  const convCount =
    typeof conversions === "string" ? parseInt(conversions, 10) : conversions;
  if (convCount === 0) return 0;
  return Number((cost / convCount).toFixed(2));
}

/**
 * Calculate CTR with safe divide
 */
export function calculateCtr(
  clicks: number | string,
  impressions: number | string,
): number {
  const c = typeof clicks === "string" ? parseInt(clicks, 10) : clicks;
  const i =
    typeof impressions === "string" ? parseInt(impressions, 10) : impressions;
  if (i === 0) return 0;
  return Number(((c / i) * 100).toFixed(2));
}

/**
 * Calculate CPM with safe divide
 */
export function calculateCpm(
  cost: number,
  impressions: number | string,
): number {
  const i =
    typeof impressions === "string" ? parseInt(impressions, 10) : impressions;
  if (i === 0) return 0;
  return Number(((cost / i) * 1000).toFixed(2));
}

/**
 * Normalize Google Ads status enum to UI-safe label
 */
export function normalizeStatus(
  status: string | undefined,
): "active" | "paused" | "removed" {
  if (!status) return "paused";
  const lower = status.toLowerCase();
  if (lower === "enabled") return "active";
  if (lower === "active") return "active";
  if (lower === "paused") return "paused";
  if (lower === "removed") return "removed";
  return "paused";
}

/**
 * Map Google Ads advertising channel type to readable label
 */
export function normalizeChannelType(channelType: string | undefined): string {
  if (!channelType) return "Unknown";
  const lower = channelType.toLowerCase();
  if (lower.includes("search")) return "Search";
  if (lower.includes("display")) return "Display";
  if (lower.includes("shopping")) return "Shopping";
  if (lower.includes("video")) return "Video";
  if (lower.includes("performance")) return "Performance Max";
  if (lower.includes("app")) return "App";
  return channelType;
}
