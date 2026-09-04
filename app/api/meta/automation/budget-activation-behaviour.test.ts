/**
 * PRE-DEPLOY AUDIT — the automation toggle, exercised rather than described.
 *
 * `budget-activation-route.test.ts` proves the route's SHAPE from its source
 * text, and `budget-automation-runtime.test.ts` proves the ceremony's pure
 * function. Neither one ever sent a request, so nothing proved that an
 * authenticated admin pressing the control actually flips the persisted
 * column — or that pressing Disable works when the workspace is in the worst
 * state it can be in.
 *
 * This file sends the request. The real `POST` handler, the real ceremony and
 * the real activation server read all run; only the low-level boundaries —
 * access, the control plane and the database — are mocked, and the database
 * mock records the exact SQL and parameters the route writes.
 */
import { readFileSync } from "node:fs";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUDGET_ACTIVATION_CONFIRMATION_PHRASE } from "@/lib/meta/budget-activation";
import { DEFAULT_META_AUTOMATION_GUARDRAILS } from "@/lib/meta/automation-control-plane";

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const ACCOUNT = "act_1";
const ADMIN = "22222222-2222-4222-8222-222222222222";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(async () => [ACCOUNT]),
}));
vi.mock("@/lib/meta/reviewer-write-guard", () => ({
  rejectIfReviewerReadOnly: vi.fn(() => null),
}));
vi.mock("./demo-write-authority", () => ({
  rejectIfAutomationDemoWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/meta/automation-control-plane", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getMetaAutomationControlPlane: vi.fn(),
    setMetaAutomationDecisionTypeMode: vi.fn(async () => []),
    setMetaAutomationGuardrailPolicy: vi.fn(async () => undefined),
    releaseMetaAutomationKillSwitch: vi.fn(async () => undefined),
    engageMetaAutomationKillSwitch: vi.fn(async () => undefined),
    writeActivityLedgerRow: vi.fn(async () => undefined),
  };
});
vi.mock("@/lib/meta/budget-readiness-read-model", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readBudgetReadiness: vi.fn(async () => ({
      dimensions: [
        { key: "budget_fact_retention", status: "ready" },
        { key: "profile_output_retention", status: "ready" },
        { key: "role_authority_retention", status: "ready" },
      ],
    })),
  };
});

/** Every statement the route issues, with its parameters, in order. */
const statements: Array<{ sql: string; params: unknown[] }> = [];

const baseQuery = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
  statements.push({ sql: String(sql), params });
  const text = String(sql);
  if (text.includes("information_schema.columns")) {
    return [{
      journal_columns: 9, envelope_column: 1,
      action_constraint: 1, occurrence_index: 1,
    }];
  }
  if (text.includes("FROM meta_automation_proposals")) {
    return [{ reconciles: 0, claims: 0 }];
  }
  if (text.includes("INSERT INTO meta_automation_business_controls")) {
    return [{ guardrails_json: {} }];
  }
  if (text.includes("UPDATE meta_automation_business_controls")) {
    return [{ business_id: BUSINESS_ID }];
  }
  return [];
};

/*
  `vi.clearAllMocks()` clears CALLS, never implementations, so a test that
  installs a failing `query` would silently poison every later test in the
  file. The base implementation is restored explicitly instead.
*/
const query = vi.fn(baseQuery);

vi.mock("@/lib/db", () => ({
  getDb: () => Object.assign(
    // The control plane uses the tagged-template form; the route's own writes
    // and reads use `.query`. Both must exist on the same handle.
    (..._args: unknown[]) => Promise.resolve([]),
    { query: (sql: string, params?: unknown[]) => query(sql, params) },
  ),
}));

const access = await import("@/lib/access");
const accountAssignments = await import("@/lib/meta/creatives-fetchers");

/** Reads the shipped route source so ordering is asserted, not assumed. */
const ROUTE_POST_ORDER = () => {
  const src = readFileSync("app/api/meta/automation/route.ts", "utf8");
  const post = src.slice(src.indexOf("export async function POST"));
  const stopAt = post.indexOf(
    'action === "set_budget_auto_execution" && body?.enabled === false');
  return {
    stopAfterReviewer: stopAt > post.indexOf("rejectIfReviewerReadOnly("),
    stopAfterDemo: stopAt > post.indexOf("rejectIfAutomationDemoWrite("),
    adminFloorCoversAction:
      post.includes('action === "set_budget_auto_execution"')
      && post.includes('|| action === "save_budget_automation_config" || armsAutoExecution')
      && post.includes('? "admin"'),
  };
};
const controlPlane = await import("@/lib/meta/automation-control-plane");
const { POST } = await import("./route");

