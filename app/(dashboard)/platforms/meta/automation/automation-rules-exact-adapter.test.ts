import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { MetaAutomationRule } from "@/lib/meta/automation-control-plane";

import {
  buildAutomationRulesViewModel,
  formatFiredCount,
} from "./automation-rules-exact-adapter";

const RULE: MetaAutomationRule = {
  id: "rule_1",
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
  createdAt: null,
  updatedAt: null,
};

const ANCHORS = {
  target_roas: 3.8,
  break_even_roas: 2.5,
  target_cpa: null,
  break_even_cpa: null,
};

describe("automation rules exact adapter", () => {
  it("maps a rule onto the design's five columns", () => {
    const model = buildAutomationRulesViewModel({
      payload: {
        rules: [RULE],
        commercialAnchors: ANCHORS,
        readCompleteness: { promotionRecords: "complete", rules: "complete" },
      },
      canCreate: true,
    });

    expect(model.rows).toEqual([
      {
        id: "rule_1",
        name: "Breakeven guard",
        trigger: "ROAS < breakeven (2.50) for 3 consecutive days",
        then: "Propose pause into the queue",
        mode: "Confirm",
        modeTone: "confirm",
        fired: "3× · Aug 12",
        active: true,
        locked: false,
        toggleTitle: "Toggle rule",
      },
    ]);
    expect(model.isProvenEmpty).toBe(false);
  });

  it("distinguishes a proven-empty table from an unproven read", () => {
    const provenEmpty = buildAutomationRulesViewModel({
      payload: {
        rules: [],
        commercialAnchors: ANCHORS,
        readCompleteness: { promotionRecords: "complete", rules: "complete" },
      },
      canCreate: true,
    });
    const unproven = buildAutomationRulesViewModel({
      payload: {
        rules: [],
        commercialAnchors: ANCHORS,
        readCompleteness: { promotionRecords: "complete", rules: "unavailable" },
      },
      canCreate: true,
    });
    const legacy = buildAutomationRulesViewModel({
      payload: {
        rules: [],
        commercialAnchors: ANCHORS,
        readCompleteness: { promotionRecords: "complete" },
      },
      canCreate: true,
    });

    expect(provenEmpty.rows).toEqual([]);
    expect(provenEmpty.isProvenEmpty).toBe(true);
    expect(unproven.rows).toBeNull();
    expect(legacy.rows).toBeNull();
    expect(buildAutomationRulesViewModel({ payload: null, canCreate: false }).rows).toBeNull();
  });

  it("locks the enforced guard's toggle with the design's title", () => {
    const model = buildAutomationRulesViewModel({
      payload: {
        rules: [
          {
            ...RULE,
            id: "rule_guard",
            name: "Quiet hours",
            mode: "enforced",
            locked: true,
            trigger: {
              kind: "quiet_hours",
              timeZone: "America/New_York",
              startHour: 0,
              endHour: 7,
            },
            action: { kind: "hard_block_writes", budgetChangePct: null },
          },
        ],
        commercialAnchors: ANCHORS,
        readCompleteness: { promotionRecords: "complete", rules: "complete" },
      },
      canCreate: false,
    });

    expect(model.rows?.[0]).toMatchObject({
      mode: "Enforced",
      modeTone: "enforced",
      locked: true,
      toggleTitle: "Enforced — cannot be disabled",
      then: "Hard block · logged",
    });
  });

  it("renders zero firings as a real zero, never as an invented date", () => {
    expect(formatFiredCount({ firedCount: 0, lastFiredAt: null })).toBe("0×");
    expect(formatFiredCount({ firedCount: 2, lastFiredAt: null })).toBe("2×");
    expect(
      formatFiredCount({ firedCount: 2, lastFiredAt: "not-a-date" }),
    ).toBe("2×");
  });

  it("stays pure — no fetch, clock or database reach", () => {
    const source = readFileSync(
      "app/(dashboard)/platforms/meta/automation/automation-rules-exact-adapter.ts",
      "utf8",
    );

    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("Date.now");
    expect(source).not.toContain("@/lib/db");
    expect(source).not.toContain("useState");
  });
});
