import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import type { DbClient } from "@/lib/db";
import { NATIVE_AD_DB_BATCH_SIZE } from "../batching";
import {
  buildCanonicalEvaluationProvenance,
  type BuildCanonicalEvaluationInput,
} from "../canonical-evaluation";
import {
  AD_DECISION_EVALUATION_CONTRACT_VERSION,
  AD_DECISION_REQUIRED_CONSTRAINTS,
  AD_DECISION_REQUIRED_INDEXES,
  AD_DECISION_SCHEMA_REQUIRED_COLUMNS,
  AD_SNAPSHOTS_TABLE,
  DECISION_AUTHORITY_BLOCKERS,
  EvaluationStoreSchemaNotReadyError,
  INSERT_AD_DECISION_EVALUATIONS_QUERY,
  INSERT_AD_DECISION_INPUT_EVIDENCE_QUERY,
  READ_AD_DECISION_INPUT_EVIDENCE_QUERY,
  adDecisionEvaluationIdentityKey,
  assertAdCanonicalEvaluationProvenance,
  assertEvaluationStoreSchemaReady,
  buildAdCanonicalEvaluationProvenance,
  NATIVE_AD_METRIC_CONTRACT,
  inspectEvaluationStoreSchemaCapability,
  normalizeAdDecisionEvaluationIdentity,
  persistAdDecisionEvaluations,
  expectedAdDecisionColumnContract,
  type AdCanonicalEvaluationProvenance,
} from "../evaluation-store";
import type { EngineV3Flags } from "../feature-flags";
import type { DecisionOutput } from "../types";
import { observedConfigAuthority, purchaseIntentConfigAuthority } from "./config-authority-fixture";
import type { NativeManualCutAdvisoryProof } from "../native-manual-cut-advisory";
import {
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeDataHealth,
} from "./helpers";

const flags: EngineV3Flags = {
  businessId: "biz-1",
  enabled: true,
  surfaceVisible: true,
  shadowOnly: false,
  presetOverride: null,
  source: {
    enabled: "env",
    surfaceVisible: "env",
    shadowOnly: "env",
    presetOverride: null,
  },
  envDefaults: {
    enabled: true,
    surfaceVisible: true,
    shadowOnly: false,
  },
};

function decision(): DecisionOutput {
  return {
    creativeId: "creative-shared",
    creativeName: "Shared Creative",
    label: "keep",
    preAuthorityLabel: "keep",
    authorityBlocker: null,
    reason: "Inside the keep band.",
    confidence: 72,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2.2,
    ratioToTarget: 1.1,
    badges: [],
    metrics: { spend: 500, purchases: 8, roas: 3, recent7dRoas: 2.8 },
    engineVersion: "v3-test",
    generatedAt: "2026-07-12T03:00:00.000Z",
  };
}

function baseEvaluation(): BuildCanonicalEvaluationInput {
  const profile = makeAccountDecisionProfile({
    asOfDate: "2026-07-12",
    scope: { type: "account", id: "act-1" },
  });
  const creativeInput = makeCreativeInput({
    creativeId: "creative-shared",
    creativeName: "Shared Creative",
  });
  return {
    engineVersion: "v3-test",
    accountProfile: profile,
    dataHealth: makeDataHealth(),
    flags,
    scope: profile.scope,
    creativeInput,
    campaignContext: {
      mode: "automatic",
      source: "system_inferred",
      campaignId: creativeInput.campaignId,
      kind: "main",
      testDimension: null,
      contextTrust: "high",
      sourceRecordType: "engine_v3_campaign_context_daily",
      sourceRecordId: "context-row-1",
      sourceAsOfDate: "2026-07-12",
      sourceUpdatedAt: "2026-07-12T02:00:00.000Z",
      sourceHash: "a".repeat(64),
    },
    priorHysteresis: null,
    decision: decision(),
    rawLabel: "keep",
    publishedLabel: "keep",
    hysteresisSuppressed: false,
    evaluatedAt: "2026-07-12T03:00:01.000Z",
  };
}

function adEvaluation(
  adId = "ad-1",
  creativeId: string | null = "creative-shared",
  providerAccountId = "act-1",
  providerAccountRefId = "00000000-0000-4000-8000-000000000121",
): AdCanonicalEvaluationProvenance {
  return buildAdCanonicalEvaluationProvenance({
    adEvidence: {
      customConversionId: null,
      configAuthority: observedConfigAuthority(),
    },
    identity: {
      decisionEntityType: "ad",
      decisionEntityId: adId,
      adId,
      providerAccountRefId,
      providerAccountId,
      creativeId,
    },
    base: buildCanonicalEvaluationProvenance(baseEvaluation()),
  });
}

function fakeDb(
  handler: (
    query: string,
    params?: unknown[],
  ) => Promise<Record<string, unknown>[]>,
): DbClient {
  const query = vi.fn(handler);
  return Object.assign(vi.fn(), { query }) as unknown as DbClient;
}

