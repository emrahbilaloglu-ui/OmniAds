// D078: the canonical `/platforms/meta/automation` body must SERVER-read the
// D077 state-history recovery readiness and hand it to the view. The rejected
// implementation re-exported the client view directly, so in the
// zero-base-off posture production actually serves, the recovery section
// rendered "Readiness read unavailable" unconditionally — these tests fail on
// that code (the helper is never called and the prop is absent).
//
// PRE-DEPLOY AUDIT — the viewer envelope and the provider-account scope,
// established for real. This body used to hand `AutomationView` neither: no
// `viewer` prop at all (defaulting to `AUTOMATION_VIEWER_NOT_ESTABLISHED`,
// which the master-switch authorization used to read as admin) and the RAW
// `?providerAccountId=` query parameter trusted directly rather than resolved
// against this business's actual assignments. The describe blocks below this
// file's original five cover both.
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readinessMocks = vi.hoisted(() => ({
  readStateHistoryCompactionReadiness: vi.fn(),
  readBudgetWriteSurfaceReadiness: vi.fn(),
}));
const accessMocks = vi.hoisted(() => ({
  requireBusinessPageContext: vi.fn(),
  readLaunchpadWriteAuthority: vi.fn(),
  resolveProviderAccountId: vi.fn(),
}));
const gateMocks = vi.hoisted(() => ({
  readMetaGateRefusal: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/meta/state-history-compaction-readiness", () => ({
  readStateHistoryCompactionReadiness:
    readinessMocks.readStateHistoryCompactionReadiness,
}));
vi.mock("@/lib/meta/budget-write-readiness-server", () => ({
  readBudgetWriteSurfaceReadiness: readinessMocks.readBudgetWriteSurfaceReadiness,
}));
vi.mock("@/lib/access/require-business-page-context", () => ({
  requireBusinessPageContext: accessMocks.requireBusinessPageContext,
}));
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: accessMocks.readLaunchpadWriteAuthority,
}));
vi.mock("@/lib/zero-base/provider-scope-server", () => ({
  resolveProviderAccountId: accessMocks.resolveProviderAccountId,
}));
vi.mock("@/lib/meta/release-gate-guard", () => ({
  readMetaGateRefusal: gateMocks.readMetaGateRefusal,
}));
vi.mock("./automation-view", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="automation-view" data-props={JSON.stringify(props)} />
  ),
}));

import LegacyMetaAutomationPage from "./legacy-page";

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const READINESS_FIXTURE = {
  contract: "d077.state-history-compaction-readiness.v3",
  businessId: BUSINESS_ID,
  journalRead: "ok",
  approvalStatus: "NOT_EXECUTED",
  latestJournal: [],
  blockers: [],
} as never;

function pageProps(businessId?: string, providerAccountId?: string) {
  const params: Record<string, string> = {};
  if (businessId) params.businessId = businessId;
  if (providerAccountId) params.providerAccountId = providerAccountId;
  return { searchParams: Promise.resolve(params) };
}

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.requireBusinessPageContext.mockResolvedValue({
    kind: "ok",
    context: { role: "admin", reviewerReadOnly: false },
  });
  accessMocks.readLaunchpadWriteAuthority.mockResolvedValue("live");
  accessMocks.resolveProviderAccountId.mockResolvedValue("act_resolved");
  readinessMocks.readStateHistoryCompactionReadiness.mockResolvedValue(
    READINESS_FIXTURE,
  );
  readinessMocks.readBudgetWriteSurfaceReadiness.mockResolvedValue(null);
  gateMocks.readMetaGateRefusal.mockReturnValue(null);
});

