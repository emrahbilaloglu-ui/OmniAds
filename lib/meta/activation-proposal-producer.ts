/**
 * The queue producer for a launch that has been created and not yet turned on.
 *
 * A launch intent may only ever create PAUSED entities — the table's own CHECK
 * says so — which means a successful launch is a receipt for something nobody
 * can see. The only way to activate it was the Launchpad receipt, and the
 * receipt has no activation control, so a created campaign could sit switched
 * off indefinitely with nothing anywhere telling the operator it was waiting.
 *
 * This raises that row. It is the second half of the launch producer beside it:
 * one says "this is staged, create it", this one says "this exists and is off".
 *
 * ## Why the verb is `resume` and why that is not enough
 *
 * Activation turns entities on, so the row's action is `resume`. But `resume`
 * is also an ordinary un-pause, which belongs to the pause family and is
 * dispatched by the status runtime one entity at a time. An activation is not
 * that: it runs campaign → ad set → ad in order, reads each one back, and stops
 * where the sequence stops. `launch_intent_id` on the row is the only thing
 * separating the two, so it is always set here and everything that decides how
 * a row may be dispatched reads it rather than the verb.
 *
 * ## Why an unapproved intent still gets a row
 *
 * NULL `activation_approval_json` means operator-only, which is every intent's
 * default. That is a statement about who may dispatch it unattended, not about
 * whether the operator should be told — so the row is raised either way and the
 * sweep's own filter is what keeps an unapproved one out of the unattended
 * page. Hiding it would leave a paused campaign nobody is reminded about.
 */
import { getDb } from "@/lib/db";
import {
  META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
  META_AUTOMATION_PROPOSAL_TTL_HOURS,
  META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES,
} from "@/lib/meta/automation-proposals";

export const ACTIVATION_PROPOSAL_PRODUCER_CONTRACT =
  "meta.activation-proposal-producer.v1" as const;

export const ACTIVATION_PROPOSAL_ACTION = "resume" as const;

/**
 * The proposal statuses that leave this intent still on offer.
 *
 * The same law the launch producer states in full beside its own copy: the list
 * is the short NON-consuming one and is used as a `NOT IN`, so every status it
 * does not name excludes the intent — which makes a status added to the CHECK
 * constraint later consuming by default, the safe direction.
 *
 * `expired` is the one terminal status written with no provider dispatch having
 * begun (`expireStaleMetaAutomationProposals` touches only `pending` rows; the
 * claim sweep writes it only where `dispatch_started_at IS NULL`), so it
 * provably turned nothing on and the paused hierarchy it described is still
 * off. Every other terminal status either reached Meta or is an operator's own
 * verdict, and none of them may be added here — `failed` included, because a
 * status alone cannot say whether that row was dispatched. Its one
 * provably-undispatched case is carved out by `NON_DISPATCHED_FAILURE_ARM_SQL`
 * below, against the durable column rather than against the status.
 *
 * Restated rather than imported from the launch producer because the snapshot
 * pipeline's tests mock these two modules independently, and a module-scope
 * import between them breaks at load under those doubles. The two copies are
 * held equal by `launch-proposal-expiry-reoffer.test.ts`, which compares the
 * statuses both statements actually exclude.
 */
const LAUNCH_INTENT_UNCONSUMED_PROPOSAL_STATUSES = [
  ...META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES,
  "expired",
] as const;

const LAUNCH_INTENT_UNCONSUMED_PROPOSAL_STATUS_SQL =
  LAUNCH_INTENT_UNCONSUMED_PROPOSAL_STATUSES.map((status) => `'${status}'`)
    .join(", ");

