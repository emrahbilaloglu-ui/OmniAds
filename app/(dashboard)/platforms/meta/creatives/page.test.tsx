import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import {
  getPresetDatesForReferenceDate,
  getTodayIsoForTimeZone,
} from "@/components/date-range/DateRangePicker";
import { buildCreativeStudioTabHrefs as sharedTabHrefBuilder } from "@/lib/meta/creative-studio-tab-hrefs";
import CreativesPage, {
  buildCreativeStudioTabHrefs,
  toCreativeStudioAssetRows,
} from "./legacy-page";

const navigation = vi.hoisted(() => ({
  pathname: "/platforms/meta/creatives",
  search: "",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedBusinessId: "biz_1",
      businesses: [{ id: "biz_1", name: "Nordventure", currency: "EUR" }],
    }),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [
    {
      rangePreset: "28d",
      customStart: "",
      customEnd: "",
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    },
    vi.fn(),
  ],
}));

vi.mock("@/lib/pricing/usePlan", () => ({
  usePlanState: () => ({ plan: "growth", isLoading: false, isReady: true }),
}));

/**
 * Mirrors the page's own window resolution (dashboard preset "28d" resolves to
 * a custom window on the account's reference day) so a seeded creatives query
 * lands on the exact key the page reads.
 */
function studioWindow(timeZone: string) {
  return getPresetDatesForReferenceDate(
    "28d",
    getTodayIsoForTimeZone(timeZone),
    "",
    "",
  );
}

function headerButtonMarkup(html: string, label: string): string {
  return html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? "";
}

