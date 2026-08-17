"use client";

import { useEffect } from "react";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import {
  fetchProviderAccountSnapshot,
  supportsProviderAssignments,
} from "@/lib/provider-account-client";
import {
  IntegrationProvider,
  useIntegrationsStore,
} from "@/store/integrations-store";

interface ManifestRow {
  id: string;
  provider: IntegrationProvider;
  status: string;
  connected_at?: string | null;
  updated_at?: string | null;
  provider_account_id?: string | null;
  provider_account_name?: string | null;
  error_message?: string | null;
  token_expires_at?: string | null;
  refresh_token?: string | null;
  has_refresh_token?: boolean | null;
  /** Granted OAuth scopes; Search Console's capability depends on Google's. */
  scopes?: string | null;
  metadata?: Record<string, unknown> | null;
}

function getBootstrapLocks() {
  const globalStore = globalThis as typeof globalThis & {
    __omniadsIntegrationBootstraps?: Map<string, Promise<void>>;
  };
  if (!globalStore.__omniadsIntegrationBootstraps) {
    globalStore.__omniadsIntegrationBootstraps = new Map();
  }
  return globalStore.__omniadsIntegrationBootstraps;
}

function enrichManifestRow(row: ManifestRow): ManifestRow {
  if (row.provider !== "ga4") return row;
  const metadata = row.metadata ?? {};
  const propertyName =
    typeof metadata.ga4PropertyName === "string" ? metadata.ga4PropertyName : null;
  const propertyId =
    typeof metadata.ga4PropertyId === "string" ? metadata.ga4PropertyId : null;
  return {
    ...row,
    provider_account_name: row.provider_account_name ?? propertyName,
    provider_account_id: row.provider_account_id ?? propertyId,
  };
}

