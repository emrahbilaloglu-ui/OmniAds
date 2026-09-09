/**
 * D088 C1 — the canonical budget proposal producer.
 *
 * It raises rows on the EXISTING queue: same table, same TTL, same dedupe key,
 * same open-slot predicate, same claim lifecycle. What differs is what it is
 * allowed to raise from.
 *
 * A budget proposal may originate only from a persisted recommendation whose
 * `recommended_action` is literally `increase_budget` or `decrease_budget` and
 * whose `target_value` carries an exact minor-unit amount. A generic `scale` or
 * `cut` label is not a budget intent: it does not say by how much, or even that
 * money is the lever. Campaign names, Test/Main/Mixed and manual labels are not
 * consulted at all.
 *
 * Each candidate is then composed through D083 → D085 → D087. Only a candidate
 * whose D085 verdict is `would_write_available` becomes a row, and the row
 * carries the server-built envelope the executor re-checks.
 */
import {
  META_BUDGET_INTENT_CONTRACT_VERSION,
  META_BUDGET_INTENT_RECOMMENDATION_TYPES,
  budgetIntentSemanticTupleSqlPredicate,
  isBudgetIntentSemanticTuple,
  type BudgetDirection,
} from "@/lib/meta/budget-intent-contract";
import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";
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
  BUDGET_PROPOSAL_ACTION,
  buildBudgetProposalEnvelope,
  canonicalDecisionHash,
  envelopeForProposalRow,
  parseBudgetProposalEnvelope,
} from "@/lib/meta/budget-proposal-runtime";
import {
  composeBudgetExecutionCandidate,
  type BudgetCompositionSources,
} from "@/lib/meta/budget-execution-composition";

export const BUDGET_PROPOSAL_PRODUCER_CONTRACT =
  "meta.budget-proposal-producer.v1" as const;

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

/**
 * The two directions a budget intent can carry.
 *
 * Read from the typed payload's own `direction`, not from `recommended_action`:
 * that column holds a sentence written for an operator, and requiring it to
 * equal a literal is why no candidate ever matched.
 */
export const TYPED_BUDGET_RECOMMENDATIONS = [
  "increase_budget",
  "decrease_budget",
] as const;

/** Direction as stored in the intent, mapped to this module's own vocabulary. */
function typedRecommendationForDirection(
  direction: string,
): (typeof TYPED_BUDGET_RECOMMENDATIONS)[number] {
  return direction === "decrease" ? "decrease_budget" : "increase_budget";
}

function directionForTypedRecommendation(
  recommendation: unknown,
): BudgetDirection | null {
  if (recommendation === "increase_budget") return "increase";
  if (recommendation === "decrease_budget") return "decrease";
  return null;
}

export interface TypedBudgetCandidate {
  /** Carried so a loader never has to be told the scope twice. */
  businessId: string;
  scopeType: "campaign" | "adset";
  scopeId: string;
  /**
   * D088 C3: the ad set's parent campaign, selected with the candidate.
   *
   * Role authority is a CAMPAIGN fact, so an ad-set candidate that does not
   * know its parent cannot be role-authorised at all — and C2 passed the ad-set
   * id into the campaign role read, which could only ever miss.
   */
  parentCampaignId: string | null;
  /** The persisted decision's OWN timestamp. */
  decisionAt: string;
  /** The canonical hash of that decision tuple. */
  decisionHash: string;
  providerAccountId: string;
  recId: string;
  recType: string;
  snapshotDate: string;
  engineVersion: string;
  decisionLabel: string;
  recommendedAction: (typeof TYPED_BUDGET_RECOMMENDATIONS)[number];
  /** The EXACT target, in minor units, from the persisted decision. */
  targetAmountMinor: number;
  reasoning: string;
  entityLabel: string | null;
  evidence: Record<string, unknown>;
  /** Stable row identity when a pending/system-withdrawn projection is refreshed. */
  existingProposalId?: string | null;
}

/**
 * Candidates, from persisted decisions only.
 *
 * The `target_value` JSON must carry an exact integer minor-unit amount. A
 * decision that names a direction without a number is not a budget intent and
 * is not selected — inventing the number is precisely what this producer exists
 * not to do.
 */
