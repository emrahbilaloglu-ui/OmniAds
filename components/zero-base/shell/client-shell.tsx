"use client";

/**
 * Client-scope shell wrapper.
 *
 * Splits the server layout (which resolves and authorizes scope) from the
 * client chrome (which needs pathname and viewport). The envelope crosses the
 * boundary as inert data — nothing here can widen the scope it was given.
 */
import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { WorkspaceContextProvider } from "@/components/workspace/workspace-context-provider";
import { AppShell } from "@/components/zero-base/shell/app-shell";
import { UserMenu } from "@/components/zero-base/shell/user-menu";
import { navGroupsFor } from "@/lib/zero-base/navigation";
import type {
  ProviderId,
  ProviderScopeMode,
  WorkspaceContextEnvelope,
  WorkspaceMode,
} from "@/lib/workspace/workspace-context";
import type { ScopeFacts } from "@/components/zero-base/primitives/scope-sheet";
import { PostureNotice } from "@/components/zero-base/auth/auth-states";
import { DEMO_BUSINESS_COPY, REVIEWER_READ_ONLY_COPY } from "@/lib/zero-base/auth-states";
import type { ProviderScopeCatalog } from "@/lib/zero-base/provider-scope-server";
import { ZeroBaseSheet } from "@/components/zero-base/primitives/overlays";
import { navHref, railLabel } from "@/lib/zero-base/navigation";

/** Human names for the scope facts, so the sheet never prints an enum. */
const WORKSPACE_MODE_LABEL: Record<WorkspaceMode, string> = {
  agency: "Agency",
  client: "Client",
  ops: "Ops",
  account: "Account",
};

const PROVIDER_LABEL: Record<ProviderId, string> = {
  meta: "Meta",
  google: "Google Ads",
  shopify: "Shopify",
  ga4: "GA4",
  search_console: "Search Console",
};

