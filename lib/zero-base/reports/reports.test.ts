/**
 * Catalog, builder and the WP-03A fail-close branch.
 *
 * The share tests drive the ACTUAL report share route with the flag on and off
 * and assert that, flag-on, nothing is read: no report lookup and no DB fetch.
 * A refusal that happened after a lookup would still leak which report ids
 * exist.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getCustomReportById = vi.hoisted(() => vi.fn());
const requireBusinessAccess = vi.hoisted(() => vi.fn());
const listUserBusinesses = vi.hoisted(() => vi.fn(async () => []));

vi.mock("@/lib/custom-report-store", () => ({
  getCustomReportById,
  createCustomReportShareSnapshot: vi.fn(),
}));
vi.mock("@/lib/custom-report-renderer", () => ({ renderCustomReportRecord: vi.fn() }));
vi.mock("@/lib/access", () => ({ requireBusinessAccess, listUserBusinesses }));

import {
  COMING_SOON_SOURCES,
  RENDERABLE_SOURCES,
  REPORT_SOURCES,
  UNSAFE_AGGREGATE_BREAKDOWNS,
  canAddSource,
  canAggregate,
  canExportCsv,
  sourceById,
} from "@/lib/zero-base/reports/report-catalog";
import {
  GRID_COLUMNS,
  MIN_WIDTH,
  applyAction,
  canUndo,
  commit,
  keyboardAction,
  newHistory,
  undo,
  widgetStateFor,
  type Widget,
} from "@/lib/zero-base/reports/builder-model";
import { isReportShareFailClosed } from "@/lib/reports/share-fail-closed";
import { POST } from "@/app/api/reports/[reportId]/share/route";

/* ---------------------------------------------------------------- catalog */

describe("the source catalog is exactly 5 + 4", () => {
  it("has nine rows", () => {
    expect(REPORT_SOURCES).toHaveLength(9);
    expect(RENDERABLE_SOURCES).toHaveLength(5);
    expect(COMING_SOON_SOURCES).toHaveLength(4);
  });

  it("preserves source identity exactly", () => {
    expect(REPORT_SOURCES.map((s) => s.id)).toEqual([
      "overview_summary",
      "overview_trend",
      "channel_attribution",
      "meta_campaigns",
      "google_campaigns",
      "shopify_data",
      "ga4_data",
      "search_console_data",
      "klaviyo_data",
    ]);
  });

  it("keeps Search Console and Klaviyo as separate rows", () => {
    // Merging them would misreport which integration is pending.
    expect(sourceById("search_console_data")?.label).toBe("Search Console");
    expect(sourceById("klaviyo_data")?.label).toBe("Klaviyo");
  });

  it("disables a coming-soon source rather than hiding it", () => {
    const gate = canAddSource("ga4_data");
    expect(gate.ok).toBe(false);
    // Hidden would read as "this data does not exist" rather than "not wired".
    expect(!gate.ok && gate.reason).toMatch(/GA4: Coming soon/);
    expect(COMING_SOON_SOURCES.every((s) => s.reason === "Coming soon")).toBe(true);
  });

  it("allows every renderable source", () => {
    for (const source of RENDERABLE_SOURCES) {
      expect(canAddSource(source.id).ok, source.id).toBe(true);
    }
  });

  it("refuses an id that is not in the catalog", () => {
    expect(canAddSource("invented_source").ok).toBe(false);
  });
});

describe("CSV is table-only", () => {
  it("allows the three table sources", () => {
    for (const id of ["channel_attribution", "meta_campaigns", "google_campaigns"]) {
      expect(canExportCsv(id).ok, id).toBe(true);
    }
  });

  it("refuses a metric card and a trend, with the reason", () => {
    for (const id of ["overview_summary", "overview_trend"]) {
      const gate = canExportCsv(id);
      expect(gate.ok, id).toBe(false);
      expect(!gate.ok && gate.reason).toMatch(/does not match what you are looking at/);
    }
  });
});

describe("unsafe aggregates are refused", () => {
  it("refuses breakdowns that would double count", () => {
    for (const breakdown of UNSAFE_AGGREGATE_BREAKDOWNS) {
      const gate = canAggregate(breakdown);
      expect(gate.ok, breakdown).toBe(false);
      expect(!gate.ok && gate.reason).toMatch(/double count/);
    }
  });

  it("permits a safe breakdown", () => {
    expect(canAggregate("campaign").ok).toBe(true);
  });
});

/* ---------------------------------------------------------------- builder */

const widget: Widget = { id: "w1", sourceId: "meta_campaigns", x: 2, y: 1, w: 4, h: 2 };

