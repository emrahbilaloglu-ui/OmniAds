import { getDb } from "@/lib/db";
import { DEMO_BUSINESS_ID } from "@/lib/demo-business-support";
import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";
import {
  evaluateAutomationGuardRules,
  evaluatePersistedQuietHoursGuardrail,
  type AutomationRuleAnchorValues,
  type AutomationRuleDefinition,
} from "@/lib/meta/automation-rules";
import {
  anchorsFromTargetPack,
  countAutomationRuleFirings,
  listAutomationRules,
} from "@/lib/meta/automation-rules-store";

export type MetaAutomationReadinessControlTier =
  "read_only" | "manual_review" | "backtest_candidate" | "auto_execute";

/**
 * A persisted quiet-hours window, exactly as an operator committed it.
 *
 * `timezone` is the operator's own label (the design renders `00:00–07:00 ET`),
 * stored and presented verbatim rather than re-derived from a server clock, so
 * the screen shows the window that was actually agreed rather than one this
 * process inferred.
 */
export interface MetaAutomationQuietHours {
  /** `HH:MM`, normalised from a persisted `TIME`. */
  start: string;
  /** `HH:MM`, normalised from a persisted `TIME`. */
  end: string;
  timezone: string;
}

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
  /**
   * The ROAS below which automation may propose a pause, as persisted for this
   * business. `null` when no operator has committed one — the screen then
   * renders an em dash rather than borrowing the commercial anchor's
   * break-even, which is a different fact that moves when margins move.
   */
  minRoasFloor: number | null;
  /** `null` until an operator persists a window. */
  quietHours: MetaAutomationQuietHours | null;
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

export type MetaAutomationActorKind = "operator" | "system";

/**
 * Who performed the recorded act.
 *
 * The user id is the ledger's existing `created_by` foreign key — the row's
 * author and its actor are the same person at every write site — so this adds
 * the missing TYPE rather than a second, divergent copy of the same id.
 * `name` is resolved from `users.name`; when the referenced user is gone the
 * kind survives and the name renders an em dash.
 */
export interface MetaAutomationActivityActor {
  kind: MetaAutomationActorKind;
  userId: string | null;
  name: string | null;
}

export interface MetaAutomationActivityEntity {
  /** `business`, `automation_decision_type`, `campaign`, `adset`, `ad`. */
  type: string;
  id: string | null;
  /** Resolved display name when the warehouse knows one; never inferred. */
  name: string | null;
}

export type MetaAutomationActivityResultStatus =
  | "applied"
  | "blocked"
  | "failed"
  | "recorded";

export interface MetaAutomationActivityResult {
  status: MetaAutomationActivityResultStatus;
  /** A provider entity id or promotion-record id proving the outcome landed. */
  receiptId: string | null;
}

export interface MetaAutomationActivityItem {
  id: string;
  activityType: string;
  severity: "info" | "warning" | "danger" | "success";
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  source: "automation_ledger" | "meta_action_log";
  /** `null` for rows written before the typed tuple existed. */
  actor: MetaAutomationActivityActor | null;
  entity: MetaAutomationActivityEntity | null;
  result: MetaAutomationActivityResult | null;
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
  /**
   * How many clean approvals this business requires before this action kind may
   * be promoted out of its current tier.
   *
   * Persisted PER BUSINESS AND ACTION KIND rather than read from a shared
   * constant, deliberately. It is the denominator of an audit statement: a
   * config constant would let a deploy retroactively rewrite the progress every
   * business has already been shown and the promotion records already written
   * under a different rule, and would force one risk appetite onto accounts
   * whose spend differs by two orders of magnitude. `null` until an operator
   * commits a number — the ladder then renders an em dash rather than adopting
   * the prototype's seed values.
   */
  cleanApprovalThreshold: number | null;
  /**
   * The current clean-approval streak for this action kind, DERIVED (never
   * stored) from real provider-write outcomes: successful writes of this kind
   * attributed to a named operator, counted since the later of this tier's
   * `updatedAt` and the most recent failed write of the same kind — the
   * ladder's own "any error demotes instantly" rule, applied to the count.
   *
   * `null` when the action kind has no provider-write channel at all (see
   * {@link CLEAN_APPROVAL_ACTION_KINDS}) or when the read could not be proven.
   */
  cleanApprovalStreak: number | null;
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
    /**
     * Omitted by payloads produced before the ladder counted anything. Absent
     * or `unavailable` means no total may be presented, exactly as for
     * `promotionRecords`.
     */
    cleanApprovalStreaks?: "complete" | "unavailable";
    /**
     * Additive, and absent on older payloads. An absent value means the rules
     * read was never attempted by this server, so an empty `rules` array must
     * be treated as unproven rather than as "this workspace has no rules".
     */
    rules?: "complete" | "unavailable";
  };
  /**
   * Deterministic rule definitions with their real 28-day firing counts.
   * An empty array with `readCompleteness.rules === "complete"` is an honest
   * "no rules exist" — the surface renders the empty five-column shell.
   */
  rules?: MetaAutomationRule[];
  /**
   * The Commercial Truth anchors the rule triggers are bound to. A `null`
   * member means the workspace pack does not supply it, and any rule anchored
   * to it renders its threshold as an em dash and never fires.
   */
  commercialAnchors?: AutomationRuleAnchorValues;
  activityLedger: MetaAutomationActivityItem[];
  /** Per-decision-type standing mode (persisted operator preference, or 'manual'
   *  default). Recording a change persists an audit record; it does NOT auto-execute
   *  — writes stay gated by the kill switch, readiness tier and dry-run guardrail. */
  decisionTypeModes: MetaAutomationDecisionTypeMode[];
}

