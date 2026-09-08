/*
  Prior-epoch read compatibility.

  The native ad producer epoch moved from
  `v3-ad-2026-07-18-decision-presentation-hardening-shadow` to
  `v3-ad-2026-09-07-held-verdict-authority-shadow`, and the single frozen
  acceptance fixture was rewritten in place at that move. That left the
  repository with evidence for exactly one epoch and no test that rows written
  under the previous one still read correctly.

  This file is the compatibility half. It answers a different question from
  `native-ad-frozen-exact-replay.test.ts`:

    acceptance  - does the CURRENT producer still emit the CURRENT frozen
                  outputs?
    this file   - is a row written under the PREVIOUS epoch still readable, and
                  is it REFUSED by current logic rather than reinterpreted
                  under current semantics?

  Neither weakens the other. The acceptance fixture is asserted here only to
  prove the two frozen artifacts are distinguishable by epoch key; its
  expectations are owned by the acceptance test.

  Each fail-closed proof below is a paired observation: the same object is
  offered twice, differing in the epoch key alone, and the test records what
  production actually does in both directions rather than asserting a property
  in the abstract.
*/
import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db";
import {
  assertExactMetaAdsActionReceiptForEpisode,
  buildAdRecommendationEpisode,
  buildAdRecommendationEpisodeKey,
  buildExactMetaAdsActionReceiptHash,
  type AdRecommendationEpisode,
  type ExactMetaAdsActionLineage,
} from "../../ad-operator-response-detection";
import { CANONICAL_EVALUATION_CONTRACT_VERSION } from "../../canonical-evaluation";
import {
  READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY,
  adDecisionStabilityKey,
  applyLabelHysteresis,
  readPreviousPublishedAdLabels,
  type PreviousAdPublishedLabel,
} from "../../decision-stability";
import {
  AD_DECISION_EVALUATION_CONTRACT_VERSION,
  assertAdCanonicalEvaluationProvenance,
  type AdCanonicalEvaluationProvenance,
} from "../../evaluation-store";
import { DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION } from "../../execution-safety";
import { ENGINE_VERSION, NATIVE_AD_ENGINE_VERSION } from "../../types";
import currentEpochRawFixture from "../fixtures/native-ad-frozen-exact-replay.v1.json";
import priorEpochRawFixture from "../fixtures/native-ad-frozen-exact-replay.prior-epoch.v1.json";

/*
  The prior epoch's four version keys. Each was read out of the same revision
  the prior-epoch fixture body was recovered from
  (31950b1a99d38271921e46ae9daa346ab68a9002):

    git show <rev>:lib/creative-decision-engine/types.ts
    git show <rev>:lib/creative-decision-engine/canonical-evaluation.ts
    git show <rev>:lib/creative-decision-engine/evaluation-store.ts

  They are literals here on purpose. A constant imported from source would move
  with the source and stop being evidence of anything.
*/
const PRIOR_ENGINE_VERSION = "v3-2026-07-18-decision-presentation-hardening";
const PRIOR_NATIVE_AD_ENGINE_VERSION =
  "v3-ad-2026-07-18-decision-presentation-hardening-shadow";
const PRIOR_CANONICAL_EVALUATION_CONTRACT_VERSION =
  "engine-v3-canonical-evaluation.v5";
const PRIOR_AD_DECISION_EVALUATION_CONTRACT_VERSION =
  "engine-v3-canonical-ad-evaluation.v7";

interface FrozenEpochFixture {
  contractVersion: string;
  engineVersion: string;
  priorEpoch?: {
    recoveredFromRevision: string;
    recoveryCommand: string;
    recoveredBodyCarriedNoEpochKey: boolean;
    engineVersion: string;
    nativeAdEngineVersion: string;
    canonicalEvaluationContractVersion: string;
    adDecisionEvaluationContractVersion: string;
  };
  archetypes: {
    belowBreakEvenLoss: {
      adId: string;
      expected: Record<string, unknown>;
    };
    scaleRefreshIsolation: {
      nativeScaleCandidate: { adId: string; expected: Record<string, unknown> };
      nativeRefreshCandidate: {
        adId: string;
        expected: Record<string, unknown>;
      };
    };
  };
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  firstAsOfDate: string;
  confirmationAsOfDate: string;
}

