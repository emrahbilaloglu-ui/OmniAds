/**
 * PostgreSQL seam for the exact source-coverage CTE embedded in native Ad
 * hydration. The test extracts the shipped SQL instead of maintaining a test
 * copy, then gives PostgreSQL adversarial publication lineages to choose from.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { sharedEphemeralDatabaseUrl } from "@/lib/test-utils/shared-ephemeral-database";
import { HYDRATE_AD_DECISION_INPUTS_QUERY } from "./data-source";

const DATABASE_URL = sharedEphemeralDatabaseUrl();
const suite = DATABASE_URL ? describe : describe.skip;

const BUSINESS_ID = "00000000-0000-4000-8000-000000000701";
const ACCOUNT_REF_ID = "00000000-0000-4000-8000-000000000711";
const ACCOUNT_ID = "act-coverage-exact";
const WRONG_ACCOUNT_REF_ID = "00000000-0000-4000-8000-000000000799";
const CUTOFF = "2026-07-10T03:15:00.000Z";

const coverageCtes = HYDRATE_AD_DECISION_INPUTS_QUERY.slice(
  HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf(
    "source_coverage_manifest_identity AS (",
  ),
  HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("current_config_scope AS ("),
)
  .replace(/,\s*$/, "")
  // The standalone seam has five inputs rather than hydration's thirteen.
  // Only the ordinal changes; the imported production expression does not.
  .replaceAll("$11", "$4");

const COVERAGE_QUERY = `
WITH assigned_accounts AS (
  SELECT
    $1::text AS business_id,
    $2::uuid AS provider_account_ref_id,
    $3::text AS provider_account_id
),
selected_accounts AS (
  SELECT business_id, provider_account_id FROM assigned_accounts
),
account_identity AS (
  SELECT
    $2::uuid AS provider_account_ref_id,
    $3::text AS provider_account_id,
    $5::text AS account_timezone,
    'USD'::text AS account_currency
),
${coverageCtes}
SELECT
  provider_account_ref_id::text,
  provider_account_id,
  expected_through_day::text,
  coverage_through_day::text,
  source_completed_at::text,
  published_at::text,
  coverage_status
FROM account_source_coverage
`;

type CandidateOverride = {
  providerAccountRefId?: string;
  providerAccountId?: string;
  surface?: string;
  manifestSurface?: string;
  manifestFetchStatus?: string;
  sliceState?: string;
  sliceTruthState?: string;
  sliceValidationStatus?: string;
  sliceStatus?: string;
  sliceRunId?: string;
  manifestRunId?: string;
  pointerRunId?: string;
  completedAt?: string;
  publishedAt?: string;
  pointerCreatedAt?: string;
  pointerUpdatedAt?: string;
  accountTimezone?: string;
};

suite("native Ad source coverage freshness in PostgreSQL", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL! });
    await client.connect();
    await client.query(`
      CREATE TEMP TABLE meta_authoritative_source_manifests (
        id uuid PRIMARY KEY,
        business_ref_id uuid,
        business_id text NOT NULL,
        provider_account_ref_id uuid,
        provider_account_id text NOT NULL,
        day date NOT NULL,
        surface text NOT NULL,
        account_timezone text NOT NULL,
        run_id text,
        fetch_status text NOT NULL,
        completed_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TEMP TABLE meta_authoritative_slice_versions (
        id uuid PRIMARY KEY,
        business_ref_id uuid,
        business_id text NOT NULL,
        provider_account_ref_id uuid,
        provider_account_id text NOT NULL,
        day date NOT NULL,
        surface text NOT NULL,
        manifest_id uuid,
        candidate_version integer NOT NULL,
        state text NOT NULL,
        truth_state text NOT NULL,
        validation_status text NOT NULL,
        status text NOT NULL,
        source_run_id text,
        published_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TEMP TABLE meta_authoritative_publication_pointers (
        id uuid PRIMARY KEY,
        business_ref_id uuid,
        business_id text NOT NULL,
        provider_account_ref_id uuid,
        provider_account_id text NOT NULL,
        day date NOT NULL,
        surface text NOT NULL,
        active_slice_version_id uuid NOT NULL,
        published_by_run_id text,
        published_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
    `);
  });

  afterAll(async () => {
    await client?.end();
  });

  async function reset() {
    await client.query(`
      TRUNCATE meta_authoritative_publication_pointers,
               meta_authoritative_slice_versions,
               meta_authoritative_source_manifests
    `);
  }

  async function insertLineage(input: {
    key: number;
    day: string;
    overrides?: CandidateOverride;
  }) {
    const override = input.overrides ?? {};
    const suffix = String(input.key).padStart(12, "0");
    const manifestId = `10000000-0000-4000-8000-${suffix}`;
    const sliceId = `20000000-0000-4000-8000-${suffix}`;
    const pointerId = `30000000-0000-4000-8000-${suffix}`;
    const providerAccountRefId =
      override.providerAccountRefId ?? ACCOUNT_REF_ID;
    const providerAccountId = override.providerAccountId ?? ACCOUNT_ID;
    const surface = override.surface ?? "ad_daily";
    const sliceRunId = override.sliceRunId ?? `run-${input.key}`;
    const manifestRunId = override.manifestRunId ?? sliceRunId;
    const pointerRunId = override.pointerRunId ?? sliceRunId;
    const publishedAt =
      override.publishedAt ??
      (input.day === "2026-07-09"
        ? "2026-07-10T01:00:00.000Z"
        : "2026-07-09T01:00:00.000Z");
    const completedAt =
      override.completedAt ??
      (input.day === "2026-07-09"
        ? "2026-07-10T00:30:00.000Z"
        : "2026-07-09T00:30:00.000Z");
    const createdAt =
      override.pointerCreatedAt ?? "2026-07-09T00:00:00.000Z";
    const updatedAt = override.pointerUpdatedAt ?? publishedAt;

    await client.query(
      `INSERT INTO meta_authoritative_source_manifests (
         id, business_ref_id, business_id, provider_account_ref_id,
         provider_account_id, day, surface, account_timezone, run_id,
         fetch_status, completed_at, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::date, $7,
                 $8, $9, $10, $11::timestamptz,
                 '2026-07-09T00:00:00.000Z'::timestamptz,
                 LEAST($11::timestamptz, $12::timestamptz))`,
      [
        manifestId,
        BUSINESS_ID,
        BUSINESS_ID,
        providerAccountRefId,
        providerAccountId,
        input.day,
        override.manifestSurface ?? "account_daily",
        override.accountTimezone ?? "UTC",
        manifestRunId,
        override.manifestFetchStatus ?? "completed",
        completedAt,
        CUTOFF,
      ],
    );
    await client.query(
      `INSERT INTO meta_authoritative_slice_versions (
         id, business_ref_id, business_id, provider_account_ref_id,
         provider_account_id, day, surface, manifest_id, candidate_version,
         state, truth_state, validation_status, status, source_run_id,
         published_at, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::date, $7,
                 $8::uuid, 1, $9, $10, $11, $12, $13,
                 $14::timestamptz,
                 '2026-07-09T00:00:00.000Z'::timestamptz,
                 LEAST($14::timestamptz, $15::timestamptz))`,
      [
        sliceId,
        BUSINESS_ID,
        BUSINESS_ID,
        providerAccountRefId,
        providerAccountId,
        input.day,
        surface,
        manifestId,
        override.sliceState ?? "finalized_verified",
        override.sliceTruthState ?? "finalized",
        override.sliceValidationStatus ?? "passed",
        override.sliceStatus ?? "published",
        sliceRunId,
        publishedAt,
        CUTOFF,
      ],
    );
    await client.query(
      `INSERT INTO meta_authoritative_publication_pointers (
         id, business_ref_id, business_id, provider_account_ref_id,
         provider_account_id, day, surface, active_slice_version_id,
         published_by_run_id, published_at, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::date, $7,
                 $8::uuid, $9, $10::timestamptz, $11::timestamptz,
                 $12::timestamptz)`,
      [
        pointerId,
        BUSINESS_ID,
        BUSINESS_ID,
        providerAccountRefId,
        providerAccountId,
        input.day,
        surface,
        sliceId,
        pointerRunId,
        publishedAt,
        createdAt,
        updatedAt,
      ],
    );
  }

  async function readCoverage(accountTimezone: string | null = "UTC") {
    const params = [
      BUSINESS_ID,
      ACCOUNT_REF_ID,
      ACCOUNT_ID,
      CUTOFF,
      accountTimezone,
    ];
    return client.query(COVERAGE_QUERY, params);
  }

  it("accepts an ad_daily pointer/slice backed by its exact account_daily run manifest", async () => {
    await reset();
    await insertLineage({ key: 1, day: "2026-07-09" });

    const result = await readCoverage();
    expect(result.rows).toEqual([
      expect.objectContaining({
        provider_account_ref_id: ACCOUNT_REF_ID,
        provider_account_id: ACCOUNT_ID,
        expected_through_day: "2026-07-09",
        coverage_through_day: "2026-07-09",
        coverage_status: "complete",
      }),
    ]);
  });

  it("uses exact completed manifest timezone for a complete empty account-day with no ad_daily identity row", async () => {
    await reset();
    await insertLineage({ key: 2, day: "2026-07-09" });

    const result = await readCoverage(null);
    expect(result.rows[0]).toMatchObject({
      expected_through_day: "2026-07-09",
      coverage_through_day: "2026-07-09",
      coverage_status: "complete",
    });
  });

  it("fails closed when exact ad_daily and manifest timezone evidence disagree", async () => {
    await reset();
    await insertLineage({
      key: 3,
      day: "2026-07-09",
      overrides: { accountTimezone: "Europe/Istanbul" },
    });

    const result = await readCoverage("UTC");
    expect(result.rows[0]).toMatchObject({
      expected_through_day: null,
      coverage_through_day: null,
      coverage_status: "unavailable",
    });
  });

  it.each([
    ["wrong physical account", { providerAccountRefId: WRONG_ACCOUNT_REF_ID }],
    ["wrong surface", { surface: "campaign_daily" }],
    ["failed manifest", { manifestFetchStatus: "failed" }],
    ["failed slice validation", { sliceValidationStatus: "failed" }],
    ["wrong manifest run", { manifestRunId: "other-run" }],
    ["wrong publication run", { pointerRunId: "other-run" }],
    [
      "source completion before provider-local day close",
      {
        completedAt: "2026-07-09T23:30:00.000Z",
        publishedAt: "2026-07-10T01:00:00.000Z",
      },
    ],
    [
      "post-cutoff pointer",
      {
        publishedAt: "2026-07-10T04:00:00.000Z",
        pointerCreatedAt: "2026-07-10T04:00:00.000Z",
        pointerUpdatedAt: "2026-07-10T04:00:00.000Z",
      },
    ],
    ["publication before provider-local day close", { publishedAt: "2026-07-09T23:59:59.000Z" }],
    [
      "source completion after publication",
      {
        completedAt: "2026-07-10T01:30:00.000Z",
        publishedAt: "2026-07-10T01:00:00.000Z",
      },
    ],
  ] as const)("rejects %s and falls back to the last valid older day", async (_name, overrides) => {
    await reset();
    await insertLineage({ key: 10, day: "2026-07-08" });
    await insertLineage({
      key: 11,
      day: "2026-07-09",
      overrides: { ...overrides },
    });

    const result = await readCoverage();
    expect(result.rows).toEqual([
      expect.objectContaining({
        expected_through_day: "2026-07-09",
        coverage_through_day: "2026-07-08",
        coverage_status: "partial",
      }),
    ]);
  });

  it("executes the shipped CTE under the D099 statement budget", async () => {
    await reset();
    await insertLineage({ key: 20, day: "2026-07-09" });
    await client.query("SET statement_timeout = '30s'");
    const startedAt = performance.now();
    const explained = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${COVERAGE_QUERY}`,
      [
        BUSINESS_ID,
        ACCOUNT_REF_ID,
        ACCOUNT_ID,
        CUTOFF,
        "UTC",
      ],
    );
    const elapsedMs = performance.now() - startedAt;
    const plan = explained.rows[0]?.["QUERY PLAN"]?.[0];
    expect(plan?.["Execution Time"]).toBeTypeOf("number");
    expect(elapsedMs).toBeLessThan(30_000);
  });
});
