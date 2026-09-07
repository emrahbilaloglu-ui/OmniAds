// @vitest-environment jsdom

/**
 * Meta History client behaviour and replay evidence.
 *
 * Two laws are pinned here.
 *
 * 1. Clearing a filter is a filter change. The refetch effect used to skip any
 *    transition back to the defaults, so emptying the search box left the three
 *    filtered rows on screen with no filter applied: the table then claimed to
 *    be the whole journal while showing a search result, and "Load more" paged
 *    an unfiltered cursor onto filtered rows, mixing two result sets in one
 *    table. The skip must be "these rows were already read for these filters",
 *    never "the filters are empty".
 *
 * 2. A replay names its engine. The design's permanent replay caveat exists to
 *    say a row is a reconstruction; the version badge says *which* engine
 *    reconstructed it. The served `replay.engineVersion` was dropped in the
 *    adapter, so no replay could ever say. A version the source did not record
 *    renders as an em-dash — never as the current engine's version, which would
 *    date a reconstruction wrongly.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const fetchMetaHistoryPage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/meta/history-client", () => ({ fetchMetaHistoryPage }));
// Mutable, because one test below is about what the ACCOUNT PICKER does to the
// query it was given. A frozen empty query cannot fail for a picker that drops
// the window.
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  search: "",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: router.push, replace: router.replace }),
  usePathname: () => "/c/biz_1/meta/history",
  useSearchParams: () => new URLSearchParams(router.search),
}));

import { HistoryAccountPicker } from "@/components/zero-base/meta/history/history-account-picker";
import { HistoryClient } from "@/components/zero-base/meta/history/history-client";
import { HistoryView } from "@/components/zero-base/meta/history/history-view";
import type { HistoryPage } from "@/lib/zero-base/meta/history-adapter";

afterEach(cleanup);

function page(rows: HistoryPage["rows"]): HistoryPage {
  return {
    rows,
    disclosure: null,
    limitations: [],
    accountLabel: "act_1",
    nextCursor: null,
  };
}

/**
 * The window the shell states, as the server resolved it.
 *
 * Every read below asserts these two dates travel unchanged. `from`/`to` used
 * to be hard-coded `null` on all three client paths, so the table under a shell
 * that said "Last 7 days" was the whole journal — and "Load more" kept paging
 * that unbounded cursor.
 */
const WINDOW = {
  start: "2026-08-11",
  end: "2026-08-17",
  preset: "7d",
  source: "url",
} as const;

const UNFILTERED = page([
  {
    id: "h1",
    occurredAt: "2026-08-11T09:00:00.000Z",
    action: "Pause ad",
    outcome: "verified",
    actor: "Ada",
    replayed: false,
  },
  {
    id: "h2",
    occurredAt: "2026-08-11T08:00:00.000Z",
    action: "Raise budget",
    outcome: "verified",
    actor: "Ada",
    replayed: false,
  },
]);

function servedPayload() {
  return {
    entries: [],
    page: { limit: 40, returned: 0, total: null, nextCursor: null },
    scope: { providerAccountId: "act_1", providerAccountName: "act_1" },
    limitations: [],
  };
}

