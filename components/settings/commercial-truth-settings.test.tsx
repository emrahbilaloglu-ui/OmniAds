import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildTargetPackReconfirmDescription,
  DecisionCoverageSection,
  getTargetPackReconfirmDisabledReason,
  requestTargetPackReconfirmation,
  TargetRoasSection,
} from "@/components/settings/commercial-truth-settings";
import {
  createEmptyBusinessCommercialTruthSnapshot,
  createEmptyTargetPack,
  type BusinessCommercialTruthSnapshot,
  type BusinessTargetPackData,
} from "@/src/types/business-commercial";

const UPDATED_AT = "2026-05-01T10:30:00.000Z";

function targetPack(
  overrides?: Partial<BusinessTargetPackData>,
): BusinessTargetPackData {
  return {
    ...createEmptyTargetPack(),
    targetRoas: 3.2,
    breakEvenRoas: 2.1,
    targetCpa: null,
    breakEvenCpa: 55,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function snapshot(pack = targetPack()): BusinessCommercialTruthSnapshot {
  const value = createEmptyBusinessCommercialTruthSnapshot("biz_1");
  return {
    ...value,
    targetPack: pack,
    sectionMeta: {
      ...value.sectionMeta,
      targetPack: {
        ...value.sectionMeta.targetPack,
        configured: true,
        itemCount: 1,
        updatedAt: pack.updatedAt,
        freshness: {
          status: "stale",
          updatedAt: pack.updatedAt,
          ageHours: 1_800,
          reason:
            "Target pack thresholds are older than the allowed freshness window.",
        },
        blocking: true,
      },
    },
  };
}

function renderTargetSection(input?: {
  reconfirmDisabledReason?: string | null;
  freshnessStatus?: "fresh" | "stale" | "missing";
}) {
  const freshnessStatus = input?.freshnessStatus ?? "stale";
  return renderToStaticMarkup(
    <TargetRoasSection
      targetRoas={3.2}
      onChange={vi.fn()}
      breakEven={2.1}
      manualBreakEven={2.1}
      onManualBreakEvenChange={vi.fn()}
      targetCpa={null}
      onTargetCpaChange={vi.fn()}
      breakEvenCpa={55}
      onBreakEvenCpaChange={vi.fn()}
      currency="EUR"
      freshness={{
        status: freshnessStatus,
        updatedAt: UPDATED_AT,
        ageHours: freshnessStatus === "fresh" ? 1 : 1_800,
        reason: freshnessStatus === "stale" ? "Review required." : null,
      }}
      updatedAt={UPDATED_AT}
      reconfirmDisabledReason={input?.reconfirmDisabledReason ?? null}
      onRequestReconfirm={vi.fn()}
      costStructureActive={false}
    />,
  );
}

describe("Commercial Truth target-pack settings", () => {
  it("renders CPA anchors in the business currency without fabricating zero for a missing value", () => {
    const html = renderTargetSection();

    expect(html).toContain('data-testid="commercial-target-cpa"');
    expect(html).toContain('data-testid="commercial-break-even-cpa"');
    expect(html).toContain("EUR");
    expect(html).not.toContain('data-testid="commercial-target-cpa" value="0"');
    expect(html).toContain('data-testid="commercial-break-even-cpa"');
    expect(html).toContain('value="55"');
  });

  it("states stale authority and does not call stale thresholds complete", () => {
    const targetHtml = renderTargetSection();
    const coverageHtml = renderToStaticMarkup(
      <DecisionCoverageSection snapshot={snapshot()} />,
    );

    expect(targetHtml).toContain("Decision authority needs reconfirmation");
    expect(targetHtml).toContain(
      "Hard Scale/Cut authority is blocked until reconfirmed.",
    );
    expect(targetHtml).toContain("Last updated or confirmed:");
    expect(coverageHtml).toContain("Stale");
    expect(coverageHtml).toContain(
      "Hard Scale/Cut authority blocked until reconfirmed",
    );
  });

  it("blocks reconfirmation while local edits are dirty", () => {
    const pack = targetPack();
    const disabledReason = getTargetPackReconfirmDisabledReason({
      canEdit: true,
      dirty: true,
      reconfirming: false,
      targetPack: pack,
      freshnessStatus: "stale",
    });
    const html = renderTargetSection({
      reconfirmDisabledReason: disabledReason,
    });

    expect(disabledReason).toBe(
      "Save or discard local edits before reconfirming unchanged economics.",
    );
    expect(html).toMatch(
      /data-testid="commercial-target-pack-reconfirm"[^>]*disabled/,
    );
    expect(html).toContain(disabledReason);
  });

  it("disables explicit reconfirmation for an already-fresh pack", () => {
    const disabledReason = getTargetPackReconfirmDisabledReason({
      canEdit: true,
      dirty: false,
      reconfirming: false,
      targetPack: targetPack(),
      freshnessStatus: "fresh",
    });

    expect(disabledReason).toContain("already fresh");
    expect(
      renderTargetSection({
        reconfirmDisabledReason: disabledReason,
        freshnessStatus: "fresh",
      }),
    ).toMatch(/data-testid="commercial-target-pack-reconfirm"[^>]*disabled/);
  });

  it("lists every non-null anchor in the confirmation copy", () => {
    const description = buildTargetPackReconfirmDescription(
      targetPack(),
      "EUR",
    );

    expect(description).toContain("Target ROAS: 3.20x");
    expect(description).toContain("Break-even ROAS: 2.10x");
    expect(description).not.toContain("Target CPA:");
    expect(description).toContain("Break-even CPA:");
  });

  it("posts only the reconfirm identity contract and returns the refreshed snapshot", async () => {
    const refreshed = snapshot(
      targetPack({ updatedAt: "2026-07-14T12:00:00.000Z" }),
    );
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ snapshot: refreshed, revision: "a".repeat(64) }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await requestTargetPackReconfirmation({
      businessId: "biz_1",
      expectedUpdatedAt: UPDATED_AT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.snapshot).toEqual(refreshed);
    expect(result.revision).toBe("a".repeat(64));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).toEqual({
      businessId: "biz_1",
      action: "reconfirm_target_pack",
      expectedUpdatedAt: UPDATED_AT,
    });
  });

  it("preserves the exact server error message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "target_pack_conflict",
          message:
            "Targets changed in another session. Reload before reconfirming.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      requestTargetPackReconfirmation({
        businessId: "biz_1",
        expectedUpdatedAt: UPDATED_AT,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(
      "Targets changed in another session. Reload before reconfirming.",
    );
  });
});
