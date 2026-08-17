import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

const db = await import("@/lib/db");
const {
  AutomationRuleDuplicateNameError,
  AutomationRuleLockedError,
  AutomationRuleNotFoundError,
  countAutomationRuleFirings,
  createAutomationRule,
  listAutomationRules,
  recordAutomationGuardBlock,
  recordRuleFirings,
  setAutomationRuleActive,
} = await import("@/lib/meta/automation-rules-store");
const {
  assertAutomationProposalDraft,
  AutomationProposalContractError,
  AUTOMATION_PROPOSAL_CONTRACT_VERSION,
} = await import("@/lib/meta/automation-proposal-intake");
const { evaluateAutomationRules } = await import("@/lib/meta/automation-rules");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const USER_ID = "3f26d2f4-2f3f-4c5a-9f0c-3d0a1b2c3d4e";

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule_1",
    business_id: BUSINESS_ID,
    name: "Breakeven guard",
    entity_level: "adset",
    trigger_json: {
      kind: "roas_below_anchor",
      anchor: "break_even_roas",
      anchorMultiplier: 1,
      consecutiveDays: 3,
    },
    action_json: { kind: "propose_pause" },
    mode: "confirm",
    active: true,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rule persistence", () => {
  it("drops a stored row whose trigger no longer satisfies the state machine", async () => {
    const sql = vi.fn().mockResolvedValueOnce([
      ruleRow(),
      // A row hand-edited to carry an absolute threshold is not renderable.
      ruleRow({
        id: "rule_2",
        name: "Hand-tuned",
        trigger_json: {
          kind: "roas_below_anchor",
          anchor: "break_even_roas",
          consecutiveDays: 3,
          threshold: 2.5,
        },
      }),
      ruleRow({ id: "rule_3", name: "Broken", trigger_json: null }),
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rules = await listAutomationRules(BUSINESS_ID);

    expect(rules.map((rule) => rule.id)).toEqual(["rule_1"]);
  });

  it("rejects a duplicate rule name instead of silently overwriting", async () => {
    const sql = vi.fn().mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      createAutomationRule({
        businessId: BUSINESS_ID,
        userId: USER_ID,
        name: "Breakeven guard",
        entityLevel: "adset",
        trigger: {
          kind: "roas_below_anchor",
          anchor: "break_even_roas",
          consecutiveDays: 3,
        },
        action: { kind: "propose_pause" },
        mode: "confirm",
      }),
    ).rejects.toBeInstanceOf(AutomationRuleDuplicateNameError);
  });

  it("writes an activity-ledger record when a rule is created", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([ruleRow()])
      .mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await createAutomationRule({
      businessId: BUSINESS_ID,
      userId: USER_ID,
      name: "Breakeven guard",
      entityLevel: "adset",
      trigger: {
        kind: "roas_below_anchor",
        anchor: "break_even_roas",
        consecutiveDays: 3,
      },
      action: { kind: "propose_pause" },
      mode: "confirm",
    });

    expect(sql).toHaveBeenCalledTimes(2);
    const ledgerCall = sql.mock.calls[1]!;
    expect(String(ledgerCall[0])).toContain("meta_automation_activity_ledger");
    expect(ledgerCall).toContain("automation_rule_created");
  });
});

describe("the toggle", () => {
  it("refuses to disable an enforced guard", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([
        ruleRow({
          id: "rule_guard",
          name: "Quiet hours",
          mode: "enforced",
          trigger_json: {
            kind: "quiet_hours",
            timeZone: "America/New_York",
            startHour: 0,
            endHour: 7,
          },
          action_json: { kind: "hard_block_writes", budgetChangePct: null },
        }),
      ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      setAutomationRuleActive({
        businessId: BUSINESS_ID,
        userId: USER_ID,
        ruleId: "rule_guard",
        active: false,
      }),
    ).rejects.toBeInstanceOf(AutomationRuleLockedError);
    // The refusal happens before any UPDATE is issued.
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("refuses a rule id that belongs to another business", async () => {
    const sql = vi.fn().mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      setAutomationRuleActive({
        businessId: BUSINESS_ID,
        userId: USER_ID,
        ruleId: "rule_from_elsewhere",
        active: false,
      }),
    ).rejects.toBeInstanceOf(AutomationRuleNotFoundError);
  });

  it("disables an unlocked rule and records it", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([ruleRow()])
      .mockResolvedValueOnce([ruleRow({ active: false })])
      .mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const updated = await setAutomationRuleActive({
      businessId: BUSINESS_ID,
      userId: USER_ID,
      ruleId: "rule_1",
      active: false,
    });

    expect(updated.active).toBe(false);
    expect(sql.mock.calls[2]).toContain("automation_rule_disabled");
  });
});