const priorFixture = priorEpochRawFixture as unknown as FrozenEpochFixture;
const currentFixture = currentEpochRawFixture as unknown as FrozenEpochFixture;

/**
 * The admission rule the acceptance replay applies to its fixture: a frozen
 * acceptance artifact is only usable if it was frozen under the epoch that is
 * running now. Reading a prior-epoch artifact as if it were current is the
 * exact silent recomputation this file exists to forbid.
 */
function admitAsCurrentEpochAcceptanceFixture(
  candidate: FrozenEpochFixture,
): FrozenEpochFixture {
  if (candidate.engineVersion !== NATIVE_AD_ENGINE_VERSION) {
    throw new TypeError(
      `Frozen acceptance fixture belongs to epoch ${candidate.engineVersion}, not ${NATIVE_AD_ENGINE_VERSION}.`,
    );
  }
  return candidate;
}

/** Prior-epoch artifacts stay readable, but only under their own epoch key. */
function readPriorEpochFixture(
  candidate: FrozenEpochFixture,
): FrozenEpochFixture {
  if (candidate.engineVersion !== PRIOR_NATIVE_AD_ENGINE_VERSION) {
    throw new TypeError(
      `Prior-epoch fixture must be stamped ${PRIOR_NATIVE_AD_ENGINE_VERSION}, got ${candidate.engineVersion}.`,
    );
  }
  return candidate;
}

