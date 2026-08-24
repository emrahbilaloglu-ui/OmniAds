// @vitest-environment jsdom

import { useQuery } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CreativeStudioPage from "@/app/(dashboard)/platforms/meta/creatives/legacy-page";

/**
 * What the Assets surface tells the shared Tier-0 freshness contract.
 *
 * Split out of `page.test.tsx` because that file renders through
 * `renderToStaticMarkup`, where effects never run and `useTierZeroFreshness`
 * therefore never reports anything. The age a surface claims is not something
 * an SSR string can prove.
 */

const navigation = vi.hoisted(() => ({
  pathname: "/platforms/meta/creatives",
  search: "",
}));

const queryState = vi.hoisted(() => ({
  accounts: [{ id: "act_1", name: "Main", timezone: "UTC", currency: "TRY" }] as unknown,
  creatives: undefined as unknown,
  briefing: undefined as unknown,
  briefingError: null as Error | null,
  sharedLinks: undefined as unknown,
}));

const freshness = vi.hoisted(() => vi.fn());

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
  useTierZeroFreshness: freshness,
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
  PlanGate: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const useQueryMock = vi.mocked(useQuery);

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
  navigation.pathname = "/platforms/meta/creatives";
  navigation.search = "";
  queryState.accounts = [
    { id: "act_1", name: "Main", timezone: "UTC", currency: "TRY" },
  ];
  queryState.creatives = undefined;
  queryState.briefing = undefined;
  queryState.briefingError = null;
  queryState.sharedLinks = undefined;
  freshness.mockReset();
  useQueryMock.mockReset();
  useQueryMock.mockImplementation((options: { queryKey?: readonly unknown[] }) => {
    const key = options.queryKey?.[0];
    const data =
      key === "meta-provider-accounts"
        ? queryState.accounts
        : key === "meta-creative-studio"
          ? queryState.creatives
          : key === "creative-share-links"
            ? queryState.sharedLinks
            : queryState.briefing;
    const error = key === "meta-creative-studio-briefing" ? queryState.briefingError : null;
    return {
      data,
      error,
      fetchStatus: "idle",
      isError: Boolean(error),
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
      status: error ? "error" : data ? "success" : "pending",
    } as unknown as ReturnType<typeof useQuery>;
  });
});

afterEach(() => cleanup());

describe("Creative Studio Assets: the age comes from the rows' own source", () => {
  /**
   * WHY: this bar used to be dated from the briefing snapshot's `observedAt`,
   * which is when a *decision computation* ran — a different clock from the one
   * that wrote the metrics in the table. On a live account the two were a day
   * apart: the decision snapshot said 2026-08-17T06:01Z while
   * `meta_creative_daily` for the same account had been written
   * 2026-08-18T04:34Z, and the topbar chip read "Synced 1d ago" over rows that
   * were hours old. `/api/meta/creatives` now publishes
   * `warehouse_observed_at` from `MAX(updated_at)` over the very rows it
   * returned, and that is the only instant this surface may claim.
   */
  it("dates the table from warehouse_observed_at, not the decision snapshot", () => {
    queryState.creatives = {
      status: "ok",
      rows: [],
      warehouse_observed_at: "2026-08-18T04:34:04.744Z",
    };
    queryState.briefing = {
      source: {
        measurementReconciliation: {
          snapshotLatest: { observedAt: "2026-08-17T06:01:49.189Z" },
        },
      },
    };

    render(<CreativeStudioPage businessId="biz_1" providerAccountId="act_1" />);

    expect(lastFreshnessCall().asOf).toBe("2026-08-18T04:34:04.744Z");
  });

  /**
   * WHY: a live read has no warehouse write behind it, so there is no
   * observation instant to report. `lib/tier-zero-as-of.ts` exists because a
   * surface dated from its own request is fresh by construction and can never
   * say "stale" — and the briefing instant is not a fallback, it is a different
   * measurement. "Age unknown" is the honest answer.
   */
  it("keeps the age unknown rather than borrowing the briefing instant", () => {
    queryState.creatives = {
      status: "ok",
      rows: [],
      snapshot_source: "live",
      warehouse_observed_at: null,
    };
    queryState.briefing = {
      source: {
        measurementReconciliation: {
          snapshotLatest: { observedAt: "2026-08-17T06:01:49.189Z" },
        },
      },
    };

    render(<CreativeStudioPage businessId="biz_1" providerAccountId="act_1" />);

    expect(lastFreshnessCall().asOf).toBeNull();
  });

  /**
   * WHY: a server-declared partial is a served surface with a stated gap. The
   * envelope carried `isPartial`/`notReadyReason` and this page dropped both,
   * so a window that was still being prepared read as a finished one.
   */
  it("states the server's own partial reason", () => {
    queryState.creatives = {
      status: "ok",
      rows: [],
      isPartial: true,
      notReadyReason: "Current-day live Meta creative data is still being prepared.",
      warehouse_observed_at: null,
    };

    render(<CreativeStudioPage businessId="biz_1" providerAccountId="act_1" />);

    expect(lastFreshnessCall().partialReason).toContain(
      "Current-day live Meta creative data is still being prepared.",
    );
  });

  /**
   * WHY: a whole surface must not claim to be partial. A standing partial chip
   * is noise, and noise is how a real partial gets ignored.
   */
  it("reports no partial when the response declared none", () => {
    queryState.creatives = {
      status: "ok",
      rows: [],
      warehouse_observed_at: "2026-08-18T04:34:04.744Z",
    };

    render(<CreativeStudioPage businessId="biz_1" providerAccountId="act_1" />);

    expect(lastFreshnessCall().partialReason).toBeNull();
  });
});