describe("firings and the 28-day count", () => {
  it("counts real events over an explicit window", async () => {
    const sql = vi.fn().mockResolvedValueOnce([
      { rule_id: "rule_1", fired_count: "3", last_fired_at: "2026-08-12T09:00:00.000Z" },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const counts = await countAutomationRuleFirings({
      businessId: BUSINESS_ID,
      asOf: new Date("2026-08-16T00:00:00.000Z"),
    });

    expect(counts.get("rule_1")).toEqual({
      ruleId: "rule_1",
      firedCount: 3,
      lastFiredAt: "2026-08-12T09:00:00.000Z",
    });
    // 28 days before the explicit asOf, not before "now".
    expect(sql.mock.calls[0]).toContain("2026-07-19T00:00:00.000Z");
  });

  it("raises exactly one confirmation-queue proposal per firing, never a provider write", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: "firing_1" }])
      .mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rules = await listAutomationRulesFromRow();
    const evaluation = evaluateAutomationRules({
      rules,
      anchors: {
        target_roas: 3.8,
        break_even_roas: 2.5,
        target_cpa: null,
        break_even_cpa: null,
      },
      entities: [
        {
          entityLevel: "adset",
          entityId: "adset_1",
          entityName: "Retargeting 7d — DPA",
          providerAccountId: "act_1",
          daily: [
            { date: "2026-08-16", roas: 1.9, cpa: null, spend: 100, revenue: 190 },
            { date: "2026-08-15", roas: 1.8, cpa: null, spend: 100, revenue: 180 },
            { date: "2026-08-14", roas: 1.7, cpa: null, spend: 100, revenue: 170 },
          ],
        },
      ],
      asOfDate: "2026-08-16",
    });

    const sink = vi.fn().mockResolvedValue({
      proposalId: "proposal_1",
      status: "inserted",
    });
    const recorded = await recordRuleFirings({
      businessId: BUSINESS_ID,
      rules,
      verdicts: evaluation.verdicts,
      proposalSink: sink,
    });

    expect(recorded).toEqual([
      {
        ruleId: "rule_1",
        entityId: "adset_1",
        evaluatedForDate: "2026-08-16",
        outcome: "proposal_raised",
        proposalId: "proposal_1",
        inserted: true,
      },
    ]);
    expect(sink).toHaveBeenCalledTimes(1);
    const draft = sink.mock.calls[0]![0];
    expect(draft).toMatchObject({
      contractVersion: AUTOMATION_PROPOSAL_CONTRACT_VERSION,
      sourceKind: "automation_rule",
      proposedAction: "pause",
      requiresConfirmation: true,
      autoExecute: false,
      dedupeKey: "rule_1:adset_1:2026-08-16",
    });
  });

  it("is a no-op on re-run over the same warehouse day", async () => {
    // ON CONFLICT DO NOTHING returns no row the second time.
    const sql = vi.fn().mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rules = await listAutomationRulesFromRow();
    const sink = vi
      .fn()
      .mockResolvedValue({ proposalId: "proposal_1", status: "already_present" });

    const recorded = await recordRuleFirings({
      businessId: BUSINESS_ID,
      rules,
      verdicts: [
        {
          status: "fires",
          ruleId: "rule_1",
          entityId: "adset_1",
          entityLevel: "adset",
          entityName: null,
          providerAccountId: "act_1",
          outcome: "proposal",
          evaluatedForDate: "2026-08-16",
          dedupeKey: "rule_1:adset_1:2026-08-16",
          reason: "Breakeven guard: ROAS below breakeven 2.50 for 3 consecutive days.",
          evidence: {
            anchor: "break_even_roas",
            anchorValue: 2.5,
            threshold: 2.5,
            consecutiveDays: 3,
            observed: [],
          },
        },
      ],
      proposalSink: sink,
    });

    expect(recorded[0]!.inserted).toBe(false);
    // No UPDATE for the proposal link when nothing was inserted.
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("records a guard block as a firing so the Enforced row's count is real", async () => {
    const sql = vi.fn().mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await recordAutomationGuardBlock({
      businessId: BUSINESS_ID,
      ruleId: "rule_guard",
      ruleName: "Quiet hours",
      reason: "Quiet hours: provider writes are hard-blocked.",
      providerAccountId: "act_1",
      at: new Date("2026-08-16T04:30:00.000Z"),
    });

    const call = sql.mock.calls[0]!;
    const template = (call[0] as unknown as string[]).join("?");
    expect(template).toContain("meta_automation_rule_firings");
    expect(template).toContain("hard_block_recorded");
    expect(template).toContain("ON CONFLICT (rule_id, entity_id, evaluated_for_date) DO NOTHING");
    expect(call).toContain("2026-08-16");
  });
});

