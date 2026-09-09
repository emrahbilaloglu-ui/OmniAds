// @vitest-environment node
/**
 * THE >60-Ad ACCEPTANCE SEAM, through the REAL path, against real PostgreSQL.
 *
 * WHAT WAS BROKEN. `readMetaDecisionsWorkspaceReadModel` attaches the full
 * exact-Ad identity universe onto the read model as a NON-ENUMERABLE,
 * symbol-keyed property (`Symbol.for("adsecute.meta.decisions.canonical-ad-
 * universe")`, attached by `attachCanonicalAdUniverse` in
 * `lib/meta/decisions-workspace-read-model.ts`). `structuredClone` copies
 * neither symbol keys nor non-enumerable ones, and
 * `applyMetaExecutionGovernanceToReadModel` clones the model between the reader
 * and the presentation. So `readCanonicalAdUniverseIds` in
 * `lib/meta/decisions-os-presentation.ts` read `null` on every request and fell
 * back to the ids the 60-row cap had SERVED. Every exact decision the cap
 * omitted was then indistinguishable from an ACTIVE Ad no producer had decided,
 * and was counted into `os.ads.pendingInventoryCount` plus the
 * `active_ad_inventory_pending_native_decision` limitation sentence: on an
 * account serving 60 of 80, twenty real verdicts reported to the operator as
 * "no exact Ad-grain decision yet". `carryCanonicalAdUniverse` is the fix.
 *
 * WHY THE EXISTING COVERAGE CANNOT CATCH IT.
 * `lib/meta/decisions-canonical-ad-universe.test.ts` FABRICATES the universe
 * with its own `Object.defineProperty` onto a hand-built object, and
 * `app/api/meta/decisions-workspace/route.test.ts` mocks
 * `@/lib/meta/decisions-workspace-read-model` wholesale. Neither ever reaches
 * the line that ATTACHES the universe, so neither can observe it being dropped.
 * And the defect needs MORE THAN 60 identity-eligible exact-Ad candidates to
 * appear at all (`META_DECISIONS_AD_CANDIDATE_LIMIT` is 60 in
 * `lib/meta/decisions-workspace-contract.ts`), which is why nothing
 * fixture-shaped caught it.
 *
 * WHAT IS REAL HERE. Everything from the attachment point onwards, driven
 * through the EXPORTED `GET` of `app/api/meta/decisions-workspace/route.ts`:
 * request auth (`requireBusinessAccess` -> `getSessionFromRequest` -> the
 * seeded `sessions`/`memberships` rows), the posture read, the native
 * generation validator and its identity-manifest recomputation, the read-model
 * builder that attaches the universe, `applyMetaExecutionGovernanceToReadModel`
 * with its `structuredClone`, and `buildMetaOsDecisionsPresentation`. The
 * account-pulse and lane-classify upstreams run IN-PROCESS against the same
 * ephemeral database (`META_DECISIONS_UPSTREAM_TRANSPORT=in_process`, a shipped
 * transport option) and `fetch` is stubbed to throw, so no network call exists.
 *
 * WHAT IS MOCKED, in full. ONLY the external current-provider-inventory
 * boundary — `resolveMetaCredentials` and `fetchMetaActiveAdConfigsReceipt`
 * from `@/lib/api/meta` — because the 80 ACTIVE rows the pending-inventory
 * census is measured against come from a live Meta Graph call this repository
 * must not make. Those two are the module's only members the served chain
 * reaches: `lane-classify` imports `resolveMetaCredentials` and nothing else
 * from it, and `account-pulse` imports nothing from it at all. The boundary is
 * an INPUT to the read model and sits entirely before it; no step of the
 * attach -> clone -> present chain is stubbed, replaced or spied. The same
 * boundary, and only it, is what
 * `app/api/meta/decisions-workspace/route.lattice-cta.db.test.tsx` mocks.
 *
 * WHY REAL POSTGRES. The universe is built from the rows the native generation
 * validator ADMITS, not from a list the test hands in: the serving read
 * recomputes `hashAdDecisionIdentityManifest` over the generation's sorted ad
 * ids and requires exact equality with the job run's hydration receipt, and the
 * candidate set is then filtered by `identityResolution.adActionEligible`,
 * which is derived from the ad/creative identity columns. A template-SQL mock
 * answers all of that with whatever the test author typed, and the count that
 * decides this defect — 80 admitted against a 60-row cap — is exactly the
 * number such a mock would be fabricating.
 *
 * Runs only inside an ephemeral-database seam (`ADSECUTE_EPHEMERAL_DB_SEAM=1`),
 * because outside one `DATABASE_URL` in this repository points at PRODUCTION.
 * Under a plain `npx vitest run` the default include still COLLECTS this file
 * and `describe.skipIf(!SEAM)` reports every case as skipped, which reads
 * green — so the file is registered as a stage of
 * `scripts/ephemeral-postgres-migrations-check.ts`, whose `runChildVitest`
 * fails the gate on a skipped or short run. Adding or removing a case here
 * means updating the expected passing count in that registration.
 */
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { NATIVE_AD_CALIBRATION_CONTRACT_VERSION } from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV } from "@/lib/creative-decision-engine/campaign-context/source";
import { META_DECISIONS_AD_CANDIDATE_LIMIT } from "@/lib/meta/decisions-workspace-contract";

/*
  PRE-DEPLOY AUDIT — the production-tunnel refusal every seeding DB test in this
  repository carries. This file SEEDS users, businesses, memberships and
  sessions. This machine's `.env.local` reaches PRODUCTION over an SSH tunnel on
  127.0.0.1:15432. It THROWS rather than skipping: a seam that was asked to run
  and silently did nothing is how a "green" run hides a misconfiguration.
*/
if (
  process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1" &&
  process.env.DATABASE_URL?.includes("15432")
) {
  throw new Error(
    "Sixty-ad acceptance seam refused: DATABASE_URL points at the production tunnel",
  );
}

const SEAM =
  process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1" &&
  Boolean(process.env.DATABASE_URL) &&
  !process.env.DATABASE_URL?.includes("15432");

// Run the account-pulse and lane-classify upstreams IN-PROCESS (a shipped
// transport option) so the real sibling route functions execute against the
// ephemeral database — no HTTP hop exists, and the global-fetch stub can prove
// zero network calls of any kind.
process.env.META_DECISIONS_UPSTREAM_TRANSPORT = "in_process";

const metaApiMock = vi.hoisted(() => ({
  resolveMetaCredentials: vi.fn(),
  fetchMetaActiveAdConfigsReceipt: vi.fn(),
}));
vi.mock("@/lib/api/meta", () => ({
  resolveMetaCredentials: metaApiMock.resolveMetaCredentials,
  fetchMetaActiveAdConfigsReceipt: metaApiMock.fetchMetaActiveAdConfigsReceipt,
}));

const networkSpy = vi.fn((...args: unknown[]) => {
  throw new Error(
    `network access is forbidden in the sixty-ad acceptance seam: ${String(args[0]).slice(0, 200)}`,
  );
});

