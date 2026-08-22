"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { IntegrationProvider, useIntegrationsStore } from "@/store/integrations-store";
import { DataEmptyState } from "@/components/states/DataEmptyState";
import {
  fetchProviderAccountSnapshot,
  type ProviderAccountSnapshot,
  warmProviderAccountSnapshot,
} from "@/lib/provider-account-client";
import {
  getProviderAssignmentTitle,
  getProviderFetchPath,
  type ProviderAccountRow,
  saveProviderAssignments,
} from "@/components/integrations/provider-assignment-drawer-support";
import { Loader2, RefreshCw } from "lucide-react";

interface ProviderAssignmentDrawerProps {
  open: boolean;
  provider: IntegrationProvider | null;
  businessId: string;
  assignedAccountIds: string[];
  onClose: () => void;
  onSave: (
    provider: IntegrationProvider,
    accountIds: string[],
    accounts: ProviderAccountRow[],
  ) => void;
  /**
   * Disconnecting lives here rather than on the card face.
   *
   * The design gives each integration card exactly one button, so the card can
   * no longer carry Reconnect/Disconnect/Retry. Manage is the destination those
   * belong behind, and this drawer is it.
   */
  onDisconnect?: (provider: IntegrationProvider) => void;
}

/**
 * `degraded` is separate from `empty` on purpose (D8, §9 state 5 vs 6).
 *
 * An empty list used to render one screen — "No ad accounts found … or the
 * required permissions are missing" — for two facts that call for opposite
 * responses. A read that succeeded and found nothing means the login owns no ad
 * accounts, and the operator should go look at their Business Manager. A read
 * that FAILED (expired token, permission denied, provider 5xx, refresh refused)
 * means we do not know what they own, and the operator should reconnect or
 * retry. Offering "or the required permissions are missing" as a hedge on both
 * made the honest case unreadable and the broken case look like a data fact.
 */
type FetchState =
  | "idle"
  | "loading"
  | "success"
  /** Proven: the read succeeded and there genuinely are no accounts. */
  | "empty"
  /** The read did not succeed, so the empty list is not evidence of anything. */
  | "degraded"
  | "error";

