// Runs only from the migrations-from-zero runner against its throwaway
// PostgreSQL cluster. All provider responses are in-process fakes.
import { createHash } from "node:crypto";
import { Client } from "pg";
import { getDb, resetDbClientCache, runDbTransaction } from "@/lib/db";
import { claimMetaAdDuplicateAction } from "@/lib/meta/ads-action-log";
import {
  appendMetaAdDuplicateAttemptStarted,
  buildMetaAdDuplicateCanonicalName,
  finalizeMetaAdDuplicateAttempt,
  finalizeMetaAdDuplicatePreProviderFailure,
  listMetaAdDuplicateReconciliationCandidates,
  reconcileMetaAdDuplicateAttempt,
  recordMetaAdDuplicateReconciliationObservation,
  type MetaAdDuplicateReconciliationCandidate,
  type MetaAdDuplicateScanCheckpoint,
} from "@/lib/meta/duplicate-ad-reconciliation-store";
import { duplicateAd } from "@/lib/meta/ads-write";

const PROVIDER_ACCOUNT_ID = "act_duplicate_seam";
const SOURCE_AD_ID = "duplicate_source_ad";
const SOURCE_CREATIVE_ID = "duplicate_source_creative";
const POST_PATH = "act_duplicate_seam/ads";
const ACCESS_TOKEN = "ephemeral-duplicate-secret";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`duplicate-ad seam FAILED: ${message}`);
}

