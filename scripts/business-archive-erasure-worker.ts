import { writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertSafeArchiveDirectory } from "../lib/business-archive-configuration";
import { runBusinessArchiveErasureTick } from "../lib/business-archive-erasure-worker";
import { DbGrowthFenceRefusal } from "../lib/sync/db-growth-fence";

const control = dirname(process.env.ENGINE_V3_NATIVE_ARCHIVE_ACTIVE_POINTER ?? "/run/adsecute-business-erasure/active.json");
await assertSafeArchiveDirectory(control);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { stopping = true; });
while (!stopping) {
  let outcome: string, reason: string | null = null;
  try { outcome = (await runBusinessArchiveErasureTick()).outcome; }
  catch(error) { outcome = "admission_unavailable";
    const code=error instanceof DbGrowthFenceRefusal?error.decision.reason:"measurement_or_gate_unavailable";
    reason=/^[a-z][a-z0-9_]{0,80}$/.test(code)?code:"measurement_or_gate_unavailable";
    console.error("[business archive erasure] admission unavailable",{reason}); }
  const pending = join(control, "health.pending"), health = { contract: "business-archive-erasure-health.v1",
    buildId: process.env.APP_BUILD_ID, observedAt: new Date().toISOString(), outcome, reason };
  await writeFile(pending, JSON.stringify(health), { mode: 0o600 }); await rename(pending, join(control, "health.json"));
  if (!stopping) await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); process.removeListener("SIGTERM", done); process.removeListener("SIGINT", done); resolve(); };
    const timer = setTimeout(done, 15_000);
    process.once("SIGTERM", done); process.once("SIGINT", done);
  });
}
