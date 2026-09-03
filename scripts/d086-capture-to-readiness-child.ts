#!/usr/bin/env node
/**
 * The D086 capture-to-readiness child. Runs INSIDE the ephemeral cluster the
 * parent created; refuses to run anywhere else.
 *
 * Correction 8 rejected r8's version of this seam because its provenance was
 * fabricated: partition ids and snapshot ids were invented strings with no
 * `meta_sync_partitions` row behind them, no `persistMetaRawSnapshot` call and
 * no linkage the database could enforce. Every capture below now begins with a
 * real core-lane partition and a real raw snapshot, so the cohort a receipt
 * names is a cohort that exists.
 */
import { getDb } from "@/lib/db";
import { runMigrations } from "@/lib/migrations";
import { mapCampaignObservationState, mapAdSetObservationState } from "@/lib/api/meta";
import {
  persistMetaEntityObservation,
  persistMetaExplicitEntityTombstone,
} from "@/lib/meta/entity-state-history";
import {
  buildMetaRawSnapshotHash,
  persistMetaRawSnapshot,
  queueMetaSyncPartition,
} from "@/lib/meta/warehouse";
import {
  readBudgetReadiness,
  D086_STATE_BUDGET_SQL,
  D086_ACCOUNT_TIMEZONE_SQL,
} from "@/lib/meta/budget-readiness-read-model";
import { buildCanonicalBudgetFact } from "@/lib/meta/budget-fact";
import { toBudgetObservation } from "@/lib/meta/budget-observation-projection";
import {
  D086_CAPABILITY_PROBE_SQL,
  D086_INDEX_CATALOG_SQL,
  D086_REQUIRED_PROFILE_COLUMNS,
  D086_REQUIRED_ROLE_COLUMNS,
  D086_REQUIRED_RUN_COLUMNS,
  D086_REQUIRED_RECEIPT_COLUMNS,
  D086_REQUIRED_STATE_COLUMNS,
  D086_REQUIRED_TOMBSTONE_COLUMNS,
  D086_REQUIRED_PARTITION_COLUMNS,
  D086_REQUIRED_RAW_OBSERVATION_COLUMNS,
  D086_REQUIRED_INDEXES,
  classifyIndexCatalog,
} from "@/lib/meta/budget-readiness-retention";

const steps: Array<{ step: string; detail: string }> = [];
const cases: Array<{
  name: string;
  mechanics: string;
  status: string;
  blocker: string | null;
  attested: boolean;
}> = [];
const failures: string[] = [];
const note = (step: string, detail: string) => steps.push({ step, detail });
const check = (condition: unknown, message: string) => {
  if (!condition) failures.push(message);
};

const BIZ = "11111111-1111-4111-8111-111111111111";
const OWNER = "55555555-5555-4555-8555-555555555555";
const READ_AT = "2026-08-31T12:00:00.000Z";

/** Raw Meta-shaped responses. This is where a real sync begins. */
interface RawCampaignRow {
  id: string; name: string; status: string; effective_status: string;
  daily_budget?: string; updated_time: string;
}
interface RawAdSetRow {
  id: string; name: string; campaign_id: string; status: string;
  effective_status: string; daily_budget?: string; updated_time: string;
}

const RAW_CAMPAIGNS: RawCampaignRow[] = [
  {
    id: "c_100", name: "Prospecting", status: "ACTIVE", effective_status: "ACTIVE",
    daily_budget: "250000", updated_time: "2026-08-30T09:00:00+0000",
  },
  {
    id: "c_200", name: "Retargeting", status: "ACTIVE", effective_status: "ACTIVE",
    updated_time: "2026-08-30T09:00:00+0000",
  },
];
const RAW_ADSETS: RawAdSetRow[] = [
  {
    id: "a_10", name: "Broad", campaign_id: "c_100", status: "ACTIVE",
    effective_status: "ACTIVE", updated_time: "2026-08-30T09:00:00+0000",
  },
  {
    id: "a_20", name: "Lookalike", campaign_id: "c_200", status: "ACTIVE",
    effective_status: "ACTIVE", daily_budget: "90000",
    updated_time: "2026-08-30T09:00:00+0000",
  },
];

type Credentials = Parameters<typeof mapCampaignObservationState>[0]["credentials"];

const credentials = {
  businessId: BIZ,
  accessToken: "unused-by-the-mapper",
  accountIds: [] as string[],
  accountProfiles: {} as Record<string, { timezone: string; currency: string }>,
} as unknown as Credentials;

