import type {
  MetaHistoryHistoricalAccount,
  MetaHistoryAccount,
  MetaHistoryEntityType,
  MetaHistoryKind,
  MetaHistoryOutcomeFilter,
  MetaHistoryResponse,
} from "@/lib/meta/history-contract";

type FetchLike = typeof fetch;

export interface MetaHistoryClientFilters {
  kind: MetaHistoryKind | null;
  entity: MetaHistoryEntityType | null;
  label: string | null;
  outcome: MetaHistoryOutcomeFilter | null;
  from: string | null;
  to: string | null;
  q: string | null;
}

async function readPayload(response: Response) {
  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string }; message?: string }
    | null;
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ?? payload?.message ?? `Meta History request failed (${response.status}).`,
    );
  }
  return payload;
}

export async function fetchMetaHistoryAccounts(input: {
  businessId: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<MetaHistoryAccount[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const params = new URLSearchParams({ businessId: input.businessId });
  const response = await fetchImpl(`/api/meta/history/accounts?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    signal: input.signal,
  });
  const payload = (await readPayload(response)) as { accounts?: MetaHistoryAccount[] } | null;
  return Array.isArray(payload?.accounts) ? payload.accounts : [];
}

/**
 * D078 R4 (correction 2): both picker groups. `historicalAccounts` is
 * TRI-STATE — `null` means the additive account-state read FAILED on the
 * server and the UI must render an explicit unavailable state; `[]` means a
 * successful read proved there is no deselected/historical identity. The
 * client never collapses null into an empty group.
 */
export async function fetchMetaHistoryAccountScopes(input: {
  businessId: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<{
  accounts: MetaHistoryAccount[];
  historicalAccounts: MetaHistoryHistoricalAccount[] | null;
}> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const params = new URLSearchParams({ businessId: input.businessId });
  const response = await fetchImpl(`/api/meta/history/accounts?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    signal: input.signal,
  });
  const payload = (await readPayload(response)) as {
    accounts?: MetaHistoryAccount[];
    historicalAccounts?: MetaHistoryHistoricalAccount[] | null;
  } | null;
  return {
    accounts: Array.isArray(payload?.accounts) ? payload.accounts : [],
    // null (server read failure) passes through; a missing field on a
    // legacy payload also reads as unavailable rather than proven-none.
    historicalAccounts: Array.isArray(payload?.historicalAccounts)
      ? payload.historicalAccounts
      : null,
  };
}

export async function fetchMetaHistoryPage(input: {
  businessId: string;
  providerAccountId: string;
  filters: MetaHistoryClientFilters;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<MetaHistoryResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    limit: String(input.limit ?? 40),
  });
  for (const [key, value] of Object.entries(input.filters)) {
    if (value) params.set(key, value);
  }
  if (input.cursor) params.set("cursor", input.cursor);

  const response = await fetchImpl(`/api/meta/history?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    signal: input.signal,
  });
  return (await readPayload(response)) as MetaHistoryResponse;
}
