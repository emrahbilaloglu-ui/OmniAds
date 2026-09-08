import { logRuntimeWarn } from "@/lib/runtime-logging";
import { sanitizeMetaGraphTraceId } from "@/lib/meta/graph-trace-id";

export interface MetaAdAccountNormalized {
  id: string;
  raw_id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  account_status: number | null;
  source?: "direct" | "business_owned" | "business_client";
  business_id?: string | null;
  business_name?: string | null;
}

/** The provider's error as it arrives. Nothing of this shape leaves the module. */
interface MetaGraphError {
  /**
   * Declared so the parse is honest about what Meta sends, and read by nothing.
   * Free text the provider controls, observed echoing the access token back
   * inside it; `toSafeGraphError` replaces it with a locally-authored sentence.
   */
  message?: string;
  type?: string;
  code?: number;
  // Graph reports the actual cause in the subcode and the retryability flag;
  // neither was declared here, so neither could be read off a failed refresh.
  error_subcode?: number;
  is_transient?: boolean;
  fbtrace_id?: string;
}

interface MetaGraphPaging {
  next?: string;
}

interface MetaGraphCollectionResponse<TItem> {
  data?: TItem[];
  error?: MetaGraphError;
  paging?: MetaGraphPaging;
}

interface MetaGraphAdAccount {
  id?: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  account_status?: number;
}

interface MetaGraphBusiness {
  id?: string;
  name?: string;
}

export interface MetaAdAccountsFetchResult {
  status: number;
  ok: boolean;
  /**
   * The failure, in the only form this module hands out.
   *
   * `rawBody` used to sit alongside this and carried the provider's response
   * text verbatim; `app/integrations/meta/ad-accounts/debug/route.ts` returned
   * it to the browser. The field is gone rather than redacted so no caller can
   * reach for it again.
   */
  body: MetaSafeAdAccountsResponse | null;
  normalized: MetaAdAccountNormalized[];
  /**
   * The named Graph identifiers behind a non-OK response, so a failed refresh
   * can be diagnosed and quoted to Meta instead of being reported as a bare
   * status. Null when the request never reached a Graph error.
   */
  graphError?: MetaGraphErrorIdentity | null;
  businessDiscovery?: {
    status: number | null;
    ok: boolean;
    businessCount: number;
    accountCount: number;
    errors: Array<{
      businessId?: string | null;
      edge: string;
      message: string;
      graphError?: MetaGraphErrorIdentity | null;
    }>;
  };
}

function normalizeAccountId(input: string) {
  if (input.startsWith("act_")) {
    return {
      id: input,
      rawId: input.slice(4),
    };
  }

  return {
    id: `act_${input}`,
    rawId: input,
  };
}

function graphUrl(path: string) {
  return `https://graph.facebook.com/v25.0/${path}`;
}

/**
 * The Graph error identifiers a non-OK response is allowed to leave behind.
 *
 * Meta puts the diagnosis in `error.code` / `error.error_subcode` /
 * `error.is_transient` / `error.fbtrace_id`. This loop used to keep only the
 * HTTP status, so an account refresh that failed said "400" and nothing that
 * could be looked up or reported to Meta.
 *
 * `error.message` and the body around it stay out: the message is free text the
 * provider echoes back from the request, and the body is the response that the
 * access token produced.
 *
 * Deliberately not imported from lib/api/meta.ts, which owns the same rule for
 * the sync client: that module pulls in the warehouse and the database pool,
 * and this one runs inside the OAuth callback and the integrations routes.
 */
interface MetaGraphErrorIdentity {
  errorCode: number | null;
  errorSubcode: number | null;
  isTransient: boolean | null;
  fbtraceId: string | null;
}

/**
 * The error shape this module is allowed to hand to a caller.
 *
 * `authored_by` is load-bearing, not decoration. `MetaGraphError.message` is
 * free text Meta controls and has been observed echoing the access token back
 * inside it; structural typing would otherwise let a parsed provider error be
 * assigned straight into a `MetaSafeGraphError` slot, because both have an
 * optional string `message`. The literal field makes that assignment a compile
 * error, so the passthrough cannot come back by accident.
 */
