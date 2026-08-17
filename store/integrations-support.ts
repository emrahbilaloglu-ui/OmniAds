import type { ProviderConnectionFacts } from "@/lib/provider-read-capability";
import type {
  AssignedAccountsByBusiness,
  IntegrationAdAccount,
  IntegrationProvider,
  IntegrationState,
  ProviderConnectionState,
  ProviderDiscoveryEntity,
  ProviderDiscoveryState,
  ProviderDomainState,
  ProviderViewState,
} from "@/store/integrations-store";

export const INTEGRATION_PROVIDERS: IntegrationProvider[] = [
  "shopify",
  "meta",
  "google",
  "search_console",
  "tiktok",
  "pinterest",
  "snapchat",
  "ga4",
  "klaviyo",
];

export const DEFAULT_INTEGRATION_ACCOUNTS: Record<IntegrationProvider, IntegrationAdAccount[]> = {
  shopify: [],
  meta: [],
  google: [],
  search_console: [],
  tiktok: [],
  pinterest: [],
  snapchat: [],
  ga4: [],
  klaviyo: [],
};

export function isLegacyMockAccount(account: IntegrationAdAccount) {
  return (
    account.id.startsWith("meta-acct-") ||
    account.id.startsWith("google-acct-") ||
    account.id.startsWith("shopify-acct-") ||
    account.id === "ga4-property-1" ||
    account.id.startsWith("klaviyo-list-")
  );
}

export function buildDefaultIntegrations(): Record<IntegrationProvider, IntegrationState> {
  return INTEGRATION_PROVIDERS.reduce<Record<IntegrationProvider, IntegrationState>>(
    (acc, provider) => {
      acc[provider] = {
        provider,
        status: "disconnected",
        accounts: [],
      };
      return acc;
    },
    {} as Record<IntegrationProvider, IntegrationState>
  );
}

function buildDefaultConnectionState(): ProviderConnectionState {
  return {
    status: "disconnected",
  };
}

function buildDefaultDiscoveryState(): ProviderDiscoveryState {
  return {
    status: "idle",
    entities: [],
    source: null,
    sourceHealth: null,
    trustLevel: null,
    trustScore: null,
    fetchedAt: null,
    notice: null,
    stale: false,
    refreshFailed: false,
    failureClass: null,
    retryAfterAt: null,
  };
}

export function buildDefaultProviderDomains(): Record<IntegrationProvider, ProviderDomainState> {
  return INTEGRATION_PROVIDERS.reduce<Record<IntegrationProvider, ProviderDomainState>>(
    (acc, provider) => {
      acc[provider] = {
        provider,
        connection: buildDefaultConnectionState(),
        discovery: buildDefaultDiscoveryState(),
        assignment: {
          status: "idle",
          selectedIds: [],
          updatedAt: null,
        },
      };
      return acc;
    },
    {} as Record<IntegrationProvider, ProviderDomainState>
  );
}

export function normalizeBusinessIntegrations(
  current?: Partial<Record<IntegrationProvider, IntegrationState>>
): Record<IntegrationProvider, IntegrationState> {
  const defaults = buildDefaultIntegrations();
  if (!current) return defaults;

  return INTEGRATION_PROVIDERS.reduce<Record<IntegrationProvider, IntegrationState>>(
    (acc, provider) => {
      const existing = current[provider];
      acc[provider] = existing
        ? {
            provider,
            status: existing.status,
            errorMessage: existing.errorMessage,
            connectedAt: existing.connectedAt,
            lastSyncAt: existing.lastSyncAt,
            integrationId: existing.integrationId,
            providerAccountId: existing.providerAccountId,
            providerAccountName: existing.providerAccountName,
            accounts: (existing.accounts ?? []).filter(
              (account) => !isLegacyMockAccount(account)
            ),
          }
        : defaults[provider];
      return acc;
    },
    {} as Record<IntegrationProvider, IntegrationState>
  );
}