/** Ids chosen not to collide with any other stage of the seam gate. */
const OWNER_EMAIL = "sixty-ad-acceptance@example.invalid";
const BUSINESS_ID = "6a0d1c8e-5b41-4f7a-9d2c-8e1f0a3b7c60";
const ACCOUNT_ID = "act_sixty_ad_acceptance_6001";
/**
 * The shipped native epoch, imported rather than restated.
 *
 * `resolveNativeGenerationReceipt` refuses any generation whose
 * `engine_version` is not exactly `NATIVE_AD_ENGINE_VERSION` — the refusal is
 * `native_latest_job_engine_mismatch` and it drops the read to the legacy
 * creative envelope, where there are no exact-Ad candidates and this defect
 * cannot be observed at all. A literal here would rot silently into a seam that
 * still passes while proving nothing.
 */
const ENGINE_VERSION = NATIVE_AD_ENGINE_VERSION;
const CAMPAIGN_ID = "c-sixty-ad-seam";
const ADSET_ID = "as-sixty-ad-seam";
const ACCOUNT_TZ = "America/Chicago";

/**
 * 80 against a 60-row cap: the smallest shape in which the defect is visible.
 *
 * `META_DECISIONS_AD_CANDIDATE_LIMIT` is 60, so 20 real verdicts are omitted by
 * the cap; a 60-or-fewer population selects everything and the served set and
 * the universe coincide, which is precisely why every existing fixture missed
 * this. `CAPPED_OUT_COUNT` is derived from the shipped constant rather than
 * written down a second time, and the first case asserts it is positive, so a
 * cap raised above 80 fails this seam loudly instead of quietly making the
 * population too small to express the defect.
 */
const AD_COUNT = 80;
const CAPPED_OUT_COUNT = AD_COUNT - META_DECISIONS_AD_CANDIDATE_LIMIT;

/** Numeric ad ids: `activeInventoryAdId` and `adDecision` both require `^\d+$`. */
function adIdAt(index: number) {
  return `12060000000000${String(index).padStart(4, "0")}`;
}

const AD_IDS = Array.from({ length: AD_COUNT }, (_, index) => adIdAt(index));

function sha(seed: string) {
  return createHash("sha256").update(seed).digest("hex");
}

/**
 * The decision the engine recorded for one ad.
 *
 * A deliberate mix of hard `cut`, hard `scale` and unauthorized `keep` so the
 * lane reserves in `selectAdCandidates` are actually exercised: with a single
 * label the reserve arithmetic collapses and the selection would be a plain
 * head-of-list slice, which is not the selection production runs.
 */
function adPlan(index: number) {
  const adId = AD_IDS[index]!;
  if (index % 4 === 0) {
    return {
      adId,
      label: "cut",
      authorizedAction: "cut" as string | null,
      confidence: 78,
      spend: 640 + index,
      purchases: 3,
      roas: 0.85,
      reason: `[economic stop-loss] ROAS 0.85 (28d) below break-even (seam ad ${index}).`,
    };
  }
  if (index % 4 === 1) {
    return {
      adId,
      label: "scale",
      authorizedAction: "scale" as string | null,
      confidence: 74,
      spend: 520 + index,
      purchases: 22,
      roas: 4.6,
      reason: `[scale] ROAS 4.60 (28d) clears the scale gates (seam ad ${index}).`,
    };
  }
  return {
    adId,
    label: "keep",
    authorizedAction: null as string | null,
    confidence: 62,
    spend: 300 + index,
    purchases: 9,
    roas: 2.4,
    reason: `[hold] above target; no gate opened (seam ad ${index}).`,
  };
}

let sessionCookie = "";
let asOfDate = "";

