// @vitest-environment jsdom

/**
 * The creative surfaces as an operator meets them.
 *
 * The mobile assertions matter most: at 390 and 320 every metric that exists at
 * 1440 must still be rendered. A metric silently dropped on mobile is a
 * different surface pretending to be the same one.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CreativePerformanceView } from "@/components/zero-base/creative/performance-view";
import { CreativeDetailView } from "@/components/zero-base/creative/detail-view";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import {
  buildPerformanceViewModel,
  type ServedCreativeRow,
} from "@/lib/zero-base/creative/performance-adapter";
import { buildEvidence, buildHistory, decisionBand } from "@/lib/zero-base/creative/detail-adapter";
import { ENGINE_POSTURES, postureView, type EnginePosture } from "@/lib/zero-base/creative/engine-posture";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";

afterEach(cleanup);

function row(overrides: Partial<ServedCreativeRow> = {}): ServedCreativeRow {
  return {
    id: "r1",
    creative_id: "cr-1",
    real_ad_id: "ad-1",
    account_id: "act_1",
    name: "Creative One",
    campaign_name: "Prospecting",
    adset_name: "Broad",
    currency: "USD",
    spend: 100,
    roas: 3.4,
    cpa: 12.5,
    purchases: 8,
    preview_status: "ready",
    cached_thumbnail_url: "https://cdn.example/a.jpg",
    ...overrides,
  };
}

function performance(posture: EnginePosture, rows: ServedCreativeRow[] = [row()]) {
  const decision = {
    providerAccountId: "act_1",
    parentChain: {
      ad: { id: "ad-1", name: "Creative One" },
      creative: { id: "cr-1", name: "Creative One" },
    },
    classification: {
      buyerAction: "scale",
      buyerLabel: "Scale",
      decisionState: "act",
    },
    metrics: { effectiveTargetRoas: 3.2 },
  } as unknown as MetaCanonicalDecision;
  render(
    <ZeroBasePortalHost>
      <CreativePerformanceView
        model={buildPerformanceViewModel({
          rows,
          posture,
          totalAvailable: rows.length,
          canonicalDecisions: [decision],
        })}
        businessId="biz-1"
      />
    </ZeroBasePortalHost>,
  );
}

describe("posture is stated on the surface", () => {
  it("names every posture with its explanation", () => {
    for (const posture of ENGINE_POSTURES) {
      cleanup();
      performance(posture);
      const node = document.querySelector(`[data-engine-posture="${posture}"]`);
      expect(node, posture).not.toBeNull();
      expect(node!.textContent, posture).toContain(postureView(posture).label);
    }
  });

  it("offers a decision link only while serving", () => {
    for (const posture of ENGINE_POSTURES) {
      cleanup();
      performance(posture);
      const links = document.querySelectorAll("[data-decision-link]").length;
      expect(links, posture).toBe(posture === "serving" ? 1 : 0);
      if (posture !== "serving") {
        expect(document.querySelector("[data-decision-withheld]"), posture).not.toBeNull();
      }
    }
  });
});

describe("collection detail stays in a drawer flow", () => {
  it("emits the selected creative instead of navigating the collection link", async () => {
    const onOpenCreative = vi.fn();
    const model = buildPerformanceViewModel({
      rows: [row()],
      posture: "serving",
      totalAvailable: 1,
    });
    render(
      <CreativePerformanceView
        model={model}
        businessId="biz-1"
        onOpenCreative={onOpenCreative}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Creative One" });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.closest("a")).toBeNull();
    await userEvent.click(trigger);
    expect(onOpenCreative).toHaveBeenCalledWith("cr-1");
  });
});

describe("rows stay complete at every width", () => {
  it("renders all four metrics — the mobile rows drop none", () => {
    performance("serving");
    // Layout is CSS; the DOM must carry every metric at any viewport, so a
    // narrow screen cannot become a quietly reduced surface.
    for (const metric of ["spend", "roas", "cpa", "purchases"]) {
      expect(document.querySelector(`[data-metric="${metric}"]`), metric).not.toBeNull();
    }
  });

  it("prints an absent metric as not served, never as 0", () => {
    performance("serving", [row({ roas: null, cpa: undefined })]);
    expect(document.querySelector('[data-metric-unavailable="roas"]')!.textContent).toMatch(
      /Not served/,
    );
    expect(document.querySelector('[data-metric="roas"]')).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\b0\.00\b/);
  });

  it("keeps a real zero visible as a measurement", () => {
    performance("serving", [row({ purchases: 0 })]);
    expect(document.querySelector('[data-metric="purchases"]')!.getAttribute("data-metric-raw")).toBe("0");
  });
});

describe("media", () => {
  it("names a missing preview instead of leaving a blank frame", () => {
    performance("serving", [row({ preview_status: "missing", cached_thumbnail_url: null })]);
    expect(document.querySelector('[data-creative-media="missing"]')!.textContent).toMatch(/No preview/);
  });

  it("gives a served preview a real alt text", () => {
    performance("serving");
    expect(screen.getByAltText("Preview of Creative One")).toBeTruthy();
  });
});

describe("disclosure", () => {
  it("states the cap and the omissions on the surface", () => {
    render(
      <ZeroBasePortalHost>
        <CreativePerformanceView
          model={buildPerformanceViewModel({
            rows: [row(), row({ id: "r2", creative_id: "" })],
            totalAvailable: 90,
            posture: "serving",
          })}
          businessId="biz-1"
        />
      </ZeroBasePortalHost>,
    );
    const text = document.querySelector("[data-performance-disclosure]")!.textContent ?? "";
    expect(text).toMatch(/Showing 1 of 90/);
    expect(text).toMatch(/1 row omitted/);
  });
});

/* --------------------------------------------------------------- detail */

