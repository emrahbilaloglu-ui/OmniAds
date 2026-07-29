import { configureOperationalScriptRuntime } from "./_operational-runtime";
import { getSyncWorkerOwnedWorkUnits } from "@/lib/sync/worker-health";
import {
  evaluateWorkerHealth,
  selectStagedWorkers,
} from "@/lib/sync/staged-worker-predicate";

type ParsedArgs = {
  help: boolean;
  providerScopes: string[];
  onlineWindowMinutes: number;
  minOnlineWorkers: number;
  minHeartbeatAfter: string | null;
  expectStagedIdle: boolean;
  expectBuildId: string | null;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    providerScopes: [],
    onlineWindowMinutes: 5,
    minOnlineWorkers: 1,
    minHeartbeatAfter: null,
    expectStagedIdle: false,
    expectBuildId: null,
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
    if (arg === "--expect-build-id") {
      const value = argv[index + 1]?.trim();
      if (!value) {
        throw new Error("missing value for --expect-build-id");
      }
      parsed.expectBuildId = value;
      index += 1;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return parsed;
}

function printUsage() {
  console.log(
    "usage: node --import tsx scripts/sync-worker-healthcheck.ts [--provider-scope <scope>] [--online-window-minutes <minutes>] [--min-online-workers <count>] [--min-heartbeat-after <iso>] [--expect-staged-idle] [--expect-build-id <sha>]",
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

  // The staged registrations. Selected before the owned-work query because
  // that query is scoped to exactly these worker ids.
  const stagedWorkers = selectStagedWorkers({
    workers: summary.workers,
    nowMs: Date.now(),
    onlineWindowMinutes: args.onlineWindowMinutes,
  });
  const owned = args.expectStagedIdle
    ? await getSyncWorkerOwnedWorkUnits(stagedWorkers.map((worker) => worker.workerId))
    : null;

  const evaluation = evaluateWorkerHealth({
    summary,
    stagedWorkers,
    ownedWorkUnits: owned,
    expectStagedIdle: args.expectStagedIdle,
    expectBuildId: args.expectBuildId,
    minHeartbeatAfter: args.minHeartbeatAfter,
    minOnlineWorkers: args.minOnlineWorkers,
  });
  const { pass, reason } = evaluation;

  console.log(
    JSON.stringify(
      {
        providerScopes: args.providerScopes,
        onlineWindowMinutes: args.onlineWindowMinutes,
        minOnlineWorkers: args.minOnlineWorkers,
        minHeartbeatAfter: args.minHeartbeatAfter,
        expectStagedIdle: args.expectStagedIdle,
        expectBuildId: args.expectBuildId,
        stagedWorkers: stagedWorkers.length,
        stagedWorkerId: evaluation.stagedWorkerId,
        stagedWorkerStartedAt: evaluation.stagedWorkerStartedAt,
        stagedWorkerBuildId: evaluation.stagedWorkerBuildId,
        stagedWorkerContractBuildId: evaluation.stagedWorkerContractBuildId,
        stagedIsThisRun: evaluation.stagedIsThisRun,
        stagedBuildIdMatches: evaluation.stagedBuildIdMatches,
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
