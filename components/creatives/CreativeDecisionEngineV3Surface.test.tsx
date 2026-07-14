import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CreativeDecisionEngineV3Surface,
  SOURCE_FRESHNESS_CONFIDENCE_COPY,
  updateEngineV3PresetOverride,
} from "@/components/creatives/CreativeDecisionEngineV3Surface";
import type {
  AccountDecisionProfile,
  DataHealth,
  DataLayerHealth,
  DecisionOutput,
  EngineV3Flags,
} from "@/lib/creative-decision-engine";

const decision: DecisionOutput = {
  creativeId: "mock-creative-001",
  creativeName: "WallArtCatalog",
  label: "test_more",
  preAuthorityLabel: "test_more",
  authorityBlocker: null,
  reason: "Engine v3 stub - real gate logic not yet implemented.",
  confidence: 50,
  truthSource: "commercial_truth",
  effectiveTargetRoas: 2.2,
  ratioToTarget: 1.36,
  badges: [
    {
      type: "missing_recent_data",
      label: "Recent 7d data missing",
      severity: "warning",
    },
  ],
  metrics: {
    spend: 500,
    purchases: 8,
    roas: 3,
    recent7dRoas: 2.8,
  },
  engineVersion: "v3-2026-05-04-phase-3.4",
  generatedAt: "2026-05-04T12:30:00.000Z",
};

function makeLayer(
  overrides: Partial<DataLayerHealth> = {},
): DataLayerHealth {
  return {
    asOfDate: "2026-05-04",
    computedAt: "2026-05-04T12:00:00.000Z",
    sourceFreshnessHours: 0,
    staleTier: "none",
    fallbackMode: "runtime_sql",
    note: null,
    ...overrides,
  };
}

function makeDataHealth(
  overrides: Partial<DataHealth> = {},
): DataHealth {
  return {
    calibration: makeLayer(),
    lifecycle: makeLayer(),
    decisions: makeLayer(),
    worstTier: "none",
    degraded: false,
    ...overrides,
  };
}

function makeFlags(overrides: Partial<EngineV3Flags> = {}): EngineV3Flags {
  return {
    businessId: "biz-1",
    enabled: true,
    surfaceVisible: true,
    shadowOnly: false,
    presetOverride: null,
    source: {
      enabled: "env",
      surfaceVisible: "business_override",
      shadowOnly: "business_override",
      presetOverride: null,
    },
    envDefaults: {
      enabled: true,
      surfaceVisible: false,
      shadowOnly: true,
    },
    ...overrides,
  };
}

function makeAccountProfile(): AccountDecisionProfile {
  return {
    businessId: "biz-1",
    asOfDate: "2026-05-04",
    channel: "meta",
    objectiveFamily: "sales",
    preset: "balanced",
    presetSource: "default",
    spendUnit: 50,
    spendUnitSource: "meta_derived_aov",
    spendUnitConfidence: "high",
    spendUnitEvidence: {
      targetCpa: null,
      operatorAovAssumption: 55,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 42,
      metaAttributedRevenue90d: 2100,
      targetRoas: 2.2,
      breakEvenRoas: 1.71,
      accountCpaP50: 58,
      accountCpaSampleCount: 24,
      warnings: [],
    },
    multipliers: {
      zeroConvBurner: 1.5,
      cutCandidate: 2,
      sustainedLoser: 3,
      lossBudget: 2,
      hardCut: 4,
      scalePurchase: 1,
      winnerMemory: 0.8,
      recentSample: 0.5,
      weakFunnelRate: 0.8,
    },
    thresholds: {
      zeroConvBurnerSpend: 75,
      cutCandidateSpend: 100,
      sustainedLoserSpend: 150,
      commercialMaturitySpend: 100,
      hardCutSpend: 200,
      recentSampleMinSpend: 50,
      winnerMemoryMinSpend: 80,
      scaleMinPurchases: 3,
      winnerMemoryMinPurchases: 2,
      bottomQuartileRatio: 0.6,
      severeLoserRatio: 0.4,
    },
    accountBaselines: {
      businessId: "biz-1",
      computedAt: "2026-05-04T12:00:00.000Z",
      matureCreativeCount: 35,
      roasP75: 2.4,
      roasP60: 1.9,
      refreshRatioP10: 0.82,
      lowCtrP10: 0.7,
      accountCpaP50: 58,
      accountCpaSampleCount: 24,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 42,
      metaAttributedRevenue90d: 2100,
      matureSpendP50: 300,
      matureSpendP75: 450,
      winnerSpendP25: 250,
      winnerSpendP50: 500,
      winnerPurchaseP50: 5,
      roasRatioP10: 0.4,
      roasRatioP25: 0.6,
      roasRatioP50: 1,
      roasRatioP75: 1.35,
      metaAovQuality: "ready",
    },
    funnelCalibration: { byFormat: {} },
    scope: { type: "account", id: "*" },
    hardActionEligibility: {
      scale: true,
      cut: true,
      refresh: true,
      reason: null,
    },
    quality: {
      commercialTruthReady: true,
      calibrationReady: true,
      metaAovQuality: "ready",
      thresholdQuality: "ready",
    },
  };
}

