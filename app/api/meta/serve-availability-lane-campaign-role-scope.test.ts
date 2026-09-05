/**
 * The lane serve path must read the decision snapshot with its account.
 *
 * `readLatestMetaDecisionSnapshot` resolves the campaign-role guard inside
 * itself, through `readCampaignContextGuardState` →
 * `readCampaignContextLabelMap`, and that reader refuses to answer without a
 * physical provider account: campaign role is an account fact, so an unproven
 * scope returns an EMPTY map rather than a business-wide guess. Calling it with
 * no account therefore made every campaign read as unlabeled, and
 * `applyMetaCampaignLabelGuard` demoted every hard action to `watch` /
 * `low` / `review_only` with `campaign_context_unresolved` on the blockers —
 * measured on a campaign that HAS a published, high-confidence, system-inferred
 * role from the approved resolver identity.
 *
 * This is a runtime proof of the call, not a source scan: the shipped route
 * handler is invoked and the argument it passed is read off the mock. The
 * second case pins the other half of the contract — a request with no account
 * still reads business-wide, because that caller has no account scope to prove
 * and inventing one is the failure this guard exists to prevent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/api/meta", () => ({ resolveMetaCredentials: vi.fn() }));
vi.mock("@/lib/meta/snapshot", () => ({
  readMetaDecisionSnapshotForRange: vi.fn(),
}));
vi.mock("@/lib/meta/campaigns-source", () => ({
  getMetaCampaignsForRange: vi.fn(),
}));
vi.mock("@/lib/meta/adsets-source", () => ({
  getMetaAdSetsForRange: vi.fn(),
}));
vi.mock("@/lib/meta/request-model-store", () => ({
  readPreviousDifferentMetaAdSetConfigHistoryDiffs: vi.fn(async () => new Map()),
  readPreviousDifferentMetaCampaignConfigHistoryDiffs: vi.fn(
    async () => new Map(),
  ),
}));

const access = await import("@/lib/access");
const apiMeta = await import("@/lib/api/meta");
const db = await import("@/lib/db");
const snapshot = await import("@/lib/meta/snapshot");
const campaigns = await import("@/lib/meta/campaigns-source");
const adsets = await import("@/lib/meta/adsets-source");
const { GET } = await import("@/app/api/meta/lane-classify/route");

const ACCOUNT = "act_9000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    session: {} as never,
    membership: { businessId: "biz_1" } as never,
  });
  vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue(null);
  vi.mocked(db.getDb).mockReturnValue(
    vi.fn(async () => []) as never,
  );
  vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue(null);
  vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
    rows: [],
    evidenceSource: "warehouse",
  } as never);
  vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
    rows: [],
    evidenceSource: "warehouse",
  } as never);
});

function laneRequest(providerAccountId: string | null) {
  const account = providerAccountId
    ? `&providerAccountId=${providerAccountId}`
    : "";
  return new NextRequest(
    `http://localhost/api/meta/lane-classify?businessId=biz_1${account}` +
      `&startDate=2026-08-08&endDate=2026-09-04`,
  );
}

describe("lane classification snapshot scope", () => {
  it("passes the requested provider account into the decision snapshot read", async () => {
    await GET(laneRequest(ACCOUNT));

    expect(snapshot.readMetaDecisionSnapshotForRange).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
        providerAccountId: ACCOUNT,
      }),
    );
  });

  it("keeps the business-wide read when no account is named", async () => {
    await GET(laneRequest(null));

    expect(snapshot.readMetaDecisionSnapshotForRange).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
        providerAccountId: null,
      }),
    );
  });
});
