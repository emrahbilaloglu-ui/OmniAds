// @vitest-environment jsdom

import { useQuery } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CopiesPage from "@/app/(dashboard)/platforms/meta/copies/legacy-page";
import type { MetaCopyApiRow } from "@/app/api/meta/copies/route";

const appState = vi.hoisted(() => ({
  selectedBusinessId: null as string | null,
}));

const navigationState = vi.hoisted(() => ({
  pathname: "/platforms/meta/copies",
  providerAccountId: "",
}));

const queryState = vi.hoisted(() => ({
  accounts: undefined as unknown,
  accountsError: null as Error | null,
  accountsLoading: false,
  copies: undefined as unknown,
  copiesError: null as Error | null,
  copiesLoading: false,
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
    selector: (state: { selectedBusinessId: string | null }) => unknown,
  ) => selector(appState),
}));

vi.mock("@tanstack/react-query", () => ({
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

function buildCopyApiRow(input?: {
  id?: string;
  accountId?: string;
  text?: string;
  angle?: string | null;
  variants?: string[];
}): MetaCopyApiRow {
  const id = input?.id ?? "copy_1";
  const text = input?.text ?? "Real copy";
  const row = {
    id,
    ad_id: `ad_${id}`,
    creative_id: `creative_${id}`,
    post_id: null,
    name: text,
    campaign_id: "campaign_1",
    campaign_name: "Prospecting",
    adset_id: "adset_1",
    adset_name: "Broad",
    account_id: input?.accountId ?? "act_1",
    account_name: "Main",
    currency: "USD",
    launch_date: "2026-07-01",
    primary_text: text,
    headline: "Headline",
    description: "Description",
    copy_text: text,
    copy_variants: input?.variants ?? [text],
    headline_variants: ["Headline"],
    description_variants: ["Description"],
    normalized_copy_key: text.toLowerCase(),
    copy_source: "creative.body",
    copy_asset_type: "primary_text",
    copy_debug_sources: ["creative.body"],
    unresolved_reason: null,
    preview_url: null,
    thumbnail_url: null,
    image_url: null,
    table_thumbnail_url: null,
    card_preview_url: null,
    is_catalog: false,
    preview_state: "unavailable",
    preview: {
      render_mode: "unavailable",
      image_url: null,
      video_url: null,
      poster_url: null,
      source: null,
      is_catalog: false,
    },
    spend: 100,
    purchase_value: 300,
    roas: 3,
    cpa: 20,
    cpc_link: 2,
    cpm: 10,
    ctr_all: 2,
    purchases: 5,
    impressions: 1_000,
    link_clicks: 40,
    add_to_cart: 12,
    landing_page_views: 30,
    initiate_checkout: 8,
    leads: 0,
    messages: 0,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    click_to_purchase: 12.5,
    thumbstop: null,
    first_frame_retention: null,
    aov: 60,
    click_to_atc_ratio: 30,
    atc_to_purchase_ratio: 41.7,
  } as MetaCopyApiRow & {
    ai_tags?: { messagingAngle?: string[] };
  };
  if (input?.angle) row.ai_tags = { messagingAngle: [input.angle] };
  return row;
}

beforeEach(() => {
  appState.selectedBusinessId = null;
  navigationState.pathname = "/platforms/meta/copies";
  navigationState.providerAccountId = "";
  queryState.accounts = undefined;
  queryState.accountsError = null;
  queryState.accountsLoading = false;
  queryState.copies = undefined;
  queryState.copiesError = null;
  queryState.copiesLoading = false;
  freshness.mockReset();
  useQueryMock.mockReset();
  useQueryMock.mockImplementation(
    (options: { queryKey?: readonly unknown[] }) => {
      const accountQuery = options.queryKey?.[0] === "meta-provider-accounts";
      const data = accountQuery ? queryState.accounts : queryState.copies;
      const error = accountQuery
        ? queryState.accountsError
        : queryState.copiesError;
      const loading = accountQuery
        ? queryState.accountsLoading
        : queryState.copiesLoading;
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

describe("CopiesPage exact integration", () => {
  it("uses authorized route props and the shell-owned dashboard date window", () => {
    appState.selectedBusinessId = "biz_store";
    navigationState.pathname = "/c/biz_authorized/creative/copies";
    navigationState.providerAccountId = "act_url";
    queryState.copies = {
      rows: [buildCopyApiRow({ accountId: "act_authorized" })],
      meta: { warehouseObservedAt: "2026-07-29T00:00:00.000Z" },
    };

    render(
      <CopiesPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["meta-provider-accounts", "biz_authorized"],
        enabled: false,
      }),
    );
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: [
          "copies-creatives",
          "biz_authorized",
          "act_authorized",
          "2026-07-01",
          "2026-07-28",
          "copy",
        ],
        enabled: true,
      }),
    );
    expect(screen.getByTestId("copies-studio-page")).toBeInTheDocument();
    expect(document.querySelector('[data-plan-gate="growth"]')).not.toBeNull();
    expect(screen.getByRole("link", { name: "Inbox" })).toHaveAttribute(
      "href",
      "/c/biz_authorized/creative/inbox?providerAccountId=act_authorized&start=2026-07-01&end=2026-07-28",
    );
    expect(freshness).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz_authorized" }),
    );
    expect(screen.queryByText("act_url")).not.toBeInTheDocument();
  });

  it("renders the exact nine copy columns and honest unsupported values", () => {
    queryState.copies = {
      rows: [buildCopyApiRow()],
      meta: {},
    };

    const { container } = render(
      <CopiesPage businessId="biz_1" providerAccountId="act_1" />,
    );

    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual([
      "Copy",
      "Angle",
      "Ads",
      "Spend",
      "See more",
      "CTR",
      "Engage",
      "CVR",
      "ROAS",
    ]);
    expect(container.querySelectorAll("[data-copy-angle]")).toHaveLength(4);
    const row = container.querySelector('[data-copy-row="copy_1"]');
    expect(row).not.toBeNull();
    const cells = Array.from(row!.querySelectorAll("td")).map((cell) =>
      cell.textContent?.trim(),
    );
    expect(cells[1]).toBe("—");
    expect(cells[2]).toBe("—");
    expect(cells[4]).toBe("—");
    expect(cells[6]).toBe("—");
    expect(screen.queryByText("Compare")).not.toBeInTheDocument();
    expect(screen.queryByText("Usage Map")).not.toBeInTheDocument();
    expect(screen.queryByText("Ad account")).not.toBeInTheDocument();
  });

  it("aggregates only a real server messaging angle and pads absent slots with em dashes", () => {
    queryState.copies = {
      rows: [
        buildCopyApiRow({ angle: "Social Proof" }),
        buildCopyApiRow({ id: "copy_2", text: "Untagged copy" }),
      ],
      meta: {},
    };

    const { container } = render(
      <CopiesPage businessId="biz_1" providerAccountId="act_1" />,
    );

    expect(container.querySelector('[data-copy-angle="social-proof"]')).not.toBeNull();
    expect(screen.getAllByText("Social Proof").length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-copy-angle^="unavailable-"]')).toHaveLength(3);
    expect(screen.queryByText("Problem-aware")).not.toBeInTheDocument();
  });

  it("opens the read-only drawer with served alternatives and closes on Escape", () => {
    queryState.copies = {
      rows: [
        buildCopyApiRow({
          variants: ["Real copy", "Served alternative"],
        }),
      ],
      meta: {},
    };

    const { container } = render(
      <CopiesPage businessId="biz_1" providerAccountId="act_1" />,
    );
    fireEvent.click(container.querySelector('[data-copy-row="copy_1"]')!);

    expect(screen.getByTestId("copy-detail-drawer")).toBeInTheDocument();
    expect(screen.getByText("“Served alternative”")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in Launchpad →" })).toHaveAttribute(
      "href",
      "/platforms/meta/launchpad?businessId=biz_1&providerAccountId=act_1",
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("copy-detail-drawer")).not.toBeInTheDocument();
  });

  it("keeps a server-refused account null instead of using URL scope", () => {
    navigationState.providerAccountId = "act_url";

    render(<CopiesPage businessId="biz_1" providerAccountId={null} />);

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: [
          "copies-creatives",
          "biz_1",
          "",
          "2026-07-01",
          "2026-07-28",
          "copy",
        ],
        enabled: false,
      }),
    );
    expect(
      screen.getByText("Select one assigned Meta account to load copy performance."),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("act_url");
  });

  it("shows the query error rather than an empty-success message", () => {
    queryState.copiesError = new Error("copy read failed");

    render(<CopiesPage businessId="biz_1" providerAccountId="act_1" />);

    expect(screen.getByText("copy read failed")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "No copy performance is available for this account and date range.",
      ),
    ).not.toBeInTheDocument();
  });
});
