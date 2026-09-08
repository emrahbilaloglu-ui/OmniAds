import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { MetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";
import type { AutomationProposalsModel } from "./automation-proposals-exact-adapter";
import { MetaAutomationView } from "./automation-view";
import { buildAutomationViewerEnvelope } from "./viewer-envelope";
import { META_GATE_REFUSAL_REASONS } from "@/lib/meta/release-gate-copy";

/**
 * Every read this payload carries was actually performed.
 *
 * Kept as a named constant because the provenance is now load-bearing for more
 * than one card: a test that wants to pin ONE unproven read (rules, streaks,
 * promotions) must not silently un-prove the control read too, which would
 * em-dash the kill switch and guardrails and change what the test is measuring.
 */
const PROVEN_READS = {
  promotionRecords: "complete",
  businessControl: "complete",
  activityLedger: "complete",
} as const;

const OBSERVED_AT = "2026-08-18T09:00:00.000Z";

/** Every section read, and every one of them proven. */
const SECTIONS = {
  businessControl: {
    status: "complete",
    errorCode: null,
    observedAt: OBSERVED_AT,
  },
  rules: { status: "complete", errorCode: null, observedAt: OBSERVED_AT },
  activity: { status: "complete", errorCode: null, observedAt: OBSERVED_AT },
  promotionRecords: {
    status: "complete",
    errorCode: null,
    observedAt: OBSERVED_AT,
  },
  decisionModes: {
    status: "complete",
    errorCode: null,
    observedAt: OBSERVED_AT,
  },
  anchors: { status: "complete", errorCode: null, observedAt: OBSERVED_AT },
  readiness: { status: "complete", errorCode: null, observedAt: OBSERVED_AT },
} as const;

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
      perActionSpendCeilingValid: true,
      notificationPolicy: "every_auto_action",
      maxBudgetIncreasePct: 15,
      maxDailyBudgetChangeMinor: null,
      requireResolvedCampaignRole: true,
      requireCommercialAnchor: true,
      requireLivePreflight: true,
      requireRollbackPlan: true,
      budgetMinHoursBetweenChanges: null,
      budgetMaxChangesPer7d: null,
      budgetMaxAccountConcentrationPct: null,
      // Unstamped: no sizing policy version is bound to this fixture, which
      // is the state every business is in until an operator saves one.
      budgetSizingPolicyVersion: null,
      bidSizingPolicyVersion: null,
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
  readCompleteness: PROVEN_READS,
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

/**
 * A queue model with the hold counts read and nothing held — the canonical
 * state. Spelled out rather than defaulted so that every test which wants a
 * DIFFERENT hold state has to say so, and so no test can accidentally assert
 * the design's geometry off a model that never carried the fact.
 */
const NO_HOLDS = { claimed: 0, reconcile: 0 } as const;

function queueModel(
  input: Partial<AutomationProposalsModel> & {
    readCompleteness: AutomationProposalsModel["readCompleteness"];
    count: string;
    rows: AutomationProposalsModel["rows"];
  },
): AutomationProposalsModel {
  const holds = input.holds === undefined ? { ...NO_HOLDS } : input.holds;
  return {
    ...input,
    holds,
    provenEmpty:
      input.provenEmpty ??
      (input.readCompleteness === "complete" &&
        input.rows.length === 0 &&
        holds !== null &&
        holds.claimed === 0 &&
        holds.reconcile === 0),
  };
}

function renderWithQueue(
  proposals: AutomationProposalsModel,
  extra?: {
    viewer?: React.ComponentProps<typeof MetaAutomationView>["viewer"];
  },
) {
  return renderToStaticMarkup(
    <MetaAutomationView
      payload={{ ...payload, sections: SECTIONS }}
      providerAccountId="act_1"
      proposals={proposals}
      viewer={extra?.viewer}
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
    readCompleteness: { ...PROVEN_READS, rules: "complete" },
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

/**
 * The queue's own empty cell.
 *
 * Scoped on purpose: `data-proven-empty` is emitted by the rules table and the
 * activity ledger too, so a bare `toContain('data-proven-empty="false"')`
 * passes off an unrelated section and proves nothing about the queue. That is
 * exactly how the first draft of these tests survived a mutation that broke
 * the law they claim to pin.
 */
function confirmationEmptyEl(html: string) {
  return (
    html.match(/<div[^>]*data-testid="confirmation-empty"[^>]*>/)?.[0] ?? ""
  );
}

/** The existing confirmation card, so a test can prove a statement is INSIDE it. */
function confirmationCard(html: string) {
  const start = html.indexOf("Pending approvals");
  const end = html.indexOf("<h2>Recent activity</h2>", start);
  return start < 0 ? "" : html.slice(start, end < 0 ? undefined : end);
}

function mobileMarkup(html: string) {
  return (
    html.match(
      /<section[^>]*data-testid="meta-mobile-automation"[\s\S]*?<\/section>/,
    )?.[0] ?? ""
  );
}

describe("Dashboard v2 exact Automation presentation", () => {
  it("keeps the simplified operator hierarchy and hides backend diagnostics", () => {
    const html = render();

    expect(html).toContain('data-screen-label="Automation"');
    expect(html).toContain(">Automation</h1>");
    expect(html).toContain("Choose which Meta actions need approval");
    expect(html).toContain('data-testid="automation-operating-state"');
    expect(html).toContain(">Action modes</h2>");
    expect(html).toContain(">Pending approvals</h2>");
    expect(html).toContain(">Recent activity</h2>");
    expect(html).not.toContain("Choose how each kind of change is handled");
    expect(html).not.toContain("Review before applying");
    expect(html).toMatch(
      /<details[^>]*><summary><span>Controls and limits<\/span>/,
    );
    expect(html).toMatch(/<details[^>]*><summary><span>Custom rules<\/span>/);

    for (const removed of [
      "System diagnostics",
      "State-history recovery readiness",
      "Decision-input retention readiness",
      "Autonomy ladder",
      "Activity ledger",
      "Advanced automation settings",
      "Google Ads",
      "Control-plane reading",
      "Receipt ",
    ]) {
      expect(html, removed).not.toContain(removed);
    }
  });
  it("shows setup needed when the saved switch is on but execution is blocked", () => {
    const html = render({
      ...payload,
      businessControl: {
        ...payload.businessControl,
        killSwitchEngaged: false,
        autoExecutionEnabled: true,
      },
      execution: {
        autoExecutionAllowed: false,
        writeEndpointsBlocked: true,
        blockedReasons: ["business_kill_switch"],
      },
    });

    expect(html).toContain('data-business-master-switch="on"');
    expect(html).toContain("<h2>Needs setup</h2>");
    expect(html).toContain(
      "Automatic actions are selected, but setup still needs attention.",
    );
    expect(html).not.toContain("effective automatic execution");
  });
  it("keeps useful limits inside the collapsed controls section", () => {
    const html = render();

    expect(html).toContain("Controls and limits");
    expect(html).toContain("Maximum budget increase");
    expect(html).toContain("+15% max");
    expect(html).toContain("Pause below ROAS");
    expect(html).toContain("Maximum actions per day");
    expect(html).toMatch(/guardrail-roas-floor[\s\S]*?<strong>—<\/strong>/);
    expect(html).toMatch(/guardrail-quiet-hours[\s\S]*?<strong>—<\/strong>/);
    expect(html).not.toContain("Readiness");
    expect(html).not.toContain("promotion record");
  });
  it("shows a stopped state without exposing default-control internals", () => {
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

    expect(html).toContain("<h2>Stopped</h2>");
    expect(html).toContain(
      "All automatic Meta actions are paused for this business.",
    );
    expect(html).toContain("Preview only");
    expect(html).not.toContain("defaults, not set here");
    expect(html).not.toContain("META_ADS_WRITE_KILL_SWITCH");
  });
  it("does not expose internal promotion readiness counts", () => {
    const complete = render({
      ...payload,
      promotionRecords: [],
      readCompleteness: { ...PROVEN_READS, promotionRecords: "complete" },
    });
    const unavailable = render({
      ...payload,
      promotionRecords: [],
      readCompleteness: { ...PROVEN_READS, promotionRecords: "unavailable" },
    });

    expect(complete).not.toContain('data-field="promotion-count"');
    expect(unavailable).not.toContain('data-field="promotion-count"');
  });
  it("preserves canonical empty geometry without inventing proposals, rules or actions", () => {
    const html = render({ ...payload, sections: SECTIONS });

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

    /*
     * The default fixture's queue read is UNAVAILABLE, so the controls are:
     * "+ New rule", the queue's Retry, the Meta Stop — and AUTO-03's autonomy
     * mode, three segments on each of the four action kinds the control plane
     * has a decision type for. Twelve plus three.
     *
     * Counted rather than listed, and the count moved deliberately: the ladder
     * used to be four read-only captions, so a mode recorded by the control
     * plane could only be read back through the API. The launch row is
     * excluded on purpose — new spend has no decision type and never
     * automates, so a control there would offer a choice that does not exist.
     *
     * Sixteen now: the guardrails card gained a Save. The ROAS floor and the
     * quiet window were persisted, server-enforced and unsettable from any
     * screen, so in practice they belonged to whoever last edited the row.
     *
     * Seventeen now, and the two additions are both on the MOBILE pane:
     *   +1  the Meta stop, which was visible there and inoperable;
     *   +1  the unreadable queue's Retry, which was absent there entirely.
     * Line by line: "+ New rule" (1), desktop Stop (1), desktop queue Retry
     * (1), twelve AUTO-03 segments (12), mobile Stop (1), mobile queue Retry
     * (1) = 17. The guardrails Save is absent because this canonical helper
     * has no authorized business scope; only an authorized admin sees it.
     */
    expect(html.match(/<button/g)).toHaveLength(17);
    expect(html.match(/data-ctl="gated:AUTO-03 mode"/g)).toHaveLength(4);
    expect(html).toContain('data-field="business-writes-control"');
    expect(html).toContain('data-control="retry-queue"');

    // A queue that was actually read and is actually empty gets no retry —
    // there is nothing to recover from — so the canonical geometry loses one
    // control and keeps "+ New rule" beside the Stop.
    const proven = renderWithQueue(
      queueModel({
        readCompleteness: "complete",
        count: "0",
        rows: [],
      }),
    );
    // Three, plus the twelve AUTO-03 segments, which do not depend on the
    // queue: "+ New rule", the desktop Stop, and the mobile Stop. The
    // unbound helper has no admin-only guardrails Save, and neither pane draws
    // a Retry because a proven-empty queue has nothing to recover.
    expect(proven.match(/<button/g)).toHaveLength(15);
    expect(proven).not.toContain('data-control="retry-queue"');
  });

  // ITEM 11. A queue error must offer a REAL retry: one bound to the handler
  // that re-runs the read, not a decorative control.
  it("binds the queue retry to the same read the notice retries", () => {
    const live = renderToStaticMarkup(
      <MetaAutomationView
        payload={payload}
        providerAccountId="act_1"
        proposals={queueModel({
          readCompleteness: "unavailable",
          count: "—",
          rows: [],
        })}
        onRetryRead={() => {}}
      />,
    );
    const inert = renderWithQueue(
      queueModel({
        readCompleteness: "unavailable",
        count: "—",
        rows: [],
      }),
    );

    expect(live).toMatch(
      /<button[^>]*data-control="retry-queue"(?![^>]*disabled)/,
    );
    // A server render has no handler, so the control is visibly unavailable
    // rather than armed and inert.
    expect(inert).toMatch(
      /<button[^>]*data-control="retry-queue"[^>]*disabled=""/,
    );
  });

  // ITEM 9. The footnote makes a claim about EVIDENCE — "every outcome lands in
  // the ledger with a receipt" — so it may only be made where the evidence
  // exists. The ledger write used to end in `.catch(() => undefined)`, which
  // meant a failed INSERT left this promise on screen under a decision that
  // was never recorded there.
  it("records healthy ledger evidence without showing receipt plumbing", () => {
    const html = render();

    expect(html).toContain('data-ledger-evidence="complete"');
    expect(html).not.toContain('data-field="queue-footnote"');
    expect(html).not.toContain("lands in the ledger with a receipt");
  });
  it("records unavailable ledger evidence without exposing backend recovery copy", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        payload={payload}
        providerAccountId="act_1"
        ledgerCompleteness="unavailable"
      />,
    );

    expect(html).toContain('data-ledger-evidence="unavailable"');
    expect(html).not.toContain('data-field="queue-footnote"');
    expect(html).not.toContain("receipt");
  });
  it("marks absent ledger evidence without making a visible promise", () => {
    const unreadLedger = renderToStaticMarkup(
      <MetaAutomationView
        payload={{
          ...payload,
          readCompleteness: { ...PROVEN_READS, activityLedger: "unavailable" },
        }}
        providerAccountId="act_1"
        ledgerCompleteness={null}
      />,
    );

    expect(unreadLedger).toContain('data-ledger-evidence="no_evidence"');
    expect(unreadLedger).not.toContain('data-field="queue-footnote"');
    expect(unreadLedger).not.toContain("every outcome");
  });
  it("rebuilds ledger evidence from the served read model after reload", () => {
    const afterReload = renderToStaticMarkup(
      <MetaAutomationView
        payload={payload}
        providerAccountId="act_1"
        ledgerCompleteness={null}
      />,
    );

    expect(afterReload).toContain('data-ledger-evidence="complete"');
    expect(afterReload).not.toContain('data-field="queue-footnote"');
  });
  it("lets a proven ledger failure outrank a healthy server read", () => {
    // The control plane could READ the ledger, and the decision still failed to
    // reach it. First-hand beats general.
    const html = renderToStaticMarkup(
      <MetaAutomationView
        payload={payload}
        providerAccountId="act_1"
        ledgerCompleteness="unavailable"
      />,
    );

    expect(html).toContain('data-ledger-evidence="unavailable"');
    expect(html).not.toContain("every outcome");
  });

  /**
   * ITEM 7. Every control on this screen was gated on `businessId &&
   * providerAccountId` alone, so a guest, a reviewer and a demo session all got
   * live Approve / Modify / Dismiss / + New rule / rule toggle the moment an
   * account resolved. A resolved account is not write authority.
   */
  it("disables every write control for a viewer the server refuses, account or not", () => {
    const refusals = [
      {
        viewer: buildAutomationViewerEnvelope({
          role: "admin",
          reviewerReadOnly: true,
          writeAuthority: "live",
        }),
        operatorMessage: "This workspace is read-only.",
      },
      {
        viewer: buildAutomationViewerEnvelope({
          role: "admin",
          reviewerReadOnly: false,
          writeAuthority: "demo",
        }),
        operatorMessage:
          "Automation changes are unavailable in demo workspaces.",
      },
      {
        viewer: buildAutomationViewerEnvelope({
          role: "guest",
          reviewerReadOnly: false,
          writeAuthority: "live",
        }),
        operatorMessage:
          "Collaborator access is required to change automation.",
      },
      {
        viewer: buildAutomationViewerEnvelope({
          role: "admin",
          reviewerReadOnly: false,
          // An unreadable demo flag refuses. It never reads as "live".
          writeAuthority: "unverified",
        }),
        operatorMessage: "Automation changes are unavailable right now.",
      },
    ];

    for (const { viewer, operatorMessage } of refusals) {
      const html = renderToStaticMarkup(
        <MetaAutomationView
          payload={withRules()}
          providerAccountId="act_1"
          businessId="biz_1"
          proposals={queueModel({
            readCompleteness: "complete",
            count: "1",
            rows: [queuedRow],
          })}
          onProposalControl={() => undefined}
          onRulesChanged={() => undefined}
          viewer={viewer}
        />,
      );

      for (const control of ["approve", "modify", "dismiss"]) {
        expect(
          new RegExp(
            `<button[^>]*data-control="${control}"[^>]*disabled=""`,
          ).test(html),
        ).toBe(true);
      }
      // "+ New rule" and every rule toggle are the same authority question.
      expect(html).toMatch(/aria-disabled="true"[^>]*>\+ New rule</);
      // `withRules()` carries three rules. Two are unlocked and were live
      // before this change; the third is the enforced guard and was already
      // locked. All three must be inert for a refused viewer.
      const toggles =
        html.match(/<button[^>]*aria-pressed="[a-z]+"[^>]*>/g) ?? [];
      expect(toggles).toHaveLength(3);
      for (const toggle of toggles) expect(toggle).toContain('disabled=""');
      // The server code is retained without exposing its internal sentence.
      expect(html).toContain('data-field="viewer-refusal"');
      expect(html).toContain(operatorMessage);
      expect(html).not.toContain(viewer.reason!);
      expect(html).toContain(`data-reason-code="${viewer.reasonCode}"`);
    }
  });

  it("adds no refusal chrome on the canonical render", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        payload={withRules()}
        providerAccountId="act_1"
        businessId="biz_1"
        proposals={queueModel({
          readCompleteness: "complete",
          count: "1",
          rows: [queuedRow],
        })}
        onProposalControl={() => undefined}
        viewer={buildAutomationViewerEnvelope({
          role: "collaborator",
          reviewerReadOnly: false,
          writeAuthority: "live",
        })}
      />,
    );

    expect(html).not.toContain('data-field="viewer-refusal"');
    expect(html).toMatch(/<button[^>]*data-control="approve"(?![^>]*disabled)/);
  });

  it("does not let a failed rules read erase proven automation state", () => {
    const rulesBroken = render({
      ...payload,
      rules: [],
      sections: {
        ...SECTIONS,
        rules: {
          status: "unavailable",
          errorCode: "read_failed",
          observedAt: OBSERVED_AT,
        },
      },
    });

    expect(rulesBroken).toContain('data-testid="rules-empty"');
    expect(rulesBroken).toContain('data-proven-empty="false"');
    expect(rulesBroken).toContain('data-testid="automation-operating-state"');
    expect(rulesBroken).toContain(">Action modes</h2>");
    expect(rulesBroken).toContain("+15% max");
    expect(rulesBroken).not.toContain("System diagnostics");
  });
  it("uses the richer section envelope and shows a simple unavailable state", () => {
    const html = render({
      ...payload,
      readCompleteness: PROVEN_READS,
      sections: {
        ...SECTIONS,
        businessControl: {
          status: "migration_required",
          errorCode: "undefined_column",
          observedAt: OBSERVED_AT,
        },
      },
    });

    expect(html).toContain("<h2>Unavailable</h2>");
    expect(html).toContain('data-field="read-error"');
    expect(html).toContain(
      'data-reason="automation_control_state_unavailable"',
    );
    expect(html).not.toContain("undefined_column");
  });
  it("draws no read-failure notice while the read is healthy", () => {
    const html = render();

    expect(html).not.toContain('data-field="read-error"');
    expect(html).not.toContain('data-control="retry-read"');
  });

  it("gives a failed read a live retry control with simple copy", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        payload={null}
        providerAccountId="act_1"
        readError="automation_control_plane_unavailable"
        onRetryRead={() => {}}
      />,
    );
    const notice =
      html.match(/<p[^>]*data-field="read-error"[\s\S]*?<\/p>/)?.[0] ?? "";

    expect(notice).toContain('data-control="retry-read"');
    expect(notice).toContain(">Retry</button>");
    expect(notice).not.toContain('disabled=""');
    expect(notice).toContain(
      "Automation is unavailable right now. Refresh to try again.",
    );
    expect(notice).not.toContain("control plane");
  });
  it("keeps the retry inert on a render that has no reader to re-run", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        payload={null}
        providerAccountId="act_1"
        readError="automation_control_plane_unavailable"
      />,
    );
    const notice =
      html.match(/<p[^>]*data-field="read-error"[\s\S]*?<\/p>/)?.[0] ?? "";

    expect(notice).toContain('data-control="retry-read"');
    expect(notice).toContain('disabled=""');
  });

  /**
   * The law: a failed control read may not be dressed as a served one.
   *
   * `businessControl` is ALWAYS populated — a failed read degrades to
   * `defaultBusinessControl`, which is a concrete, benign-looking state. The
   * screen used to print that state as fact: a green ENABLED pill, "Tier 1 —
   * Supervised", "+15% max" and "3", none of which came from the database —
   * while `getMetaWriteBlockState` refused every write in the same window with
   * `control_state_unavailable`. Provenance, not truthiness, decides.
   */
  /**
   * D078: a SUCCESSFUL read of a MISSING control row is not the same case as
   * a failed read — the section is complete, the values are defaults, and the
   * write boundary refuses every Meta write with
   * `business_control_not_configured`. The screen printed a green ENABLED
   * pill for that business while every write was refused; the pill must state
   * the effective fail-closed posture instead.
   */
  it("renders a missing control row as off without claiming execution", () => {
    const html = render({
      ...payload,
      businessControl: {
        ...payload.businessControl,
        killSwitchEngaged: false,
        source: "default",
      },
      readCompleteness: { ...PROVEN_READS, businessControl: "complete" },
    });

    expect(html).toContain('data-business-master-switch="off"');
    expect(html).toContain("<h2>Off</h2>");
    expect(html).not.toContain("Automatic execution is ON");
    expect(html).not.toContain("Global writes");
  });
  it("withholds control facts when the control read failed and names recovery", () => {
    const html = render({
      ...payload,
      businessControl: {
        ...payload.businessControl,
        killSwitchEngaged: false,
        killSwitchReason: null,
        readinessTier: "manual_review",
        updatedAt: null,
        updatedBy: null,
        source: "default",
      },
      readCompleteness: { ...PROVEN_READS, businessControl: "unavailable" },
    });

    expect(html).toContain("<h2>Unavailable</h2>");
    expect(html).not.toContain("Supervised");
    expect(html).not.toContain("+15% max");
    expect(html).toContain('data-action-modes-state="unavailable"');
    expect(html).toContain('data-field="action-modes-unavailable"');
    expect(html).not.toContain('data-mode="manual"');
    expect(html).toContain('data-field="read-error"');
    expect(html).toContain(
      'data-reason="automation_control_state_unavailable"',
    );
    expect(html).toContain(
      "Automation status is unavailable right now. Refresh to try again.",
    );
    const emergencyStatus =
      html.match(
        /<span[^>]*data-field="business-writes"[^>]*>[\s\S]*?<\/span>/,
      )?.[0] ?? "";
    expect(emergencyStatus).toContain(">Unavailable</span>");
    expect(emergencyStatus).not.toContain(">OFF</span>");
    expect(html).not.toContain("control state could not be read");
  });
  it("treats a payload without control-read provenance as unavailable", () => {
    const html = render({ ...payload, readCompleteness: undefined });

    expect(html).toContain("<h2>Unavailable</h2>");
    expect(html).toContain('data-field="read-error"');
    expect(html).not.toContain("defaults, not set here");
  });
  it("separates proven-empty recent activity from an unavailable read", () => {
    const provenEmpty = render({
      ...payload,
      activityLedger: [],
      readCompleteness: { ...PROVEN_READS, activityLedger: "complete" },
    });
    const unproven = render({
      ...payload,
      activityLedger: [],
      readCompleteness: { ...PROVEN_READS, activityLedger: "unavailable" },
    });
    const legacyWithoutProvenance = render({
      ...payload,
      activityLedger: [],
      readCompleteness: {
        promotionRecords: "complete",
        businessControl: "complete",
      },
    });
    const emptyRow = (html: string) =>
      html.match(/<tr[^>]*data-testid="ledger-empty"[\s\S]*?<\/tr>/)?.[0] ?? "";

    expect(emptyRow(provenEmpty)).toContain('data-proven-empty="true"');
    expect(emptyRow(provenEmpty)).toContain("No recent activity");
    expect(provenEmpty).toContain('data-ledger-state="empty"');
    expect(emptyRow(unproven)).toContain('data-proven-empty="false"');
    expect(emptyRow(unproven)).toContain("Activity is unavailable");
    expect(unproven).toContain('data-ledger-state="unavailable"');
    expect(emptyRow(legacyWithoutProvenance)).toContain(
      'data-proven-empty="false"',
    );
    expect(render()).toContain('data-ledger-state="ready"');
  });
  it("names an unresolved account scope without backend terminology", () => {
    const unresolved = renderToStaticMarkup(
      <MetaAutomationView
        payload={null}
        providerAccountId={null}
        readError="provider_account_scope_unresolved"
        onRetryRead={() => {}}
      />,
    );
    const noneAssigned = renderToStaticMarkup(
      <MetaAutomationView
        payload={null}
        providerAccountId={null}
        readError="provider_account_none_assigned"
      />,
    );
    const unavailable = renderToStaticMarkup(
      <MetaAutomationView
        payload={null}
        providerAccountId={null}
        readError="provider_account_scope_unavailable"
      />,
    );

    expect(unresolved).toContain(
      'data-reason="provider_account_scope_unresolved"',
    );
    expect(unresolved).toContain(
      "Choose a Meta ad account in the top bar to see its automation status.",
    );
    expect(unresolved).toContain('data-control="retry-read"');
    expect(unresolved).not.toContain('data-control="account-picker"');
    expect(noneAssigned).toContain(
      "No Meta ad account is assigned to this business",
    );
    expect(unavailable).toContain("Meta ad accounts are unavailable right now");
    expect(unavailable).not.toContain("No Meta ad account is assigned");
  });

  it("collapses a narrow unread state into one recovery and the launch invariant", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        payload={null}
        providerAccountId={null}
        readError="provider_account_scope_unresolved"
        onRetryRead={() => {}}
      />,
    );
    const mobile = mobileMarkup(html);

    expect(mobile).toContain('data-testid="automation-mobile-read-recovery"');
    expect(mobile.match(/data-field="read-error"/g)).toHaveLength(1);
    expect(mobile).toContain('data-reason="provider_account_scope_unresolved"');
    expect(mobile).toContain(
      "Choose a Meta ad account in the top bar to see its automation status.",
    );
    expect(mobile).toContain('data-control="retry-read"');
    expect(mobile).not.toContain('data-control="account-picker"');
    expect(mobile).not.toContain('data-field="action-modes-unavailable"');
    expect(mobile).not.toContain('data-testid="mobile-stop-control"');
    expect(mobile).not.toContain("Pending approvals");
    expect(mobile).not.toContain("Recent activity");
    expect(mobile).toContain('data-decision-type="launch"');
    expect(mobile).toContain("Launches · new spend");
    expect(mobile).toContain("Always manual");
  });

  it("keeps a local modes failure visible when the account and control read are healthy", () => {
    const html = render({
      ...payload,
      sections: {
        ...SECTIONS,
        decisionModes: {
          status: "unavailable",
          errorCode: "read_failed",
          observedAt: OBSERVED_AT,
        },
      },
    });
    const mobile = mobileMarkup(html);

    expect(mobile).not.toContain(
      'data-testid="automation-mobile-read-recovery"',
    );
    expect(mobile).toContain('data-field="action-modes-unavailable"');
    expect(mobile).toContain('data-testid="mobile-stop-control"');
    expect(mobile).toContain("Pending approvals");
    expect(mobile).toContain("Recent activity");
  });
  it("renders a real proposal in the canonical row shape with all three controls", () => {
    const html = renderWithQueue(
      queueModel({
        readCompleteness: "complete",
        count: "1",
        rows: [queuedRow],
      }),
    );

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
    const html = renderWithQueue(
      queueModel({
        readCompleteness: "complete",
        count: "1",
        rows: [queuedRow],
      }),
    );

    // Approve, Modify and Dismiss — on BOTH surfaces, because the queue is one
    // component rendered twice. Six is three per pane, and the law it states is
    // unchanged: no pane draws an armed control without a handler behind it.
    expect(html.match(/data-control="[a-z-]+"[^>]*disabled=""/g)).toHaveLength(
      6,
    );
  });

  // ITEM 2. The server counts the rows this account holds open without being
  // approvable and sends them beside the queue; the view model used to drop
  // them. A `claimed` row is a dispatch in flight and a `reconcile` row is an
  // outcome nobody has confirmed — telling the operator "0" over either one is
  // the single worst answer this card can give.
  it("states an in-progress action inside pending approvals without backend wording", () => {
    const html = renderWithQueue(
      queueModel({
        readCompleteness: "complete",
        count: "—",
        rows: [],
        holds: { claimed: 1, reconcile: 0 },
      }),
    );

    expect(html).toContain("1 action in progress");
    expect(html).toContain('data-field="queue-holds"');
    expect(html).toContain('data-claimed="1"');
    expect(confirmationEmptyEl(html)).toContain('data-proven-empty="false"');
    expect(html).not.toContain("dispatch in progress");
    expect(confirmationCard(html)).toContain("1 action in progress");
  });
  it("states actions needing review without reconciliation jargon", () => {
    const html = renderWithQueue(
      queueModel({
        readCompleteness: "complete",
        count: "—",
        rows: [],
        holds: { claimed: 0, reconcile: 2 },
      }),
    );

    expect(html).toContain("2 actions need review");
    expect(html).toContain('data-reconcile="2"');
    expect(confirmationEmptyEl(html)).toContain('data-proven-empty="false"');
    expect(html).not.toContain("reconciliation required");
    expect(html).not.toContain("retry is forbidden");
  });
  it("keeps an unreadable queue unproven and offers retry without diagnostic copy", () => {
    const html = renderWithQueue(
      queueModel({
        readCompleteness: "complete",
        count: "—",
        rows: [],
        holds: null,
      }),
    );

    expect(confirmationEmptyEl(html)).toContain('data-proven-empty="false"');
    expect(confirmationCard(html)).toContain('data-queue-state="unavailable"');
    expect(html).toContain("Pending actions are unavailable");
    expect(html).toContain('data-control="retry-queue"');
    expect(confirmationCard(html)).not.toContain("Review before applying");
    expect(confirmationCard(html)).not.toContain('data-field="viewer-refusal"');
    expect(html).not.toContain('data-holds="unreadable"');
    expect(html).not.toContain('data-field="confirmation-count">0<');
  });
  it("draws no hold statement at all on the canonical empty queue", () => {
    // No new persistent chrome: a read queue with nothing held renders exactly
    // the geometry it always did.
    const html = renderWithQueue(
      queueModel({
        readCompleteness: "complete",
        count: "0",
        rows: [],
        holds: { claimed: 0, reconcile: 0 },
      }),
    );

    expect(html).not.toContain('data-field="queue-holds"');
    expect(html).not.toContain("dispatch in progress");
    expect(html).not.toContain("reconciliation required");
    expect(confirmationEmptyEl(html)).toContain('data-proven-empty="true"');
    expect(html).toContain('data-field="confirmation-count">0<');
    // Recovery stays absent on a state that is not a failure.
    expect(html).not.toContain('data-control="retry-queue"');
  });

  it("distinguishes a proven empty queue from an unproven read", () => {
    const proven = renderWithQueue(
      queueModel({
        readCompleteness: "complete",
        count: "0",
        rows: [],
      }),
    );
    const unproven = renderWithQueue(
      queueModel({
        readCompleteness: "unavailable",
        count: "—",
        rows: [],
      }),
    );

    expect(proven).toContain('data-field="confirmation-count">0<');
    expect(proven).toContain('data-testid="confirmation-empty"');
    expect(unproven).toContain('data-field="confirmation-count">—<');
    expect(unproven).toContain('data-testid="confirmation-empty"');
  });

  /*
    REWRITTEN to the NEW law, not loosened.
    OLD law: "the queue is kept off the read-only mobile surface."
    NEW law: the confirmation queue is CARRIED on the mobile surface, with the
    same three controls the desktop pane draws and the same disabled rule.
    The old decision meant an operator away from a desk could watch a proposal
    expire and do nothing about it; the approved plan requires Approve
    reachable at 320px.
  */
  it("carries the confirmation queue on the mobile surface", () => {
    const mobile = mobileMarkup(
      renderWithQueue(
        queueModel({
          readCompleteness: "complete",
          count: "1",
          rows: [queuedRow],
        }),
      ),
    );

    expect(mobile).toContain("Approve &amp; apply</button>");
    expect(mobile).toContain(">Modify</button>");
    expect(mobile).toContain(">Dismiss</button>");
    expect(mobile).toContain('data-read-only="false"');

    // Disabled exactly when `!onProposalControl || !canMutate ||
    // pendingProposalId !== null`. This render binds no handler, so all three
    // are inert — and inert is rendered, never hidden.
    for (const control of ["approve", "modify", "dismiss"]) {
      expect(mobile, control).toMatch(
        new RegExp(`data-control="${control}"[^>]*disabled=""`),
      );
    }

    // Arming automatic execution is still desktop-and-admin-only; the mobile
    // pane's BudgetWriteReadinessSection stays on `surface: "mobile_read_only"`.
    expect(mobile).not.toContain("budget-activation-enable");
    expect(mobile).not.toContain("budget-preparation-form");
  });

  it("suffixes every duplicated DOM id by surface, so neither pane collides", () => {
    /*
      Both panes are in the DOM at every width — only CSS hides one — so an
      unsuffixed `proposal-note-<id>` or `stop-confirm-input` would be a real
      duplicate id, and therefore an accessibility defect rather than a test
      artifact. Both ids only exist after an interaction (a row being modified,
      a confirmation being opened), so this reads the source: the law is that
      neither template can be written WITHOUT the surface.
    */
    const source = readFileSync(
      "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
      "utf8",
    );

    expect(source).toContain("id={`proposal-note-${row.id}-${surface}`}");
    expect(source).toContain("htmlFor={`proposal-note-${row.id}-${surface}`}");
    expect(source).toContain("id={`stop-confirm-input-${surface}`}");
    expect(source).toContain("htmlFor={`stop-confirm-input-${surface}`}");
    // And no unsuffixed survivor anywhere.
    expect(source).not.toContain("`proposal-note-${row.id}`");

    // The two rendered panes are addressable and distinct.
    const html = renderWithQueue(
      queueModel({
        readCompleteness: "complete",
        count: "1",
        rows: [queuedRow],
      }),
    );
    expect(
      html.match(/class="[^"]*confirmationCard[^"]*" data-surface="(\w+)"/g),
    ).toHaveLength(2);
    expect(html).toContain('data-surface="desktop"');
    expect(html).toContain('data-surface="mobile"');
  });

  it("uses only persisted per-kind modes, never fabricates progress, and keeps launches manual", () => {
    const html = render({ ...payload, sections: SECTIONS });

    expect(html).toContain("Budget changes ≤ +15%");
    expect(html).toMatch(
      /data-decision-type="budget"[\s\S]*?role="radio" aria-checked="true" data-mode="semi_auto"/,
    );
    expect(html).toContain("Pause / resume");
    const pause =
      html.match(
        /data-decision-type="pause"[\s\S]*?data-decision-type="bid"/,
      )?.[0] ?? "";
    expect(pause.match(/role="radio"/g)).toHaveLength(3);
    expect(pause).not.toContain('aria-checked="true"');
    expect(html).toContain("Creative rotation");
    expect(html).toMatch(
      /data-decision-type="creative"[\s\S]*?role="radio" aria-checked="true" data-mode="auto"/,
    );
    expect(html).toContain("Always manual");
    expect(html).not.toContain(
      "Backtest contract required before auto-execute.",
    );
    expect(html).not.toContain("New spend never automates.");
    expect(html).not.toContain("18 / 30");
    expect(html).not.toContain("22 / 30");
    expect(html).not.toContain("4 / 20");
  });

  it("renders real ledger records while leaving unavailable tuple fields as em dashes", () => {
    const html = render();

    expect(html).toContain('data-ledger-id="activity_1"');
    expect(html).toContain("Aug 15, 14:31");
    expect(html).toContain("Automation stopped");
    expect(html).not.toContain(
      "Business kill switch engaged — all Meta writes stopped.",
    );
    expect(html).not.toContain("System guard");
    expect(html).not.toContain("Success record");
    expect(html).not.toContain("not-presented-as-a-result");
    expect(html).not.toContain('data-field="ledger-actor"');
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

    expect(html).not.toContain('data-field="ledger-actor"');
    expect(html).not.toContain("Emrah B.");
    expect(html).toMatch(/data-field="ledger-entity">Budget<\/td>/);
    expect(html).toMatch(
      /data-field="ledger-result"[^>]*data-tone="recorded">Recorded<\/span>/,
    );
    expect(html).toMatch(
      /data-field="ledger-entity">Retargeting 7d — DPA<\/td>/,
    );
    expect(html).toMatch(
      /data-field="ledger-result"[^>]*data-tone="applied">Applied<\/span>/,
    );
    expect(html).not.toContain("promo_1");
    expect(html).not.toContain("23851");
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
    expect(html).not.toContain('data-field="ledger-actor"');
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

  it("does not expose approval-streak internals in the action-mode controls", () => {
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
      sections: SECTIONS,
      readCompleteness: { ...PROVEN_READS, cleanApprovalStreaks: "complete" },
      decisionTypeModes: [
        persistedPause,
        ...payload.decisionTypeModes.filter(
          (item) => item.decisionType !== "pause",
        ),
      ],
    });
    const unproven = render({
      ...payload,
      sections: {
        ...SECTIONS,
        readiness: {
          status: "unavailable",
          errorCode: "read_failed",
          observedAt: OBSERVED_AT,
        },
      },
      readCompleteness: {
        ...PROVEN_READS,
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
      sections: SECTIONS,
      readCompleteness: { ...PROVEN_READS, cleanApprovalStreaks: "complete" },
      decisionTypeModes: [
        { ...persistedPause, cleanApprovalThreshold: null },
        ...payload.decisionTypeModes.filter(
          (item) => item.decisionType !== "pause",
        ),
      ],
    });

    expect(proven).toMatch(
      /data-decision-type="pause"[\s\S]*?role="radio" aria-checked="true" data-mode="manual"/,
    );
    expect(proven).not.toContain("18 / 30");
    expect(unproven).not.toContain("18 / 30");
    expect(noThreshold).not.toContain("18 / 30");
    expect(proven).not.toContain('data-tone="measured"');
    expect(unproven).not.toContain('data-tone="locked"');
    expect(proven).not.toContain("progressTrack");
  });

  it("offers the Meta Stop, holds ENGAGE behind the gate, and never holds RELEASE", () => {
    /*
     * WP13's contract, replacing the older "exposes no write path" one.
     *
     * That earlier assertion was true of the code and wrong about the product:
     * the screen named a Meta Stop, reported whether it was engaged, and gave
     * an operator no way to reach it. "Deliberately absent" reads on screen as
     * "this product cannot stop Meta writes", which is false and is at its most
     * dangerous in exactly the moment the operator needs it.
     *
     * What replaces it is narrower and stronger: the control exists, engaging
     * is held by `META_AUTOMATION_STOP_UI` with the reason visible, releasing
     * is held by nothing, and the GLOBAL switch is still untouchable from here.
     */
    const source = readFileSync(
      "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
      "utf8",
    );

    const html = render();
    expect(html).not.toContain('data-field="global-writes"');
    expect(html).toContain('data-field="business-writes-control"');

    // The default fixture is ENGAGED, so the one control offered is the lift —
    // and it carries no refusal, at any gate setting.
    expect(html).toContain('data-ctl="gated:AUTO-02 release"');
    expect(html).not.toContain("data-stop-engage-refused");

    // Released, with the gate shut: engage is present, disabled, and says why.
    const released = renderToStaticMarkup(
      <MetaAutomationView
        payload={{
          ...payload,
          businessControl: {
            ...payload.businessControl,
            killSwitchEngaged: false,
            killSwitchReason: null,
          },
        }}
        providerAccountId="act_1"
        viewer={{
          role: "admin",
          reviewerReadOnly: false,
          demo: false,
          canMutate: true,
          reason: null,
          reasonCode: null,
        }}
        stopEngageRefusalReason={META_GATE_REFUSAL_REASONS.automationStopUi}
      />,
    );
    /*
     * The contract key does not change with the state. `gated:AUTO-01A engage`
     * is the manifest's own value for this control; whether it is currently
     * refused is `aria-disabled` plus `data-stop-engage-refused`, asserted
     * below.
     */
    expect(released).toContain('data-ctl="gated:AUTO-01A engage"');
    expect(released).toContain('data-stop-engage-refused=""');
    expect(released).toContain("The emergency stop is unavailable right now.");
    expect(released).not.toContain("a stop that cannot be released is worse");
    /*
     * The refusal is readable, not only a tooltip an operator must hunt for —
     * and `aria-disabled` rather than `disabled`, so a keyboard user can reach
     * the control the reason belongs to. The responsive gate measures exactly
     * that reachability.
     */
    expect(released).toMatch(
      /<button[^>]*aria-disabled="true"[^>]*>Stop Meta writes<\/button>/,
    );
    // And it never names a deployment variable.
    expect(released).not.toMatch(/META_[A-Z_]+/);

    // Released, gate open, a viewer the server says may write: a live control.
    const openGate = renderToStaticMarkup(
      <MetaAutomationView
        payload={{
          ...payload,
          businessControl: {
            ...payload.businessControl,
            killSwitchEngaged: false,
            killSwitchReason: null,
          },
        }}
        providerAccountId="act_1"
        viewer={{
          role: "admin",
          reviewerReadOnly: false,
          demo: false,
          canMutate: true,
          reason: null,
          reasonCode: null,
        }}
        stopEngageRefusalReason={null}
      />,
    );
    expect(openGate).toContain('data-ctl="gated:AUTO-01A engage"');
    expect(openGate).not.toContain("data-stop-engage-refused");

    // No confirm dialog stands between an operator and a stop.
    expect(source).not.toContain("window.confirm");

    /*
     * The POST allowlist, still exact. FIVE call sites now — the proposal
     * queue, the Stop, AUTO-03's mode, D088's budget activation ceremony, and
     * the budget PREPARATION save — across two boundaries, both of which are
     * ours: `/api/meta/automation/proposals` and `/api/meta/automation`.
     * Asserted as an allowlist rather than a ban, so a contracted control can
     * exist while nothing else quietly gains a write, and none of these
     * reaches a provider.
     *
     * PRE-DEPLOY AUDIT — why the fifth is safe to admit. It is a different
     * VERB from the fourth: `save_budget_automation_config` is admin-floored
     * on the route and pins `auto_execution_enabled` to FALSE while clearing
     * the activated account on every path, so the site that was added to let
     * an operator PREPARE cannot be the site that ENABLES. The two actions are
     * named separately below so a rename cannot merge them.
     *
     * SIX, and why the sixth is safe. `set_guardrail_policy` only ever
     * TIGHTENS or clears two limits — the ROAS floor below which a pause may
     * be proposed, and the quiet window during which an alert may not
     * interrupt. It enables nothing, binds no account, and reaches no
     * provider. It was added because both values were persisted,
     * server-enforced and unsettable from any screen, which made them belong
     * to whoever last edited the row rather than to the operator.
     */
    expect(source.match(/method: "POST"/g)).toHaveLength(6);
    expect(source).toContain('action: "set_decision_type_mode"');
    expect(source).toContain('action: "set_budget_auto_execution"');
    expect(source).toContain('action: "save_budget_automation_config"');
    expect(source).toContain('action: "set_guardrail_policy"');
    expect(source).toMatch(
      /fetch\(`\/api\/meta\/automation\/proposals\?\$\{query\.toString\(\)\}`, \{\s*method: "POST"/,
    );
    expect(source).toMatch(
      /fetch\(`\/api\/meta\/automation\?\$\{[^`]*`, \{\s*method: "POST"/,
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
    expect(html).not.toContain("rules never write directly");
  });

  it("marks a disabled rule without removing its row", () => {
    const html = render(withRules());
    const disabledRow =
      html.match(/<tr[^>]*data-rule-id="rule_suggest"[\s\S]*?<\/tr>/)?.[0] ??
      "";

    expect(disabledRow).toContain('data-active="false"');
    expect(disabledRow).toContain('data-on="false"');
  });

  it("leaves the table em-dashed when the rules read was not proven complete", () => {
    const unavailable = render({
      ...withRules(),
      readCompleteness: { ...PROVEN_READS, rules: "unavailable" },
    });
    const legacyWithoutProvenance = render({
      ...withRules(),
      readCompleteness: PROVEN_READS,
    });

    expect(unavailable).toContain('data-testid="rules-empty"');
    expect(unavailable).not.toContain("data-rule-id");
    expect(unavailable).toContain('data-proven-empty="false"');
    expect(legacyWithoutProvenance).toContain('data-testid="rules-empty"');
    expect(legacyWithoutProvenance).not.toContain("data-rule-id");
    // The unproven read must never claim there are no rules.
    expect(unavailable).not.toContain("No rules yet");
    expect(legacyWithoutProvenance).not.toContain("No rules yet");
  });

  // The adapter separated "no rules" from "rules could not be read" and the
  // table then rendered both as the same em dash, which told an operator who
  // had just created their first rule the same thing it told one whose read had
  // failed. A proven zero is stated, exactly as `0×` is on the Fired column.
  it("says an empty rule set is empty when the read proved it", () => {
    const html = render({
      ...withRules(),
      readCompleteness: { ...PROVEN_READS, rules: "complete" },
      rules: [],
    });

    expect(html).toContain('data-proven-empty="true"');
    expect(html).toContain("No custom rules");
    expect(html).not.toContain("data-rule-id");
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
          readCompleteness: PROVEN_READS,
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
    expect(unproven).toMatch(
      /<button[^>]*disabled=""[^>]*>\+ New rule<\/button>/,
    );
    // Collapsed by default: the default DOM is exactly the design's.
    expect(authorized).not.toContain('data-testid="rule-composer"');
  });

  /*
    REWRITTEN to the NEW law, not loosened.
    OLD law: "a handler-free READ-ONLY surface at the 768px contract" — no
    button anywhere on the mobile pane.
    NEW law: the mobile pane carries exactly two operable things, the emergency
    stop and the confirmation queue, and nothing else. Everything the old test
    protected against — a guardrail form, a rule composer, an autonomy ladder,
    a budget-activation control leaking onto a phone — is asserted absent
    below, one by one, rather than by a blanket "no <button>".
  */
  it("carries the stop and the queue, and nothing else, at the 768px contract", () => {
    const html = render();
    const mobile = mobileMarkup(html);
    const css = readFileSync(
      "app/(dashboard)/platforms/meta/automation/automation.module.css",
      "utf8",
    );
    const narrowCss = css.slice(
      css.indexOf("@media (max-width: 1023px)"),
      css.indexOf("@media (min-width: 1024px)"),
    );

    expect(mobile).toContain('data-read-only="false"');
    // The emergency control, reachable whenever this surface is.
    expect(mobile).toContain('data-testid="mobile-stop-control"');
    expect(mobile).toMatch(/data-stop-trigger=""[^>]*data-surface="mobile"/);
    // ...and it is `aria-disabled`, never `disabled`, so a refused operator
    // can still reach the reason from the keyboard at 320px.
    expect(mobile).not.toMatch(
      /data-stop-trigger=""[\s\S]{0,200}?\sdisabled=""/,
    );
    expect(mobile).toContain('data-surface="mobile"');
    expect(mobile).toContain("Pending approvals");
    expect(mobile).toContain('data-testid="automation-action-modes-mobile"');
    expect(mobile).toContain('data-testid="automation-recent-activity-mobile"');

    // Everything that stays on desktop.
    expect(mobile).not.toContain('data-collection="guardrails"');
    expect(mobile).not.toContain('data-testid="rule-composer"');
    expect(mobile).not.toContain("+ New rule");
    expect(mobile).not.toContain('data-ctl="gated:AUTO-03 mode"');
    expect(mobile).not.toContain("budget-activation-enable");
    // The H19/H20 reference markers are desktop-only: those artboards are
    // 1440px frames where `.mobileSurface` is `display: none`, so a mobile
    // duplicate would add a graded node with no contract behind it.
    expect(mobile).not.toContain('data-ctl="gated:AUTO-01A engage"');
    expect(mobile).not.toContain('data-ctl="gated:AUTO-02 release"');

    expect(mobile).not.toContain("Google Ads writes");

    expect(css).toContain("@media (max-width: 1023px)");
    expect(css).toMatch(
      /@media \(max-width: 1023px\)[\s\S]*?\.desktopSurface \{[\s\S]*?display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 1023px\)[\s\S]*?\.mobileSurface \{[\s\S]*?display: grid/,
    );
    // Both visual-audit widths (390px and 320px) enter this breakpoint. Empty
    // and unavailable activity are one sentence, so they shed the desktop
    // table's 660px floor and left-align the cell inside the viewport. Ready
    // rows keep the base 660px table and its intentional horizontal scroll.
    expect(css).toMatch(/\.ledgerTable \{[\s\S]*?min-width: 660px/);
    expect(narrowCss).toContain('.ledgerCard[data-ledger-state="empty"]');
    expect(narrowCss).toContain('.ledgerCard[data-ledger-state="unavailable"]');
    expect(narrowCss).toMatch(
      /\.ledgerCard\[data-ledger-state="empty"\] \.ledgerTable,[\s\S]*?min-width: 100%/,
    );
    expect(narrowCss).toMatch(
      /\.ledgerCard\[data-ledger-state="empty"\] \.ledgerEmpty td,[\s\S]*?overflow-wrap: anywhere;[\s\S]*?text-align: left/,
    );
    expect(narrowCss).not.toContain(
      '.ledgerCard[data-ledger-state="ready"] .ledgerTable',
    );
    expect(css).not.toContain(".accountPicker");
    expect(css).toContain("@media (min-width: 1024px)");
  });
});

describe("the guardrails an operator could read and not set", () => {
  /*
    `minRoasFloor` decides whether a pause is proposed at all, and quiet hours
    decide when an alert may interrupt someone. Both are persisted, both are
    enforced on the server, and neither had a control anywhere — which in
    practice made them belong to whoever last edited the row directly. The
    route has accepted `set_guardrail_policy` all along; nothing sent it.
  */
  function withGuardrails(
    guardrails: Partial<
      MetaAutomationControlPlane["businessControl"]["guardrails"]
    >,
    viewer?: React.ComponentProps<typeof MetaAutomationView>["viewer"],
  ) {
    return renderToStaticMarkup(
      <MetaAutomationView
        payload={{
          ...payload,
          businessControl: {
            ...payload.businessControl,
            guardrails: {
              ...payload.businessControl.guardrails,
              ...guardrails,
            },
          },
        }}
        businessId="biz_1"
        providerAccountId="act_1"
        viewer={
          viewer ??
          buildAutomationViewerEnvelope({
            role: "admin",
            reviewerReadOnly: false,
            writeAuthority: "live",
          })
        }
      />,
    );
  }

  it("seeds each control from what is stored", () => {
    const html = withGuardrails({
      minRoasFloor: 1.4,
      quietHours: { start: "22:00", end: "07:00", timezone: "Europe/Istanbul" },
    });
    expect(html).toContain('data-testid="guardrail-policy-form"');
    expect(html).toContain('value="1.4"');
    expect(html).toContain('value="22:00"');
    expect(html).toContain('value="Europe/Istanbul"');
  });

  it("leaves the controls empty when nothing is stored", () => {
    // An operator who wants automation to consider every losing entity should
    // not have to invent a number to say so.
    const html = withGuardrails({ minRoasFloor: null, quietHours: null });
    expect(html).not.toContain("Blank clears");
    expect(html).toContain('data-testid="guardrail-roas-floor"');
  });

  it("keeps the read-only rows the card always had", () => {
    const html = withGuardrails({ minRoasFloor: 1.4 });
    expect(html).toContain('data-field="guardrail-roas-floor"');
    expect(html).toContain('data-field="guardrail-quiet-hours"');
  });

  it("offers no limits form to a read-only viewer", () => {
    const html = withGuardrails(
      { minRoasFloor: 1.4 },
      // The real envelope, built the way the page builds it: a reviewer is
      // read-only whatever the release posture says.
      buildAutomationViewerEnvelope({
        role: "admin",
        reviewerReadOnly: true,
        writeAuthority: "live",
      }),
    );
    expect(html).not.toContain('data-testid="guardrail-policy-form"');
    expect(html).not.toContain('data-testid="guardrail-roas-floor"');
    expect(html).toContain('data-field="guardrail-roas-floor"');
  });

  it("offers the limits form only to an admin, not a collaborator", () => {
    const html = withGuardrails(
      { minRoasFloor: 1.4 },
      buildAutomationViewerEnvelope({
        role: "collaborator",
        reviewerReadOnly: false,
        writeAuthority: "live",
      }),
    );

    expect(html).not.toContain('data-testid="guardrail-policy-form"');
    expect(html).not.toContain('data-testid="guardrail-roas-floor"');
    expect(html).toContain('data-field="guardrail-roas-floor"');
  });

  it("offers no clearing form when the business-control read is unproven", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        payload={{
          ...payload,
          businessControl: {
            ...payload.businessControl,
            guardrails: {
              ...payload.businessControl.guardrails,
              minRoasFloor: 2.5,
              quietHours: {
                start: "22:00",
                end: "07:00",
                timezone: "Europe/Istanbul",
              },
            },
          },
          readCompleteness: undefined,
          sections: undefined,
        }}
        businessId="biz_1"
        providerAccountId="act_1"
        viewer={buildAutomationViewerEnvelope({
          role: "admin",
          reviewerReadOnly: false,
          writeAuthority: "live",
        })}
      />,
    );

    expect(html).not.toContain('data-testid="guardrail-policy-form"');
    expect(html).not.toContain('data-testid="guardrail-policy-save"');
    expect(html).not.toContain('value="2.5"');
    expect(html).not.toContain('value="22:00"');
  });
});
