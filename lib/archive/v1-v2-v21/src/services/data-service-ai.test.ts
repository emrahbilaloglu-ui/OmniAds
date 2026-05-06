import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCreativeDecisionOsSnapshot,
  getCreativeDecisionOsV2Preview,
} from "@/src/services/data-service-ai";

function previewResponse(enabled: boolean) {
  return new Response(
    JSON.stringify({
      contractVersion: "creative-decision-os-v2-preview.v0.1.1",
      enabled,
      status: "not_run",
      scope: {
        analysisScope: "account",
        analysisScopeId: null,
        analysisScopeLabel: "Account-wide",
        benchmarkScope: "account",
        benchmarkScopeId: null,
        benchmarkScopeLabel: "Account-wide",
      },
      generatedAt: "2026-04-27T12:00:00.000Z",
      decisionOsV2Preview: null,
      error: null,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function snapshotResponse(decisionCenter: unknown = undefined) {
  return new Response(
    JSON.stringify({
      contractVersion: "creative-decision-os-snapshot.v1",
      status: "ready",
      scope: {
        analysisScope: "account",
        analysisScopeId: null,
        analysisScopeLabel: "Account-wide",
        benchmarkScope: "account",
        benchmarkScopeId: null,
        benchmarkScopeLabel: "Account-wide",
      },
      snapshot: null,
      decisionOs: {
        contractVersion: "creative-decision-os.v1",
        creatives: [],
      },
      ...(decisionCenter !== undefined ? { decisionCenter } : {}),
      error: null,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function mutatingFetchCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([, init]) => {
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    return ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  });
}

describe("getCreativeDecisionOsV2Preview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a read-only GET request when the v2 preview flag is enabled", async () => {
    const fetchMock = vi.fn(async () => previewResponse(true));
    vi.stubGlobal("fetch", fetchMock);

    await getCreativeDecisionOsV2Preview("business-1", {
      enabled: true,
      benchmarkScope: {
        scope: "campaign",
        scopeId: "campaign-1",
        scopeLabel: "Campaign 1",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mutatingFetchCalls(fetchMock)).toEqual([]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/creatives/decision-os-v2/preview");
    expect(parsed.searchParams.get("businessId")).toBe("business-1");
    expect(parsed.searchParams.get("creativeDecisionOsV2Preview")).toBe("1");
    expect(parsed.searchParams.get("benchmarkScope")).toBe("campaign");
    expect(parsed.searchParams.get("benchmarkScopeId")).toBe("campaign-1");
    expect(parsed.searchParams.get("benchmarkScopeLabel")).toBe("Campaign 1");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.cache).toBe("no-store");
  });

  it("keeps the preview endpoint GET-only when the flag is omitted", async () => {
    const fetchMock = vi.fn(async () => previewResponse(false));
    vi.stubGlobal("fetch", fetchMock);

    await getCreativeDecisionOsV2Preview("business-1", { enabled: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mutatingFetchCalls(fetchMock)).toEqual([]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/creatives/decision-os-v2/preview");
    expect(parsed.searchParams.get("creativeDecisionOsV2Preview")).toBeNull();
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });
});

describe("getCreativeDecisionOsSnapshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts old snapshot responses without decisionCenter", async () => {
    const fetchMock = vi.fn(async () => snapshotResponse());
    vi.stubGlobal("fetch", fetchMock);

    const payload = await getCreativeDecisionOsSnapshot("business-1");

    expect(payload.contractVersion).toBe("creative-decision-os-snapshot.v1");
    expect(payload.decisionOs?.contractVersion).toBe("creative-decision-os.v1");
    expect(payload.decisionCenter).toBeUndefined();
  });

  it("accepts additive snapshot responses with decisionCenter null", async () => {
    const fetchMock = vi.fn(async () => snapshotResponse(null));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await getCreativeDecisionOsSnapshot("business-1");

    expect(payload.decisionCenter).toBeNull();
  });

  it("accepts additive snapshot responses with an empty decisionCenter", async () => {
    const fetchMock = vi.fn(async () =>
      snapshotResponse({
        contractVersion: "creative-decision-center.v2.1",
        engineVersion: "engine",
        adapterVersion: "adapter",
        configVersion: "config",
        generatedAt: "2026-04-30T00:00:00.000Z",
        dataFreshness: { status: "unknown", maxAgeHours: null },
        inputCoverageSummary: {},
        missingDataSummary: {},
        todayBrief: [],
        actionBoard: {
          scale: [],
          cut: [],
          refresh: [],
          protect: [],
          test_more: [],
          watch_launch: [],
          fix_delivery: [],
          fix_policy: [],
          diagnose_data: [],
        },
        rowDecisions: [],
        aggregateDecisions: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = await getCreativeDecisionOsSnapshot("business-1");

    expect(payload.decisionCenter?.contractVersion).toBe(
      "creative-decision-center.v2.1",
    );
    expect(payload.decisionCenter?.rowDecisions).toEqual([]);
  });

  it("still rejects invalid snapshot contract versions", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ contractVersion: "wrong" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCreativeDecisionOsSnapshot("business-1")).rejects.toThrow(
      "Creative Decision OS snapshot API returned an invalid payload.",
    );
  });
});
