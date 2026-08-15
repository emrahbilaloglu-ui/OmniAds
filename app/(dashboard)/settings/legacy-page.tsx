"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { usePreferencesStore } from "@/store/preferences-store";
import { clearAuthScopedClientState } from "@/lib/client-auth-state";
import { isDemoBusinessId } from "@/lib/demo-business";
import { type PlanId } from "@/lib/pricing/plans";
import { ConfirmOverlay } from "@/components/settings/settings-section";
import { StateBanner } from "@/components/ui/product-surface";
import { WorkspaceSurface } from "@/components/workspace/workspace-surface";
import {
  fetchProviderAccountSnapshot,
  warmProviderAccountSnapshot,
} from "@/lib/provider-account-client";
import {
  CURRENCY_OPTIONS,
  fetchSettingsAccount,
  fetchWorkspaceRoleByBusiness,
  type WorkspaceRole,
} from "@/app/(dashboard)/settings/settings-support";

/* ---------------------------------------------------------------------------
 * Design primitives — the v2 Settings screen is three repeats of one article
 * shell plus a navy plan band and a stack of action rows. Values are the
 * design's own: r14 cards, 1fr 1fr grids at gap 14, h36 controls at r9.
 * ------------------------------------------------------------------------- */

function FieldCard({ children }: { children: ReactNode }) {
  return (
    <article className="grid grid-cols-1 gap-[14px] rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-4 sm:grid-cols-2">
      {children}
    </article>
  );
}

function Field({
  label,
  children,
  span,
}: {
  label: string;
  children: ReactNode;
  span?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-[5px] ${span ? "sm:col-span-2" : ""}`}>
      <span className="text-[12px] font-semibold text-[var(--adv-ink-2)]">{label}</span>
      {children}
    </label>
  );
}

const CONTROL =
  "h-9 w-full rounded-[9px] border border-[var(--adv-border)] bg-[var(--adv-surface)] px-[11px] text-[13px] text-[var(--adv-ink)] outline-none focus:border-[var(--adv-accent-bd)] disabled:bg-[var(--adv-fill)] disabled:text-[var(--adv-ink-3)]";

/** The design's row button: h31, r8, white ground, tone carried by border + text. */
function RowButton({
  children,
  onClick,
  tone = "neutral",
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: "neutral" | "caution" | "danger";
  disabled?: boolean;
}) {
  const palette =
    tone === "danger"
      ? "border-[var(--adc-danger-bd)] text-[var(--adc-danger-fg)]"
      : tone === "caution"
        ? "border-[#EBD6A4] text-[#B45309]"
        : "border-[var(--adv-border)] text-[var(--adv-ink-2)]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-[31px] shrink-0 rounded-[8px] border bg-[var(--adv-surface)] px-[13px] text-[12px] font-semibold transition-colors hover:bg-[var(--adv-fill)] disabled:opacity-50 ${palette}`}
    >
      {children}
    </button>
  );
}

