/**
 * The confirmation queue's proposal record — the ONE queue the design draws.
 *
 * The design's Automation screen has a single "Needs your confirmation" list
 * and two things that feed it: the decision engine's snapshot, and the
 * deterministic rules whose own footnote says "rules never write directly —
 * they raise proposals into the confirmation queue (or hard-block, for
 * guards)". Both land in this one table, discriminated by {@link
 * MetaAutomationProposalOrigin}, because the operator sees one list and one
 * decide path. A second table would be a second read model and a second set of
 * gates, and only one of them could be right.
 *
 * **An engine-origin proposal is a persisted projection of an existing engine
 * decision, not a new kind of judgement.** The engine already writes one
 * deterministic,
 * evidence-carrying row per entity per snapshot day into
 * `meta_decision_snapshots_daily`; a second record kind would be a second
 * engine, and anything it added that the decision did not already prove would
 * be invented. The design says so in its own footnotes — "rules never write
 * directly — they raise proposals into the confirmation queue" and "expired
 * proposals re-evaluate on the next snapshot" — which describes a projection of
 * the snapshot, keyed to it, refreshed by it.
 *
 * Three consequences follow, and they are the whole design of this module:
 *
 * 1. **Every descriptive field is copied, never derived from prose.** Action,
 *    entity, reason, evidence and lineage come from named columns of the
 *    decision row. A column the decision leaves null stays null here and the
 *    surface renders an em-dash rather than a guess.
 * 2. **Only decisions that map to a real guarded endpoint become proposals.**
 *    A queue row promises "approving executes"; a row whose action has no
 *    endpoint could only ever fail, so it is not projected at all. Today that
 *    is `cut` → `pause` at campaign and ad-set grain (see
 *    {@link proposalActionForDecision} for why the others are excluded).
 * 3. **Expiry is the snapshot cadence, not a per-row invention.** A proposal is
 *    only as current as the snapshot that produced it, and the scheduled
 *    snapshot runs daily, so a proposal outlives its evidence after one
 *    cadence. Past that it is marked `expired` — never deleted — and the next
 *    snapshot re-projects a fresh row if the decision still holds.
 *
 * A rule-origin proposal obeys all three, with the rule firing standing in for
 * the decision row: it carries `ruleId` + `dedupeKey` instead of the engine
 * lineage columns (which are null — a rule id wearing an engine's clothes would
 * be forged lineage), it may only name an action that has a real guarded
 * endpoint, and its expiry is the same one cadence. Whatever raised it, a row
 * in this table means exactly one thing: an operator may approve it, and
 * approving calls the existing guarded handler.
 */
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import type { MutationAction } from "@/lib/zero-base/meta/dispatch-contract";

/** Grains the queue can aim a guarded write at. */
export type MetaAutomationProposalScope = "campaign" | "adset";

/**
 * What raised the row.
 *
 * The discriminator is stored rather than inferred, because the two shapes
 * carry different lineage and the database CHECK that keeps each shape complete
 * has to be able to read it.
 */
export const META_AUTOMATION_PROPOSAL_ORIGINS = [
  "engine_decision",
  "automation_rule",
] as const;
export type MetaAutomationProposalOrigin =
  (typeof META_AUTOMATION_PROPOSAL_ORIGINS)[number];

export const META_AUTOMATION_PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "failed",
  "modified",
  "dismissed",
  "expired",
] as const;
export type MetaAutomationProposalStatus =
  (typeof META_AUTOMATION_PROPOSAL_STATUSES)[number];

/** The three controls the design puts on every row. */
export const META_AUTOMATION_PROPOSAL_ACTIONS = [
  "approve",
  "modify",
  "dismiss",
] as const;
export type MetaAutomationProposalAction =
  (typeof META_AUTOMATION_PROPOSAL_ACTIONS)[number];

export interface MetaAutomationProposalReceipt {
  /** HTTP status the reused guarded handler returned. */
  httpStatus: number;
  /** Verbatim response envelope of that handler. Never re-worded. */
  response: unknown;
  /** True when the business guardrail forced the reused handler's dry-run mode. */
  dryRun: boolean;
  dispatchedAt: string;
  /** Concrete path of the guarded endpoint that was called. */
  endpoint: string | null;
  /** Why nothing was dispatched, when the dispatch contract withheld the body. */
  withheld: string | null;
}