async function seed() {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // One transaction: composite FKs in the calibration lattice include one
    // exact `as_of_cutoff`, so every lattice statement must share it. Use the
    // start of the current ACCOUNT day as that instant. A raw `now()` crosses
    // into the next UTC date for several hours while Chicago is still on the
    // prior account day, which makes the fixture violate the production
    // cutoff-date constraint even though its decision date is correct.
    await client.query("BEGIN");
    const userId = (
      await client.query(
        `INSERT INTO users (name, email, password_hash)
         VALUES ('Sixty ad acceptance seam', $1, 'unused') RETURNING id`,
        [OWNER_EMAIL],
      )
    ).rows[0].id as string;
    await client.query(
      `INSERT INTO businesses (id, name, owner_id, currency, platform)
       VALUES ($1::uuid, 'Sixty ad acceptance seam', $2, 'USD', 'shopify')`,
      [BUSINESS_ID, userId],
    );
    await client.query(
      `INSERT INTO memberships (user_id, business_id, role, status)
       VALUES ($1, $2, 'admin', 'active')`,
      [userId, BUSINESS_ID],
    );
    await client.query(
      `INSERT INTO business_engine_v3_flags (business_id, surface_visible, shadow_only)
       VALUES ($1::uuid, true, false)`,
      [BUSINESS_ID],
    );
    // REAL request auth: a fresh in-memory token; only its sha256 is written,
    // into the throwaway cluster.
    const token = randomBytes(32).toString("hex");
    await client.query(
      `INSERT INTO sessions (user_id, token_hash, active_business_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [userId, sha(token), BUSINESS_ID],
    );
    sessionCookie = `omniads_session=${token}`;

    const accountRefId = (
      await client.query(
        `INSERT INTO provider_accounts
           (provider, external_account_id, account_name, currency, timezone)
         VALUES ('meta', $1, 'Sixty ad acceptance seam', 'USD', $2)
         RETURNING id`,
        [ACCOUNT_ID, ACCOUNT_TZ],
      )
    ).rows[0].id as string;
    await client.query(
      `INSERT INTO business_provider_accounts
         (business_id, provider, provider_account_id, is_selected,
          business_ref_id, provider_account_ref_id)
       VALUES ($1::text, 'meta', $2, true, $1::uuid, $3::uuid)`,
      [BUSINESS_ID, ACCOUNT_ID, accountRefId],
    );
    await client.query(
      `INSERT INTO business_target_packs
         (business_id, target_roas, break_even_roas, source_label, business_ref_id)
       VALUES ($1::uuid, 2, 1.7, 'settings_manual_entry', $1::uuid)`,
      [BUSINESS_ID],
    );
    await client.query(
      `INSERT INTO business_cost_models
         (business_id, cogs_percent, shipping_percent, fee_percent,
          fixed_monthly_cost, business_ref_id)
       VALUES ($1::uuid, 40, 8, 3, 0, $1::uuid)`,
      [BUSINESS_ID],
    );
    await client.query(
      `INSERT INTO meta_automation_business_controls
         (business_id, kill_switch_engaged, auto_execution_enabled,
          readiness_tier, guardrails_json)
       VALUES ($1::uuid, false, false, 'manual_review',
               '{"dryRunOnly": true, "requireLivePreflight": true}'::jsonb)`,
      [BUSINESS_ID],
    );

    const accountClock = (
      await client.query<{ d: string; cutoff: Date }>(
        `SELECT
           (now() AT TIME ZONE $1)::date::text AS d,
           date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1 AS cutoff`,
        [ACCOUNT_TZ],
      )
    ).rows[0]!;
    asOfDate = accountClock.d;
    const asOfCutoff = accountClock.cutoff.toISOString();

    for (let offset = 0; offset < 3; offset += 1) {
      await client.query(
        `INSERT INTO meta_account_daily
           (business_id, provider_account_id, date, account_name,
            account_timezone, account_currency, spend, revenue, conversions,
            business_ref_id)
         VALUES ($1::text, $2, (now() AT TIME ZONE $3)::date - $4::int,
                 'Sixty ad acceptance seam', $3, 'USD', 12000, 30000, 400,
                 $1::uuid)`,
        [BUSINESS_ID, ACCOUNT_ID, ACCOUNT_TZ, offset],
      );
    }

    await client.query(
      `INSERT INTO meta_campaign_dimensions
         (business_id, provider_account_id, campaign_id, campaign_name_current,
          campaign_status, business_ref_id)
       VALUES ($1::text, $2, $3, 'Sixty ad seam campaign', 'ACTIVE', $1::uuid)`,
      [BUSINESS_ID, ACCOUNT_ID, CAMPAIGN_ID],
    );
    await client.query(
      `INSERT INTO meta_adset_dimensions
         (business_id, provider_account_id, campaign_id, adset_id,
          adset_name_current, adset_status, business_ref_id)
       VALUES ($1::text, $2, $3, $4, 'Sixty ad seam ad set', 'ACTIVE', $1::uuid)`,
      [BUSINESS_ID, ACCOUNT_ID, CAMPAIGN_ID, ADSET_ID],
    );
    await client.query(
      `INSERT INTO engine_v3_campaign_context_daily
         (business_id, provider_account_id, campaign_id, campaign_name,
          as_of_date, inferred_kind, confidence_score, confidence_class,
          kind_source, kind_basis, resolver_version, signal_scores_json,
          evidence_json, conflict_reasons_json)
       VALUES ($1::text, $2, $3, 'Sixty ad seam campaign', $4::date, 'main',
               0.92, 'high', 'system_inferred', 'sixty_ad_seam', $5,
               '{}'::jsonb, '["sixty ad seam evidence"]'::jsonb, '[]'::jsonb)`,
      [BUSINESS_ID, ACCOUNT_ID, CAMPAIGN_ID, asOfDate, CAMPAIGN_CONTEXT_RESOLVER_VERSION],
    );

    // Physical-capacity telemetry: the growth fence denies admission
    // fail-closed without a fresh db-host healthcheck sample.
    await client.query(
      `INSERT INTO system_capacity_snapshots (source, hostname, sampled_at, payload)
       VALUES ('db_host_healthcheck', 'sixty-ad-seam-host', clock_timestamp(),
               jsonb_build_object(
                 'hostname', 'sixty-ad-seam-host',
                 'database', jsonb_build_object('name', current_database()),
                 'disks', jsonb_build_array(jsonb_build_object(
                   'path', '/var/lib/postgresql',
                   'totalBytes', 500000000000,
                   'usedBytes', 100000000000,
                   'availableBytes', 400000000000
                 ))
               ))`,
    );
    await client.query(
      `INSERT INTO meta_sync_runs
         (business_id, provider_account_id, lane, scope, partition_date,
          status, started_at, finished_at, business_ref_id)
       VALUES ($1::text, $2, 'maintenance', 'account_daily',
               (now() AT TIME ZONE $3)::date - 1, 'succeeded',
               now() - interval '10 minutes', now() - interval '9 minutes',
               $1::uuid)`,
      [BUSINESS_ID, ACCOUNT_ID, ACCOUNT_TZ],
    );

    for (let index = 0; index < AD_COUNT; index += 1) {
      const plan = adPlan(index);
      await client.query(
        `INSERT INTO meta_ad_dimensions
           (business_id, provider_account_id, campaign_id, adset_id, ad_id,
            ad_name_current, ad_status, business_ref_id)
         VALUES ($1::text, $2, $3, $4, $5, $6, 'ACTIVE', $1::uuid)`,
        [
          BUSINESS_ID,
          ACCOUNT_ID,
          CAMPAIGN_ID,
          ADSET_ID,
          plan.adId,
          `SEAM_${plan.adId.slice(-4)}`,
        ],
      );
      for (let offset = 0; offset < 3; offset += 1) {
        await client.query(
          `INSERT INTO meta_ad_daily
             (business_id, provider_account_id, date, campaign_id, adset_id,
              ad_id, ad_name_current, ad_status, account_timezone,
              account_currency, spend, impressions, clicks, conversions,
              revenue, truth_state, finalized_at, validation_status,
              business_ref_id)
           VALUES ($1::text, $2, (now() AT TIME ZONE $3)::date - $4::int, $5,
                   $6, $7, $8, 'ACTIVE', $3, 'USD', $9, 1000, 30, $10, $11,
                   'finalized', now(), 'passed', $1::uuid)`,
          [
            BUSINESS_ID,
            ACCOUNT_ID,
            ACCOUNT_TZ,
            offset,
            CAMPAIGN_ID,
            ADSET_ID,
            plan.adId,
            `SEAM_${plan.adId.slice(-4)}`,
            plan.spend / 3,
            plan.purchases / 3,
            (plan.roas * plan.spend) / 3,
          ],
        );
      }
    }

    const calibrationJobRunId = (
      await client.query(
        `INSERT INTO engine_v3_job_runs
           (job_name, business_ref_id, business_id, as_of_date, engine_version,
            status, started_at, finished_at)
         VALUES ('engine_v3_native_ad_calibration_shadow_job', $1::uuid,
                 $1::text, $2::date, $3, 'success', now() - interval '2 hours',
                 now() - interval '119 minutes')
         RETURNING id`,
        [BUSINESS_ID, asOfDate, ENGINE_VERSION],
      )
    ).rows[0].id as string;

    // The serving predicate recomputes the identity-manifest hash over the
    // generation's sorted ad ids and requires exact equality with the receipt,
    // so the receipt must carry the REAL hash over all 80.
    const manifestHash = hashAdDecisionIdentityManifest({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      asOfDate,
      adIds: [...AD_IDS].map((value) => value.trim()).sort(),
    });
    const decisionsJobRunId = (
      await client.query(
        `INSERT INTO engine_v3_job_runs
           (job_name, business_ref_id, business_id, as_of_date, engine_version,
            status, started_at, finished_at, row_count, error_json)
         VALUES ('engine_v3_native_ad_decisions_shadow_job', $1::uuid, $1::text,
                 $2::date, $3, 'success', now() - interval '90 minutes',
                 now() - interval '89 minutes', $4, $5::jsonb)
         RETURNING id`,
        [
          BUSINESS_ID,
          asOfDate,
          ENGINE_VERSION,
          AD_COUNT,
          JSON.stringify({
            metadata: {
              hydration_receipts: [
                {
                  provider_account_id: ACCOUNT_ID,
                  provider_account_ref_id: accountRefId,
                  expected_ad_count: AD_COUNT,
                  hydrated_ad_count: AD_COUNT,
                  expected_manifest_hash: manifestHash,
                  hydrated_manifest_hash: manifestHash,
                  authoritative_for_prune: true,
                },
              ],
            },
          }),
        ],
      )
    ).rows[0].id as string;

    const batchId = (
      await client.query(
        `INSERT INTO engine_v3_ad_account_calibration_batches
           (business_ref_id, business_id, provider, provider_account_ref_id,
            provider_account_id, as_of_date, as_of_cutoff,
            transaction_isolation, engine_version, policy_version, source_mode,
            source_provenance_json, expected_cell_count,
            generation_content_hash, input_manifest_hash, source_manifest_hash,
            cell_set_hash, completeness_status, job_run_id, computed_at,
            completed_at, contract_version)
         VALUES ($1::uuid, $1::text, 'meta', $2::uuid, $3::text, $4::date,
                 $5::timestamptz, 'repeatable read', $6, 'sixty-ad-seam',
                 'current_transaction_snapshot',
                 jsonb_build_object(
                   'mode', 'current_transaction_snapshot',
                   'providerAccountRefId', $2::text,
                   'providerAccountId', $3::text,
                   'transactionCutoff', $5::timestamptz,
                   'transactionIsolation', 'repeatable read'
                 ), 1,
                 $7, $8, $9, $10, 'writing', $11::uuid,
                 $5::timestamptz, NULL, $12)
         RETURNING id`,
        [
          BUSINESS_ID,
          accountRefId,
          ACCOUNT_ID,
          asOfDate,
          asOfCutoff,
          ENGINE_VERSION,
          sha("sixty-gen"),
          sha("sixty-input"),
          sha("sixty-source"),
          sha("sixty-cells"),
          calibrationJobRunId,
          NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
        ],
      )
    ).rows[0].id as string;

    const calibrationRowId = (
      await client.query(
        `INSERT INTO engine_v3_ad_account_calibration_daily
           (batch_id, business_ref_id, business_id, provider,
            provider_account_ref_id, provider_account_id, account_timezone,
            account_currency, cell_scope, objective, funnel_cohort,
            optimization_context, as_of_date, as_of_cutoff, engine_version,
            policy_version, sample_window_start, sample_window_end,
            sample_window_days, source_ad_count, source_day_count,
            eligible_ad_count, mature_ad_count, zero_conversion_ad_count,
            account_cpa_sample_count, meta_attributed_aov_purchase_count_90d,
            meta_attributed_revenue_90d, meta_aov_quality,
            funnel_calibration_json, metric_sample_counts_json,
            action_readiness_json, quality_counts_json, quality_status,
            target_authority_status, target_authority_hash,
            batch_input_manifest_hash, input_manifest_hash,
            source_manifest_hash, job_run_id, computed_at, contract_version)
         VALUES ($1::uuid, $2::uuid, $2::text, 'meta', $3::uuid, $4, $5, 'USD',
                 'account_objective_cohort', 'OUTCOME_SALES', 'purchase',
                 'purchase', $6::date, $7::timestamptz, $8, 'sixty-ad-seam',
                 $6::date - 27, $6::date, 28, $9, $10, $9, $9, 0, $9, 400,
                 520000, 'ready', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                 '{}'::jsonb, 'ready', 'fresh', $11, $12, $13, $14,
                 $15::uuid, $7::timestamptz, $16)
         RETURNING id`,
        [
          batchId,
          BUSINESS_ID,
          accountRefId,
          ACCOUNT_ID,
          ACCOUNT_TZ,
          asOfDate,
          asOfCutoff,
          ENGINE_VERSION,
          AD_COUNT,
          AD_COUNT * 28,
          sha("sixty-authority"),
          sha("sixty-input"),
          sha("sixty-input"),
          sha("sixty-source"),
          calibrationJobRunId,
          NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
        ],
      )
    ).rows[0].id as string;

    await client.query(
      `UPDATE engine_v3_ad_account_calibration_batches
          SET completeness_status = 'complete', completed_at = now()
        WHERE id = $1::uuid`,
      [batchId],
    );

    const contextId = (
      await client.query(
        `INSERT INTO engine_v3_ad_decision_evaluation_contexts
           (business_ref_id, business_id, provider_account_ref_id,
            provider_account_id, as_of_date, engine_version, scope_type,
            scope_id, contract_version, context_json, account_profile_json,
            data_health_json, flags_json, context_hash, job_run_id,
            evaluated_at)
         VALUES ($1::uuid, $1::text, $2::uuid, $3, $4::date, $5, 'account', $3,
                 'sixty-ad-seam', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                 '{}'::jsonb, $6, $7::uuid, now())
         RETURNING id`,
        [
          BUSINESS_ID,
          accountRefId,
          ACCOUNT_ID,
          asOfDate,
          ENGINE_VERSION,
          sha("sixty-context"),
          decisionsJobRunId,
        ],
      )
    ).rows[0].id as string;

    for (let index = 0; index < AD_COUNT; index += 1) {
      const plan = adPlan(index);
      const evaluationId = (
        await client.query(
          `INSERT INTO engine_v3_ad_decision_evaluations
             (context_id, business_ref_id, business_id, provider_account_ref_id,
              provider_account_id, decision_entity_type, decision_entity_id,
              ad_id, creative_id, as_of_date, engine_version, scope_type,
              scope_id, contract_version, creative_input_json,
              campaign_context_json, prior_hysteresis_json,
              decision_output_json, raw_label, input_hash, decision_hash,
              job_run_id, evaluated_at)
           VALUES ($1::uuid, $2::uuid, $2::text, $3::uuid, $4, 'ad', $5, $5,
                   $6, $7::date, $8, 'account', $4, 'sixty-ad-seam',
                   $9::jsonb, '{}'::jsonb, '{}'::jsonb, $10::jsonb, $11, $12,
                   $13, $14::uuid, now())
           RETURNING id`,
          [
            contextId,
            BUSINESS_ID,
            accountRefId,
            ACCOUNT_ID,
            plan.adId,
            `cr_${plan.adId.slice(-6)}`,
            asOfDate,
            ENGINE_VERSION,
            JSON.stringify({
              adId: plan.adId,
              spend: plan.spend,
              purchases: plan.purchases,
              roas: plan.roas,
              purchaseValue: plan.roas * plan.spend,
              targetRoas: 2,
              breakevenRoas: 1.7,
              objective: "OUTCOME_SALES",
              optimizationGoal: "Offsite Conversions",
              customEventType: "PURCHASE",
              effectiveCohort: "purchase",
              effectiveStatus: "ACTIVE",
              accountCurrency: "USD",
              accountTimezone: ACCOUNT_TZ,
            }),
            JSON.stringify({
              adId: plan.adId,
              label: plan.label,
              reason: plan.reason,
              confidence: plan.confidence,
              metrics: {
                roas: plan.roas,
                spend: plan.spend,
                purchases: plan.purchases,
              },
              effectiveTargetRoas: 2,
              ratioToTarget: plan.roas / 2,
              truthSource: "commercial_truth",
              engineVersion: ENGINE_VERSION,
              campaignRoleStatus: "resolved",
              campaignKind: "main",
            }),
            plan.label,
            sha(`sixty-in-${plan.adId}`),
            sha(`sixty-dec-${plan.adId}`),
            decisionsJobRunId,
          ],
        )
      ).rows[0].id as string;

      await client.query(
        `INSERT INTO engine_v3_ad_decision_snapshots_daily
           (business_ref_id, business_id, provider_account_ref_id,
            provider_account_id, decision_entity_type, decision_entity_id,
            ad_id, creative_id, as_of_date, engine_version, scope_type,
            scope_id, label, raw_label, confidence, truth_source,
            effective_target_roas, ratio_to_target, badges, reason, spend,
            purchases, roas, authorized_action, calibration_row_id,
            evaluation_id, input_hash, decision_hash, computed_at, job_run_id,
            idempotency_key)
         VALUES ($1::uuid, $1::text, $2::uuid, $3, 'ad', $4, $4, $5, $6::date,
                 $7, 'account', $3, $8, $8, $9, 'commercial_truth', 2, $10,
                 '[]'::jsonb, $11, $12, $13, $14, $15, $16::uuid, $17::uuid,
                 $18, $19, now(), $20::uuid, $21)`,
        [
          BUSINESS_ID,
          accountRefId,
          ACCOUNT_ID,
          plan.adId,
          `cr_${plan.adId.slice(-6)}`,
          asOfDate,
          ENGINE_VERSION,
          plan.label,
          plan.confidence,
          plan.roas / 2,
          plan.reason,
          plan.spend,
          plan.purchases,
          plan.roas,
          plan.authorizedAction,
          calibrationRowId,
          evaluationId,
          sha(`sixty-in-${plan.adId}`),
          sha(`sixty-dec-${plan.adId}`),
          decisionsJobRunId,
          `sixty-${plan.adId}`,
        ],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

interface OsAdsBlock {
  items: Array<{ adId: string }>;
  pendingInventoryCount?: number;
  limitations?: Array<{ code: string; message?: string }>;
}

interface WorkspacePayload {
  decisionReadModel: {
    status: string;
    source?: {
      status?: string;
      authority?: string;
      fallbackReason?: string | null;
      generation?: { jobRunId?: string | null };
    };
    unavailable?: unknown;
    queue?: {
      adCandidates?: {
        limit: number;
        eligiblePreCapCount: number;
        selectedCount: number;
      };
    };
  };
  os: { ads: OsAdsBlock; limitations?: Array<{ code: string }> };
}

let payload: WorkspacePayload;

async function workspaceGet(): Promise<{
  status: number;
  payload: WorkspacePayload;
}> {
  const route = await import("@/app/api/meta/decisions-workspace/route");
  const response = await route.GET(
    new NextRequest(
      `http://localhost/api/meta/decisions-workspace?businessId=${BUSINESS_ID}&providerAccountId=${ACCOUNT_ID}&window=28d`,
      { headers: { cookie: sessionCookie } },
    ),
  );
  if (response.status !== 200) {
    console.error(
      "[sixty-ad-seam] route error body:",
      JSON.stringify(await response.clone().json()).slice(0, 1500),
    );
  }
  return {
    status: response.status,
    payload: (await response.json()) as WorkspacePayload,
  };
}

