// @vitest-environment jsdom
/**
 * ONE PICKED PRESET MUST PRODUCE ONE WINDOW.
 *
 * Three resolvers used to answer the same click differently, and every link in
 * the chain below is one of the seams where they disagreed:
 *
 *   shell picker  →  URL dates  →  outgoing request start/end
 *
 * Proven on the running server before this test existed: at
 * `/platforms/meta?window=7d&startDate=2026-08-11&endDate=2026-08-17` the shell
 * captioned "Last 7 days", the workspace read went out as
 * `?…&window=7d&status_filter=active` with the stated dates thrown away, and
 * the ads series went out as `?start=2026-08-12&end=2026-08-18` — a different
 * week again, because the page body re-expanded "7d" with
 * `includeCurrentDay: true`. Three windows, one click, and the caption named
 * none of the two that were measured.
 *
 * The law these tests state: THE URL'S DATES ARE THE WINDOW, and every request
 * this surface issues measures exactly those days. A preset name is a label
 * for them, expanded once — by the shell writer, to completed days — and never
 * re-expanded downstream against some other component's clock. See
 * `DATE_WINDOW_INCLUDES_CURRENT_DAY` in `lib/dashboard/date-window-url` for why
 * "completed days" is the chosen intent: today is a part-day, and counting it
 * whole breaks the evidence-window day count every rate is divided by.
 *
 * These assertions are on the query strings that actually leave the browser,
 * not on internal state, because "an endpoint exists" was never the problem —
 * the request carried the wrong dates.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  metaLanePayload,
  metaPulse,
} from "@/components/meta/redesign/test-fixtures";
import {
  applyDateWindowToParams,
  resolveDateWindowFromParams,
} from "@/lib/dashboard/date-window-url";

/** The workspace clock every layer in this test resolves "today" against. */
const REFERENCE_DATE = "2026-08-18";
/** 2026-08-18T06:00Z is 09:00 in Europe/Istanbul — the same calendar day. */
const SYSTEM_TIME = new Date("2026-08-18T06:00:00.000Z");

const state = vi.hoisted(() => ({
  search: "",
  pathname: "/platforms/meta",
  captured: [] as Array<{
    queryKey: unknown[];
    queryFn?: (context: { signal: AbortSignal }) => unknown;
  }>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(state.search),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (input: unknown) => unknown) =>
    selector({ businesses: [], selectBusiness: vi.fn() }),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));

/**
 * The view layer is stubbed; the read layer is NOT.
 *
 * What is under test is which dates leave the browser, and those are decided
 * entirely in `MetaPlatformPage`'s own window resolution and its query
 * adapters — both of which stay real here. Building a complete decision view
 * model would only add fixture surface that could fail for reasons unrelated to
 * the window.
 */
vi.mock(
  "@/components/meta/decision-center/meta-decision-center-exact-adapter",
  () => ({
    buildMetaDecisionCenterExactViewModel: () => ({ stub: true }),
    // This file asserts the WINDOW chain, so every other adapter export is
    // stubbed rather than exercised. It must list them all: a factory mock
    // replaces the module wholesale, so an export added later makes the page
    // throw here for a reason that has nothing to do with dates.
    buildMetaStructureInventoryViewModel: () => ({
      servedCount: null,
      campaignCount: null,
      adsetCount: null,
      shownCount: 0,
      searchApplied: false,
      rows: [],
      unavailableReason: null,
    }),
  }),
);

vi.mock("@/components/meta/decision-center/MetaDecisionCenterExact", () => ({
  MetaDecisionCenterExact: () => null,
}));

vi.mock("@tanstack/react-query", () => ({
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (input: {
    queryKey: unknown[];
    queryFn?: (context: { signal: AbortSignal }) => unknown;
  }) => {
    state.captured.push(input);
    return {
      data: queryData(String(input.queryKey[0])),
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      status: "success",
      fetchStatus: "idle",
    };
  },
}));

const { MetaPlatformPage } =
  await import("@/components/meta/redesign/MetaPlatformPage");

/**
 * Enough of the served payload for the page to reach its per-ad series read.
 * The queue sparkline query only issues a request once the workspace has named
 * some ads, and that request is one of the three the window has to reach.
 */
