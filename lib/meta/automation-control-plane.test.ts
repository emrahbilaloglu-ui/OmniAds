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
  isGlobalMetaAdsWriteKillSwitchEngaged,
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
