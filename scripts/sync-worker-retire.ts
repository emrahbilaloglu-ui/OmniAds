/**
 * Retire the outgoing worker's heartbeat rows, in two explicit steps.
 *
 *   capture --runtime-instance-id <id>        BEFORE the container is stopped
 *   retire  --census <file> --container-stopped   AFTER it is proven stopped
 *
 * Two steps, not one, because the safety of the whole operation rests on
 * comparing the database against a picture taken while the worker was still
 * running. A single-shot command would have nothing to compare against and
 * would degrade into "mark these rows stopped", which is the unsafe version.
 *
 * `--container-stopped` is a required, explicit assertion. This process can see
 * the database and not the container runtime, so the caller that CAN see it has
 * to say so out loud; leaving it implicit would let a live worker be retired by
 * forgetting a flag rather than by asserting a falsehood.
 */
import fs from "node:fs";
import { configureOperationalScriptRuntime } from "./_operational-runtime";
import {
  captureOutgoingWorkerCensus,
  discoverOnlineWorkerInstance,
  retireStoppedSyncWorker,
  WorkerRetirementRefusal,
  type OutgoingWorkerCensus,
} from "@/lib/sync/worker-retirement";

function usage() {
  console.log(
    [
      "usage:",
      "  node --import tsx scripts/sync-worker-retire.ts capture (--runtime-instance-id <id> | --online-instance) [--out <file>]",
      "  node --import tsx scripts/sync-worker-retire.ts retire --census <file> --container-stopped --container-finished-at <iso> [--wait-for-held-work-seconds <n>] [--heartbeat-interval-ms <n>]",
    ].join("\n"),
  );
}

function argValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${name}`);
  }
  return value;
}

async function main() {
  configureOperationalScriptRuntime();
  const argv = process.argv.slice(2);
  const mode = argv[0];

  if (!mode || mode === "--help" || mode === "-h") {
    usage();
    process.exit(mode ? 0 : 1);
  }

  if (mode === "capture") {
    // Either name the worker explicitly, or ask for the one that is online.
    // Discovery refuses on zero or on more than one, so `--online-instance` is
    // not a looser form of the same request — it is the same assertion made
    // against the database instead of against the caller's memory.
    const runtimeInstanceId = argv.includes("--online-instance")
      ? await discoverOnlineWorkerInstance()
      : argValue(argv, "--runtime-instance-id");
    if (!runtimeInstanceId) {
      throw new Error("capture requires --runtime-instance-id <id> or --online-instance");
    }
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId });
    const payload = JSON.stringify(census, null, 2);
    const out = argValue(argv, "--out");
    if (out) fs.writeFileSync(out, `${payload}\n`, { mode: 0o600 });
    console.log(payload);
    process.exit(0);
  }

  if (mode === "retire") {
    const censusPath = argValue(argv, "--census");
    if (!censusPath) throw new Error("retire requires --census <file>");
    // Absent flag means absent assertion, and an absent assertion is a refusal.
    const containerStopped = argv.includes("--container-stopped");
    const census = JSON.parse(fs.readFileSync(censusPath, "utf8")) as OutgoingWorkerCensus;
    // A runner lease is renewed while working and lapses on its own within a
    // couple of minutes of the worker stopping, so the caller may budget a wait
    // for THOSE EXACT ROWS to reach zero. Absent, the default is no wait at all:
    // waiting is a deliberate decision with a budget the caller owns.
    const waitSecondsRaw = argValue(argv, "--wait-for-held-work-seconds");
    const waitSeconds = waitSecondsRaw == null ? 0 : Number(waitSecondsRaw);
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
      throw new Error("--wait-for-held-work-seconds must be a non-negative number");
    }
    // The container's exact exit time. Required: "stopped" cannot bound WHEN the
    // worker last wrote, and a graceful shutdown legitimately writes after the
    // census was taken. Without this the proof cannot distinguish a write made
    // while shutting down from one made after the process was gone.
    const containerFinishedAt = argValue(argv, "--container-finished-at");
    if (!containerFinishedAt) {
      throw new Error("retire requires --container-finished-at <iso> (docker inspect .State.FinishedAt)");
    }
    const intervalRaw = argValue(argv, "--heartbeat-interval-ms");
    const heartbeatIntervalMs = intervalRaw == null ? undefined : Number(intervalRaw);
    if (heartbeatIntervalMs != null && (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0)) {
      throw new Error("--heartbeat-interval-ms must be a positive number");
    }
    const result = await retireStoppedSyncWorker({
      census,
      containerStopped,
      containerFinishedAt,
      heartbeatIntervalMs:
        heartbeatIntervalMs ??
        (process.env.WORKER_HEARTBEAT_INTERVAL_MS
          ? Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS)
          : undefined),
      waitForHeldWorkMs: Math.round(waitSeconds * 1000),
    });
    console.log(JSON.stringify({ pass: true, ...result }, null, 2));
    process.exit(0);
  }

  throw new Error(`unknown mode: ${mode}`);
}

main().catch((error) => {
  if (error instanceof WorkerRetirementRefusal) {
    console.log(
      JSON.stringify({ pass: false, reason: error.reason, message: error.message, ...error.detail }, null, 2),
    );
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
});