describe("the builder grid is one model for keyboard and pointer", () => {
  it("moves a widget", () => {
    const next = applyAction({ widgets: [widget] }, { kind: "move", id: "w1", dx: 1, dy: 1 });
    expect(next.widgets[0]).toMatchObject({ x: 3, y: 2 });
  });

  it("clamps a move at the grid edge rather than pushing it off-canvas", () => {
    // Off-canvas would be unreachable by keyboard.
    const left = applyAction({ widgets: [widget] }, { kind: "move", id: "w1", dx: -99, dy: -99 });
    expect(left.widgets[0]).toMatchObject({ x: 0, y: 0 });
    const right = applyAction({ widgets: [widget] }, { kind: "move", id: "w1", dx: 99, dy: 0 });
    expect(right.widgets[0].x).toBe(GRID_COLUMNS - widget.w);
  });

  it("resizes within the minimum and the grid width", () => {
    const small = applyAction({ widgets: [widget] }, { kind: "resize", id: "w1", dw: -99, dh: -99 });
    expect(small.widgets[0]).toMatchObject({ w: MIN_WIDTH, h: 1 });
    const wide = applyAction({ widgets: [widget] }, { kind: "resize", id: "w1", dw: 99, dh: 0 });
    expect(wide.widgets[0].w).toBe(GRID_COLUMNS - widget.x);
  });

  it("maps arrows to move and shift+arrows to resize", () => {
    expect(keyboardAction({ key: "ArrowRight", shiftKey: false, selectedId: "w1" })).toEqual({
      kind: "move",
      id: "w1",
      dx: 1,
      dy: 0,
    });
    expect(keyboardAction({ key: "ArrowRight", shiftKey: true, selectedId: "w1" })).toEqual({
      kind: "resize",
      id: "w1",
      dw: 1,
      dh: 0,
    });
  });

  it("does nothing without a selection", () => {
    expect(keyboardAction({ key: "ArrowRight", shiftKey: false, selectedId: null })).toBeNull();
  });
});

describe("undo restores the exact prior state", () => {
  it("returns the grid to what it was, not to a computed inverse", () => {
    // A widget clamped at the edge does not move back the way it moved in.
    const history = newHistory({ widgets: [{ ...widget, x: 0 }] });
    const moved = commit(history, { kind: "move", id: "w1", dx: -5, dy: 0 });
    expect(moved.present.widgets[0].x).toBe(0);
    const back = undo(moved);
    expect(back.present.widgets[0].x).toBe(0);
    expect(canUndo(back)).toBe(false);
  });

  it("undoes several steps in order", () => {
    let history = newHistory({ widgets: [widget] });
    history = commit(history, { kind: "move", id: "w1", dx: 1, dy: 0 });
    history = commit(history, { kind: "resize", id: "w1", dw: 1, dh: 0 });
    expect(history.present.widgets[0]).toMatchObject({ x: 3, w: 5 });
    history = undo(history);
    expect(history.present.widgets[0]).toMatchObject({ x: 3, w: 4 });
    history = undo(history);
    expect(history.present.widgets[0]).toMatchObject({ x: 2, w: 4 });
  });

  it("is a no-op with nothing to undo", () => {
    const history = newHistory({ widgets: [widget] });
    expect(undo(history)).toEqual(history);
  });
});

describe("a failing widget does not blank the page", () => {
  it("keeps its own error and retry", () => {
    const state = widgetStateFor({
      loaded: true,
      failed: true,
      rowCount: 0,
      emptyGrammar: "empty",
      errorGrammar: "Meta campaign source failed — error + retry per widget.",
    });
    expect(state.kind).toBe("error");
    expect(state.kind === "error" && state.retryable).toBe(true);
  });

  it("renders the empty grammar rather than zeros", () => {
    const state = widgetStateFor({
      loaded: true,
      failed: false,
      rowCount: 0,
      emptyGrammar: "No Meta campaigns served for the selected account/window.",
      errorGrammar: null,
    });
    expect(state.kind).toBe("empty");
    expect(state.kind === "empty" && state.grammar).toMatch(/No Meta campaigns served/);
  });
});

/* ------------------------------------------------- WP-03A fail-close branch */

describe("the report share flag, against the real route", () => {
  const OLD = process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED;

  beforeEach(() => {
    vi.clearAllMocks();
    requireBusinessAccess.mockResolvedValue({
      session: { user: { id: "u1" } },
      membership: { businessId: "biz-1", role: "guest" },
    });
    getCustomReportById.mockResolvedValue({ id: "rep-1", businessId: "biz-1" });
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED;
    else process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED = OLD;
  });

  function request() {
    return { json: async () => ({ expiryDays: 7 }) } as never;
  }
  function params() {
    return { params: Promise.resolve({ reportId: "rep-1" }) } as never;
  }

  it("defaults to off, so legacy sharing is unaffected", () => {
    delete process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED;
    expect(isReportShareFailClosed({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("flag ON: the mint POST fails closed and reads nothing", async () => {
    // `isReportShareFailClosed` reads process.env per call, so toggling the
    // variable is enough — no module reset, which would unbind the mocks.
    process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED = "true";
    const response = await POST(request(), params());

    expect(response.status).toBeGreaterThanOrEqual(400);
    // Nothing was looked up, so the refusal cannot be used to probe which
    // report ids exist. This is the public-token DB/fetch count of zero.
    expect(getCustomReportById).not.toHaveBeenCalled();
    expect(requireBusinessAccess).not.toHaveBeenCalled();
  });

  it("flag OFF: the route proceeds past the fail-closed branch", async () => {
    process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED = "false";
    await POST(request(), params()).catch(() => null);
    // Legacy compatibility: the report IS looked up when the flag is off.
    expect(getCustomReportById).toHaveBeenCalledWith("rep-1");
  });
});
