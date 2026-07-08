import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaAutomationView } from "./page";
import type { MetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";

const payload: MetaAutomationControlPlane = {
  contractVersion: "meta-automation-control-plane.v1",
  businessId: "biz_1",
  globalKillSwitch: { engaged: false, reason: null },
  businessControl: {
    businessId: "biz_1",
    killSwitchEngaged: true,
    killSwitchReason: "Owner paused automation.",
    autoExecutionEnabled: false,
    readinessTier: "manual_review",
    guardrails: {
      dailyAutoActionCap: 3,
      perActionSpendCeilingMinor: 5000,
      perActionSpendCeilingCurrency: "EUR",
      notificationPolicy: "every_auto_action",
      maxBudgetIncreasePct: 15,
      maxDailyBudgetChangeMinor: null,
      requireCampaignLabel: true,
      requireCommercialAnchor: true,
      requireLivePreflight: true,
      requireRollbackPlan: true,
      dryRunOnly: true,
    },
    updatedAt: null,
    updatedBy: null,
    source: "persisted",
  },
  execution: {
    autoExecutionAllowed: false,
    writeEndpointsBlocked: true,
    blockedReasons: ["business_kill_switch", "auto_execution_not_enabled"],
  },
  promotionRecords: [
    {
      id: "promo_1",
      recId: "rec_1",
      entityType: "adset",
      entityId: "adset_1",
      sourceTier: "manual_review",
      targetTier: "backtest_candidate",
      status: "approved",
      reason: "Backtest ready.",
      createdAt: "2026-07-07T10:00:00.000Z",
    },
  ],
  activityLedger: [
    {
      id: "act_1",
      activityType: "meta_pause",
      severity: "warning",
      message: "Meta write blocked by kill switch.",
      payload: { endpoint: "/ad_1" },
      createdAt: "2026-07-07T10:05:00.000Z",
      source: "meta_action_log",
    },
  ],
  decisionTypeModes: [
    { decisionType: "pause", mode: "manual", lockReason: null, updatedAt: null, updatedBy: null, source: "default" },
    { decisionType: "bid", mode: "semi_auto", lockReason: null, updatedAt: "2026-07-07T09:00:00.000Z", updatedBy: "user_1", source: "persisted" },
    { decisionType: "budget", mode: "manual", lockReason: null, updatedAt: null, updatedBy: null, source: "default" },
    { decisionType: "creative", mode: "manual", lockReason: null, updatedAt: null, updatedBy: null, source: "default" },
  ],
};

describe("MetaAutomationView", () => {
  it("renders blocked automation state from the server contract", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView businessName="IwaStore" payload={payload} />,
    );

    expect(html).toContain("Automation");
    // Kill-switch posture + the human reason are both surfaced (honesty).
    expect(html).toContain("Kill switch engaged");
    expect(html).toContain("Owner paused automation.");
    // Real server data is rendered verbatim; nothing is invented.
    expect(html).toContain("Manual review"); // readinessTier label
    expect(html).toContain("Backtest ready."); // promotion record reason
    expect(html).toContain("Meta write blocked by kill switch."); // activity message
    expect(html).toContain("Daily auto-action cap");
    expect(html).toContain("3 / day");
    expect(html).toContain("Per-action spend ceiling");
    expect(html).toContain("€50");
    // With the kill switch engaged, the control offers a real release path (no one-way trap).
    expect(html).toContain("Resume writes");
    expect(html).toContain('data-testid="meta-mobile-automation"');
    expect(html).toContain("Automation · read-only");
    expect(html).toContain("Mobile is read-only");
    expect(html).toContain("STOP-only");
    // Per-decision-type gates stay honest: no fabricated hit/judged numbers.
    expect(html).toContain("read model missing");
    expect(html).toContain("href=\"/platforms/meta\"");
    expect(html).not.toContain("href=\"/platforms/meta/launchpad\"");
  });

  it("does not invent state when no business is selected", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView businessName={null} payload={null} />,
    );

    expect(html).toContain("Select a business");
    expect(html).toContain("default account is assumed");
    // With no payload the surface withholds state rather than inventing it.
    expect(html).toContain("not loaded");
    expect(html).toContain("Guardrails are missing");
  });
});
