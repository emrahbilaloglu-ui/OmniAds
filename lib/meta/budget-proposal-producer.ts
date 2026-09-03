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
import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";
import {
  META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
  META_AUTOMATION_PROPOSAL_TTL_HOURS,
  META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES,
  proposalActionLabel,
} from "@/lib/meta/automation-proposals";
import {
  BUDGET_PROPOSAL_ACTION,
  buildBudgetProposalEnvelope,
  canonicalDecisionHash,
} from "@/lib/meta/budget-proposal-runtime";
import {
  composeBudgetExecutionCandidate,
  type BudgetCompositionSources,
} from "@/lib/meta/budget-execution-composition";

export const BUDGET_PROPOSAL_PRODUCER_CONTRACT =
  "meta.budget-proposal-producer.v1" as const;

/** The only two recommended actions that are budget intents. */
export const TYPED_BUDGET_RECOMMENDATIONS = [
  "increase_budget",
  "decrease_budget",
] as const;

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
         (d.target_value ->> 'amountMinor')::bigint AS target_amount_minor,
         d.reasoning,
         dim.entity_label,
         dim.parent_campaign_id,
         d.created_at,
         d.evidence
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
   WHERE d.business_id = $1::text
     AND d.snapshot_date = $2::date
     AND d.kind = 'recommendation'
     AND d.scope_type IN ('campaign', 'adset')
     -- The EXACT typed verb. Not the decision label, which is a commercial
     -- action and says nothing about money.
     AND d.recommended_action = ANY($3::text[])
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

  const candidates = deps.listCandidates
    ? await deps.listCandidates()
    : await listTypedBudgetCandidates(deps.businessId, deps.snapshotDate);

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
    const proposalId = deps.newProposalId ? deps.newProposalId() : randomUUID();
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
    const id = await deps.insertProposal({
      proposalId,
      candidate,
      envelopeJson: JSON.stringify(envelope),
      actionLabel: proposalActionLabel(BUDGET_PROPOSAL_ACTION, candidate.scopeType),
    });
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
): Promise<TypedBudgetCandidate[]> {
  const sql = getDb();
  const rows = (await sql.query(TYPED_BUDGET_CANDIDATE_SQL, [
    businessId, snapshotDate, [...TYPED_BUDGET_RECOMMENDATIONS],
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
    recommendedAction: String(row.recommended_action) as
      (typeof TYPED_BUDGET_RECOMMENDATIONS)[number],
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
  const sql = getDb();
  const rows = (await sql.query(
    `INSERT INTO meta_automation_proposals (
       id,
       business_id, provider_account_id, origin, decision_key, scope_type, scope_id,
       rec_id, rec_type, snapshot_date, engine_version, decision_label,
       proposed_action, action_label, primary_caption, entity_label, reason,
       evidence_ref, expires_at, status, budget_envelope_json
     ) VALUES (
       $19::uuid,
       $1::uuid, $2, 'engine_decision', $3, $4, $5, $6, $7, $8::date, $9, $10,
       $11, $12, $13, NULLIF(BTRIM($14), ''), $15,
       $16::jsonb, NOW() + ($17 || ' hours')::interval, 'pending', $18::jsonb
     )
     ON CONFLICT (business_id, provider_account_id, decision_key, rec_type, snapshot_date)
     DO NOTHING
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
    ],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}
