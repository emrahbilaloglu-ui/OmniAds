import { runDecisionsJob } from "@/lib/creative-decision-engine/jobs/decisions-job";
import { resetDbClientCache } from "@/lib/db";
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
    const asOf = process.argv[2] ?? new Date().toISOString().slice(0, 10);
    for (const business of BUSINESSES) {
      console.log(`Running decisions for ${business.name} as_of=${asOf}...`);
      const result = await runDecisionsJob({
        businessId: business.id,
        asOf,
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