describe("prior-epoch frozen evidence is distinguishable from the current epoch", () => {
  it("stamps the two frozen artifacts with different producer epochs", () => {
    expect(priorFixture.engineVersion).toBe(PRIOR_NATIVE_AD_ENGINE_VERSION);
    expect(currentFixture.engineVersion).toBe(NATIVE_AD_ENGINE_VERSION);
    expect(priorFixture.engineVersion).not.toBe(currentFixture.engineVersion);

    // All four prior keys really are prior: none of them is the running value.
    expect(PRIOR_ENGINE_VERSION).not.toBe(ENGINE_VERSION);
    expect(PRIOR_NATIVE_AD_ENGINE_VERSION).not.toBe(NATIVE_AD_ENGINE_VERSION);
    expect(PRIOR_CANONICAL_EVALUATION_CONTRACT_VERSION).not.toBe(
      CANONICAL_EVALUATION_CONTRACT_VERSION,
    );
    expect(PRIOR_AD_DECISION_EVALUATION_CONTRACT_VERSION).not.toBe(
      AD_DECISION_EVALUATION_CONTRACT_VERSION,
    );
  });

  it("carries the recovery provenance of the prior-epoch body", () => {
    // The body was recovered from git, not hand-authored. The revision below
    // is the only revision that has ever tracked the acceptance fixture.
    expect(priorFixture.priorEpoch).toMatchObject({
      recoveredFromRevision: "31950b1a99d38271921e46ae9daa346ab68a9002",
      recoveredBodyCarriedNoEpochKey: true,
      engineVersion: PRIOR_ENGINE_VERSION,
      nativeAdEngineVersion: PRIOR_NATIVE_AD_ENGINE_VERSION,
      canonicalEvaluationContractVersion:
        PRIOR_CANONICAL_EVALUATION_CONTRACT_VERSION,
      adDecisionEvaluationContractVersion:
        PRIOR_AD_DECISION_EVALUATION_CONTRACT_VERSION,
    });
    expect(currentFixture.priorEpoch).toBeUndefined();
  });

  it("refuses to read the prior-epoch artifact as current acceptance evidence", () => {
    // Guard on: the prior artifact is refused, by epoch key alone.
    expect(() => admitAsCurrentEpochAcceptanceFixture(priorFixture)).toThrow(
      `Frozen acceptance fixture belongs to epoch ${PRIOR_NATIVE_AD_ENGINE_VERSION}, not ${NATIVE_AD_ENGINE_VERSION}.`,
    );
    // Control: the current artifact passes the same gate untouched.
    expect(admitAsCurrentEpochAcceptanceFixture(currentFixture)).toBe(
      currentFixture,
    );
    // And the prior artifact stays readable under its OWN key.
    expect(readPriorEpochFixture(priorFixture)).toBe(priorFixture);
    expect(() => readPriorEpochFixture(currentFixture)).toThrow(
      `Prior-epoch fixture must be stamped ${PRIOR_NATIVE_AD_ENGINE_VERSION}`,
    );
  });

  it("records the verdict-authority expectations that actually moved between the epochs", () => {
    /*
      This is why the prior artifact is evidence and not a duplicate. Under the
      prior epoch a near-scale ad published `keep` with nothing blocked; under
      the current epoch the same archetype publishes `keep` but records the
      withheld hard action and the authority that withheld it. The current
      column is proven against live production by the acceptance replay in
      native-ad-frozen-exact-replay.test.ts, which is why it is safe to read it
      here as "what current semantics produce".
    */
    const priorScale =
      priorFixture.archetypes.scaleRefreshIsolation.nativeScaleCandidate
        .expected;
    const currentScale =
      currentFixture.archetypes.scaleRefreshIsolation.nativeScaleCandidate
        .expected;
    expect(priorScale.blockedActionType).toBeNull();
    expect(currentScale.blockedActionType).toBe("scale");
    expect(priorScale.authorityBlocker).toBeUndefined();
    expect(currentScale.authorityBlocker).toBe(
      "profile_hard_action_ineligible",
    );
    expect(priorScale.preAuthorityLabel).toBeUndefined();
    expect(currentScale.preAuthorityLabel).toBe("scale");

    const priorRefresh =
      priorFixture.archetypes.scaleRefreshIsolation.nativeRefreshCandidate
        .expected;
    const currentRefresh =
      currentFixture.archetypes.scaleRefreshIsolation.nativeRefreshCandidate
        .expected;
    expect(priorRefresh.preAuthorityLabel).toBe("keep");
    expect(currentRefresh.preAuthorityLabel).toBe("refresh");
    expect(priorRefresh.blockedActionType).toBeNull();
    expect(currentRefresh.blockedActionType).toBe("refresh");

    // Unchanged across the move: the below-break-even confirmation ladder. A
    // prior-epoch row is not uniformly stale, which is exactly why the epoch
    // key rather than the payload has to decide admission.
    expect(priorFixture.archetypes.belowBreakEvenLoss.expected).toEqual(
      currentFixture.archetypes.belowBreakEvenLoss.expected,
    );
  });
});

/*
  Hysteresis read boundary.

  In production, the prior-label map that `computeNativeAdDecisions` consumes
  is built from `readPreviousPublishedAdLabels` and from nothing else:
  runAdDecisionsJob in lib/creative-decision-engine/jobs/ad-decisions-job.ts
  seeds an empty Map and merges only that call's results into it. So that
  reader's epoch guard - the SQL predicate `AND snapshot.engine_version = $2`,
  bound to NATIVE_AD_ENGINE_VERSION - is the whole of the epoch defence on the
  hysteresis path. The fake below models that predicate so the guard
  can be switched off and the difference observed.
*/
const HYSTERESIS_BUSINESS_ID = priorFixture.businessId;
const HYSTERESIS_ACCOUNT_REF_ID = priorFixture.providerAccountRefId;
const HYSTERESIS_ACCOUNT_ID = priorFixture.providerAccountId;
const HYSTERESIS_AD_ID = priorFixture.archetypes.belowBreakEvenLoss.adId;

