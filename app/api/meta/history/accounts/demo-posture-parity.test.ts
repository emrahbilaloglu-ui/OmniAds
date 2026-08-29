import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { DEMO_BUSINESS_ID } from "@/lib/demo-business-support";
import { getDemoMetaStatus } from "@/lib/demo-business";
import { META_FAILURES } from "@/lib/meta/read-state-contract";

/**
 * D071 parity: one business, one assignment authority across three reads.
 *
 * Integrations used to report Meta as connected with an assigned account while
 * Decisions, for the same `businessId` in the same session, offered
 * "No assigned account". The cause was posture handling, not data: the status
 * route resolved `readMetaBusinessDataPosture` and served the committed demo
 * fixture, while `history/accounts`, `history` and `decisions-workspace` read
 * `business_provider_accounts` directly.
 *
 * These tests pin the resolved contract. They exercise the real route handlers
 * so a regression in any one of the three fails here.
 *
 * Status-side limitation: `/api/meta/status` is not invoked. It performs
 * runtime-contract startup assertions that make it prohibitively coupled in a
 * unit test, so `getDemoMetaStatus` is used as the Integrations-side value and
 * a source assertion pins the status route to that same helper. If the status
 * route ever stops delegating to it, the last test in this file fails.
 */

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/meta/history-read-model", () => ({
  readMetaHistoryAccounts: vi.fn(),
  readMetaHistoryAssignedAccountIds: vi.fn(),
  readMetaHistoryJournal: vi.fn(),
}));
vi.mock("@/lib/meta/business-data-posture", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/meta/business-data-posture")
  >();
  return { ...actual, readMetaBusinessDataPosture: vi.fn() };
});

const access = await import("@/lib/access");
const readModel = await import("@/lib/meta/history-read-model");
const posture = await import("@/lib/meta/business-data-posture");
const accountsRoute = await import("@/app/api/meta/history/accounts/route");
const historyRoute = await import("@/app/api/meta/history/route");

const ASSIGNED_DEMO_ACCOUNT = "act_210009998877";
const UNASSIGNED_DEMO_ACCOUNT = "act_210009998901";

function accountsRequest(businessId = DEMO_BUSINESS_ID) {
  return new NextRequest(
    `http://localhost/api/meta/history/accounts?businessId=${businessId}`,
  );
}

function historyRequest(providerAccountId: string) {
  return new NextRequest(
    `http://localhost/api/meta/history?businessId=${DEMO_BUSINESS_ID}` +
      `&providerAccountId=${providerAccountId}`,
  );
}

function noHistoryReadModelCalls() {
  expect(readModel.readMetaHistoryAccounts).not.toHaveBeenCalled();
  expect(readModel.readMetaHistoryAssignedAccountIds).not.toHaveBeenCalled();
  expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user_demo", email: "demo@example.com" } } as never,
    membership: { businessId: DEMO_BUSINESS_ID, role: "owner" } as never,
  });
});

