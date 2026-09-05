/**
 * The producer that turns a reviewed creative decision into a STAGED launch
 * intent — the first upstream caller the launch queue never had.
 *
 * `launch-proposal-producer.ts` selects prepared, unstarted intents carrying
 * decision, snapshot or brief lineage. Nothing ever wrote one. Launchpad's
 * wizard stages and executes an intent inside a single request, and the
 * operator intent API stages one with no lineage at all, so the queue's
 * candidate query matched nothing and the `launch` row — with its own CHECK,
 * its executor and its separately authorized activation behind it — was
 * unreachable by construction.
 *
 * ## What this producer is allowed to know, and what it is not
 *
 * It never decides what to advertise. Every fact it needs is already recorded
 * by a person before it runs:
 *
 * - **which decision** — a creative-grain snapshot the engine published as
 *   `scale` with no authority blocker. `launchpadModeForAuthorizedAction` maps
 *   `scale` to `duplicate`, and `duplicate` is `add_to_existing`; `cut` maps to
 *   no Launchpad mode at all and `refresh` maps to a NEW campaign, whose
 *   budget, targeting and ad sets a duplicate draft cannot supply. So `scale`
 *   is the only label here, and that is a consequence of the shipped map rather
 *   than a preference.
 * - **the approval** — a creative brief for that exact snapshot that a named
 *   person moved to `reviewed`. The table's own CHECK makes `reviewed` imply a
 *   `reviewed_at`, and `verifyMetaLaunchIntentLineage` already refuses a brief
 *   that is not reviewed, so this is the same law read one step earlier.
 * - **the approved asset, the approved copy and the exact destination** — a
 *   Launchpad draft the operator composed, naming this decision's creative and
 *   an exact target campaign and ad set. `copyMode` must be `reuse_creative`:
 *   the copy that ships is the copy already inside the approved creative, and
 *   `rebuild_creative` would be new copy nobody wrote or approved.
 *
 * Any of those missing is a NAMED refusal and no intent. Composing a payload,
 * picking a destination, or promoting a creative into an ad set nobody chose
 * would be this module deciding what to advertise, which is a person's call.
 *
 * ## Why it stages only under the `semi_auto` creative mode
 *
 * A staged intent's payload carries `executionAuthority`, and the create path
 * reads it two ways. The operator's own queue approval re-derives it from the
 * request — the fingerprint covers it, so the stored value must be the one
 * `bindMetaLaunchpadManualAuthorityToPayload` produces or the intent is refused
 * as a contract mismatch. The UNATTENDED arm reads it as evidence:
 * `storedLaunchExecutionAuthority` treats it as proof that an operator
 * confirmed this exact provider write.
 *
 * This producer cannot give that confirmation. Nobody pressed anything when it
 * ran. So it stages only where the confirmation is still to come — `semi_auto`,
 * where an operator approves each queue row and supplies the confirmation then
 * — and withholds under `auto` rather than leaving a stored value the unattended
 * arm would read as a confirmation that was never given. `manual` is withheld
 * for the reason the queue producer beside it already states: the operator works
 * from Launchpad, and a queue row would be a second inbox they never asked for.
 */
