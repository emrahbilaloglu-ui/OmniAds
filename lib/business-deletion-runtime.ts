import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { DbGrowthFenceRefusal, evaluateDbGrowthFence } from "@/lib/sync/db-growth-fence";
import { runBusinessDeletionWorkerTick } from "@/lib/business-deletion-jobs";

export async function runAdmittedBusinessDeletionTick() {
  assertSyncLaneEnabled("assignment_mutation");
  // Fresh physical proof, without an override. Erasure may reduce stored data
  // when a logical growth budget refuses; it grants no provider/retention work.
  const capacity = await evaluateDbGrowthFence();
  if (capacity.physical?.admitted !== true || capacity.overridden
    || !capacity.allowed && !["database_budget_exceeded","table_budget_exceeded"].includes(capacity.reason))
    throw new DbGrowthFenceRefusal(capacity, "business_erasure");
  return runBusinessDeletionWorkerTick();
}

export function createBusinessDeletionProcessor(run: () => Promise<unknown> = runAdmittedBusinessDeletionTick, intervalMs = 15_000) {
  let stopped = false, inFlight = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try { await run(); }
    catch { console.error("[business erasure] background admission/execution unavailable"); }
    finally { inFlight = false; }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

export function startBusinessDeletionProcessor() {
  if (process.env.NODE_ENV !== "production" || process.env.NEXT_PHASE === "phase-production-build"
    || process.env.SYNC_WORKER_MODE === "1") return;
  const global = globalThis as typeof globalThis & { __businessDeletionProcessor?: () => void };
  global.__businessDeletionProcessor ??= createBusinessDeletionProcessor();
}
