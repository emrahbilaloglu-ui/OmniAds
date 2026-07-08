import { beforeEach, describe, expect, it, vi } from "vitest";

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
    expect(isGlobalMetaAdsWriteKillSwitchEngaged({ META_ADS_WRITE_KILL_SWITCH: " true " } as never)).toBe(true);
    expect(isGlobalMetaAdsWriteKillSwitchEngaged({ META_ADS_WRITE_KILL_SWITCH: "YES" } as never)).toBe(true);
    expect(isGlobalMetaAdsWriteKillSwitchEngaged({ META_ADS_WRITE_KILL_SWITCH: "0" } as never)).toBe(false);
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

    const payload = await getMetaAutomationControlPlane({ businessId: BUSINESS_ID });

    expect(payload.contractVersion).toBe("meta-automation-control-plane.v1");
    expect(payload.businessControl.source).toBe("persisted");
    expect(payload.businessControl.guardrails.dailyAutoActionCap).toBe(4);
    expect(payload.businessControl.guardrails.perActionSpendCeilingMinor).toBe(7500);
    expect(payload.businessControl.guardrails.maxBudgetIncreasePct).toBe(10);
    expect(payload.promotionRecords).toHaveLength(1);
    expect(payload.activityLedger[0]?.message).toBe("Meta write blocked by kill switch.");
    expect(payload.execution.autoExecutionAllowed).toBe(false);
    expect(payload.execution.blockedReasons).toContain("dry_run_only_guardrail");
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

  it("fails closed when business kill-switch state cannot be verified", async () => {
    vi.stubEnv("META_AUTOMATION_WRITE_GUARD_TEST_READS", "1");
    const dbError = Object.assign(new Error("database unavailable"), { code: "57P01" });
    const sql = vi.fn().mockRejectedValueOnce(dbError);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const block = await getMetaWriteBlockState({ businessId: BUSINESS_ID });

    expect(block).toMatchObject({
      blocked: true,
      reason: "business_kill_switch",
      message: "Meta writes are temporarily blocked because automation control state could not be verified.",
    });
  });

  it("keeps the business guard open before the automation control table is migrated", async () => {
    vi.stubEnv("META_AUTOMATION_WRITE_GUARD_TEST_READS", "1");
    const missingTable = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const sql = vi.fn().mockRejectedValueOnce(missingTable);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const block = await getMetaWriteBlockState({ businessId: BUSINESS_ID });

    expect(block).toEqual({ blocked: false, reason: null, message: null });
  });
});
