import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { MetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";
import type { AutomationProposalsModel } from "./automation-proposals-exact-adapter";
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
      minRoasFloor: null,
      quietHours: null,
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
      actor: null,
      entity: null,
      result: null,
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
      cleanApprovalThreshold: null,
      cleanApprovalStreak: null,
    },
    {
      decisionType: "bid",
      mode: "manual",
      lockReason: null,
      updatedAt: null,
      updatedBy: null,
      source: "default",
      cleanApprovalThreshold: null,
      cleanApprovalStreak: null,
    },
    {
      decisionType: "budget",
      mode: "semi_auto",
      lockReason: "Backtest contract required before auto-execute.",
      updatedAt: "2026-08-15T09:00:00.000Z",
      updatedBy: "user_1",
      source: "persisted",
      cleanApprovalThreshold: null,
      cleanApprovalStreak: null,
    },
    {
      decisionType: "creative",
      mode: "auto",
      lockReason: null,
      updatedAt: "2026-08-15T08:00:00.000Z",
      updatedBy: "user_2",
      source: "persisted",
      cleanApprovalThreshold: null,
      cleanApprovalStreak: null,
    },
  ],
};

function render(input: MetaAutomationControlPlane | null = payload) {
  return renderToStaticMarkup(
    <MetaAutomationView payload={input} providerAccountId="act_1" />,
  );
}

function renderWithQueue(proposals: AutomationProposalsModel) {
  return renderToStaticMarkup(
    <MetaAutomationView
      payload={payload}
      providerAccountId="act_1"
      proposals={proposals}
    />,
  );
}