interface SnapshotRow {
  source_snapshot_id: string;
  provider_account_ref_id: string;
  provider_account_id: string;
  decision_entity_type: "ad";
  decision_entity_id: string;
  source_as_of_date: string;
  source_computed_at: string;
  source_engine_version: string;
  label: string;
  raw_label: string;
  source_evaluation_id: string;
  source_input_hash: string;
  source_decision_hash: string;
}

/**
 * One identity, two rows: yesterday's confirmed `cut` written under the prior
 * epoch, and an older `keep` written under the current epoch. The prior-epoch
 * row is the newer of the two, so if it is admitted at all it wins the
 * query's DISTINCT ON and becomes today's hysteresis memory.
 */
const SNAPSHOT_TABLE: readonly SnapshotRow[] = [
  {
    source_snapshot_id: "00000000-0000-4000-8000-000000000901",
    provider_account_ref_id: HYSTERESIS_ACCOUNT_REF_ID,
    provider_account_id: HYSTERESIS_ACCOUNT_ID,
    decision_entity_type: "ad",
    decision_entity_id: HYSTERESIS_AD_ID,
    source_as_of_date: priorFixture.firstAsOfDate,
    source_computed_at: `${priorFixture.firstAsOfDate}T03:10:00.000Z`,
    source_engine_version: PRIOR_NATIVE_AD_ENGINE_VERSION,
    label: "cut",
    raw_label: "cut",
    source_evaluation_id: "00000000-0000-4000-8000-000000000902",
    source_input_hash: "a".repeat(64),
    source_decision_hash: "b".repeat(64),
  },
  {
    source_snapshot_id: "00000000-0000-4000-8000-000000000903",
    provider_account_ref_id: HYSTERESIS_ACCOUNT_REF_ID,
    provider_account_id: HYSTERESIS_ACCOUNT_ID,
    decision_entity_type: "ad",
    decision_entity_id: HYSTERESIS_AD_ID,
    source_as_of_date: "2026-07-01",
    source_computed_at: "2026-07-01T03:10:00.000Z",
    source_engine_version: NATIVE_AD_ENGINE_VERSION,
    label: "keep",
    raw_label: "keep",
    source_evaluation_id: "00000000-0000-4000-8000-000000000904",
    source_input_hash: "c".repeat(64),
    source_decision_hash: "d".repeat(64),
  },
];

/*
  The guard, read off production rather than assumed. The fake below applies
  the epoch filter only when the real query still carries the predicate, so
  deleting `AND snapshot.engine_version = $2` from decision-stability.ts makes
  the guarded assertions in this file observe the unguarded result and fail.
*/
const SQL_BINDS_EPOCH = /AND\s+snapshot\.engine_version\s*=\s*\$2/.test(
  READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY,
);

/**
 * Executes READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY against SNAPSHOT_TABLE.
 * `applyEpochPredicate: false` is the guard-disabled arm: every other clause of
 * the real query still runs, so the only thing removed is the epoch filter.
 */
function fakeSnapshotDb(options: { applyEpochPredicate: boolean }) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql !== READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY) {
      throw new Error("Fake snapshot table received an unexpected query.");
    }
    const engineVersion = String(params?.[1]);
    const identities = JSON.parse(String(params?.[2])) as Array<{
      provider_account_ref_id: string;
      provider_account_id: string;
      decision_entity_type: string;
      decision_entity_id: string;
    }>;
    const asOf = String(params?.[3]);
    const matched = SNAPSHOT_TABLE.filter(
      (row) =>
        identities.some(
          (identity) =>
            identity.provider_account_ref_id === row.provider_account_ref_id &&
            identity.provider_account_id === row.provider_account_id &&
            identity.decision_entity_type === row.decision_entity_type &&
            identity.decision_entity_id === row.decision_entity_id,
        ) &&
        row.source_as_of_date < asOf &&
        (!options.applyEpochPredicate ||
          row.source_engine_version === engineVersion),
    );
    // DISTINCT ON (identity) ... ORDER BY as_of_date DESC, computed_at DESC.
    const winners = new Map<string, SnapshotRow>();
    for (const row of [...matched].sort((left, right) =>
      right.source_as_of_date.localeCompare(left.source_as_of_date),
    )) {
      const key = `${row.provider_account_ref_id}:${row.provider_account_id}:${row.decision_entity_id}`;
      if (!winners.has(key)) winners.set(key, row);
    }
    return [...winners.values()];
  });
  return {
    db: Object.assign(vi.fn(), { query }) as unknown as DbClient,
    query,
  };
}

