/**
 * Next.js instrumentation hook (runs once when the web server process starts).
 *
 * Keeps the web service's runtime-contract row in `sync_runtime_instances` fresh
 * on a timer. Without this the web only re-published its contract when a handful
 * of routes (/api/build-info, /api/meta/status, admin ops) happened to be hit,
 * so during traffic gaps the contract aged past the gate freshness window and
 * the release/deploy gates blocked with "Fresh web runtime contract instance was
 * not observed", which in turn restricted sync to canary businesses only.
 * The worker already self-publishes every few seconds from its loop; this makes
 * the web behave the same way instead of depending on external traffic.
 */
export async function register() {
  // Only run in the long-lived Node.js web server (not the edge runtime, and not
  // the durable worker process which publishes its own contract).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SYNC_WORKER_MODE === "1") return;

  const { assertRuntimeContractStartup, upsertRuntimeContractInstance } =
    await import("@/lib/sync/runtime-contract");

  const refreshMs = Math.max(
    30_000,
    Number(process.env.WEB_RUNTIME_CONTRACT_REFRESH_MS) || 120_000,
  );

  const publish = async () => {
    try {
      const contract = assertRuntimeContractStartup({ service: "web" });
      await upsertRuntimeContractInstance({ contract });
    } catch {
      // Best-effort: a transient miss is tolerated by the gate freshness window;
      // the next tick will re-publish.
    }
  };

  await publish();
  const timer = setInterval(publish, refreshMs);
  timer.unref?.();
}
