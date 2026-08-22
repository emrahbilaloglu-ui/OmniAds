import { type IntegrationProvider } from "@/store/integrations-store";

export interface ProviderAccountRow {
  id: string;
  name: string;
  currency?: string;
  timezone?: string;
  isManager?: boolean;
  assigned?: boolean;
}

interface ProviderErrorBody {
  error?: string;
  message?: string;
}

interface SaveSuccessBody {
  success?: boolean;
  assigned_accounts?: string[];
}

/**
 * What the server actually reported, rather than what the caller hoped.
 *
 * The old return type was `{ assignedIds, error }`, which could not express the
 * two outcomes the server takes care to distinguish:
 *
 *  - **202** — the selection was committed but the first sync could not be
 *    scheduled. `response.ok` is true for a 202, so this closed the drawer and
 *    reported plain success; the operator was never told sync had not started
 *    and would wait for data that nothing was fetching.
 *  - **demo** — a 200 that persisted nothing. Reported as a save.
 *
 * `selectionSaved` and `syncScheduled` are the server's own two fields, carried
 * rather than collapsed, which is what the master plan's WP3 item 8 asks for.
 */
export interface ProviderAssignmentSaveOutcome {
  /** Ids the SERVER says are assigned. Never the caller's draft. */
  assignedIds: string[];
  /** Non-null when nothing was committed. */
  error: string | null;
  /** True only when the server says the selection is durable. */
  selectionSaved: boolean;
  /** True only when follow-up sync work was enqueued AND read back. */
  syncScheduled: boolean;
  /** True when the workspace is a demo and by design persists nothing. */
  demo: boolean;
  /** Shown to the operator when the outcome is not a clean success. */
  notice: string | null;
}

interface SaveOutcomeBody extends SaveSuccessBody {
  selectionSaved?: boolean;
  syncScheduled?: boolean;
  demo?: boolean;
  persisted?: boolean;
  message?: string;
}

function readOutcomeBody(payload: unknown): SaveOutcomeBody {
  return payload && typeof payload === "object" ? (payload as SaveOutcomeBody) : {};
}

export function getProviderAssignmentTitle(provider: IntegrationProvider | null) {
  if (!provider) return "Assign accounts";
  if (provider === "meta") {
    return "Assign Meta ad accounts to this business";
  }
  if (provider === "google") {
    return "Assign Google Ads customer accounts to this business";
  }
  if (provider === "ga4") return "Assign GA4 properties to this business";
  if (provider === "shopify") return "Assign Shopify stores to this business";
  return `Assign ${provider} accounts to this business`;
}

export function getProviderFetchPath(provider: IntegrationProvider, businessId: string) {
  if (provider === "meta") {
    return `/integrations/meta/ad-accounts?businessId=${encodeURIComponent(businessId)}`;
  }
  if (provider === "google") {
    return `/api/google/accessible-accounts?businessId=${encodeURIComponent(businessId)}`;
  }
  return null;
}

export function getProviderSavePath(provider: IntegrationProvider, businessId: string) {
  if (provider === "meta") {
    return `/businesses/${encodeURIComponent(businessId)}/meta/assign-accounts`;
  }
  return `/businesses/${encodeURIComponent(businessId)}/${provider}/assign-accounts`;
}

function hasErrorMessage(payload: unknown): payload is ProviderErrorBody {
  if (!payload || typeof payload !== "object") return false;
  return "message" in payload && typeof payload.message === "string";
}

function hasAssignedAccounts(payload: unknown): payload is SaveSuccessBody {
  if (!payload || typeof payload !== "object") return false;
  if (!("assigned_accounts" in payload)) return false;
  const maybeIds = payload.assigned_accounts;
  return Array.isArray(maybeIds) && maybeIds.every((id) => typeof id === "string");
}

const SAVE_FAILED = "Could not save account assignments.";

export async function saveProviderAssignments(params: {
  provider: IntegrationProvider;
  businessId: string;
  draftIds: string[];
}): Promise<ProviderAssignmentSaveOutcome> {
  /**
   * Nothing reached the server, so nothing is assigned.
   *
   * Every failure path below returns `assignedIds: []`. The old code returned
   * the caller's own `draftIds` here, which reads as "these are assigned" —
   * the request's input presented as its result. A caller that trusted the ids
   * without also checking `error` would have shown a confirmed selection for a
   * write that never happened.
   */
  const failed = (error: string): ProviderAssignmentSaveOutcome => ({
    assignedIds: [],
    error,
    selectionSaved: false,
    syncScheduled: false,
    demo: false,
    notice: null,
  });

  try {
    const response = await fetch(getProviderSavePath(params.provider, params.businessId), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ account_ids: params.draftIds }),
    });
    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      return failed(
        (hasErrorMessage(payload) ? payload.message : null) ?? SAVE_FAILED,
      );
    }

    const body = readOutcomeBody(payload);

    // A demo workspace persists nothing and says so. Treated as a refusal
    // rather than a save, because the drawer closing on it would confirm a
    // selection that does not exist.
    if (body.demo === true || body.persisted === false) {
      return {
        assignedIds: [],
        error: null,
        selectionSaved: false,
        syncScheduled: false,
        demo: true,
        notice: body.message ?? "This workspace does not save account assignments.",
      };
    }

    // `selectionSaved` is the server's word for "committed". Absent means an
    // older or unreadable body, and an unreadable body is not a commitment.
    const selectionSaved = body.selectionSaved === true;
    if (!selectionSaved) {
      return failed(body.message ?? SAVE_FAILED);
    }

    const assignedIds = hasAssignedAccounts(payload)
      ? (payload.assigned_accounts ?? [])
      : [];
    const syncScheduled = body.syncScheduled === true;

    return {
      assignedIds,
      error: null,
      selectionSaved: true,
      syncScheduled,
      demo: false,
      // The 202 case. Saved, but nothing is fetching yet — the operator has to
      // know that or they will wait for data no worker was asked for.
      notice: syncScheduled
        ? null
        : (body.message ??
          "Your account selection was saved, but the first sync could not be scheduled yet."),
    };
  } catch {
    return failed(SAVE_FAILED);
  }
}
