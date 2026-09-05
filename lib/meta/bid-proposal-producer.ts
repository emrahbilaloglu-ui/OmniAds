/**
 * The queue producer for a typed bid intent.
 *
 * `bid` has been an allowed `proposed_action` since the table was created and
 * nothing has ever raised one. The sizing policy and the intent contract were
 * both written and both tested; what did not exist was the step that turns a
 * persisted bid decision into a row an operator can approve and a scheduler can
 * execute. Unattended bid execution was excluded for exactly that reason — not
 * because a cap change is unsafe to automate, but because no row could prove an
 * amount.
 *
 * It follows the budget producer's shape and its discipline: rows come only
 * from a persisted decision whose `target_value` names the bid intent contract
 * and carries exact minor units. Nothing here computes an amount; the sizing
 * policy already did, in the snapshot, from evidence a card shows.
 */
import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";
import { resolveEffectiveMetaModes } from "@/lib/meta/automation-control-plane";
import {
  META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
  META_AUTOMATION_PROPOSAL_TTL_HOURS,
  META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES,
  proposalActionLabel,
} from "@/lib/meta/automation-proposals";
import { META_BID_INTENT_CONTRACT_VERSION } from "@/lib/meta/bid-intent-contract";
import { buildBidProposalEnvelope } from "@/lib/meta/bid-proposal-envelope";

export const BID_PROPOSAL_PRODUCER_CONTRACT =
  "meta.bid-proposal-producer.v1" as const;

export const BID_PROPOSAL_ACTION = "bid" as const;

export interface TypedBidCandidate {
  businessId: string;
  /** Only ever an ad set. A campaign has no bid amount to write. */
  scopeId: string;
  parentCampaignId: string | null;
  providerAccountId: string;
  recId: string;
  recType: string;
  snapshotDate: string;
  engineVersion: string;
  decisionLabel: string;
  decisionAt: string;
  bidStrategyType: string;
  direction: "increase" | "decrease";
  percent: number;
  currentMinorUnits: number;
  proposedMinorUnits: number;
  currency: string;
  currencyExponent: number;
  intentKey: string;
  reasoning: string;
  entityLabel: string | null;
  evidence: Record<string, unknown>;
}

/**
 * Candidates, from persisted decisions only.
 *
 * Every predicate here is about the payload, never about the prose. The
 * `authorityStatus` check matters most: the sizing policy writes a blocked
 * intent when it wants the CARD to explain why it withheld, and a blocked
 * intent must never become a queue row somebody can approve.
 */
export const TYPED_BID_CANDIDATE_SQL = `
  SELECT d.scope_id,
         dim.provider_account_id,
         dim.entity_label,
         dim.parent_campaign_id,
         d.rec_id,
         d.rec_type,
         d.snapshot_date::text AS snapshot_date,
         d.engine_version,
         d.decision_label,
         d.created_at,
         d.reasoning,
         d.evidence,
         d.target_value ->> 'bidStrategyType' AS bid_strategy_type,
         d.target_value ->> 'direction' AS direction,
         (d.target_value ->> 'percent')::int AS percent,
         (d.target_value ->> 'currentMinorUnits')::bigint AS current_minor_units,
         (d.target_value ->> 'proposedMinorUnits')::bigint AS proposed_minor_units,
         d.target_value ->> 'currency' AS currency,
         (d.target_value ->> 'currencyExponent')::int AS currency_exponent,
         d.target_value ->> 'intentKey' AS intent_key
    FROM meta_decision_snapshots_daily d
    JOIN (
      SELECT business_id, adset_id AS scope_id, provider_account_id,
             adset_name_current AS entity_label, adset_status AS entity_status,
             campaign_id AS parent_campaign_id
        FROM meta_adset_dimensions
    ) dim
      ON dim.business_id = d.business_id
     AND dim.scope_id = d.scope_id
   WHERE d.business_id = $1::text
     AND d.snapshot_date = $2::date
     AND d.kind = 'recommendation'
     -- A bid amount lives on an ad set; there is no campaign-grain bid write.
     AND d.scope_type = 'adset'
     AND jsonb_typeof(d.target_value) = 'object'
     AND d.target_value ->> 'contractVersion' = $3::text
     AND d.target_value ->> 'kind' = 'bid_intent'
     -- A withheld intent is a card explanation, never a queue row.
     AND d.target_value ->> 'authorityStatus' = 'authorised'
     AND jsonb_array_length(COALESCE(d.target_value -> 'blockerCodes', '[]'::jsonb)) = 0
     AND d.target_value ->> 'direction' IN ('increase', 'decrease')
     AND (d.target_value ->> 'percent') ~ '^[0-9]+$'
     AND (d.target_value ->> 'currentMinorUnits') ~ '^[0-9]+$'
     AND (d.target_value ->> 'proposedMinorUnits') ~ '^[0-9]+$'
     AND (d.target_value ->> 'proposedMinorUnits')::bigint > 0
     AND NULLIF(BTRIM(d.target_value ->> 'bidStrategyType'), '') IS NOT NULL
     AND NULLIF(BTRIM(d.target_value ->> 'intentKey'), '') IS NOT NULL
     AND COALESCE(UPPER(dim.entity_status), '') <> 'PAUSED'
     AND NULLIF(BTRIM(d.reasoning), '') IS NOT NULL
     -- The SAME open-slot predicate every other producer on this queue uses.
     AND NOT EXISTS (
       SELECT 1 FROM meta_automation_proposals decided
        WHERE decided.business_id = $1::uuid
          AND decided.provider_account_id = dim.provider_account_id
          AND decided.decision_key = 'adset:' || d.scope_id
          AND decided.snapshot_date = d.snapshot_date
          AND decided.status NOT IN (${META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES.map((s) => `'${s}'`).join(", ")})
     )
   ORDER BY d.scope_id, d.rec_type
` as const;

