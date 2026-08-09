"use client";

import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { usePreferencesStore } from "@/store/preferences-store";
import { clearAuthScopedClientState } from "@/lib/client-auth-state";
import { isDemoBusinessId } from "@/lib/demo-business";
import { type PlanId } from "@/lib/pricing/plans";
import {
  ConfirmOverlay,
  SettingsActionRow,
  SettingsField,
  SettingsGrid,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
} from "@/components/settings/settings-section";
import { StateBanner } from "@/components/ui/product-surface";
import {
  WorkspaceAnchorNav,
  WorkspaceSurface,
} from "@/components/workspace/workspace-surface";
import {
  fetchProviderAccountSnapshot,
  warmProviderAccountSnapshot,
} from "@/lib/provider-account-client";
import {
  CURRENCY_OPTIONS,
  fetchSettingsAccount,
  fetchWorkspaceRoleByBusiness,
  fetchWorkspaceTeam,
  type InviteRow,
  type MemberRow,
  type WorkspaceRole,
  projectProviderHealth,
} from "@/app/(dashboard)/settings/settings-support";
import { getTranslations } from "@/lib/i18n";

export default function SettingsPage() {

  const router = useRouter();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceOwnerId = useAppStore((state) => state.workspaceOwnerId);
  const setWorkspaceSnapshot = useAppStore((state) => state.setWorkspaceSnapshot);
  const deleteBusiness = useAppStore((state) => state.deleteBusiness);
  const selectBusiness = useAppStore((state) => state.selectBusiness);

  const byBusinessId = useIntegrationsStore((state) => state.byBusinessId);
  const ensureBusiness = useIntegrationsStore((state) => state.ensureBusiness);
  const integrationDomains = useIntegrationsStore((state) =>
    selectedBusinessId ? state.domainsByBusinessId[selectedBusinessId] : undefined
  );
  const removeBusinessData = useIntegrationsStore((state) => state.removeBusinessData);
  const clearAllState = useIntegrationsStore((state) => state.clearAllState);
  const clearProviderAccountsForBusiness = useIntegrationsStore(
    (state) => state.clearProviderAccountsForBusiness
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

  const activeBusiness =
    businesses.find((business) => business.id === selectedBusinessId) ?? null;
  const settingsTranslations = getTranslations(language).settings;
  const integrations = selectedBusinessId ? byBusinessId[selectedBusinessId] : undefined;
  const connectedIntegrations = Object.values(integrations ?? {}).filter(
    (integration) => integration.status === "connected"
  );

  const [accountName, setAccountName] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [accountCreatedAt, setAccountCreatedAt] = useState<string | null>(null);
  const [workspaceRole, setWorkspaceRole] = useState<WorkspaceRole>("guest");

  const [workspaceName, setWorkspaceName] = useState(activeBusiness?.name ?? "");
  const [workspaceCurrency, setWorkspaceCurrency] = useState(activeBusiness?.currency ?? "USD");

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("collaborator");

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
  const [loadingTeam, setLoadingTeam] = useState(false);

  const [sendingInvite, setSendingInvite] = useState(false);
  const [runningDangerAction, setRunningDangerAction] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmModal, setConfirmModal] = useState<null | "disconnectAll" | "deleteWorkspace" | "revokeSessions">(null);
  const [providerHealth, setProviderHealth] = useState<Record<string, { label: string; value: string }>>({});

  // One freshness contract across every Tier-0 surface. Derived from the
  // state this surface already has, so it cannot drift from what is on screen.
  useTierZeroFreshness({
    surface: "settings",
    isLoading: loadingTeam,
    error: workspaceError ?? accountError ?? teamError,
    asOf: accountCreatedAt,
    businessId: null,
  });

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
      setAccountCreatedAt(user.createdAt ?? null);
    } catch (error: unknown) {
      setAccountError(error instanceof Error ? error.message : "Could not load account settings.");
    }
  }, []);

  const loadWorkspaceRole = useCallback(async () => {
    const currentRole = await fetchWorkspaceRoleByBusiness(selectedBusinessId);
    setWorkspaceRole(currentRole);
  }, [selectedBusinessId]);

  const loadTeam = useCallback(async () => {
    if (!selectedBusinessId) return;
    setLoadingTeam(true);
    setTeamError(null);
    try {
      const team = await fetchWorkspaceTeam(selectedBusinessId);
      setMembers(team.members);
      setInvites(team.invites);
    } catch (error: unknown) {
      setTeamError(error instanceof Error ? error.message : "Could not load workspace team.");
    } finally {
      setLoadingTeam(false);
    }
  }, [selectedBusinessId]);

  const loadBilling = useCallback(async () => {
    if (!selectedBusinessId) return;
    setBillingLoading(true);
    try {
      const response = await fetch(`/api/billing?businessId=${encodeURIComponent(selectedBusinessId)}`);
      const data = await response.json().catch(() => null) as typeof billing | null;
      if (response.ok && data) {
        setBilling(data);
      }
    } catch {
      // non-fatal, billing section will show fallback
    } finally {
      setBillingLoading(false);
    }
  }, [selectedBusinessId]);

  // Provider health is projected from the same derivation Integrations renders.
  // Settings previously judged health from the account-list snapshot alone, so a
  // revoked token could read "Healthy" here while Integrations said action
  // required — two answers to one question, from two different sources.
  const loadProviderHealth = useCallback(async () => {
    if (!selectedBusinessId) return;
    if (isDemoBusinessId(selectedBusinessId)) {
      setProviderHealth({
        meta: { label: "Connected", value: "Demo data fixture" },
        google: { label: "Connected", value: "Demo data fixture" },
      });
      return;
    }
    await ensureBusiness(selectedBusinessId);
  }, [ensureBusiness, selectedBusinessId]);

  const derivedProviderHealth = useMemo(() => {
    if (!selectedBusinessId || isDemoBusinessId(selectedBusinessId)) return null;
    return projectProviderHealth(integrationDomains);
  }, [integrationDomains, selectedBusinessId]);

  /** One health answer: the shared derivation, with the demo fixture as the only override. */
  const effectiveProviderHealth = derivedProviderHealth ?? providerHealth;

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  useEffect(() => {
    if (!selectedBusinessId) return;
    void loadWorkspaceRole();
    void loadTeam();
    void loadProviderHealth();
    void loadBilling();
  }, [loadBilling, loadProviderHealth, loadTeam, loadWorkspaceRole, selectedBusinessId]);

  const isWorkspaceAdmin = workspaceRole === "admin";
  const isDemoWorkspace = isDemoBusinessId(selectedBusinessId);

  // Sticky sub-nav model — mirrors the wireframe's left settings rail. Team is
  // omitted for demo workspaces, matching the section that actually renders.
  const settingsNav: Array<{ id: string; label: string }> = [
    { id: "settings-billing", label: "Plan & Billing" },
    { id: "settings-workspace", label: "Workspace" },
    { id: "settings-account", label: "Account" },
    ...(!isDemoWorkspace ? [{ id: "settings-team", label: "Team" }] : []),
    { id: "settings-data", label: "Data & Integrations" },
    { id: "settings-security", label: "Security" },
    { id: "settings-preferences", label: "Preferences" },
    { id: "settings-danger", label: "Danger zone" },
  ];

  const totalMembers = members.length;
  const totalInvites = invites.filter((invite) => invite.status === "pending").length;
  const workspaceTimezoneLabel = activeBusiness?.timezone ?? "Derived after Shopify or GA4 connection";
  const workspaceTimezoneSourceLabel =
    activeBusiness?.timezoneSource === "shopify"
      ? "Shopify"
      : activeBusiness?.timezoneSource === "ga4"
        ? "GA4"
        : "Unset";

  async function handleWorkspaceSave() {
    if (!selectedBusinessId || !activeBusiness || !workspaceOwnerId) return;
    setSavingWorkspace(true);
    setWorkspaceError(null);
    try {
      const response = await fetch(`/api/businesses/${encodeURIComponent(selectedBusinessId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: workspaceName,
          currency: workspaceCurrency,
        }),
      });
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
          : business
      );
      setWorkspaceSnapshot(workspaceOwnerId, nextBusinesses, selectedBusinessId);
      setToast({ type: "success", message: "Workspace settings updated." });
    } catch (error: unknown) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not update workspace settings.");
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
      const payload = (await response.json().catch(() => null)) as { user?: { name?: string }; message?: string } | null;
      if (!response.ok || !payload?.user) {
        throw new Error(payload?.message ?? "Could not update account settings.");
      }
      setAccountName(payload.user.name ?? accountName);
      setToast({ type: "success", message: "Account settings updated." });
      router.refresh();
    } catch (error: unknown) {
      setAccountError(error instanceof Error ? error.message : "Could not update account settings.");
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
      if (!response.ok) {
        throw new Error(payload?.message ?? "Could not update password.");
      }
      setCurrentPassword("");
      setNextPassword("");
      setToast({ type: "success", message: "Password updated." });
    } catch (error: unknown) {
      setPasswordError(error instanceof Error ? error.message : "Could not update password.");
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleInvite() {
    if (!selectedBusinessId || !inviteEmail.trim()) return;
    setSendingInvite(true);
    setTeamError(null);
    try {
      const response = await fetch("/api/team/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: selectedBusinessId,
          emails: [inviteEmail],
          role: inviteRole,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Could not send invite.");
      }
      setInviteEmail("");
      setToast({ type: "success", message: "Invite sent." });
      await loadTeam();
    } catch (error: unknown) {
      setTeamError(error instanceof Error ? error.message : "Could not send invite.");
    } finally {
      setSendingInvite(false);
    }
  }

  async function updateMemberRole(membershipId: string, role: WorkspaceRole) {
    if (!selectedBusinessId) return;
    const response = await fetch("/api/team/members", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: selectedBusinessId, membershipId, role }),
    });
    if (!response.ok) {
      setTeamError("Could not change member role.");
      return;
    }
    setToast({ type: "success", message: "Member role updated." });
    await loadTeam();
  }

  async function removeMemberAction(membershipId: string) {
    if (!selectedBusinessId) return;
    const response = await fetch("/api/team/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: selectedBusinessId, membershipId }),
    });
    if (!response.ok) {
      setTeamError("Could not remove member.");
      return;
    }
    setToast({ type: "success", message: "Member removed." });
    await loadTeam();
  }

  async function revokeInviteAction(inviteId: string) {
    if (!selectedBusinessId) return;
    const response = await fetch("/api/team/invites", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: selectedBusinessId, inviteId, action: "revoke" }),
    });
    if (!response.ok) {
      setTeamError("Could not revoke invite.");
      return;
    }
    setToast({ type: "success", message: "Invite revoked." });
    await loadTeam();
  }

  async function handleResyncIntegrations() {
    if (!selectedBusinessId) return;
    if (isDemoBusinessId(selectedBusinessId)) {
      await loadProviderHealth();
      setToast({ type: "success", message: "Demo workspace is already using fixture-backed integration data." });
      return;
    }
    try {
      await fetch(`/api/integrations?businessId=${encodeURIComponent(selectedBusinessId)}`, { cache: "no-store" });
      await loadProviderHealth();
      setToast({ type: "success", message: "Integration sync check completed." });
    } catch {
      setToast({ type: "error", message: "Could not re-sync integrations." });
    }
  }

  async function handleForceRefreshSnapshots() {
    if (!selectedBusinessId) return;
    if (isDemoBusinessId(selectedBusinessId)) {
      await loadProviderHealth();
      setToast({ type: "success", message: "Demo workspace snapshots are fixture-backed and already up to date." });
      return;
    }
    try {
      await Promise.all(
        connectedIntegrations
          .filter((integration) => integration.provider === "meta" || integration.provider === "google")
          .map((integration) =>
            warmProviderAccountSnapshot(integration.provider as "meta" | "google", selectedBusinessId)
          )
      );
      await loadProviderHealth();
      setToast({ type: "success", message: "Provider snapshots refreshed." });
    } catch {
      setToast({ type: "error", message: "Could not refresh provider snapshots." });
    }
  }

  function handleClearCachedProviderAccounts() {
    if (!selectedBusinessId) return;
    clearProviderAccountsForBusiness(selectedBusinessId);
    setToast({ type: "success", message: "Cached provider account data cleared for this workspace." });
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
              { method: "DELETE" }
            ).catch(() => null)
          )
        );
        clearAllState();
        setToast({ type: "success", message: "All integrations disconnected." });
        router.refresh();
      } else if (confirmModal === "deleteWorkspace") {
        const response = await fetch(`/api/businesses/${encodeURIComponent(selectedBusinessId)}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          throw new Error("Could not delete workspace.");
        }
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
        const response = await fetch("/api/settings/security/revoke-sessions", {
          method: "POST",
        });
        if (!response.ok) {
          throw new Error("Could not revoke sessions.");
        }
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
    if (!billing?.connected) return;
    if (!billing.managedPricingUrl) {
      setToast({
        type: "error",
        message: "Shopify billing URL is not available for this store yet.",
      });
      return;
    }
    window.location.href = billing.managedPricingUrl;
  }

  const inviteRows = useMemo(
    () => invites.filter((invite) => invite.status === "pending"),
    [invites]
  );

  if (!selectedBusinessId || !activeBusiness) {
    return (
      <WorkspaceSurface
        eyebrow="Workspace"
        title="Settings"
        description="Select a workspace to manage settings."
        width="narrow"
      >
        <StateBanner tone="warning" title="No workspace selected" />
      </WorkspaceSurface>
    );
  }

  return (
    <WorkspaceSurface
      eyebrow="Workspace"
      title="Settings"
      description="Manage your account, workspace operations, integrations, preferences, and security from one place."
      width="narrow"
    >

      {toast ? (
        <StateBanner
          tone={toast.type === "success" ? "success" : "danger"}
          title={toast.type === "success" ? "Settings updated" : "Settings action failed"}
        >
          {toast.message}
        </StateBanner>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[176px_minmax(0,1fr)]">
        <WorkspaceAnchorNav items={settingsNav} className="hidden lg:flex" />
        <div className="min-w-0 space-y-6">
      <SettingsSection
        id="settings-billing"
        title="Plan & Billing"
        description="Manage your Adsecute subscription. Billing is handled through the Shopify App Store."
      >
        {billingLoading ? (
          <p className="text-sm text-[var(--adc-ink3)]">Loading subscription details...</p>
        ) : billing?.managedPricingUrl ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">{billing.planName} plan</p>
              <Badge variant="secondary">
                {billing.status === "active" ? "Active" : billing.status ?? "Active"}
              </Badge>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleOpenShopifyBilling}
            >
              Open Shopify billing ↗
            </Button>
          </div>
        ) : (
          <p className="text-sm text-[var(--adc-ink3)]">
            Connect a Shopify store from the{" "}
            <a href="/integrations" className="text-[var(--adc-info-fg)] hover:underline">
              Integrations
            </a>{" "}
            page to manage your subscription.
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        id="settings-workspace"
        title="Workspace Settings"
        description="Update the current workspace identity and default reporting context for this business."
      >
        <SettingsGrid>
          <SettingsField label="Workspace name">
            <SettingsInput
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              disabled={!isWorkspaceAdmin}
            />
          </SettingsField>
          <SettingsField label="Default timezone">
            <div className="rounded-md border border-[var(--adc-b1)] bg-[var(--adc-s1)] px-3 py-2 text-sm">
              <div className="font-medium">{workspaceTimezoneLabel}</div>
              <div className="mt-1 text-xs text-[var(--adc-ink3)]">
                Source: {workspaceTimezoneSourceLabel}. Managed automatically from Shopify first, then GA4.
              </div>
            </div>
          </SettingsField>
          <SettingsField label="Default currency">
            <SettingsSelect
              value={workspaceCurrency}
              onChange={(event) => setWorkspaceCurrency(event.target.value)}
              disabled={!isWorkspaceAdmin}
            >
              {CURRENCY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </SettingsSelect>
          </SettingsField>
          <div className="rounded-[10px] border border-[var(--adc-b1)] bg-[var(--adc-s2)] px-4 py-3">
            <p className="text-sm font-medium">Access level</p>
            <p className="mt-1 text-sm text-[var(--adc-ink3)]">
              {workspaceRole === "admin" ? "Admin" : workspaceRole === "collaborator" ? "Member" : "Viewer"}
            </p>
          </div>
        </SettingsGrid>
        {workspaceError ? <p className="mt-3 text-sm text-[var(--adc-danger-fg)]">{workspaceError}</p> : null}
        <SettingsActionRow>
          <Button onClick={handleWorkspaceSave} disabled={!isWorkspaceAdmin || savingWorkspace}>
            {savingWorkspace ? "Saving..." : "Save workspace settings"}
          </Button>
        </SettingsActionRow>
      </SettingsSection>
      <SettingsSection
        id="settings-account"
        title="Account Settings"
        description="Manage your personal profile and password for Adsecute."
      >
        <SettingsGrid>
          <SettingsField label="Name">
            <SettingsInput value={accountName} onChange={(event) => setAccountName(event.target.value)} />
          </SettingsField>
          <SettingsField label="Email" hint="Read-only account identifier.">
            <SettingsInput value={accountEmail} readOnly disabled />
          </SettingsField>
          <div className="rounded-[8px] border border-[var(--adc-b1)] bg-[var(--adc-s2)] px-3 py-2.5">
            <p className="text-[12px] font-medium text-[var(--adc-ink)]">Member since</p>
            <p className="mt-1 font-mono text-[12px] text-[var(--adc-ink3)]">
              {accountCreatedAt ? new Date(accountCreatedAt).toLocaleDateString() : "Unknown"}
            </p>
          </div>
        </SettingsGrid>
        {accountError ? <p className="mt-3 text-sm text-[var(--adc-danger-fg)]">{accountError}</p> : null}
        <SettingsActionRow>
          <Button onClick={handleAccountSave} disabled={savingAccount}>
            {savingAccount ? "Saving..." : "Update profile"}
          </Button>
        </SettingsActionRow>

        <div className="mt-6 border-t pt-5">
          <h3 className="text-sm font-semibold">Change password</h3>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <SettingsField label="Current password">
              <SettingsInput
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </SettingsField>
            <SettingsField label="New password">
              <SettingsInput
                type="password"
                value={nextPassword}
                onChange={(event) => setNextPassword(event.target.value)}
              />
            </SettingsField>
          </div>
          {passwordError ? <p className="mt-3 text-sm text-[var(--adc-danger-fg)]">{passwordError}</p> : null}
          <SettingsActionRow>
            <Button onClick={handlePasswordUpdate} disabled={savingPassword}>
              {savingPassword ? "Updating..." : "Change password"}
            </Button>
          </SettingsActionRow>
        </div>
      </SettingsSection>

      {!isDemoWorkspace && <SettingsSection
        id="settings-team"
        title="Team Management"
        description="Invite teammates, review current workspace access, and manage roles."
        actions={
          <Badge variant="secondary">
            {totalMembers} members • {totalInvites} pending invites
          </Badge>
        }
      >
        <div className="grid gap-6 lg:grid-cols-[1.25fr_0.9fr]">
          <div className="space-y-4">
            <div className="rounded-xl border">
              <div className="grid grid-cols-[1.4fr_1fr_140px] gap-3 border-b px-4 py-3 text-xs font-medium uppercase tracking-[0.16em] text-[var(--adc-ink3)]">
                <span>Member</span>
                <span>Role</span>
                <span className="text-right">Actions</span>
              </div>
              {loadingTeam ? (
                <p className="px-4 py-4 text-sm text-[var(--adc-ink3)]">Loading team members...</p>
              ) : members.length === 0 ? (
                <p className="px-4 py-4 text-sm text-[var(--adc-ink3)]">No members found for this workspace.</p>
              ) : (
                members.map((member) => (
                  <div
                    key={member.membership_id}
                    className="grid grid-cols-[1.4fr_1fr_140px] gap-3 border-b px-4 py-3 last:border-b-0"
                  >
                    <div>
                      <p className="text-sm font-medium">{member.name}</p>
                      <p className="text-xs text-[var(--adc-ink3)]">{member.email}</p>
                    </div>
                    <div>
                      <SettingsSelect
                        value={member.role}
                        disabled={!isWorkspaceAdmin}
                        onChange={(event) => void updateMemberRole(member.membership_id, event.target.value as WorkspaceRole)}
                      >
                        <option value="admin">Admin</option>
                        <option value="collaborator">Member</option>
                        <option value="guest">Viewer</option>
                      </SettingsSelect>
                    </div>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        className="text-[var(--adc-ink3)] hover:text-[var(--adc-danger-fg)]"
                        disabled={!isWorkspaceAdmin}
                        onClick={() => void removeMemberAction(member.membership_id)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="rounded-[10px] border border-[var(--adc-b1)] bg-[var(--adc-s2)] p-4">
              <h3 className="text-sm font-semibold">Pending invites</h3>
              <div className="mt-3 space-y-3">
                {inviteRows.length === 0 ? (
                  <p className="text-sm text-[var(--adc-ink3)]">No pending invites.</p>
                ) : (
                  inviteRows.map((invite) => (
                    <div
                      key={invite.id}
                      className="flex flex-col gap-3 rounded-lg border px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div>
                        <p className="text-sm font-medium">{invite.email}</p>
                        <p className="text-xs text-[var(--adc-ink3)]">
                          {invite.role === "collaborator" ? "Member" : invite.role === "guest" ? "Viewer" : "Admin"} • expires {new Date(invite.expires_at).toLocaleDateString()}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        className="self-end text-[var(--adc-ink3)] hover:text-[var(--adc-danger-fg)] sm:self-auto"
                        disabled={!isWorkspaceAdmin}
                        onClick={() => void revokeInviteAction(invite.id)}
                      >
                        Revoke
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="rounded-[10px] border border-[var(--adc-b1)] bg-[var(--adc-s2)] p-4">
            <h3 className="text-sm font-semibold">Invite team member</h3>
            <div className="mt-4 space-y-4">
              <SettingsField label="Email address">
                <SettingsInput
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  disabled={!isWorkspaceAdmin}
                  placeholder="name@company.com"
                />
              </SettingsField>
              <SettingsField label="Role">
                <SettingsSelect
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value as WorkspaceRole)}
                  disabled={!isWorkspaceAdmin}
                >
                  <option value="admin">Admin</option>
                  <option value="collaborator">Member</option>
                  <option value="guest">Viewer</option>
                </SettingsSelect>
              </SettingsField>
              {teamError ? <p className="text-sm text-[var(--adc-danger-fg)]">{teamError}</p> : null}
              <Button className="w-full" onClick={handleInvite} disabled={!isWorkspaceAdmin || sendingInvite}>
                {sendingInvite ? "Sending..." : "Invite team member"}
              </Button>
            </div>
          </div>
        </div>
      </SettingsSection>}

      <SettingsSection
        id="settings-data"
        title="Data & Integrations Management"
        description="Monitor connection health and trigger maintenance actions for provider data."
      >
        <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="grid gap-3 md:grid-cols-2">
            {["meta", "google"].map((provider) => (
              <div key={provider} className="rounded-[10px] border border-[var(--adc-b1)] bg-[var(--adc-s2)] p-4">
                <p className="text-sm font-medium capitalize">{provider}</p>
                <p className="mt-2 text-sm text-[var(--adc-ink3)]">
                  {effectiveProviderHealth[provider]?.label ?? "Checking health..."}
                </p>
                <p className="mt-1 text-xs text-[var(--adc-ink3)]">
                  {effectiveProviderHealth[provider]?.value ?? "Loading provider status"}
                </p>
              </div>
            ))}
            <div className="rounded-[10px] border border-[var(--adc-b1)] bg-[var(--adc-s2)] p-4">
              <p className="text-sm font-medium">Last sync status</p>
              <p className="mt-2 text-sm text-[var(--adc-ink3)]">
                {connectedIntegrations.length > 0 ? "Connected providers available" : "No connected integrations"}
              </p>
              <p className="mt-1 text-xs text-[var(--adc-ink3)]">
                {connectedIntegrations
                  .map((integration) => integration.providerAccountName ?? integration.provider)
                  .slice(0, 3)
                  .join(", ") || "Connect a provider to begin syncing"}
              </p>
            </div>
            <div className="rounded-[10px] border border-[var(--adc-b1)] bg-[var(--adc-s2)] p-4">
              <p className="text-sm font-medium">Provider snapshot health</p>
              <p className="mt-2 text-sm text-[var(--adc-ink3)]">
                {Object.keys(effectiveProviderHealth).length > 0 ? "Observed" : "Not available yet"}
              </p>
              <p className="mt-1 text-xs text-[var(--adc-ink3)]">
                Snapshot actions refresh account discovery state without changing assignments.
              </p>
            </div>
          </div>

          <div className="rounded-[10px] border border-[var(--adc-b1)] bg-[var(--adc-s2)] p-4">
            <h3 className="text-sm font-semibold">Maintenance actions</h3>
            <div className="mt-4 space-y-3">
              <Button className="w-full justify-between" onClick={handleResyncIntegrations}>
                Re-sync integrations
                <span className="text-xs opacity-80">Refresh statuses</span>
              </Button>
              <Button variant="outline" className="w-full justify-between" onClick={handleForceRefreshSnapshots}>
                Force refresh provider snapshots
                <span className="text-xs opacity-80">Meta & Google</span>
              </Button>
              <Button variant="outline" className="w-full justify-between" onClick={handleClearCachedProviderAccounts}>
                Clear cached provider accounts
                <span className="text-xs opacity-80">Local workspace cache</span>
              </Button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        id="settings-security"
        title="Security"
        description="Only working security controls are shown here; 2FA, API tokens, and profile pictures are cut rather than stubbed."
      >
        <div className="grid gap-4 lg:grid-cols-[1fr_0.9fr]">
          <div className="rounded-[8px] border border-[var(--adc-b1)] bg-[var(--adc-s1)] p-3 text-[12px] leading-5 text-[var(--adc-ink2)]">
            The reference design intentionally removes non-working security settings. This page should not promise
            2FA, API token management, profile images, or session browsers until those contracts exist.
          </div>
          <div className="rounded-[8px] border border-[var(--adc-b1)] bg-[var(--adc-s2)] p-4">
            <h3 className="text-sm font-semibold">Session controls</h3>
            <p className="mt-2 text-sm text-[var(--adc-ink3)]">
              Manage active sessions and security-sensitive access across devices.
            </p>
            <div className="mt-4 space-y-3">
              <Button className="w-full justify-between" onClick={() => setConfirmModal("revokeSessions")}>
                Revoke all sessions
                <span className="text-xs opacity-80">Sign out everywhere</span>
              </Button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        id="settings-preferences"
        title="System Preferences"
        description="Choose the defaults Adsecute should use across reporting and table-heavy views."
      >
        <SettingsGrid>
          <SettingsField label="Default date range">
            <SettingsSelect
              value={defaultDateRange}
              onChange={(event) =>
                setDefaultDateRange(event.target.value as "7d" | "14d" | "30d" | "90d")
              }
            >
              <option value="7d">Last 7 days</option>
              <option value="14d">Last 14 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </SettingsSelect>
          </SettingsField>
          <SettingsField label="Metric display preference">
            <SettingsSelect
              value={metricDisplay}
              onChange={(event) =>
                setMetricDisplay(event.target.value as "compact" | "detailed")
              }
            >
              <option value="detailed">Detailed metrics</option>
              <option value="compact">Compact metrics</option>
            </SettingsSelect>
          </SettingsField>
          <SettingsField label="Table density">
            <SettingsSelect
              value={tableDensity}
              onChange={(event) =>
                setTableDensity(event.target.value as "comfortable" | "compact")
              }
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </SettingsSelect>
          </SettingsField>
          <div className="rounded-[10px] border border-[var(--adc-b1)] bg-[var(--adc-s2)] px-4 py-3">
            <p className="text-sm font-medium">Heatmap visualizations</p>
            <p className="mt-1 text-xs text-[var(--adc-ink3)]">
              Toggle denser visual heatmap treatments where available.
            </p>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm text-foreground">
                {heatmapEnabled ? "Enabled" : "Disabled"}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setHeatmapEnabled(!heatmapEnabled)}
              >
                Toggle
              </Button>
            </div>
          </div>
        </SettingsGrid>
      </SettingsSection>

      <SettingsSection
        id="settings-danger"
        title="Danger Zone"
        description="High-impact actions are separated here to reduce accidental changes."
        danger
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-[10px] border border-[var(--adc-danger-bd)] bg-[var(--adc-s2)] p-4">
            <p className="text-sm font-medium">Disconnect all integrations</p>
            <p className="mt-2 text-sm text-[var(--adc-ink3)]">
              Removes active provider connections for this workspace without deleting the workspace itself.
            </p>
            <div className="mt-4">
              <Button variant="outline" onClick={() => setConfirmModal("disconnectAll")}>
                Disconnect all integrations
              </Button>
            </div>
          </div>
          <div className="rounded-[10px] border border-[var(--adc-danger-bd)] bg-[var(--adc-s2)] p-4">
            <p className="text-sm font-medium">Delete workspace</p>
            <p className="mt-2 text-sm text-[var(--adc-ink3)]">
              Permanently removes this workspace and its assignments. This action cannot be undone.
            </p>
            <div className="mt-4">
              <Button
                variant="destructive"
                onClick={() => setConfirmModal("deleteWorkspace")}
                disabled={!isWorkspaceAdmin}
              >
                Delete workspace
              </Button>
            </div>
          </div>
        </div>
      </SettingsSection>
        </div>
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
