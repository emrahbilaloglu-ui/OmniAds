import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  deriveEffectiveAuthority,
  MetaAutomationView,
} from "./automation-view";
import type { MetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";

const payload: MetaAutomationControlPlane = {
  contractVersion: "meta-automation-control-plane.v1",
  businessId: "biz_1",
  providerAccountId: "act_1",
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
      entityType: "decision_type_mode",
      entityId: "bid",
      sourceTier: "manual",
      targetTier: "semi_auto",
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
    {
      decisionType: "pause",
      mode: "manual",
      lockReason: null,
      updatedAt: null,
      updatedBy: null,
      source: "default",
    },
    {
      decisionType: "bid",
      mode: "semi_auto",
      lockReason: null,
      updatedAt: "2026-07-07T09:00:00.000Z",
      updatedBy: "user_1",
      source: "persisted",
    },
    {
      decisionType: "budget",
      mode: "manual",
      lockReason: null,
      updatedAt: null,
      updatedBy: null,
      source: "default",
    },
    {
      decisionType: "creative",
      mode: "auto",
      lockReason: "Evidence review pending.",
      updatedAt: "2026-07-07T08:00:00.000Z",
      updatedBy: "user_2",
      source: "persisted",
    },
  ],
};

describe("MetaAutomationView", () => {
  it("renders the ten product action classes mapped to the four backend preference groups", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        businessId="biz_1"
        businessName="IwaStore"
        providerAccounts={[
          {
            id: "act_1",
            name: "Main account",
            currency: "EUR",
            timezone: "Europe/Istanbul",
          },
        ]}
        providerAccountId="act_1"
        payload={payload}
      />,
    );

    expect(html).toContain("Automation");
    expect(html).toContain("Meta · Supervision control plane");
    expect(html).toContain("Effective authority");
    expect(html).toContain("Evidence");
    expect(html).toContain("Guardrails");
    expect(html).toContain("Activity");
    expect(html).toContain('data-testid="automation-authority-panel"');
    expect(html).not.toContain('data-testid="automation-evidence-panel"');
    expect(html).not.toContain('data-testid="automation-guardrails-panel"');
    expect(html).not.toContain('data-testid="automation-activity-panel"');
    expect(html.match(/data-action-class=/g)).toHaveLength(10);
    expect(html).toContain("Provider evidence");
    expect(html).toContain(
      "Business controls cover all assigned Meta accounts",
    );

    // Canonical authority is stated once; raw v1 preferences remain evidence.
    expect(html).toContain("Observe");
    expect(html).toContain("Recommend");
    expect(html).toContain("Approval Required");
    expect(html).toContain("Auto-execute");
    expect(html).toContain("Raw v1 value");
    expect(html).toContain("semi_auto");

    // A write STOP demotes effective authority. Guardrail controls remain isolated in their tab.
    expect(html).toContain("STOP engaged");
    expect(html).toContain("Owner paused automation.");
    expect(html).not.toContain('data-testid="review-release-business-stop"');

    // The route-owned mobile surface is read-only and preserves current context.
    expect(html).toContain('data-testid="meta-mobile-automation"');
    expect(html).toContain("Read-only status");
    expect(html).toContain(
      'href="/platforms/meta/automation?automationTab=authority&amp;businessId=biz_1&amp;providerAccountId=act_1"',
    );
    expect(html).toContain(
      'href="/platforms/meta?businessId=biz_1&amp;providerAccountId=act_1"',
    );
    expect(html).not.toContain("ad-mobile-device");
  });

  it("keeps evidence isolated in its tab and closes every missing gate", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        businessId="biz_1"
        businessName="IwaStore"
        providerAccountId="act_1"
        payload={payload}
        initialTab="evidence"
      />,
    );

    expect(html).toContain('data-testid="automation-evidence-panel"');
    expect(html).not.toContain('data-testid="automation-authority-panel"');
    expect(html.match(/data-action-class=/g)).toHaveLength(10);
    expect(html).toContain("Pause underperformer");
    expect(html).toContain("Apply bid or cost cap");
    expect(html).toContain("Scale budget step");
    expect(html).toContain("Promote test to Main");
    expect(html).toContain("Resume paused");
    expect(html).toContain("n &gt;= 30 per calibration cell");
    expect(html).toContain("ECE &lt;= 0.05 per label");
    expect(html).toContain("Mature outcomes; unknown excluded");
    expect(html).toContain("Zero critical or silent failures");
    expect(html).toContain("10 promotions closed");
    expect(html).toContain("Not in v1");
  });

  it("shows only the real Business STOP engage path and stored guardrails", () => {
    const clearPayload: MetaAutomationControlPlane = {
      ...payload,
      businessControl: {
        ...payload.businessControl,
        killSwitchEngaged: false,
        killSwitchReason: null,
      },
      execution: {
        ...payload.execution,
        writeEndpointsBlocked: false,
        blockedReasons: ["auto_execution_not_enabled"],
      },
    };
    const html = renderToStaticMarkup(
      <MetaAutomationView
        businessId="biz_1"
        businessName="IwaStore"
        providerAccountId="act_1"
        payload={clearPayload}
        initialTab="guardrails"
      />,
    );

    expect(html).toContain('data-testid="automation-guardrails-panel"');
    expect(html).toContain("Business STOP");
    expect(html).toContain("Environment STOP");
    expect(html).toContain("META_ADS_WRITE_KILL_SWITCH");
    expect(html).toContain("Engage Business STOP");
    expect(html).toContain('data-testid="engage-business-stop"');
    expect(html).toContain("Server-enforced");
    expect(html).not.toContain("Account stop");
    expect(html).not.toContain("Resume writes");
    expect(html).not.toContain("Release unavailable");

    expect(html).toContain(
      "Configured defaults, not yet enforced by an automation executor.",
    );
    expect(html).toContain("Daily auto-action cap");
    expect(html).toContain("3 / day");
    expect(html).toContain("Per-action spend ceiling");
    expect(html).toContain("€50.00");
    expect(html).toContain("Configured only");
  });

  it("exposes only the first Admin review step when Business STOP is engaged", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        businessId="biz_1"
        businessName="IwaStore"
        providerAccountId="act_1"
        payload={payload}
        initialTab="guardrails"
      />,
    );

    expect(html).toContain("Review release (Admin)");
    expect(html).toContain('data-testid="review-release-business-stop"');
    expect(html).not.toContain('data-testid="confirm-release-business-stop"');
    expect(html).toContain("fresh persisted-state preflight");
  });

  it("keeps activity and partial receipts isolated in the activity tab", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        businessId="biz_1"
        businessName="IwaStore"
        providerAccountId="act_1"
        payload={payload}
        initialTab="activity"
      />,
    );

    expect(html).toContain('data-testid="automation-activity-panel"');
    expect(html).not.toContain('data-testid="automation-authority-panel"');
    expect(html).toContain("Meta write blocked by kill switch.");
    expect(html).toContain("Provider action log");
    expect(html).toContain("Partial receipt evidence");
    expect(html).toContain(
      "not expose prior, intended, and observed state or verifiedAt",
    );
    expect(html).toContain("Backtest ready.");
    expect(html).toContain("not evidence-gated proposals");
  });

  it("does not invent business state when no business is selected", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        businessName={null}
        payload={null}
        initialTab="guardrails"
      />,
    );

    expect(html).toContain("Select a business.");
    expect(html).toContain("No default account is assumed.");
    expect(html).toContain("Not loaded");
    expect(html).toContain("No business scope");
    expect(html).toContain("Guardrail configuration is not loaded.");
    expect(html).toContain("disabled");
  });

  it("fails closed on an unreadable control plane but leaves scoped STOP available", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        businessId="biz_1"
        businessName="IwaStore"
        providerAccountId="act_1"
        payload={null}
        error="Database read failed."
        initialTab="guardrails"
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain("Control plane unreadable - fail closed.");
    expect(html).toContain("No authority or clearing action is inferred.");
    expect(html).toContain("Database read failed.");
    expect(html).toContain("Effective authority");
    expect(html).toContain("Observe");
    expect(html).toContain("Engage Business STOP");
    expect(html).toContain('data-testid="engage-business-stop"');
    expect(html).toContain("Retry read");
    expect(html).not.toContain("Resume writes");
  });

  it("treats a default control source as unverified rather than authoritative", () => {
    const defaultPayload: MetaAutomationControlPlane = {
      ...payload,
      businessControl: {
        ...payload.businessControl,
        source: "default",
        killSwitchEngaged: false,
        killSwitchReason: null,
      },
      execution: {
        autoExecutionAllowed: false,
        writeEndpointsBlocked: false,
        blockedReasons: [
          "auto_execution_not_enabled",
          "dry_run_only_guardrail",
        ],
      },
    };

    const html = renderToStaticMarkup(
      <MetaAutomationView
        businessId="biz_1"
        businessName="IwaStore"
        payload={defaultPayload}
      />,
    );

    expect(deriveEffectiveAuthority(defaultPayload)).toMatchObject({
      mode: "Observe",
    });
    expect(html).toContain("Persisted business control is not proven.");
    expect(html).toContain("The payload source is default.");
    expect(html).toContain("Unverified");
    expect(html).toContain("authority fails closed");
    expect(html).toContain("Persisted business control is not proven");
  });

  it("surfaces a server-allowed auto flag without fabricating an executor", () => {
    const serverAllowedPayload: MetaAutomationControlPlane = {
      ...payload,
      businessControl: {
        ...payload.businessControl,
        killSwitchEngaged: false,
        killSwitchReason: null,
        autoExecutionEnabled: true,
        readinessTier: "auto_execute",
        guardrails: {
          ...payload.businessControl.guardrails,
          dryRunOnly: false,
        },
      },
      execution: {
        autoExecutionAllowed: true,
        writeEndpointsBlocked: false,
        blockedReasons: [],
      },
    };

    const html = renderToStaticMarkup(
      <MetaAutomationView
        businessId="biz_1"
        businessName="IwaStore"
        payload={serverAllowedPayload}
      />,
    );

    expect(deriveEffectiveAuthority(serverAllowedPayload)).toMatchObject({
      mode: "Approval Required",
    });
    expect(html).toContain(
      "Server policy allows Auto-execute; executor absent.",
    );
    expect(html).toContain("This is a policy flag, not proof");
    expect(html).toContain("Stage B remains person-initiated");
    expect(html).toContain(
      "Auto-execute remains unavailable without an executor",
    );
  });

  it("does not assign a currency when the contract omits it", () => {
    const unknownCurrencyPayload: MetaAutomationControlPlane = {
      ...payload,
      businessControl: {
        ...payload.businessControl,
        guardrails: {
          ...payload.businessControl.guardrails,
          perActionSpendCeilingCurrency: null,
        },
      },
    };

    const html = renderToStaticMarkup(
      <MetaAutomationView
        businessId="biz_1"
        businessName="IwaStore"
        payload={unknownCurrencyPayload}
        initialTab="guardrails"
      />,
    );

    expect(html).toContain("5,000 minor units - currency unknown");
    expect(html).not.toContain("€50.00");
    expect(html).not.toContain("$50.00");
  });
});
