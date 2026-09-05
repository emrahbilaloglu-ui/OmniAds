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
import { readMetaReleaseGates } from "@/lib/meta/release-gates";

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
  /** False only for a corrupt or half-persisted ceiling pair. */
  perActionSpendCeilingValid: boolean;
  notificationPolicy: "every_auto_action" | "none";
  maxBudgetIncreasePct: number;
  maxDailyBudgetChangeMinor: number | null;
  /** D074b: automation requires a RESOLVED automatic campaign role (there is
   * no label to require). Parses the pre-D074b `requireCampaignLabel` key
   * from persisted guardrail rows as a compatibility alias. */
  requireResolvedCampaignRole: boolean;
  requireCommercialAnchor: boolean;
  requireLivePreflight: boolean;
  requireRollbackPlan: boolean;
  dryRunOnly: boolean;
  /*
    D088 C3 — the budget-write policy keys, ADDITIVE and NULLABLE.

    They have no permissive default: a business that has never configured them
    reads `null`, the D087 policy cannot be built, and activation blocks until
    an operator persists real numbers. Inventing a value here would be
    inventing permission.
  */
  budgetMinHoursBetweenChanges: number | null;
  budgetMaxChangesPer7d: number | null;
  budgetMaxAccountConcentrationPct: number | null;
  /*
    Which sizing policies this business's configuration is bound to.

    A sizing policy is an operating decision — the bands, the ladder, the
    damping — and a build that changed it must not silently start proposing
    different amounts against a configuration nobody re-approved. The producer
    refuses when the stamped version is not the one it implements, so an
    unstamped business (every business today) proposes nothing until an
    operator saves their automation configuration.
  */
  budgetSizingPolicyVersion: string | null;
  bidSizingPolicyVersion: string | null;
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

/**
 * Why a section of this screen cannot be stated.
 *
 * `migration_required` is separated from `unavailable` because they call for
 * different acts: one is a deploy, the other is a retry. Collapsing them made
 * an unmigrated database look like a flaky read forever.
 */
export type MetaAutomationSectionStatus =
  | "complete"
  | "unavailable"
  | "migration_required";

/**
 * One section's provenance.
 *
 * `observedAt` is the instant the read was ATTEMPTED, not a data timestamp, and
 * it is stamped for failures too — "we tried at 12:04 and could not read it" is
 * the fact the freshness bar needs, and it is not the same as "no data".
 */
export interface MetaAutomationSectionCompleteness {
  status: MetaAutomationSectionStatus;
  errorCode: string | null;
  observedAt: string;
}

/**
 * The sections the Automation screen draws, each answering for its own read.
 *
 * One failing section must not erase the others: before this, a screen-wide
 * notion of "unavailable" meant a broken rules read blanked a promotion count
 * the server had actually proven. Every entry here is independent, and the
 * surface renders each card from its own entry.
 */
