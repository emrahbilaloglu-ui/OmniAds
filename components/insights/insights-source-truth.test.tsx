// @vitest-environment jsdom

/**
 * WP-21 source truth, re-homed.
 *
 * These assertions used to live in
 * `components/zero-base/analytics/analytics-source-truth.test.tsx`, against
 * `AnalyticsSourceClient` and `SeoClient`. Batch 11 deleted those clients — the
 * canonical analytics leaves now mount the exact Insights screens — so the file
 * went with its subject. The defect it existed to prevent did not: the clients
 * read connection state off their own report payload, so a healthy GA4 or
 * Search Console read rendered its own provider as down.
 *
 * `InsightsChrome` is what renders that posture now. It is wired to the
 * integration authority and to nothing else, and this file pins that:
 *
 *  1. a connected, serving provider is never drawn as down,
 *  2. "down" is claimed only when the authority says disconnected,
 *  3. an authority that has not been read yet reads as unknown, not down,
 *  4. no provider that supplied none of the numbers gets a panel beside them.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type {
  IntegrationProvider,
  ProviderDomainState,
} from "@/store/integrations-store";
import { buildDefaultProviderDomains } from "@/store/integrations-support";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

const storeMocks = vi.hoisted(() => ({
  domainsByBusinessId: {} as Record<string, unknown>,
  selectedBusinessId: null as string | null,
  businesses: [] as Array<Record<string, unknown>>,
  bootstrapStatus: "ready" as "idle" | "loading" | "ready",
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedBusinessId: storeMocks.selectedBusinessId,
      businesses: storeMocks.businesses,
    }),
}));
vi.mock("@/store/integrations-store", () => ({
  useIntegrationsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ domainsByBusinessId: storeMocks.domainsByBusinessId }),
}));
vi.mock("@/hooks/use-business-integrations-bootstrap", () => ({
  useBusinessIntegrationsBootstrap: () => ({
    isBootstrapping: storeMocks.bootstrapStatus === "loading",
    bootstrapStatus: storeMocks.bootstrapStatus,
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/insights/analytics",
}));
vi.mock("@/components/date-range/DateRangePicker", () => ({
  DateRangePicker: () => React.createElement("div", null, "date-range"),
  getTodayIsoForTimeZone: () => "2026-08-17",
}));
vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [{ rangePreset: "last_28_days" }, vi.fn()],
}));

const { InsightsChrome } = await import("@/components/insights/InsightsChrome");

const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

/**
 * A provider domain that can actually serve a read — connected *and* carrying
 * whatever else its read gate demands. `search_console` also needs the `google`
 * domain beside it; see `googleWithSearchConsoleScope`.
 */
function connected(
  provider: IntegrationProvider,
  overrides: Partial<ProviderDomainState["connection"]> = {},
): ProviderDomainState {
  const base = buildDefaultProviderDomains()[provider];
  return {
    ...base,
    connection: {
      ...base.connection,
      status: "connected",
      providerAccountId: "properties/12345678",
      providerAccountName: "Grandmix GA4",
      // The facts the read gates check: GA4 wants a selected property,
      // Search Console a selected site.
      selectedEntityId:
        provider === "search_console" ? "sc-domain:example.com" : "12345678",
      ...overrides,
    },
    discovery: { ...base.discovery, status: "ready" },
  };
}

/** The `google` row Search Console borrows its credential from. */
function googleWithSearchConsoleScope(): ProviderDomainState {
  return connected("google", {
    providerAccountId: "1234567890",
    providerAccountName: "Google Ads",
    selectedEntityId: null,
    scopes: `https://www.googleapis.com/auth/adwords ${SEARCH_CONSOLE_SCOPE}`,
  });
}

function domains(overrides: Partial<Record<IntegrationProvider, ProviderDomainState>>) {
  return { ...buildDefaultProviderDomains(), ...overrides };
}

/** The chip whose label cell reads `provider`, as a plain string. */
function chipText(label: string): string {
  const labelNode = screen.getByText(label);
  return (labelNode.closest("span")?.textContent ?? "").trim();
}

beforeEach(() => {
  storeMocks.domainsByBusinessId = {};
  storeMocks.selectedBusinessId = null;
  storeMocks.businesses = [];
  storeMocks.bootstrapStatus = "ready";
});

afterEach(cleanup);

