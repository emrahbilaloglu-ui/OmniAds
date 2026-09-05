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
import { resolveEffectiveMetaModes } from "@/lib/meta/automation-control-plane";
import { getDb, runDbTransaction } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { readMetaAutomationProposalRoasFloor } from "@/lib/meta/automation-guardrail-policy";
import type { MutationAction } from "@/lib/zero-base/meta/dispatch-contract";
import {
  envelopeForProposalRow,
  parseBudgetProposalEnvelope,
  type BudgetProposalEnvelope,
} from "@/lib/meta/budget-proposal-runtime";
import {
  bidEnvelopeForProposalRow,
  parseBidProposalEnvelope,
  type BidProposalEnvelope,
} from "@/lib/meta/bid-proposal-envelope";

/** Grains the queue can aim a guarded write at. */
/**
 * The grains a proposal can be about.
 *
 * `ad` was in the database CHECK from the beginning and in no producer: the
 * native chain writes thousands of authorized ad-level `cut` decisions a day
 * and none of them reached a surface an operator could act on. It is a real
 * grain here now; what differs is the write path, which carries an immutable
 * per-attempt journal and therefore stays operator-approved.
 */
export type MetaAutomationProposalScope = "campaign" | "adset" | "ad";

/**
 * The queued actions unattended execution may take, and therefore the ones the
 * daily cap must count.
 *
 * It lives here rather than beside the sweep because the atomic claim in this
 * module has to count the SAME families the sweep dispatches. They were two
 * different lists: the claim counted `proposed_action = 'budget'` while the
 * sweep also executed pause and resume, so a cap of three permitted three
 * budget writes AND three more pauses on every tick — the cap an operator set
 * to bound money-moving actions bounded one third of them.
 *
 * `duplicate` and `launch` are absent: both create an entity, and creating one
 * without an operator is a different authorization than changing one that
 * already exists.
 *
 * `bid` is here now. It was excluded because no queue row could prove an
 * amount — the row carried a verb and a target and an executor would have had
 * to invent the size of the change. `bid_envelope_json` is that amount, the
 * database refuses a `bid` row without one, and the same daily cap that bounds
 * a budget change now bounds a cap change, because both move money.
 */
export const AUTOMATABLE_PROPOSAL_ACTIONS = [
  "budget",
  "bid",
  "pause",
  "resume",
] as const;

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

/**
 * The row's life, including the two states the execution claim needs.
 *
 * `claimed` is held by exactly one approval attempt between the compare-and-set
 * that wins the row and the settle that records what happened. It exists
 * because a provider pause cannot be taken back: without it the only guard
 * between two concurrent approvals ran AFTER the provider call, so both could
 * dispatch and only one could be recorded.
 *
 * `reconcile` is the honest terminal state for an attempt whose provider
 * outcome is unknown — the dispatch started and no answer came back. It is
 * never auto-approved (that would call an unknown a success) and never
 * requeued (that would risk a second write), so it waits for a human.
 */
export const META_AUTOMATION_PROPOSAL_STATUSES = [
  "pending",
  "claimed",
  "approved",
  "failed",
  "modified",
  "dismissed",
  "expired",
  "reconcile",
] as const;

/**
 * Statuses that occupy an entity's one action slot.
 *
 * A claimed row is mid-dispatch, so the slot is taken: raising a second pause
 * for the same entity while the first is on its way to Meta would be two writes
 * for one decision. This list is the code-side twin of the partial unique index
 * `uq_meta_automation_proposals_open_slot`.
 *
 * `reconcile` is in this list, and leaving it out was a hole. A reconcile row
 * means "a dispatch for this entity/action began and its provider outcome is
 * UNKNOWN". While the pending-and-claimed-only version of this list was in
 * force, a stale claim swept into `reconcile` freed the slot, so the next
 * snapshot projection or rule firing could raise a NEW proposal for the same
 * entity and action — a second dispatch path for work whose provider outcome
 * nobody has established. An unknown outcome is not an absent outcome, so the
 * slot stays held until a human resolves it against a fresh provider read.
 */
export const META_AUTOMATION_PROPOSAL_OPEN_STATUSES = [
  "pending",
  "claimed",
  "reconcile",
] as const;

/**
 * Statuses that mean "this snapshot day's proposal has NOT been decided yet".
 *
 * Deliberately narrower than the open list, and the difference is the point.
 * `reconcile` is both DECIDED (an operator already acted on it; that attempt is
 * over) and OPEN (its slot is still held). Widening this list to match the open
 * one would let the projection re-raise the same rec type for the same snapshot
 * day after a reconcile; narrowing the open list to match this one is the bug
 * this pair replaces.
 */
export const META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES = [
  "pending",
  "claimed",
] as const;

/**
 * Render a fixed status list as a SQL literal list.
 *
 * The lists above are `as const` compile-time constants, so nothing external
 * reaches this; the reason it exists is drift. Two hand-written copies of
 * `IN ('pending', 'claimed')` in this file already disagreed with the partial
 * unique index they were supposed to mirror.
 */
function sqlStatusList(statuses: readonly string[]): string {
  return statuses.map((status) => `'${status}'`).join(", ");
}

/** `'pending', 'claimed', 'reconcile'` — the open-slot predicate, once. */
export const META_AUTOMATION_PROPOSAL_OPEN_STATUS_SQL = sqlStatusList(
  META_AUTOMATION_PROPOSAL_OPEN_STATUSES,
);

/** `'pending', 'claimed'` — the not-yet-decided predicate, once. */
const META_AUTOMATION_PROPOSAL_UNDECIDED_STATUS_SQL = sqlStatusList(
  META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES,
);
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
  /**
   * The attempt's claim token, carried into the receipt so a ledger row, a
   * queue row and a response envelope can be joined to ONE attempt.
   *
   * Optional in the type because receipts written before the claim existed do
   * not have one, and a missing key must read as missing rather than as some
   * other attempt's key.
   */
  receiptKey?: string | null;
  /** Which authorization path produced this receipt. */
  executionKind?: "manual" | "scheduled";
  /**
   * Set when the dispatch started and no provider answer was obtained. An
   * ambiguous attempt is never presented as PAUSED or as success.
   */
  ambiguous?: boolean;
}