export interface MetaAutomationProposal {
  id: string;
  businessId: string;
  providerAccountId: string;
  origin: MetaAutomationProposalOrigin;
  /** Set only on `automation_rule` rows: the rule whose firing raised this. */
  ruleId: string | null;
  /** Set only on `automation_rule` rows: `${ruleId}:${entityId}:${date}`. */
  dedupeKey: string | null;
  /** `campaign:<id>` / `adset:<id>` — the same key the decision surfaces use. */
  decisionKey: string;
  scopeType: MetaAutomationProposalScope;
  scopeId: string;
  /** Engine lineage. Null on `automation_rule` rows, which have none. */
  recId: string | null;
  recType: string | null;
  /** The warehouse day the evidence is about. Required for both origins. */
  snapshotDate: string;
  engineVersion: string | null;
  decisionLabel: string | null;
  proposedAction: MutationAction;
  /** Row's own action tag, e.g. `Pause ad set`. */
  actionLabel: string;
  /** Row's own primary-button caption. */
  primaryCaption: string;
  entityLabel: string | null;
  reason: string;
  evidenceLabel: string | null;
  evidenceRef: Record<string, unknown>;
  expiresAt: string;
  status: MetaAutomationProposalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  receipt: MetaAutomationProposalReceipt | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One snapshot cadence.
 *
 * The scheduled Meta snapshot runs daily, so a proposal that has outlived a
 * full cadence is describing evidence the engine has already replaced. This is
 * the engine's own period, not a policy invented for the queue.
 */
export const META_AUTOMATION_PROPOSAL_TTL_HOURS = 24;

const PROPOSAL_TABLES = ["meta_automation_proposals"] as const;

/**
 * The design's literal primary caption.
 *
 * It is stored per row rather than computed at render because the design binds
 * it to the row (`a.btn`): when a second action kind becomes executable it will
 * carry its own caption, and rows already in the queue must keep the caption
 * they were approved under.
 */
export const META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION = "Approve & apply";

/** The design's own action-tag wording, per action and grain. */
export function proposalActionLabel(
  action: MutationAction,
  scopeType: MetaAutomationProposalScope,
): string {
  const entity = scopeType === "campaign" ? "campaign" : "ad set";
  switch (action) {
    case "pause":
      return `Pause ${entity}`;
    case "resume":
      return `Resume ${entity}`;
    case "bid":
      return `Apply bid`;
    case "duplicate":
      return `Duplicate ${entity}`;
  }
}

/**
 * Which engine decisions may become an executable proposal.
 *
 * Deliberately narrow, and the exclusions are the interesting part:
 *
 * - `cut` → **pause**. The one label whose intent maps exactly onto a guarded
 *   endpoint that exists at this grain and needs no operator-entered value.
 * - `scale` → nothing. There is no guarded budget-write endpoint in this repo
 *   (`MUTATION_ENDPOINTS` has no budget action at any grain), so a scale
 *   proposal would be a primary button that can only fail.
 * - `tune` → nothing. The bid endpoint exists at ad-set grain but the dispatch
 *   contract declares `bidAmountMinor` an **operator** field: no engine
 *   decision proves a bid amount, so a one-tap approval would have to invent
 *   the number it wrote.
 * - `keep` / `test_more` / `rebuild` / `switch` / `diagnose` → nothing. None of
 *   them names a single provider mutation.
 * - `ad` grain → nothing. Ad writes go through the decision-origin execution
 *   contract, which requires a full lineage envelope (snapshot id, evaluation
 *   id, decision hash) that a projection does not hold; forging one would be a
 *   second write path.
 */
export function proposalActionForDecision(input: {
  decisionLabel: string | null;
  scopeType: string | null;
}): { action: MutationAction; scopeType: MetaAutomationProposalScope } | null {
  const scopeType = input.scopeType === "campaign" || input.scopeType === "adset"
    ? (input.scopeType as MetaAutomationProposalScope)
    : null;
  if (!scopeType) return null;
  if (input.decisionLabel !== "cut") return null;
  return { action: "pause", scopeType };
}

export function proposalDecisionKey(
  scopeType: MetaAutomationProposalScope,
  scopeId: string,
): string {
  return `${scopeType}:${scopeId}`;
}

/** Expiry of a proposal projected from a decision row created at `createdAt`. */
export function proposalExpiryFor(createdAt: string | Date): string {
  const base =
    createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt));
  const resolved = Number.isFinite(base) ? base : Date.now();
  return new Date(
    resolved + META_AUTOMATION_PROPOSAL_TTL_HOURS * 60 * 60 * 1000,
  ).toISOString();
}