export interface MetaAutomationSections {
  businessControl: MetaAutomationSectionCompleteness;
  rules: MetaAutomationSectionCompleteness;
  activity: MetaAutomationSectionCompleteness;
  promotionRecords: MetaAutomationSectionCompleteness;
  decisionModes: MetaAutomationSectionCompleteness;
  /** The Commercial Truth pack the rule triggers are bound to. */
  anchors: MetaAutomationSectionCompleteness;
  /** The readiness tier and its promotion ladder. */
  readiness: MetaAutomationSectionCompleteness;
}

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
    /**
     * Additive, and absent on older payloads.
     *
     * `businessControl` below is ALWAYS populated — a failed read degrades to
     * `defaultBusinessControl`, which is a concrete, benign-looking state
     * (`killSwitchEngaged: false`, `readinessTier: "manual_review"`, the 15%
     * / 3-action default guardrails). Without this flag the surface could not
     * tell that state apart from one the database actually returned, and it
     * printed a green ENABLED pill and hard guardrail numbers during a control
     * read failure — while `getMetaWriteBlockState` refused every write in the
     * same window with `control_state_unavailable`. That is a read failure
     * rendered as a success, which this screen must never do.
     *
     * Anything other than `"complete"` (including absent) means no field of
     * `businessControl` may be stated as fact.
     */
    businessControl?: "complete" | "unavailable";
    /**
     * Additive, and absent on older payloads. Separates "this workspace has
     * never acted" from "the activity read failed": both produce an empty
     * `activityLedger`, and only the first one may be presented as an empty
     * ledger. Absent or `unavailable` keeps the em dash.
     */
    activityLedger?: "complete" | "unavailable";
  };
  /**
   * Per-section provenance, additive beside the flat `readCompleteness` map.
   *
   * Both exist on purpose: `readCompleteness` is the shape older payloads and
   * existing callers already read, and dropping it would make an additive
   * envelope a breaking change. `sections` is the richer one — it carries the
   * error code and the observation instant that the flat map has nowhere to
   * put — and an absent `sections` means this payload came from a server that
   * did not produce one, never that everything is fine.
   */
  sections?: MetaAutomationSections;
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
    /** The environment capability for live Meta writes is not open. */
    | "release_capability_closed"
    /** The business is deliberately parked in the read-only readiness tier. */
    | "readiness_tier_read_only"
    | null;
  message: string | null;
  /** Set only when `reason === "automation_guard_rule"`. */
  guardRule?: { id: string; name: string } | null;
  /**
   * Whether this business is in rehearsal, and every write must stop before Meta.
   *
   * NOT a block, and the distinction is the whole point. A rehearsal write
   * still happens — it reads the entity back, journals a receipt and tells the
   * operator what would have been written — it just never posts. Refusing it
   * outright would take away the one safe way to try a change; letting it
   * through as a real write would be worse.
   *
   * The client's `dryRun` can only ADD to this. `guardrails.dryRunOnly` is a
   * persisted posture and a request that omits the flag must not escape it,
   * which is exactly what happened before: every entity and ad route read
   * `dryRun` from the request body alone, so an operator request with the field
   * omitted reached a provider POST while the business was in rehearsal.
   *
   * `true` whenever the posture could not be read, for the same reason every
   * other unknown here fails closed.
   */
  rehearsal: boolean;
}