import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { normalizeMetaAddToExistingPayload } from "@/lib/launchpad/meta";
import type { MetaAddToExistingPayload } from "@/lib/launchpad/meta";
import { evaluateMetaLaunchpadExecutionBounds } from "@/lib/launchpad/meta-execution-bounds";
import {
  bindMetaLaunchpadManualAuthorityToPayload,
  META_LAUNCHPAD_MANUAL_AUTHORITY,
} from "@/lib/launchpad/meta-manual-authority";
import { MetaLaunchIntentLineageError } from "@/lib/launchpad/meta-launch-intent-lineage";
import { createMetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent-store";
import { validateMetaAddToExistingRequest } from "@/lib/launchpad/meta-validation";
import { resolveEffectiveMetaModes } from "@/lib/meta/automation-control-plane";

export const LAUNCH_INTENT_PRODUCER_CONTRACT =
  "meta.launch-intent-producer.v1" as const;

/**
 * How old the decision's own evidence may be when it becomes a launch.
 *
 * A brief can be reviewed days after the snapshot that produced it, and the
 * review is an approval of the reasoning rather than a fresh reading of the
 * account. Fourteen days is this producer's own policy — long enough that a
 * brief written on a Friday and reviewed the following week still stages, short
 * enough that a winner nobody looked at for a month does not silently become a
 * new ad. A candidate outside it is refused by name, not skipped in SQL, so the
 * reason is visible.
 */
export const LAUNCH_INTENT_DECISION_MAX_AGE_DAYS = 14;

export interface StageableLaunchDecisionCandidate {
  businessId: string;
  providerAccountId: string;
  /** The creative-grain snapshot row the brief was written against. */
  snapshotId: string;
  snapshotAsOfDate: string;
  decisionId: string;
  creativeId: string;
  publishedLabel: string;
  briefId: string;
  briefStatus: "draft" | "reviewed";
  /** The person whose review this staging rests on. Null on a draft brief. */
  briefReviewedBy: string | null;
  draftId: string | null;
  draftPayload: unknown;
}

export interface LaunchIntentProducerResult {
  contract: typeof LAUNCH_INTENT_PRODUCER_CONTRACT;
  ran: boolean;
  candidates: number;
  staged: number;
  stagedIntentIds: string[];
  refusals: Record<string, number>;
}

export interface LaunchIntentProducerDeps {
  businessId: string;
  snapshotDate: string;
  listCandidates?(): Promise<StageableLaunchDecisionCandidate[]>;
  /**
   * The shipped add-to-existing validator. Named as a dependency so the
   * eligibility ladder can be driven without a database, and defaulted to the
   * real one so production never gets a second opinion about what is valid.
   */
  validatePayload?(input: {
    businessId: string;
    providerAccountId: string;
    payload: MetaAddToExistingPayload;
  }): Promise<{ ok: boolean; blockers: Array<{ code: string }> }>;
  stageIntent?(input: {
    candidate: StageableLaunchDecisionCandidate;
    idempotencyKey: string;
    requestPayload: Record<string, unknown>;
  }): Promise<{ created: boolean; intentId: string }>;
  readCreativeMode?(): Promise<"manual" | "semi_auto" | "auto">;
}

/**
 * Decisions with a brief, and the draft that names their creative.
 *
 * The brief is an INNER join and that is what bounds this query: briefs are
 * written one at a time by people, so the candidate set is the set of decisions
 * somebody has already written about, not every `scale` the engine has ever
 * published. The draft is a LATERAL LEFT join so that "the operator approved the
 * decision but has not composed a launch" comes back as a candidate with a
 * named refusal rather than as silence.
 *
 * The draft must name EXACTLY this decision's creative. A draft carrying two
 * creatives is a launch about two decisions, and matching it to one of them
 * would stage a payload the other decision never authorized — and, because the
 * fingerprint is taken over the whole payload, two decisions would race to
 * stage the same semantic intent and the store's own guard would refuse the
 * second.
 *
 * `NOT EXISTS` on the intents is the first of the two things that make a rerun
 * safe; the idempotency key derived from the decision is the other, and it is
 * the one that holds when this query is racing itself.
 */
export const STAGEABLE_LAUNCH_DECISION_SQL = `
  SELECT s.id::text                AS snapshot_id,
         s.as_of_date::text        AS snapshot_as_of_date,
         s.creative_id,
         s.label                   AS published_label,
         b.id::text                AS brief_id,
         b.provider_account_id,
         b.source_decision_id,
         b.status                  AS brief_status,
         b.reviewed_by::text       AS brief_reviewed_by,
         draft.id::text            AS draft_id,
         draft.payload_json        AS draft_payload
    FROM engine_v3_decision_snapshots_daily s
    JOIN meta_creative_briefs b
      ON b.source_snapshot_id = s.id
     AND b.business_id = $1::uuid
    LEFT JOIN LATERAL (
      SELECT d.id, d.payload_json
        FROM meta_launch_drafts d
       WHERE d.business_id = $1::uuid
         AND d.provider_account_id = b.provider_account_id
         AND d.status = 'draft'
         AND d.payload_json ->> 'mode' = 'add_to_existing'
         AND d.payload_json -> 'creativeIds' = jsonb_build_array(s.creative_id)
       ORDER BY d.updated_at DESC, d.id DESC
       LIMIT 1
    ) draft ON TRUE
   WHERE s.business_ref_id = $1::uuid
     AND s.label = 'scale'
     AND s.authority_blocker IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM meta_launch_intents i
        WHERE i.business_id = $1::uuid
          AND i.source_decision_snapshot_id = s.id
     )
   ORDER BY s.as_of_date DESC, s.id
` as const;

/**
 * The idempotency key, derived from the DECISION and from nothing else.
 *
 * Not from the clock, and deliberately not from the payload either. If it
 * covered the payload, an operator editing their draft after the first tick
 * would produce a second key, a second intent and a second ad for one decision
 * — the queue's open-slot predicate would not catch it, because the two rows
 * would name two different intents. Keyed on the decision, the store's own
 * `ON CONFLICT (business_id, provider_account_id, operation, idempotency_key)`
 * returns the intent already staged and this producer records that it did
 * nothing.
 */
export function launchIntentIdempotencyKeyForDecision(input: {
  businessId: string;
  providerAccountId: string;
  decisionId: string;
  snapshotId: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        LAUNCH_INTENT_PRODUCER_CONTRACT,
        input.businessId,
        input.providerAccountId,
        input.decisionId,
        input.snapshotId,
      ]),
    )
    .digest("hex");
  return `${LAUNCH_INTENT_PRODUCER_CONTRACT}:${digest}`;
}

