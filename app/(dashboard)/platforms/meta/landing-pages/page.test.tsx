// @vitest-environment jsdom

import { useQuery } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LandingPagesPage from "@/app/(dashboard)/platforms/meta/landing-pages/legacy-page";
import { buildCreativeStudioLandingModel } from "@/components/creatives/creative-studio-exact-adapters";
import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";

const appState = vi.hoisted(() => ({
  selectedBusinessId: null as string | null,
  workspaceResolved: true,
}));

const navigationState = vi.hoisted(() => ({
  pathname: "/platforms/meta/landing-pages",
  providerAccountId: "",
}));

const queryState = vi.hoisted(() => ({
  accounts: undefined as unknown,
  accountsError: null as Error | null,
  accountsLoading: false,
  destinations: undefined as unknown,
  destinationsError: null as Error | null,
  destinationsLoading: false,
}));

const freshness = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
  useSearchParams: () =>
    new URLSearchParams(
      navigationState.providerAccountId
        ? `providerAccountId=${navigationState.providerAccountId}`
        : "",
    ),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (
    selector: (state: {
      selectedBusinessId: string | null;
      workspaceResolved: boolean;
    }) => unknown,
  ) => selector(appState),
}));

vi.mock("@tanstack/react-query", () => ({
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: freshness,
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [
    {
      rangePreset: "custom",
      customStart: "2026-07-01",
      customEnd: "2026-07-28",
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    },
    vi.fn(),
  ],
}));

vi.mock("@/components/pricing/PlanGate", () => ({
  PlanGate: ({
    children,
    requiredPlan,
  }: {
    children: React.ReactNode;
    requiredPlan: string;
  }) => <div data-plan-gate={requiredPlan}>{children}</div>,
}));

const useQueryMock = vi.mocked(useQuery);

function buildDestinationRow(input?: {
  id?: string;
  destinationUrl?: string | null;
  spend?: number;
}): MetaCreativeApiRow {
  return {
    id: input?.id ?? "ad_1",
    ad_id: input?.id ?? "ad_1",
    creative_id: `creative_${input?.id ?? "ad_1"}`,
    associated_ads_count: 1,
    account_id: "act_authorized",
    account_name: "Main",
    campaign_id: "campaign_1",
    campaign_name: "Prospecting",
    adset_id: "adset_1",
    adset_name: "Broad",
    currency: "USD",
    name: input?.id ?? "ad_1",
    launch_date: "2026-07-01",
    destination_url:
      input?.destinationUrl === undefined
        ? "https://shop.example/a"
        : input.destinationUrl,
    spend: input?.spend ?? 100,
    purchase_value: 300,
    purchases: 5,
    link_clicks: 40,
    landing_page_views: 30,
  } as unknown as MetaCreativeApiRow;
}

/** The last props the page handed to the Tier-0 freshness bar. */
function lastFreshnessCall() {
  const call = freshness.mock.calls.at(-1);
  expect(call, "the page never reported Tier-0 freshness").toBeDefined();
  return call![0] as {
    isLoading: boolean;
    error: unknown;
    partialReason: string | null;
    asOf: string | null;
  };
}

beforeEach(() => {
  appState.selectedBusinessId = null;
  appState.workspaceResolved = true;
  navigationState.pathname = "/platforms/meta/landing-pages";
  navigationState.providerAccountId = "";
  queryState.accounts = undefined;
  queryState.accountsError = null;
  queryState.accountsLoading = false;
  queryState.destinations = undefined;
  queryState.destinationsError = null;
  queryState.destinationsLoading = false;
  freshness.mockReset();
  useQueryMock.mockReset();
  useQueryMock.mockImplementation(
    (options: { queryKey?: readonly unknown[] }) => {
      const accountQuery = options.queryKey?.[0] === "meta-provider-accounts";
      const data = accountQuery ? queryState.accounts : queryState.destinations;
      const error = accountQuery
        ? queryState.accountsError
        : queryState.destinationsError;
      const loading = accountQuery
        ? queryState.accountsLoading
        : queryState.destinationsLoading;
      return {
        data,
        error,
        fetchStatus: loading ? "fetching" : "idle",
        isError: Boolean(error),
        isFetching: loading,
        isLoading: loading,
        refetch: vi.fn(),
        status: error ? "error" : data ? "success" : "pending",
      } as unknown as ReturnType<typeof useQuery>;
    },
  );
});

