/**
 * "Applied overnight" has to mean one night.
 *
 * The ledger read was open-ended — `created_at >= asOf - 1 day` and nothing
 * else — so the number under a card labelled "Applied overnight" was between
 * 24 and 48 hours of activity depending on what time the operator opened Home,
 * and a brief for a past asOf swept in every row written after that day. These
 * assertions are about the emitted window rather than the returned counts,
 * because the boundary is the defect: a fake `query` returns whatever rows it
 * is told to regardless of the predicate, so only the SQL itself can say
 * whether the window is closed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/meta/anomalies", () => ({
  readMetaAnomaliesForBusiness: vi.fn(async () => ({ anomalies: [] })),
}));
vi.mock("@/lib/meta/snapshot", () => ({
  readLatestMetaDecisionSnapshot: vi.fn(async () => null),
}));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  resolveEffectiveMetaModes: vi.fn(async () => null),
}));

import * as db from "@/lib/db";
import { buildMetaDailyBrief } from "@/lib/meta/daily-brief";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

// Typed with the arguments the ledger read actually passes, so `mock.calls`
// carries the query text and the bound parameters these assertions inspect.
const query = vi.fn(async (_text: string, _params: unknown[]) => [
  { result_status: "applied", count: 4 },
  { result_status: "failed", count: 1 },
]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getDb).mockReturnValue({ query } as never);
});

/**
 * The two `created_at` bounds, as written. Pulled apart rather than matched as
 * one string so the assertions below read as claims about the window (is it
 * closed? how wide? what does it hang off?) and not as claims about how the
 * query happens to be indented.
 */
function overnightWindow(sqlText: string) {
  return {
    lower: /created_at\s*>=\s*(.+)/.exec(sqlText)?.[1]?.trim() ?? null,
    upper: /created_at\s*<(?!=)\s*(.+)/.exec(sqlText)?.[1]?.trim() ?? null,
  };
}

async function ledgerQuery(asOf: string) {
  await buildMetaDailyBrief({
    businessId: BUSINESS,
    providerAccountId: "act_1",
    asOf,
  });
  const call = query.mock.calls.find((args) =>
    String(args[0]).includes("meta_automation_activity_ledger"));
  expect(call, "the brief did not read the activity ledger").toBeTruthy();
  return { text: String(call![0]), params: call![1] };
}

describe("the overnight window is closed at both ends", () => {
  it("bounds the window above, so the count cannot grow through the day", async () => {
    const { text } = await ledgerQuery("2026-09-05");
    const { lower, upper } = overnightWindow(text);

    expect(lower).toBeTruthy();
    // Without an upper bound the window ran to whenever the query happened to
    // execute: 33 hours at 09:00, 47 hours at 23:00, all of it reported as
    // "overnight".
    expect(upper).toBeTruthy();
  });

  it("makes the window exactly 24 hours wide", async () => {
    const { text } = await ledgerQuery("2026-09-05");
    const { lower, upper } = overnightWindow(text);

    // Both ends hang off the same anchor, so the span is fixed no matter what
    // the anchor resolves to. A window whose ends move independently is how
    // the 24-to-48-hour drift got in.
    expect(lower).toBe(`${upper} - INTERVAL '24 hours'`);
  });

  it("ends no later than the asOf day, so a past brief cannot keep growing", async () => {
    const { text, params } = await ledgerQuery("2026-09-01");
    const { upper } = overnightWindow(text);

    // The anchor is the earlier of now() and the end of the asOf day. For a
    // historical asOf that clamps to that day's midnight; previously the read
    // had no ceiling at all, so a brief for 2026-09-01 counted every row the
    // automation has written since.
    expect(upper).toContain("LEAST");
    expect(upper).toContain("now()");
    expect(upper).toContain("$2::date");
    expect(params).toEqual([BUSINESS, "2026-09-01"]);
  });

  it("still reports what the ledger returned", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: "act_1",
      asOf: "2026-09-05",
    });
    expect(brief.appliedYesterday).toMatchObject({
      state: "read",
      applied: 4,
      failed: 1,
    });
  });
});