function daysBetween(fromDate: string, toDate: string): number | null {
  const from = Date.parse(`${fromDate}T00:00:00.000Z`);
  const to = Date.parse(`${toDate}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

export async function projectMetaLaunchIntents(
  deps: LaunchIntentProducerDeps,
): Promise<LaunchIntentProducerResult> {
  const refusals: Record<string, number> = {};
  const refuse = (code: string) => {
    refusals[code] = (refusals[code] ?? 0) + 1;
  };

  const mode = await (deps.readCreativeMode
    ?? (async () => (await resolveEffectiveMetaModes(deps.businessId)).creative))();
  if (mode !== "semi_auto") {
    return {
      contract: LAUNCH_INTENT_PRODUCER_CONTRACT,
      ran: true,
      candidates: 0,
      staged: 0,
      stagedIntentIds: [],
      refusals: {
        [mode === "manual"
          ? "creative_mode_manual"
          : "creative_mode_auto_operator_staging_required"]: 1,
      },
    };
  }

  const candidates = deps.listCandidates
    ? await deps.listCandidates()
    : await listStageableLaunchDecisions(deps.businessId);
  const validatePayload = deps.validatePayload ?? validateMetaAddToExistingRequest;
  const stageIntent = deps.stageIntent ?? stageDecisionLaunchIntent;

  const stagedIntentIds: string[] = [];
  for (const candidate of candidates) {
    if (candidate.briefStatus !== "reviewed" || !candidate.briefReviewedBy) {
      /*
        A brief nobody has reviewed is a note to self, not an approval — and
        `verifyMetaLaunchIntentLineage` would refuse it a moment later anyway.
        Refusing here says so with the decision still in hand.
      */
      refuse("creative_brief_not_reviewed");
      continue;
    }
    const age = daysBetween(candidate.snapshotAsOfDate, deps.snapshotDate);
    if (age === null || age > LAUNCH_INTENT_DECISION_MAX_AGE_DAYS) {
      refuse("decision_evidence_stale");
      continue;
    }
    if (!candidate.draftId) {
      // The decision is approved and nobody has said WHERE the ad goes. That
      // is the one thing this producer must never fill in.
      refuse("launch_payload_not_composed");
      continue;
    }

    const payload = normalizeMetaAddToExistingPayload(candidate.draftPayload);
    if (payload.copyMode !== "reuse_creative") {
      /*
        `rebuild_creative` writes a new image and a new creative object, so the
        copy that would ship is copy nobody approved — and the create path
        refuses it on the operator's own route for the separate reason that its
        provider writes have no durable per-step receipt.
      */
      refuse("copy_not_approved_for_reuse");
      continue;
    }
    if (
      payload.creativeIds.length !== 1
      || payload.creativeIds[0] !== candidate.creativeId
    ) {
      refuse("launch_payload_creative_mismatch");
      continue;
    }
    if (
      payload.targets.length === 0
      || payload.targets.some(
        (target) => !target.targetCampaignId.trim() || !target.targetAdsetId.trim(),
      )
    ) {
      refuse("destination_not_exact");
      continue;
    }

    const bounds = evaluateMetaLaunchpadExecutionBounds({
      operation: "add_to_existing",
      creativeCount: payload.creativeIds.length,
      adSetOrTargetCount: payload.targets.length,
      copyMode: payload.copyMode,
    });
    if (!bounds.ok) {
      refuse(bounds.blockers[0]?.code ?? "launch_execution_bounds_exceeded");
      continue;
    }

    /*
      The shipped validator, not a second opinion about what is approved.

      It is where "the creative exists in this account", "the creative is not
      rejected", "the creative has a source ad", "the destination ad set exists
      and is ACTIVE" and "the destination belongs to this account" already
      live. Re-implementing any of them here would produce a producer that
      stages what the create path is about to refuse.
    */
    const validation = await validatePayload({
      businessId: candidate.businessId,
      providerAccountId: candidate.providerAccountId,
      payload,
    }).catch(() => null);
    if (!validation) {
      refuse("launch_validation_unavailable");
      continue;
    }
    if (!validation.ok) {
      refuse(validation.blockers[0]?.code ?? "launch_validation_blocked");
      continue;
    }

    const idempotencyKey = launchIntentIdempotencyKeyForDecision({
      businessId: candidate.businessId,
      providerAccountId: candidate.providerAccountId,
      decisionId: candidate.decisionId,
      snapshotId: candidate.snapshotId,
    });
    /*
      The payload is stored in the exact shape the create path re-derives.

      `handleMetaAddToExistingAction` normalizes the request body and binds the
      approving operator's authority before comparing fingerprints, so a stored
      payload missing either step is refused as a contract mismatch and the
      staged intent is inert. Nothing here is composed: the fields are the
      operator's own draft, normalized by the same function the route uses.
    */
    const requestPayload = bindMetaLaunchpadManualAuthorityToPayload(
      payload,
      META_LAUNCHPAD_MANUAL_AUTHORITY,
    ) as unknown as Record<string, unknown>;

    const staged = await stageIntent({
      candidate,
      idempotencyKey,
      requestPayload,
    }).catch((error: unknown) => {
      if (error instanceof MetaLaunchIntentLineageError) {
        refuse(error.code);
        return null;
      }
      const code = (error as { code?: unknown } | null)?.code;
      refuse(typeof code === "string" ? code : "launch_intent_stage_failed");
      return null;
    });
    if (!staged) continue;
    if (!staged.created) {
      // A rerun, or a race with one. The store handed back the intent that is
      // already staged for this decision and nothing was written twice.
      refuse("intent_already_staged");
      continue;
    }
    stagedIntentIds.push(staged.intentId);
  }

  return {
    contract: LAUNCH_INTENT_PRODUCER_CONTRACT,
    ran: true,
    candidates: candidates.length,
    staged: stagedIntentIds.length,
    stagedIntentIds,
    refusals,
  };
}

export async function listStageableLaunchDecisions(
  businessId: string,
): Promise<StageableLaunchDecisionCandidate[]> {
  const rows = (await getDb().query(STAGEABLE_LAUNCH_DECISION_SQL, [
    businessId,
  ])) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    businessId,
    providerAccountId: String(row.provider_account_id),
    snapshotId: String(row.snapshot_id),
    snapshotAsOfDate: String(row.snapshot_as_of_date),
    decisionId: String(row.source_decision_id),
    creativeId: String(row.creative_id),
    publishedLabel: String(row.published_label),
    briefId: String(row.brief_id),
    briefStatus: row.brief_status === "reviewed" ? "reviewed" : "draft",
    briefReviewedBy:
      typeof row.brief_reviewed_by === "string" ? row.brief_reviewed_by : null,
    draftId: typeof row.draft_id === "string" ? row.draft_id : null,
    draftPayload: row.draft_payload ?? null,
  }));
}

/**
 * The write, through the store's own creator rather than an INSERT of our own.
 *
 * `createMetaLaunchIntent` is where the lineage is verified against the account
 * (the brief must be reviewed and belong to it, the draft must exist in it),
 * where the request fingerprint is taken, where `requested_status` is pinned to
 * PAUSED, and where the semantic guard refuses a second in-flight intent for the
 * same payload. Writing the row directly would skip every one of those.
 *
 * `createdBy` is the person who reviewed the brief. This staging rests on their
 * approval, and the action log for anything it eventually creates should name
 * them rather than a job.
 */
export async function stageDecisionLaunchIntent(input: {
  candidate: StageableLaunchDecisionCandidate;
  idempotencyKey: string;
  requestPayload: Record<string, unknown>;
}): Promise<{ created: boolean; intentId: string }> {
  const result = await createMetaLaunchIntent({
    businessId: input.candidate.businessId,
    providerAccountId: input.candidate.providerAccountId,
    operation: "add_to_existing",
    idempotencyKey: input.idempotencyKey,
    requestPayload: input.requestPayload,
    creativeBriefId: input.candidate.briefId,
    sourceDraftId: input.candidate.draftId,
    createdBy: input.candidate.briefReviewedBy,
  });
  return { created: result.created, intentId: result.intent.id };
}
