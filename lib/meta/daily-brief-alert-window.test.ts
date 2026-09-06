/**
 * A brief stamped with one date has to be about that date.
 *
 * The alert read was the last unbounded section. `readMetaAnomaliesForBusiness`
 * takes `MAX(snapshot_date)` over all time unless it is given `endDate` — its
 * own doc says "Without it a historical range would show today's anomalies" —
 * so a brief requested for a past day carried today's alerts beside that day's
 * decisions and ledger window, under a single `asOf` claiming they were the
 * same morning.
 *
 * These assertions are about the arguments the brief hands its producers, not
 * about the counts that come back: a mocked reader returns whatever rows it is
 * told to no matter what bound it was given, so only the call itself can say
 * whether the alerts were bounded to the requested day.
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
import * as anomalies from "@/lib/meta/anomalies";
import * as snapshot from "@/lib/meta/snapshot";
import { buildMetaDailyBrief } from "@/lib/meta/daily-brief";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

const query = vi.fn(async (_text: string, _params: unknown[]) => [
  { result_status: "applied", count: 1 },
]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getDb).mockReturnValue({ query } as never);
});

function alertRead() {
  const call = vi.mocked(anomalies.readMetaAnomaliesForBusiness).mock.calls[0];
  expect(call, "the brief did not read the anomalies authority").toBeTruthy();
  return call![0];
}

describe("the alert read is bound to the requested day", () => {
  it("passes the historical asOf as the anomaly ceiling", async () => {
    await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: "act_1",
      asOf: "2026-09-01",
    });

    // Unbounded, this read returns the newest anomaly snapshot in the table —
    // which for a brief about 2026-09-01 is every alert raised since.
    expect(alertRead()).toMatchObject({
      businessId: BUSINESS,
      activeOnly: true,
      endDate: "2026-09-01",
    });
  });

  it("gives alerts and decisions the same ceiling", async () => {
    await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: "act_1",
      asOf: "2026-09-01",
    });

    const decisionRead = vi.mocked(snapshot.readLatestMetaDecisionSnapshot)
      .mock.calls[0]![0];
    // One notion of "as of" per brief. Two ceilings is how the payload came to
    // mix a historical decision window with this morning's alerts.
    expect(alertRead().endDate).toBe(decisionRead.endDate);
  });

  it("bounds the default asOf too, at the day the payload is labelled with", async () => {
    // The account is named because the alert read is now withheld without one
    // (see the alert scope suite); this case is about the DAY, and without an
    // account there would be no read here to inspect at all.
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: "act_1",
    });

    // No caller-supplied date is not the same as no ceiling: the brief still
    // states a day, and the alerts have to belong to it.
    expect(alertRead().endDate).toBe(brief.asOf);
  });
});
