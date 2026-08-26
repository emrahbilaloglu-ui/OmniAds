/**
 * A served Automation control plane, for the frame and shell harnesses.
 *
 * The harnesses used to render an archived presenter that took a small,
 * hand-shaped `postures`/`guardrails`/`ceremony` model. The mounted body takes
 * the real `MetaAutomationControlPlane` — the same object `/api/meta/automation`
 * returns — so the fixture has to be one, and building it here rather than
 * inline in the registry keeps H19 and H20 differing by exactly the one fact
 * that separates them.
 *
 * Every read is marked `complete` on purpose. The mounted body is careful to
 * distinguish "read and empty" from "not read", and a harness fixture with
 * unproven reads would draw em dashes everywhere and grade the unknown state
 * rather than the served one. The two frames that DO grade an unproven read are
 * the responsive shell's own, which use their own fixtures.
 */
import type {
  MetaAutomationControlPlane,
  MetaAutomationDecisionMode,
  MetaAutomationDecisionType,
} from "@/lib/meta/automation-control-plane";

const OBSERVED_AT = "2026-08-15T14:32:00.000Z";

const PROVEN = {
  status: "complete",
  errorCode: null,
  observedAt: OBSERVED_AT,
} as const;

/** Every mode PERSISTED, so the ladder draws a recorded choice rather than a default. */
const MODES: {
  decisionType: MetaAutomationDecisionType;
  mode: MetaAutomationDecisionMode;
  threshold: number | null;
  streak: number | null;
  lockReason: string | null;
}[] = [
  { decisionType: "budget", mode: "semi_auto", threshold: 30, streak: 18, lockReason: "Backtest contract required before auto-execute." },
  { decisionType: "pause", mode: "manual", threshold: 30, streak: 4, lockReason: "Two demotions in the last review window." },
  { decisionType: "bid", mode: "manual", threshold: 30, streak: 0, lockReason: "No clean-approval streak recorded yet." },
  { decisionType: "creative", mode: "auto", threshold: 30, streak: 30, lockReason: null },
];

export function automationControlPlaneFixture(
  options: {
    killSwitchEngaged?: boolean;
    /**
     * When the businessControl reading was taken.
     *
     * Frozen by default, because the frame harness screenshots this instant and
     * a moving clock would make 92 captures non-deterministic. A caller that
     * needs the Stop ceremony OPERABLE must pass a fresh one: the mounted body
     * refuses a confirmation made against a reading older than
     * `STOP_PREFLIGHT_MAX_AGE_MS`, and a frozen instant is older than that by
     * design.
     */
    businessControlObservedAt?: string;
  } = {},
): MetaAutomationControlPlane {
  const killSwitchEngaged = options.killSwitchEngaged ?? false;
  const businessControlObserved = {
    status: "complete",
    errorCode: null,
    observedAt: options.businessControlObservedAt ?? OBSERVED_AT,
  } as const;
  return {
    contractVersion: "meta-automation-control-plane.v1",
    businessId: "biz",
    providerAccountId: "act_1",
    globalKillSwitch: { engaged: false, reason: null },
    businessControl: {
      businessId: "biz",
      killSwitchEngaged,
      killSwitchReason: killSwitchEngaged ? "Operator stop." : null,
      autoExecutionEnabled: false,
      readinessTier: "manual_review",
      guardrails: {
        dailyAutoActionCap: 8,
        perActionSpendCeilingMinor: 25000,
        perActionSpendCeilingCurrency: "USD",
        notificationPolicy: "every_auto_action",
        maxBudgetIncreasePct: 20,
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
      writeEndpointsBlocked: killSwitchEngaged,
      blockedReasons: killSwitchEngaged ? ["business_kill_switch"] : [],
    },
    promotionRecords: [],
    /*
     * BOTH envelopes, because the server serves both.
     *
     * `readCompleteness` is the flat legacy map of `"complete" | "unavailable"`
     * strings; `sections` is the richer one that carries the error code and the
     * instant each read was taken. This fixture used to put the SECTIONS shape
     * under the `readCompleteness` key and omit `sections` entirely — so every
     * consumer that reads the observation instant, which is what the Stop
     * ceremony's preflight is, saw nothing and refused. A fixture that does not
     * describe what the route returns grades the wrong product.
     */
    readCompleteness: {
      businessControl: "complete",
      rules: "complete",
      activityLedger: "complete",
      promotionRecords: "complete",
      cleanApprovalStreaks: "complete",
    },
    sections: {
      businessControl: businessControlObserved,
      rules: PROVEN,
      activity: PROVEN,
      promotionRecords: PROVEN,
      decisionModes: PROVEN,
      anchors: PROVEN,
      readiness: PROVEN,
    },
    activityLedger: [
      {
        id: "activity_1",
        activityType: "automation_decision_type_mode",
        severity: "info",
        message: "Creative rotation moved to Tier 3 · Auto-execute.",
        payload: {},
        createdAt: "2026-08-15T14:31:00.000Z",
        source: "automation_ledger",
        actor: { id: "user_1", name: "Dana Whitfield" },
        entity: { type: "automation_decision_type", id: "creative", name: null },
        result: "recorded",
      },
    ],
    decisionTypeModes: MODES.map((entry) => ({
      decisionType: entry.decisionType,
      mode: entry.mode,
      lockReason: entry.lockReason,
      updatedAt: "2026-08-15T09:00:00.000Z",
      updatedBy: "user_1",
      source: "persisted",
      cleanApprovalThreshold: entry.threshold,
      cleanApprovalStreak: entry.streak,
    })),
    rules: [],
  } as unknown as MetaAutomationControlPlane;
}

/**
 * The viewer H19 and H20 are drawn for: an admin who may act.
 *
 * Both frames grade controls, and a refused viewer would draw them disabled —
 * which is a different frame (the role matrix grades that one) and would make
 * the anatomy gate measure a state the reference does not draw.
 */
export const AUTOMATION_HARNESS_VIEWER = {
  role: "admin" as const,
  reviewerReadOnly: false,
  demo: false,
  canMutate: true,
  reason: null,
  reasonCode: null,
};
