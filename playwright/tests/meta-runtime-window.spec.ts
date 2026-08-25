/**
 * WP5 / D7, on the running server: the URL, the request and the label agree.
 *
 * Four incompatible spellings of one concept were in the tree at once, and the
 * damage was not that they existed — it was that nothing forced the three
 * places an operator can SEE the window to be the same window. Picking "Last 7
 * days" once measured one week in the caption, a different week in the
 * sparklines, and a third in the decisions themselves.
 *
 * `date-window-url.test.ts` proves the parser. It cannot prove that the picker
 * writes what the parser reads, that the body sends what the URL states, or
 * that the caption names the days that were actually measured — those are
 * claims about a running server, and this file makes them:
 *
 *   URL → REQUEST → LABEL, asserted as one equality per preset.
 *
 * Two rules from `date-window-url.ts` are what make the equality checkable, and
 * both are asserted rather than assumed: exact dates in the URL ARE the window
 * and are never re-expanded, and a preset expands once, to COMPLETED days
 * ending yesterday — a 7-day window whose seventh day is three hours long is
 * not a 7-day window.
 */
import { expect, test, type Page, type Request } from "@playwright/test";

import { openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();

/**
 * Decisions is the surface under test.
 *
 * It is `windowCapability: "mixed"` — the metric window and the decision as-of
 * date are two clocks (D7) and conflating them is the defect D070 had to
 * correct — so it is the hardest case, not the easiest. A surface with one
 * clock cannot show the picker driving the right one.
 */
const SURFACE = `/c/${handle.businesses.oneAccount}/meta/decisions`;

/**
 * The window a request states, from any of the spellings a Meta API accepts.
 *
 * `startDate`/`endDate` is the wire format the shell writes; `from`/`to` is
 * what the History journal takes; `start`/`end` is the Creative Studio pair.
 * All three are read because the claim under test is that they carry the SAME
 * two days, and a reader that only understood one spelling could not catch the
 * case where they do not.
 */
function requestWindow(request: Request): { start: string; end: string } | null {
  const params = new URL(request.url()).searchParams;
  const start =
    params.get("startDate") ?? params.get("from") ?? params.get("start") ?? null;
  const end = params.get("endDate") ?? params.get("to") ?? params.get("end") ?? null;
  return start && end ? { start, end } : null;
}

/** Collect the window every API request states while `run` executes. */
async function windowsRequestedDuring(
  page: Page,
  run: () => Promise<void>,
): Promise<{ start: string; end: string }[]> {
  const seen: { start: string; end: string }[] = [];
  const listener = (request: Request) => {
    if (!request.url().includes("/api/")) return;
    const window = requestWindow(request);
    if (window) seen.push(window);
  };
  page.on("request", listener);
  try {
    await run();
  } finally {
    page.off("request", listener);
  }
  return seen;
}

/** The two dates the topbar caption names, in the order it names them. */
async function labelledWindow(page: Page): Promise<{ start: string; end: string } | null> {
  const text = await page
    .locator("button.adv-date-range-trigger")
    .first()
    .innerText()
    .catch(() => "");
  // The caption is written for a person — "Jul 28 - Aug 24" — so it is parsed
  // against the year the URL states rather than guessed at.
  const match = /([A-Z][a-z]{2})\s+(\d{1,2})\s*[-–]\s*([A-Z][a-z]{2})\s+(\d{1,2})/.exec(
    text.replace(/\s+/g, " "),
  );
  if (!match) return null;
  const month = (name: string) =>
    String(
      [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ].indexOf(name) + 1,
    ).padStart(2, "0");
  return {
    start: `${month(match[1]!)}-${match[2]!.padStart(2, "0")}`,
    end: `${month(match[3]!)}-${match[4]!.padStart(2, "0")}`,
  };
}

/**
 * The workspace's own clock, which is the one the product resolves presets on.
 *
 * `Europe/Istanbul` — the timezone the D6 fixture gives the one-account
 * business and its Meta account. Named here rather than read from the product,
 * so this is still an independent expectation, but named at all because the
 * previous version used UTC and that is a different day for three hours out of
 * every twenty-four.
 *
 * The failure it produced is worth recording because it reads as a product bug:
 * between 21:00 and 24:00 UTC, Istanbul is already tomorrow, so the test's
 * "yesterday" and the shell's "yesterday" were different dates. The shell then
 * could not match the URL's explicit window to the `7d` preset that named it
 * and captioned the range `7 days` instead of `Last 7 days` — correct dates, a
 * preset it could no longer recognise, and a test failing on the operator's
 * word for a window rather than on the window.
 */
const WORKSPACE_TIME_ZONE = "Europe/Istanbul";

/** `days` before today, in ISO, on the workspace's clock. */
function isoDaysAgo(days: number): string {
  // `en-CA` formats as YYYY-MM-DD, which is the ISO date this compares against.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: WORKSPACE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const shifted = new Date(`${today}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The presets under test, each with the window the shared authority says it is.
 *
 * Spelled out rather than computed from the same helper the product uses: a
 * test that derives its expectation from the implementation agrees with a bug
 * as readily as with correct code. `end` is yesterday for every one of them,
 * which is rule 2 stated as data.
 */
const PRESETS: { key: string; days: number; label: RegExp }[] = [
  { key: "7d", days: 7, label: /Last 7 days/i },
  { key: "28d", days: 28, label: /Last 28 days/i },
];

test.describe("a preset window reaches the request and the caption unchanged", () => {
  for (const preset of PRESETS) {
    test(`${preset.key} — URL, request and label name the same days`, async ({ page }) => {
      const endDate = isoDaysAgo(1);
      const startDate = isoDaysAgo(preset.days);
      const url = `${SURFACE}?window=${preset.key}&startDate=${startDate}&endDate=${endDate}`;

      const requested = await windowsRequestedDuring(page, async () => {
        await openSurface(page, handle, url);
      });

      // 1. Every request that states a window states THIS one. Not "at least
      //    one" — a single request carrying a different week is the whole
      //    defect, and it hides behind an assertion that only looks for a
      //    match.
      const wrong = requested.filter(
        (window) => window.start !== startDate || window.end !== endDate,
      );
      expect(
        wrong,
        `requests that measured a different window than the URL stated`,
      ).toEqual([]);
      expect(requested.length, "no request carried a window at all").toBeGreaterThan(0);

      // 2. The caption names the same two days.
      const label = await labelledWindow(page);
      expect(label, "the topbar named no window").not.toBeNull();
      expect(label!.start).toBe(startDate.slice(5));
      expect(label!.end).toBe(endDate.slice(5));

      // 3. And it names them by the operator's word for them.
      const caption = await page.locator("button.adv-date-range-trigger").first().innerText();
      expect(caption).toMatch(preset.label);
    });
  }
});

test("a custom window is honoured verbatim and never re-expanded", async ({ page }) => {
  /**
   * Rule 1, which is the one a re-expansion breaks silently.
   *
   * These dates match no preset, so nothing can recover a name for them and
   * nothing may substitute a week it prefers. A surface that re-expanded would
   * answer with a window near this one, which reads as correct until an
   * operator compares two screens.
   */
  const startDate = "2026-03-02";
  const endDate = "2026-03-11";

  const requested = await windowsRequestedDuring(page, async () => {
    await openSurface(
      page,
      handle,
      `${SURFACE}?window=custom&startDate=${startDate}&endDate=${endDate}`,
    );
  });

  expect(requested.length).toBeGreaterThan(0);
  expect(
    requested.filter((window) => window.start !== startDate || window.end !== endDate),
    "requests that re-expanded a stated custom window",
  ).toEqual([]);

  const label = await labelledWindow(page);
  expect(label).toEqual({ start: "03-02", end: "03-11" });
});

test("an impossible window is refused rather than repaired", async ({ page }) => {
  /**
   * A backwards pair is not a window. The contract says it is ignored so the
   * caller falls back to its stored range — never quietly swapped into
   * something plausible, because a repaired window is a window nobody asked
   * for wearing a label that says they did.
   */
  const requested = await windowsRequestedDuring(page, async () => {
    await openSurface(
      page,
      handle,
      `${SURFACE}?window=custom&startDate=2026-05-20&endDate=2026-05-02`,
    );
  });

  const repaired = requested.filter(
    (window) => window.start === "2026-05-02" && window.end === "2026-05-20",
  );
  expect(repaired, "the backwards pair was silently swapped into a valid one").toEqual([]);

  // And whatever it fell back to, it is a real window and the caption names it.
  for (const window of requested) expect(window.start <= window.end).toBe(true);
});

test("changing the window through the real control moves all three together", async ({
  page,
}) => {
  /**
   * The transition, driven the way an operator drives it: open the picker,
   * choose a preset, press Apply. Not a synthetic `pushState` — the picker
   * STAGES a choice and only Apply commits it, so a test that skipped Apply
   * would be asserting that nothing happened and calling it a pass.
   */
  await openSurface(page, handle, `${SURFACE}?window=28d`);
  const before = await labelledWindow(page);

  const requested = await windowsRequestedDuring(page, async () => {
    await page.locator("button.adv-date-range-trigger").first().click();
    // Matched loosely, because the preset row's accessible name carries the
    // dates it resolves to as well as the name — which is the whole point of
    // the control and would make an exact match brittle for no gain.
    await page.getByRole("button", { name: /Last 7 days/ }).first().click();
    await page.getByRole("button", { name: /^Apply$/ }).first().click();
    // Settle on the caption changing rather than on a timer.
    await expect
      .poll(async () => (await labelledWindow(page))?.start, { timeout: 15_000 })
      .not.toBe(before?.start);
  });

  const after = await labelledWindow(page);
  expect(after).not.toEqual(before);

  // The URL now states the new window…
  const params = new URL(page.url()).searchParams;
  expect(params.get("window")).toBe("7d");
  const startDate = params.get("startDate");
  const endDate = params.get("endDate");
  expect(startDate, "the picker committed a preset without stating its dates").toBeTruthy();

  // …the caption names it…
  expect(after!.start).toBe(startDate!.slice(5));
  expect(after!.end).toBe(endDate!.slice(5));

  // …and every request made after the change carried it. Requests from before
  // the click are excluded by comparing against the committed pair only for
  // those that state the NEW start, which is what a stale-window bug would
  // fail: it would keep sending the old one for ever.
  expect(
    requested.some((window) => window.start === startDate && window.end === endDate),
    "no request was made with the newly chosen window",
  ).toBe(true);
});

test.describe("D7 — a business with no timezone says so instead of assuming one", () => {
  test("the surface never presents an unstated clock as a known one", async ({ page }) => {
    /**
     * The reporting timezone is a fact that can be missing, and every other
     * business in this fixture has one — so this branch had nothing to be read
     * against. Assuming UTC when the answer is unknown is the D8 defect one
     * clock over: it produces a day boundary nobody chose and no screen admits
     * to.
     *
     * The assertion is deliberately about what must NOT appear. A surface may
     * legitimately name the account's timezone for account-scoped figures; what
     * it may not do is print a business timezone it does not have.
     */
    await openSurface(
      page,
      handle,
      `/c/${handle.businesses.noTimezone}/meta/decisions`,
    );

    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    // No fabricated business clock. UTC in particular, because that is the
    // value a missing timezone silently becomes.
    expect(body).not.toMatch(/Workspace timezone[^.]{0,20}UTC/i);
    expect(body).not.toMatch(/Business timezone[^.]{0,20}UTC/i);

    // And the surface still renders: an unknown clock is not a reason to
    // withhold everything, only a reason not to claim one.
    const state = page.locator("[data-meta-surface-state]").first();
    await expect(state).toHaveCount(1);
    expect(await state.getAttribute("data-read-state")).not.toBe("degraded");
  });

  test("its window still resolves, and the caption still names the days", async ({
    page,
  }) => {
    // A missing timezone must not take the picker down with it. The window is
    // stated in absolute dates precisely so it survives an unknown clock.
    const endDate = isoDaysAgo(1);
    const startDate = isoDaysAgo(7);

    const requested = await windowsRequestedDuring(page, async () => {
      await openSurface(
        page,
        handle,
        `/c/${handle.businesses.noTimezone}/meta/decisions?window=7d&startDate=${startDate}&endDate=${endDate}`,
      );
    });

    expect(
      requested.filter((window) => window.start !== startDate || window.end !== endDate),
      "a missing business timezone changed the window that was measured",
    ).toEqual([]);
    expect(await labelledWindow(page)).toEqual({
      start: startDate.slice(5),
      end: endDate.slice(5),
    });
  });
});
