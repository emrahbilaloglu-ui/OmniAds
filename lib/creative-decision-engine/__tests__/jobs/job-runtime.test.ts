import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS } from "../../jobs/job-runtime";

const JOB_FILES = [
  "calibration-job.ts",
  "lifecycle-job.ts",
  "decisions-job.ts",
  "decision-outcomes-job.ts",
] as const;

describe("engine v3 job runtime contracts", () => {
  it("uses a scoped batch-job transaction timeout without changing the global DB timeout", () => {
    expect(ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS).toBe(30_000);

    for (const file of JOB_FILES) {
      const source = readFileSync(
        `lib/creative-decision-engine/jobs/${file}`,
        "utf8",
      );
      expect(source).toContain("ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS");
      expect(source).toContain(
        "timeoutMs: ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS",
      );
    }
  });

  it("keeps the transaction timeout local to the current job transaction", () => {
    const source = readFileSync("lib/db.ts", "utf8");

    expect(source).toContain("SET LOCAL statement_timeout");
    expect(source).toContain("buildLocalStatementTimeoutSql(timeoutMs)");
  });
});
