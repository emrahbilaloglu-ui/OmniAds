/**
 * The decision -> staged launch intent producer.
 *
 * The queue's `launch` row was unreachable: its candidate query wants a
 * prepared intent carrying decision, snapshot or brief lineage, and nothing
 * wrote one. These cases pin what this producer may and may not decide on its
 * own, because the failure that would matter is not an empty queue — it is a
 * producer that invents an asset, a line of copy or a destination and stages an
 * ad nobody chose.
 *
 * The eligibility ladder runs against the REAL payload normalizer and the REAL
 * execution-bounds evaluator; only the database read, the shipped validator and
 * the store's own writer are injected, and the last two are asserted on rather
 * than reimplemented.
 */
import { describe, expect, it } from "vitest";
import { MetaLaunchIntentLineageError } from "@/lib/launchpad/meta-launch-intent-lineage";
import {
  LAUNCH_INTENT_DECISION_MAX_AGE_DAYS,
  launchIntentIdempotencyKeyForDecision,
  projectMetaLaunchIntents,
  STAGEABLE_LAUNCH_DECISION_SQL,
  type LaunchIntentProducerDeps,
  type StageableLaunchDecisionCandidate,
} from "@/lib/meta/launch-intent-producer";

const BUSINESS_ID = "9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const ACCOUNT_ID = "act_7788990011";
const REVIEWER_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e";
const SNAPSHOT_DATE = "2026-09-05";

function draftPayload(overrides: Record<string, unknown> = {}) {
  return {
    mode: "add_to_existing",
    targetCampaignId: "23847000000101",
    targetAdsetId: "23847000000202",
    copyMode: "reuse_creative",
    targets: [
      {
        targetCampaignId: "23847000000101",
        targetAdsetId: "23847000000202",
        targetAdsetName: "Broad · purchase",
      },
    ],
    creativeIds: ["23847000000303"],
    creatives: [
      { creativeId: "23847000000303", sourceAdId: "23847000000404", name: "Hero 9x16" },
    ],
    ...overrides,
  };
}

function candidate(
  overrides: Partial<StageableLaunchDecisionCandidate> = {},
): StageableLaunchDecisionCandidate {
  return {
    businessId: BUSINESS_ID,
    providerAccountId: ACCOUNT_ID,
    snapshotId: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
    snapshotAsOfDate: "2026-09-04",
    decisionId: "meta:decision:winner-1",
    creativeId: "23847000000303",
    publishedLabel: "scale",
    briefId: "6d7e8f90-a1b2-4c3d-8e4f-5a6b7c8d9e0f",
    briefStatus: "reviewed",
    briefReviewedBy: REVIEWER_ID,
    draftId: "7e8f90a1-b2c3-4d4e-8f5a-6b7c8d9e0f1a",
    draftPayload: draftPayload(),
    ...overrides,
  };
}

type StageCall = {
  candidate: StageableLaunchDecisionCandidate;
  idempotencyKey: string;
  requestPayload: Record<string, unknown>;
};

function harness(
  input: {
    candidates?: StageableLaunchDecisionCandidate[];
    mode?: "manual" | "semi_auto" | "auto";
    validation?: { ok: boolean; blockers: Array<{ code: string }> };
    stage?: LaunchIntentProducerDeps["stageIntent"];
  } = {},
) {
  const stageCalls: StageCall[] = [];
  const deps: LaunchIntentProducerDeps = {
    businessId: BUSINESS_ID,
    snapshotDate: SNAPSHOT_DATE,
    readCreativeMode: async () => input.mode ?? "semi_auto",
    listCandidates: async () => input.candidates ?? [candidate()],
    validatePayload: async () => input.validation ?? { ok: true, blockers: [] },
    stageIntent:
      input.stage
      ?? (async (call) => {
        stageCalls.push(call);
        return { created: true, intentId: `intent-${stageCalls.length}` };
      }),
  };
  return { deps, stageCalls };
}

