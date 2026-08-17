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