export function ClientShell({
  envelope,
  businessId,
  providerCatalogs = [],
  businesses = [],
  children,
}: {
  envelope: WorkspaceContextEnvelope;
  businessId: string;
  providerScopeMode: ProviderScopeMode;
  providerCatalogs?: ProviderScopeCatalog[];
  businesses?: Array<{ id: string; name: string }>;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  const [picker, setPicker] = useState<"business" | "account" | "window" | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const groups = navGroupsFor("Client");

  const providerId: "meta" | "google" | null =
    pathname.startsWith("/app/meta") || pathname.startsWith("/app/creative") || pathname.includes("/meta/") || pathname.includes("/creative/")
      ? "meta"
      : pathname.startsWith("/app/google") || pathname.includes("/google/")
        ? "google"
        : null;
  const catalog = providerCatalogs.find((item) => item.provider === providerId) ?? null;
  const requestedAccountId = searchParams.get("providerAccountId");
  const selectedAccount =
    catalog?.accounts.find((account) => account.id === requestedAccountId) ??
    (catalog?.accounts.length === 1 ? catalog.accounts[0] : null);
  const routeWindow = {
    start: searchParams.get("start"),
    end: searchParams.get("end"),
  };
  const accountPickerEnabled =
    pathname.startsWith("/app/creative/") || pathname === "/app/meta/launchpad";
  const windowPickerEnabled = pathname.startsWith("/app/creative/");
  const evidenceWindowLabel =
    windowPickerEnabled && routeWindow.start && routeWindow.end
      ? `${routeWindow.start} → ${routeWindow.end}`
      : windowPickerEnabled
        ? "Last 28 days"
        : envelope.evidence.windowLabel;

  const effectiveEnvelope = useMemo<WorkspaceContextEnvelope>(
    () => ({
      ...envelope,
      provider: providerId
        ? {
            id: providerId,
            selectedAccountIds: selectedAccount
              ? [selectedAccount.id]
              : (catalog?.accounts.map((account) => account.id) ?? []),
            selectedAccountLabel: selectedAccount?.label ?? null,
            mode: selectedAccount
              ? "single"
              : catalog && catalog.accounts.length > 1
                ? "portfolio"
                : "none",
          }
        : null,
      evidence: { ...envelope.evidence, windowLabel: evidenceWindowLabel },
    }),
    [catalog, envelope, evidenceWindowLabel, providerId, selectedAccount],
  );

  const currentItem = groups
    .flatMap((group) => group.items)
    .find((item) => {
      const href = navHref(item.url, businessId);
      return pathname === href || pathname.startsWith(`${href}/`);
    });

  function replaceScope(updates: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    router.replace(`${pathname}${next.size ? `?${next.toString()}` : ""}`, { scroll: false });
    setPicker(null);
  }

  async function switchBusiness(nextBusinessId: string) {
    if (nextBusinessId === businessId) {
      setPicker(null);
      return;
    }
    setSwitchError(null);
    const response = await fetch("/api/auth/switch-business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: nextBusinessId }),
    }).catch(() => null);
    if (!response?.ok) {
      setSwitchError("The business could not be switched. Try again.");
      return;
    }
    window.location.assign(pathname || "/app/home");
  }

  const scope: ScopeFacts = {
    // Context and provider are facts the envelope already carries; the sheet
    // states them rather than leaving the actor to infer scope from the rail.
    scopeContext: WORKSPACE_MODE_LABEL[effectiveEnvelope.mode],
    // Not yet tracked in the envelope: nothing records which surface the client
    // scope was entered from, so this stays null rather than guessing "Agency
    // Desk" for someone who navigated straight to a bookmark.
    enteredFrom: null,
    providerLabel:
      !effectiveEnvelope.provider
        ? null
        : PROVIDER_LABEL[effectiveEnvelope.provider.id],
    businessName: effectiveEnvelope.business?.name ?? null,
    providerAccountLabel:
      effectiveEnvelope.provider?.selectedAccountLabel ?? null,
    evidenceWindowLabel: effectiveEnvelope.evidence.windowLabel,
    configuredCurrency: selectedAccount?.currency ?? effectiveEnvelope.business?.configuredCurrency ?? null,
    currencyProof: selectedAccount?.currency ? "proven" : effectiveEnvelope.proof.currency,
    businessTimezone: selectedAccount?.timezone ?? effectiveEnvelope.business?.businessTimezone ?? null,
    timezoneProof: selectedAccount?.timezone ? "aligned" : effectiveEnvelope.proof.timezone,
    freshness: effectiveEnvelope.evidence.freshness,
    snapshotAt: effectiveEnvelope.evidence.snapshotAt,
  };

  return (
    <WorkspaceContextProvider value={effectiveEnvelope}>
      <AppShell
        groups={groups}
        businessId={businessId}
        pathname={pathname}
        workspaceMode="client"
        workspaceName={effectiveEnvelope.business?.name ?? "Client"}
        title={currentItem ? railLabel(currentItem.label) : `Client · ${effectiveEnvelope.business?.name ?? "Client"}`}
        scope={scope}
        scopePickers={{
          onSwitchBusiness: () => setPicker("business"),
          ...(accountPickerEnabled && catalog?.accounts.length ? { onPickAccount: () => setPicker("account") } : {}),
          ...(windowPickerEnabled ? { onPickWindow: () => setPicker("window") } : {}),
        }}
        railFooter={
          <UserMenu
            name={envelope.actor.name}
            rail
            onLogout={() => {
              window.location.href = "/logout";
            }}
          />
        }
      >
        {/* Posture is stated on the surface, not only in the rail footer: a
            reviewer who cannot write, or a demo business whose numbers are
            illustrative, must know before they read a chart. */}
        {envelope.actor.reviewerReadOnly ? (
          <PostureNotice text={REVIEWER_READ_ONLY_COPY} kind="reviewer" />
        ) : null}
        {envelope.actor.demo ? <PostureNotice text={DEMO_BUSINESS_COPY} kind="demo" /> : null}
        {children}

      <ZeroBaseSheet
        open={picker === "business"}
        onOpenChange={(open) => setPicker(open ? "business" : null)}
        title="Switch business"
        regionEl="business-picker"
        side="bottom"
      >
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {switchError ? <p role="alert">{switchError}</p> : null}
          {businesses.map((business) => (
            <button
              type="button"
              key={business.id}
              aria-pressed={business.id === businessId}
              onClick={() => void switchBusiness(business.id)}
              style={{ minHeight: 44, textAlign: "left", padding: "8px 12px" }}
            >
              {business.name}
            </button>
          ))}
        </div>
      </ZeroBaseSheet>

      <ZeroBaseSheet
        open={picker === "account"}
        onOpenChange={(open) => setPicker(open ? "account" : null)}
        title="Choose provider account"
        regionEl="provider-account-picker"
        side="bottom"
      >
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {(catalog?.accounts ?? []).map((account) => (
            <button
              type="button"
              key={account.id}
              aria-pressed={selectedAccount?.id === account.id}
              onClick={() => replaceScope({ providerAccountId: account.id })}
              style={{ minHeight: 44, textAlign: "left", padding: "8px 12px" }}
            >
              <strong style={{ display: "block" }}>{account.label}</strong>
              <span style={{ fontSize: 12 }}>{account.id}</span>
            </button>
          ))}
        </div>
      </ZeroBaseSheet>

      <ZeroBaseSheet
        open={picker === "window"}
        onOpenChange={(open) => setPicker(open ? "window" : null)}
        title="Choose evidence window"
        regionEl="evidence-window-picker"
        side="bottom"
      >
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {[
            ["Last 7 days", 7],
            ["Last 28 days", 28],
            ["Last 90 days", 90],
          ].map(([label, days]) => {
            const end = new Date();
            const start = new Date(end);
            start.setUTCDate(start.getUTCDate() - Number(days) + 1);
            return (
              <button
                type="button"
                key={String(days)}
                onClick={() => replaceScope({
                  start: start.toISOString().slice(0, 10),
                  end: end.toISOString().slice(0, 10),
                })}
                style={{ minHeight: 44, textAlign: "left", padding: "8px 12px" }}
              >
                {String(label)}
              </button>
            );
          })}
        </div>
      </ZeroBaseSheet>
      </AppShell>
    </WorkspaceContextProvider>
  );
}
