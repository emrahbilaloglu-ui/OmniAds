#!/usr/bin/env node
// D077 — operator CLI for state-history compaction. The ONLY entry point to
// the executor besides the real-Postgres seam and tests; nothing in app
// runtime imports it and nothing schedules it.
//
//   plan    (default) SELECT-only dry-run. One explicit REPEATABLE READ
//           READ ONLY transaction (a single snapshot for the whole
//           multi-statement plan) with an explicit statement timeout;
//           writes the plan JSON to a file and prints the summary. Never
//           mutates anything.
//   execute Requires --plan-file, --approval-token (the operator constructs
//           it from the printed planHash deliberately; the CLI never prints
//           the token), --acknowledge-physical-shrink-required, and the same
//           --business-ids the plan was built for.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function requireBusinessIds(): string[] {
  const raw = argValue("--business-ids");
  const ids = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error(
      "--business-ids <id,id,...> is required; a global scope is refused.",
    );
  }
  return ids;
}

async function main() {
  const mode = argValue("--mode") ?? "plan";
  const [{ getDb, runDbTransaction }, operational] = await Promise.all([
    import("@/lib/db"),
    import("@/scripts/_operational-runtime"),
  ]);
  const businessIds = requireBusinessIds();

  if (mode === "plan") {
    operational.configureOperationalScriptRuntime({
      lane: "read_only_observation",
    });
    const { planStateHistoryCompaction } = await import(
      "@/lib/meta/state-history-compaction"
    );
    const timeoutMs = Number(argValue("--statement-timeout-ms") ?? 120_000);
    const plan = await operational.withOperationalStartupLogsSilenced(
      async () =>
        runDbTransaction(async () => {
          const db = getDb();
          await db.query(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
          );
          await db.query(
            `SET LOCAL statement_timeout = '${Math.max(1_000, Math.min(600_000, Math.floor(timeoutMs)))}ms'`,
          );
          return planStateHistoryCompaction(db, { businessIds });
        }),
    );
    const outPath = resolve(
      argValue("--plan-out") ?? "state-history-compaction-plan.json",
    );
    writeFileSync(outPath, JSON.stringify(plan, null, 1));
    console.log(
      JSON.stringify(
        {
          status: plan.status,
          insufficiencyReasons: plan.insufficiencyReasons,
          totals: plan.totals,
          fence: plan.fence,
          fenceProjection: plan.fenceProjection,
          planHash: plan.planHash,
          planFile: outPath,
        },
        null,
        1,
      ),
    );
    console.log(
      "[state-history-compaction] DRY RUN ONLY. Nothing was mutated. The raw-size fence is NOT cleared by any DELETE plan; see fenceProjection.",
    );
    return;
  }

  if (mode === "execute") {
    const planFile = argValue("--plan-file");
    const approvalToken = argValue("--approval-token");
    const acknowledged = process.argv.includes(
      "--acknowledge-physical-shrink-required",
    );
    if (!planFile || !approvalToken) {
      throw new Error(
        "execute requires --plan-file and --approval-token (constructed by the operator from the plan hash).",
      );
    }
    const { executeStateHistoryCompaction } = await import(
      "@/lib/meta/state-history-compaction-executor"
    );
    const plan = JSON.parse(readFileSync(resolve(planFile), "utf8"));
    if (
      JSON.stringify([...businessIds].sort()) !==
      JSON.stringify(plan.businessIds)
    ) {
      throw new Error(
        "--business-ids must exactly match the plan's business scope.",
      );
    }
    const result = await executeStateHistoryCompaction({
      plan,
      approvalToken,
      acknowledgePhysicalShrinkRequired: acknowledged,
    });
    console.log(JSON.stringify(result, null, 1));
    if (result.status !== "completed" && result.status !== "completed_with_skips") {
      process.exitCode = 2;
    }
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