export interface BidProposalProducerResult {
  contract: typeof BID_PROPOSAL_PRODUCER_CONTRACT;
  ran: boolean;
  candidates: number;
  projected: number;
  refusals: Record<string, number>;
}

export interface BidProposalProducerDeps {
  businessId: string;
  snapshotDate: string;
  insertProposal(input: {
    proposalId: string;
    candidate: TypedBidCandidate;
    envelopeJson: string;
    actionLabel: string;
  }): Promise<string | null>;
  listCandidates?(): Promise<TypedBidCandidate[]>;
  /**
   * The standing bid mode. Manual means the operator applies from the card, so
   * a queue row would be a second inbox nobody asked for — the same judgement
   * the budget and pause projections make about their own families.
   */
  readBidMode?(): Promise<"manual" | "semi_auto" | "auto">;
  newProposalId?(): string;
}

export async function projectMetaBidProposals(
  deps: BidProposalProducerDeps,
): Promise<BidProposalProducerResult> {
  const refusals: Record<string, number> = {};
  const refuse = (code: string) => { refusals[code] = (refusals[code] ?? 0) + 1; };

  const mode = await (deps.readBidMode
    ?? (async () => (await resolveEffectiveMetaModes(deps.businessId)).bid))();
  if (mode === "manual") {
    return {
      contract: BID_PROPOSAL_PRODUCER_CONTRACT,
      ran: true,
      candidates: 0,
      projected: 0,
      refusals: { bid_mode_manual: 1 },
    };
  }

  const candidates = deps.listCandidates
    ? await deps.listCandidates()
    : await listTypedBidCandidates(deps.businessId, deps.snapshotDate);

  let projected = 0;
  for (const candidate of candidates) {
    /*
      The real row id, reserved before anything is fingerprinted.

      The envelope names the row it belongs to, so the id has to exist before
      the envelope does and be inserted verbatim — a database-generated id
      would leave every stored envelope naming a row that is not its own.
    */
    const proposalId = deps.newProposalId ? deps.newProposalId() : randomUUID();
    /*
      The arithmetic, re-checked here rather than trusted.

      The percent and the two amounts come from one payload, but they are three
      numbers and only a check makes them one instruction. A row whose amounts
      disagree with its own percent would be a bid change of ambiguous size.
    */
    const expected = Math.round(
      candidate.currentMinorUnits
      * (1 + (candidate.direction === "increase" ? 1 : -1) * candidate.percent / 100),
    );
    if (expected !== candidate.proposedMinorUnits) {
      refuse("percent_math_inconsistent");
      continue;
    }
    if (candidate.currentMinorUnits <= 0) { refuse("current_value_missing"); continue; }

    const envelope = buildBidProposalEnvelope({
      proposalId,
      businessId: candidate.businessId,
      providerAccountId: candidate.providerAccountId,
      entityId: candidate.scopeId,
      parentCampaignId: candidate.parentCampaignId,
      bidStrategyType: candidate.bidStrategyType,
      direction: candidate.direction,
      percent: candidate.percent,
      currentMinorUnits: candidate.currentMinorUnits,
      proposedMinorUnits: candidate.proposedMinorUnits,
      currency: candidate.currency,
      currencyExponent: candidate.currencyExponent,
      intentKey: candidate.intentKey,
      recId: candidate.recId,
      recType: candidate.recType,
      snapshotDate: candidate.snapshotDate,
      engineVersion: candidate.engineVersion,
      decisionAt: candidate.decisionAt,
    });
    const id = await deps.insertProposal({
      proposalId,
      candidate,
      envelopeJson: JSON.stringify(envelope),
      actionLabel: proposalActionLabel(BID_PROPOSAL_ACTION, "adset"),
    });
    if (id) projected += 1; else refuse("insert_conflicted");
  }

  return {
    contract: BID_PROPOSAL_PRODUCER_CONTRACT,
    ran: true,
    candidates: candidates.length,
    projected,
    refusals,
  };
}

