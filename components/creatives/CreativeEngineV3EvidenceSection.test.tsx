import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeAdDecisionEvidenceResponse } from "@/app/api/creatives/decision-engine-v3/evidence/route";

let queryState: Record<string, unknown>;
let invokeQueryFn = false;
let observedQuery: { queryKey?: unknown[]; enabled?: boolean } = {};

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(
    (input: {
      queryKey: unknown[];
      enabled?: boolean;
      queryFn: () => Promise<unknown>;
    }) => {
      observedQuery = {
        queryKey: input.queryKey,
        enabled: input.enabled,
      };
      if (invokeQueryFn && input.enabled) void input.queryFn();
      return queryState;
    },
  ),
}));

const { CreativeEngineV3EvidenceSection } = await import(
  "@/components/creatives/CreativeEngineV3EvidenceSection"
);

function payload(): NativeAdDecisionEvidenceResponse {
  return {
    status: "available",
    contractVersion: "decision-engine-v3-native-ad-evidence.v1",
    businessId: "biz-1",
    providerAccountId: "act_1",
    adId: "ad-1",
    creativeId: "creative-1",
    asOf: "2026-07-16",
    engineVersion: "native-current",
    generation: {
      jobRunId: "job-run-1",
      asOfDate: "2026-07-16",
      providerAccountRefId: "provider-ref-1",
      manifestHash: "a".repeat(64),
      expectedAdCount: 1,
    },
    decision: {
      decisionId: "decision-ad-1",
      episodeId: "episode-ad-1",
      providerAccountId: "act_1",
      identityGrain: "ad",
      sourceAuthority: {
        status: "native_exact",
        actionEligible: false,
        reviewOnlyReason: "pending_transition",
        authorizedAction: null,
      },
      sourceDecision: {
        label: "keep",
        rawLabel: "cut",
        preAuthorityLabel: "cut",
        authorityBlocker: "pending_transition",
        reason: "Persisted Cut is held for epoch confirmation.",
        confidence: 91,
        truthSource: "commercial_truth",
        badges: ["pending_transition"],
      },
      parentChain: {
        ad: { id: "ad-1", name: "Ad one" },
        creative: { id: "creative-1", name: "Creative one" },
      },
      classification: {
        decisionState: "blocked",
        heldAction: "cut",
        buyerAction: null,
        buyerLabel: "Cut · Held",
      },
      metrics: {
        spend: 500,
        purchases: 2,
        roas: 0.8,
        recent7dRoas: 0.7,
        effectiveTargetRoas: 2.2,
        ratioToTarget: 0.36,
      },
      history: {
        responses: {
          status: "available",
          reason: null,
          items: [
            {
              id: "response-1",
              observationStatus: "observed_no_response",
              responseType: "ignored",
              detectedAt: "2026-07-16T10:00:00.000Z",
              responseCutoff: "2026-07-16T09:00:00.000Z",
            },
          ],
        },
        providerWrites: {
          status: "unavailable",
          reason: "native_action_receipt_not_observed",
        },
      },
    } as never,
    lineage: {
      status: "verified",
      providerAccountRefId: "provider-ref-1",
      jobRunId: "job-run-1",
      scope: { type: "account", id: "act_1" },
      snapshot: {
        id: "snapshot-1",
        inputHash: "1".repeat(64),
        decisionHash: "2".repeat(64),
      },
      evaluation: {
        id: "evaluation-1",
        contextId: "context-1",
        contractVersion: "native-evaluation.v1",
        inputHash: "1".repeat(64),
        decisionHash: "2".repeat(64),
        evaluatedAt: "2026-07-16T03:04:00.000Z",
      },
      context: {
        id: "context-1",
        contractVersion: "native-evaluation.v1",
        contextHash: "3".repeat(64),
        evaluatedAt: "2026-07-16T03:03:00.000Z",
      },
    },
    persistedEvidence: {
      creativeInput: { adId: "ad-1", spend: 500 },
      campaignContext: { kind: "main" },
      priorHysteresis: { prior: null },
      decisionOutput: { label: "keep", blockedActionType: "cut" },
      evaluationContext: { asOf: "2026-07-16" },
      accountProfile: { scope: { type: "account", id: "act_1" } },
      dataHealth: { worstTier: "none" },
      flags: { shadowOnly: true },
    },
    flags: {
      businessId: "biz-1",
      enabled: true,
      surfaceVisible: true,
      shadowOnly: true,
      presetOverride: null,
      source: {
        enabled: "env",
        surfaceVisible: "env",
        shadowOnly: "env",
        presetOverride: null,
      },
      envDefaults: {
        enabled: true,
        surfaceVisible: true,
        shadowOnly: true,
      },
    },
  };
}

