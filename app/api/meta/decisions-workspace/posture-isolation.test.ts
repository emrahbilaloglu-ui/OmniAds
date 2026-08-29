import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { DEMO_BUSINESS_ID } from "@/lib/demo-business-support";

/**
 * D071 isolation proof: a confirmed demo or unverified workspace reads nothing
 * live.
 *
 * This is a runtime proof, not a source scan. Every direct live dependency of
 * `GET /api/meta/decisions-workspace` is mocked, the real handler is invoked,
 * and each mock is asserted never to have been called. An earlier revision
 * placed the posture check inside `canonicalDecisionReadModel`, which runs
 * *after* the end-date resolver, commercial targets and current-Ad reads have
 * already started — these tests fail against that revision, which is the point.
 */

const accessMock = vi.hoisted(() => ({ requireBusinessAccess: vi.fn() }));
const postureMock = vi.hoisted(() => ({ readMetaBusinessDataPosture: vi.fn() }));
const dbMock = vi.hoisted(() => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not be reached for a non-live posture");
  }),
  getDbRuntimeDiagnostics: vi.fn(() => ({ pool: {}, counters: {} })),
}));
const assignmentsMock = vi.hoisted(() => ({
  getProviderAccountAssignments: vi.fn(),
}));
const readModelMock = vi.hoisted(() => ({
  buildUnavailableMetaDecisionsWorkspaceReadModel: vi.fn(),
  readMetaDecisionCampaignContextRows: vi.fn(),
  readMetaDecisionsWorkspaceReadModel: vi.fn(),
}));
const metaApiMock = vi.hoisted(() => ({
  resolveMetaCredentials: vi.fn(),
  fetchMetaActiveAdConfigsReceipt: vi.fn(),
}));
const upstreamRouteMock = vi.hoisted(() => ({
  accountPulseGet: vi.fn(),
  laneClassificationGet: vi.fn(),
}));
const commercialTargetsMock = vi.hoisted(() => ({
  hasMetaHardActionAnchor: vi.fn(),
  readMetaCommercialTargets: vi.fn(),
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: accessMock.requireBusinessAccess,
}));
vi.mock("@/lib/meta/business-data-posture", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/meta/business-data-posture")
  >();
  return { ...actual, readMetaBusinessDataPosture: postureMock.readMetaBusinessDataPosture };
});
vi.mock("@/lib/db", () => ({
  getDb: dbMock.getDb,
  getDbRuntimeDiagnostics: dbMock.getDbRuntimeDiagnostics,
}));
vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: assignmentsMock.getProviderAccountAssignments,
}));
vi.mock("@/lib/meta/decisions-workspace-read-model", () => ({
  resolveProvisionalCampaignKind: vi.fn(() => "main"),
  buildUnavailableMetaDecisionsWorkspaceReadModel:
    readModelMock.buildUnavailableMetaDecisionsWorkspaceReadModel,
  readMetaDecisionCampaignContextRows:
    readModelMock.readMetaDecisionCampaignContextRows,
  readMetaDecisionsWorkspaceReadModel:
    readModelMock.readMetaDecisionsWorkspaceReadModel,
}));
vi.mock("@/lib/api/meta", () => ({
  resolveMetaCredentials: metaApiMock.resolveMetaCredentials,
  fetchMetaActiveAdConfigsReceipt: metaApiMock.fetchMetaActiveAdConfigsReceipt,
}));
vi.mock("@/app/api/meta/account-pulse/route", () => ({
  GET: upstreamRouteMock.accountPulseGet,
}));
vi.mock("@/app/api/meta/lane-classify/route", () => ({
  GET: upstreamRouteMock.laneClassificationGet,
}));
vi.mock("@/lib/meta/commercial-targets", () => ({
  hasMetaHardActionAnchor: commercialTargetsMock.hasMetaHardActionAnchor,
  readMetaCommercialTargets: commercialTargetsMock.readMetaCommercialTargets,
}));

const { GET } = await import("@/app/api/meta/decisions-workspace/route");

const DEMO_ACCOUNT = "act_210009998877";