export interface MetaSafeGraphError {
  /** Locally authored. Never `error.message` as Meta wrote it. */
  message: string;
  code: number | null;
  error_subcode: number | null;
  is_transient: boolean | null;
  fbtrace_id: string | null;
  authored_by: "adsecute";
}

export interface MetaSafeAdAccountsResponse {
  error?: MetaSafeGraphError;
}

const EMPTY_META_GRAPH_ERROR_IDENTITY: MetaGraphErrorIdentity = {
  errorCode: null,
  errorSubcode: null,
  isTransient: null,
  fbtraceId: null,
};

function readGraphErrorNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Graph has answered with `code` as a numeric string on some edges, and a
  // string would otherwise classify as "no code reported".
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readMetaGraphErrorIdentity(
  error: MetaGraphError | null | undefined,
): MetaGraphErrorIdentity {
  if (!error) return { ...EMPTY_META_GRAPH_ERROR_IDENTITY };
  return {
    errorCode: readGraphErrorNumber(error.code),
    errorSubcode: readGraphErrorNumber(error.error_subcode),
    isTransient:
      typeof error.is_transient === "boolean" ? error.is_transient : null,
    // Same shared rule as the Graph client's own parser: this identity is
    // returned to callers and printed, so an unvetted provider string here is
    // the same defect one module over.
    fbtraceId: sanitizeMetaGraphTraceId(error.fbtrace_id),
  };
}

/**
 * Everything a Meta failure is allowed to say, in one place.
 *
 * Only the four named identifiers Meta documents as diagnosis handles — code,
 * subcode, is_transient, fbtrace_id — plus our own HTTP status. Enough to quote
 * back to Meta support; nothing the provider wrote.
 */