describe("legacy Meta automation page (canonical route body)", () => {
  it("server-reads the business-scoped D077 readiness and passes it to the view", async () => {
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(
      readinessMocks.readStateHistoryCompactionReadiness,
    ).toHaveBeenCalledTimes(1);
    expect(
      readinessMocks.readStateHistoryCompactionReadiness.mock.calls[0]?.[1],
    ).toEqual({ businessId: BUSINESS_ID });
    expect(element.props.stateHistoryReadiness).toEqual(READINESS_FIXTURE);
  });

  it("passes the readiness through verbatim, including a journal-unavailable state", async () => {
    const unavailable = {
      ...(READINESS_FIXTURE as Record<string, unknown>),
      journalRead: "unavailable",
      approvalStatus: "UNKNOWN_JOURNAL_UNAVAILABLE",
      blockers: ["compaction_journal_read_unavailable"],
    } as never;
    readinessMocks.readStateHistoryCompactionReadiness.mockResolvedValueOnce(
      unavailable,
    );
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(element.props.stateHistoryReadiness).toEqual(unavailable);
  });

  it("fails closed to null without a businessId — the read never runs", async () => {
    const element = await LegacyMetaAutomationPage(pageProps());
    expect(
      readinessMocks.readStateHistoryCompactionReadiness,
    ).not.toHaveBeenCalled();
    expect(element.props.stateHistoryReadiness).toBeNull();
  });

  it("fails closed to null when access is denied — the read never runs", async () => {
    accessMocks.requireBusinessPageContext.mockResolvedValueOnce({
      kind: "not_found",
    });
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(
      readinessMocks.readStateHistoryCompactionReadiness,
    ).not.toHaveBeenCalled();
    expect(element.props.stateHistoryReadiness).toBeNull();
  });

  it("fails closed to null when the readiness read throws", async () => {
    readinessMocks.readStateHistoryCompactionReadiness.mockRejectedValueOnce(
      new Error("db down"),
    );
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(element.props.stateHistoryReadiness).toBeNull();
  });
});

describe("legacy Meta automation page — the viewer envelope is established for real", () => {
  it("an admin gets a viewer whose role is genuinely 'admin'", async () => {
    accessMocks.requireBusinessPageContext.mockResolvedValueOnce({
      kind: "ok", context: { role: "admin", reviewerReadOnly: false },
    });
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(element.props.viewer).toMatchObject({
      role: "admin", canMutate: true, reason: null, reasonCode: null,
    });
  });

  it("a collaborator's role is restated as 'collaborator', not swallowed", async () => {
    accessMocks.requireBusinessPageContext.mockResolvedValueOnce({
      kind: "ok", context: { role: "collaborator", reviewerReadOnly: false },
    });
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(element.props.viewer.role).toBe("collaborator");
  });

  it("a reviewer's refusal is established, regardless of their role", async () => {
    accessMocks.requireBusinessPageContext.mockResolvedValueOnce({
      kind: "ok", context: { role: "admin", reviewerReadOnly: true },
    });
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(element.props.viewer.canMutate).toBe(false);
    expect(element.props.viewer.reasonCode).toBe("reviewer_read_only");
  });

  it("a demo workspace's admin is refused, read from the TABLE via readLaunchpadWriteAuthority", async () => {
    accessMocks.readLaunchpadWriteAuthority.mockResolvedValueOnce("demo");
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(accessMocks.readLaunchpadWriteAuthority).toHaveBeenCalledWith(BUSINESS_ID);
    expect(element.props.viewer.canMutate).toBe(false);
    expect(element.props.viewer.reasonCode).toBe("demo_business_read_only");
  });

  it("an unreadable demo flag fails closed to unverified, never to live", async () => {
    accessMocks.readLaunchpadWriteAuthority.mockResolvedValueOnce("unverified");
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(element.props.viewer.canMutate).toBe(false);
    expect(element.props.viewer.reasonCode).toBe("demo_status_unverified");
  });

  /*
    PRE-DEPLOY AUDIT — THE defect, proven directly on the page body.

    No businessId, or a denied access: the viewer must stay `undefined`, which
    is what `AutomationView` defaults to `AUTOMATION_VIEWER_NOT_ESTABLISHED`
    for. `buildBudgetMasterSwitchAuthorization` now refuses that state (fixed
    separately in viewer-envelope.ts) — this test only proves the PAGE holds
    up its half: it must never invent or leak a viewer when it has no
    established one.
  */
  it("passes NO viewer (undefined, not a fabricated one) without a businessId", async () => {
    const element = await LegacyMetaAutomationPage(pageProps());
    expect(element.props.viewer).toBeUndefined();
    expect(accessMocks.readLaunchpadWriteAuthority).not.toHaveBeenCalled();
  });

  it("passes NO viewer when access is denied", async () => {
    accessMocks.requireBusinessPageContext.mockResolvedValueOnce({ kind: "not_found" });
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(element.props.viewer).toBeUndefined();
    expect(accessMocks.readLaunchpadWriteAuthority).not.toHaveBeenCalled();
  });

  it("passes NO viewer when access itself throws", async () => {
    accessMocks.requireBusinessPageContext.mockRejectedValueOnce(new Error("db down"));
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(element.props.viewer).toBeUndefined();
  });
});

