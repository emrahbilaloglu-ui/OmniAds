// Child of ephemeral-postgres-migrations-check. It runs only against the
// throwaway database URL force-set by the parent and never calls Meta.
//
// Why this exists as a DB seam rather than as another mocked unit test: every
// read in the Automation control plane is wrapped in a swallow-all guard, so a
// query that is merely INVALID SQL — a mistyped LATERAL, an `= ANY(...)` the
// driver will not bind, a join onto a column this migration forgot — presents
// in production as "this business has no activity and no guardrails", which is
// indistinguishable from the truthful empty answer. Only executing the real
// statements against the real migrated schema can tell those apart.
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  engageMetaAutomationKillSwitch,
  getMetaAutomationControlPlane,
  setMetaAutomationDecisionTypeMode,
  setMetaAutomationGuardrailPolicy,
} from "@/lib/meta/automation-control-plane";

function expectEqual(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `automation-control-plane seam FAILED [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function seedFixture() {
  const db = getDb();
  const users = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash)
     VALUES ('Automation Seam Operator', 'automation-seam@example.test', 'x')
     RETURNING id::text AS id`,
  );
  const userId = users[0]!.id;
  const businesses = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, owner_id)
     VALUES ('Automation Seam Business', $1::uuid)
     RETURNING id::text AS id`,
    [userId],
  );
  const businessId = businesses[0]!.id;
  const providerAccountId = "act_automation_seam";

  // A real warehouse dimension so the ledger's entity join has something
  // truthful to resolve, and the account scope has something to match.
  await db.query(
    `INSERT INTO meta_adset_dimensions
       (business_id, provider_account_id, campaign_id, adset_id, adset_name_current)
     VALUES ($1, $2, 'camp_seam', 'adset_seam', 'Retargeting 7d — DPA')`,
    [businessId, providerAccountId],
  );
  return { businessId, userId, providerAccountId };
}

async function seedActionLog(input: {
  businessId: string;
  userId: string;
  action: string;
  status: string;
  requestedAt: string;
  requestedBy: string | null;
}) {
  await getDb().query(
    `INSERT INTO meta_ads_action_log
       (business_id, ad_id, action, source, requested_by, requested_at, status, payload_request)
     VALUES ($1::uuid, 'adset_seam', $2, 'ui_manual', $3::uuid, $4::timestamptz, $5, '{}'::jsonb)`,
    [
      input.businessId,
      input.action,
      input.requestedBy,
      input.requestedAt,
      input.status,
    ],
  );
}

async function main() {
  if (process.env.ADSECUTE_EPHEMERAL_DB_SEAM !== "1") {
    throw new Error(
      "automation-control-plane seam refused: not running against the ephemeral seam database.",
    );
  }
  const fixture = await seedFixture();

  // 1. Guardrail policy round-trips through its own columns.
  await setMetaAutomationGuardrailPolicy({
    businessId: fixture.businessId,
    userId: fixture.userId,
    minRoasFloor: 2.5,
    quietHours: { start: "00:00", end: "07:00", timezone: "ET" },
  });

  // 2. A standing mode change carries its threshold and its promotion receipt.
  await setMetaAutomationDecisionTypeMode({
    businessId: fixture.businessId,
    decisionType: "pause",
    mode: "manual",
    userId: fixture.userId,
    cleanApprovalThreshold: 5,
  });

  // 3. A kill-switch engage stamps the business entity and an applied result.
  await engageMetaAutomationKillSwitch({
    businessId: fixture.businessId,
    userId: fixture.userId,
    reason: "Seam stop.",
  });

  // Provider writes on both sides of a failure, so the streak must count only
  // the successes AFTER the failure rather than all of them.
  const tierStart = (
    await getDb().query<{ updated_at: string }>(
      `SELECT updated_at FROM meta_automation_decision_type_modes
       WHERE business_id = $1::uuid AND decision_type = 'pause'`,
      [fixture.businessId],
    )
  )[0]!.updated_at;
  const at = (offsetMs: number) =>
    new Date(new Date(tierStart).getTime() + offsetMs).toISOString();
  await seedActionLog({
    businessId: fixture.businessId,
    userId: fixture.userId,
    action: "pause",
    status: "success",
    requestedAt: at(1000),
    requestedBy: fixture.userId,
  });
  await seedActionLog({
    businessId: fixture.businessId,
    userId: fixture.userId,
    action: "pause",
    status: "failure",
    requestedAt: at(2000),
    requestedBy: fixture.userId,
  });
  await seedActionLog({
    businessId: fixture.businessId,
    userId: fixture.userId,
    action: "resume",
    status: "success",
    requestedAt: at(3000),
    requestedBy: fixture.userId,
  });
  await seedActionLog({
    businessId: fixture.businessId,
    userId: fixture.userId,
    action: "pause",
    status: "success",
    requestedAt: at(4000),
    requestedBy: fixture.userId,
  });
  // Unattributed success: real, but not an approval anyone can be named for.
  await seedActionLog({
    businessId: fixture.businessId,
    userId: fixture.userId,
    action: "pause",
    status: "success",
    requestedAt: at(5000),
    requestedBy: null,
  });

  const plane = await getMetaAutomationControlPlane({
    businessId: fixture.businessId,
    providerAccountId: fixture.providerAccountId,
  });

  expectEqual(plane.businessControl.source, "persisted", "control persisted");
  expectEqual(
    plane.businessControl.guardrails.minRoasFloor,
    2.5,
    "min ROAS floor round-trip",
  );
  expectEqual(
    plane.businessControl.guardrails.quietHours,
    { start: "00:00", end: "07:00", timezone: "ET" },
    "quiet hours round-trip",
  );

  const pause = plane.decisionTypeModes.find(
    (item) => item.decisionType === "pause",
  );
  expectEqual(pause?.cleanApprovalThreshold, 5, "threshold round-trip");
  // Two attributed successes after the failure; the pre-failure success and the
  // unattributed one are both excluded.
  expectEqual(pause?.cleanApprovalStreak, 2, "clean-approval streak window");
  expectEqual(
    plane.readCompleteness?.cleanApprovalStreaks,
    "complete",
    "streak read completeness",
  );
  const budget = plane.decisionTypeModes.find(
    (item) => item.decisionType === "budget",
  );
  expectEqual(
    budget?.cleanApprovalStreak,
    null,
    "no channel means no budget streak",
  );

  const guardrailRow = plane.activityLedger.find(
    (item) => item.activityType === "automation_guardrail_policy_updated",
  );
  expectEqual(guardrailRow?.actor?.kind, "operator", "guardrail actor kind");
  expectEqual(
    guardrailRow?.actor?.name,
    "Automation Seam Operator",
    "guardrail actor name join",
  );
  expectEqual(
    guardrailRow?.entity?.name,
    "Automation Seam Business",
    "business entity name join",
  );
  expectEqual(guardrailRow?.result?.status, "applied", "guardrail result");

  const modeRow = plane.activityLedger.find(
    (item) => item.activityType === "decision_type_mode_change",
  );
  expectEqual(modeRow?.entity?.type, "automation_decision_type", "mode entity type");
  expectEqual(modeRow?.entity?.id, "pause", "mode entity id");
  expectEqual(modeRow?.result?.status, "recorded", "mode result status");
  if (!modeRow?.result?.receiptId) {
    throw new Error(
      "automation-control-plane seam FAILED [mode receipt]: no promotion-record receipt was stamped",
    );
  }
  const receipt = await getDb().query<{ id: string }>(
    `SELECT id::text AS id FROM meta_automation_promotion_records WHERE id = $1::uuid`,
    [modeRow.result.receiptId],
  );
  expectEqual(receipt.length, 1, "mode receipt resolves to a real record");

  const stopRow = plane.activityLedger.find(
    (item) => item.activityType === "business_kill_switch_engaged",
  );
  expectEqual(stopRow?.entity?.type, "business", "stop entity type");
  expectEqual(stopRow?.result?.status, "applied", "stop result status");

  const providerRow = plane.activityLedger.find(
    (item) => item.source === "meta_action_log" && item.result?.status === "failed",
  );
  expectEqual(
    providerRow?.entity,
    { type: "adset", id: "adset_seam", name: "Retargeting 7d — DPA" },
    "provider entity resolved from the warehouse dimension",
  );
  expectEqual(
    providerRow?.actor?.name,
    "Automation Seam Operator",
    "provider actor name join",
  );

  const unattributed = plane.activityLedger.find(
    (item) => item.source === "meta_action_log" && item.actor === null,
  );
  if (!unattributed) {
    throw new Error(
      "automation-control-plane seam FAILED [unattributed actor]: a write with no requested_by must keep a blank actor",
    );
  }

  console.log(
    "[automation-control-plane-seam] PASS: guardrail policy, threshold, streak window, ledger actor/entity/result tuple and provider entity resolution.",
  );
  resetDbClientCache();
}

main().catch((error) => {
  console.error(error);
  try {
    resetDbClientCache();
  } catch {
    // Best-effort cleanup after the original seam failure.
  }
  process.exitCode = 1;
});
