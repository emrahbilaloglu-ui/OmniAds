#!/usr/bin/env node
/**
 * PRE-DEPLOY AUDIT — the CURRENT serving-freshness preflight for the six
 * release-relevant businesses, run for real against production.
 *
 * The frozen 2026-08-30 evidence (`docs/audits/D077_PRODUCTION_RECOVERY_
 * PREFLIGHT_2026-08-30.md`, embedded in
 * `docs/audits/generated/d077-production-recovery-readonly-evidence-2026-08-30.json`)
 * reported `automated_missing` surfaces for IwaStore (3), TheSwaf (3) and
 * Grandmix (23), and `docs/architecture/serving-direct-production-release-
 * runbook.md` treats that as a real deploy blocker. That evidence is FIVE
 * DAYS OLD by the time this pass runs — this script re-measures the SAME
 * six businesses, the SAME way (`readServingFreshnessStatus`, one bounded
 * `REPEATABLE READ READ ONLY` transaction, a `statement_timeout`, a unique
 * `application_name`, in-transaction proof of all three before anything
 * else runs), and writes a NEW, distinctly-dated evidence file — it never
 * overwrites or edits the frozen 2026-08-30 file, and it never fabricates
 * a GO verdict: if `automated_missing` is still non-zero anywhere, this
 * says so, names exactly which surfaces and why, and states the
 * remediation the runbook already prescribes.
 *
 * SELECT-only. No backfill, no cache warm, no provider call, no write of
 * any kind — the transaction is READ ONLY at the Postgres level, so any
 * accidental write attempt is rejected by the database itself, and the
 * transaction always ends in ROLLBACK regardless of outcome.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const CHARTER = [
  { name: "IwaStore", businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2" },
  { name: "Grandmix", businessId: "5dbc7147-f051-4681-a4d6-20617170074f" },
  { name: "Bilsem Zeka", businessId: "6c690fa4-6395-40b5-9755-e99b34d69bc3" },
  { name: "TheSwaf", businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3" },
  { name: "IwaTR", businessId: "b79683b4-6f87-48c0-a3ca-44d4356fef51" },
  { name: "ColorFullWorldsTR", businessId: "bc0c6178-7853-4f6f-b026-ef0222a4b9e7" },
] as const;

const OUTPUT_PATH = process.env.SERVING_FRESHNESS_PREFLIGHT_OUTPUT
  ?? "docs/audits/generated/serving-freshness-current-preflight-2026-09-03.json";

type Row = Record<string, unknown>;

class RollbackWithPayload extends Error {
  constructor(public payload: Record<string, unknown>) {
    super("serving-freshness-current-preflight-rollback-sentinel");
  }
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function main() {
  const [{ getDb, runDbTransaction }, operational] = await Promise.all([
    import("@/lib/db"),
    import("@/scripts/_operational-runtime"),
  ]);
  operational.configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const { readServingFreshnessStatus } = await import("@/lib/serving-freshness-status");

  const appName = `serving_freshness_current_preflight_${Date.now()}`;
  let payload: Record<string, unknown> | null = null;

  try {
    await operational.withOperationalStartupLogsSilenced(() =>
      runDbTransaction(async () => {
        const db = getDb();
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await db.query("SET LOCAL statement_timeout = '120000ms'");
        await db.query(`SET LOCAL application_name = '${appName}'`);

        const proofs = (
          await db.query<Row>(
            `SELECT current_setting('transaction_read_only') AS transaction_read_only,
                    current_setting('transaction_isolation') AS transaction_isolation,
                    current_setting('application_name') AS application_name,
                    current_setting('statement_timeout') AS statement_timeout,
                    now()::text AS retrieved_at`,
          )
        )[0]!;
        if (proofs.transaction_read_only !== "on") {
          throw new Error("refusing: transaction_read_only is not on");
        }
        if (proofs.transaction_isolation !== "repeatable read") {
          throw new Error("refusing: transaction_isolation is not repeatable read");
        }
        if (proofs.statement_timeout === "0") {
          throw new Error("refusing: statement_timeout is unbounded");
        }
        if (proofs.application_name !== appName) {
          throw new Error("refusing: application_name was not applied");
        }

        const perBusiness: Row[] = [];
        for (const business of CHARTER) {
          const report = await readServingFreshnessStatus({ businessId: business.businessId });
          const automatedMissing = report.entries.filter(
            (entry) => entry.statusClassification === "automated_missing",
          );
          perBusiness.push({
            business: business.name,
            businessId: business.businessId,
            classifications: report.classifications,
            automatedMissingCount: automatedMissing.length,
            automatedMissingSurfaces: automatedMissing.map((entry) => ({
              surface: entry.surface,
              ownerModule: entry.ownerModule,
              statusReason: entry.statusReason,
              operatorFallbackCommand: entry.operatorFallbackCommand,
            })),
          });
        }

        const totalAutomatedMissing = perBusiness.reduce(
          (sum, b) => sum + (b.automatedMissingCount as number), 0,
        );

        throw new RollbackWithPayload({
          transactionProofs: proofs,
          perBusiness,
          totalAutomatedMissing,
        });
      }, { timeoutMs: 120_000 }),
    );
  } catch (error) {
    if (error instanceof RollbackWithPayload) {
      payload = error.payload;
    } else {
      throw error;
    }
  }

  if (!payload) {
    throw new Error("no payload captured — the transaction did not run to the rollback sentinel");
  }

  const verdict = (payload.totalAutomatedMissing as number) === 0 ? "GO" : "NO_GO";
  const evidence = {
    contract: "adsecute.serving-freshness-current-preflight.v1",
    generatedAtUtc: new Date().toISOString(),
    note:
      "Re-measurement of the same six businesses and the same automated_missing "
      + "classification the 2026-08-30 evidence used (docs/audits/D077_PRODUCTION_"
      + "RECOVERY_PREFLIGHT_2026-08-30.md), current as of generatedAtUtc above. "
      + "Does NOT edit or supersede the 2026-08-30 file — that file remains the "
      + "historical record of what was true then.",
    verdict,
    remediation:
      verdict === "GO"
        ? null
        : "Per docs/architecture/serving-direct-production-release-runbook.md: "
          + "automated_missing surfaces are a real release blocker, not a "
          + "cosmetic gap. Each named surface's operatorFallbackCommand can "
          + "serve it manually in the interim; the underlying automated owner "
          + "module for each surface must actually run and succeed for that "
          + "business/scope before this verdict can read GO.",
    ...payload,
  };
  const evidenceHash = sha256Utf8(JSON.stringify(evidence, null, 1));
  const hashed = { evidenceHash, hashAlgorithm: "sha256", hashBasis: "sha256 over UTF-8 bytes of JSON.stringify(evidence, null, 1) of the evidence object WITHOUT this hash field", ...evidence };

  writeFileSync(OUTPUT_PATH, JSON.stringify(hashed, null, 2));
  console.log(JSON.stringify({ verdict, totalAutomatedMissing: payload.totalAutomatedMissing, outputPath: OUTPUT_PATH }, null, 2));
  process.exit(verdict === "GO" ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
