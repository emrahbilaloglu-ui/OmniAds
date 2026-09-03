#!/usr/bin/env node
/**
 * PRE-DEPLOY AUDIT — the capability-open preflight, run for real.
 *
 * Invoked INSIDE the worker container (`docker compose exec -T worker node
 * --import tsx scripts/automation-capability-preflight-cli.ts`), where
 * `DATABASE_URL` is the container's own production connection — the same
 * connection every other post-deploy verification script in this repo
 * already uses.
 *
 * This runs the automation-off readback and the six-business check as
 * INDIVIDUAL statements through the app's own `getDb()`/`runDbTransaction()`
 * — one bounded `REPEATABLE READ READ ONLY` transaction with a
 * `statement_timeout` and a unique `application_name`, all three proven
 * in-transaction before anything else runs — the exact pattern
 * `scripts/audits/d077-production-recovery-readonly-preflight.ts` already
 * proves against real production.
 *
 * It does NOT shell out to `psql` and does NOT read
 * `docs/audits/AUTOMATION_OFF_READBACK_2026-09-03.md`. The shipped worker
 * image (Dockerfile's `worker-runner` stage) copies `app/`, `lib/`,
 * `providers/`, `scripts/`, `deploy/`, `src/`, `store/`, `hooks/`,
 * `components/` and a handful of root config files — never `docs/` — and
 * the base `node:20-alpine` image never installs a `psql` client. Run for
 * real inside that container, the old design's docs read threw ENOENT and
 * its psql spawn failed with ENOENT too: the preflight could refuse but
 * could never PASS, so capability-open could never succeed on an actual
 * deploy. `RUNTIME_READBACK_SQL_STATEMENTS` in
 * `lib/meta/automation-capability-preflight.ts` carries the SAME SELECT
 * text the operator document declares — extracted once, not retyped, and
 * kept honest by that module's own "byte-identical to the operator
 * document" test.
 *
 * Prints ONE JSON verdict to stdout:
 *
 *   { "result": "pass" | "refused", "blockers": string[], ... }
 *
 * Exit 0 only on `"pass"`. Never `|| true`d by a caller — a refused
 * preflight must stop the workflow, not be swallowed.
 */
import {
  AUTOMATION_CAPABILITY_PREFLIGHT_CONTRACT,
  evaluateAutomationCapabilityPreflightFromRows,
  runRuntimePerBusinessQuery,
  runRuntimeReadback,
  type AutomationCapabilityPreflightResult,
  type RuntimeQueryFn,
} from "@/lib/meta/automation-capability-preflight";

async function main(): Promise<void> {
  const { getDb, runDbTransaction } = await import("@/lib/db");
  const operational = await import("@/scripts/_operational-runtime");
  operational.configureOperationalScriptRuntime({ lane: "read_only_observation" });

  const appName = `automation_capability_preflight_${Date.now()}_${process.pid}`;

  let verdict: AutomationCapabilityPreflightResult;

  try {
    verdict = await operational.withOperationalStartupLogsSilenced(() =>
      runDbTransaction(
        async () => {
          const db = getDb();
          await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
          await db.query("SET LOCAL statement_timeout = '30s'");
          await db.query(`SET LOCAL application_name = '${appName}'`);

          const proofs = (
            await db.query<{
              transaction_read_only: string;
              transaction_isolation: string;
              application_name: string;
            }>(
              `SELECT current_setting('transaction_read_only') AS transaction_read_only,
                      current_setting('transaction_isolation') AS transaction_isolation,
                      current_setting('application_name') AS application_name`,
            )
          )[0]!;
          if (proofs.transaction_read_only !== "on") {
            throw new Error("refusing: transaction_read_only is not on");
          }
          if (proofs.transaction_isolation !== "repeatable read") {
            throw new Error("refusing: transaction_isolation is not repeatable read");
          }
          if (proofs.application_name !== appName) {
            throw new Error("refusing: application_name was not applied");
          }

          const query: RuntimeQueryFn = (sql) => db.query(sql);
          const readbackRows = await runRuntimeReadback(query);
          const businessRows = await runRuntimePerBusinessQuery(query);

          return evaluateAutomationCapabilityPreflightFromRows({ readbackRows, businessRows });
        },
        { timeoutMs: 30_000 },
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    verdict = {
      contract: AUTOMATION_CAPABILITY_PREFLIGHT_CONTRACT,
      ok: false,
      blockers: [`preflight_query_failed: ${message.slice(0, 300)}`],
      sectionsSeen: [],
      perBusiness: [],
    };
  }

  const summary = {
    contract: verdict.contract,
    result: verdict.ok ? "pass" : "refused",
    blockers: verdict.blockers,
    sectionsSeen: verdict.sectionsSeen,
    perBusiness: verdict.perBusiness,
    checkedAtUtc: new Date().toISOString(),
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith("automation-capability-preflight-cli.ts")) {
  main();
}