export async function listTypedBidCandidates(
  businessId: string,
  snapshotDate: string,
): Promise<TypedBidCandidate[]> {
  const rows = (await getDb().query(TYPED_BID_CANDIDATE_SQL, [
    businessId, snapshotDate, META_BID_INTENT_CONTRACT_VERSION,
  ])) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    businessId,
    scopeId: String(row.scope_id),
    parentCampaignId: typeof row.parent_campaign_id === "string"
      ? row.parent_campaign_id : null,
    providerAccountId: String(row.provider_account_id),
    recId: String(row.rec_id),
    recType: String(row.rec_type),
    snapshotDate: String(row.snapshot_date).slice(0, 10),
    engineVersion: String(row.engine_version),
    decisionLabel: String(row.decision_label ?? ""),
    decisionAt: new Date(String(row.created_at)).toISOString(),
    bidStrategyType: String(row.bid_strategy_type),
    direction: String(row.direction) as "increase" | "decrease",
    percent: Number(row.percent),
    currentMinorUnits: Number(row.current_minor_units),
    proposedMinorUnits: Number(row.proposed_minor_units),
    currency: String(row.currency),
    currencyExponent: Number(row.currency_exponent),
    intentKey: String(row.intent_key),
    reasoning: String(row.reasoning),
    entityLabel: typeof row.entity_label === "string" ? row.entity_label : null,
    evidence: (row.evidence ?? {}) as Record<string, unknown>,
  }));
}

/** The default insert. The SAME table, TTL, dedupe key and status as the rest. */
export async function insertBidProposalRow(input: {
  businessId: string;
  proposalId: string;
  candidate: TypedBidCandidate;
  envelopeJson: string;
  actionLabel: string;
}): Promise<string | null> {
  const rows = (await getDb().query(
    `INSERT INTO meta_automation_proposals (
       id,
       business_id, provider_account_id, origin, decision_key, scope_type, scope_id,
       rec_id, rec_type, snapshot_date, engine_version, decision_label,
       proposed_action, action_label, primary_caption, entity_label, reason,
       evidence_ref, expires_at, status, bid_envelope_json
     ) VALUES (
       $17::uuid,
       $1::uuid, $2, 'engine_decision', $3, 'adset', $4, $5, $6, $7::date, $8, $9,
       '${BID_PROPOSAL_ACTION}', $10, $11, NULLIF(BTRIM($12), ''), $13,
       $14::jsonb, NOW() + ($15 || ' hours')::interval, 'pending', $16::jsonb
     )
     ON CONFLICT (business_id, provider_account_id, decision_key, rec_type, snapshot_date)
     DO NOTHING
     RETURNING id::text AS id`,
    [
      input.businessId,
      input.candidate.providerAccountId,
      `adset:${input.candidate.scopeId}`,
      input.candidate.scopeId,
      input.candidate.recId,
      input.candidate.recType,
      input.candidate.snapshotDate,
      input.candidate.engineVersion,
      input.candidate.decisionLabel,
      input.actionLabel,
      META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
      input.candidate.entityLabel ?? "",
      input.candidate.reasoning,
      JSON.stringify({
        recId: input.candidate.recId,
        recType: input.candidate.recType,
        snapshotDate: input.candidate.snapshotDate,
        engineVersion: input.candidate.engineVersion,
        decisionKey: `adset:${input.candidate.scopeId}`,
        intentKey: input.candidate.intentKey,
        evidence: input.candidate.evidence,
      }),
      String(META_AUTOMATION_PROPOSAL_TTL_HOURS),
      input.envelopeJson,
      input.proposalId,
    ],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}
