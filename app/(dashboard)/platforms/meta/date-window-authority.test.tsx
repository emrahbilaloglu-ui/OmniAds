// @vitest-environment jsdom

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The chain, end to end: a window stated on the URL has to survive the shell
 * hook, the page body, the adapter and the request that finally leaves the
 * browser. Anything less and the picker is still decorative — which is exactly
 * what it was: a preferences store that six of the nine Meta surfaces never
 * read and no server-rendered surface could read at all.
 *
 * Nothing here mocks the date hook. That is the point: the real
 * `usePersistentDateRange` reads the real URL, and the assertion is on the
 * query string of the outgoing `/api/meta/creatives` request.
 */
const appState = vi.hoisted(() => ({
  selectedBusinessId: "biz_1" as string | null,
  workspaceResolved: true,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/platforms/meta/landing-pages",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) =>
    selector(appState),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));

vi.mock("@/components/pricing/PlanGate", () => ({
  PlanGate: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const LandingPagesPage = (
  await import("@/app/(dashboard)/platforms/meta/landing-pages/legacy-page")
).default;
const { usePreferencesStore } = await import("@/store/preferences-store");

const useQueryMock = vi.mocked(useQuery);
type CapturedQuery = { queryKey: readonly unknown[]; queryFn?: () => unknown };
const captured: CapturedQuery[] = [];

function idleResult(queryKey: readonly unknown[]) {
  if (queryKey[0] === "meta-provider-accounts") {
    return {
      data: [
        { id: "act_1", name: "Main", timezone: "Europe/Istanbul" },
      ],
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    };
  }
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  };
}

/** The request the destinations read would actually send. */
async function creativesRequestUrl(): Promise<string> {
  const destinations = captured.find(
    (input) => input.queryKey[0] === "meta-creative-destinations",
  );
  expect(destinations, "the surface never issued a destinations read").toBeDefined();
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      rows: [],
      currency: "TRY",
      providerAccountId: "act_1",
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  // The response body is irrelevant here; the request is the assertion.
  await Promise.resolve(destinations!.queryFn?.()).catch(() => null);
  const url = fetchMock.mock.calls[0]?.[0] as string;
  expect(url, "the destinations read sent no request").toBeTruthy();
  return url;
}

describe("a stated window reaches the request", () => {
  beforeEach(() => {
    captured.length = 0;
    useQueryMock.mockReset();
    useQueryMock.mockImplementation(((input: CapturedQuery) => {
      captured.push(input);
      return idleResult(input.queryKey);
    }) as unknown as typeof useQuery);
    usePreferencesStore.setState({ dashboardDateRange: null });
    window.history.replaceState(null, "", "/platforms/meta/landing-pages");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sends the window the URL names, not the one this browser stored", async () => {
    usePreferencesStore.getState().setDashboardDateRange({
      rangePreset: "custom",
      customStart: "2026-05-01",
      customEnd: "2026-05-28",
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    });
    window.history.replaceState(
      null,
      "",
      "/platforms/meta/landing-pages?providerAccountId=act_1&window=custom&startDate=2026-07-01&endDate=2026-07-14",
    );

    render(<LandingPagesPage />);

    const url = await creativesRequestUrl();
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(url.startsWith("/api/meta/creatives?")).toBe(true);
    expect(params.get("start")).toBe("2026-07-01");
    expect(params.get("end")).toBe("2026-07-14");
    expect(params.get("businessId")).toBe("biz_1");
    expect(params.get("providerAccountId")).toBe("act_1");
    expect(url).not.toContain("2026-05-01");
  });

  it("keys the cached read on the stated window, so a previous one cannot be served for it", () => {
    window.history.replaceState(
      null,
      "",
      "/platforms/meta/landing-pages?providerAccountId=act_1&window=custom&startDate=2026-07-01&endDate=2026-07-14",
    );
    render(<LandingPagesPage />);
    const first = captured.find(
      (input) => input.queryKey[0] === "meta-creative-destinations",
    )!.queryKey;

    cleanup();
    captured.length = 0;
    window.history.replaceState(
      null,
      "",
      "/platforms/meta/landing-pages?providerAccountId=act_1&window=custom&startDate=2026-06-01&endDate=2026-06-14",
    );
    render(<LandingPagesPage />);
    const second = captured.find(
      (input) => input.queryKey[0] === "meta-creative-destinations",
    )!.queryKey;

    expect(first).not.toEqual(second);
    expect(first).toContain("2026-07-01");
    expect(second).toContain("2026-06-01");
  });

  it("keys it on the business too, so a switch cannot show the previous workspace's answer", () => {
    window.history.replaceState(
      null,
      "",
      "/platforms/meta/landing-pages?providerAccountId=act_1&window=custom&startDate=2026-07-01&endDate=2026-07-14",
    );
    render(<LandingPagesPage />);
    const first = captured.find(
      (input) => input.queryKey[0] === "meta-creative-destinations",
    )!.queryKey;

    cleanup();
    captured.length = 0;
    appState.selectedBusinessId = "biz_2";
    render(<LandingPagesPage />);
    const second = captured.find(
      (input) => input.queryKey[0] === "meta-creative-destinations",
    )!.queryKey;
    appState.selectedBusinessId = "biz_1";

    expect(first).toContain("biz_1");
    expect(second).toContain("biz_2");
    expect(first).not.toEqual(second);
  });
});