/**
 * What this attempt actually established about the provider — in three facts,
 * not one boolean.
 *
 * A single `providerWrite: boolean` cannot express this path's real outcomes.
 * The record that says in its own message "the pause may have happened at Meta"
 * used to be written to the ledger as `providerWrite: false`, which reads —
 * and filters, and aggregates — as "nothing was sent". That is the one thing
 * the record does not know.
 *
 * - `providerDispatchStarted` — did this attempt enter the provider handler at
 *   all? The durable evidence is `dispatch_started_at`, written BEFORE the call.
 * - `providerOutcomeKnown` — did a provider answer come back and get read? An
 *   exception, a timeout, or a settle that died before recording the answer all
 *   leave this `false`.
 * - `providerWriteVerified` — did an answer come back that PROVES a write
 *   landed at Meta? A dry run is `false` here and always will be: nothing left
 *   the building. `false` with `providerOutcomeKnown: false` means UNKNOWN, and
 *   the two fields must be read together — that pairing is the whole contract.
 *
 * There is no fourth field for "no write happened". Absence is
 * `providerDispatchStarted: false`, which is a fact this path can actually
 * prove; "the write definitely did not land" after a dispatch is not.
 */
export interface MetaAutomationProviderDispatchFacts {
  providerDispatchStarted: boolean;
  providerOutcomeKnown: boolean;
  providerWriteVerified: boolean;
}

/** Nothing was dispatched at all — modify, dismiss, a refusal before dispatch. */
export const NO_PROVIDER_DISPATCH: MetaAutomationProviderDispatchFacts = {
  providerDispatchStarted: false,
  providerOutcomeKnown: true,
  providerWriteVerified: false,
};

/**
 * Derive the three facts from what an attempt actually observed.
 *
 * One function so the ledger row, the response envelope and the reconciliation
 * receipt cannot disagree about the same attempt.
 */
export function providerDispatchFacts(input: {
  /** True once `dispatch_started_at` was stamped for this attempt. */
  dispatchStarted: boolean;
  /** True when a provider answer was obtained AND read by this request. */
  outcomeKnown: boolean;
  /** The handler's own success verdict. Only meaningful when the outcome is known. */
  ok: boolean;
  /** A dry run never leaves the building, so it can never verify a write. */
  dryRun: boolean;
}): MetaAutomationProviderDispatchFacts {
  return {
    providerDispatchStarted: input.dispatchStarted,
    providerOutcomeKnown: input.outcomeKnown,
    providerWriteVerified:
      input.dispatchStarted && input.outcomeKnown && input.ok && !input.dryRun,
  };
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
  /**
   * D088: the immutable server-built budget envelope.
   *
   * Non-null only on a `budget` row whose stored envelope parses AND whose
   * stored fingerprint re-derives from its own fields. Null on every other
   * action, on a pre-migration read, and on a `budget` row that has been
   * tampered with — which is why the executor refuses when it is null.
   */
  budgetEnvelope: BudgetProposalEnvelope | null;
  /**
   * The same fact for a `bid` row: which ad set, from what, to what.
   *
   * Non-null only when the stored envelope parses, its own arithmetic holds
   * and it names this row. The database refuses a `bid` row without one, so a
   * null here means the value was edited or copied from another proposal —
   * and the executor refuses rather than writing an amount it cannot vouch for.
   */
  bidEnvelope: BidProposalEnvelope | null;
  /**
   * The current (or last) execution claim.
   *
   * `null` on a database that has not run the claim migration yet, which is a
   * different fact from "no attempt has been made" — see
   * {@link claimMetaAutomationProposal}, which refuses to execute at all in
   * that state rather than dispatching unclaimed.
   */
  claimToken: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  /** Stamped immediately before the provider handler is entered. */
  dispatchStartedAt: string | null;
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
    case "launch":
      // The intent names its own destination, so the tag names the act.
      return "Create paused ad";
    case "bid":
      return `Apply bid`;
    case "duplicate":
      return `Duplicate ${entity}`;
    case "budget":
      // D088. The amount is a server fact and belongs on the row's own
      // evidence, not in a caption the queue renders from an enum.
      return `Change ${entity} budget`;
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
  /** D088. Absent on a pre-migration read; the mapper then yields null. */
  budget_envelope_json?: unknown;
  /** The bid amount envelope. Absent the same way on a pre-migration read. */
  bid_envelope_json?: unknown;
  /** Absent (undefined) on a database that predates the claim migration. */
  claim_token?: string | null;
  claimed_by?: string | null;
  claimed_at?: string | null;
  dispatch_started_at?: string | null;
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
    /*
      D088 C2: the envelope must be THIS row's. The fingerprint proves it has
      not been edited; the identity check proves it was not copied from another
      proposal, account or entity, where it would re-fingerprint perfectly.
    */
    budgetEnvelope: envelopeForProposalRow(
      parseBudgetProposalEnvelope(row.budget_envelope_json ?? null),
      {
        id: row.id,
        businessId: row.business_id,
        providerAccountId: row.provider_account_id,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        proposedAction: row.proposed_action,
        // D088 C3: the row's own decision lineage, re-checked.
        recId: row.rec_id,
        recType: row.rec_type,
        snapshotDate: String(row.snapshot_date).slice(0, 10),
        engineVersion: row.engine_version,
      },
    ),
    /*
      The same two proofs the budget envelope gets: the fingerprint says it was
      not edited, the identity check says it was not copied from another row —
      where it would re-fingerprint perfectly and name another ad set's cap.
    */
    bidEnvelope: bidEnvelopeForProposalRow(
      parseBidProposalEnvelope(row.bid_envelope_json ?? null),
      {
        id: row.id,
        businessId: row.business_id,
        providerAccountId: row.provider_account_id,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
      },
    ),
    claimToken: row.claim_token ?? null,
    claimedBy: row.claimed_by ?? null,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    dispatchStartedAt: row.dispatch_started_at
      ? new Date(row.dispatch_started_at).toISOString()
      : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const PROPOSAL_BASE_COLUMNS = `
  id, business_id, provider_account_id, origin, rule_id, dedupe_key,
  decision_key, scope_type, scope_id,
  rec_id, rec_type, snapshot_date::text AS snapshot_date, engine_version,
  decision_label, proposed_action, action_label, primary_caption, entity_label,
  reason, evidence_label, evidence_ref, expires_at, status, decided_by,
  decided_at, decision_note, receipt_json, created_at, updated_at
`;

/**
 * D088's envelope column, read separately so a pre-migration database degrades
 * the same way the claim columns do: the row still reads, the envelope is null,
 * and a budget approval refuses rather than dispatching without one.
 */
const PROPOSAL_BUDGET_COLUMNS = `budget_envelope_json, bid_envelope_json`;

/** The claim columns, cast to text so a UUID arrives as the key it is used as. */
const PROPOSAL_CLAIM_COLUMNS = `
  claim_token::text AS claim_token, claimed_by::text AS claimed_by,
  claimed_at, dispatch_started_at
`;

const PROPOSAL_COLUMNS =
  `${PROPOSAL_BASE_COLUMNS}, ${PROPOSAL_CLAIM_COLUMNS}, ${PROPOSAL_BUDGET_COLUMNS}`;

/** PostgreSQL's `undefined_column`. */
function isUndefinedColumnError(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "42703"
  );
}