export const TYPED_BUDGET_CANDIDATE_SQL = `
  SELECT d.scope_type,
         d.scope_id,
         dim.provider_account_id,
         d.rec_id,
         d.rec_type,
         d.snapshot_date::text AS snapshot_date,
         d.engine_version,
         d.decision_label,
         d.recommended_action,
         d.target_value ->> 'direction' AS target_direction,
         (d.target_value ->> 'amountMinor')::bigint AS target_amount_minor,
         d.reasoning,
         dim.entity_label,
         dim.parent_campaign_id,
         d.created_at,
         d.evidence,
         (
           SELECT existing.id::text
             FROM meta_automation_proposals existing
            WHERE existing.business_id = $1::uuid
              AND existing.provider_account_id = dim.provider_account_id
              AND existing.decision_key = d.scope_type || ':' || d.scope_id
              AND existing.rec_type = d.rec_type
              AND existing.snapshot_date = d.snapshot_date
              AND existing.origin = 'engine_decision'
              AND existing.proposed_action = 'budget'
              AND ${metaEngineProjectionReofferablePredicate("existing")}
            LIMIT 1
         ) AS existing_proposal_id
    FROM meta_decision_snapshots_daily d
    JOIN (
      SELECT 'campaign'::text AS scope_type, business_id, campaign_id AS scope_id,
             provider_account_id, campaign_name_current AS entity_label,
             campaign_status AS entity_status,
             NULL::text AS parent_campaign_id
        FROM meta_campaign_dimensions
      UNION ALL
      SELECT 'adset'::text AS scope_type, business_id, adset_id AS scope_id,
             provider_account_id, adset_name_current AS entity_label,
             adset_status AS entity_status,
             campaign_id AS parent_campaign_id
        FROM meta_adset_dimensions
    ) dim
      ON dim.business_id = d.business_id
     AND dim.scope_type = d.scope_type
     AND dim.scope_id = d.scope_id
     AND dim.provider_account_id = d.provider_account_id
   WHERE d.business_id = $1::text
     AND d.snapshot_date = $2::date
     AND d.kind = 'recommendation'
     AND d.decision_state = 'act'
     AND dim.provider_account_id = ANY($4::text[])
     AND ${budgetIntentSemanticTupleSqlPredicate({
       recommendationTypeExpression: "d.rec_type",
       grainExpression: "d.scope_type",
       directionExpression: "d.target_value ->> 'direction'",
     })}
     /*
       The typed intent's own contract, not a verb in prose.

       This used to require recommended_action to be one of two exact
       literals, while every producer in the engine writes an English sentence
       there ("Increase budget by 10-15% and monitor CPA / ROAS..."). The
       predicate could not match, ever, so the whole budget path was inert.
       A payload that names its contract is the thing that cannot be typed by
       accident; the sentence stays where it is, for the operator to read.
     */
     AND d.target_value ->> 'contractVersion' = $3::text
     AND jsonb_typeof(d.target_value) = 'object'
     AND (d.target_value ->> 'amountMinor') ~ '^[0-9]+$'
     AND (d.target_value ->> 'amountMinor')::bigint > 0
     AND COALESCE(UPPER(dim.entity_status), '') <> 'PAUSED'
     AND NULLIF(BTRIM(d.reasoning), '') IS NOT NULL
     -- An ad-set candidate without its parent cannot be role-authorised.
     AND (d.scope_type = 'campaign' OR dim.parent_campaign_id IS NOT NULL)
     -- The SAME open-slot predicate the pause producer uses.
     AND NOT EXISTS (
       SELECT 1 FROM meta_automation_proposals decided
        WHERE decided.business_id = $1::uuid
          AND decided.provider_account_id = dim.provider_account_id
          AND decided.decision_key = d.scope_type || ':' || d.scope_id
          AND decided.snapshot_date = d.snapshot_date
          AND decided.status NOT IN (${META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES.map((s) => `'${s}'`).join(', ')})
          AND NOT (${metaEngineProjectionWithdrawalPredicate("decided")})
     )
     AND NOT EXISTS (
       SELECT 1 FROM meta_automation_proposals held
        WHERE held.business_id = $1::uuid
          AND held.provider_account_id = dim.provider_account_id
          AND held.decision_key = d.scope_type || ':' || d.scope_id
          AND held.proposed_action = 'budget'
          AND held.status IN (${META_AUTOMATION_PROPOSAL_OPEN_STATUS_SQL})
          AND NOT (
            held.status = 'pending'
            AND held.origin = 'engine_decision'
            AND held.rec_type = d.rec_type
            AND held.snapshot_date = d.snapshot_date
          )
     )
   ORDER BY d.scope_type, d.scope_id, d.rec_type
` as const;

