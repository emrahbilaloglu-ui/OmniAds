import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  buildDefaultProviderDomains,
  DEFAULT_INTEGRATION_ACCOUNTS,
  deriveProviderViewState,
  INTEGRATION_PROVIDERS,
  normalizeAssignedAccounts,
  normalizeBusinessIntegrations,
  normalizeBusinessProviderDomains,
  syncLegacyIntegrationsFromDomains,
  updateEnabledAccounts,
  withAssignedAccountFlags,
} from "@/store/integrations-support";

export const INTEGRATIONS_STORE_PERSIST_KEY = "omniads-integrations-store-v2";

export type IntegrationProvider =
  | "shopify"
  | "meta"
  | "google"
  | "search_console"
  | "tiktok"
  | "pinterest"
  | "snapchat"
  | "ga4"
  | "klaviyo";

export type IntegrationStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "timeout";

export interface IntegrationAdAccount {
  id: string;
  name: string;
  enabled: boolean;
}

export interface IntegrationState {
  provider: IntegrationProvider;
  status: IntegrationStatus;
  errorMessage?: string;
  connectedAt?: string;
  lastSyncAt?: string;
  integrationId?: string;
  providerAccountId?: string;
  providerAccountName?: string;
  accounts: IntegrationAdAccount[];
}

export type ProviderConnectionStatus =
  | "connected"
  | "disconnected"
  | "expired"
  | "error";

export type ProviderDiscoveryStatus =
  | "idle"
  | "loading"
  | "ready"
  | "stale"
  | "failed";

export type ProviderAssignmentStatus =
  | "idle"
  | "loading"
  | "ready"
  | "empty"
  | "failed";

export type ProviderPresentationStatus =
  | "disconnected"
  | "connecting"
  | "loading_data"
  | "ready"
  | "needs_assignment"
  | "degraded"
  | "action_required";

export interface ProviderConnectionState {
  status: ProviderConnectionStatus;
  integrationId?: string;
  connectedAt?: string;
  lastCheckedAt?: string;
  lastSyncAt?: string;
  providerAccountId?: string;
  providerAccountName?: string;
  errorMessage?: string;
}

export interface ProviderDiscoveryEntity {
  id: string;
  name: string;
  currency?: string;
  timezone?: string;
  isManager?: boolean;
}

export interface ProviderDiscoveryState {
  status: ProviderDiscoveryStatus;
  entities: ProviderDiscoveryEntity[];
  source: "live" | "snapshot" | null;
  sourceHealth?: "fresh" | "healthy_cached" | "stale_cached" | "degraded_blocking" | null;
  trustLevel?: "safe" | "risky" | "blocking" | null;
  trustScore?: number | null;
  fetchedAt?: string | null;
  errorMessage?: string;
  notice?: string | null;
  stale: boolean;
  refreshFailed: boolean;
  failureClass?: "quota" | "auth" | "scope" | "permission" | "unknown" | null;
  retryAfterAt?: string | null;
}

export interface ProviderAssignmentState {
  status: ProviderAssignmentStatus;
  selectedIds: string[];
  updatedAt?: string | null;
  errorMessage?: string;
}

export interface ProviderDomainState {
  provider: IntegrationProvider;
  connection: ProviderConnectionState;
  discovery: ProviderDiscoveryState;
  assignment: ProviderAssignmentState;
}

export interface ProviderViewState {
  provider: IntegrationProvider;
  status: ProviderPresentationStatus;
  connectionLabel: string;
  primaryActionLabel: string;
  statusLabel: string;
  detailLabel: string;
  detailValue: string;
  accountLabel: string;
  accountValue: string;
  lastSyncLabel: string;
  lastSyncValue: string;
  assignedCount: number;
  assignedSummary: string;
  connectedAt?: string;
  errorMessage?: string;
  notice?: string | null;
  canManageAssignments: boolean;
  isConnected: boolean;
}

export type AssignedAccountsByBusiness = Record<
  string,
  Partial<Record<IntegrationProvider, string[]>>
>;

export interface IntegrationToast {
  type: "success" | "error";
  message: string;
}

interface ManifestConnectionRow {
  provider: IntegrationProvider;
  status: string;
  id?: string;
  connected_at?: string | null;
  updated_at?: string | null;
  provider_account_id?: string | null;
  provider_account_name?: string | null;
  error_message?: string | null;
  token_expires_at?: string | null;
  refresh_token?: string | null;
  has_refresh_token?: boolean | null;
}

