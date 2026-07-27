import { configureOperationalScriptRuntime } from "./_operational-runtime";
import { getSyncWorkerOwnedWorkUnits } from "@/lib/sync/worker-health";

type ParsedArgs = {
  help: boolean;
  providerScopes: string[];
  onlineWindowMinutes: number;
  minOnlineWorkers: number;
  minHeartbeatAfter: string | null;
  expectStagedIdle: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    providerScopes: [],
    onlineWindowMinutes: 5,
    minOnlineWorkers: 1,
    minHeartbeatAfter: null,
    expectStagedIdle: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--expect-staged-idle") {
      parsed.expectStagedIdle = true;
      continue;
    }
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--provider-scope") {
      const value = argv[index + 1]?.trim();
      if (!value) {
        throw new Error("missing value for --provider-scope");
      }
      parsed.providerScopes.push(value);
      index += 1;
      continue;
    }
    if (arg === "--online-window-minutes") {
      const value = Number(argv[index + 1] ?? "");
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("invalid value for --online-window-minutes");
      }
      parsed.onlineWindowMinutes = value;
      index += 1;
      continue;
    }
    if (arg === "--min-online-workers") {
      const value = Number(argv[index + 1] ?? "");
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("invalid value for --min-online-workers");
      }
      parsed.minOnlineWorkers = value;
      index += 1;
      continue;
    }
    if (arg === "--min-heartbeat-after") {
      const value = argv[index + 1]?.trim();
      if (!value) {
        throw new Error("missing value for --min-heartbeat-after");
      }
      parsed.minHeartbeatAfter = value;
      index += 1;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return parsed;
}

function printUsage() {
  console.log(
    "usage: node --import tsx scripts/sync-worker-healthcheck.ts [--provider-scope <scope>] [--online-window-minutes <minutes>] [--min-online-workers <count>] [--min-heartbeat-after <iso>]",
  );
}

async function main() {
  configureOperationalScriptRuntime();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const { getSyncWorkerHealthSummary } = await import("@/lib/sync/worker-health");
  const summary = await getSyncWorkerHealthSummary({
    providerScopes: args.providerScopes,
    onlineWindowMinutes: args.onlineWindowMinutes,
  });

  const minHeartbeatAfterMs =
    args.minHeartbeatAfter != null ? new Date(args.minHeartbeatAfter).getTime() : null;
  if (
    minHeartbeatAfterMs != null &&
    (!Number.isFinite(minHeartbeatAfterMs) || Number.isNaN(minHeartbeatAfterMs))
  ) {
    throw new Error("invalid ISO timestamp for --min-heartbeat-after");
  }

  const lastHeartbeatMs =
    summary.lastHeartbeatAt != null ? new Date(summary.lastHeartbeatAt).getTime() : null;
  const heartbeatSatisfied =
    minHeartbeatAfterMs == null ||
    (lastHeartbeatMs != null &&
      Number.isFinite(lastHeartbeatMs) &&
      lastHeartbeatMs >= minHeartbeatAfterMs);
  // Staged mode asserts the NEGATIVE contract, which the ordinary path cannot
  // express: --min-online-workers rejects 0, and a staged worker's whole point
  // is that zero workers are online while exactly one is registered.
  const stagedWorkers = (summary.workers ?? []).filter(
    (worker) => worker.status === "disabled" && worker.workerFreshnessState === "staged",
  );
  const owned = args.expectStagedIdle
    ? await getSyncWorkerOwnedWorkUnits(stagedWorkers.map((worker) => worker.workerId))
    : null;
  const holdsNothing = owned == null || Object.values(owned).every((count) => count === 0);

  let reason: string;
  if (args.expectStagedIdle) {
    if (stagedWorkers.length !== 1) reason = "staged_idle_not_observed";
    else if (summary.onlineWorkers > 0) reason = "unexpected_online_workers";
    else if (!holdsNothing) reason = "staged_worker_holds_work";
    else if (!heartbeatSatisfied) reason = "fresh_heartbeat_not_observed";
    else reason = "healthy";
  } else if (summary.onlineWorkers < args.minOnlineWorkers) {
    reason = "insufficient_online_workers";
  } else if (!heartbeatSatisfied) {
    reason = "fresh_heartbeat_not_observed";
  } else {
    reason = "healthy";
  }
  const pass = reason === "healthy";

  console.log(
    JSON.stringify(
      {
        providerScopes: args.providerScopes,
        onlineWindowMinutes: args.onlineWindowMinutes,
        minOnlineWorkers: args.minOnlineWorkers,
        minHeartbeatAfter: args.minHeartbeatAfter,
        expectStagedIdle: args.expectStagedIdle,
        stagedWorkers: stagedWorkers.length,
        ownedWorkUnits: owned,
        pass,
        reason,
        summary,
      },
      null,
      2,
    ),
  );

  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  printUsage();
  process.exit(1);
});
