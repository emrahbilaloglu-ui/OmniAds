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
    expect(source).not.toContain('method: "POST"');
    expect(source).not.toContain("window.confirm");
    expect(source).not.toContain("engage_kill_switch");
    expect(source).not.toContain("release_kill_switch");
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