export interface BudgetProposalProducerResult {
  contract: typeof BUDGET_PROPOSAL_PRODUCER_CONTRACT;
  ran: boolean;
  candidates: number;
  projected: number;
  /** Why each rejected candidate did not become a row. */
  refusals: Record<string, number>;
}

export interface BudgetProposalProducerDeps {
  businessId: string;
  snapshotDate: string;
  /** Accounts whose decision generation completed in this exact snapshot run. */
  providerAccountIds: readonly string[];
  /** Reads the per-candidate evidence the composition root needs. */
  loadCompositionSources(candidate: TypedBudgetCandidate): Promise<
    Omit<BudgetCompositionSources, "proposalId" | "claimToken"> | null
  >;
  /** Persists a projected row on the EXISTING table. */
  insertProposal(input: {
    /** The id the envelope was fingerprinted against. Inserted verbatim. */
    proposalId: string;
    candidate: TypedBudgetCandidate;
    envelopeJson: string;
    actionLabel: string;
  }): Promise<string | null>;
  listCandidates?(): Promise<TypedBudgetCandidate[]>;
  /**
   * Compatibility-only injection retained for older callers. Projection is
   * mode-independent: manual and semi-auto need the same pending review row,
   * while the scheduled executor separately requires `auto` at claim time.
   */
  readBudgetMode?(): Promise<"manual" | "semi_auto" | "auto">;
  /** Injectable only so a test can pin the identity it asserts on. */
  newProposalId?(): string;
  nowMs?: number;
}

/**
 * Project budget proposals for one business/day.
 *
 * Zero candidates is a perfectly good answer, and today it is the answer: no
 * retained decision in any of the six businesses carries a typed budget verb
 * with an exact amount. The path is complete, so the day one does, no source
 * change is required.
 */
export async function projectMetaBudgetProposals(
  deps: BudgetProposalProducerDeps,
): Promise<BudgetProposalProducerResult> {
  const refusals: Record<string, number> = {};
  const refuse = (code: string) => { refusals[code] = (refusals[code] ?? 0) + 1; };
  const providerAccountIds = Array.from(new Set(
    deps.providerAccountIds.map((id) => id.trim()).filter(Boolean),
  ));
  if (providerAccountIds.length === 0) {
    return {
      contract: BUDGET_PROPOSAL_PRODUCER_CONTRACT,
      ran: true,
      candidates: 0,
      projected: 0,
      refusals: { account_generation_not_fulfilled: 1 },
    };
  }
  const allowedProviderAccountIds = new Set(providerAccountIds);
  const allowedRecommendationTypes = new Set<string>(
    META_BUDGET_INTENT_RECOMMENDATION_TYPES,
  );

  const loadedCandidates = deps.listCandidates
    ? await deps.listCandidates()
    : await listTypedBudgetCandidates(
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
    if (!allowedRecommendationTypes.has(candidate.recType)) {
      refuse("budget_action_type_ineligible");
      return false;
    }
    const direction = directionForTypedRecommendation(candidate.recommendedAction);
    if (!isBudgetIntentSemanticTuple({
      recommendationType: candidate.recType,
      grain: candidate.scopeType,
      direction,
    })) {
      refuse("budget_action_semantic_mismatch");
      return false;
    }
    return true;
  });

  let projected = 0;
  for (const candidate of candidates) {
    const sources = await deps.loadCompositionSources(candidate);
    if (!sources) { refuse("composition_sources_unavailable"); continue; }

    /*
      D088 C2: the REAL row id, reserved before anything is fingerprinted.

      C1 fingerprinted a placeholder and then inserted a database-generated id,
      so no stored envelope could ever match its own row. The id is generated
      here and inserted explicitly, so the envelope and the row are the same
      identity from the first byte.
    */
    const proposalId = candidate.existingProposalId?.trim()
      || (deps.newProposalId ? deps.newProposalId() : randomUUID());
    const composed = composeBudgetExecutionCandidate({
      ...sources,
      proposalId,
      // The claim does not exist until approval; the durable idempotency key is
      // rebuilt then, from the real claim. Admissibility is what is tested here.
      claimToken: proposalId,
    });
    if (composed.blockers.length > 0) {
      for (const blocker of composed.blockers) refuse(blocker);
      continue;
    }
    if (composed.dryRun?.status !== "would_write_available") {
      refuse(`d085:${composed.dryRun?.status ?? "unavailable"}`);
      continue;
    }
    const request = composed.request;
    if (!request) { refuse("durable_request_not_constructible"); continue; }
    if (!isBudgetIntentSemanticTuple({
      recommendationType: candidate.recType,
      grain: request.scope.ownerGrain,
      direction: directionForTypedRecommendation(candidate.recommendedAction),
    })) {
      refuse("budget_action_semantic_mismatch");
      continue;
    }
    /*
      The intent's target and the composed request must be the same number. If
      they are not, the producer would be raising a row for a change nobody
      recommended.
    */
    if (request.intendedAmountMinor !== candidate.targetAmountMinor) {
      refuse("target_amount_disagrees_with_composition");
      continue;
    }

    const envelope = buildBudgetProposalEnvelope({
      proposalId,
      businessId: request.scope.businessId,
      providerAccountId: request.scope.providerAccountId,
      ownerGrain: request.scope.ownerGrain,
      entityId: request.scope.entityId,
      parentCampaignId: request.scope.parentCampaignId,
      budgetField: request.budgetField,
      ownerMode: request.ownerMode,
      currentAmountMinor: request.baseline.amountMinor,
      intendedAmountMinor: request.intendedAmountMinor,
      currency: request.currency,
      currencyExponent: request.currencyExponent,
      currencyRegistryVersion: request.currencyRegistryVersion,
      intentVerb: candidate.recommendedAction,
      recId: candidate.recId,
      recType: candidate.recType,
      snapshotDate: candidate.snapshotDate,
      engineVersion: candidate.engineVersion,
      decisionHash: candidate.decisionHash,
      decisionAt: candidate.decisionAt,
    });
    let id: string | null;
    try {
      id = await deps.insertProposal({
        proposalId,
        candidate,
        envelopeJson: JSON.stringify(envelope),
        actionLabel: proposalActionLabel(BUDGET_PROPOSAL_ACTION, candidate.scopeType),
      });
    } catch (error) {
      /* A rule or sibling projection can win the slot after candidate read. */
      if (!isOpenSlotUniqueViolation(error)) throw error;
      id = null;
    }
    if (id) projected += 1; else refuse("insert_conflicted");
  }

  return {
    contract: BUDGET_PROPOSAL_PRODUCER_CONTRACT,
    ran: true,
    candidates: candidates.length,
    projected,
    refusals,
  };
}