export function useBusinessIntegrationsBootstrap(
  businessId: string | null,
  options?: { providers?: IntegrationProvider[] }
) {
  const ensureBusinessDomains = useIntegrationsStore((state) => state.ensureBusinessDomains);
  const startBusinessBootstrap = useIntegrationsStore((state) => state.startBusinessBootstrap);
  const finishBusinessBootstrap = useIntegrationsStore((state) => state.finishBusinessBootstrap);
  const setManifestConnections = useIntegrationsStore((state) => state.setManifestConnections);
  const setProviderDiscovery = useIntegrationsStore((state) => state.setProviderDiscovery);
  const setProviderAssignmentState = useIntegrationsStore(
    (state) => state.setProviderAssignmentState
  );
  const bootstrapStatus = useIntegrationsStore((state) =>
    businessId ? state.bootstrapStatusByBusiness[businessId] ?? "idle" : "idle"
  );
  const providerFilterKey = options?.providers?.length
    ? [...new Set(options.providers)].sort().join(",")
    : "all";

  useEffect(() => {
    if (!businessId) return;
    ensureBusinessDomains(businessId);
  }, [businessId, ensureBusinessDomains]);

  useEffect(() => {
    if (!businessId) return;
    const lockKey = `${businessId}:${providerFilterKey}`;
    const locks = getBootstrapLocks();
    if (locks.has(lockKey)) {
      return;
    }

    const bootstrapPromise = (async () => {
      const allowedProviders =
        providerFilterKey === "all"
          ? null
          : new Set(providerFilterKey.split(",") as IntegrationProvider[]);
      startBusinessBootstrap(businessId);
      logClientAuthEvent("integration_bootstrap_started", { businessId });

      try {
        const manifestResponse = await fetch(
          `/api/integrations?businessId=${encodeURIComponent(businessId)}`,
          {
            cache: "no-store",
            headers: { "Cache-Control": "no-store" },
          }
        );
        const manifestPayload = (await manifestResponse.json().catch(() => null)) as
          | { integrations?: ManifestRow[] }
          | null;
        const manifestRows = Array.isArray(manifestPayload?.integrations)
          ? manifestPayload.integrations.map(enrichManifestRow)
          : [];

        setManifestConnections(
          businessId,
          manifestRows.map((row) => ({
            provider: row.provider,
            status: row.status,
            id: row.id,
            connected_at: row.connected_at,
            updated_at: row.updated_at,
            provider_account_id: row.provider_account_id,
            provider_account_name: row.provider_account_name,
            error_message: row.error_message,
            token_expires_at: row.token_expires_at,
            refresh_token: row.refresh_token,
            has_refresh_token: row.has_refresh_token,
            // The two facts the effective-capability predicate needs, and the
            // two the store used to drop: whether Google's grant carries the
            // Search Console scope, and which property/site was selected.
            scopes: row.scopes,
            metadata: row.metadata,
          }))
        );
        logClientAuthEvent("integration_manifest_loaded", {
          businessId,
          rowCount: manifestRows.length,
        });

        const snapshotRows = allowedProviders
          ? manifestRows.filter((row) => allowedProviders.has(row.provider))
          : manifestRows;

        await Promise.all(
          snapshotRows.map(async (row) => {
            const provider = row.provider;
            if (!supportsProviderAssignments(provider)) return;
            if (row.status !== "connected") {
              setProviderDiscovery(businessId, provider, {
                status: "idle",
                entities: [],
                source: null,
                fetchedAt: null,
                notice: null,
                stale: false,
                refreshFailed: false,
              });
              setProviderAssignmentState(businessId, provider, {
                status: "idle",
                selectedIds: [],
              });
              return;
            }

            logClientAuthEvent("provider_discovery_started", {
              businessId,
              provider,
            });

            try {
              const snapshot = await fetchProviderAccountSnapshot(provider, businessId);
              setProviderDiscovery(businessId, provider, {
                status: snapshot.meta?.stale ? "stale" : "ready",
                entities: snapshot.accounts,
                source: snapshot.meta?.source ?? null,
                fetchedAt: snapshot.meta?.fetchedAt ?? null,
                notice: snapshot.notice,
                stale: snapshot.meta?.stale ?? false,
                refreshFailed: snapshot.meta?.refreshFailed ?? false,
              });
              setProviderAssignmentState(businessId, provider, {
                status:
                  snapshot.assignedAccountIds.length > 0 ? "ready" : "empty",
                selectedIds: snapshot.assignedAccountIds,
                updatedAt: snapshot.meta?.fetchedAt ?? null,
              });
              logClientAuthEvent(
                snapshot.meta?.stale || snapshot.meta?.refreshFailed
                  ? "provider_discovery_degraded"
                  : "provider_discovery_ready",
                {
                  businessId,
                  provider,
                  entityCount: snapshot.accounts.length,
                  assignedCount: snapshot.assignedAccountIds.length,
                  source: snapshot.meta?.source ?? null,
                  stale: snapshot.meta?.stale ?? false,
                }
              );
              logClientAuthEvent("provider_assignment_loaded", {
                businessId,
                provider,
                assignedCount: snapshot.assignedAccountIds.length,
              });
            } catch (error) {
              setProviderDiscovery(businessId, provider, {
                status: "failed",
                entities: [],
                errorMessage:
                  error instanceof Error ? error.message : "Discovery failed.",
                notice: null,
                stale: false,
                refreshFailed: true,
              });
              setProviderAssignmentState(businessId, provider, {
                status: "failed",
                selectedIds: [],
                errorMessage:
                  error instanceof Error ? error.message : "Assignment load failed.",
              });
              logClientAuthEvent("provider_discovery_degraded", {
                businessId,
                provider,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })
        );
      } finally {
        finishBusinessBootstrap(businessId);
        locks.delete(lockKey);
      }
    })();

    locks.set(lockKey, bootstrapPromise);
  }, [
    businessId,
    ensureBusinessDomains,
    finishBusinessBootstrap,
    providerFilterKey,
    setManifestConnections,
    setProviderAssignmentState,
    setProviderDiscovery,
    startBusinessBootstrap,
  ]);

  return {
    isBootstrapping: bootstrapStatus === "loading",
    bootstrapStatus,
  };
}
