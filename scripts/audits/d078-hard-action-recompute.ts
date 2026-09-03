#!/usr/bin/env node
// D078 Phase B — decision-quality recompute over the frozen evidence bundle.
//
// SELECT-only. For every current persisted-authorized hard action and every
// stratified-sample row frozen in the D078 evidence bundle, this fetches the
// linked evaluation + context rows and:
//   1. recomputes the stored arithmetic (ratio-to-target, ROAS, CPA, snapshot
//      vs evaluation-input agreement);
//   2. re-derives the cutoff-window aggregates from the warehouse
//      (meta_ad_daily) for the 28d and 7d windows and compares within
//      tolerance;
//   3. records the eligibility tuple (blockers, authority blocker, blocked
//      action type, decision age vs the 12h execution ceiling, truth source,
//      target provenance) and the lineage hashes (presence + linkage only —
//      recomputing an old engine's hash with current code is intentionally a
//      mismatch under the D074b hash-input rename, so no hash recomputation
//      is claimed here);
//   4. captures cohort/objective/optimization-goal facts for the Bilsem
//      non-purchase-contract determination.
//
// Output: docs/audits/generated/d078-hard-action-recompute-2026-08-30.json
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const BUNDLE_PATH =
  "docs/audits/generated/d078-six-business-evidence-bundle-2026-08-30.json";
const JSON_OUT =
  "docs/audits/generated/d078-hard-action-recompute-2026-08-30.json";