/**
 * Run a read that names the claim columns, and fall back to the pre-claim
 * column list when the migration has not run yet.
 *
 * READS degrade; the CLAIM does not. A row read without its claim columns is
 * still an honest queue row (the fields come back null), but an approval that
 * cannot claim must refuse rather than dispatch — see
 * {@link claimMetaAutomationProposal}.
 */
async function withClaimColumnFallback<T>(
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

async function selectProposalRows(
  where: string,
  params: unknown[],
): Promise<ProposalDbRow[]> {
  return withClaimColumnFallback(
    async () =>
      (await getDb().query<ProposalDbRow>(
        `SELECT ${PROPOSAL_COLUMNS} FROM meta_automation_proposals ${where}`,
        params,
      )) as ProposalDbRow[],
    async () =>
      (await getDb().query<ProposalDbRow>(
        `SELECT ${PROPOSAL_BASE_COLUMNS} FROM meta_automation_proposals ${where}`,
        params,
      )) as ProposalDbRow[],
  );
}

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

/**
 * How long one approval may hold a claimed row.
 *
 * Deliberately NOT the proposal's own 24h expiry: the expiry is about the
 * evidence, the lease is about a request that may have died. It is far longer
 * than any dispatch this path performs (one guarded HTTP handler call under the
 * 8s web DB timeout), so a live approval can never be swept out from under
 * itself, and short enough that a crashed one does not hold the entity's slot
 * for a day.
 */
export const META_AUTOMATION_PROPOSAL_CLAIM_LEASE_MS = 5 * 60 * 1000;

export interface SweepMetaAutomationProposalClaimsResult {
  /** Claims proven never to have dispatched, returned to the queue. */
  requeued: number;
  /** Claims proven never to have dispatched whose evidence had also aged out. */
  expired: number;
  /** Claims whose dispatch started and whose outcome is unknown. */
  reconcile: number;
  ran: boolean;
}

type ProposalClaimSweepDb = Pick<ReturnType<typeof getDb>, "query">;
const SCHEDULED_ACTOR_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The stale-lease transition against the caller's current DB handle.
 *
 * Keeping this separate from schema readiness is load-bearing: the scheduled
 * claim path calls it after taking its transaction advisory lock, and
 * `getDb()` then resolves to that same transaction through AsyncLocalStorage.
 * The sweep and the cap count therefore cannot be interleaved by another cron
 * worker for the same business/account.
 */
async function sweepStaleMetaAutomationProposalClaimsWithDb(
  db: ProposalClaimSweepDb,
  input: { businessId: string; now: Date },
): Promise<SweepMetaAutomationProposalClaimsResult> {
  const leaseCutoff = new Date(
    input.now.getTime() - META_AUTOMATION_PROPOSAL_CLAIM_LEASE_MS,
  ).toISOString();
  try {
    const rows = (await db.query<{ next_status: string }>(
      `
        UPDATE meta_automation_proposals
        SET status = CASE
              WHEN dispatch_started_at IS NOT NULL THEN 'reconcile'
              WHEN expires_at <= $2::timestamptz THEN 'expired'
              ELSE 'pending'
            END,
            -- The claim itself is released only where it is provably spent.
            -- A row moved to 'reconcile' keeps its token, because that token
            -- is the receipt key an operator will reconcile against.
            claim_token = CASE
              WHEN dispatch_started_at IS NOT NULL THEN claim_token
              ELSE NULL
            END,
            claimed_by = CASE
              WHEN dispatch_started_at IS NOT NULL THEN claimed_by
              ELSE NULL
            END,
            claimed_at = CASE
              WHEN dispatch_started_at IS NOT NULL THEN claimed_at
              ELSE NULL
            END,
            updated_at = NOW()
        WHERE business_id = $1::uuid
          AND status = 'claimed'
          AND claimed_at <= $3::timestamptz
        RETURNING status AS next_status
      `,
      [input.businessId, input.now.toISOString(), leaseCutoff],
    )) as Array<{ next_status: string }>;
    return {
      requeued: rows.filter((row) => row.next_status === "pending").length,
      expired: rows.filter((row) => row.next_status === "expired").length,
      reconcile: rows.filter((row) => row.next_status === "reconcile").length,
      ran: true,
    };
  } catch (error) {
    // An unmigrated database has no safe way to classify claim leases.
    if (isUndefinedColumnError(error)) {
      return { requeued: 0, expired: 0, reconcile: 0, ran: false };
    }
    throw error;
  }
}

/**
 * Age out claims that outlived their lease — WITHOUT ever guessing.
 *
 * Three branches, and the split between them is the whole point:
 *
 * - `dispatch_started_at IS NULL` means the claim holder never entered the
 *   provider handler, because that column is written first. Nothing reached
 *   Meta, so the row may go back to `pending` (or to `expired` if its evidence
 *   aged out meanwhile). This is a *proven* requeue, not a blind one.
 * - `dispatch_started_at IS NOT NULL` means a provider write may exist. It is
 *   moved to `reconcile` and left there: requeueing it could pause the same
 *   entity twice, and calling it `approved` would report a success nobody
 *   observed. Both are guesses; a human resolves this one.
 */
export async function sweepStaleMetaAutomationProposalClaims(input: {
  businessId: string;
  now?: Date;
}): Promise<SweepMetaAutomationProposalClaimsResult> {
  if (!(await proposalsReady())) {
    return { requeued: 0, expired: 0, reconcile: 0, ran: false };
  }
  const now = input.now ?? new Date();
  return sweepStaleMetaAutomationProposalClaimsWithDb(getDb(), {
    businessId: input.businessId,
    now,
  });
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
 *   a proposal the operator had already dismissed that same day. `claimed`
 *   counts as NOT decided — a claim is an attempt in flight, and if it is
 *   released the row goes back to `pending` and is the queue's row again —
 *   while `reconcile` counts as decided, because re-raising a pause for an
 *   entity whose last attempt has an unknown provider outcome would offer a
 *   second write for the same unresolved decision.
 * - The `NOT EXISTS` against an *open* (pending, claimed or reconcile) row
 *   already occupying this entity's action slot — whatever raised it. A rule
 *   that has
 *   already queued a pause on this ad set makes the projection's row
 *   redundant: two rows would be two chances to do the same thing, and the
 *   header count would say `2` for one pause. Claimed is included because a
 *   row being dispatched right now holds the slot most of all, and `reconcile`
 *   because a dispatch that began and never answered may ALREADY have paused
 *   the entity — projecting a fresh pause there offers a second write for an
 *   outcome nobody has established. Without them the insert would also collide
 *   with `uq_meta_automation_proposals_open_slot` and throw inside the snapshot
 *   pipeline. The clause exempts the exact PENDING row this statement upserts
 *   onto (same rec type, same snapshot day), so refresh-in-place still works.
 * - The operator's ROAS proposal floor. Same guardrail the rule evaluator
 *   applies, at the other producer of a queue row, so a floor an operator
 *   committed cannot be walked around by whichever half raised the proposal.
 *   It compares the warehouse's own served `roas` for that entity on the
 *   snapshot day the decision is about — the day the evidence describes — and
 *   requires it to be strictly below the floor. `spend > 0` is what separates a
 *   measurement from the `NOT NULL DEFAULT 0` column default, so an entity with
 *   no served row, or no spend, is UNPROVABLE and is not projected: an unknown
 *   ROAS must not be able to pass the tightest floor an operator can set.
 */
export async function projectMetaAutomationProposals(input: {
  businessId: string;
  snapshotDate: string;
  now?: Date;
  /** Injectable so the projection stays testable without a control plane. */
  readModes?: typeof resolveEffectiveMetaModes;
}): Promise<ProjectMetaAutomationProposalsResult> {
  if (!(await proposalsReady())) {
    return { projected: 0, expired: 0, ran: false };
  }

  /*
    The standing mode decides whether a queue row is wanted at all.

    In manual mode the operator applies from the decision card; a confirmation
    queue that fills up behind them is a second inbox nobody asked for, and one
    they would have to dismiss row by row. Semi-automatic and automatic are the
    two modes whose whole shape is "it arrives here first", so those are the two
    that project.

    An unreadable mode is `manual` — the safe reading, and the one
    `resolveEffectiveMetaModes` already gives.
  */
  const modes = await (input.readModes ?? resolveEffectiveMetaModes)(
    input.businessId,
  );
  if (modes.pause === "manual") {
    return { projected: 0, expired: 0, ran: true };
  }
  // Read the floor before anything else happens. "I could not read the floor"
  // is not "there is no floor", and projecting under a guardrail this process
  // could not consult would re-open the very hole it closes.
  const floorRead = await readMetaAutomationProposalRoasFloor(input.businessId);
  if (floorRead.status === "unreadable") {
    return { projected: 0, expired: 0, ran: false };
  }
  const minRoasFloor = floorRead.floor;
  const now = input.now ?? new Date();
  const expired = await expireStaleMetaAutomationProposals({
    businessId: input.businessId,
    now,
  });
  // A claim whose holder died holds this entity's action slot, and the `held`
  // clause below honours that — correctly, but forever if nothing ever ages it
  // out. The sweep runs at BOTH producers (here and the queue read) because
  // the snapshot pipeline can run for a business nobody has the screen open
  // for. It never guesses: see its own contract for the three branches.
  await sweepStaleMetaAutomationProposalClaims({
    businessId: input.businessId,
    now,
  }).catch(() => null);

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
              AND decided.status NOT IN (${META_AUTOMATION_PROPOSAL_UNDECIDED_STATUS_SQL})
          )
          AND NOT EXISTS (
            SELECT 1
            FROM meta_automation_proposals held
            WHERE held.business_id = $1::uuid
              AND held.provider_account_id = dim.provider_account_id
              AND held.decision_key = d.scope_type || ':' || d.scope_id
              AND held.proposed_action = 'pause'
              AND held.status IN (${META_AUTOMATION_PROPOSAL_OPEN_STATUS_SQL})
              -- The exemption is for the row this statement REFRESHES in place,
              -- and only a pending row can be refreshed: the upsert's own
              -- DO UPDATE is guarded on status = 'pending'. Exempting a
              -- reconcile row here would let the projection attempt an insert
              -- against a held slot, which the open-slot unique index would
              -- then reject inside the snapshot pipeline.
              AND NOT (
                held.status = 'pending'
                AND held.origin = 'engine_decision'
                AND held.rec_type = d.rec_type
                AND held.snapshot_date = d.snapshot_date
              )
          )
          AND (
            $5::numeric IS NULL
            OR EXISTS (
              SELECT 1
              FROM meta_campaign_daily perf
              WHERE d.scope_type = 'campaign'
                AND perf.business_id = d.business_id
                AND perf.provider_account_id = dim.provider_account_id
                AND perf.campaign_id = d.scope_id
                AND perf.date = d.snapshot_date
                AND perf.spend > 0
                AND perf.roas < $5::numeric
            )
            OR EXISTS (
              SELECT 1
              FROM meta_adset_daily perf
              WHERE d.scope_type = 'adset'
                AND perf.business_id = d.business_id
                AND perf.provider_account_id = dim.provider_account_id
                AND perf.adset_id = d.scope_id
                AND perf.date = d.snapshot_date
                AND perf.spend > 0
                AND perf.roas < $5::numeric
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
      minRoasFloor,
    ],
  )) as Array<{ id: string }>;

  /*
    The native ad projection does NOT run here.

    It used to, and the ordering made it useless: this projection is called
    from the structure snapshot, and the cron runs the native ad chain
    AFTERWARDS. So it read the previous slot's native decisions every time —
    the morning's decisions never entered the queue in the morning, and by the
    afternoon it was reading them while the afternoon's own decisions were
    again still unwritten.

    It is now `projectNativeAdProposals`, called by the native chain once that
    chain has actually published. Same statement, same idempotency; the only
    change is that it runs after the rows it reads exist.
  */
  return { projected: rows.length, expired, ran: true };
}