describe("WP-21 Insights source truth", () => {
  it("does not render GA4 as down when GA4 is connected and serving", () => {
    storeMocks.domainsByBusinessId = {
      [BUSINESS]: domains({ ga4: connected("ga4") }),
    };

    render(
      <InsightsChrome businessId={BUSINESS}>
        {/* The tab body's own healthy payload, rendered beside the chips. */}
        <div>4,210 sessions · 2.8% purchase CVR</div>
      </InsightsChrome>,
    );

    expect(chipText("GA4")).toContain("connected");
    expect(chipText("GA4")).not.toContain("not connected");
    // The payload the body renders cannot reach the chip: the chip's only
    // inputs are the route and the two provider states.
    expect(screen.getByText("4,210 sessions · 2.8% purchase CVR")).toBeTruthy();
  });

  it("renders GA4 as down only when the authority says it is disconnected", () => {
    storeMocks.domainsByBusinessId = { [BUSINESS]: domains({}) };

    render(
      <InsightsChrome businessId={BUSINESS}>
        <div>body</div>
      </InsightsChrome>,
    );

    expect(chipText("GA4")).toContain("not connected");
  });

  it("reports an unread authority as unknown rather than down", () => {
    // The manifest fetch has not completed, so nothing is known about either
    // provider yet. Claiming "not connected" here is the WP-21 defect.
    storeMocks.bootstrapStatus = "loading";
    storeMocks.domainsByBusinessId = {};

    render(
      <InsightsChrome businessId={BUSINESS}>
        <div>body</div>
      </InsightsChrome>,
    );

    expect(chipText("GA4")).toContain("reading status");
    expect(chipText("GA4")).not.toContain("not connected");
    expect(chipText("Search Console")).toContain("reading status");
  });

  it("does not render Search Console as down on a healthy Search Console read", () => {
    storeMocks.domainsByBusinessId = {
      [BUSINESS]: domains({
        search_console: connected("search_console"),
        // Healthy means the borrowed Google grant is there too — without it
        // the reads 401 and "connected" would be the lie this file exists for.
        google: googleWithSearchConsoleScope(),
      }),
    };

    render(
      <InsightsChrome businessId={BUSINESS}>
        <div>48.2K organic clicks</div>
      </InsightsChrome>,
    );

    expect(chipText("Search Console")).toContain("connected");
    expect(chipText("Search Console")).not.toContain("not connected");
    // SEO reads Search Console, not GA4 — GA4's own state is reported on its
    // own terms and is not inferred from this read.
    expect(chipText("GA4")).toContain("not connected");
  });

  /**
   * E5, both cases read off production on 2026-08-17:
   *
   *   business   provider         status         has_search_console_scope
   *   BskTR      google           disconnected   true
   *   BskTR      search_console   connected      —
   *   Grandmix   ga4              connected      —   (no ga4PropertyId)
   *
   * On both, the header chip said "connected" while the tab body refused the
   * read. The header may not out-claim the body.
   */
  describe("effective capability, not the connection row", () => {
    it("does not call Search Console connected when the Google grant it borrows is gone", () => {
      // BskTR: the `search_console` row is connected and a site is chosen, but
      // `google` is disconnected, so `resolveSearchConsoleContext` throws
      // `search_console_reconnect_required` and every read 401s.
      storeMocks.domainsByBusinessId = {
        [BUSINESS]: domains({ search_console: connected("search_console") }),
      };

      render(
        <InsightsChrome businessId={BUSINESS}>
          <div>
            Reconnect Search Console to unlock SEO Intelligence — Google
            integration is required for Search Console. Please reconnect Google.
          </div>
        </InsightsChrome>,
      );

      expect(chipText("Search Console")).toContain("reconnect Google");
      // Neither the lie nor the opposite lie: the row *is* connected, so
      // telling the operator to connect it would send them nowhere.
      expect(chipText("Search Console")).not.toContain("not connected");
    });

    it("does not call GA4 connected when no property is selected", () => {
      // Grandmix: `ga4` is connected, and the OAuth callback already wrote the
      // Google *user* id into provider_account_id — but no property was ever
      // chosen, so `resolveGa4AnalyticsContext` throws `no_property_selected`
      // and the Analytics tab cannot render at all.
      storeMocks.domainsByBusinessId = {
        [BUSINESS]: domains({
          ga4: connected("ga4", {
            providerAccountId: "117482910294857201938",
            providerAccountName: "Grandmix Google",
            selectedEntityId: null,
          }),
        }),
      };

      render(
        <InsightsChrome businessId={BUSINESS}>
          <div>body</div>
        </InsightsChrome>,
      );

      expect(chipText("GA4")).toContain("select property");
      expect(chipText("GA4")).not.toContain("not connected");
    });
  });

  it("claims no panel for a provider that supplied none of the numbers", () => {
    storeMocks.domainsByBusinessId = {
      [BUSINESS]: domains({
        ga4: connected("ga4"),
        // Shopify is connected but supplies nothing on this surface.
        shopify: connected("shopify"),
      }),
    };

    const { container } = render(
      <InsightsChrome businessId={BUSINESS}>
        <div>4,210 sessions</div>
      </InsightsChrome>,
    );

    expect(screen.queryByText("Shopify")).toBeNull();
    // Exactly two source chips, and they are the two providers this surface
    // actually reads. The icons are decorative, so the chips are counted by
    // their platform marks.
    expect(
      Array.from(container.querySelectorAll("img")).map((image) =>
        image.getAttribute("src"),
      ),
    ).toEqual(["/platform-logos/GA4.svg", "/platform-logos/searchconsole.svg"]);
  });
});