/** The design's settingsRows shape: title + detail on the left, one action right. */
function ActionRow({
  title,
  detail,
  children,
  footer,
}: {
  title: string;
  detail: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <article className="rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] px-4 py-[14px]">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[13.5px] font-semibold text-[var(--adv-ink)]">{title}</p>
          <p className="m-0 mt-[3px] text-[12px] text-[var(--adv-ink-3)]">{detail}</p>
        </div>
        {children}
      </div>
      {footer}
    </article>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceOwnerId = useAppStore((state) => state.workspaceOwnerId);
  const setWorkspaceSnapshot = useAppStore((state) => state.setWorkspaceSnapshot);
  const deleteBusiness = useAppStore((state) => state.deleteBusiness);
  const selectBusiness = useAppStore((state) => state.selectBusiness);

  const byBusinessId = useIntegrationsStore((state) => state.byBusinessId);
  const removeBusinessData = useIntegrationsStore((state) => state.removeBusinessData);
  const clearAllState = useIntegrationsStore((state) => state.clearAllState);
  const clearProviderAccountsForBusiness = useIntegrationsStore(
    (state) => state.clearProviderAccountsForBusiness,
  );

  const defaultDateRange = usePreferencesStore((state) => state.defaultDateRange);
  const metricDisplay = usePreferencesStore((state) => state.metricDisplay);
  const tableDensity = usePreferencesStore((state) => state.tableDensity);
  const heatmapEnabled = usePreferencesStore((state) => state.heatmapEnabled);
  const language = usePreferencesStore((state) => state.language);
  const setDefaultDateRange = usePreferencesStore((state) => state.setDefaultDateRange);
  const setMetricDisplay = usePreferencesStore((state) => state.setMetricDisplay);
  const setTableDensity = usePreferencesStore((state) => state.setTableDensity);
  const setHeatmapEnabled = usePreferencesStore((state) => state.setHeatmapEnabled);
  const setLanguage = usePreferencesStore((state) => state.setLanguage);

  const activeBusiness =
    businesses.find((business) => business.id === selectedBusinessId) ?? null;
  const integrations = selectedBusinessId ? byBusinessId[selectedBusinessId] : undefined;
  const connectedIntegrations = Object.values(integrations ?? {}).filter(
    (integration) => integration.status === "connected",
  );

  const [accountName, setAccountName] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [workspaceRole, setWorkspaceRole] = useState<WorkspaceRole>("guest");

  const [workspaceName, setWorkspaceName] = useState(activeBusiness?.name ?? "");
  const [workspaceCurrency, setWorkspaceCurrency] = useState(activeBusiness?.currency ?? "USD");

  const [billing, setBilling] = useState<{
    connected: boolean;
    planId: PlanId;
    planName: string;
    monthlyPrice: number;
    status: string;
    storeName: string | null;
    managedPricingUrl?: string | null;
    source?: string | null;
  } | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);

  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [savingAccount, setSavingAccount] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [runningDangerAction, setRunningDangerAction] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmModal, setConfirmModal] = useState<
    null | "disconnectAll" | "deleteWorkspace" | "revokeSessions"
  >(null);
  const [snapshotNote, setSnapshotNote] = useState<string>("Checking provider snapshots…");

  useEffect(() => {
    setWorkspaceName(activeBusiness?.name ?? "");
    setWorkspaceCurrency(activeBusiness?.currency ?? "USD");
  }, [activeBusiness]);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timeout);
  }, [toast]);

  const loadAccount = useCallback(async () => {
    try {
      const user = await fetchSettingsAccount();
      setAccountError(null);
      setAccountName(user.name ?? "");
      setAccountEmail(user.email ?? "");
    } catch (error: unknown) {
      setAccountError(error instanceof Error ? error.message : "Could not load account settings.");
    }
  }, []);

  const loadWorkspaceRole = useCallback(async () => {
    const currentRole = await fetchWorkspaceRoleByBusiness(selectedBusinessId);
    setWorkspaceRole(currentRole);
  }, [selectedBusinessId]);

  const loadBilling = useCallback(async () => {
    if (!selectedBusinessId) return;
    setBillingLoading(true);
    try {
      const response = await fetch(
        `/api/billing?businessId=${encodeURIComponent(selectedBusinessId)}`,
      );
      const data = (await response.json().catch(() => null)) as typeof billing | null;
      if (response.ok && data) setBilling(data);
    } catch {
      // non-fatal — the plan band falls back to its unconnected copy
    } finally {
      setBillingLoading(false);
    }
  }, [selectedBusinessId]);

  /** One sentence describing real snapshot state — the row's detail line. */
  const loadSnapshotNote = useCallback(async () => {
    if (!selectedBusinessId) return;
    if (isDemoBusinessId(selectedBusinessId)) {
      setSnapshotNote("Demo workspace · provider data is fixture-backed.");
      return;
    }
    const parts: string[] = [];
    for (const provider of ["meta", "google"] as const) {
      try {
        const snapshot = await fetchProviderAccountSnapshot(provider, selectedBusinessId);
        parts.push(
          `${provider}: ${
            snapshot.meta?.refreshFailed
              ? "attention needed"
              : snapshot.meta?.stale
                ? "stale"
                : "healthy"
          }`,
        );
      } catch {
        parts.push(`${provider}: unavailable`);
      }
    }
    setSnapshotNote(`Rebuild read models from provider data. ${parts.join(" · ")}.`);
  }, [selectedBusinessId]);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  useEffect(() => {
    if (!selectedBusinessId) return;
    void loadWorkspaceRole();
    void loadSnapshotNote();
    void loadBilling();
  }, [loadBilling, loadSnapshotNote, loadWorkspaceRole, selectedBusinessId]);

  const isWorkspaceAdmin = workspaceRole === "admin";
  const workspaceTimezoneLabel = activeBusiness?.timezone ?? "Not derived yet";
  const workspaceTimezoneSourceLabel =
    activeBusiness?.timezoneSource === "shopify"
      ? "Shopify"
      : activeBusiness?.timezoneSource === "ga4"
        ? "GA4"
        : "unset";

  async function handleWorkspaceSave() {
    if (!selectedBusinessId || !activeBusiness || !workspaceOwnerId) return;
    setSavingWorkspace(true);
    setWorkspaceError(null);
    try {
      const response = await fetch(
        `/api/businesses/${encodeURIComponent(selectedBusinessId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: workspaceName, currency: workspaceCurrency }),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | {
            business?: {
              id: string;
              name: string;
              timezone: string | null;
              timezoneSource?: "shopify" | "ga4" | null;
              currency: string;
            };
            message?: string;
          }
        | null;
      if (!response.ok || !payload?.business) {
        throw new Error(payload?.message ?? "Could not update workspace settings.");
      }
      const nextBusinesses = businesses.map((business) =>
        business.id === payload.business!.id
          ? {
              ...business,
              name: payload.business!.name,
              timezone: payload.business!.timezone,
              timezoneSource: payload.business!.timezoneSource ?? null,
              currency: payload.business!.currency,
            }
          : business,
      );
      setWorkspaceSnapshot(workspaceOwnerId, nextBusinesses, selectedBusinessId);
      setToast({ type: "success", message: "Workspace settings updated." });
    } catch (error: unknown) {
      setWorkspaceError(
        error instanceof Error ? error.message : "Could not update workspace settings.",
      );
    } finally {
      setSavingWorkspace(false);
    }
  }

  async function handleAccountSave() {
    setSavingAccount(true);
    setAccountError(null);
    try {
      const response = await fetch("/api/settings/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: accountName }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { user?: { name?: string }; message?: string }
        | null;
      if (!response.ok || !payload?.user) {
        throw new Error(payload?.message ?? "Could not update account settings.");
      }
      setAccountName(payload.user.name ?? accountName);
      setToast({ type: "success", message: "Account settings updated." });
      router.refresh();
    } catch (error: unknown) {
      setAccountError(
        error instanceof Error ? error.message : "Could not update account settings.",
      );
    } finally {
      setSavingAccount(false);
    }
  }

  async function handlePasswordUpdate() {
    setSavingPassword(true);
    setPasswordError(null);
    try {
      const response = await fetch("/api/settings/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, nextPassword }),
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(payload?.message ?? "Could not update password.");
      setCurrentPassword("");
      setNextPassword("");
      setPasswordOpen(false);
      setToast({ type: "success", message: "Password updated." });
    } catch (error: unknown) {
      setPasswordError(error instanceof Error ? error.message : "Could not update password.");
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleResyncIntegrations() {
    if (!selectedBusinessId) return;
    if (isDemoBusinessId(selectedBusinessId)) {
      await loadSnapshotNote();
      setToast({ type: "success", message: "Demo workspace already uses fixture-backed data." });
      return;
    }
    try {
      await fetch(`/api/integrations?businessId=${encodeURIComponent(selectedBusinessId)}`, {
        cache: "no-store",
      });
      await loadSnapshotNote();
      setToast({ type: "success", message: "Integration sync check completed." });
    } catch {
      setToast({ type: "error", message: "Could not re-sync integrations." });
    }
  }

  async function handleForceRefreshSnapshots() {
    if (!selectedBusinessId) return;
    if (isDemoBusinessId(selectedBusinessId)) {
      await loadSnapshotNote();
      setToast({ type: "success", message: "Demo snapshots are fixture-backed." });
      return;
    }
    try {
      await Promise.all(
        connectedIntegrations
          .filter((i) => i.provider === "meta" || i.provider === "google")
          .map((i) =>
            warmProviderAccountSnapshot(i.provider as "meta" | "google", selectedBusinessId),
          ),
      );
      await loadSnapshotNote();
      setToast({ type: "success", message: "Provider snapshots refreshed." });
    } catch {
      setToast({ type: "error", message: "Could not refresh provider snapshots." });
    }
  }

  function handleClearCachedProviderAccounts() {
    if (!selectedBusinessId) return;
    clearProviderAccountsForBusiness(selectedBusinessId);
    setToast({ type: "success", message: "Cached provider account data cleared." });
  }

  async function handleDangerConfirm() {
    if (!selectedBusinessId || !confirmModal) return;
    setRunningDangerAction(true);
    try {
      if (confirmModal === "disconnectAll") {
        await Promise.all(
          connectedIntegrations.map((integration) =>
            fetch(
              `/api/integrations?businessId=${encodeURIComponent(selectedBusinessId)}&provider=${integration.provider}`,
              { method: "DELETE" },
            ).catch(() => null),
          ),
        );
        clearAllState();
        setToast({ type: "success", message: "All integrations disconnected." });
        router.refresh();
      } else if (confirmModal === "deleteWorkspace") {
        const response = await fetch(
          `/api/businesses/${encodeURIComponent(selectedBusinessId)}`,
          { method: "DELETE" },
        );
        if (!response.ok) throw new Error("Could not delete workspace.");
        const nextSelected = deleteBusiness(selectedBusinessId);
        removeBusinessData(selectedBusinessId);
        if (nextSelected) {
          selectBusiness(nextSelected);
          await fetch("/api/auth/switch-business", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ businessId: nextSelected }),
          }).catch(() => null);
          router.push("/select-business");
        } else {
          router.push("/businesses/new");
        }
      } else if (confirmModal === "revokeSessions") {
        const response = await fetch("/api/settings/security/revoke-sessions", { method: "POST" });
        if (!response.ok) throw new Error("Could not revoke sessions.");
        clearAuthScopedClientState();
        window.location.assign("/login");
        return;
      }
    } catch (error: unknown) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Action failed.",
      });
    } finally {
      setRunningDangerAction(false);
      setConfirmModal(null);
    }
  }

  function handleOpenShopifyBilling() {
    if (!billing?.managedPricingUrl) {
      setToast({
        type: "error",
        message: "Shopify billing URL is not available for this store yet.",
      });
      return;
    }
    window.location.href = billing.managedPricingUrl;
  }

  if (!selectedBusinessId || !activeBusiness) {
    return (
      <WorkspaceSurface eyebrow="Workspace · Preferences" title="Settings" width="narrow">
        <StateBanner tone="warning" title="No workspace selected" />
      </WorkspaceSurface>
    );
  }

  return (
    <WorkspaceSurface eyebrow="Workspace · Preferences" title="Settings" width="narrow">
      {toast ? (
        <StateBanner
          tone={toast.type === "success" ? "success" : "danger"}
          title={toast.type === "success" ? "Settings updated" : "Settings action failed"}
        >
          {toast.message}
        </StateBanner>
      ) : null}

      <div className="flex flex-col gap-3">
        {/* Identity and locale — the design's first article. */}
        <FieldCard>
          <Field label="Full name">
            <input
              className={CONTROL}
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
            />
          </Field>
          <Field label="Email">
            <input className={CONTROL} value={accountEmail} readOnly disabled />
          </Field>
          <Field label="Interface language">
            <select
              className={CONTROL}
              value={language}
              onChange={(event) => setLanguage(event.target.value as "en" | "tr")}
            >
              <option value="en">English</option>
              <option value="tr">Türkçe</option>
            </select>
          </Field>
          <Field label="Workspace timezone">
            {/* Derived from Shopify first, then GA4 — never operator-chosen, so the
                control shows the derived value and stays disabled. */}
            <select className={CONTROL} value={workspaceTimezoneLabel} disabled>
              <option value={workspaceTimezoneLabel}>
                {workspaceTimezoneLabel} · from {workspaceTimezoneSourceLabel}
              </option>
            </select>
          </Field>
          {accountError ? (
            <p className="m-0 text-[12px] text-[var(--adc-danger-fg)] sm:col-span-2">
              {accountError}
            </p>
          ) : null}
          <div className="flex justify-end sm:col-span-2">
            <RowButton onClick={() => void handleAccountSave()} disabled={savingAccount}>
              {savingAccount ? "Saving…" : "Save profile"}
            </RowButton>
          </div>
        </FieldCard>

        {/* Workspace identity — same article shell, workspace-scoped fields. */}
        <FieldCard>
          <Field label="Workspace name">
            <input
              className={CONTROL}
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              disabled={!isWorkspaceAdmin}
            />
          </Field>
          <Field label="Reporting currency">
            <select
              className={CONTROL}
              value={workspaceCurrency}
              onChange={(event) => setWorkspaceCurrency(event.target.value)}
              disabled={!isWorkspaceAdmin}
            >
              {CURRENCY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          {workspaceError ? (
            <p className="m-0 text-[12px] text-[var(--adc-danger-fg)] sm:col-span-2">
              {workspaceError}
            </p>
          ) : null}
          <div className="flex justify-end sm:col-span-2">
            <RowButton
              onClick={() => void handleWorkspaceSave()}
              disabled={!isWorkspaceAdmin || savingWorkspace}
            >
              {savingWorkspace ? "Saving…" : "Save workspace"}
            </RowButton>
          </div>
        </FieldCard>

        {/* Reporting defaults — persisted client-side, so they save on change. */}
        <FieldCard>
          <Field label="Default date range">
            <select
              className={CONTROL}
              value={defaultDateRange}
              onChange={(event) =>
                setDefaultDateRange(event.target.value as "7d" | "14d" | "30d" | "90d")
              }
            >
              <option value="7d">Last 7 days</option>
              <option value="14d">Last 14 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </select>
          </Field>
          <Field label="Metric display">
            <select
              className={CONTROL}
              value={metricDisplay}
              onChange={(event) => setMetricDisplay(event.target.value as "compact" | "detailed")}
            >
              <option value="detailed">Detailed</option>
              <option value="compact">Compact</option>
            </select>
          </Field>
          <Field label="Table density">
            <select
              className={CONTROL}
              value={tableDensity}
              onChange={(event) =>
                setTableDensity(event.target.value as "comfortable" | "compact")
              }
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </Field>
          <Field label="Heatmap cells">
            <select
              className={CONTROL}
              value={heatmapEnabled ? "on" : "off"}
              onChange={(event) => setHeatmapEnabled(event.target.value === "on")}
            >
              <option value="on">Enabled</option>
              <option value="off">Disabled</option>
            </select>
          </Field>
        </FieldCard>

        {/* Plan band — the design's navy article. */}
        <article className="flex flex-wrap items-center gap-[14px] rounded-[14px] bg-[var(--adv-rail)] p-4">
          <div className="min-w-0 flex-1">
            <p className="m-0 text-[15px] font-semibold text-white">
              {billingLoading
                ? "Loading plan…"
                : billing?.planName
                  ? `${billing.planName} plan${
                      billing.monthlyPrice ? ` · $${billing.monthlyPrice}/mo` : ""
                    }`
                  : "No plan connected"}
            </p>
            <p className="m-0 mt-1 text-[12.5px] text-[#8B93A7]">
              {billing?.managedPricingUrl
                ? "Unlocks Commercial Truth. Reports & Insights need Pro; Team seats need Scale."
                : "Connect a Shopify store from Integrations to manage your subscription."}
            </p>
          </div>
          {billing?.managedPricingUrl ? (
            <button
              type="button"
              onClick={handleOpenShopifyBilling}
              className="h-[34px] shrink-0 rounded-[9px] bg-[var(--adv-accent)] px-[14px] text-[12.5px] font-semibold text-white hover:bg-[var(--adv-accent-hover)]"
            >
              Upgrade to Pro
            </button>
          ) : null}
        </article>

        {/* Action rows — the design's settingsRows pattern. */}
        <ActionRow
          title="Change password"
          detail="Sign-in password for this account."
          footer={
            passwordOpen ? (
              <div className="mt-[14px] border-t border-[var(--adv-hairline)] pt-[14px]">
                <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
                  <Field label="Current password">
                    <input
                      className={CONTROL}
                      type="password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                    />
                  </Field>
                  <Field label="New password">
                    <input
                      className={CONTROL}
                      type="password"
                      value={nextPassword}
                      onChange={(event) => setNextPassword(event.target.value)}
                    />
                  </Field>
                </div>
                {passwordError ? (
                  <p className="m-0 mt-3 text-[12px] text-[var(--adc-danger-fg)]">
                    {passwordError}
                  </p>
                ) : null}
                <div className="mt-3 flex justify-end">
                  <RowButton onClick={() => void handlePasswordUpdate()} disabled={savingPassword}>
                    {savingPassword ? "Updating…" : "Save password"}
                  </RowButton>
                </div>
              </div>
            ) : null
          }
        >
          <RowButton onClick={() => setPasswordOpen((open) => !open)}>
            {passwordOpen ? "Cancel" : "Update"}
          </RowButton>
        </ActionRow>

        <ActionRow
          title="Active sessions"
          detail="Signs you out of every device and browser session."
        >
          <RowButton onClick={() => setConfirmModal("revokeSessions")}>Revoke others</RowButton>
        </ActionRow>

        <ActionRow title="Resync warehouse" detail={snapshotNote}>
          <RowButton tone="caution" onClick={() => void handleResyncIntegrations()}>
            Run resync
          </RowButton>
        </ActionRow>

        <ActionRow
          title="Refresh provider snapshots"
          detail="Re-reads Meta and Google account discovery without changing assignments."
        >
          <RowButton tone="caution" onClick={() => void handleForceRefreshSnapshots()}>
            Refresh
          </RowButton>
        </ActionRow>

        <ActionRow
          title="Clear cached provider accounts"
          detail="Drops the local workspace cache of discovered accounts."
        >
          <RowButton onClick={handleClearCachedProviderAccounts}>Clear cache</RowButton>
        </ActionRow>

        <ActionRow
          title="Disconnect all integrations"
          detail="Removes every provider connection. Assignments stay stored."
        >
          <RowButton tone="danger" onClick={() => setConfirmModal("disconnectAll")}>
            Disconnect
          </RowButton>
        </ActionRow>

        <ActionRow
          title="Delete workspace"
          detail="Permanently removes this workspace and its assignments. Cannot be undone."
        >
          <RowButton
            tone="danger"
            onClick={() => setConfirmModal("deleteWorkspace")}
            disabled={!isWorkspaceAdmin}
          >
            Delete
          </RowButton>
        </ActionRow>
      </div>

      <ConfirmOverlay
        open={confirmModal === "disconnectAll"}
        title="Disconnect all integrations?"
        description="This will disconnect every provider linked to this workspace. Assignments remain stored, but all live connections will be removed."
        confirmLabel="Disconnect all"
        onCancel={() => setConfirmModal(null)}
        onConfirm={() => void handleDangerConfirm()}
        busy={runningDangerAction}
      />
      <ConfirmOverlay
        open={confirmModal === "deleteWorkspace"}
        title="Delete this workspace?"
        description="This permanently deletes the workspace, team memberships, invites, assignments, and linked integrations."
        confirmLabel="Delete workspace"
        onCancel={() => setConfirmModal(null)}
        onConfirm={() => void handleDangerConfirm()}
        busy={runningDangerAction}
      />
      <ConfirmOverlay
        open={confirmModal === "revokeSessions"}
        title="Revoke all sessions?"
        description="This signs you out from every active device and browser session."
        confirmLabel="Revoke sessions"
        confirmVariant="default"
        onCancel={() => setConfirmModal(null)}
        onConfirm={() => void handleDangerConfirm()}
        busy={runningDangerAction}
      />
    </WorkspaceSurface>
  );
}
