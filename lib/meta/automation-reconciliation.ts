/**
 * The durable record of an Automation attempt whose provider outcome is unknown.
 *
 * WHY THIS EXISTS. The approve boundary has exactly one irreversible step — it
 * enters the guarded entity-action handler — and two ways to lose the answer
 * afterwards:
 *
 *   1. the handler itself never answers (an exception, a timeout);
 *   2. it answers, and the write that was supposed to RECORD the answer throws.
 *
 * Before this module the second case fell into the route's generic 500. The
 * provider had been reached, the receipt existed in memory, and the response
 * said `proposal_action_failed` — a phrase an operator reasonably reads as
 * "nothing happened". Meanwhile the queue row was left `claimed`, the ledger was
 * never attempted, and the only durable trace of a possible pause at Meta was a
 * `dispatch_started_at` timestamp with no receipt attached to it.
 *
 * So there is a second, deliberately tiny table. It is written with ONE INSERT
 * of already-serialized values, with no dependency on the proposal row's own
 * update succeeding, because it exists precisely for the moment that update
 * did not. It is append-only: an attempt's facts are what they were, and a
 * later reconciliation adds a resolution beside them rather than rewriting them.
 *
 * WHAT THIS MODULE MAY NOT DO, and does not import the means to do:
 *
 * - It never calls a provider. Not to verify, not to retry, not "just a GET".
 *   The fresh read is performed by the caller and handed in as evidence, so the
 *   only code that can talk to Meta stays the code that is guarded for it.
 * - It never retries a create/duplicate/pause POST. The binding invariant is
 *   that provider create/duplicate POSTs must not retry without provider
 *   idempotency bound to durable per-attempt receipts; this path has no
 *   provider idempotency key, so it has no retry at all.
 * - It never releases a held slot on a guess. An inconclusive read leaves the
 *   proposal in `reconcile` and the receipt open. "I could not tell" is not
 *   "nothing happened".
 */
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";

import type {
  MetaAutomationProposalReceipt,
  MetaAutomationProviderDispatchFacts,
} from "@/lib/meta/automation-proposals";

const RECONCILIATION_TABLES = ["meta_automation_reconciliation_receipts"] as const;

/**
 * Why an attempt ended up here. A closed vocabulary, mirrored by the column's
 * CHECK constraint, so a new reason cannot be invented at a call site.
 */
export const META_AUTOMATION_RECONCILIATION_REASONS = [
  /** The provider handler was entered and threw / never answered. */
  "dispatch_no_answer",
  /** The provider answered; the settle that had to record it threw. */
  "settle_failed_after_dispatch",
  /** A claim outlived its lease with `dispatch_started_at` already stamped. */
  "claim_lease_expired_after_dispatch",
] as const;
export type MetaAutomationReconciliationReason =
  (typeof META_AUTOMATION_RECONCILIATION_REASONS)[number];

/**
 * How a reconciliation ended. Both values are CONCLUSIONS FROM A FRESH READ,
 * never inferences from the attempt itself.
 */
export const META_AUTOMATION_RECONCILIATION_RESOLUTIONS = [
  /** The fresh read shows the intended state; the write landed. */
  "provider_write_confirmed",
  /** The fresh read shows the entity untouched; the write did not land. */
  "provider_write_absent",
] as const;
export type MetaAutomationReconciliationResolution =
  (typeof META_AUTOMATION_RECONCILIATION_RESOLUTIONS)[number];

export interface MetaAutomationReconciliationRecord {
  id: string;
  businessId: string;
  proposalId: string | null;
  providerAccountId: string | null;
  decisionKey: string | null;
  proposedAction: string | null;
  claimToken: string;
  reason: MetaAutomationReconciliationReason;
  providerDispatchStarted: boolean;
  providerOutcomeKnown: boolean;
  providerWriteVerified: boolean;
  receipt: MetaAutomationProposalReceipt | null;
  createdAt: string;
  resolution: MetaAutomationReconciliationResolution | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionEvidence: Record<string, unknown> | null;
}

export type AppendReconciliationReceiptResult =
  /** This attempt's receipt is now durable. */
  | { status: "recorded"; id: string }
  /**
   * A receipt for this exact claim token already exists. Append-only means the
   * first one wins; a second attempt to write it is a repeat, not a conflict.
   */
  | { status: "already_recorded"; id: string | null }
  /** Nothing durable was written. The caller must say so out loud. */
  | { status: "unavailable" };

