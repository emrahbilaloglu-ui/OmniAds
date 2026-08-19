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
  commercialTargets: undefined as unknown,
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
  /**
   * The count `/api/meta/copies` publishes for this row. `undefined` models a
   * response that carries no count at all, which must stay an em dash — the
   * page may not re-derive it from the rows it received. See
   * `page-support.test.ts` for the same law over the real route.
   */
  associatedAdsCount?: number | null;
}): MetaCopyApiRow {
  const id = input?.id ?? "copy_1";
  const text = input?.text ?? "Real copy";
  const row = {
    id,
    ad_id: `ad_${id}`,
    associated_ads_count:
      input && "associatedAdsCount" in input ? input.associatedAdsCount : 1,
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
  queryState.commercialTargets = undefined;
  freshness.mockReset();
  useQueryMock.mockReset();
  useQueryMock.mockImplementation(
    (options: { queryKey?: readonly unknown[] }) => {
      const accountQuery = options.queryKey?.[0] === "meta-provider-accounts";
      const targetsQuery = options.queryKey?.[0] === "copies-commercial-targets";
      const data = targetsQuery
        ? queryState.commercialTargets
        : accountQuery
          ? queryState.accounts
          : queryState.copies;
      const error = targetsQuery
        ? null
        : accountQuery
          ? queryState.accountsError
          : queryState.copiesError;
      const loading = targetsQuery
        ? false
        : accountQuery
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
    // ITEM 17 — the shared Studio builder now states the window in BOTH live
    // spellings: `window`/`startDate`/`endDate` is what the shell's date control
    // writes and what `usePersistentDateRange` reads back, and `start`/`end` is
    // the Studio's older pair that the shares/briefs/detail routes still read.
    // Both come from the one resolved window this surface measured, so they
    // cannot name different days; `window=custom` is what forbids the
    // destination from re-expanding a preset against its own clock.
    expect(screen.getByRole("link", { name: "Inbox" })).toHaveAttribute(
      "href",
      "/c/biz_authorized/creative/inbox?providerAccountId=act_authorized" +
        "&window=custom&startDate=2026-07-01&endDate=2026-07-28" +
        "&start=2026-07-01&end=2026-07-28",
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
    // Angle, See more and Engage stay dashed: the copies response carries no
    // angle field and no see-more/engagement counters, and a guess there would
    // be worse than a dash.
    expect(cells[1]).toBe("—");
    expect(cells[4]).toBe("—");
    expect(cells[6]).toBe("—");
    // Ads is different — it is the server's own count of the distinct ads it
    // merged into this row, rendered as served. The page does not recompute it:
    // `?groupBy=copy` already collapsed the per-ad rows, so any client-side
    // grouping of the response could only ever answer 1.
    expect(cells[2]).toBe("1");
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
    /**
     * "Draft →" used to be a LINK to
     * `/platforms/meta/launchpad?businessId=…&providerAccountId=…`, and the
     * footnote told the operator the line's evidence was attached to it.
     * Nothing was attached: no copy id, no alternate text, no evidence window,
     * no lineage — and a URL parameter cannot mint any of them.
     *
     * It must never become a link again. Preparing a draft is a POST the server
     * answers by re-reading the served copy for this creative and window, so
     * the control is a BUTTON: an href could only carry claims. "Draft all"
     * stays disabled outright because a handoff carries one line by
     * construction and there is no honest implementation of "all".
     */
    expect(screen.queryByRole("link", { name: "Draft →" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draft →" })).toBeEnabled();
    expect(
      screen.queryByRole("link", { name: "Draft all 1 in Launchpad" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Draft all 1 in Launchpad" }),
    ).toBeDisabled();
    expect(screen.queryByText(/evidence attached/)).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("copy-detail-drawer")).not.toBeInTheDocument();
  });

  /**
   * The Copy -> Launchpad handoff, end to end on this side of the wire.
   *
   * What must travel: the creative the line was served with, the exact line,
   * and the window the copies table was actually showing. What must NOT travel:
   * the line itself in a URL, or any claim about authority. The response is a
   * single-use reference and that is the only thing the navigation carries.
   */
  it("prepares a draft by naming the creative, the line and the window to the server", async () => {
    queryState.copies = {
      rows: [buildCopyApiRow({ variants: ["Real copy", "Served alternative"] })],
      meta: {},
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ handoff: `${"a".repeat(8)}-handoff-reference` }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign, href: "http://localhost/platforms/meta/copies" },
    });

    const { container } = render(
      <CopiesPage businessId="biz_1" providerAccountId="act_1" />,
    );
    fireEvent.click(container.querySelector('[data-copy-row="copy_1"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Draft →" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(url).toBe("/api/meta/launchpad-handoff/copy");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      businessId: "biz_1",
      providerAccountId: "act_1",
      // The provider creative, not the synthetic copy-bucket row id.
      creativeId: "creative_copy_1",
      alternateText: "Served alternative",
      start: "2026-07-01",
      end: "2026-07-28",
    });

    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const destination = String(assign.mock.calls[0]![0]);
    expect(destination).toContain("/platforms/meta/launchpad");
    expect(destination).toContain("handoff=");
    // The line, the creative and the window are read back out of the record
    // server-side; none of them may ride in the address bar.
    expect(destination).not.toContain("Served%20alternative");
    expect(destination).not.toContain("creativeId");
    expect(destination).not.toContain("start=");
  });

  // A refusal is restated verbatim and NOTHING is opened. Navigating to
  // Launchpad anyway would read as success.
  it("restates a refused draft and opens nothing", async () => {
    queryState.copies = {
      rows: [buildCopyApiRow({ variants: ["Real copy", "Served alternative"] })],
      meta: {},
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({
          error: "copy_identity_missing",
          message:
            "That copy line is not in the current served universe for this account and window.",
        }),
      })) as unknown as typeof fetch,
    );
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign, href: "http://localhost/platforms/meta/copies" },
    });

    const { container } = render(
      <CopiesPage businessId="biz_1" providerAccountId="act_1" />,
    );
    fireEvent.click(container.querySelector('[data-copy-row="copy_1"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Draft →" }));

    await screen.findByText(/not in the current served universe/);
    expect(assign).not.toHaveBeenCalled();
  });

  it("reads the operator's own target pack into the drawer's ROAS tile", () => {
    queryState.copies = { rows: [buildCopyApiRow()], meta: {} };
    queryState.commercialTargets = { snapshot: { targetPack: { targetRoas: 2.5 } } };

    const { container } = render(
      <CopiesPage businessId="biz_1" providerAccountId="act_1" />,
    );

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["copies-commercial-targets", "biz_1"],
        enabled: true,
      }),
    );

    fireEvent.click(container.querySelector('[data-copy-row="copy_1"]')!);
    expect(screen.getByText("target 2.50")).toBeInTheDocument();
  });

  it("keeps the ROAS tile's target an em dash when no target pack is configured", () => {
    queryState.copies = { rows: [buildCopyApiRow()], meta: {} };
    queryState.commercialTargets = { snapshot: { targetPack: { targetRoas: null } } };

    const { container } = render(
      <CopiesPage businessId="biz_1" providerAccountId="act_1" />,
    );
    fireEvent.click(container.querySelector('[data-copy-row="copy_1"]')!);

    // An unconfigured target is not a target of zero.
    expect(screen.getByText("target —")).toBeInTheDocument();
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

  /**
   * ITEM 16 — the endpoint's freshness lineage, proven to reach a pixel.
   *
   * `/api/meta/copies` has published `isPartial`, `notReadyReason`,
   * `readSource`, `warehouseObservedAt` and `rowsObservedAt` for a while, and
   * `resolveCopiesFreshness` has known how to read them — but a grep for either
   * symbol found only the endpoint's own test. The page declared its own
   * narrower `MetaCopiesResponse` carrying `warehouseObservedAt` alone and read
   * exactly that, so the client half was a dead seam: a window the server had
   * explicitly declared incomplete arrived on screen looking finished, and a
   * live Meta read was aged by a warehouse write that never touched it.
   *
   * These four cases assert the binding at BOTH ends: the value handed to
   * `useTierZeroFreshness` (which drives the shell's freshness pill), and the
   * sentence rendered into the Copy performance header.
   */
  it("shows the server's own partial reason and refuses the warehouse clock for live rows", () => {
    queryState.copies = {
      status: "partial",
      rows: [buildCopyApiRow()],
      meta: {
        warehouseObservedAt: "2026-07-29T00:00:00.000Z",
        readSource: "current_day_live",
        rowsObservedAt: null,
        rowsObservedAtSource: "live",
        isPartial: true,
        notReadyReason: "Today is still being prepared in the account timezone.",
      },
    };

    render(<CopiesPage businessId="biz_1" providerAccountId="act_1" />);

    const call = freshness.mock.calls.at(-1)?.[0] as {
      asOf: string | null;
      partialReason: string | null;
    };
    // THE TWO CLOCKS STAY APART. `warehouseObservedAt` exists and is NOT quoted,
    // because these rows were read live and no warehouse write describes them.
    expect(call.asOf).toBeNull();
    expect(call.partialReason).toContain(
      "Today is still being prepared in the account timezone.",
    );
    expect(call.partialReason).toContain(
      "These rows were read live from Meta, so the warehouse sync time does not describe them.",
    );

    // And the operator can read it, not just the store.
    expect(
      screen.getByText(
        /Today is still being prepared in the account timezone\..*read live from Meta/,
      ),
    ).toBeInTheDocument();
  });

  it("quotes the warehouse clock, and names it, when the rows came from the warehouse", () => {
    queryState.copies = {
      status: "ok",
      rows: [buildCopyApiRow()],
      meta: {
        warehouseObservedAt: "2026-07-29T06:15:00.000Z",
        readSource: "warehouse",
        rowsObservedAt: "2026-07-29T06:15:00.000Z",
        rowsObservedAtSource: "warehouse",
        isPartial: false,
        notReadyReason: null,
      },
    };

    render(<CopiesPage businessId="biz_1" providerAccountId="act_1" />);

    const call = freshness.mock.calls.at(-1)?.[0] as {
      asOf: string | null;
      partialReason: string | null;
    };
    expect(call.asOf).toBe("2026-07-29T06:15:00.000Z");
    expect(call.partialReason).toBeNull();
    expect(
      screen.getByText("Warehouse rows · age is the warehouse sync clock"),
    ).toBeInTheDocument();
  });

  it("states an unknown lineage rather than borrowing the warehouse clock", () => {
    queryState.copies = {
      status: "ok",
      rows: [buildCopyApiRow()],
      // A response that names no read source at all: the warehouse instant is
      // present but nothing establishes that it describes these rows.
      meta: { warehouseObservedAt: "2026-07-29T06:15:00.000Z" },
    };

    render(<CopiesPage businessId="biz_1" providerAccountId="act_1" />);

    const call = freshness.mock.calls.at(-1)?.[0] as { asOf: string | null };
    expect(call.asOf).toBeNull();
    expect(
      screen.getByText("Row age unavailable · the read did not name its source"),
    ).toBeInTheDocument();
  });

  it("names the demo source rather than calling it unnamed", () => {
    queryState.copies = {
      status: "ok",
      rows: [buildCopyApiRow()],
      // The demo branch of `/api/meta/copies` publishes `readSource: "demo"`
      // with no observation instant, because fixtures were never observed.
      meta: {
        warehouseObservedAt: null,
        readSource: "demo",
        rowsObservedAt: null,
        rowsObservedAtSource: "unknown",
      },
    };

    render(<CopiesPage businessId="biz_1" providerAccountId="act_1" />);

    const call = freshness.mock.calls.at(-1)?.[0] as { asOf: string | null };
    expect(call.asOf).toBeNull();
    expect(
      screen.getByText("Demo rows · fixtures carry no observation time"),
    ).toBeInTheDocument();
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