function readyColumns() {
  return Object.entries(AD_DECISION_SCHEMA_REQUIRED_COLUMNS).flatMap(
    ([table_name, columns]) =>
      columns.map((column_name) => {
        const contract = expectedAdDecisionColumnContract(
          table_name,
          column_name,
        );
        return {
          table_name,
          column_name,
          is_nullable: contract.nullable ? "YES" : "NO",
          data_type: contract.udtName,
          udt_name: contract.udtName,
          character_maximum_length: contract.characterMaximumLength,
        };
      }),
  );
}

function readyIndexes() {
  return AD_DECISION_REQUIRED_INDEXES.map((index) => ({
    tablename: index.table,
    indexname: index.name,
    indexdef: `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${index.name} ON ${index.table} (${index.orderedColumns.join(", ")})${index.predicate ? ` WHERE ${index.predicate}` : ""}`,
  }));
}

function readyConstraints() {
  return AD_DECISION_REQUIRED_CONSTRAINTS.map((constraint) => ({
    table_name: constraint.table,
    constraint_name: constraint.name,
    constraint_type: constraint.type,
    definition: constraint.allOf.join(" "),
    validated: true,
  }));
}

function evidenceRows(
  params: unknown[] | undefined,
  evidenceMatches = true,
): Array<Record<string, unknown>> {
  return (
    JSON.parse(String(params?.[0])) as Array<Record<string, unknown>>
  ).map((row) => ({
    contract_version: row.contract_version,
    input_hash: row.input_hash,
    evidence_matches: evidenceMatches,
  }));
}

