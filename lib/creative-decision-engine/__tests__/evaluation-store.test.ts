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
  adDecisionEvaluationIdentityKey,
  assertAdCanonicalEvaluationProvenance,
  assertEvaluationStoreSchemaReady,
  buildAdCanonicalEvaluationProvenance,
  inspectEvaluationStoreSchemaCapability,
  normalizeAdDecisionEvaluationIdentity,
  persistAdDecisionEvaluations,
  expectedAdDecisionColumnContract,
  type AdCanonicalEvaluationProvenance,
} from "../evaluation-store";
import type { EngineV3Flags } from "../feature-flags";
import type { DecisionOutput } from "../types";
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

describe("ad decision evaluation identity", () => {
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

  it("persists large native evaluation sets in bounded SQL batches", async () => {
    const evaluationBatchSizes: number[] = [];
    const db = fakeDb(async (query, params) => {
      if (query.includes("information_schema.columns")) return readyColumns();
      if (query.includes("FROM pg_indexes")) return readyIndexes();
      if (query.includes("pg_constraint")) return readyConstraints();
      if (query.includes("engine_v3_ad_decision_evaluation_contexts")) {
        return [{ id: "00000000-0000-4000-8000-000000000201" }];
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