describe("clearing a filter issues an unfiltered read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMetaHistoryPage.mockResolvedValue(servedPayload());
  });

  it("does not re-read page one on mount", async () => {
    render(
      <HistoryClient
        businessId="biz_1"
        providerAccountId="act_1"
        dateWindow={WINDOW}
        initialPage={UNFILTERED}
        pageLimit={40}
      />,
    );
    // The server already delivered exactly this page.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fetchMetaHistoryPage).not.toHaveBeenCalled();
  });

  it("re-reads with no query when the search box is emptied", async () => {
    const user = userEvent.setup();
    render(
      <HistoryClient
        businessId="biz_1"
        providerAccountId="act_1"
        dateWindow={WINDOW}
        initialPage={UNFILTERED}
        pageLimit={40}
      />,
    );
    const search = document.querySelector<HTMLInputElement>(
      '[data-ctl="live:META-HIST-05 search"]',
    )!;

    await user.type(search, "budget");
    await waitFor(() => expect(fetchMetaHistoryPage).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    expect(fetchMetaHistoryPage.mock.calls[0][0].filters.q).toBe("budget");
    expect(fetchMetaHistoryPage.mock.calls[0][0].filters.from).toBe(
      WINDOW.start,
    );
    expect(fetchMetaHistoryPage.mock.calls[0][0].filters.to).toBe(WINDOW.end);

    await user.clear(search);
    await waitFor(() => expect(fetchMetaHistoryPage).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    // `null`, not "": the unfiltered journal, asked for explicitly.
    expect(fetchMetaHistoryPage.mock.calls[1][0].filters.q).toBeNull();
    // ...but "unfiltered" is not "unbounded". Clearing a search clears the
    // search; it does not widen the window the shell states.
    expect(fetchMetaHistoryPage.mock.calls[1][0].filters.from).toBe(
      WINDOW.start,
    );
    expect(fetchMetaHistoryPage.mock.calls[1][0].filters.to).toBe(WINDOW.end);
  });

  it("re-reads when the outcome filter returns to all", async () => {
    const user = userEvent.setup();
    render(
      <HistoryClient
        businessId="biz_1"
        providerAccountId="act_1"
        dateWindow={WINDOW}
        initialPage={UNFILTERED}
        pageLimit={40}
      />,
    );
    const outcome = document.querySelector<HTMLSelectElement>(
      '[data-ctl="live:META-HIST-05 filter"]',
    )!;

    await user.selectOptions(outcome, "failed");
    await waitFor(() => expect(fetchMetaHistoryPage).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    expect(fetchMetaHistoryPage.mock.calls[0][0].filters.outcome).toBe(
      "failed",
    );

    await user.selectOptions(outcome, "all");
    await waitFor(() => expect(fetchMetaHistoryPage).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    expect(fetchMetaHistoryPage.mock.calls[1][0].filters.outcome).toBeNull();
    expect(fetchMetaHistoryPage.mock.calls[1][0].filters.from).toBe(
      WINDOW.start,
    );
    expect(fetchMetaHistoryPage.mock.calls[1][0].filters.to).toBe(WINDOW.end);
  });
});

describe("history limitations stay visible without exposing internals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("summarizes served limitations with stable operator copy", () => {
    render(
      <HistoryView
        rows={UNFILTERED.rows}
        limitations={[
          "source_read_failed: relation history_projection missing",
        ]}
      />,
    );

    const notice = document.querySelector("[data-history-limitations]");
    expect(notice?.textContent).toContain(
      "Some history details are unavailable. The entries shown may be incomplete.",
    );
    expect(document.body.textContent).not.toContain("source_read_failed");
    expect(document.body.textContent).not.toContain("history_projection");
  });

  it("keeps existing rows and marks them incomplete when a later page fails", async () => {
    fetchMetaHistoryPage.mockRejectedValue(
      new Error("cursor_read_failed: database connection refused"),
    );
    const user = userEvent.setup();
    render(
      <HistoryClient
        businessId="biz_1"
        providerAccountId="act_1"
        dateWindow={WINDOW}
        initialPage={{ ...UNFILTERED, nextCursor: "cursor_page_2" }}
        pageLimit={40}
      />,
    );

    await user.click(
      document.querySelector<HTMLButtonElement>(
        '[data-ctl="live:META-HIST-05 cursor"]',
      )!,
    );

    await waitFor(() =>
      expect(
        document.querySelector("[data-history-limitations]"),
      ).not.toBeNull(),
    );
    expect(document.body.textContent).toContain("Pause ad");
    expect(document.body.textContent).toContain("may be incomplete");
    expect(document.body.textContent).not.toContain("cursor_read_failed");
    expect(document.body.textContent).not.toContain("database connection");
  });
});

