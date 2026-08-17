import { readFileSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/entity-action-routes", () => ({
  handleMetaEntityPauseAction: vi.fn(),
  handleMetaEntityResumeAction: vi.fn(),
}));

const entityRoutes = await import("@/lib/meta/entity-action-routes");
const { executeMetaAutomationProposal } = await import(
  "@/lib/meta/automation-proposal-execution"
);
type MetaAutomationProposal =
  import("@/lib/meta/automation-proposals").MetaAutomationProposal;

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

function proposal(
  overrides: Partial<MetaAutomationProposal> = {},
): MetaAutomationProposal {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    businessId: BUSINESS_ID,
    providerAccountId: "act_1",
    decisionKey: "adset:23848",
    scopeType: "adset",
    scopeId: "23848",
    recId: "rec_1",
    recType: "scenario_m3_mid_funnel_inefficient_cut",
    snapshotDate: "2026-08-17",
    engineVersion: "meta-v3",
    decisionLabel: "cut",
    proposedAction: "pause",
    actionLabel: "Pause ad set",
    primaryCaption: "Approve & apply",
    entityLabel: "Retargeting 7d — DPA",
    reason: "ROAS below breakeven.",
    evidenceLabel: null,
    evidenceRef: {},
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    receipt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function operatorRequest() {
  return new NextRequest(
    "http://localhost/api/meta/automation/proposals?businessId=" + BUSINESS_ID,
    { method: "POST", headers: { cookie: "adsecute_session=token-abc" } },
  );
}

async function capturedDispatch() {
  const [request, context] = vi.mocked(entityRoutes.handleMetaEntityPauseAction)
    .mock.calls[0];
  return {
    url: request.nextUrl.pathname,
    cookie: request.headers.get("cookie"),
    body: await request.json(),
    params: await context.params,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(entityRoutes.handleMetaEntityPauseAction).mockResolvedValue(
    NextResponse.json(
      { ok: true, action: "pause", entityId: "23848", status: "PAUSED" },
      { status: 200 },
    ) as never,
  );
});

describe("approval executes through the existing guarded handler", () => {
  it("calls the entity-action handler rather than any provider client", async () => {
    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
    });

    expect(entityRoutes.handleMetaEntityPauseAction).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.receipt.httpStatus).toBe(200);
    expect(result.receipt.endpoint).toBe("/api/meta/adsets/23848/pause");
  });

  it("sends exactly the manual-operator contract that handler demands", async () => {
    await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
    });

    const dispatch = await capturedDispatch();
    expect(dispatch.url).toBe("/api/meta/adsets/23848/pause");
    expect(dispatch.params).toEqual({ adsetId: "23848" });
    expect(dispatch.body).toEqual({
      actionOrigin: "manual_operator_v1",
      manualConfirmation: "explicit_operator_confirmation",
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      // Lineage of the evidence, so the action-log row points back at the
      // engine decision the proposal projects.
      recId: "rec_1",
    });
  });

  it("carries no native decision-lineage field, so it cannot claim engine authority", async () => {
    await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
    });

    const body = (await capturedDispatch()).body as Record<string, unknown>;
    for (const forbidden of [
      "decisionId",
      "decisionSnapshotId",
      "snapshotId",
      "evaluationId",
      "engineVersion",
      "decisionHash",
      "decisionOrigin",
      "action_origin",
      "executionOrigin",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("forwards the operator's own session so every guard runs on their authority", async () => {
    await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
    });

    expect((await capturedDispatch()).cookie).toBe(
      "adsecute_session=token-abc",
    );
  });

  it("hands the persisted dryRunOnly guardrail to the handler's own dry-run mode", async () => {
    await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: true,
    });

    expect((await capturedDispatch()).body).toMatchObject({ dryRun: true });
  });

  it("routes a campaign-grain proposal to the campaign parameter name", async () => {
    await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal({ scopeType: "campaign", scopeId: "9911" }),
      dryRunOnly: false,
    });

    const dispatch = await capturedDispatch();
    expect(dispatch.url).toBe("/api/meta/campaigns/9911/pause");
    expect(dispatch.params).toEqual({ campaignId: "9911" });
  });

  it("reports a handler refusal as a failed receipt, not as a success", async () => {
    vi.mocked(entityRoutes.handleMetaEntityPauseAction).mockResolvedValue(
      NextResponse.json(
        { ok: false, error: { code: "kill_switch_engaged" } },
        { status: 503 },
      ) as never,
    );

    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
    });

    expect(result.ok).toBe(false);
    expect(result.receipt.httpStatus).toBe(503);
    expect(result.receipt.response).toMatchObject({
      error: { code: "kill_switch_engaged" },
    });
  });

  it("withholds an action that has no endpoint instead of improvising one", async () => {
    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      // `bid` has an endpoint but needs an operator-entered amount, and this
      // module refuses it before any dispatch is built.
      proposal: proposal({ proposedAction: "bid" }),
      dryRunOnly: false,
    });

    expect(result.ok).toBe(false);
    expect(result.receipt.withheld).toBe("unsupported_action");
    expect(entityRoutes.handleMetaEntityPauseAction).not.toHaveBeenCalled();
    expect(entityRoutes.handleMetaEntityResumeAction).not.toHaveBeenCalled();
  });
});

describe("there is no second write path", () => {
  it("never imports a Meta write client or the action log directly", () => {
    const source = readFileSync(
      "lib/meta/automation-proposal-execution.ts",
      "utf8",
    );

    // Everything a provider write needs — the HTTP call, the action log, the
    // preflight, the kill switch — belongs to the handler this delegates to.
    // Importing any of it here would be the beginning of a second path.
    expect(source).not.toContain("@/lib/meta/ads-write");
    expect(source).not.toContain("@/lib/meta/ads-action-log");
    expect(source).not.toContain("graph.facebook.com");
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).toContain("@/lib/meta/entity-action-routes");
  });
});