describe.skipIf(!SEAM)(
  "decisions workspace >60-Ad acceptance (real route, real database)",
  () => {
    beforeAll(async () => {
      // D074: trusted-for-action roles are reachable only after the deliberate
      // operator act of validating the exact resolver version. The gate is
      // intentionally unset in production and in this shell; stubbing it here
      // is this process's SIMULATION of that act (repo-established practice,
      // mirrored from the D078 lattice proof), never a real environment change.
      vi.stubEnv(
        CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV,
        CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      );
      vi.stubGlobal("fetch", networkSpy);
      await seed();

      metaApiMock.resolveMetaCredentials.mockResolvedValue({
        accountIds: [ACCOUNT_ID],
        accessToken: "sixty-ad-seam-inventory-boundary",
      });
      metaApiMock.fetchMetaActiveAdConfigsReceipt.mockResolvedValue({
        complete: true,
        termination: "exhausted",
        rows: AD_IDS.map((adId) => ({
          id: adId,
          name: `SEAM_${adId.slice(-4)}`,
          status: "ACTIVE",
          effective_status: "ACTIVE",
          campaign_id: CAMPAIGN_ID,
          adset_id: ADSET_ID,
          creative: { id: `cr_${adId.slice(-6)}` },
          updated_time: "2026-08-29T00:00:00+0000",
        })),
      });

      const first = await workspaceGet();
      expect(first.status).toBe(200);
      payload = first.payload;
    }, 180_000);

    afterAll(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it("serves a native generation whose exact-Ad population exceeds the cap", () => {
      expect(payload.decisionReadModel.status).toBe("available");
      expect(payload.decisionReadModel.source?.authority).toBe("native_ad");
      const candidates = payload.decisionReadModel.queue?.adCandidates;
      expect(candidates?.limit).toBe(META_DECISIONS_AD_CANDIDATE_LIMIT);
      expect(candidates?.eligiblePreCapCount).toBe(AD_COUNT);
      expect(candidates?.selectedCount).toBe(META_DECISIONS_AD_CANDIDATE_LIMIT);
      expect(CAPPED_OUT_COUNT).toBeGreaterThan(0);
    });

    it("does not count a capped-out exact decision as pending ACTIVE inventory", () => {
      // The whole defect in one number. Every one of the 80 ACTIVE Ads has an
      // exact Ad-grain verdict; the cap serves 60 of them. If the universe did
      // not survive `structuredClone`, the presentation falls back to the 60 it
      // SERVED and reports the other 20 as un-decided inventory.
      const servedAdIds = new Set(payload.os.ads.items.map((item) => item.adId));
      const cappedOut = AD_IDS.filter((adId) => !servedAdIds.has(adId));
      // Named, so the claim is about specific decided Ads that the response
      // omitted rather than about an aggregate that could be zero for any
      // reason: every id here was sent as ACTIVE in the provider receipt and
      // has its own row in `engine_v3_ad_decision_snapshots_daily`.
      expect(cappedOut.length).toBe(CAPPED_OUT_COUNT);
      expect(AD_IDS).toEqual(expect.arrayContaining(cappedOut));
      expect(payload.os.ads.pendingInventoryCount).toBe(0);
    });

    it("publishes no pending-inventory limitation when every ACTIVE Ad is decided", () => {
      const codes = (payload.os.limitations ?? []).map((item) => item.code);
      expect(codes).not.toContain(
        "active_ad_inventory_pending_native_decision",
      );
    });

    it("still serves exactly the capped number of decision rows", () => {
      // The guard against a fixture tuned to pass: the pending count is 0
      // BECAUSE the universe survived, not because the cap stopped biting.
      expect(payload.os.ads.items.length).toBe(
        META_DECISIONS_AD_CANDIDATE_LIMIT,
      );
      const servedAdIds = new Set(payload.os.ads.items.map((item) => item.adId));
      expect(servedAdIds.size).toBe(META_DECISIONS_AD_CANDIDATE_LIMIT);
      const omitted = AD_IDS.filter((adId) => !servedAdIds.has(adId));
      expect(omitted.length).toBe(CAPPED_OUT_COUNT);
    });

    it("made no network call of any kind", () => {
      expect(networkSpy).not.toHaveBeenCalled();
    });
  },
);

/**
 * THE CACHE CROSSING.
 *
 * `app/api/meta/decisions-workspace/route.ts` wraps the decision read in
 * `getCachedValue` at `ttlMs: 60_000` / `staleWhileRevalidateMs: 240_000` under
 * `shouldCache: result.ok && result.model.status === "available"`.
 *
 * The suite above cannot exercise that, and saying so is part of the evidence:
 * the route takes the cache branch only when `process.env.VITEST !== "true" &&
 * process.env.NODE_ENV !== "test"`, so under a normal vitest run EVERY cached
 * loader in that file — the decision read, the current-Ad inventory, the
 * commercial anchor profile, the campaign contexts and the upstream pair — is
 * called directly. A seam that drove `GET` and then claimed the cache was
 * covered would be claiming coverage of a branch it never entered.
 *
 * So this suite stubs those two variables for the duration, which is the only
 * way the shipped cache branch runs at all, and then measures three things:
 *
 *   1. WHERE THE UNIVERSE IS ACTUALLY LOST. `lib/server-cache.ts` stores and
 *      returns the value BY REFERENCE (`writeEntry` puts the object into a Map
 *      and `readEntry` hands the same object back; neither clones). So the
 *      non-enumerable symbol survives the cache untouched, and
 *      `structuredClone` is the ONLY step in the chain that drops it. Both
 *      halves are measured here rather than assumed.
 *   2. That a request served FROM the cache still tells a capped-out decision
 *      from un-decided inventory.
 *   3. WHAT A CACHED ENVELOPE OUTLIVES — reported as a finding, not as a bug:
 *      inside the stale-while-revalidate window the route serves a decision
 *      envelope, universe included, that the database no longer supports.
 */
describe.skipIf(!SEAM)(
  "decisions workspace cache crossing (real server cache, real route)",
  () => {
    const CACHE_STORE_KEY = "__omniadsServerCache";

    /**
     * Wait for every background revalidation to finish.
     *
     * `getCachedValue` fires the stale-window refresh with `void
     * loadIntoCache(...)`, so the stale RESPONSE returns before the
     * revalidation has decided anything. A test that asserted on the next
     * request without waiting would be measuring a race, and would pass on a
     * tree where eviction had been removed simply because it read the entry
     * before the eviction ran. `store.inflight` is the cache's own record of
     * work in progress; real timers throughout, because this waits on the
     * database.
     */
    async function settleCacheRevalidations() {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const store = (globalThis as Record<string, unknown>)[CACHE_STORE_KEY] as
          | { inflight: Map<string, unknown> }
          | undefined;
        if (!store || store.inflight.size === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("cache revalidations did not settle");
    }

    async function setNativeDecisionJobStatus(status: string) {
      const { Client } = await import("pg");
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        const updated = await client.query(
          `UPDATE engine_v3_job_runs SET status = $2
            WHERE business_id = $1
              AND job_name = 'engine_v3_native_ad_decisions_shadow_job'`,
          [BUSINESS_ID, status],
        );
        expect(updated.rowCount).toBeGreaterThanOrEqual(1);
      } finally {
        await client.end();
      }
    }

    /**
     * A GENUINELY SEPARATE SECOND GENERATION.
     *
     * ROUND 6 item 7: this suite used to flip the ONE seeded job row from
     * `failed` back to `success`, which is not a new generation — it is the old
     * one un-failed, so `source.generation.jobRunId` never moved and "the next
     * request picks up the new generation" was never actually asserted.
     *
     * This writes a second `engine_v3_native_ad_decisions_shadow_job` run with
     * its own id and later clocks, carrying the SAME 80-ad hydration receipt
     * and manifest hash — the universe must survive a regeneration — and
     * re-points all 80 snapshot rows at it with fresh decision hashes and
     * idempotency keys, which is what a real re-run produces. g1 is left
     * `failed`, so the receipt resolver has exactly one servable generation and
     * it is g2.
     */
    async function createSecondDecisionGeneration(): Promise<string> {
      const { Client } = await import("pg");
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        const accountRefId = (
          await client.query(
            `SELECT id FROM provider_accounts WHERE external_account_id = $1`,
            [ACCOUNT_ID],
          )
        ).rows[0].id as string;
        const manifestHash = hashAdDecisionIdentityManifest({
          businessId: BUSINESS_ID,
          providerAccountId: ACCOUNT_ID,
          asOfDate,
          adIds: [...AD_IDS].map((value) => value.trim()).sort(),
        });
        const g2 = (
          await client.query(
            `INSERT INTO engine_v3_job_runs
               (job_name, business_ref_id, business_id, as_of_date, engine_version,
                status, started_at, finished_at, row_count, error_json)
             VALUES ('engine_v3_native_ad_decisions_shadow_job', $1::uuid, $1::text,
                     $2::date, $3, 'success', now() - interval '5 minutes',
                     now() - interval '4 minutes', $4, $5::jsonb)
             RETURNING id`,
            [
              BUSINESS_ID,
              asOfDate,
              ENGINE_VERSION,
              AD_COUNT,
              JSON.stringify({
                metadata: {
                  hydration_receipts: [
                    {
                      provider_account_id: ACCOUNT_ID,
                      provider_account_ref_id: accountRefId,
                      expected_ad_count: AD_COUNT,
                      hydrated_ad_count: AD_COUNT,
                      expected_manifest_hash: manifestHash,
                      hydrated_manifest_hash: manifestHash,
                      authoritative_for_prune: true,
                    },
                  ],
                },
              }),
            ],
          )
        ).rows[0].id as string;

        /*
          THE WHOLE LINEAGE MOVES WITH IT, BECAUSE THE SCHEMA SAYS SO.

          `engine_v3_ad_evaluations_context_lineage_fk` binds an evaluation to a
          CONTEXT by eleven columns including `job_run_id`, and
          `engine_v3_ad_snapshots_evaluation_lineage_fk` binds a snapshot to an
          evaluation by fifteen including `decision_hash` and `job_run_id`. A
          second generation is therefore not a snapshot rewrite: context,
          evaluations and snapshots are all re-minted under the new run,
          exactly as the real job does. Every column list is read from the
          catalogue rather than restated, so a schema change cannot silently
          leave a column behind.
        */
        const contextColumns = (
          await client.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'engine_v3_ad_decision_evaluation_contexts'
                AND column_name <> 'id'
              ORDER BY ordinal_position`,
          )
        ).rows.map((row) => row.column_name);
        const contextRows = (
          await client.query<{ id: string; old_id: string }>(
            `INSERT INTO engine_v3_ad_decision_evaluation_contexts
               (${contextColumns.map((column) => `"${column}"`).join(", ")})
             SELECT ${contextColumns
               .map((column) =>
                 column === "job_run_id" ? `$2::uuid AS job_run_id` : `"${column}"`,
               )
               .join(", ")}
               FROM engine_v3_ad_decision_evaluation_contexts
              WHERE business_id = $1 AND as_of_date = $3::date
                AND job_run_id <> $2::uuid
             RETURNING id, scope_id AS old_id`,
            [BUSINESS_ID, g2, asOfDate],
          )
        ).rows;
        expect(contextRows.length).toBeGreaterThan(0);
        const newContextId = contextRows[0]!.id;

        const evaluationColumns = (
          await client.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'engine_v3_ad_decision_evaluations'
                AND column_name <> 'id'
              ORDER BY ordinal_position`,
          )
        ).rows.map((row) => row.column_name);
        const projected = evaluationColumns
          .map((column) =>
            column === "job_run_id"
              ? `$2::uuid AS job_run_id`
              : column === "context_id"
                ? `$4::uuid AS context_id`
                : column === "decision_hash"
                  ? `encode(sha256(('g2-' || ad_id)::bytea), 'hex') AS decision_hash`
                  : `"${column}"`,
          )
          .join(", ");
        const reminted = await client.query(
          `INSERT INTO engine_v3_ad_decision_evaluations
             (${evaluationColumns.map((column) => `"${column}"`).join(", ")})
           SELECT ${projected}
             FROM engine_v3_ad_decision_evaluations
            WHERE business_id = $1 AND as_of_date = $3::date
              AND job_run_id <> $2::uuid
           RETURNING id, ad_id`,
          [BUSINESS_ID, g2, asOfDate, newContextId],
        );
        expect(reminted.rowCount).toBe(AD_COUNT);
        const evaluationIdByAdId = new Map(
          reminted.rows.map((row) => [row.ad_id as string, row.id as string]),
        );

        let repointed = 0;
        for (const [adId, evaluationId] of evaluationIdByAdId) {
          const updated = await client.query(
            `UPDATE engine_v3_ad_decision_snapshots_daily
                SET job_run_id = $2::uuid,
                    evaluation_id = $4::uuid,
                    decision_hash = encode(sha256(('g2-' || ad_id)::bytea), 'hex'),
                    idempotency_key = 'sixty-g2-' || ad_id,
                    computed_at = now()
              WHERE business_id = $1
                AND as_of_date = $3::date
                AND ad_id = $5`,
            [BUSINESS_ID, g2, asOfDate, evaluationId, adId],
          );
          repointed += updated.rowCount ?? 0;
        }
        // All eighty, so the universe the response caps at sixty is intact.
        expect(repointed).toBe(AD_COUNT);
        return g2;
      } finally {
        await client.end();
      }
    }

    beforeAll(() => {
      vi.stubEnv(
        CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV,
        CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      );
      vi.stubGlobal("fetch", networkSpy);
      // The two variables the route's own cache branch reads. Stubbed, not
      // set: `vi.unstubAllEnvs` restores both in `afterAll`.
      vi.stubEnv("VITEST", "");
      vi.stubEnv("NODE_ENV", "production");
      // The cache store hangs off `globalThis` and survives module reloads, so
      // start from a known-empty one rather than inheriting whatever an earlier
      // suite in this process left behind.
      delete (globalThis as Record<string, unknown>)[CACHE_STORE_KEY];
      metaApiMock.fetchMetaActiveAdConfigsReceipt.mockClear();
    });

    afterAll(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      delete (globalThis as Record<string, unknown>)[CACHE_STORE_KEY];
    });

    it("returns the read model by reference, so the universe survives the cache and only structuredClone drops it", async () => {
      const { readMetaDecisionsWorkspaceReadModel } = await import(
        "@/lib/meta/decisions-workspace-read-model"
      );
      const { getCachedValue } = await import("@/lib/server-cache");
      /*
        The well-known symbol is LOOKED UP, never populated here.

        `Symbol.for` reads the cross-realm registry, so this is the identical
        symbol `attachCanonicalAdUniverse` uses — the distinction from
        `lib/meta/decisions-canonical-ad-universe.test.ts`, which defines the
        property itself and therefore proves nothing about the attachment.
      */
      const universeSymbol = Symbol.for(
        "adsecute.meta.decisions.canonical-ad-universe",
      );
      type WithUniverse = Record<symbol, ReadonlySet<string> | undefined>;

      const loader = async () =>
        readMetaDecisionsWorkspaceReadModel({
          businessId: BUSINESS_ID,
          providerAccountId: ACCOUNT_ID,
          asOfDate,
          currentAds: AD_IDS.map((adId) => ({
            providerAccountId: ACCOUNT_ID,
            adId,
            adName: `SEAM_${adId.slice(-4)}`,
            campaignId: CAMPAIGN_ID,
            campaignName: "Sixty ad seam campaign",
            adsetId: ADSET_ID,
            creativeId: `cr_${adId.slice(-6)}`,
            configuredStatus: "ACTIVE",
            effectiveStatus: "ACTIVE",
            providerUpdatedAt: "2026-08-29T00:00:00+0000",
            fetchedAt: new Date().toISOString(),
          })),
          currentAdSourceComplete: true,
        });

      // The route's own literal cache parameters, including its `shouldCache`
      // predicate translated to this loader's shape.
      const key = `sixty-ad-seam-universe-cache:${BUSINESS_ID}:${ACCOUNT_ID}:${asOfDate}`;
      const first = await getCachedValue({
        key,
        ttlMs: 60_000,
        staleWhileRevalidateMs: 240_000,
        loader,
        shouldCache: (model) => model.status === "available",
      });
      expect(first.cacheState).toBe("miss");
      expect(first.value.status).toBe("available");
      expect(
        (first.value as unknown as WithUniverse)[universeSymbol]?.size,
      ).toBe(AD_COUNT);

      const second = await getCachedValue({
        key,
        ttlMs: 60_000,
        staleWhileRevalidateMs: 240_000,
        loader,
        shouldCache: (model) => model.status === "available",
      });
      expect(second.cacheState).toBe("fresh");
      // Same object, not a copy: this is why the symbol is still there.
      expect(second.value).toBe(first.value);
      expect(
        (second.value as unknown as WithUniverse)[universeSymbol]?.size,
      ).toBe(AD_COUNT);

      // The mechanism, measured on the same object rather than recalled: a
      // clone of the very model the cache just returned has no universe.
      expect(
        (structuredClone(second.value) as unknown as WithUniverse)[
          universeSymbol
        ],
      ).toBeUndefined();
    }, 120_000);

    it("serves a cached request that still tells a capped-out decision from un-decided inventory", async () => {
      const first = await workspaceGet();
      expect(first.status).toBe(200);
      expect(first.payload.decisionReadModel.source?.authority).toBe(
        "native_ad",
      );
      expect(first.payload.os.ads.pendingInventoryCount).toBe(0);
      const inventoryCallsAfterFirst =
        metaApiMock.fetchMetaActiveAdConfigsReceipt.mock.calls.length;
      expect(inventoryCallsAfterFirst).toBeGreaterThan(0);

      const second = await workspaceGet();
      expect(second.status).toBe(200);
      // The cache branch really is engaged: the provider-inventory loader was
      // not called a second time inside its 60s TTL.
      expect(metaApiMock.fetchMetaActiveAdConfigsReceipt.mock.calls.length).toBe(
        inventoryCallsAfterFirst,
      );
      expect(second.payload.decisionReadModel.source?.authority).toBe(
        "native_ad",
      );
      expect(second.payload.os.ads.pendingInventoryCount).toBe(0);
      expect(second.payload.os.ads.items.length).toBe(
        META_DECISIONS_AD_CANDIDATE_LIMIT,
      );
    }, 120_000);

    it("serves a cached envelope, universe included, that the database no longer supports", async () => {
      // Warm the cache with the healthy generation, and remember WHICH one it
      // was: the whole point of the sequence below is that the identity moves.
      const warm = await workspaceGet();
      expect(warm.status).toBe(200);
      expect(warm.payload.decisionReadModel.source?.authority).toBe(
        "native_ad",
      );
      const g1 = warm.payload.decisionReadModel.source?.generation?.jobRunId;
      expect(g1).toBeTruthy();

      // Now the generation stops being servable: its job run terminates as
      // `failed`, which `resolveNativeGenerationReceipt` refuses outright and
      // for which there is no earlier successful generation to fall back to.
      await setNativeDecisionJobStatus("failed");

      // A read taken NOW, with no cache in front of it, can no longer produce
      // the native envelope. This is what makes the next assertion a statement
      // about the cache rather than about the database.
      const { readMetaDecisionsWorkspaceReadModel } = await import(
        "@/lib/meta/decisions-workspace-read-model"
      );
      const uncached = await readMetaDecisionsWorkspaceReadModel({
        businessId: BUSINESS_ID,
        providerAccountId: ACCOUNT_ID,
        asOfDate,
      });
      expect(uncached.source.authority).not.toBe("native_ad");

      // Cross the TTL into the stale-while-revalidate window. Only `Date` is
      // faked, so the pg driver's timers and the microtask queue are untouched.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 61_000));

      const afterTtl = await workspaceGet();
      vi.useRealTimers();
      expect(afterTtl.status).toBe(200);
      /*
        THE FINDING, pinned rather than asserted away.

        Inside the 240s stale-while-revalidate window the route serves the
        CACHED decision envelope — carrying the full 80-Ad identity universe —
        for a generation the database has already stopped serving. The
        revalidation kicked off behind it returns `status: "unavailable"`, which
        `shouldCache` refuses to write, and `loadIntoCache` does not evict the
        existing entry when it declines to replace it, so the stale entry keeps
        answering until `staleUntil` passes.

        It is bounded and it is not an authority leak: the cached rows carry
        whatever execution posture they were built with, and
        `applyMetaExecutionGovernanceToReadModel` re-derives freshness against
        the CURRENT clock on every request, so the age ceiling still closes over
        a cached inventory. What it is, is a window in which the operator reads a
        universe the database can no longer produce — and the universe is the
        thing that decides whether a capped-out verdict is reported as a
        verdict. Pinning it here means a future change to the TTL, to
        `shouldCache`, or to `loadIntoCache`'s eviction behaviour has to face
        this measurement rather than rediscover it in production.
      */
      expect(afterTtl.payload.decisionReadModel.source?.authority).toBe(
        "native_ad",
      );
      expect(afterTtl.payload.os.ads.pendingInventoryCount).toBe(0);
      expect(afterTtl.payload.os.ads.items.length).toBe(
        META_DECISIONS_AD_CANDIDATE_LIMIT,
      );

      /*
        ── AND THE PROOF DOES NOT STOP AT THE FIRST STALE RESPONSE ───────────
        One stale serve is the finding; it is not the acceptance. What decides
        whether the window is BOUNDED is what the NEXT request sees, and that
        is the assertion a test which stopped here never made — leaving
        `evictStaleWhen` (the eviction the route passes for exactly this case)
        unexercised end to end, so removing it would have broken nothing.

        The revalidation the stale serve kicked off has to finish first: it is
        launched with `void loadIntoCache(...)`, so asserting without waiting
        would measure a race and would pass on a tree with no eviction at all.
      */
      await settleCacheRevalidations();

      const afterRevalidation = await workspaceGet();
      expect(afterRevalidation.status).toBe(200);
      /*
        The stale native envelope is GONE. Either the entry was evicted — the
        route's `evictStaleWhen` fires on a successful read whose model is no
        longer `available` — or the revalidation's own reading replaced it.
        Both are correct answers to "the generation the operator was reading is
        not servable"; serving the same native envelope a second time is not.
      */
      expect(
        afterRevalidation.payload.decisionReadModel.source?.authority,
      ).not.toBe("native_ad");

      /*
        ── A NEW GENERATION UNDER THE SAME CACHE KEY IS SEEN ─────────────────
        The mirror image, and the reason eviction matters: a cache that
        stopped serving the dead generation but could not pick up the next one
        would have traded a stale read for a permanently degraded one. The
        cache key is unchanged — same business, account, as-of date, candidate
        limit and ad scope — so this is the same entry, not a new one.
      */
      const g2 = await createSecondDecisionGeneration();
      expect(g2).not.toBe(g1);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 61_000));
      // If the previous step replaced the entry, this crosses ITS ttl and
      // starts the revalidation that picks the new generation up. If the entry
      // was evicted, this is simply a miss that loads it directly.
      await workspaceGet();
      vi.useRealTimers();
      await settleCacheRevalidations();

      const restored = await workspaceGet();
      expect(restored.status).toBe(200);
      expect(restored.payload.decisionReadModel.source?.authority).toBe(
        "native_ad",
      );
      /*
        THE GENERATION IDENTITY MOVED, under the SAME cache key. This is the
        assertion the un-failing shortcut could never make: g1's envelope is
        gone and what the operator now reads is the run that actually produced
        it.
      */
      expect(restored.payload.decisionReadModel.source?.generation?.jobRunId)
        .toBe(g2);
      expect(restored.payload.decisionReadModel.source?.generation?.jobRunId)
        .not.toBe(g1);
      /*
        AND THE 80-AD UNIVERSE SURVIVED THE WHOLE SEQUENCE. This is the
        measurement the file exists for: with 80 ACTIVE Ads and a 60-row
        response cap, a universe that had been dropped anywhere along the
        stale/evict/reload path would report the 20 capped-out verdicts as
        un-decided ACTIVE inventory.
      */
      expect(restored.payload.os.ads.pendingInventoryCount).toBe(0);
      expect(restored.payload.os.ads.items.length).toBe(
        META_DECISIONS_AD_CANDIDATE_LIMIT,
      );
    }, 240_000);
  },
);