export interface MetaEffectiveWriteGovernance {
  verified: boolean;
  controlsConfigured: boolean;
  writeBlocked: boolean;
  blockReason:
    | "META_ADS_WRITE_KILL_SWITCH"
    | "business_kill_switch"
    | "business_control_not_configured"
    | "control_state_unavailable"
    | "demo_business_read_only"
    | null;
  killSwitchEngaged: boolean;
  killSwitchReason: string | null;
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
  perActionSpendCeilingValid: true,
  notificationPolicy: "every_auto_action",
  maxBudgetIncreasePct: 15,
  maxDailyBudgetChangeMinor: null,
  requireResolvedCampaignRole: true,
  requireCommercialAnchor: true,
  requireLivePreflight: true,
  requireRollbackPlan: true,
  dryRunOnly: true,
  // No permissive default: unconfigured is unknown, and unknown blocks.
  budgetMinHoursBetweenChanges: null,
  budgetMaxChangesPer7d: null,
  budgetMaxAccountConcentrationPct: null,
  budgetSizingPolicyVersion: null,
  bidSizingPolicyVersion: null,
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

/** Preserve guardrails whose configuration contract explicitly allows decimals. */
function toPositiveFiniteNumberOrNull(value: unknown) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : null;
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

/**
 * D074b correction: the legacy alias may only TIGHTEN this guardrail. A
 * pre-D074b persisted `false` under the legacy key must not disable the
 * resolved-role requirement; only the canonical key can relax it.
 */
export function resolveRequireResolvedCampaignRole(
  record: Record<string, unknown>,
): boolean {
  return toBool(
    record.requireResolvedCampaignRole ??
      (record.requireCampaignLabel === true ? true : undefined),
    DEFAULT_META_AUTOMATION_GUARDRAILS.requireResolvedCampaignRole,
  );
}

function normalizeGuardrails(
  value: unknown,
  policy: ControlDbRow,
): MetaAutomationGuardrails {
  const record = isRecord(value) ? value : {};
  const hasCeilingMinor = Object.prototype.hasOwnProperty.call(
    record,
    "perActionSpendCeilingMinor",
  );
  const hasCeilingCurrency = Object.prototype.hasOwnProperty.call(
    record,
    "perActionSpendCeilingCurrency",
  );
  const ceilingAbsent = !hasCeilingMinor && !hasCeilingCurrency;
  const ceilingCleared = hasCeilingMinor && hasCeilingCurrency
    && record.perActionSpendCeilingMinor === null
    && record.perActionSpendCeilingCurrency === null;
  const ceilingMinor = ceilingAbsent
    ? DEFAULT_META_AUTOMATION_GUARDRAILS.perActionSpendCeilingMinor
    : Number.isSafeInteger(record.perActionSpendCeilingMinor)
      && (record.perActionSpendCeilingMinor as number) > 0
      ? record.perActionSpendCeilingMinor as number
      : null;
  const ceilingCurrency = ceilingAbsent
    ? DEFAULT_META_AUTOMATION_GUARDRAILS.perActionSpendCeilingCurrency
    : toCurrencyOrNull(record.perActionSpendCeilingCurrency);
  const ceilingValid = ceilingAbsent || ceilingCleared || (
    ceilingMinor !== null && ceilingCurrency !== null
  );
  return {
    minRoasFloor: toFiniteNumberOrNull(policy.min_roas_floor),
    quietHours: toQuietHours(policy),
    /*
      D088 C3: parsed with NO fallback. An absent or unusable value stays null,
      which is what makes activation block rather than proceed on a default
      nobody chose.
    */
    budgetMinHoursBetweenChanges:
      toPositiveFiniteNumberOrNull(record.budgetMinHoursBetweenChanges),
    budgetMaxChangesPer7d: toPositiveNumberOrNull(record.budgetMaxChangesPer7d),
    budgetMaxAccountConcentrationPct:
      toPositiveFiniteNumberOrNull(record.budgetMaxAccountConcentrationPct),
    budgetSizingPolicyVersion:
      typeof record.budgetSizingPolicyVersion === "string"
      && record.budgetSizingPolicyVersion.trim().length > 0
        ? record.budgetSizingPolicyVersion.trim()
        : null,
    bidSizingPolicyVersion:
      typeof record.bidSizingPolicyVersion === "string"
      && record.bidSizingPolicyVersion.trim().length > 0
        ? record.bidSizingPolicyVersion.trim()
        : null,
    dailyAutoActionCap:
      toPositiveNumberOrNull(record.dailyAutoActionCap) ??
      DEFAULT_META_AUTOMATION_GUARDRAILS.dailyAutoActionCap,
    perActionSpendCeilingMinor: ceilingMinor,
    perActionSpendCeilingCurrency: ceilingCurrency,
    perActionSpendCeilingValid: ceilingValid,
    notificationPolicy: toNotificationPolicy(record.notificationPolicy),
    maxBudgetIncreasePct:
      toPositiveFiniteNumberOrNull(record.maxBudgetIncreasePct) ??
      DEFAULT_META_AUTOMATION_GUARDRAILS.maxBudgetIncreasePct,
    maxDailyBudgetChangeMinor:
      toPositiveNumberOrNull(record.maxDailyBudgetChangeMinor) ??
      DEFAULT_META_AUTOMATION_GUARDRAILS.maxDailyBudgetChangeMinor,
    requireResolvedCampaignRole: resolveRequireResolvedCampaignRole(record),
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

/**
 * Degrade a read to a fallback value, WITHOUT recording that it degraded.
 *
 * Only legitimate where the fallback is indistinguishable from the real answer
 * to the reader — i.e. where nothing downstream presents the value as a fact.
 * Anything a surface prints must go through `readWithCompleteness` instead, so
 * the payload can say "this was not read" rather than showing the fallback.
 *
 * The old body branched on `isUndefinedTableError` and then returned the same
 * fallback in both arms — dead code that documented an intent (only a missing
 * table degrades) the function did not honour. The intent is not restored here
 * because the callers that needed it now carry provenance instead; the branch
 * is removed so it cannot be mistaken for a live guarantee.
 */
async function safeRead<T>(reader: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await reader();
  } catch {
    return fallback;
  }
}

/**
 * Classify a failed section read.
 *
 * `undefined_table` / `undefined_column` mean a pending migration, not a flaky
 * read, and the operator's next act differs accordingly: one is a deploy, the
 * other is the Retry button.
 */
function sectionStatusFor(error: unknown): {
  status: MetaAutomationSectionStatus;
  errorCode: string;
} {
  if (isUndefinedTableError(error)) {
    return { status: "migration_required", errorCode: "undefined_table" };
  }
  if (isUndefinedColumnError(error)) {
    return { status: "migration_required", errorCode: "undefined_column" };
  }
  return { status: "unavailable", errorCode: "read_failed" };
}

async function readWithCompleteness<T>(
  reader: () => Promise<T>,
  fallback: T,
): Promise<{
  value: T;
  completeness: "complete" | "unavailable";
  section: MetaAutomationSectionCompleteness;
}> {
  const observedAt = new Date().toISOString();
  try {
    const value = await reader();
    return {
      value,
      completeness: "complete",
      section: { status: "complete", errorCode: null, observedAt },
    };
  } catch (error) {
    const classified = sectionStatusFor(error);
    return {
      value: fallback,
      completeness: "unavailable",
      section: { ...classified, observedAt },
    };
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
    controlPersisted: Boolean(rows[0]?.business_id),
    isDemoBusiness: rows[0]?.is_demo_business === true,
  };
}

async function readBusinessControl(businessId: string) {
  return (await readBusinessControlState(businessId)).control;
}

/**
 * Read the governance facts a screen may state without calling Meta. This is
 * deliberately narrower than the live mutation preflight: it combines the
 * global and per-business kill switches and proves whether a persisted
 * business control exists. Missing/unreadable controls block writes but never
 * suppress decision reading.
 */
export async function readEffectiveMetaWriteGovernance(input: {
  businessId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MetaEffectiveWriteGovernance> {
  const businessId = input.businessId.trim();
  const env = input.env ?? process.env;
  if (businessId === DEMO_BUSINESS_ID) {
    return {
      verified: true,
      controlsConfigured: false,
      writeBlocked: true,
      blockReason: "demo_business_read_only",
      killSwitchEngaged: false,
      killSwitchReason: null,
    };
  }
  if (isGlobalMetaAdsWriteKillSwitchEngaged(env)) {
    return {
      verified: true,
      controlsConfigured: false,
      writeBlocked: true,
      blockReason: "META_ADS_WRITE_KILL_SWITCH",
      killSwitchEngaged: true,
      killSwitchReason: "META_ADS_WRITE_KILL_SWITCH",
    };
  }
  let state: Awaited<ReturnType<typeof readBusinessControlState>>;
  try {
    state = await readBusinessControlState(businessId);
  } catch {
    return {
      verified: false,
      controlsConfigured: false,
      writeBlocked: true,
      blockReason: "control_state_unavailable",
      killSwitchEngaged: false,
      killSwitchReason: null,
    };
  }
  if (!state.businessFound) {
    return {
      verified: false,
      controlsConfigured: false,
      writeBlocked: true,
      blockReason: "control_state_unavailable",
      killSwitchEngaged: false,
      killSwitchReason: null,
    };
  }
  if (state.isDemoBusiness) {
    return {
      verified: true,
      controlsConfigured: state.controlPersisted,
      writeBlocked: true,
      blockReason: "demo_business_read_only",
      killSwitchEngaged: false,
      killSwitchReason: null,
    };
  }
  if (!state.controlPersisted) {
    return {
      verified: true,
      controlsConfigured: false,
      writeBlocked: true,
      blockReason: "business_control_not_configured",
      killSwitchEngaged: false,
      killSwitchReason: null,
    };
  }
  if (state.control.killSwitchEngaged) {
    return {
      verified: true,
      controlsConfigured: true,
      writeBlocked: true,
      blockReason: "business_kill_switch",
      killSwitchEngaged: true,
      killSwitchReason:
        state.control.killSwitchReason || "Business kill switch engaged.",
    };
  }
  return {
    verified: true,
    controlsConfigured: true,
    writeBlocked: false,
    blockReason: null,
    killSwitchEngaged: false,
    killSwitchReason: null,
  };
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
 *
 * Exported because it is the ONLY sanctioned way to add a row to this table.
 * The confirmation queue's boundary used to hand-roll its own INSERT naming the
 * six pre-tuple columns, so every proposal decision landed in the ledger with
 * Actor, Entity and Result already em-dashed — three of the five columns the
 * screen draws, blank for rows whose writer knew all three.
 */
export async function writeActivityLedgerRow(input: {
  businessId: string;
  activityType: string;
  severity: MetaAutomationActivityItem["severity"];
  message: string;
  payload: Record<string, unknown>;
  /**
   * The operator who acted, or `null` for a system actor.
   *
   * D088 C2: `created_by` has always been a nullable FK and `actorKind` has
   * always admitted `"system"`, but the parameter demanded a user id — so a
   * scheduled job could not write a ledger row at all without misattributing it
   * to a person. Null is the honest value for work nobody requested.
   */
  userId: string | null;
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
 * The four standing modes, resolved for one business.
 *
 * A missing row is `manual`, which is the safe reading: an operator who has
 * never chosen a mode has not consented to anything being queued or executed
 * on their behalf. This is the ONLY place the default is decided, so a caller
 * cannot accidentally read an absent row as something more permissive.
 */
export async function resolveEffectiveMetaModes(
  businessId: string,
): Promise<Record<MetaAutomationDecisionType, MetaAutomationDecisionMode>> {
  const rows = await readDecisionTypeModes(businessId).catch(() => null);
  const modes = {} as Record<MetaAutomationDecisionType, MetaAutomationDecisionMode>;
  for (const decisionType of META_AUTOMATION_DECISION_TYPES) {
    modes[decisionType] =
      rows?.find((row) => row.decisionType === decisionType)?.mode ?? "manual";
  }
  return modes;
}

/** One decision type's standing mode; `manual` when unread or absent. */
export async function resolveEffectiveMetaMode(
  businessId: string,
  decisionType: MetaAutomationDecisionType,
): Promise<MetaAutomationDecisionMode> {
  return (await resolveEffectiveMetaModes(businessId))[decisionType];
}

/**
 * Create the business control row if it does not exist, default-closed.
 *
 * Every Meta write requires a persisted row (`getMetaWriteBlockState` refuses
 * `control_state_unavailable` without one), so a business that has never
 * visited Automation cannot act at all. Creating the row is not an
 * authorization: STOP stays clear but `auto_execution_enabled` is FALSE,
 * `dryRunOnly` is TRUE, and no ceiling is stated.
 *
 * The spend ceiling is written as an EXPLICIT null pair rather than left
 * absent. `normalizeGuardrails` treats an absent ceiling as the packaged
 * default — 5000 minor EUR — and none of the accounts this product serves is
 * denominated in EUR, so an absent ceiling would make every budget intent fail
 * `policy_spend_ceiling_currency_mismatch` with no visible cause. An explicit
 * null pair takes the "cleared" branch instead: no ceiling is claimed, and the
 * budget sizing producer refuses to size until an operator states one in the
 * account's own currency.
 */
export async function ensureBusinessControlRow(input: {
  businessId: string;
  userId?: string | null;
}): Promise<{ created: boolean }> {
  const businessId = input.businessId.trim();
  if (!businessId) return { created: false };
  const sql = getDb();
  const guardrails = JSON.stringify({
    dryRunOnly: true,
    perActionSpendCeilingMinor: null,
    perActionSpendCeilingCurrency: null,
  });
  const rows = (await sql`
    INSERT INTO meta_automation_business_controls (
      business_id,
      kill_switch_engaged,
      auto_execution_enabled,
      guardrails_json,
      updated_by,
      updated_at
    )
    VALUES (
      ${businessId}, FALSE, FALSE, ${guardrails}::jsonb,
      ${input.userId ?? null}, NOW()
    )
    ON CONFLICT (business_id) DO NOTHING
    RETURNING business_id
  `) as Array<{ business_id: string }>;
  return { created: rows.length > 0 };
}

/**
 * What this workspace may do to Meta right now — one server reading.
 *
 * Before this existed the same question was answered by three independent
 * environment flags (`ZERO_BASE_MUTATION_UI_ENABLED`, `META_DECISION_WORKFLOW_UI`
 * and `META_AUTOMATION_LIVE_WRITES`) read in different places, which is why one
 * route family offered controls the other did not. Both families now take this
 * object as props.
 *
 * It is deliberately fail-closed: an unreadable control row yields
 * `verified: false` and `writeBlocked: true`. "Not read_only" is never by
 * itself an authorization.
 *
 * STOP is exempt on purpose. Engaging or releasing the business kill switch,
 * and seeing its state, must stay reachable even when provider-write capability
 * is closed — an operator locks the doors precisely when everything else is
 * refusing.
 */
export interface MetaWriteCapability {
  contractVersion: "meta-write-capability.v1";
  businessId: string;
  /** `META_AUTOMATION_LIVE_WRITES` — the environment capability. */
  capabilityOpen: boolean;
  /** Standing mode per decision type; absent rows read `manual`. */
  effectiveModes: Record<MetaAutomationDecisionType, MetaAutomationDecisionMode>;
  /** `guardrails_json.dryRunOnly` — true means every write is a rehearsal. */
  rehearsal: boolean;
  stop: { engaged: boolean; reason: string | null };
  /** `readiness_tier === "read_only"` forbids writes in every mode. */
  readOnlyTier: boolean;
  launchpadExecution: boolean;
  /** The server's own refusal, from `getMetaWriteBlockState`. */
  writeBlocked: boolean;
  blockReason: string | null;
  /** False when a required read failed; callers must treat it as blocked. */
  verified: boolean;
  /** STOP management stays reachable regardless of the rest. */
  stopControlAvailable: true;
}

export async function resolveMetaWriteCapability(input: {
  businessId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MetaWriteCapability> {
  const businessId = input.businessId.trim();
  const env = input.env ?? process.env;
  const gates = readMetaReleaseGates(env);
  const [blockState, control, modes] = await Promise.all([
    getMetaWriteBlockState({ businessId }).catch(() => null),
    readBusinessControlState(businessId).catch(() => null),
    resolveEffectiveMetaModes(businessId),
  ]);
  const verified = blockState !== null && control !== null;
  const guardrails = control?.controlPersisted
    ? control.control.guardrails
    : DEFAULT_META_AUTOMATION_GUARDRAILS;
  return {
    contractVersion: "meta-write-capability.v1",
    businessId,
    capabilityOpen: gates.automationLiveWrites,
    effectiveModes: modes,
    // An unread guardrail is a rehearsal, not a live write.
    rehearsal: verified ? guardrails.dryRunOnly !== false : true,
    stop: {
      engaged: control?.control.killSwitchEngaged ?? false,
      reason: control?.control.killSwitchReason ?? null,
    },
    readOnlyTier: control?.control.readinessTier === "read_only",
    launchpadExecution: gates.launchpadExecution,
    writeBlocked: verified ? blockState!.blocked : true,
    blockReason: verified
      ? blockState!.reason
      : "control_state_unavailable",
    verified,
    stopControlAvailable: true,
  };
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
  // Provenance, not just a value. The fallback this degrades to is a concrete
  // control state (ENABLED, Tier 1, +15%, 3 actions/day) that the surface would
  // otherwise print as fact during a read failure — while every write in the
  // same window is refused with `control_state_unavailable` by
  // `getMetaWriteBlockState`, which fails closed on the identical error.
  const businessControlRead = await readWithCompleteness(
    () => readBusinessControl(businessId),
    defaultBusinessControl(businessId),
  );
  const businessControl = businessControlRead.value;
  const [
    promotionRead,
    automationActivity,
    actionActivity,
    decisionTypeModes,
    rulesRead,
  ] = await Promise.all([
    readWithCompleteness(() => readPromotionRecords(businessId), []),
    readWithCompleteness(
      () => readActivityLedger(businessId),
      [] as MetaAutomationActivityItem[],
    ),
    readWithCompleteness(
      () => readRecentActionLedger(businessId, providerAccountId),
      [] as MetaAutomationActivityItem[],
    ),
    // Was `safeRead`, which degraded to the defaults WITHOUT recording that it
    // had. The ladder prints those defaults, so a failed read and a workspace
    // that has configured nothing were the same four rows. It answers for its
    // own read now, like every other section.
    readWithCompleteness(
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
    businessControlRead.completeness !== "complete"
      ? "control_state_unavailable"
      : null,
    businessControlRead.completeness === "complete" &&
    businessControl.source !== "persisted"
      ? "business_control_not_configured"
      : null,
    businessControl.killSwitchEngaged ? "business_kill_switch" : null,
    !businessControl.autoExecutionEnabled ? "auto_execution_not_enabled" : null,
    businessControl.guardrails.dryRunOnly ? "dry_run_only_guardrail" : null,
  ].filter((item): item is string => Boolean(item));

  // Second phase on purpose: a streak window starts at the tier's own
  // `updatedAt`, which is only known once the modes have been read.
  const streakRead = await readWithCompleteness(
    () => readCleanApprovalStreaks(businessId, decisionTypeModes.value),
    decisionTypeModes.value,
  );

  const activitySection: MetaAutomationSectionCompleteness =
    automationActivity.section.status === "complete"
      ? actionActivity.section
      : automationActivity.section;

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
        businessControlRead.completeness === "complete" &&
        businessControl.source === "persisted" &&
        !businessControl.killSwitchEngaged &&
        businessControl.autoExecutionEnabled &&
        /*
          `readiness_tier` has no application writer, so its value is always the
          column default `manual_review`. Requiring `auto_execute` here made
          this banner structurally unreachable while the scheduled sweep — which
          never consulted the tier — would in fact run. The two now agree: the
          tier forbids writes only when it says `read_only`.
        */
        businessControl.readinessTier !== "read_only" &&
        !businessControl.guardrails.dryRunOnly,
      writeEndpointsBlocked:
        globalKillSwitchEngaged ||
        businessControlRead.completeness !== "complete" ||
        businessControl.source !== "persisted" ||
        businessControl.killSwitchEngaged,
      blockedReasons,
    },
    promotionRecords: promotionRead.value,
    readCompleteness: {
      promotionRecords: promotionRead.completeness,
      cleanApprovalStreaks: streakRead.completeness,
      rules: rulesRead.completeness,
      businessControl: businessControlRead.completeness,
      // The ledger is one presented collection assembled from two reads, so it
      // is only proven empty when BOTH halves were read. Either half failing
      // means an empty array is unproven, never "nothing has happened here".
      activityLedger:
        automationActivity.completeness === "complete" &&
        actionActivity.completeness === "complete"
          ? "complete"
          : "unavailable",
    },
    // The richer envelope. Each section answers for ITS read: a failed rules
    // read leaves the promotion count complete, and vice versa.
    sections: {
      businessControl: businessControlRead.section,
      rules: rulesRead.section,
      // One presented collection, two reads: it is only proven when BOTH are.
      activity: activitySection,
      promotionRecords: promotionRead.section,
      decisionModes: decisionTypeModes.section,
      // The anchors ride the rules read (the Commercial Truth snapshot is
      // fetched inside it), so they share its provenance rather than claiming
      // an independent one they do not have.
      anchors: rulesRead.section,
      // Readiness is a field of the business control row, plus the promotion
      // ladder's own streak read. Unproven if either is.
      readiness:
        businessControlRead.section.status === "complete"
          ? streakRead.section
          : businessControlRead.section,
    },
    rules: rulesRead.value.rules,
    commercialAnchors: rulesRead.value.anchors,
    activityLedger: [...automationActivity.value, ...actionActivity.value]
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
      rehearsal: true,
    };
  }
  if (isGlobalMetaAdsWriteKillSwitchEngaged(env)) {
    return {
      blocked: true,
      reason: "META_ADS_WRITE_KILL_SWITCH",
      message: "Meta writes are disabled by global kill switch.",
      rehearsal: true,
    };
  }

  /*
    PRE-DEPLOY AUDIT — the test bypass is narrowed, because this guard is now
    the last line in front of an UNATTENDED Meta budget mutation.

    It used to open on `NODE_ENV === "test"` as well as on `VITEST`, so a
    deployed process that was started with `NODE_ENV=test` — a configuration
    mistake, not an attack — would skip the business kill switch, the
    control-state-unavailable refusal, the guard rules and quiet hours, and
    report every write as unblocked. The global kill switch and the demo
    refusal already ran above; everything else was being waived.

    It now requires an actual vitest process AND a non-production NODE_ENV, so
    the bypass is unreachable in a deployed environment by construction. Under
    vitest `VITEST === "true"`, so no existing test changes behaviour.
  */
  const isVitest = env.VITEST === "true" && env.NODE_ENV !== "production";
  if (isVitest && env.META_AUTOMATION_WRITE_GUARD_TEST_READS !== "1") {
    return { blocked: false, reason: null, message: null, rehearsal: false };
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
      rehearsal: true,
    };
  }
  if (!controlState.businessFound) {
    return {
      blocked: true,
      reason: "control_state_unavailable",
      message:
        "Meta writes are temporarily blocked because automation control state could not be verified.",
      rehearsal: true,
    };
  }
  if (controlState.isDemoBusiness) {
    return {
      blocked: true,
      reason: "demo_business_read_only",
      message: "Meta writes are disabled for synthetic demo businesses.",
      rehearsal: true,
    };
  }
  if (!controlState.controlPersisted) {
    return {
      blocked: true,
      reason: "control_state_unavailable",
      message:
        "Meta writes are blocked because this business has no persisted automation control state.",
      rehearsal: true,
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
      rehearsal: true,
    };
  }

  /*
    THE ENVIRONMENT CAPABILITY, at the same choke point as everything else.

    This gate was written, exported and never consulted by the server that
    actually reaches Meta: `readMetaReleaseGates` decided what the SCREENS
    offered, and the write path never asked. So a request built by hand, a
    stale tab, or any caller that skipped the UI could reach a provider POST
    with the capability shut — which is the one thing a release capability
    exists to prevent.

    It is a block rather than a rehearsal downgrade, because a closed
    capability is not "try this safely", it is "this build may not write here".
  */
  if (readMetaReleaseGates(env).automationLiveWrites !== true) {
    return {
      blocked: true,
      reason: "release_capability_closed",
      message:
        "Live Meta writes are not enabled in this environment, so nothing was sent.",
      rehearsal: true,
    };
  }

  /*
    THE READ-ONLY TIER, which had two consumers and no enforcement.

    `readiness_tier` is the operator's own statement about what this business
    may do, and `read_only` means one thing. Until now the only place that
    honoured it was the scheduled budget reader, so a business deliberately
    parked in it could still be written to by hand.
  */
  if (control.readinessTier === "read_only") {
    return {
      blocked: true,
      reason: "readiness_tier_read_only",
      message:
        "This business is set to read-only, so no Meta write was attempted.",
      rehearsal: true,
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
        rehearsal: true,
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
      rehearsal: true,
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
      rehearsal: true,
    };
  }

  /*
    Not blocked — but possibly rehearsing.

    `dryRunOnly` is a persisted guardrail and the plan makes it the ONE meaning
    of rehearsal for every write family. `!== false` rather than `=== true`:
    the shipped default is rehearsal, and a guardrail row that could not state
    the field must not be read as permission to reach Meta.
  */
  return {
    blocked: false,
    reason: null,
    message: null,
    rehearsal: control.guardrails.dryRunOnly !== false,
  };
}