afterEach(() => cleanup());

describe("Landing Pages: a timezone lookup is not the table", () => {
  /**
   * WHY: on the server-scoped route the account is handed to the page, so the
   * accounts read only supplies `account.timezone`. Gating `dataState` on it
   * turned a failed name/timezone lookup into "Meta destination data is
   * unavailable." with zero rows — while the destinations fetch for that same
   * account had succeeded and its rows were in hand. A read that did not fail
   * must never be presented as a failure, and a lookup that did fail must not
   * be presented as an empty success either: it becomes a stated partial.
   */
  it("renders the destinations it has when only the account lookup failed", () => {
    queryState.accountsError = new Error("history accounts 503");
    queryState.destinations = {
      rows: [buildDestinationRow({ id: "ad_1" })],
      snapshot_source: "persisted",
      last_synced_at: "2026-07-28T09:15:00.000Z",
    };

    render(
      <LandingPagesPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );

    expect(
      screen
        .getByTestId("landing-pages-studio-page")
        .getAttribute("data-landing-state"),
    ).toBe("ready");
    expect(
      screen.queryByText("Meta destination data is unavailable."),
    ).toBeNull();

    const reported = lastFreshnessCall();
    // The failure is reported, not swallowed — and as a partial, because
    // deriveTierZeroFreshnessState ranks `error` above `partial` and would put
    // the bar straight back into the total-outage state.
    expect(reported.error).toBeNull();
    expect(reported.partialReason).toContain(
      "Dates are shown in UTC because the account timezone is unavailable.",
    );
  });

  /**
   * WHY: in the unscoped branch the accounts read genuinely selects the
   * account, so its failure IS a surface failure. This pins that the fix above
   * did not quietly weaken the branch that still depends on the read.
   */
  it("still fails the surface when the accounts read selects the account", () => {
    appState.selectedBusinessId = "biz_store";
    queryState.accountsError = new Error("history accounts 503");

    render(<LandingPagesPage />);

    expect(
      screen
        .getByTestId("landing-pages-studio-page")
        .getAttribute("data-landing-state"),
    ).toBe("error");
    expect(lastFreshnessCall().error).toBeInstanceOf(Error);
  });
});