const queuedRow = {
  id: "11111111-1111-4111-8111-111111111111",
  action: "Pause ad set",
  tone: "negative" as const,
  entity: "Retargeting 7d — DPA",
  why: "ROAS 1.94 below breakeven 2.50 for 6 consecutive days.",
  evidence: "frees $680/d",
  expires: "in 3h",
  primaryCaption: "Approve & apply",
};

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
        action: { kind: "propose_pause" },
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
        action: { kind: "propose_pause" },
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
        action: { kind: "hard_block_writes" },
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

  it("renders a real proposal in the canonical row shape with all three controls", () => {
    const html = renderWithQueue({
      readCompleteness: "complete",
      count: "1",
      rows: [queuedRow],
    });

    expect(html).toContain(
      'data-proposal-id="11111111-1111-4111-8111-111111111111"',
    );
    expect(html).toContain(">Pause ad set</span>");
    expect(html).toContain(">Retargeting 7d — DPA</p>");
    expect(html).toContain("ROAS 1.94 below breakeven 2.50");
    expect(html).toContain(">frees $680/d</span>");
    expect(html).toContain("expires in 3h");
    expect(html).toContain("Approve &amp; apply</button>");
    expect(html).toContain(">Modify</button>");
    expect(html).toContain(">Dismiss</button>");
    expect(html).toContain('data-field="confirmation-count">1<');
    expect(html).not.toContain('data-testid="confirmation-empty"');
  });

  it("leaves every control inert when no handler is bound", () => {
    // A server render has no action handler. The controls must be visibly
    // unavailable rather than look armed and do nothing on click.
    const html = renderWithQueue({
      readCompleteness: "complete",
      count: "1",
      rows: [queuedRow],
    });

    expect(html.match(/data-control="[a-z-]+"[^>]*disabled=""/g)).toHaveLength(
      3,
    );
  });

  it("distinguishes a proven empty queue from an unproven read", () => {
    const proven = renderWithQueue({
      readCompleteness: "complete",
      count: "0",
      rows: [],
    });
    const unproven = renderWithQueue({
      readCompleteness: "unavailable",
      count: "—",
      rows: [],
    });

    expect(proven).toContain('data-field="confirmation-count">0<');
    expect(proven).toContain('data-testid="confirmation-empty"');
    expect(unproven).toContain('data-field="confirmation-count">—<');
    expect(unproven).toContain('data-testid="confirmation-empty"');
  });

  it("keeps the queue off the read-only mobile surface", () => {
    const mobile = mobileMarkup(
      renderWithQueue({
        readCompleteness: "complete",
        count: "1",
        rows: [queuedRow],
      }),
    );

    expect(mobile).not.toContain("Approve");
    expect(mobile).not.toContain("<button");
    expect(mobile).toContain('data-read-only="true"');
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
    expect(html).toMatch(/data-field="ledger-actor">—<\/td>/);
    expect(html).toMatch(/data-field="ledger-entity">—<\/td>/);
    expect(html).toMatch(
      /data-field="ledger-result"[^>]*data-tone="unknown">—<\/span>/,
    );
  });

  it("renders the persisted actor, entity and result tuple when the record carries one", () => {
    const html = render({
      ...payload,
      activityLedger: [
        {
          id: "activity_tuple",
          activityType: "decision_type_mode_change",
          severity: "info",
          message: "budget standing mode set to semi_auto (from manual).",
          payload: null,
          createdAt: "2026-08-15T14:31:00.000Z",
          source: "automation_ledger",
          actor: { kind: "operator", userId: "user_1", name: "Emrah B." },
          entity: {
            type: "automation_decision_type",
            id: "budget",
            name: null,
          },
          result: { status: "recorded", receiptId: "promo_1" },
        },
        {
          id: "activity_applied",
          activityType: "meta_pause",
          severity: "success",
          message: "Meta pause completed.",
          payload: null,
          createdAt: "2026-08-15T09:12:00.000Z",
          source: "meta_action_log",
          actor: { kind: "operator", userId: "user_1", name: "Emrah B." },
          entity: {
            type: "adset",
            id: "23851",
            name: "Retargeting 7d — DPA",
          },
          result: { status: "applied", receiptId: null },
        },
      ],
    });

    expect(html).toMatch(/data-field="ledger-actor">Emrah B\.<\/td>/);
    expect(html).toMatch(/data-field="ledger-entity">Budget<\/td>/);
    expect(html).toMatch(
      /data-field="ledger-result"[^>]*data-tone="recorded">Receipt promo_1<\/span>/,
    );
    expect(html).toMatch(
      /data-field="ledger-entity">Retargeting 7d — DPA<\/td>/,
    );
    expect(html).toMatch(
      /data-field="ledger-result"[^>]*data-tone="applied">Applied<\/span>/,
    );
  });

  it("tones a blocked provider write as a refusal rather than a success", () => {
    const html = render({
      ...payload,
      activityLedger: [
        {
          id: "activity_blocked",
          activityType: "meta_pause",
          severity: "warning",
          message: "Meta write blocked by kill switch.",
          payload: null,
          createdAt: "2026-08-15T18:05:00.000Z",
          source: "meta_action_log",
          actor: null,
          entity: { type: "ad", id: "9912", name: "Lookalike 3% — UGC" },
          result: { status: "blocked", receiptId: null },
        },
      ],
    });

    expect(html).toMatch(
      /data-field="ledger-result"[^>]*data-tone="blocked">Blocked<\/span>/,
    );
    // No attributable operator on the row: the actor stays blank instead of
    // borrowing the prototype's "System guard" label.
    expect(html).toMatch(/data-field="ledger-actor">—<\/td>/);
  });

  it("renders the persisted ROAS floor and quiet-hours window verbatim", () => {
    const html = render({
      ...payload,
      businessControl: {
        ...payload.businessControl,
        guardrails: {
          ...payload.businessControl.guardrails,
          minRoasFloor: 2.5,
          quietHours: { start: "00:00", end: "07:00", timezone: "ET" },
        },
      },
    });

    expect(html).toMatch(/guardrail-roas-floor[\s\S]*?<strong>2\.50<\/strong>/);
    expect(html).toMatch(
      /guardrail-quiet-hours[\s\S]*?<strong>00:00–07:00 ET<\/strong>/,
    );
  });

  it("presents ladder progress only when the streak read and the threshold are both proven", () => {
    const persistedPause = {
      decisionType: "pause" as const,
      mode: "manual" as const,
      lockReason: null,
      updatedAt: "2026-08-01T00:00:00.000Z",
      updatedBy: "user_1",
      source: "persisted" as const,
      cleanApprovalThreshold: 30,
      cleanApprovalStreak: 18,
    };
    const proven = render({
      ...payload,
      readCompleteness: {
        promotionRecords: "complete",
        cleanApprovalStreaks: "complete",
      },
      decisionTypeModes: [
        persistedPause,
        ...payload.decisionTypeModes.filter(
          (item) => item.decisionType !== "pause",
        ),
      ],
    });
    const unproven = render({
      ...payload,
      readCompleteness: {
        promotionRecords: "complete",
        cleanApprovalStreaks: "unavailable",
      },
      decisionTypeModes: [
        persistedPause,
        ...payload.decisionTypeModes.filter(
          (item) => item.decisionType !== "pause",
        ),
      ],
    });
    const noThreshold = render({
      ...payload,
      readCompleteness: {
        promotionRecords: "complete",
        cleanApprovalStreaks: "complete",
      },
      decisionTypeModes: [
        { ...persistedPause, cleanApprovalThreshold: null },
        ...payload.decisionTypeModes.filter(
          (item) => item.decisionType !== "pause",
        ),
      ],
    });

    expect(proven).toMatch(
      /data-decision-type="pause"[\s\S]*?data-tone="measured" style="width:60%"/,
    );
    expect(proven).toMatch(/data-decision-type="pause"[\s\S]*?>18 \/ 30</);
    expect(unproven).not.toContain("18 / 30");
    expect(unproven).toMatch(
      /data-decision-type="pause"[\s\S]*?data-tone="locked" style="width:0%"/,
    );
    expect(noThreshold).not.toContain("18 / 30");
    // A kind with no provider-write channel keeps the em dash even beside a
    // proven read.
    expect(proven).toMatch(
      /data-decision-type="budget"[\s\S]*?_progressValue_[^"]*">—<\/span>/,
    );
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
    expect(source).not.toContain("window.confirm");
    expect(source).not.toContain("engage_kill_switch");
    expect(source).not.toContain("release_kill_switch");
    // The confirmation queue is the ONE mutation this screen may issue, and it
    // goes to its own boundary. Asserted as an exact allowlist rather than a
    // blanket ban on POST, so the kill-switch guarantee stays enforced while
    // the queue the design requires can exist.
    expect(source.match(/method: "POST"/g)).toHaveLength(1);
    expect(source).toMatch(
      /fetch\(`\/api\/meta\/automation\/proposals\?\$\{query\.toString\(\)\}`, \{\s*method: "POST"/,
    );
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