/** A persisted rule plus the real events behind the design's "Fired · 28d". */
export interface MetaAutomationRule extends AutomationRuleDefinition {
  locked: boolean;
  firedCount: number;
  lastFiredAt: string | null;
}

export interface MetaWriteBlockState {
  blocked: boolean;
  reason:
    | "META_ADS_WRITE_KILL_SWITCH"
    | "business_kill_switch"
    | "demo_business_read_only"
    | "control_state_unavailable"
    /** An enforced guard rule refused this write. Additive; never removes a block. */
    | "automation_guard_rule"
    | null;
  message: string | null;
  /** Set only when `reason === "automation_guard_rule"`. */
  guardRule?: { id: string; name: string } | null;
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
  /** Absent on a pre-migration schema; then the ladder renders an em dash. */
  min_roas_floor?: string | number | null;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  quiet_hours_timezone?: string | null;
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
  /** All absent on a pre-migration schema, and on rows written before it. */
  actor_kind?: string | null;
  actor_user_id?: string | null;
  actor_name?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  entity_name?: string | null;
  result_status?: string | null;
  result_receipt_id?: string | null;
};

type ActionLogDbRow = {
  id: string;
  action: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  requested_at: string;
  payload_request: unknown;
  requested_by?: string | null;
  actor_name?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  entity_name?: string | null;
  resulting_ad_id?: string | null;
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
  // No seeded guardrail. An unset ROAS floor or quiet-hours window is a fact
  // about this business, and inventing one under the design's caption would be
  // worse than the em dash it replaces.
  minRoasFloor: null,
  quietHours: null,
};

/**
 * Action-log kinds that count as a clean approval for a ladder row.
 *
 * `budget`, `bid` and `creative` are absent because no provider-write channel
 * for them exists: `meta_ads_action_log.action` is constrained to
 * `pause | resume | duplicate | launch_campaign | launch_adset | launch_ad`,
 * and budget values are only ever POSTed while CREATING an ad set inside
 * `lib/meta/launch-write.ts`, never as a standalone change. Counting zero for
 * those kinds would state "no clean approvals yet" where the truth is "this
 * product cannot make that kind of change at all", so they stay `null`.
 */
export const CLEAN_APPROVAL_ACTION_KINDS: Partial<
  Record<MetaAutomationDecisionType, readonly string[]>
