import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { MetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";
import { MetaAutomationView } from "./automation-view";

const payload: MetaAutomationControlPlane = {
  contractVersion: "meta-automation-control-plane.v1",
  businessId: "biz_1",
  providerAccountId: "act_1",
  globalKillSwitch: { engaged: false, reason: null },
  businessControl: {
    businessId: "biz_1",
    killSwitchEngaged: true,
    killSwitchReason: "Operator stop.",
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
    updatedAt: "2026-08-15T12:00:00.000Z",
    updatedBy: "user_1",
    source: "persisted",
  },
  execution: {
    autoExecutionAllowed: false,
    writeEndpointsBlocked: true,
    blockedReasons: ["business_kill_switch"],
  },
  promotionRecords: [
    {
      id: "promo_1",
      recId: "rec_1",
      entityType: "decision_type_mode",
      entityId: "budget",
      sourceTier: "manual",
      targetTier: "semi_auto",
      status: "approved",
      reason: "Backtest ready.",
      createdAt: "2026-08-15T10:00:00.000Z",
    },
  ],
  readCompleteness: { promotionRecords: "complete" },
  activityLedger: [
    {
      id: "activity_1",
      activityType: "business_kill_switch_engaged",
      severity: "danger",
      message: "Business kill switch engaged — all Meta writes stopped.",
      payload: { internal: "not-presented-as-a-result" },
      createdAt: "2026-08-15T14:31:00.000Z",
      source: "automation_ledger",
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
      mode: "manual",
      lockReason: null,
      updatedAt: null,
      updatedBy: null,
      source: "default",
    },
    {
      decisionType: "budget",
      mode: "semi_auto",
      lockReason: "Backtest contract required before auto-execute.",
      updatedAt: "2026-08-15T09:00:00.000Z",
      updatedBy: "user_1",
      source: "persisted",
    },
    {
      decisionType: "creative",
      mode: "auto",
      lockReason: null,
      updatedAt: "2026-08-15T08:00:00.000Z",
      updatedBy: "user_2",
      source: "persisted",
    },
  ],
};

function render(input: MetaAutomationControlPlane | null = payload) {
  return renderToStaticMarkup(
    <MetaAutomationView payload={input} providerAccountId="act_1" />,
  );
}

/**
 * A payload whose rules read is PROVEN complete. Everything in it is data the
 * server actually returned — no prototype rule from the design file.
 */
function withRules(): MetaAutomationControlPlane {
  return {
    ...payload,
    readCompleteness: { promotionRecords: "complete", rules: "complete" },
    commercialAnchors: {
      target_roas: 3.8,
      break_even_roas: 2.5,
      target_cpa: null,
      break_even_cpa: null,
    },
    rules: [
      {
        id: "rule_confirm",
        businessId: "biz_1",
        name: "Breakeven guard",
        entityLevel: "adset",
        trigger: {
          kind: "roas_below_anchor",
          anchor: "break_even_roas",
          anchorMultiplier: 1,
          consecutiveDays: 3,
        },
        action: { kind: "propose_pause", budgetChangePct: null },
        mode: "confirm",
        active: true,
        locked: false,
        firedCount: 3,
        lastFiredAt: "2026-08-12T09:00:00.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "rule_suggest",
        businessId: "biz_1",
        name: "Scale window",
        entityLevel: "adset",
        trigger: {
          kind: "roas_at_or_above_anchor",
          anchor: "target_roas",
          anchorMultiplier: 1,
          consecutiveDays: 12,
        },
        action: { kind: "flag_for_review", budgetChangePct: null },
        mode: "suggest",
        active: false,
        locked: false,
        firedCount: 0,
        lastFiredAt: null,
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
      },
      {
        id: "rule_guard",
        businessId: "biz_1",
        name: "Quiet hours",
        entityLevel: "adset",
        trigger: {
          kind: "quiet_hours",
          timeZone: "America/New_York",
          startHour: 0,
          endHour: 7,
        },
        action: { kind: "hard_block_writes", budgetChangePct: null },
        mode: "enforced",
        active: true,
        locked: true,
        firedCount: 1,
        lastFiredAt: "2026-08-12T04:12:00.000Z",
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ],
  };
}

function mobileMarkup(html: string) {
  return (
    html.match(
      /<section[^>]*data-testid="meta-mobile-automation"[\s\S]*?<\/section>/,
    )?.[0] ?? ""
  );
}

describe("Dashboard v2 exact Automation presentation", () => {
  it("keeps the canonical one-page hierarchy and copy without legacy extras", () => {
    const html = render();

    expect(html).toContain('data-screen-label="Automation"');
    expect(html).toContain("Meta · Supervision control plane");
    expect(html).toContain(">Automation</h1>");
    expect(html.match(/<article/g)).toHaveLength(7);
    expect(html).toContain("Kill switch");
    expect(html).toContain("Guardrails");
    expect(html).toContain("Readiness");
    expect(html).toContain("Needs your confirmation");
    expect(html).toContain("Rules");
    expect(html).toContain("Autonomy ladder");
    expect(html).toContain("Activity ledger");
    expect(html).toContain(
      "Flipping either switch blocks every provider write instantly — server-enforced, not a UI state.",
    );

    expect(html).not.toContain("Effective authority");
    expect(html).not.toContain("Provider posture");
    expect(html).not.toContain("Automation &amp; Meta Stop");
    expect(html).not.toContain("accountSelect");
    expect(html).not.toContain("Back to Meta");
    expect(html).not.toContain("Retry read");
  });

  it("maps only supported persisted summary fields and leaves unsupported values blank", () => {
    const html = render();

    expect(html).toMatch(
      /data-field="global-writes"[^>]*data-read-only="true"[^>]*>ENABLED/,
    );
    expect(html).toMatch(
      /data-field="business-writes"[^>]*data-read-only="true"[^>]*>STOPPED/,
    );
    expect(html).toContain("Max budget change / day");
    expect(html).toContain("+15% max");
    expect(html).toContain("Min ROAS floor (pause)");
    expect(html).not.toContain("Min ROAS floor · pause");
    expect(html).toContain("Max actions / day");
    expect(html).toContain(">3</strong>");
    expect(html).toMatch(/guardrail-roas-floor[\s\S]*?<strong>—<\/strong>/);
    expect(html).toMatch(/guardrail-quiet-hours[\s\S]*?<strong>—<\/strong>/);
    expect(html).not.toContain("2.50");
    expect(html).not.toContain("00:00–07:00 ET");
    expect(html).not.toContain("±15%");
    expect(html).toContain("Tier 1 — Supervised");
    expect(html).toContain("1 promotion record");
  });

  it("does not hide the real global env read when business control has no persisted row", () => {
    const html = render({
      ...payload,
      globalKillSwitch: {
        engaged: true,
        reason: "META_ADS_WRITE_KILL_SWITCH",
      },
      businessControl: {
        ...payload.businessControl,
        source: "default",
        readinessTier: "auto_execute",
      },
    });

    expect(html).toMatch(/data-field="global-writes"[^>]*>STOPPED/);
    expect(html).toMatch(/data-field="business-writes"[^>]*>—/);
    expect(html).toMatch(/data-field="readiness-tier">—/);
    expect(html).toMatch(/data-field="promotion-count">—/);
    expect(html).not.toContain("Every action requires operator confirmation.");
    expect(html).not.toContain("+15% max");
  });

  it("shows a zero promotion count only when the collection read is proven complete", () => {
    const complete = render({
      ...payload,
      promotionRecords: [],
      readCompleteness: { promotionRecords: "complete" },
    });
    const unavailable = render({
      ...payload,
      promotionRecords: [],
      readCompleteness: { promotionRecords: "unavailable" },
    });
    const legacyWithoutProvenance = render({
      ...payload,
      promotionRecords: [],
      readCompleteness: undefined,
    });

    expect(complete).toMatch(
      /data-field="promotion-count">0 promotion records/,
    );
    expect(unavailable).toMatch(/data-field="promotion-count">—/);
    expect(legacyWithoutProvenance).toMatch(/data-field="promotion-count">—/);
  });

  it("preserves canonical empty geometry without inventing proposals, rules or actions", () => {
    const html = render();

    expect(html).toContain('data-testid="confirmation-empty"');
    expect(html).toContain('data-testid="rules-empty"');
    expect(html).toContain("+ New rule</button>");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>\+ New rule<\/button>/);
    expect(html).not.toContain("Approve &amp; apply");
    expect(html).not.toContain(">Modify</button>");
    expect(html).not.toContain(">Dismiss</button>");
    expect(html).not.toContain("Breakeven guard");
    expect(html).not.toContain("Scale window");
    expect(html).not.toContain("data-rule-id");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("uses only persisted per-kind modes, never fabricates progress, and keeps launches manual", () => {
    const html = render();

    expect(html).toContain("Budget changes ≤ +15%");
    expect(html).toContain("Tier 2 · Backtest");
    expect(html).toContain("Backtest contract required before auto-execute.");
    expect(html).toContain("Pause / resume");
    expect(html).toMatch(
      /data-decision-type="pause"[\s\S]*?<span[^>]*>—<\/span>/,
    );
    expect(html).toContain("Creative rotation");
    expect(html).toContain("Tier 3 · Auto-execute");
    expect(html).toContain("Manual · by design");
    expect(html).toContain("New spend never automates.");
    expect(html).not.toContain("18 / 30");
    expect(html).not.toContain("22 / 30");
    expect(html).not.toContain("4 / 20");
  });

  it("renders real ledger records while leaving unavailable tuple fields as em dashes", () => {
    const html = render();

    expect(html).toContain('data-ledger-id="activity_1"');
    expect(html).toContain("Aug 15, 14:31");
    expect(html).toContain(
      "Business kill switch engaged — all Meta writes stopped.",
    );
    expect(html).not.toContain("System guard");
    expect(html).not.toContain("Success record");
    expect(html).not.toContain("not-presented-as-a-result");
    expect(html.match(/<td>—<\/td>/g)).toHaveLength(2);
  });

  it("keeps both exact kill-status pills static and exposes no write path", () => {
    const html = render();
    const source = readFileSync(
      "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
      "utf8",
    );

    expect(html).not.toContain('data-testid="business-stop-toggle"');
    expect(html.match(/data-read-only="true"/g)?.length).toBeGreaterThanOrEqual(
      3,
    );
    expect(source).not.toContain('method: "POST"');
    expect(source).not.toContain("window.confirm");
    expect(source).not.toContain("engage_kill_switch");
    expect(source).not.toContain("release_kill_switch");
  });

  it("renders persisted rules in the design's column order with real 28-day counts", () => {
    const html = render(withRules());

    expect(html).toContain('data-rule-id="rule_confirm"');
    expect(html).toContain("Breakeven guard");
    expect(html).toContain("ROAS &lt; breakeven (2.50) for 3 consecutive days");
    expect(html).toContain("Propose pause into the queue");
    expect(html).toContain(">Confirm</span>");
    expect(html).toContain("3× · Aug 12");
    expect(html).toContain('data-rule-id="rule_guard"');
    expect(html).toContain("any provider write 00:00–07:00 America/New_York");
    expect(html).toContain("Hard block · logged");
    expect(html).toContain(">Enforced</span>");
    // A proven-complete read with no firings is a real zero, not an em dash.
    expect(html).toContain("0×");
    expect(html).not.toContain('data-testid="rules-empty"');
  });

  it("renders the anchor as an em dash when the Commercial Truth pack does not supply it", () => {
    const html = render({
      ...withRules(),
      commercialAnchors: {
        target_roas: null,
        break_even_roas: null,
        target_cpa: null,
        break_even_cpa: null,
      },
    });

    expect(html).toContain("ROAS &lt; breakeven (—) for 3 consecutive days");
    expect(html).not.toContain("(2.50)");
  });

  it("keeps the enforced guard's toggle locked and never offers a provider action", () => {
    const html = render(withRules());
    const guardRow =
      html.match(/<tr[^>]*data-rule-id="rule_guard"[\s\S]*?<\/tr>/)?.[0] ?? "";

    expect(guardRow).toContain('data-locked="true"');
    expect(guardRow).toContain("Enforced — cannot be disabled");
    expect(guardRow).toMatch(/<button[^>]*disabled=""/);
    expect(html).not.toContain("Approve &amp; apply");
    expect(html).not.toContain("Execute");
    expect(html).toContain(
      "rules never write directly — they raise proposals into the confirmation queue (or hard-block, for guards)",
    );
  });

  it("marks a disabled rule without removing its row", () => {
    const html = render(withRules());
    const disabledRow =
      html.match(/<tr[^>]*data-rule-id="rule_suggest"[\s\S]*?<\/tr>/)?.[0] ?? "";

    expect(disabledRow).toContain('data-active="false"');
    expect(disabledRow).toContain('data-on="false"');
  });

  it("leaves the table em-dashed when the rules read was not proven complete", () => {
    const unavailable = render({
      ...withRules(),
      readCompleteness: { promotionRecords: "complete", rules: "unavailable" },
    });
    const legacyWithoutProvenance = render({
      ...withRules(),
      readCompleteness: { promotionRecords: "complete" },
    });

    expect(unavailable).toContain('data-testid="rules-empty"');
    expect(unavailable).not.toContain("data-rule-id");
    expect(legacyWithoutProvenance).toContain('data-testid="rules-empty"');
    expect(legacyWithoutProvenance).not.toContain("data-rule-id");
  });

  it("keeps every rule control inert without a server-authorized business scope", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        payload={withRules()}
        providerAccountId="act_1"
        businessId={null}
      />,
    );

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>\+ New rule<\/button>/);
    expect(html).not.toContain('data-testid="rule-composer"');
    const toggles = html.match(/class="[^"]*ruleToggle[^"]*"[^>]*/g) ?? [];
    expect(toggles.length).toBeGreaterThan(0);
    for (const toggle of html.match(/<button[^>]*ruleToggle[\s\S]*?>/g) ?? []) {
      expect(toggle).toContain('disabled=""');
    }
  });

  it("enables + New rule only with an authorized scope and a proven read", () => {
    const authorized = renderToStaticMarkup(
      <MetaAutomationView
        payload={withRules()}
        providerAccountId="act_1"
        businessId="biz_1"
      />,
    );
    const unproven = renderToStaticMarkup(
      <MetaAutomationView
        payload={{
          ...withRules(),
          readCompleteness: { promotionRecords: "complete" },
        }}
        providerAccountId="act_1"
        businessId="biz_1"
      />,
    );

    expect(authorized).toMatch(
      /<button[^>]*class="[^"]*newRule[^"]*"[^>]*>\+ New rule<\/button>/,
    );
    expect(authorized).not.toMatch(
      /<button[^>]*newRule[^>]*disabled=""[^>]*>\+ New rule/,
    );
    expect(unproven).toMatch(/<button[^>]*disabled=""[^>]*>\+ New rule<\/button>/);
    // Collapsed by default: the default DOM is exactly the design's.
    expect(authorized).not.toContain('data-testid="rule-composer"');
  });

  it("mounts a handler-free read-only surface at the 768px contract", () => {
    const html = render();
    const mobile = mobileMarkup(html);
    const css = readFileSync(
      "app/(dashboard)/platforms/meta/automation/automation.module.css",
      "utf8",
    );

    expect(mobile).toContain('data-read-only="true"');
    expect(mobile).toContain("Read-only");
    expect(mobile).not.toContain("<button");
    expect(mobile).not.toContain("onClick");
    expect(css).toContain("@media (max-width: 1023px)");
    expect(css).toMatch(
      /@media \(max-width: 1023px\)[\s\S]*?\.desktopSurface \{[\s\S]*?display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 1023px\)[\s\S]*?\.mobileSurface \{[\s\S]*?display: grid/,
    );
    expect(css).toContain("@media (min-width: 1024px)");
  });
});
