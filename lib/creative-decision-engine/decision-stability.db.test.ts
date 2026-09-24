import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { sharedEphemeralDatabaseUrl } from "@/lib/test-utils/shared-ephemeral-database";
import { READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY } from "./decision-stability";

const DATABASE_URL = sharedEphemeralDatabaseUrl();
const suite = DATABASE_URL ? describe : describe.skip;

const BUSINESS_ID = "00000000-0000-4000-8000-000000000101";
const ACCOUNT_REF_ID = "00000000-0000-4000-8000-000000000121";
const ACCOUNT_ID = "act-stability";
const CURRENT_EPOCH = "current-epoch";
const PRIOR_EPOCH = "prior-epoch";

suite("native Ad prior-label query in PostgreSQL", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL! });
    await client.connect();
    await client.query(`
      CREATE TEMP TABLE engine_v3_ad_decision_evaluations (
        id uuid PRIMARY KEY, business_ref_id uuid, business_id text,
        provider_account_ref_id uuid, provider_account_id text,
        decision_entity_type text, decision_entity_id text, as_of_date date,
        engine_version text, scope_type text, scope_id text,
        input_hash text, decision_hash text, job_run_id uuid
      );
      CREATE TEMP TABLE engine_v3_ad_decision_snapshots_daily (
        id uuid PRIMARY KEY, business_ref_id uuid, business_id text,
        provider_account_ref_id uuid, provider_account_id text,
        decision_entity_type text, decision_entity_id text, as_of_date date,
        computed_at timestamptz, engine_version text, scope_type text,
        scope_id text, label text, raw_label text, evaluation_id uuid,
        input_hash text, decision_hash text, job_run_id uuid,
        created_at timestamptz
      );
    `);
  });

  afterAll(async () => {
    await client?.end();
  });

  async function addSnapshot(input: {
    key: number;
    day: string;
    epoch: string;
    label: string;
    createdAt: string;
    adId?: string;
    linked?: boolean;
  }) {
    const suffix = String(input.key).padStart(12, "0");
    const snapshotId = `10000000-0000-4000-8000-${suffix}`;
    const evaluationId = `20000000-0000-4000-8000-${suffix}`;
    const jobRunId = `30000000-0000-4000-8000-${suffix}`;
    const common = [
      BUSINESS_ID, BUSINESS_ID, ACCOUNT_REF_ID, ACCOUNT_ID, "ad", input.adId ?? "ad-1",
      input.day, input.epoch, "account", ACCOUNT_ID, "a".repeat(64),
      "b".repeat(64), jobRunId,
    ];
    if (input.linked !== false) {
      await client.query(
        `INSERT INTO engine_v3_ad_decision_evaluations VALUES (
          $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8::date,
          $9, $10, $11, $12, $13, $14::uuid
        )`,
        [evaluationId, ...common],
      );
    }
    await client.query(
      `INSERT INTO engine_v3_ad_decision_snapshots_daily VALUES (
        $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8::date,
        $9::timestamptz, $10, $11, $12, $13, $14, $15::uuid,
        $16, $17, $18::uuid, $19::timestamptz
      )`,
      [
        snapshotId, ...common.slice(0, 7), input.createdAt,
        ...common.slice(7, 10), input.label, input.label, evaluationId,
        ...common.slice(10), input.createdAt,
      ],
    );
  }

  async function read(cutoff: string | null, adId = "ad-1") {
    return (await client.query(READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY, [
      BUSINESS_ID, CURRENT_EPOCH,
      JSON.stringify([{
        provider_account_ref_id: ACCOUNT_REF_ID,
        provider_account_id: ACCOUNT_ID,
        decision_entity_type: "ad",
        decision_entity_id: adId,
      }]),
      "2026-09-24", "account", ACCOUNT_ID, cutoff,
    ])).rows;
  }

  it("selects the latest linked same-epoch prior row and respects the historical cutoff", async () => {
    await addSnapshot({
      key: 1, day: "2026-09-22", epoch: CURRENT_EPOCH, label: "keep",
      createdAt: "2026-09-22T03:00:00Z",
    });
    await addSnapshot({
      key: 2, day: "2026-09-23", epoch: PRIOR_EPOCH, label: "cut",
      createdAt: "2026-09-23T00:30:00Z",
    });
    await addSnapshot({
      key: 3, day: "2026-09-23", epoch: CURRENT_EPOCH, label: "scale",
      createdAt: "2026-09-23T03:00:00Z",
    });
    await addSnapshot({
      key: 4, day: "2026-09-23", epoch: CURRENT_EPOCH, label: "refresh",
      createdAt: "2026-09-23T04:00:00Z", linked: false,
    });

    const production = await read(null);
    expect(production).toHaveLength(1);
    expect(production[0]).toMatchObject({
      source_as_of_date: "2026-09-23", label: "scale",
    });

    const historical = await read("2026-09-23T01:00:00Z");
    expect(historical).toHaveLength(1);
    expect(historical[0]).toMatchObject({
      source_as_of_date: "2026-09-22", label: "keep",
    });
  });

  it("materializes only the requested identity batch before reading evaluations", async () => {
    await addSnapshot({
      key: 10, adId: "ad-requested", day: "2026-09-23",
      epoch: CURRENT_EPOCH, label: "keep", createdAt: "2026-09-23T03:00:00Z",
    });
    await addSnapshot({
      key: 11, adId: "ad-other", day: "2026-09-23",
      epoch: CURRENT_EPOCH, label: "cut", createdAt: "2026-09-23T03:00:00Z",
    });

    const parameters = [
      BUSINESS_ID, CURRENT_EPOCH,
      JSON.stringify([{
        provider_account_ref_id: ACCOUNT_REF_ID,
        provider_account_id: ACCOUNT_ID,
        decision_entity_type: "ad",
        decision_entity_id: "ad-requested",
      }]),
      "2026-09-24", "account", ACCOUNT_ID, null,
    ];
    const explain = await client.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY}`,
      parameters,
    );
    const plan = explain.rows[0]["QUERY PLAN"][0].Plan;
    const findEligibleCte = (node: Record<string, unknown>): Record<string, unknown> | null => {
      if (node["Subplan Name"] === "CTE eligible_snapshots") return node;
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) {
        const found = findEligibleCte(child);
        if (found) return found;
      }
      return null;
    };
    expect(findEligibleCte(plan)?.["Actual Rows"]).toBe(1);
    expect(await read(null, "ad-requested")).toMatchObject([{
      decision_entity_id: "ad-requested", label: "keep",
    }]);
  });
});
