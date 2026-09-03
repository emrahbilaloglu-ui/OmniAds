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
  businessControl: { status: "complete", errorCode: null, observedAt: OBSERVED_AT },
  rules: { status: "complete", errorCode: null, observedAt: OBSERVED_AT },
  activity: { status: "complete", errorCode: null, observedAt: OBSERVED_AT },
  promotionRecords: {
    status: "complete",
    errorCode: null,
    observedAt: OBSERVED_AT,
  },
  decisionModes: { status: "complete", errorCode: null, observedAt: OBSERVED_AT },
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
  extra?: { viewer?: React.ComponentProps<typeof MetaAutomationView>["viewer"] },
) {
  return renderToStaticMarkup(
    <MetaAutomationView
      payload={payload}
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
  const start = html.indexOf("Needs your confirmation");
  const end = html.indexOf("<h2>Rules</h2>");
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
  it("keeps the canonical one-page hierarchy and copy without legacy extras", () => {
    const html = render();

    expect(html).toContain('data-screen-label="Automation"');
    expect(html).toContain("Meta · Supervision control plane");
    expect(html).toContain(">Automation</h1>");
    /*
      7 canonical cards
      + 2 D077 state-history recovery-readiness sections (desktop + mobile)
      + 2 D086 budget-readiness sections (desktop + mobile)

      Both additions are display-only articles on the EXISTING readiness surface;
      neither adds a route, a dashboard or an affordance. The D077 pin predated
      its own sections and was corrected in the D078 acceptance pass; this one is
      updated in the same slice that adds the sections it counts.
    */
    expect(html.match(/<article/g)).toHaveLength(13);
    // ...and the D086 sections are display-only on both surfaces.
    expect(html.match(/data-testid="budget-readiness"/g)).toHaveLength(2);
    /*
      D087 adds the budget write capability panel to the SAME surface, on both
      layouts. It is display-only for the same reason the D086 panel is, and it
      is unavailable here because this fixture supplies no server model — which
      is what an unconfigured account must look like.
    */
    expect(html.match(/data-testid="budget-write-readiness-unavailable"/g)).toHaveLength(2);
    expect(html).toContain("Automatic execution — master switch");
    expect(html).toContain("Kill switch");
    expect(html).toContain("Guardrails");
    expect(html).toContain("Readiness");
    expect(html).toContain("Needs your confirmation");
    expect(html).toContain("Rules");
    expect(html).toContain("Autonomy ladder");
    expect(html).toContain("Activity ledger");
    /**
     * The design file's own copy here reads "Global writes" and "blocks every
     * provider write instantly", and both are false of the control.
     * `META_ADS_WRITE_KILL_SWITCH` is read by `lib/meta/ads-write.ts` and the
     * Meta routes; `lib/google-ads/advisor-mutate.ts` neither reads it nor
     * imports anything from the Meta control plane. An operator reaching for
     * this switch during an incident would have believed Google Ads stopped
     * too. Corrected under the master plan's WP1 items 5–6 and its D1 allowance
     * for wrong or risky micro-copy; the layout, hierarchy and styling the
     * design specifies are untouched.
     */
    expect(html).toContain(
      "Flipping either switch blocks every <b>Meta</b> write instantly — server-enforced, not a UI state.",
    );
    expect(html).toContain(
      "<b>No control on this screen stops Google Ads writes.</b>",
    );
    // The false claim must be gone, not merely joined by a true one.
    expect(html).not.toContain("blocks every provider write");
    expect(html).not.toContain("<span>Global writes</span>");
    expect(html).not.toContain("<dt>Global writes</dt>");
    // `dryRunOnly` is the guardrail that decides whether anything here reaches
    // Meta at all, and it was the one guardrail the card did not show.
    expect(html).toContain("Approvals reach Meta");

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
    /*
     * The business row lost `data-read-only` when WP13's Stop control landed
     * under it: the pill still only REPORTS, but the row is no longer a
     * read-only corner of the screen, and marking it so would have said the
     * product cannot stop Meta writes. The global row keeps the marker — that
     * switch is deployment-owned and this screen can never move it.
     */
    expect(html).toMatch(/data-field="business-writes"[^>]*>STOPPED/);
    expect(html).not.toMatch(
      /data-field="business-writes"[^>]*data-read-only="true"/,
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

  it("states the defaulted control the server actually enforces, and names it a default", () => {
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

    // The global read is the subject and still comes through.
    expect(html).toMatch(/data-field="global-writes"[^>]*>STOPPED/);

    // A defaulted control row is not an absent one. These defaults are what the
    // server enforces for a business nobody has configured:
    // `automation-proposal-execution.ts` sets `dryRun` from
    // `guardrails.dryRunOnly`, which defaults true in the code AND in the
    // column — which is why every approval here short-circuits before the
    // provider. Printing an em dash beside a 15% ceiling and a 3-action cap
    // told the operator no limit was in force while one governed every write.
    // The fixture's business control is engaged, so the served answer is
    // STOPPED — the point is that a served answer appears at all.
    expect(html).toMatch(/data-field="business-writes"[^>]*>STOPPED/);
    expect(html).not.toMatch(/data-field="readiness-tier">—/);
    expect(html).toContain("+15% max");

    // ...but it still has to say these are defaults, not the operator's own
    // settings. That distinction is the reason the old gate existed.
    expect(html).toContain("defaults, not set here");
  });

  it("shows a zero promotion count only when the collection read is proven complete", () => {
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

  /**
   * Rewritten, not deleted.
   *
   * The old assertion was `expect(html.match(/<button/g)).toHaveLength(1)` on a
   * render whose queue read is UNAVAILABLE — so it pinned "one button" for a
   * state that is a read failure, and in doing so pinned the absence of any way
   * to retry that read. The law it was actually protecting is that the empty
   * screen invents no PROPOSAL controls and no rule rows, and that survives
   * intact below.
   *
   * What changed: an unreadable queue now carries its own Retry, for the same
   * reason the control-plane read already does — a failure with no way back is
   * a dead end an operator can only escape by reloading the page. The
   * proven-empty queue is unchanged and still renders exactly one button.
   */
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
     */
    expect(html.match(/<button/g)).toHaveLength(15);
    expect(html.match(/data-ctl="gated:AUTO-03 mode"/g)).toHaveLength(4);
    expect(html).toContain('data-field="business-writes-control"');
    expect(html).toContain('data-control="retry-queue"');

    // A queue that was actually read and is actually empty gets no retry —
    // there is nothing to recover from — so the canonical geometry loses one
    // control and keeps "+ New rule" beside the Stop.
    const proven = renderWithQueue(queueModel({
      readCompleteness: "complete",
      count: "0",
      rows: [],
    }));
    // Two, plus the twelve AUTO-03 segments, which do not depend on the queue.
    expect(proven.match(/<button/g)).toHaveLength(14);
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
    const inert = renderWithQueue(queueModel({
      readCompleteness: "unavailable",
      count: "—",
      rows: [],
    }));

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
  it("keeps the design's ledger promise while the ledger is actually working", () => {
    const html = render();

    expect(html).toContain("every outcome");
    expect(html).toContain("lands in the ledger with a receipt");
    expect(html).not.toContain("could not be written to the activity ledger");
  });

  it("withdraws the ledger promise when the last decision did not reach it", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        payload={payload}
        providerAccountId="act_1"
        ledgerCompleteness="unavailable"
      />,
    );

    expect(html).toContain("could not be written to the activity ledger");
    expect(html).toContain("its receipt is on the proposal record");
    // The claim itself is gone, not merely qualified.
    expect(html).not.toContain("every outcome");
    // And the two clauses that are still true are untouched.
    expect(html).toContain("approving executes inside the guardrails above");
    expect(html).toContain("expired proposals");
  });

  // ITEM 11. Each section answers for its OWN read. One failure must not erase
  // a fact the server proved elsewhere on the same screen.
  /**
   * ITEM 5. `ledgerCompleteness` was CLIENT SESSION STATE ONLY. A reload reset
   * it to `null`, and `null` printed the promise — so a decision that genuinely
   * never reached the ledger was papered over by a refresh, and a workspace
   * whose ledger could not be read at all was told every outcome lands there.
   *
   * The promise is a claim about evidence, so it needs evidence. There are now
   * three states, not two, because asserting a failure with no decision behind
   * it would be just as false as asserting success.
   */
  it("makes no ledger promise at all when nothing proves the ledger works", () => {
    const unreadLedger = renderToStaticMarkup(
      <MetaAutomationView
        payload={{
          ...payload,
          // The server read model's own answer: the activity read did not
          // complete. This survives a reload because it arrives with the page.
          readCompleteness: { ...PROVEN_READS, activityLedger: "unavailable" },
        }}
        providerAccountId="act_1"
        // A fresh page load. No decision has been recorded in this session.
        ledgerCompleteness={null}
      />,
    );

    expect(unreadLedger).toContain('data-ledger-evidence="no_evidence"');
    // The claim is not made...
    expect(unreadLedger).not.toContain("every outcome");
    // ...and neither is the opposite claim, because no decision failed here.
    expect(unreadLedger).not.toContain(
      "could not be written to the activity ledger",
    );
    // The two clauses that are still true are untouched.
    expect(unreadLedger).toContain("approving executes inside the guardrails above");
    expect(unreadLedger).toContain("expired proposals");
  });

  it("rebuilds the promise from the server read model rather than session state", () => {
    // Exactly the state a refresh produces: no session fact, a served payload.
    const afterReload = renderToStaticMarkup(
      <MetaAutomationView
        payload={payload}
        providerAccountId="act_1"
        ledgerCompleteness={null}
      />,
    );

    expect(afterReload).toContain('data-ledger-evidence="complete"');
    expect(afterReload).toContain("lands in the ledger with a receipt");
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
      buildAutomationViewerEnvelope({
        role: "admin",
        reviewerReadOnly: true,
        writeAuthority: "live",
      }),
      buildAutomationViewerEnvelope({
        role: "admin",
        reviewerReadOnly: false,
        writeAuthority: "demo",
      }),
      buildAutomationViewerEnvelope({
        role: "guest",
        reviewerReadOnly: false,
        writeAuthority: "live",
      }),
      buildAutomationViewerEnvelope({
        role: "admin",
        reviewerReadOnly: false,
        // An unreadable demo flag refuses. It never reads as "live".
        writeAuthority: "unverified",
      }),
    ];

    for (const viewer of refusals) {
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
      const toggles = html.match(/<button[^>]*aria-pressed="[a-z]+"[^>]*>/g) ?? [];
      expect(toggles).toHaveLength(3);
      for (const toggle of toggles) expect(toggle).toContain('disabled=""');
      // The server's own sentence, stated before the click rather than after.
      expect(html).toContain('data-field="viewer-refusal"');
      expect(html).toContain(viewer.reason!);
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

  it("does not let one failed section erase another that was proven", () => {
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

    // The rules table cannot claim an empty workspace...
    expect(rulesBroken).toContain('data-proven-empty="false"');
    // ...but the promotion count, the guardrails and the readiness tier were
    // all read successfully and are still stated.
    expect(rulesBroken).toMatch(
      /data-field="promotion-count">1 promotion record/,
    );
    expect(rulesBroken).toContain("+15% max");
    expect(rulesBroken).not.toMatch(/data-field="readiness-tier">—/);
  });

  it("reads the richer section envelope in preference to the flat flags", () => {
    // The flat map says everything is complete; the section envelope says the
    // control read failed. The envelope is the more specific statement and it
    // carries the error code, so it wins — otherwise a server that learned how
    // to describe a failure would be ignored by the surface that must show it.
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

    expect(html).toMatch(/data-field="readiness-tier">—/);
    expect(html).toMatch(/data-field="business-writes"[^>]*>—/);
    expect(html).toContain('data-field="read-error"');
  });

  // A failed control-plane read em-dashes every card on this screen. Until now
  // it drew no notice and no way back: the retry handler existed but its only
  // registered consumer, the Tier-0 freshness bar, is mounted nowhere, so a
  // transient failure could only be cleared by reloading the page.
  it("draws no read-failure notice while the read is healthy", () => {
    const html = render();

    expect(html).not.toContain('data-field="read-error"');
    expect(html).not.toContain('data-control="retry-read"');
  });

  it("gives a failed read a live retry control", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        payload={null}
        providerAccountId="act_1"
        readError="automation_control_plane_unavailable"
        onRetryRead={() => {}}
      />,
    );
    const notice = html.match(/<p[^>]*data-field="read-error"[\s\S]*?<\/p>/)?.[0] ?? "";

    expect(notice).toContain('data-control="retry-read"');
    expect(notice).toContain(">Retry</button>");
    expect(notice).not.toContain('disabled=""');
    expect(notice).toContain(
      "Automation could not be read, so every figure below is unknown rather than zero.",
    );
  });

  it("keeps the retry inert on a render that has no reader to re-run", () => {
    const html = renderToStaticMarkup(
      <MetaAutomationView
        payload={null}
        providerAccountId="act_1"
        readError="automation_control_plane_unavailable"
      />,
    );
    const notice = html.match(/<p[^>]*data-field="read-error"[\s\S]*?<\/p>/)?.[0] ?? "";

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
  it("renders a missing control row as blocked/not-configured, never ENABLED (D078)", () => {
    const html = render({
      ...payload,
      businessControl: {
        ...payload.businessControl,
        killSwitchEngaged: false,
        source: "default",
      },
      // The read itself succeeded — provenance says the row does not exist.
      readCompleteness: { ...PROVEN_READS, businessControl: "complete" },
    });

    expect(html).not.toMatch(/data-field="business-writes"[^>]*>ENABLED/);
    expect(html).toMatch(
      /data-field="business-writes"[^>]*>BLOCKED · NOT CONFIGURED/,
    );
    expect(html).toMatch(/data-tone="stopped"[^>]*data-field="business-writes"/);
    // The global row keeps its own truth: the env switch is independent.
    expect(html).toMatch(/data-field="global-writes"[^>]*>ENABLED/);
  });

  it("withholds every control fact when the control read failed, and names the failure", () => {
    const html = render({
      ...payload,
      // Exactly what the server hands back on a failed control read.
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

    expect(html).toMatch(/data-field="business-writes"[^>]*>—/);
    expect(html).not.toMatch(/data-field="business-writes"[^>]*>ENABLED/);
    expect(html).toMatch(/data-field="readiness-tier">—/);
    expect(html).not.toContain("Tier 1 — Supervised");
    expect(html).toMatch(/guardrail-budget-change[\s\S]*?<strong>—<\/strong>/);
    expect(html).toMatch(/guardrail-actions-per-day[\s\S]*?<strong>—<\/strong>/);
    expect(html).not.toContain("+15% max");
    expect(html).not.toContain(">3</strong>");

    // ...but a collection with its OWN proven read is still stated. Hiding a
    // fact the server did prove is the same defect pointed the other way.
    expect(html).toMatch(/data-field="promotion-count">1 promotion record/);

    // The old hint claimed the OPPOSITE of what happened: it said nobody
    // configured a guardrail, when the server could not find out.
    expect(html).not.toContain("defaults, not set here");

    expect(html).toContain('data-field="read-error"');
    expect(html).toContain(
      'data-reason="automation_control_state_unavailable"',
    );
    expect(html).toContain(
      "The automation control state could not be read, so the kill switch, guardrails and readiness above are unknown rather than the defaults they would otherwise show.",
    );

    // The global switch is read from the environment, not the control table,
    // so it is still a served fact and stays stated.
    expect(html).toMatch(/data-field="global-writes"[^>]*>ENABLED/);
  });

  // Same law, absent flag: a payload that never proved the control read is not
  // a payload that proved it succeeded. Identical to the `rules` convention.
  it("treats a payload without control-read provenance as unproven", () => {
    const html = render({ ...payload, readCompleteness: undefined });

    expect(html).toMatch(/data-field="business-writes"[^>]*>—/);
    expect(html).toMatch(/data-field="readiness-tier">—/);
    expect(html).not.toContain("defaults, not set here");
    expect(html).toContain('data-field="read-error"');
  });

  /**
   * The law: an empty activity ledger is only "nothing happened" when the read
   * proved it. Both ledger halves used to degrade to `[]` on failure, so a
   * broken read and a quiet workspace rendered the same em dash — and a
   * business with a genuinely empty ledger could never learn that it was empty.
   */
  it("separates a proven-empty activity ledger from an unproven one", () => {
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
      readCompleteness: { promotionRecords: "complete", businessControl: "complete" },
    });
    const emptyRow = (html: string) =>
      html.match(/<tr[^>]*data-testid="ledger-empty"[\s\S]*?<\/tr>/)?.[0] ?? "";

    expect(emptyRow(provenEmpty)).toContain('data-proven-empty="true"');
    expect(emptyRow(provenEmpty)).toContain("No activity yet");
    expect(emptyRow(unproven)).toContain('data-proven-empty="false"');
    expect(emptyRow(unproven)).not.toContain("No activity yet");
    expect(emptyRow(unproven)).toContain("—");
    expect(emptyRow(legacyWithoutProvenance)).toContain(
      'data-proven-empty="false"',
    );
    expect(emptyRow(legacyWithoutProvenance)).not.toContain("No activity yet");
  });

  /**
   * The law: when no account scope resolved, neither read ran — and the screen
   * has to say that rather than sit at "—" with no explanation. The design has
   * no account picker and this adds none; it names the reason in the failure
   * notice that is already drawn.
   */
  it("names an unresolved account scope instead of failing silently", () => {
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
      "No Meta ad account is resolved for this business, so Automation was never read",
    );
    // Still the same notice element and the same retry control — no new
    // geometry, no account picker.
    expect(unresolved).toContain('data-control="retry-read"');

    // "Could not be read" and "there is nothing to read" are different facts.
    expect(noneAssigned).toContain(
      "No Meta ad account is assigned to this business",
    );
    expect(unavailable).toContain(
      "Meta account assignments could not be read",
    );
    expect(unavailable).not.toContain(
      "No Meta ad account is assigned to this business",
    );
  });

  it("renders a real proposal in the canonical row shape with all three controls", () => {
    const html = renderWithQueue(queueModel({
      readCompleteness: "complete",
      count: "1",
      rows: [queuedRow],
    }));

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
    const html = renderWithQueue(queueModel({
      readCompleteness: "complete",
      count: "1",
      rows: [queuedRow],
    }));

    expect(html.match(/data-control="[a-z-]+"[^>]*disabled=""/g)).toHaveLength(
      3,
    );
  });

  // ITEM 2. The server counts the rows this account holds open without being
  // approvable and sends them beside the queue; the view model used to drop
  // them. A `claimed` row is a dispatch in flight and a `reconcile` row is an
  // outcome nobody has confirmed — telling the operator "0" over either one is
  // the single worst answer this card can give.
  it("states a dispatch in progress inside the confirmation card instead of claiming zero", () => {
    const html = renderWithQueue(
      queueModel({
        readCompleteness: "complete",
        count: "—",
        rows: [],
        holds: { claimed: 1, reconcile: 0 },
      }),
    );

    expect(html).toContain("dispatch in progress");
    expect(html).toContain('data-field="queue-holds"');
    expect(html).toContain('data-claimed="1"');
    // Not empty, and not counted as empty.
    expect(html).toContain('data-field="confirmation-count">—<');
    expect(confirmationEmptyEl(html)).toContain('data-proven-empty="false"');
    expect(html).not.toContain('data-field="confirmation-count">0<');
    // Inside the existing card, not in a new region of its own.
    const card = confirmationCard(html);
    expect(card).toContain("dispatch in progress");
  });

  it("states reconciliation required, and that retry is forbidden, for a held row", () => {
    const html = renderWithQueue(
      queueModel({
        readCompleteness: "complete",
        count: "—",
        rows: [],
        holds: { claimed: 0, reconcile: 2 },
      }),
    );

    expect(html).toContain("reconciliation required");
    // The invariant's own words: such a row "stays pending ... reconciliation
    // required, and retry forbidden".
    expect(html).toContain("retry is forbidden");
    expect(html).toContain('data-reconcile="2"');
    expect(confirmationEmptyEl(html)).toContain('data-proven-empty="false"');
  });

  it("forbids a proven-empty queue when the hold count could not be read", () => {
    const html = renderWithQueue(
      queueModel({
        readCompleteness: "complete",
        count: "—",
        rows: [],
        holds: null,
      }),
    );

    expect(html).toContain('data-holds="unreadable"');
    expect(confirmationEmptyEl(html)).toContain('data-proven-empty="false"');
    // And the failure gets the way back the read-failure state already has.
    expect(html).toContain('data-control="retry-queue"');
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
    // The approved exception: no Retry on a state that is not a failure.
    expect(html).not.toContain('data-control="retry-queue"');
  });

  it("distinguishes a proven empty queue from an unproven read", () => {
    const proven = renderWithQueue(queueModel({
      readCompleteness: "complete",
      count: "0",
      rows: [],
    }));
    const unproven = renderWithQueue(queueModel({
      readCompleteness: "unavailable",
      count: "—",
      rows: [],
    }));

    expect(proven).toContain('data-field="confirmation-count">0<');
    expect(proven).toContain('data-testid="confirmation-empty"');
    expect(unproven).toContain('data-field="confirmation-count">—<');
    expect(unproven).toContain('data-testid="confirmation-empty"');
  });

  it("keeps the queue off the read-only mobile surface", () => {
    const mobile = mobileMarkup(
      renderWithQueue(queueModel({
        readCompleteness: "complete",
        count: "1",
        rows: [queuedRow],
      })),
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
      readCompleteness: { ...PROVEN_READS, cleanApprovalStreaks: "unavailable" },
      decisionTypeModes: [
        persistedPause,
        ...payload.decisionTypeModes.filter(
          (item) => item.decisionType !== "pause",
        ),
      ],
    });
    const noThreshold = render({
      ...payload,
      readCompleteness: { ...PROVEN_READS, cleanApprovalStreaks: "complete" },
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

    // The global switch is deployment-owned; this screen may only report it.
    const html = render();
    expect(html).toMatch(/data-field="global-writes"[^>]*data-read-only="true"/);
    expect(html).toContain('data-field="business-writes-control"');

    // The default fixture is STOPPED, so the one control offered is the lift —
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
    expect(released).toContain("a stop that cannot be released is worse");
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
     */
    expect(source.match(/method: "POST"/g)).toHaveLength(5);
    expect(source).toContain('action: "set_decision_type_mode"');
    expect(source).toContain('action: "set_budget_auto_execution"');
    expect(source).toContain('action: "save_budget_automation_config"');
    expect(source).toMatch(
      /fetch\(`\/api\/meta\/automation\/proposals\?\$\{query\.toString\(\)\}`, \{\s*method: "POST"/,
    );
    expect(source).toMatch(/fetch\(`\/api\/meta\/automation\?\$\{[^`]*`, \{\s*method: "POST"/);
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
    expect(html).toContain("No rules yet");
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