async function readPriorLabel(options: {
  applyEpochPredicate: boolean;
}): Promise<PreviousAdPublishedLabel | null> {
  const { db, query } = fakeSnapshotDb(options);
  const result = await readPreviousPublishedAdLabels(
    {
      businessId: HYSTERESIS_BUSINESS_ID,
      asOf: priorFixture.confirmationAsOfDate,
      identities: [
        {
          providerAccountRefId: HYSTERESIS_ACCOUNT_REF_ID,
          providerAccountId: HYSTERESIS_ACCOUNT_ID,
          decisionEntityType: "ad",
          decisionEntityId: HYSTERESIS_AD_ID,
        },
      ],
      scopeType: "account",
      scopeId: HYSTERESIS_ACCOUNT_ID,
    },
    db,
  );
  expect(query).toHaveBeenCalledTimes(1);
  return (
    result.get(
      adDecisionStabilityKey({
        businessId: HYSTERESIS_BUSINESS_ID,
        providerAccountRefId: HYSTERESIS_ACCOUNT_REF_ID,
        providerAccountId: HYSTERESIS_ACCOUNT_ID,
        decisionEntityType: "ad",
        decisionEntityId: HYSTERESIS_AD_ID,
        scopeType: "account",
        scopeId: HYSTERESIS_ACCOUNT_ID,
      }),
    ) ?? null
  );
}