describe("the intake contract", () => {
  const draft = {
    contractVersion: AUTOMATION_PROPOSAL_CONTRACT_VERSION,
    businessId: BUSINESS_ID,
    providerAccountId: "act_1",
    sourceKind: "automation_rule" as const,
    sourceId: "rule_1",
    sourceName: "Breakeven guard",
    proposedAction: "pause" as const,
    entityLevel: "adset" as const,
    entityId: "adset_1",
    entityName: null,
    reason: "…",
    evidenceLabel: "breakeven 2.50 · 3d",
    evidence: {},
    dedupeKey: "rule_1:adset_1:2026-08-16",
    evaluatedForDate: "2026-08-16",
    requiresConfirmation: true as const,
    autoExecute: false as const,
  };

  it("accepts a well-formed draft", () => {
    expect(assertAutomationProposalDraft(draft)).toBe(draft);
  });

  it("refuses a draft that claims it may execute or skip confirmation", () => {
    expect(() =>
      assertAutomationProposalDraft({
        ...draft,
        autoExecute: true as unknown as false,
      }),
    ).toThrowError(AutomationProposalContractError);
    expect(() =>
      assertAutomationProposalDraft({
        ...draft,
        requiresConfirmation: false as unknown as true,
      }),
    ).toThrowError(/requires_confirmation_must_be_true/);
  });

  it("refuses a draft naming an action with no guarded endpoint", () => {
    // A queue row promises "approving executes inside the guardrails above".
    // A draft for an action the guarded write path cannot perform would be a
    // primary button that can only fail, so the sink never persists one.
    expect(() =>
      assertAutomationProposalDraft({
        ...draft,
        proposedAction: "budget_increase" as unknown as "pause",
      }),
    ).toThrowError(/proposed_action_has_no_guarded_endpoint/);
  });

  it("refuses a draft with no account scope, which no account queue could show", () => {
    expect(() =>
      assertAutomationProposalDraft({ ...draft, providerAccountId: "  " }),
    ).toThrowError(/provider_account_id_is_required/);
  });

  it("keeps every provider client out of the engine's persistence layer", () => {
    for (const file of [
      "lib/meta/automation-rules-store.ts",
      "lib/meta/automation-proposal-intake.ts",
      "lib/meta/automation-rules-evaluation.ts",
      "lib/meta/automation-rules.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("graph.facebook");
      expect(source).not.toContain("ads-write");
      expect(source).not.toContain("googleads");
      expect(source).not.toContain("fetch(");
    }
  });
});

async function listAutomationRulesFromRow() {
  const sql = vi.fn().mockResolvedValueOnce([ruleRow()]);
  const previous = vi.mocked(db.getDb).getMockImplementation();
  vi.mocked(db.getDb).mockReturnValueOnce(sql as never);
  const rules = await listAutomationRules(BUSINESS_ID);
  if (previous) vi.mocked(db.getDb).mockImplementation(previous);
  return rules;
}