interface IntegrationsStore {
  byBusinessId: Record<string, Record<IntegrationProvider, IntegrationState>>;
  domainsByBusinessId: Record<string, Record<IntegrationProvider, ProviderDomainState>>;
  assignedAccountsByBusiness: AssignedAccountsByBusiness;
  bootstrapStatusByBusiness: Record<string, "idle" | "loading" | "ready">;
  toast: IntegrationToast | null;
  clearAllState: () => void;
  ensureBusiness: (businessId: string) => void;
  ensureBusinessDomains: (businessId: string) => void;
  startBusinessBootstrap: (businessId: string) => void;
  finishBusinessBootstrap: (businessId: string) => void;
  setManifestConnections: (businessId: string, rows: ManifestConnectionRow[]) => void;
  setProviderDiscovery: (
    businessId: string,
    provider: IntegrationProvider,
    payload: {
      status: ProviderDiscoveryStatus;
      entities?: ProviderDiscoveryEntity[];
      source?: "live" | "snapshot" | null;
      sourceHealth?: "fresh" | "healthy_cached" | "stale_cached" | "degraded_blocking" | null;
      trustLevel?: "safe" | "risky" | "blocking" | null;
      trustScore?: number | null;
      fetchedAt?: string | null;
      errorMessage?: string;
      notice?: string | null;
      stale?: boolean;
      refreshFailed?: boolean;
      failureClass?: "quota" | "auth" | "scope" | "permission" | "unknown" | null;
      retryAfterAt?: string | null;
    }
  ) => void;
  setProviderAssignmentState: (
    businessId: string,
    provider: IntegrationProvider,
    payload: {
      status: ProviderAssignmentStatus;
      selectedIds: string[];
      updatedAt?: string | null;
      errorMessage?: string;
    }
  ) => void;
  startConnecting: (businessId: string, provider: IntegrationProvider) => void;
  setConnected: (
    businessId: string,
    provider: IntegrationProvider,
    integrationId?: string,
    metadata?: {
      connectedAt?: string;
      lastSyncAt?: string;
      providerAccountId?: string | null;
      providerAccountName?: string | null;
    }
  ) => void;
  setError: (
    businessId: string,
    provider: IntegrationProvider,
    errorMessage: string
  ) => void;
  setTimedOut: (businessId: string, provider: IntegrationProvider) => void;
  disconnect: (businessId: string, provider: IntegrationProvider) => void;
  setAssignedAccounts: (
    businessId: string,
    provider: IntegrationProvider,
    accountIds: string[]
  ) => void;
  setProviderAccounts: (
    businessId: string,
    provider: IntegrationProvider,
    accounts: Array<{ id: string; name: string; currency?: string; timezone?: string; isManager?: boolean }>
  ) => void;
  removeBusinessData: (businessId: string) => void;
  retainBusinesses: (businessIds: string[]) => void;
  clearProviderAccountsForBusiness: (businessId: string) => void;
  getAssignedAccounts: (businessId: string, provider: IntegrationProvider) => string[];
  hasAssignedAccounts: (businessId: string, provider: IntegrationProvider) => boolean;
  getProviderViewState: (businessId: string, provider: IntegrationProvider) => ProviderViewState;
  setToast: (toast: IntegrationToast) => void;
  clearToast: () => void;
}

function providerCanAutoRefresh(
  provider: IntegrationProvider,
  hasRefreshToken?: boolean | null
) {
  if (!hasRefreshToken) return false;
  return provider === "google" || provider === "ga4" || provider === "search_console";
}

/**
 * Whether a stored `token_expires_at` is evidence the PROVIDER will reject us.
 *
 * For Google-family providers the stamp is authoritative: the token really is
 * refused past it, which is why they carry a refresh token to get ahead of it.
 *
 * For Meta it is not. The stamp is our own note taken at grant time, never
 * re-derived and never confirmed against Meta, and Meta's long-lived tokens
 * routinely keep working past it. Treating it as expiry meant the UI announced
 * a failure that the provider had not declared and that no user action could
 * clear: measured 2026-08-06, all 12 Meta rows in `provider_connections` were
 * `connected` and every one of them held an access token, while 10 sat behind
 * an "Expired / Action required" badge sourced entirely from this column.
 *
 * So Meta's freshness is decided by asking Meta. `validateMetaLiveAccountAccess`
 * is that question, and the repair engine already treats its verdict as the
 * authority on whether a Meta auth failure is real. The badge now waits for the
 * same evidence: a warning appears when Meta actually rejects, not before.
 */
