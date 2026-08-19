import { describe, expect, it } from "vitest";

import {
  DATE_WINDOW_END_PARAM,
  DATE_WINDOW_START_PARAM,
} from "@/lib/dashboard/date-window-url";
import {
  CREATIVE_WINDOW_PARAM_SPELLINGS,
  requestedProviderAccountFromSearchParams,
  windowFromSearchParams,
} from "@/lib/zero-base/creative/route-scope";

describe("windowFromSearchParams", () => {
  it("returns the window a link names in the Creative Studio spelling", () => {
    expect(
      windowFromSearchParams({ start: "2026-03-01", end: "2026-03-07" }),
    ).toEqual({ start: "2026-03-01", end: "2026-03-07" });
  });

  it("returns the window a link names in the shell spelling", () => {
    // The shell date control states its window as startDate/endDate. A route
    // that only understood the Studio's own start/end pair would ignore the
    // operator's own control on a server-rendered surface.
    expect(
      windowFromSearchParams({
        window: "custom",
        startDate: "2026-03-01",
        endDate: "2026-03-07",
      }),
    ).toEqual({ start: "2026-03-01", end: "2026-03-07" });
  });

  it("lets the shell's window outrank a stale Creative Studio pair", () => {
    // Both spellings can sit on one URL: the operator arrives on a Studio link
    // carrying start/end, then moves the shell control, which writes
    // startDate/endDate and leaves the older pair in place. The range they just
    // chose is the answer.
    expect(
      windowFromSearchParams({
        start: "2026-01-01",
        end: "2026-01-28",
        startDate: "2026-03-01",
        endDate: "2026-03-07",
      }),
    ).toEqual({ start: "2026-03-01", end: "2026-03-07" });
  });

  it("falls through to the Studio spelling when the shell pair is unreadable", () => {
    expect(
      windowFromSearchParams({
        startDate: "not-a-date",
        endDate: "2026-03-07",
        start: "2026-01-01",
        end: "2026-01-28",
      }),
    ).toEqual({ start: "2026-01-01", end: "2026-01-28" });
  });

  it("keeps its spelling identical to the module that owns the wire format", () => {
    // The names are duplicated rather than imported because
    // lib/dashboard/date-window-url.ts reaches a "use client" component and
    // route-scope is imported by server routes. This is the pin that stops the
    // two copies from drifting apart in silence.
    expect(CREATIVE_WINDOW_PARAM_SPELLINGS[0]).toEqual({
      start: DATE_WINDOW_START_PARAM,
      end: DATE_WINDOW_END_PARAM,
    });
    expect(CREATIVE_WINDOW_PARAM_SPELLINGS[1]).toEqual({
      start: "start",
      end: "end",
    });
  });

  it("takes the first value when a bound is repeated", () => {
    expect(
      windowFromSearchParams({
        start: ["2026-03-01", "2026-04-01"],
        end: ["2026-03-07"],
      }),
    ).toEqual({ start: "2026-03-01", end: "2026-03-07" });
  });

  it("reports an absent window as absent rather than a default", () => {
    // The callers of this helper own a surface whose window belongs to the
    // shell date control. Answering "no window named" with a 28-day constant
    // would overwrite the operator's own range with something nobody asked for,
    // and would do it on a UTC clock the account may not share.
    expect(windowFromSearchParams({})).toBeNull();
    expect(windowFromSearchParams(undefined)).toBeNull();
    expect(windowFromSearchParams({ providerAccountId: "act_1" })).toBeNull();
  });

  it("refuses a half window instead of completing it", () => {
    expect(windowFromSearchParams({ start: "2026-03-01" })).toBeNull();
    expect(windowFromSearchParams({ end: "2026-03-07" })).toBeNull();
    expect(windowFromSearchParams({ start: "  ", end: "2026-03-07" })).toBeNull();
  });

  it("refuses a bound that is not a date", () => {
    expect(
      windowFromSearchParams({ start: "yesterday", end: "2026-03-07" }),
    ).toBeNull();
    expect(
      windowFromSearchParams({ start: "2026-3-1", end: "2026-03-07" }),
    ).toBeNull();
    expect(
      windowFromSearchParams({
        start: "2026-03-01T00:00:00Z",
        end: "2026-03-07",
      }),
    ).toBeNull();
  });

  it("refuses a date the calendar does not have", () => {
    // ISO-shaped is not the same as real; JavaScript would happily roll
    // 2026-02-30 forward to March and the surface would read a window the link
    // never named.
    expect(
      windowFromSearchParams({ start: "2026-02-30", end: "2026-03-07" }),
    ).toBeNull();
    expect(
      windowFromSearchParams({ start: "2026-03-01", end: "2026-13-01" }),
    ).toBeNull();
  });

  it("refuses a window that runs backwards, in either spelling", () => {
    expect(
      windowFromSearchParams({ startDate: "2026-03-08", endDate: "2026-03-07" }),
    ).toBeNull();
    expect(
      windowFromSearchParams({ start: "2026-03-08", end: "2026-03-07" }),
    ).toBeNull();
    expect(
      windowFromSearchParams({ start: "2026-03-07", end: "2026-03-07" }),
    ).toEqual({ start: "2026-03-07", end: "2026-03-07" });
  });
});

describe("requestedProviderAccountFromSearchParams", () => {
  it("reads the requested account as a request, never as an answer", () => {
    // Whether the business may read this account is `resolveProviderAccountId`'s
    // decision; a URL cannot grant scope. This helper only reports what was
    // asked for.
    expect(
      requestedProviderAccountFromSearchParams({
        providerAccountId: " act_9 ",
      }),
    ).toBe("act_9");
    expect(requestedProviderAccountFromSearchParams({})).toBeNull();
    expect(
      requestedProviderAccountFromSearchParams({ providerAccountId: "  " }),
    ).toBeNull();
  });
});