describe("D071 — demo posture serves the committed manifest", () => {
  beforeEach(() => {
    vi.mocked(posture.readMetaBusinessDataPosture).mockResolvedValue("demo");
  });

  it("offers exactly the assigned demo account and excludes the rest of the catalog", async () => {
    const response = await accountsRoute.GET(accountsRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe("read_only");
    expect(body.businessId).toBe(DEMO_BUSINESS_ID);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].id).toBe(ASSIGNED_DEMO_ACCOUNT);
    expect(body.accounts[0].name).toBe("UrbanTrail DTC");

    const offered = (body.accounts as Array<{ id: string }>).map((a) => a.id);
    expect(offered).not.toContain(UNASSIGNED_DEMO_ACCOUNT);
    expect(offered).not.toContain("act_210009998955");
    noHistoryReadModelCalls();
  });

  it("agrees with the Integrations-side assignment for the same business", async () => {
    const response = await accountsRoute.GET(accountsRequest());
    const body = await response.json();

    const integrationsAssigned = [...getDemoMetaStatus().assignedAccountIds].sort();
    const decisionsOffered = (body.accounts as Array<{ id: string }>)
      .map((account) => account.id)
      .sort();

    // The contradiction this ADR resolves: these two were 1 and 0.
    expect(decisionsOffered).toEqual(integrationsAssigned);
  });

  it("serves a demo journal as explicitly not-recorded, never as proven-zero", async () => {
    const response = await historyRoute.GET(
      historyRequest(ASSIGNED_DEMO_ACCOUNT),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe("read_only");
    expect(body.scope.providerAccountId).toBe(ASSIGNED_DEMO_ACCOUNT);
    expect(body.entries).toEqual([]);
    expect(body.page.returned).toBe(0);
    // Null, not 0. A 0 total is an exact claim that nothing exists; this read
    // counted nothing, so it states no total at all.
    expect(body.page.total).toBeNull();
    // An empty list alone would still imply proven zero activity. The
    // limitation is what makes the emptiness truthful.
    const limitation = (
      body.limitations as Array<{ code: string; message: string }>
    ).find((item) => item.code === "demo_journal_not_recorded");
    expect(limitation).toBeDefined();
    // One source of truth: the code is contracted, so its sentence is too.
    expect(limitation!.message).toBe(
      META_FAILURES.demo_journal_not_recorded.message,
    );
    noHistoryReadModelCalls();
  });

  it("refuses an unassigned demo catalog account from the journal", async () => {
    const response = await historyRoute.GET(
      historyRequest(UNASSIGNED_DEMO_ACCOUNT),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("provider_account_not_assigned");
    noHistoryReadModelCalls();
  });
});

describe("D071 — unverified posture withholds rather than emptying", () => {
  beforeEach(() => {
    vi.mocked(posture.readMetaBusinessDataPosture).mockResolvedValue(
      "unverified",
    );
  });

  it("withholds the account list", async () => {
    const response = await accountsRoute.GET(accountsRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("workspace_posture_unverified");
    expect(body.accounts).toBeUndefined();
    noHistoryReadModelCalls();
  });

  it("withholds the journal", async () => {
    const response = await historyRoute.GET(
      historyRequest(ASSIGNED_DEMO_ACCOUNT),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("workspace_posture_unverified");
    expect(body.entries).toBeUndefined();
    noHistoryReadModelCalls();
  });
});

describe("D071 — live posture is unchanged and never reads the demo fixture", () => {
  beforeEach(() => {
    vi.mocked(posture.readMetaBusinessDataPosture).mockResolvedValue("live");
  });

  it("still serves the persisted intersection", async () => {
    vi.mocked(readModel.readMetaHistoryAccounts).mockResolvedValue([
      { id: "act_live_1", name: "Live", currency: "EUR", timezone: "UTC" },
      { id: "act_live_stale", name: "Removed", currency: "EUR", timezone: "UTC" },
    ]);
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockResolvedValue([
      "act_live_1",
    ]);

    const response = await accountsRoute.GET(
      accountsRequest("11111111-2222-4111-8111-111111111111"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accounts).toEqual([
      { id: "act_live_1", name: "Live", currency: "EUR", timezone: "UTC" },
    ]);
    // A live workspace never gets a demo account, even one that exists in the
    // demo catalog.
    expect(
      (body.accounts as Array<{ id: string }>).map((a) => a.id),
    ).not.toContain(ASSIGNED_DEMO_ACCOUNT);
    expect(readModel.readMetaHistoryAssignedAccountIds).toHaveBeenCalled();
  });

  it("still reports a failed live assignment read as unavailable, not unassigned", async () => {
    vi.mocked(readModel.readMetaHistoryAccounts).mockResolvedValue([]);
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockRejectedValue(
      new Error("assignment read failed"),
    );

    const response = await accountsRoute.GET(accountsRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("meta_history_accounts_unavailable");
    expect(body.accounts).toBeUndefined();
  });
});

describe("D071 — the status route remains the Integrations-side authority", () => {
  it("delegates the demo branch to getDemoMetaStatus", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/meta/status/route.ts", "utf8");

    expect(source).toContain("readMetaBusinessDataPosture");
    expect(source).toContain('posture === "demo"');
    expect(source).toContain("getDemoMetaStatus()");
  });
});