describe("Landing Pages: a 200 with no rows is not automatically empty", () => {
  /**
   * WHY: `/api/meta/creatives` answers HTTP 200 with `rows: []` for
   * `no_connection`, `no_access_token` and `no_accounts_assigned` — verdicts
   * returned before the provider is ever called. This page counted rows and
   * nothing else, so all three printed "No Meta-reported destinations are
   * available for this window.", which is a definite statement about the
   * operator's account produced by a read that never happened.
   */
  it.each([
    ["no_connection", "Creative data is temporarily unavailable."],
    ["no_accounts_assigned", "Creative data is temporarily unavailable."],
  ])(
    "reports %s as unavailable rather than an empty window",
    (status, message) => {
      queryState.accounts = [
        { id: "act_authorized", name: "Main", timezone: "UTC" },
      ];
      queryState.destinations = { status, rows: [] };

      render(
        <LandingPagesPage
          businessId="biz_authorized"
          providerAccountId="act_authorized"
        />,
      );

      const surface = screen.getByTestId("landing-pages-studio-page");
      expect(surface.getAttribute("data-landing-state")).toBe("unavailable");
      expect(surface.getAttribute("data-landing-source-status")).toBe(status);
      expect(screen.getAllByText(message).length).toBeGreaterThan(0);
      expect(screen.queryByText("No data for this view.")).toBeNull();
    },
  );

  /**
   * WHY: the distinction only means something if the true-empty case still
   * reads as empty. `status: "ok"` with no rows is a real window in which the
   * account served no destinations, and it must keep saying so.
   */
  it("still calls a served-but-empty window empty", () => {
    queryState.accounts = [
      { id: "act_authorized", name: "Main", timezone: "UTC" },
    ];
    queryState.destinations = { status: "ok", rows: [] };

    render(
      <LandingPagesPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );

    expect(
      screen
        .getByTestId("landing-pages-studio-page")
        .getAttribute("data-landing-state"),
    ).toBe("empty");
    expect(
      screen.getAllByText("No data for this view.").length,
    ).toBeGreaterThan(0);
  });

  /**
   * WHY: a server-declared partial is a served table with a stated gap. The
   * envelope carried `isPartial`/`notReadyReason` and the page dropped both, so
   * a window still being prepared read as a finished one.
   */
  it("states the server's own partial reason alongside its own", () => {
    queryState.accounts = [
      { id: "act_authorized", name: "Main", timezone: "UTC" },
    ];
    queryState.destinations = {
      status: "ok",
      rows: [buildDestinationRow({ id: "ad_1" })],
      isPartial: true,
      notReadyReason:
        "Current-day live Meta creative data is still being prepared.",
      warehouse_observed_at: "2026-08-18T04:59:40.635Z",
    };

    render(
      <LandingPagesPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );

    expect(lastFreshnessCall().partialReason).toBe(
      "Some landing page data is unavailable. Try again.",
    );
  });
});

describe("Landing Pages: the freshness chip reports a measured instant", () => {
  /**
   * WHY: the warehouse path never stamps `last_synced_at` at all — the payload
   * `getMetaCreativesWarehousePayload` returns carries `snapshot_source:
   * "persisted"` and no timestamp — so before `warehouse_observed_at` existed
   * every persisted read here reported "age unknown". The endpoint now
   * publishes `MAX(updated_at)` over the very rows it returned (`meta_ad_daily`
   * for this surface's `groupBy=ad` read), and that observation instant is what
   * the bar must claim.
   */
  it("prefers the warehouse observation instant over the snapshot stamp", () => {
    queryState.accounts = [
      { id: "act_authorized", name: "Main", timezone: "UTC" },
    ];
    queryState.destinations = {
      status: "ok",
      rows: [buildDestinationRow({ id: "ad_1" })],
      snapshot_source: "persisted",
      last_synced_at: "2026-07-28T09:15:00.000Z",
      warehouse_observed_at: "2026-08-18T04:59:40.635Z",
    };

    render(
      <LandingPagesPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );

    expect(lastFreshnessCall().asOf).toBe("2026-08-18T04:59:40.635Z");
  });

  /**
   * WHY: lib/tier-zero-as-of.ts exists because a surface that dates itself
   * from the request is fresh by construction and can never say "stale". The
   * persisted snapshot's `last_synced_at` is a real observation time and is
   * already on the wire (lib/meta/creatives-snapshot-helpers.ts:330), so the
   * page has no excuse to report "age unknown".
   */
  it("dates the table from the persisted snapshot's last_synced_at", () => {
    queryState.accounts = [
      { id: "act_authorized", name: "Main", timezone: "UTC" },
    ];
    queryState.destinations = {
      rows: [buildDestinationRow({ id: "ad_1" })],
      snapshot_source: "persisted",
      last_synced_at: "2026-07-28T09:15:00.000Z",
    };

    render(
      <LandingPagesPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );

    expect(lastFreshnessCall().asOf).toBe("2026-07-28T09:15:00.000Z");
  });

  /**
   * WHY: buildLiveApiResponse stamps `last_synced_at: new Date().toISOString()`
   * (creatives-snapshot-helpers.ts:358). That is the age of the request, which
   * lib/tier-zero-as-of.ts forbids presenting as the age of the data. "Age
   * unknown" is the honest answer here; a reassuring number is not.
   */
  it("refuses the live path's fetch time and keeps age unknown", () => {
    queryState.accounts = [
      { id: "act_authorized", name: "Main", timezone: "UTC" },
    ];
    queryState.destinations = {
      rows: [buildDestinationRow({ id: "ad_1" })],
      snapshot_source: "live",
      last_synced_at: new Date().toISOString(),
    };

    render(
      <LandingPagesPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );

    expect(lastFreshnessCall().asOf).toBeNull();
  });
});

