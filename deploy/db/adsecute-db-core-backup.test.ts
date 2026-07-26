import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(
  process.cwd(),
  "deploy/db/adsecute-db-core-backup.sh",
);
const script = readFileSync(scriptPath, "utf8");

describe("database core backup contract", () => {
  it("remains valid Bash", () => {
    const result = spawnSync("bash", ["-n", scriptPath], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("backs up the normalized provider connection identity and credentials", () => {
    for (const table of [
      "public.provider_accounts",
      "public.provider_connections",
      "public.integration_credentials",
      "public.business_provider_accounts",
    ]) {
      expect(script).toContain(table);
    }
    expect(script).not.toContain("\n  public.integrations\n");
    expect(script).not.toContain("\n  public.provider_account_assignments\n");
    expect(script).toContain("--strict-names");
  });

  it("writes portable checksums that survive the atomic directory rename", () => {
    expect(script).toContain('cd "$TMP_DIR"');
    expect(script).toContain(
      "sha256sum core-data.dump schema.sql globals.sql",
    );
    expect(script).not.toContain(
      'sha256sum "$TMP_DIR/core-data.dump"',
    );
  });
});
