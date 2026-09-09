/**
 * The queue producer for a typed bid intent.
 *
 * This is a forward-compatible path for a semantically explicit ad-set bid
 * decision. B1 is the only current vocabulary that names a currency cap move,
 * but its producer emits at campaign grain. The production query therefore
 * returns zero today; it must stay closed until a real ad-set producer supplies
 * both that operation meaning and the typed amount.
 *
 * It follows the budget producer's shape and its discipline: rows come only
 * A future row may come only from a persisted decision whose recommendation
 * type explicitly authorises the direction and whose `target_value` carries
 * exact minor units. Nothing here computes or infers an operation.
 */
import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";
import { resolveEffectiveMetaModes } from "@/lib/meta/automation-control-plane";
import {
  META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
  META_AUTOMATION_PROPOSAL_OPEN_STATUS_SQL,
  META_AUTOMATION_PROPOSAL_TTL_HOURS,
  META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES,
  metaEngineProjectionReofferablePredicate,
  metaEngineProjectionWithdrawalPredicate,
  proposalActionLabel,
} from "@/lib/meta/automation-proposals";
import {
  META_BID_INTENT_CONTRACT_VERSION,
  metaBidAmountDirectionForRecommendationType,
} from "@/lib/meta/bid-intent-contract";
import {
  bidEnvelopeForProposalRow,
  buildBidProposalEnvelope,
  parseBidProposalEnvelope,
} from "@/lib/meta/bid-proposal-envelope";

export const BID_PROPOSAL_PRODUCER_CONTRACT =
  "meta.bid-proposal-producer.v1" as const;

function isOpenSlotUniqueViolation(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && (error as { code?: unknown }).code === "23505"
      && (error as { constraint?: unknown }).constraint
        === "uq_meta_automation_proposals_open_slot",
  );
}

