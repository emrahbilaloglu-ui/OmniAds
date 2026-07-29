import { loadEnvConfig } from "@next/env";
import { assertImmutableBuildIdentity } from "@/lib/build-runtime";
import { durableWorkerAdapters } from "@/lib/sync/provider-worker-adapters";
import { assertRuntimeContractStartup } from "@/lib/sync/runtime-contract";
import { runDurableWorkerRuntime } from "@/lib/sync/worker-runtime";

loadEnvConfig(process.cwd());

// Which release this is, decided BEFORE the runtime contract reads it.
//
// `loadEnvConfig` above is exactly how a stale APP_BUILD_ID gets in: it loads
// the host's env files over the image's own ENV. Resolving here means the
// startup contract, every heartbeat and the `sync_runtime_instances` row all
// carry one identity that the image can vouch for, rather than three readings
// of whichever file was on the host.
//
// Enforced where identity is load-bearing — production, and staged mode
// wherever it runs. A developer running the worker locally with no build id is
// unaffected.
const stagingIdleRequested = ["1", "true", "yes", "enabled"].includes(
  process.env.SYNC_WORKER_STAGING_IDLE?.trim().toLowerCase() ?? "",
);
if (process.env.NODE_ENV === "production" || stagingIdleRequested) {
  try {
    assertImmutableBuildIdentity({ context: "sync_worker_startup" });
  } catch (error) {
    console.error("[sync-worker] build_identity_refused", error);
    process.exitCode = 1;
    throw error;
  }
}

assertRuntimeContractStartup({ service: "worker" });

void runDurableWorkerRuntime({
  adapters: durableWorkerAdapters,
}).catch((error) => {
  console.error("[sync-worker] fatal", error);
  process.exitCode = 1;
});
