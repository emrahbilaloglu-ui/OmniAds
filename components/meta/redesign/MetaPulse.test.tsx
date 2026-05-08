import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MetaPulse } from "@/components/meta/redesign/MetaPulse";
import { metaPulse } from "@/components/meta/redesign/test-fixtures";
import type { MetaPulsePayload } from "@/components/meta/redesign/types";

function renderPulse(overrides: Partial<MetaPulsePayload> = {}) {
  return renderToStaticMarkup(
    <MetaPulse pulse={metaPulse(overrides)} window="28d" onWindowChange={vi.fn()} />,
  );
}

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe("MetaPulse", () => {
  it("does not render the Meta pulse strip as sticky", () => {
    const html = renderPulse();

    expect(html).toContain('id="pulse"');
    expect(html).not.toContain("sticky top-0");
    expect(html).toContain("relative z-0 bg-white border-b border-slate-200");
  });

  it("applies severity tones to KPI band deltas", () => {
    const html = renderPulse({
      revenue: { current: 1200, prev: 2500 },
      cpa: { current: 160, prev: 76 },
      spend: { current: 7532, prev: 8760 },
    });

    expect(html).toContain("Revenue");
    expect(html).toContain("-52%");
    expect(html).toContain("text-rose-700 font-bold");
    expect(html).toContain("CPA");
    expect(html).toContain("+111%");
  });

  it("tones multi-window ROAS by breakeven and target", () => {
    const html = renderPulse({
      roas: { d7: 0.71, d14: 1.23, d28: 1.92, target: 1.83 },
    });

    expect(html).toContain('data-roas-window="7d"');
    expect(html).toContain("text-rose-700 font-bold");
    expect(html).toContain('data-roas-window="14d"');
    expect(html).toContain("text-amber-700");
    expect(html).toContain('data-roas-window="28d"');
  });

  it("renders tracking health pills and removes unknown tracking", () => {
    expect(renderPulse({ trackingHealth: { status: "healthy", detail: "Stable." } })).toContain(
      "Tracking healthy",
    );
    expect(renderPulse({ trackingHealth: { status: "degraded", detail: "Watchlisted." } })).toContain(
      "Tracking degraded",
    );
    expect(renderPulse({ trackingHealth: { status: "syncing", detail: "Syncing." } })).toContain(
      "Tracking syncing",
    );
    const unknown = renderPulse({ trackingHealth: { status: "unknown", detail: "Unavailable." } });
    expect(unknown).not.toContain("Tracking unknown");
    expect(unknown).not.toContain(">unknown<");
  });

  it("renders engine status with the snapshot engine version", () => {
    const live = renderPulse({ engineLastRun: isoDaysAgo(2), engineVersion: "v3.6.0-meta-taxonomy" });
    expect(live).toContain("v3.6.0-meta-taxonomy · Live");
    expect(live).toContain("v3.6.0-meta-taxonomy");

    const stale = renderPulse({ engineLastRun: isoDaysAgo(15), engineVersion: "v3.6.0-meta-taxonomy" });
    expect(stale).toContain("v3.6.0-meta-taxonomy · Stale");
    expect(stale).toContain("border-rose-200");
    expect(stale).toContain("bg-rose-50");
    expect(stale).toContain("text-rose-700");
  });

  it("does not render a standalone Stabilize action before handler wiring exists", () => {
    const html = renderPulse({ operatingMode: "Stabilize" });

    expect(html).toContain("Mode: Stabilize");
    expect(html).not.toContain("Apply stabilize mode");
    expect(html).not.toContain("Open stabilize plan");
  });

  it("labels regime and mode chips instead of rendering bare words", () => {
    const html = renderPulse({ operatingMode: "Balanced", seasonalRegime: "normalized" });

    expect(html).toContain("Mode: Balanced");
    expect(html).toContain("Regime: Normalized");
    expect(html).not.toContain(">normalized<");
  });

  it("renders ROAS vs target as an explicit sentence with ratio", () => {
    const html = renderPulse({ roas: { d7: 0.71, d14: 1.23, d28: 1.62, target: 1.83 } });

    expect(html).toContain("1.62×");
    expect(html).toContain("of 1.83× target");
    expect(html).toContain("· 88%");
    expect(html).toContain("below target");
    expect(html).not.toContain("1.62× / 1.83×");
  });

  it("renders sparkline only when ROAS history is present", () => {
    const withSparkline = renderPulse({
      roasHistory: [1.8, 1.6, 1.4, 1.2, 0.9, 0.8, 0.71],
    });
    expect(withSparkline).toContain('data-roas-sparkline="true"');

    const withoutSparkline = renderPulse({ roasHistory: undefined });
    expect(withoutSparkline).not.toContain("data-roas-sparkline");
  });

  it("shows contextual pace labels and gracefully falls back", () => {
    const daily = renderPulse({
      pacing: {
        mtdSpend: 1200,
        mtdTarget: 2400,
        dayPace: 0.27,
        spendToday: 90,
        dailyTarget: 333,
      },
    });
    expect(daily).toContain("Daily pace");
    expect(daily).toContain("$90 of $333");
    expect(daily).toContain("27%");

    const fallback = renderPulse({ pacing: { mtdSpend: 1200, mtdTarget: 2400, dayPace: 0.5 } });
    expect(fallback).toContain("Spend pace");
    expect(fallback).toContain("$1,200 of $2,400");
  });

  it("shows timestamped sync indicator only when a source exists", () => {
    const synced = renderPulse({ lastSyncAt: isoDaysAgo(0) });
    expect(synced).toContain("Synced");

    const missing = renderPulse({ lastSyncAt: null });
    expect(missing).not.toContain("Synced");
    expect(missing).not.toContain(">saved<");
  });

  it("renders three top-row bands with two dividers", () => {
    const html = renderPulse();

    expect(html).toContain('data-pulse-band="controls"');
    expect(html).toContain('data-pulse-band="engine-context"');
    expect(html).toContain('data-pulse-band="status"');
    expect((html.match(/data-pulse-divider="true"/g) ?? []).length).toBe(2);
  });

  it("renders loading state without fake unknown or saved pills", () => {
    const html = renderToStaticMarkup(
      <MetaPulse pulse={null} window="28d" onWindowChange={vi.fn()} />,
    );

    expect(html).toContain("Loading campaigns");
    expect(html).not.toContain("unknown");
    expect(html).not.toContain("saved");
    expect(html).not.toContain("$0");
  });
});