describe("prior-epoch hysteresis rows are refused, not reinterpreted", () => {
  it("binds the running native epoch into the snapshot read", () => {
    expect(SQL_BINDS_EPOCH).toBe(true);
    expect(READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY).toContain(
      "AND evaluation.engine_version = snapshot.engine_version",
    );
    const { db, query } = fakeSnapshotDb({
      applyEpochPredicate: SQL_BINDS_EPOCH,
    });
    return readPreviousPublishedAdLabels(
      {
        businessId: HYSTERESIS_BUSINESS_ID,
        asOf: priorFixture.confirmationAsOfDate,
        identities: [
          {
            providerAccountRefId: HYSTERESIS_ACCOUNT_REF_ID,
            providerAccountId: HYSTERESIS_ACCOUNT_ID,
            decisionEntityType: "ad",
            decisionEntityId: HYSTERESIS_AD_ID,
          },
        ],
        scopeType: "account",
        scopeId: HYSTERESIS_ACCOUNT_ID,
      },
      db,
    ).then(() => {
      expect(query.mock.calls[0]?.[1]?.[1]).toBe(NATIVE_AD_ENGINE_VERSION);
      expect(query.mock.calls[0]?.[1]?.[1]).not.toBe(
        PRIOR_NATIVE_AD_ENGINE_VERSION,
      );
    });
  });

  it("does not serve the prior-epoch row to the current epoch's hysteresis", async () => {
    const served = await readPriorLabel({
      applyEpochPredicate: SQL_BINDS_EPOCH,
    });
    // The prior-epoch `cut` is the newest row for this identity and still
    // loses: the current-epoch `keep` is what the current epoch sees.
    expect(served).not.toBeNull();
    expect(served?.sourceEngineVersion).toBe(NATIVE_AD_ENGINE_VERSION);
    expect(served?.publishedLabel).toBe("keep");
    expect(served?.sourceSnapshotId).toBe(
      "00000000-0000-4000-8000-000000000903",
    );
  });

  it("serves the prior-epoch row under its ORIGINAL version key when it is read at all", async () => {
    // Guard disabled: the reader itself performs no epoch check, so the row
    // comes back. What it does NOT do is restamp it - the row is served under
    // the epoch that wrote it, so downstream provenance can still tell the two
    // apart. This is the "remains readable" half of the contract.
    const served = await readPriorLabel({ applyEpochPredicate: false });
    expect(served).not.toBeNull();
    expect(served?.sourceEngineVersion).toBe(PRIOR_NATIVE_AD_ENGINE_VERSION);
    expect(served?.sourceEngineVersion).not.toBe(NATIVE_AD_ENGINE_VERSION);
    expect(served?.publishedLabel).toBe("cut");
    expect(served?.sourceSnapshotId).toBe(
      "00000000-0000-4000-8000-000000000901",
    );
  });

  it("shows the hard action the epoch predicate is preventing", async () => {
    /*
      The consequence, observed rather than asserted. `applyLabelHysteresis` is
      the current semantics that consume a prior row, and it has no epoch input
      at all - `PreviousPublishedLabel` carries only labels. So the epoch
      predicate in the SQL is the entire defence.

      Guard on : today's raw `cut` meets a current-epoch `keep`, so the hard
                 action is withheld for one more evaluation - fail closed.
      Guard off : today's raw `cut` meets the prior-epoch `cut` and is published
                 immediately, on the strength of a row the current epoch never
                 produced.
    */
    const guarded = await readPriorLabel({
      applyEpochPredicate: SQL_BINDS_EPOCH,
    });
    const unguarded = await readPriorLabel({ applyEpochPredicate: false });

    expect(applyLabelHysteresis("cut", guarded)).toEqual({
      publishedLabel: "keep",
      rawLabel: "cut",
      suppressed: true,
    });
    expect(applyLabelHysteresis("cut", unguarded)).toEqual({
      publishedLabel: "cut",
      rawLabel: "cut",
      suppressed: false,
    });
  });
});

/*
  Operator-response episode lineage.

  This is the surface where a prior-epoch row is genuinely handed to current
  logic: a stored action receipt is matched against a recommendation episode
  before any operator response is attributed. Both halves carry an engine
  version, and both are checked against the running epoch.
*/
const EPISODE_RECOMMENDED_AT = `${priorFixture.confirmationAsOfDate}T03:00:00.000Z`;

function makeEpisode(engineVersion: string): AdRecommendationEpisode {
  return buildAdRecommendationEpisode({
    businessId: HYSTERESIS_BUSINESS_ID,
    businessDisplayId: HYSTERESIS_BUSINESS_ID,
    providerAccountRefId: HYSTERESIS_ACCOUNT_REF_ID,
    providerAccountId: HYSTERESIS_ACCOUNT_ID,
    adId: HYSTERESIS_AD_ID,
    creativeId: "creative-anonymous-loss",
    asOfDate: priorFixture.confirmationAsOfDate,
    engineVersion,
    scopeType: "account",
    scopeId: HYSTERESIS_ACCOUNT_ID,
    snapshotId: "00000000-0000-4000-8000-000000000901",
    evaluationId: "00000000-0000-4000-8000-000000000902",
    inputHash: "a".repeat(64),
    decisionHash: "b".repeat(64),
    decisionLabel: "cut",
    sourceCampaignId: "campaign-anonymous-loss",
    sourceAdsetId: "adset-anonymous-loss",
    recommendedAt: EPISODE_RECOMMENDED_AT,
  });
}