const controlPayload = (over: {
  source?: "persisted" | "default";
  dryRunOnly?: boolean;
  budgetMode?: "manual" | "semi_auto" | "auto";
  killSwitch?: boolean;
} = {}) => ({
  businessControl: {
    businessId: BUSINESS_ID,
    killSwitchEngaged: over.killSwitch ?? false,
    killSwitchReason: null,
    autoExecutionEnabled: false,
    readinessTier: "manual_review",
    guardrails: {
      ...DEFAULT_META_AUTOMATION_GUARDRAILS,
      dryRunOnly: over.dryRunOnly ?? false,
    },
    updatedAt: "2026-09-03T00:00:00.000Z",
    updatedBy: ADMIN,
    source: over.source ?? "persisted",
  },
  globalKillSwitch: { engaged: false, reason: null },
  execution: { writeEndpointsBlocked: false, autoExecutionAllowed: false, blockedReasons: [] },
  decisionTypeModes: [{ decisionType: "budget", mode: over.budgetMode ?? "auto" }],
  activityLedger: [],
  readCompleteness: {},
});

const post = (body: Record<string, unknown>) => POST(
  new NextRequest(
    `http://localhost/api/meta/automation?businessId=${BUSINESS_ID}&providerAccountId=${ACCOUNT}`,
    { method: "POST", body: JSON.stringify(body) },
  ),
);

const activationWrite = () =>
  statements.find((entry) =>
    entry.sql.includes("INSERT INTO meta_automation_business_controls")
    || entry.sql.includes("UPDATE meta_automation_business_controls")) ?? null;

