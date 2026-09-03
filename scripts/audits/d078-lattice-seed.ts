/**
 * D078 ephemeral fixture seed (shared, correction 2).
 *
 * Seeds the sanitized six-business/seven-account fixture — including the
 * constitutionally valid TheSwaf-Main native lattice (calibration
 * batch/row → context → evaluations → snapshots bound by the authority
 * CHECK → job-run hydration receipts) — into an already-migrated ephemeral
 * cluster. Shared by the local-UI harness and the DB-backed actual-route
 * CTA proof so both speak about the same rows. Secrets: the session token
 * is generated per call and returned in memory only; the DB stores its
 * sha256.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import type { Client } from "pg";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";

export const D078_QA_ENGINE_VERSION =
  "v3-ad-2026-07-18-decision-presentation-hardening-shadow";
export const D078_QA_THESWAF_BUSINESS_ID =
  "172d0ab8-495b-4679-a4c6-ffa404c389d3";
export const D078_QA_THESWAF_MAIN = "act_822913786458311";
export const D078_QA_FRESH_AD_ID = "120299000000000001";
export const D078_QA_KEEP_AD_ID = "120299000000000002";

const BUNDLE_PATH =
  "docs/audits/generated/d078-six-business-evidence-bundle-2026-08-30.json";
const ENGINE_VERSION = D078_QA_ENGINE_VERSION;

type Row = Record<string, unknown>;

function sha(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function log(message: string) {
  console.log(`[d078-seed] ${message}`);
}

export interface SeedResult {
  sessionToken: string;
  businesses: Array<{ id: string; name: string }>;
  staleAdId: string;
  freshAdId: string;
  keepAdId: string;
}

export async function seedD078Fixture(client: Client): Promise<SeedResult> {
  // One transaction: composite FKs in the calibration lattice include the
  // transaction-stable as_of_cutoff (now()), so every lattice statement must
  // share one now().
  await client.query("BEGIN");
  const bundle = JSON.parse(fs.readFileSync(BUNDLE_PATH, "utf8")) as {
    scopeContract: { charterBusinessIds: string[]; charterAccountIds: string[] };
    businesses: Array<{ name: string; businessId: string }>;
    payload: {
      identity: {
        accounts: Row[];
        accountIdentity: Row[];
        accountSpend14: Row[];
      };
      economics: { targetPacks: Row[]; costModels: Row[] };
      governance: { automationControls: Row[] };
      nativeDecisions: { hardActions: Row[] };
    };
  };

  const sessionToken = randomBytes(32).toString("hex");
  const tokenHash = sha(sessionToken);

  const userId = (
    await client.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('D078 QA', 'qa-d078@ephemeral.invalid', 'x') RETURNING id`,
    )
  ).rows[0].id as string;

  const identityByAccount = new Map(
    bundle.payload.identity.accountIdentity.map((row) => [
      String(row.provider_account_id),
      row,
    ]),
  );
  const spendByAccount = new Map(
    bundle.payload.identity.accountSpend14.map((row) => [
      String(row.provider_account_id),
      row,
    ]),
  );

  for (const business of bundle.businesses) {
    await client.query(
      `INSERT INTO businesses (id, name, owner_id, currency, platform)
       VALUES ($1, $2, $3, 'USD', 'shopify')`,
      [business.businessId, business.name, userId],
    );
    await client.query(
      `INSERT INTO memberships (user_id, business_id, role, status)
       VALUES ($1, $2, 'admin', 'active')`,
      [userId, business.businessId],
    );
    await client.query(
      `INSERT INTO business_engine_v3_flags (business_id, surface_visible, shadow_only)
       VALUES ($1::uuid, true, false)`,
      [business.businessId],
    );
  }
  const theswaf = bundle.businesses.find((b) => b.name === "TheSwaf")!;
  await client.query(
    `INSERT INTO sessions (user_id, token_hash, active_business_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 day')`,
    [userId, tokenHash, theswaf.businessId],
  );

  const accountRefByExternalId = new Map<string, string>();
  for (const assignment of bundle.payload.identity.accounts) {
    const externalId = String(assignment.provider_account_id);
    const identity = identityByAccount.get(externalId);
    const refId = (
      await client.query(
        `INSERT INTO provider_accounts
           (provider, external_account_id, account_name, currency, timezone)
         VALUES ('meta', $1, $2, $3, $4) RETURNING id`,
        [
          externalId,
          identity?.account_name ?? null,
          identity?.account_currency ?? null,
          identity?.account_timezone ?? null,
        ],
      )
    ).rows[0].id as string;
    accountRefByExternalId.set(externalId, refId);
    await client.query(
      `INSERT INTO business_provider_accounts
         (business_id, provider, provider_account_id, is_selected,
          business_ref_id, provider_account_ref_id)
       VALUES ($1::text, 'meta', $2, $3, $4::uuid, $5::uuid)`,
      [
        String(assignment.business_id),
        externalId,
        assignment.is_selected === true,
        String(assignment.business_id),
        refId,
      ],
    );
    const spend = spendByAccount.get(externalId);
    const latestDate = String(
      identity?.latest_fact_date ?? spend?.window_end ?? "2026-08-21",
    );
    const total = Number(spend?.spend_14d ?? 0);
    const revenue = Number(spend?.revenue_14d ?? 0);
    for (let offset = 0; offset < 3; offset += 1) {
      await client.query(
        `INSERT INTO meta_account_daily
           (business_id, provider_account_id, date, account_name,
            account_timezone, account_currency, spend, revenue, conversions,
            business_ref_id)
         VALUES ($1::text, $2, $3::date - $4::int, $5, $6, $7, $8, $9, 1,
                 $10::uuid)`,
        [
          String(assignment.business_id),
          externalId,
          latestDate,
          offset,
          identity?.account_name ?? null,
          identity?.account_timezone ?? "UTC",
          identity?.account_currency ?? "USD",
          total / 3,
          revenue / 3,
          String(assignment.business_id),
        ],
      );
    }
  }

  for (const pack of bundle.payload.economics.targetPacks) {
    await client.query(
      `INSERT INTO business_target_packs
         (business_id, target_roas, break_even_roas, source_label, business_ref_id)
       VALUES ($1::uuid, $2, $3, 'settings_manual_entry', $1::uuid)`,
      [String(pack.business_id), pack.target_roas, pack.break_even_roas],
    );
  }
  for (const model of bundle.payload.economics.costModels) {
    await client.query(
      `INSERT INTO business_cost_models
         (business_id, cogs_percent, shipping_percent, fee_percent,
          fixed_monthly_cost, business_ref_id)
       VALUES ($1::uuid, $2, $3, $4, 0, $1::uuid)`,
      [
        String(model.business_id),
        model.cogs_percent,
        model.shipping_percent,
        model.fee_percent,
      ],
    );
  }

  // Governance: IwaStore's real kill-switched row (from the bundle); an OPEN
  // dry-run manual-review row for TheSwaf (so a fresh row can reach the
  // supervised live-preflight state); the other four businesses deliberately
  // have NO row — the fail-closed missing-governance probe.
  for (const control of bundle.payload.governance.automationControls) {
    await client.query(
      `INSERT INTO meta_automation_business_controls
         (business_id, kill_switch_engaged, kill_switch_reason,
          auto_execution_enabled, readiness_tier, guardrails_json)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)`,
      [
        String(control.business_id),
        control.kill_switch_engaged === true,
        control.kill_switch_reason ?? null,
        control.auto_execution_enabled === true,
        String(control.readiness_tier ?? "manual_review"),
        JSON.stringify(control.guardrails_json ?? {}),
      ],
    );
  }
  await client.query(
    `INSERT INTO meta_automation_business_controls
       (business_id, kill_switch_engaged, auto_execution_enabled,
        readiness_tier, guardrails_json)
     VALUES ($1::uuid, false, false, 'manual_review',
             '{"dryRunOnly": true, "requireLivePreflight": true}'::jsonb)`,
    [theswaf.businessId],
  );

  // ------------------------------------------------------------------
  // TheSwaf-Main native lattice (three ads; one generation).
  // ------------------------------------------------------------------
  const THESWAF_MAIN = "act_822913786458311";
  const mainRef = accountRefByExternalId.get(THESWAF_MAIN)!;
  const bundleCut = bundle.payload.nativeDecisions.hardActions.find(
    (row) => row.provider_account_id === THESWAF_MAIN,
  )!;
  const staleAdId = String(bundleCut.ad_id);
  const freshAdId = D078_QA_FRESH_AD_ID;
  const keepAdId = D078_QA_KEEP_AD_ID;
  const asOf = new Date().toISOString().slice(0, 10);
  const staleComputedAt = String(bundleCut.computed_at);

  for (const [adId, spend, revenue, purchases] of [
    [
      staleAdId,
      Number(bundleCut.spend),
      Number(bundleCut.roas) * Number(bundleCut.spend),
      Number(bundleCut.purchases),
    ],
    [freshAdId, 900, 810, 6],
    [keepAdId, 197.42, 895.42, 5],
  ] as const) {
    for (let offset = 0; offset < 3; offset += 1) {
      // Finalized+validated ad-days through the account-timezone expected
      // cutoff (yesterday): the decision pipeline health gate requires the
      // warehouse cutoff to be current before live_preflight_required.
      await client.query(
        `INSERT INTO meta_ad_daily
           (business_id, provider_account_id, date, campaign_id, adset_id,
            ad_id, ad_name_current, ad_status, account_timezone,
            account_currency, spend, impressions, clicks, conversions,
            revenue, truth_state, finalized_at, validation_status,
            business_ref_id)
         VALUES ($1::text, $2, (now() AT TIME ZONE 'America/Chicago')::date - $3::int, 'c-seed',
                 'as-seed', $4, $5, 'ACTIVE', 'America/Chicago', 'USD',
                 $6, 1000, 30, $7, $8, 'finalized', now(), 'passed',
                 $9::uuid)`,
        [
          theswaf.businessId,
          THESWAF_MAIN,
          offset,
          String(adId),
          `SEED_${String(adId).slice(-6)}`,
          Number(spend) / 3,
          Number(purchases) / 3,
          Number(revenue) / 3,
          theswaf.businessId,
        ],
      );
    }
  }

  // Account-bound automatic campaign-context row: the D074 fail-closed
  // read serves roles only from account-scoped system-inferred rows; the
  // compiled resolver version is stamped so a test that SIMULATES the
  // operator validation act (vi.stubEnv, repo-established practice) can
  // reach trusted-for-action. Nothing here sets any real environment flag.
  await client.query(
    `INSERT INTO engine_v3_campaign_context_daily
       (business_id, provider_account_id, campaign_id, campaign_name,
        as_of_date, inferred_kind, confidence_score, confidence_class,
        kind_source, kind_basis, resolver_version, signal_scores_json,
        evidence_json, conflict_reasons_json)
     VALUES ($1::text, $2, 'c-seed', 'Seed campaign', $3::date, 'main', 0.92,
             'high', 'system_inferred', 'd078_qa_fixture', $4,
             '{}'::jsonb, '["d078 fixture evidence"]'::jsonb, '[]'::jsonb)`,
    [theswaf.businessId, THESWAF_MAIN, asOf, CAMPAIGN_CONTEXT_RESOLVER_VERSION],
  );

  // Hierarchy identity/status rows: the serving read joins the dimension
  // tables and delivery-scope eligibility requires an ACTIVE chain.
  await client.query(
    `INSERT INTO meta_campaign_dimensions
       (business_id, provider_account_id, campaign_id, campaign_name_current,
        campaign_status, business_ref_id)
     VALUES ($1::text, $2, 'c-seed', 'Seed campaign', 'ACTIVE', $1::uuid)`,
    [theswaf.businessId, THESWAF_MAIN],
  );
  await client.query(
    `INSERT INTO meta_adset_dimensions
       (business_id, provider_account_id, campaign_id, adset_id,
        adset_name_current, adset_status, business_ref_id)
     VALUES ($1::text, $2, 'c-seed', 'as-seed', 'Seed ad set', 'ACTIVE',
             $1::uuid)`,
    [theswaf.businessId, THESWAF_MAIN],
  );
  for (const adId of [staleAdId, freshAdId, keepAdId]) {
    await client.query(
      `INSERT INTO meta_ad_dimensions
         (business_id, provider_account_id, campaign_id, adset_id, ad_id,
          ad_name_current, ad_status, business_ref_id)
       VALUES ($1::text, $2, 'c-seed', 'as-seed', $3, $4, 'ACTIVE',
               $1::uuid)`,
      [theswaf.businessId, THESWAF_MAIN, adId, `SEED_${adId.slice(-6)}`],
    );
  }

  // Physical-capacity telemetry snapshot: the growth fence denies admission
  // fail-closed without a fresh db-host healthcheck sample; seed a healthy
  // one so the pipeline gate can measure a REAL admitting fence.
  await client.query(
    `INSERT INTO system_capacity_snapshots (source, hostname, sampled_at, payload)
     VALUES ('db_host_healthcheck', 'd078-qa-host', clock_timestamp(),
             jsonb_build_object(
               'hostname', 'd078-qa-host',
               'database', jsonb_build_object('name', current_database()),
               'disks', jsonb_build_array(jsonb_build_object(
                 'path', '/var/lib/postgresql',
                 'totalBytes', 500000000000,
                 'usedBytes', 100000000000,
                 'availableBytes', 400000000000
               ))
             ))`,
  );

  // Fresh scoped successful sync activity (<60 min) for the pipeline gate.
  await client.query(
    `INSERT INTO meta_sync_runs
       (business_id, provider_account_id, lane, scope, partition_date,
        status, started_at, finished_at, business_ref_id)
     VALUES ($1::text, $2, 'maintenance', 'account_daily',
             (now() AT TIME ZONE 'America/Chicago')::date - 1, 'succeeded',
             now() - interval '10 minutes', now() - interval '9 minutes',
             $1::uuid)`,
    [theswaf.businessId, THESWAF_MAIN],
  );

  const calibrationJobRunId = (
    await client.query(
      `INSERT INTO engine_v3_job_runs
         (job_name, business_ref_id, business_id, as_of_date, engine_version,
          status, started_at, finished_at)
       VALUES ('engine_v3_native_ad_calibration_shadow_job', $1::uuid,
               $1::text, $2::date, $3, 'success', now() - interval '2 hours',
               now() - interval '119 minutes')
       RETURNING id`,
      [theswaf.businessId, asOf, ENGINE_VERSION],
    )
  ).rows[0].id as string;

  // The serving predicate recomputes the identity-manifest hash over the
  // generation's sorted ad ids and requires exact equality with the
  // receipt — so the receipt must carry the REAL hash.
  const manifestHash = hashAdDecisionIdentityManifest({
    businessId: theswaf.businessId,
    providerAccountId: THESWAF_MAIN,
    asOfDate: asOf,
    adIds: [staleAdId, freshAdId, keepAdId].map((v) => v.trim()).sort(),
  });
  const decisionsJobRunId = (
    await client.query(
      `INSERT INTO engine_v3_job_runs
         (job_name, business_ref_id, business_id, as_of_date, engine_version,
          status, started_at, finished_at, row_count, error_json)
       VALUES ('engine_v3_native_ad_decisions_shadow_job', $1::uuid, $1::text,
               $2::date, $3, 'success', now() - interval '90 minutes',
               now() - interval '89 minutes', 3, $4::jsonb)
       RETURNING id`,
      [
        theswaf.businessId,
        asOf,
        ENGINE_VERSION,
        JSON.stringify({
          metadata: {
            hydration_receipts: [
              {
                provider_account_id: THESWAF_MAIN,
                provider_account_ref_id: mainRef,
                expected_ad_count: 3,
                hydrated_ad_count: 3,
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
          completed_at)
       VALUES ($1::uuid, $1::text, 'meta', $2::uuid, $3, $4::date, now(),
               'repeatable read', $5, 'd078-qa', 'current_transaction_snapshot',
               '{"source":"d078-qa-fixture"}'::jsonb, 1,
               $6, $7, $8, $9, 'writing', $10::uuid, now(), NULL)
       RETURNING id`,
      [
        theswaf.businessId,
        mainRef,
        THESWAF_MAIN,
        asOf,
        ENGINE_VERSION,
        sha("d078-gen"),
        sha("d078-input"),
        sha("d078-source"),
        sha("d078-cells"),
        calibrationJobRunId,
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
          source_manifest_hash, job_run_id, computed_at)
       VALUES ($1::uuid, $2::uuid, $2::text, 'meta', $3::uuid, $4,
               'America/Chicago', 'USD', 'account_objective_cohort',
               'OUTCOME_SALES', 'purchase', 'purchase', $5::date, now(), $6,
               'd078-qa', $5::date - 27, $5::date, 28, 3, 84, 3, 3, 0, 3, 40,
               52000, 'ready',
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               'ready', 'fresh', $7, $8, $9, $10,
               $11::uuid, now())
       RETURNING id`,
      [
        batchId,
        theswaf.businessId,
        mainRef,
        THESWAF_MAIN,
        asOf,
        ENGINE_VERSION,
        sha("d078-authority"),
        sha("d078-input"),
        sha("d078-input"),
        sha("d078-source"),
        calibrationJobRunId,
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
               'd078-qa', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               '{}'::jsonb, $6, $7::uuid, now())
       RETURNING id`,
      [
        theswaf.businessId,
        mainRef,
        THESWAF_MAIN,
        asOf,
        ENGINE_VERSION,
        sha("d078-context"),
        decisionsJobRunId,
      ],
    )
  ).rows[0].id as string;

  interface LatticeAd {
    adId: string;
    label: string;
    authorized: boolean;
    computedAt: string | null;
    spend: number;
    purchases: number;
    roas: number;
    reason: string;
  }
  const ads: LatticeAd[] = [
    {
      adId: staleAdId,
      label: "cut",
      authorized: true,
      computedAt: staleComputedAt,
      spend: Number(bundleCut.spend),
      purchases: Number(bundleCut.purchases),
      roas: Number(bundleCut.roas),
      reason: String(bundleCut.reason ?? "economic stop-loss (bundle)"),
    },
    {
      adId: freshAdId,
      label: "cut",
      authorized: true,
      computedAt: null, // now
      spend: 900,
      purchases: 6,
      roas: 0.9,
      reason:
        "[economic stop-loss] ROAS 0.90 (28d) = 45% of commercial target, below explicit break-even (D078 QA fresh probe).",
    },
    {
      adId: keepAdId,
      label: "keep",
      authorized: false,
      computedAt: null,
      spend: 197.42,
      purchases: 5,
      roas: 4.54,
      reason: "[near scale] above target; scale gates hold (D078 QA probe).",
    },
  ];
  for (const ad of ads) {
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
                 $6, $7::date, $8, 'account', $4, 'd078-qa',
                 $9::jsonb, '{}'::jsonb, '{}'::jsonb, $10::jsonb, $11, $12,
                 $13, $14::uuid, COALESCE($15::timestamptz, now()))
         RETURNING id`,
        [
          contextId,
          theswaf.businessId,
          mainRef,
          THESWAF_MAIN,
          ad.adId,
          `cr_${ad.adId.slice(-6)}`,
          asOf,
          ENGINE_VERSION,
          JSON.stringify({
            adId: ad.adId,
            spend: ad.spend,
            purchases: ad.purchases,
            roas: ad.roas,
            purchaseValue: ad.roas * ad.spend,
            targetRoas: 2,
            breakevenRoas: 1.71,
            objective: "OUTCOME_SALES",
            optimizationGoal: "Offsite Conversions",
            customEventType: "PURCHASE",
            effectiveCohort: "purchase",
            effectiveStatus: "ACTIVE",
            accountCurrency: "USD",
            accountTimezone: "America/Chicago",
          }),
          JSON.stringify({
            adId: ad.adId,
            label: ad.label,
            reason: ad.reason,
            confidence: ad.authorized ? 75 : 65,
            metrics: { roas: ad.roas, spend: ad.spend, purchases: ad.purchases },
            effectiveTargetRoas: 2,
            ratioToTarget: ad.roas / 2,
            truthSource: "commercial_truth",
            engineVersion: ENGINE_VERSION,
            // Canonical automatic-role output (the engine emits this when
            // automatic context authority resolves); required for a hard
            // cut to classify as an actionable decision.
            campaignRoleStatus: "resolved",
            campaignKind: "main",
          }),
          ad.label,
          sha(`d078-in-${ad.adId}`),
          sha(`d078-dec-${ad.adId}`),
          decisionsJobRunId,
          ad.computedAt,
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
               $18, $19, COALESCE($20::timestamptz, now()), $21::uuid, $22)`,
      [
        theswaf.businessId,
        mainRef,
        THESWAF_MAIN,
        ad.adId,
        `cr_${ad.adId.slice(-6)}`,
        asOf,
        ENGINE_VERSION,
        ad.label,
        ad.authorized ? 75 : 65,
        ad.roas / 2,
        ad.reason,
        ad.spend,
        ad.purchases,
        ad.roas,
        ad.authorized ? ad.label : null,
        calibrationRowId,
        evaluationId,
        sha(`d078-in-${ad.adId}`),
        sha(`d078-dec-${ad.adId}`),
        ad.computedAt,
        decisionsJobRunId,
        `d078-${ad.adId}`,
      ],
    );
  }

  await client.query("COMMIT");
  log(
    `seeded ${bundle.businesses.length} businesses / ${bundle.payload.identity.accounts.length} accounts; TheSwaf lattice: stale cut ${staleAdId}, fresh cut ${freshAdId}, keep ${keepAdId}`,
  );
  return {
    sessionToken,
    businesses: bundle.businesses.map((b) => ({ id: b.businessId, name: b.name })),
    staleAdId,
    freshAdId,
    keepAdId,
  };
}
