import { runRawPayloadCompactionTick } from "../lib/sync/raw-payload-compaction";
import { writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertSafeArchiveDirectory } from "../lib/business-archive-configuration";
import { runBusinessArchiveErasureTick } from "../lib/business-archive-erasure-worker";
import { DbGrowthFenceRefusal } from "../lib/sync/db-growth-fence";
import { runNativeColdLifecycleTick } from "./native-cold-lifecycle/controller";
import { safeError } from "./native-storage-batch/common";

async function main(){
const control = dirname(process.env.ENGINE_V3_NATIVE_ARCHIVE_ACTIVE_POINTER ?? "/run/adsecute-business-erasure/active.json");
await assertSafeArchiveDirectory(control);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { stopping = true; });
while (!stopping) {
  let outcome: string, reason: string | null = null;
  let rawPayload: Awaited<ReturnType<typeof runRawPayloadCompactionTick>> | null = null;
  let heartbeat=Promise.resolve();
  const pulse=setInterval(()=>{heartbeat=heartbeat.then(async()=>{
    const path=join(control,"health.cold.pending");await writeFile(path,JSON.stringify({contract:"business-archive-erasure-health.v1",
      buildId:process.env.APP_BUILD_ID,observedAt:new Date().toISOString(),outcome:"finite_archive_operation",reason:null}),{mode:0o600});
    await rename(path,join(control,"health.json"));
  }).catch(()=>undefined);},15_000);
  try { outcome = (await runBusinessArchiveErasureTick()).outcome;
    if(outcome==="idle"&&!stopping)rawPayload=await runRawPayloadCompactionTick();
    if(outcome==="idle"&&!stopping)outcome=`cold_${(await runNativeColdLifecycleTick(()=>stopping)).outcome}`;
  }
  catch(error) { outcome = "admission_unavailable";
    const code=error instanceof DbGrowthFenceRefusal?error.decision.reason:safeError(error).code;
    reason=/^[A-Za-z0-9_:,-]{1,160}$/.test(code)?code:"measurement_or_gate_unavailable";
    console.error("[business archive erasure] admission unavailable",{reason}); }
  finally{clearInterval(pulse);await heartbeat;}
  const pending = join(control, "health.pending"), health = { contract: "business-archive-erasure-health.v1",
    buildId: process.env.APP_BUILD_ID, observedAt: new Date().toISOString(), outcome, reason,
    ...(rawPayload ? { rawPayload } : {}) };
  await writeFile(pending, JSON.stringify(health), { mode: 0o600 }); await rename(pending, join(control, "health.json"));
  if (!stopping) await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); process.removeListener("SIGTERM", done); process.removeListener("SIGINT", done); resolve(); };
    const timer = setTimeout(done, 15_000);
    process.once("SIGTERM", done); process.once("SIGINT", done);
  });
}
}
void main().catch(()=>{console.error("[business archive erasure] startup failed");process.exitCode=1;});