function renderSurface(
  overrides: Partial<React.ComponentProps<typeof CreativeDecisionEngineV3Surface>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <CreativeDecisionEngineV3Surface
        businessId="biz-1"
        decisions={[decision]}
        isLoading={false}
        isError={false}
        error={null}
        engineVersion="v3-2026-05-04-phase-3.4"
        dataHealth={null}
        accountProfile={null}
        flags={makeFlags()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

describe("CreativeDecisionEngineV3Surface", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the v3 preview header, distribution, and decision row fields", () => {
    const html = renderSurface();

    expect(html).toContain("Engine v3 — in development");
    expect(html).toContain("v3-2026-05-04-phase-3.4");
    expect(html).toContain("Last updated 2026-05-04 12:30 UTC");
    expect(html).toContain("Test more: 1");
    expect(html).toContain("WallArtCatalog");
    expect(html).toContain("mock-creative-001");
    expect(html).toContain(
      'class="max-w-[14rem] shrink-0 truncate font-medium">WallArtCatalog</span>',
    );
    expect(html).toContain(
      'class="max-w-[10rem] shrink-0 truncate font-mono text-[10px] text-muted-foreground/70">mock-creative-001</span>',
    );
    expect(html).toContain("Engine v3 stub - real gate logic not yet implemented.");
    expect(html).toContain("conf 50");
    expect(html).toContain("commercial_truth");
  });

  it("does not render when the surface flag is off", () => {
    expect(
      renderSurface({
        flags: makeFlags({
          surfaceVisible: false,
          source: {
            enabled: "env",
            surfaceVisible: "env",
            shadowOnly: "business_override",
            presetOverride: null,
          },
        }),
      }),
    ).toBe("");
  });

  it("renders a shadow mode badge when advisory-only mode is active", () => {
    const html = renderSurface({
      flags: makeFlags({ shadowOnly: true }),
    });

    expect(html).toContain("Shadow mode (advisory only)");
  });

  it("falls back to the creative ID when the creative name is missing", () => {
    const html = renderSurface({
      decisions: [
        {
          ...decision,
          creativeName: null,
        },
      ],
    });

    expect(html).toContain("mock-creative-001");
    expect(html).not.toContain("WallArtCatalog");
    expect(html.match(/mock-creative-001/g)).toHaveLength(1);
  });

  it("renders the data source tag when the response includes it", () => {
    const html = renderSurface({ dataSource: "warehouse" });

    expect(html).toContain("data: warehouse");
  });

  it("does not render a data health badge when all layers are fresh", () => {
    const html = renderSurface({ dataHealth: makeDataHealth() });

    expect(html).not.toContain("data-health-tier=");
    expect(html).not.toContain("data: stale");
    expect(html).not.toContain("data: degraded");
  });

  it("renders the stale data health badge for warning tier", () => {
    const html = renderSurface({
      dataHealth: makeDataHealth({
        lifecycle: makeLayer({
          sourceFreshnessHours: 50,
          staleTier: "warning",
        }),
        worstTier: "warning",
      }),
    });

    expect(html).toContain('data-health-tier="warning"');
    expect(html).toContain("bg-amber-500/15");
    expect(html).toContain("data: stale");
    expect(html).toContain(
      "Data health: warning (calibration none, lifecycle warning, decisions none)",
    );
  });

  it("renders the degraded data health badge for disabled tier", () => {
    const html = renderSurface({
      dataHealth: makeDataHealth({
        decisions: makeLayer({
          sourceFreshnessHours: 73,
          staleTier: "disabled",
        }),
        worstTier: "disabled",
        degraded: true,
      }),
    });

    expect(html).toContain('data-health-tier="disabled"');
    expect(html).toContain("bg-rose-500/15");
    expect(html).toContain("data: degraded");
  });

  it("renders unknown freshness as warning-equivalent without calling it degraded", () => {
    const html = renderSurface({
      dataHealth: makeDataHealth({
        decisions: makeLayer({
          sourceFreshnessHours: null,
          staleTier: "unknown",
        }),
        worstTier: "unknown",
      }),
    });

    expect(html).toContain('data-health-tier="unknown"');
    expect(html).toContain("bg-amber-500/15");
    expect(html).toContain("data: freshness unknown");
    expect(html).not.toContain("data: degraded");
  });

  it("renders badge chips when decisions include badges", () => {
    const html = renderSurface();

    expect(html).toContain('data-badge-type="missing_recent_data"');
    expect(html).toContain(">missing_recent_data</span>");
  });

  it("does not render badge chips when decisions are empty or badges are empty", () => {
    expect(renderSurface({ decisions: [] })).not.toContain("data-badge-type=");
    expect(
      renderSurface({
        decisions: [
          {
            ...decision,
            badges: [],
          },
        ],
      }),
    ).not.toContain("data-badge-type=");
    expect(
      renderSurface({
        decisions: [
          {
            ...decision,
            badges: [],
          },
        ],
      }),
    ).not.toContain("No badges");
  });

  it("uses warning styling and exposes the badge label as tooltip text", () => {
    const html = renderSurface();

    expect(html).toContain('data-badge-severity="warning"');
    expect(html).toContain("bg-amber-500/15");
    expect(html).toContain('title="Recent 7d data missing"');
  });

  it("renders confidence freshness copy only from server-provided badges", () => {
    const staleHtml = renderSurface({
      decisions: [
        {
          ...decision,
          label: "cut",
          confidence: 65,
          badges: [
            {
              type: "stale_evidence",
              label: "Stale evidence: last sync 49h ago",
              severity: "warning",
            },
          ],
          metrics: {
            spend: 1000,
            purchases: 15,
            roas: 3.5,
            recent7dRoas: 3,
          },
        },
      ],
    });
    const noBadgeHtml = renderSurface({
      decisions: [
        {
          ...decision,
          label: "cut",
          confidence: 65,
          badges: [],
          metrics: {
            spend: 1000,
            purchases: 15,
            roas: 3.5,
            recent7dRoas: 3,
          },
        },
      ],
    });

    expect(staleHtml).toContain('data-confidence-copy="source_freshness_cap"');
    expect(staleHtml).toContain(SOURCE_FRESHNESS_CONFIDENCE_COPY);
    expect(staleHtml).toContain("confidence capped");
    expect(noBadgeHtml).not.toContain("source_freshness_cap");
    expect(noBadgeHtml).not.toContain(SOURCE_FRESHNESS_CONFIDENCE_COPY);
  });

  it("renders loading, error, and empty states", () => {
    expect(renderSurface({ decisions: null, isLoading: true })).toContain(
      "Loading v3 decisions...",
    );
    expect(
      renderSurface({
        decisions: null,
        isError: true,
        error: new Error("route failed"),
      }),
    ).toContain("Engine error: route failed");
    expect(renderSurface({ decisions: [] })).toContain("No creatives in scope.");
  });

  it("does not render when no business is selected", () => {
    expect(renderSurface({ businessId: null })).toBe("");
  });

  it("renders Scope profile disclosure when accountProfile is provided", () => {
    const html = renderSurface({ accountProfile: makeAccountProfile() });

    expect(html).toContain("<details");
    expect(html).toContain("Scope profile (account)");
    expect(html).toContain("Resolved scope");
    expect(html).toContain("account:*");
    expect(html).toContain('aria-label="Engine v3 preset"');
    expect(html).toContain("Preset");
    expect(html).toContain("Spend unit");
    expect(html).toContain("Target ROAS / break-even");
  });

  it("renders the preset dropdown with the active account preset selected", () => {
    const profile = {
      ...makeAccountProfile(),
      preset: "conservative" as const,
    };
    const html = renderSurface({ accountProfile: profile });

    expect(html).toContain('aria-label="Engine v3 preset"');
    expect(html).toContain(
      '<option value="conservative" selected="">conservative</option>',
    );
  });

  it("sends the selected preset to the preset mutation endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ...makeFlags(),
          presetOverride: "aggressive",
          source: {
            enabled: "env",
            surfaceVisible: "business_override",
            shadowOnly: "business_override",
            presetOverride: "business_override",
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const flags = await updateEngineV3PresetOverride({
      businessId: "biz-1",
      preset: "aggressive",
    });

    expect(flags.presetOverride).toBe("aggressive");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/engine-v3/preset",
      expect.objectContaining({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: "biz-1",
          preset: "aggressive",
        }),
      }),
    );
  });

  it("renders Clear override only when the preset comes from the v3 flags override", () => {
    const inheritedHtml = renderSurface({ accountProfile: makeAccountProfile() });
    const overrideHtml = renderSurface({
      accountProfile: {
        ...makeAccountProfile(),
        preset: "aggressive",
        presetSource: "business_engine_v3_flags_override",
      },
    });

    expect(inheritedHtml).not.toContain("Clear override");
    expect(overrideHtml).toContain("Clear override");
  });

  it("renders the disclosure collapsed and includes profile fields", () => {
    const html = renderSurface({ accountProfile: makeAccountProfile() });

    expect(html).not.toContain("<details open");
    expect(html).toContain("balanced");
    expect(html).toContain("meta_derived_aov / high");
    expect(html).toContain("2.2 / 1.71");
  });

  it("renders campaign scope and fallback reason in the profile disclosure", () => {
    const html = renderSurface({
      accountProfile: {
        ...makeAccountProfile(),
        scope: {
          type: "account",
          id: "*",
          fallbackReason: "campaign_sample_below_threshold",
        },
      },
    });

    expect(html).toContain("Scope profile (account)");
    expect(html).toContain(
      "Falling back to account scope: campaign sample size below 8 mature creatives",
    );
    expect(html).toContain("campaign_sample_below_threshold");
  });

  it("renders no Scope profile disclosure when accountProfile is null", () => {
    const html = renderSurface({ accountProfile: null });

    expect(html).not.toContain("Scope profile");
    expect(html).not.toContain("Mature creatives");
  });
});
