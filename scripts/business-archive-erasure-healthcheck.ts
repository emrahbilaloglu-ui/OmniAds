import { dirname, join } from "node:path";
import { readSafeArchiveFile } from "../lib/business-archive-configuration";
async function main(){
const control = dirname(process.env.ENGINE_V3_NATIVE_ARCHIVE_ACTIVE_POINTER ?? "/run/adsecute-business-erasure/active.json");
const health = JSON.parse((await readSafeArchiveFile(join(control, "health.json"), 4096)).toString("utf8"));
if (health.contract !== "business-archive-erasure-health.v1" || health.buildId !== process.env.APP_BUILD_ID
  || health.buildId !== process.env.ADSECUTE_IMAGE_BUILD_ID || !Number.isFinite(Date.parse(health.observedAt))
  || Date.now() - Date.parse(health.observedAt) < 0 || Date.now() - Date.parse(health.observedAt) > 180_000) process.exit(1);
}
void main().catch(()=>{process.exitCode=1;});