function formatRetryAfter(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function ProviderAssignmentDrawer({
  open,
  provider,
  businessId,
  assignedAccountIds,
  onClose,
  onSave,
  onDisconnect,
}: ProviderAssignmentDrawerProps) {
  const [draftIds, setDraftIds] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<ProviderAccountRow[]>([]);
  const [fetchState, setFetchState] = useState<FetchState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  /**
   * A partial success, which is not an error and must not be painted as one.
   *
   * The 202 case — selection committed, first sync not scheduled — is real
   * progress the operator should keep, so it is held separately from
   * `saveErrorMessage` and rendered in a warning tone. Reusing the destructive
   * slot would tell them the save failed when it did not, and the obvious
   * response to that is to try the save again.
   */
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const isMeta = provider === "meta";
  const isGoogle = provider === "google";
  const isSupportedProvider = isMeta || isGoogle;
  const initializedForOpenRef = useRef<string | null>(null);
  const latestAssignedAccountIdsRef = useRef<string[]>(assignedAccountIds);
  const domain = useIntegrationsStore((state) =>
    provider && businessId ? state.domainsByBusinessId[businessId]?.[provider] : undefined
  );
  const setProviderDiscovery = useIntegrationsStore((state) => state.setProviderDiscovery);
  const setProviderAssignmentState = useIntegrationsStore(
    (state) => state.setProviderAssignmentState
  );

  const hydratedAccounts = useMemo(
    () =>
      (domain?.discovery.entities ?? []).map((account) => ({
        ...account,
        assigned: (domain?.assignment.selectedIds ?? []).includes(account.id),
      })),
    [domain]
  );
  const quotaRetryAfterAt =
    provider === "google" && domain?.discovery.failureClass === "quota"
      ? domain.discovery.retryAfterAt ?? null
      : null;
  const quotaCooldownActive =
    Boolean(quotaRetryAfterAt) &&
    new Date(quotaRetryAfterAt as string).getTime() > Date.now();
  const quotaRetryLabel = formatRetryAfter(quotaRetryAfterAt);
  const shouldBlockDrawer = provider === "shopify";
  const discoveryTrustLabel =
    domain?.discovery.trustLevel === "risky"
      ? "Cached list is available, but freshness is risky."
      : domain?.discovery.trustLevel === "safe" && domain?.discovery.sourceHealth !== "fresh"
        ? "Cached list is available and safe to use."
        : null;

  useEffect(() => {
    if (open && shouldBlockDrawer) {
      onClose();
    }
  }, [onClose, open, shouldBlockDrawer]);

  useEffect(() => {
    latestAssignedAccountIdsRef.current = assignedAccountIds;
  }, [assignedAccountIds]);

  const applySnapshotResult = useCallback(
    (snapshot: ProviderAccountSnapshot) => {
      if (!provider) return;
      const list = snapshot.accounts.map((account) => ({
        ...account,
        assigned: snapshot.assignedAccountIds.includes(account.id),
      }));

      console.log("[assignment-modal] ✓ VALID DATA RECEIVED", {
        accountCount: list.length,
        assignedAccounts: list.filter((a) => a.assigned).length,
      });

      setAccounts(list);
      setNoticeMessage(snapshot.notice);
      const hasAssignedFlag = list.some((account) => typeof account.assigned === "boolean");
      const serverAssignedIds = hasAssignedFlag
        ? list.filter((account) => account.assigned === true).map((account) => account.id)
        : latestAssignedAccountIdsRef.current;
      setDraftIds((prev) =>
        initializedForOpenRef.current === `${businessId}:${provider}`
          ? prev
          : serverAssignedIds
      );
      initializedForOpenRef.current = `${businessId}:${provider}`;
      /**
       * An empty list is only "empty" when the read that produced it worked.
       *
       * `refreshFailed`, a non-null `failureClass` and a `degraded_blocking`
       * source health each mean the provider did not answer, so the zero here
       * is the absence of an answer rather than an answer of zero.
       */
      const readDegraded =
        snapshot.meta?.refreshFailed === true ||
        // `failureClass` is `null` on a healthy read; every non-null value —
        // quota, auth, scope, permission, unknown — is a reason the answer is
        // missing rather than zero.
        snapshot.meta?.failureClass != null ||
        snapshot.meta?.sourceHealth === "degraded_blocking";
      setFetchState(
        list.length > 0 ? "success" : readDegraded ? "degraded" : "empty",
      );
      setProviderDiscovery(businessId, provider, {
        status: snapshot.meta?.stale ? "stale" : "ready",
        entities: snapshot.accounts,
        source: snapshot.meta?.source ?? null,
        sourceHealth: snapshot.meta?.sourceHealth ?? null,
        trustLevel: snapshot.meta?.trustLevel ?? null,
        trustScore: snapshot.meta?.trustScore ?? null,
        fetchedAt: snapshot.meta?.fetchedAt ?? null,
        notice: snapshot.notice,
        stale: snapshot.meta?.stale ?? false,
        refreshFailed: snapshot.meta?.refreshFailed ?? false,
        failureClass: snapshot.meta?.failureClass ?? null,
        retryAfterAt: snapshot.meta?.retryAfterAt ?? null,
      });
      setProviderAssignmentState(businessId, provider, {
        status: serverAssignedIds.length > 0 ? "ready" : "empty",
        selectedIds: serverAssignedIds,
        updatedAt: snapshot.meta?.fetchedAt ?? null,
      });
    },
    [businessId, provider, setProviderAssignmentState, setProviderDiscovery]
  );

  const loadAccounts = useCallback(
    async (options?: { preserveExisting?: boolean; forceRefresh?: boolean }) => {
      if (!open || !provider) return;
      if (!isSupportedProvider) {
        setAccounts([]);
        setFetchState("empty");
        setErrorMessage(null);
        setNoticeMessage(null);
        return;
      }

      if (!getProviderFetchPath(provider, businessId)) {
        setAccounts([]);
        setFetchState("empty");
        setErrorMessage(null);
        setNoticeMessage(null);
        return;
      }

      const preserveExisting = options?.preserveExisting === true;

      if (!preserveExisting && hydratedAccounts.length > 0) {
        setAccounts(hydratedAccounts);
        setNoticeMessage(domain?.discovery.notice ?? null);
        setDraftIds(domain?.assignment.selectedIds ?? latestAssignedAccountIdsRef.current);
        initializedForOpenRef.current = `${businessId}:${provider}`;
        setFetchState(hydratedAccounts.length > 0 ? "success" : "empty");
        return;
      }
      if (!preserveExisting) {
        setAccounts([]);
        setFetchState("loading");
      } else {
        setIsRefreshing(true);
      }
      setErrorMessage(null);
      setNoticeMessage(null);
      setSaveErrorMessage(null);

      console.log("[assignment-modal] 🔹 FETCH STARTED", {
        provider,
        businessId,
        mode: options?.preserveExisting ? "refresh" : "initial",
      });

      if (options?.forceRefresh && quotaCooldownActive) {
        setNoticeMessage(
          quotaRetryLabel
            ? `Google Ads account refresh is temporarily rate-limited. Using cached accounts until ${quotaRetryLabel}.`
            : "Google Ads account refresh is temporarily rate-limited. Using cached accounts for now."
        );
        setIsRefreshing(false);
        return;
      }

      try {
        const snapshot = options?.forceRefresh
          ? await warmProviderAccountSnapshot(provider, businessId)
          : await fetchProviderAccountSnapshot(provider, businessId);
        applySnapshotResult(snapshot);
      } catch (err) {
        console.error("[assignment-modal] ❌ FETCH EXCEPTION", {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        setErrorMessage(
          `We couldn't fetch accessible ${provider === "google" ? "Google Ads" : "Meta"} ad accounts for this connection.`,
        );
        setFetchState("error");
        setProviderDiscovery(businessId, provider, {
          status: "failed",
          entities: [],
          sourceHealth: domain?.discovery.sourceHealth ?? null,
          trustLevel: domain?.discovery.trustLevel ?? null,
          trustScore: domain?.discovery.trustScore ?? null,
          errorMessage: err instanceof Error ? err.message : String(err),
          notice: null,
          refreshFailed: true,
          failureClass: domain?.discovery.failureClass ?? null,
          retryAfterAt: domain?.discovery.retryAfterAt ?? null,
        });
        setProviderAssignmentState(businessId, provider, {
          status: "failed",
          selectedIds: latestAssignedAccountIdsRef.current,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setIsRefreshing(false);
      }
    },
    [
      applySnapshotResult,
      businessId,
      domain,
      hydratedAccounts,
      isSupportedProvider,
      open,
      provider,
      setProviderAssignmentState,
      setProviderDiscovery,
    ],
  );

  useEffect(() => {
    if (!open || !provider) return;
    void loadAccounts();
  }, [businessId, open, provider, loadAccounts]);

  useEffect(() => {
    if (!open) {
      setAccounts([]);
      setFetchState("idle");
      setErrorMessage(null);
      setSaveErrorMessage(null);
      setDraftIds([]);
      setIsSaving(false);
      setIsRefreshing(false);
      setNoticeMessage(null);
      setSearchQuery("");
      initializedForOpenRef.current = null;
    }
  }, [open]);

  const normalizedAccounts = useMemo(
    () =>
      accounts.map((account) => ({
        id: account.id,
        name: account.name,
        currency: account.currency,
        timezone: account.timezone,
        externalId: account.id,
      })),
    [accounts],
  );

  const filteredAccounts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return normalizedAccounts;
    return normalizedAccounts.filter((account) => {
      const byName = account.name.toLowerCase().includes(query);
      const byId = account.externalId.toLowerCase().includes(query);
      return byName || byId;
    });
  }, [normalizedAccounts, searchQuery]);

  if (shouldBlockDrawer) {
    return null;
  }

  function toggleAccount(accountId: string) {
    setDraftIds((prev) =>
      prev.includes(accountId)
        ? prev.filter((item) => item !== accountId)
        : [...prev, accountId],
    );
  }

  async function handleSave() {
    if (!provider || !isSupportedProvider) return;

    setIsSaving(true);
    setSaveErrorMessage(null);
    setSaveNotice(null);
    const result = await saveProviderAssignments({
      provider,
      businessId,
      draftIds,
    });
    if (result.error) {
      setSaveErrorMessage(result.error);
      setIsSaving(false);
      return;
    }

    /**
     * A demo workspace persisted nothing, so the drawer stays open and says so.
     *
     * Closing here would confirm a selection that does not exist: every Meta
     * surface would then resolve no account and refuse, immediately after the
     * product told the operator the assignment succeeded.
     */
    if (result.demo || !result.selectionSaved) {
      setSaveErrorMessage(
        result.notice ?? "Account assignments were not saved.",
      );
      setIsSaving(false);
      return;
    }

    // Saved. `assignedIds` is the server's list, not the local draft, so a
    // canonicalised or narrowed selection is reflected rather than overwritten
    // with what was asked for.
    onSave(provider, result.assignedIds, accounts);

    if (!result.syncScheduled) {
      /**
       * The 202: committed, but no work enqueued.
       *
       * `response.ok` is true for a 202, so this used to close the drawer on a
       * plain success and the operator waited for data nothing was fetching.
       * The selection IS saved, so it is handed upward first and only then
       * reported — the notice is about scheduling, not about the save.
       */
      setSaveNotice(
        result.notice ??
          "Your account selection was saved, but the first sync could not be scheduled yet.",
      );
      setIsSaving(false);
      return;
    }

    onClose();
    setIsSaving(false);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => (!nextOpen ? onClose() : undefined)}
    >
      <SheetContent
        side="right"
        className="flex h-full w-full flex-col p-0 sm:max-w-xl"
      >
        <div className="shrink-0 border-b px-6 py-6">
          <SheetHeader className="space-y-2">
            <SheetTitle>{getProviderAssignmentTitle(provider)}</SheetTitle>
            <SheetDescription>
              Select the accounts Adsecute should use when syncing data for this
              business.
            </SheetDescription>
          </SheetHeader>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
          {noticeMessage ? (
            <div
              className={`mb-3 rounded-md border px-3 py-2 text-sm ${
                domain?.discovery.sourceHealth === "healthy_cached"
                  ? "border-[var(--adc-info-bd)] bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)]"
                  : "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <span className="block">{noticeMessage}</span>
                  {discoveryTrustLabel ? (
                    <span className="block text-xs opacity-80">{discoveryTrustLabel}</span>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0"
                  onClick={() =>
                    void loadAccounts({
                      preserveExisting: accounts.length > 0,
                      forceRefresh: true,
                    })
                  }
                  disabled={isRefreshing || quotaCooldownActive}
                  title={
                    quotaCooldownActive && quotaRetryLabel
                      ? `Retry available after ${quotaRetryLabel}`
                      : undefined
                  }
                >
                  {isRefreshing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {quotaCooldownActive ? "Cooling down" : "Retry"}
                </Button>
              </div>
            </div>
          ) : null}

          {fetchState === "success" ? (
            <div className="shrink-0 pb-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search ad accounts..."
                  aria-label="Search ad accounts by name"
                  className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void loadAccounts({ preserveExisting: true, forceRefresh: true })
                  }
                  disabled={isRefreshing || quotaCooldownActive}
                  title={
                    quotaCooldownActive && quotaRetryLabel
                      ? `Refresh available after ${quotaRetryLabel}`
                      : undefined
                  }
                >
                  {isRefreshing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {quotaCooldownActive ? "Cooling down" : "Refresh"}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-3">
            {fetchState === "loading" ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>
                  {provider === "google"
                    ? "Loading Google Ads accounts..."
                    : "Loading ad accounts..."}
                </span>
              </div>
            ) : null}

            {fetchState === "error" ? (
              <DataEmptyState
                title="Could not load ad accounts"
                description={
                  errorMessage ??
                  `Unable to retrieve ${provider === "google" ? "Google Ads" : "Meta"} accounts. Retry.`
                }
              />
            ) : null}

            {fetchState === "error" ? (
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  onClick={() => void loadAccounts({ forceRefresh: true })}
                  disabled={quotaCooldownActive}
                >
                  <RefreshCw className="h-4 w-4" />
                  {quotaCooldownActive ? "Cooling down" : "Retry"}
                </Button>
              </div>
            ) : null}

            {fetchState === "empty" ? (
              <DataEmptyState
                title="No ad accounts found"
                description={`This ${provider === "google" ? "Google Ads" : "Meta"} login was read successfully and owns no ad accounts. Add one in ${provider === "google" ? "Google Ads" : "Meta Business Manager"}, or reconnect with a login that has access.`}
              />
            ) : null}

            {fetchState === "degraded" ? (
              <DataEmptyState
                title="Account list unavailable"
                description={
                  noticeMessage ??
                  `We could not read the ${provider === "google" ? "Google Ads" : "Meta"} account list for this connection, so this is not a list of zero accounts — it is a missing answer. Retry, or reconnect if the connection has expired.`
                }
              />
            ) : null}

            {fetchState === "degraded" ? (
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  onClick={() => void loadAccounts({ forceRefresh: true })}
                  disabled={isRefreshing || quotaCooldownActive}
                >
                  {isRefreshing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Retry
                </Button>
              </div>
            ) : null}

              {fetchState === "success"
                ? filteredAccounts.map((account) => {
                  const checked = draftIds.includes(account.id);
                  return (
                    <label
                      key={account.id}
                      className="flex items-start justify-between gap-4 rounded-lg border border-neutral-200 bg-white px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {account.name}
                        </p>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {account.externalId}
                          {account.currency ? ` • ${account.currency}` : ""}
                          {account.timezone ? ` • ${account.timezone}` : ""}
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAccount(account.id)}
                        className="mt-0.5"
                      />
                    </label>
                  );
                })
              : null}

              {fetchState === "success" && filteredAccounts.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  <p>No ad accounts found</p>
                  <p className="mt-1 text-xs">Try a different account name</p>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t px-6 py-6">
          {saveErrorMessage ? (
            <p
              className="mb-3 text-sm text-destructive"
              role="alert"
              data-field="assignment-save-error"
            >
              {saveErrorMessage}
            </p>
          ) : null}
          {saveNotice ? (
            <p
              className="mb-3 text-sm text-[var(--warn,#B45309)]"
              role="status"
              data-field="assignment-save-notice"
            >
              {saveNotice}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            {onDisconnect && provider ? (
              <Button
                variant="ghost"
                className="px-2.5 text-muted-foreground hover:text-destructive"
                disabled={isSaving}
                onClick={() => onDisconnect(provider)}
              >
                Disconnect
              </Button>
            ) : null}
            <span className="flex-1" />
            <Button variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={
                isSaving ||
                fetchState !== "success" ||
                !provider ||
                !isSupportedProvider
              }
            >
              {isSaving ? "Saving..." : "Save assignments"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
