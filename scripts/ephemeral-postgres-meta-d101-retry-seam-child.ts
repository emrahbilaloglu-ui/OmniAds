/** A migrated-Postgres seam for the D101 retry and orphan-receipt repair. */
import { getDb, resetDbClientCache } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { createMetaFinalizationCompletenessProof } from "@/lib/meta/finalization-proof";
import {
  getMetaCorePublishedRetryState,
  getMetaPositiveSpendAdIdsForPublishedRun,
  listMetaRawSnapshotsForRun,
  replaceMetaAdDailySlice,
  supersedeMetaRawSnapshotsForPartition,
} from "@/lib/meta/warehouse";

const BUSINESS = "d1010000-0000-4000-8000-000000000001";
const ACCOUNT = "act_d101_retry_seam";
const ACCOUNT_REF = "d1010000-0000-4000-8000-000000000002";
const DAY = "2026-09-22";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`D101 retry seam: ${message}`);
}

async function main() {
  if (process.env.ADSECUTE_EPHEMERAL_DB_SEAM !== "1" ||
      !process.env.DATABASE_URL?.includes("127.0.0.1") ||
      process.env.DATABASE_URL.includes(":15432")) {
    throw new Error("D101 retry seam requires the migrated ephemeral database");
  }
  const db = getDb();
  await db.query(`
    INSERT INTO users (id, name, email, password_hash)
    VALUES ('d1010000-0000-4000-8000-000000000003', 'D101 retry',
            'd101-retry@adsecute.local', 'x')
  `);
  await db.query(`
    INSERT INTO businesses (id, name, owner_id)
    VALUES ($1::uuid, 'D101 retry seam',
            'd1010000-0000-4000-8000-000000000003'::uuid)
  `, [BUSINESS]);
  await db.query(`
    INSERT INTO provider_accounts
      (id, provider, external_account_id, account_name, currency, timezone)
    VALUES ($1::uuid, 'meta', $2, 'D101 retry seam', 'USD', 'UTC')
  `, [ACCOUNT_REF, ACCOUNT]);
  await db.query(`
    INSERT INTO business_provider_accounts
      (business_id, provider, provider_account_ref_id, provider_account_id,
       position, is_selected)
    VALUES ($1::uuid, 'meta', $2::uuid, $3, 0, TRUE)
  `, [BUSINESS, ACCOUNT_REF, ACCOUNT]);
  const [partition] = await db.query<{ id: string }>(`
    INSERT INTO meta_sync_partitions
      (business_id, provider_account_id, lane, scope, partition_date, status, source)
    VALUES ($1, $2, 'maintenance', 'account_daily', $3::date, 'dead_letter', 'finalize_day')
    RETURNING id::text AS id
  `, [BUSINESS, ACCOUNT, DAY]);
  assert(partition, "partition fixture missing");
  const runId = partition.id;
  const snapshots: string[] = [];

  for (const page of [0, 1]) {
    const [snapshot] = await db.query<{ id: string }>(`
      INSERT INTO meta_raw_snapshots
        (business_id, provider_account_id, endpoint_name, entity_scope,
         page_index, start_date, end_date, payload_json, payload_hash, content_key,
         provider_http_status, status)
      VALUES ($1, $2, 'breakdown_country', 'account', $3, $4::date, $4::date,
              '[]'::jsonb, $5, $6, 200, 'fetched')
      RETURNING id::text AS id
    `, [BUSINESS, ACCOUNT, page, DAY, `hash-${page}`, `d101-retry-${runId}-${page}`]);
    assert(snapshot, `raw page ${page} missing`);
    snapshots.push(snapshot.id);
    await db.query(`
      INSERT INTO meta_raw_snapshot_observations
        (snapshot_id, business_id, provider_account_id, partition_id, run_id,
         endpoint_name, entity_scope, page_index, provider_cursor, status,
         provider_http_status, observed_at)
      VALUES ($1::uuid, $2, $3, $4::uuid, $4, 'breakdown_country', 'account',
              $5, $6, 'fetched', 200, now())
    `, [snapshot.id, BUSINESS, ACCOUNT, runId, page, page === 0 ? "next-page" : null]);
  }
  const before = await listMetaRawSnapshotsForRun({
    partitionId: runId, endpointName: "breakdown_country", runId,
  });
  assert(before.length === 2, "the orphan fixture must expose both raw pages");
  const retired = await supersedeMetaRawSnapshotsForPartition({
    partitionId: runId, runId, endpointName: "breakdown_country",
  });
  assert(retired === 2, `expected two scoped retirements, got ${retired}`);
  const after = await listMetaRawSnapshotsForRun({
    partitionId: runId, endpointName: "breakdown_country", runId,
  });
  assert(after.length === 0, "retired orphan pages must not resume");
  // The same canonical content may be fetched again after an older
  // supersession. Its new receipt must be independently retireable.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await db.query(`
    INSERT INTO meta_raw_snapshot_observations
      (snapshot_id, business_id, provider_account_id, partition_id, run_id,
       endpoint_name, entity_scope, page_index, provider_cursor, status,
       provider_http_status, observed_at)
    VALUES ($1::uuid, $2, $3, $4::uuid, $4, 'breakdown_country', 'account',
            0, 'next-page', 'fetched', 200, now())
  `, [snapshots[0], BUSINESS, ACCOUNT, runId]);
  const newPage = await listMetaRawSnapshotsForRun({
    partitionId: runId, endpointName: "breakdown_country", runId,
  });
  assert(newPage.length === 1 && newPage[0]?.page_index === 0,
    "new receipt of shared content must be visible after old retirement");
  const secondRetire = await supersedeMetaRawSnapshotsForPartition({
    partitionId: runId, runId, endpointName: "breakdown_country",
  });
  assert(secondRetire === 1, "a refetched canonical page must be retired again");
  const thirdRetire = await supersedeMetaRawSnapshotsForPartition({
    partitionId: runId, runId, endpointName: "breakdown_country",
  });
  assert(thirdRetire === 0, "retirement must be idempotent without a new fetch");

  const surfaces = ["account_daily", "campaign_daily", "adset_daily", "ad_daily"];
  for (const [index, surface] of surfaces.entries()) {
    const [slice] = await db.query<{ id: string }>(`
      INSERT INTO meta_authoritative_slice_versions
        (business_id, provider_account_id, day, surface, candidate_version,
         state, truth_state, validation_status, status, source_run_id, published_at)
      VALUES ($1, $2, $3::date, $4, 1, 'finalized_verified', 'finalized',
              'passed', 'published', $5, now())
      RETURNING id::text AS id
    `, [BUSINESS, ACCOUNT, DAY, surface, runId]);
    assert(slice, `slice ${surface} missing`);
    if (index !== surfaces.length - 1) {
      await db.query(`
        INSERT INTO meta_authoritative_publication_pointers
          (business_id, provider_account_id, day, surface,
           active_slice_version_id, published_by_run_id, publication_reason)
        VALUES ($1, $2, $3::date, $4, $5::uuid, $6, 'authoritative_finalize')
      `, [BUSINESS, ACCOUNT, DAY, surface, slice.id, runId]);
    }
  }
  await db.query(`
    UPDATE meta_authoritative_slice_versions
    SET business_ref_id=$1::uuid, provider_account_ref_id=$2::uuid
    WHERE business_id=$1 AND provider_account_id=$3 AND day=$4::date
  `, [BUSINESS, ACCOUNT_REF, ACCOUNT, DAY]);
  await db.query(`
    UPDATE meta_authoritative_publication_pointers
    SET business_ref_id=$1::uuid, provider_account_ref_id=$2::uuid
    WHERE business_id=$1 AND provider_account_id=$3 AND day=$4::date
  `, [BUSINESS, ACCOUNT_REF, ACCOUNT, DAY]);
  const partial = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY, partitionId: runId,
    accountTimezone: "UTC",
  });
  assert(!partial.complete && !partial.active && partial.requiresProviderRefetch,
    "a missing Ad pointer must allow the unfinished core to repair itself");
  const [adSlice] = await db.query<{ id: string }>(`
    SELECT id::text AS id FROM meta_authoritative_slice_versions
    WHERE business_id=$1 AND provider_account_id=$2 AND day=$3::date
      AND surface='ad_daily' AND source_run_id=$4
  `, [BUSINESS, ACCOUNT, DAY, runId]);
  assert(adSlice, "Ad slice missing");
  await db.query(`
    INSERT INTO meta_authoritative_publication_pointers
      (business_id, provider_account_id, day, surface,
       active_slice_version_id, published_by_run_id, publication_reason)
    VALUES ($1, $2, $3::date, 'ad_daily', $4::uuid, $5, 'authoritative_finalize')
  `, [BUSINESS, ACCOUNT, DAY, adSlice.id, runId]);
  await db.query(`
    UPDATE meta_authoritative_publication_pointers
    SET business_ref_id=$1::uuid, provider_account_ref_id=$2::uuid
    WHERE business_id=$1 AND provider_account_id=$3 AND day=$4::date
      AND surface='ad_daily'
  `, [BUSINESS, ACCOUNT_REF, ACCOUNT, DAY]);
  const noManifest = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY, partitionId: runId,
    accountTimezone: "UTC",
  });
  assert(!noManifest.complete, "a published slice without its manifest must refetch");
  const [manifest] = await db.query<{ id: string }>(`
    INSERT INTO meta_authoritative_source_manifests
      (business_id, provider_account_id, day, surface, account_timezone,
       source_kind, source_window_kind, run_id, fetch_status, completed_at)
    VALUES ($1, $2, $3::date, 'account_daily', 'UTC', 'meta_insights',
            'complete_day', $4, 'completed', '2026-09-22T12:00:00Z')
    RETURNING id::text AS id
  `, [BUSINESS, ACCOUNT, DAY, runId]);
  assert(manifest, "Ad source manifest missing");
  await db.query(`
    UPDATE meta_authoritative_source_manifests
    SET business_ref_id=$1::uuid, provider_account_ref_id=$2::uuid
    WHERE id=$3::uuid
  `, [BUSINESS, ACCOUNT_REF, manifest.id]);
  await db.query(`
    UPDATE meta_authoritative_slice_versions SET manifest_id=$1::uuid
    WHERE id=$2::uuid
  `, [manifest.id, adSlice.id]);
  const early = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY, partitionId: runId,
    accountTimezone: "UTC",
  });
  assert(!early.complete && early.requiresProviderRefetch,
    "a provider fetch before local close must refetch, not restamp old raw pages");
  await db.query(`
    UPDATE meta_authoritative_source_manifests
    SET completed_at='2026-09-23T01:00:00Z' WHERE id=$1::uuid
  `, [manifest.id]);
  const active = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY, partitionId: runId,
    accountTimezone: "UTC",
  });
  assert(active.complete && active.active,
    "only same-run core with post-close Ad proof may be reused on retry");
  // A zero-row publish can leave an older generation's Ad rows behind. Such
  // rows make the active slice inadmissible even though no row bears runId.
  const staleAdRunId = randomUUID();
  await db.query(`
    INSERT INTO meta_ad_daily
      (business_id, business_ref_id, provider_account_id,
       provider_account_ref_id, date, ad_id, account_timezone,
       account_currency, spend, source_run_id)
    VALUES ($1::text, $1::uuid, $2, $3::uuid, $4::date,
            'ad-stale-run', 'UTC', 'USD', 10, $5)
  `, [BUSINESS, ACCOUNT, ACCOUNT_REF, DAY, staleAdRunId]);
  const staleAdRows = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY, partitionId: runId,
    accountTimezone: "UTC",
  });
  assert(!staleAdRows.complete && !staleAdRows.active &&
      staleAdRows.requiresProviderRefetch,
    "Ad rows from a different source run must invalidate retry proof");
  await replaceMetaAdDailySlice({
    slice: { businessId: BUSINESS, providerAccountId: ACCOUNT, date: DAY },
    rows: [],
    proof: createMetaFinalizationCompletenessProof({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      date: DAY,
      scope: "ad",
      sourceRunId: runId,
      complete: true,
      validationStatus: "passed",
    }),
  });
  const [remainingStaleAd] = await db.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count FROM meta_ad_daily
    WHERE business_id=$1 AND provider_account_id=$2 AND date=$3::date
  `, [BUSINESS, ACCOUNT, DAY]);
  assert(Number(remainingStaleAd?.count) === 0,
    "a proved zero-Ad refetch must remove older source-run rows");
  const repairedEmptyAd = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY, partitionId: runId,
    accountTimezone: "UTC",
  });
  assert(repairedEmptyAd.complete && repairedEmptyAd.active,
    "the empty authoritative Ad replacement must make retry proof reusable");
  const [campaignSlice] = await db.query<{ id: string }>(`
    SELECT id::text AS id FROM meta_authoritative_slice_versions
    WHERE business_id=$1 AND provider_account_id=$2 AND day=$3::date
      AND surface='campaign_daily' AND source_run_id=$4
  `, [BUSINESS, ACCOUNT, DAY, runId]);
  assert(campaignSlice, "campaign slice missing");
  await db.query(`
    DELETE FROM meta_authoritative_publication_pointers
    WHERE business_id=$1 AND provider_account_id=$2 AND day=$3::date
      AND surface='campaign_daily'
  `, [BUSINESS, ACCOUNT, DAY]);
  const missingCampaignPointer = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY, partitionId: runId,
    accountTimezone: "UTC",
  });
  assert(!missingCampaignPointer.complete && missingCampaignPointer.requiresProviderRefetch,
    "a missing non-Ad core pointer cannot be hidden by valid Ad proof");
  await db.query(`
    INSERT INTO meta_authoritative_publication_pointers
      (business_id, business_ref_id, provider_account_id,
       provider_account_ref_id, day, surface, active_slice_version_id,
       published_by_run_id, publication_reason)
    VALUES ($1::text, $1::uuid, $2, $3::uuid, $4::date, 'campaign_daily',
            $5::uuid, $6, 'authoritative_finalize')
  `, [BUSINESS, ACCOUNT, ACCOUNT_REF, DAY, campaignSlice.id, runId]);
  const pendingRunId = randomUUID();
  const [pendingOtherRun] = await db.query<{ id: string }>(`
    INSERT INTO meta_authoritative_slice_versions
      (business_id, business_ref_id, provider_account_id,
       provider_account_ref_id, day, surface, candidate_version, state,
       truth_state, validation_status, status, source_run_id)
    VALUES ($1::text, $1::uuid, $2, $3::uuid, $4::date, 'ad_daily', 2,
            'finalizing', 'finalized', 'pending', 'staging', $5)
    RETURNING id::text AS id
  `, [BUSINESS, ACCOUNT, ACCOUNT_REF, DAY, pendingRunId]);
  assert(pendingOtherRun, "pending new-run Ad slice missing");
  const oldPointer = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY,
    partitionId: runId, sourceRunId: pendingRunId, accountTimezone: "UTC",
    repairCaptureInProgress: true,
  });
  assert(!oldPointer.complete && oldPointer.requiresProviderRefetch,
    "an older active pointer cannot supersede a newer staged capture");
  await db.query(`DELETE FROM meta_authoritative_slice_versions WHERE id=$1::uuid`,
    [pendingOtherRun.id]);
  const [unfinishedAdSlice] = await db.query<{ id: string }>(`
    INSERT INTO meta_authoritative_slice_versions
      (business_id, business_ref_id, provider_account_id,
       provider_account_ref_id, day, surface, candidate_version, state,
       truth_state, validation_status, status, source_run_id)
    VALUES ($1::text, $1::uuid, $2, $3::uuid, $4::date, 'ad_daily', 2,
            'finalizing', 'finalized', 'pending', 'staging', $5)
    RETURNING id::text AS id
  `, [BUSINESS, ACCOUNT, ACCOUNT_REF, DAY, runId]);
  assert(unfinishedAdSlice, "unfinished Ad candidate missing");
  const interrupted = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY, partitionId: runId,
    accountTimezone: "UTC",
  });
  assert(!interrupted.complete && interrupted.requiresProviderRefetch,
    "an older published slice cannot hide a newer unfinished candidate");
  await db.query(`DELETE FROM meta_authoritative_slice_versions WHERE id=$1::uuid`,
    [unfinishedAdSlice.id]);
  const wrongTimezone = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY, partitionId: runId,
    accountTimezone: "America/Los_Angeles",
  });
  assert(!wrongTimezone.complete,
    "a corrected provider-account timezone must invalidate an old retry shortcut");
  const foreign = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: "act_other", day: DAY, partitionId: runId,
    accountTimezone: "UTC",
  });
  assert(!foreign.complete, "a different physical account cannot inherit the publication");
  // A forced provider refetch must mint a NEW source run. Reusing runId would
  // make createMetaAuthoritativeSliceVersion return the old manifest-bound
  // candidate, even if the provider supplied new post-close facts.
  await db.query(`
    UPDATE meta_authoritative_source_manifests
    SET completed_at='2026-09-22T12:00:00Z' WHERE id=$1::uuid
  `, [manifest.id]);
  const invalidOld = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY, partitionId: runId,
    accountTimezone: "UTC",
  });
  assert(!invalidOld.complete && invalidOld.requiresProviderRefetch,
    "old early source must request a genuinely new provider generation");
  const freshRunId = randomUUID();
  const [freshManifest] = await db.query<{ id: string }>(`
    INSERT INTO meta_authoritative_source_manifests
      (business_id, business_ref_id, provider_account_id,
       provider_account_ref_id, day, surface, account_timezone, source_kind,
       source_window_kind, run_id, fetch_status, completed_at)
    VALUES ($1::text, $1::uuid, $2, $3::uuid, $4::date, 'account_daily',
            'UTC', 'meta_insights', 'complete_day', $5, 'completed',
            now() - interval '1 minute')
    RETURNING id::text AS id
  `, [BUSINESS, ACCOUNT, ACCOUNT_REF, DAY, freshRunId]);
  assert(freshManifest && freshManifest.id !== manifest.id,
    "fresh source manifest must retain a separate identity");
  for (const surface of surfaces) {
    const [freshSlice] = await db.query<{ id: string }>(`
      INSERT INTO meta_authoritative_slice_versions
        (business_id, business_ref_id, provider_account_id,
         provider_account_ref_id, day, surface, manifest_id,
         candidate_version, state, truth_state, validation_status, status,
         source_run_id, published_at)
      VALUES ($1::text, $1::uuid, $2, $3::uuid, $4::date, $5, $6::uuid, 2,
              'finalized_verified', 'finalized', 'passed', 'published', $7, now())
      RETURNING id::text AS id
    `, [BUSINESS, ACCOUNT, ACCOUNT_REF, DAY, surface, freshManifest.id, freshRunId]);
    assert(freshSlice, `fresh ${surface} slice missing`);
    await db.query(`
      UPDATE meta_authoritative_publication_pointers
      SET active_slice_version_id=$1::uuid, published_by_run_id=$2,
          published_at=now(), updated_at=now()
      WHERE business_id=$3 AND provider_account_id=$4 AND day=$5::date
        AND surface=$6
    `, [freshSlice.id, freshRunId, BUSINESS, ACCOUNT, DAY, surface]);
  }
  const fresh = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY,
    partitionId: runId, sourceRunId: freshRunId, accountTimezone: "UTC",
  });
  assert(fresh.complete && fresh.active && !fresh.requiresProviderRefetch,
    "a fresh post-close source run must carry its own admissible manifest and slices");
  const stale = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY, partitionId: runId,
    accountTimezone: "UTC",
  });
  assert(stale.complete && !stale.active && !stale.requiresProviderRefetch,
    "a failed older run must not overwrite newer active core pointers");
  await db.query(`
    INSERT INTO meta_sync_runs
      (partition_id, business_id, provider_account_id, lane, scope,
       partition_date, status, finished_at)
    VALUES ($1::uuid, $2, $3, 'maintenance', 'account_daily', $4::date,
            'succeeded', now() + interval '1 second')
  `, [runId, BUSINESS, ACCOUNT, DAY]);
  const newRequest = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: DAY, partitionId: runId,
    accountTimezone: "UTC",
  });
  assert(!newRequest.complete && newRequest.requiresProviderRefetch,
    "a completed prior partition must perform a fresh provider read");

  // A delayed today partition rotates to a capture UUID. Neither the retry
  // guard nor the breakdown Ad filter may silently substitute partition_id.
  const captureRunId = randomUUID();
  const delayedDay = "2026-09-23";
  const [delayedPartition] = await db.query<{ id: string }>(`
    INSERT INTO meta_sync_partitions
      (business_id, provider_account_id, lane, scope, partition_date, status, source)
    VALUES ($1, $2, 'core', 'account_daily', $3::date, 'failed', 'today')
    RETURNING id::text AS id
  `, [BUSINESS, ACCOUNT, delayedDay]);
  assert(delayedPartition, "delayed today partition missing");
  for (const surface of surfaces) {
    const [slice] = await db.query<{ id: string }>(`
      INSERT INTO meta_authoritative_slice_versions
        (business_id, provider_account_id, day, surface, candidate_version,
         state, truth_state, validation_status, status, source_run_id, published_at)
      VALUES ($1, $2, $3::date, $4, 1, 'finalized_verified', 'finalized',
              'passed', 'published', $5, now())
      RETURNING id::text AS id
    `, [BUSINESS, ACCOUNT, delayedDay, surface, captureRunId]);
    assert(slice, `delayed ${surface} slice missing`);
    await db.query(`
      INSERT INTO meta_authoritative_publication_pointers
        (business_id, provider_account_id, day, surface,
         active_slice_version_id, published_by_run_id, publication_reason)
      VALUES ($1, $2, $3::date, $4, $5::uuid, $6, 'authoritative_finalize')
    `, [BUSINESS, ACCOUNT, delayedDay, surface, slice.id, captureRunId]);
  }
  await db.query(`
    UPDATE meta_authoritative_slice_versions
    SET business_ref_id=$1::uuid, provider_account_ref_id=$2::uuid
    WHERE business_id=$1 AND provider_account_id=$3 AND day=$4::date
  `, [BUSINESS, ACCOUNT_REF, ACCOUNT, delayedDay]);
  await db.query(`
    UPDATE meta_authoritative_publication_pointers
    SET business_ref_id=$1::uuid, provider_account_ref_id=$2::uuid
    WHERE business_id=$1 AND provider_account_id=$3 AND day=$4::date
  `, [BUSINESS, ACCOUNT_REF, ACCOUNT, delayedDay]);
  const [delayedManifest] = await db.query<{ id: string }>(`
    INSERT INTO meta_authoritative_source_manifests
      (business_id, provider_account_id, day, surface, account_timezone,
       source_kind, source_window_kind, run_id, fetch_status, completed_at)
    VALUES ($1, $2, $3::date, 'account_daily', 'UTC', 'meta_insights',
            'complete_day', $4, 'completed', '2026-09-24T01:00:00Z')
    RETURNING id::text AS id
  `, [BUSINESS, ACCOUNT, delayedDay, captureRunId]);
  assert(delayedManifest, "delayed Ad source manifest missing");
  await db.query(`
    UPDATE meta_authoritative_source_manifests
    SET business_ref_id=$1::uuid, provider_account_ref_id=$2::uuid
    WHERE id=$3::uuid
  `, [BUSINESS, ACCOUNT_REF, delayedManifest.id]);
  await db.query(`
    UPDATE meta_authoritative_slice_versions SET manifest_id=$1::uuid
    WHERE business_id=$2 AND provider_account_id=$3 AND day=$4::date
      AND surface='ad_daily' AND source_run_id=$5
  `, [delayedManifest.id, BUSINESS, ACCOUNT, delayedDay, captureRunId]);
  const delayedProof = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: delayedDay,
    partitionId: delayedPartition.id, sourceRunId: captureRunId,
    accountTimezone: "UTC",
  });
  assert(delayedProof.complete && delayedProof.active,
    "delayed finalization must reuse the exact capture UUID");
  const guessedProof = await getMetaCorePublishedRetryState({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: delayedDay,
    partitionId: delayedPartition.id, accountTimezone: "UTC",
  });
  assert(!guessedProof.complete, "partition ID must not impersonate the capture UUID");
  for (const [adId, sourceRunId] of [
    ["ad-capture", captureRunId], ["ad-other", delayedPartition.id],
  ]) {
    await db.query(`
      INSERT INTO meta_ad_daily
        (business_id, business_ref_id, provider_account_id,
         provider_account_ref_id, date, ad_id, account_timezone,
         account_currency, spend, source_run_id)
      VALUES ($1::text, $1::uuid, $2, $3::uuid, $4::date, $5, 'UTC', 'USD', 10, $6)
    `, [BUSINESS, ACCOUNT, ACCOUNT_REF, delayedDay, adId, sourceRunId]);
  }
  const delayedAdIds = await getMetaPositiveSpendAdIdsForPublishedRun({
    businessId: BUSINESS, providerAccountId: ACCOUNT, day: delayedDay,
    sourceRunId: captureRunId,
  });
  assert(delayedAdIds.length === 1 && delayedAdIds[0] === "ad-capture",
    "breakdown Ad list must be scoped to the published capture UUID");
  console.log("[meta-d101-retry-seam] PASS: scoped orphan retirement, retry reuse, fresh-request boundary");
  await resetDbClientCache();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
