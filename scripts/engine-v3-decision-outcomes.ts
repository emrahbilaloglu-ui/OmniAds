#!/usr/bin/env node
import { runDecisionOutcomesJob } from "@/lib/creative-decision-engine/jobs/decision-outcomes-job";

function usage() {
  console.error(
    "usage: node --import tsx scripts/engine-v3-decision-outcomes.ts <businessId> [asOf=YYYY-MM-DD]",
  );
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const businessId = process.argv[2]?.trim();
  const asOf = process.argv[3]?.trim() || todayIsoDate();
  if (!businessId) {
    usage();
    process.exitCode = 1;
    return;
  }

  const result = await runDecisionOutcomesJob({ businessId, asOf });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "failed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
