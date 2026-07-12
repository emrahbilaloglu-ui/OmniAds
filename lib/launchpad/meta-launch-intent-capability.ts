import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import type { MetaLaunchIntentCapability } from "@/lib/launchpad/meta-launch-intent";

export async function getMetaLaunchIntentCapability(): Promise<MetaLaunchIntentCapability> {
  const readiness = await getDbSchemaReadiness({
    tables: ["meta_launch_intents"],
  });
  const ready = readiness.ready;
  return {
    status: ready ? "ready" : "migration_required",
    canRead: ready,
    canWrite: ready,
    missingTables: readiness.missingTables,
    checkedAt: readiness.checkedAt,
  };
}