/** Every direct live dependency the handler can reach. */
function everyLiveDependency() {
  return [
    ["getDb", dbMock.getDb],
    ["getProviderAccountAssignments", assignmentsMock.getProviderAccountAssignments],
    ["readMetaDecisionsWorkspaceReadModel", readModelMock.readMetaDecisionsWorkspaceReadModel],
    ["readMetaDecisionCampaignContextRows", readModelMock.readMetaDecisionCampaignContextRows],
    ["buildUnavailableMetaDecisionsWorkspaceReadModel", readModelMock.buildUnavailableMetaDecisionsWorkspaceReadModel],
    ["resolveMetaCredentials", metaApiMock.resolveMetaCredentials],
    ["fetchMetaActiveAdConfigsReceipt", metaApiMock.fetchMetaActiveAdConfigsReceipt],
    ["readMetaCommercialTargets", commercialTargetsMock.readMetaCommercialTargets],
    ["account-pulse GET", upstreamRouteMock.accountPulseGet],
    ["lane-classify GET", upstreamRouteMock.laneClassificationGet],
  ] as const;
}

function expectNoLiveReads() {
  for (const [name, mock] of everyLiveDependency()) {
    expect(mock, `${name} must not be called`).not.toHaveBeenCalled();
  }
}

function workspaceRequest(businessId: string, providerAccountId = DEMO_ACCOUNT) {
  return new NextRequest(
    `http://localhost/api/meta/decisions-workspace?businessId=${businessId}` +
      `&providerAccountId=${providerAccountId}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  accessMock.requireBusinessAccess.mockResolvedValue({
    session: { user: { id: "user_1", email: "demo@example.com" } },
    membership: { businessId: DEMO_BUSINESS_ID, role: "owner" },
  });
});

describe("a confirmed demo workspace reads nothing live", () => {
  beforeEach(() => {
    postureMock.readMetaBusinessDataPosture.mockResolvedValue("demo");
  });

  it("refuses before touching any live dependency", async () => {
    const response = await GET(workspaceRequest(DEMO_BUSINESS_ID));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("demo_workspace_envelope_unavailable");
    expect(body.isPartial).toBe(true);
    expect(body.notReadyReason).toBeTruthy();
    // The refusal is not an empty success.
    expect(body.pulse).toBeUndefined();
    expect(body.lanes).toBeUndefined();
    expectNoLiveReads();
  });

  it("resolves posture exactly once, so no lower function can re-resolve it", async () => {
    await GET(workspaceRequest(DEMO_BUSINESS_ID));
    expect(postureMock.readMetaBusinessDataPosture).toHaveBeenCalledTimes(1);
    expect(postureMock.readMetaBusinessDataPosture).toHaveBeenCalledWith(
      DEMO_BUSINESS_ID,
    );
  });

  it("refuses identically without a provider account, still reading nothing", async () => {
    const response = await GET(
      new NextRequest(
        `http://localhost/api/meta/decisions-workspace?businessId=${DEMO_BUSINESS_ID}`,
      ),
    );
    expect(response.status).toBe(503);
    expectNoLiveReads();
  });

  it("refuses the compact OS surface the same way", async () => {
    const response = await GET(
      new NextRequest(
        `http://localhost/api/meta/decisions-workspace?businessId=${DEMO_BUSINESS_ID}` +
          `&providerAccountId=${DEMO_ACCOUNT}&surface=os`,
      ),
    );
    expect(response.status).toBe(503);
    expectNoLiveReads();
  });
});

describe("an unverified workspace withholds before any live read", () => {
  beforeEach(() => {
    postureMock.readMetaBusinessDataPosture.mockResolvedValue("unverified");
  });

  it("returns the shared posture refusal and reads nothing", async () => {
    const response = await GET(workspaceRequest("22222222-2222-4222-8222-222222222222"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("workspace_posture_unverified");
    expect(body.isPartial).toBe(true);
    expect(body.pulse).toBeUndefined();
    expectNoLiveReads();
  });
});

describe("a proven-live workspace still uses the persisted and provider path", () => {
  beforeEach(() => {
    postureMock.readMetaBusinessDataPosture.mockResolvedValue("live");
  });

  it("reaches the live reads the demo and unverified branches refuse", async () => {
    // The live path is exercised in route.test.ts; here it only has to prove
    // the gate is posture-conditional rather than an unconditional refusal.
    await GET(workspaceRequest("33333333-3333-4333-8333-333333333333")).catch(
      () => null,
    );

    const reached = everyLiveDependency().filter(([, mock]) =>
      mock.mock.calls.length > 0,
    );
    expect(
      reached.length,
      "a live posture must reach at least one live dependency",
    ).toBeGreaterThan(0);
  });
});
