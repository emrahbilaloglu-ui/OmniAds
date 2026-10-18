import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("guards the exact cron invocation and exercises the real Linux overlap lock", () => {
  const result = spawnSync("python3", [path.resolve("scripts/operator/test_sync_cron_call_lifecycle.py"), "-v"], {
    encoding: "utf8", timeout: 20_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("OK");
  expect(result.stdout).not.toContain("owned-test-token");
  if (process.platform === "linux") {
    expect(result.stdout).toContain("legacy-concurrent=2 guarded-concurrent=1 later-tick=retained log=preserved no-network=true");
    expect(result.stderr).not.toContain("skipped");
  }
});