/**
 * The one `failed` row that consumed nothing, told apart by durable proof.
 *
 * `failed` is written for two different facts. One is a provider answer: the
 * dispatch was entered and Meta refused. The other is a withheld outcome —
 * the stored approval expired, the standing mode or a gate closed, the write
 * posture went read-only after the row was claimed — which
 * `scheduled-activation-runtime` and the manual activate boundary return
 * BEFORE any provider call, and which `runClaimedProposalExecution` — or, on the
 * manual path, the approve route's own settle block — settles as
 * `failed` because nothing was dispatched and nothing succeeded
 * (`budget-execution-lifecycle.ts`, the `providerDispatchStarted` branch).
 * Excluding the intent for the second kind was the `expired` defect arriving
 * through the other door: the hierarchy is still paused, still nobody's, and
 * it never came back to the queue.
 *
 * `dispatch_started_at` is PROOF, not an inference from the receipt:
 * `markMetaAutomationProposalDispatchStarted` writes it before the first
 * provider call and the call is refused when it cannot be written, so no
 * activation can have reached Meta without it; `claimMetaAutomationProposal`
 * resets it to NULL on every claim, so it describes THIS attempt and not an
 * older one; and the claim sweep already trusts exactly this column to tell
 * `reconcile` from `expired`. The receipt could not carry the same weight —
 * `withheld()` publishes `providerMutationAttempted: false` even for a refusal
 * raised after the marker fired.
 *
 * It qualifies `failed` and nothing else. `approved` asserts a write landed,
 * `reconcile` means the outcome is unknown, and `dismissed`/`modified` are a
 * person's verdict on the offer; none of those becomes re-offerable merely for
 * want of a dispatch stamp. A row whose status is `failed` and whose stamp is
 * missing is the only combination that is provably non-consuming, so anything
 * else keeps excluding the intent.
 *
 * Restated rather than shared with the launch producer for the reason the
 * status list gives, and held equal to that copy by
 * `launch-proposal-nondispatched-failure-reoffer.test.ts`.
 */
const NON_DISPATCHED_FAILURE_ARM_SQL =
  "NOT (\n"
  + "            decided.status = 'failed'\n"
  + "            AND decided.dispatch_started_at IS NULL\n"
  /*
    ...AND the approval this launch was staged under still stands.

    The seam proved why this third condition is not optional. In the
    decision-to-launch chain, an operator un-reviews the brief, the sweep
    refuses with `creative_brief_not_reviewed` before touching Meta, and the row
    settles `failed` with no dispatch stamp while the intent stays `prepared`.
    With only the first two conditions that intent came straight back — and
    would come back on EVERY snapshot, to be refused every time, because nothing
    re-reviews a brief on its own. A queue row that can only ever fail is worse
    for the operator than the disappearance this carve-out set out to fix.

    This is one leg of the standing contract, not a reimplementation of it:
    `verifyMetaLaunchIntentLineage` refuses with exactly this code on exactly
    this predicate (`brief.status !== "reviewed"`), and it is the leg that
    changed in the observed failure. The full contract is still enforced where
    it matters, at execution. An intent naming no brief is unaffected.
  */
  + "            AND (\n"
  + "              i.creative_brief_id IS NULL\n"
  + "              OR EXISTS (\n"
  + "                SELECT 1 FROM meta_creative_briefs standing\n"
  + "                 WHERE standing.id = i.creative_brief_id\n"
  + "                   AND standing.status = 'reviewed'\n"
  + "              )\n"
  + "            )\n"
  + "          )";

export interface ActivatableLaunchIntentCandidate {
  intentId: string;
  businessId: string;
  providerAccountId: string;
  operation: "new_campaign" | "add_to_existing";
  /**
   * The FIRST entity the sequence will touch, which is what the row is about.
   *
   * A new-campaign launch owns its whole hierarchy, so the row points at the
   * campaign; an add-to-existing launch joined somebody else's live ad set and
   * owns only the ad it added, so the row points at the ad. The rest of the
   * plan is rebuilt from the receipt at dispatch — `activationPlanForIntent`
   * has the last word, and it reads the receipt rather than this row.
   */
  grain: "campaign" | "ad";
  entityId: string;
  entityLabel: string | null;
  identities: {
    campaignId: string | null;
    adsetId: string | null;
    adIds: string[];
  };
  /** Whether a stored approval exists at all. Never whether it is VALID. */
  approvalPresent: boolean;
  createdAt: string;
}

/**
 * Launches that produced something and are not delivering.
 *
 * `partially_succeeded` is included deliberately: a launch whose campaign and
 * ad set exist but whose ad failed still created entities that are off, and its
 * partial identities are as real as a complete receipt's. The activation
 * sequence only ever changes a status, so completing one is safe in a way that
 * re-running a create would not be.
 *
 * `delivering` on the stored activation receipt is what "already done" means.
 * Any other value — no receipt, a blocked one, an ambiguous one — leaves work
 * an operator may still want to finish, and a blocked hierarchy is exactly the
 * case that must not disappear from the queue.
 *
 * A paused launch used to disappear anyway, by the back door: the last arm
 * excluded the intent once ANY terminal row existed, and `expired` is terminal.
 * So a created-but-off campaign nobody activated within the row's 24h TTL was
 * never offered again — the exact outcome the paragraph above forbids. The arm
 * now names the outcomes that CONSUME the intent; `expired` is not one, because
 * it is only ever written where no dispatch began, and neither is a `failed`
 * row the queue withheld before the provider — same door, same paused
 * hierarchy, and `dispatch_started_at` is what proves it never dispatched.
 */