/**
 * The native ad decisions, which had no producer at all.
 *
 * The creative chain writes an ad-grain `cut` with its own `authorized_action`
 * — the field that says the engine's authority survived every blocker — and
 * nothing has ever turned one into something an operator could act on. Both
 * conditions are required here: a `cut` label whose authority was withheld is
 * a diagnosis, not a proposal, and projecting it would offer an action the
 * engine deliberately refused to authorize.
 *
 * A failure returns zero rather than throwing. The pause projection above has
 * already committed, and losing it because the native table is absent in some
 * environment would trade a working queue for a missing one.
 */
/**
 * Project the native ad decisions this business just published.
 *
 * Called by the native chain, per business, AFTER it has written
 * `engine_v3_ad_decision_snapshots_daily` for the day — which is the whole
 * point: run from the structure snapshot, as it was, it could only ever see
 * the previous slot's decisions.
 *
 * Idempotent by construction. The insert's ON CONFLICT targets the projection's
 * own unique key (business, account, decision key, rec type, snapshot date) and
 * only refreshes a row that is still `pending`, so a second call after a
 * partial run adds what is missing and touches nothing an operator has decided.
 * Safe to call again for one account, or for all of them.
 */
export async function projectNativeAdProposals(input: {
  businessId: string;
  snapshotDate: string;
  ttlInterval?: string;
}): Promise<{ projected: number; ran: boolean }> {
  if (!(await proposalsReady())) return { projected: 0, ran: false };
  const modes = await resolveEffectiveMetaModes(input.businessId).catch(() => null);
  // Same standing-mode gate the pause projection applies: in manual mode the
  // operator applies from the card, and a queue filling up behind them is a
  // second inbox nobody asked for.
  if (!modes || modes.pause === "manual") {
    return { projected: 0, ran: modes !== null };
  }
  const projected = await projectNativeAdPauseProposals({
    businessId: input.businessId,
    snapshotDate: input.snapshotDate,
    ttlInterval:
      input.ttlInterval ?? `${META_AUTOMATION_PROPOSAL_TTL_HOURS} hours`,
  });
  return { projected, ran: true };
}

