"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import {
  DateRangePicker,
  getTodayIsoForTimeZone,
} from "@/components/date-range/DateRangePicker";
import { InsightsShellExact } from "@/components/insights/InsightsShellExact";
import { buildInsightsShellExactModel } from "@/components/insights/insights-shell-exact-adapter";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import {
  buildDefaultProviderDomains,
  deriveProviderViewState,
} from "@/store/integrations-support";

/**
 * The Insights outer chrome wired to the real integration authority.
 *
 * `businessId` is passed explicitly by the canonical `/c/{businessId}/**`
 * routes, which already authorized it server-side; the preserved `/insights/**`
 * family falls back to the selected business in the app store.
 */
export function InsightsChrome({
  businessId,
  pathname: pathnameOverride,
  children,
}: {
  businessId?: string | null;
  /** Server routes pass their own path; client routes read the router. */
  pathname?: string;
  children: ReactNode;
}) {
  const routerPathname = usePathname();
  const pathname = pathnameOverride ?? routerPathname ?? "/insights/analytics";

  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const scopeId = businessId ?? selectedBusinessId ?? null;

  // Without the bootstrap the store holds defaults, which would read as
  // "not connected" for every business — a claim we have not earned until the
  // manifest has actually been read.
  const { bootstrapStatus } = useBusinessIntegrationsBootstrap(scopeId);

  const domains = useIntegrationsStore((state) =>
    scopeId ? state.domainsByBusinessId[scopeId] : undefined,
  );
  const defaults = buildDefaultProviderDomains();

  const model = buildInsightsShellExactModel({
    pathname,
    ga4: deriveProviderViewState("ga4", domains?.ga4 ?? defaults.ga4),
    searchConsole: deriveProviderViewState(
      "search_console",
      domains?.search_console ?? defaults.search_console,
    ),
    // With no business in scope there is no manifest to read; the unknown
    // state only applies while a scope's own bootstrap is still outstanding.
    authorityRead: scopeId === null || bootstrapStatus === "ready",
  });

  const [dateRange, setDateRange] = usePersistentDateRange();
  // Rolling presets resolve against the workspace clock, not the browser's, so
  // "today" means the same day the GA4 numbers do.
  const workspaceTimeZone =
    businesses.find((business) => business.id === scopeId)?.timezone ?? "UTC";

  return (
    <InsightsShellExact
      model={model}
      dateControl={
        <DateRangePicker
          variant="v2"
          showComparisonTrigger={false}
          value={dateRange}
          onChange={setDateRange}
          testId="insights-date-range-picker"
          label="Date range"
          referenceDate={getTodayIsoForTimeZone(workspaceTimeZone)}
          timeZoneLabel={workspaceTimeZone}
        />
      }
    >
      {children}
    </InsightsShellExact>
  );
}
