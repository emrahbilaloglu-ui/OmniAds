import { runDecisionsJob } from "@/lib/creative-decision-engine/jobs/decisions-job";
import { resetDbClientCache } from "@/lib/db";
import { requireCreativeDayEvaluationCutoffAt } from "@/lib/meta/creative-day-decision-admission";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

const BUSINESSES = [
  { id: "172d0ab8-495b-4679-a4c6-ffa404c389d3", name: "TheSwaf" },
  { id: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", name: "IwaStore" },
];

async function main() {
  configureOperationalScriptRuntime({ lane: "owner_maintenance" });
  await withOperationalStartupLogsSilenced(async () => {
    const asOf = process.argv[2]?.trim();
    if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      throw new Error("usage: _run_decisions_job.ts <asOf=YYYY-MM-DD> <evaluationCutoffAt=UTC ISO> (or ADSECUTE_CREATIVE_EVALUATION_CUTOFF_AT)");
    }
    const evaluationCutoffAt = requireCreativeDayEvaluationCutoffAt(
      process.argv[3]?.trim() || process.env.ADSECUTE_CREATIVE_EVALUATION_CUTOFF_AT?.trim(),
    );
    for (const business of BUSINESSES) {
      console.log(`Running decisions for ${business.name} as_of=${asOf} cutoff=${evaluationCutoffAt}...`);
      const result = await runDecisionsJob({
        businessId: business.id,
        asOf,
        evaluationCutoffAt,
      });
      console.log(JSON.stringify(result, null, 2));
    }
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    resetDbClientCache();
  });