describe("Landing Pages: dropped ads are counted, not swallowed", () => {
  /**
   * WHY: buildCreativeStudioLandingModel skips every row whose landing URL
   * could not be resolved (creative-studio-exact-adapters.ts:243-246). Those
   * ads leave the table, the Ads column and the Spend total together, so a
   * page that says nothing reads as a complete picture of where the money went
   * when it is not. The count the page reports and the rows the adapter kept
   * are asserted against the same input here, so if the adapter's skip rule
   * ever changes, this test — not the operator — finds out.
   */
  it("names how many ads have no resolvable destination", () => {
    const rows = [
      buildDestinationRow({
        id: "ad_1",
        destinationUrl: "https://shop.example/a",
      }),
      buildDestinationRow({ id: "ad_2", destinationUrl: null }),
      buildDestinationRow({ id: "ad_3", destinationUrl: "   " }),
    ];
    queryState.accounts = [
      { id: "act_authorized", name: "Main", timezone: "UTC" },
    ];
    queryState.destinations = {
      rows,
      snapshot_source: "persisted",
      last_synced_at: "2026-07-28T09:15:00.000Z",
    };

    render(
      <LandingPagesPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );

    const model = buildCreativeStudioLandingModel({ rows, state: "ready" });
    expect(model.rows.map((row) => row.id)).toEqual(["https://shop.example/a"]);

    const reason = lastFreshnessCall().partialReason;
    expect(reason).toBe(
      "2 ads have no resolvable destination and are not in this table",
    );

    // The invariant worth pinning: every ad the response carried is either in
    // the table or in the stated count. Nothing may fall between them.
    const adsInTable = model.rows.reduce(
      (total, row) => total + (row.ads ?? 0),
      0,
    );
    const adsReportedMissing = Number(/^(\d+)/.exec(reason!)![1]);
    expect(adsInTable + adsReportedMissing).toBe(rows.length);
  });

  /**
   * WHY: "1 ads" is the tell of a count nobody read back. The reason string is
   * operator-facing prose, not a debug dump.
   */
  it("says it in the singular when one ad was dropped", () => {
    queryState.accounts = [
      { id: "act_authorized", name: "Main", timezone: "UTC" },
    ];
    queryState.destinations = {
      rows: [
        buildDestinationRow({ id: "ad_1" }),
        buildDestinationRow({ id: "ad_2", destinationUrl: null }),
      ],
      snapshot_source: "persisted",
      last_synced_at: "2026-07-28T09:15:00.000Z",
    };

    render(
      <LandingPagesPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );

    expect(lastFreshnessCall().partialReason).toBe(
      "1 ad has no resolvable destination and is not in this table",
    );
  });

  /**
   * WHY: a table that is whole must not claim to be partial. A standing
   * "partial" chip is noise, and noise is how a real partial gets ignored.
   */
  it("reports no partial when every ad resolved a destination", () => {
    queryState.accounts = [
      { id: "act_authorized", name: "Main", timezone: "UTC" },
    ];
    queryState.destinations = {
      rows: [
        buildDestinationRow({ id: "ad_1" }),
        buildDestinationRow({ id: "ad_2" }),
      ],
      snapshot_source: "persisted",
      last_synced_at: "2026-07-28T09:15:00.000Z",
    };

    render(
      <LandingPagesPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );

    expect(lastFreshnessCall().partialReason).toBeNull();
  });
});