async function reconciliationReady() {
  const readiness = await getDbSchemaReadiness({
    tables: [...RECONCILIATION_TABLES],
  }).catch(() => null);
  return Boolean(readiness?.ready);
}

interface ReconciliationDbRow {
  id: string;
  business_id: string;
  proposal_id: string | null;
  provider_account_id: string | null;
  decision_key: string | null;
  proposed_action: string | null;
  claim_token: string;
  reason: string;
  provider_dispatch_started: boolean;
  provider_outcome_known: boolean;
  provider_write_verified: boolean;
  receipt_json: unknown;
  created_at: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_evidence_json: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mapRow(row: ReconciliationDbRow): MetaAutomationReconciliationRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    proposalId: row.proposal_id,
    providerAccountId: row.provider_account_id,
    decisionKey: row.decision_key,
    proposedAction: row.proposed_action,
    claimToken: row.claim_token,
    reason: row.reason as MetaAutomationReconciliationReason,
    providerDispatchStarted: row.provider_dispatch_started,
    providerOutcomeKnown: row.provider_outcome_known,
    providerWriteVerified: row.provider_write_verified,
    receipt: isRecord(row.receipt_json)
      ? (row.receipt_json as unknown as MetaAutomationProposalReceipt)
      : null,
    createdAt: new Date(row.created_at).toISOString(),
    resolution: row.resolution as MetaAutomationReconciliationResolution | null,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    resolutionEvidence: isRecord(row.resolution_evidence_json)
      ? row.resolution_evidence_json
      : null,
  };
}

const RECONCILIATION_COLUMNS = `
  id::text AS id, business_id::text AS business_id,
  proposal_id::text AS proposal_id, provider_account_id, decision_key,
  proposed_action, claim_token::text AS claim_token, reason,
  provider_dispatch_started, provider_outcome_known, provider_write_verified,
  receipt_json, created_at, resolution, resolved_by::text AS resolved_by,
  resolved_at, resolution_evidence_json
`;

/**
 * Append one attempt's facts, keyed by its claim token.
 *
 * `ON CONFLICT (claim_token) DO NOTHING` rather than an upsert, and that is the
 * immutability rule in one clause: the first write of an attempt's facts is the
 * record of that attempt. A second call with different values must not be able
 * to rewrite history — the database also refuses it from below, via the
 * append-only trigger the migration installs.
 *
 * Every failure mode returns `unavailable` instead of throwing, because the one
 * caller is already on a failure path and a throw here would replace an honest
 * "reconciliation required" with a generic 500 — the exact defect this closes.
 */
export async function appendMetaAutomationReconciliationReceipt(input: {
  businessId: string;
  proposalId: string | null;
  providerAccountId: string | null;
  decisionKey: string | null;
  proposedAction: string | null;
  claimToken: string;
  reason: MetaAutomationReconciliationReason;
  facts: MetaAutomationProviderDispatchFacts;
  receipt: MetaAutomationProposalReceipt | null;
}): Promise<AppendReconciliationReceiptResult> {
  const claimToken = input.claimToken.trim();
  if (!claimToken) return { status: "unavailable" };
  try {
    const inserted = (await getDb().query<{ id: string }>(
      `
        INSERT INTO meta_automation_reconciliation_receipts (
          business_id, proposal_id, provider_account_id, decision_key,
          proposed_action, claim_token, reason, provider_dispatch_started,
          provider_outcome_known, provider_write_verified, receipt_json
        ) VALUES (
          $1::uuid, $2::uuid, $3, $4,
          $5, $6::uuid, $7, $8,
          $9, $10, $11::jsonb
        )
        ON CONFLICT (claim_token) DO NOTHING
        RETURNING id::text AS id
      `,
      [
        input.businessId,
        input.proposalId,
        input.providerAccountId,
        input.decisionKey,
        input.proposedAction,
        claimToken,
        input.reason,
        input.facts.providerDispatchStarted,
        input.facts.providerOutcomeKnown,
        input.facts.providerWriteVerified,
        JSON.stringify(input.receipt ?? null),
      ],
    )) as Array<{ id: string }>;

    if (inserted[0]) return { status: "recorded", id: inserted[0].id };

    const existing = (await getDb().query<{ id: string }>(
      `SELECT id::text AS id FROM meta_automation_reconciliation_receipts
       WHERE claim_token = $1::uuid`,
      [claimToken],
    )) as Array<{ id: string }>;
    return { status: "already_recorded", id: existing[0]?.id ?? null };
  } catch {
    return { status: "unavailable" };
  }
}