export function normalizeAssignedAccounts(
  businessId: string,
  assignedAccountsByBusiness: AssignedAccountsByBusiness,
  byBusinessId: Record<string, Record<IntegrationProvider, IntegrationState>>
): Partial<Record<IntegrationProvider, string[]>> {
  const existing = assignedAccountsByBusiness[businessId];
  if (existing) return existing;

  const integrations = byBusinessId[businessId];
  if (!integrations) return {};

  return INTEGRATION_PROVIDERS.reduce<Partial<Record<IntegrationProvider, string[]>>>(
    (acc, provider) => {
      acc[provider] = (integrations[provider]?.accounts ?? [])
        .filter((account) => account.enabled)
        .map((account) => account.id);
      return acc;
    },
    {}
  );
}

export function withAssignedAccountFlags(
  accounts: Array<{ id: string; name: string }>,
  assignedIds: string[]
) {
  return accounts.map((account) => ({
    id: account.id,
    name: account.name,
    enabled: assignedIds.includes(account.id),
  }));
}

export function updateEnabledAccounts(
  accounts: IntegrationAdAccount[],
  accountIds: string[]
) {
  return accounts.map((account) =>
    accountIds.includes(account.id)
      ? { ...account, enabled: true }
      : { ...account, enabled: false }
  );
}

function legacyStatusFromConnection(
  connection: ProviderConnectionState,
  discovery: ProviderDiscoveryState
): IntegrationState["status"] {
  if (connection.status === "error" || connection.status === "expired") {
    return "error";
  }
  if (connection.status === "connected") {
    return "connected";
  }
  if (discovery.status === "loading") {
    return "connecting";
  }
  return "disconnected";
}

export function normalizeBusinessProviderDomains(
  current: Partial<Record<IntegrationProvider, ProviderDomainState>> | undefined,
  legacyIntegrations?: Record<IntegrationProvider, IntegrationState>,
  assignedByProvider?: Partial<Record<IntegrationProvider, string[]>>
): Record<IntegrationProvider, ProviderDomainState> {
  const defaults = buildDefaultProviderDomains();

  return INTEGRATION_PROVIDERS.reduce<Record<IntegrationProvider, ProviderDomainState>>(
    (acc, provider) => {
      const existing = current?.[provider];
      const legacy = legacyIntegrations?.[provider];
      const assignedIds = assignedByProvider?.[provider] ?? [];
      const entities: ProviderDiscoveryEntity[] = (legacy?.accounts ?? []).map((account) => ({
        id: account.id,
        name: account.name,
      }));

      acc[provider] = {
        provider,
        connection: existing?.connection ?? {
          status:
            legacy?.status === "connected"
              ? "connected"
              : legacy?.status === "error" || legacy?.status === "timeout"
                ? "error"
                : "disconnected",
          integrationId: legacy?.integrationId,
          connectedAt: legacy?.connectedAt,
          lastSyncAt: legacy?.lastSyncAt,
          providerAccountId: legacy?.providerAccountId,
          providerAccountName: legacy?.providerAccountName,
          errorMessage: legacy?.errorMessage,
        },
        discovery: existing?.discovery ?? {
          status: entities.length > 0 ? "ready" : "idle",
          entities,
          source: entities.length > 0 ? "snapshot" : null,
          sourceHealth: entities.length > 0 ? "healthy_cached" : null,
          trustLevel: entities.length > 0 ? "safe" : null,
          trustScore: entities.length > 0 ? 68 : null,
          fetchedAt: legacy?.lastSyncAt ?? null,
          notice: null,
          stale: false,
          refreshFailed: false,
          failureClass: null,
          retryAfterAt: null,
          errorMessage: undefined,
        },
        assignment: existing?.assignment ?? {
          status:
            assignedIds.length > 0
              ? "ready"
              : entities.length > 0
                ? "empty"
                : "idle",
          selectedIds: assignedIds,
          updatedAt: null,
          errorMessage: undefined,
        },
      };
      if (!existing && !legacy) {
        acc[provider] = defaults[provider];
      }
      return acc;
    },
    {} as Record<IntegrationProvider, ProviderDomainState>
  );
}