function workspacePayload() {
  const pulse = metaPulse();
  const lanes = metaLanePayload();
  return {
    businessId: pulse.businessId,
    window: pulse.window,
    statusFilter: pulse.statusFilter,
    startDate: pulse.startDate,
    endDate: pulse.endDate,
    pulse,
    lanes,
    queue: { groups: [], actionStates: {} },
    system: {
      trackingBlocked: false,
      dataReadiness: pulse.dataReadiness ?? null,
      snapshotHealth: pulse.snapshotHealth ?? lanes.snapshotHealth ?? null,
      laneSnapshotDate: lanes.snapshotDate,
      laneSnapshotCreatedAt: lanes.snapshotCreatedAt ?? null,
      engineVersion: pulse.engineVersion,
      currency: pulse.currency ?? null,
      killSwitchEngaged: false,
      killSwitchReason: null,
    },
    decisionReadModel: {
      contractVersion: "meta-decisions-workspace.read.v1",
      status: "available",
      generatedAt: "2026-08-17T12:00:00.000Z",
      scope: {
        businessId: "biz_1",
        providerAccountId: "act_1",
        decisionMode: "current",
        metricsRangeAffectsDecisionSnapshot: false,
      },
      unavailable: null,
      source: {
        status: "available",
        authority: "legacy_creative",
        table: "engine_v3_decision_snapshots_daily",
        snapshotAsOf: "2026-08-17",
        computedAt: "2026-08-17T06:00:00.000Z",
        engineVersion: "v3-test",
        fallbackReason: "native_generation_unavailable",
        generation: null,
      },
      queue: {
        deduplicationGrain: "creative",
        sourcePreCapCount: 0,
        queuedPreCapCount: 0,
        sections: {
          integrity_fires: emptyCanonicalSection("integrity_fires"),
          money_moves: emptyCanonicalSection("money_moves"),
          creative_rotation: emptyCanonicalSection("creative_rotation"),
        },
        omittedFromQueue: { count: 0, reasons: [] },
      },
      capabilities: {},
    },
    os: { ads: { items: [{ adId: "ad_1" }] } },
  } as unknown;
}

function emptyCanonicalSection(key: string) {
  return {
    key,
    label: key,
    topN: 5,
    preCapCount: 0,
    selectedCount: 0,
    rankablePreCapCount: 0,
    unrankablePreCapCount: 0,
    items: [],
    exposureDigest: {
      basis: "pre_cap",
      byCurrency: [],
      unavailableCount: 0,
      crossCurrencyTotal: null,
    },
    suppressionReceipt: {
      receiptId: `receipt_${key}`,
      selectionVersion: "meta-decisions-section-selection.v1",
      topN: 5,
      preCapCount: 0,
      selectedCount: 0,
      suppressedCount: 0,
      reasons: [],
    },
  };
}

function queryData(key: string): unknown {
  if (key === "meta-provider-accounts") {
    return [
      {
        id: "act_1",
        name: "Main Meta",
        currency: "USD",
        timezone: "Europe/Istanbul",
      },
    ];
  }
  if (key === "meta-decisions-workspace") return workspacePayload();
  if (key === "meta-anomalies")
    return { anomalies: [], snapshotDate: "2026-08-17", count: 0 };
  if (key === "triage-state") return { rows: [], deferredCount: 0 };
  return undefined;
}

/**
 * The URL the shell's date picker writes for a preset.
 *
 * `AppTopbar` has no expansion of its own — it calls exactly this — so this is
 * the first link of the chain rather than a restatement of it.
 */
function shellUrlForPreset(preset: "7d" | "14d" | "28d"): URLSearchParams {
  return applyDateWindowToParams(
    new URLSearchParams("businessId=biz_1&providerAccountId=act_1"),
    { rangePreset: preset, customStart: "", customEnd: "" },
    REFERENCE_DATE,
  );
}

/** Render the Meta surface at `search` and return the requests it would send. */
async function requestsAt(
  search: string,
): Promise<Map<string, URLSearchParams>> {
  state.search = search;
  state.captured.length = 0;
  renderToStaticMarkup(
    <MetaPlatformPage businessId="biz_1" serverProviderAccountId="act_1" />,
  );

  const requests = new Map<string, URLSearchParams>();
  for (const query of state.captured) {
    if (!query.queryFn) continue;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rows: [], series: [], points: [], anomalies: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await Promise.resolve(
      query.queryFn({ signal: new AbortController().signal }),
    ).catch(() => null);
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      const [path, query_ = ""] = url.split("?", 2);
      requests.set(path!, new URLSearchParams(query_));
    }
    vi.unstubAllGlobals();
  }
  return requests;
}

