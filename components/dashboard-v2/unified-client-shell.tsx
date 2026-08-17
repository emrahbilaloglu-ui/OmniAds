"use client";

import { useEffect, useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { AuthBootstrap } from "@/components/layout/auth-bootstrap";
import { DashboardFrame } from "@/components/layout/dashboard-frame";
import { WorkspaceContextProvider } from "@/components/workspace/workspace-context-provider";
import type { ProviderScopeCatalog } from "@/lib/zero-base/provider-scope-server";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";
import { QueryProvider } from "@/providers/query-provider";
import { useAppStore } from "@/store/app-store";

type DashboardProviderId = "meta" | "google";

interface SearchParamReader {
  get(name: string): string | null;
}

function routeSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/**
 * Resolve provider scope from the two canonical route families without
 * trusting an arbitrary substring elsewhere in the URL.
 */
export function dashboardProviderForPathname(
  pathname: string,
): DashboardProviderId | null {
  const segments = routeSegments(pathname);
  const surface =
    segments[0] === "app"
      ? segments[1]
      : segments[0] === "c" && segments.length >= 3
        ? segments[2]
        : null;

  if (surface === "meta" || surface === "creative") return "meta";
  if (surface === "google") return "google";
  return null;
}

function isCreativeEvidencePath(pathname: string): boolean {
  const segments = routeSegments(pathname);
  return (
    (segments[0] === "app" && segments[1] === "creative") ||
    (segments[0] === "c" && segments.length >= 3 && segments[2] === "creative")
  );
}

/**
 * The path identifies the route family; the authorized business id always
 * comes from the server envelope, never from the client-controlled segment.
 */
export function scopedEnvelopeBusinessId(
  pathname: string,
  envelope: WorkspaceContextEnvelope,
): string | null {
  const segments = routeSegments(pathname);
  return segments[0] === "c" && segments.length >= 2
    ? (envelope.business?.id ?? null)
    : null;
}

/**
 * Enrich the server-authorized envelope with URL-selected presentation scope.
 *
 * The URL can select only an account already present in the server-resolved
 * provider catalog. It cannot introduce an account or business. With multiple
 * assigned accounts and no valid selection, the existing portfolio semantics
 * are preserved; a single assigned account remains the honest default.
 */
export function buildEffectiveDashboardEnvelope(input: {
  envelope: WorkspaceContextEnvelope;
  pathname: string;
  searchParams: SearchParamReader;
  providerCatalogs: readonly ProviderScopeCatalog[];
}): WorkspaceContextEnvelope {
  const providerId = dashboardProviderForPathname(input.pathname);
  const catalog =
    input.providerCatalogs.find((item) => item.provider === providerId) ?? null;
  const requestedAccountId = input.searchParams.get("providerAccountId");
  const selectedAccount =
    catalog?.accounts.find((account) => account.id === requestedAccountId) ??
    (catalog?.accounts.length === 1 ? catalog.accounts[0] : null);

  const creativeEvidencePath = isCreativeEvidencePath(input.pathname);
  const start = input.searchParams.get("start");
  const end = input.searchParams.get("end");
  const evidenceWindowLabel =
    creativeEvidencePath && start && end
      ? `${start} → ${end}`
      : creativeEvidencePath
        ? "Last 28 days"
        : input.envelope.evidence.windowLabel;

  return {
    ...input.envelope,
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
    evidence: {
      ...input.envelope.evidence,
      windowLabel: evidenceWindowLabel,
    },
  };
}

function EnvelopeScopedDashboardFrame({
  envelope,
  pathname,
  children,
}: {
  envelope: WorkspaceContextEnvelope;
  pathname: string;
  children: React.ReactNode;
}) {
  const scopedBusinessId = scopedEnvelopeBusinessId(pathname, envelope);
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const hasHydrated = useAppStore((state) => state.hasHydrated);
  const selectBusiness = useAppStore((state) => state.selectBusiness);
  const scopedMembershipExists = Boolean(
    scopedBusinessId &&
      businesses.some((business) => business.id === scopedBusinessId),
  );

  useEffect(() => {
    if (
      !scopedBusinessId ||
      !hasHydrated ||
      !scopedMembershipExists ||
      selectedBusinessId === scopedBusinessId
    ) {
      return;
    }
    // `selectBusiness` changes only the active selection and refuses ids that
    // are not already in the authenticated membership list. It neither
    // replaces memberships nor claims that auth bootstrap has completed.
    selectBusiness(scopedBusinessId);
  }, [
    hasHydrated,
    scopedBusinessId,
    scopedMembershipExists,
    selectBusiness,
    selectedBusinessId,
  ]);

  const storeHasBusinessState =
    businesses.length > 0 || selectedBusinessId !== null;
  const scopedStoreIsMisaligned = Boolean(
    scopedBusinessId &&
      (storeHasBusinessState || hasHydrated) &&
      (!scopedMembershipExists || selectedBusinessId !== scopedBusinessId),
  );

  // Never mount rail/topbar query hooks while a scoped route and the session
  // store disagree. The server shell can render before hydration when the
  // store is empty; once persisted state exists it must first bind to A.
  if (scopedStoreIsMisaligned) {
    return <div data-dashboard-scope-binding="pending" aria-hidden="true" />;
  }

  return (
    <DashboardFrame userName={envelope.actor.name}>{children}</DashboardFrame>
  );
}

/**
 * Shared Dashboard v2 chrome for the readable and business-scoped canonical
 * route families. Authorization and provider assignments remain server-owned;
 * this client boundary can only narrow or describe the supplied envelope.
 */
export function UnifiedDashboardClientShell({
  envelope,
  providerCatalogs = [],
  children,
}: {
  envelope: WorkspaceContextEnvelope;
  providerCatalogs?: ProviderScopeCatalog[];
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const effectiveEnvelope = useMemo(
    () =>
      buildEffectiveDashboardEnvelope({
        envelope,
        pathname,
        searchParams,
        providerCatalogs,
      }),
    [envelope, pathname, providerCatalogs, searchParams],
  );

  return (
    <QueryProvider>
      <WorkspaceContextProvider value={effectiveEnvelope}>
        <AuthBootstrap />
        <EnvelopeScopedDashboardFrame
          envelope={effectiveEnvelope}
          pathname={pathname}
        >
          {children}
        </EnvelopeScopedDashboardFrame>
      </WorkspaceContextProvider>
    </QueryProvider>
  );
}