export function syncLegacyIntegrationsFromDomains(
  current: Record<IntegrationProvider, IntegrationState> | undefined,
  domains: Record<IntegrationProvider, ProviderDomainState>
): Record<IntegrationProvider, IntegrationState> {
  const normalized = normalizeBusinessIntegrations(current);

  return INTEGRATION_PROVIDERS.reduce<Record<IntegrationProvider, IntegrationState>>(
    (acc, provider) => {
      const domain = domains[provider];
      const existing = normalized[provider];
      acc[provider] = {
        provider,
        status: legacyStatusFromConnection(domain.connection, domain.discovery),
        errorMessage: domain.connection.errorMessage,
        connectedAt: domain.connection.connectedAt,
        lastSyncAt:
          domain.connection.lastSyncAt ??
          domain.discovery.fetchedAt ??
          existing.lastSyncAt,
        integrationId: domain.connection.integrationId,
        providerAccountId: domain.connection.providerAccountId,
        providerAccountName: domain.connection.providerAccountName,
        accounts: withAssignedAccountFlags(
          domain.discovery.entities.map((entity) => ({
            id: entity.id,
            name: entity.name,
          })),
          domain.assignment.selectedIds
        ),
      };
      return acc;
    },
    {} as Record<IntegrationProvider, IntegrationState>
  );
}

function providerDetailLabel(provider: IntegrationProvider) {
  if (provider === "shopify") return "Store";
  if (provider === "ga4") return "Property";
  if (provider === "search_console") return "Site";
  if (provider === "klaviyo") return "Workspace";
  return "Assigned";
}

function providerActionLabel(
  provider: IntegrationProvider,
  assignedCount: number,
  hasSelectedProviderEntity: boolean
) {
  if (provider === "shopify") {
    return "Connected";
  }
  if (provider === "ga4") {
    return hasSelectedProviderEntity ? "Change Property" : "Select Property";
  }
  if (provider === "search_console") {
    return hasSelectedProviderEntity ? "Change Site" : "Select Site";
  }
  if (provider === "klaviyo") return "Open intelligence";
  return assignedCount > 0 ? "Manage assignments" : "Finish setup";
}

function providerMetaValue(
  provider: IntegrationProvider,
  domain: ProviderDomainState,
  assignedCount: number
) {
  const providerAccountName =
    domain.connection.providerAccountName ??
    domain.connection.providerAccountId;
  if (
    provider === "shopify" ||
    provider === "ga4" ||
    provider === "search_console" ||
    provider === "klaviyo"
  ) {
    return providerAccountName ?? "Not configured yet";
  }
  return assignedCount > 0
    ? `${assignedCount} ${assignedCount === 1 ? "account" : "accounts"}`
    : "Not configured yet";
}