describe("the stated window is the window History reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMetaHistoryPage.mockResolvedValue(servedPayload());
  });

  it("pages Load more inside the same window", async () => {
    const user = userEvent.setup();
    render(
      <HistoryClient
        businessId="biz_1"
        providerAccountId="act_1"
        dateWindow={WINDOW}
        initialPage={{ ...UNFILTERED, nextCursor: "cursor_page_2" }}
        pageLimit={40}
      />,
    );

    await user.click(
      document.querySelector<HTMLButtonElement>(
        '[data-ctl="live:META-HIST-05 cursor"]',
      )!,
    );

    await waitFor(() => expect(fetchMetaHistoryPage).toHaveBeenCalledTimes(1));
    const call = fetchMetaHistoryPage.mock.calls[0][0];
    expect(call.cursor).toBe("cursor_page_2");
    // The second page must answer the same question as the first. An unbounded
    // page-two appended to a windowed page-one puts two different windows'
    // rows in one table, under one caption.
    expect(call.filters.from).toBe(WINDOW.start);
    expect(call.filters.to).toBe(WINDOW.end);
  });

  it("re-reads page one when the shell moves the window", async () => {
    const { rerender } = render(
      <HistoryClient
        businessId="biz_1"
        providerAccountId="act_1"
        dateWindow={WINDOW}
        initialPage={{ ...UNFILTERED, nextCursor: "cursor_page_2" }}
        pageLimit={40}
      />,
    );

    rerender(
      <HistoryClient
        businessId="biz_1"
        providerAccountId="act_1"
        dateWindow={{
          start: "2026-07-01",
          end: "2026-07-31",
          preset: "custom",
          source: "url",
        }}
        initialPage={{ ...UNFILTERED, nextCursor: "cursor_page_2" }}
        pageLimit={40}
      />,
    );

    await waitFor(() => expect(fetchMetaHistoryPage).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    const call = fetchMetaHistoryPage.mock.calls[0][0];
    expect(call.filters.from).toBe("2026-07-01");
    expect(call.filters.to).toBe("2026-07-31");
    // Page one of the NEW window. Carrying the old cursor would page into the
    // previous window's result set.
    expect(call.cursor).toBeNull();
  });

  it("prints the window these rows were read for", async () => {
    // The dates on screen are the dates that were read. Without this line the
    // only statement of the window is the shell's chip, which is a different
    // component reading a different source.
    render(
      <HistoryClient
        businessId="biz_1"
        providerAccountId="act_1"
        dateWindow={WINDOW}
        initialPage={UNFILTERED}
        pageLimit={40}
      />,
    );

    const line = document.querySelector("[data-history-window]")!;
    expect(line.textContent).toContain("2026-08-11 – 2026-08-17");
    expect(line.getAttribute("data-history-window-source")).toBe("url");
    // A window the link stated needs no apology beside it.
    expect(line.textContent).not.toMatch(/entries outside it are not shown/);
  });

  it("reads the defaulted window while keeping the visible date line concise", async () => {
    // RESTATED LAW. This test used to assert `from: null, to: null` for a URL
    // that stated no window, with the reasoning that an invented default "would
    // hide entries nobody asked to exclude — and would do it silently".
    //
    // The hiding half of that stands; the silence half is what changed, and it
    // is why the reading reversed. Unbounded was never neutral: the chip above
    // this table always asserts a window, so a table ignoring it answered a
    // question nobody asked while the control named the one they did — the whole
    // journal back to the account's first entry, under "Last 28 days".
    //
    // So the server resolves the shell's own default preset and marks it
    // `source: "default"`, and this surface prints that fact in the same line as
    // the dates. The exclusion is still real; it is no longer invisible.
    const user = userEvent.setup();
    const defaulted = {
      start: "2026-07-21",
      end: "2026-08-17",
      preset: "28d",
      source: "default",
    } as const;
    render(
      <HistoryClient
        businessId="biz_1"
        providerAccountId="act_1"
        dateWindow={defaulted}
        initialPage={UNFILTERED}
        pageLimit={40}
      />,
    );

    const line = document.querySelector("[data-history-window]")!;
    expect(line.getAttribute("data-history-window-source")).toBe("default");
    expect(line.textContent).toContain("2026-07-21 – 2026-08-17");
    expect(line.textContent).not.toMatch(/default window|entries outside it/i);

    // And every later read is bounded by the same two days — a search that fell
    // back to unbounded would answer a wider question than the one on screen.
    await user.type(
      document.querySelector<HTMLInputElement>(
        '[data-ctl="live:META-HIST-05 search"]',
      )!,
      "budget",
    );
    await waitFor(() => expect(fetchMetaHistoryPage).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    expect(fetchMetaHistoryPage.mock.calls[0][0].filters.from).toBe(
      defaulted.start,
    );
    expect(fetchMetaHistoryPage.mock.calls[0][0].filters.to).toBe(
      defaulted.end,
    );
  });
});