function assertEphemeralDatabase() {
  if (process.env.ADSECUTE_EPHEMERAL_DB_SEAM !== "1") {
    throw new Error("Refusing duplicate-ad seam outside ephemeral runner.");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const parsed = new URL(databaseUrl);
  const port = Number(parsed.port || "5432");
  if (
    parsed.hostname !== "127.0.0.1" ||
    port === 5432 ||
    port === 15432
  ) {
    throw new Error("Refusing protected/non-ephemeral database target.");
  }
  return databaseUrl;
}

function markerFor(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function cursorHash(cursor: string | null) {
  return createHash("sha256")
    .update(cursor === null ? "first:" : `cursor:${cursor}`, "utf8")
    .digest("hex");
}

async function expectRejected(
  operation: () => Promise<unknown>,
  message: string,
  codes?: readonly string[],
) {
  try {
    await operation();
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (!codes || codes.includes(code)) return;
    const detail =
      error instanceof Error ? ` (${error.message})` : "";
    throw new Error(
      `${message}: unexpected SQL/error code ${code || "none"}${detail}`,
    );
  }
  throw new Error(`${message}: operation unexpectedly succeeded`);
}

function claimInput(input: {
  businessId: string;
  userId: string;
  marker: string;
  targetAdsetId: string;
}) {
  const canonicalAdName = buildMetaAdDuplicateCanonicalName(
    "Seam duplicate",
    input.marker,
  );
  return {
    businessId: input.businessId,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    adId: SOURCE_AD_ID,
    creativeId: SOURCE_CREATIVE_ID,
    targetAdsetId: input.targetAdsetId,
    dryRun: false,
    requestedBy: input.userId,
    payloadRequest: {
      method: "POST",
      endpoint: `/${POST_PATH}`,
      body: {
        adset_id: input.targetAdsetId,
        target_adset_id: input.targetAdsetId,
        name: canonicalAdName,
        status_option: "PAUSED",
        dry_run: false,
      },
      dry_run: false,
    },
    recIdOrigin: null,
    marker: input.marker,
    canonicalAdName,
    sinceMinutes: 10,
  };
}

async function acquireClaim(input: {
  businessId: string;
  userId: string;
  index: number;
  targetAdsetId?: string;
}) {
  const request = claimInput({
    businessId: input.businessId,
    userId: input.userId,
    marker: markerFor(input.index),
    targetAdsetId:
      input.targetAdsetId ?? `duplicate_target_adset_${input.index}`,
  });
  const claim = await claimMetaAdDuplicateAction(request);
  assert(claim.claimed, `claim ${input.index} was not acquired`);
  return { claim, request };
}

async function ageAttempt(sourceActionLogId: string) {
  const db = getDb();
  await db.query(
    `ALTER TABLE meta_ads_duplicate_action_attempt_events
     DISABLE TRIGGER trg_meta_ads_duplicate_attempt_immutable`,
  );
  try {
    await db.query(
      `WITH base AS (
         SELECT
           id,
           prepared_at - interval '10 minutes' AS shifted_prepared_at,
           lease_deadline - interval '10 minutes' AS shifted_lease_deadline,
           CASE WHEN started_at IS NULL THEN NULL
                ELSE started_at - interval '10 minutes'
           END AS shifted_started_at,
           jsonb_set(
             jsonb_set(
               evidence_json,
               '{preparedAt}',
               to_jsonb(to_char(
                 (prepared_at - interval '10 minutes') AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               ))
             ),
             '{leaseDeadline}',
             to_jsonb(to_char(
               (lease_deadline - interval '10 minutes') AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             ))
           ) AS shifted_base_evidence,
           started_at
         FROM meta_ads_duplicate_action_attempt_events
         WHERE source_action_log_id = $1::uuid
       ),
       shifted AS (
         SELECT
           *,
           CASE WHEN started_at IS NULL THEN shifted_base_evidence
                ELSE jsonb_set(
                  shifted_base_evidence,
                  '{startedAt}',
                  to_jsonb(to_char(
                    shifted_started_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                  ))
                )
           END AS shifted_evidence
         FROM base
       )
       UPDATE meta_ads_duplicate_action_attempt_events event
       SET prepared_at = shifted.shifted_prepared_at,
           lease_deadline = shifted.shifted_lease_deadline,
           started_at = shifted.shifted_started_at,
           evidence_json = shifted.shifted_evidence,
           evidence_hash = encode(
             digest(shifted.shifted_evidence::text, 'sha256'),
             'hex'
           )
       FROM shifted
       WHERE event.id = shifted.id`,
      [sourceActionLogId],
    );
  } finally {
    await db.query(
      `ALTER TABLE meta_ads_duplicate_action_attempt_events
       ENABLE TRIGGER trg_meta_ads_duplicate_attempt_immutable`,
    );
  }
}

async function ageLatestObservation(sourceActionLogId: string) {
  const db = getDb();
  await db.query(
    `ALTER TABLE meta_ads_duplicate_reconciliation_observations
     DISABLE TRIGGER trg_meta_ads_duplicate_observation_immutable`,
  );
  try {
    await db.query(
      `WITH source AS (
         SELECT *
         FROM meta_ads_duplicate_reconciliation_observations
         WHERE source_action_log_id = $1::uuid
         ORDER BY attempt_ordinal DESC
         LIMIT 1
       ),
       shifted AS (
         SELECT
           id,
           observed_at - interval '11 minutes' AS shifted_observed_at,
           captured_at - interval '11 minutes' AS shifted_captured_at,
           next_attempt_not_before - interval '11 minutes'
             AS shifted_next_attempt,
           jsonb_set(
             jsonb_set(
               jsonb_set(
                 jsonb_set(
                   evidence_json,
                   '{observedAt}',
                   to_jsonb(to_char(
                     (observed_at - interval '11 minutes')
                       AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   ))
                 ),
                 '{capturedAt}',
                 to_jsonb(to_char(
                   (captured_at - interval '11 minutes')
                     AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 ))
               ),
               '{nextAttemptNotBefore}',
               to_jsonb(to_char(
                 (next_attempt_not_before - interval '11 minutes')
                   AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               ))
             ),
             '{observationEvidence,observedAt}',
             to_jsonb(to_char(
               (observed_at - interval '11 minutes') AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             ))
           ) AS shifted_evidence
         FROM source
       )
       UPDATE meta_ads_duplicate_reconciliation_observations observation
       SET observed_at = shifted.shifted_observed_at,
           captured_at = shifted.shifted_captured_at,
           next_attempt_not_before = shifted.shifted_next_attempt,
           evidence_json = shifted.shifted_evidence,
           evidence_hash = encode(
             digest(shifted.shifted_evidence::text, 'sha256'),
             'hex'
           )
       FROM shifted
       WHERE observation.id = shifted.id`,
      [sourceActionLogId],
    );
  } finally {
    await db.query(
      `ALTER TABLE meta_ads_duplicate_reconciliation_observations
       ENABLE TRIGGER trg_meta_ads_duplicate_observation_immutable`,
    );
  }
}

async function candidateFor(sourceActionLogId: string) {
  const candidates =
    await listMetaAdDuplicateReconciliationCandidates(10);
  const candidate = candidates.find(
    (row) => row.sourceActionLogId === sourceActionLogId,
  );
  assert(candidate, `candidate ${sourceActionLogId} was not ready`);
  return candidate;
}

function scanEvidence(input: {
  candidate: MetaAdDuplicateReconciliationCandidate;
  checkpoint: MetaAdDuplicateScanCheckpoint;
  complete: boolean;
  blocker: string | null;
  segmentPageCount: number;
  segmentObservationCount: number;
  observedAt: string;
  pointVerificationBlocker?: string;
}) {
  return {
    contractVersion: "meta-ad-duplicate-provider-scan.v1",
    providerAccountId: input.candidate.providerAccountId,
    marker: input.candidate.marker,
    canonicalAdName: input.candidate.canonicalAdName,
    targetAdsetId: input.candidate.targetAdsetId,
    creativeId: input.candidate.sourceCreativeId,
    requestedStatus: input.candidate.requestedStatus,
    providerAdsPathname: `/v22.0/${PROVIDER_ACCOUNT_ID}/ads`,
    maxPages: 1,
    maxDurationMs: 1_000,
    complete: input.complete,
    blocker: input.blocker,
    pageCount: input.checkpoint.cumulativePageCount,
    observationCount: input.checkpoint.cumulativeObservationCount,
    exactMatchIds: input.checkpoint.cumulativeExactMatchIds,
    segmentPageCount: input.segmentPageCount,
    segmentObservationCount: input.segmentObservationCount,
    segmentStartCursorHash: input.checkpoint.segmentStartCursorHash,
    segmentEndCursorHash: input.checkpoint.segmentEndCursorHash,
    visitedCursorHashes: input.checkpoint.visitedCursorHashes,
    pages: [],
    observedAt: input.observedAt,
    ...(input.pointVerificationBlocker
      ? { pointVerificationBlocker: input.pointVerificationBlocker }
      : {}),
  };
}

function checkpoint(input: {
  cycleId: string;
  segmentIndex: number;
  start: string | null;
  end: string | null;
  visitedCursorHashes: string[];
  pageCount: number;
  observationCount: number;
  exactMatchIds: string[];
  complete: boolean;
}): MetaAdDuplicateScanCheckpoint {
  return {
    cycleId: input.cycleId,
    segmentIndex: input.segmentIndex,
    segmentStartAfterCursor: input.start,
    segmentStartCursorHash:
      input.start === null ? null : cursorHash(input.start),
    segmentEndAfterCursor: input.end,
    segmentEndCursorHash:
      input.end === null ? null : cursorHash(input.end),
    cycleComplete: input.complete,
    visitedCursorHashes: input.visitedCursorHashes,
    cumulativePageCount: input.pageCount,
    cumulativeObservationCount: input.observationCount,
    cumulativeExactMatchIds: input.exactMatchIds,
  };
}

async function recordScan(input: {
  candidate: MetaAdDuplicateReconciliationCandidate;
  checkpoint: MetaAdDuplicateScanCheckpoint;
  disposition:
    | "scan_segment_progress"
    | "point_verification_pending"
    | "complete_scan_absence";
  blocker: string | null;
  resultingAdId?: string | null;
  segmentPageCount: number;
  segmentObservationCount: number;
  pointVerificationBlocker?: string;
}) {
  const observedAt = new Date().toISOString();
  const evidence = scanEvidence({
    ...input,
    complete: input.checkpoint.cycleComplete,
    observedAt,
  });
  return recordMetaAdDuplicateReconciliationObservation({
    candidate: input.candidate,
    observationMethod: "account_ads_scan",
    disposition: input.disposition,
    resultingAdId: input.resultingAdId ?? null,
    scanComplete: input.checkpoint.cycleComplete,
    scannedPageCount: input.checkpoint.cumulativePageCount,
    observationCount: input.checkpoint.cumulativeObservationCount,
    exactMatchCount: input.checkpoint.cumulativeExactMatchIds.length,
    observedAt,
    observationEvidence: evidence,
    scanCheckpoint: input.checkpoint,
  });
}

function unverifiedProviderSuccessCompletion(input: {
  sourceActionLogId: string;
  startedAt: string;
  providerResponse: Record<string, unknown>;
  resultingAdId: string | null;
}): Parameters<typeof finalizeMetaAdDuplicateAttempt>[0] {
  const attemptedAt = new Date(
    Math.max(Date.now(), Date.parse(input.startedAt)),
  ).toISOString();
  return {
    sourceActionLogId: input.sourceActionLogId,
    successful: false,
    mutationReceipt: {
      attemptCount: 1,
      method: "POST",
      path: POST_PATH,
      attemptedAt,
      completedAt: new Date(Date.parse(attemptedAt) + 1).toISOString(),
      providerResponseReceived: true,
      providerResponseSuccessful: true,
      httpStatus: 200,
      outcome: "provider_response_received",
      automaticRetryAttempted: false,
      transportError: null,
    },
    providerResponse: input.providerResponse,
    verification: null,
    verificationObservedAt: null,
    resultingAdId: input.resultingAdId,
    errorCode: "duplicate_provider_success_verification_failed",
    errorMessage: "provider response was not independently verified",
    durationMs: 1,
  };
}

async function main() {
  /*
    The release capability, opened for this seam.

    The shared write choke point now reads it: with it shut, every product
    write — including this duplicate — answers `release_capability_closed`
    before reaching the fake provider, and the duplicate contract below could
    not be exercised at all. It is an environment fact a deployment opens
    deliberately, so this seam states it rather than inheriting whatever the
    process happens to have. The closed answer has its own coverage in
    `lib/meta/write-posture-enforcement.test.ts`.
  */
  process.env.META_AUTOMATION_LIVE_WRITES = "true";
  const databaseUrl = assertEphemeralDatabase();
  resetDbClientCache();
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const user = await admin.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Duplicate seam', 'duplicate-seam@example.invalid', 'x')
       RETURNING id::text`,
    );
    const userId = user.rows[0]!.id;
    const business = await admin.query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id)
       VALUES ('Duplicate seam', $1::uuid)
       RETURNING id::text`,
      [userId],
    );
    const businessId = business.rows[0]!.id;
    const account = await admin.query<{ id: string }>(
      `INSERT INTO provider_accounts (
         provider, external_account_id, account_name
       ) VALUES ('meta', $1, 'Duplicate seam')
       RETURNING id::text`,
      [PROVIDER_ACCOUNT_ID],
    );
    const providerAccountRefId = account.rows[0]!.id;
    await admin.query(
      `INSERT INTO business_provider_accounts (
         business_id, provider, provider_account_ref_id,
         provider_account_id, is_selected
       ) VALUES ($1, 'meta', $2::uuid, $3, TRUE)`,
      [businessId, providerAccountRefId, PROVIDER_ACCOUNT_ID],
    );

    // D072/AR-013: the shared write choke point now fails closed when the
    // business has no persisted automation control row. This seam tests the
    // duplicate write/reconciliation contract itself, so persist an explicit
    // open control state; the missing-row refusal has its own coverage.
    await admin.query(
      `INSERT INTO meta_automation_business_controls
         (business_id, kill_switch_engaged, auto_execution_enabled, readiness_tier)
       VALUES ($1::uuid, FALSE, FALSE, 'manual_review')
       ON CONFLICT (business_id) DO UPDATE SET kill_switch_engaged = FALSE`,
      [businessId],
    );

    // Write authority for this seam's in-process fake provider.
    //
    // readProviderWriteAuthority reads provider_connections +
    // integration_credentials + the SELECTED business_provider_accounts
    // binding. duplicateAd's contexts pass connectionGeneration "1:connected",
    // so the connection must actually be status 'connected' at generation 1.
    // The guard is exercised for real here; nothing is mocked or bypassed.
    const connectionRows = await admin.query(
      `INSERT INTO provider_connections (business_id, provider, status, connection_generation)
       VALUES ($1, 'meta', 'connected', 1)
       ON CONFLICT (business_id, provider)
       DO UPDATE SET status = 'connected', connection_generation = 1
       RETURNING id::text AS id`,
      [businessId],
    );
    await admin.query(
      `INSERT INTO integration_credentials (provider_connection_id, access_token)
       VALUES ($1::uuid, $2)
       ON CONFLICT (provider_connection_id)
       DO UPDATE SET access_token = EXCLUDED.access_token`,
      [connectionRows.rows[0]!.id, ACCESS_TOKEN],
    );

    await expectRejected(
      () =>
        admin.query(
          `INSERT INTO meta_ads_action_log (
             business_id, provider_account_id, ad_id, creative_id,
             action, source, payload_request, status, dry_run
           ) VALUES (
             $1::uuid, $2, $3, $4, 'duplicate', 'manual_operator_v1',
             '{"method":"POST","dry_run":false}'::jsonb,
             'pending', false
           )`,
          [businessId, PROVIDER_ACCOUNT_ID, SOURCE_AD_ID, SOURCE_CREATIVE_ID],
        ),
      "contractless rollback insert was not disabled",
      ["23514"],
    );
    await expectRejected(
      () =>
        admin.query(
          `INSERT INTO meta_ads_action_log (
             business_id, provider_account_ref_id, provider_account_id,
             ad_id, creative_id, action, source, payload_request,
             status, dry_run
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, 'duplicate',
             'manual_operator_v1',
             jsonb_build_object(
               'duplicate_attempt_contract_version',
                 'meta-manual-ad-duplicate-attempt.v1',
               'duplicate_attempt_required', true,
               'dry_run', false
             ),
             'pending', false
           )`,
          [
            businessId,
            providerAccountRefId,
            PROVIDER_ACCOUNT_ID,
            SOURCE_AD_ID,
            SOURCE_CREATIVE_ID,
          ],
        ),
      "flag-only forged contract insert was accepted",
      ["23514"],
    );
    const orphanMarker = markerFor(999);
    const orphanCanonicalName = buildMetaAdDuplicateCanonicalName(
      "Seam duplicate",
      orphanMarker,
    );
    await expectRejected(
      () =>
        admin.query(
          `INSERT INTO meta_ads_action_log (
             business_id, provider_account_ref_id, provider_account_id,
             ad_id, creative_id, action, source, requested_by,
             payload_request, status, dry_run
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, 'duplicate',
             'manual_operator_v1', $6::uuid,
             jsonb_build_object(
               'method', 'POST',
               'endpoint', $7::text,
               'dry_run', false,
               'body', jsonb_build_object(
                 'adset_id', $8::text,
                 'target_adset_id', $8::text,
                 'name', $9::text,
                 'status_option', 'PAUSED',
                 'dry_run', false
               ),
               'duplicate_attempt_contract_version',
                 'meta-manual-ad-duplicate-attempt.v1',
               'duplicate_attempt_required', true,
               'duplicate_marker', $10::text,
               'duplicate_canonical_name', $9::text,
               'duplicate_target', jsonb_build_object(
                 'businessId', $1::text,
                 'providerAccountRefId', $2::text,
                 'providerAccountId', $3::text,
                 'sourceAdId', $4::text,
                 'sourceCreativeId', $5::text,
                 'targetAdsetId', $8::text,
                 'marker', $10::text,
                 'canonicalAdName', $9::text,
                 'requestedStatus', 'PAUSED'
               )
             ),
             'pending', false
           )`,
          [
            businessId,
            providerAccountRefId,
            PROVIDER_ACCOUNT_ID,
            SOURCE_AD_ID,
            SOURCE_CREATIVE_ID,
            userId,
            `/${POST_PATH}`,
            "orphan_exact_target",
            orphanCanonicalName,
            orphanMarker,
          ],
        ),
      "exact live envelope committed without one preparation event",
      ["23514"],
    );
    await expectRejected(
      () =>
        admin.query(
          `INSERT INTO meta_ads_action_log (
             business_id, provider_account_id, ad_id, creative_id,
             action, source, payload_request, status, dry_run
           ) VALUES (
             $1::uuid, $2, $3, $4, 'duplicate', 'manual_operator_v1',
             jsonb_build_object(
               'method', 'POST',
               'endpoint', '/${POST_PATH}',
               'dry_run', false,
               'body', jsonb_build_object(
                 'adset_id', 'dry_target',
                 'target_adset_id', 'dry_target',
                 'status_option', 'PAUSED',
                 'dry_run', false
               )
             ),
             'pending', true
           )`,
          [businessId, PROVIDER_ACCOUNT_ID, SOURCE_AD_ID, SOURCE_CREATIVE_ID],
        ),
      "dry-run column alone bypassed the exact dry-run envelope",
      ["23514"],
    );
    await admin.query(
      `INSERT INTO meta_ads_action_log (
         business_id, provider_account_id, ad_id, creative_id,
         action, source, payload_request, status, dry_run
       ) VALUES (
         $1::uuid, $2, $3, $4, 'duplicate', 'manual_operator_v1',
         jsonb_build_object(
           'method', 'POST',
           'endpoint', '/${POST_PATH}',
           'dry_run', true,
           'body', jsonb_build_object(
             'adset_id', 'dry_target',
             'target_adset_id', 'dry_target',
             'status_option', 'PAUSED',
             'dry_run', true
           )
         ),
         'pending', true
       )`,
      [businessId, PROVIDER_ACCOUNT_ID, SOURCE_AD_ID, SOURCE_CREATIVE_ID],
    );
    const transitionSeed = await admin.query<{ id: string }>(
      `INSERT INTO meta_ads_action_log (
         business_id, provider_account_ref_id, provider_account_id,
         ad_id, creative_id, action, source, requested_by,
         payload_request, status, dry_run
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, 'pause', 'legacy_seed',
         $6::uuid, '{"method":"POST"}'::jsonb, 'pending', false
       )
       RETURNING id::text`,
      [
        businessId,
        providerAccountRefId,
        PROVIDER_ACCOUNT_ID,
        SOURCE_AD_ID,
        SOURCE_CREATIVE_ID,
        userId,
      ],
    );
    await expectRejected(
      () =>
        admin.query(
          `UPDATE meta_ads_action_log
           SET action = 'duplicate',
               source = 'manual_operator_v1',
               payload_request =
                 '{"method":"POST","dry_run":false}'::jsonb
           WHERE id = $1::uuid`,
          [transitionSeed.rows[0]!.id],
        ),
      "ordinary action was rewritten into a contractless live duplicate",
      ["55000"],
    );
    const legacyTargetAdsetId = "legacy_failure_target";
    let legacyFailureId = "";
    await admin.query(
      `ALTER TABLE meta_ads_action_log
       DISABLE TRIGGER trg_manual_meta_ads_duplicate_insert_contract`,
    );
    try {
      const legacyFailure = await admin.query<{ id: string }>(
        `INSERT INTO meta_ads_action_log (
           business_id, ad_id, creative_id, action, source, requested_by,
           payload_request, payload_response, status, error_code,
           error_message, resulting_ad_id, verification_payload, dry_run
         ) VALUES (
           $1::uuid, $2, $3, 'duplicate', 'manual_operator_v1', $4::uuid,
           jsonb_build_object(
             'method', 'POST',
             'dry_run', false,
             'body', jsonb_build_object(
               'adset_id', $5::text,
               'target_adset_id', $5::text,
               'dry_run', false
             )
           ),
           jsonb_build_object(
             'error', jsonb_build_object(
               'code', 3,
               'message', 'legacy unclassified provider failure',
               'is_transient', NULL
             )
           ),
           'failure', '3', 'legacy unclassified provider failure',
           NULL,
           '{"provider_verification":{"status":"unclassified"}}'::jsonb,
           false
         )
         RETURNING id::text`,
        [
          businessId,
          SOURCE_AD_ID,
          SOURCE_CREATIVE_ID,
          userId,
          legacyTargetAdsetId,
        ],
      );
      legacyFailureId = legacyFailure.rows[0]!.id;
    } finally {
      await admin.query(
        `ALTER TABLE meta_ads_action_log
         ENABLE TRIGGER trg_manual_meta_ads_duplicate_insert_contract`,
      );
    }
    const legacyFailureRequest = claimInput({
      businessId,
      userId,
      marker: markerFor(998),
      targetAdsetId: legacyTargetAdsetId,
    });
    const legacyFailureClaim = await claimMetaAdDuplicateAction(
      legacyFailureRequest,
    );
    assert(
      !legacyFailureClaim.claimed &&
        legacyFailureClaim.existing.id === legacyFailureId &&
        legacyFailureClaim.existing.status === "failure" &&
        legacyFailureClaim.existing.resultingAdId === null,
      "pre-contract legacy failure did not remain retry-blocking",
    );
    const legacyPrepared = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM meta_ads_duplicate_action_attempt_events
       WHERE source_action_log_id = $1::uuid`,
      [legacyFailureId],
    );
    assert(
      legacyPrepared.rows[0]?.count === "0",
      "legacy failure blocker fabricated current-contract journal authority",
    );

    const concurrentInput = {
      businessId,
      userId,
      targetAdsetId: "concurrent_target",
    };
    const concurrent = await Promise.all([
      claimMetaAdDuplicateAction(
        claimInput({ ...concurrentInput, marker: markerFor(1) }),
      ),
      claimMetaAdDuplicateAction(
        claimInput({ ...concurrentInput, marker: markerFor(2) }),
      ),
    ]);
    const winners = concurrent.filter((result) => result.claimed);
    assert(winners.length === 1, "concurrent tuple had multiple winners");
    const winner = winners[0]!;
    assert(winner.claimed, "concurrent winner is missing");
    const winnerIndex = concurrent.findIndex((result) => result.claimed);
    const winningRequest = claimInput({
      ...concurrentInput,
      marker: markerFor(winnerIndex === 0 ? 1 : 2),
    });

    await expectRejected(
      () =>
        admin.query(
          `INSERT INTO meta_ads_action_log (
             business_id, provider_account_ref_id, provider_account_id,
             ad_id, creative_id, action, source, requested_by,
             payload_request, status, dry_run
           )
           SELECT business_id, provider_account_ref_id, provider_account_id,
                  ad_id, creative_id, action, source, requested_by,
                  payload_request, status, dry_run
           FROM meta_ads_action_log
           WHERE id = $1::uuid`,
          [winner.log.id],
        ),
      "direct duplicate open-claim insert bypassed unique index",
      ["23505"],
    );

    let providerPostCount = 0;
    globalThis.fetch = (async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(request);
      if (init?.method === "POST") {
        const started = await admin.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM meta_ads_duplicate_action_attempt_events
           WHERE source_action_log_id = $1::uuid
             AND event_kind = 'attempt_started'`,
          [winner.log.id],
        );
        assert(
          started.rows[0]?.count === "1",
          "provider POST ran before the durable start",
        );
        providerPostCount += 1;
        return new Response(JSON.stringify({ id: "duplicate_result_ad" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const isResult = url.includes("/duplicate_result_ad?");
      return new Response(
        JSON.stringify(
          isResult
            ? {
                id: "duplicate_result_ad",
                name: winningRequest.canonicalAdName,
                account_id: "duplicate_seam",
                status: "PAUSED",
                effective_status: "PAUSED",
                adset_id: "concurrent_target",
                creative: { id: SOURCE_CREATIVE_ID },
              }
            : {
                id: SOURCE_AD_ID,
                name: "Source",
                account_id: "duplicate_seam",
                status: "ACTIVE",
                effective_status: "ACTIVE",
                adset_id: "source_adset",
                creative: { id: SOURCE_CREATIVE_ID },
              },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const providerResult = await duplicateAd(
      {
        businessId,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        accessToken: ACCESS_TOKEN,
        connectionGeneration: "1:connected",
      },
      {
        adId: SOURCE_AD_ID,
        targetAdsetId: "concurrent_target",
        expectedSourceCreativeId: SOURCE_CREATIVE_ID,
        name: winningRequest.canonicalAdName,
        beforeMutationAttempt: () =>
          appendMetaAdDuplicateAttemptStarted(winner.log.id).then(
            () => undefined,
          ),
      },
    );
    assert(providerResult.ok, "fake provider duplicate did not verify");
    const secondProviderResult = await duplicateAd(
      {
        businessId,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        accessToken: ACCESS_TOKEN,
        connectionGeneration: "1:connected",
      },
      {
        adId: SOURCE_AD_ID,
        targetAdsetId: "concurrent_target",
        expectedSourceCreativeId: SOURCE_CREATIVE_ID,
        name: winningRequest.canonicalAdName,
        beforeMutationAttempt: () =>
          appendMetaAdDuplicateAttemptStarted(winner.log.id).then(
            () => undefined,
          ),
      },
    );
    assert(!secondProviderResult.ok, "second durable start was accepted");
    assert(providerPostCount === 1, "duplicate flow issued a second POST");

    const completedAtMs = Date.parse(
      providerResult.mutationAttempt.completedAt,
    );
    const verificationObservedAt = new Date(
      Math.max(
        completedAtMs + 1,
        Date.parse(providerResult.verificationObservedAt),
      ),
    ).toISOString();
    const verification = {
      ...(providerResult.verificationPayload ?? {}),
      observedAt: verificationObservedAt,
    };
    const completion = {
      sourceActionLogId: winner.log.id,
      successful: true,
      mutationReceipt: {
        ...providerResult.mutationAttempt,
        transportError: null,
      },
      providerResponse: providerResult.responsePayload ?? null,
      verification,
      verificationObservedAt,
      resultingAdId: providerResult.newAdId,
      errorCode: null,
      errorMessage: null,
      durationMs: 1,
    };
    await expectRejected(
      () =>
        runDbTransaction(async () => {
          await finalizeMetaAdDuplicateAttempt(completion);
          throw new Error("intentional completion rollback");
        }),
      "completion rollback did not roll back",
    );
    await finalizeMetaAdDuplicateAttempt(completion);
    await finalizeMetaAdDuplicateAttempt(completion);
    await expectRejected(
      () =>
        finalizeMetaAdDuplicateAttempt({
          ...completion,
          verificationObservedAt: new Date(
            Date.parse(verificationObservedAt) + 1,
          ).toISOString(),
        }),
      "conflicting completion replay was accepted",
    );
    const terminal = await admin.query<{
      status: string;
      resulting_ad_id: string;
      event_count: string;
      verified_matches: boolean;
    }>(
      `SELECT
         action.status,
         action.resulting_ad_id,
         count(event.id)::text AS event_count,
         bool_and(
           event.event_kind <> 'attempt_completed' OR
           action.verified_at = event.verification_observed_at
         ) AS verified_matches
       FROM meta_ads_action_log action
       JOIN meta_ads_duplicate_action_attempt_events event
         ON event.source_action_log_id = action.id
       WHERE action.id = $1::uuid
       GROUP BY action.status, action.resulting_ad_id`,
      [winner.log.id],
    );
    assert(
      terminal.rows[0]?.status === "success" &&
        terminal.rows[0]?.resulting_ad_id === "duplicate_result_ad" &&
        terminal.rows[0]?.event_count === "3" &&
        terminal.rows[0]?.verified_matches,
      "success terminal did not bind the exact verification observation",
    );
    await expectRejected(
      () =>
        admin.query(
          `UPDATE meta_ads_action_log
           SET resulting_ad_id = 'mutated'
           WHERE id = $1::uuid`,
          [winner.log.id],
        ),
      "terminal action mutation was accepted",
      ["55000"],
    );
    await expectRejected(
      () =>
        admin.query(
          `UPDATE meta_ads_duplicate_action_attempt_events
           SET canonical_ad_name = canonical_ad_name || ' drift'
           WHERE source_action_log_id = $1::uuid`,
          [winner.log.id],
        ),
      "attempt journal update was accepted",
      ["55000"],
    );

    for (const [index, httpStatus] of [500, 429].entries()) {
      const unresolved = await acquireClaim({
        businessId,
        userId,
        index: 10 + index,
      });
      const started = await appendMetaAdDuplicateAttemptStarted(
        unresolved.claim.log.id,
      );
      const attemptedAt = new Date(
        Math.max(Date.now(), Date.parse(started.startedAt)),
      ).toISOString();
      const completedAt = new Date(
        Date.parse(attemptedAt) + 1,
      ).toISOString();
      await finalizeMetaAdDuplicateAttempt({
        sourceActionLogId: unresolved.claim.log.id,
        successful: false,
        mutationReceipt: {
          attemptCount: 1,
          method: "POST",
          path: POST_PATH,
          attemptedAt,
          completedAt,
          providerResponseReceived: true,
          providerResponseSuccessful: false,
          httpStatus,
          outcome: "outcome_ambiguous",
          automaticRetryAttempted: false,
          transportError: null,
        },
        providerResponse: {
          error: { code: httpStatus === 429 ? 17 : 2, message: "transient" },
        },
        verification: null,
        verificationObservedAt: null,
        resultingAdId: null,
        errorCode: "provider_outcome_ambiguous",
        errorMessage: "ambiguous provider response",
        durationMs: 1,
      });
      const blocked = await claimMetaAdDuplicateAction(unresolved.request);
      assert(
        !blocked.claimed && !blocked.existing.resultingAdId,
        `${httpStatus} ambiguity did not keep the claim retry-blocking`,
      );
    }

    const transport = await acquireClaim({
      businessId,
      userId,
      index: 20,
    });
    const transportStarted = await appendMetaAdDuplicateAttemptStarted(
      transport.claim.log.id,
    );
    const transportAttemptedAt = new Date(
      Math.max(Date.now(), Date.parse(transportStarted.startedAt)),
    ).toISOString();
    await finalizeMetaAdDuplicateAttempt({
      sourceActionLogId: transport.claim.log.id,
      successful: false,
      mutationReceipt: {
        attemptCount: 1,
        method: "POST",
        path: POST_PATH,
        attemptedAt: transportAttemptedAt,
        completedAt: new Date(
          Date.parse(transportAttemptedAt) + 1,
        ).toISOString(),
        providerResponseReceived: false,
        providerResponseSuccessful: false,
        httpStatus: null,
        outcome: "outcome_ambiguous",
        automaticRetryAttempted: false,
        transportError: { code: "network_error", message: "closed" },
      },
      providerResponse: null,
      verification: null,
      verificationObservedAt: null,
      resultingAdId: null,
      errorCode: "provider_outcome_ambiguous",
      errorMessage: "ambiguous transport",
      durationMs: 1,
    });

    const definite = await acquireClaim({
      businessId,
      userId,
      index: 21,
    });
    const definiteStarted = await appendMetaAdDuplicateAttemptStarted(
      definite.claim.log.id,
    );
    const definiteAttemptedAt = new Date(
      Math.max(Date.now(), Date.parse(definiteStarted.startedAt)),
    ).toISOString();
    await finalizeMetaAdDuplicateAttempt({
      sourceActionLogId: definite.claim.log.id,
      successful: false,
      mutationReceipt: {
        attemptCount: 1,
        method: "POST",
        path: POST_PATH,
        attemptedAt: definiteAttemptedAt,
        completedAt: new Date(
          Date.parse(definiteAttemptedAt) + 1,
        ).toISOString(),
        providerResponseReceived: true,
        providerResponseSuccessful: false,
        httpStatus: 400,
        outcome: "provider_response_received",
        automaticRetryAttempted: false,
        transportError: null,
      },
      providerResponse: {
        error: {
          code: 100,
          message: "Invalid parameter",
          is_transient: false,
        },
      },
      verification: null,
      verificationObservedAt: null,
      resultingAdId: null,
      errorCode: "100",
      errorMessage: "Invalid parameter",
      durationMs: 1,
    });
    const released = await claimMetaAdDuplicateAction(definite.request);
    assert(released.claimed, "exact non-transient 400 did not release claim");

    const nonExplicitTransientCases: Array<{
      label: string;
      providerResponse: Record<string, unknown>;
    }> = [
      {
        label: "missing",
        providerResponse: {
          error: { code: 100, message: "flag missing" },
        },
      },
      {
        label: "null",
        providerResponse: {
          error: {
            code: 100,
            message: "flag null",
            is_transient: null,
          },
        },
      },
      {
        label: "string",
        providerResponse: {
          error: {
            code: 100,
            message: "flag string",
            is_transient: "false",
          },
        },
      },
    ];
    for (const [offset, transientCase] of nonExplicitTransientCases.entries()) {
      const unresolved = await acquireClaim({
        businessId,
        userId,
        index: 23 + offset,
      });
      const started = await appendMetaAdDuplicateAttemptStarted(
        unresolved.claim.log.id,
      );
      const attemptedAt = new Date(
        Math.max(Date.now(), Date.parse(started.startedAt)),
      ).toISOString();
      const commonCompletion = {
        sourceActionLogId: unresolved.claim.log.id,
        successful: false,
        providerResponse: transientCase.providerResponse,
        verification: null,
        verificationObservedAt: null,
        resultingAdId: null,
        errorCode: "100",
        errorMessage: `${transientCase.label} transient flag`,
        durationMs: 1,
      };
      const receipt = {
        attemptCount: 1 as const,
        method: "POST" as const,
        path: POST_PATH,
        attemptedAt,
        completedAt: new Date(Date.parse(attemptedAt) + 1).toISOString(),
        providerResponseReceived: true,
        providerResponseSuccessful: false,
        httpStatus: 400,
        automaticRetryAttempted: false as const,
        transportError: null,
      };
      await expectRejected(
        () =>
          finalizeMetaAdDuplicateAttempt({
            ...commonCompletion,
            mutationReceipt: {
              ...receipt,
              outcome: "provider_response_received",
            },
          }),
        `${transientCase.label} is_transient forged a definite failure`,
        ["23514"],
      );
      await finalizeMetaAdDuplicateAttempt({
        ...commonCompletion,
        mutationReceipt: {
          ...receipt,
          outcome: "outcome_ambiguous",
        },
      });
      const blocked = await claimMetaAdDuplicateAction(unresolved.request);
      assert(
        !blocked.claimed,
        `${transientCase.label} is_transient released an ambiguous claim`,
      );
    }

    const mismatchedResponseId = await acquireClaim({
      businessId,
      userId,
      index: 26,
    });
    const mismatchedResponseIdStart =
      await appendMetaAdDuplicateAttemptStarted(
        mismatchedResponseId.claim.log.id,
      );
    await expectRejected(
      () =>
        finalizeMetaAdDuplicateAttempt(
          unverifiedProviderSuccessCompletion({
            sourceActionLogId: mismatchedResponseId.claim.log.id,
            startedAt: mismatchedResponseIdStart.startedAt,
            providerResponse: { id: "provider_response_ad" },
            resultingAdId: "unrelated_resulting_ad",
          }),
        ),
      "store accepted a provider response id/resulting id mismatch",
    );
    let mismatchIdReadCount = 0;
    const changingResponseId: Record<string, unknown> = {};
    Object.defineProperty(changingResponseId, "id", {
      enumerable: true,
      get: () =>
        mismatchIdReadCount++ === 0
          ? "unrelated_resulting_ad"
          : "provider_response_ad",
    });
    await expectRejected(
      () =>
        finalizeMetaAdDuplicateAttempt(
          unverifiedProviderSuccessCompletion({
            sourceActionLogId: mismatchedResponseId.claim.log.id,
            startedAt: mismatchedResponseIdStart.startedAt,
            providerResponse: changingResponseId,
            resultingAdId: "unrelated_resulting_ad",
          }),
        ),
      "database accepted a provider response id/resulting id mismatch",
      ["23514"],
    );
    await finalizeMetaAdDuplicateAttempt(
      unverifiedProviderSuccessCompletion({
        sourceActionLogId: mismatchedResponseId.claim.log.id,
        startedAt: mismatchedResponseIdStart.startedAt,
        providerResponse: { id: "provider_response_ad" },
        resultingAdId: "provider_response_ad",
      }),
    );

    const missingResponseId = await acquireClaim({
      businessId,
      userId,
      index: 27,
    });
    const missingResponseIdStart = await appendMetaAdDuplicateAttemptStarted(
      missingResponseId.claim.log.id,
    );
    await expectRejected(
      () =>
        finalizeMetaAdDuplicateAttempt(
          unverifiedProviderSuccessCompletion({
            sourceActionLogId: missingResponseId.claim.log.id,
            startedAt: missingResponseIdStart.startedAt,
            providerResponse: { success: true },
            resultingAdId: "unbound_resulting_ad",
          }),
        ),
      "store accepted a resulting id without a provider response id",
    );
    let missingIdReadCount = 0;
    const disappearingResponseId: Record<string, unknown> = {
      success: true,
    };
    Object.defineProperty(disappearingResponseId, "id", {
      enumerable: true,
      get: () =>
        missingIdReadCount++ === 0 ? "unbound_resulting_ad" : undefined,
    });
    await expectRejected(
      () =>
        finalizeMetaAdDuplicateAttempt(
          unverifiedProviderSuccessCompletion({
            sourceActionLogId: missingResponseId.claim.log.id,
            startedAt: missingResponseIdStart.startedAt,
            providerResponse: disappearingResponseId,
            resultingAdId: "unbound_resulting_ad",
          }),
        ),
      "database accepted a resulting id without a provider response id",
      ["23514"],
    );
    await finalizeMetaAdDuplicateAttempt(
      unverifiedProviderSuccessCompletion({
        sourceActionLogId: missingResponseId.claim.log.id,
        startedAt: missingResponseIdStart.startedAt,
        providerResponse: { success: true },
        resultingAdId: null,
      }),
    );

    const forged = await acquireClaim({
      businessId,
      userId,
      index: 22,
    });
    const forgedStarted = await appendMetaAdDuplicateAttemptStarted(
      forged.claim.log.id,
    );
    const forgedAttemptedAt = new Date(
      Math.max(Date.now(), Date.parse(forgedStarted.startedAt)),
    ).toISOString();
    await expectRejected(
      () =>
        finalizeMetaAdDuplicateAttempt({
          sourceActionLogId: forged.claim.log.id,
          successful: false,
          mutationReceipt: {
            attemptCount: 1,
            method: "POST",
            path: POST_PATH,
            attemptedAt: forgedAttemptedAt,
            completedAt: new Date(
              Date.parse(forgedAttemptedAt) + 1,
            ).toISOString(),
            providerResponseReceived: true,
            providerResponseSuccessful: false,
            httpStatus: 500,
            outcome: "provider_response_received",
            automaticRetryAttempted: false,
            transportError: null,
          },
          providerResponse: {
            error: { code: 2, message: "transient" },
          },
          verification: null,
          verificationObservedAt: null,
          resultingAdId: null,
          errorCode: "2",
          errorMessage: "forged definite failure",
          durationMs: 1,
        }),
      "forged 5xx definite failure was accepted",
      ["23514"],
    );
    await expectRejected(
      () =>
        admin.query(
          `UPDATE meta_ads_action_log
           SET status = 'failure',
               payload_response = NULL,
               error_code = NULL,
               error_message = NULL,
               terminal_finalized_at = clock_timestamp()
           WHERE id = $1::uuid`,
          [forged.claim.log.id],
        ),
      "NULL terminal payload bypassed journal authority",
      ["23514"],
    );

    const expired = await acquireClaim({
      businessId,
      userId,
      index: 30,
    });
    await ageAttempt(expired.claim.log.id);
    const expiredCandidate = await candidateFor(expired.claim.log.id);
    assert(
      expiredCandidate.authorityKind === "expired_prepared",
      "expired preparation did not produce no-POST authority",
    );
    await expectRejected(
      () =>
        reconcileMetaAdDuplicateAttempt({
          candidate: expiredCandidate,
          resolution: "exact_provider_match",
          resultingAdId: "forged_ad",
          scanComplete: true,
          scannedPageCount: 0,
          observationCount: 1,
          exactMatchCount: 1,
          observedAt: new Date().toISOString(),
          providerAd: {},
          scanEvidence: {},
        }),
      "expired preparation was allowed to reconcile provider success",
      ["23514"],
    );
    await finalizeMetaAdDuplicatePreProviderFailure({
      sourceActionLogId: expired.claim.log.id,
      errorCode: "duplicate_prepared_lease_expired_without_start",
      errorMessage: "lease expired with no durable provider start",
      durationMs: 0,
    });

    const segmented = await acquireClaim({
      businessId,
      userId,
      index: 31,
    });
    await appendMetaAdDuplicateAttemptStarted(segmented.claim.log.id);
    await ageAttempt(segmented.claim.log.id);
    let segmentedCandidate = await candidateFor(segmented.claim.log.id);
    const cycleId = markerFor(900);
    const exactAdId = "segmented_exact_ad";
    const first = checkpoint({
      cycleId,
      segmentIndex: 0,
      start: null,
      end: "cursor_1",
      visitedCursorHashes: [cursorHash(null)],
      pageCount: 1,
      observationCount: 10,
      exactMatchIds: [exactAdId],
      complete: false,
    });
    const firstObservation = await recordScan({
      candidate: segmentedCandidate,
      checkpoint: first,
      disposition: "scan_segment_progress",
      blocker: "pagination_segment_limit",
      segmentPageCount: 1,
      segmentObservationCount: 10,
    });
    await expectRejected(
      () =>
        admin.query(
          `UPDATE meta_ads_duplicate_reconciliation_observations
           SET evidence_json = jsonb_set(
             evidence_json,
             '{observationEvidence,visitedCursorHashes}',
             '[]'::jsonb
           )
           WHERE id = $1::uuid`,
          [firstObservation.id],
        ),
      "observation append-only trigger was bypassed",
      ["55000"],
    );
    const backedOff =
      await listMetaAdDuplicateReconciliationCandidates(10);
    assert(
      backedOff.every(
        (row) => row.sourceActionLogId !== segmented.claim.log.id,
      ),
      "scan progress did not apply durable backoff",
    );
    await ageLatestObservation(segmented.claim.log.id);
    segmentedCandidate = await candidateFor(segmented.claim.log.id);
    assert(
      segmentedCandidate.scanContinuation?.afterCursor === "cursor_1" &&
        segmentedCandidate.scanContinuation.segmentIndex === 1,
      "segment continuation was not reconstructed exactly",
    );
    const second = checkpoint({
      cycleId,
      segmentIndex: 1,
      start: "cursor_1",
      end: "cursor_2",
      visitedCursorHashes: [cursorHash(null), cursorHash("cursor_1")],
      pageCount: 2,
      observationCount: 20,
      exactMatchIds: [exactAdId],
      complete: false,
    });
    await recordScan({
      candidate: segmentedCandidate,
      checkpoint: second,
      disposition: "scan_segment_progress",
      blocker: "pagination_segment_limit",
      segmentPageCount: 1,
      segmentObservationCount: 10,
    });
    await ageLatestObservation(segmented.claim.log.id);
    segmentedCandidate = await candidateFor(segmented.claim.log.id);
    const finalCheckpoint = checkpoint({
      cycleId,
      segmentIndex: 2,
      start: "cursor_2",
      end: null,
      visitedCursorHashes: [
        cursorHash(null),
        cursorHash("cursor_1"),
        cursorHash("cursor_2"),
      ],
      pageCount: 3,
      observationCount: 30,
      exactMatchIds: [exactAdId],
      complete: true,
    });
    const pendingObservedAt = new Date().toISOString();
    await recordMetaAdDuplicateReconciliationObservation({
      candidate: segmentedCandidate,
      observationMethod: "account_ads_scan",
      disposition: "point_verification_pending",
      resultingAdId: exactAdId,
      scanComplete: true,
      scannedPageCount: 3,
      observationCount: 30,
      exactMatchCount: 1,
      observedAt: pendingObservedAt,
      observationEvidence: scanEvidence({
        candidate: segmentedCandidate,
        checkpoint: finalCheckpoint,
        complete: true,
        blocker: null,
        segmentPageCount: 1,
        segmentObservationCount: 10,
        observedAt: pendingObservedAt,
        pointVerificationBlocker: "provider_deadline_exhausted",
      }),
      scanCheckpoint: finalCheckpoint,
    });
    await ageLatestObservation(segmented.claim.log.id);
    segmentedCandidate = await candidateFor(segmented.claim.log.id);
    assert(
      segmentedCandidate.resultingAdId === exactAdId &&
        segmentedCandidate.scanContinuation === null,
      "pending point proof did not move the next wave to direct point GET",
    );
    const finalObservedAt = new Date().toISOString();
    const providerAd = {
      id: exactAdId,
      name: segmentedCandidate.canonicalAdName,
      account_id: "duplicate_seam",
      status: "PAUSED",
      effective_status: "PAUSED",
      adset_id: segmentedCandidate.targetAdsetId,
      creative: { id: SOURCE_CREATIVE_ID },
    };
    const pointEvidence = {
      contractVersion: "meta-ad-duplicate-known-result-point-get.v1",
      providerAccountId: segmentedCandidate.providerAccountId,
      marker: segmentedCandidate.marker,
      canonicalAdName: segmentedCandidate.canonicalAdName,
      targetAdsetId: segmentedCandidate.targetAdsetId,
      creativeId: segmentedCandidate.sourceCreativeId,
      requestedStatus: "PAUSED",
      complete: true,
      adId: exactAdId,
      observedAt: finalObservedAt,
    };
    const reconciliation = {
      candidate: segmentedCandidate,
      resolution: "exact_provider_match" as const,
      resultingAdId: exactAdId,
      scanComplete: true,
      scannedPageCount: 0,
      observationCount: 1,
      exactMatchCount: 1,
      observedAt: finalObservedAt,
      providerAd,
      scanEvidence: pointEvidence,
    };
    await reconcileMetaAdDuplicateAttempt(reconciliation);
    await reconcileMetaAdDuplicateAttempt(reconciliation);
    await expectRejected(
      () =>
        reconcileMetaAdDuplicateAttempt({
          ...reconciliation,
          resultingAdId: "conflicting_ad",
        }),
      "conflicting reconciliation replay was accepted",
    );

    const absence = await acquireClaim({
      businessId,
      userId,
      index: 32,
    });
    await appendMetaAdDuplicateAttemptStarted(absence.claim.log.id);
    await ageAttempt(absence.claim.log.id);
    const absenceCandidate = await candidateFor(absence.claim.log.id);
    const absenceCheckpoint = checkpoint({
      cycleId: markerFor(901),
      segmentIndex: 0,
      start: null,
      end: null,
      visitedCursorHashes: [cursorHash(null)],
      pageCount: 1,
      observationCount: 100,
      exactMatchIds: [],
      complete: true,
    });
    await recordScan({
      candidate: absenceCandidate,
      checkpoint: absenceCheckpoint,
      disposition: "complete_scan_absence",
      blocker: null,
      segmentPageCount: 1,
      segmentObservationCount: 100,
    });
    const absenceState = await admin.query<{
      status: string;
      reconciliation_count: string;
    }>(
      `SELECT action.status,
              count(reconciliation.id)::text AS reconciliation_count
       FROM meta_ads_action_log action
       LEFT JOIN meta_ads_duplicate_action_reconciliation_events reconciliation
         ON reconciliation.source_action_log_id = action.id
       WHERE action.id = $1::uuid
       GROUP BY action.status`,
      [absence.claim.log.id],
    );
    assert(
      absenceState.rows[0]?.status === "pending" &&
        absenceState.rows[0]?.reconciliation_count === "0",
      "complete zero-match scan incorrectly released the claim",
    );

    const fairnessClaims = [];
    for (let index = 40; index < 44; index += 1) {
      const item = await acquireClaim({ businessId, userId, index });
      await appendMetaAdDuplicateAttemptStarted(item.claim.log.id);
      await ageAttempt(item.claim.log.id);
      fairnessClaims.push(item);
    }
    for (const item of fairnessClaims.slice(0, 3)) {
      const candidate = await candidateFor(item.claim.log.id);
      const observedAt = new Date().toISOString();
      await recordMetaAdDuplicateReconciliationObservation({
        candidate,
        observationMethod: "internal",
        disposition: "provider_deadline_exhausted",
        resultingAdId: null,
        scanComplete: false,
        scannedPageCount: 0,
        observationCount: 0,
        exactMatchCount: 0,
        observedAt,
        observationEvidence: {
          contractVersion:
            "meta-ad-duplicate-provider-deadline-observation.v1",
          blocker: "provider_deadline_exhausted",
          observedAt,
        },
      });
    }
    const fairNext = await listMetaAdDuplicateReconciliationCandidates(1);
    assert(
      fairNext[0]?.sourceActionLogId === fairnessClaims[3]!.claim.log.id,
      "durable deadline backoff starved the later candidate",
    );

    await expectRejected(
      () =>
        admin.query(
          `DELETE FROM meta_ads_action_log WHERE id = $1::uuid`,
          [winner.log.id],
        ),
      "journal source FK allowed action deletion",
      ["23503"],
    );
    const secretRows = await admin.query<{ secret_count: string }>(
      `SELECT (
         SELECT count(*) FROM meta_ads_duplicate_action_attempt_events
         WHERE evidence_json::text LIKE '%' || $1 || '%'
            OR COALESCE(provider_response_json::text, '') LIKE
              '%' || $1 || '%'
            OR COALESCE(verification_json::text, '') LIKE
              '%' || $1 || '%'
       ) + (
         SELECT count(*) FROM meta_ads_duplicate_reconciliation_observations
         WHERE evidence_json::text LIKE '%' || $1 || '%'
       ) + (
         SELECT count(*)
         FROM meta_ads_duplicate_action_reconciliation_events
         WHERE evidence_json::text LIKE '%' || $1 || '%'
       ) AS secret_count`,
      [ACCESS_TOKEN],
    );
    assert(
      secretRows.rows[0]?.secret_count === "0",
      "provider credential leaked into duplicate journals",
    );

    console.log(
      "[duplicate-ad-reconciliation-seam] PASS: exact rollback guard, deferred preparation, atomic singleton claim, durable before-POST start, one POST, exact replay/conflict, HTTP/transport ambiguity, definite 4xx release, expired-prepared no-POST authority, multi-wave checkpoint continuation, pending-point liveness, zero-match quarantine, append-only/FK/terminal guards, fairness backoff, and credential redaction.",
    );
  } finally {
    await admin.end();
    resetDbClientCache();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