describe("ad decision evaluation identity", () => {
  it("v19 binds the purchase-intent days and the separately stored manual recommendation", () => {
    const configAuthority = purchaseIntentConfigAuthority();
    const proof: NativeManualCutAdvisoryProof = {
      contractVersion: "meta-native-manual-cut-advisory.v1", recommendation: "cut",
      basis: "peer_free_commercial_stop_loss", confidenceCap: "medium", authority: "none",
      heldBy: "config_source_authority", adId: "ad-1", providerAccountId: "act-1",
      asOfDate: "2026-07-12", computedAt: "2026-07-12T03:00:01.000Z",
      engineVersion: "v3-test", engineAuthorityBlocker: "campaign_context",
      commercialTargetRoas: 2, receiptManifestHash: "c".repeat(64),
      economicDayCount: 5, bracketedDays: 4, historicalObjectiveUnverifiedDays: 5,
      pointObservedDays: [{ date: "2026-07-08", spend: 100, revenue: 100, stressedRevenue: 200 }],
      stress: { purchaseValue: { actual: 500, stressed: 600 }, roas: { actual: 1, stressed: 1.2 }, recent7dRoas: null, bands: [] },
    };
    const build = (advice: NativeManualCutAdvisoryProof | null = proof, authority = configAuthority) =>
      buildAdCanonicalEvaluationProvenance({
        base: buildCanonicalEvaluationProvenance(baseEvaluation()),
        identity: adEvaluation().identity,
        adEvidence: { customConversionId: null, configAuthority: authority },
        manualCutAdvisory: advice,
      });
    const original = build();
    expect(original.contractVersion).toBe("engine-v3-canonical-ad-evaluation.v19");
    const { computedAt: _computedAt, ...storedProof } = proof;
    expect(original.inputPayload.configEvidence).toMatchObject({ manualCutAdvisory: storedProof, purchaseIntentWindow: configAuthority.purchaseIntentWindow });
    const repeated = build({ ...proof, computedAt: "2026-07-12T04:00:00.000Z" });
    expect(repeated.inputHash).toBe(original.inputHash);
    expect(repeated.decisionHash).toBe(original.decisionHash);
    const otherReceipt = build({ ...proof, receiptManifestHash: "d".repeat(64) });
    const otherDay = build(proof, { ...configAuthority, purchaseIntentWindow: {
      ...configAuthority.purchaseIntentWindow!,
      pointObserved: [{ date: "2026-07-08", spend: 101, revenue: 100 }],
    } });
    for (const changed of [build(null), otherReceipt, otherDay]) {
      expect(changed.inputHash).not.toBe(original.inputHash);
      expect(changed.decisionHash).not.toBe(original.decisionHash);
      expect(changed.contextHash).toBe(original.contextHash);
    }
    expect(build(null).inputPayload.configEvidence).toMatchObject({ manualCutAdvisory: null });
  });
  it("binds config observation and custom-conversion identity to the native input hash", () => {
    const base = buildCanonicalEvaluationProvenance(baseEvaluation());
    const identity = {
      decisionEntityType: "ad" as const,
      decisionEntityId: "ad-1",
      adId: "ad-1",
      providerAccountRefId: "00000000-0000-4000-8000-000000000121",
      providerAccountId: "act-1",
      creativeId: "creative-shared",
    };
    const observed = observedConfigAuthority();
    const build = (
      customConversionId: string | null,
      observedToday: boolean,
      economicsVerified = true,
    ) =>
      buildAdCanonicalEvaluationProvenance({
        identity,
        base,
        adEvidence: {
          customConversionId,
          configAuthority: {
            ...observed,
            currentValueEvidence: {
              ...observed.currentValueEvidence,
              observed: observedToday,
            },
            decisionEconomics: {
              ...observed.decisionEconomics,
              fullyVerified: economicsVerified,
              unverifiedEconomicDayCount: economicsVerified ? 0 : 1,
            },
          },
        },
      });
    const first = build(null, true);
    const receiptLost = build(null, false);
    const targetChanged = build("conversion-B", true);
    const economicDayUnverified = build(null, true, false);

    expect(first.contextHash).toBe(receiptLost.contextHash);
    expect(first.inputHash).not.toBe(receiptLost.inputHash);
    expect(first.decisionHash).not.toBe(receiptLost.decisionHash);
    expect(first.inputHash).not.toBe(targetChanged.inputHash);
    expect(first.inputHash).not.toBe(economicDayUnverified.inputHash);
    expect(first.decisionHash).not.toBe(economicDayUnverified.decisionHash);
    expect(first.inputPayload.configEvidence).toMatchObject({
      customConversionId: null,
      currentValueEvidence: { observed: true },
    });
  });

  /*
    RECEIPT LINEAGE (2026-09-22). The same value and the same tier, resting on a
    DIFFERENT receipt, is a different input — and so is a different
    observation of the SAME canonical snapshot. A row that predates lineage
    carries explicit nulls, never an inferred identity.
  */
  describe("binds WHICH config receipt the verdict rests on", () => {
    const identity = {
      decisionEntityType: "ad" as const,
      decisionEntityId: "ad-1",
      adId: "ad-1",
      providerAccountRefId: "00000000-0000-4000-8000-000000000121",
      providerAccountId: "act-1",
      creativeId: "creative-shared",
    };
    const SNAPSHOT_A = "11111111-1111-4111-8111-111111111111";
    const SNAPSHOT_B = "22222222-2222-4222-8222-222222222222";
    const OBS_1 = "33333333-3333-4333-8333-333333333333";
    const OBS_2 = "44444444-4444-4444-8444-444444444444";
    const ref = (snapshot: string, observation: string) => ({
      refContractVersion: "meta-config-field-evidence-ref.v1" as const,
      field: "objective" as const,
      sourceContractVersion: "meta-config-field-source.v1",
      normalizationVersion: 1,
      tier: "provider_receipt_point_in_day" as const,
      readiness: "review_only" as const,
      sourceClass: "modern" as const,
      pitClass: "as_of_known" as const,
      sourceSnapshotId: snapshot,
      observationId: observation,
      observedAt: "2026-07-12T09:00:00.000Z",
      fieldScopeHash: "a".repeat(64),
      corroboratingSnapshotId: null,
      corroboratingObservationId: null,
      corroboratingObservedAt: null,
    });
    const build = (objectiveRef: ReturnType<typeof ref> | null, supplied = true) => {
      const observed = observedConfigAuthority();
      return buildAdCanonicalEvaluationProvenance({
        identity,
        base: buildCanonicalEvaluationProvenance(baseEvaluation()),
        adEvidence: {
          customConversionId: null,
          configAuthority: {
            ...observed,
            currentValueEvidence: {
              ...observed.currentValueEvidence,
              lineageSupplied: supplied,
              refs: { ...observed.currentValueEvidence.refs, objective: objectiveRef },
            },
          },
        },
      });
    };

    it("moves the input hash when only the receipt changes, value and tier unchanged", () => {
      const onA = build(ref(SNAPSHOT_A, OBS_1));
      const onB = build(ref(SNAPSHOT_B, OBS_1));
      expect(onA.contextHash).toBe(onB.contextHash);
      expect(onA.inputHash).not.toBe(onB.inputHash);
      expect(onA.decisionHash).not.toBe(onB.decisionHash);
    });

    it("tells two observations of the SAME canonical snapshot apart", () => {
      expect(build(ref(SNAPSHOT_A, OBS_1)).inputHash).not.toBe(
        build(ref(SNAPSHOT_A, OBS_2)).inputHash,
      );
    });

    it("POSITIVE: the same receipt reproduces the same hash", () => {
      expect(build(ref(SNAPSHOT_A, OBS_1)).inputHash).toBe(
        build(ref(SNAPSHOT_A, OBS_1)).inputHash,
      );
    });

    it("keeps a legacy, lineage-less input explicit rather than inferred", () => {
      const legacy = build(null, false);
      expect(legacy.inputPayload.configEvidence).toMatchObject({
        currentValueEvidence: {
          lineageSupplied: false,
          refs: {
            objective: null,
            optimization_goal: null,
            custom_event_type: null,
            custom_conversion_id: null,
          },
        },
      });
    });

    it("names the metric parsing rules the inputs were read under", () => {
      expect(build(null).inputPayload.metricContract).toEqual(NATIVE_AD_METRIC_CONTRACT);
    });

    it("persists exactly what it hashed, so the input hash can be recomputed from storage", async () => {
      const evaluation = build(ref(SNAPSHOT_A, OBS_1));
      const { canonicalSha256 } = await import("../canonical-evaluation");
      const payload = evaluation.inputPayload as Record<string, unknown>;
      // The persisted columns: creative_input_json, campaign_context_json,
      // prior_hysteresis_json, and the hash-keyed evidence mapping's two members.
      const rebuilt = {
        contractVersion: payload.contractVersion,
        envelopeType: payload.envelopeType,
        engineVersion: payload.engineVersion,
        contextHash: payload.contextHash,
        creativeInput: payload.creativeInput,
        campaignContext: payload.campaignContext,
        priorHysteresis: payload.priorHysteresis,
        decisionIdentity: payload.decisionIdentity,
        configEvidence: payload.configEvidence,
        metricContract: payload.metricContract,
      };
      expect(Object.keys(payload).sort()).toEqual(Object.keys(rebuilt).sort());
      expect(canonicalSha256(rebuilt as never)).toBe(evaluation.inputHash);
    });
  });

  it("binds hashes to native adId when one creative is reused by multiple ads", () => {
    const first = adEvaluation("ad-1");
    const second = adEvaluation("ad-2");

    expect(first.contextHash).toBe(second.contextHash);
    expect(first.inputHash).not.toBe(second.inputHash);
    expect(first.decisionHash).not.toBe(second.decisionHash);
    expect(first.inputPayload.decisionIdentity).toEqual({
      decisionEntityType: "ad",
      decisionEntityId: "ad-1",
      adId: "ad-1",
      providerAccountRefId: "00000000-0000-4000-8000-000000000121",
      providerAccountId: "act-1",
      creativeGroupingId: "creative-shared",
    });
    expect(first.contractVersion).toBe(AD_DECISION_EVALUATION_CONTRACT_VERSION);
  });

  it("keeps creativeId nullable and outside the evaluation identity key", () => {
    expect(
      adDecisionEvaluationIdentityKey({
        decisionEntityType: "ad",
        decisionEntityId: "ad-1",
        adId: "ad-1",
        providerAccountRefId: "00000000-0000-4000-8000-000000000121",
        providerAccountId: "act-1",
        creativeId: "creative-a",
      }),
    ).toBe(
      adDecisionEvaluationIdentityKey({
        decisionEntityType: "ad",
        decisionEntityId: "ad-1",
        adId: "ad-1",
        providerAccountRefId: "00000000-0000-4000-8000-000000000121",
        providerAccountId: "act-1",
        creativeId: "creative-b",
      }),
    );
    expect(
      normalizeAdDecisionEvaluationIdentity({
        decisionEntityType: "ad",
        decisionEntityId: " ad-1 ",
        adId: "ad-1",
        providerAccountRefId: "00000000-0000-4000-8000-000000000121",
        providerAccountId: "act-1",
        creativeId: " ",
      }).creativeId,
    ).toBeNull();
  });

  it("separates the same ad identifier across provider account authority", () => {
    const first = adEvaluation("ad-1", "creative-shared", "act-1");
    const second = adEvaluation(
      "ad-1",
      "creative-shared",
      "act-2",
      "00000000-0000-4000-8000-000000000122",
    );

    expect(first.inputHash).not.toBe(second.inputHash);
    expect(adDecisionEvaluationIdentityKey(first.identity)).not.toBe(
      adDecisionEvaluationIdentityKey(second.identity),
    );
  });

  it("rejects an alias that differs from the native adId", () => {
    expect(() =>
      normalizeAdDecisionEvaluationIdentity({
        decisionEntityType: "ad",
        decisionEntityId: "creative-1",
        adId: "ad-1",
        providerAccountRefId: "00000000-0000-4000-8000-000000000121",
        providerAccountId: "act-1",
        creativeId: "creative-1",
      }),
    ).toThrow(/must equal the native adId/);
  });

  it("rejects mutated payloads or hashes before persistence", () => {
    const valid = adEvaluation();
    expect(() => assertAdCanonicalEvaluationProvenance(valid)).not.toThrow();
    expect(() =>
      assertAdCanonicalEvaluationProvenance({
        ...valid,
        inputHash: "f".repeat(64),
      }),
    ).toThrow(/input hash does not match/);
  });
});