/** The default candidate read. Separated so the producer stays testable. */
export async function listTypedBudgetCandidates(
  businessId: string,
  snapshotDate: string,
  providerAccountIds: readonly string[],
): Promise<TypedBudgetCandidate[]> {
  const sql = getDb();
  const rows = (await sql.query(TYPED_BUDGET_CANDIDATE_SQL, [
    businessId,
    snapshotDate,
    META_BUDGET_INTENT_CONTRACT_VERSION,
    [...providerAccountIds],
  ])) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    businessId,
    scopeType: String(row.scope_type) as "campaign" | "adset",
    scopeId: String(row.scope_id),
    providerAccountId: String(row.provider_account_id),
    recId: String(row.rec_id),
    recType: String(row.rec_type),
    snapshotDate: String(row.snapshot_date).slice(0, 10),
    engineVersion: String(row.engine_version),
    decisionLabel: String(row.decision_label ?? ""),
    recommendedAction: typedRecommendationForDirection(
      String(row.target_direction ?? ""),
    ),
    targetAmountMinor: Number(row.target_amount_minor),
    reasoning: String(row.reasoning),
    entityLabel: typeof row.entity_label === "string" ? row.entity_label : null,
    parentCampaignId: typeof row.parent_campaign_id === "string"
      ? row.parent_campaign_id : null,
    decisionAt: new Date(String(row.created_at)).toISOString(),
    decisionHash: canonicalDecisionHash({
      businessId,
      providerAccountId: String(row.provider_account_id),
      scopeType: String(row.scope_type),
      scopeId: String(row.scope_id),
      recId: String(row.rec_id),
      recType: String(row.rec_type),
      snapshotDate: String(row.snapshot_date).slice(0, 10),
      engineVersion: String(row.engine_version),
      recommendedAction: String(row.recommended_action),
      targetAmountMinor: Number(row.target_amount_minor),
      decisionAt: new Date(String(row.created_at)).toISOString(),
    }),
    evidence: (row.evidence ?? {}) as Record<string, unknown>,
    existingProposalId:
      typeof row.existing_proposal_id === "string"
        ? row.existing_proposal_id
        : null,
  }));
}