/** Read one attempt's reconciliation record by its claim token. */
export async function readMetaAutomationReconciliationReceipt(input: {
  businessId: string;
  claimToken: string;
}): Promise<MetaAutomationReconciliationRecord | null> {
  if (!(await reconciliationReady())) return null;
  const rows = (await getDb().query<ReconciliationDbRow>(
    `SELECT ${RECONCILIATION_COLUMNS}
     FROM meta_automation_reconciliation_receipts
     WHERE business_id = $1::uuid AND claim_token = $2::uuid
     LIMIT 1`,
    [input.businessId, input.claimToken],
  )) as ReconciliationDbRow[];
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Every unresolved reconciliation an account is still holding a slot for. */
export async function listOpenMetaAutomationReconciliations(input: {
  businessId: string;
  providerAccountId?: string | null;
}): Promise<MetaAutomationReconciliationRecord[] | null> {
  if (!(await reconciliationReady())) return null;
  try {
    const rows = (await getDb().query<ReconciliationDbRow>(
      `SELECT ${RECONCILIATION_COLUMNS}
       FROM meta_automation_reconciliation_receipts
       WHERE business_id = $1::uuid
         AND resolution IS NULL
         AND ($2::text IS NULL OR provider_account_id = $2::text)
       ORDER BY created_at ASC`,
      [input.businessId, input.providerAccountId ?? null],
    )) as ReconciliationDbRow[];
    return rows.map(mapRow);
  } catch {
    // Unknown, not empty. An empty list here would say "nothing to reconcile".
    return null;
  }
}

/**
 * How fresh a provider read has to be to release a held slot.
 *
 * A reconciliation is a statement about the entity's state NOW. A read taken an
 * hour ago cannot make it, and a read taken before the dispatch cannot make it
 * at all — that one describes the world the attempt was trying to change.
 */
export const META_AUTOMATION_RECONCILIATION_READ_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The evidence a caller must bring. There is no variant that means "I assume".
 *
 * `observedAt` is when the PROVIDER was read, not when this function was called,
 * and `entityStatus` is the provider's own verbatim status string.
 */
export type MetaAutomationReconciliationRead =
  | {
      status: "observed";
      observedAt: string;
      /** The provider's own status string for the entity, verbatim. */
      entityStatus: string;
      /** Anything else the read returned, stored beside the verdict. */
      evidence?: Record<string, unknown>;
    }
  | {
      status: "inconclusive";
      observedAt?: string | null;
      reason: string;
      evidence?: Record<string, unknown>;
    };

export type ResolveMetaAutomationReconciliationResult =
  | {
      status: "resolved";
      resolution: MetaAutomationReconciliationResolution;
      proposalStatus: "approved" | "failed";
    }
  /** The slot stays held. `code` says why, and nothing was changed. */
  | {
      status: "held";
      code:
        | "read_inconclusive"
        | "read_stale"
        | "read_precedes_dispatch"
        | "no_open_reconciliation"
        | "proposal_not_in_reconcile"
        | "receipt_missing"
        | "recording_failed"
        | "unavailable";
    };

function ageMs(observedAt: string, now: Date): number | null {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return null;
  return now.getTime() - observed;
}

/**
 * Release a `reconcile` row — and ONLY against a fresh provider read.
 *
 * The gates, each of which leaves the slot held rather than guessing:
 *
 * 1. The proposal must actually be in `reconcile` with this claim token. A row
 *    someone else already resolved is not re-resolvable from here.
 * 2. There must be an OPEN reconciliation receipt for that token. A resolution
 *    with nothing to attach itself to is not auditable, and the receipt is the
 *    immutable half of the record.
 * 3. The read must be conclusive. `inconclusive` is a first-class answer and it
 *    keeps the slot.
 * 4. The read must be fresh, and must not predate the dispatch it is judging.
 *
 * Only then is the resolution appended to the receipt (NULL -> value, once; the
 * database's append-only trigger refuses anything else) and the proposal moved
 * to `approved` or `failed`. If the receipt update lands and the proposal move
 * does not, the answer is `recording_failed` and the slot stays held: a written
 * resolution with an unmoved row is still an unresolved slot.
 *
 * There is NO provider call in this function and no retry of the original
 * write. Confirming that a pause landed is the end of the story; discovering it
 * did not is `failed`, and re-raising the decision belongs to the next
 * snapshot's projection, which is a fresh decision with fresh evidence.
 */
export async function resolveMetaAutomationProposalReconciliation(input: {
  businessId: string;
  proposalId: string;
  claimToken: string;
  resolvedBy: string;
  /** The provider status that proves the intended write landed, e.g. `PAUSED`. */
  expectedEntityStatus: string;
  read: MetaAutomationReconciliationRead;
  now?: Date;
}): Promise<ResolveMetaAutomationReconciliationResult> {
  if (!(await reconciliationReady())) return { status: "held", code: "unavailable" };
  const now = input.now ?? new Date();

  let proposal: Array<{ dispatch_started_at: string | null }>;
  try {
    proposal = (await getDb().query<{ dispatch_started_at: string | null }>(
      `SELECT dispatch_started_at
       FROM meta_automation_proposals
       WHERE business_id = $1::uuid
         AND id = $2::uuid
         AND status = 'reconcile'
         AND claim_token = $3::uuid
       LIMIT 1`,
      [input.businessId, input.proposalId, input.claimToken],
    )) as Array<{ dispatch_started_at: string | null }>;
  } catch {
    return { status: "held", code: "unavailable" };
  }
  if (!proposal[0]) return { status: "held", code: "proposal_not_in_reconcile" };

  const receipt = await readMetaAutomationReconciliationReceipt({
    businessId: input.businessId,
    claimToken: input.claimToken,
  }).catch(() => null);
  if (!receipt) return { status: "held", code: "receipt_missing" };
  if (receipt.resolution !== null) {
    return { status: "held", code: "no_open_reconciliation" };
  }

  if (input.read.status !== "observed") {
    return { status: "held", code: "read_inconclusive" };
  }

  const age = ageMs(input.read.observedAt, now);
  if (age === null || age > META_AUTOMATION_RECONCILIATION_READ_MAX_AGE_MS || age < 0) {
    return { status: "held", code: "read_stale" };
  }
  const dispatchedAt = proposal[0].dispatch_started_at;
  if (dispatchedAt) {
    const dispatched = Date.parse(dispatchedAt);
    const observed = Date.parse(input.read.observedAt);
    if (!Number.isFinite(dispatched) || observed < dispatched) {
      return { status: "held", code: "read_precedes_dispatch" };
    }
  }

  const landed =
    input.read.entityStatus.trim().toUpperCase() ===
    input.expectedEntityStatus.trim().toUpperCase();
  const resolution: MetaAutomationReconciliationResolution = landed
    ? "provider_write_confirmed"
    : "provider_write_absent";

  try {
    const updated = (await getDb().query<{ id: string }>(
      `UPDATE meta_automation_reconciliation_receipts
       SET resolution = $3,
           resolved_by = $4::uuid,
           resolved_at = NOW(),
           resolution_evidence_json = $5::jsonb
       WHERE business_id = $1::uuid
         AND claim_token = $2::uuid
         AND resolution IS NULL
       RETURNING id::text AS id`,
      [
        input.businessId,
        input.claimToken,
        resolution,
        input.resolvedBy,
        JSON.stringify({
          observedAt: input.read.observedAt,
          entityStatus: input.read.entityStatus,
          expectedEntityStatus: input.expectedEntityStatus,
          evidence: input.read.evidence ?? {},
        }),
      ],
    )) as Array<{ id: string }>;
    if (!updated[0]) return { status: "held", code: "no_open_reconciliation" };
  } catch {
    return { status: "held", code: "recording_failed" };
  }

  const proposalStatus = landed ? "approved" : "failed";
  try {
    const moved = (await getDb().query<{ id: string }>(
      `UPDATE meta_automation_proposals
       SET status = $4,
           decided_by = $5::uuid,
           decided_at = NOW(),
           updated_at = NOW()
       WHERE business_id = $1::uuid
         AND id = $2::uuid
         AND status = 'reconcile'
         AND claim_token = $3::uuid
       RETURNING id::text AS id`,
      [
        input.businessId,
        input.proposalId,
        input.claimToken,
        proposalStatus,
        input.resolvedBy,
      ],
    )) as Array<{ id: string }>;
    if (!moved[0]) return { status: "held", code: "recording_failed" };
  } catch {
    return { status: "held", code: "recording_failed" };
  }

  return { status: "resolved", resolution, proposalStatus };
}

export const META_AUTOMATION_RECONCILIATION_CONTRACT =
  "meta-automation-reconciliation.v1";
