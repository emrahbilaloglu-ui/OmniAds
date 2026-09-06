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
  launchOperationForDecisionLabel,
  projectMetaLaunchIntents,
  STAGEABLE_LAUNCH_DECISION_LABELS,
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
    draftMode: "add_to_existing",
    ...overrides,
  };
}

/**
 * The other half of the accepted matrix: the test launch a `refresh` maps to.
 *
 * Everything in it is the operator's — the campaign they named, the budget they
 * set, the ad set they built with its pixel, country, age range and click
 * attribution. The producer adds none of it.
 */
function launchDraftPayload(overrides: Record<string, unknown> = {}) {
  return {
    mode: "new_campaign",
    currencyCode: "USD",
    campaign: { name: "Test · winner refresh" },
    budget: {
      mode: "CBO",
      amountMinor: 5000,
      currency: "USD",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    },
    creativeIds: ["23847000000303"],
    creatives: [{ creativeId: "23847000000303", sourceAdId: "23847000000404" }],
    adSets: [
      {
        clientId: "adset-1",
        name: "Broad · test",
        optimizationGoal: "OFFSITE_CONVERSIONS",
        pixelId: "555000111",
        customEventType: "PURCHASE",
        targeting: { countries: ["US"], ageMin: 18, ageMax: 65 },
        attributionSpec: [{ eventType: "CLICK_THROUGH", windowDays: 7 }],
      },
    ],
    ...overrides,
  };
}

function launchCandidate(
  overrides: Partial<StageableLaunchDecisionCandidate> = {},
): StageableLaunchDecisionCandidate {
  return candidate({
    snapshotId: "2b3c4d5e-6f7a-4b8c-8d9e-0f1a2b3c4d5e",
    decisionId: "meta:decision:refresh-1",
    briefId: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    publishedLabel: "refresh",
    draftPayload: launchDraftPayload(),
    draftMode: "new_campaign",
    ...overrides,
  });
}

type StageCall = {
  candidate: StageableLaunchDecisionCandidate;
  operation: "add_to_existing" | "new_campaign";
  idempotencyKey: string;
  requestPayload: Record<string, unknown>;
};