type Row = Record<string, unknown>;

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function close(a: number | null, b: number | null, tol: number): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function main() {
  const [{ getDb, runDbTransaction }, operational] = await Promise.all([
    import("@/lib/db"),
    import("@/scripts/_operational-runtime"),
  ]);
  operational.configureOperationalScriptRuntime({
    lane: "read_only_observation",
  });
  process.env.DB_QUERY_TIMEOUT_MS = "180000";

  const bundle = JSON.parse(readFileSync(BUNDLE_PATH, "utf8")) as {
    bundleHash: string;
    payload: {
      nativeDecisions: { hardActions: Row[]; stratifiedSample: Row[] };
    };
  };
  const targets: Array<Row & { cohortRole: "hard_action" | "stratified_sample" }> = [
    ...bundle.payload.nativeDecisions.hardActions.map((r) => ({
      ...r,
      cohortRole: "hard_action" as const,
    })),
    ...bundle.payload.nativeDecisions.stratifiedSample.map((r) => ({
      ...r,
      cohortRole: "stratified_sample" as const,
    })),
  ];
  const evaluationIds = [
    ...new Set(
      targets
        .map((t) => (typeof t.evaluation_id === "string" ? t.evaluation_id : null))
        .filter((v): v is string => Boolean(v)),
    ),
  ];

  const result = await operational.withOperationalStartupLogsSilenced(
    async () =>
      runDbTransaction(async () => {
        const db = getDb();
        await db.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const readOnly = await db.query<{ transaction_read_only: string }>(
          "SHOW transaction_read_only",
        );
        if (readOnly[0]?.transaction_read_only !== "on") {
          throw new Error("recompute refuses a writable transaction");
        }
        const retrievedAt = (
          await db.query<{ now: string }>("SELECT now()::text AS now")
        )[0]?.now;

        const evaluations = await db.query<Row>(
          `SELECT e.id::text AS evaluation_id, e.ad_id, e.business_id,
                  e.provider_account_id, e.as_of_date::text AS as_of_date,
                  e.engine_version, e.input_hash, e.decision_hash,
                  e.creative_input_json, e.decision_output_json,
                  e.evaluated_at::text AS evaluated_at,
                  c.context_hash, c.data_health_json
             FROM engine_v3_ad_decision_evaluations e
             LEFT JOIN engine_v3_ad_decision_evaluation_contexts c
               ON c.id = e.context_id
            WHERE e.id = ANY($1::uuid[])
            ORDER BY e.business_id, e.provider_account_id, e.ad_id`,
          [evaluationIds],
        );
        const byEvaluationId = new Map(
          evaluations.map((row) => [String(row.evaluation_id), row]),
        );

        // Warehouse re-derivation per (ad, as_of): 28d and 7d windows ending
        // at the decision as-of date (inclusive) — the engine's own windows
        // are pinned by the evaluation input; both end-inclusive and
        // end-exclusive sums are captured so window-edge semantics are
        // visible instead of assumed.
        const rows: Row[] = [];
        for (const target of targets) {
          const evaluation = byEvaluationId.get(String(target.evaluation_id));
          const input =
            (evaluation?.creative_input_json as Row | undefined) ?? {};
          const output =
            (evaluation?.decision_output_json as Row | undefined) ?? {};
          const adId = String(target.ad_id);
          const asOf = String(target.as_of_date);
          const businessId = String(target.business_id);
          const accountId = String(target.provider_account_id);

          const warehouse = (
            await db.query<Row>(
              `SELECT
                 SUM(spend) FILTER (WHERE date > $4::date - 28 AND date <= $4::date)::float8 AS spend_28_incl,
                 SUM(revenue) FILTER (WHERE date > $4::date - 28 AND date <= $4::date)::float8 AS revenue_28_incl,
                 SUM(conversions) FILTER (WHERE date > $4::date - 28 AND date <= $4::date)::float8 AS purchases_28_incl,
                 SUM(spend) FILTER (WHERE date > $4::date - 29 AND date < $4::date)::float8 AS spend_28_excl,
                 SUM(revenue) FILTER (WHERE date > $4::date - 29 AND date < $4::date)::float8 AS revenue_28_excl,
                 SUM(conversions) FILTER (WHERE date > $4::date - 29 AND date < $4::date)::float8 AS purchases_28_excl,
                 SUM(spend) FILTER (WHERE date > $4::date - 7 AND date <= $4::date)::float8 AS spend_7_incl,
                 SUM(revenue) FILTER (WHERE date > $4::date - 7 AND date <= $4::date)::float8 AS revenue_7_incl,
                 SUM(spend) FILTER (WHERE date > $4::date - 8 AND date < $4::date)::float8 AS spend_7_excl,
                 SUM(revenue) FILTER (WHERE date > $4::date - 8 AND date < $4::date)::float8 AS revenue_7_excl
                FROM meta_ad_daily
               WHERE business_id = $1 AND provider_account_id = $2
                 AND ad_id = $3`,
              [businessId, accountId, adId, asOf],
            )
          )[0];

          const inSpend = num(input.spend);
          const inPurchases = num(input.purchases);
          const inPurchaseValue = num(input.purchaseValue);
          const inRoas = num(input.roas);
          const inCpa = num(input.cpa);
          const inTarget = num(input.targetRoas);
          const inBreakeven = num(input.breakevenRoas);
          const outRatio = num(output.ratioToTarget);
          const outTarget = num(output.effectiveTargetRoas);
          const snapSpend = num(target.spend);
          const snapPurchases = num(target.purchases);
          const snapRoas = num(target.roas);
          const snapTarget = num(target.effective_target_roas);
          const snapRatio = num(target.ratio_to_target);

          const derivedRoas =
            inPurchaseValue !== null && inSpend !== null && inSpend > 0
              ? inPurchaseValue / inSpend
              : null;
          const derivedCpa =
            inSpend !== null && inPurchases !== null && inPurchases > 0
              ? inSpend / inPurchases
              : null;
          const derivedRatio =
            inRoas !== null && outTarget !== null && outTarget > 0
              ? inRoas / outTarget
              : null;

          const zeroActivity =
            (inSpend ?? 0) === 0 &&
            (inPurchases ?? 0) === 0 &&
            (inPurchaseValue ?? 0) === 0;
          const metricsUnavailableFailClosed = inRoas === null;
          const zed = (v: number | null) => (v === null ? 0 : v);
          const wSpend28Incl = num(warehouse?.spend_28_incl);
          const wSpend28Excl = num(warehouse?.spend_28_excl);
          const wRevenue28Incl = num(warehouse?.revenue_28_incl);
          const wRevenue28Excl = num(warehouse?.revenue_28_excl);
          const wPurch28Incl = num(warehouse?.purchases_28_incl);
          const wPurch28Excl = num(warehouse?.purchases_28_excl);
          const wSpend7Incl = num(warehouse?.spend_7_incl);
          const wSpend7Excl = num(warehouse?.spend_7_excl);

          // A NULL warehouse sum means no rows in the window; the engine's
          // zeroed input for an inactive ad is the same fact, so compare
          // through zed() rather than calling NULL-vs-0 a mismatch.
          const spendWindowMatch =
            close(zed(inSpend), zed(wSpend28Incl), 0.02) ||
            close(zed(inSpend), zed(wSpend28Excl), 0.02);
          const valueWindowMatch =
            inPurchaseValue === null ||
            close(zed(inPurchaseValue), zed(wRevenue28Incl), 0.02) ||
            close(zed(inPurchaseValue), zed(wRevenue28Excl), 0.02);
          const purchasesWindowMatch =
            inPurchases === null ||
            close(zed(inPurchases), zed(wPurch28Incl), 0.02) ||
            close(zed(inPurchases), zed(wPurch28Excl), 0.02);
          const recent7Match =
            num(input.recent7dSpend) === null ||
            close(zed(num(input.recent7dSpend)), zed(wSpend7Incl), 0.02) ||
            close(zed(num(input.recent7dSpend)), zed(wSpend7Excl), 0.02);

          const computedAtMs = Date.parse(String(target.computed_at));
          const nowMs = Date.parse(String(retrievedAt));
          const ageHours =
            Number.isFinite(computedAtMs) && Number.isFinite(nowMs)
              ? (nowMs - computedAtMs) / 3_600_000
              : null;

          rows.push({
            cohortRole: target.cohortRole,
            businessId,
            providerAccountId: accountId,
            adId,
            asOfDate: asOf,
            label: target.label,
            authorizedAction: target.authorized_action ?? null,
            stratum: target.stratum ?? null,
            classificationFlags: {
              zeroActivityWindow: zeroActivity,
              metricsUnavailableFailClosed,
            },
            checks: {
              evaluationRowFound: Boolean(evaluation),
              snapshotMatchesInput:
                close(zed(snapSpend), zed(inSpend), 1e-9) &&
                close(zed(snapPurchases), zed(inPurchases), 1e-9) &&
                (metricsUnavailableFailClosed ||
                  close(snapRoas, inRoas, 1e-9)),
              // A row whose purchase ROAS is non-finite is a deliberate
              // fail-closed diagnose; there is no ROAS arithmetic to
              // reproduce and the reason text carries the anomaly.
              roasReproducesFromValueOverSpend:
                metricsUnavailableFailClosed ||
                close(inRoas, derivedRoas, 1e-9),
              cpaReproduces: inCpa === null || close(inCpa, derivedCpa, 1e-9),
              ratioToTargetReproduces:
                metricsUnavailableFailClosed ||
                (close(outRatio, derivedRatio, 1e-9) &&
                  close(snapRatio, derivedRatio, 1e-9)),
              effectiveTargetMatchesSnapshot: close(outTarget, snapTarget, 1e-9),
              commercialAnchorConfigured:
                inTarget !== null && inBreakeven !== null,
              warehouseSpend28Reproduces: spendWindowMatch,
              warehouseValue28Reproduces: valueWindowMatch,
              warehousePurchases28Reproduces: purchasesWindowMatch,
              warehouseRecent7SpendReproduces: recent7Match,
              authorizedRowHasNoBlocker:
                (target.authorized_action ?? null) === null ||
                (output.blockers === null &&
                  output.authorityBlocker === null &&
                  output.blockedActionType === null),
              hashesPresent:
                /^[0-9a-f]{64}$/.test(String(evaluation?.input_hash ?? "")) &&
                /^[0-9a-f]{64}$/.test(String(evaluation?.decision_hash ?? "")) &&
                /^[0-9a-f]{64}$/.test(String(evaluation?.context_hash ?? "")),
            },
            numbers: {
              inputSpend: inSpend,
              inputPurchases: inPurchases,
              inputPurchaseValue: inPurchaseValue,
              inputRoas: inRoas,
              derivedRoas,
              effectiveTargetRoas: outTarget,
              breakevenRoas: inBreakeven,
              ratioToTargetStored: outRatio,
              ratioToTargetDerived: derivedRatio,
              warehouseSpend28InclusiveOfAsOf: wSpend28Incl,
              warehouseSpend28EndExclusive: wSpend28Excl,
              warehouseRevenue28InclusiveOfAsOf: wRevenue28Incl,
              warehouseRevenue28EndExclusive: wRevenue28Excl,
              recent7dSpendInput: num(input.recent7dSpend),
              warehouseSpend7Inclusive: wSpend7Incl,
              warehouseSpend7EndExclusive: wSpend7Excl,
            },
            eligibilityTuple: {
              truthSource: target.truth_source ?? output.truthSource ?? null,
              blockers: output.blockers ?? null,
              authorityBlocker: output.authorityBlocker ?? null,
              blockedActionType: output.blockedActionType ?? null,
              confidence: target.confidence ?? null,
              computedAt: target.computed_at,
              decisionAgeHoursAtRecompute: ageHours,
              executionCeilingHours: 12,
              staleBeyondExecutionCeiling:
                ageHours !== null ? ageHours > 12 : null,
              legacyOnlyRoleVocabulary:
                "campaignLabelStatus" in output &&
                !("campaignRoleStatus" in output),
            },
            cohortFacts: {
              objective: input.objective ?? null,
              optimizationGoal: input.optimizationGoal ?? null,
              customEventType: input.customEventType ?? null,
              effectiveCohort: input.effectiveCohort ?? null,
              accountCurrency: input.accountCurrency ?? null,
              accountTimezone: input.accountTimezone ?? null,
              campaignKind: output.campaignKind ?? null,
              decisionKindSource: output.decisionKindSource ?? null,
            },
            lineage: {
              evaluationId: target.evaluation_id,
              inputHash: evaluation?.input_hash ?? null,
              decisionHash: evaluation?.decision_hash ?? null,
              contextHash: evaluation?.context_hash ?? null,
              engineVersion: evaluation?.engine_version ?? null,
              reason: output.reason ?? null,
            },
          });
        }

        return { retrievedAt, rows };
      }),
  );

  const summary = {
    totalRows: result.rows.length,
    hardActions: result.rows.filter((r) => r.cohortRole === "hard_action")
      .length,
    sampleRows: result.rows.filter((r) => r.cohortRole === "stratified_sample")
      .length,
    checkFailures: result.rows
      .map((r) => ({
        adId: r.adId,
        businessId: r.businessId,
        failed: Object.entries(r.checks as Record<string, boolean>)
          .filter(([, ok]) => !ok)
          .map(([name]) => name),
      }))
      .filter((r) => r.failed.length > 0),
  };

  const artifact = {
    contract: "adsecute.meta.d078-hard-action-recompute.v1",
    sourceBundleHash: bundle.bundleHash,
    retrievedAt: result.retrievedAt,
    summary,
    rows: result.rows,
  };
  const artifactHash = sha256(artifact);
  writeFileSync(
    JSON_OUT,
    `${JSON.stringify({ artifactHash, ...artifact }, null, 1)}\n`,
  );
  console.log(`recompute written: ${JSON_OUT}`);
  console.log(`artifactHash: ${artifactHash}`);
  console.log(JSON.stringify(summary, null, 1));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
