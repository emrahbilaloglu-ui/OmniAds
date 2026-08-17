"use client";

import { useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CreativeStudioExact } from "@/components/creatives/CreativeStudioExact";
import type {
  CreativeStudioAudiencesModel,
  CreativeStudioBreakdown,
  CreativeStudioTabId,
} from "@/components/creatives/creative-studio-exact-types";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { dashboardHrefForRouteFamily } from "@/lib/dashboard-v2/screen-registry";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import { useAppStore } from "@/store/app-store";

export interface MetaAudiencesPageProps {
  businessId?: string;
  providerAccountId?: string | null;
}

const LEGACY_TAB_HREFS: Record<CreativeStudioTabId, string> = {
  assets: "/platforms/meta/creatives",
  copies: "/platforms/meta/copies",
  "landing-pages": "/platforms/meta/landing-pages",
  inbox: "/platforms/meta/creative-inbox",
  audiences: "/platforms/meta/audiences",
};

const BREAKDOWN_TITLES = [
  ["frequency", "Frequency", "exposures / user"],
  ["age", "Age", "spend share · ROAS"],
  ["gender", "Gender", "spend share · ROAS"],
  ["placement", "Placement", "spend share · ROAS"],
  ["platform", "Platform", "spend share · ROAS"],
] as const;

function unavailableBreakdowns(): CreativeStudioBreakdown[] {
  return BREAKDOWN_TITLES.map(([id, title, subtitle]) => ({
    id,
    title,
    subtitle,
    note: null,
    rows: [],
  }));
}

export default function MetaAudiencesPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
}: MetaAudiencesPageProps = {}) {
  const pathname = usePathname() || "/platforms/meta/audiences";
  const searchParams = useSearchParams();
  const storeBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceResolved = useAppStore((state) => state.workspaceResolved);
  const hasAuthorizedScope = authorizedBusinessId !== undefined;
  const businessId = hasAuthorizedScope ? authorizedBusinessId : storeBusinessId ?? "";
  const providerAccountId = hasAuthorizedScope
    ? authorizedProviderAccountId?.trim() || null
    : searchParams?.get("providerAccountId")?.trim() || null;
  const message = providerAccountId
    ? "Audience-level creative evidence is unavailable for this assigned Meta account."
    : "Select one assigned Meta ad account.";
  const model: CreativeStudioAudiencesModel = {
    state: providerAccountId ? "empty" : "account_required",
    message,
    summaries: Array.from({ length: 4 }, (_, index) => ({
      id: `unavailable-${index + 1}`,
      name: "—",
      status: null,
      tone: "neutral" as const,
      currency: null,
      spend: null,
      roas: null,
      frequency: null,
      note: null,
    })),
    breakdowns: unavailableBreakdowns(),
    matrixColumns: [],
    matrixRows: [],
  };
  const tabHrefs = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(LEGACY_TAB_HREFS).map(([tab, href]) => [
          tab,
          dashboardHrefForRouteFamily(
            buildMetaScopedHref(href, { businessId, providerAccountId }),
            pathname,
          ),
        ]),
      ) as Record<CreativeStudioTabId, string>,
    [businessId, pathname, providerAccountId],
  );

  useTierZeroFreshness({
    surface: "creative_studio",
    isLoading: !workspaceResolved && !hasAuthorizedScope,
    isFetching: false,
    error: null,
    partialReason: message,
    asOf: null,
    businessId: businessId || null,
  });

  if (!hasAuthorizedScope && workspaceResolved && !businessId) return <BusinessEmptyState />;

  return (
    <main data-testid="audiences-studio-page" data-audiences-state={model.state}>
      <CreativeStudioExact
        activeTab="audiences"
        audiences={model}
        counts={{}}
        tabHrefs={tabHrefs}
      />
    </main>
  );
}