export const ACTIVATABLE_LAUNCH_INTENT_SQL = `
  SELECT i.id::text            AS intent_id,
         i.provider_account_id,
         i.operation,
         i.created_at,
         /*
           Present means USABLE, not merely non-null. A withdrawal is stored as
           a durable non-authorizing document, so a bare IS NOT NULL test would
           report approvalPresent true for an intent whose approval the operator
           withdrew -- and this field's own contract is what the queue may say
           to them.

           No backticks in this comment on purpose: it sits inside a tagged
           template literal, where one would end the SQL string.
         */
         (
           i.activation_approval_json IS NOT NULL
           AND i.activation_approval_json->>'revokedAt' IS NULL
         ) AS approval_present,
         COALESCE(
           i.result_receipt_json,
           i.error_receipt_json -> 'partialResult'
         )                     AS receipt,
         COALESCE(
           NULLIF(BTRIM(i.request_payload_json #>> '{campaign,name}'), ''),
           NULLIF(BTRIM(i.request_payload_json #>> '{name}'), '')
         )                     AS entity_label
    FROM meta_launch_intents i
   WHERE i.business_id = $1::uuid
     AND i.status IN ('succeeded', 'partially_succeeded')
     AND COALESCE((i.activation_receipt_json ->> 'delivering')::boolean, FALSE) = FALSE
     AND NOT EXISTS (
       SELECT 1 FROM meta_automation_proposals decided
        WHERE decided.business_id = i.business_id
          AND decided.provider_account_id = i.provider_account_id
          AND decided.decision_key = 'activate:' || i.id::text
          AND decided.status NOT IN (${LAUNCH_INTENT_UNCONSUMED_PROPOSAL_STATUS_SQL})
          -- A withheld activation never reached Meta, so it consumed nothing.
          AND ${NON_DISPATCHED_FAILURE_ARM_SQL}
     )
   ORDER BY i.created_at
` as const;

export interface ActivationProposalProducerResult {
  contract: typeof ACTIVATION_PROPOSAL_PRODUCER_CONTRACT;
  ran: boolean;
  candidates: number;
  projected: number;
  refusals: Record<string, number>;
}

export interface ActivationProposalProducerDeps {
  businessId: string;
  snapshotDate: string;
  insertProposal(input: {
    candidate: ActivatableLaunchIntentCandidate;
    actionLabel: string;
  }): Promise<string | null>;
  listCandidates?(): Promise<ActivatableLaunchIntentCandidate[]>;
}

/**
 * The row's own tag, written here rather than taken from the shared helper.
 *
 * `proposalActionLabel` renders `resume` as "Resume campaign" or "Resume ad
 * set" — it has no ad grain and no notion of a sequence, so it would tag an
 * ad-grain activation "Resume ad set", which names the wrong entity. What this
 * row offers is not an un-pause of one thing; it is the ordered activation of
 * what a launch created.
 */
export function activationActionLabel(
  candidate: Pick<ActivatableLaunchIntentCandidate, "operation">,
): string {
  return candidate.operation === "new_campaign"
    ? "Activate launch"
    : "Activate new ad";
}

export async function projectMetaActivationProposals(
  deps: ActivationProposalProducerDeps,
): Promise<ActivationProposalProducerResult> {
  const refusals: Record<string, number> = {};
  const refuse = (code: string) => { refusals[code] = (refusals[code] ?? 0) + 1; };

  const candidates = deps.listCandidates
    ? await deps.listCandidates()
    : await listActivatableLaunchIntents(deps.businessId);

  let projected = 0;
  for (const candidate of candidates) {
    /*
      Per candidate, for the reason the launch producer states beside its own
      loop: the snapshot catches at the BATCH level, so one duplicate that
      raised here used to drop every remaining candidate and look like an empty
      queue.
    */
    const id = await deps
      .insertProposal({ candidate, actionLabel: activationActionLabel(candidate) })
      .catch(() => null);
    if (id) projected += 1; else refuse("insert_conflicted");
  }

  return {
    contract: ACTIVATION_PROPOSAL_PRODUCER_CONTRACT,
    ran: true,
    candidates: candidates.length,
    projected,
    refusals,
  };
}

