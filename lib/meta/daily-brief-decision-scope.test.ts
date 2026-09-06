/**
 * The decision section belongs to one account and one day, or it is withheld.
 *
 * Two leaks met on the same read. `providerAccountId: null` is not "no account"
 * to `readLatestMetaDecisionSnapshot` — null is its no-filter case — so a
 * business with zero or several Meta assignments got business-wide rows served
 * under an account-scoped card, a disconnected account's decisions included,
 * with nothing in the top-item shape to say which action belonged to where. And
 * `startDate`/`endDate` never bounded which snapshot is "latest": that read
 * takes MAX(snapshot_date) over all time unless it is given a ceiling, so a
 * brief for a past day labelled TODAY's actionable decisions and freshness date
 * with that past `asOf`.
 *
 * These assertions are about the arguments the brief hands its producer, and
 * about whether it calls it at all. A mocked reader returns whatever rows it is
 * told to no matter what scope or bound it was given, so only the call itself
 * can say which day and which account were asked for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/meta/anomalies", () => ({
  readMetaAnomaliesForBusiness: vi.fn(async () => ({ anomalies: [] })),
}));
vi.mock("@/lib/meta/automation-proposals", () => ({
  readMetaAutomationProposalQueue: vi.fn(async () => ({
    readCompleteness: "complete",
    proposals: [],
  })),
}));
vi.mock("@/lib/meta/snapshot", () => ({
  readLatestMetaDecisionSnapshot: vi.fn(async () => ({
    status: "ok",
    snapshotDate: "2026-09-05",
    summary: {},
    recommendations: [
      { id: "r1", level: "campaign", campaignId: "camp_1", decisionLabel: "cut", title: "Pause" },
    ],
  })),
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

function decisionRead() {
  const call = vi.mocked(snapshot.readLatestMetaDecisionSnapshot).mock.calls[0];
  expect(call, "the brief did not read the decision snapshot").toBeTruthy();
  return call![0];
}

describe("the decision read is bound to the requested day", () => {
  it("caps the snapshot at the asOf the brief is stamped with", async () => {
    await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: "act_1",
      asOf: "2026-09-01",
    });

    // Uncapped, this read resolves MAX(snapshot_date) across all time, so a
    // brief about 2026-09-01 reported this morning's decisions and this
    // morning's freshness date under that day's label.
    expect(decisionRead()).toMatchObject({
      businessId: BUSINESS,
      providerAccountId: "act_1",
      snapshotDateCeiling: "2026-09-01",
    });
  });

  it("gives decisions and alerts the same ceiling", async () => {
    await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: "act_1",
      asOf: "2026-09-01",
    });

    const alertRead = vi.mocked(anomalies.readMetaAnomaliesForBusiness)
      .mock.calls[0]![0];
    // One notion of "as of" per brief. The metric range the read also carries
    // is context for the caller; it is not what bounds the snapshot, which is
    // how a historical brief kept serving today's decisions.
    expect(decisionRead().snapshotDateCeiling).toBe(alertRead.endDate);
  });

  it("bounds the default asOf too, at the day the payload is labelled with", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: "act_1",
    });

    expect(decisionRead().snapshotDateCeiling).toBe(brief.asOf);
  });
});

describe("the decision read is withheld without one resolved account", () => {
  it("does not read business-wide rows when no account was resolved", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: null,
      asOf: "2026-09-05",
    });

    // Null reaches the reader as "no account filter", not as "no account", so
    // this call would have merged every assigned account's decisions — a
    // disconnected account's included — into one account-scoped card.
    expect(vi.mocked(snapshot.readLatestMetaDecisionSnapshot))
      .not.toHaveBeenCalled();
    // Same shape the queue has always used for this case: no account to read
    // is not the same as nothing to do.
    expect(brief.decisions).toMatchObject({ state: "unavailable", actionable: 0 });
    expect(brief.decisions.top).toEqual([]);
    expect(brief.freshness).toMatchObject({
      state: "unavailable",
      lastSnapshotDate: null,
    });
  });

  it("still reads the snapshot when exactly one account is resolved", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: "act_1",
      asOf: "2026-09-05",
    });

    expect(brief.decisions).toMatchObject({ state: "read", actionable: 1 });
    expect(brief.freshness).toMatchObject({
      state: "read",
      lastSnapshotDate: "2026-09-05",
    });
  });
});