function harness(
  input: {
    candidates?: StageableLaunchDecisionCandidate[];
    mode?: "manual" | "semi_auto" | "auto";
    validation?: { ok: boolean; blockers: Array<{ code: string }> };
    launchValidation?: { ok: boolean; blockers: Array<{ code: string }> };
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
    validateLaunchPayload: async () =>
      input.launchValidation ?? { ok: true, blockers: [] },
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
    expect(staged.operation).toBe("add_to_existing");
    /*
      This producer's OWN authority, and never the operator's.

      Nobody pressed anything when it ran. Storing
      `explicit_operator_confirmation` here would be a claim the unattended arm
      reads as proof that somebody confirmed this exact provider write, so the
      pair it binds says what is true instead: a reviewed decision was staged.
    */
    expect(staged.requestPayload.executionAuthority).toEqual({
      actionOrigin: "launchpad_decision_staged_v1",
      manualConfirmation: "decision_staged_approval",
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

  it("refuses a future decision before validation or intent staging", async () => {
    const { deps, stageCalls } = harness({
      candidates: [candidate({ snapshotAsOfDate: "2026-09-06" })],
    });
    let validations = 0;
    deps.validatePayload = async () => {
      validations += 1;
      return { ok: true, blockers: [] };
    };
    const result = await projectMetaLaunchIntents(deps);
    expect(result.refusals).toEqual({ decision_evidence_in_future: 1 });
    expect(validations).toBe(0);
    expect(stageCalls).toHaveLength(0);
  });

  it.each(["2026-09-05", "2026-09-04", "2026-08-22"])(
    "stages evidence on or before the snapshot within the inclusive 14-day window: %s",
    async (snapshotAsOfDate) => {
      const { deps, stageCalls } = harness({
        candidates: [candidate({ snapshotAsOfDate })],
      });
      const result = await projectMetaLaunchIntents(deps);
      expect(result.refusals).toEqual({});
      expect(stageCalls).toHaveLength(1);
    },
  );

  it("refuses evidence one day beyond the lower window boundary", async () => {
    const { deps, stageCalls } = harness({
      candidates: [candidate({ snapshotAsOfDate: "2026-08-21" })],
    });
    const result = await projectMetaLaunchIntents(deps);
    expect(result.refusals).toEqual({ decision_evidence_stale: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  it("does not normalize an impossible evidence date into the valid window", async () => {
    const { deps, stageCalls } = harness({
      candidates: [candidate({ snapshotAsOfDate: "2026-02-30" })],
    });
    deps.snapshotDate = "2026-03-03";
    const result = await projectMetaLaunchIntents(deps);
    expect(result.refusals).toEqual({ decision_evidence_stale: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  it.each(["2026-02-30", "2026-9-05", "2026-09-05T00:00:00Z"])(
    "refuses an invalid snapshot calendar date before reading candidates: %s",
    async (snapshotDate) => {
      const { deps, stageCalls } = harness();
      deps.snapshotDate = snapshotDate;
      deps.listCandidates = async () => { throw new Error("must not read candidates"); };
      const result = await projectMetaLaunchIntents(deps);
      expect(result.refusals).toEqual({ snapshot_date_invalid: 1 });
      expect(stageCalls).toHaveLength(0);
    },
  );

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
    The `auto` arm, which used to refuse every run as
    `creative_mode_auto_operator_staging_required`.

    It refused because the only authority a stored payload could carry said an
    operator had confirmed the write, and a background producer cannot say that.
    The staged authority is what makes this honest rather than what makes it
    pass: the payload now says a reviewed decision was staged, which is exactly
    what happened, and the unattended arm journals itself separately on top.
  */
  it("stages under the auto creative mode, carrying the staged authority", async () => {
    const { deps, stageCalls } = harness({ mode: "auto" });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.staged).toBe(1);
    expect(result.refusals).toEqual({});
    expect(stageCalls).toHaveLength(1);
    expect(stageCalls[0]!.requestPayload.executionAuthority).toEqual({
      actionOrigin: "launchpad_decision_staged_v1",
      manualConfirmation: "decision_staged_approval",
    });
  });

  /*
    The value does not depend on the mode at staging time, and that is the
    point. An intent staged under `semi_auto` and swept after somebody moved the
    family to `auto` must not arrive at the unattended arm carrying a
    confirmation nobody gave.
  */
  it("binds the same staged authority in semi_auto and auto", async () => {
    const semi = harness({ mode: "semi_auto" });
    await projectMetaLaunchIntents(semi.deps);
    const auto = harness({ mode: "auto" });
    await projectMetaLaunchIntents(auto.deps);

    expect(semi.stageCalls[0]!.requestPayload.executionAuthority).toEqual(
      auto.stageCalls[0]!.requestPayload.executionAuthority,
    );
  });

  // ---------------------------------------------------------------------
  // The test launch — the third case in the accepted creative matrix.
  // ---------------------------------------------------------------------

  it("stages a new-campaign test launch from a refresh decision", async () => {
    const { deps, stageCalls } = harness({
      mode: "auto",
      candidates: [launchCandidate()],
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.staged).toBe(1);
    expect(result.refusals).toEqual({});
    expect(stageCalls[0]!.operation).toBe("new_campaign");
    // The operator's own campaign and ad set, not one composed here.
    expect(
      (stageCalls[0]!.requestPayload.campaign as { name: string }).name,
    ).toBe("Test · winner refresh");
    expect(
      (stageCalls[0]!.requestPayload.adSets as Array<{ name: string }>).map(
        (adSet) => adSet.name,
      ),
    ).toEqual(["Broad · test"]);
    expect(stageCalls[0]!.requestPayload.creativeIds).toEqual([
      "23847000000303",
    ]);
    expect(stageCalls[0]!.requestPayload.executionAuthority).toEqual({
      actionOrigin: "launchpad_decision_staged_v1",
      manualConfirmation: "decision_staged_approval",
    });
  });

  it("refuses a test launch whose draft names a different creative", async () => {
    const { deps, stageCalls } = harness({
      candidates: [
        launchCandidate({
          draftPayload: launchDraftPayload({
            creativeIds: ["23847000000999"],
            creatives: [{ creativeId: "23847000000999" }],
          }),
        }),
      ],
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.refusals).toEqual({ launch_payload_creative_mismatch: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  it("refuses a test launch nobody has composed a campaign for", async () => {
    const { deps, stageCalls } = harness({
      candidates: [
        launchCandidate({
          draftPayload: launchDraftPayload({ campaign: { name: "" }, adSets: [] }),
        }),
      ],
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.refusals).toEqual({ destination_not_exact: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  it("carries the new-campaign validator's own refusal code", async () => {
    const { deps, stageCalls } = harness({
      candidates: [launchCandidate()],
      launchValidation: {
        ok: false,
        blockers: [{ code: "pixel_not_active" }],
      },
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.refusals).toEqual({ pixel_not_active: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  it("refuses a draft composed for the other kind of launch", async () => {
    const { deps, stageCalls } = harness({
      // A `refresh` decision whose only draft is a creative-reuse one. The SQL
      // would not have matched it; an injected candidate still must not stage.
      candidates: [launchCandidate({ draftMode: "add_to_existing" })],
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(result.refusals).toEqual({ launch_payload_mode_mismatch: 1 });
    expect(stageCalls).toHaveLength(0);
  });

  it("refuses a label the shipped Launchpad map gives no destination", async () => {
    const { deps, stageCalls } = harness({
      candidates: [candidate({ publishedLabel: "cut" })],
    });
    const result = await projectMetaLaunchIntents(deps);

    expect(launchOperationForDecisionLabel("cut")).toBeNull();
    expect(result.refusals).toEqual({
      decision_label_has_no_launch_destination: 1,
    });
    expect(stageCalls).toHaveLength(0);
  });

  /*
    Read from the SQL rather than asserted about it in prose: a candidate query
    that lost either predicate would stage a second intent for a decision that
    already has one, or would stage from a decision the engine itself blocked.
  */
  it("selects only unblocked, launchable decisions that have no intent yet", () => {
    expect(STAGEABLE_LAUNCH_DECISION_SQL).toContain("s.label = ANY($2::text[])");
    expect(STAGEABLE_LAUNCH_DECISION_SQL).toContain("s.authority_blocker IS NULL");
    expect(STAGEABLE_LAUNCH_DECISION_SQL).toContain(
      "i.source_decision_snapshot_id = s.id",
    );
    expect(STAGEABLE_LAUNCH_DECISION_SQL).toContain(
      "d.payload_json -> 'creativeIds' = jsonb_build_array(s.creative_id)",
    );
    // The label list and the required draft mode both come from the shipped
    // map, so a `cut` can never be a candidate and a reuse draft can never
    // satisfy a refresh.
    expect([...STAGEABLE_LAUNCH_DECISION_LABELS]).toEqual(["scale", "refresh"]);
    expect(launchOperationForDecisionLabel("scale")).toBe("add_to_existing");
    expect(launchOperationForDecisionLabel("refresh")).toBe("new_campaign");
  });
});