describe("evaluation store schema gate", () => {
  it("requires nullable authority provenance and its closed blocker enum", () => {
    expect(expectedAdDecisionColumnContract(
      AD_SNAPSHOTS_TABLE,
      "pre_authority_label",
    ).nullable).toBe(true);
    expect(expectedAdDecisionColumnContract(
      AD_SNAPSHOTS_TABLE,
      "authority_blocker",
    ).nullable).toBe(true);
    expect(AD_DECISION_REQUIRED_CONSTRAINTS.find((constraint) =>
      constraint.name === "engine_v3_ad_snapshots_authority_blocker_check",
    )?.allOf).toEqual(["authority_blocker is null", ...DECISION_AUTHORITY_BLOCKERS]);
  });

  it("accepts only ad-keyed uniqueness with nullable creative grouping", async () => {
    const db = fakeDb(async (query) => {
      if (query.includes("information_schema.columns")) return readyColumns();
      if (query.includes("FROM pg_indexes")) return readyIndexes();
      return readyConstraints();
    });

    await expect(inspectEvaluationStoreSchemaCapability(db)).resolves.toEqual({
      ready: true,
      missing: [],
    });
  });

  it("rejects the current creative-owned schema before any INSERT", async () => {
    const calls: string[] = [];
    const db = fakeDb(async (query) => {
      calls.push(query);
      if (query.includes("information_schema.columns")) {
        return [
          {
            table_name: "engine_v3_decision_evaluations",
            column_name: "creative_id",
            is_nullable: "NO",
          },
          {
            table_name: "engine_v3_decision_snapshots_daily",
            column_name: "creative_id",
            is_nullable: "NO",
          },
        ];
      }
      return [
        {
          tablename: "engine_v3_decision_evaluations",
          indexdef:
            "CREATE UNIQUE INDEX old_eval ON engine_v3_decision_evaluations (context_id, creative_id, input_hash, decision_hash)",
        },
        {
          tablename: "engine_v3_decision_snapshots_daily",
          indexdef:
            "CREATE UNIQUE INDEX old_snapshot ON engine_v3_decision_snapshots_daily (business_ref_id, creative_id, as_of_date, engine_version, scope_type, scope_id)",
        },
      ];
    });
    const evaluation = adEvaluation();

    await expect(
      persistAdDecisionEvaluations(
        {
          businessId: "biz-1",
          asOf: "2026-07-12",
          engineVersion: "v3-test",
          scope: { type: "account", id: "act-1" },
          jobRunId: "job-1",
          evaluatedAt: "2026-07-12T03:00:01.000Z",
          evaluations: [evaluation],
        },
        db,
      ),
    ).rejects.toBeInstanceOf(EvaluationStoreSchemaNotReadyError);
    expect(calls).toHaveLength(3);
    expect(calls.every((query) => !/\bINSERT\b/i.test(query))).toBe(true);
  });

  it("rejects a surviving creative-owned unique index even after ad columns exist", async () => {
    const db = fakeDb(async (query) => {
      if (query.includes("information_schema.columns")) return readyColumns();
      if (query.includes("pg_constraint")) return readyConstraints();
      return [
        ...readyIndexes(),
        {
          tablename: "engine_v3_ad_decision_snapshots_daily",
          indexdef:
            "CREATE UNIQUE INDEX stale_creative_unique ON engine_v3_ad_decision_snapshots_daily (business_ref_id, creative_id, as_of_date, engine_version, scope_type, scope_id)",
        },
      ];
    });

    await expect(assertEvaluationStoreSchemaReady(db)).rejects.toMatchObject({
      code: "ad_decision_evaluation_schema_not_ready",
      missing: expect.arrayContaining([
        "engine_v3_ad_decision_snapshots_daily.creative_identity_unique_present",
      ]),
    });
  });

  it("persists shared context once and resolves rows by ad identity", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const db = fakeDb(async (query, params) => {
      if (query.includes("information_schema.columns")) return readyColumns();
      if (query.includes("FROM pg_indexes")) return readyIndexes();
      if (query.includes("pg_constraint")) return readyConstraints();
      if (query.includes("engine_v3_ad_decision_evaluation_contexts")) {
        return [{ id: "00000000-0000-4000-8000-000000000201" }];
      }
      if (query === INSERT_AD_DECISION_INPUT_EVIDENCE_QUERY) return [];
      if (query === READ_AD_DECISION_INPUT_EVIDENCE_QUERY) {
        return evidenceRows(params);
      }
      const payload = JSON.parse(String(params?.[0])) as Array<
        Record<string, unknown>
      >;
      payloads.push(...payload);
      return payload.map((row, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 301).padStart(12, "0")}`,
        provider_account_ref_id: row.provider_account_ref_id,
        provider_account_id: row.provider_account_id,
        decision_entity_id: row.decision_entity_id,
        input_hash: row.input_hash,
        decision_hash: row.decision_hash,
      }));
    });

    const stored = await persistAdDecisionEvaluations(
      {
        businessId: "biz-1",
        asOf: "2026-07-12",
        engineVersion: "v3-test",
        scope: { type: "account", id: "act-1" },
        jobRunId: "00000000-0000-4000-8000-000000000101",
        evaluatedAt: "2026-07-12T03:00:01.000Z",
        evaluations: [adEvaluation("ad-1"), adEvaluation("ad-2")],
      },
      db,
    );

    expect(stored.size).toBe(2);
    expect([...stored.keys()]).toEqual([
      "00000000-0000-4000-8000-000000000121:act-1:ad:ad-1",
      "00000000-0000-4000-8000-000000000121:act-1:ad:ad-2",
    ]);
    expect(payloads).toHaveLength(2);
    expect(payloads.map((row) => row.decision_entity_id)).toEqual([
      "ad-1",
      "ad-2",
    ]);
    expect(payloads.map((row) => row.creative_id)).toEqual([
      "creative-shared",
      "creative-shared",
    ]);
    expect(new Set(payloads.map((row) => row.context_id))).toEqual(
      new Set(["00000000-0000-4000-8000-000000000201"]),
    );
  });

  it("verifies hash-keyed evidence before inserting narrow evaluation rows", async () => {
    const writeOrder: string[] = [];
    let evaluationPayload: Array<Record<string, unknown>> = [];
    let evidencePayload: Array<Record<string, unknown>> = [];
    const db = fakeDb(async (query, params) => {
      if (query.includes("information_schema.columns")) return readyColumns();
      if (query.includes("FROM pg_indexes")) return readyIndexes();
      if (query.includes("pg_constraint")) return readyConstraints();
      if (query.includes("engine_v3_ad_decision_evaluation_contexts")) {
        return [{ id: "00000000-0000-4000-8000-000000000201" }];
      }
      if (query === INSERT_AD_DECISION_INPUT_EVIDENCE_QUERY) {
        writeOrder.push("evidence-insert");
        evidencePayload = JSON.parse(String(params?.[0])) as Array<
          Record<string, unknown>
        >;
        return [];
      }
      if (query === READ_AD_DECISION_INPUT_EVIDENCE_QUERY) {
        writeOrder.push("evidence-verify");
        return evidenceRows(params);
      }
      writeOrder.push("evaluation-insert");
      evaluationPayload = JSON.parse(String(params?.[0])) as Array<
        Record<string, unknown>
      >;
      return evaluationPayload.map((row) => ({
        id: "00000000-0000-4000-8000-000000000301",
        provider_account_ref_id: row.provider_account_ref_id,
        provider_account_id: row.provider_account_id,
        decision_entity_id: row.decision_entity_id,
        input_hash: row.input_hash,
        decision_hash: row.decision_hash,
      }));
    });

    await persistAdDecisionEvaluations(
      {
        businessId: "biz-1",
        asOf: "2026-07-12",
        engineVersion: "v3-test",
        scope: { type: "account", id: "act-1" },
        jobRunId: "00000000-0000-4000-8000-000000000101",
        evaluatedAt: "2026-07-12T03:00:01.000Z",
        evaluations: [adEvaluation()],
      },
      db,
    );

    expect(writeOrder).toEqual([
      "evidence-insert",
      "evidence-verify",
      "evaluation-insert",
    ]);
    expect(evidencePayload[0]).toMatchObject({
      contract_version: AD_DECISION_EVALUATION_CONTRACT_VERSION,
      input_hash: adEvaluation().inputHash,
      input_evidence_json: {
        configEvidence: expect.any(Object),
        metricContract: NATIVE_AD_METRIC_CONTRACT,
      },
    });
    expect(evaluationPayload[0]).not.toHaveProperty("input_evidence_json");
  });

  it("fails closed on an existing hash whose stored evidence differs", async () => {
    let evaluationInsertCalled = false;
    const db = fakeDb(async (query, params) => {
      if (query.includes("information_schema.columns")) return readyColumns();
      if (query.includes("FROM pg_indexes")) return readyIndexes();
      if (query.includes("pg_constraint")) return readyConstraints();
      if (query.includes("engine_v3_ad_decision_evaluation_contexts")) {
        return [{ id: "00000000-0000-4000-8000-000000000201" }];
      }
      if (query === INSERT_AD_DECISION_INPUT_EVIDENCE_QUERY) return [];
      if (query === READ_AD_DECISION_INPUT_EVIDENCE_QUERY) {
        return evidenceRows(params, false);
      }
      evaluationInsertCalled = true;
      return [];
    });

    await expect(
      persistAdDecisionEvaluations(
        {
          businessId: "biz-1",
          asOf: "2026-07-12",
          engineVersion: "v3-test",
          scope: { type: "account", id: "act-1" },
          jobRunId: "00000000-0000-4000-8000-000000000101",
          evaluatedAt: "2026-07-12T03:00:01.000Z",
          evaluations: [adEvaluation()],
        },
        db,
      ),
    ).rejects.toThrow("Ad decision input evidence missing or hash collision");
    expect(evaluationInsertCalled).toBe(false);
  });

  it("persists large native evaluation sets in bounded SQL batches", async () => {
    const evaluationBatchSizes: number[] = [];
    const db = fakeDb(async (query, params) => {
      if (query.includes("information_schema.columns")) return readyColumns();
      if (query.includes("FROM pg_indexes")) return readyIndexes();
      if (query.includes("pg_constraint")) return readyConstraints();
      if (query.includes("engine_v3_ad_decision_evaluation_contexts")) {
        return [{ id: "00000000-0000-4000-8000-000000000201" }];
      }
      if (query === INSERT_AD_DECISION_INPUT_EVIDENCE_QUERY) return [];
      if (query === READ_AD_DECISION_INPUT_EVIDENCE_QUERY) {
        return evidenceRows(params);
      }
      const payload = JSON.parse(String(params?.[0])) as Array<
        Record<string, unknown>
      >;
      evaluationBatchSizes.push(payload.length);
      return payload.map((row) => ({
        id: `evaluation-${String(row.decision_entity_id)}`,
        provider_account_ref_id: row.provider_account_ref_id,
        provider_account_id: row.provider_account_id,
        decision_entity_id: row.decision_entity_id,
        input_hash: row.input_hash,
        decision_hash: row.decision_hash,
      }));
    });
    const evaluations = Array.from(
      { length: NATIVE_AD_DB_BATCH_SIZE + 1 },
      (_, index) => adEvaluation(`ad-${index + 1}`),
    );

    const stored = await persistAdDecisionEvaluations(
      {
        businessId: "biz-1",
        asOf: "2026-07-12",
        engineVersion: "v3-test",
        scope: { type: "account", id: "act-1" },
        jobRunId: "00000000-0000-4000-8000-000000000101",
        evaluatedAt: "2026-07-12T03:00:01.000Z",
        evaluations,
      },
      db,
    );

    expect(evaluationBatchSizes).toEqual([NATIVE_AD_DB_BATCH_SIZE, 1]);
    expect(stored.size).toBe(evaluations.length);
  });

  it("fails closed when any expected evaluation cannot be resolved", async () => {
    const db = fakeDb(async (query, params) => {
      if (query.includes("information_schema.columns")) return readyColumns();
      if (query.includes("FROM pg_indexes")) return readyIndexes();
      if (query.includes("pg_constraint")) return readyConstraints();
      if (query.includes("engine_v3_ad_decision_evaluation_contexts")) {
        return [{ id: "00000000-0000-4000-8000-000000000201" }];
      }
      if (query === INSERT_AD_DECISION_INPUT_EVIDENCE_QUERY) return [];
      if (query === READ_AD_DECISION_INPUT_EVIDENCE_QUERY) {
        return evidenceRows(params);
      }
      const [first] = JSON.parse(String(params?.[0])) as Array<
        Record<string, unknown>
      >;
      return first
        ? [
            {
              id: "00000000-0000-4000-8000-000000000301",
              provider_account_ref_id: first.provider_account_ref_id,
              provider_account_id: first.provider_account_id,
              decision_entity_id: first.decision_entity_id,
              input_hash: first.input_hash,
              decision_hash: first.decision_hash,
            },
          ]
        : [];
    });

    await expect(
      persistAdDecisionEvaluations(
        {
          businessId: "biz-1",
          asOf: "2026-07-12",
          engineVersion: "v3-test",
          scope: { type: "account", id: "act-1" },
          jobRunId: "00000000-0000-4000-8000-000000000101",
          evaluatedAt: "2026-07-12T03:00:01.000Z",
          evaluations: [adEvaluation("ad-1"), adEvaluation("ad-2")],
        },
        db,
      ),
    ).rejects.toThrow(
      "Ad evaluation linkage incomplete: expected 2, resolved 1.",
    );
  });

  it("keeps one compatibility re-resolution attempt for direct read-committed callers", async () => {
    let evaluationAttempt = 0;
    const db = fakeDb(async (query, params) => {
      if (query.includes("information_schema.columns")) return readyColumns();
      if (query.includes("FROM pg_indexes")) return readyIndexes();
      if (query.includes("pg_constraint")) return readyConstraints();
      if (query.includes("engine_v3_ad_decision_evaluation_contexts")) {
        return [{ id: "00000000-0000-4000-8000-000000000201" }];
      }
      if (query === INSERT_AD_DECISION_INPUT_EVIDENCE_QUERY) return [];
      if (query === READ_AD_DECISION_INPUT_EVIDENCE_QUERY) {
        return evidenceRows(params);
      }
      evaluationAttempt += 1;
      if (evaluationAttempt === 1) return [];
      const payload = JSON.parse(String(params?.[0])) as Array<
        Record<string, unknown>
      >;
      return payload.map((row, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 301).padStart(12, "0")}`,
        provider_account_ref_id: row.provider_account_ref_id,
        provider_account_id: row.provider_account_id,
        decision_entity_id: row.decision_entity_id,
        input_hash: row.input_hash,
        decision_hash: row.decision_hash,
      }));
    });

    const stored = await persistAdDecisionEvaluations(
      {
        businessId: "biz-1",
        asOf: "2026-07-12",
        engineVersion: "v3-test",
        scope: { type: "account", id: "act-1" },
        jobRunId: "00000000-0000-4000-8000-000000000101",
        evaluatedAt: "2026-07-12T03:00:01.000Z",
        evaluations: [adEvaluation("ad-1"), adEvaluation("ad-2")],
      },
      db,
    );

    expect(evaluationAttempt).toBe(2);
    expect(stored.size).toBe(2);
  });

  it("rejects cross-tenant and cross-scope canonical lineage before database access", async () => {
    const db = fakeDb(async () => {
      throw new Error("database must not be reached");
    });

    await expect(
      persistAdDecisionEvaluations(
        {
          businessId: "other-business",
          asOf: "2026-07-12",
          engineVersion: "v3-test",
          scope: { type: "account", id: "act-1" },
          jobRunId: "job-1",
          evaluatedAt: "2026-07-12T03:00:01.000Z",
          evaluations: [adEvaluation()],
        },
        db,
      ),
    ).rejects.toThrow("Canonical account profile and batch tenant differ.");
    await expect(
      persistAdDecisionEvaluations(
        {
          businessId: "biz-1",
          asOf: "2026-07-12",
          engineVersion: "v3-test",
          scope: { type: "campaign", id: "campaign-1" },
          jobRunId: "job-1",
          evaluatedAt: "2026-07-12T03:00:01.000Z",
          evaluations: [adEvaluation()],
        },
        db,
      ),
    ).rejects.toThrow("Canonical context and batch scopes differ.");
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("evaluation store SQL contract", () => {
  it("stores evidence by contract and input hash without widening evaluations", () => {
    expect(INSERT_AD_DECISION_INPUT_EVIDENCE_QUERY).toContain(
      "ON CONFLICT (contract_version, input_hash) DO NOTHING",
    );
    expect(READ_AD_DECISION_INPUT_EVIDENCE_QUERY).toContain(
      "stored.contract_version = payload.contract_version",
    );
    expect(READ_AD_DECISION_INPUT_EVIDENCE_QUERY).toContain(
      "stored.input_hash = payload.input_hash",
    );
    expect(INSERT_AD_DECISION_EVALUATIONS_QUERY).not.toContain(
      "input_evidence_json",
    );
  });

  it("resolves immutable rows by ad identity and hashes, never creative grouping", () => {
    const join = INSERT_AD_DECISION_EVALUATIONS_QUERY.slice(
      INSERT_AD_DECISION_EVALUATIONS_QUERY.indexOf(
        "FROM engine_v3_ad_decision_evaluations evaluation",
      ),
    );
    expect(INSERT_AD_DECISION_EVALUATIONS_QUERY).toContain(
      "decision_entity_id text",
    );
    expect(INSERT_AD_DECISION_EVALUATIONS_QUERY).toContain("ad_id text");
    expect(INSERT_AD_DECISION_EVALUATIONS_QUERY).toContain(
      "provider_account_id text",
    );
    expect(INSERT_AD_DECISION_EVALUATIONS_QUERY).toContain("creative_id text");
    expect(join).toContain(
      "evaluation.decision_entity_id = payload.decision_entity_id",
    );
    expect(join).toContain("evaluation.input_hash = payload.input_hash");
    expect(join).toContain("evaluation.decision_hash = payload.decision_hash");
    expect(join).not.toContain("evaluation.creative_id = payload.creative_id");
    expect(INSERT_AD_DECISION_EVALUATIONS_QUERY).toContain(
      "ON CONFLICT DO NOTHING",
    );
    expect(INSERT_AD_DECISION_EVALUATIONS_QUERY).toContain("FROM inserted");
    expect(INSERT_AD_DECISION_EVALUATIONS_QUERY).toContain("UNION ALL");
    expect(INSERT_AD_DECISION_EVALUATIONS_QUERY).toContain(
      "WHERE inserted.id = evaluation.id",
    );
  });

  it("keeps the legacy creative producer isolated from parallel native tables", () => {
    const producer = readFileSync(
      "lib/creative-decision-engine/jobs/decisions-job.ts",
      "utf8",
    );
    expect(producer).not.toContain("persistAdDecisionEvaluations");
    expect(producer).not.toContain("engine_v3_ad_decision_");
    const nativeProducer = readFileSync(
      "lib/creative-decision-engine/jobs/ad-decisions-job.ts",
      "utf8",
    );
    expect(nativeProducer).toContain("engine_v3_ad_decision_snapshots_daily");
    expect(nativeProducer).not.toContain(
      "INSERT INTO engine_v3_decision_snapshots_daily",
    );
  });
});
