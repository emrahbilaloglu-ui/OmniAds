/**
 * The queue producer for a validated launch intent.
 *
 * `launch` became an allowed `proposed_action` — with a CHECK requiring the
 * intent id on the row — and nothing ever raised one. A launch intent that
 * passed validation sat in `ready` where only the Launchpad screen could see
 * it, so the confirmation queue, which is the place an operator actually works
 * from in the morning, never mentioned it.
 *
 * ## Why this producer creates nothing
 *
 * Every other producer here reads a persisted decision. This one reads a
 * persisted INTENT, because a launch is not a recommendation: it names an
 * approved asset, an approved copy and a destination, and those are decided in
 * Launchpad by a person. Inventing one from a `scale` label would be this
 * module deciding what to advertise.
 *
 * So the row is a pointer, and the intent stays the authority. `launch` is
 * deliberately absent from `AUTOMATABLE_PROPOSAL_ACTIONS`: creating an entity
 * with nobody present is a different authorization than changing one that
 * already exists, and this row is for an operator to approve.
 */
import { getDb } from "@/lib/db";
import { resolveEffectiveMetaModes } from "@/lib/meta/automation-control-plane";
import {
  META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
  META_AUTOMATION_PROPOSAL_TTL_HOURS,
  META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES,
  proposalActionLabel,
} from "@/lib/meta/automation-proposals";

export const LAUNCH_PROPOSAL_PRODUCER_CONTRACT =
  "meta.launch-proposal-producer.v1" as const;

export const LAUNCH_PROPOSAL_ACTION = "launch" as const;

export interface ReadyLaunchIntentCandidate {
  intentId: string;
  businessId: string;
  providerAccountId: string;
  operation: "new_campaign" | "add_to_existing";
  createdAt: string;
  /** What the intent will create first. A new campaign, or one ad in a live set. */
  grain: "campaign" | "ad";
  entityLabel: string | null;
}

/**
 * Intents that are validated and not yet executed.
 *
 * `ready` is the only status that qualifies: `prepared` has not passed
 * validation, and everything after `executing` has already reached a provider.
 * Offering either would be offering an action that cannot be taken.
 */
export const READY_LAUNCH_INTENT_SQL = `
  SELECT i.id::text            AS intent_id,
         i.provider_account_id,
         i.operation,
         i.created_at,
         COALESCE(
           NULLIF(BTRIM(i.request_payload_json #>> '{campaign,name}'), ''),
           NULLIF(BTRIM(i.request_payload_json #>> '{name}'), '')
         )                     AS entity_label
    FROM meta_launch_intents i
   WHERE i.business_id = $1::uuid
     AND i.status = 'ready'
     AND NOT EXISTS (
       SELECT 1 FROM meta_automation_proposals decided
        WHERE decided.business_id = i.business_id
          AND decided.provider_account_id = i.provider_account_id
          AND decided.decision_key = 'launch:' || i.id::text
          AND decided.status NOT IN (${META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES.map((s) => `'${s}'`).join(", ")})
     )
   ORDER BY i.created_at
` as const;

export interface LaunchProposalProducerResult {
  contract: typeof LAUNCH_PROPOSAL_PRODUCER_CONTRACT;
  ran: boolean;
  candidates: number;
  projected: number;
  refusals: Record<string, number>;
}

export interface LaunchProposalProducerDeps {
  businessId: string;
  snapshotDate: string;
  insertProposal(input: {
    candidate: ReadyLaunchIntentCandidate;
    actionLabel: string;
  }): Promise<string | null>;
  listCandidates?(): Promise<ReadyLaunchIntentCandidate[]>;
  /**
   * The standing creative mode. Manual means the operator works from
   * Launchpad, so a queue row would be a second inbox they never asked for —
   * the same judgement every other projection here makes about its family.
   */
  readCreativeMode?(): Promise<"manual" | "semi_auto" | "auto">;
}