function makeReceipt(
  episode: AdRecommendationEpisode,
  sourceEngineVersion: string,
): ExactMetaAdsActionLineage {
  const receipt: Omit<ExactMetaAdsActionLineage, "receiptHash"> = {
    receiptId: "receipt-prior-epoch",
    actionLogId: "log-prior-epoch",
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: episode.businessId,
    providerAccountRefId: episode.providerAccountRefId,
    providerAccountId: episode.providerAccountId,
    sourceAdId: episode.adId,
    sourceSnapshotId: episode.snapshotId,
    sourceEvaluationId: episode.evaluationId,
    sourceEngineVersion,
    sourceDecisionHash: episode.decisionHash,
    targetEntityType: "ad",
    targetEntityId: episode.adId,
    action: "pause",
    successorKind: null,
    resultingAdId: null,
    idempotencyKey: "idem-prior-epoch",
    status: "success",
    dryRun: false,
    providerVerified: true,
    requestedAt: `${priorFixture.confirmationAsOfDate}T04:00:00.000Z`,
    verifiedAt: `${priorFixture.confirmationAsOfDate}T04:01:00.000Z`,
    finalizedAt: `${priorFixture.confirmationAsOfDate}T04:02:00.000Z`,
    capturedAt: `${priorFixture.confirmationAsOfDate}T04:03:00.000Z`,
    verificationEntityId: episode.adId,
    verificationStatus: "PAUSED",
    verificationLineage: {
      sourceCreativeId: episode.creativeId,
      sourceCampaignId: episode.sourceCampaignId,
      sourceAdsetId: episode.sourceAdsetId,
      verifiedProviderAccountId: episode.providerAccountId,
      verifiedCreativeId: episode.creativeId,
      verifiedCampaignId: episode.sourceCampaignId,
      verifiedAdsetId: episode.sourceAdsetId,
    },
  };
  // The hash is taken by the current hasher over this exact field set, so the
  // receipt's own integrity check passes either way. The epoch key is the only
  // thing that can be wrong with it.
  return { ...receipt, receiptHash: buildExactMetaAdsActionReceiptHash(receipt) };
}

describe("prior-epoch action lineage is refused by current episode logic", () => {
  it("will not mint an episode key for a prior-epoch row", () => {
    expect(() => makeEpisode(PRIOR_NATIVE_AD_ENGINE_VERSION)).toThrow(
      `engineVersion must equal the native ad epoch ${NATIVE_AD_ENGINE_VERSION}.`,
    );
    // Control: the same call at the running epoch succeeds.
    const current = makeEpisode(NATIVE_AD_ENGINE_VERSION);
    expect(current.engineVersion).toBe(NATIVE_AD_ENGINE_VERSION);
    expect(current.episodeKey).toBe(buildAdRecommendationEpisodeKey(current));
  });

  it("refuses a forged prior-epoch episode that bypassed the builder", () => {
    /*
      The builder is not the only way to reach the assertion, so
      assertExactMetaAdsActionReceiptForEpisode re-derives the episode key
      through buildAdRecommendationEpisodeKey - and that re-derivation hits the
      same epoch guard first. A hand-assembled prior-epoch episode carrying a
      current-epoch key therefore never reaches the key comparison at all; it is
      refused on the epoch. Observed message recorded verbatim below.
    */
    const current = makeEpisode(NATIVE_AD_ENGINE_VERSION);
    const forged: AdRecommendationEpisode = {
      ...current,
      engineVersion: PRIOR_NATIVE_AD_ENGINE_VERSION,
    };
    expect(() =>
      assertExactMetaAdsActionReceiptForEpisode({
        action: makeReceipt(current, PRIOR_NATIVE_AD_ENGINE_VERSION),
        episode: forged,
      }),
    ).toThrow(
      `engineVersion must equal the native ad epoch ${NATIVE_AD_ENGINE_VERSION}.`,
    );
    // Control: the unforged episode passes the same re-derivation.
    expect(() => buildAdRecommendationEpisodeKey(current)).not.toThrow();
  });

  it("refuses a prior-epoch receipt against a current episode, and accepts the same receipt at the current epoch", () => {
    const episode = makeEpisode(NATIVE_AD_ENGINE_VERSION);

    // Guard on: one field differs from the accepted receipt - the epoch.
    const priorEpochReceipt = makeReceipt(
      episode,
      PRIOR_NATIVE_AD_ENGINE_VERSION,
    );
    expect(() =>
      assertExactMetaAdsActionReceiptForEpisode({
        action: priorEpochReceipt,
        episode,
      }),
    ).toThrow(
      "Immutable action receipt does not match the exact native episode lineage.",
    );

    // Guard off, expressed the only honest way: put the epoch back and change
    // nothing else. The receipt is then accepted, which proves the refusal
    // above was caused by the epoch key and by nothing else in the payload.
    const currentEpochReceipt = makeReceipt(episode, NATIVE_AD_ENGINE_VERSION);
    expect(() =>
      assertExactMetaAdsActionReceiptForEpisode({
        action: currentEpochReceipt,
        episode,
      }),
    ).not.toThrow();
    const { receiptHash: _priorHash, sourceEngineVersion: _priorEpoch, ...priorRest } =
      priorEpochReceipt;
    const {
      receiptHash: _currentHash,
      sourceEngineVersion: _currentEpoch,
      ...currentRest
    } = currentEpochReceipt;
    expect(priorRest).toEqual(currentRest);
  });
});

