import { runCalibrationJob } from "@/lib/creative-decision-engine/jobs/calibration-job";
import { runLifecycleJob } from "@/lib/creative-decision-engine/jobs/lifecycle-job";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

const BUSINESSES = [
  { id: "172d0ab8-495b-4679-a4c6-ffa404c389d3", name: "TheSwaf" },
  { id: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", name: "IwaStore" },
];

type DistributionRow = Record<string, unknown> & {
  lifecycle_position: unknown;
  count: unknown;
};

async function lifecycleDistribution(input: { businessId: string; asOf: string }) {
  return getDb().query<DistributionRow>(
    `
    SELECT lifecycle_position, COUNT(*) AS count
    FROM engine_v3_creative_lifecycle_daily
    WHERE business_ref_id = $1::uuid
      AND as_of_date = $2::date
      AND engine_version = $3
    GROUP BY lifecycle_position
    ORDER BY lifecycle_position
    `,
    [input.businessId, input.asOf, ENGINE_VERSION],
  );
}

async function main() {
  configureOperationalScriptRuntime({ lane: "owner_maintenance" });
  await withOperationalStartupLogsSilenced(async () => {
    const asOf = process.argv[2] ?? new Date().toISOString().slice(0, 10);
    for (const business of BUSINESSES) {
      console.log(`Running calibration for ${business.name} as_of=${asOf}...`);
      const calibration = await runCalibrationJob({
        businessId: business.id,
        asOf,
      });
      console.log(JSON.stringify(calibration, null, 2));

      console.log(`Running lifecycle for ${business.name} as_of=${asOf}...`);
      const lifecycle = await runLifecycleJob({
        businessId: business.id,
        asOf,
      });
      console.log(JSON.stringify(lifecycle, null, 2));

      const distribution = await lifecycleDistribution({
        businessId: business.id,
        asOf,
      });
      console.log(JSON.stringify({ lifecycle_position_distribution: distribution }, null, 2));
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