export function isProposalExpired(input: {
  expiresAt: string;
  now: Date;
}): boolean {
  const expiry = Date.parse(input.expiresAt);
  // An unparseable expiry is treated as expired. The alternative — treating it
  // as still valid — would make a corrupt timestamp the one way to reach a
  // provider write past its evidence.
  if (!Number.isFinite(expiry)) return true;
  return input.now.getTime() >= expiry;
}

export type ProposalTransitionRefusal =
  | "proposal_not_pending"
  | "proposal_expired";

export const PROPOSAL_TRANSITION_MESSAGE: Record<
  ProposalTransitionRefusal,
  string
> = {
  proposal_not_pending:
    "This proposal has already been decided, so it can no longer be approved, modified or dismissed.",
  proposal_expired:
    "This proposal has expired and is no longer executable. The next snapshot re-evaluates it.",
};

export type ProposalTransitionResult =
  | { ok: true; next: Exclude<MetaAutomationProposalStatus, "pending" | "expired" | "failed"> }
  | { ok: false; refusal: ProposalTransitionRefusal; message: string };

/**
 * The whole state machine, in one pure function.
 *
 * `pending` is the only transitionable state and expiry beats every action —
 * including dismiss, because an expired row is not in the queue any more and
 * deciding it would record an operator verdict on evidence that no longer
 * exists. `failed` and `expired` are terminal states the *server* writes from
 * an outcome, never states an operator can ask for, which is why they are not
 * in the result type.
 */
export function evaluateProposalTransition(input: {
  status: MetaAutomationProposalStatus;
  expiresAt: string;
  action: MetaAutomationProposalAction;
  now: Date;
}): ProposalTransitionResult {
  if (input.status !== "pending") {
    return {
      ok: false,
      refusal: "proposal_not_pending",
      message: PROPOSAL_TRANSITION_MESSAGE.proposal_not_pending,
    };
  }
  if (isProposalExpired({ expiresAt: input.expiresAt, now: input.now })) {
    return {
      ok: false,
      refusal: "proposal_expired",
      message: PROPOSAL_TRANSITION_MESSAGE.proposal_expired,
    };
  }
  return {
    ok: true,
    next:
      input.action === "approve"
        ? "approved"
        : input.action === "modify"
          ? "modified"
          : "dismissed",
  };
}