describe("one picked preset produces one window", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(SYSTEM_TIME);
    state.pathname = "/platforms/meta";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("expands a preset to completed days, never to a window ending on today's part-day", () => {
    const params = shellUrlForPreset("7d");
    // Seven whole days ending yesterday. Ending on 2026-08-18 would count a
    // day that is still being written as if it were finished, which is the
    // evidence-window day-count invariant broken from the other end.
    expect(params.get("startDate")).toBe("2026-08-11");
    expect(params.get("endDate")).toBe("2026-08-17");
    expect(params.get("window")).toBe("7d");
    // The scope parameters sharing the URL are untouched.
    expect(params.get("businessId")).toBe("biz_1");
    expect(params.get("providerAccountId")).toBe("act_1");
  });

  it("sends the URL's dates on EVERY request, for a preset window as much as a custom one", async () => {
    const shellParams = shellUrlForPreset("7d");
    const start = shellParams.get("startDate")!;
    const end = shellParams.get("endDate")!;

    const requests = await requestsAt(shellParams.toString());

    const workspace = requests.get("/api/meta/decisions-workspace");
    expect(
      workspace,
      "the surface never issued a workspace read",
    ).toBeDefined();
    // This was the proven defect: `window=7d` went out alone and the route
    // resolved an end date of its own.
    expect(workspace!.get("startDate")).toBe(start);
    expect(workspace!.get("endDate")).toBe(end);
    // The preset key still travels so the served answer can name the window.
    expect(workspace!.get("window")).toBe("7d");

    const series = requests.get("/api/meta/ads/series");
    expect(
      series,
      "the surface never issued a per-ad series read",
    ).toBeDefined();
    // This one used to read 2026-08-12..2026-08-18 while the caption said
    // "Last 7 days" over 08-11..08-17.
    expect(series!.get("start")).toBe(start);
    expect(series!.get("end")).toBe(end);

    const anomalies = requests.get("/api/meta/anomalies");
    expect(
      anomalies,
      "the surface never issued an anomalies read",
    ).toBeDefined();
    // Undated, this showed TODAY's anomalies above a historical week's
    // decisions.
    expect(anomalies!.get("endDate")).toBe(end);

    // The chain closes: every measured window is the one window the URL states.
    const measured = new Set([
      `${workspace!.get("startDate")}..${workspace!.get("endDate")}`,
      `${series!.get("start")}..${series!.get("end")}`,
    ]);
    expect(measured).toEqual(new Set([`${start}..${end}`]));
  });

  it("honours exact dates whatever the preset key says, instead of re-expanding the label", async () => {
    // A 14-day span carrying a `7d` key. The key used to win and the dates
    // were discarded unless the key happened to read `custom`; now the dates
    // are the window and the key is only its name.
    const requests = await requestsAt(
      "businessId=biz_1&providerAccountId=act_1&window=7d&startDate=2026-06-01&endDate=2026-06-14",
    );
    const workspace = requests.get("/api/meta/decisions-workspace")!;
    expect(workspace.get("startDate")).toBe("2026-06-01");
    expect(workspace.get("endDate")).toBe("2026-06-14");
    const series = requests.get("/api/meta/ads/series")!;
    expect(series.get("start")).toBe("2026-06-01");
    expect(series.get("end")).toBe("2026-06-14");
  });

  it("resolves a bare preset the same way the shell writer would have", async () => {
    // A link that names only `window=7d` must land on the same seven days the
    // picker would have written, not on a second opinion resolved here.
    const requests = await requestsAt(
      "businessId=biz_1&providerAccountId=act_1&window=7d",
    );
    const workspace = requests.get("/api/meta/decisions-workspace")!;
    expect(workspace.get("startDate")).toBe("2026-08-11");
    expect(workspace.get("endDate")).toBe("2026-08-17");
    expect(shellUrlForPreset("7d").get("startDate")).toBe(
      workspace.get("startDate"),
    );
    expect(shellUrlForPreset("7d").get("endDate")).toBe(
      workspace.get("endDate"),
    );
  });

  it("keeps the shared resolver and the shell writer in exact agreement for every preset", () => {
    for (const preset of ["7d", "14d", "28d"] as const) {
      const written = shellUrlForPreset(preset);
      const read = resolveDateWindowFromParams(written, REFERENCE_DATE);
      expect(read, `no window read back for ${preset}`).not.toBeNull();
      expect(read!.start).toBe(written.get("startDate"));
      expect(read!.end).toBe(written.get("endDate"));
      // The label survives the round trip, so the caption keeps naming the
      // preset that was actually measured.
      expect(read!.preset).toBe(preset);
    }
  });
});