describe("projectMetaLaunchIntents", () => {
  it("stages one intent from a reviewed decision and an operator-composed draft", async () => {
    const { deps, stageCalls } = harness();
    const result = await projectMetaLaunchIntents(deps);

    expect(result.candidates).toBe(1);
    expect(result.staged).toBe(1);
    expect(result.refusals).toEqual({});
    expect(stageCalls).toHaveLength(1);

    const staged = stageCalls[0]!;
    // The lineage the queue's candidate query requires, and the approval it
    // rests on: the brief a person reviewed, and the draft they composed.
    expect(staged.candidate.briefId).toBe(candidate().briefId);
    expect(staged.candidate.draftId).toBe(candidate().draftId);
    expect(staged.candidate.briefReviewedBy).toBe(REVIEWER_ID);
    // The destination and the asset are the draft's, unchanged.
    expect(staged.requestPayload.targetAdsetId).toBe("23847000000202");
    expect(staged.requestPayload.creativeIds).toEqual(["23847000000303"]);
    expect(staged.requestPayload.copyMode).toBe("reuse_creative");
    /*
      The authority the create path re-derives from the approving operator's
      request. The fingerprint covers it, so a stored payload without it is
      refused as a contract mismatch and the staged intent is inert.
    */
    expect(staged.requestPayload.executionAuthority).toEqual({
      actionOrigin: "launchpad_manual_v1",
      manualConfirmation: "explicit_operator_confirmation",
    });
  });

  it("derives the idempotency key from the decision, never from the payload", async () => {
    const first = harness();
    await projectMetaLaunchIntents(first.deps);
    const edited = harness({
      candidates: [
        candidate({
          // The operator renamed the ad after the first tick. Same decision.
          draftPayload: draftPayload({ names: { "23847000000303": "Hero — v2" } }),
        }),
      ],
    });
    await projectMetaLaunchIntents(edited.deps);

    expect(first.stageCalls[0]!.idempotencyKey).toBe(
      edited.stageCalls[0]!.idempotencyKey,
    );
    expect(first.stageCalls[0]!.idempotencyKey).toBe(
      launchIntentIdempotencyKeyForDecision({
        businessId: BUSINESS_ID,
        providerAccountId: ACCOUNT_ID,
        decisionId: "meta:decision:winner-1",
        snapshotId: candidate().snapshotId,
      }),
    );
    // Two decisions never share a key, so two winners never collapse into one
    // staged launch.
    expect(
      launchIntentIdempotencyKeyForDecision({
        businessId: BUSINESS_ID,
        providerAccountId: ACCOUNT_ID,
        decisionId: "meta:decision:winner-2",
        snapshotId: candidate().snapshotId,
      }),
    ).not.toBe(first.stageCalls[0]!.idempotencyKey);
  });

  it("stages nothing a second time when the store already holds the intent", async () => {
    const { deps } = harness({
      stage: async () => ({ created: false, intentId: "intent-existing" }),
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.staged).toBe(0);
    expect(result.stagedIntentIds).toEqual([]);
    expect(result.refusals).toEqual({ intent_already_staged: 1 });
  });

  it("refuses a brief nobody reviewed", async () => {
    const { deps, stageCalls } = harness({
      candidates: [candidate({ briefStatus: "draft", briefReviewedBy: null })],
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.staged).toBe(0);
    expect(result.refusals).toEqual({ creative_brief_not_reviewed: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  it("refuses when no operator has composed a launch for the decision", async () => {
    const { deps, stageCalls } = harness({
      candidates: [candidate({ draftId: null, draftPayload: null })],
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.refusals).toEqual({ launch_payload_not_composed: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  it("refuses a rebuilt creative, whose copy nobody approved", async () => {
    const { deps, stageCalls } = harness({
      candidates: [
        candidate({ draftPayload: draftPayload({ copyMode: "rebuild_creative" }) }),
      ],
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.refusals).toEqual({ copy_not_approved_for_reuse: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  it("refuses a draft that names a creative other than the decision's", async () => {
    const { deps, stageCalls } = harness({
      candidates: [
        candidate({
          draftPayload: draftPayload({
            creativeIds: ["23847000000999"],
            creatives: [
              { creativeId: "23847000000999", sourceAdId: "23847000000404" },
            ],
          }),
        }),
      ],
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.refusals).toEqual({ launch_payload_creative_mismatch: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  it("refuses a draft that names more creatives than the decision", async () => {
    const { deps } = harness({
      candidates: [
        candidate({
          draftPayload: draftPayload({
            creativeIds: ["23847000000303", "23847000000305"],
            creatives: [
              { creativeId: "23847000000303", sourceAdId: "23847000000404" },
              { creativeId: "23847000000305", sourceAdId: "23847000000405" },
            ],
          }),
        }),
      ],
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.refusals).toEqual({ launch_payload_creative_mismatch: 1 });
  });

  it("refuses a draft with no exact destination", async () => {
    const { deps, stageCalls } = harness({
      candidates: [
        candidate({
          draftPayload: draftPayload({
            targetCampaignId: "",
            targetAdsetId: "",
            targets: [],
          }),
        }),
      ],
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.refusals).toEqual({ destination_not_exact: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  it("refuses evidence older than the producer's own window", async () => {
    const { deps } = harness({
      candidates: [candidate({ snapshotAsOfDate: "2026-08-01" })],
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(LAUNCH_INTENT_DECISION_MAX_AGE_DAYS).toBe(14);
    expect(result.refusals).toEqual({ decision_evidence_stale: 1 });
  });

  it("carries the shipped validator's own refusal code", async () => {
    const { deps, stageCalls } = harness({
      validation: {
        ok: false,
        blockers: [
          { code: "target_adset_not_active" },
          { code: "creative_rejected" },
        ],
      },
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.refusals).toEqual({ target_adset_not_active: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  it("withholds a validator that could not answer at all", async () => {
    const { deps, stageCalls } = harness();
    const result = await projectMetaLaunchIntents({
      ...deps,
      validatePayload: async () => {
        throw new Error("read timed out");
      },
    });

    expect(result.refusals).toEqual({ launch_validation_unavailable: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  it("names the lineage refusal the store raised", async () => {
    const { deps } = harness({
      stage: async () => {
        throw new MetaLaunchIntentLineageError(
          "creative_brief_not_reviewed",
          "Creative Brief must be reviewed before it can become launch lineage.",
        );
      },
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.staged).toBe(0);
    expect(result.refusals).toEqual({ creative_brief_not_reviewed: 1 });
  });

  it("does not let one candidate's refusal drop the candidates behind it", async () => {
    const second = candidate({
      snapshotId: "8f90a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b",
      decisionId: "meta:decision:winner-2",
      briefId: "90a1b2c3-d4e5-4f6a-8b7c-8d9e0f1a2b3c",
    });
    let calls = 0;
    const { deps } = harness({
      candidates: [candidate(), second],
      stage: async (call) => {
        calls += 1;
        if (calls === 1) throw new Error("conflict");
        return { created: true, intentId: `intent-${call.candidate.snapshotId}` };
      },
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.candidates).toBe(2);
    expect(result.staged).toBe(1);
    expect(result.stagedIntentIds).toEqual([`intent-${second.snapshotId}`]);
    expect(result.refusals).toEqual({ launch_intent_stage_failed: 1 });
  });

  it("stages nothing under the manual creative mode", async () => {
    const { deps, stageCalls } = harness({ mode: "manual" });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.candidates).toBe(0);
    expect(result.refusals).toEqual({ creative_mode_manual: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  /*
    The unattended arm reads the stored `executionAuthority` as EVIDENCE that an
    operator confirmed this exact provider write. This producer cannot give that
    confirmation, so it withholds rather than leaving a value that would be read
    as one — the whole point of `storedLaunchExecutionAuthority`.
  */
  it("stages nothing under the auto creative mode, where nobody would confirm the create", async () => {
    const { deps, stageCalls } = harness({ mode: "auto" });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.staged).toBe(0);
    expect(result.refusals).toEqual({
      creative_mode_auto_operator_staging_required: 1,
    });
    expect(stageCalls).toHaveLength(0);
  });

  /*
    Read from the SQL rather than asserted about it in prose: a candidate query
    that lost either predicate would stage a second intent for a decision that
    already has one, or would stage from a decision the engine itself blocked.
  */
  it("selects only unblocked scale decisions that have no intent yet", () => {
    expect(STAGEABLE_LAUNCH_DECISION_SQL).toContain("s.label = 'scale'");
    expect(STAGEABLE_LAUNCH_DECISION_SQL).toContain("s.authority_blocker IS NULL");
    expect(STAGEABLE_LAUNCH_DECISION_SQL).toContain(
      "i.source_decision_snapshot_id = s.id",
    );
    expect(STAGEABLE_LAUNCH_DECISION_SQL).toContain(
      "d.payload_json -> 'creativeIds' = jsonb_build_array(s.creative_id)",
    );
  });
});
