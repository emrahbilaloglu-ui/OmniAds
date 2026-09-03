/**
 * PRE-DEPLOY AUDIT — the preparation READ, and the readiness model that
 * carries it to the form.
 *
 * The single rule these cases exist to hold: **unknown is never collapsed into
 * unset.** "This business has no control row" licenses a first save; "we could
 * not read the row" does not, because a save on that basis overwrites values
 * nobody has seen. The two states are one nullish-coalesce apart in the code
 * and worlds apart on the screen.
 */
import { describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@/lib/db", () => ({ getDb: () => ({ query }) }));

const {
  BUDGET_PREPARATION_FIELDS,
  readBudgetPreparation,
  unpreparedFields,
} = await import("@/lib/meta/budget-preparation-read");

describe("readBudgetPreparation — the three states", () => {
  it("reports every field UNKNOWN when the read fails", async () => {
    query.mockRejectedValueOnce(new Error("connection reset"));
    const view = await readBudgetPreparation({ businessId: "b1" });
    expect(view.rowRead).toBe(false);
    expect(view.rowExists).toBe(false);
    for (const key of BUDGET_PREPARATION_FIELDS) {
      expect(view[key].state, key).toBe("unknown");
      expect(view[key].value, key).toBeNull();
    }
  });

  it("reports every field UNSET when the business has no control row", async () => {
    query.mockResolvedValueOnce([]);
    const view = await readBudgetPreparation({ businessId: "b1" });
    expect(view.rowRead).toBe(true);
    expect(view.rowExists).toBe(false);
    for (const key of BUDGET_PREPARATION_FIELDS) expect(view[key].state, key).toBe("unset");
  });

  it("never reports UNKNOWN as UNSET, or the reverse", async () => {
    // The distinction, asserted directly: the same absent value produces two
    // different states depending on whether the read succeeded.
    query.mockRejectedValueOnce(new Error("down"));
    const unreadable = await readBudgetPreparation({ businessId: "b1" });
    query.mockResolvedValueOnce([]);
    const noRow = await readBudgetPreparation({ businessId: "b1" });
    expect(unreadable.dryRunOnly.state).toBe("unknown");
    expect(noRow.dryRunOnly.state).toBe("unset");
  });

  it("reports persisted values from the stored guardrail document", async () => {
    query.mockResolvedValueOnce([{
      guardrails_json: {
        dryRunOnly: false,
        budgetMinHoursBetweenChanges: 12,
        budgetMaxChangesPer7d: 3,
        budgetMaxAccountConcentrationPct: 40,
        maxBudgetIncreasePct: 25,
        perActionSpendCeilingMinor: 500000,
        perActionSpendCeilingCurrency: "TRY",
        // A key this contract does not own. It must be ignored, not surfaced.
        roasFloor: 1.8,
      },
    }]);
    const view = await readBudgetPreparation({ businessId: "b1" });
    expect(view.rowExists).toBe(true);
    expect(view.dryRunOnly).toEqual({ state: "persisted", value: false });
    expect(view.budgetMinHoursBetweenChanges).toEqual({ state: "persisted", value: 12 });
    expect(view.perActionSpendCeilingCurrency).toEqual({ state: "persisted", value: "TRY" });
    expect(Object.keys(view)).not.toContain("roasFloor");
  });

  it("reports a partially-prepared row field by field", async () => {
    query.mockResolvedValueOnce([{
      guardrails_json: { dryRunOnly: true, budgetMinHoursBetweenChanges: 6 },
    }]);
    const view = await readBudgetPreparation({ businessId: "b1" });
    expect(view.dryRunOnly.state).toBe("persisted");
    expect(view.budgetMinHoursBetweenChanges.state).toBe("persisted");
    expect(view.budgetMaxChangesPer7d.state).toBe("unset");
    expect(unpreparedFields(view)).toEqual([
      "budgetMaxChangesPer7d",
      "budgetMaxAccountConcentrationPct",
      "maxBudgetIncreasePct",
    ]);
  });

  it("refuses to read without a business, and issues no statement", async () => {
    query.mockClear();
    const view = await readBudgetPreparation({ businessId: "" });
    expect(view.rowRead).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("reads guardrails_json and nothing else", async () => {
    query.mockClear();
    query.mockResolvedValueOnce([]);
    await readBudgetPreparation({ businessId: "b1" });
    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toContain("SELECT guardrails_json");
    expect(String(sql)).toContain("FROM meta_automation_business_controls");
    // A READ. It must not be able to change a posture even by accident.
    expect(String(sql)).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(params).toEqual(["b1"]);
  });
});

describe("unpreparedFields — what activation readiness still needs", () => {
  it("treats the spend ceiling as optional and everything else as required", async () => {
    query.mockResolvedValueOnce([{
      guardrails_json: {
        dryRunOnly: false,
        budgetMinHoursBetweenChanges: 12,
        budgetMaxChangesPer7d: 3,
        budgetMaxAccountConcentrationPct: 40,
        maxBudgetIncreasePct: 25,
      },
    }]);
    const view = await readBudgetPreparation({ businessId: "b1" });
    // Clearing the ceiling is a valid saved configuration, so its absence is
    // not a missing prerequisite.
    expect(unpreparedFields(view)).toEqual([]);
  });

  it("lists every required key when nothing is prepared", async () => {
    query.mockResolvedValueOnce([]);
    const view = await readBudgetPreparation({ businessId: "b1" });
    expect(unpreparedFields(view)).toEqual([
      "dryRunOnly",
      "budgetMinHoursBetweenChanges",
      "budgetMaxChangesPer7d",
      "budgetMaxAccountConcentrationPct",
      "maxBudgetIncreasePct",
    ]);
  });

  it("lists every required key when the row could not be read", async () => {
    // Unknown is not prepared. The form must not offer a save as if the
    // prerequisites were satisfied by a read that never happened.
    query.mockRejectedValueOnce(new Error("down"));
    const view = await readBudgetPreparation({ businessId: "b1" });
    expect(unpreparedFields(view).length).toBe(5);
  });
});
