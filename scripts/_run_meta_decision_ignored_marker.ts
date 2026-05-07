import { resetDbClientCache } from "@/lib/db";
import { runMetaDecisionIgnoredMarker } from "@/lib/meta/decision-responses";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

function parseNow(argv: string[]) {
  const raw = argv[2]?.trim();
  if (!raw) return new Date();
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Expected optional ISO timestamp argument.");
  }
  return parsed;
}

async function main() {
  configureOperationalScriptRuntime({ lane: "owner_maintenance" });
  await withOperationalStartupLogsSilenced(async () => {
    const result = await runMetaDecisionIgnoredMarker({ now: parseNow(process.argv) });
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
