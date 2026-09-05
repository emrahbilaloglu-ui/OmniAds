import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MetaMorningCard } from "@/components/overview/v2/meta-morning-card";
import type { MetaDailyBrief } from "@/lib/meta/daily-brief";

function brief(overrides: Partial<MetaDailyBrief> = {}): MetaDailyBrief {
  return {
    contract: "meta.daily-brief.v1",
    businessId: "biz",
    providerAccountId: "act_1",
    asOf: "2026-09-05",
    modes: { state: "read", pause: "semi_auto", budget: "auto", bid: "manual", creative: "manual" },
    alerts: { state: "read", high: 2, total: 5, top: [] },
    decisions: { state: "read", actionable: 7, top: [], snapshotDate: "2026-09-05" },
    queue: { state: "read", pending: 3 },
    appliedYesterday: { state: "read", applied: 4, failed: 1 },
    freshness: { state: "read", lastSnapshotDate: "2026-09-05", staleDays: 0 },
    ...overrides,
  };
}

describe("the morning card answers the questions the operator opens with", () => {
  it("shows what ran, what waits, what is wrong and what to do", () => {
    const html = renderToStaticMarkup(<MetaMorningCard brief={brief()} />);
    expect(html).toContain("Applied overnight");
    expect(html).toContain("Waiting for you");
    expect(html).toContain("1 failed");
    expect(html).toContain("2 need attention");
    expect(html).toContain("Budget Automatic · Pause Semi-automatic");
  });

  it("names the snapshot the numbers came from", () => {
    const html = renderToStaticMarkup(<MetaMorningCard brief={brief()} />);
    expect(html).toContain("Based on decisions from 2026-09-05");
  });

  it("says how old a stale picture is instead of implying it is today's", () => {
    const html = renderToStaticMarkup(<MetaMorningCard brief={brief({
      freshness: { state: "read", lastSnapshotDate: "2026-09-02", staleDays: 3 },
    })} />);
    expect(html).toContain("3 days old");
  });
});

describe("a read that failed never reads as a quiet morning", () => {
  it("says 'not read' rather than zero", () => {
    /*
      The distinction the whole card is built around: an empty queue and an
      unreadable queue are both "0" on a dashboard and mean opposite things.
      One is nothing to do; the other is a broken read reported as nothing to
      do, which is how an operator misses a day.
    */
    const html = renderToStaticMarkup(<MetaMorningCard brief={brief({
      queue: { state: "unavailable", pending: 0 },
      alerts: { state: "unavailable", high: 0, total: 0, top: [] },
    })} />);
    expect(html).toContain("not read");
    // And the sections that DID read still show their real numbers.
    expect(html).toContain("Applied overnight");
    expect(html).toContain(">4<");
  });

  it("says the modes could not be read rather than showing manual", () => {
    const html = renderToStaticMarkup(<MetaMorningCard brief={brief({
      modes: { state: "unavailable", pause: null, budget: null, bid: null, creative: null },
    })} />);
    expect(html).toContain("Management modes could not be read");
    expect(html).not.toContain("Budget Manual");
  });

  it("shows the reason when the whole brief failed", () => {
    const html = renderToStaticMarkup(
      <MetaMorningCard brief={null} error="meta_brief_unavailable" />,
    );
    expect(html).toContain("meta_brief_unavailable");
  });
});
