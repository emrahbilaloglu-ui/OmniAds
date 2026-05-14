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

interface MetaGraphError {
  message?: string;
  type?: string;
  code?: number;
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

type MetaGraphAdAccountsResponse = MetaGraphCollectionResponse<MetaGraphAdAccount>;

export interface MetaAdAccountsFetchResult {
  status: number;
  ok: boolean;
  rawBody: string;
  body: MetaGraphAdAccountsResponse | null;
  normalized: MetaAdAccountNormalized[];
  businessDiscovery?: {
    status: number | null;
    ok: boolean;
    businessCount: number;
    accountCount: number;
    errors: Array<{ businessId?: string | null; edge: string; message: string }>;
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

async function fetchMetaGraphCollection<TItem>(
  path: string,
  accessToken: string,
  maxPages = 50,
): Promise<{
  status: number;
  ok: boolean;
  rawBody: string;
  body: MetaGraphCollectionResponse<TItem> | null;
  data: TItem[];
}> {
  let nextUrl: string | null = graphUrl(path);
  let resultStatus = 0;
  let resultOk = false;
  let resultRawBody = "";
  let resultBody: MetaGraphCollectionResponse<TItem> | null = null;
  const data: TItem[] = [];
  let stoppedOnError = false;

  for (let page = 0; nextUrl && page < maxPages; page += 1) {
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

    if (page === 0) {
      resultStatus = response.status;
      resultOk = response.ok && !body?.error;
      resultRawBody = rawBody;
      resultBody = body;
    }

    if (!response.ok || body?.error) {
      stoppedOnError = true;
      if (page > 0) {
        resultStatus = response.status;
        resultOk = false;
        resultRawBody = rawBody;
        resultBody = body;
      }
      break;
    }

    if (Array.isArray(body?.data)) {
      data.push(...body.data);
    }
    nextUrl = typeof body?.paging?.next === "string" ? body.paging.next : null;
  }

  if (nextUrl && !stoppedOnError) {
    resultOk = false;
    resultBody = {
      error: {
        message: `Meta Graph pagination exceeded ${maxPages} pages before completion.`,
      },
    };
    resultRawBody = JSON.stringify(resultBody);
  }

  return {
    status: resultStatus,
    ok: resultOk,
    rawBody: resultRawBody,
    body: resultBody,
    data,
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

function graphErrorMessage(body: MetaGraphCollectionResponse<unknown> | null, fallback: string) {
  return body?.error?.message ?? fallback;
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
    ).catch((error: unknown) => ({
      status: 0,
      ok: false,
      rawBody: "",
      body: null,
      data: [] as MetaGraphBusiness[],
      error,
    }));

    businessDiscovery.status = businesses.status;
    businessDiscovery.ok = businesses.ok && !businesses.body?.error;
    businessDiscovery.businessCount = businesses.data.length;

    if (!businessDiscovery.ok) {
      businessDiscovery.errors.push({
        edge: "me/businesses",
        message: graphErrorMessage(
          businesses.body,
          "Meta business discovery failed.",
        ),
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
        ).catch((error: unknown) => ({
          status: 0,
          ok: false,
          rawBody: "",
          body: null,
          data: [] as MetaGraphAdAccount[],
          error,
        }));

        if (!result.ok || result.body?.error) {
          businessDiscovery.errors.push({
            businessId: business.id,
            edge,
            message: graphErrorMessage(
              result.body,
              `Meta ${edge} discovery failed.`,
            ),
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
  const businessDiscoveryFailureBody: MetaGraphAdAccountsResponse | null =
    businessDiscoveryFailed
      ? {
          error: {
            message: `Meta business account discovery failed: ${businessDiscovery.errors
              .map((error) => error.message)
              .join("; ")}`,
          },
        }
      : null;

  return {
    status: direct.status,
    ok: direct.ok && !businessDiscoveryFailed,
    rawBody: direct.rawBody,
    body: businessDiscoveryFailureBody ?? direct.body,
    normalized: Array.from(merged.values()),
    businessDiscovery,
  };
}

export function getMetaApiErrorMessage(result: MetaAdAccountsFetchResult) {
  const bodyError = result.body?.error?.message;
  if (bodyError) return bodyError;
  if (result.rawBody) return result.rawBody;
  return `Meta API request failed with status ${result.status}`;
}