function readIdentities(receipt: unknown) {
  const record = receipt && typeof receipt === "object" && !Array.isArray(receipt)
    ? (receipt as Record<string, unknown>)
    : {};
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const adIds = Array.isArray(record.adIds)
    ? record.adIds.map(text).filter((id): id is string => Boolean(id))
    : [];
  const adsetIds = Array.isArray(record.adsetIds)
    ? record.adsetIds.map(text).filter((id): id is string => Boolean(id))
    : [];
  return {
    campaignId: text(record.campaignId),
    adsetId: adsetIds[0] ?? null,
    adIds,
  };
}

export async function listActivatableLaunchIntents(
  businessId: string,
): Promise<ActivatableLaunchIntentCandidate[]> {
  const rows = (await getDb().query(ACTIVATABLE_LAUNCH_INTENT_SQL, [businessId])) as
    Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const operation = String(row.operation) as "new_campaign" | "add_to_existing";
    const identities = readIdentities(row.receipt);
    /*
      The grain follows the SAME rule the activation plan follows: only a launch
      that created its own campaign may name one. An add-to-existing receipt
      records the campaign it joined, and pointing the row at that would offer
      to turn on somebody else's structure on the strength of one added ad.
    */
    const entityId = operation === "new_campaign"
      ? identities.campaignId
      : identities.adIds[0] ?? null;
    // A receipt naming nothing this launch created is not activatable, and a
    // row pointing at no entity would be a button with no target.
    if (!entityId) return [];
    return [{
      intentId: String(row.intent_id),
      businessId,
      providerAccountId: String(row.provider_account_id),
      operation,
      grain: operation === "new_campaign" ? ("campaign" as const) : ("ad" as const),
      entityId,
      entityLabel: typeof row.entity_label === "string" ? row.entity_label : null,
      identities,
      approvalPresent: row.approval_present === true,
      createdAt: new Date(String(row.created_at)).toISOString(),
    }];
  });
}

/**
 * The row. `origin = 'operator_action'` and the intent id always set.
 *
 * The lineage is not decoration: it is what stops this row being read as an
 * ordinary un-pause by the standing-mode resolver, by the sweep's runtime
 * selection and by the queue's own executor. A `resume` row without it would be
 * dispatched one entity at a time with no approval check.
 */
export async function insertActivationProposalRow(input: {
  candidate: ActivatableLaunchIntentCandidate;
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
       '${ACTIVATION_PROPOSAL_ACTION}', $7, $8, NULLIF(BTRIM($9), ''), $10,
       $11::jsonb, NOW() + ($12 || ' hours')::interval, 'pending', $13::uuid
     )
     /*
       The open-slot index, named with its own predicate.

       The projection index includes rec_type, which is NULL on an
       operator-origin row, and NULL is distinct from NULL in a unique index --
       so it can never arbitrate one of these. Without this the second
       projection for the same intent raises and takes the rest of the batch
       with it.
     */
     ON CONFLICT (business_id, provider_account_id, decision_key, proposed_action)
       WHERE status IN ('pending', 'claimed', 'reconcile')
     DO NOTHING
     RETURNING id::text AS id`,
    [
      input.candidate.businessId,
      input.candidate.providerAccountId,
      `activate:${input.candidate.intentId}`,
      input.candidate.grain,
      input.candidate.entityId,
      input.snapshotDate,
      input.actionLabel,
      META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
      input.candidate.entityLabel ?? "",
      input.candidate.operation === "new_campaign"
        ? "A test launch was created paused. Activating turns the campaign, ad set and ad on in order, and stops wherever the sequence stops."
        : "A reused creative was added paused to a live ad set. Activating turns that ad on and verifies its parents are actually delivering.",
      JSON.stringify({
        launchIntentId: input.candidate.intentId,
        operation: input.candidate.operation,
        identities: input.candidate.identities,
        /*
          Whether an approval EXISTS, which is not whether it is valid. The
          binding check is `validateActivationApproval` at dispatch, against the
          live intent; this is only what the queue may say to the operator.
        */
        approvalPresent: input.candidate.approvalPresent,
        createdAt: input.candidate.createdAt,
      }),
      String(META_AUTOMATION_PROPOSAL_TTL_HOURS),
      input.candidate.intentId,
    ],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}
