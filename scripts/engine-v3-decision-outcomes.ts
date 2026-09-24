#!/usr/bin/env node
import { runDecisionOutcomesJob } from "@/lib/creative-decision-engine/jobs/decision-outcomes-job";
import { requireCreativeDayEvaluationCutoffAt } from "@/lib/meta/creative-day-decision-admission";

function usage() {
  console.error(
    "usage: node --import tsx scripts/engine-v3-decision-outcomes.ts <businessId> <asOf=YYYY-MM-DD> <evaluationCutoffAt=UTC ISO> (or ADSECUTE_CREATIVE_EVALUATION_CUTOFF_AT)",
  );
}

async function main() {
  const businessId = process.argv[2]?.trim();
  const asOf = process.argv[3]?.trim();
  if (!businessId || !asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    usage();
    process.exitCode = 1;
    return;
  }
  const evaluationCutoffAt = requireCreativeDayEvaluationCutoffAt(
    process.argv[4]?.trim() || process.env.ADSECUTE_CREATIVE_EVALUATION_CUTOFF_AT?.trim(),
  );

  const result = await runDecisionOutcomesJob({ businessId, asOf, evaluationCutoffAt });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "failed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