/*
  Canonical evaluation envelopes.

  evaluation-store.ts states that rows under `.v7` and earlier "stay readable
  under their own key and are never recomputed under current semantics". The
  store-side half of that claim is checked here: a `.v7` envelope offered to the
  current writer is refused on its version key before any of its content is
  interpreted.
*/
function makeEnvelope(contractVersion: string): AdCanonicalEvaluationProvenance {
  const payload = {
    contractVersion,
    envelopeType: "context",
    engineVersion: PRIOR_NATIVE_AD_ENGINE_VERSION,
  };
  return {
    contractVersion,
    identity: {
      decisionEntityType: "ad",
      decisionEntityId: HYSTERESIS_AD_ID,
      adId: HYSTERESIS_AD_ID,
      providerAccountRefId: HYSTERESIS_ACCOUNT_REF_ID,
      providerAccountId: HYSTERESIS_ACCOUNT_ID,
      creativeId: null,
    },
    contextPayload: payload,
    inputPayload: { ...payload, envelopeType: "input" },
    decisionPayload: { ...payload, envelopeType: "decision" },
    contextJson: "{}",
    inputJson: "{}",
    decisionJson: "{}",
    contextHash: "a".repeat(64),
    inputHash: "b".repeat(64),
    decisionHash: "c".repeat(64),
    rawLabel: "cut",
    publishedLabel: "cut",
    hysteresisSuppressed: false,
  } as unknown as AdCanonicalEvaluationProvenance;
}

describe("prior-epoch canonical envelopes are refused by the current store", () => {
  it("rejects a .v7 envelope on its version key, before reading its content", () => {
    expect(() =>
      assertAdCanonicalEvaluationProvenance(
        makeEnvelope(PRIOR_AD_DECISION_EVALUATION_CONTRACT_VERSION),
      ),
    ).toThrow("Unexpected ad evaluation contract version.");
  });

  it("stops rejecting on the version key once only the version key is changed", () => {
    /*
      Guard disabled: the identical envelope stamped .v8 gets past the version
      gate and is refused further in, on its (deliberately invalid) hashes. The
      two different messages are the evidence that the version key alone is
      what refuses the prior-epoch envelope - the gate is real, not incidental.
    */
    expect(() =>
      assertAdCanonicalEvaluationProvenance(
        makeEnvelope(AD_DECISION_EVALUATION_CONTRACT_VERSION),
      ),
    ).toThrow("context canonical JSON does not match its payload.");
  });
});
