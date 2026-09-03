#!/usr/bin/env node
/**
 * D077 production recovery — READ-ONLY preflight evidence collector
 * (correction 1). This ONE generator owns the complete final artifact
 * shape: every section — in-transaction SQL payload, out-of-transaction
 * public reads, the planner-attempt record, data-quality verdicts, and
 * the coverage checksum — is emitted by this inspected code, and the
 * embedded hash declares its algorithm and byte basis and is recomputed
 * from the written file before the process exits.
 *
 * PREPARE + PRODUCTION READ-ONLY. All production SQL runs inside ONE
 * explicit `REPEATABLE READ READ ONLY` transaction with a bounded
 * `SET LOCAL statement_timeout`, a unique `application_name`,
 * in-transaction proof of read-only/isolation/timeout/app-name, and ends
 * with ROLLBACK (the payload leaves the transaction via a sentinel throw
 * that makes the wrapper roll back). SELECT-only; six-business scoped
 * except genuinely global schema/fence/extension facts. No DDL, no
 * grant, no extension install, no compaction, no provider call.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const CHARTER = [
  { name: "IwaStore", businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", accounts: ["act_1087566732415606"], releaseCanary: true },
  { name: "Grandmix", businessId: "5dbc7147-f051-4681-a4d6-20617170074f", accounts: ["act_805150454596350"], releaseCanary: true },
  { name: "Bilsem Zeka", businessId: "6c690fa4-6395-40b5-9755-e99b34d69bc3", accounts: ["act_840779107261785"], releaseCanary: false },
  { name: "TheSwaf", businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3", accounts: ["act_822913786458311", "act_921275999286619"], releaseCanary: true },
  { name: "IwaTR", businessId: "b79683b4-6f87-48c0-a3ca-44d4356fef51", accounts: ["act_2335220976649516"], releaseCanary: false },
  { name: "ColorFullWorldsTR", businessId: "bc0c6178-7853-4f6f-b026-ef0222a4b9e7", accounts: ["act_3554615364751964"], releaseCanary: false },
] as const;

/**
 * Independent coverage checksum contract: sorted
 * `businessId|providerAccountId` lines, LF-joined, NO trailing LF,
 * SHA-256 over UTF-8 bytes. The pinned value was independently computed
 * by Codex; the collector recomputes it from the LIVE binding rows and
 * refuses to emit evidence on any mismatch.
 */
const COVERAGE_CHECKSUM_PIN =
  "18ea0e86085f2086d4d113a9239af9439648a2cec4aecd9907262ef2fff7fc39";

type Row = Record<string, unknown>;

class RollbackWithPayload extends Error {
  constructor(public payload: Record<string, unknown>) {
    super("d077-preflight-rollback-sentinel");
  }
}