> = {
  pause: ["pause", "resume"],
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

function toFiniteNumberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

/** `13:05:00`, `13:05:00+00` or `13:05` → `13:05`; anything else → `null`. */
export function normalizeQuietHourTime(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?/.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : null;
}

function toQuietHours(row: ControlDbRow): MetaAutomationQuietHours | null {
  const start = normalizeQuietHourTime(row.quiet_hours_start);
  const end = normalizeQuietHourTime(row.quiet_hours_end);
  const timezone =
    typeof row.quiet_hours_timezone === "string"
      ? row.quiet_hours_timezone.trim()
      : "";
  // A half-persisted window is not a window. Presenting `00:00–—` under the
  // design's caption would read as a real guardrail with a rendering bug.
  if (!start || !end || !timezone) return null;
  return { start, end, timezone };
}

function toActorKind(value: unknown): MetaAutomationActorKind | null {
  return value === "operator" || value === "system" ? value : null;
}

function toResultStatus(
  value: unknown,
): MetaAutomationActivityResultStatus | null {
  return value === "applied" ||
    value === "blocked" ||
    value === "failed" ||
    value === "recorded"
    ? value
    : null;
}

function trimmedOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeGuardrails(
  value: unknown,
  policy: ControlDbRow,
): MetaAutomationGuardrails {
  const record = isRecord(value) ? value : {};
  return {
    minRoasFloor: toFiniteNumberOrNull(policy.min_roas_floor),
    quietHours: toQuietHours(policy),
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
    guardrails: normalizeGuardrails(row.guardrails_json, row),
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
  const actorKind = toActorKind(row.actor_kind);
  const entityType = trimmedOrNull(row.entity_type);
  const resultStatus = toResultStatus(row.result_status);
  return {
    id: row.id,
    activityType: row.activity_type,
    severity: toSeverity(row.severity),
    message: row.message,
    payload: isRecord(row.payload_json) ? row.payload_json : null,
    createdAt: row.created_at,
    source: "automation_ledger",
    actor: actorKind
      ? {
          kind: actorKind,
          userId: trimmedOrNull(row.actor_user_id),
          name: trimmedOrNull(row.actor_name),
        }
      : null,
    entity: entityType
      ? {
          type: entityType,
          id: trimmedOrNull(row.entity_id),
          name: trimmedOrNull(row.entity_name),
        }
      : null,
    result: resultStatus
      ? {
          status: resultStatus,
          receiptId: trimmedOrNull(row.result_receipt_id),
        }
      : null,
  };
}

function mapActionLog(row: ActionLogDbRow): MetaAutomationActivityItem {
  const failed = row.status === "failure" || row.status === "silent_failure";
  const blocked = row.error_code === "kill_switch_engaged";
  const requestedBy = trimmedOrNull(row.requested_by);
  const entityType = trimmedOrNull(row.entity_type);
  return {
    id: `meta-action-${row.id}`,
    activityType: `meta_${row.action}`,
    severity: blocked ? "warning" : failed ? "danger" : "success",
    message: blocked
      ? "Meta write blocked by kill switch."
      : failed
        ? row.error_message || `Meta ${row.action} failed.`
        : `Meta ${row.action} completed.`,
    payload: isRecord(row.payload_request) ? row.payload_request : null,
    createdAt: row.requested_at,
    source: "meta_action_log",
    // A provider write is only attributable when the log names the operator who
    // requested it. Rows without `requested_by` keep an em-dash actor rather
    // than being relabelled with the prototype's "System guard" placeholder.
    actor: requestedBy
      ? {
          kind: "operator",
          userId: requestedBy,
          name: trimmedOrNull(row.actor_name),
        }
      : null,
    // `ad_id` holds a synthetic placeholder for launch rows
    // (`launch:<key>:campaign`), so the entity is presented only when a
    // warehouse dimension in this account actually matches the requested or
    // resulting id.
    entity: entityType
      ? {
          type: entityType,
          id: trimmedOrNull(row.entity_id),
          name: trimmedOrNull(row.entity_name),
        }
      : null,
    result: {
      status: blocked ? "blocked" : failed ? "failed" : "applied",
      receiptId: failed ? null : trimmedOrNull(row.resulting_ad_id),
    },
  };
}

function isUndefinedTableError(error: unknown) {
  return isRecord(error) && error.code === "42P01";
}

function isUndefinedColumnError(error: unknown) {
  return isRecord(error) && error.code === "42703";
}

/**
 * Run a statement that names the additive tuple/guardrail columns, and fall back
 * to the pre-migration column list when they are not there yet.
 *
 * Without this the additive columns would be a silent outage rather than an
 * additive change. Every read here is wrapped in a swallow-all `safeRead`, so a
 * single `42703` would turn the whole activity ledger — or the whole business
 * control row — into "unavailable" on an unmigrated database, and the ledger
 * INSERTs would make the kill switch itself unusable there.
 */
async function withAdditiveColumnFallback<T>(
  modern: () => Promise<T>,
  legacy: () => Promise<T>,
): Promise<T> {
  try {
    return await modern();
  } catch (error) {
    if (!isUndefinedColumnError(error)) throw error;
    return legacy();
  }
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
  const rows = await withAdditiveColumnFallback(
    async () =>
      (await sql`
        SELECT
          control.business_id,
          business.is_demo_business,
          control.kill_switch_engaged,
          control.kill_switch_reason,
          control.auto_execution_enabled,
          control.readiness_tier,
          control.guardrails_json,
          control.updated_at,
          control.updated_by,
          control.min_roas_floor,
          control.quiet_hours_start,
          control.quiet_hours_end,
          control.quiet_hours_timezone
        FROM businesses business
        LEFT JOIN meta_automation_business_controls control
          ON control.business_id = business.id
        WHERE business.id = ${businessId}
        LIMIT 1
      `) as ControlDbRow[],
    async () =>
      (await sql`
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
      `) as ControlDbRow[],
  );
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
  const rows = await withAdditiveColumnFallback(
    async () =>
      (await sql`
        SELECT
          ledger.id,
          ledger.activity_type,
          ledger.severity,
          ledger.message,
          ledger.payload_json,
          ledger.created_at,
          ledger.actor_kind,
          ledger.created_by AS actor_user_id,
          actor.name AS actor_name,
          ledger.entity_type,
          ledger.entity_id,
          entity_business.name AS entity_name,
          ledger.result_status,
          ledger.result_receipt_id
        FROM meta_automation_activity_ledger ledger
        LEFT JOIN users actor
          ON actor.id = ledger.created_by
        LEFT JOIN businesses entity_business
          ON ledger.entity_type = 'business'
          AND entity_business.id::text = ledger.entity_id
        WHERE ledger.business_id = ${businessId}
        ORDER BY ledger.created_at DESC
        LIMIT 20
      `) as ActivityDbRow[],
    async () =>
      (await sql`
        SELECT id, activity_type, severity, message, payload_json, created_at
        FROM meta_automation_activity_ledger
        WHERE business_id = ${businessId}
        ORDER BY created_at DESC
        LIMIT 20
      `) as ActivityDbRow[],
  );
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
        log.payload_request,
        log.requested_by,
        log.resulting_ad_id,
        actor.name AS actor_name,
        entity.entity_type,
        entity.entity_id,
        entity.entity_name
      FROM meta_ads_action_log log
      LEFT JOIN users actor
        ON actor.id = log.requested_by
      LEFT JOIN LATERAL (
        SELECT matched.entity_type, matched.entity_id, matched.entity_name
        FROM (
          SELECT
            'ad'::text AS entity_type,
            dimension.ad_id AS entity_id,
            dimension.ad_name_current AS entity_name
          FROM meta_ad_dimensions dimension
          WHERE dimension.business_id::text = ${businessId}
            AND (
              ${providerAccountId}::text IS NULL
              OR dimension.provider_account_id = ${providerAccountId}
            )
            AND dimension.ad_id IN (log.ad_id, log.resulting_ad_id)
          UNION ALL
          SELECT
            'campaign'::text,
            dimension.campaign_id,
            dimension.campaign_name_current
          FROM meta_campaign_dimensions dimension
          WHERE dimension.business_id::text = ${businessId}
            AND (
              ${providerAccountId}::text IS NULL
              OR dimension.provider_account_id = ${providerAccountId}
            )
            AND dimension.campaign_id IN (log.ad_id, log.resulting_ad_id)
          UNION ALL
          SELECT
            'adset'::text,
            dimension.adset_id,
            dimension.adset_name_current
          FROM meta_adset_dimensions dimension
          WHERE dimension.business_id::text = ${businessId}
            AND (
              ${providerAccountId}::text IS NULL
              OR dimension.provider_account_id = ${providerAccountId}
            )
            AND dimension.adset_id IN (log.ad_id, log.resulting_ad_id)
        ) matched
        LIMIT 1
      ) entity ON TRUE
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
        log.payload_request,
        log.requested_by,
        log.resulting_ad_id,
        actor.name AS actor_name,
        entity.entity_type,
        entity.entity_id,
        entity.entity_name
      FROM meta_ads_action_log log
      LEFT JOIN users actor
        ON actor.id = log.requested_by
      LEFT JOIN LATERAL (
        SELECT matched.entity_type, matched.entity_id, matched.entity_name
        FROM (
          SELECT
            'ad'::text AS entity_type,
            dimension.ad_id AS entity_id,
            dimension.ad_name_current AS entity_name
          FROM meta_ad_dimensions dimension
          WHERE dimension.business_id::text = ${businessId}
            AND (
              ${providerAccountId}::text IS NULL
              OR dimension.provider_account_id = ${providerAccountId}
            )
            AND dimension.ad_id IN (log.ad_id, log.resulting_ad_id)
          UNION ALL
          SELECT
            'campaign'::text,
            dimension.campaign_id,
            dimension.campaign_name_current
          FROM meta_campaign_dimensions dimension
          WHERE dimension.business_id::text = ${businessId}
            AND (
              ${providerAccountId}::text IS NULL
              OR dimension.provider_account_id = ${providerAccountId}
            )
            AND dimension.campaign_id IN (log.ad_id, log.resulting_ad_id)
          UNION ALL
          SELECT
            'adset'::text,
            dimension.adset_id,
            dimension.adset_name_current
          FROM meta_adset_dimensions dimension
          WHERE dimension.business_id::text = ${businessId}
            AND (
              ${providerAccountId}::text IS NULL
              OR dimension.provider_account_id = ${providerAccountId}
            )
            AND dimension.adset_id IN (log.ad_id, log.resulting_ad_id)
        ) matched
        LIMIT 1
      ) entity ON TRUE
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

/**
 * The clean-approval streak for one action kind.
 *
 * Counts successful, operator-attributed provider writes of that kind since the
 * later of the tier's own start and the most recent failed write of the same
 * kind, which is the ladder's stated rule ("any error demotes instantly")
 * expressed as a count rather than as prose.
 */
async function readCleanApprovalStreak(input: {
  businessId: string;
  decisionType: MetaAutomationDecisionType;
  tierStartedAt: string;
}): Promise<number | null> {
  const actions = CLEAN_APPROVAL_ACTION_KINDS[input.decisionType];
  if (!actions || actions.length === 0) return null;
  const sql = getDb();
  const rows = (await sql`
    SELECT COUNT(*)::int AS clean_approvals
    FROM meta_ads_action_log log
    WHERE log.business_id = ${input.businessId}
      AND log.action = ANY(${actions as string[]}::text[])
      AND log.requested_by IS NOT NULL
      AND log.status = 'success'
      AND log.requested_at > COALESCE(
        (
          SELECT MAX(failed.requested_at)
          FROM meta_ads_action_log failed
          WHERE failed.business_id = log.business_id
            AND failed.action = ANY(${actions as string[]}::text[])
            AND failed.requested_by IS NOT NULL
            AND failed.status IN ('failure', 'silent_failure')
            AND failed.requested_at >= ${input.tierStartedAt}::timestamptz
        ),
        ${input.tierStartedAt}::timestamptz
      )
  `) as Array<{ clean_approvals: number | string | null }>;
  const count = Number(rows[0]?.clean_approvals);
  return Number.isFinite(count) ? count : null;
}

/**
 * Attach the derived streak to every ladder row that can carry one.
 *
 * A row only earns a count when its tier is a persisted decision (so the window
 * has a real start) AND an operator has committed a threshold (so the count has
 * a denominator). Reading a streak nobody set a target for would put a bare
 * number under a caption that promises a ratio.
 */
async function readCleanApprovalStreaks(
  businessId: string,
  modes: MetaAutomationDecisionTypeMode[],
): Promise<MetaAutomationDecisionTypeMode[]> {
  return Promise.all(
    modes.map(async (mode) => {
      if (
        mode.source !== "persisted" ||
        !mode.updatedAt ||
        mode.cleanApprovalThreshold === null
      ) {
        return mode;
      }
      return {
        ...mode,
        cleanApprovalStreak: await readCleanApprovalStreak({
          businessId,
          decisionType: mode.decisionType,
          tierStartedAt: mode.updatedAt,
        }),
      };
    }),
  );
}

function normalizeKillSwitchReason(value: unknown) {
  const reason = typeof value === "string" ? value.trim() : "";
  return (
    reason.slice(0, 500) || "Operator stopped all Meta writes from Automation."
  );
}

/**
 * The single place an automation activity row is written.
 *
 * Every caller already knows who acted, what they acted on and how it landed;
 * before this the ledger threw all three away and kept only a sentence, which
 * is why three of the screen's five columns had nothing to render. The actor's
 * user id stays in the existing `created_by` foreign key — one id, one owner —
 * and `actor_kind` supplies the type that column never carried.
 */
async function writeActivityLedgerRow(input: {
  businessId: string;
  activityType: string;
  severity: MetaAutomationActivityItem["severity"];
  message: string;
  payload: Record<string, unknown>;
  userId: string;
  actorKind?: MetaAutomationActorKind;
  entityType: string;
  entityId: string | null;
  resultStatus: MetaAutomationActivityResultStatus;
  resultReceiptId: string | null;
}) {
  const sql = getDb();
  const payloadJson = JSON.stringify(input.payload);
  await withAdditiveColumnFallback(
    async () => {
      await sql`
        INSERT INTO meta_automation_activity_ledger (
          business_id,
          activity_type,
          severity,
          message,
          payload_json,
          created_by,
          actor_kind,
          entity_type,
          entity_id,
          result_status,
          result_receipt_id
        )
        VALUES (
          ${input.businessId},
          ${input.activityType},
          ${input.severity},
          ${input.message},
          ${payloadJson}::jsonb,
          ${input.userId},
          ${input.actorKind ?? "operator"},
          ${input.entityType},
          ${input.entityId},
          ${input.resultStatus},
          ${input.resultReceiptId}
        )
      `;
    },
    async () => {
      // Pre-migration schema: keep recording the act. The tuple columns are the
      // additive part, so their absence must cost the three columns, not the row.
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
          ${input.businessId},
          ${input.activityType},
          ${input.severity},
          ${input.message},
          ${payloadJson}::jsonb,
          ${input.userId}
        )
      `;
    },
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
    RETURNING *
  `) as ControlDbRow[];
  await writeActivityLedgerRow({
    businessId,
    activityType: "business_kill_switch_engaged",
    severity: "danger",
    message: "Business kill switch engaged — all Meta writes stopped.",
    payload: { reason },
    userId: input.userId,
    entityType: "business",
    entityId: businessId,
    resultStatus: "applied",
    resultReceiptId: null,
  });
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
    RETURNING *
  `) as ControlDbRow[];
  await writeActivityLedgerRow({
    businessId,
    activityType: "business_kill_switch_released",
    severity: "warning",
    message:
      "Business kill switch released — Meta writes may resume, still subject to the remaining automation gates.",
    payload: {},
    userId: input.userId,
    entityType: "business",
    entityId: businessId,
    resultStatus: "applied",
    resultReceiptId: null,
  });
  return mapControlRow(rows[0], businessId);
}

type DecisionTypeModeDbRow = {
  decision_type: string;
  mode: string;
  lock_reason: string | null;
  updated_at: string | null;
  updated_by: string | null;
  clean_approval_threshold?: number | string | null;
};

function defaultDecisionTypeModes(): MetaAutomationDecisionTypeMode[] {
  return META_AUTOMATION_DECISION_TYPES.map((decisionType) => ({
    decisionType,
    mode: "manual",
    lockReason: null,
    updatedAt: null,
    updatedBy: null,
    source: "default",
    cleanApprovalThreshold: null,
    cleanApprovalStreak: null,
  }));
}

async function readDecisionTypeModes(
  businessId: string,
): Promise<MetaAutomationDecisionTypeMode[]> {
  const sql = getDb();
  const rows = await withAdditiveColumnFallback(
    async () =>
      (await sql`
        SELECT
          decision_type,
          mode,
          lock_reason,
          updated_at,
          updated_by,
          clean_approval_threshold
        FROM meta_automation_decision_type_modes
        WHERE business_id = ${businessId}
      `) as DecisionTypeModeDbRow[],
    async () =>
      (await sql`
        SELECT decision_type, mode, lock_reason, updated_at, updated_by
        FROM meta_automation_decision_type_modes
        WHERE business_id = ${businessId}
      `) as DecisionTypeModeDbRow[],
  );
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
        cleanApprovalThreshold: null,
        cleanApprovalStreak: null,
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
      cleanApprovalThreshold: normalizeCleanApprovalThreshold(
        row.clean_approval_threshold,
      ),
      cleanApprovalStreak: null,
    };
  });
}

/** A threshold is a positive whole number of approvals or it is not a threshold. */
export function normalizeCleanApprovalThreshold(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const next = Number(value);
  return Number.isFinite(next) && next >= 1 ? Math.trunc(next) : null;
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
  /**
   * Omit to leave the persisted threshold untouched; pass `null` to clear it.
   * A cleared threshold returns the ladder row to the em dash rather than to a
   * default, because "we no longer state a promotion target" and "the target is
   * 30" are different claims.
   */
  cleanApprovalThreshold?: number | null;
}): Promise<MetaAutomationDecisionTypeMode[]> {
  const businessId = input.businessId.trim();
  const sql = getDb();
  const reason =
    typeof input.reason === "string"
      ? input.reason.trim().slice(0, 500) || null
      : null;
  const thresholdProvided = input.cleanApprovalThreshold !== undefined;
  const threshold = thresholdProvided
    ? normalizeCleanApprovalThreshold(input.cleanApprovalThreshold)
    : null;
  const priorRows = (await sql`
    SELECT mode FROM meta_automation_decision_type_modes
    WHERE business_id = ${businessId} AND decision_type = ${input.decisionType}
  `) as Array<{ mode: string }>;
  const priorMode = priorRows[0]?.mode ?? "manual";
  await withAdditiveColumnFallback(
    async () => {
      await sql`
        INSERT INTO meta_automation_decision_type_modes (
          business_id, decision_type, mode, lock_reason, updated_by, updated_at,
          clean_approval_threshold
        )
        VALUES (
          ${businessId}, ${input.decisionType}, ${input.mode}, ${reason},
          ${input.userId}, NOW(), ${threshold}
        )
        ON CONFLICT (business_id, decision_type)
        DO UPDATE SET
          mode = EXCLUDED.mode,
          lock_reason = EXCLUDED.lock_reason,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW(),
          clean_approval_threshold = CASE
            WHEN ${thresholdProvided} THEN EXCLUDED.clean_approval_threshold
            ELSE meta_automation_decision_type_modes.clean_approval_threshold
          END
      `;
    },
    async () => {
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
    },
  );
  const promotionRows = (await sql`
    INSERT INTO meta_automation_promotion_records (
      business_id, entity_type, entity_id, source_tier, target_tier, status, reason, created_by
    )
    VALUES (${businessId}, 'decision_type_mode', ${input.decisionType}, ${priorMode}, ${input.mode}, 'approved', ${reason}, ${input.userId})
    RETURNING id
  `) as Array<{ id: string }>;
  await writeActivityLedgerRow({
    businessId,
    activityType: "decision_type_mode_change",
    severity: "info",
    message: `${input.decisionType} standing mode set to ${input.mode}${priorMode !== input.mode ? ` (from ${priorMode})` : ""}.`,
    payload: {
      decisionType: input.decisionType,
      from: priorMode,
      to: input.mode,
      ...(thresholdProvided ? { cleanApprovalThreshold: threshold } : {}),
    },
    userId: input.userId,
    entityType: "automation_decision_type",
    entityId: input.decisionType,
    // Recording a standing preference is not a provider write, and the receipt
    // is the promotion record this change is auditable through.
    resultStatus: "recorded",
    resultReceiptId: promotionRows[0]?.id ?? null,
  });
  return readDecisionTypeModes(businessId);
}

/**
 * Persist the business's guardrail policy: the ROAS floor below which a pause
 * may be proposed, and the quiet-hours window during which provider writes are
 * refused.
 *
 * Kept out of `guardrails_json` on purpose. The JSONB column carries a literal
 * server-side default, so a value living there cannot be distinguished from one
 * this process supplied; dedicated nullable columns make "no operator has set a
 * ROAS floor" a readable state instead of an invisible one.
 */
export async function setMetaAutomationGuardrailPolicy(input: {
  businessId: string;
  userId: string;
  minRoasFloor: number | null;
  quietHours: MetaAutomationQuietHours | null;
}): Promise<MetaAutomationBusinessControl> {
  const businessId = input.businessId.trim();
  const sql = getDb();
  const minRoasFloor =
    typeof input.minRoasFloor === "number" &&
    Number.isFinite(input.minRoasFloor) &&
    input.minRoasFloor > 0
      ? input.minRoasFloor
      : null;
  const quietHours = input.quietHours
    ? {
        start: normalizeQuietHourTime(input.quietHours.start),
        end: normalizeQuietHourTime(input.quietHours.end),
        timezone: input.quietHours.timezone.trim().slice(0, 40) || null,
      }
    : { start: null, end: null, timezone: null };
  const quietHoursComplete = Boolean(
    quietHours.start && quietHours.end && quietHours.timezone,
  );
  const rows = (await sql`
    INSERT INTO meta_automation_business_controls (
      business_id,
      min_roas_floor,
      quiet_hours_start,
      quiet_hours_end,
      quiet_hours_timezone,
      updated_by,
      updated_at
    )
    VALUES (
      ${businessId},
      ${minRoasFloor},
      ${quietHoursComplete ? quietHours.start : null}::time,
      ${quietHoursComplete ? quietHours.end : null}::time,
      ${quietHoursComplete ? quietHours.timezone : null},
      ${input.userId},
      NOW()
    )
    ON CONFLICT (business_id)
    DO UPDATE SET
      min_roas_floor = EXCLUDED.min_roas_floor,
      quiet_hours_start = EXCLUDED.quiet_hours_start,
      quiet_hours_end = EXCLUDED.quiet_hours_end,
      quiet_hours_timezone = EXCLUDED.quiet_hours_timezone,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING *
  `) as ControlDbRow[];
  await writeActivityLedgerRow({
    businessId,
    activityType: "automation_guardrail_policy_updated",
    severity: "info",
    message: "Automation guardrail policy updated.",
    payload: {
      minRoasFloor,
      quietHours: quietHoursComplete ? quietHours : null,
    },
    userId: input.userId,
    entityType: "business",
    entityId: businessId,
    resultStatus: "applied",
    resultReceiptId: null,
  });
  return mapControlRow(rows[0], businessId);
}

/**
 * Read the persisted rules and join each one to its real 28-day firing count.
 *
 * Both halves have to succeed. A rule list without counts would force the
 * surface to either invent a number or show a rule row whose count column lies,
 * so a count failure makes the whole read `unavailable` and the table stays on
 * the honest empty geometry.
 */
async function readAutomationRules(input: {
  businessId: string;
  asOf: Date;
}): Promise<{
  rules: MetaAutomationRule[];
  anchors: AutomationRuleAnchorValues;
}> {
  const [rules, counts, snapshot] = await Promise.all([
    listAutomationRules(input.businessId),
    countAutomationRuleFirings({
      businessId: input.businessId,
      asOf: input.asOf,
    }),
    getBusinessCommercialTruthSnapshot(input.businessId),
  ]);
  return {
    rules: rules.map((rule) => {
      const count = counts.get(rule.id);
      return {
        ...rule,
        locked: rule.mode === "enforced",
        firedCount: count?.firedCount ?? 0,
        lastFiredAt: count?.lastFiredAt ?? null,
      };
    }),
    anchors: anchorsFromTargetPack(snapshot.targetPack),
  };
}

export async function getMetaAutomationControlPlane(input: {
  businessId: string;
  providerAccountId?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Explicit evaluation instant for the 28-day firing window. */
  asOf?: Date;
}): Promise<MetaAutomationControlPlane> {
  const businessId = input.businessId.trim();
  const providerAccountId = input.providerAccountId?.trim() || null;
  const env = input.env ?? process.env;
  const globalKillSwitchEngaged = isGlobalMetaAdsWriteKillSwitchEngaged(env);
  const businessControl = await safeRead(
    () => readBusinessControl(businessId),
    defaultBusinessControl(businessId),
  );
  const [
    promotionRead,
    automationActivity,
    actionActivity,
    decisionTypeModes,
    rulesRead,
  ] = await Promise.all([
    readWithCompleteness(() => readPromotionRecords(businessId), []),
    safeRead(() => readActivityLedger(businessId), []),
    safeRead(() => readRecentActionLedger(businessId, providerAccountId), []),
    safeRead(
      () => readDecisionTypeModes(businessId),
      defaultDecisionTypeModes(),
    ),
    readWithCompleteness(
      () => readAutomationRules({ businessId, asOf: input.asOf ?? new Date() }),
      {
        rules: [] as MetaAutomationRule[],
        anchors: anchorsFromTargetPack(null),
      },
    ),
  ]);
  const blockedReasons = [
    globalKillSwitchEngaged ? "META_ADS_WRITE_KILL_SWITCH" : null,
    businessControl.killSwitchEngaged ? "business_kill_switch" : null,
    !businessControl.autoExecutionEnabled ? "auto_execution_not_enabled" : null,
    businessControl.guardrails.dryRunOnly ? "dry_run_only_guardrail" : null,
  ].filter((item): item is string => Boolean(item));

  // Second phase on purpose: a streak window starts at the tier's own
  // `updatedAt`, which is only known once the modes have been read.
  const streakRead = await readWithCompleteness(
    () => readCleanApprovalStreaks(businessId, decisionTypeModes),
    decisionTypeModes,
  );

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
      cleanApprovalStreaks: streakRead.completeness,
      rules: rulesRead.completeness,
    },
    rules: rulesRead.value.rules,
    commercialAnchors: rulesRead.value.anchors,
    activityLedger: [...automationActivity, ...actionActivity]
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      )
      .slice(0, 30),
    decisionTypeModes: streakRead.value,
  };
}

export async function getMetaWriteBlockState(input: {
  businessId: string;
  env?: NodeJS.ProcessEnv;
  /** Explicit instant for temporal guard rules; defaults to now. */
  at?: Date;
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
  if (control.killSwitchEngaged) {
    return {
      blocked: true,
      reason: "business_kill_switch",
      message:
        control.killSwitchReason ||
        "Meta writes are disabled by business kill switch.",
    };
  }

  const at = input.at ?? new Date();

  // Enforced guard rules, consulted at the SAME choke point every existing
  // write path already goes through. This can only add a block: reaching here
  // means every prior gate said "not blocked", and the only two outcomes below
  // are the unchanged pass and a new refusal. A missing rules table is treated
  // as "no guards" so an un-migrated database keeps today's behaviour; any
  // other read failure falls back to the existing fail-closed reason rather
  // than silently permitting a write we could not check.
  //
  // "No guards" is deliberately NOT an early return: the operator's own
  // quiet-hours window below lives in a different table, and an un-migrated
  // rules table must not be able to lift a guardrail that does not depend on it.
  let guardRules: AutomationRuleDefinition[] = [];
  try {
    guardRules = await listAutomationRules(businessId);
  } catch (error) {
    if (!isUndefinedTableError(error)) {
      return {
        blocked: true,
        reason: "control_state_unavailable",
        message:
          "Meta writes are temporarily blocked because automation guard rules could not be verified.",
      };
    }
  }

  const guardBlock = evaluateAutomationGuardRules({
    rules: guardRules,
    at,
  });
  if (guardBlock) {
    return {
      blocked: true,
      reason: "automation_guard_rule",
      message: guardBlock.reason,
      guardRule: { id: guardBlock.ruleId, name: guardBlock.ruleName },
    };
  }

  // The persisted quiet-hours guardrail, at the same boundary and with the same
  // refusal. `setMetaAutomationGuardrailPolicy` promises writes are refused
  // during the configured window; this is where that promise is kept.
  //
  // Same `automation_guard_rule` reason as an enforced rule's refusal on
  // purpose — one concept, one path, indistinguishable to every caller. It
  // carries no `guardRule` because there is no rule: a firing row is keyed to a
  // real `meta_automation_rules` id, and minting one for a window an operator
  // typed into the guardrail panel would be forged lineage.
  //
  // Fail-closed by construction: see `evaluatePersistedQuietHoursGuardrail`. An
  // unresolvable timezone, an unreadable HH:MM boundary or a start equal to its
  // end all REFUSE the write rather than permitting one this process could not
  // check against the window the operator committed.
  const quietHoursBlock = evaluatePersistedQuietHoursGuardrail({
    quietHours: control.guardrails.quietHours,
    at,
  });
  if (quietHoursBlock) {
    return {
      blocked: true,
      reason: "automation_guard_rule",
      message: quietHoursBlock.reason,
      guardRule: null,
    };
  }

  return { blocked: false, reason: null, message: null };
}