describe("legacy Meta automation page — the provider account is RESOLVED, not trusted", () => {
  it("resolves via resolveProviderAccountId, scoped to this business's assignments", async () => {
    accessMocks.resolveProviderAccountId.mockResolvedValueOnce("act_assigned");
    const element = await LegacyMetaAutomationPage(
      pageProps(BUSINESS_ID, "act_raw_from_url"),
    );
    expect(accessMocks.resolveProviderAccountId).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      provider: "meta",
      requestedAccountId: "act_raw_from_url",
    });
    // The RESOLVED value reaches the view, not the raw query parameter.
    expect(element.props.providerAccountId).toBe("act_assigned");
  });

  it("does not leak an unassigned raw query id: the resolver's answer wins", async () => {
    // The resolver refuses the raw id (not assigned to this business) and
    // returns null instead of echoing it back.
    accessMocks.resolveProviderAccountId.mockResolvedValueOnce(null);
    const element = await LegacyMetaAutomationPage(
      pageProps(BUSINESS_ID, "act_not_actually_assigned"),
    );
    expect(element.props.providerAccountId).toBeNull();
    expect(element.props.providerAccountId).not.toBe("act_not_actually_assigned");
  });

  it("reads both readiness models with the RESOLVED account, not the raw one", async () => {
    accessMocks.resolveProviderAccountId.mockResolvedValueOnce("act_resolved_x");
    await LegacyMetaAutomationPage(pageProps(BUSINESS_ID, "act_raw_y"));
    expect(readinessMocks.readBudgetWriteSurfaceReadiness).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: "act_resolved_x",
    });
  });

  it("resolves to null (no single assignment) without throwing, and passes null through", async () => {
    accessMocks.resolveProviderAccountId.mockResolvedValueOnce(null);
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(element.props.providerAccountId).toBeNull();
  });

  it("a failed resolution fails closed to null, not to the raw query id", async () => {
    accessMocks.resolveProviderAccountId.mockRejectedValueOnce(new Error("assignment read down"));
    const element = await LegacyMetaAutomationPage(
      pageProps(BUSINESS_ID, "act_raw_z"),
    );
    expect(element.props.providerAccountId).toBeNull();
  });

  /*
    PRE-DEPLOY AUDIT — the OTHER half of the fail-closed contract.

    On any access failure, `providerAccountId` must stay `undefined`, never
    `null`. `AutomationView` treats an explicit `null` as "the server
    authorized this scope and resolved it to nothing" (locking out the
    client's own account resolution), which is not what happened here at
    all — access never got far enough to resolve anything. `undefined`
    preserves the pre-existing client-side resolution path exactly.
  */
  it("stays undefined (not null) when access is denied — never a false 'server resolved: none'", async () => {
    accessMocks.requireBusinessPageContext.mockResolvedValueOnce({ kind: "not_found" });
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(element.props.providerAccountId).toBeUndefined();
    expect(accessMocks.resolveProviderAccountId).not.toHaveBeenCalled();
  });

  it("businessId itself stays undefined (not the raw value) on access failure", async () => {
    accessMocks.requireBusinessPageContext.mockResolvedValueOnce({ kind: "forbidden" });
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(element.props.businessId).toBeUndefined();
  });
});

describe("legacy Meta automation page — the two gate refusal facts", () => {
  it("reads both gates unconditionally, even with no businessId at all", async () => {
    await LegacyMetaAutomationPage(pageProps());
    expect(gateMocks.readMetaGateRefusal).toHaveBeenCalledWith("automationStopUi");
    expect(gateMocks.readMetaGateRefusal).toHaveBeenCalledWith("automationLiveWrites");
  });

  it("restates the gate's own message verbatim, never re-derived", async () => {
    gateMocks.readMetaGateRefusal.mockImplementation((gate: string) =>
      gate === "automationStopUi"
        ? { code: "automation_stop_disabled", message: "Stop is off.", safetyIncomplete: false }
        : { code: "automation_live_writes_disabled", message: "Live writes are off.", safetyIncomplete: false },
    );
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(element.props.stopEngageRefusalReason).toBe("Stop is off.");
    expect(element.props.liveWritesRefusalReason).toBe("Live writes are off.");
  });

  it("passes null when a gate returns no refusal", async () => {
    gateMocks.readMetaGateRefusal.mockReturnValue(null);
    const element = await LegacyMetaAutomationPage(pageProps(BUSINESS_ID));
    expect(element.props.stopEngageRefusalReason).toBeNull();
    expect(element.props.liveWritesRefusalReason).toBeNull();
  });
});