function exactMoneyLabel(input: {
  currency: string;
  currencyExponent: number;
  minorUnits: number;
}): string {
  const negative = input.minorUnits < 0;
  const digits = String(Math.abs(input.minorUnits))
    .padStart(input.currencyExponent + 1, "0");
  const whole = input.currencyExponent === 0
    ? digits
    : digits.slice(0, digits.length - input.currencyExponent);
  const fraction = input.currencyExponent === 0
    ? ""
    : `.${digits.slice(digits.length - input.currencyExponent)}`;
  return `${input.currency.toUpperCase()} ${negative ? "-" : ""}${whole}${fraction}`;
}

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
  /** Stable row identity when a pending/system-withdrawn projection is refreshed. */
  existingProposalId?: string | null;
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
         d.target_value ->> 'intentKey' AS intent_key,
         (
           SELECT existing.id::text
             FROM meta_automation_proposals existing
            WHERE existing.business_id = $1::uuid
              AND existing.provider_account_id = dim.provider_account_id
              AND existing.decision_key = 'adset:' || d.scope_id
              AND existing.rec_type = d.rec_type
              AND existing.snapshot_date = d.snapshot_date
              AND existing.origin = 'engine_decision'
              AND existing.proposed_action = 'bid'
              AND ${metaEngineProjectionReofferablePredicate("existing")}
            LIMIT 1
         ) AS existing_proposal_id
    FROM meta_decision_snapshots_daily d
    JOIN (
      SELECT business_id, adset_id AS scope_id, provider_account_id,
             adset_name_current AS entity_label, adset_status AS entity_status,
             campaign_id AS parent_campaign_id
        FROM meta_adset_dimensions
    ) dim
      ON dim.business_id = d.business_id
     AND dim.scope_id = d.scope_id
     AND dim.provider_account_id = d.provider_account_id
   WHERE d.business_id = $1::text
     AND d.snapshot_date = $2::date
     AND d.kind = 'recommendation'
     AND d.decision_state = 'act'
     AND dim.provider_account_id = ANY($4::text[])
     -- A valid amount cannot replace the recommendation's requested lever.
     -- B1 is the only current vocabulary that explicitly means a currency cap
     -- increase; its producer is campaign-grain, so no current ad-set row is a
     -- recommendation-derived bid candidate.
     AND d.rec_type = 'scenario_b1_capped_winner_bid_raise'
     AND d.target_value ->> 'direction' = 'increase'
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
          AND NOT (${metaEngineProjectionWithdrawalPredicate("decided")})
     )
     AND NOT EXISTS (
       SELECT 1 FROM meta_automation_proposals held
        WHERE held.business_id = $1::uuid
          AND held.provider_account_id = dim.provider_account_id
          AND held.decision_key = 'adset:' || d.scope_id
          AND held.proposed_action = 'bid'
          AND held.status IN (${META_AUTOMATION_PROPOSAL_OPEN_STATUS_SQL})
          AND NOT (
            held.status = 'pending'
            AND held.origin = 'engine_decision'
            AND held.rec_type = d.rec_type
            AND held.snapshot_date = d.snapshot_date
          )
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
  /** Accounts whose decision generation completed in this exact snapshot run. */
  providerAccountIds: readonly string[];
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
  const providerAccountIds = Array.from(new Set(
    deps.providerAccountIds.map((id) => id.trim()).filter(Boolean),
  ));
  if (providerAccountIds.length === 0) {
    return {
      contract: BID_PROPOSAL_PRODUCER_CONTRACT,
      ran: true,
      candidates: 0,
      projected: 0,
      refusals: { account_generation_not_fulfilled: 1 },
    };
  }
  const allowedProviderAccountIds = new Set(providerAccountIds);

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

  const loadedCandidates = deps.listCandidates
    ? await deps.listCandidates()
    : await listTypedBidCandidates(
        deps.businessId,
        deps.snapshotDate,
        providerAccountIds,
      );
  /* Injectable candidate readers must not bypass this run's account scope. */
  const candidates = loadedCandidates.filter((candidate) => {
    if (
      candidate.businessId !== deps.businessId
      || candidate.snapshotDate !== deps.snapshotDate
    ) {
      refuse("candidate_scope_mismatch");
      return false;
    }
    if (!allowedProviderAccountIds.has(candidate.providerAccountId)) return false;
    const expectedDirection =
      metaBidAmountDirectionForRecommendationType(candidate.recType);
    if (!expectedDirection || expectedDirection !== candidate.direction) {
      refuse("bid_action_semantic_missing");
      return false;
    }
    return true;
  });

  let projected = 0;
  for (const candidate of candidates) {
    /*
      The real row id, reserved before anything is fingerprinted.

      The envelope names the row it belongs to, so the id has to exist before
      the envelope does and be inserted verbatim — a database-generated id
      would leave every stored envelope naming a row that is not its own.
    */
    const proposalId = candidate.existingProposalId?.trim()
      || (deps.newProposalId ? deps.newProposalId() : randomUUID());
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
    let id: string | null;
    try {
      id = await deps.insertProposal({
        proposalId,
        candidate,
        envelopeJson: JSON.stringify(envelope),
        actionLabel: proposalActionLabel(BID_PROPOSAL_ACTION, "adset"),
      });
    } catch (error) {
      /* A rule or sibling projection can win the slot after candidate read. */
      if (!isOpenSlotUniqueViolation(error)) throw error;
      id = null;
    }
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
  providerAccountIds: readonly string[],
): Promise<TypedBidCandidate[]> {
  const rows = (await getDb().query(TYPED_BID_CANDIDATE_SQL, [
    businessId,
    snapshotDate,
    META_BID_INTENT_CONTRACT_VERSION,
    [...providerAccountIds],
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
    existingProposalId:
      typeof row.existing_proposal_id === "string"
        ? row.existing_proposal_id
        : null,
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
  let storedEnvelope: ReturnType<typeof parseBidProposalEnvelope>;
  try {
    storedEnvelope = parseBidProposalEnvelope(
      JSON.parse(input.envelopeJson) as unknown,
    );
  } catch {
    return null;
  }
  const validatedEnvelope = bidEnvelopeForProposalRow(storedEnvelope, {
    id: input.proposalId,
    businessId: input.businessId,
    providerAccountId: input.candidate.providerAccountId,
    scopeType: "adset",
    scopeId: input.candidate.scopeId,
    recId: input.candidate.recId,
    recType: input.candidate.recType,
    snapshotDate: input.candidate.snapshotDate,
    engineVersion: input.candidate.engineVersion,
  });
  if (!validatedEnvelope) return null;
  const percent = `${validatedEnvelope.direction === "increase" ? "+" : "-"}${validatedEnvelope.percent}%`;
  const evidenceLabel = `Bid: ${exactMoneyLabel({
    currency: validatedEnvelope.currency,
    currencyExponent: validatedEnvelope.currencyExponent,
    minorUnits: validatedEnvelope.currentMinorUnits,
  })} → ${exactMoneyLabel({
    currency: validatedEnvelope.currency,
    currencyExponent: validatedEnvelope.currencyExponent,
    minorUnits: validatedEnvelope.proposedMinorUnits,
  })} (${percent})`;

  try {
    const rows = (await getDb().query(
      `INSERT INTO meta_automation_proposals (
       id,
       business_id, provider_account_id, origin, decision_key, scope_type, scope_id,
       rec_id, rec_type, snapshot_date, engine_version, decision_label,
       proposed_action, action_label, primary_caption, entity_label, reason,
       evidence_ref, expires_at, status, bid_envelope_json, evidence_label
     ) SELECT
       $17::uuid,
       $1::uuid, $2, 'engine_decision', $3, 'adset', $4, $5, $6, $7::date, $8, $9,
       '${BID_PROPOSAL_ACTION}', $10, $11, NULLIF(BTRIM($12), ''), $13,
       $14::jsonb, NOW() + ($15 || ' hours')::interval, 'pending', $16::jsonb, $18
     WHERE NOT EXISTS (
       SELECT 1 FROM meta_automation_proposals held
        WHERE held.business_id = $1::uuid
          AND held.provider_account_id = $2
          AND held.decision_key = $3
          AND held.proposed_action = 'bid'
          AND held.status IN (${META_AUTOMATION_PROPOSAL_OPEN_STATUS_SQL})
          AND NOT (
            held.status = 'pending'
            AND held.origin = 'engine_decision'
            AND held.rec_type = $6
            AND held.snapshot_date = $7::date
          )
     )
     ON CONFLICT (business_id, provider_account_id, decision_key, rec_type, snapshot_date)
     DO UPDATE SET
       status = 'pending',
       rec_id = EXCLUDED.rec_id,
       engine_version = EXCLUDED.engine_version,
       decision_label = EXCLUDED.decision_label,
       proposed_action = EXCLUDED.proposed_action,
       action_label = EXCLUDED.action_label,
       primary_caption = EXCLUDED.primary_caption,
       entity_label = EXCLUDED.entity_label,
       reason = EXCLUDED.reason,
       evidence_ref = EXCLUDED.evidence_ref,
       evidence_label = EXCLUDED.evidence_label,
       expires_at = EXCLUDED.expires_at,
       bid_envelope_json = EXCLUDED.bid_envelope_json,
       decision_note = NULL,
       updated_at = NOW()
     WHERE meta_automation_proposals.origin = 'engine_decision'
       AND meta_automation_proposals.id = EXCLUDED.id
       AND meta_automation_proposals.scope_type = 'adset'
       AND meta_automation_proposals.proposed_action = 'bid'
       AND ${metaEngineProjectionReofferablePredicate(
         "meta_automation_proposals",
       )}
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
      evidenceLabel,
      ],
    )) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  } catch (error) {
    /* Two statements can both observe a free slot; the unique index arbitrates. */
    if (isOpenSlotUniqueViolation(error)) return null;
    throw error;
  }
}