function renderEvidence(
  props: Partial<
    React.ComponentProps<typeof CreativeEngineV3EvidenceSection>
  > = {},
) {
  return renderToStaticMarkup(
    <CreativeEngineV3EvidenceSection
      businessId="biz-1"
      providerAccountId="act_1"
      adId="ad-1"
      creativeId="creative-1"
      open
      {...props}
    />,
  );
}

beforeEach(() => {
  queryState = {
    data: null,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
  };
  invokeQueryFn = false;
  observedQuery = {};
  vi.unstubAllGlobals();
});

describe("CreativeEngineV3EvidenceSection", () => {
  it("does not fetch while closed", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    invokeQueryFn = true;

    expect(renderEvidence({ open: false })).toBe("");
    expect(observedQuery.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed without a real Ad or exact provider account", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    invokeQueryFn = true;

    const missingAd = renderEvidence({ adId: null });
    expect(missingAd).toContain("Exact Ad evidence unavailable");
    expect(observedQuery.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    const missingAccount = renderEvidence({ providerAccountId: null });
    expect(missingAccount).toContain("provider account or real Ad identity");
    expect(observedQuery.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches by business, exact account, and exact Ad only", () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { origin: "https://app.example" },
    });
    invokeQueryFn = true;

    renderEvidence();

    expect(observedQuery).toEqual({
      enabled: true,
      queryKey: [
        "engine-v3-native-ad-evidence",
        "biz-1",
        "act_1",
        "ad-1",
      ],
    });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("businessId")).toBe("biz-1");
    expect(url.searchParams.get("providerAccountId")).toBe("act_1");
    expect(url.searchParams.get("adId")).toBe("ad-1");
    expect(url.searchParams.has("creativeId")).toBe(false);
    expect(url.searchParams.has("campaignId")).toBe(false);
  });

  it("renders only server-supplied persisted decision and lineage evidence", () => {
    queryState = { ...queryState, data: payload() };

    const html = renderEvidence();

    expect(html).toContain("Decision</summary>");
    expect(html).toContain("Persisted input</summary>");
    expect(html).toContain("Campaign and evaluation context</summary>");
    expect(html).toContain("Persisted engine trail</summary>");
    expect(html).toContain("Operator response</summary>");
    expect(html).toContain("Provenance</summary>");
    expect(html).toContain("Cut · Held");
    expect(html).toContain("pending_transition");
    expect(html).toContain("snapshot-1");
    expect(html).toContain("evaluation-1");
    expect(html).toContain("context-1");
    expect(html).toContain("creativeId (grouping only)");
  });

  it("renders disabled and fail-closed read states", () => {
    queryState = {
      ...queryState,
      data: {
        status: "disabled",
        reason: "engine_v3_disabled_for_business",
        flags: payload().flags,
      },
    };
    expect(renderEvidence()).toContain(
      "Engine v3 not enabled for this business",
    );

    queryState = { ...queryState, data: null, isError: true };
    expect(renderEvidence()).toContain(
      "failed lineage validation",
    );
  });
});