async function main() {
  const expected = process.env.D086_E2E_EXPECTED_URL ?? "";
  const actual = process.env.DATABASE_URL ?? "";
  if (!expected || actual !== expected) {
    throw new Error("Refusing to run: DATABASE_URL is not the ephemeral cluster.");
  }
  if (!/127\.0\.0\.1:\d+\/d086_e2e$/.test(actual)) {
    throw new Error("Refusing to run: DATABASE_URL does not name the e2e database.");
  }

  // 1. The REAL migration registry builds the schema.
  await runMigrations({ force: true, reason: "d086_e2e" });
  const sql = getDb();
  const version = (await sql.query<{ version: string }>("SELECT version()"))[0]?.version ?? "";
  note("migrations", "the registered migration set applied to a fresh cluster");

  const receiptColumns = await sql.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='meta_entity_observation_receipts'
      ORDER BY column_name`,
  );
  check(receiptColumns.length > 0,
    "the registered migration did not create meta_entity_observation_receipts");
  check(receiptColumns.some((row) => row.column_name === "source_snapshot_ref_id"),
    "the receipt table has no typed snapshot reference");
  const receiptConstraints = await sql.query<{ conname: string; convalidated: boolean }>(
    `SELECT conname, convalidated FROM pg_constraint
      WHERE conrelid = 'meta_entity_observation_receipts'::regclass AND contype = 'f'
      ORDER BY conname`,
  );
  const constraintNames = receiptConstraints.map((row) => row.conname);
  for (const required of [
    "meta_entity_observation_receipts_partition_fk",
    "meta_entity_observation_receipts_snapshot_fk",
  ]) {
    check(constraintNames.includes(required),
      `the receipt table is missing the ${required} foreign key`);
  }
  note("receipt_table",
    `${receiptColumns.length} columns and ${constraintNames.length} foreign keys created by `
    + `the registry: ${constraintNames.join(", ")}`);

  await sql.query(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ($1, 'D086 e2e', 'd086-e2e@example.invalid', 'x')
     ON CONFLICT (id) DO NOTHING`, [OWNER]);
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, timezone, currency)
     VALUES ($1, 'D086 e2e', $2, 'Europe/Istanbul', 'TRY')
     ON CONFLICT (id) DO NOTHING`, [BIZ, OWNER]);

  let accountSeq = 0;
  const newAccount = async (): Promise<string> => {
    accountSeq += 1;
    const pad = String(accountSeq).padStart(2, "0");
    const ref = `2222222${accountSeq % 10}-2222-4222-8222-2222222222${pad}`;
    const external = `act_7701${pad}`;
    await sql.query(
      `INSERT INTO provider_accounts
         (id, provider, external_account_id, account_name, currency, timezone)
       VALUES ($1, 'meta', $2, 'D086 e2e account', 'TRY', 'Europe/Istanbul')
       ON CONFLICT (id) DO NOTHING`, [ref, external]);
    await sql.query(
      `INSERT INTO business_provider_accounts
         (business_id, provider_account_ref_id, provider_account_id, provider)
       VALUES ($1, $2, $3, 'meta') ON CONFLICT DO NOTHING`, [BIZ, ref, external]);
    const profiles = credentials as unknown as {
      accountIds: string[];
      accountProfiles: Record<string, { timezone: string; currency: string }>;
    };
    profiles.accountProfiles[external] = { timezone: "Europe/Istanbul", currency: "TRY" };
    profiles.accountIds.push(external);
    return external;
  };

  /** A REAL core-lane partition. This is what a receipt's cohort must name. */
  const realPartition = async (input: {
    account: string; day: string; lane?: "core" | "extended"; scope?: string;
  }): Promise<string> => {
    const queued = await queueMetaSyncPartition({
      businessId: BIZ,
      providerAccountId: input.account,
      lane: (input.lane ?? "core") as never,
      scope: (input.scope ?? "account_daily") as never,
      partitionDate: input.day,
      status: "succeeded",
      priority: 0,
      source: "system",
      attemptCount: 1,
    });
    const id = queued?.id ?? null;
    if (!id) throw new Error("the partition queue returned no row");
    return id;
  };

  /** A REAL raw snapshot, which also writes its own observation receipt. */
  const realSnapshot = async (input: {
    account: string; partitionId: string; endpointName: string; entityScope: string;
    day: string; payload: unknown; status?: "fetched" | "failed";
  }): Promise<string> => {
    const id = await persistMetaRawSnapshot({
      businessId: BIZ,
      providerAccountId: input.account,
      partitionId: input.partitionId,
      endpointName: input.endpointName,
      entityScope: input.entityScope,
      startDate: input.day,
      endDate: input.day,
      accountTimezone: "Europe/Istanbul",
      accountCurrency: "TRY",
      payloadJson: input.payload,
      payloadHash: buildMetaRawSnapshotHash({
        businessId: BIZ,
        providerAccountId: input.account,
        endpointName: input.endpointName,
        startDate: input.day,
        endDate: input.day,
        payload: input.payload,
      }),
      requestContext: { source: "d086_e2e" },
      providerHttpStatus: 200,
      status: input.status ?? "fetched",
    });
    if (!id) throw new Error(`persistMetaRawSnapshot returned no id for ${input.endpointName}`);
    return id;
  };

  interface CaptureOptions {
    account: string;
    day: string;
    observedAt: string;
    capturedAt: string;
    campaigns?: RawCampaignRow[];
    adsets?: RawAdSetRow[];
    campaignEndpoint?: string;
    completeness?: "complete" | "partial" | "failed";
    /** Deliberately break the cohort's provenance, one way at a time. */
    breakage?:
      | "missing_partition" | "foreign_partition" | "extended_lane"
      | "missing_snapshot" | "snapshot_partition_mismatch" | "snapshot_endpoint_mismatch";
    foreignAccount?: string;
    partitionId?: string;
  }

  const realCapture = async (options: CaptureOptions) => {
    const account = options.account;
    const campaigns = options.campaigns ?? RAW_CAMPAIGNS;
    const adsets = options.adsets ?? RAW_ADSETS;
    const completeness = options.completeness ?? "complete";
    const campaignEndpoint = options.campaignEndpoint ?? "campaign_configs";

    let partitionId = options.partitionId
      ?? await realPartition({
        account: options.breakage === "foreign_partition"
          ? (options.foreignAccount ?? account) : account,
        day: options.day,
        lane: options.breakage === "extended_lane" ? "extended" : "core",
        scope: options.breakage === "extended_lane" ? "creative_daily" : "account_daily",
      });
    if (options.breakage === "missing_partition") {
      /*
        A receipt that PREDATES the foreign key.

        The constraint now makes an orphan cohort impossible to write, which is
        the fix — so the only way one exists is to have been written before it,
        and that is exactly what the read-side validation is for. Dropping the
        constraint, writing the row and re-adding it NOT VALID reproduces that
        history faithfully rather than pretending the FK is absent.
      */
      partitionId = "00000000-0000-4000-8000-000000000000";
      await sql.query(
        `ALTER TABLE meta_entity_observation_receipts
           DROP CONSTRAINT IF EXISTS meta_entity_observation_receipts_partition_fk`);
    }

    const snapshotPartition = options.breakage === "snapshot_partition_mismatch"
      ? await realPartition({ account, day: "2026-08-01" })
      : partitionId;

    let campaignSnapshot: string | null = null;
    let adsetSnapshot: string | null = null;
    if (options.breakage !== "missing_partition") {
      campaignSnapshot = await realSnapshot({
        account, partitionId: snapshotPartition,
        endpointName: options.breakage === "snapshot_endpoint_mismatch"
          ? "ad_configs" : campaignEndpoint,
        entityScope: "campaign", day: options.day, payload: campaigns,
      });
      adsetSnapshot = await realSnapshot({
        account, partitionId: snapshotPartition, endpointName: "adset_configs",
        entityScope: "adset", day: options.day, payload: adsets,
      });
    }
    if (options.breakage === "missing_snapshot") campaignSnapshot = null;

    const campaignStates = campaigns
      .map((row) => mapCampaignObservationState({
        credentials, accountId: account, row: row as never,
        responseObservedAt: options.observedAt, capturedAt: options.capturedAt,
      }).state)
      .filter((state): state is NonNullable<typeof state> => state !== null);
    const adsetStates = adsets
      .map((row) => mapAdSetObservationState({
        credentials, accountId: account, row: row as never,
        responseObservedAt: options.observedAt, capturedAt: options.capturedAt,
      }).state)
      .filter((state): state is NonNullable<typeof state> => state !== null);

    const campaignRun = await persistMetaEntityObservation({
      businessId: BIZ, providerAccountId: account, entityType: "campaign",
      endpoint: campaignEndpoint, observedAt: options.observedAt,
      capturedAt: options.capturedAt, completeness, pageCount: 1,
      providerRowCount: campaignStates.length,
      states: completeness === "failed" ? [] : campaignStates,
      sourceSnapshotId: campaignSnapshot,
      error: completeness === "complete" ? null : { reason: "seam_case" },
      captureReceipt: {
        partitionId,
        sourceSnapshotId: campaignSnapshot,
        sourceSnapshotRefId: campaignSnapshot,
      },
    });
    const adsetRun = await persistMetaEntityObservation({
      businessId: BIZ, providerAccountId: account, entityType: "adset",
      endpoint: "adset_configs", observedAt: options.observedAt,
      capturedAt: options.capturedAt, completeness: "complete", pageCount: 1,
      providerRowCount: adsetStates.length, states: adsetStates,
      sourceSnapshotId: adsetSnapshot, error: null,
      captureReceipt: {
        partitionId,
        sourceSnapshotId: adsetSnapshot,
        sourceSnapshotRefId: adsetSnapshot,
      },
    });
    if (options.breakage === "missing_partition") {
      await sql.query(
        `ALTER TABLE meta_entity_observation_receipts
           ADD CONSTRAINT meta_entity_observation_receipts_partition_fk
           FOREIGN KEY (partition_id) REFERENCES meta_sync_partitions(id)
           ON DELETE RESTRICT NOT VALID`);
    }
    return { campaignRun, adsetRun, partitionId, campaignSnapshot, adsetSnapshot };
  };

  const readFor = async (account: string, nowIso = READ_AT) => {
    const model = await readBudgetReadiness(getDb(), {
      businessId: BIZ, providerAccountId: account, nowIso,
      approvedResolverVersion:
        "campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01",
    });
    return model.dimensions.find((d) => d.key === "budget_fact_retention");
  };

  const record = async (
    name: string, mechanics: string, account: string,
    expectedResult: { status: string; blocker: string | null }, nowIso = READ_AT,
  ) => {
    const dimension = await readFor(account, nowIso);
    cases.push({
      name, mechanics,
      status: dimension?.status ?? "missing",
      blocker: dimension?.blocker ?? null,
      attested: dimension?.coverage?.universe?.completeRunAttested === true,
    });
    check(
      dimension?.status === expectedResult.status
        && (dimension?.blocker ?? null) === expectedResult.blocker,
      `${name}: expected ${expectedResult.status}/${expectedResult.blocker ?? "none"}, got `
      + `${dimension?.status}/${dimension?.blocker ?? "none"}`,
    );
    return dimension;
  };

  // -----------------------------------------------------------------------
  // 1. A REAL FULL capture, with real partition and real snapshots.
  // -----------------------------------------------------------------------
  const fullAccount = await newAccount();
  const first = await realCapture({
    account: fullAccount, day: "2026-08-30",
    observedAt: "2026-08-30T09:05:00.000Z", capturedAt: "2026-08-30T09:06:00.000Z",
  });
  const linkage = await sql.query<{
    partition_id: string; source_snapshot_ref_id: string | null;
    lane: string; scope: string; obs_endpoint: string | null;
  }>(
    `SELECT rc.partition_id::text, rc.source_snapshot_ref_id::text,
            part.lane, part.scope, obs.endpoint_name AS obs_endpoint
       FROM meta_entity_observation_receipts rc
       JOIN meta_sync_partitions part ON part.id = rc.partition_id
       LEFT JOIN meta_raw_snapshot_observations obs
              ON obs.snapshot_id = rc.source_snapshot_ref_id
      WHERE rc.business_id = $1 AND rc.provider_account_id = $2
        AND rc.entity_type = 'campaign'`,
    [BIZ, fullAccount]);
  check(linkage.length === 1, `expected 1 campaign receipt, found ${linkage.length}`);
  check(linkage[0]?.lane === "core" && linkage[0]?.scope === "account_daily",
    "the receipt's partition is not the core current-inventory partition");
  check(linkage[0]?.source_snapshot_ref_id === first.campaignSnapshot,
    "the receipt does not reference the raw snapshot it was mapped from");
  check(linkage[0]?.obs_endpoint === "campaign_configs",
    "no raw snapshot observation matches the receipt's endpoint");
  note("real_linkage",
    `receipt -> partition(${linkage[0]?.lane}/${linkage[0]?.scope}) -> snapshot`
    + `(${linkage[0]?.obs_endpoint}) proven by join`);

  // The UNCHANGED second heartbeat: identical truth, a NEW real partition.
  const second = await realCapture({
    account: fullAccount, day: "2026-08-30",
    observedAt: "2026-08-30T10:05:00.000Z", capturedAt: "2026-08-30T10:06:00.000Z",
    partitionId: await realPartition({ account: fullAccount, day: "2026-08-29" }),
  });
  check(second.campaignRun.coalesced === true,
    "the second identical campaign sync appended a new run instead of coalescing");
  check(second.campaignRun.runId === first.campaignRun.runId,
    "the coalesced campaign capture did not reuse the first run");
  const cohorts = await sql.query<{ partitions: string; runs: string }>(
    `SELECT count(DISTINCT partition_id)::text AS partitions,
            count(DISTINCT run_id)::text AS runs
       FROM meta_entity_observation_receipts
      WHERE business_id=$1 AND provider_account_id=$2 AND entity_type='campaign'`,
    [BIZ, fullAccount]);
  check(cohorts[0]?.runs === "1" && cohorts[0]?.partitions === "2",
    `expected 1 run across 2 cohorts, got ${cohorts[0]?.runs} run(s) across `
    + `${cohorts[0]?.partitions} cohort(s)`);
  note("cohort_proof",
    `${cohorts[0]?.runs} campaign run carries ${cohorts[0]?.partitions} real capture cohorts`);

  const diag = await sql.query<Record<string, unknown>>(
    `SELECT r.entity_type, r.id::text AS run_id, r.manifest_kind, r.row_count,
            r.completeness, r.captured_at::text AS captured_at,
            (SELECT count(*) FROM meta_entity_state_history s
              WHERE s.run_id = r.id AND s.presence = 'present') AS present_states,
            (SELECT count(*) FROM meta_entity_state_history s
              WHERE s.run_id = r.id) AS all_states
       FROM meta_entity_observation_runs r
      WHERE r.business_id=$1 AND r.provider_account_id=$2
      ORDER BY r.entity_type, r.captured_at`, [BIZ, fullAccount]);
  note("full_runs", JSON.stringify(diag));

  const fullDimension = await record("real_full_capture_ready",
    "real core partition + persistMetaRawSnapshot + real mappers + "
    + "persistMetaEntityObservation; second identical sync coalesced onto the same run "
    + "under a second real partition",
    fullAccount, { status: "ready", blocker: null });
  check(fullDimension?.coverage?.population === 4,
    `the current population should be the 4 latest identities, got `
    + `${fullDimension?.coverage?.population}`);
  check(fullDimension?.coverage?.universe?.manifestCampaignMembers === 2,
    "the campaign manifest did not enumerate 2 members");

  // -----------------------------------------------------------------------
  // 2. A GENUINE writer-produced DELTA: change one raw row, capture again.
  // -----------------------------------------------------------------------
  {
    const account = await newAccount();
    /*
      The provider clock has to PRECEDE the capture clock, or the mapper drops it
      as unknowable — and the row then differs between the two captures for a
      reason that has nothing to do with the change under test. That is what made
      r8's "delta" store every entity: c_200 looked changed because its
      provider_updated_at went from NULL to a value.
    */
    const baseCampaigns: RawCampaignRow[] = RAW_CAMPAIGNS.map((row) =>
      ({ ...row, updated_time: "2026-08-29T08:00:00+0000" }));
    const baseAdsets: RawAdSetRow[] = RAW_ADSETS.map((row) =>
      ({ ...row, updated_time: "2026-08-29T08:00:00+0000" }));
    const base = await realCapture({
      account, day: "2026-08-29", campaigns: baseCampaigns, adsets: baseAdsets,
      observedAt: "2026-08-29T09:05:00.000Z", capturedAt: "2026-08-29T09:06:00.000Z",
    });
    // ONE campaign changes; the other is byte-identical to the base capture.
    const changed: RawCampaignRow[] = [
      { ...baseCampaigns[0]!, daily_budget: "300000",
        updated_time: "2026-08-30T08:00:00+0000" },
      baseCampaigns[1]!,
    ];
    const delta = await realCapture({
      account, day: "2026-08-30", campaigns: changed, adsets: baseAdsets,
      observedAt: "2026-08-30T09:05:00.000Z", capturedAt: "2026-08-30T09:06:00.000Z",
    });
    check(delta.campaignRun.runId !== base.campaignRun.runId,
      "the changed capture did not append a new run");
    check(delta.campaignRun.manifestKind === "delta",
      `the writer did not produce a delta manifest (got `
      + `${String(delta.campaignRun.manifestKind)})`);
    const physical = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM meta_entity_state_history
        WHERE run_id = $1::uuid AND entity_type = 'campaign'`, [delta.campaignRun.runId]);
    const stats = delta.campaignRun.deltaStats;
    note("delta_stats", JSON.stringify(stats));
    check((stats?.changedEntityCount ?? 0) === 1,
      `the writer diffed ${stats?.changedEntityCount} changed entities, expected 1`);
    check((stats?.physicalStateRows ?? 0) < RAW_CAMPAIGNS.length,
      `the delta wrote ${stats?.physicalStateRows} physical state rows, not a subset`);
    check(Number(physical[0]?.count ?? 0) === 1,
      `the delta run holds ${physical[0]?.count} campaign states, expected exactly the changed one`);
    check((stats?.logicalEntityCount ?? 0) === RAW_CAMPAIGNS.length,
      `the delta's logical scope is ${stats?.logicalEntityCount}, expected `
      + `${RAW_CAMPAIGNS.length}`);
    const dimension = await record("real_writer_delta_ready",
      `the second capture changed one raw campaign budget, so the writer itself returned `
      + `manifestKind='delta' over a logical scope of ${stats?.logicalEntityCount} with `
      + `${stats?.changedEntityCount} changed and ${stats?.physicalStateRows} physical state `
      + `rows (${physical[0]?.count} campaign rows on the delta run); the unchanged member is `
      + `reconstructed from the base run`,
      account, { status: "ready", blocker: null });
    check(dimension?.coverage?.universe?.manifestCampaignMembers === 2,
      "the delta manifest did not reconstruct both campaign members");
    check(dimension?.coverage?.population === 4,
      `the delta population should be 4 identities, got ${dimension?.coverage?.population}`);
    note("delta_mechanics",
      `base run ${base.campaignRun.runId} -> delta run ${delta.campaignRun.runId}, `
      + `${physical[0]?.count} physical campaign states, 2 reconstructed members`);
  }

  // -----------------------------------------------------------------------
  // 3. A REAL SCOPE EXIT: a campaign disappears from the payload.
  // -----------------------------------------------------------------------
  {
    const account = await newAccount();
    await realCapture({
      account, day: "2026-08-29",
      observedAt: "2026-08-29T09:05:00.000Z", capturedAt: "2026-08-29T09:06:00.000Z",
    });
    const exited = await realCapture({
      account, day: "2026-08-30",
      campaigns: [RAW_CAMPAIGNS[0]!],
      adsets: [RAW_ADSETS[0]!],
      observedAt: "2026-08-30T09:05:00.000Z", capturedAt: "2026-08-30T09:06:00.000Z",
    });
    const dimension = await record("real_scope_exit_ready",
      "the second capture omitted c_200 and a_20 entirely, so the writer recorded the "
      + "exits and the manifest must enumerate exactly the surviving identities",
      account, { status: "ready", blocker: null });
    check(dimension?.coverage?.universe?.manifestCampaignMembers === 1,
      `the exited campaign is still a member `
      + `(${dimension?.coverage?.universe?.manifestCampaignMembers})`);
    check(dimension?.coverage?.universe?.manifestAdsetMembers === 1,
      `the exited ad-set is still a member `
      + `(${dimension?.coverage?.universe?.manifestAdsetMembers})`);
    check(dimension?.coverage?.population === 2,
      `the population after the exit should be 2, got ${dimension?.coverage?.population}`);
    note("scope_exit_mechanics",
      `run ${exited.campaignRun.runId} manifest=${String(exited.campaignRun.manifestKind)}, `
      + `1 campaign member and 1 ad-set member survive`);
  }

  // -----------------------------------------------------------------------
  // 4. FUTURE HEARTBEAT: a later coalesce must not erase historical evidence.
  // -----------------------------------------------------------------------
  {
    const account = await newAccount();
    await realCapture({
      account, day: "2026-08-30",
      observedAt: "2026-08-30T09:05:00.000Z", capturedAt: "2026-08-30T09:06:00.000Z",
    });
    const before = await readFor(account, "2026-08-31T00:00:00.000Z");
    check(before?.status === "ready",
      `the historical read was not ready BEFORE the heartbeat (${before?.status})`);
    // A heartbeat AFTER the historical cutoff. It advances last_seen_at and
    // last_captured_at on the coalesced run.
    await realCapture({
      account, day: "2026-08-30",
      observedAt: "2026-09-01T09:05:00.000Z", capturedAt: "2026-09-01T09:06:00.000Z",
      partitionId: await realPartition({ account, day: "2026-09-01" }),
    });
    const heartbeat = await sql.query<{ last_captured_at: string | null }>(
      `SELECT last_captured_at::text FROM meta_entity_observation_runs
        WHERE business_id=$1 AND provider_account_id=$2 AND entity_type='campaign'
        ORDER BY captured_at DESC LIMIT 1`, [BIZ, account]);
    check(heartbeat[0]?.last_captured_at !== null,
      "the heartbeat did not advance the mutable clock, so the case proves nothing");
    await record("future_heartbeat_preserves_history",
      `a heartbeat at 2026-09-01 advanced last_captured_at to `
      + `${heartbeat[0]?.last_captured_at}; the read at the earlier 2026-08-31 cutoff must `
      + "still see the 2026-08-30 occurrence",
      account, { status: "ready", blocker: null }, "2026-08-31T00:00:00.000Z");
  }

  // -----------------------------------------------------------------------
  // 5. Cohort provenance: each way it can be wrong, named separately.
  // -----------------------------------------------------------------------
  const provenanceCases: Array<{
    name: string; breakage: CaptureOptions["breakage"]; blocker: string; mechanics: string;
  }> = [
    {
      name: "missing_partition_never_attests", breakage: "missing_partition",
      blocker: "budget_universe_campaign_partition_absent",
      mechanics: "the receipt names a partition id with no meta_sync_partitions row",
    },
    {
      name: "foreign_partition_never_attests", breakage: "foreign_partition",
      blocker: "budget_universe_campaign_partition_scope_mismatch",
      mechanics: "the receipt names a real partition belonging to another provider account",
    },
    {
      name: "extended_lane_partition_never_attests", breakage: "extended_lane",
      blocker: "budget_universe_campaign_partition_lane_mismatch",
      mechanics: "the receipt names a real extended-lane creative_daily partition",
    },
    {
      name: "missing_snapshot_never_attests", breakage: "missing_snapshot",
      blocker: "budget_universe_campaign_snapshot_absent",
      mechanics: "the receipt carries no raw snapshot reference at all",
    },
    {
      name: "snapshot_partition_mismatch_never_attests", breakage: "snapshot_partition_mismatch",
      blocker: "budget_universe_campaign_snapshot_partition_mismatch",
      mechanics: "the raw snapshot was recorded under a different real partition",
    },
    {
      name: "snapshot_endpoint_mismatch_never_attests", breakage: "snapshot_endpoint_mismatch",
      blocker: "budget_universe_campaign_snapshot_endpoint_mismatch",
      mechanics: "the raw snapshot was recorded for ad_configs, not campaign_configs",
    },
  ];
  for (const entry of provenanceCases) {
    const account = await newAccount();
    const foreign = entry.breakage === "foreign_partition" ? await newAccount() : undefined;
    await realCapture({
      account, day: "2026-08-30",
      observedAt: "2026-08-30T09:05:00.000Z", capturedAt: "2026-08-30T09:06:00.000Z",
      breakage: entry.breakage, foreignAccount: foreign,
    });
    await record(entry.name, entry.mechanics, account,
      { status: "partial", blocker: entry.blocker });
  }

  // -----------------------------------------------------------------------
  // 6. Freshness and endpoint causes.
  // -----------------------------------------------------------------------
  for (const [name, completeness, blocker] of [
    ["newer_failed_blocks_older_complete", "failed", "budget_universe_campaign_capture_failed"],
    ["newer_partial_blocks_older_complete", "partial", "budget_universe_campaign_capture_partial"],
  ] as const) {
    const account = await newAccount();
    await realCapture({
      account, day: "2026-08-29",
      observedAt: "2026-08-30T09:05:00.000Z", capturedAt: "2026-08-30T09:06:00.000Z",
    });
    await realCapture({
      account, day: "2026-08-30", completeness,
      observedAt: "2026-08-30T11:05:00.000Z", capturedAt: "2026-08-30T11:06:00.000Z",
    });
    await record(name,
      `one complete capture at 09:06, then a ${completeness.toUpperCase()} capture at 11:06 `
      + "on the same endpoint; the older complete run is still present and readable",
      account, { status: "partial", blocker });
  }
  {
    const account = await newAccount();
    await realCapture({
      account, day: "2026-08-30", campaignEndpoint: "ad_configs",
      observedAt: "2026-08-30T09:05:00.000Z", capturedAt: "2026-08-30T09:06:00.000Z",
    });
    await record("wrong_endpoint_named",
      "the campaign capture recorded endpoint ad_configs; the receipt and the run both "
      + "carry it, so nothing is filtered away and the cause is visible",
      account, { status: "partial", blocker: "budget_universe_campaign_endpoint_mismatch" });
  }
  {
    const account = await newAccount();
    const dayPartition = await realPartition({ account, day: "2026-08-30" });
    const otherPartition = await realPartition({ account, day: "2026-08-28" });
    const campaignSnapshot = await realSnapshot({
      account, partitionId: dayPartition, endpointName: "campaign_configs",
      entityScope: "campaign", day: "2026-08-30", payload: RAW_CAMPAIGNS,
    });
    const adsetSnapshot = await realSnapshot({
      account, partitionId: otherPartition, endpointName: "adset_configs",
      entityScope: "adset", day: "2026-08-28", payload: RAW_ADSETS,
    });
    const observedAt = "2026-08-30T09:05:00.000Z";
    const capturedAt = "2026-08-30T09:06:00.000Z";
    const campaignStates = RAW_CAMPAIGNS
      .map((row) => mapCampaignObservationState({
        credentials, accountId: account, row: row as never,
        responseObservedAt: observedAt, capturedAt,
      }).state)
      .filter((state): state is NonNullable<typeof state> => state !== null);
    const adsetStates = RAW_ADSETS
      .map((row) => mapAdSetObservationState({
        credentials, accountId: account, row: row as never,
        responseObservedAt: observedAt, capturedAt,
      }).state)
      .filter((state): state is NonNullable<typeof state> => state !== null);
    await persistMetaEntityObservation({
      businessId: BIZ, providerAccountId: account, entityType: "campaign",
      endpoint: "campaign_configs", observedAt, capturedAt, completeness: "complete",
      pageCount: 1, providerRowCount: campaignStates.length, states: campaignStates,
      sourceSnapshotId: campaignSnapshot, error: null,
      captureReceipt: {
        partitionId: dayPartition, sourceSnapshotId: campaignSnapshot,
        sourceSnapshotRefId: campaignSnapshot,
      },
    });
    await persistMetaEntityObservation({
      businessId: BIZ, providerAccountId: account, entityType: "adset",
      endpoint: "adset_configs", observedAt, capturedAt, completeness: "complete",
      pageCount: 1, providerRowCount: adsetStates.length, states: adsetStates,
      sourceSnapshotId: adsetSnapshot, error: null,
      captureReceipt: {
        partitionId: otherPartition, sourceSnapshotId: adsetSnapshot,
        sourceSnapshotRefId: adsetSnapshot,
      },
    });
    await record("cohort_mismatch_across_syncs",
      "campaign and ad-set receipts name two DIFFERENT real core partitions at the same "
      + "capture clock",
      account, { status: "partial", blocker: "budget_universe_cohort_mismatch" });
  }

  // -----------------------------------------------------------------------
  // 7. An EXPLICIT DELETION, written by the real tombstone writer.
  // -----------------------------------------------------------------------
  {
    const account = await newAccount();
    await realCapture({
      account, day: "2026-08-30",
      observedAt: "2026-08-30T09:05:00.000Z", capturedAt: "2026-08-30T09:06:00.000Z",
    });
    await persistMetaExplicitEntityTombstone({
      businessId: BIZ, providerAccountId: account, entityType: "campaign",
      entityId: "c_200", endpoint: "campaign_configs", reason: "explicit_deleted",
      providerEvidence: { error: { code: 100, message: "Object does not exist" } },
      observedAt: "2026-08-30T10:00:00.000Z", capturedAt: "2026-08-30T10:00:30.000Z",
      sourceSnapshotId: null,
    });
    const tombstones = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM meta_entity_tombstones
        WHERE business_id=$1 AND provider_account_id=$2`, [BIZ, account]);
    check(Number(tombstones[0]?.count ?? 0) === 1,
      "the tombstone case did not write a row into meta_entity_tombstones");
    await record("explicit_tombstone_supersedes_manifest",
      `persistMetaExplicitEntityTombstone wrote ${tombstones[0]?.count} row into `
      + "meta_entity_tombstones after the manifest's own capture clock",
      account,
      { status: "partial", blocker: "budget_universe_campaign_membership_tombstoned" });
  }

  // -----------------------------------------------------------------------
  // 8. RECEIPT COLLISION: an exact retry is a no-op, a different one refuses.
  // -----------------------------------------------------------------------
  {
    const account = await newAccount();
    const capture = await realCapture({
      account, day: "2026-08-30",
      observedAt: "2026-08-30T09:05:00.000Z", capturedAt: "2026-08-30T09:06:00.000Z",
    });
    const before = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM meta_entity_observation_receipts
        WHERE business_id=$1 AND provider_account_id=$2`, [BIZ, account]);
    // An EXACT retry: same occurrence, same everything.
    await realCapture({
      account, day: "2026-08-30", partitionId: capture.partitionId,
      observedAt: "2026-08-30T09:05:00.000Z", capturedAt: "2026-08-30T09:06:00.000Z",
    });
    const after = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM meta_entity_observation_receipts
        WHERE business_id=$1 AND provider_account_id=$2`, [BIZ, account]);
    check(before[0]?.count === after[0]?.count,
      `an exact retry changed the receipt count (${before[0]?.count} -> ${after[0]?.count})`);

    // A CONTRADICTORY collision: same occurrence key, different truth.
    let refused = "";
    try {
      await persistMetaEntityObservation({
        businessId: BIZ, providerAccountId: account, entityType: "campaign",
        endpoint: "campaign_configs",
        observedAt: "2026-08-30T09:05:00.000Z", capturedAt: "2026-08-30T09:06:00.000Z",
        completeness: "complete", pageCount: 9, providerRowCount: 99,
        states: [], sourceSnapshotId: capture.campaignSnapshot, error: null,
        captureReceipt: {
          partitionId: capture.partitionId,
          sourceSnapshotId: capture.campaignSnapshot,
          sourceSnapshotRefId: capture.campaignSnapshot,
        },
      });
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    check(refused.includes("collision with a DIFFERENT occurrence"),
      `a contradictory receipt collision was not refused (got: ${refused || "no error"})`);
    const stillIntact = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM meta_entity_observation_receipts
        WHERE business_id=$1 AND provider_account_id=$2`, [BIZ, account]);
    check(stillIntact[0]?.count === after[0]?.count,
      "the refused collision left a partial write behind");
    await record("receipt_collision_refused",
      `an exact retry left the receipt count at ${after[0]?.count}; a colliding occurrence `
      + `with a different run, page count and row count was REFUSED: ${refused.slice(0, 120)}`,
      account, { status: "ready", blocker: null });
  }

  // -----------------------------------------------------------------------
  // 9. A TRUE TIE: two materially different receipts at the SAME clock,
  //    inserted in opposite physical order.
  // -----------------------------------------------------------------------
  for (const order of ["forward", "reversed"] as const) {
    const account = await newAccount();
    const capture = await realCapture({
      account, day: "2026-08-30",
      observedAt: "2026-08-30T09:05:00.000Z", capturedAt: "2026-08-30T09:06:00.000Z",
    });
    const rival = await realPartition({ account, day: "2026-08-27" });
    const rivalSnapshot = await realSnapshot({
      account, partitionId: rival, endpointName: "campaign_configs",
      entityScope: "campaign", day: "2026-08-27",
      payload: [{ ...RAW_CAMPAIGNS[0]!, daily_budget: "999999" }],
    });
    // The SAME captured_at as the real receipt, a different partition, snapshot
    // and row count: a genuine same-clock disagreement. Deleting and re-inserting
    // in the two orders makes the physical sequence the only difference.
    const rows: Array<[string, string, number]> = [
      [capture.partitionId, String(capture.campaignSnapshot), 2],
      [rival, rivalSnapshot, 1],
    ];
    const sequence = order === "forward" ? rows : [...rows].reverse();
    await sql.query(
      `DELETE FROM meta_entity_observation_receipts
        WHERE business_id=$1 AND provider_account_id=$2 AND entity_type='campaign'`,
      [BIZ, account]);
    for (const [partition, snapshot, rowCount] of sequence) {
      await sql.query(
        `INSERT INTO meta_entity_observation_receipts
           (receipt_contract, run_id, business_id, provider_account_id, entity_type,
            endpoint, partition_id, source_snapshot_id, source_snapshot_ref_id,
            capture_status, provider_row_count, page_count, run_reused,
            observed_at, captured_at)
         VALUES ('d086.observation-capture-receipt.v1', $3::uuid, $1, $2, 'campaign',
                 'campaign_configs', $4::uuid, $5::text, $7::uuid, 'complete', $6, 1, false,
                 '2026-08-30T09:05:00.000Z'::timestamptz,
                 '2026-08-30T09:06:00.000Z'::timestamptz)`,
        [BIZ, account, capture.campaignRun.runId, partition, snapshot, rowCount, snapshot]);
    }
    const ties = await sql.query<{ tied: string }>(
      `SELECT count(*)::text AS tied FROM meta_entity_observation_receipts
        WHERE business_id=$1 AND provider_account_id=$2 AND entity_type='campaign'
          AND captured_at = '2026-08-30T09:06:00.000Z'::timestamptz`, [BIZ, account]);
    check(ties[0]?.tied === "2",
      `the ${order} tie case did not create two same-clock receipts (${ties[0]?.tied})`);
    await record(`true_tie_${order}_insertion`,
      `two materially different campaign receipts at the EXACT same captured_at, inserted `
      + `in ${order} physical order (partitions ${sequence.map((r) => r[0]).join(" then ")})`,
      account,
      { status: "partial", blocker: "budget_universe_manifest_conflict" });
  }

  // -----------------------------------------------------------------------
  // 10. Capability and catalog, read from the live cluster.
  // -----------------------------------------------------------------------
  const probe = await sql.query<Record<string, unknown>>(
    D086_CAPABILITY_PROBE_SQL,
    [
      [...D086_REQUIRED_PARTITION_COLUMNS], [...D086_REQUIRED_PROFILE_COLUMNS],
      [...D086_REQUIRED_ROLE_COLUMNS], [...D086_REQUIRED_RUN_COLUMNS],
      [...D086_REQUIRED_RECEIPT_COLUMNS], [...D086_REQUIRED_STATE_COLUMNS],
      [...D086_REQUIRED_TOMBSTONE_COLUMNS], [...D086_REQUIRED_RAW_OBSERVATION_COLUMNS],
    ]);
  for (const [key, expectedCount] of [
    ["partition_columns", D086_REQUIRED_PARTITION_COLUMNS.length],
    ["raw_observation_columns", D086_REQUIRED_RAW_OBSERVATION_COLUMNS.length],
    ["run_columns", D086_REQUIRED_RUN_COLUMNS.length],
    ["receipt_columns", D086_REQUIRED_RECEIPT_COLUMNS.length],
    ["state_columns", D086_REQUIRED_STATE_COLUMNS.length],
    ["tombstone_columns", D086_REQUIRED_TOMBSTONE_COLUMNS.length],
  ] as const) {
    check(String(probe[0]?.[key] ?? "") === String(expectedCount),
      `${key}: the live cluster reports ${String(probe[0]?.[key])}, contract wants ${expectedCount}`);
  }
  const catalog = await sql.query<{ indexname: string; indexdef: string }>(
    D086_INDEX_CATALOG_SQL, [D086_REQUIRED_INDEXES.map((index) => index.indexName)]);
  const catalogVerdict = classifyIndexCatalog(catalog);
  check(catalogVerdict.satisfied,
    `the required indexes are not all usable: missing ${catalogVerdict.missing.join(",")} `
    + `unusable ${catalogVerdict.unusable.join(",")}`);
  note("capability_probe", JSON.stringify(probe[0] ?? {}));
  note("index_catalog", JSON.stringify({
    checked: D086_REQUIRED_INDEXES.map((index) => index.indexName),
    found: catalog.map((row) => row.indexname).sort(),
    satisfied: catalogVerdict.satisfied,
  }));

  // The canonical facts behind the READY case, so the evidence names them.
  const diagRows = await sql.query<Record<string, unknown>>(
    D086_STATE_BUDGET_SQL, [BIZ, fullAccount, READ_AT, 500]);
  const diagZone = String((await sql.query<Record<string, unknown>>(
    D086_ACCOUNT_TIMEZONE_SQL, [BIZ, fullAccount]))[0]?.account_timezone ?? "");
  const diagObs = diagRows
    .map((row) => toBudgetObservation({ ...row, entity_type: row.grain },
      { businessId: BIZ, providerAccountId: fullAccount }))
    .filter((o): o is NonNullable<typeof o> => o !== null);
  const byKey = new Map<string, typeof diagObs>();
  for (const o of diagObs) {
    const k = `${o.entityGrain}|${o.entityId}`;
    byKey.set(k, [...(byKey.get(k) ?? []), o]);
  }
  note("canonical_facts", `tz=${diagZone} rows=${diagRows.length} ` + diagObs.map((o) => {
    const f = buildCanonicalBudgetFact({
      businessId: BIZ, providerAccountId: fullAccount, entityGrain: o.entityGrain,
      entityId: o.entityId, parentCampaignId: o.parentCampaignId,
      pit: { asOf: READ_AT.slice(0, 10), timeZone: diagZone, requireRecordedByCutoff: true },
      entityObservations: byKey.get(`${o.entityGrain}|${o.entityId}`) ?? [],
      parentObservations: o.parentCampaignId
        ? (byKey.get(`campaign|${o.parentCampaignId}`) ?? []) : [],
    });
    return `${o.entityGrain}:${o.entityId}=${f.ownerMode}/${f.blockers.join(",") || "-"}`;
  }).join(" | "));

  return { version, probe: probe[0] ?? {}, catalog };
}

main()
  .then(({ version, probe, catalog }) => {
    console.log("__D086_E2E__" + JSON.stringify({
      ok: failures.length === 0, postgresVersion: version, steps, cases,
      capabilityProbe: probe, indexCatalog: catalog, failures,
    }));
    process.exit(0);
  })
  .catch((error) => {
    console.log("__D086_E2E__" + JSON.stringify({
      ok: false,
      postgresVersion: "",
      steps,
      cases,
      capabilityProbe: {},
      indexCatalog: [],
      failures: [...failures, error instanceof Error ? error.message : String(error)],
    }));
    process.exit(0);
  });