function namedGraphIdentity(
  httpStatus: number,
  identity: MetaGraphErrorIdentity | null,
) {
  return [
    `status ${httpStatus}`,
    identity?.errorCode != null ? `code ${identity.errorCode}` : null,
    identity?.errorSubcode != null ? `subcode ${identity.errorSubcode}` : null,
    identity?.isTransient != null
      ? `is_transient ${identity.isTransient}`
      : null,
    identity?.fbtraceId ? `fbtrace_id ${identity.fbtraceId}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}

function describeMetaGraphFailure(
  httpStatus: number,
  identity: MetaGraphErrorIdentity | null,
) {
  return `Meta API request failed (${namedGraphIdentity(httpStatus, identity)})`;
}

/**
 * The same rule for Graph calls made outside this module.
 *
 * `app/api/oauth/meta/callback/route.ts` fetches the token exchange and the
 * `/me` identity itself and used to throw `error.message` from each, which the
 * catch put into the `?error=` parameter of a redirect the browser renders
 * verbatim. It calls this instead, so the rule has one implementation rather
 * than a copy that can drift.
 */
export function describeMetaGraphErrorPayload(input: {
  label: string;
  httpStatus: number;
  payload: unknown;
}) {
  const error =
    input.payload && typeof input.payload === "object"
      ? (input.payload as { error?: unknown }).error
      : null;
  const identity =
    error && typeof error === "object"
      ? readMetaGraphErrorIdentity(error as MetaGraphError)
      : null;
  return `${input.label} (${namedGraphIdentity(input.httpStatus, identity)})`;
}

function toSafeGraphError(
  httpStatus: number,
  identity: MetaGraphErrorIdentity | null,
): MetaSafeGraphError {
  return {
    message: describeMetaGraphFailure(httpStatus, identity),
    code: identity?.errorCode ?? null,
    error_subcode: identity?.errorSubcode ?? null,
    is_transient: identity?.isTransient ?? null,
    fbtrace_id: identity?.fbtraceId ?? null,
    authored_by: "adsecute",
  };
}

/** A failure this module diagnosed itself, with no Graph error behind it. */
function localGraphError(message: string): MetaSafeGraphError {
  return {
    message,
    code: null,
    error_subcode: null,
    is_transient: null,
    fbtrace_id: null,
    authored_by: "adsecute",
  };
}

/**
 * Codes Meta documents as retryable: 1/2 (unknown and temporary), 4/17/32 (app,
 * user and page throttling) and the 80000-series ads throttles. Meta reports
 * these as HTTP 400 with the code in the payload: meta_raw_snapshots holds
 * 400s, 500s, 502s and 503s from this provider and not one 429, so a
 * status-only classifier retries none of the throttling.
 */
const META_TRANSIENT_GRAPH_ERROR_CODES = new Set([
  1, 2, 4, 17, 32, 341, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006,
  80008, 80014,
]);

function isTransientGraphFailure(
  httpStatus: number,
  identity: MetaGraphErrorIdentity,
) {
  // The provider's own verdict wins in both directions: an explicit
  // `is_transient: false` means the identical request cannot succeed.
  if (identity.isTransient !== null) return identity.isTransient;
  if (
    identity.errorCode !== null &&
    META_TRANSIENT_GRAPH_ERROR_CODES.has(identity.errorCode)
  ) {
    return true;
  }
  return httpStatus >= 500;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const META_MAX_ATTEMPTS_PER_PAGE = 3;
const META_RETRY_BASE_DELAY_MS = 250;
const META_RETRY_MAX_DELAY_MS = 2_000;

async function fetchMetaGraphCollection<TItem>(
  path: string,
  accessToken: string,
  maxPages = 50,
): Promise<{
  status: number;
  ok: boolean;
  /**
   * Locally authored, always. The parsed provider body is consumed inside this
   * loop and never escapes it: `error.message` is free text Meta controls, and
   * a token echoed back inside it would otherwise reach every caller.
   */
  body: MetaSafeAdAccountsResponse | null;
  data: TItem[];
  graphError: MetaGraphErrorIdentity | null;
}> {
  let nextUrl: string | null = graphUrl(path);
  let resultStatus = 0;
  let resultOk = false;
  let resultBody: MetaSafeAdAccountsResponse | null = null;
  let resultGraphError: MetaGraphErrorIdentity | null = null;
  const data: TItem[] = [];
  let stoppedOnError = false;
  // A `paging.next` that points back at a page already read would otherwise
  // spend the whole page budget re-reading the same rows and report a cap.
  const visitedUrls = new Set<string>([nextUrl]);

  for (let page = 0; nextUrl && page < maxPages; page += 1) {
    let attempt = 0;
    let pageFailed = false;

    for (;;) {
      attempt += 1;
      const response = await fetch(nextUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        cache: "no-store",
      });
      const rawBody = await response.text();
      let body: MetaGraphCollectionResponse<TItem> | null = null;
      try {
        body = JSON.parse(rawBody) as MetaGraphCollectionResponse<TItem>;
      } catch {
        body = null;
      }

      // A successful HTTP status is not a successful collection read unless
      // the provider supplied the collection itself. Treat invalid JSON,
      // missing `data`, `data: null`, and every other non-array value as a
      // local failure before any caller can persist an empty/partial account
      // set or reconcile assignments from it.
      const malformedCollection =
        response.ok && !body?.error && !Array.isArray(body?.data);
      const failed =
        !response.ok || Boolean(body?.error) || malformedCollection;
      if (failed) {
        const identity = readMetaGraphErrorIdentity(body?.error);
        const transient = isTransientGraphFailure(response.status, identity);
        logRuntimeWarn("meta-graph", "ad_accounts_page_rejected", {
          httpStatus: response.status,
          errorCode: identity.errorCode,
          errorSubcode: identity.errorSubcode,
          isTransient: identity.isTransient,
          fbtraceId: identity.fbtraceId,
          pageIndex: page,
          attempt,
          transient,
        });
        if (transient && attempt < META_MAX_ATTEMPTS_PER_PAGE) {
          await sleep(
            Math.min(
              META_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
              META_RETRY_MAX_DELAY_MS,
            ),
          );
          continue;
        }
      }

      if (page === 0) {
        resultStatus = response.status;
        resultOk = response.ok && !body?.error && !malformedCollection;
        resultBody = null;
      }

      if (failed) {
        stoppedOnError = true;
        pageFailed = true;
        resultGraphError = malformedCollection
          ? null
          : readMetaGraphErrorIdentity(body?.error);
        if (page > 0) {
          resultStatus = response.status;
          resultOk = false;
        }
        resultBody = {
          error: malformedCollection
            ? localGraphError(
                `Meta Graph collection returned status ${response.status} without a data array.`,
              )
            : toSafeGraphError(response.status, resultGraphError),
        };
        break;
      }

      // The malformed case returned through the failure branch above, so this
      // narrowing is guaranteed rather than an optional best effort.
      data.push(...body!.data!);
      const candidateNext =
        typeof body?.paging?.next === "string" ? body.paging.next : null;
      if (candidateNext !== null && visitedUrls.has(candidateNext)) {
        stoppedOnError = true;
        pageFailed = true;
        resultOk = false;
        // The repeated cursor itself is a URL Meta built and handed back, so it
        // stays out of the message: only the four named credential params were
        // ever redacted from it, and an unrecognised one would have travelled.
        // The page index says the same thing for anyone reading a log.
        logRuntimeWarn("meta-graph", "ad_accounts_pagination_cursor_repeated", {
          pageIndex: page,
        });
        resultBody = {
          error: localGraphError(
            "Meta Graph pagination returned a page cursor already fetched.",
          ),
        };
        break;
      }
      if (candidateNext !== null) visitedUrls.add(candidateNext);
      nextUrl = candidateNext;
      break;
    }

    if (pageFailed) break;
  }

  if (nextUrl && !stoppedOnError) {
    resultOk = false;
    resultBody = {
      error: localGraphError(
        `Meta Graph pagination exceeded ${maxPages} pages before completion.`,
      ),
    };
  }

  return {
    status: resultStatus,
    ok: resultOk,
    body: resultBody,
    data,
    graphError: resultGraphError,
  };
}

function normalizeMetaAdAccount(
  item: MetaGraphAdAccount,
  source: MetaAdAccountNormalized["source"],
  business?: MetaGraphBusiness,
): MetaAdAccountNormalized | null {
  if (typeof item.id !== "string" || typeof item.name !== "string") return null;
  const idInfo = normalizeAccountId(item.id);
  return {
    id: idInfo.id,
    raw_id: idInfo.rawId,
    name: item.name,
    currency: item.currency ?? null,
    timezone: item.timezone_name ?? null,
    account_status:
      typeof item.account_status === "number" ? item.account_status : null,
    source,
    business_id: typeof business?.id === "string" ? business.id : null,
    business_name: typeof business?.name === "string" ? business.name : null,
  };
}

function mergeAccount(
  merged: Map<string, MetaAdAccountNormalized>,
  account: MetaAdAccountNormalized | null,
) {
  if (!account) return;
  const existing = merged.get(account.id);
  if (!existing) {
    merged.set(account.id, account);
    return;
  }
  merged.set(account.id, {
    ...existing,
    name: existing.name || account.name,
    currency: existing.currency ?? account.currency,
    timezone: existing.timezone ?? account.timezone,
    account_status: existing.account_status ?? account.account_status,
    business_id: existing.business_id ?? account.business_id,
    business_name: existing.business_name ?? account.business_name,
  });
}

/**
 * What a failed discovery edge is allowed to say.
 *
 * This used to be `body?.error?.message ?? fallback`, i.e. the provider's own
 * sentence. It reaches `businessDiscovery.errors[].message`, is joined into the
 * aggregate `body.error.message`, and from there into the ad-accounts route's
 * JSON and the snapshot `lastError` the browser renders.
 */
function describeEdgeFailure(
  edge: string,
  status: number,
  identity: MetaGraphErrorIdentity | null,
) {
  return `Meta ${edge} discovery failed (${namedGraphIdentity(status, identity)})`;
}

export async function fetchMetaAdAccounts(
  accessToken: string
): Promise<MetaAdAccountsFetchResult> {
  const direct = await fetchMetaGraphCollection<MetaGraphAdAccount>(
    "me/adaccounts?fields=id,name,account_status,currency,timezone_name&limit=100",
    accessToken,
  );
  const merged = new Map<string, MetaAdAccountNormalized>();

  for (const item of direct.data) {
    mergeAccount(merged, normalizeMetaAdAccount(item, "direct"));
  }

  const businessDiscovery: MetaAdAccountsFetchResult["businessDiscovery"] = {
    status: null,
    ok: false,
    businessCount: 0,
    accountCount: 0,
    errors: [],
  };

  if (direct.ok && !direct.body?.error) {
    const businesses = await fetchMetaGraphCollection<MetaGraphBusiness>(
      "me/businesses?fields=id,name&limit=100",
      accessToken,
    ).catch(() => ({
      status: 0,
      ok: false,
      body: null as MetaSafeAdAccountsResponse | null,
      data: [] as MetaGraphBusiness[],
      graphError: null as MetaGraphErrorIdentity | null,
    }));

    businessDiscovery.status = businesses.status;
    businessDiscovery.ok = businesses.ok && !businesses.body?.error;
    businessDiscovery.businessCount = businesses.data.length;

    if (!businessDiscovery.ok) {
      businessDiscovery.errors.push({
        edge: "me/businesses",
        message: describeEdgeFailure(
          "me/businesses",
          businesses.status,
          businesses.graphError,
        ),
        graphError: businesses.graphError,
      });
    }

    for (const business of businesses.data) {
      if (typeof business.id !== "string") continue;
      const edges = [
        { edge: "owned_ad_accounts", source: "business_owned" as const },
        { edge: "client_ad_accounts", source: "business_client" as const },
      ];

      for (const { edge, source } of edges) {
        const result = await fetchMetaGraphCollection<MetaGraphAdAccount>(
          `${business.id}/${edge}?fields=id,name,account_status,currency,timezone_name&limit=100`,
          accessToken,
        ).catch(() => ({
          status: 0,
          ok: false,
          body: null as MetaSafeAdAccountsResponse | null,
          data: [] as MetaGraphAdAccount[],
          graphError: null as MetaGraphErrorIdentity | null,
        }));

        if (!result.ok || result.body?.error) {
          businessDiscovery.errors.push({
            businessId: business.id,
            edge,
            message: describeEdgeFailure(edge, result.status, result.graphError),
            graphError: result.graphError,
          });
          continue;
        }

        for (const item of result.data) {
          const beforeCount = merged.size;
          mergeAccount(merged, normalizeMetaAdAccount(item, source, business));
          if (merged.size > beforeCount) {
            businessDiscovery.accountCount += 1;
          }
        }
      }
    }
  }

  const businessDiscoveryFailed = businessDiscovery.errors.length > 0;
  const businessDiscoveryFailureBody: MetaSafeAdAccountsResponse | null =
    businessDiscoveryFailed
      ? {
          // Every part joined here came from `describeEdgeFailure`, so the
          // aggregate is locally authored end to end.
          error: localGraphError(
            `Meta business account discovery failed: ${businessDiscovery.errors
              .map((error) => error.message)
              .join("; ")}`,
          ),
        }
      : null;

  return {
    status: direct.status,
    ok: direct.ok && !businessDiscoveryFailed,
    body: businessDiscoveryFailureBody ?? direct.body,
    normalized: Array.from(merged.values()),
    graphError: direct.graphError,
    businessDiscovery,
  };
}

/**
 * The message the OAuth callback, the ad-accounts route and the sync worker
 * adapter throw. Everything it can return is authored here.
 *
 * The `body.error` it reads is a `MetaSafeGraphError`, which only this module
 * constructs; the provider's own `error.message` is discarded at the parse
 * boundary in `fetchMetaGraphCollection` and never reaches this function. The
 * fallback used to be the raw response text, so an edge answering with a
 * non-JSON body put the whole provider response into an application error.
 */
export function getMetaApiErrorMessage(result: MetaAdAccountsFetchResult) {
  const authoredMessage = result.body?.error;
  if (authoredMessage && authoredMessage.authored_by === "adsecute") {
    return authoredMessage.message;
  }
  return describeMetaGraphFailure(result.status, result.graphError ?? null);
}