function renderPage(
  input: {
    pageProps?: React.ComponentProps<typeof CreativesPage>;
    businessId?: string;
    providerAccounts?: Array<{
      id: string;
      timezone?: string;
      currency?: string;
    }>;
    creativeApiRows?: Array<Record<string, unknown>>;
    /** Envelope fields beside `rows` — status, isPartial, observed-at. */
    creativeEnvelope?: Record<string, unknown>;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  if (input.businessId && input.providerAccounts) {
    client.setQueryData(
      ["meta-provider-accounts", input.businessId],
      input.providerAccounts,
    );
  }
  if (
    input.businessId &&
    input.providerAccounts?.length === 1 &&
    input.creativeApiRows
  ) {
    const account = input.providerAccounts[0]!;
    const { start, end } = studioWindow(account.timezone || "UTC");
    client.setQueryData(
      [
        "meta-creative-studio",
        input.businessId,
        account.id,
        start,
        end,
        "creative",
      ],
      { ...(input.creativeEnvelope ?? {}), rows: input.creativeApiRows },
    );
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CreativesPage {...input.pageProps} />
    </QueryClientProvider>,
  );
}

function creativeRow(
  overrides: Partial<MetaCreativeRow> = {},
): MetaCreativeRow {
  return {
    id: "creative_1",
    creativeId: "creative_1",
    name: "Served asset",
    creativePrimaryLabel: "Video",
    creativeTypeLabel: "Video",
    creativeVisualFormat: "vertical",
    effectiveStatus: "ACTIVE",
    aiTags: { messagingAngle: ["Problem aware", "Offer-led"] },
    currency: null,
    metricsAvailability: "available",
    spend: 100,
    purchaseValue: 400,
    purchases: 4,
    impressions: 1_000,
    clicks: 50,
    linkClicks: 40,
    addToCart: 8,
    roas: 4,
    cpa: 25,
    cpm: 10,
    linkCtr: 4,
    thumbstop: 32,
    frequency: 2.1,
    // `meta_creative_daily.launch_date` as it reaches the UI row
    // (`mapApiRowToUiRow`, page-support.tsx:1025). It is `ad.created_time`,
    // earliest across the ads sharing the creative — a CREATED clock, which is
    // why the column that reads it says "since created".
    launchDate: "2026-08-01",
    clickToAddToCart: 20,
    clickToPurchase: 10,
    video100: 91,
    tableThumbnailUrl: null,
    cachedThumbnailUrl: null,
    thumbnailUrl: null,
    imageUrl: null,
    cardPreviewUrl: null,
    previewUrl: null,
    preview: {
      render_mode: "unavailable",
      image_url: null,
      video_url: null,
      poster_url: null,
      source: null,
      is_catalog: false,
    },
    format: "video",
    ...overrides,
  } as MetaCreativeRow;
}

/**
 * The last day the projected rows' numbers cover.
 *
 * A LITERAL, never `new Date()`. The age column counts to the WINDOW'S end, so
 * every expected age below is a fixed integer; a projector that quietly counted
 * to `Date.now()` instead would produce a different number today than it did
 * yesterday, and these assertions would start failing on their own — which is
 * exactly the signal.
 */
const WINDOW_END = "2026-08-17";

afterEach(() => {
  navigation.pathname = "/platforms/meta/creatives";
  navigation.search = "";
});

describe("/platforms/meta/creatives page", () => {
  it("renders the exact Assets surface without the legacy Studio OS controls", () => {
    const html = renderPage();

    expect(html).toContain('data-testid="creative-studio-page"');
    expect(html).toContain('data-creative-studio-exact="true"');
    expect(html).toContain('data-creative-studio-exact-section="assets"');
    expect(html).toContain("Creative Studio");
    expect(html).toContain("Export CSV");
    expect(html).toContain("Share with client");
    expect(html).toContain('data-responsive-studio="true"');
    expect(html).toContain('data-provider-writes="none"');
    expect(html).not.toContain('data-testid="creative-studio-os"');
    expect(html).not.toContain('aria-label="Primary"');
    expect(html).not.toContain("data-studio-nav-rail");
    expect(html).not.toContain("Business STOP");
    expect(html).not.toContain(">More<");
    expect(html).not.toContain(">Winners<");
    expect(html).not.toContain(">Briefs<");
    expect(html).not.toContain(">Shares<");
    expect(html).not.toContain("creatives-briefing-page");
  });

  it("does not let URL/store state override an explicit server scope with no account", () => {
    navigation.search = "providerAccountId=url_account";

    const html = renderPage({
      pageProps: { businessId: "server_biz", providerAccountId: null },
      businessId: "server_biz",
      providerAccounts: [
        { id: "server_account", timezone: "UTC", currency: "USD" },
      ],
    });

    expect(html).toContain(
      "Select one assigned Meta ad account. Assets remain withheld until the provider scope is explicit.",
    );
    expect(html).not.toContain("server_account");
    expect(html).not.toContain("url_account");
  });

  it("keeps an explicit server account authoritative over the URL account", () => {
    navigation.search = "providerAccountId=url_account";

    const html = renderPage({
      pageProps: {
        businessId: "server_biz",
        providerAccountId: "server_account",
      },
      businessId: "server_biz",
      providerAccounts: [
        { id: "server_account", timezone: "UTC", currency: "USD" },
      ],
    });

    expect(html).toContain("providerAccountId=server_account");
    expect(html).not.toContain("providerAccountId=url_account");
  });

  it("does not silently select the first account when the legacy scope has multiple assignments", () => {
    const html = renderPage({
      businessId: "biz_1",
      providerAccounts: [
        { id: "act_1", timezone: "UTC", currency: "USD" },
        { id: "act_2", timezone: "UTC", currency: "USD" },
      ],
    });

    expect(html).toContain(
      "Select one assigned Meta ad account. Assets remain withheld until the provider scope is explicit.",
    );
  });

  it("keeps Export CSV disabled until the Assets tab has rows the export can write", () => {
    const whileLoading = renderPage({
      businessId: "biz_1",
      providerAccounts: [{ id: "act_1", timezone: "UTC", currency: "USD" }],
    });

    expect(whileLoading).toContain("Loading creative assets.");
    expect(headerButtonMarkup(whileLoading, "Export CSV")).toContain(
      "disabled",
    );

    const withoutRows = renderPage({
      businessId: "biz_1",
      providerAccounts: [{ id: "act_1", timezone: "UTC", currency: "USD" }],
      creativeApiRows: [],
    });

    expect(withoutRows).toContain(
      "No creative assets were served for this window.",
    );
    expect(headerButtonMarkup(withoutRows, "Export CSV")).toContain("disabled");

    const withRows = renderPage({
      businessId: "biz_1",
      providerAccounts: [{ id: "act_1", timezone: "UTC", currency: "USD" }],
      creativeApiRows: [
        {
          id: "creative_1",
          creative_id: "creative_1",
          account_id: "act_1",
          name: "Served asset",
          spend: 100,
        },
      ],
    });

    expect(withRows).toContain("Served asset");
    expect(headerButtonMarkup(withRows, "Export CSV")).not.toContain(
      "disabled",
    );
  });
});

describe("Creative Studio Assets: a 200 with no rows is not automatically empty", () => {
  /**
   * WHY: `/api/meta/creatives` answers HTTP 200 with `rows: []` for
   * `no_connection`, `no_access_token` and `no_accounts_assigned` — verdicts
   * that mean no read was attempted at all (lib/meta/creatives-api.ts returns
   * them before the provider is ever called, and
   * `accountScopeHttpStatus` leaves them at 200). This surface counted rows and
   * nothing else, so all three printed "No creative assets were served for this
   * window.": a definite statement about the operator's Meta account, produced
   * by a read that never happened. An operator can cut a creative on that.
   */
  it.each([
    [
      "no_connection",
      "This business has no connected Meta account, so no creative data was read.",
    ],
    [
      "no_access_token",
      "The Meta connection has no usable access token, so no creative data was read.",
    ],
    [
      "no_accounts_assigned",
      "No Meta ad account is assigned to this business, so no creative data was read.",
    ],
  ])(
    "reports %s as unavailable rather than an empty window",
    (status, message) => {
      const html = renderPage({
        businessId: "biz_1",
        providerAccounts: [{ id: "act_1", timezone: "UTC", currency: "USD" }],
        creativeApiRows: [],
        creativeEnvelope: { status },
      });

      expect(html).toContain(`data-assets-state="unavailable"`);
      expect(html).toContain(`data-assets-source-status="${status}"`);
      expect(html).toContain(message);
      expect(html).not.toContain(
        "No creative assets were served for this window.",
      );
      // A count is only a count when a read produced one.
      expect(html).toContain("— synced · Meta");
    },
  );

  /**
   * WHY: the distinction only means something if the true-empty case still
   * reads as empty. `status: "ok"` with no rows is the account genuinely
   * serving nothing, and must keep saying so.
   */
  it("still calls a served-but-empty window empty", () => {
    const html = renderPage({
      businessId: "biz_1",
      providerAccounts: [{ id: "act_1", timezone: "UTC", currency: "USD" }],
      creativeApiRows: [],
      creativeEnvelope: { status: "ok" },
    });

    expect(html).toContain(`data-assets-state="empty"`);
    expect(html).toContain("No creative assets were served for this window.");
    expect(html).toContain("0 synced · Meta");
  });
});

describe("Creative Studio Assets projection", () => {
  it("withholds every number when metrics are unavailable and uses only server-owned labels", () => {
    const [row] = toCreativeStudioAssetRows(
      [
        creativeRow({
          metricsAvailability: "unavailable",
          spend: 999,
          roas: 9,
          effectiveStatus: "WITH_ISSUES",
          aiTags: { messagingAngle: [" Server angle ", "Second angle"] },
          currency: null,
        }),
      ],
      "EUR",
      new Map(),
      WINDOW_END,
    );

    /*
     * RESTATED, NOT WEAKENED. The law was "every value in the map is null",
     * and it was a true statement of a narrower law: every number the METRICS
     * PRODUCER serves is withheld when that producer says it measured nothing.
     * `ageDays` is not one of those numbers — it is the distance between
     * `launch_date`, which the row carries whether or not any metric was
     * measured, and the end of the window. Gating it on `metricsAvailability`
     * would delete a fact the payload supplied in order to honour a flag about
     * a different fact, and the useful reading of an unmeasured creative is
     * precisely "40 days old and still no numbers".
     *
     * So the assertion now names the producer's own fields, and the age is
     * asserted separately below rather than swept into the same `every`.
     */
    const producerServed = Object.entries(row!.metrics).filter(
      ([key]) => key !== "ageDays",
    );
    expect(producerServed.length).toBeGreaterThan(15);
    expect(producerServed.every(([, value]) => value === null)).toBe(true);
    expect(row!.metrics.ageDays).toBe(16);
    // LAW: `status` is the ENGINE's classification of this creative, and this
    // call passes no classification index, so the surface says `Not
    // evaluated`. `WITH_ISSUES` is Meta's delivery enum; it keeps its own
    // field and its own place on screen, and it is not an answer to "is this
    // creative winning, fatigued or still learning".
    expect(row).toMatchObject({
      status: "Not evaluated",
      statusTone: "neutral",
      decisionSegment: null,
      decisionCount: 0,
      deliveryStatus: "With issues",
      marketingAngle: "Server angle, Second angle",
      currency: "EUR",
    });
  });

  /**
   * WHAT THIS TEST USED TO SAY, AND WHY IT SAYS SOMETHING ELSE NOW.
   *
   * It used to assert `hold: null` — that the projector never substitutes a
   * video-completion rate for a 15-second hold. The substitution is still
   * forbidden, but `hold` is no longer a key at all: it was a DEFAULT column
   * (the Engagement preset and the default Custom set) that resolved to a
   * literal `null` on every row of every account, so it printed an em dash in
   * every cell it ever occupied. There is no Hold-15s field on
   * `MetaCreativeRow` and no key for one in `META_OBSERVED_METRIC_KEYS`, so
   * nothing could ever fill it.
   *
   * The law survives in the stronger form: the projector emits no key for a
   * metric it cannot measure, and a video quartile sitting on the row does not
   * become one. `video100: 99` is on this fixture precisely so a future
   * "reasonable proxy" fails here.
   */
  it("emits no Hold key and never mints one from a video quartile", () => {
    const [row] = toCreativeStudioAssetRows(
      [creativeRow({ video100: 99, thumbstop: 44 })],
      "USD",
      new Map(),
      WINDOW_END,
    );

    expect(row?.metrics).toMatchObject({
      spend: 100,
      // Revenue is the biggest gap this pass closed: ROAS alone cannot tell a
      // $30 win from a $4,000 one.
      revenue: 400,
      aov: 100,
      ctr: 4,
      thumbstop: 44,
      atcRate: 20,
      cvr: 10,
    });
    expect(Object.keys(row!.metrics)).not.toContain("hold");
    expect(Object.values(row!.metrics)).not.toContain(99);
  });

  /**
   * Every measurable upstream field the catalogue admits is actually projected.
   *
   * The failure this guards is silent: a metric added to `CreativeAssetMetricId`
   * and to a preset, but never assigned here, renders an em dash in every row
   * and nothing goes red. `formatMetric` switches exhaustively over the union,
   * so the compiler catches a missing FORMAT — it cannot catch a missing VALUE.
   */
  it("projects every funnel counter and derived ratio the producer serves", () => {
    const [row] = toCreativeStudioAssetRows(
      [
        creativeRow({
          landingPageViews: 30,
          initiateCheckout: 6,
          cpcLink: 2.5,
          atcToPurchaseRatio: 50,
        }),
      ],
      "USD",
      new Map(),
      WINDOW_END,
    );

    expect(row?.metrics).toMatchObject({
      spend: 100,
      impressions: 1_000,
      revenue: 400,
      clicks: 50,
      linkClicks: 40,
      landingPageViews: 30,
      addToCart: 8,
      initiateCheckout: 6,
      purchases: 4,
      roas: 4,
      cpa: 25,
      cpm: 10,
      cpcLink: 2.5,
      aov: 100,
      ctr: 4,
      frequency: 2.1,
      atcRate: 20,
      atcToPurchase: 50,
      cvr: 10,
    });
  });

  /**
   * WHY: availability used to be all-or-nothing for the whole row, so one
   * absent field withheld every number the payload did carry — a real measured
   * spend disappeared because, say, `frequency` never arrived. Availability is
   * per metric now, and a served 0 is a measurement that must survive: a
   * paused, never-delivered creative really did spend nothing.
   */
  it("withholds only the metrics the producer did not serve", () => {
    const [row] = toCreativeStudioAssetRows(
      [
        creativeRow({
          observedMetrics: {
            spend: 0,
            impressions: 0,
            clicks: 0,
            purchases: 0,
            purchaseValue: 0,
            // Never served by this payload.
            thumbstop: null,
            frequency: null,
          },
        }),
      ],
      "TRY",
      new Map(),
      WINDOW_END,
    );

    expect(row?.metrics).toMatchObject({
      spend: 0,
      impressions: 0,
      clicks: 0,
      purchases: 0,
      thumbstop: null,
      frequency: null,
    });
  });

  /*
   * THE AGE COLUMN'S THREE WAYS OF BEING WRONG, each pinned separately.
   *
   * Age is not decoration: it decides the verdict. $8 at ROAS 0 is UNJUDGED on
   * day 2 and dead on day 30, and the numbers beside it are identical. So each
   * of the three failures below changes what a buyer does.
   *
   *   1. THE WRONG CLOCK. Counting to `Date.now()` instead of to the window's
   *      end puts two clocks in one row. The fixture's window closed on
   *      2026-08-17 and the creative was created on 2026-08-01, so the answer
   *      is 16 FOREVER. A projector reading the system clock returns a
   *      different number every day this suite runs, and cannot return 16 on
   *      any day but 2026-08-17.
   *   2. AN ABSENT DATE PRINTED AS 0. An unsupplied `launch_date` reaches the
   *      wire as `undefined` or as `""` depending on which `coerceRawCreativeRow`
   *      branch the stored projection took, and `safeString` in
   *      `mapApiRowToUiRow` turns both into the EMPTY STRING, so the projector
   *      is handed "" rather than null.
   *      A `Date.parse("")` -> NaN -> `|| 0` anywhere on this path would claim
   *      every unread creative was created on the window's last day, i.e. that
   *      the whole account is brand new and unjudgeable.
   *   3. A MEASURED 0 PRINTED AS AN EM DASH. A creative created ON the window's
   *      last day genuinely has an age, and that age is zero. Withholding it
   *      would hide the single strongest "do not judge this yet" signal the
   *      table has.
   */
  describe("creative age", () => {
    const ageOf = (row: Partial<MetaCreativeRow>, windowEnd: string | null) =>
      toCreativeStudioAssetRows(
        [creativeRow(row)],
        "USD",
        new Map(),
        windowEnd,
      )[0]?.metrics.ageDays;

    it("counts to the window's end, not to today", () => {
      // 2026-08-01 -> 2026-08-17 is 16 days. Whatever today is.
      expect(ageOf({ launchDate: "2026-08-01" }, WINDOW_END)).toBe(16);
      // The same creative, read over a window that closed a week earlier, is
      // seven days younger — which is only true of a projector that reads the
      // window rather than the clock.
      expect(ageOf({ launchDate: "2026-08-01" }, "2026-08-10")).toBe(9);
      // ...and the number never depends on when the suite runs.
      expect(ageOf({ launchDate: "2026-08-01" }, WINDOW_END)).toBe(
        ageOf({ launchDate: "2026-08-01" }, WINDOW_END),
      );
      const today = new Date().toISOString().slice(0, 10);
      expect(
        ageOf({ launchDate: "2026-08-01" }, WINDOW_END),
        "the age moved with the system clock instead of the window",
      ).not.toBe(ageOf({ launchDate: "2026-08-01" }, today));
    });

    it("states a measured zero as 0 for a creative created on the window's last day", () => {
      expect(ageOf({ launchDate: WINDOW_END }, WINDOW_END)).toBe(0);
    });

    it("withholds an age the payload never supplied instead of calling it 0", () => {
      // The empty string is what an unsupplied `launch_date` actually looks
      // like by the time it reaches this row, not a hypothetical null.
      expect(ageOf({ launchDate: "" }, WINDOW_END)).toBeNull();
      expect(ageOf({ launchDate: "   " }, WINDOW_END)).toBeNull();
      expect(ageOf({ launchDate: "not-a-date" }, WINDOW_END)).toBeNull();
      expect(
        ageOf({ launchDate: undefined as unknown as string }, WINDOW_END),
      ).toBeNull();
      // Nor does an absent WINDOW make an age: with nothing to count to, there
      // is no number, and 0 would mean "created the day the window closed".
      expect(ageOf({ launchDate: "2026-08-01" }, null)).toBeNull();
      expect(ageOf({ launchDate: "2026-08-01" }, "")).toBeNull();
    });

    it("withholds a creation date later than the window it is counted to", () => {
      // Not -3, and not a clamped 0: the row is claiming it was created after
      // the last day it reports numbers for, so there is no age to state.
      expect(ageOf({ launchDate: "2026-08-20" }, WINDOW_END)).toBeNull();
    });
  });

  /**
   * WHY: `normalizeCreativeMetricFields` (lib/meta/creatives-service-support.ts)
   * ends every ratio with `: 0`, so a creative that spent ₺33,500 and bought
   * nothing published `cpa: 0`. CPA is a lower-is-better column, so the heat
   * ramp painted that row as the account's cost-per-purchase *leader* — 63 of
   * 107 rows on a live account did exactly this. Zero purchases does not make
   * acquisition free; it makes cost per acquisition undefined, which is an em
   * dash. The spend beside it is real and must stay.
   */
  it("withholds a ratio whose denominator was measured as zero", () => {
    const [row] = toCreativeStudioAssetRows(
      [
        creativeRow({
          spend: 33_500,
          purchases: 0,
          purchaseValue: 0,
          impressions: 0,
          clicks: 0,
          linkClicks: 0,
          addToCart: 0,
          roas: 0,
          cpa: 0,
          cpm: 0,
          linkCtr: 0,
          thumbstop: 0,
          clickToAddToCart: 0,
          clickToPurchase: 0,
        }),
      ],
      "TRY",
      new Map(),
      WINDOW_END,
    );

    expect(row?.metrics).toMatchObject({
      spend: 33_500,
      purchases: 0,
      impressions: 0,
      cpa: null,
      aov: null,
      cpm: null,
      ctr: null,
      thumbstop: null,
      atcRate: null,
      cvr: null,
      roas: 0,
    });
  });

  /**
   * ITEM 17 — this page mints its tab links with the SHARED builder, and the
   * link now states the window in both live spellings.
   *
   * The assertion moved rather than being deleted: `buildCreativeStudioTabHrefs`
   * lives in `lib/meta/creative-studio-tab-hrefs.ts` and is exhaustively pinned
   * by `lib/meta/creative-studio-tab-hrefs.test.ts` (route family, business
   * placement, all five tabs, both spellings, `window=custom`, and the half /
   * malformed pair that carries no window at all). What this test keeps is the
   * fact that matters HERE: Assets re-exports and uses that one builder, so it
   * cannot drift back into a private link format while Landers and Audiences
   * use another.
   *
   * `?startDate`/`?endDate` is the shell's spelling and `?start`/`?end` is the
   * Studio's older one; both are written from one resolved pair, and `window` is
   * `custom` because the exact dates ARE the window — naming a rolling preset
   * would let the destination re-expand it against its own clock and measure
   * different days from the surface the operator just left.
   */
  it("mints tab links with the shared builder, carrying scope and window", () => {
    const scope = {
      businessId: "biz/1",
      providerAccountId: "act_1",
      start: "2026-07-01",
      end: "2026-07-28",
    };

    expect(
      buildCreativeStudioTabHrefs({
        ...scope,
        pathname: "/c/biz%2F1/creative/performance",
      }).copies,
    ).toBe(
      "/c/biz%2F1/creative/copies?providerAccountId=act_1&window=custom" +
        "&startDate=2026-07-01&endDate=2026-07-28" +
        "&start=2026-07-01&end=2026-07-28",
    );
    expect(
      buildCreativeStudioTabHrefs({
        ...scope,
        pathname: "/app/creative/performance",
      }).inbox,
    ).toBe(
      "/app/creative/inbox?providerAccountId=act_1&window=custom" +
        "&startDate=2026-07-01&endDate=2026-07-28" +
        "&start=2026-07-01&end=2026-07-28",
    );
    expect(
      buildCreativeStudioTabHrefs({
        ...scope,
        pathname: "/platforms/meta/creatives",
      }).audiences,
    ).toBe(
      "/platforms/meta/audiences?businessId=biz%2F1&providerAccountId=act_1" +
        "&window=custom&startDate=2026-07-01&endDate=2026-07-28" +
        "&start=2026-07-01&end=2026-07-28",
    );
    // The page's export and the shared module are the same function, not two
    // copies that happen to agree today.
    expect(buildCreativeStudioTabHrefs).toBe(sharedTabHrefBuilder);
  });
});
