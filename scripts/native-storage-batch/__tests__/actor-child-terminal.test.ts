import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTOR_FILE } from "../production-transport";

describe("production actor child terminal evidence and read-only TOAST observation dispatch", () => {
  it("keeps a bounded {type, code, sqlState} without inventing or leaking anything, and never dispatches a TOAST VACUUM", () => {
    const run = spawnSync("python3", [join(__dirname, "actor-child-terminal.harness.py"), ACTOR_FILE], { encoding: "utf8", timeout: 60_000 });
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(out.failures).toEqual([]);
    expect(run.status).toBe(0);
    expect(out.checks).toBeGreaterThanOrEqual(25);
  });
});
