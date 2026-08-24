// @vitest-environment jsdom

import { useQuery } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CreativeStudioPage from "@/app/(dashboard)/platforms/meta/creatives/legacy-page";
import { cardForDecision } from "@/app/api/creatives/briefing/card-serialization";
import { buildMetaCreativeApiRow } from "@/lib/meta/creatives-service-support";
import { groupRows } from "@/lib/meta/creatives-row-mappers";
import {
  buildCreativeUsageMap,
  buildFallbackAdRawRow,
  hydrateWarehouseCreativeMetrics,
} from "@/lib/meta/creatives-warehouse";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import type {
  MetaCreativeApiRow,
  RawCreativeRow,
} from "@/lib/meta/creatives-types";
import type { MetaAdDailyRow } from "@/lib/meta/warehouse-types";
import type {
  BriefingCanonicalNativeAdDecision,
  BriefingCreativeCard,
  CreativesBriefingResponse,
} from "@/components/creatives/briefing/types";

/**
 * The three defects the operator reported on the Creative Studio table, pinned
 * along the PRODUCTION chain rather than against fixtures.
 *
 *   1. "Creative studio'da status sütununda winner, fatigued, testing gibi
 *      sınıflandırmalar var normalde bizde durum farklı şuan."
 *   2. "tablodaki ısı haritası doğru çalışmıyor anlamlı mantıklı bir
 *      renklendirme yok."
 *   3. "Metriklerin olduğu sütunlarda sıralama yapabilmeliyim azalan artan
 *      şeklinde."
 *
 * Handing `toCreativeStudioAssetRows` a ready-made row, or `AssetsView` a
 * ready-made model, proves only that a renderer can read an object. Each case
 * below therefore starts where production starts:
 *
 *   the engine's `DecisionOutput`
 *     -> cardForDecision                        (the server's briefing card)
 *     -> buildServedCreativeClassifications     (the client index)
 *   and, in parallel,
 *   a nullable `MetaAdDailyRow`
 *     -> buildFallbackAdRawRow / hydrate / groupRows / buildMetaCreativeApiRow
 *     -> mapApiRowToUiRow                       (the page's own adapter)
 *     -> the rendered Creative Studio Assets table
 *
 * and every assertion is on the cell, class or order a person actually sees.
 *
 * MEASURED BASELINE, live dev server against production data, TheSwaf
 * act_822913786458311, 2026-07-21..2026-08-17, 96 rows on screen:
 *   - Status read `PAUSED` 34x, `ADSET_PAUSED` 26x, `ACTIVE` 23x,
 *     `CAMPAIGN_PAUSED` 10x, `WITH_ISSUES` 3x — the provider's delivery enum.
 *   - The briefing served a decision label for all 96 (join on `creative_id`,
 *     96/96 matched): test_more 57, cut 21, keep 11, diagnose 5, and 2
 *     creatives whose two ads disagreed.
 *   - AOV: 42 measured cells, one outlier at 1309 against a median of 160 put
 *     41 of 42 in the WORST colour bucket and 1 in the best.
 *   - No `<th>` on the page carried `aria-sort` or a button; the only sort
 *     control was a three-option select that always sorted descending.
 */

const navigation = vi.hoisted(() => ({
  pathname: "/platforms/meta/creatives",
  search: "",
}));

const queryState = vi.hoisted(() => ({
  accounts: [
    { id: "act_9", name: "Main", timezone: "UTC", currency: "USD" },
  ] as unknown,
  creatives: undefined as unknown,
  briefing: undefined as unknown,
  // The Shared-links toolbar count and manager read this. Undefined here
  // reads as "unread" (an em dash on the toolbar), matching the honest
  // default until a real business/account is wired.
  sharedLinks: undefined as unknown,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ selectedBusinessId: "biz_1", businesses: [] }),
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
  useTierZeroFreshness: vi.fn(),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [
    {
      rangePreset: "custom",
      customStart: "2026-07-21",
      customEnd: "2026-08-17",
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    },
    vi.fn(),
  ],
}));

