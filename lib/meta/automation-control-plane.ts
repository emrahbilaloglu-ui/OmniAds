import { getDb } from "@/lib/db";
import { DEMO_BUSINESS_ID } from "@/lib/demo-business-support";

export type MetaAutomationReadinessControlTier =
  "read_only" | "manual_review" | "backtest_candidate" | "auto_execute";

export interface MetaAutomationGuardrails {
  dailyAutoActionCap: number;
  perActionSpendCeilingMinor: number | null;
  perActionSpendCeilingCurrency: string | null;
  notificationPolicy: "every_auto_action" | "none";
  maxBudgetIncreasePct: number;
  maxDailyBudgetChangeMinor: number | null;
  requireCampaignLabel: boolean;
  requireCommercialAnchor: boolean;
  requireLivePreflight: boolean;
  requireRollbackPlan: boolean;
  dryRunOnly: boolean;
}

export interface MetaAutomationBusinessControl {
  businessId: string;
  killSwitchEngaged: boolean;
  killSwitchReason: string | null;
  autoExecutionEnabled: boolean;
  readinessTier: MetaAutomationReadinessControlTier;
  guardrails: MetaAutomationGuardrails;
  updatedAt: string | null;
  updatedBy: string | null;
  source: "persisted" | "default";
}

export interface MetaAutomationPromotionRecord {
  id: string;
  recId: string | null;
  entityType: string;
  entityId: string | null;
  sourceTier: string | null;
  targetTier: string | null;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface MetaAutomationActivityItem {
  id: string;
  activityType: string;
  severity: "info" | "warning" | "danger" | "success";
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  source: "automation_ledger" | "meta_action_log";
}

export type MetaAutomationDecisionType =
  "pause" | "bid" | "budget" | "creative";
export type MetaAutomationDecisionMode = "manual" | "semi_auto" | "auto";

export interface MetaAutomationDecisionTypeMode {
  decisionType: MetaAutomationDecisionType;
  mode: MetaAutomationDecisionMode;
  lockReason: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  source: "persisted" | "default";
}

export const META_AUTOMATION_DECISION_TYPES: MetaAutomationDecisionType[] = [
  "pause",
  "bid",
  "budget",
  "creative",
];
const META_AUTOMATION_DECISION_MODES: MetaAutomationDecisionMode[] = [
  "manual",
  "semi_auto",
  "auto",
];

export interface MetaAutomationControlPlane {
  contractVersion: "meta-automation-control-plane.v1";
  businessId: string;
  /** Explicit provider account used to scope provider-action evidence.
   * Business controls and STOP state remain business-wide. */
  providerAccountId: string | null;
  globalKillSwitch: {
    engaged: boolean;
    reason: "META_ADS_WRITE_KILL_SWITCH" | null;
  };
  businessControl: MetaAutomationBusinessControl;
  execution: {
    autoExecutionAllowed: boolean;
    writeEndpointsBlocked: boolean;
    blockedReasons: string[];
  };
  promotionRecords: MetaAutomationPromotionRecord[];
  /**
   * Additive read provenance for collections whose empty value is otherwise
   * ambiguous. Older payloads omit this field and must therefore be treated as
   * unproven rather than as a confirmed empty collection.
   */
  readCompleteness?: {
    promotionRecords: "complete" | "unavailable";
  };
  activityLedger: MetaAutomationActivityItem[];
  /** Per-decision-type standing mode (persisted operator preference, or 'manual'
   *  default). Recording a change persists an audit record; it does NOT auto-execute
   *  — writes stay gated by the kill switch, readiness tier and dry-run guardrail. */
  decisionTypeModes: MetaAutomationDecisionTypeMode[];
}

export interface MetaWriteBlockState {
  blocked: boolean;
  reason:
    | "META_ADS_WRITE_KILL_SWITCH"
    | "business_kill_switch"
    | "demo_business_read_only"
    | "control_state_unavailable"
    | null;
  message: string | null;
}

type ControlDbRow = {
  business_id: string | null;
  is_demo_business?: boolean | null;
  kill_switch_engaged: boolean | null;
  kill_switch_reason: string | null;
  auto_execution_enabled: boolean | null;
  readiness_tier: string | null;
  guardrails_json: unknown;
  updated_at: string | null;
  updated_by: string | null;
};

type PromotionDbRow = {
  id: string;
  rec_id: string | null;
  entity_type: string;
  entity_id: string | null;
  source_tier: string | null;
  target_tier: string | null;
  status: string;
  reason: string | null;
  created_at: string;
};

type ActivityDbRow = {
  id: string;
  activity_type: string;
  severity: string | null;
  message: string;
  payload_json: unknown;
  created_at: string;
};

type ActionLogDbRow = {
  id: string;
  action: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  requested_at: string;
  payload_request: unknown;
};

export const DEFAULT_META_AUTOMATION_GUARDRAILS: MetaAutomationGuardrails = {
  dailyAutoActionCap: 3,
  perActionSpendCeilingMinor: 5000,
  perActionSpendCeilingCurrency: "EUR",
  notificationPolicy: "every_auto_action",
  maxBudgetIncreasePct: 15,
  maxDailyBudgetChangeMinor: null,
  requireCampaignLabel: true,
  requireCommercialAnchor: true,
  requireLivePreflight: true,
  requireRollbackPlan: true,
  dryRunOnly: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toBool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function toPositiveNumberOrNull(value: unknown) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.trunc(next) : null;
}

function toCurrencyOrNull(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function toNotificationPolicy(
  value: unknown,
): MetaAutomationGuardrails["notificationPolicy"] {
  return value === "none" ? "none" : "every_auto_action";
}

function toReadinessTier(value: unknown): MetaAutomationReadinessControlTier {
  return value === "read_only" ||
    value === "manual_review" ||
    value === "backtest_candidate" ||
    value === "auto_execute"
    ? value
    : "manual_review";
}

function toSeverity(value: unknown): MetaAutomationActivityItem["severity"] {
  return value === "warning" || value === "danger" || value === "success"
    ? value
    : "info";
}

function normalizeGuardrails(value: unknown): MetaAutomationGuardrails {
  const record = isRecord(value) ? value : {};
  return {
    dailyAutoActionCap:
      toPositiveNumberOrNull(record.dailyAutoActionCap) ??
      DEFAULT_META_AUTOMATION_GUARDRAILS.dailyAutoActionCap,
    perActionSpendCeilingMinor:
      toPositiveNumberOrNull(record.perActionSpendCeilingMinor) ??
      DEFAULT_META_AUTOMATION_GUARDRAILS.perActionSpendCeilingMinor,
    perActionSpendCeilingCurrency:
      toCurrencyOrNull(record.perActionSpendCeilingCurrency) ??
      DEFAULT_META_AUTOMATION_GUARDRAILS.perActionSpendCeilingCurrency,
    notificationPolicy: toNotificationPolicy(record.notificationPolicy),
    maxBudgetIncreasePct:
      toPositiveNumberOrNull(record.maxBudgetIncreasePct) ??
      DEFAULT_META_AUTOMATION_GUARDRAILS.maxBudgetIncreasePct,
    maxDailyBudgetChangeMinor:
      toPositiveNumberOrNull(record.maxDailyBudgetChangeMinor) ??
      DEFAULT_META_AUTOMATION_GUARDRAILS.maxDailyBudgetChangeMinor,
    requireCampaignLabel: toBool(
      record.requireCampaignLabel,
      DEFAULT_META_AUTOMATION_GUARDRAILS.requireCampaignLabel,
    ),
    requireCommercialAnchor: toBool(
      record.requireCommercialAnchor,
      DEFAULT_META_AUTOMATION_GUARDRAILS.requireCommercialAnchor,
    ),
    requireLivePreflight: toBool(
      record.requireLivePreflight,
      DEFAULT_META_AUTOMATION_GUARDRAILS.requireLivePreflight,
    ),
    requireRollbackPlan: toBool(
      record.requireRollbackPlan,
      DEFAULT_META_AUTOMATION_GUARDRAILS.requireRollbackPlan,
    ),
    dryRunOnly: toBool(
      record.dryRunOnly,
      DEFAULT_META_AUTOMATION_GUARDRAILS.dryRunOnly,
    ),
  };
}

export function isTruthyControlValue(value: string | undefined | null) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function isGlobalMetaAdsWriteKillSwitchEngaged(
  env: NodeJS.ProcessEnv = process.env,
) {
  return isTruthyControlValue(env.META_ADS_WRITE_KILL_SWITCH);
}

function defaultBusinessControl(
  businessId: string,
): MetaAutomationBusinessControl {
  return {
    businessId,
    killSwitchEngaged: false,
    killSwitchReason: null,
    autoExecutionEnabled: false,
    readinessTier: "manual_review",
    guardrails: DEFAULT_META_AUTOMATION_GUARDRAILS,
    updatedAt: null,
    updatedBy: null,
    source: "default",
  };
}

function mapControlRow(
  row: ControlDbRow | undefined,
  businessId: string,
): MetaAutomationBusinessControl {
  if (!row) return defaultBusinessControl(businessId);
  return {
    businessId,
    killSwitchEngaged: row.kill_switch_engaged === true,
    killSwitchReason: row.kill_switch_reason?.trim() || null,
    autoExecutionEnabled: row.auto_execution_enabled === true,
    readinessTier: toReadinessTier(row.readiness_tier),
    guardrails: normalizeGuardrails(row.guardrails_json),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    source: "persisted",
  };
}

function mapPromotion(row: PromotionDbRow): MetaAutomationPromotionRecord {
  return {
    id: row.id,
    recId: row.rec_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sourceTier: row.source_tier,
    targetTier: row.target_tier,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapActivity(row: ActivityDbRow): MetaAutomationActivityItem {
  return {
    id: row.id,
    activityType: row.activity_type,
    severity: toSeverity(row.severity),
    message: row.message,
    payload: isRecord(row.payload_json) ? row.payload_json : null,
    createdAt: row.created_at,
    source: "automation_ledger",
  };
}

function mapActionLog(row: ActionLogDbRow): MetaAutomationActivityItem {
  const failed = row.status === "failure" || row.status === "silent_failure";
  return {
    id: `meta-action-${row.id}`,
    activityType: `meta_${row.action}`,
    severity:
      row.error_code === "kill_switch_engaged"
        ? "warning"
        : failed
          ? "danger"
          : "success",
    message:
      row.error_code === "kill_switch_engaged"
        ? "Meta write blocked by kill switch."
        : failed
          ? row.error_message || `Meta ${row.action} failed.`
          : `Meta ${row.action} completed.`,
    payload: isRecord(row.payload_request) ? row.payload_request : null,
    createdAt: row.requested_at,
    source: "meta_action_log",
  };
}

function isUndefinedTableError(error: unknown) {
  return isRecord(error) && error.code === "42P01";
}

async function safeRead<T>(reader: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await reader();
  } catch (error) {
    if (isUndefinedTableError(error)) return fallback;
    return fallback;
  }
}

async function readWithCompleteness<T>(
  reader: () => Promise<T>,
  fallback: T,
): Promise<{ value: T; completeness: "complete" | "unavailable" }> {
  try {
    return { value: await reader(), completeness: "complete" };
  } catch {
    return { value: fallback, completeness: "unavailable" };
  }
}

async function readBusinessControlState(businessId: string) {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      control.business_id,
      business.is_demo_business,
      control.kill_switch_engaged,
      control.kill_switch_reason,
      control.auto_execution_enabled,
      control.readiness_tier,
      control.guardrails_json,
      control.updated_at,
      control.updated_by
    FROM businesses business
    LEFT JOIN meta_automation_business_controls control
      ON control.business_id = business.id
    WHERE business.id = ${businessId}
    LIMIT 1
  `) as ControlDbRow[];
  return {
    control: mapControlRow(
      rows[0]?.business_id ? rows[0] : undefined,
      businessId,
    ),
    businessFound: rows.length > 0,
    isDemoBusiness: rows[0]?.is_demo_business === true,
  };
}

async function readBusinessControl(businessId: string) {
  return (await readBusinessControlState(businessId)).control;
}

async function readPromotionRecords(businessId: string) {
  const sql = getDb();
  const rows = (await sql`
    SELECT id, rec_id, entity_type, entity_id, source_tier, target_tier, status, reason, created_at
    FROM meta_automation_promotion_records
    WHERE business_id = ${businessId}
    ORDER BY created_at DESC
    LIMIT 20
  `) as PromotionDbRow[];
  return rows.map(mapPromotion);
}

async function readActivityLedger(businessId: string) {
  const sql = getDb();
  const rows = (await sql`
    SELECT id, activity_type, severity, message, payload_json, created_at
    FROM meta_automation_activity_ledger
    WHERE business_id = ${businessId}
    ORDER BY created_at DESC
    LIMIT 20
  `) as ActivityDbRow[];
  return rows.map(mapActivity);
}

async function readRecentActionLedger(
  businessId: string,
  providerAccountId: string | null,
) {
  const sql = getDb();
  let rows: ActionLogDbRow[];
  try {
    rows = (await sql`
      SELECT
        log.id,
        log.action,
        log.status,
        log.error_code,
        log.error_message,
        log.requested_at,
        log.payload_request
      FROM meta_ads_action_log log
      WHERE log.business_id = ${businessId}
        AND log.status IN ('success', 'failure', 'silent_failure')
        AND (
          ${providerAccountId}::text IS NULL
          OR EXISTS (
            SELECT 1
            FROM meta_ad_dimensions dimension
            WHERE dimension.business_id::text = ${businessId}
              AND dimension.provider_account_id = ${providerAccountId}
              AND dimension.ad_id IN (log.ad_id, log.resulting_ad_id)
          )
          OR EXISTS (
            SELECT 1
            FROM meta_campaign_dimensions dimension
            WHERE dimension.business_id::text = ${businessId}
              AND dimension.provider_account_id = ${providerAccountId}
              AND dimension.campaign_id = log.ad_id
          )
          OR EXISTS (
            SELECT 1
            FROM meta_adset_dimensions dimension
            WHERE dimension.business_id::text = ${businessId}
              AND dimension.provider_account_id = ${providerAccountId}
              AND dimension.adset_id = log.ad_id
          )
          OR EXISTS (
            SELECT 1
            FROM meta_launch_intents intent
            WHERE intent.business_id = log.business_id
              AND intent.provider_account_id = ${providerAccountId}
              AND intent.id::text = COALESCE(
                log.launch_intent_id::text,
                log.payload_request->>'launch_intent_id'
              )
          )
        )
      ORDER BY log.requested_at DESC
      LIMIT 20
    `) as ActionLogDbRow[];
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error;

    // LaunchIntent is an additive lineage source. Older schemas must still show
    // account-scoped campaign, ad set and ad actions instead of dropping the
    // entire activity ledger because this optional table is not migrated yet.
    rows = (await sql`
      SELECT
        log.id,
        log.action,
        log.status,
        log.error_code,
        log.error_message,
        log.requested_at,
        log.payload_request
      FROM meta_ads_action_log log
      WHERE log.business_id = ${businessId}
        AND log.status IN ('success', 'failure', 'silent_failure')
        AND (
          ${providerAccountId}::text IS NULL
          OR EXISTS (
            SELECT 1
            FROM meta_ad_dimensions dimension
            WHERE dimension.business_id::text = ${businessId}
              AND dimension.provider_account_id = ${providerAccountId}
              AND dimension.ad_id IN (log.ad_id, log.resulting_ad_id)
          )
          OR EXISTS (
            SELECT 1
            FROM meta_campaign_dimensions dimension
            WHERE dimension.business_id::text = ${businessId}
              AND dimension.provider_account_id = ${providerAccountId}
              AND dimension.campaign_id = log.ad_id
          )
          OR EXISTS (
            SELECT 1
            FROM meta_adset_dimensions dimension
            WHERE dimension.business_id::text = ${businessId}
              AND dimension.provider_account_id = ${providerAccountId}
              AND dimension.adset_id = log.ad_id
          )
        )
      ORDER BY log.requested_at DESC
      LIMIT 20
    `) as ActionLogDbRow[];
  }
  return rows.map(mapActionLog);
}

function normalizeKillSwitchReason(value: unknown) {
  const reason = typeof value === "string" ? value.trim() : "";
  return (
    reason.slice(0, 500) || "Operator stopped all Meta writes from Automation."
  );
}

export async function engageMetaAutomationKillSwitch(input: {
  businessId: string;
  userId: string;
  reason?: unknown;
}): Promise<MetaAutomationBusinessControl> {
  const businessId = input.businessId.trim();
  const reason = normalizeKillSwitchReason(input.reason);
  const sql = getDb();
  const rows = (await sql`
    INSERT INTO meta_automation_business_controls (
      business_id,
      kill_switch_engaged,
      kill_switch_reason,
      updated_by,
      updated_at
    )
    VALUES (${businessId}, TRUE, ${reason}, ${input.userId}, NOW())
    ON CONFLICT (business_id)
    DO UPDATE SET
      kill_switch_engaged = TRUE,
      kill_switch_reason = EXCLUDED.kill_switch_reason,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING
      business_id,
      kill_switch_engaged,
      kill_switch_reason,
      auto_execution_enabled,
      readiness_tier,
      guardrails_json,
      updated_at,
      updated_by
  `) as ControlDbRow[];
  await sql`
    INSERT INTO meta_automation_activity_ledger (
      business_id,
      activity_type,
      severity,
      message,
      payload_json,
      created_by
    )
    VALUES (
      ${businessId},
      'business_kill_switch_engaged',
      'danger',
      'Business kill switch engaged — all Meta writes stopped.',
      ${JSON.stringify({ reason })}::jsonb,
      ${input.userId}
    )
  `;
  return mapControlRow(rows[0], businessId);
}

/**
 * Release the business kill switch (the inverse of {@link engageMetaAutomationKillSwitch}).
 * This only lifts the STOP: it sets kill_switch_engaged=FALSE and clears the reason. It does
 * NOT enable auto-execution — writes still require the remaining gates (auto_execution_enabled,
 * readiness tier, dry-run guardrail, and the env-level global kill switch). Without this the
 * business kill switch was a one-way trap with no UI path back.
 */
export async function releaseMetaAutomationKillSwitch(input: {
  businessId: string;
  userId: string;
}): Promise<MetaAutomationBusinessControl> {
  const businessId = input.businessId.trim();
  const sql = getDb();
  const rows = (await sql`
    INSERT INTO meta_automation_business_controls (
      business_id,
      kill_switch_engaged,
      kill_switch_reason,
      updated_by,
      updated_at
    )
    VALUES (${businessId}, FALSE, NULL, ${input.userId}, NOW())
    ON CONFLICT (business_id)
    DO UPDATE SET
      kill_switch_engaged = FALSE,
      kill_switch_reason = NULL,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING
      business_id,
      kill_switch_engaged,
      kill_switch_reason,
      auto_execution_enabled,
      readiness_tier,
      guardrails_json,
      updated_at,
      updated_by
  `) as ControlDbRow[];
  await sql`
    INSERT INTO meta_automation_activity_ledger (
      business_id,
      activity_type,
      severity,
      message,
      payload_json,
      created_by
    )
    VALUES (
      ${businessId},
      'business_kill_switch_released',
      'warning',
      'Business kill switch released — Meta writes may resume, still subject to the remaining automation gates.',
      ${JSON.stringify({})}::jsonb,
      ${input.userId}
    )
  `;
  return mapControlRow(rows[0], businessId);
}

type DecisionTypeModeDbRow = {
  decision_type: string;
  mode: string;
  lock_reason: string | null;
  updated_at: string | null;
  updated_by: string | null;
};

function defaultDecisionTypeModes(): MetaAutomationDecisionTypeMode[] {
  return META_AUTOMATION_DECISION_TYPES.map((decisionType) => ({
    decisionType,
    mode: "manual",
    lockReason: null,
    updatedAt: null,
    updatedBy: null,
    source: "default",
  }));
}

async function readDecisionTypeModes(
  businessId: string,
): Promise<MetaAutomationDecisionTypeMode[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT decision_type, mode, lock_reason, updated_at, updated_by
    FROM meta_automation_decision_type_modes
    WHERE business_id = ${businessId}
  `) as DecisionTypeModeDbRow[];
  const byType = new Map(rows.map((row) => [row.decision_type, row]));
  return META_AUTOMATION_DECISION_TYPES.map((decisionType) => {
    const row = byType.get(decisionType);
    if (!row) {
      return {
        decisionType,
        mode: "manual" as MetaAutomationDecisionMode,
        lockReason: null,
        updatedAt: null,
        updatedBy: null,
        source: "default" as const,
      };
    }
    const mode = (META_AUTOMATION_DECISION_MODES as string[]).includes(row.mode)
      ? (row.mode as MetaAutomationDecisionMode)
      : "manual";
    return {
      decisionType,
      mode,
      lockReason: row.lock_reason,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      source: "persisted" as const,
    };
  });
}

/**
 * Persist a per-decision-type standing mode. This records the operator's preference
 * (with a real promotion + activity-ledger audit row); it NEVER issues a Meta write and
 * does not by itself enable auto-execution — that stays gated by the kill switch,
 * readiness tier and dry-run guardrail.
 */
export async function setMetaAutomationDecisionTypeMode(input: {
  businessId: string;
  decisionType: MetaAutomationDecisionType;
  mode: MetaAutomationDecisionMode;
  userId: string;
  reason?: unknown;
}): Promise<MetaAutomationDecisionTypeMode[]> {
  const businessId = input.businessId.trim();
  const sql = getDb();
  const reason =
    typeof input.reason === "string"
      ? input.reason.trim().slice(0, 500) || null
      : null;
  const priorRows = (await sql`
    SELECT mode FROM meta_automation_decision_type_modes
    WHERE business_id = ${businessId} AND decision_type = ${input.decisionType}
  `) as Array<{ mode: string }>;
  const priorMode = priorRows[0]?.mode ?? "manual";
  await sql`
    INSERT INTO meta_automation_decision_type_modes (
      business_id, decision_type, mode, lock_reason, updated_by, updated_at
    )
    VALUES (${businessId}, ${input.decisionType}, ${input.mode}, ${reason}, ${input.userId}, NOW())
    ON CONFLICT (business_id, decision_type)
    DO UPDATE SET
      mode = EXCLUDED.mode,
      lock_reason = EXCLUDED.lock_reason,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
  `;
  await sql`
    INSERT INTO meta_automation_promotion_records (
      business_id, entity_type, entity_id, source_tier, target_tier, status, reason, created_by
    )
    VALUES (${businessId}, 'decision_type_mode', ${input.decisionType}, ${priorMode}, ${input.mode}, 'approved', ${reason}, ${input.userId})
  `;
  await sql`
    INSERT INTO meta_automation_activity_ledger (
      business_id, activity_type, severity, message, payload_json, created_by
    )
    VALUES (
      ${businessId},
      'decision_type_mode_change',
      'info',
      ${`${input.decisionType} standing mode set to ${input.mode}${priorMode !== input.mode ? ` (from ${priorMode})` : ""}.`},
      ${JSON.stringify({ decisionType: input.decisionType, from: priorMode, to: input.mode })}::jsonb,
      ${input.userId}
    )
  `;
  return readDecisionTypeModes(businessId);
}

export async function getMetaAutomationControlPlane(input: {
  businessId: string;
  providerAccountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<MetaAutomationControlPlane> {
  const businessId = input.businessId.trim();
  const providerAccountId = input.providerAccountId?.trim() || null;
  const env = input.env ?? process.env;
  const globalKillSwitchEngaged = isGlobalMetaAdsWriteKillSwitchEngaged(env);
  const businessControl = await safeRead(
    () => readBusinessControl(businessId),
    defaultBusinessControl(businessId),
  );
  const [promotionRead, automationActivity, actionActivity, decisionTypeModes] =
    await Promise.all([
      readWithCompleteness(() => readPromotionRecords(businessId), []),
      safeRead(() => readActivityLedger(businessId), []),
      safeRead(() => readRecentActionLedger(businessId, providerAccountId), []),
      safeRead(
        () => readDecisionTypeModes(businessId),
        defaultDecisionTypeModes(),
      ),
    ]);
  const blockedReasons = [
    globalKillSwitchEngaged ? "META_ADS_WRITE_KILL_SWITCH" : null,
    businessControl.killSwitchEngaged ? "business_kill_switch" : null,
    !businessControl.autoExecutionEnabled ? "auto_execution_not_enabled" : null,
    businessControl.guardrails.dryRunOnly ? "dry_run_only_guardrail" : null,
  ].filter((item): item is string => Boolean(item));

  return {
    contractVersion: "meta-automation-control-plane.v1",
    businessId,
    providerAccountId,
    globalKillSwitch: {
      engaged: globalKillSwitchEngaged,
      reason: globalKillSwitchEngaged ? "META_ADS_WRITE_KILL_SWITCH" : null,
    },
    businessControl,
    execution: {
      autoExecutionAllowed:
        !globalKillSwitchEngaged &&
        !businessControl.killSwitchEngaged &&
        businessControl.autoExecutionEnabled &&
        businessControl.readinessTier === "auto_execute" &&
        !businessControl.guardrails.dryRunOnly,
      writeEndpointsBlocked:
        globalKillSwitchEngaged || businessControl.killSwitchEngaged,
      blockedReasons,
    },
    promotionRecords: promotionRead.value,
    readCompleteness: {
      promotionRecords: promotionRead.completeness,
    },
    activityLedger: [...automationActivity, ...actionActivity]
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      )
      .slice(0, 30),
    decisionTypeModes,
  };
}

export async function getMetaWriteBlockState(input: {
  businessId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MetaWriteBlockState> {
  const businessId = input.businessId.trim();
  const env = input.env ?? process.env;
  if (businessId === DEMO_BUSINESS_ID) {
    return {
      blocked: true,
      reason: "demo_business_read_only",
      message: "Meta writes are disabled for synthetic demo businesses.",
    };
  }
  if (isGlobalMetaAdsWriteKillSwitchEngaged(env)) {
    return {
      blocked: true,
      reason: "META_ADS_WRITE_KILL_SWITCH",
      message: "Meta writes are disabled by global kill switch.",
    };
  }

  const isVitest = env.VITEST === "true" || env.NODE_ENV === "test";
  if (isVitest && env.META_AUTOMATION_WRITE_GUARD_TEST_READS !== "1") {
    return { blocked: false, reason: null, message: null };
  }

  let controlState: Awaited<ReturnType<typeof readBusinessControlState>>;
  try {
    controlState = await readBusinessControlState(businessId);
  } catch {
    return {
      blocked: true,
      reason: "control_state_unavailable",
      message:
        "Meta writes are temporarily blocked because automation control state could not be verified.",
    };
  }
  if (!controlState.businessFound) {
    return {
      blocked: true,
      reason: "control_state_unavailable",
      message:
        "Meta writes are temporarily blocked because automation control state could not be verified.",
    };
  }
  if (controlState.isDemoBusiness) {
    return {
      blocked: true,
      reason: "demo_business_read_only",
      message: "Meta writes are disabled for synthetic demo businesses.",
    };
  }
  const control = controlState.control;
  if (!control.killSwitchEngaged) {
    return { blocked: false, reason: null, message: null };
  }
  return {
    blocked: true,
    reason: "business_kill_switch",
    message:
      control.killSwitchReason ||
      "Meta writes are disabled by business kill switch.",
  };
}