function detail(overrides: Partial<React.ComponentProps<typeof CreativeDetailView>> = {}) {
  const built = buildHistory([
    { id: "h1", occurredAt: "t1", label: "Decided scale", detail: null, actor: "ada@example.com" },
    { id: "h2", occurredAt: "t2", label: "Decided cut", detail: null, replayedAt: "t3" },
  ]);
  render(
    <ZeroBasePortalHost>
      <CreativeDetailView
        creativeId="cr-1"
        name="Creative One"
        media={{ kind: "ready", url: "https://cdn.example/a.jpg", origin: "snapshot" }}
        evidence={buildEvidence(row())}
        band={decisionBand({
          posture: "serving",
          postureExplanation: "x",
          servedLabel: "Scale up",
          servedDetail: null,
        })}
        decisionsHref="/c/biz-1/meta/decisions?providerAccountId=act_1"
        history={built.rows}
        anyReplayed={built.anyReplayed}
        {...overrides}
      />
    </ZeroBasePortalHost>,
  );
}

describe("creative detail", () => {
  it("shows the served band and its Decisions link", () => {
    detail();
    expect(document.querySelector('[data-decision-band="Scale up"]')).not.toBeNull();
    expect(document.querySelector("[data-detail-decision-link]")).not.toBeNull();
  });

  it("shows the posture's reason instead of a band when not serving", () => {
    detail({
      band: decisionBand({
        posture: "shadow_only",
        postureExplanation: "Decisions are being computed for comparison only.",
        servedLabel: "scale",
        servedDetail: null,
      }),
    });
    expect(document.querySelector("[data-decision-band-none]")!.textContent).toMatch(
      /comparison only/,
    );
    expect(document.querySelector("[data-decision-band]")).toBeNull();
  });

  it("marks a replayed history entry and names an unrecorded actor", () => {
    detail();
    expect(document.querySelector("[data-creative-replay-banner]")).not.toBeNull();
    expect(document.querySelector('[data-history-replayed="h2"]')).not.toBeNull();
    expect(document.querySelector('[data-history-actor="h2"]')!.textContent).toBe("Actor not recorded");
    expect(document.querySelector('[data-history-actor="h1"]')!.textContent).toBe("ada@example.com");
  });

  it("labels every evidence field with its source", () => {
    detail();
    const items = document.querySelectorAll("[data-evidence-item]");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.textContent!.length).toBeGreaterThan(0);
  });

  it("refuses a cross-account deep link with its own reason", () => {
    detail({
      unavailableReason:
        "This creative exists but belongs to a different ad account than the one in this link.",
    });
    expect(document.body.textContent).toMatch(/different ad account/);
    expect(document.querySelector("[data-detail-decision-link]")).toBeNull();
  });
});