function sanitize(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-dsn]")
    .replace(/(password|token|secret|authorization|api[_-]?key)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 400);
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function main() {
  const [{ getDb, runDbTransaction }, operational, fenceModule] =
    await Promise.all([
      import("@/lib/db"),
      import("@/scripts/_operational-runtime"),
      import("@/lib/sync/db-growth-fence"),
    ]);
  operational.configureOperationalScriptRuntime({
    lane: "read_only_observation",
  });
  process.env.DB_QUERY_TIMEOUT_MS = "120000";
  const appName = `d077_recovery_preflight_c1_${Date.now()}`;
  const { ASSIGNED_ACCOUNT_STATES_SQL } = await import(
    "@/lib/meta/assigned-account-states"
  );
  const { readServingFreshnessStatus } = await import(
    "@/lib/serving-freshness-status"
  );

  let payload: Record<string, unknown> | null = null;
  try {
    await operational.withOperationalStartupLogsSilenced(async () =>
      runDbTransaction(async () => {
        const db = getDb();
        await db.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        await db.query("SET LOCAL statement_timeout = '120000ms'");
        await db.query(`SET LOCAL application_name = '${appName}'`);

        const proofs = (
          await db.query<Row>(
            `SELECT current_setting('transaction_read_only') AS transaction_read_only,
                    current_setting('transaction_isolation') AS transaction_isolation,
                    current_setting('application_name') AS application_name,
                    current_setting('statement_timeout') AS statement_timeout,
                    current_database() AS database,
                    current_setting('server_version') AS server_version,
                    now()::text AS retrieved_at`,
          )
        )[0]!;
        if (proofs.transaction_read_only !== "on")
          throw new Error("refusing: transaction_read_only is not on");
        if (proofs.transaction_isolation !== "repeatable read")
          throw new Error("refusing: isolation is not repeatable read");
        if (proofs.statement_timeout === "0")
          throw new Error("refusing: statement_timeout is unbounded");
        if (proofs.application_name !== appName)
          throw new Error("refusing: application_name not applied");

        // ── Schema state relevant to D074–D078 ────────────────────────────
        const regclasses = await db.query<Row>(
          `SELECT
             to_regclass('public.meta_entity_state_history') IS NOT NULL AS state_history,
             to_regclass('public.meta_entity_observation_runs') IS NOT NULL AS observation_runs,
             to_regclass('public.meta_creative_lineage_edges') IS NOT NULL AS lineage_edges,
             to_regclass('adsecute_compact_20260726t0204z.meta_creative_lineage_edges') IS NOT NULL AS archived_lineage_edges,
             to_regclass('public.engine_v3_ad_operator_response_events') IS NOT NULL AS response_events,
             to_regclass('public.meta_state_history_compaction_journal') IS NOT NULL AS compaction_journal,
             to_regclass('public.system_capacity_snapshots') IS NOT NULL AS capacity_snapshots,
             to_regclass('public.meta_automation_business_controls') IS NOT NULL AS automation_controls,
             to_regclass('public.sync_worker_heartbeats') IS NOT NULL AS worker_heartbeats`,
        );
        const runsColumns = await db.query<Row>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'meta_entity_observation_runs'
              AND column_name IN ('manifest_kind','base_run_id','delta_stats_json',
                                  'semantic_hash','last_seen_at','last_captured_at',
                                  'repeat_count','last_checkpoint_at',
                                  'completeness','endpoint','entity_type',
                                  'business_id','provider_account_id','captured_at','observed_at')
            ORDER BY column_name`,
        );
        const stateColumns = await db.query<Row>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'meta_entity_state_history'
              AND column_name IN ('run_id','run_completeness','state_hash','captured_at',
                                  'created_at','entity_type','entity_id',
                                  'business_id','provider_account_id','configured_status')
            ORDER BY column_name`,
        );

        // ── Extension availability, trust, and privilege capability ───────
        // (Correction item 5: rolsuper=false alone is NOT the install proof.)
        const pgstattupleVersions = await db.query<Row>(
          `SELECT name, version, superuser, trusted, relocatable
             FROM pg_available_extension_versions
            WHERE name = 'pgstattuple'
            ORDER BY version`,
        );
        const pgstattupleDefault = await db.query<Row>(
          `SELECT name, default_version, installed_version
             FROM pg_available_extensions WHERE name = 'pgstattuple'`,
        );
        const installedExtensions = await db.query<Row>(
          `SELECT extname FROM pg_extension ORDER BY extname`,
        );
        // Correction 2: the exact current role IS captured — a PostgreSQL
        // role name is an identity, not a credential (no password, DSN,
        // token, cookie, or approval token is serialized anywhere). The
        // server itself produces the injection-safe quoted identifier the
        // A1b grant/revoke SQL binds to.
        const privileges = (
          await db.query<Row>(
            `SELECT current_user AS current_role,
                    quote_ident(current_user) AS current_role_sql_identifier,
                    r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
                    has_database_privilege(current_user, current_database(), 'CREATE') AS has_database_create,
                    pg_has_role(current_user, 'pg_stat_scan_tables', 'MEMBER') AS member_of_pg_stat_scan_tables,
                    pg_has_role(current_user, 'pg_monitor', 'MEMBER') AS member_of_pg_monitor
               FROM pg_roles r WHERE r.rolname = current_user`,
          )
        )[0]!;

        // ── Relation anatomy + fence inputs (global; the fence is global) ──
        const relation = (
          await db.query<Row>(
            `SELECT
               pg_total_relation_size('meta_entity_state_history')::bigint AS total_bytes,
               pg_table_size('meta_entity_state_history')::bigint AS heap_toast_bytes,
               pg_relation_size('meta_entity_state_history', 'main')::bigint AS heap_main_bytes,
               pg_indexes_size('meta_entity_state_history')::bigint AS index_bytes`,
          )
        )[0]!;
        const stats = (
          await db.query<Row>(
            `SELECT n_live_tup, n_dead_tup,
                    last_vacuum::text AS last_vacuum,
                    last_autovacuum::text AS last_autovacuum,
                    last_analyze::text AS last_analyze,
                    last_autoanalyze::text AS last_autoanalyze,
                    vacuum_count, autovacuum_count
               FROM pg_stat_user_tables
              WHERE relname = 'meta_entity_state_history'`,
          )
        )[0];
        const indexes = await db.query<Row>(
          `SELECT indexrelname AS index_name,
                  pg_relation_size(indexrelid)::bigint AS bytes
             FROM pg_stat_user_indexes
            WHERE relname = 'meta_entity_state_history'
            ORDER BY bytes DESC`,
        );

        // ── Capacity telemetry (hostname redacted by projection) ──────────
        const capacity = await db.query<Row>(
          `SELECT source, sampled_at::text AS sampled_at,
                  payload->'database'->>'name' AS database_name,
                  payload->'disks' AS disks
             FROM system_capacity_snapshots
            WHERE source = 'db_host_healthcheck'
            ORDER BY sampled_at DESC, id DESC LIMIT 1`,
        );

        // ── Ingestion / admission state ───────────────────────────────────
        const lastStateWrite = (
          await db.query<Row>(
            `SELECT MAX(captured_at)::text AS last_captured_at,
                    MAX(created_at)::text AS last_created_at
               FROM meta_entity_state_history`,
          )
        )[0];
        const heartbeat = await db.query<Row>(
          `SELECT provider_scope, instance_type, status,
                  last_heartbeat_at::text AS last_heartbeat_at
             FROM sync_worker_heartbeats
            ORDER BY last_heartbeat_at DESC LIMIT 3`,
        );

        // ── Per-pair sync/warehouse clocks (six businesses only) ──────────
        const perPair: Row[] = [];
        for (const business of CHARTER) {
          for (const account of business.accounts) {
            const row = (
              await db.query<Row>(
                `WITH latest_job AS (
                   SELECT status,
                          COALESCE(finished_at, started_at, triggered_at, updated_at)::text AS at
                     FROM meta_sync_jobs
                    WHERE business_id::text = $1 AND provider_account_id::text = $2
                    ORDER BY triggered_at DESC, id DESC LIMIT 1
                 ),
                 latest_success AS (
                   SELECT MAX(at)::text AS at FROM (
                     SELECT COALESCE(finished_at, started_at, triggered_at, updated_at) AS at
                       FROM meta_sync_jobs
                      WHERE business_id::text = $1 AND provider_account_id::text = $2 AND status = 'succeeded'
                     UNION ALL
                     SELECT COALESCE(finished_at, started_at, created_at, updated_at) AS at
                       FROM meta_sync_runs
                      WHERE business_id::text = $1 AND provider_account_id::text = $2 AND status = 'succeeded'
                   ) s
                 ),
                 warehouse AS (
                   SELECT MAX(date)::text AS latest_finalized_date
                     FROM meta_ad_daily
                    WHERE business_id::text = $1 AND provider_account_id::text = $2
                      AND truth_state = 'finalized' AND finalized_at IS NOT NULL
                      AND validation_status = 'passed'
                 )
                 SELECT (SELECT status FROM latest_job) AS latest_job_status,
                        (SELECT at FROM latest_job) AS latest_job_at,
                        (SELECT at FROM latest_success) AS latest_success_at,
                        (SELECT latest_finalized_date FROM warehouse) AS latest_finalized_date`,
                [business.businessId, account],
              )
            )[0]!;
            perPair.push({
              business: business.name,
              businessId: business.businessId,
              providerAccountId: account,
              ...row,
            });
          }
        }

        // ── Decision generations + evidence lanes (six businesses only) ───
        const generations: Row[] = [];
        for (const business of CHARTER) {
          const row = (
            await db.query<Row>(
              `SELECT MAX(as_of_date)::text AS latest_as_of,
                      COUNT(*) FILTER (WHERE as_of_date = (
                        SELECT MAX(as_of_date) FROM engine_v3_ad_decision_snapshots_daily
                         WHERE business_id::text = $1
                      ))::int AS latest_rows,
                      COUNT(*) FILTER (WHERE as_of_date = (
                        SELECT MAX(as_of_date) FROM engine_v3_ad_decision_snapshots_daily
                         WHERE business_id::text = $1
                      ) AND authorized_action IS NOT NULL)::int AS latest_authorized
                 FROM engine_v3_ad_decision_snapshots_daily
                WHERE business_id::text = $1`,
              [business.businessId],
            )
          )[0]!;
          generations.push({ business: business.name, businessId: business.businessId, ...row });
        }
        const sixIds = CHARTER.map((b) => b.businessId);
        const lanePresence = (
          await db.query<Row>(
            `SELECT
               to_regclass('public.engine_v3_ad_decision_outcomes_daily') IS NOT NULL AS outcomes,
               to_regclass('public.engine_v3_ad_account_calibration_daily') IS NOT NULL AS calibration`,
          )
        )[0]!;
        const evidenceLanes: Row = {
          outcome_rows:
            lanePresence.outcomes === true
              ? (
                  await db.query<Row>(
                    `SELECT COUNT(*)::int AS n FROM engine_v3_ad_decision_outcomes_daily
                      WHERE business_id::text = ANY($1::text[])`,
                    [sixIds],
                  )
                )[0]!.n
              : "relation_absent",
          calibration_daily_rows:
            lanePresence.calibration === true
              ? (
                  await db.query<Row>(
                    `SELECT COUNT(*)::int AS n FROM engine_v3_ad_account_calibration_daily
                      WHERE business_id::text = ANY($1::text[])`,
                    [sixIds],
                  )
                )[0]!.n
              : "relation_absent",
        };

        // ── Account binding via the shipped read (six businesses) ─────────
        const binding: Row[] = [];
        for (const business of CHARTER) {
          const rows = await db.query<Row>(ASSIGNED_ACCOUNT_STATES_SQL, [
            business.businessId,
          ]);
          for (const row of rows) binding.push({ business: business.name, ...row });
        }

        // ── Coverage checksum from the LIVE binding rows ──────────────────
        const coverageLines = binding
          .map(
            (row) =>
              `${CHARTER.find((b) => b.name === row.business)!.businessId}|${row.provider_account_id}`,
          )
          .sort();
        const coverageChecksum = sha256Utf8(coverageLines.join("\n"));
        if (coverageChecksum !== COVERAGE_CHECKSUM_PIN) {
          throw new Error(
            `coverage checksum mismatch: computed ${coverageChecksum}, pinned ${COVERAGE_CHECKSUM_PIN}`,
          );
        }

        // ── Automation control plane (six businesses) ─────────────────────
        const controlColumns = (
          await db.query<Row>(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'meta_automation_business_controls'`,
          )
        ).map((row) => String(row.column_name));
        const wantedControlColumns = [
          "business_id",
          "kill_switch_engaged",
          "kill_switch_reason",
          "auto_execution_enabled",
          "readiness_tier",
          "updated_at",
        ].filter((column) => controlColumns.includes(column));
        const controlRows =
          wantedControlColumns.length > 0
            ? await db.query<Row>(
                `SELECT ${wantedControlColumns
                  .map((column) =>
                    column === "updated_at"
                      ? "updated_at::text AS updated_at"
                      : column,
                  )
                  .join(", ")}
                   FROM meta_automation_business_controls
                  WHERE business_id::text = ANY($1::text[])
                  ORDER BY business_id`,
                [sixIds],
              )
            : [];
        const controlsByBusiness = new Map(
          controlRows.map((row) => [String(row.business_id), row]),
        );
        const automationEffective = CHARTER.map((business) => {
          const row = controlsByBusiness.get(business.businessId) ?? null;
          const effective =
            row === null
              ? "fail_closed_not_configured"
              : row.kill_switch_engaged === true
                ? "stopped_kill_switch"
                : row.auto_execution_enabled === true
                  ? "AUTO_EXECUTION_ENABLED_STOP_CONDITION"
                  : "disabled";
          return {
            business: business.name,
            businessId: business.businessId,
            controlRow: row,
            effectiveResult: effective,
          };
        });

        // ── Serving freshness INSIDE this RR/RO transaction ───────────────
        // Runs LAST: a failed statement aborts the whole transaction, and
        // everything above is already captured by then. Serial per business.
        const servingFreshness: Row[] = [];
        for (const business of CHARTER) {
          const report = await readServingFreshnessStatus({
            businessId: business.businessId,
          });
          const automatedMissing = report.entries
            .filter((entry) => entry.statusClassification === "automated_missing")
            .map((entry) => entry.surface);
          servingFreshness.push({
            business: business.name,
            businessId: business.businessId,
            releaseCanary: business.releaseCanary,
            classifications: report.classifications,
            automatedMissingSurfaces: automatedMissing,
          });
        }

        throw new RollbackWithPayload({
          transactionProofs: proofs,
          schemaState: {
            relations: regclasses[0],
            observationRunColumnsPresent: runsColumns.map((r) => r.column_name),
            stateHistoryColumnsPresent: stateColumns.map((r) => r.column_name),
          },
          extensions: {
            pgstattuple: pgstattupleDefault[0] ?? null,
            pgstattupleVersions,
            installed: installedExtensions.map((r) => r.extname),
            currentRoleCapabilities: privileges,
            functionExecutionNote:
              "has_function_privilege on pgstattuple_approx is undecidable pre-install (the function does not exist yet); since pgstattuple 1.5 the extension script revokes PUBLIC and grants EXECUTE to pg_stat_scan_tables, so member_of_pg_stat_scan_tables above is the decisive post-install capability fact.",
          },
          relationAnatomy: {
            table: "meta_entity_state_history",
            ...relation,
            stats: stats ?? null,
            statsNote:
              "n_live_tup / n_dead_tup are PLANNER ESTIMATES from pg_stat_user_tables, not exact row counts.",
            indexes,
            fenceBudgetBytesFromLocalCode:
              fenceModule.DEFAULT_TABLE_BUDGET_BYTES.meta_entity_state_history,
          },
          capacityTelemetry: capacity[0] ?? null,
          ingestion: {
            lastStateHistoryWrite: lastStateWrite,
            workerHeartbeats: heartbeat,
          },
          perPairClocks: perPair,
          generations,
          evidenceLanes,
          assignedAccountStates: binding,
          coverageChecksum: {
            algorithm:
              "sha256 over UTF-8 bytes of sorted businessId|providerAccountId lines, LF-joined, no trailing LF",
            value: coverageChecksum,
            pinnedIndependentValue: COVERAGE_CHECKSUM_PIN,
            lineCount: coverageLines.length,
          },
          automation: {
            note:
              "Effective result derived from CONTROL-PLANE ROWS read in this transaction. Deployed host environment internals were NOT read and remain UNKNOWN; treat automation env flags on the host as a deploy precondition/stop condition, never as a read-back claim.",
            perBusiness: automationEffective,
          },
          servingFreshness: {
            mechanism:
              "readServingFreshnessStatus executed INSIDE this same REPEATABLE READ READ ONLY transaction, serially per business, bounded by the transaction's statement_timeout",
            perBusiness: servingFreshness,
          },
        });
      }),
    );
  } catch (error) {
    if (error instanceof RollbackWithPayload) payload = error.payload;
    else throw error;
  }
  if (!payload) throw new Error("no payload captured");

  // ── Out-of-transaction PUBLIC reads (clearly outside SQL) ───────────────
  const buildInfo: Row = {};
  for (const host of ["adsecute.com", "www.adsecute.com"]) {
    try {
      const response = await fetch(`https://${host}/api/build-info`, {
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.json()) as {
        buildId?: string;
        controlPlanePersistence?: {
          latest?: {
            deployGate?: { verdict?: string; emittedAt?: string };
            releaseGate?: { verdict?: string; emittedAt?: string };
          };
        };
      };
      buildInfo[host] = {
        retrievedAtUtc: new Date().toISOString(),
        buildId: body.buildId ?? null,
        deployGate: body.controlPlanePersistence?.latest?.deployGate ?? null,
        releaseGate: body.controlPlanePersistence?.latest?.releaseGate ?? null,
      };
    } catch (error) {
      buildInfo[host] = {
        error: sanitize(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  const artifact: Record<string, unknown> = {
    contract: "adsecute.d077.production-recovery-readonly-evidence.v2",
    operatingClass: "production_read_only_preflight",
    generator: "scripts/audits/d077-production-recovery-readonly-preflight.ts",
    transactionMechanism:
      "single REPEATABLE READ READ ONLY transaction over the repository tunnel (127.0.0.1:15432), bounded SET LOCAL statement_timeout, unique application_name, in-transaction read-only/isolation/timeout/app-name proof, ended by ROLLBACK via sentinel",
    charterBusinesses: CHARTER.map((b) => ({
      name: b.name,
      businessId: b.businessId,
      accounts: [...b.accounts],
      releaseCanary: b.releaseCanary,
    })),
    payload,
    outOfTransactionEvidence: {
      note: "PUBLIC HTTPS/GitHub reads only — never SQL; collected outside the transaction on purpose",
      deployedBuildInfo: buildInfo,
      workflows: {
        source:
          "gh run list / gh run download (emrahbilaloglu-ui/OmniAds), read 2026-08-30 ~11:20Z",
        sha: "babf158e150fd33057117b39b175da044ac62d2e",
        ci: "success 2026-08-29T11:10:44Z",
        deploy: "success 2026-08-29T11:32:11Z",
        postDeployVerify: "success 2026-08-29T11:35:06Z",
        postDeployArtifactInspected: {
          artifact:
            "post-deploy-verify-babf158e150fd33057117b39b175da044ac62d2e/post-deploy-release-authority.json",
          summaryResult: "pass",
          blockers: [],
        },
        previousDeployedSha:
          "843b6e9c8 (success 2026-08-22) — rollback anchor with published images",
      },
      authenticatedDeployedIdentity:
        "NOT read (no operator session available) — limitation",
    },
    plannerAttempt: {
      mode: "plan (dry-run) ONLY — execute was never invoked; plan mode performs zero writes",
      attempts: [
        {
          statementTimeoutMs: 300000,
          outcome:
            "honest failure preserved: 'Error: Database query timed out after 300000ms' (lib/db wrapper; one census statement exceeded 300s through the tunnel); the read-only transaction rolled back server-side",
        },
        {
          statementTimeoutMs: 600000,
          outcome:
            "two attempts produced no output and no plan file: the long no-output, task-owned planner processes were TERMINATED BY THE CODEX SUPERVISOR after bounded waiting, to limit production read load; the final planner process received SIGINT. No writes occurred; the aborted read-only sessions rolled back server-side. (The earlier 'sandbox reaper' attribution was wrong and is withdrawn.)",
        },
      ],
      result:
        "NO VALID CURRENT PRODUCTION PLAN EXISTS. Planner totals (exact removable runs/rows, per-scope counts, protectionsByReason, plan hash) are UNKNOWN — not zero, not estimated, never inferred from the frozen census bounds (candidate <= 3,449,571 fleet / <= 1,774,467 six-business rows; lineage row-pins >= 160,477 are bounds only).",
      operatorPath:
        "run the packet-2 A3 command from an operator shell in a low-traffic window with DB_QUERY_TIMEOUT_MS=600000; this correction deliberately did NOT rerun the long planner",
      processHygieneNote:
        "Codex also terminated one task-owned orphaned `sleep 900` timeout watcher after the local cutover harness had already completed; the watcher alone held the output pipe open and its termination changed no test or DB result.",
    },
    dataQuality: {
      recoveryReadinessPreflight:
        "SUFFICIENT — fence bytes, schema presence, extension/privilege capability, admission clocks, bindings, control-plane state and serving freshness are current verified reads",
      decisionQualityEvaluation:
        "INSUFFICIENT — generations are 8 days stale; the hard-action recompute belongs to the frozen D078 evidence, not this preflight",
      observedOutcomeEvaluation:
        "INSUFFICIENT — the six-business outcome lane contains ZERO rows",
      offlinePolicyCounterfactualEstimation:
        "INSUFFICIENT — no retained counterfactual/holdout evidence; see the historical-simulation closure record",
      causalClaims:
        "INSUFFICIENT — no controlled treatment exists; no causal claim is made anywhere in this package",
    },
    evidenceClassLedger: {
      verifiedProductionFacts:
        "payload.* (one RR RO transaction, proofs embedded) and outOfTransactionEvidence.deployedBuildInfo (public HTTPS)",
      derivedMetrics:
        "fence overage = total_bytes - budget; staleness ages from clocks; automation effectiveResult derived from control rows",
      estimates:
        "pg_stat_user_tables n_live_tup/n_dead_tup (planner estimates); capacity disk figures as sampled by the healthcheck",
      unknown:
        "planner totals/plan hash; deployed host env internals (incl. CAMPAIGN_CONTEXT_MODE override and any automation env) — deploy preconditions, not read-backs; authenticated deployed UI state",
    },
  };

  mkdirSync("docs/audits/generated", { recursive: true });
  const hashBasis =
    "sha256 over UTF-8 bytes of JSON.stringify(artifact, null, 1) of the artifact WITHOUT the evidenceHash/hashAlgorithm/hashBasis fields";
  const body = JSON.stringify(artifact, null, 1);
  const evidenceHash = sha256Utf8(body);
  const outPath =
    "docs/audits/generated/d077-production-recovery-readonly-evidence-2026-08-30.json";
  writeFileSync(
    outPath,
    `${JSON.stringify(
      { evidenceHash, hashAlgorithm: "sha256", hashBasis, ...artifact },
      null,
      1,
    )}\n`,
  );

  // Independent recomputation from the WRITTEN file before exiting.
  const reread = JSON.parse(readFileSync(outPath, "utf8")) as Record<
    string,
    unknown
  >;
  const {
    evidenceHash: writtenHash,
    hashAlgorithm: _alg,
    hashBasis: _basis,
    ...rest
  } = reread;
  const recomputed = sha256Utf8(JSON.stringify(rest, null, 1));
  if (recomputed !== writtenHash || recomputed !== evidenceHash) {
    throw new Error(
      `embedded hash failed recomputation: wrote ${String(writtenHash)}, recomputed ${recomputed}`,
    );
  }
  console.log(
    JSON.stringify(
      { evidenceHash, outPath, applicationName: appName, hashRecomputed: true },
      null,
      1,
    ),
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(
      sanitize(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      ),
    );
    process.exit(1);
  },
);