async function projectNativeAdPauseProposals(input: {
  businessId: string;
  snapshotDate: string;
  ttlInterval: string;
}): Promise<number> {
  const rows = (await getDb().query<{ id: string }>(
    `
      WITH decisions AS (
        SELECT DISTINCT ON (d.ad_id)
               d.ad_id,
               d.creative_id,
               d.provider_account_id,
               d.evaluation_id::text AS rec_id,
               d.as_of_date,
               d.engine_version,
               d.reason,
               d.decision_hash,
               d.roas,
               d.spend,
               d.effective_target_roas,
               dim.ad_name_current AS entity_label
          FROM engine_v3_ad_decision_snapshots_daily d
          JOIN meta_ad_dimensions dim
            ON dim.business_id = d.business_id
           AND dim.provider_account_id = d.provider_account_id
           AND dim.ad_id = d.ad_id
         WHERE d.business_id = $1::text
           AND d.as_of_date = $2::date
           AND d.label = 'cut'
           AND d.authorized_action = 'cut'
           -- The identity the ad write must present. Without it the dispatch
           -- builder withholds, so a row that could never execute is never
           -- offered.
           AND NULLIF(BTRIM(d.creative_id), '') IS NOT NULL
           AND COALESCE(UPPER(dim.ad_status), '') <> 'PAUSED'
           AND NOT EXISTS (
             SELECT 1
               FROM meta_automation_proposals decided
              WHERE decided.business_id = $1::uuid
                AND decided.provider_account_id = d.provider_account_id
                AND decided.decision_key = 'ad:' || d.ad_id
                AND decided.snapshot_date = d.as_of_date
                AND decided.status NOT IN (${META_AUTOMATION_PROPOSAL_UNDECIDED_STATUS_SQL})
           )
           AND NOT EXISTS (
             SELECT 1
               FROM meta_automation_proposals held
              WHERE held.business_id = $1::uuid
                AND held.provider_account_id = d.provider_account_id
                AND held.decision_key = 'ad:' || d.ad_id
                AND held.proposed_action = 'pause'
                AND held.status IN (${META_AUTOMATION_PROPOSAL_OPEN_STATUS_SQL})
                AND NOT (
                  held.status = 'pending'
                  AND held.origin = 'engine_decision'
                  AND held.rec_type = 'native_ad_cut'
                  AND held.snapshot_date = d.as_of_date
                )
           )
         ORDER BY d.ad_id, d.computed_at DESC
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
             'ad:' || ad_id,
             'ad',
             ad_id,
             rec_id,
             'native_ad_cut',
             as_of_date,
             engine_version,
             'cut',
             'pause',
             'Pause ad',
             $3,
             NULLIF(BTRIM(entity_label), ''),
             reason,
             NULL,
             jsonb_build_object(
               'recId', rec_id,
               'recType', 'native_ad_cut',
               'snapshotDate', as_of_date::text,
               'engineVersion', engine_version,
               'decisionKey', 'ad:' || ad_id,
               'creativeId', creative_id,
               'decisionHash', decision_hash,
               'evidence', jsonb_build_object(
                 'roas', roas,
                 'spend', spend,
                 'targetRoas', effective_target_roas
               )
             ),
             NOW() + $4::interval,
             'pending'
        FROM decisions
      ON CONFLICT (business_id, provider_account_id, decision_key, rec_type, snapshot_date)
      DO UPDATE SET
        reason = EXCLUDED.reason,
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
      input.ttlInterval,
    ],
  ).catch(() => null)) as Array<{ id: string }> | null;
  return rows?.length ?? 0;
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
  // A claim whose holder died must not hold the entity's slot forever, and a
  // claim whose dispatch started must not be silently returned to the queue.
  // Both are decided by the sweep, never by this read.
  await sweepStaleMetaAutomationProposalClaims({
    businessId: input.businessId,
    now,
  }).catch(() => null);
  const rows = await selectProposalRows(
    `
      WHERE business_id = $1::uuid
        AND provider_account_id = $2
        AND status = 'pending'
        AND expires_at > $3::timestamptz
      ORDER BY expires_at ASC, created_at ASC
    `,
    [input.businessId, input.providerAccountId, now.toISOString()],
  );
  return { readCompleteness: "complete", proposals: rows.map(mapProposalRow) };
}

/**
 * Rows this account is holding open without being approvable.
 *
 * A `claimed` row is being dispatched right now and a `reconcile` row has an
 * unknown provider outcome; neither belongs in the operator's "needs your
 * confirmation" list, and neither may be silently forgotten either. The counts
 * travel in the queue's completeness envelope so the surface can say that
 * something is in flight without inventing a row for it.
 */
export interface MetaAutomationProposalHoldCounts {
  claimed: number;
  reconcile: number;
}

export async function countMetaAutomationProposalHolds(input: {
  businessId: string;
  providerAccountId: string;
}): Promise<MetaAutomationProposalHoldCounts | null> {
  if (!(await proposalsReady())) return null;
  try {
    const rows = (await getDb().query<{ status: string; count: string }>(
      `
        SELECT status, COUNT(*)::text AS count
        FROM meta_automation_proposals
        WHERE business_id = $1::uuid
          AND provider_account_id = $2
          AND status IN ('claimed', 'reconcile')
        GROUP BY status
      `,
      [input.businessId, input.providerAccountId],
    )) as Array<{ status: string; count: string }>;
    const at = (status: string) =>
      Number(rows.find((row) => row.status === status)?.count ?? "0");
    return { claimed: at("claimed"), reconcile: at("reconcile") };
  } catch {
    // Unknown, not zero. The caller reports the section as unavailable.
    return null;
  }
}

/** One proposal, scoped to the authorized business and its resolved account. */
export async function readMetaAutomationProposal(input: {
  businessId: string;
  providerAccountId: string;
  proposalId: string;
}): Promise<MetaAutomationProposal | null> {
  if (!(await proposalsReady())) return null;
  const rows = await selectProposalRows(
    `
      WHERE business_id = $1::uuid
        AND provider_account_id = $2
        AND id = $3::uuid
      LIMIT 1
    `,
    [input.businessId, input.providerAccountId, input.proposalId],
  );
  return rows[0] ? mapProposalRow(rows[0]) : null;
}

/**
 * The result of trying to take the execution claim.
 *
 * `migration_required` is NOT an error the caller may ignore. It means this
 * database cannot express a claim, so an approval has no way to be exclusive —
 * and the only safe answer to "may I write to Meta without exclusivity" is no.
 */
export type ClaimMetaAutomationProposalResult =
  | {
      status: "claimed";
      proposal: MetaAutomationProposal;
      /** Also the receipt key. Unique per attempt. */
      claimToken: string;
    }
  | { status: "conflict"; current: MetaAutomationProposal | null }
  | { status: "migration_required" }
  | { status: "unavailable" };

export type ClaimScheduledMetaAutomationProposalResult =
  | ClaimMetaAutomationProposalResult
  | { status: "cap_reached" }
  | { status: "cap_unavailable" }
  | { status: "activation_changed" };

/**
 * Reserve one unattended budget action under the business/account daily cap.
 *
 * The advisory transaction lock makes the count and `pending -> claimed`
 * transition one serial operation across web/worker processes. Without this,
 * two cron invocations could both observe one remaining slot and both claim a
 * proposal. Current claims and recent reconcile rows count conservatively as
 * reservations until their provider outcome is safe to ignore.
 */
export async function claimScheduledMetaAutomationProposal(input: {
  businessId: string;
  providerAccountId: string;
  proposalId: string;
  claimedBy: string;
  /** Exact activation tuple observed before this unattended claim. */
  expectedEnablingActorUserId: string;
  expectedActivationControlVersion: string;
  dailyAutoActionCap: number;
  now?: Date;
}): Promise<ClaimScheduledMetaAutomationProposalResult> {
  const now = input.now ?? new Date();
  if (!Number.isSafeInteger(input.dailyAutoActionCap)
    || input.dailyAutoActionCap <= 0
    || typeof input.expectedEnablingActorUserId !== "string"
    || !SCHEDULED_ACTOR_UUID_PATTERN.test(input.expectedEnablingActorUserId)
    || input.claimedBy !== input.expectedEnablingActorUserId
    || typeof input.expectedActivationControlVersion !== "string"
    || input.expectedActivationControlVersion.trim() === ""
    || !Number.isFinite(now.getTime())) {
    return { status: "activation_changed" };
  }
  if (!(await proposalsReady())) return { status: "unavailable" };

  return runDbTransaction(async () => {
    await getDb().query(
      `SELECT pg_advisory_xact_lock(
         hashtext('meta_budget_daily_cap'),
         hashtext($1::text || ':' || $2::text)
       )`,
      [input.businessId, input.providerAccountId],
    );
    /*
      Bind the claim itself to the exact activation observed by the scheduler.
      The row and enabling membership are share-locked until the claim commits,
      so disable/re-enable or actor replacement cannot create a claim under the
      previous authority tuple.
    */
    const activation = await getDb().query<{ business_id: string }>(
      `SELECT controls.business_id::text AS business_id
         FROM meta_automation_business_controls controls
         JOIN memberships m
           ON m.user_id = controls.auto_execution_enabled_by
          AND m.business_id = controls.business_id
          AND m.role = 'admin'
          AND m.status = 'active'
        WHERE controls.business_id = $1::uuid
          AND controls.auto_execution_enabled = TRUE
          AND controls.auto_execution_provider_account_id = $2
          AND controls.auto_execution_enabled_by = $3::uuid
          AND controls.updated_at = $4::timestamptz
        FOR SHARE OF controls, m`,
      [input.businessId, input.providerAccountId,
        input.expectedEnablingActorUserId,
        input.expectedActivationControlVersion],
    );
    if (activation.length !== 1) return { status: "activation_changed" };
    /*
      A `claimed` row reserves one daily slot, but only for the five-minute
      lease. Reclassify expired leases while this business/account cap lock is
      held; otherwise a crashed markerless worker can consume the cap forever
      and prevent the scheduler from ever reaching this helper again.
    */
    const swept = await sweepStaleMetaAutomationProposalClaimsWithDb(getDb(), {
      businessId: input.businessId,
      now,
    });
    if (!swept.ran) return { status: "cap_unavailable" };
    const rows = await getDb().query<{ used: number }>(
      `SELECT count(*)::int AS used
         FROM meta_automation_proposals
        WHERE business_id = $1::uuid
          AND provider_account_id = $2
          -- EVERY family this sweep can dispatch, not just budget. Counting one
          -- of three meant the cap bounded a third of the automatic actions an
          -- operator thought it bounded.
          AND proposed_action = ANY($4::text[])
          AND (
            (status = 'approved'
              AND decided_at >= $3::timestamptz - interval '24 hours'
              AND receipt_json->>'executionKind' = 'scheduled')
            OR status = 'claimed'
            OR (status = 'reconcile'
              AND COALESCE(decided_at, claimed_at, updated_at)
                >= $3::timestamptz - interval '24 hours')
          )`,
      [input.businessId, input.providerAccountId, now.toISOString(),
        [...AUTOMATABLE_PROPOSAL_ACTIONS]],
    );
    const used = Number(rows[0]?.used);
    if (!Number.isSafeInteger(used) || used < 0) {
      return { status: "cap_unavailable" };
    }
    if (used >= input.dailyAutoActionCap) return { status: "cap_reached" };

    return claimMetaAutomationProposal({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      proposalId: input.proposalId,
      claimedBy: input.claimedBy,
      now,
    });
  });
}

/**
 * Take the row, atomically, BEFORE anything reaches a provider.
 *
 * This is the fix the previous shape of this module owed. The compare-and-set
 * used to run after `executeMetaAutomationProposal`, which meant it decided who
 * got to RECORD the outcome, not who got to CAUSE it: two concurrent approvals
 * both reached the provider handler and only the winner's row said so. Here the
 * single statement below is the gate — `pending -> claimed ... RETURNING` — and
 * PostgreSQL guarantees exactly one caller sees a returned row.
 *
 * The expiry is re-checked inside the same statement rather than trusted from
 * the caller's earlier read, because that read happened before every gate the
 * route runs and a proposal can age out in between.
 */
export async function claimMetaAutomationProposal(input: {
  businessId: string;
  providerAccountId: string;
  proposalId: string;
  claimedBy: string;
  now?: Date;
}): Promise<ClaimMetaAutomationProposalResult> {
  if (!(await proposalsReady())) return { status: "unavailable" };
  const now = (input.now ?? new Date()).toISOString();
  let rows: ProposalDbRow[];
  try {
    rows = (await getDb().query<ProposalDbRow>(
      `
        UPDATE meta_automation_proposals
        SET status = 'claimed',
            claim_token = gen_random_uuid(),
            claimed_by = $4::uuid,
            claimed_at = NOW(),
            dispatch_started_at = NULL,
            updated_at = NOW()
        WHERE business_id = $1::uuid
          AND provider_account_id = $2
          AND id = $3::uuid
          AND status = 'pending'
          AND expires_at > $5::timestamptz
        RETURNING ${PROPOSAL_COLUMNS}
      `,
      [
        input.businessId,
        input.providerAccountId,
        input.proposalId,
        input.claimedBy,
        now,
      ],
    )) as ProposalDbRow[];
  } catch (error) {
    // No claim columns means no exclusivity. Refusing here is what keeps an
    // unmigrated database from running the old both-requests-dispatch race.
    if (isUndefinedColumnError(error)) return { status: "migration_required" };
    throw error;
  }

  const claimed = rows[0] ? mapProposalRow(rows[0]) : null;
  if (claimed?.claimToken) {
    return {
      status: "claimed",
      proposal: claimed,
      claimToken: claimed.claimToken,
    };
  }
  // Zero rows updated: someone else holds it, it was already decided, or it
  // aged out. The caller is told which by the row itself, never by a guess.
  const current = await readMetaAutomationProposal({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    proposalId: input.proposalId,
  }).catch(() => null);
  return { status: "conflict", current };
}

/**
 * Stamp the instant the provider handler is entered, as the claim holder.
 *
 * Written BEFORE the dispatch, never after, because its whole job is to answer
 * "might a write exist?" for a request that never came back. `false` means the
 * claim is no longer held by this token, and the caller must not dispatch.
 */
export async function markMetaAutomationProposalDispatchStarted(input: {
  businessId: string;
  proposalId: string;
  claimToken: string;
}): Promise<boolean> {
  if (!(await proposalsReady())) return false;
  try {
    const rows = (await getDb().query<{ id: string }>(
      `
        UPDATE meta_automation_proposals
        SET dispatch_started_at = NOW(), updated_at = NOW()
        WHERE business_id = $1::uuid
          AND id = $2::uuid
          AND status = 'claimed'
          AND claim_token = $3::uuid
        RETURNING id
      `,
      [input.businessId, input.proposalId, input.claimToken],
    )) as Array<{ id: string }>;
    return rows.length === 1;
  } catch (error) {
    if (isUndefinedColumnError(error)) return false;
    throw error;
  }
}

/**
 * Give the row back, only where giving it back is provable.
 *
 * Guarded on `dispatch_started_at IS NULL`: a claim that never entered the
 * provider handler can safely become `pending` again, and one that did may not,
 * because releasing it would offer a second approval for a write that might
 * already exist.
 */
export async function releaseMetaAutomationProposalClaim(input: {
  businessId: string;
  proposalId: string;
  claimToken: string;
}): Promise<boolean> {
  if (!(await proposalsReady())) return false;
  try {
    const rows = (await getDb().query<{ id: string }>(
      `
        UPDATE meta_automation_proposals
        SET status = 'pending',
            claim_token = NULL,
            claimed_by = NULL,
            claimed_at = NULL,
            updated_at = NOW()
        WHERE business_id = $1::uuid
          AND id = $2::uuid
          AND status = 'claimed'
          AND claim_token = $3::uuid
          AND dispatch_started_at IS NULL
        RETURNING id
      `,
      [input.businessId, input.proposalId, input.claimToken],
    )) as Array<{ id: string }>;
    return rows.length === 1;
  } catch (error) {
    if (isUndefinedColumnError(error)) return false;
    throw error;
  }
}

/**
 * Move a claim this request can no longer settle into `reconcile`.
 *
 * The one caller is the approve boundary's post-dispatch failure path: the
 * provider was already entered, and the settle that was supposed to record its
 * outcome threw. `settleMetaAutomationProposal` is not reusable there — it is
 * the thing that just failed — so this is a deliberately minimal statement with
 * no receipt marshalling, no decided_by, and no jsonb: the fewest moving parts
 * that can still land on a database that is only partly sick.
 *
 * Guarded on `status = 'claimed' AND claim_token = $` so it can only ever move
 * THIS attempt, and on nothing else: `dispatch_started_at` is deliberately not
 * required, because the caller has already been inside the provider handler and
 * a missing stamp there would mean the marking write is the one that failed —
 * still an unknown outcome, still not a release.
 *
 * Returns `false` when nothing moved. `false` is not "it is fine": the caller
 * must then say the state is unknown rather than report a settled outcome. The
 * row stays `claimed` with `dispatch_started_at` set, which the stale-claim
 * sweep resolves to `reconcile` on its own — and which `claimMetaAutomation
 * Proposal` refuses to re-claim in the meantime, because that statement
 * requires `status = 'pending'`.
 */
export async function forceMetaAutomationProposalReconcile(input: {
  businessId: string;
  proposalId: string;
  claimToken: string;
}): Promise<boolean> {
  try {
    const rows = (await getDb().query<{ id: string }>(
      `
        UPDATE meta_automation_proposals
        SET status = 'reconcile', updated_at = NOW()
        WHERE business_id = $1::uuid
          AND id = $2::uuid
          AND status = 'claimed'
          AND claim_token = $3::uuid
        RETURNING id
      `,
      [input.businessId, input.proposalId, input.claimToken],
    )) as Array<{ id: string }>;
    return rows.length === 1;
  } catch {
    // Unknown, never "released". The caller reports reconciliation_required.
    return false;
  }
}

/**
 * Record the outcome of an operator decision.
 *
 * Two guarded shapes, one statement:
 *
 * - WITHOUT a claim token (modify, dismiss): `status = 'pending'`. A row that
 *   an approval has already claimed is therefore untouchable by a modification
 *   or a dismissal — losing the `pending -> claimed` transition here would let
 *   a dismissal overwrite a row whose provider write is already in flight, and
 *   the ledger would then carry a dismissal for something that got paused.
 * - WITH a claim token (approve, fail, reconcile): `status = 'claimed' AND
 *   claim_token = $`. Only the holder of the claim may record its outcome.
 *
 * Either way the loser updates zero rows and gets `null` back.
 */
export async function settleMetaAutomationProposal(input: {
  businessId: string;
  proposalId: string;
  status: MetaAutomationProposalStatus;
  decidedBy: string;
  decisionNote?: string | null;
  receipt?: MetaAutomationProposalReceipt | null;
  /** Present only for a settle that follows a claim. */
  claimToken?: string | null;
}): Promise<MetaAutomationProposal | null> {
  if (!(await proposalsReady())) return null;
  const claimToken = input.claimToken?.trim() || null;
  const guard = claimToken
    ? `AND status = 'claimed' AND claim_token = $7::uuid`
    : `AND status = 'pending'`;
  const params: unknown[] = [
    input.businessId,
    input.proposalId,
    input.status,
    input.decidedBy,
    input.decisionNote?.trim() || null,
    input.receipt ? JSON.stringify(input.receipt) : null,
  ];
  if (claimToken) params.push(claimToken);

  const run = (columns: string) =>
    getDb().query<ProposalDbRow>(
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
        ${guard}
      RETURNING ${columns}
    `,
      params,
    ) as Promise<ProposalDbRow[]>;

  // A claimed settle cannot degrade: the guard itself names a claim column, so
  // an unmigrated database has no claim to settle and must return null rather
  // than fall back to an unguarded update.
  const rows = claimToken
    ? await run(PROPOSAL_COLUMNS).catch((error: unknown) => {
        if (isUndefinedColumnError(error)) return [] as ProposalDbRow[];
        throw error;
      })
    : await withClaimColumnFallback(
        () => run(PROPOSAL_COLUMNS),
        () => run(PROPOSAL_BASE_COLUMNS),
      );
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
   * The entity's open slot was already held — by this firing's own earlier
   * run, by another rule, or by the engine's projection. The firing still
   * happened and is still counted; it points at the row that represents it.
   */
  | { status: "already_queued"; proposalId: string | null }
  /**
   * The slot is held by a row whose provider outcome is UNKNOWN.
   *
   * Reported separately from `already_queued` because it is not the same fact:
   * there is no approvable queue row for this firing, and there will not be one
   * until a human reconciles the previous attempt against a fresh provider
   * read. Calling this "queued" would tell the operator a confirmation is
   * waiting for them when what is actually waiting is a reconciliation.
   */
  | { status: "held_for_reconciliation"; proposalId: string | null }
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
  const held = (await getDb().query<{ id: string; status: string }>(
    `
      SELECT id, status
      FROM meta_automation_proposals
      WHERE business_id = $1::uuid
        AND (
          dedupe_key = $2
          OR (
            provider_account_id = $3
            AND decision_key = $4
            AND proposed_action = $5
            -- Claimed holds the slot exactly as pending does; a firing that
            -- arrives while the entity's pause is being dispatched joins that
            -- row rather than reporting a queue row that does not exist.
            -- Reconcile holds it too, and harder: that row's provider outcome
            -- is unknown, so a firing arriving behind it has no queue row to
            -- join and must not be told one exists.
            AND status IN (${META_AUTOMATION_PROPOSAL_OPEN_STATUS_SQL})
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
  )) as Array<{ id: string; status: string }>;

  if (held[0]?.status === "reconcile") {
    return { status: "held_for_reconciliation", proposalId: held[0].id };
  }
  return { status: "already_queued", proposalId: held[0]?.id ?? null };
}

/**
 * The queue's response contract version.
 *
 * It lives here rather than in the route because a Next.js route module may
 * only export the framework's own fields -- `GET`, `POST`, `dynamic` and the
 * rest. Exporting anything else fails `next build` with "is not a valid Route
 * export field", and `tsc --noEmit` does not see it, so the build is the only
 * gate that catches it.
 */
export const META_AUTOMATION_PROPOSALS_CONTRACT = "meta-automation-proposals.v1";
