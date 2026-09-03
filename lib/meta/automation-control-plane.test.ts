import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_BUSINESS_ID } from "@/lib/demo-business-support";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const db = await import("@/lib/db");
const {
  engageMetaAutomationKillSwitch,
  getMetaAutomationControlPlane,
  getMetaWriteBlockState,
  readEffectiveMetaWriteGovernance,
  isGlobalMetaAdsWriteKillSwitchEngaged,
  setMetaAutomationDecisionTypeMode,
  setMetaAutomationGuardrailPolicy,
} = await import("@/lib/meta/automation-control-plane");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

describe("meta automation control plane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("normalizes the global Meta write kill switch like the UI banner", () => {
    expect(
      isGlobalMetaAdsWriteKillSwitchEngaged({
        META_ADS_WRITE_KILL_SWITCH: " true ",
      } as never),
    ).toBe(true);
    expect(
      isGlobalMetaAdsWriteKillSwitchEngaged({
        META_ADS_WRITE_KILL_SWITCH: "YES",
      } as never),
    ).toBe(true);
    expect(
      isGlobalMetaAdsWriteKillSwitchEngaged({
        META_ADS_WRITE_KILL_SWITCH: "0",
      } as never),
    ).toBe(false);
  });

  it("returns persisted controls, promotion records, and activity without claiming auto execution", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([
        {
          business_id: BUSINESS_ID,
          kill_switch_engaged: false,
          kill_switch_reason: null,
          auto_execution_enabled: true,
          readiness_tier: "backtest_candidate",
          guardrails_json: {
            dailyAutoActionCap: 4,
            perActionSpendCeilingMinor: 7500,
            perActionSpendCeilingCurrency: "EUR",
            notificationPolicy: "every_auto_action",
            maxBudgetIncreasePct: 10,
            requireCampaignLabel: true,
            requireCommercialAnchor: true,
            requireLivePreflight: true,
            requireRollbackPlan: true,
            dryRunOnly: true,
          },
          updated_at: "2026-07-07T10:00:00.000Z",
          updated_by: "user_1",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "promo_1",
          rec_id: "rec_1",
          entity_type: "adset",
          entity_id: "adset_1",
          source_tier: "manual_review",
          target_tier: "backtest_candidate",
          status: "approved",
          reason: "Backtest ready.",
          created_at: "2026-07-07T10:05:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "act_1",
          activity_type: "guardrail_updated",
          severity: "info",
          message: "Guardrails updated.",
          payload_json: { maxBudgetIncreasePct: 10 },
          created_at: "2026-07-07T10:06:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "log_1",
          action: "pause",
          status: "failure",
          error_code: "kill_switch_engaged",
          error_message: "Meta writes are disabled.",
          requested_at: "2026-07-07T10:07:00.000Z",
          payload_request: { endpoint: "/ad_1" },
        },
      ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const payload = await getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });

    expect(payload.contractVersion).toBe("meta-automation-control-plane.v1");
    expect(payload.providerAccountId).toBe("act_1");
    expect(payload.businessControl.source).toBe("persisted");
    expect(payload.businessControl.guardrails.dailyAutoActionCap).toBe(4);
    expect(payload.businessControl.guardrails.perActionSpendCeilingMinor).toBe(
      7500,
    );
    expect(payload.businessControl.guardrails.maxBudgetIncreasePct).toBe(10);
    expect(payload.promotionRecords).toHaveLength(1);
    expect(payload.readCompleteness?.promotionRecords).toBe("complete");
    expect(payload.activityLedger[0]?.message).toBe(
      "Meta write blocked by kill switch.",
    );
    expect(payload.execution.autoExecutionAllowed).toBe(false);
    expect(payload.execution.blockedReasons).toContain(
      "dry_run_only_guardrail",
    );
    expect(sql.mock.calls.flat()).toContain("act_1");
    const actionLedgerQuery = String(sql.mock.calls[3]?.[0] ?? "");
    expect(actionLedgerQuery).not.toMatch(/\baccount_id\s*=/);
    expect(actionLedgerQuery).toContain("meta_ad_dimensions");
    expect(actionLedgerQuery).toContain("meta_campaign_dimensions");
    expect(actionLedgerQuery).toContain("meta_adset_dimensions");
    expect(actionLedgerQuery).toContain("meta_launch_intents");
  });

  it("marks promotion records unavailable when that collection read fails", async () => {
    const sql = vi.fn(async (parts: TemplateStringsArray) => {
      const query = Array.from(parts).join("?");
      if (query.includes("LEFT JOIN meta_automation_business_controls")) {
        return [
          {
            business_id: BUSINESS_ID,
            kill_switch_engaged: false,
            kill_switch_reason: null,
            auto_execution_enabled: false,
            readiness_tier: "manual_review",
            guardrails_json: {},
            updated_at: "2026-08-17T08:00:00.000Z",
            updated_by: "user_1",
          },
        ];
      }
      if (query.includes("FROM meta_automation_promotion_records")) {
        throw Object.assign(new Error("promotion table unavailable"), {
          code: "57P01",
        });
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const payload = await getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });

    expect(payload.businessControl.source).toBe("persisted");
    expect(payload.promotionRecords).toEqual([]);
    expect(payload.readCompleteness?.promotionRecords).toBe("unavailable");
  });

  it("keeps account-scoped action activity when the optional LaunchIntent table is not migrated", async () => {
    const missingLaunchIntents = Object.assign(
      new Error('relation "meta_launch_intents" does not exist'),
      { code: "42P01" },
    );
    const sql = vi.fn(async (parts: TemplateStringsArray) => {
      const query = Array.from(parts).join("?");
      if (query.includes("FROM meta_automation_business_controls")) return [];
      if (query.includes("FROM meta_automation_promotion_records")) return [];
      if (query.includes("FROM meta_automation_activity_ledger")) return [];
      if (query.includes("meta_launch_intents")) throw missingLaunchIntents;
      if (query.includes("FROM meta_ads_action_log")) {
        return [
          {
            id: "log_fallback",
            action: "pause",
            status: "success",
            error_code: null,
            error_message: null,
            requested_at: "2026-07-11T09:00:00.000Z",
            payload_request: { endpoint: "/ad_iwa" },
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const payload = await getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_iwa",
    });

    expect(payload.activityLedger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "meta-action-log_fallback",
          message: "Meta pause completed.",
        }),
      ]),
    );
    expect(payload.promotionRecords).toEqual([]);
    expect(payload.readCompleteness?.promotionRecords).toBe("complete");
    const actionQueries = sql.mock.calls
      .map((call) => Array.from(call[0] as TemplateStringsArray).join("?"))
      .filter((query) => query.includes("FROM meta_ads_action_log"));
    expect(actionQueries).toHaveLength(2);
    expect(actionQueries[0]).toContain("meta_launch_intents");
    expect(actionQueries[1]).not.toContain("meta_launch_intents");
    expect(actionQueries[1]).toContain("meta_ad_dimensions");
    expect(actionQueries[1]).toContain("meta_campaign_dimensions");
    expect(actionQueries[1]).toContain("meta_adset_dimensions");
  });

  it("carries the persisted guardrail policy and the typed activity tuple end to end", async () => {
    const sql = vi.fn(async (parts: TemplateStringsArray) => {
      const query = Array.from(parts).join("?");
      if (query.includes("LEFT JOIN meta_automation_business_controls")) {
        expect(query).toContain("control.min_roas_floor");
        return [
          {
            business_id: BUSINESS_ID,
            kill_switch_engaged: false,
            kill_switch_reason: null,
            auto_execution_enabled: false,
            readiness_tier: "manual_review",
            guardrails_json: {},
            updated_at: "2026-08-17T08:00:00.000Z",
            updated_by: "user_1",
            min_roas_floor: "2.5000",
            quiet_hours_start: "00:00:00",
            quiet_hours_end: "07:00:00",
            quiet_hours_timezone: "ET",
          },
        ];
      }
      if (query.includes("FROM meta_automation_activity_ledger ledger")) {
        return [
          {
            id: "act_tuple",
            activity_type: "decision_type_mode_change",
            severity: "info",
            message: "budget standing mode set to semi_auto.",
            payload_json: {},
            created_at: "2026-08-17T09:00:00.000Z",
            actor_kind: "operator",
            actor_user_id: "user_1",
            actor_name: "Emrah B.",
            entity_type: "automation_decision_type",
            entity_id: "budget",
            entity_name: null,
            result_status: "recorded",
            result_receipt_id: "promo_9",
          },
        ];
      }
      if (query.includes("clean_approvals")) {
        return [{ clean_approvals: 18 }];
      }
      if (query.includes("FROM meta_ads_action_log log")) {
        return [
          {
            id: "log_1",
            action: "pause",
            status: "success",
            error_code: null,
            error_message: null,
            requested_at: "2026-08-17T08:30:00.000Z",
            payload_request: {},
            requested_by: "user_1",
            resulting_ad_id: null,
            actor_name: "Emrah B.",
            entity_type: "adset",
            entity_id: "23851",
            entity_name: "Retargeting 7d — DPA",
          },
        ];
      }
      if (query.includes("FROM meta_automation_decision_type_modes")) {
        return [
          {
            decision_type: "pause",
            mode: "manual",
            lock_reason: null,
            updated_at: "2026-08-01T00:00:00.000Z",
            updated_by: "user_1",
            clean_approval_threshold: 30,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const payload = await getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });

    expect(payload.businessControl.guardrails.minRoasFloor).toBe(2.5);
    expect(payload.businessControl.guardrails.quietHours).toEqual({
      start: "00:00",
      end: "07:00",
      timezone: "ET",
    });
    const ledgerRow = payload.activityLedger.find(
      (item) => item.id === "act_tuple",
    );
    expect(ledgerRow?.actor).toEqual({
      kind: "operator",
      userId: "user_1",
      name: "Emrah B.",
    });
    expect(ledgerRow?.entity).toEqual({
      type: "automation_decision_type",
      id: "budget",
      name: null,
    });
    expect(ledgerRow?.result).toEqual({
      status: "recorded",
      receiptId: "promo_9",
    });
    const actionRow = payload.activityLedger.find(
      (item) => item.id === "meta-action-log_1",
    );
    expect(actionRow?.actor?.name).toBe("Emrah B.");
    expect(actionRow?.entity).toEqual({
      type: "adset",
      id: "23851",
      name: "Retargeting 7d — DPA",
    });
    expect(actionRow?.result).toEqual({ status: "applied", receiptId: null });
    const pause = payload.decisionTypeModes.find(
      (item) => item.decisionType === "pause",
    );
    expect(pause?.cleanApprovalThreshold).toBe(30);
    expect(pause?.cleanApprovalStreak).toBe(18);
    expect(payload.readCompleteness?.cleanApprovalStreaks).toBe("complete");
    // No provider-write channel exists for budget, so its streak stays absent
    // instead of being reported as zero.
    const budget = payload.decisionTypeModes.find(
      (item) => item.decisionType === "budget",
    );
    expect(budget?.cleanApprovalStreak).toBeNull();
  });

  it("keeps the ledger and the control row readable on a pre-migration schema", async () => {
    const missingColumn = Object.assign(
      new Error('column "actor_kind" does not exist'),
      { code: "42703" },
    );
    const sql = vi.fn(async (parts: TemplateStringsArray) => {
      const query = Array.from(parts).join("?");
      if (
        query.includes("control.min_roas_floor") ||
        query.includes("ledger.actor_kind") ||
        query.includes("clean_approval_threshold")
      ) {
        throw missingColumn;
      }
      if (query.includes("LEFT JOIN meta_automation_business_controls")) {
        return [
          {
            business_id: BUSINESS_ID,
            kill_switch_engaged: true,
            kill_switch_reason: "Owner stop.",
            auto_execution_enabled: false,
            readiness_tier: "manual_review",
            guardrails_json: {},
            updated_at: "2026-08-17T08:00:00.000Z",
            updated_by: "user_1",
          },
        ];
      }
      if (query.includes("FROM meta_automation_activity_ledger")) {
        return [
          {
            id: "legacy_row",
            activity_type: "business_kill_switch_engaged",
            severity: "danger",
            message: "Business kill switch engaged.",
            payload_json: {},
            created_at: "2026-08-17T09:00:00.000Z",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const payload = await getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });

    expect(payload.businessControl.source).toBe("persisted");
    expect(payload.businessControl.killSwitchEngaged).toBe(true);
    expect(payload.businessControl.guardrails.minRoasFloor).toBeNull();
    expect(payload.businessControl.guardrails.quietHours).toBeNull();
    const legacy = payload.activityLedger.find(
      (item) => item.id === "legacy_row",
    );
    expect(legacy?.message).toBe("Business kill switch engaged.");
    expect(legacy?.actor).toBeNull();
    expect(legacy?.entity).toBeNull();
    expect(legacy?.result).toBeNull();
  });

  it("refuses to present a streak the read could not prove", async () => {
    const sql = vi.fn(async (parts: TemplateStringsArray) => {
      const query = Array.from(parts).join("?");
      if (query.includes("clean_approvals")) {
        throw Object.assign(new Error("statement timeout"), { code: "57014" });
      }
      if (query.includes("FROM meta_automation_decision_type_modes")) {
        return [
          {
            decision_type: "pause",
            mode: "manual",
            lock_reason: null,
            updated_at: "2026-08-01T00:00:00.000Z",
            updated_by: "user_1",
            clean_approval_threshold: 30,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const payload = await getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });

    expect(payload.readCompleteness?.cleanApprovalStreaks).toBe("unavailable");
    expect(
      payload.decisionTypeModes.find((item) => item.decisionType === "pause")
        ?.cleanApprovalStreak,
    ).toBeNull();
  });

  it("counts a clean approval streak from the later of the tier start and the last failure", async () => {
    const queries: string[] = [];
    const params: unknown[][] = [];
    const sql = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = Array.from(parts).join("?");
      queries.push(query);
      params.push(values);
      if (query.includes("clean_approvals")) return [{ clean_approvals: 4 }];
      if (query.includes("FROM meta_automation_decision_type_modes")) {
        return [
          {
            decision_type: "pause",
            mode: "manual",
            lock_reason: null,
            updated_at: "2026-08-01T00:00:00.000Z",
            updated_by: "user_1",
            clean_approval_threshold: 12,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const payload = await getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });

    const streakQuery = queries.find((query) =>
      query.includes("clean_approvals"),
    );
    expect(streakQuery).toContain("failed.status IN ('failure', 'silent_failure')");
    expect(streakQuery).toContain("log.requested_by IS NOT NULL");
    expect(streakQuery).toContain("log.status = 'success'");
    expect(params.flat()).toContain("2026-08-01T00:00:00.000Z");
    expect(
      payload.decisionTypeModes.find((item) => item.decisionType === "pause")
        ?.cleanApprovalStreak,
    ).toBe(4);
  });

  it("persists the guardrail policy and stamps the ledger tuple for it", async () => {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const sql = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = Array.from(parts).join("?");
      calls.push({ query, values });
      if (query.includes("INSERT INTO meta_automation_business_controls")) {
        return [
          {
            business_id: BUSINESS_ID,
            kill_switch_engaged: false,
            kill_switch_reason: null,
            auto_execution_enabled: false,
            readiness_tier: "manual_review",
            guardrails_json: {},
            updated_at: "2026-08-17T10:00:00.000Z",
            updated_by: "user_1",
            min_roas_floor: "2.5000",
            quiet_hours_start: "00:00:00",
            quiet_hours_end: "07:00:00",
            quiet_hours_timezone: "ET",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const control = await setMetaAutomationGuardrailPolicy({
      businessId: BUSINESS_ID,
      userId: "user_1",
      minRoasFloor: 2.5,
      quietHours: { start: "00:00", end: "07:00", timezone: "ET" },
    });

    expect(control.guardrails.minRoasFloor).toBe(2.5);
    expect(control.guardrails.quietHours).toEqual({
      start: "00:00",
      end: "07:00",
      timezone: "ET",
    });
    const ledgerInsert = calls.find((call) =>
      call.query.includes("INSERT INTO meta_automation_activity_ledger"),
    );
    expect(ledgerInsert?.query).toContain("actor_kind");
    expect(ledgerInsert?.values).toContain("operator");
    expect(ledgerInsert?.values).toContain("business");
    expect(ledgerInsert?.values).toContain("applied");
  });

  it("stamps a decision-type mode change with its promotion record as the receipt", async () => {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const sql = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = Array.from(parts).join("?");
      calls.push({ query, values });
      if (query.includes("INSERT INTO meta_automation_promotion_records")) {
        return [{ id: "promo_created" }];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await setMetaAutomationDecisionTypeMode({
      businessId: BUSINESS_ID,
      decisionType: "pause",
      mode: "semi_auto",
      userId: "user_1",
      cleanApprovalThreshold: 30,
    });

    const modeUpsert = calls.find((call) =>
      call.query.includes("INSERT INTO meta_automation_decision_type_modes"),
    );
    expect(modeUpsert?.query).toContain("clean_approval_threshold");
    expect(modeUpsert?.values).toContain(30);
    const ledgerInsert = calls.find((call) =>
      call.query.includes("INSERT INTO meta_automation_activity_ledger"),
    );
    expect(ledgerInsert?.values).toContain("automation_decision_type");
    expect(ledgerInsert?.values).toContain("pause");
    expect(ledgerInsert?.values).toContain("recorded");
    expect(ledgerInsert?.values).toContain("promo_created");
  });

  it("engages the business kill switch and records an activity row", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([
        {
          business_id: BUSINESS_ID,
          kill_switch_engaged: true,
          kill_switch_reason: "Emergency stop.",
          auto_execution_enabled: false,
          readiness_tier: "manual_review",
          guardrails_json: {},
          updated_at: "2026-07-08T10:00:00.000Z",
          updated_by: "user_1",
        },
      ])
      .mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const control = await engageMetaAutomationKillSwitch({
      businessId: BUSINESS_ID,
      userId: "user_1",
      reason: "Emergency stop.",
    });

    expect(control.killSwitchEngaged).toBe(true);
    expect(control.killSwitchReason).toBe("Emergency stop.");
    expect(control.guardrails.dailyAutoActionCap).toBe(3);
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it("blocks writes from business kill-switch state when write-guard DB reads are enabled in tests", async () => {
    vi.stubEnv("META_AUTOMATION_WRITE_GUARD_TEST_READS", "1");
    const sql = vi.fn().mockResolvedValueOnce([
      {
        business_id: BUSINESS_ID,
        kill_switch_engaged: true,
        kill_switch_reason: "Owner paused automation.",
        auto_execution_enabled: false,
        readiness_tier: "manual_review",
        guardrails_json: {},
        updated_at: "2026-07-07T10:00:00.000Z",
        updated_by: null,
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const block = await getMetaWriteBlockState({ businessId: BUSINESS_ID });

    expect(block).toMatchObject({
      blocked: true,
      reason: "business_kill_switch",
      message: "Owner paused automation.",
    });
  });

  it("blocks every Meta write for a demo business before provider execution", async () => {
    vi.stubEnv("META_AUTOMATION_WRITE_GUARD_TEST_READS", "1");
    const sql = vi.fn().mockResolvedValueOnce([
      {
        business_id: null,
        is_demo_business: true,
        kill_switch_engaged: null,
        kill_switch_reason: null,
        auto_execution_enabled: null,
        readiness_tier: null,
        guardrails_json: null,
        updated_at: null,
        updated_by: null,
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const block = await getMetaWriteBlockState({ businessId: BUSINESS_ID });

    expect(block).toEqual({
      blocked: true,
      reason: "demo_business_read_only",
      message: "Meta writes are disabled for synthetic demo businesses.",
    });
  });

  it("blocks the immutable demo business id without depending on DB state or the test bypass", async () => {
    const block = await getMetaWriteBlockState({
      businessId: ` ${DEMO_BUSINESS_ID} `,
    });

    expect(block).toEqual({
      blocked: true,
      reason: "demo_business_read_only",
      message: "Meta writes are disabled for synthetic demo businesses.",
    });
    expect(db.getDb).not.toHaveBeenCalled();
  });

  it("fails closed when the business row is missing", async () => {
    vi.stubEnv("META_AUTOMATION_WRITE_GUARD_TEST_READS", "1");
    const sql = vi.fn().mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const block = await getMetaWriteBlockState({ businessId: BUSINESS_ID });

    expect(block).toEqual({
      blocked: true,
      reason: "control_state_unavailable",
      message:
        "Meta writes are temporarily blocked because automation control state could not be verified.",
    });
  });

  it("keeps decisions readable but blocks writes when the business has no persisted controls", async () => {
    vi.stubEnv("META_AUTOMATION_WRITE_GUARD_TEST_READS", "1");
    const sql = vi.fn().mockResolvedValue([
      {
        business_id: null,
        is_demo_business: false,
        kill_switch_engaged: null,
        kill_switch_reason: null,
        auto_execution_enabled: null,
        readiness_tier: null,
        guardrails_json: null,
        updated_at: null,
        updated_by: null,
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      readEffectiveMetaWriteGovernance({ businessId: BUSINESS_ID }),
    ).resolves.toEqual({
      verified: true,
      controlsConfigured: false,
      writeBlocked: true,
      blockReason: "business_control_not_configured",
      killSwitchEngaged: false,
      killSwitchReason: null,
    });
    await expect(
      getMetaWriteBlockState({ businessId: BUSINESS_ID }),
    ).resolves.toEqual({
      blocked: true,
      reason: "control_state_unavailable",
      message:
        "Meta writes are blocked because this business has no persisted automation control state.",
    });
  });

  it("fails closed when business kill-switch state cannot be verified", async () => {
    vi.stubEnv("META_AUTOMATION_WRITE_GUARD_TEST_READS", "1");
    const dbError = Object.assign(new Error("database unavailable"), {
      code: "57P01",
    });
    const sql = vi.fn().mockRejectedValueOnce(dbError);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const block = await getMetaWriteBlockState({ businessId: BUSINESS_ID });

    expect(block).toMatchObject({
      blocked: true,
      reason: "control_state_unavailable",
      message:
        "Meta writes are temporarily blocked because automation control state could not be verified.",
    });
  });

  it("fails closed when the automation control table is unavailable", async () => {
    vi.stubEnv("META_AUTOMATION_WRITE_GUARD_TEST_READS", "1");
    const missingTable = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    const sql = vi.fn().mockRejectedValueOnce(missingTable);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const block = await getMetaWriteBlockState({ businessId: BUSINESS_ID });

    expect(block).toMatchObject({
      blocked: true,
      reason: "control_state_unavailable",
      message:
        "Meta writes are temporarily blocked because automation control state could not be verified.",
    });
  });
});

describe("enforced guard rules at the write boundary", () => {
  const OPEN_CONTROL_ROW = {
    business_id: BUSINESS_ID,
    is_demo_business: false,
    kill_switch_engaged: false,
    kill_switch_reason: null,
    auto_execution_enabled: false,
    readiness_tier: "manual_review",
    guardrails_json: {},
    updated_at: "2026-08-17T08:00:00.000Z",
    updated_by: "user_1",
  };

  const QUIET_HOURS_ROW = {
    id: "rule_quiet",
    business_id: BUSINESS_ID,
    name: "Quiet hours",
    entity_level: "adset",
    trigger_json: {
      kind: "quiet_hours",
      timeZone: "America/New_York",
      startHour: 0,
      endHour: 7,
    },
    action_json: { kind: "hard_block_writes", budgetChangePct: null },
    mode: "enforced",
    active: true,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };

  function sqlWith(rulesResult: unknown) {
    return vi.fn(async (parts: TemplateStringsArray) => {
      const query = Array.from(parts).join("?");
      if (query.includes("LEFT JOIN meta_automation_business_controls")) {
        return [OPEN_CONTROL_ROW];
      }
      if (query.includes("FROM meta_automation_rules")) {
        if (rulesResult instanceof Error) throw rulesResult;
        return rulesResult;
      }
      return [];
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("META_AUTOMATION_WRITE_GUARD_TEST_READS", "1");
  });

  it("hard-blocks a provider write inside the guard window", async () => {
    vi.mocked(db.getDb).mockReturnValue(sqlWith([QUIET_HOURS_ROW]) as never);

    const block = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      // 04:00 in New York.
      at: new Date("2026-08-16T08:00:00.000Z"),
    });

    expect(block).toMatchObject({
      blocked: true,
      reason: "automation_guard_rule",
      guardRule: { id: "rule_quiet", name: "Quiet hours" },
    });
  });

  it("permits the write outside the window, leaving today's behaviour unchanged", async () => {
    vi.mocked(db.getDb).mockReturnValue(sqlWith([QUIET_HOURS_ROW]) as never);

    const block = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      // 14:00 in New York.
      at: new Date("2026-08-16T18:00:00.000Z"),
    });

    expect(block).toEqual({ blocked: false, reason: null, message: null });
  });

  it("keeps an un-migrated database on its existing behaviour", async () => {
    const missingTable = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    vi.mocked(db.getDb).mockReturnValue(sqlWith(missingTable) as never);

    const block = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      at: new Date("2026-08-16T08:00:00.000Z"),
    });

    expect(block).toEqual({ blocked: false, reason: null, message: null });
  });

  it("fails closed when guard rules cannot be read at all", async () => {
    const dbError = Object.assign(new Error("database unavailable"), {
      code: "57P01",
    });
    vi.mocked(db.getDb).mockReturnValue(sqlWith(dbError) as never);

    const block = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      at: new Date("2026-08-16T18:00:00.000Z"),
    });

    expect(block).toMatchObject({
      blocked: true,
      reason: "control_state_unavailable",
    });
  });

  it("never lets a guard rule lift an existing block", async () => {
    const sql = vi.fn(async (parts: TemplateStringsArray) => {
      const query = Array.from(parts).join("?");
      if (query.includes("LEFT JOIN meta_automation_business_controls")) {
        return [
          {
            ...OPEN_CONTROL_ROW,
            kill_switch_engaged: true,
            kill_switch_reason: "Owner paused automation.",
          },
        ];
      }
      return [QUIET_HOURS_ROW];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const block = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      at: new Date("2026-08-16T18:00:00.000Z"),
    });

    expect(block).toMatchObject({
      blocked: true,
      reason: "business_kill_switch",
    });
  });
});

describe("rules in the control-plane payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("serves persisted rules with their real 28-day counts and the live anchors", async () => {
    const sql = vi.fn(async (parts: TemplateStringsArray) => {
      const query = Array.from(parts).join("?");
      if (query.includes("LEFT JOIN meta_automation_business_controls")) {
        return [
          {
            business_id: BUSINESS_ID,
            kill_switch_engaged: false,
            kill_switch_reason: null,
            auto_execution_enabled: false,
            readiness_tier: "manual_review",
            guardrails_json: {},
            updated_at: "2026-08-17T08:00:00.000Z",
            updated_by: "user_1",
          },
        ];
      }
      if (query.includes("FROM meta_automation_rules")) {
        return [
          {
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
            action_json: { kind: "propose_pause", budgetChangePct: null },
            mode: "confirm",
            active: true,
            created_at: "2026-08-01T00:00:00.000Z",
            updated_at: "2026-08-01T00:00:00.000Z",
          },
        ];
      }
      if (query.includes("FROM meta_automation_rule_firings")) {
        return [
          {
            rule_id: "rule_1",
            fired_count: "3",
            last_fired_at: "2026-08-12T09:00:00.000Z",
          },
        ];
      }
      if (query.includes("FROM business_target_packs")) {
        return [
          {
            target_cpa: null,
            target_roas: 3.8,
            break_even_cpa: null,
            break_even_roas: 2.5,
            contribution_margin_assumption: null,
            aov_assumption: null,
            new_customer_weight: null,
            default_risk_posture: "balanced",
            cost_cogs_percent: null,
            cost_shipping_percent: null,
            cost_fulfillment_percent: null,
            cost_payment_processing_percent: null,
            source_label: "settings_manual_entry",
            updated_at: "2026-08-16T00:00:00.000Z",
            updated_by_user_id: null,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const payload = await getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      asOf: new Date("2026-08-16T00:00:00.000Z"),
    });

    expect(payload.readCompleteness?.rules).toBe("complete");
    expect(payload.rules).toHaveLength(1);
    expect(payload.rules?.[0]).toMatchObject({
      id: "rule_1",
      name: "Breakeven guard",
      mode: "confirm",
      locked: false,
      active: true,
      firedCount: 3,
      lastFiredAt: "2026-08-12T09:00:00.000Z",
    });
    expect(payload.commercialAnchors).toMatchObject({
      break_even_roas: 2.5,
      target_roas: 3.8,
    });
  });

  it("marks the rules read unavailable rather than reporting an empty table", async () => {
    const sql = vi.fn(async (parts: TemplateStringsArray) => {
      const query = Array.from(parts).join("?");
      if (query.includes("LEFT JOIN meta_automation_business_controls")) {
        return [
          {
            business_id: BUSINESS_ID,
            kill_switch_engaged: false,
            kill_switch_reason: null,
            auto_execution_enabled: false,
            readiness_tier: "manual_review",
            guardrails_json: {},
            updated_at: "2026-08-17T08:00:00.000Z",
            updated_by: "user_1",
          },
        ];
      }
      if (query.includes("FROM meta_automation_rules")) {
        throw Object.assign(new Error("rules table unavailable"), {
          code: "57P01",
        });
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const payload = await getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });

    expect(payload.readCompleteness?.rules).toBe("unavailable");
    expect(payload.rules).toEqual([]);
  });

  /**
   * The law: a failed control read is reported as a failed read.
   *
   * `businessControl` is always populated, because a failure degrades to
   * `defaultBusinessControl` — a concrete, benign-looking state (not stopped,
   * Tier 1 supervised, the 15% / 3-action default guardrails). Without
   * provenance the surface could not tell that apart from a row the database
   * actually returned, and it printed those four values as facts while
   * `getMetaWriteBlockState` refused every write in the same window with
   * `control_state_unavailable`. The value still degrades; what changed is
   * that the payload now admits it.
   */
  it("marks the control read unavailable rather than passing its default off as a read", async () => {
    const sql = vi.fn(async (parts: TemplateStringsArray) => {
      const query = Array.from(parts).join("?");
      if (query.includes("meta_automation_business_controls")) {
        // Not 42P01: a timeout, a permission error or a dropped connection is
        // exactly the case the old `safeRead` swallowed into a default.
        throw Object.assign(new Error("control read timed out"), {
          code: "57014",
        });
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const payload = await getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });

    expect(payload.readCompleteness?.businessControl).toBe("unavailable");
    expect(payload.businessControl.source).toBe("default");
    expect(payload.businessControl.killSwitchEngaged).toBe(false);
  });

  it("proves the control read when the row comes back", async () => {
    const sql = vi.fn(async (parts: TemplateStringsArray) => {
      const query = Array.from(parts).join("?");
      if (query.includes("meta_automation_business_controls")) {
        return [
          {
            business_id: BUSINESS_ID,
            kill_switch_engaged: false,
            kill_switch_reason: null,
            auto_execution_enabled: false,
            readiness_tier: "manual_review",
            guardrails_json: {},
            updated_at: "2026-08-17T08:00:00.000Z",
            updated_by: "user_1",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const payload = await getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });

    expect(payload.readCompleteness?.businessControl).toBe("complete");
    expect(payload.businessControl.source).toBe("persisted");
  });

  /**
   * The law: an empty activity ledger is only "nothing has happened here" when
   * BOTH halves of it were read. The ledger is assembled from the automation
   * ledger and the ads action log; either one degrading to `[]` on failure made
   * a broken read indistinguishable from a quiet workspace.
   */
  it("refuses to prove an empty activity ledger when either half failed", async () => {
    const brokenActionLog = vi.fn(async (parts: TemplateStringsArray) => {
      const query = Array.from(parts).join("?");
      if (query.includes("FROM meta_ads_action_log")) {
        throw Object.assign(new Error("action log unavailable"), {
          code: "57P01",
        });
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(brokenActionLog as never);
    const broken = await getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });

    expect(broken.activityLedger).toEqual([]);
    expect(broken.readCompleteness?.activityLedger).toBe("unavailable");

    const cleanReads = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(cleanReads as never);
    const proven = await getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });

    expect(proven.activityLedger).toEqual([]);
    expect(proven.readCompleteness?.activityLedger).toBe("complete");
  });
});