describe("PRE-DEPLOY — the automation master switch, exercised", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockImplementation(baseQuery);
    // Same law: a resolved/rejected value set by one test outlives it.
    vi.mocked(accountAssignments.fetchAssignedAccountIds).mockResolvedValue([ACCOUNT]);
    statements.length = 0;
    vi.unstubAllEnvs();
    // The release gate must be open for the readiness verdict to be ready.
    vi.stubEnv("META_AUTOMATION_LIVE_WRITES", "true");
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: ADMIN } },
      membership: { businessId: BUSINESS_ID, role: "admin" },
      context: { role: "admin", reviewerReadOnly: false },
    } as never);
    vi.mocked(controlPlane.getMetaAutomationControlPlane)
      .mockResolvedValue(controlPayload() as never);
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  it("an admin with the exact phrase ENABLES, bound to the exact account", async () => {
    const response = await post({
      action: "set_budget_auto_execution",
      enabled: true,
      confirmationPhrase: BUDGET_ACTIVATION_CONFIRMATION_PHRASE,
    });
    const payload = await response.json() as { ok?: boolean; blockers?: string[] };

    expect(payload.blockers ?? [], JSON.stringify(payload)).toEqual([]);
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);

    const write = activationWrite();
    expect(write).not.toBeNull();
    // business, enabled, decidedBy, activated account — in that order.
    expect(write!.params).toEqual([
      BUSINESS_ID, true, ADMIN, ACCOUNT, "2026-09-03T00:00:00.000Z",
    ]);
    expect(write!.sql).toContain("auto_execution_provider_account_id");
    expect(write!.sql).toContain("auto_execution_enabled_by = $3::uuid");
    expect(write!.sql).toContain("updated_at = $5::timestamptz");
  });

  it("the WRONG phrase refuses, and writes nothing", async () => {
    const response = await post({
      action: "set_budget_auto_execution",
      enabled: true,
      confirmationPhrase: "enable automatic budget writes",
    });
    const payload = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(409);
    expect(payload.error?.code).toBe("confirmation_phrase_mismatch");
    expect(activationWrite()).toBeNull();
  });

  it("a later fail-safe STOP wins over enablement using stale readiness", async () => {
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql: String(sql), params });
      if (String(sql).includes("UPDATE meta_automation_business_controls")) return [];
      return baseQuery(sql, params);
    });

    const response = await post({
      action: "set_budget_auto_execution",
      enabled: true,
      confirmationPhrase: BUDGET_ACTIVATION_CONFIRMATION_PHRASE,
    });
    const payload = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(409);
    expect(payload.error?.code).toBe("budget_auto_execution_state_changed");
  });

  it("a NOT-READY workspace refuses to enable, and names why", async () => {
    // The one condition an operator most plausibly gets wrong: the persisted
    // dry-run guardrail is still engaged.
    vi.mocked(controlPlane.getMetaAutomationControlPlane)
      .mockResolvedValue(controlPayload({ dryRunOnly: true }) as never);

    const response = await post({
      action: "set_budget_auto_execution",
      enabled: true,
      confirmationPhrase: BUDGET_ACTIVATION_CONFIRMATION_PHRASE,
    });
    const payload = await response.json() as {
      error?: { code?: string }; blockers?: string[] };

    expect(response.status).toBe(409);
    expect(payload.error?.code).toBe("readiness_not_proven");
    expect(payload.blockers).toContain("dry_run_guardrail_engaged");
    expect(activationWrite()).toBeNull();
  });

  it("a business that never configured automation cannot enable", async () => {
    vi.mocked(controlPlane.getMetaAutomationControlPlane)
      .mockResolvedValue(controlPayload({ source: "default" }) as never);

    const payload = await (await post({
      action: "set_budget_auto_execution",
      enabled: true,
      confirmationPhrase: BUDGET_ACTIVATION_CONFIRMATION_PHRASE,
    })).json() as { blockers?: string[] };

    expect(payload.blockers).toContain("control_row_absent");
    expect(activationWrite()).toBeNull();
  });

  it("with the release gate CLOSED, enabling is refused", async () => {
    vi.unstubAllEnvs();
    const payload = await (await post({
      action: "set_budget_auto_execution",
      enabled: true,
      confirmationPhrase: BUDGET_ACTIVATION_CONFIRMATION_PHRASE,
    })).json() as { blockers?: string[] };

    expect(payload.blockers).toContain("global_gate_closed");
    expect(activationWrite()).toBeNull();
  });

  it.each([
    ["a stopped business", { killSwitch: true }],
    ["a Tier 1 budget mode", { budgetMode: "manual" as const }],
    ["an unconfigured control row", { source: "default" as const }],
  ])("DISABLE always works — %s, no phrase, still persists OFF", async (_label, over) => {
    /*
      A stop that could be refused is not a stop. Disable takes no phrase, no
      readiness verdict and no ceremony, and it clears the activated account so
      no scheduled run can find one.
    */
    vi.mocked(controlPlane.getMetaAutomationControlPlane)
      .mockResolvedValue(controlPayload(over) as never);

    const response = await post({
      action: "set_budget_auto_execution",
      enabled: false,
    });
    const payload = await response.json() as { ok?: boolean };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    const write = activationWrite();
    expect(write).not.toBeNull();
    // enabled false, and the activated account cleared to NULL.
    expect(write!.params[1]).toBe(false);
    expect(write!.params[3]).toBeNull();
    expect(write!.sql).toContain("auto_execution_enabled_by = NULL");
  });

  it("DISABLE still works when every readiness read FAILS", async () => {
    /*
      The control plane is unreadable and every readiness query throws.
      Enabling would be impossible; stopping must not be. The persist itself
      still works — that case is the next test.
    */
    vi.mocked(controlPlane.getMetaAutomationControlPlane)
      .mockRejectedValue(new Error("control plane unavailable"));
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = String(sql);
      if (text.includes("INSERT INTO meta_automation_business_controls")) {
        statements.push({ sql: text, params });
        return [];
      }
      throw new Error("db down");
    });

    const response = await post({
      action: "set_budget_auto_execution",
      enabled: false,
    });

    expect(response.status).toBe(200);
    expect(activationWrite()!.params[1]).toBe(false);
    expect(activationWrite()!.params[3]).toBeNull();
  });

  it("DISABLE works when the ACCOUNT-ASSIGNMENT read is unavailable", async () => {
    /*
      PRE-DEPLOY AUDIT — the defect this whole path exists for.

      `resolveAutomationAccountScope` answers 503
      `provider_account_scope_unavailable` when `fetchAssignedAccountIds`
      throws, and it used to run before the action was even looked at. So a
      provider-assignment outage could REFUSE a request to turn automatic
      execution off. It now runs after the stop.
    */
    vi.mocked(accountAssignments.fetchAssignedAccountIds)
      .mockRejectedValue(new Error("assignment API unavailable"));

    const response = await post({
      action: "set_budget_auto_execution",
      enabled: false,
    });

    expect(response.status).toBe(200);
    expect(activationWrite()!.params[1]).toBe(false);
    expect(activationWrite()!.params[3]).toBeNull();
  });

  it("DISABLE works with NO account selected at all", async () => {
    vi.mocked(accountAssignments.fetchAssignedAccountIds).mockResolvedValue([]);
    const response = await POST(
      new NextRequest(
        `http://localhost/api/meta/automation?businessId=${BUSINESS_ID}`,
        { method: "POST", body: JSON.stringify({
          action: "set_budget_auto_execution", enabled: false }) },
      ),
    );
    expect(response.status).toBe(200);
    expect(activationWrite()!.params[1]).toBe(false);
  });

  it("a STOP whose WRITE fails says so, and never reports success", async () => {
    // The one dependency a stop genuinely has. It must not read as "off".
    query.mockImplementation(async () => { throw new Error("db down"); });

    const response = await post({
      action: "set_budget_auto_execution",
      enabled: false,
    });
    const payload = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(503);
    expect(payload.error?.code).toBe("budget_auto_execution_stop_unpersisted");
  });

  it("STOP still requires ADMIN, the reviewer gate and the demo gate", async () => {
    // The fail-safe path must not become an authorization hole.
    const post2 = ROUTE_POST_ORDER();
    expect(post2.stopAfterReviewer).toBe(true);
    expect(post2.stopAfterDemo).toBe(true);
    expect(post2.adminFloorCoversAction).toBe(true);
  });

  it("`enabled` must be a real boolean — no truthy coercion", async () => {
    for (const enabled of ["true", 1, {}, null]) {
      statements.length = 0;
      const response = await post({
        action: "set_budget_auto_execution",
        enabled,
        confirmationPhrase: BUDGET_ACTIVATION_CONFIRMATION_PHRASE,
      });
      expect(response.status, JSON.stringify(enabled)).toBe(400);
      expect(activationWrite()).toBeNull();
    }
  });

  it("PREPARE saves the guardrails and never enables", async () => {
    /*
      PRE-DEPLOY AUDIT: five of six target businesses have no control row and
      the three budget policy keys had no writer at all, so the system could
      not be prepared for activation without hand-run SQL.
    */
    const response = await post({
      action: "save_budget_automation_config",
      dryRunOnly: false,
      budgetMinHoursBetweenChanges: 12,
      budgetMaxChangesPer7d: 3,
      budgetMaxAccountConcentrationPct: 40,
      maxBudgetIncreasePct: 25,
      perActionSpendCeilingMinor: 500000,
      perActionSpendCeilingCurrency: "TRY",
    });
    const payload = await response.json() as {
      ok?: boolean; saved?: boolean; autoExecutionEnabled?: boolean };

    expect(response.status).toBe(200);
    expect(payload.saved).toBe(true);
    expect(payload.autoExecutionEnabled).toBe(false);

    const write = activationWrite();
    expect(write).not.toBeNull();
    // FALSE and NULL are literals in the statement, not caller values.
    expect(write!.sql).toContain("auto_execution_enabled = FALSE");
    expect(write!.sql).toContain("auto_execution_provider_account_id = NULL");
    expect(write!.sql).toContain("auto_execution_enabled_by = NULL");
    expect(write!.sql).not.toContain("kill_switch_engaged");
    // No phrase was sent, and none was needed — this is not the enable verb.
    expect(write!.params.length).toBe(3);
  });

  it("PREPARE refuses an unvalidated value and writes nothing", async () => {
    const response = await post({
      action: "save_budget_automation_config",
      dryRunOnly: false,
      budgetMinHoursBetweenChanges: 0,
      budgetMaxChangesPer7d: 3,
      budgetMaxAccountConcentrationPct: 40,
      maxBudgetIncreasePct: 25,
      perActionSpendCeilingMinor: null,
      perActionSpendCeilingCurrency: null,
    });
    const payload = await response.json() as { error?: { code?: string } };
    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe("min_hours_between_changes_invalid");
    expect(activationWrite()).toBeNull();
  });

  it("PREPARE takes the ADMIN floor, like every other master control", async () => {
    await post({
      action: "save_budget_automation_config",
      dryRunOnly: false,
      budgetMinHoursBetweenChanges: 12,
      budgetMaxChangesPer7d: 3,
      budgetMaxAccountConcentrationPct: 40,
      maxBudgetIncreasePct: 25,
      perActionSpendCeilingMinor: null,
      perActionSpendCeilingCurrency: null,
    });
    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, minRole: "admin" }),
    );
  });

  it("PREPARE and ENABLE are different verbs, audited separately", async () => {
    const ledger = vi.mocked(controlPlane.writeActivityLedgerRow);
    await post({
      action: "save_budget_automation_config",
      dryRunOnly: false,
      budgetMinHoursBetweenChanges: 12,
      budgetMaxChangesPer7d: 3,
      budgetMaxAccountConcentrationPct: 40,
      maxBudgetIncreasePct: 25,
      perActionSpendCeilingMinor: null,
      perActionSpendCeilingCurrency: null,
    });
    expect(ledger).toHaveBeenCalledWith(expect.objectContaining({
      activityType: "budget_automation_configuration_saved",
    }));
    expect(ledger.mock.calls.map(([c]) => c.activityType))
      .not.toContain("budget_auto_execution_enabled");
  });

  it("the DISABLE act is audited", async () => {
    const ledger = vi.mocked(controlPlane.writeActivityLedgerRow);
    await post({ action: "set_budget_auto_execution", enabled: false });
    expect(ledger).toHaveBeenCalledWith(expect.objectContaining({
      activityType: "budget_auto_execution_disabled",
      severity: "warning",
    }));
  });
});
