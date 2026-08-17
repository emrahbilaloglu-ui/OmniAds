import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AutomationRuleValidationError,
  anchorsFromTargetPack,
  describeAction,
  describeTrigger,
  evaluateAutomationGuardRules,
  evaluateAutomationRules,
  isAutomationRuleLocked,
  isWithinQuietHours,
  validateAutomationRuleDraft,
  type AutomationRuleAnchorValues,
  type AutomationRuleDefinition,
  type AutomationRuleEntityWindow,
} from "@/lib/meta/automation-rules";

const ANCHORS: AutomationRuleAnchorValues = {
  target_roas: 3.8,
  break_even_roas: 2.5,
  target_cpa: 18,
  break_even_cpa: 24,
};

function rule(
  overrides: Partial<AutomationRuleDefinition> = {},
): AutomationRuleDefinition {
  return {
    id: "rule_breakeven",
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
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function entity(
  roasSeries: Array<number | null>,
  overrides: Partial<AutomationRuleEntityWindow> = {},
): AutomationRuleEntityWindow {
  return {
    entityLevel: "adset",
    entityId: "adset_1",
    entityName: "Retargeting 7d — DPA",
    providerAccountId: "act_1",
    daily: roasSeries.map((roas, index) => ({
      // index 0 is the most recent day.
      date: `2026-08-${String(16 - index).padStart(2, "0")}`,
      roas,
      cpa: roas === null ? null : 30 - roas,
      spend: 100,
      revenue: roas === null ? null : roas * 100,
    })),
    ...overrides,
  };
}

describe("automation rule state machine", () => {
  it("accepts an anchored confirm rule and normalizes its defaults", () => {
    const draft = validateAutomationRuleDraft({
      name: "  Breakeven guard  ",
      entityLevel: "adset",
      trigger: {
        kind: "roas_below_anchor",
        anchor: "break_even_roas",
        consecutiveDays: 3,
      },
      action: { kind: "propose_pause" },
      mode: "confirm",
    });

    expect(draft.name).toBe("Breakeven guard");
    expect(draft.trigger).toEqual({
      kind: "roas_below_anchor",
      anchor: "break_even_roas",
      anchorMultiplier: 1,
      consecutiveDays: 3,
    });
    expect(draft.action).toEqual({
      kind: "propose_pause",
      budgetChangePct: null,
    });
  });

  it("refuses a trigger that carries a free-floating threshold instead of an anchor", () => {
    expect(() =>
      validateAutomationRuleDraft({
        name: "Hand-tuned",
        entityLevel: "adset",
        trigger: {
          kind: "roas_below_anchor",
          anchor: "break_even_roas",
          consecutiveDays: 3,
          threshold: 2.5,
        },
        action: { kind: "propose_pause" },
        mode: "confirm",
      }),
    ).toThrowError(AutomationRuleValidationError);

    expect(() =>
      validateAutomationRuleDraft({
        name: "No anchor at all",
        entityLevel: "adset",
        trigger: { kind: "roas_below_anchor", consecutiveDays: 3 },
        action: { kind: "propose_pause" },
        mode: "confirm",
      }),
    ).toThrowError(/commercial_truth_anchor/);
  });

  it("refuses a ROAS trigger anchored to a CPA number and vice versa", () => {
    expect(() =>
      validateAutomationRuleDraft({
        name: "Mismatched",
        entityLevel: "adset",
        trigger: {
          kind: "roas_below_anchor",
          anchor: "break_even_cpa",
          consecutiveDays: 3,
        },
        action: { kind: "propose_pause" },
        mode: "confirm",
      }),
    ).toThrowError(/roas_trigger_requires_a_roas_anchor/);
  });

  it("makes hard-block unreachable for confirm and suggest modes", () => {
    expect(() =>
      validateAutomationRuleDraft({
        name: "Sneaky block",
        entityLevel: "adset",
        trigger: {
          kind: "roas_below_anchor",
          anchor: "break_even_roas",
          consecutiveDays: 3,
        },
        action: { kind: "hard_block_writes" },
        mode: "confirm",
      }),
    ).toThrowError(/hard_block_is_only_available_to_enforced_guards/);
  });

  it("requires an enforced rule to be a guard, and locks it", () => {
    expect(() =>
      validateAutomationRuleDraft({
        name: "Enforced but not a guard",
        entityLevel: "adset",
        trigger: {
          kind: "roas_below_anchor",
          anchor: "break_even_roas",
          consecutiveDays: 3,
        },
        action: { kind: "hard_block_writes" },
        mode: "enforced",
      }),
    ).toThrowError(/enforced_rules_must_use_a_guard_trigger/);

    const guard = validateAutomationRuleDraft({
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
    });
    expect(guard.mode).toBe("enforced");
    expect(isAutomationRuleLocked(guard)).toBe(true);
    expect(isAutomationRuleLocked({ mode: "confirm" })).toBe(false);
  });

  it("bounds the anchor multiplier, the day window and the budget delta", () => {
    const base = {
      name: "Bounded",
      entityLevel: "adset" as const,
      trigger: {
        kind: "roas_below_anchor",
        anchor: "break_even_roas",
        consecutiveDays: 3,
      },
      action: { kind: "propose_pause" },
      mode: "confirm" as const,
    };

    expect(() =>
      validateAutomationRuleDraft({
        ...base,
        trigger: { ...base.trigger, anchorMultiplier: 9 },
      }),
    ).toThrowError(/anchor_multiplier/);
    expect(() =>
      validateAutomationRuleDraft({
        ...base,
        trigger: { ...base.trigger, consecutiveDays: 90 },
      }),
    ).toThrowError(/consecutive_days/);
    expect(() =>
      validateAutomationRuleDraft({
        ...base,
        action: { kind: "propose_budget_increase", budgetChangePct: 400 },
      }),
    ).toThrowError(/budget_change_pct/);
    expect(() =>
      validateAutomationRuleDraft({
        ...base,
        action: { kind: "propose_pause", budgetChangePct: 20 },
      }),
    ).toThrowError(/only_valid_for_budget_actions/);
  });
});

describe("deterministic evaluation", () => {
  it("fires only when every day in the window satisfies the anchored comparison", () => {
    const fires = evaluateAutomationRules({
      rules: [rule()],
      anchors: ANCHORS,
      entities: [entity([1.94, 2.1, 2.2, 4.0])],
      asOfDate: "2026-08-16",
    });
    const verdict = fires.verdicts[0]!;
    expect(verdict.status).toBe("fires");
    expect(verdict).toMatchObject({
      ruleId: "rule_breakeven",
      entityId: "adset_1",
      outcome: "proposal",
      evaluatedForDate: "2026-08-16",
      dedupeKey: "rule_breakeven:adset_1:2026-08-16",
    });

    const notMet = evaluateAutomationRules({
      rules: [rule()],
      anchors: ANCHORS,
      entities: [entity([1.94, 2.1, 3.9, 4.0])],
      asOfDate: "2026-08-16",
    });
    expect(notMet.verdicts[0]!.status).toBe("not_met");
  });

  it("returns a deeply equal result for identical inputs, and orders verdicts stably", () => {
    const input = {
      rules: [
        rule({ id: "rule_b" }),
        rule({ id: "rule_a", name: "Scale window" }),
      ],
      anchors: ANCHORS,
      entities: [
        entity([1.0, 1.0, 1.0], { entityId: "adset_2" }),
        entity([1.0, 1.0, 1.0], { entityId: "adset_1" }),
      ],
      asOfDate: "2026-08-16",
    };
    const first = evaluateAutomationRules(input);
    const second = evaluateAutomationRules(input);

    expect(second).toEqual(first);
    expect(first.verdicts.map((verdict) => `${verdict.ruleId}/${verdict.entityId}`)).toEqual([
      "rule_a/adset_1",
      "rule_a/adset_2",
      "rule_b/adset_1",
      "rule_b/adset_2",
    ]);
  });

  it("never fires when the Commercial Truth pack does not supply the anchor", () => {
    const evaluation = evaluateAutomationRules({
      rules: [rule()],
      anchors: { ...ANCHORS, break_even_roas: null },
      entities: [entity([0.1, 0.1, 0.1])],
      asOfDate: "2026-08-16",
    });

    expect(evaluation.verdicts).toEqual([
      {
        status: "unevaluable",
        ruleId: "rule_breakeven",
        entityId: null,
        reason: "anchor_missing",
      },
    ]);
  });

  it("does not fire on partial history or a missing metric", () => {
    const short = evaluateAutomationRules({
      rules: [rule()],
      anchors: ANCHORS,
      entities: [entity([1.0, 1.0])],
      asOfDate: "2026-08-16",
    });
    expect(short.verdicts[0]).toMatchObject({
      status: "unevaluable",
      reason: "insufficient_history",
    });

    const gap = evaluateAutomationRules({
      rules: [rule()],
      anchors: ANCHORS,
      entities: [entity([1.0, null, 1.0])],
      asOfDate: "2026-08-16",
    });
    expect(gap.verdicts[0]).toMatchObject({
      status: "unevaluable",
      reason: "metric_missing",
    });
  });

  it("ignores days after asOfDate so a late warehouse row cannot change history", () => {
    const evaluation = evaluateAutomationRules({
      rules: [rule()],
      anchors: ANCHORS,
      entities: [entity([9.9, 1.0, 1.0, 1.0])],
      asOfDate: "2026-08-15",
    });
    expect(evaluation.verdicts[0]).toMatchObject({
      status: "fires",
      evaluatedForDate: "2026-08-15",
    });
  });

  it("produces no verdict-with-an-action for an inactive rule or a guard", () => {
    const evaluation = evaluateAutomationRules({
      rules: [
        rule({ active: false }),
        rule({
          id: "rule_guard",
          name: "Quiet hours",
          mode: "enforced",
          trigger: {
            kind: "quiet_hours",
            timeZone: "America/New_York",
            startHour: 0,
            endHour: 7,
          },
          action: { kind: "hard_block_writes", budgetChangePct: null },
        }),
      ],
      anchors: ANCHORS,
      entities: [entity([1.0, 1.0, 1.0])],
      asOfDate: "2026-08-16",
    });

    expect(evaluation.verdicts.map((verdict) => verdict.status)).toEqual([
      "skipped",
      "skipped",
    ]);
    expect(evaluation.verdicts.every((verdict) => verdict.status !== "fires")).toBe(
      true,
    );
  });

  it("only ever produces the proposal outcome — there is no executing branch", () => {
    const evaluation = evaluateAutomationRules({
      rules: [
        rule({ id: "r1", mode: "confirm" }),
        rule({
          id: "r2",
          mode: "suggest",
          action: { kind: "flag_for_review", budgetChangePct: null },
        }),
      ],
      anchors: ANCHORS,
      entities: [entity([1.0, 1.0, 1.0])],
      asOfDate: "2026-08-16",
    });
    const outcomes = evaluation.verdicts
      .filter((verdict) => verdict.status === "fires")
      .map((verdict) => (verdict as { outcome: string }).outcome);

    expect(outcomes).toEqual(["proposal", "proposal"]);
  });

  it("has no clock, randomness, network or provider reach in its source", () => {
    const source = readFileSync("lib/meta/automation-rules.ts", "utf8");

    expect(source).not.toContain("Date.now");
    expect(source).not.toContain("Math.random");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("graph.facebook");
    expect(source).not.toContain("@/lib/db");
    expect(source).not.toContain("googleads");
  });
});

describe("guard rules", () => {
  const guard = rule({
    id: "rule_quiet",
    name: "Quiet hours",
    mode: "enforced",
    trigger: {
      kind: "quiet_hours",
      timeZone: "America/New_York",
      startHour: 0,
      endHour: 7,
    },
    action: { kind: "hard_block_writes", budgetChangePct: null },
  });

  it("blocks inside the window and permits outside it, at an explicit instant", () => {
    // 2026-08-16T08:00Z is 04:00 in New York — inside 00:00–07:00.
    expect(
      evaluateAutomationGuardRules({
        rules: [guard],
        at: new Date("2026-08-16T08:00:00.000Z"),
      }),
    ).toMatchObject({ ruleId: "rule_quiet", ruleName: "Quiet hours" });

    // 2026-08-16T18:00Z is 14:00 in New York — outside the window.
    expect(
      evaluateAutomationGuardRules({
        rules: [guard],
        at: new Date("2026-08-16T18:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("handles a window that wraps past midnight", () => {
    expect(isWithinQuietHours(23, { startHour: 22, endHour: 7 })).toBe(true);
    expect(isWithinQuietHours(3, { startHour: 22, endHour: 7 })).toBe(true);
    expect(isWithinQuietHours(12, { startHour: 22, endHour: 7 })).toBe(false);
  });

  it("does not consult non-enforced or inactive rules", () => {
    expect(
      evaluateAutomationGuardRules({
        rules: [{ ...guard, active: false }],
        at: new Date("2026-08-16T08:00:00.000Z"),
      }),
    ).toBeNull();
    expect(
      evaluateAutomationGuardRules({
        rules: [rule()],
        at: new Date("2026-08-16T08:00:00.000Z"),
      }),
    ).toBeNull();
  });
});

describe("captions", () => {
  it("renders the anchor's live value, and an em dash when the pack does not supply it", () => {
    expect(describeTrigger(rule().trigger, ANCHORS)).toBe(
      "ROAS < breakeven (2.50) for 3 consecutive days",
    );
    expect(
      describeTrigger(rule().trigger, { ...ANCHORS, break_even_roas: null }),
    ).toBe("ROAS < breakeven (—) for 3 consecutive days");
    expect(
      describeTrigger(
        {
          kind: "roas_at_or_above_anchor",
          anchor: "target_roas",
          anchorMultiplier: 1.1,
          consecutiveDays: 12,
        },
        ANCHORS,
      ),
    ).toBe("ROAS ≥ target × 1.1 (4.18) for 12 consecutive days");
    expect(
      describeTrigger(
        {
          kind: "quiet_hours",
          timeZone: "America/New_York",
          startHour: 0,
          endHour: 7,
        },
        ANCHORS,
      ),
    ).toBe("any provider write 00:00–07:00 America/New_York");
  });

  it("describes actions in the design's language and never as an execution", () => {
    expect(describeAction({ kind: "propose_pause", budgetChangePct: null })).toBe(
      "Propose pause into the queue",
    );
    expect(
      describeAction({ kind: "propose_budget_increase", budgetChangePct: 20 }),
    ).toBe("Propose +20% budget");
    expect(
      describeAction({ kind: "propose_budget_decrease", budgetChangePct: 10 }),
    ).toBe("Propose −10% budget");
    expect(
      describeAction({ kind: "hard_block_writes", budgetChangePct: null }),
    ).toBe("Hard block · logged");
  });
});

describe("commercial anchors", () => {
  it("projects the target pack and leaves absent fields null", () => {
    expect(
      anchorsFromTargetPack({
        targetRoas: 3.8,
        breakEvenRoas: 2.5,
        targetCpa: null,
        breakEvenCpa: null,
      }),
    ).toEqual({
      target_roas: 3.8,
      break_even_roas: 2.5,
      target_cpa: null,
      break_even_cpa: null,
    });
    expect(anchorsFromTargetPack(null)).toEqual({
      target_roas: null,
      break_even_roas: null,
      target_cpa: null,
      break_even_cpa: null,
    });
  });
});
