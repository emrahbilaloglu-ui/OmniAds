/**
 * The alert count belongs to one account, or the card says it was not read.
 *
 * `readMetaAnomaliesForBusiness` treats a missing `providerAccountId` as "no
 * account FILTER" rather than "no account" — its filter step is `if
 * (!providerAccountId) return true` — so the brief, which omitted the
 * argument, counted every assigned account's anomalies beside decisions and a
 * queue that are one account's. Home's "Alerts" number could therefore exceed
 * the Alerts screen's for the same business, on a card whose whole premise is
 * that its sections agree with the screens behind them. The two other surfaces
 * that serve anomalies — the anomalies route and the intelligence server's
 * anomalies authority — both pass the account and refuse when there is none.
 *
 * These assertions are about the argument the brief hands the anomalies
 * authority, and about whether it calls it at all. A mocked reader returns
 * whatever rows it is told to no matter what scope it was given, so only the
 * call itself can say which account was asked about.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/meta/anomalies", () => ({
  readMetaAnomaliesForBusiness: vi.fn(async () => ({
    anomalies: [
      { type: "cpm_spike", severity: "high", scopeLabel: "Prospecting", title: "CPM spike", detail: "x" },
    ],
  })),
}));
vi.mock("@/lib/meta/snapshot", () => ({
  readLatestMetaDecisionSnapshot: vi.fn(async () => null),
}));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  resolveEffectiveMetaModes: vi.fn(async () => null),
}));

import * as db from "@/lib/db";
import * as anomalies from "@/lib/meta/anomalies";
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

describe("the alert read is scoped to the resolved account", () => {
  it("names the account the rest of the card is about", async () => {
    await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: "act_1",
      asOf: "2026-09-05",
    });

    // Omitted, this argument is the reader's no-filter case, and the count
    // came back business-wide under an account-scoped card.
    expect(alertRead()).toMatchObject({
      businessId: BUSINESS,
      providerAccountId: "act_1",
      activeOnly: true,
    });
  });

  it("still reports what the scoped read returned", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: "act_1",
      asOf: "2026-09-05",
    });

    expect(brief.alerts).toMatchObject({ state: "read", high: 1, total: 1 });
  });

  it("uses the same normalized account in the read and payload", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: "  act_1  ",
      asOf: "2026-09-05",
    });

    expect(alertRead().providerAccountId).toBe("act_1");
    expect(brief.providerAccountId).toBe("act_1");
  });

  it("reports a failed scoped read as unavailable", async () => {
    vi.mocked(anomalies.readMetaAnomaliesForBusiness)
      .mockRejectedValueOnce(new Error("source read failed"));
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: "act_1",
      asOf: "2026-09-05",
    });

    expect(brief.alerts).toEqual({
      state: "unavailable", high: 0, total: 0, top: [],
    });
  });
});

describe("the alert read is withheld without one resolved account", () => {
  it("treats a whitespace account as unresolved instead of reading all accounts", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: "   ",
      asOf: "2026-09-05",
    });

    expect(vi.mocked(anomalies.readMetaAnomaliesForBusiness))
      .not.toHaveBeenCalled();
    expect(brief.providerAccountId).toBeNull();
    expect(brief.alerts.state).toBe("unavailable");
  });

  it("does not count business-wide alerts when no account was resolved", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: null,
      asOf: "2026-09-05",
    });

    // Withheld by not asking, not by discarding an answer: with zero or
    // several assigned accounts there is no account to scope to, and a
    // business-wide count served as one account's is the defect itself.
    expect(vi.mocked(anomalies.readMetaAnomaliesForBusiness))
      .not.toHaveBeenCalled();
    // The shape the decisions and queue sections already use for this case:
    // "no account to read" is not "nothing is wrong this morning".
    expect(brief.alerts).toMatchObject({
      state: "unavailable",
      high: 0,
      total: 0,
    });
    expect(brief.alerts.top).toEqual([]);
  });

  it("withholds alerts and decisions together, under one rule", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS,
      providerAccountId: null,
      asOf: "2026-09-05",
    });

    // One rule for the account-scoped sections rather than a separate one for
    // alerts, so the card cannot report a confident alert count beside a
    // decisions cell that admits it could not be read.
    expect(brief.alerts.state).toBe(brief.decisions.state);
    expect(brief.alerts.state).toBe("unavailable");
  });
});