export async function projectMetaLaunchProposals(
  deps: LaunchProposalProducerDeps,
): Promise<LaunchProposalProducerResult> {
  const refusals: Record<string, number> = {};
  const refuse = (code: string) => { refusals[code] = (refusals[code] ?? 0) + 1; };

  const mode = await (deps.readCreativeMode
    ?? (async () => (await resolveEffectiveMetaModes(deps.businessId)).creative))();
  if (mode === "manual") {
    return {
      contract: LAUNCH_PROPOSAL_PRODUCER_CONTRACT,
      ran: true,
      candidates: 0,
      projected: 0,
      refusals: { creative_mode_manual: 1 },
    };
  }

  const candidates = deps.listCandidates
    ? await deps.listCandidates()
    : await listReadyLaunchIntents(deps.businessId);

  let projected = 0;
  for (const candidate of candidates) {
    const id = await deps.insertProposal({
      candidate,
      actionLabel: proposalActionLabel(
        LAUNCH_PROPOSAL_ACTION,
        candidate.grain === "campaign" ? "campaign" : "ad",
      ),
    });
    if (id) projected += 1; else refuse("insert_conflicted");
  }

  return {
    contract: LAUNCH_PROPOSAL_PRODUCER_CONTRACT,
    ran: true,
    candidates: candidates.length,
    projected,
    refusals,
  };
}

export async function listReadyLaunchIntents(
  businessId: string,
): Promise<ReadyLaunchIntentCandidate[]> {
  const rows = (await getDb().query(READY_LAUNCH_INTENT_SQL, [businessId])) as
    Array<Record<string, unknown>>;
  return rows.map((row) => {
    const operation = String(row.operation) as "new_campaign" | "add_to_existing";
    return {
      intentId: String(row.intent_id),
      businessId,
      providerAccountId: String(row.provider_account_id),
      operation,
      createdAt: new Date(String(row.created_at)).toISOString(),
      grain: operation === "new_campaign" ? "campaign" : "ad",
      entityLabel: typeof row.entity_label === "string" ? row.entity_label : null,
    };
  });
}

/**
 * The row. `origin = 'operator_action'`, because that is what it is.
 *
 * A launch intent is a person's decision recorded in Launchpad, not an engine
 * recommendation, and the lineage CHECK has an arm that says exactly that: no
 * rule, no dedupe key, and no invented engine version.
 */
export async function insertLaunchProposalRow(input: {
  candidate: ReadyLaunchIntentCandidate;
  snapshotDate: string;
  actionLabel: string;
}): Promise<string | null> {
  const rows = (await getDb().query(
    `INSERT INTO meta_automation_proposals (
       business_id, provider_account_id, origin, decision_key, scope_type,
       scope_id, snapshot_date, proposed_action, action_label, primary_caption,
       entity_label, reason, evidence_ref, expires_at, status, launch_intent_id
     ) VALUES (
       $1::uuid, $2, 'operator_action', $3, $4, $5, $6::date,
       '${LAUNCH_PROPOSAL_ACTION}', $7, $8, NULLIF(BTRIM($9), ''), $10,
       $11::jsonb, NOW() + ($12 || ' hours')::interval, 'pending', $13::uuid
     )
     ON CONFLICT (business_id, provider_account_id, decision_key, rec_type, snapshot_date)
     DO NOTHING
     RETURNING id::text AS id`,
    [
      input.candidate.businessId,
      input.candidate.providerAccountId,
      `launch:${input.candidate.intentId}`,
      input.candidate.grain === "campaign" ? "campaign" : "ad",
      // The intent is what this row is about; no provider entity exists yet.
      input.candidate.intentId,
      input.snapshotDate,
      input.actionLabel,
      META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
      input.candidate.entityLabel ?? "",
      input.candidate.operation === "new_campaign"
        ? "A validated test launch is waiting. Everything it creates is paused; activating is a separate decision."
        : "A validated creative reuse is waiting. The new ad is created paused; activating is a separate decision.",
      JSON.stringify({
        launchIntentId: input.candidate.intentId,
        operation: input.candidate.operation,
        createdAt: input.candidate.createdAt,
        // Said on the row, because it is the fact an operator most needs and
        // the one a queue full of pause rows would let them assume otherwise.
        createStatus: "PAUSED",
      }),
      String(META_AUTOMATION_PROPOSAL_TTL_HOURS),
      input.candidate.intentId,
    ],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}
