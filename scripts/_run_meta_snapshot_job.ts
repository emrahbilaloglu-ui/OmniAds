import { resetDbClientCache } from "@/lib/db";
import {
  runMetaSnapshotForAllBusinesses,
  runMetaSnapshotForBusiness,
} from "@/lib/meta/snapshot";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

function parseArgs(argv: string[]) {
  const first = argv[2]?.trim();
  const second = argv[3]?.trim();
  const firstIsDate = Boolean(first && /^\d{4}-\d{2}-\d{2}$/.test(first));
  return {
    snapshotDate: firstIsDate ? first! : new Date().toISOString().slice(0, 10),
    businessId: firstIsDate ? second || null : first || null,
  };
}

async function main() {
  configureOperationalScriptRuntime({ lane: "owner_maintenance" });
  await withOperationalStartupLogsSilenced(async () => {
    const { snapshotDate, businessId } = parseArgs(process.argv);
    const result = businessId
      ? await runMetaSnapshotForBusiness(businessId, snapshotDate)
      : await runMetaSnapshotForAllBusinesses(snapshotDate);
    console.log(JSON.stringify(result, null, 2));
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