function providerExpiryStampIsAuthoritative(provider: IntegrationProvider) {
  return provider !== "meta";
}

function getDomainsForState(state: IntegrationsStore, businessId: string) {
  return normalizeBusinessProviderDomains(
    state.domainsByBusinessId[businessId],
    state.byBusinessId[businessId],
    state.assignedAccountsByBusiness[businessId]
  );
}

function updateDomains(
  state: IntegrationsStore,
  businessId: string,
  updater: (
    current: Record<IntegrationProvider, ProviderDomainState>
  ) => Record<IntegrationProvider, ProviderDomainState>
) {
  const currentDomains = getDomainsForState(state, businessId);
  const nextDomains = updater(currentDomains);
  return {
    domainsByBusinessId: {
      ...state.domainsByBusinessId,
      [businessId]: nextDomains,
    },
    byBusinessId: {
      ...state.byBusinessId,
      [businessId]: syncLegacyIntegrationsFromDomains(state.byBusinessId[businessId], nextDomains),
    },
  };
}

export const useIntegrationsStore = create<IntegrationsStore>()(
  persist(
    (set, get) => ({
      byBusinessId: {},
      domainsByBusinessId: {},
      assignedAccountsByBusiness: {},
      bootstrapStatusByBusiness: {},
      toast: null,
      clearAllState: () =>
        set({
          byBusinessId: {},
          domainsByBusinessId: {},
          assignedAccountsByBusiness: {},
          bootstrapStatusByBusiness: {},
          toast: null,
        }),
      ensureBusiness: (businessId) => {
        set((state) => ({
          byBusinessId: {
            ...state.byBusinessId,
            [businessId]: normalizeBusinessIntegrations(state.byBusinessId[businessId]),
          },
          domainsByBusinessId: {
            ...state.domainsByBusinessId,
            [businessId]: normalizeBusinessProviderDomains(
              state.domainsByBusinessId[businessId],
              state.byBusinessId[businessId],
              state.assignedAccountsByBusiness[businessId]
            ),
          },
          assignedAccountsByBusiness: {
            ...state.assignedAccountsByBusiness,
            [businessId]: normalizeAssignedAccounts(
              businessId,
              state.assignedAccountsByBusiness,
              state.byBusinessId
            ),
          },
          bootstrapStatusByBusiness: {
            ...state.bootstrapStatusByBusiness,
            [businessId]: state.bootstrapStatusByBusiness[businessId] ?? "idle",
          },
        }));
      },
      ensureBusinessDomains: (businessId) => {
        get().ensureBusiness(businessId);
      },
      startBusinessBootstrap: (businessId) => {
        get().ensureBusiness(businessId);
        set((state) => ({
          bootstrapStatusByBusiness: {
            ...state.bootstrapStatusByBusiness,
            [businessId]: "loading",
          },
        }));
      },
      finishBusinessBootstrap: (businessId) => {
        get().ensureBusiness(businessId);
        set((state) => ({
          bootstrapStatusByBusiness: {
            ...state.bootstrapStatusByBusiness,
            [businessId]: "ready",
          },
        }));
      },
      setManifestConnections: (businessId, rows) => {
        get().ensureBusiness(businessId);
        set((state) => {
          const result = updateDomains(state, businessId, (currentDomains) => {
            const nextDomains = { ...currentDomains };
            for (const provider of INTEGRATION_PROVIDERS) {
              const row = rows.find((item) => item.provider === provider);
              if (!row) {
                nextDomains[provider] = {
                  ...nextDomains[provider],
                  connection: {
                    ...nextDomains[provider].connection,
                    status: "disconnected",
                    lastCheckedAt: new Date().toISOString(),
                    errorMessage: undefined,
                  },
                };
                continue;
              }

              const isExpired =
                providerExpiryStampIsAuthoritative(provider) &&
                Boolean(row.token_expires_at) &&
                new Date(row.token_expires_at as string).getTime() <= Date.now();
              const nextStatus: ProviderConnectionStatus =
                row.status === "error"
                  ? "error"
                  : isExpired &&
                      !providerCanAutoRefresh(
                        provider,
                        row.has_refresh_token ?? Boolean(row.refresh_token)
                      )
                    ? "expired"
                    : row.status === "connected"
                      ? "connected"
                      : "disconnected";

              nextDomains[provider] = {
                ...nextDomains[provider],
                connection: {
                  ...nextDomains[provider].connection,
                  status: nextStatus,
                  integrationId: row.id ?? nextDomains[provider].connection.integrationId,
                  connectedAt:
                    row.connected_at ?? nextDomains[provider].connection.connectedAt,
                  lastCheckedAt: new Date().toISOString(),
                  lastSyncAt:
                    row.updated_at ?? nextDomains[provider].connection.lastSyncAt,
                  providerAccountId:
                    row.provider_account_id ??
                    nextDomains[provider].connection.providerAccountId,
                  providerAccountName:
                    row.provider_account_name ??
                    nextDomains[provider].connection.providerAccountName,
                  errorMessage:
                    row.error_message ??
                    (nextStatus === "error"
                      ? nextDomains[provider].connection.errorMessage ??
                        "Connection failed on the server."
                      : undefined),
                },
              };
            }
            return nextDomains;
          });

          return result;
        });
      },
      setProviderDiscovery: (businessId, provider, payload) => {
        get().ensureBusiness(businessId);
        set((state) =>
          updateDomains(state, businessId, (currentDomains) => ({
            ...currentDomains,
            [provider]: {
              ...currentDomains[provider],
              discovery: {
                ...currentDomains[provider].discovery,
                status: payload.status,
                entities:
                  payload.entities ?? currentDomains[provider].discovery.entities,
                source:
                  payload.source === undefined
                    ? currentDomains[provider].discovery.source
                    : payload.source,
                sourceHealth:
                  payload.sourceHealth === undefined
                    ? currentDomains[provider].discovery.sourceHealth
                    : payload.sourceHealth,
                trustLevel:
                  payload.trustLevel === undefined
                    ? currentDomains[provider].discovery.trustLevel
                    : payload.trustLevel,
                trustScore:
                  payload.trustScore === undefined
                    ? currentDomains[provider].discovery.trustScore
                    : payload.trustScore,
                fetchedAt:
                  payload.fetchedAt === undefined
                    ? currentDomains[provider].discovery.fetchedAt
                    : payload.fetchedAt,
                errorMessage: payload.errorMessage,
                notice:
                  payload.notice === undefined
                    ? currentDomains[provider].discovery.notice
                    : payload.notice,
                stale: payload.stale ?? currentDomains[provider].discovery.stale,
                refreshFailed:
                  payload.refreshFailed ??
                  currentDomains[provider].discovery.refreshFailed,
                failureClass:
                  payload.failureClass === undefined
                    ? currentDomains[provider].discovery.failureClass
                    : payload.failureClass,
                retryAfterAt:
                  payload.retryAfterAt === undefined
                    ? currentDomains[provider].discovery.retryAfterAt
                    : payload.retryAfterAt,
              },
            },
          }))
        );
      },
      setProviderAssignmentState: (businessId, provider, payload) => {
        get().ensureBusiness(businessId);
        set((state) => {
          const result = updateDomains(state, businessId, (currentDomains) => ({
            ...currentDomains,
            [provider]: {
              ...currentDomains[provider],
              assignment: {
                ...currentDomains[provider].assignment,
                status: payload.status,
                selectedIds: payload.selectedIds,
                updatedAt: payload.updatedAt,
                errorMessage: payload.errorMessage,
              },
            },
          }));
          return {
            ...result,
            assignedAccountsByBusiness: {
              ...state.assignedAccountsByBusiness,
              [businessId]: {
                ...state.assignedAccountsByBusiness[businessId],
                [provider]: payload.selectedIds,
              },
            },
          };
        });
      },
      startConnecting: (businessId, provider) => {
        get().ensureBusiness(businessId);
        set((state) =>
          updateDomains(state, businessId, (currentDomains) => ({
            ...currentDomains,
            [provider]: {
              ...currentDomains[provider],
              connection: {
                ...currentDomains[provider].connection,
                status: "connected",
                lastCheckedAt: new Date().toISOString(),
                errorMessage: undefined,
              },
            },
          }))
        );
      },
      setConnected: (businessId, provider, integrationId, metadata) => {
        get().ensureBusiness(businessId);
        set((state) => {
          const now = new Date().toISOString();
          return updateDomains(state, businessId, (currentDomains) => ({
            ...currentDomains,
            [provider]: {
              ...currentDomains[provider],
              connection: {
                ...currentDomains[provider].connection,
                status: "connected",
                integrationId,
                connectedAt:
                  metadata?.connectedAt ??
                  currentDomains[provider].connection.connectedAt ??
                  now,
                lastSyncAt: metadata?.lastSyncAt ?? now,
                lastCheckedAt: now,
                providerAccountId:
                  metadata?.providerAccountId ??
                  currentDomains[provider].connection.providerAccountId,
                providerAccountName:
                  metadata?.providerAccountName ??
                  currentDomains[provider].connection.providerAccountName,
                errorMessage: undefined,
              },
            },
          }));
        });
      },
      setError: (businessId, provider, errorMessage) => {
        get().ensureBusiness(businessId);
        set((state) =>
          updateDomains(state, businessId, (currentDomains) => ({
            ...currentDomains,
            [provider]: {
              ...currentDomains[provider],
              connection: {
                ...currentDomains[provider].connection,
                status: "error",
                errorMessage,
                lastCheckedAt: new Date().toISOString(),
              },
            },
          }))
        );
      },
      setTimedOut: (businessId, provider) => {
        get().ensureBusiness(businessId);
        set((state) => ({
          ...updateDomains(state, businessId, (currentDomains) => ({
            ...currentDomains,
            [provider]: {
              ...currentDomains[provider],
              connection: {
                ...currentDomains[provider].connection,
                status: "error",
                errorMessage: "Connection timed out. Please try again.",
                lastCheckedAt: new Date().toISOString(),
              },
            },
          })),
          byBusinessId: {
            ...state.byBusinessId,
            [businessId]: {
              ...normalizeBusinessIntegrations(state.byBusinessId[businessId]),
              [provider]: {
                ...normalizeBusinessIntegrations(state.byBusinessId[businessId])[provider],
                status: "timeout",
                errorMessage: "Connection timed out. Please try again.",
              },
            },
          },
        }));
      },
      disconnect: (businessId, provider) => {
        get().ensureBusiness(businessId);
        set((state) => {
          const result = updateDomains(state, businessId, (currentDomains) => ({
            ...currentDomains,
            [provider]: buildDefaultProviderDomains()[provider],
          }));
          return {
            ...result,
            assignedAccountsByBusiness: {
              ...state.assignedAccountsByBusiness,
              [businessId]: {
                ...state.assignedAccountsByBusiness[businessId],
                [provider]: [],
              },
            },
          };
        });
      },
      setAssignedAccounts: (businessId, provider, accountIds) => {
        get().ensureBusiness(businessId);
        set((state) => {
          const result = updateDomains(state, businessId, (currentDomains) => ({
            ...currentDomains,
            [provider]: {
              ...currentDomains[provider],
              assignment: {
                ...currentDomains[provider].assignment,
                status: accountIds.length > 0 ? "ready" : "empty",
                selectedIds: accountIds,
                updatedAt: new Date().toISOString(),
                errorMessage: undefined,
              },
            },
          }));
          return {
            ...result,
            assignedAccountsByBusiness: {
              ...state.assignedAccountsByBusiness,
              [businessId]: {
                ...state.assignedAccountsByBusiness[businessId],
                [provider]: accountIds,
              },
            },
            byBusinessId: {
              ...result.byBusinessId,
              [businessId]: {
                ...result.byBusinessId[businessId],
                [provider]: {
                  ...result.byBusinessId[businessId][provider],
                  accounts: updateEnabledAccounts(
                    result.byBusinessId[businessId][provider].accounts,
                    accountIds
                  ),
                },
              },
            },
          };
        });
      },
      setProviderAccounts: (businessId, provider, accounts) => {
        get().ensureBusiness(businessId);
        set((state) => {
          const assignedIds = state.assignedAccountsByBusiness[businessId]?.[provider] ?? [];
          const result = updateDomains(state, businessId, (currentDomains) => ({
            ...currentDomains,
            [provider]: {
              ...currentDomains[provider],
              discovery: {
                ...currentDomains[provider].discovery,
                status: accounts.length > 0 ? "ready" : "idle",
                entities: accounts.map((account) => ({
                  id: account.id,
                  name: account.name,
                  currency: account.currency,
                  timezone: account.timezone,
                  isManager: account.isManager,
                })),
                errorMessage: undefined,
              },
            },
          }));
          return {
            ...result,
            byBusinessId: {
              ...result.byBusinessId,
              [businessId]: {
                ...result.byBusinessId[businessId],
                [provider]: {
                  ...result.byBusinessId[businessId][provider],
                  accounts: withAssignedAccountFlags(
                    accounts.map((account) => ({
                      id: account.id,
                      name: account.name,
                    })),
                    assignedIds
                  ),
                },
              },
            },
          };
        });
      },
      removeBusinessData: (businessId) => {
        set((state) => {
          const nextByBusinessId = { ...state.byBusinessId };
          const nextDomainsByBusinessId = { ...state.domainsByBusinessId };
          const nextAssigned = { ...state.assignedAccountsByBusiness };
          const nextBootstrap = { ...state.bootstrapStatusByBusiness };
          delete nextByBusinessId[businessId];
          delete nextDomainsByBusinessId[businessId];
          delete nextAssigned[businessId];
          delete nextBootstrap[businessId];
          return {
            byBusinessId: nextByBusinessId,
            domainsByBusinessId: nextDomainsByBusinessId,
            assignedAccountsByBusiness: nextAssigned,
            bootstrapStatusByBusiness: nextBootstrap,
          };
        });
      },
      retainBusinesses: (businessIds) => {
        const allowed = new Set(businessIds);
        set((state) => ({
          byBusinessId: Object.fromEntries(
            Object.entries(state.byBusinessId).filter(([businessId]) => allowed.has(businessId))
          ),
          domainsByBusinessId: Object.fromEntries(
            Object.entries(state.domainsByBusinessId).filter(([businessId]) =>
              allowed.has(businessId)
            )
          ),
          assignedAccountsByBusiness: Object.fromEntries(
            Object.entries(state.assignedAccountsByBusiness).filter(([businessId]) =>
              allowed.has(businessId)
            )
          ),
          bootstrapStatusByBusiness: Object.fromEntries(
            Object.entries(state.bootstrapStatusByBusiness).filter(([businessId]) =>
              allowed.has(businessId)
            )
          ),
        }));
      },
      clearProviderAccountsForBusiness: (businessId) => {
        get().ensureBusiness(businessId);
        set((state) => {
          const result = updateDomains(state, businessId, (currentDomains) =>
            INTEGRATION_PROVIDERS.reduce<Record<IntegrationProvider, ProviderDomainState>>(
              (acc, provider) => {
                acc[provider] = {
                  ...currentDomains[provider],
                  discovery: {
                    ...currentDomains[provider].discovery,
                    entities: [],
                    status: "idle",
                    notice: null,
                    errorMessage: undefined,
                  },
                  assignment: {
                    ...currentDomains[provider].assignment,
                    selectedIds: [],
                    status: "idle",
                    errorMessage: undefined,
                  },
                };
                return acc;
              },
              {} as Record<IntegrationProvider, ProviderDomainState>
            )
          );
          return {
            ...result,
            assignedAccountsByBusiness: {
              ...state.assignedAccountsByBusiness,
              [businessId]: {},
            },
          };
        });
      },
      getAssignedAccounts: (businessId, provider) =>
        get().assignedAccountsByBusiness[businessId]?.[provider] ?? [],
      hasAssignedAccounts: (businessId, provider) =>
        (get().assignedAccountsByBusiness[businessId]?.[provider] ?? []).length > 0,
      getProviderViewState: (businessId, provider) => {
        const state = get();
        const domains = normalizeBusinessProviderDomains(
          state.domainsByBusinessId[businessId],
          state.byBusinessId[businessId],
          state.assignedAccountsByBusiness[businessId]
        );
        return deriveProviderViewState(provider, domains[provider]);
      },
      setToast: (toast) => set({ toast }),
      clearToast: () => set({ toast: null }),
    }),
    {
      name: INTEGRATIONS_STORE_PERSIST_KEY,
      partialize: (state) => ({
        byBusinessId: state.byBusinessId,
        domainsByBusinessId: state.domainsByBusinessId,
        assignedAccountsByBusiness: state.assignedAccountsByBusiness,
        bootstrapStatusByBusiness: state.bootstrapStatusByBusiness,
      }),
    }
  )
);

export { INTEGRATION_PROVIDERS };