vi.mock("@/components/pricing/PlanGate", () => ({
  PlanGate: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const useQueryMock = vi.mocked(useQuery);

const PROVIDER_ACCOUNT_ID = "act_9";

function adDailyRow(overrides: Partial<MetaAdDailyRow> = {}): MetaAdDailyRow {
  return {
    businessId: "biz_1",
    providerAccountId: PROVIDER_ACCOUNT_ID,
    date: "2026-08-17",
    campaignId: "c_1",
    adsetId: "as_1",
    adId: "ad_1",
    adNameCurrent: "Chain probe",
    adNameHistorical: null,
    adStatus: "ACTIVE",
    accountTimezone: "UTC",
    accountCurrency: "USD",
    spend: 0,
    impressions: 0,
    clicks: 0,
    reach: 0,
    frequency: null,
    conversions: 0,
    revenue: 0,
    roas: 0,
    cpa: null,
    ctr: null,
    cpc: null,
    linkClicks: null,
    outboundClicks: null,
    landingPageViews: null,
    addToCart: null,
    initiateCheckout: null,
    viewContent: null,
    leads: null,
    postEngagement: null,
    thruplayActions: null,
    videoViews3s: null,
    payloadJson: null,
    ...overrides,
  } as MetaAdDailyRow;
}

/**
 * The production warehouse sequence, in production order.
 *
 * `creativeId` is threaded in the way `getMetaCreativesWarehousePayload` does
 * it, because it is the join key the Status column depends on: the table's own
 * row id is a synthesised handle (`creative_1jcu3ue` on the live account) while
 * the briefing keys on the provider's real creative id. Measured live, joining
 * on the row id matched 0 of 96 rows and joining on the creative id matched 96.
 */
function buildApiRows(
  factRows: MetaAdDailyRow[],
  creativeIds: ReadonlyMap<string, string> = CREATIVE_IDS,
): MetaCreativeApiRow[] {
  const rawRows = factRows.reduce<RawCreativeRow[]>((acc, factRow) => {
    const projectionRow = buildFallbackAdRawRow({
      factRow,
      projectionJson: null,
      creativeId: creativeIds.get(factRow.adId) ?? null,
    });
    acc.push(hydrateWarehouseCreativeMetrics({ row: projectionRow, factRow }));
    return acc;
  }, []);
  const grouped = groupRows(
    rawRows,
    "creative",
    buildCreativeUsageMap(rawRows),
  );
  return grouped.map((row) =>
    buildMetaCreativeApiRow({
      row,
      cachedThumbnailUrl: null,
      cardFallbackThumbnailUrl: null,
      includeDebugFields: false,
    }),
  );
}

/**
 * One ad-day whose creative id, spend and revenue are chosen by the caller.
 *
 * `revenue` drives ROAS and AOV through the same coercion the warehouse uses,
 * so the heat and sort cases below are ranking numbers the producer actually
 * produced, not numbers the test wrote into a metrics map.
 */
const CREATIVE_IDS = new Map<string, string>();

function creativeDay(input: {
  creativeId: string;
  adId: string;
  name: string;
  spend: number;
  revenue: number;
  purchases: number;
  status?: string;
}): MetaAdDailyRow {
  CREATIVE_IDS.set(input.adId, input.creativeId);
  return adDailyRow({
    adId: input.adId,
    adNameCurrent: input.name,
    adStatus: input.status ?? "ACTIVE",
    spend: input.spend,
    impressions: 1000,
    clicks: 50,
    linkClicks: 40,
    conversions: input.purchases,
    revenue: input.revenue,
    roas: input.spend > 0 ? input.revenue / input.spend : 0,
    payloadJson: { creative_id: input.creativeId },
  });
}

function engineDecision(
  overrides: Partial<DecisionOutput> = {},
): DecisionOutput {
  return {
    creativeId: "creative_1",
    creativeName: "Creative 1",
    label: "keep",
    preAuthorityLabel: overrides.preAuthorityLabel ?? overrides.label ?? "keep",
    authorityBlocker: overrides.authorityBlocker ?? null,
    reason: "Hold.",
    confidence: 65,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2.5,
    ratioToTarget: 1,
    badges: [],
    blockers: [],
    metrics: { spend: 100, purchases: 1, roas: 2.5, recent7dRoas: 2.5 },
    engineVersion: "test-engine",
    generatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  } as DecisionOutput;
}

/**
 * A briefing payload built by the SERVER's own card serializer.
 *
 * `cardForDecision` is the module that turns an engine decision into the card
 * shape `/api/creatives/briefing` publishes, and it is the only place
 * `classifyMetaCreativeAssessment` runs. Writing card objects by hand here
 * would let the vocabulary drift from the server's without a single test
 * noticing.
 */
function briefingFor(decisions: DecisionOutput[]): CreativesBriefingResponse {
  return {
    actionNow: [],
    watching: [],
    healthy: decisions.map((decision) => cardForDecision({ decision })),
  };
}

function canonicalCard(input: {
  creativeId: string;
  adId: string;
  decisionState: BriefingCanonicalNativeAdDecision["classification"]["decisionState"];
  buyerAction: BriefingCanonicalNativeAdDecision["classification"]["buyerAction"];
  buyerLabel: string;
  sourceLabel: DecisionOutput["label"];
  heldAction?: BriefingCanonicalNativeAdDecision["classification"]["heldAction"];
}): BriefingCreativeCard {
  const base = cardForDecision({
    decision: engineDecision({
      creativeId: input.creativeId,
      label: input.sourceLabel,
    }),
  });
  const authorizedAction =
    input.buyerAction === "scale" ||
    input.buyerAction === "cut" ||
    input.buyerAction === "refresh"
      ? input.buyerAction
      : null;
  const canonicalDecision: BriefingCanonicalNativeAdDecision = {
    contractVersion: "briefing-canonical-native-ad.v1",
    identityGrain: "ad",
    decisionId: `decision_${input.adId}`,
    episodeId: `episode_${input.adId}`,
    sourceSnapshotId: "snapshot_1",
    adId: input.adId,
    creativeId: input.creativeId,
    identityResolution: {
      basis: "native_ad_exact",
      adActionEligible:
        input.decisionState === "act" && authorizedAction !== null,
    },
    classification: {
      decisionState: input.decisionState,
      buyerAction: input.buyerAction,
      buyerLabel: input.buyerLabel,
      executionAction: null,
      heldAction: input.heldAction ?? null,
    },
    sourceDecision: {
      label: input.sourceLabel,
      authorityBlocker: null,
      confidence: 0.82,
      reason: "Canonical fixture",
      snapshotAsOf: "2026-08-17T00:00:00.000Z",
      computedAt: "2026-08-17T00:00:00.000Z",
    },
    sourceAuthority: {
      status: "native_exact",
      snapshotId: "snapshot_1",
      evaluationId: `evaluation_${input.adId}`,
      inputHash: "a".repeat(64),
      decisionHash: "b".repeat(64),
      engineVersion: "test-engine",
      providerAccountRefId: "provider_ref_1",
      providerAccountId: PROVIDER_ACCOUNT_ID,
      realAdId: input.adId,
      jobRunId: "job_1",
      authorizedAction,
      actionEligible:
        input.decisionState === "act" && authorizedAction !== null,
      reviewOnlyReason:
        input.decisionState === "act" ? null : "Review only fixture",
    },
  };
  return {
    ...base,
    id: `card_${input.adId}`,
    adId: input.adId,
    creativeId: input.creativeId,
    canonicalDecision,
  };
}

function renderStudio(input: {
  rows: MetaCreativeApiRow[];
  briefing?: CreativesBriefingResponse;
}) {
  queryState.creatives = {
    status: "ok",
    rows: input.rows,
    warehouse_observed_at: null,
  };
  queryState.briefing = input.briefing;
  render(
    <CreativeStudioPage
      businessId="biz_1"
      providerAccountId={PROVIDER_ACCOUNT_ID}
    />,
  );
}

function headerIndex(label: string): number {
  const headers = Array.from(document.querySelectorAll("thead th")).map(
    (cell) => cell.textContent?.replace(/[▲▼↑↓]/g, "").trim() ?? "",
  );
  const index = headers.indexOf(label);
  expect(index, `no "${label}" column is on screen`).toBeGreaterThan(-1);
  return index;
}

/** The rendered Status cell of every row, top to bottom. */
function statusColumn(): string[] {
  const index = headerIndex("Status");
  return Array.from(
    document.querySelectorAll("[data-creative-studio-asset-row]"),
  ).map(
    (row) =>
      Array.from(row.querySelectorAll("td"))[index]?.textContent?.trim() ?? "",
  );
}

/** The rendered cells of one metric column, top to bottom. */
function metricColumn(label: string): string[] {
  const index = headerIndex(label);
  return Array.from(
    document.querySelectorAll("[data-creative-studio-asset-row]"),
  ).map(
    (row) =>
      Array.from(row.querySelectorAll("td"))[index]?.textContent?.trim() ?? "",
  );
}

/**
 * The heat bucket of one metric column, per row, as the CSS-module class name
 * with its hash stripped. Reading the class rather than a computed colour keeps
 * this honest under jsdom, which loads no stylesheet.
 */
function heatBuckets(label: string): string[] {
  const index = headerIndex(label);
  return Array.from(
    document.querySelectorAll("[data-creative-studio-asset-row]"),
  ).map((row) => {
    const cell = Array.from(row.querySelectorAll("td"))[index];
    const span = cell?.querySelector("span");
    const heat = Array.from(span?.classList ?? []).find((name) =>
      /heat/i.test(name),
    );
    return heat?.replace(/^.*?(heat[A-Za-z]+).*$/, "$1") ?? "";
  });
}

function creativeNames(): string[] {
  return Array.from(
    document.querySelectorAll("[data-creative-studio-asset-row]"),
  ).map(
    (row) =>
      row.querySelector("td:nth-child(2) span span")?.textContent?.trim() ?? "",
  );
}

beforeEach(() => {
  navigation.pathname = "/platforms/meta/creatives";
  navigation.search = "";
  queryState.accounts = [
    { id: PROVIDER_ACCOUNT_ID, name: "Main", timezone: "UTC", currency: "USD" },
  ];
  queryState.creatives = undefined;
  queryState.briefing = undefined;
  queryState.sharedLinks = undefined;
  window.localStorage.clear();
  useQueryMock.mockReset();
  useQueryMock.mockImplementation(
    (options: { queryKey?: readonly unknown[] }) => {
      const key = options.queryKey?.[0];
      const data =
        key === "meta-provider-accounts"
          ? queryState.accounts
          : key === "meta-creative-studio"
            ? queryState.creatives
            : key === "creative-share-links"
              ? queryState.sharedLinks
              : queryState.briefing;
      return {
        data,
        error: null,
        fetchStatus: "idle",
        isError: false,
        isFetching: false,
        isLoading: false,
        refetch: vi.fn(),
        status: data ? "success" : "pending",
      } as unknown as ReturnType<typeof useQuery>;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Creative Studio frozen-share production flow", () => {
  function renderOneSelectedCreative() {
    renderStudio({
      rows: buildApiRows([
        creativeDay({
          creativeId: "creative_share_1",
          adId: "ad_share_1",
          name: "Shareable hero",
          spend: 125,
          revenue: 375,
          purchases: 5,
        }),
      ]),
    });
    fireEvent.click(
      document.querySelector("[data-creative-studio-asset-row]")!,
    );
  }

  it("mints once on Create, copies the ready link, and Open page reaches that same snapshot", async () => {
    const token = "e".repeat(32);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token,
          path: `/share/creative/${token}`,
          url: `/share/creative/${token}`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    renderOneSelectedCreative();
    const shareButton = screen.getByRole("button", {
      name: "Share selected creatives with client",
    });
    await waitFor(() => expect(shareButton).not.toBeDisabled());
    fireEvent.click(shareButton);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body.audience).toBe("creative_team");
    expect(body.providerAccountId).toBe(PROVIDER_ACCOUNT_ID);
    expect(body.metrics).not.toContain("spend");
    expect(body.creatives).toHaveLength(1);
    expect(body.selectedRowIds).toHaveLength(1);

    const expected = `${window.location.origin}/share/creative/${token}`;
    const link = document.querySelector<HTMLInputElement>(
      "[data-studio-share-link]",
    );
    expect(link?.value).toBe(expected);

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));

    fireEvent.click(screen.getByRole("button", { name: "Open page" }));
    expect(open).toHaveBeenCalledWith(expected, "_blank", "noopener,noreferrer");
    // Copying and opening the already-ready link mint nothing new.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the created absolute link visible when clipboard access fails", async () => {
    const token = "f".repeat(32);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderOneSelectedCreative();
    const shareButton = screen.getByRole("button", {
      name: "Share selected creatives with client",
    });
    await waitFor(() => expect(shareButton).not.toBeDisabled());
    fireEvent.click(shareButton);
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    const expected = `${window.location.origin}/share/creative/${token}`;
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copy failed" })).toBeTruthy();
    });
    expect(
      document.querySelector<HTMLInputElement>("[data-studio-share-link]")
        ?.value,
    ).toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("guards a pending mint against duplicate submits and modal dismissal", async () => {
    const token = "1".repeat(32);
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderOneSelectedCreative();
    const shareButton = screen.getByRole("button", {
      name: "Share selected creatives with client",
    });
    await waitFor(() => expect(shareButton).not.toBeDisabled());
    fireEvent.click(shareButton);
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    // The creating phase has no Create/Copy control to double-click at all —
    // the whole config footer is replaced by a locked spinner state.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Creating frozen snapshot — controls locked"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    fireEvent.click(document.querySelector('[data-testid="studio-share-modal-scrim"]')!);
    expect(screen.getByRole("dialog")).toBeTruthy();

    resolveFetch(
      new Response(JSON.stringify({ token }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close" })).not.toBeDisabled();
  });
});

describe("Creative Studio Status column carries the engine's classification", () => {
  it("renders canonical exact-Ad Act, Blocked and Monitor states with the served buyer label", () => {
    const rows = buildApiRows([
      creativeDay({
        creativeId: "cre_act",
        adId: "ad_act",
        name: "Authorized winner",
        spend: 300,
        revenue: 900,
        purchases: 5,
      }),
      creativeDay({
        creativeId: "cre_blocked",
        adId: "ad_blocked",
        name: "Held decision",
        spend: 200,
        revenue: 100,
        purchases: 1,
      }),
      creativeDay({
        creativeId: "cre_monitor",
        adId: "ad_monitor",
        name: "Maturing test",
        spend: 100,
        revenue: 80,
        purchases: 1,
      }),
    ]);
    const cards = [
      canonicalCard({
        creativeId: "cre_act",
        adId: "ad_act",
        decisionState: "act",
        buyerAction: "scale",
        buyerLabel: "Scale winner",
        sourceLabel: "scale",
      }),
      canonicalCard({
        creativeId: "cre_blocked",
        adId: "ad_blocked",
        decisionState: "blocked",
        buyerAction: null,
        buyerLabel: "Cut held",
        sourceLabel: "cut",
        heldAction: "cut",
      }),
      canonicalCard({
        creativeId: "cre_monitor",
        adId: "ad_monitor",
        decisionState: "monitor",
        buyerAction: "watch_launch",
        buyerLabel: "Keep learning",
        sourceLabel: "test_more",
      }),
    ];

    renderStudio({
      rows,
      briefing: { actionNow: [], watching: cards, healthy: [] },
    });

    expect(statusColumn().sort()).toEqual([
      "Act · Scale winner",
      "Blocked · Cut held",
      "Monitor · Keep learning",
    ]);
    expect(
      Array.from(
        document.querySelectorAll("[data-creative-decision-segment]"),
      ).map((node) => node.getAttribute("data-creative-decision-segment")),
    ).toEqual(expect.arrayContaining(["Act", "Blocked", "Monitor"]));
  });

  /**
   * LAW: the Status column states what the ENGINE decided about the creative.
   * It does not state whether Meta is currently delivering it — that is a
   * different question with its own field and its own place on screen.
   */
  it("renders the served classification, not the provider's delivery enum", () => {
    const rows = buildApiRows([
      creativeDay({
        creativeId: "cre_scale",
        adId: "ad_scale",
        name: "Scaling hero",
        spend: 400,
        revenue: 1600,
        purchases: 8,
        // The provider says this one is PAUSED. That is true, and it is not
        // the answer to "how is this creative doing".
        status: "PAUSED",
      }),
      creativeDay({
        creativeId: "cre_test",
        adId: "ad_test",
        name: "Still learning",
        spend: 40,
        revenue: 40,
        purchases: 1,
        status: "ACTIVE",
      }),
    ]);

    renderStudio({
      rows,
      briefing: briefingFor([
        engineDecision({ creativeId: "cre_scale", label: "scale" }),
        engineDecision({ creativeId: "cre_test", label: "test_more" }),
      ]),
    });

    // The server's own words, from the server's own serializer: a `scale`
    // decision backed by commercial truth is a "Proven winner" and a
    // `test_more` decision is "Learning". Neither string exists in the UI.
    expect(statusColumn().sort()).toEqual([
      "Monitor · Learning",
      "Monitor · Proven winner",
    ]);
    // The delivery state is still on screen — it just no longer occupies the
    // column the classification belongs in.
    expect(
      Array.from(
        document.querySelectorAll("[data-creative-delivery-status]"),
      ).map((node) => node.textContent?.trim()),
    ).toContain("Paused");
    expect(statusColumn().join(" ")).not.toContain("PAUSED");
  });

  /**
   * LAW: when the route publishes no assessment, the surface still shows the
   * engine's own decision label — it does not fall back to a delivery enum and
   * it does not go blank.
   *
   * This is the case PRODUCTION is in today. Probed against the live dev server
   * on 2026-08-19 (TheSwaf, act_822913786458311): `/api/creatives/briefing`
   * returned 750 cards and not one carried an `assessment` key, because the
   * live route builds cards through
   * `app/api/creatives/briefing/canonical-projection.ts`, which never calls
   * `classifyMetaCreativeAssessment`. `cardForDecision` — the only caller —
   * is reachable from its own test and nothing else. So the card is minted by
   * the real serializer and then stripped of the field the real route does not
   * send, which is exactly the payload the browser receives.
   */
  it("falls back to the served decision label when the route sends no assessment", () => {
    const rows = buildApiRows([
      creativeDay({
        creativeId: "cre_scale",
        adId: "ad_scale",
        name: "Scaling hero",
        spend: 400,
        revenue: 1600,
        purchases: 8,
        status: "PAUSED",
      }),
      creativeDay({
        creativeId: "cre_test",
        adId: "ad_test",
        name: "Still learning",
        spend: 40,
        revenue: 40,
        purchases: 1,
      }),
    ]);
    const asLiveRouteSendsIt = briefingFor([
      engineDecision({ creativeId: "cre_scale", label: "scale" }),
      engineDecision({ creativeId: "cre_test", label: "test_more" }),
    ]);
    for (const card of asLiveRouteSendsIt.healthy) delete card.assessment;

    renderStudio({ rows, briefing: asLiveRouteSendsIt });

    expect(statusColumn().sort()).toEqual([
      "Monitor · Scale",
      "Monitor · Test more",
    ]);
    expect(statusColumn().join(" ")).not.toContain("PAUSED");
  });

  /**
   * LAW: no card, no classification. Not "Unknown", not the delivery status
   * standing in, not a guess derived from the metrics on the same row. The
   * successful empty match is named explicitly so the cell never goes blank.
   */
  it("renders an explicit not-evaluated state for a creative the engine did not classify", () => {
    const rows = buildApiRows([
      creativeDay({
        creativeId: "cre_unjudged",
        adId: "ad_unjudged",
        name: "No decision",
        spend: 120,
        revenue: 240,
        purchases: 2,
        status: "ACTIVE",
      }),
    ]);

    renderStudio({ rows, briefing: briefingFor([]) });

    expect(statusColumn()).toEqual(["Not evaluated"]);
  });

  it("distinguishes an unavailable decision read from a successful unmatched read", () => {
    const rows = buildApiRows([
      creativeDay({
        creativeId: "cre_unavailable",
        adId: "ad_unavailable",
        name: "Endpoint unavailable",
        spend: 120,
        revenue: 240,
        purchases: 2,
      }),
    ]);

    renderStudio({
      rows,
      briefing: {
        actionNow: [],
        watching: [],
        healthy: [],
        source: {
          canonicalDecisionInventory: {
            contractVersion: "briefing-canonical-native-ad.v1",
            status: "unavailable",
            unavailableReason: "native_generation_unavailable",
            generation: null,
            itemCount: 0,
          },
        },
      },
    });

    expect(statusColumn()).toEqual(["Decision data unavailable"]);
  });

  /**
   * LAW: the surface may not choose between two server answers.
   *
   * The Assets table is creative-grain and the briefing is ad-grain, so several
   * cards can land on one row. Measured on the live account, 2 of 96 creatives
   * were in exactly this state (`test_more` on one ad, `diagnose` on the
   * other). Picking either — or the "worse" one, or the first one — would be
   * the surface inventing a decision the engine never published, so the cell
   * keeps both literal server answers.
   */
  it("keeps both served answers when two ads sharing a creative differ", () => {
    const rows = buildApiRows([
      creativeDay({
        creativeId: "cre_split",
        adId: "ad_split_a",
        name: "Split verdict",
        spend: 100,
        revenue: 200,
        purchases: 2,
      }),
      creativeDay({
        creativeId: "cre_split",
        adId: "ad_split_b",
        name: "Split verdict",
        spend: 100,
        revenue: 200,
        purchases: 2,
      }),
    ]);

    renderStudio({
      rows,
      briefing: {
        actionNow: [],
        watching: [],
        healthy: [
          canonicalCard({
            creativeId: "cre_split",
            adId: "ad_split_a",
            decisionState: "monitor",
            buyerAction: "watch_launch",
            buyerLabel: "Keep learning",
            sourceLabel: "test_more",
          }),
          canonicalCard({
            creativeId: "cre_split",
            adId: "ad_split_b",
            decisionState: "blocked",
            buyerAction: null,
            buyerLabel: "Cut held",
            sourceLabel: "cut",
            heldAction: "cut",
          }),
        ],
      },
    });

    expect(statusColumn()).toEqual([
      "Monitor / Blocked · Keep learning / Cut held",
    ]);
  });

  /**
   * LAW: when the server publishes its richer assessment vocabulary, the
   * surface shows THAT, verbatim, and does not fall back to the decision label.
   *
   * `cardForDecision` runs `classifyMetaCreativeAssessment`, so this case is
   * the server's own words end to end: a `scale` decision backed by
   * commercial truth is a "Proven winner", and a `refresh` decision carrying a
   * fatigue badge is a "Fatigued former winner". Neither string is written in
   * the UI.
   */
  it("prefers the server's assessment vocabulary over the bare decision label", () => {
    const rows = buildApiRows([
      creativeDay({
        creativeId: "cre_winner",
        adId: "ad_winner",
        name: "Proven",
        spend: 500,
        revenue: 2500,
        purchases: 10,
      }),
      creativeDay({
        creativeId: "cre_fatigued",
        adId: "ad_fatigued",
        name: "Blocked from scale",
        spend: 500,
        revenue: 900,
        purchases: 4,
      }),
    ]);

    const winner = cardForDecision({
      decision: engineDecision({
        creativeId: "cre_winner",
        label: "scale",
        truthSource: "commercial_truth",
      }),
    });
    const blocked = cardForDecision({
      decision: engineDecision({
        creativeId: "cre_fatigued",
        label: "keep",
        badges: [
          {
            type: "scale_readiness_blocked",
            label: "Scale readiness blocked",
            severity: "warning",
          },
        ],
      } as Partial<DecisionOutput>),
    });

    expect(winner.assessment?.label).toBe("Proven winner");
    expect(blocked.assessment?.label).toBe("Above target · not proven");

    renderStudio({
      rows,
      briefing: { actionNow: [], watching: [], healthy: [winner, blocked] },
    });

    expect(statusColumn().sort()).toEqual([
      "Monitor · Above target · not proven",
      "Monitor · Proven winner",
    ]);
  });
});

describe("Creative Studio heat map ranks within the column", () => {
  /**
   * The exact shape that made the live AOV column meaningless: one creative far
   * above the rest, the others clustered.
   *
   * Under the old `(value - min) / (max - min)` scale the clustered rows all
   * scored under 0.2 and painted as the worst bucket — measured live, 41 of 42
   * AOV cells were red and 1 was green. A rank cannot do that: with five
   * distinct values the ranks are fixed at 0, 0.25, 0.5, 0.75 and 1 no matter
   * how far the outlier sits from the rest, so one cell lands in each bucket.
   */
  it("does not let one outlier collapse the rest of a column into the worst bucket", () => {
    const spends = [
      { name: "AOV 100", revenue: 100 },
      { name: "AOV 110", revenue: 110 },
      { name: "AOV 120", revenue: 120 },
      { name: "AOV 130", revenue: 130 },
      { name: "AOV 5000", revenue: 5000 },
    ];
    const rows = buildApiRows(
      spends.map((entry, index) =>
        creativeDay({
          creativeId: `cre_${index}`,
          adId: `ad_${index}`,
          name: entry.name,
          spend: 50,
          revenue: entry.revenue,
          purchases: 1,
        }),
      ),
    );

    renderStudio({ rows });

    // Sorted by Spend descending, all spends equal, so name breaks the tie:
    // AOV 100, AOV 110, AOV 120, AOV 130, AOV 5000.
    expect(metricColumn("AOV")).toEqual([
      "$100",
      "$110",
      "$120",
      "$130",
      "$5,000",
    ]);
    expect(heatBuckets("AOV")).toEqual([
      "heatLag",
      "heatLow",
      "heatMiddle",
      "heatGood",
      "heatLead",
    ]);
  });

  /**
   * LAW: an unavailable cell is never coloured as if it were measured, and it
   * never counts as a member of the column's population.
   *
   * A creative with zero purchases has no CPA — the denominator is zero — so
   * the cell is an em dash. If it were folded into the ranking as a zero it
   * would take the best bucket in a lower-is-better column, which is the exact
   * inversion this table used to publish.
   */
  it("leaves an unavailable cell uncoloured and out of the ranking", () => {
    const rows = buildApiRows([
      creativeDay({
        creativeId: "cre_bought",
        adId: "ad_bought",
        name: "Bought something",
        spend: 300,
        revenue: 600,
        purchases: 3,
      }),
      creativeDay({
        creativeId: "cre_nothing",
        adId: "ad_nothing",
        name: "Bought nothing",
        spend: 900,
        revenue: 0,
        purchases: 0,
      }),
    ]);

    renderStudio({ rows });

    const cpa = metricColumn("CPA");
    const buckets = heatBuckets("CPA");
    const missingIndex = cpa.indexOf("—");
    expect(
      missingIndex,
      "the zero-purchase creative should have no CPA",
    ).toBeGreaterThan(-1);
    expect(buckets[missingIndex]).toBe("heatMissing");
    // The one measured cell is alone in its population and takes the neutral
    // middle rather than being declared the column's leader or its laggard.
    expect(buckets.filter((bucket) => bucket !== "heatMissing")).toEqual([
      "heatMiddle",
    ]);
  });

  /**
   * The live ROAS column's actual shape: a large tie at the bottom and a thin
   * spread above it.
   *
   * MEASURED on the live surface: 93 measured ROAS cells with a MEDIAN of 0 and
   * a maximum of 4.8 — most of the account's creatives bought nothing. A
   * mid-rank would score that tie around 0.33 and paint the account's dead
   * weight amber, level with a creative genuinely returning 1.9x. Scoring by
   * "how many do I strictly beat" puts the whole tie at 0 and leaves the bands
   * above it for creatives that actually earned them.
   */
  it("keeps a large tie at the bottom of its column, not in the middle", () => {
    const barren = Array.from({ length: 6 }, (_, index) => ({
      creativeId: `cre_zero_${index}`,
      adId: `ad_zero_${index}`,
      name: `Zero ${index}`,
      spend: 100,
      revenue: 0,
      purchases: 0,
    }));
    const earners = [
      {
        creativeId: "cre_e1",
        adId: "ad_e1",
        name: "Earner 1",
        spend: 100,
        revenue: 150,
        purchases: 1,
      },
      {
        creativeId: "cre_e2",
        adId: "ad_e2",
        name: "Earner 2",
        spend: 100,
        revenue: 300,
        purchases: 2,
      },
      {
        creativeId: "cre_e3",
        adId: "ad_e3",
        name: "Earner 3",
        spend: 100,
        revenue: 480,
        purchases: 3,
      },
    ];
    renderStudio({
      rows: buildApiRows(
        [...barren, ...earners].map((entry) => creativeDay(entry)),
      ),
    });

    const roas = metricColumn("ROAS");
    const buckets = heatBuckets("ROAS");
    const zeroBuckets = roas
      .map((value, index) => (value === "0.0" ? buckets[index] : null))
      .filter(Boolean);
    expect(zeroBuckets).toHaveLength(6);
    expect(new Set(zeroBuckets)).toEqual(new Set(["heatLag"]));
    // And the three earners are not stuck in the same bucket as the tie.
    expect(buckets.filter((bucket) => bucket !== "heatLag").length).toBe(3);
  });

  /**
   * LAW: the legend says "across THESE creatives". When the operator searches,
   * "these creatives" is what is left on screen — so the ranking population has
   * to shrink with the table, or the sentence stops being true.
   */
  it("re-ranks against the rows a search leaves on screen", () => {
    renderStudio({
      rows: buildApiRows([
        creativeDay({
          creativeId: "c1",
          adId: "a1",
          name: "Keep low",
          spend: 100,
          revenue: 100,
          purchases: 1,
        }),
        creativeDay({
          creativeId: "c2",
          adId: "a2",
          name: "Keep high",
          spend: 100,
          revenue: 400,
          purchases: 1,
        }),
        creativeDay({
          creativeId: "c3",
          adId: "a3",
          name: "Drop me",
          spend: 100,
          revenue: 900,
          purchases: 1,
        }),
      ]),
    });

    // Rows are ordered by the default Spend sort; the spends are equal, so the
    // name breaks the tie: Drop me, Keep high, Keep low. With the outlier
    // present, "Keep high" is only middling.
    expect(metricColumn("ROAS")).toEqual(["9.0", "4.0", "1.0"]);
    expect(heatBuckets("ROAS")).toEqual(["heatLead", "heatMiddle", "heatLag"]);

    fireEvent.change(screen.getByLabelText("Search creatives"), {
      target: { value: "keep" },
    });

    // With it filtered out, the same cell is now the leader of what is on
    // screen — because that is what its rank among these creatives is.
    expect(metricColumn("ROAS")).toEqual(["4.0", "1.0"]);
    expect(heatBuckets("ROAS")).toEqual(["heatLead", "heatLag"]);
  });

  /**
   * LAW: "good" is per metric. High ROAS is good; high CPA is not. The same
   * ranking machinery must invert for a lower-is-better column.
   */
  it("colours a lower-is-better column in the opposite direction", () => {
    const rows = buildApiRows([
      creativeDay({
        creativeId: "cre_cheap",
        adId: "ad_cheap",
        name: "Cheap acquisition",
        spend: 100,
        revenue: 400,
        purchases: 10,
      }),
      creativeDay({
        creativeId: "cre_dear",
        adId: "ad_dear",
        name: "Dear acquisition",
        spend: 900,
        revenue: 1200,
        purchases: 2,
      }),
      creativeDay({
        creativeId: "cre_mid",
        adId: "ad_mid",
        name: "Middling acquisition",
        spend: 400,
        revenue: 800,
        purchases: 4,
      }),
    ]);

    renderStudio({ rows });

    const cpa = metricColumn("CPA");
    const roas = metricColumn("ROAS");
    const cpaBuckets = heatBuckets("CPA");
    const roasBuckets = heatBuckets("ROAS");

    // Rows are ordered by Spend descending: dear (900), mid (400), cheap (100).
    expect(cpa).toEqual(["$450.0", "$100.0", "$10.0"]);
    expect(cpaBuckets).toEqual(["heatLag", "heatMiddle", "heatLead"]);
    // The same three rows on ROAS: 1.3, 2.0, 4.0. The buckets read identically
    // to CPA's — and that is the point. CPA's largest number (450) took the
    // WORST bucket while ROAS's largest number (4.0) took the BEST one, so the
    // same ranking machinery inverted for the lower-is-better column.
    expect(roas).toEqual(["1.3", "2.0", "4.0"]);
    expect(roasBuckets).toEqual(["heatLag", "heatMiddle", "heatLead"]);
  });
});

describe("Creative Studio metric columns sort both ways", () => {
  function threeRows() {
    return buildApiRows([
      creativeDay({
        creativeId: "cre_high",
        adId: "ad_high",
        name: "High spend",
        spend: 900,
        revenue: 1800,
        purchases: 9,
      }),
      creativeDay({
        creativeId: "cre_zero",
        adId: "ad_zero",
        name: "Measured zero",
        spend: 0,
        revenue: 0,
        purchases: 0,
      }),
      creativeDay({
        creativeId: "cre_mid",
        adId: "ad_mid",
        name: "Mid spend",
        spend: 300,
        revenue: 900,
        purchases: 3,
      }),
    ]);
  }

  /**
   * LAW: every metric header sorts, both ways, and says which way it is
   * pointing — visually and to a screen reader.
   */
  it("sorts descending then ascending from the column header and announces both", () => {
    renderStudio({ rows: threeRows() });

    const spendHeader = document.querySelector<HTMLButtonElement>(
      'button[data-metric-sort="spend"]',
    );
    expect(spendHeader, "the Spend header is not a control").not.toBeNull();
    expect(spendHeader!.closest("th")?.getAttribute("aria-sort")).toBe(
      "descending",
    );
    expect(metricColumn("Spend")).toEqual(["$900", "$300", "$0"]);

    fireEvent.click(spendHeader!);
    expect(
      document
        .querySelector('button[data-metric-sort="spend"]')!
        .closest("th")
        ?.getAttribute("aria-sort"),
    ).toBe("ascending");
    // A MEASURED zero is a number and sorts as one: it heads an ascending
    // spend column rather than being pushed out with the unavailable values.
    expect(metricColumn("Spend")).toEqual(["$0", "$300", "$900"]);
    expect(screen.getByRole("status").textContent).toContain(
      "sorted by Spend · low to high",
    );
  });

  /**
   * LAW: an em dash sorts LAST in BOTH directions. An unknown is not the
   * smallest value.
   *
   * The previous implementation coerced an unavailable metric to
   * `Number.NEGATIVE_INFINITY`, which happens to look right while the table can
   * only sort one way — and puts every unread creative at the top the moment
   * ascending exists.
   */
  it("keeps unavailable rows last whichever way a column is pointed", () => {
    // The zero-purchase creative has no CPA at all; the other two do.
    const rows = buildApiRows([
      creativeDay({
        creativeId: "cre_cheap",
        adId: "ad_cheap",
        name: "Cheap",
        spend: 100,
        revenue: 400,
        purchases: 10,
      }),
      creativeDay({
        creativeId: "cre_none",
        adId: "ad_none",
        name: "No purchases",
        spend: 500,
        revenue: 0,
        purchases: 0,
      }),
      creativeDay({
        creativeId: "cre_dear",
        adId: "ad_dear",
        name: "Dear",
        spend: 800,
        revenue: 1000,
        purchases: 2,
      }),
    ]);
    renderStudio({ rows });

    const cpaHeader = () =>
      document.querySelector<HTMLButtonElement>(
        'button[data-metric-sort="cpa"]',
      )!;

    fireEvent.click(cpaHeader());
    expect(metricColumn("CPA")).toEqual(["$400.0", "$10.0", "—"]);
    expect(creativeNames()[2]).toBe("No purchases");

    fireEvent.click(cpaHeader());
    expect(metricColumn("CPA")).toEqual(["$10.0", "$400.0", "—"]);
    expect(creativeNames()[2]).toBe("No purchases");
  });

  /**
   * LAW: the sort is the operator's, and a re-render is not permission to
   * discard it. Pinning a row re-renders the whole table through the
   * controller's `onPinnedIdsChange`; the order must be exactly where the
   * operator left it.
   */
  it("survives a re-render caused by an unrelated interaction", () => {
    renderStudio({ rows: threeRows() });

    fireEvent.click(
      document.querySelector('button[data-metric-sort="spend"]')!,
    );
    expect(metricColumn("Spend")).toEqual(["$0", "$300", "$900"]);

    fireEvent.click(
      document.querySelector("[data-creative-studio-asset-row]")!,
    );
    fireEvent.change(screen.getByLabelText("Search creatives"), {
      target: { value: "spend" },
    });

    expect(
      document
        .querySelector('button[data-metric-sort="spend"]')!
        .closest("th")
        ?.getAttribute("aria-sort"),
    ).toBe("ascending");
    expect(metricColumn("Spend")).toEqual(["$300", "$900"]);
  });

  /** LAW: the header is reachable and operable without a mouse. */
  it("puts every metric header in the tab order as a button", () => {
    renderStudio({ rows: threeRows() });

    const headers = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "thead th button[data-metric-sort]",
      ),
    );
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(header.tagName).toBe("BUTTON");
      expect(header.getAttribute("type")).toBe("button");
      expect(header.hasAttribute("disabled")).toBe(false);
    }
  });
});