describe("choosing an account keeps the window that was stated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    router.search = "";
  });

  it("carries every window parameter onto the account it navigates to", async () => {
    // The picker is only ever rendered where scope did not resolve — a business
    // with several assigned Meta accounts, opened with no selection. Rebuilding
    // the query from scratch there would drop `startDate`/`endDate`, and the
    // first thing the operator saw after choosing an account would be a journal
    // measured over a window nobody picked.
    const user = userEvent.setup();
    router.search =
      "window=7d&startDate=2026-08-11&endDate=2026-08-17&replay=h1";
    render(
      <HistoryAccountPicker
        accounts={[
          {
            id: "act_A",
            name: "First account",
            currency: "USD",
            timezone: "UTC",
          },
          {
            id: "act_B",
            name: "Second account",
            currency: "EUR",
            timezone: "UTC",
          },
        ]}
      />,
    );

    await user.selectOptions(
      document.querySelector<HTMLSelectElement>(
        '[data-control="account-picker"] select',
      )!,
      "act_B",
    );

    expect(router.push).toHaveBeenCalledTimes(1);
    const href = router.push.mock.calls[0]![0] as string;
    const next = new URLSearchParams(href.split("?")[1] ?? "");
    expect(next.get("providerAccountId")).toBe("act_B");
    expect(next.get("window")).toBe("7d");
    expect(next.get("startDate")).toBe("2026-08-11");
    expect(next.get("endDate")).toBe("2026-08-17");
    // And nothing else on the URL is lost either — a dropped `replay` turns a
    // deep link into a different page.
    expect(next.get("replay")).toBe("h1");
  });

  it("masks an unnamed account instead of showing its full provider id", () => {
    render(
      <HistoryAccountPicker
        accounts={[
          {
            id: "act_12345678",
            name: null,
            currency: "USD",
            timezone: "UTC",
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("option", { name: /Meta account/ }),
    ).toHaveTextContent("Meta account ••••5678 · USD");
    expect(document.body.textContent).not.toContain("act_12345678");
  });
});

describe("the replay drawer keeps historical context without engine internals", () => {
  const replayed = {
    id: "h9",
    occurredAt: "2026-08-11T09:00:00.000Z",
    action: "Scale budget | Prospecting — broad",
    outcome: "verified",
    actor: null,
    replayed: true,
  };

  it("does not expose the served engine version", async () => {
    const user = userEvent.setup();
    render(
      <HistoryView
        rows={[{ ...replayed, replayEngineVersion: "v3" }]}
        onReplay={vi.fn()}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: /replay/i })[0]);
    expect(
      document.querySelector('[data-replay-engine-version="h9"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("v3");
    expect(document.body.textContent).toContain(
      "Historical view. It may differ from the account today.",
    );
  });

  it("does not add an engine placeholder when no version was recorded", async () => {
    const user = userEvent.setup();
    render(
      <HistoryView
        rows={[{ ...replayed, replayEngineVersion: null }]}
        onReplay={vi.fn()}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: /replay/i })[0]);
    expect(
      document.querySelector('[data-replay-engine-version="h9"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain(
      "Historical view. It may differ from the account today.",
    );
  });

  it("shows served money facts, and an em-dash for one with no resolvable currency", async () => {
    const user = userEvent.setup();
    render(
      <HistoryView
        rows={[
          {
            ...replayed,
            summary: "Spend outran the account ROAS floor.",
            money: [
              {
                label: "Before spend",
                amount: 120,
                currency: "USD",
                availability: "available",
                attribution: "meta_attributed",
              },
              {
                label: "After spend",
                amount: null,
                currency: null,
                availability: "currency_unavailable",
                attribution: "meta_attributed",
              },
            ],
          },
        ]}
        onReplay={vi.fn()}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: /replay/i })[0]);
    expect(
      document.querySelector('[data-replay-money="Before spend"]')!.textContent,
    ).toBe("120 USD");
    // A number with no currency is not an amount; printing "0" or a bare 120
    // here would be a sum in whatever currency the reader assumed.
    expect(
      document.querySelector('[data-replay-money="After spend"]')!.textContent,
    ).toBe("—");
    expect(
      document.querySelector('[data-replay-summary="h9"]')!.textContent,
    ).toBe("Spend outran the account ROAS floor.");
  });

  it("does not offer an engine version for a row recorded at the time", async () => {
    const user = userEvent.setup();
    render(
      <HistoryView
        rows={[
          {
            ...replayed,
            id: "h10",
            replayed: false,
            replayEngineVersion: null,
          },
        ]}
        onReplay={vi.fn()}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: /replay/i })[0]);
    // Nothing replayed it, so there is no replaying engine to name.
    expect(
      document.querySelector('[data-replay-engine-version="h10"]'),
    ).toBeNull();
  });
});