export function deriveProviderViewState(
  provider: IntegrationProvider,
  domain: ProviderDomainState
): ProviderViewState {
  const assignedCount = domain.assignment.selectedIds.length;
  const providerSupportsAssignments = provider === "meta" || provider === "google";
  const providerRequiresSelection =
    provider === "ga4" || provider === "search_console";
  const hasDiscoveryEntities = domain.discovery.entities.length > 0;
  const providerAccountValue =
    domain.connection.providerAccountName ??
    domain.connection.providerAccountId ??
    (domain.connection.status === "connected" ? "Linked workspace" : "—");
  const hasSelectedProviderEntity = Boolean(
    domain.connection.providerAccountName || domain.connection.providerAccountId
  );

  let status: ProviderViewState["status"];
  if (domain.connection.status === "expired" || domain.connection.status === "error") {
    status = "action_required";
  } else if (domain.connection.status !== "connected") {
    status = "disconnected";
  } else if (
    providerSupportsAssignments &&
    domain.discovery.status === "loading" &&
    domain.discovery.entities.length > 0
  ) {
    status = "loading_data";
  } else if (domain.discovery.refreshFailed && !hasDiscoveryEntities && assignedCount === 0) {
    status = "action_required";
  } else if (
    provider === "google" &&
    domain.discovery.refreshFailed &&
    domain.discovery.failureClass === "quota"
  ) {
    status = "ready";
  } else if (
    provider === "google" &&
    domain.discovery.sourceHealth === "stale_cached" &&
    hasDiscoveryEntities
  ) {
    status = "degraded";
  } else if (domain.discovery.refreshFailed) {
    status = assignedCount > 0 || !providerSupportsAssignments ? "degraded" : "needs_assignment";
  } else if (providerSupportsAssignments && domain.discovery.status === "failed") {
    status = "action_required";
  } else if (providerRequiresSelection && !hasSelectedProviderEntity) {
    status = "needs_assignment";
  } else if (
    providerSupportsAssignments &&
    (domain.discovery.status === "ready" || domain.discovery.status === "stale") &&
    assignedCount === 0
  ) {
    status = "needs_assignment";
  } else if (
    providerSupportsAssignments &&
    domain.discovery.status === "loading" &&
    !hasDiscoveryEntities
  ) {
    status = domain.discovery.refreshFailed ? "action_required" : "needs_assignment";
  } else {
    status = "ready";
  }

  return {
    provider,
    status,
    connectionLabel:
      domain.connection.status === "connected"
        ? "Live"
        : domain.connection.status === "expired"
          ? "Expired"
          : domain.connection.status === "error"
            ? "Needs attention"
            : "Not connected",
    primaryActionLabel:
      status === "disconnected"
        ? "Connect"
        : providerActionLabel(provider, assignedCount, hasSelectedProviderEntity),
    statusLabel:
      status === "ready"
        ? "Connected"
        : status === "needs_assignment"
          ? "Needs setup"
          : status === "loading_data"
            ? "Loading"
            : status === "degraded"
              ? "Degraded"
              : status === "action_required"
                ? "Action required"
                : "Not connected",
    detailLabel: providerDetailLabel(provider),
    detailValue: providerMetaValue(provider, domain, assignedCount),
    accountLabel: "Account",
    accountValue: providerAccountValue,
    lastSyncLabel: "Last sync",
    lastSyncValue:
      domain.connection.lastSyncAt ??
      domain.discovery.fetchedAt ??
      (domain.connection.status === "connected" ? "Ready" : "—"),
    assignedCount,
    assignedSummary:
      assignedCount > 0
        ? `${assignedCount} ${assignedCount === 1 ? "account" : "accounts"} assigned`
        : providerSupportsAssignments
          ? "No accounts assigned"
          : provider === "shopify"
            ? "Store connection is complete"
            : "Configuration not selected yet",
    connectedAt: domain.connection.connectedAt,
    errorMessage: domain.connection.errorMessage ?? domain.discovery.errorMessage,
    notice: domain.discovery.notice,
    canManageAssignments:
      provider === "meta" ||
      provider === "google" ||
      provider === "ga4" ||
      provider === "search_console" ||
      provider === "klaviyo",
    isConnected: domain.connection.status === "connected",
  };
}

/**
 * The connection facts an effective-capability decision reads, lifted off a
 * domain. `deriveProviderViewState` deliberately stays out of it: its
 * `isConnected` is the stored row's status and nothing more, which is exactly
 * the claim the header must stop making on its own.
 */
export function providerConnectionFacts(
  domain: ProviderDomainState | undefined
): ProviderConnectionFacts {
  return {
    status: domain?.connection.status ?? "disconnected",
    scopes: domain?.connection.scopes ?? null,
    selectedEntityId: domain?.connection.selectedEntityId ?? null,
  };
}

export function deriveProviderViewStates(
  domains: Record<IntegrationProvider, ProviderDomainState> | undefined
) {
  const normalized = domains ?? buildDefaultProviderDomains();
  return INTEGRATION_PROVIDERS.map((provider) =>
    deriveProviderViewState(provider, normalized[provider])
  );
}