/** The default insert. The SAME table, TTL and status the queue already uses. */
export async function insertBudgetProposalRow(input: {
  businessId: string;
  proposalId: string;
  candidate: TypedBudgetCandidate;
  envelopeJson: string;
  actionLabel: string;
}): Promise<string | null> {
  const candidateDirection = directionForTypedRecommendation(
    input.candidate.recommendedAction,
  );
  if (!isBudgetIntentSemanticTuple({
    recommendationType: input.candidate.recType,
    grain: input.candidate.scopeType,
    direction: candidateDirection,
  })) return null;

  let storedEnvelope: ReturnType<typeof parseBudgetProposalEnvelope>;
  try {
    storedEnvelope = parseBudgetProposalEnvelope(
      JSON.parse(input.envelopeJson) as unknown,
    );
  } catch {
    return null;
  }
  const validatedEnvelope = envelopeForProposalRow(storedEnvelope, {
    id: input.proposalId,
    businessId: input.businessId,
    providerAccountId: input.candidate.providerAccountId,
    scopeType: input.candidate.scopeType,
    scopeId: input.candidate.scopeId,
    proposedAction: BUDGET_PROPOSAL_ACTION,
    recId: input.candidate.recId,
    recType: input.candidate.recType,
    snapshotDate: input.candidate.snapshotDate,
    engineVersion: input.candidate.engineVersion,
  });
  if (!validatedEnvelope) return null;
  const evidenceLabel = `Budget: ${exactMoneyLabel({
    currency: validatedEnvelope.currency,
    currencyExponent: validatedEnvelope.currencyExponent,
    minorUnits: validatedEnvelope.currentAmountMinor,
  })} → ${exactMoneyLabel({
    currency: validatedEnvelope.currency,
    currencyExponent: validatedEnvelope.currencyExponent,
    minorUnits: validatedEnvelope.intendedAmountMinor,
  })}`;

  const sql = getDb();
  try {
    const rows = (await sql.query(
      `INSERT INTO meta_automation_proposals (
       id,
       business_id, provider_account_id, origin, decision_key, scope_type, scope_id,
       rec_id, rec_type, snapshot_date, engine_version, decision_label,
       proposed_action, action_label, primary_caption, entity_label, reason,
       evidence_ref, expires_at, status, budget_envelope_json, evidence_label
     ) SELECT
       $19::uuid,
       $1::uuid, $2, 'engine_decision', $3, $4, $5, $6, $7, $8::date, $9, $10,
       $11, $12, $13, NULLIF(BTRIM($14), ''), $15,
       $16::jsonb, NOW() + ($17 || ' hours')::interval, 'pending', $18::jsonb, $20
     WHERE NOT EXISTS (
       SELECT 1 FROM meta_automation_proposals held
        WHERE held.business_id = $1::uuid
          AND held.provider_account_id = $2
          AND held.decision_key = $3
          AND held.proposed_action = 'budget'
          AND held.status IN (${META_AUTOMATION_PROPOSAL_OPEN_STATUS_SQL})
          AND NOT (
            held.status = 'pending'
            AND held.origin = 'engine_decision'
            AND held.rec_type = $7
            AND held.snapshot_date = $8::date
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
       budget_envelope_json = EXCLUDED.budget_envelope_json,
       decision_note = NULL,
       updated_at = NOW()
     WHERE meta_automation_proposals.origin = 'engine_decision'
       AND meta_automation_proposals.id = EXCLUDED.id
       AND meta_automation_proposals.scope_type IN ('campaign', 'adset')
       AND meta_automation_proposals.proposed_action = 'budget'
       AND ${metaEngineProjectionReofferablePredicate(
         "meta_automation_proposals",
       )}
     RETURNING id::text AS id`,
      [
      input.businessId,
      input.candidate.providerAccountId,
      `${input.candidate.scopeType}:${input.candidate.scopeId}`,
      input.candidate.scopeType,
      input.candidate.scopeId,
      input.candidate.recId,
      input.candidate.recType,
      input.candidate.snapshotDate,
      input.candidate.engineVersion,
      input.candidate.decisionLabel,
      BUDGET_PROPOSAL_ACTION,
      input.actionLabel,
      META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
      input.candidate.entityLabel ?? "",
      input.candidate.reasoning,
      JSON.stringify({
        recId: input.candidate.recId,
        recType: input.candidate.recType,
        snapshotDate: input.candidate.snapshotDate,
        engineVersion: input.candidate.engineVersion,
        decisionKey: `${input.candidate.scopeType}:${input.candidate.scopeId}`,
        recommendedAction: input.candidate.recommendedAction,
        targetAmountMinor: input.candidate.targetAmountMinor,
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