interface ProposalDbRow {
  id: string;
  business_id: string;
  provider_account_id: string;
  origin: string;
  rule_id: string | null;
  dedupe_key: string | null;
  decision_key: string;
  scope_type: string;
  scope_id: string;
  rec_id: string | null;
  rec_type: string | null;
  snapshot_date: string;
  engine_version: string | null;
  decision_label: string | null;
  proposed_action: string;
  action_label: string;
  primary_caption: string;
  entity_label: string | null;
  reason: string;
  evidence_label: string | null;
  evidence_ref: unknown;
  expires_at: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  receipt_json: unknown;
  created_at: string;
  updated_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mapProposalRow(row: ProposalDbRow): MetaAutomationProposal {
  return {
    id: row.id,
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    origin: row.origin as MetaAutomationProposalOrigin,
    ruleId: row.rule_id,
    dedupeKey: row.dedupe_key,
    decisionKey: row.decision_key,
    scopeType: row.scope_type as MetaAutomationProposalScope,
    scopeId: row.scope_id,
    recId: row.rec_id,
    recType: row.rec_type,
    snapshotDate: String(row.snapshot_date).slice(0, 10),
    engineVersion: row.engine_version,
    decisionLabel: row.decision_label,
    proposedAction: row.proposed_action as MutationAction,
    actionLabel: row.action_label,
    primaryCaption: row.primary_caption,
    entityLabel: row.entity_label?.trim() || null,
    reason: row.reason,
    evidenceLabel: row.evidence_label?.trim() || null,
    evidenceRef: isRecord(row.evidence_ref) ? row.evidence_ref : {},
    expiresAt: new Date(row.expires_at).toISOString(),
    status: row.status as MetaAutomationProposalStatus,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    decisionNote: row.decision_note,
    receipt: isRecord(row.receipt_json)
      ? (row.receipt_json as unknown as MetaAutomationProposalReceipt)
      : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const PROPOSAL_COLUMNS = `
  id, business_id, provider_account_id, origin, rule_id, dedupe_key,
  decision_key, scope_type, scope_id,
  rec_id, rec_type, snapshot_date::text AS snapshot_date, engine_version,
  decision_label, proposed_action, action_label, primary_caption, entity_label,
  reason, evidence_label, evidence_ref, expires_at, status, decided_by,
  decided_at, decision_note, receipt_json, created_at, updated_at
`;

async function proposalsReady() {
  const readiness = await getDbSchemaReadiness({
    tables: [...PROPOSAL_TABLES],
  }).catch(() => null);
  return Boolean(readiness?.ready);
}

/**
 * Mark every pending proposal whose evidence has aged out.
 *
 * `expired` rather than deleted: the design promises expired proposals
 * "re-evaluate on the next snapshot" rather than silently vanishing, and a
 * deleted row cannot be audited against the decision it came from.
 */
export async function expireStaleMetaAutomationProposals(input: {
  businessId: string;
  now?: Date;
}): Promise<number> {
  if (!(await proposalsReady())) return 0;
  const now = (input.now ?? new Date()).toISOString();
  const rows = (await getDb().query<{ id: string }>(
    `
      UPDATE meta_automation_proposals
      SET status = 'expired', updated_at = NOW()
      WHERE business_id = $1::uuid
        AND status = 'pending'
        AND expires_at <= $2::timestamptz
      RETURNING id
    `,
    [input.businessId, now],
  )) as Array<{ id: string }>;
  return rows.length;
}

export interface ProjectMetaAutomationProposalsResult {
  projected: number;
  expired: number;
  /** False when the schema is not ready; the caller must not report a count. */
  ran: boolean;
}

/**
 * Project one snapshot day's decisions into the confirmation queue.
 *
 * Runs inside the snapshot pipeline, immediately after the decision rows land,
 * which is precisely what "expired proposals re-evaluate on the next snapshot"
 * means: the sweep ages out what the previous snapshot proposed, and the insert
 * re-raises anything the new snapshot still says.
 *
 * The insert is `ON CONFLICT … DO UPDATE` restricted to rows that are still
 * `pending`. A proposal an operator already approved, modified or dismissed is
 * never resurrected by a re-run, and an expired one stays expired for its own
 * snapshot day — the new day's snapshot produces a new row.
 *
 * Three narrowing clauses that each exist for a reason:
 *
 * - The already-`PAUSED` exclusion. A pause proposal on something already
 *   paused is a primary control whose only possible outcome is a no-op write.
 * - `DISTINCT ON (scope_type, scope_id)`. The decision table's grain is one row
 *   per *rec type*, so one ad set can carry several `cut` scenarios in a day.
 *   Two queue rows proposing the same pause would be two chances to do the same
 *   thing; the lowest rec type wins, deterministically, so a re-run picks the
 *   same one.
 * - The `NOT EXISTS` against a decided row for the same entity and day. Without
 *   it, a different rec type winning the tiebreak on a later run would re-raise
 *   a proposal the operator had already dismissed that same day.
 * - The `NOT EXISTS` against a *pending* row already occupying this entity's
 *   action slot — whatever raised it. A rule that has already queued a pause on
 *   this ad set makes the projection's row redundant: two rows would be two
 *   chances to do the same thing, and the header count would say `2` for one
 *   pause. The clause exempts the exact row this statement upserts onto (same
 *   rec type, same snapshot day), so refresh-in-place still works.
 */
export async function projectMetaAutomationProposals(input: {
  businessId: string;
  snapshotDate: string;
  now?: Date;
}): Promise<ProjectMetaAutomationProposalsResult> {
  if (!(await proposalsReady())) {
    return { projected: 0, expired: 0, ran: false };
  }
  const now = input.now ?? new Date();
  const expired = await expireStaleMetaAutomationProposals({
    businessId: input.businessId,
    now,
  });

  const ttlInterval = `${META_AUTOMATION_PROPOSAL_TTL_HOURS} hours`;
  const rows = (await getDb().query<{ id: string }>(
    `
      WITH decisions AS (
        SELECT DISTINCT ON (d.scope_type, d.scope_id)
               d.scope_type,
               d.scope_id,
               d.rec_id,
               d.rec_type,
               d.snapshot_date,
               d.engine_version,
               d.decision_label,
               d.reasoning,
               d.expected_impact,
               d.evidence,
               d.created_at,
               dim.provider_account_id,
               dim.entity_label,
               dim.entity_status
        FROM meta_decision_snapshots_daily d
        JOIN (
          SELECT 'campaign'::text AS scope_type,
                 business_id,
                 campaign_id AS scope_id,
                 provider_account_id,
                 campaign_name_current AS entity_label,
                 campaign_status AS entity_status
          FROM meta_campaign_dimensions
          UNION ALL
          SELECT 'adset'::text AS scope_type,
                 business_id,
                 adset_id AS scope_id,
                 provider_account_id,
                 adset_name_current AS entity_label,
                 adset_status AS entity_status
          FROM meta_adset_dimensions
        ) dim
          ON dim.business_id = d.business_id
         AND dim.scope_type = d.scope_type
         AND dim.scope_id = d.scope_id
        WHERE d.business_id = $1::text
          AND d.snapshot_date = $2::date
          AND d.kind = 'recommendation'
          AND d.scope_type IN ('campaign', 'adset')
          AND d.decision_label = 'cut'
          AND COALESCE(UPPER(dim.entity_status), '') <> 'PAUSED'
          AND NULLIF(BTRIM(d.reasoning), '') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM meta_automation_proposals decided
            WHERE decided.business_id = $1::uuid
              AND decided.provider_account_id = dim.provider_account_id
              AND decided.decision_key = d.scope_type || ':' || d.scope_id
              AND decided.snapshot_date = d.snapshot_date
              AND decided.status <> 'pending'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM meta_automation_proposals held
            WHERE held.business_id = $1::uuid
              AND held.provider_account_id = dim.provider_account_id
              AND held.decision_key = d.scope_type || ':' || d.scope_id
              AND held.proposed_action = 'pause'
              AND held.status = 'pending'
              AND NOT (
                held.origin = 'engine_decision'
                AND held.rec_type = d.rec_type
                AND held.snapshot_date = d.snapshot_date
              )
          )
        ORDER BY d.scope_type, d.scope_id, d.rec_type
      )
      INSERT INTO meta_automation_proposals (
        business_id, provider_account_id, origin, decision_key, scope_type,
        scope_id, rec_id, rec_type, snapshot_date, engine_version,
        decision_label, proposed_action, action_label, primary_caption,
        entity_label, reason, evidence_label, evidence_ref, expires_at, status
      )
      SELECT $1::uuid,
             provider_account_id,
             'engine_decision',
             scope_type || ':' || scope_id,
             scope_type,
             scope_id,
             rec_id,
             rec_type,
             snapshot_date,
             engine_version,
             decision_label,
             'pause',
             CASE WHEN scope_type = 'campaign' THEN 'Pause campaign' ELSE 'Pause ad set' END,
             $3,
             NULLIF(BTRIM(entity_label), ''),
             reasoning,
             NULLIF(BTRIM(expected_impact), ''),
             jsonb_build_object(
               'recId', rec_id,
               'recType', rec_type,
               'snapshotDate', snapshot_date::text,
               'engineVersion', engine_version,
               'decisionKey', scope_type || ':' || scope_id,
               'evidence', evidence
             ),
             created_at + $4::interval,
             'pending'
      FROM decisions
      ON CONFLICT (business_id, provider_account_id, decision_key, rec_type, snapshot_date)
      DO UPDATE SET
        reason = EXCLUDED.reason,
        evidence_label = EXCLUDED.evidence_label,
        evidence_ref = EXCLUDED.evidence_ref,
        entity_label = EXCLUDED.entity_label,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
      WHERE meta_automation_proposals.status = 'pending'
      RETURNING id
    `,
    [
      input.businessId,
      input.snapshotDate,
      META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
      ttlInterval,
    ],
  )) as Array<{ id: string }>;

  return { projected: rows.length, expired, ran: true };
}

export interface ReadMetaAutomationProposalsResult {
  /** `complete` only when the read actually proved the collection. */
  readCompleteness: "complete" | "unavailable";
  proposals: MetaAutomationProposal[];
}

/**
 * The queue an operator may act on: pending, unexpired, in one account.
 *
 * The stale sweep runs first so a row that aged out between snapshots is
 * reported as expired rather than briefly offered as approvable.
 */
export async function readMetaAutomationProposalQueue(input: {
  businessId: string;
  providerAccountId: string;
  now?: Date;
}): Promise<ReadMetaAutomationProposalsResult> {
  if (!(await proposalsReady())) {
    return { readCompleteness: "unavailable", proposals: [] };
  }
  const now = input.now ?? new Date();
  await expireStaleMetaAutomationProposals({
    businessId: input.businessId,
    now,
  }).catch(() => 0);
  const rows = (await getDb().query<ProposalDbRow>(
    `
      SELECT ${PROPOSAL_COLUMNS}
      FROM meta_automation_proposals
      WHERE business_id = $1::uuid
        AND provider_account_id = $2
        AND status = 'pending'
        AND expires_at > $3::timestamptz
      ORDER BY expires_at ASC, created_at ASC
    `,
    [input.businessId, input.providerAccountId, now.toISOString()],
  )) as ProposalDbRow[];
  return { readCompleteness: "complete", proposals: rows.map(mapProposalRow) };
}

/** One proposal, scoped to the authorized business and its resolved account. */
export async function readMetaAutomationProposal(input: {
  businessId: string;
  providerAccountId: string;
  proposalId: string;
}): Promise<MetaAutomationProposal | null> {
  if (!(await proposalsReady())) return null;
  const rows = (await getDb().query<ProposalDbRow>(
    `
      SELECT ${PROPOSAL_COLUMNS}
      FROM meta_automation_proposals
      WHERE business_id = $1::uuid
        AND provider_account_id = $2
        AND id = $3::uuid
      LIMIT 1
    `,
    [input.businessId, input.providerAccountId, input.proposalId],
  )) as ProposalDbRow[];
  return rows[0] ? mapProposalRow(rows[0]) : null;
}

/**
 * Record the outcome of an operator decision.
 *
 * Guarded by `status = 'pending'` in the WHERE clause, so two concurrent
 * approvals cannot both settle the same proposal: the loser updates zero rows
 * and gets `null` back.
 */
export async function settleMetaAutomationProposal(input: {
  businessId: string;
  proposalId: string;
  status: MetaAutomationProposalStatus;
  decidedBy: string;
  decisionNote?: string | null;
  receipt?: MetaAutomationProposalReceipt | null;
}): Promise<MetaAutomationProposal | null> {
  if (!(await proposalsReady())) return null;
  const rows = (await getDb().query<ProposalDbRow>(
    `
      UPDATE meta_automation_proposals
      SET status = $3,
          decided_by = $4::uuid,
          decided_at = NOW(),
          decision_note = $5,
          receipt_json = $6::jsonb,
          updated_at = NOW()
      WHERE business_id = $1::uuid
        AND id = $2::uuid
        AND status = 'pending'
      RETURNING ${PROPOSAL_COLUMNS}
    `,
    [
      input.businessId,
      input.proposalId,
      input.status,
      input.decidedBy,
      input.decisionNote?.trim() || null,
      input.receipt ? JSON.stringify(input.receipt) : null,
    ],
  )) as ProposalDbRow[];
  return rows[0] ? mapProposalRow(rows[0]) : null;
}

/**
 * Actions a rule firing may queue.
 *
 * The same rule that governs the engine projection governs rule intake, for the
 * same reason: every row in this queue carries "Approve & apply" under a footer
 * that promises "approving executes inside the guardrails above". An action
 * with no guarded endpoint would be a primary button that can only fail, so it
 * never becomes a row. Today that is `pause`, at campaign and ad-set grain.
 */
export const RULE_RAISABLE_PROPOSAL_ACTIONS = ["pause"] as const;
export type RuleRaisableProposalAction =
  (typeof RULE_RAISABLE_PROPOSAL_ACTIONS)[number];

export interface RaiseRuleAutomationProposalInput {
  businessId: string;
  providerAccountId: string;
  ruleId: string;
  /** `${ruleId}:${entityId}:${evaluatedForDate}` — one proposal per firing. */
  dedupeKey: string;
  scopeType: MetaAutomationProposalScope;
  scopeId: string;
  proposedAction: RuleRaisableProposalAction;
  entityLabel: string | null;
  reason: string;
  evidenceLabel: string | null;
  evidenceRef: Record<string, unknown>;
  /** The warehouse day the verdict was computed for. */
  evaluatedForDate: string;
  now?: Date;
}

export type RaiseRuleAutomationProposalResult =
  /** This firing put a new row in the queue. */
  | { status: "inserted"; proposalId: string }
  /**
   * The entity's pending slot was already held — by this firing's own earlier
   * run, by another rule, or by the engine's projection. The firing still
   * happened and is still counted; it points at the row that represents it.
   */
  | { status: "already_queued"; proposalId: string | null }
  /** No schema to write into. The caller must not report a queued proposal. */
  | { status: "unavailable"; proposalId: null };

/**
 * Raise one rule firing into the confirmation queue.
 *
 * This is an INSERT of a `pending` row and nothing else. There is no provider
 * client in this module and no code path from here to one: the row waits for
 * the queue's own approve action, which is the single place that calls the
 * guarded handler.
 *
 * `ON CONFLICT DO NOTHING` carries no target on purpose. Two different unique
 * indexes can refuse this row — the firing's own `dedupe_key`, and the
 * one-pending-row-per-entity-per-action slot — and naming either one would turn
 * the other into a thrown error inside an evaluation loop.
 */
export async function raiseRuleAutomationProposal(
  input: RaiseRuleAutomationProposalInput,
): Promise<RaiseRuleAutomationProposalResult> {
  if (!(await proposalsReady())) {
    return { status: "unavailable", proposalId: null };
  }
  const now = input.now ?? new Date();
  const expiresAt = proposalExpiryFor(now);
  const decisionKey = proposalDecisionKey(input.scopeType, input.scopeId);

  const inserted = (await getDb().query<{ id: string }>(
    `
      INSERT INTO meta_automation_proposals (
        business_id, provider_account_id, origin, rule_id, dedupe_key,
        decision_key, scope_type, scope_id, snapshot_date, proposed_action,
        action_label, primary_caption, entity_label, reason, evidence_label,
        evidence_ref, expires_at, status
      )
      VALUES (
        $1::uuid, $2, 'automation_rule', $3::uuid, $4,
        $5, $6, $7, $8::date, $9,
        $10, $11, $12, $13, $14,
        $15::jsonb, $16::timestamptz, 'pending'
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [
      input.businessId,
      input.providerAccountId,
      input.ruleId,
      input.dedupeKey,
      decisionKey,
      input.scopeType,
      input.scopeId,
      input.evaluatedForDate,
      input.proposedAction,
      proposalActionLabel(input.proposedAction, input.scopeType),
      META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
      input.entityLabel?.trim() || null,
      input.reason,
      input.evidenceLabel?.trim() || null,
      JSON.stringify(input.evidenceRef ?? {}),
      expiresAt,
    ],
  )) as Array<{ id: string }>;

  if (inserted[0]) {
    return { status: "inserted", proposalId: inserted[0].id };
  }

  // Whoever holds the slot is the queue row this firing is about. Its own
  // dedupe key wins the lookup when it exists, so a re-run reports the row it
  // created rather than an unrelated neighbour.
  const held = (await getDb().query<{ id: string }>(
    `
      SELECT id
      FROM meta_automation_proposals
      WHERE business_id = $1::uuid
        AND (
          dedupe_key = $2
          OR (
            provider_account_id = $3
            AND decision_key = $4
            AND proposed_action = $5
            AND status = 'pending'
          )
        )
      ORDER BY (dedupe_key = $2) DESC, created_at ASC
      LIMIT 1
    `,
    [
      input.businessId,
      input.dedupeKey,
      input.providerAccountId,
      decisionKey,
      input.proposedAction,
    ],
  )) as Array<{ id: string }>;

  return { status: "already_queued", proposalId: held[0]?.id ?? null };
}
