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
 * - **which decision** — a creative-grain snapshot the engine published with no
 *   authority blocker, under a label the SHIPPED map gives a Launchpad
 *   destination. `launchpadModeForAuthorizedAction` maps `scale` to `duplicate`
 *   and `refresh` to `rebuild`; `launchpadWizardTargetForHandoffMode` turns
 *   those into `add_to_existing` and `new_campaign`. `cut` maps to no mode at
 *   all and is therefore not a candidate — a consequence of that map rather
 *   than a preference here, which is why the label list and the required draft
 *   mode are both derived from it instead of written out again.
 * - **the approval** — a creative brief for that exact snapshot that a named
 *   person moved to `reviewed`. The table's own CHECK makes `reviewed` imply a
 *   `reviewed_at`, and `verifyMetaLaunchIntentLineage` already refuses a brief
 *   that is not reviewed, so this is the same law read one step earlier.
 * - **the approved asset, the approved copy and the exact destination** — a
 *   Launchpad draft the operator composed in the mode the label maps to, naming
 *   this decision's creative and nothing else.
 *
 *   For a `scale` — creative reuse, and winner promotion, which is the same act
 *   aimed at a Main ad set — the destination is an exact existing campaign and
 *   ad set, and `copyMode` must be `reuse_creative`: the copy that ships is the
 *   copy already inside the approved creative, and `rebuild_creative` would be
 *   new copy nobody wrote or approved.
 *
 *   For a `refresh` — the test launch — the destination is the campaign and ad
 *   sets the operator composed in the wizard: their name, budget, pixel,
 *   targeting and attribution, validated by the shipped
 *   `validateMetaLaunchRequest`. There is no `copyMode` on that payload and it
 *   needs none: `createAd` sends `creative: {creative_id}`, so the copy that
 *   ships is again the approved creative's own.
 *
 * Any of those missing is a NAMED refusal and no intent. Composing a payload,
 * picking a destination, or promoting a creative into an ad set nobody chose
 * would be this module deciding what to advertise, which is a person's call.
 *
 * ## The authority it binds, and why it is its own
 *
 * A staged intent's payload carries `executionAuthority`, and it is inside the
 * request fingerprint, so whatever is stored is what every later reader sees.
 * This producer stages under `META_LAUNCHPAD_STAGED_AUTHORITY` —
 * `{launchpad_decision_staged_v1, decision_staged_approval}` — and never under
 * the operator pair, because nobody pressed anything at the moment it ran.
 *
 * It binds that value in EVERY mode it stages under, not only `auto`. The mode
 * can change between staging and execution: an intent staged while the family
 * was `semi_auto` and swept after somebody moved it to `auto` would, if the
 * stored value depended on the mode at staging time, arrive at the unattended
 * arm carrying an `explicit_operator_confirmation` nobody ever gave. Keeping one
 * honest value makes the payload's own account of itself independent of what
 * happened to the mode afterwards.
 *
 * What that costs is nothing an approval needs. Under `semi_auto` the operator
 * still approves the queue row and their confirmation is still required by
 * `evaluateMetaLaunchpadManualAuthority` on the request; the create path binds
 * the STORED authority for the fingerprint and journals the operator's
 * confirmation beside it. Under `auto` the scheduled runtime reads the stored
 * authority as what it is — a reviewed decision staged for later — and journals
 * itself under `launchpad_scheduled_v1` with no requester.
 *
 * `manual` is withheld for the reason the queue producer beside it already
 * states: the operator works from Launchpad, and a queue row would be a second
 * inbox they never asked for.
 *
 * Everything downstream of the mode is unchanged by it. The created entity is
 * PAUSED (the table's own CHECK), and turning it on is a separate row with a
 * separate approval in either mode.
 */
import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import {
  normalizeMetaAddToExistingPayload,
  normalizeMetaLaunchPayload,
} from "@/lib/launchpad/meta";
import type { MetaAddToExistingPayload, MetaLaunchPayload } from "@/lib/launchpad/meta";
import { evaluateMetaLaunchpadExecutionBounds } from "@/lib/launchpad/meta-execution-bounds";
import {
  bindMetaLaunchExecutionAuthorityToPayload,
  META_LAUNCHPAD_STAGED_AUTHORITY,
} from "@/lib/launchpad/meta-manual-authority";
import { MetaLaunchIntentLineageError } from "@/lib/launchpad/meta-launch-intent-lineage";
import { createMetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent-store";
import {
  validateMetaAddToExistingRequest,
  validateMetaLaunchRequest,
} from "@/lib/launchpad/meta-validation";
import {
  launchpadModeForAuthorizedAction,
  launchpadWizardTargetForHandoffMode,
  type LaunchpadHandoffAuthorizedAction,
} from "@/lib/meta/launchpad-handoff-contract";
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
 * reason is visible. Future evidence is excluded by the snapshot-date ceiling
 * in the query and refused again by the producer for injected candidates.
 */
export const LAUNCH_INTENT_DECISION_MAX_AGE_DAYS = 14;

/**
 * The label -> operation map, taken from the shipped Launchpad one.
 *
 * Two shipped functions already decide where a decision lands: the canonical
 * action -> handoff mode map, and the handoff mode -> wizard target map. This
 * composes them rather than restating either, so a label whose destination
 * changes there changes here too, and `cut` — which has no destination at all —
 * cannot become a launch by anybody forgetting to exclude it.
 */
export function launchOperationForDecisionLabel(
  label: string,
): MetaLaunchIntentStageableOperation | null {
  if (label !== "scale" && label !== "cut" && label !== "refresh") return null;
  const mode = launchpadModeForAuthorizedAction(
    label as LaunchpadHandoffAuthorizedAction,
  );
  if (!mode) return null;
  return launchpadWizardTargetForHandoffMode(mode).launchpadMode;
}

export type MetaLaunchIntentStageableOperation =
  | "add_to_existing"
  | "new_campaign";

/** Every label the shipped map gives a Launchpad destination, in one place. */
export const STAGEABLE_LAUNCH_DECISION_LABELS = Object.freeze(
  (["scale", "cut", "refresh"] as const).filter((label) =>
    launchOperationForDecisionLabel(label) !== null,
  ),
);

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
  /**
   * The mode of the draft the operator composed. It is matched in SQL against
   * the mode this decision's label maps to, so a candidate whose only draft is
   * for the OTHER kind of launch arrives here as "nobody composed one" rather
   * than as a launch aimed somewhere the decision never pointed.
   */
  draftMode: MetaLaunchIntentStageableOperation | null;
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
  /** The shipped new-campaign validator, for the same reason. */
  validateLaunchPayload?(input: {
    businessId: string;
    providerAccountId: string;
    payload: MetaLaunchPayload;
  }): Promise<{ ok: boolean; blockers: Array<{ code: string }> }>;
  stageIntent?(input: {
    candidate: StageableLaunchDecisionCandidate;
    operation: MetaLaunchIntentStageableOperation;
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
 * It must also be in the mode this decision's label maps to, and both the label
 * list ($2) and that mode ($3/$4) are computed from the shipped Launchpad map
 * rather than written here. Matching the mode in SQL rather than in TypeScript
 * matters: an operator who has BOTH a reuse draft and a test-launch draft for
 * one creative would otherwise have the more recently edited one picked and the
 * decision refused for pointing the wrong way, when the draft it needed was
 * sitting right there.
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
         draft.payload_json        AS draft_payload,
         draft.payload_json ->> 'mode' AS draft_mode
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
         AND d.payload_json ->> 'mode' = CASE
               WHEN s.label = 'scale' THEN $3::text
               ELSE $4::text
             END
         AND d.payload_json -> 'creativeIds' = jsonb_build_array(s.creative_id)
       ORDER BY d.updated_at DESC, d.id DESC
       LIMIT 1
    ) draft ON TRUE
   WHERE s.business_ref_id = $1::uuid
     AND s.as_of_date <= $5::date
     AND s.label = ANY($2::text[])
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

type ComposedLaunchCandidate =
  | {
      ok: true;
      operation: "add_to_existing";
      payload: MetaAddToExistingPayload;
      bounds: Parameters<typeof evaluateMetaLaunchpadExecutionBounds>[0];
    }
  | {
      ok: true;
      operation: "new_campaign";
      payload: MetaLaunchPayload;
      bounds: Parameters<typeof evaluateMetaLaunchpadExecutionBounds>[0];
    }
  | { ok: false; refusal: string };

/**
 * Creative reuse, and winner promotion — the same act, aimed at an ad set the
 * operator already chose.
 *
 * Nothing is composed: the payload is the operator's own draft, normalized by
 * the same function the create route uses, and every test below is a test of
 * what THEY approved.
 */
function composeAddToExistingCandidate(
  candidate: StageableLaunchDecisionCandidate,
): ComposedLaunchCandidate {
  const payload = normalizeMetaAddToExistingPayload(candidate.draftPayload);
  if (payload.copyMode !== "reuse_creative") {
    /*
      `rebuild_creative` writes a new image and a new creative object, so the
      copy that would ship is copy nobody approved — and the create path
      refuses it on the operator's own route for the separate reason that its
      provider writes have no durable per-step receipt.
    */
    return { ok: false, refusal: "copy_not_approved_for_reuse" };
  }
  if (
    payload.creativeIds.length !== 1
    || payload.creativeIds[0] !== candidate.creativeId
  ) {
    return { ok: false, refusal: "launch_payload_creative_mismatch" };
  }
  if (
    payload.targets.length === 0
    || payload.targets.some(
      (target) => !target.targetCampaignId.trim() || !target.targetAdsetId.trim(),
    )
  ) {
    return { ok: false, refusal: "destination_not_exact" };
  }
  return {
    ok: true,
    operation: "add_to_existing",
    payload,
    bounds: {
      operation: "add_to_existing",
      creativeCount: payload.creativeIds.length,
      adSetOrTargetCount: payload.targets.length,
      copyMode: payload.copyMode,
    },
  };
}

/**
 * The test launch: a NEW campaign, its ad sets, and one ad per ad set, all
 * PAUSED.
 *
 * The destination here is not an existing id — it is the campaign and the ad
 * sets the operator built in the wizard and saved as a draft. So the exactness
 * this checks is the one thing the draft could still get wrong for THIS
 * decision (a creative that is not the decision's own), and everything else —
 * the campaign name, the budget mode and amount, each ad set's pixel, country,
 * age range and click attribution — is left to
 * `validateMetaLaunchPayloadShape` inside the shipped validator, which is
 * where those rules already live and where the create path will read them.
 *
 * There is no `copyMode` to check. `createAd` posts
 * `creative: {creative_id: <the approved creative>}`, so the copy that ships is
 * the approved creative's own, exactly as `reuse_creative` guarantees on the
 * other branch.
 */
function composeNewCampaignCandidate(
  candidate: StageableLaunchDecisionCandidate,
): ComposedLaunchCandidate {
  const payload = normalizeMetaLaunchPayload(candidate.draftPayload);
  if (
    payload.creativeIds.length !== 1
    || payload.creativeIds[0] !== candidate.creativeId
  ) {
    return { ok: false, refusal: "launch_payload_creative_mismatch" };
  }
  if (payload.adSets.length === 0 || !payload.campaign.name.trim()) {
    // Nobody has said what the test launch IS. Filling in a campaign name or
    // an ad set would be this module deciding what to advertise.
    return { ok: false, refusal: "destination_not_exact" };
  }
  return {
    ok: true,
    operation: "new_campaign",
    payload,
    bounds: {
      operation: "new_campaign",
      creativeCount: payload.creativeIds.length,
      adSetOrTargetCount: payload.adSets.length,
    },
  };
}

function calendarDateTimestamp(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)
    || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp;
}

function daysBetween(fromDate: string, toDate: string): number | null {
  const from = calendarDateTimestamp(fromDate);
  const to = calendarDateTimestamp(toDate);
  if (from === null || to === null) return null;
  return Math.round((to - from) / 86_400_000);
}

export async function projectMetaLaunchIntents(
  deps: LaunchIntentProducerDeps,
): Promise<LaunchIntentProducerResult> {
  const refusals: Record<string, number> = {};
  const refuse = (code: string) => {
    refusals[code] = (refusals[code] ?? 0) + 1;
  };
  if (calendarDateTimestamp(deps.snapshotDate) === null) {
    return {
      contract: LAUNCH_INTENT_PRODUCER_CONTRACT,
      ran: true,
      candidates: 0,
      staged: 0,
      stagedIntentIds: [],
      refusals: { snapshot_date_invalid: 1 },
    };
  }

  const mode = await (deps.readCreativeMode
    ?? (async () => (await resolveEffectiveMetaModes(deps.businessId)).creative))();
  if (mode === "manual") {
    return {
      contract: LAUNCH_INTENT_PRODUCER_CONTRACT,
      ran: true,
      candidates: 0,
      staged: 0,
      stagedIntentIds: [],
      refusals: { creative_mode_manual: 1 },
    };
  }

  const candidates = deps.listCandidates
    ? await deps.listCandidates()
    : await listStageableLaunchDecisions(deps.businessId, deps.snapshotDate);
  const validatePayload = deps.validatePayload ?? validateMetaAddToExistingRequest;
  const validateLaunchPayload =
    deps.validateLaunchPayload ?? validateMetaLaunchRequest;
  const stageIntent = deps.stageIntent ?? stageDecisionLaunchIntent;

  const stagedIntentIds: string[] = [];
  for (const candidate of candidates) {
    /*
      Where this decision's launch is allowed to land, from the shipped map.

      A candidate whose label has no Launchpad destination cannot become a
      launch at all. The query already excludes those, so reaching this is a
      hand-edited row or a map that changed underneath, and either way the
      answer is a named refusal rather than a guess at an operation.
    */
    const operation = launchOperationForDecisionLabel(candidate.publishedLabel);
    if (!operation) {
      refuse("decision_label_has_no_launch_destination");
      continue;
    }
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
    if (age !== null && age < 0) {
      refuse("decision_evidence_in_future");
      continue;
    }
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
    if (candidate.draftMode !== null && candidate.draftMode !== operation) {
      // The query matches the mode already; this is the same law restated for
      // an injected candidate, so a test double cannot stage a reuse draft
      // against a decision that asked for a new campaign.
      refuse("launch_payload_mode_mismatch");
      continue;
    }

    /*
      The two shapes, each checked by what makes IT exact.

      A reuse names an existing campaign and ad set and must reuse the approved
      creative's own copy. A test launch names the campaign and ad sets the
      operator composed, and the shipped new-campaign validator is where their
      name, budget, pixel, targeting and attribution are proven. Both then go
      through the same bounds and the same staging below.
    */
    const composed =
      operation === "add_to_existing"
        ? composeAddToExistingCandidate(candidate)
        : composeNewCampaignCandidate(candidate);
    if (!composed.ok) {
      refuse(composed.refusal);
      continue;
    }

    const bounds = evaluateMetaLaunchpadExecutionBounds(composed.bounds);
    if (!bounds.ok) {
      refuse(bounds.blockers[0]?.code ?? "launch_execution_bounds_exceeded");
      continue;
    }

    /*
      The shipped validator, not a second opinion about what is approved.

      For a reuse it is where "the creative exists in this account", "the
      creative is not rejected", "the creative has a source ad", "the
      destination ad set exists and is ACTIVE" and "the destination belongs to
      this account" already live. For a test launch it is where the account's
      billing, the ad sets' pixels and the same creative facts live.
      Re-implementing any of them here would produce a producer that stages
      what the create path is about to refuse.
    */
    const validation = await (composed.operation === "add_to_existing"
      ? validatePayload({
          businessId: candidate.businessId,
          providerAccountId: candidate.providerAccountId,
          payload: composed.payload,
        })
      : validateLaunchPayload({
          businessId: candidate.businessId,
          providerAccountId: candidate.providerAccountId,
          payload: composed.payload,
        })
    ).catch(() => null);
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
      The payload is stored in the exact shape the create path re-derives, and
      under this producer's OWN authority.

      `handleMetaAddToExistingAction` normalizes the request body and binds the
      STORED payload's authority before comparing fingerprints, so what is
      written here is what both arms replay. Nothing else is composed: the
      fields are the operator's own draft, normalized by the same function the
      route uses.
    */
    const requestPayload = bindMetaLaunchExecutionAuthorityToPayload(
      composed.payload,
      META_LAUNCHPAD_STAGED_AUTHORITY,
    ) as unknown as Record<string, unknown>;

    const staged = await stageIntent({
      candidate,
      operation,
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
  snapshotDate: string,
): Promise<StageableLaunchDecisionCandidate[]> {
  if (calendarDateTimestamp(snapshotDate) === null)
    throw new Error("launch_intent_snapshot_date_invalid");
  const rows = (await getDb().query(STAGEABLE_LAUNCH_DECISION_SQL, [
    businessId,
    [...STAGEABLE_LAUNCH_DECISION_LABELS],
    launchOperationForDecisionLabel("scale"),
    launchOperationForDecisionLabel("refresh"),
    snapshotDate,
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
    draftMode:
      row.draft_mode === "add_to_existing" || row.draft_mode === "new_campaign"
        ? row.draft_mode
        : null,
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
  operation: MetaLaunchIntentStageableOperation;
  idempotencyKey: string;
  requestPayload: Record<string, unknown>;
}): Promise<{ created: boolean; intentId: string }> {
  const result = await createMetaLaunchIntent({
    businessId: input.candidate.businessId,
    providerAccountId: input.candidate.providerAccountId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    requestPayload: input.requestPayload,
    creativeBriefId: input.candidate.briefId,
    sourceDraftId: input.candidate.draftId,
    createdBy: input.candidate.briefReviewedBy,
  });
  return { created: result.created, intentId: result.intent.id };
}
