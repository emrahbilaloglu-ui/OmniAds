/**
 * Rendering the morning card must not decide anything, and must not report
 * today's queue under yesterday's date.
 *
 * The brief used to get its "waiting for you" number from
 * `readMetaAutomationProposalQueue`, the Automation screen's reader. That
 * reader opens with two UPDATEs — `expireStaleMetaAutomationProposals` flips
 * every pending row past `expires_at` to `expired`, and
 * `sweepStaleMetaAutomationProposalClaims` rewrites every `claimed` row past
 * its lease and clears its claim token — and both are business-wide, not
 * limited to the account the card is about. So a GET on Home wrote to the
 * confirmation queue. It also read the queue at the real current time no
 * matter which day the brief was for, while every other section was bounded to
 * `asOf`, so a brief for a past day counted proposals raised after it.
 *
 * The proposal module is deliberately NOT mocked here. Mocking it would hide
 * exactly the statements this suite exists to catch: the sweeps live inside it,
 * and a stub cannot write. `@/lib/db` is faked instead, so every statement the
 * brief causes — through whatever path — is recorded and can be inspected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const statements: Array<{ text: string; params: unknown[] }> = [];

const query = vi.fn(async (text: string, params: unknown[] = []) => {
  statements.push({ text: String(text), params });
  if (String(text).includes("meta_automation_activity_ledger")) {
    return [{ result_status: "applied", count: 1 }];
  }
  if (/count\(\*\)::int AS pending/.test(String(text))) return [{ pending: 3 }];
  return [];
});

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query }),
  runDbTransaction: async (run: () => Promise<unknown>) => run(),
}));
// Ready, so nothing in the proposal path can decline to run for lack of a
// migration and make an absent write look like a passing assertion.
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
}));
vi.mock("@/lib/meta/anomalies", () => ({
  readMetaAnomaliesForBusiness: vi.fn(async () => ({ anomalies: [] })),
}));
vi.mock("@/lib/meta/snapshot", () => ({
  readLatestMetaDecisionSnapshot: vi.fn(async () => null),
}));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  resolveEffectiveMetaModes: vi.fn(async () => null),
}));

import { buildMetaDailyBrief } from "@/lib/meta/daily-brief";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const TODAY = new Date().toISOString().slice(0, 10);
const A_PAST_DAY = "2026-09-01";

beforeEach(() => {
  vi.clearAllMocks();
  statements.length = 0;
});

/** Statements that change rows, with enough of each to name it in a failure. */
function mutations(): string[] {
  return statements
    .filter(({ text }) => /\b(update|insert|delete)\b/i.test(text))
    .map(({ text }) => text.replace(/\s+/g, " ").trim().slice(0, 80));
}

function proposalStatements(): string[] {
  return statements
    .filter(({ text }) => text.includes("meta_automation_proposals"))
    .map(({ text }) => text.replace(/\s+/g, " ").trim().slice(0, 80));
}

describe("building the brief writes nothing", () => {
  it("issues no mutating statement for today's brief", async () => {
    await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: TODAY,
    });

    // Two of these used to run on every card render: the pending-row expiry
    // and the claim-lease sweep, both across every account of the business.
    expect(mutations()).toEqual([]);
  });

  it("issues no mutating statement for a past day's brief either", async () => {
    await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: A_PAST_DAY,
    });

    expect(mutations()).toEqual([]);
  });
});

describe("the queue count belongs to the day the brief is stamped with", () => {
  it("withholds the queue for a past day rather than counting today's", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: A_PAST_DAY,
    });

    // The pending set at a past date cannot be reconstructed: `status` is
    // overwritten in place with no history, and the snapshot refresh rewrites
    // `expires_at`. "Not read" is the only honest answer; a number here would
    // be today's queue wearing that day's date.
    expect(brief.queue).toEqual({ state: "unavailable", pending: 0 });
    // And it is withheld by not asking, not by discarding an answer.
    expect(proposalStatements()).toEqual([]);
  });

  it("counts the queue for a brief about today", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: TODAY,
    });

    expect(brief.queue).toEqual({ state: "read", pending: 3 });
  });

  it("counts it for the default asOf too, which is today", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1",
    });

    expect(brief.asOf).toBe(TODAY);
    expect(brief.queue).toEqual({ state: "read", pending: 3 });
  });
});

describe("the count is scoped to the account the card is about", () => {
  it("bounds the count by account, pending status and unexpired evidence", async () => {
    await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: TODAY,
    });

    const [read, ...rest] = statements
      .filter(({ text }) => text.includes("meta_automation_proposals"));
    expect(read, "the brief did not count the queue").toBeTruthy();
    expect(rest).toEqual([]);
    // Every column here is a leading column of
    // idx_meta_automation_proposals_queue, which is why this stays a range
    // scan rather than the kind of predicate that has quietly exceeded the
    // pool read timeout on this schema before.
    expect(read!.text).toContain("business_id = $1::uuid");
    expect(read!.text).toContain("provider_account_id = $2");
    expect(read!.text).toContain("status = 'pending'");
    expect(read!.text).toContain("expires_at > now()");
    expect(read!.params).toEqual([BUSINESS, "act_1"]);
  });
});
