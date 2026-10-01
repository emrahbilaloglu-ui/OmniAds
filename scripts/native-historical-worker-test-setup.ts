import { spawnSync } from "node:child_process";

/** Every CI shard builds the same worker source before its tests. No test case,
 * timeout or coverage is reduced, and no provider/archive connection is made. */
export default function setup() {
  const child = spawnSync(process.execPath, ["scripts/build-native-historical-worker.mjs"], {
    cwd: process.cwd(), stdio: "pipe", encoding: "utf8", timeout: 30_000,
  });
  if (child.status !== 0) throw new Error("Packaged historical worker build failed: " + child.stderr);
}
