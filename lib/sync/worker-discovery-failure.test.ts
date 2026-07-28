import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The durable worker read its business list with
 * `getActiveBusinesses(...).catch(() => [])`.
 *
 * A failed read therefore became "there are no businesses": the worker looped
 * forever doing nothing while every liveness surface stayed green. It kept
 * heartbeating `idle`, so `online_workers` counted it and the container
 * healthcheck — which asserts heartbeat freshness, never progress — passed
 * throughout a total sync outage. Nothing logged, because the swallow was
 * silent.
 *
 * Asserted against the source because the defect IS the absence of a branch:
 * the existing worker tests mock every dependency, so a reader that resolves to
 * [] is indistinguishable from a healthy idle tick inside them.
 */
const source = fs.readFileSync(
  path.join(process.cwd(), "lib/sync/worker-runtime.ts"),
  "utf8",
);

function stripComments(input: string): string {
  return input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const code = stripComments(source);

describe("worker business discovery", () => {
  it("uses the fail-closed reader, not the one that collapses errors to an empty list", () => {
    expect(code).toContain("readActiveBusinesses");
    expect(
      code,
      "getActiveBusinesses() returns [] on an unreadable schema, which is the defect",
    ).not.toMatch(/getActiveBusinesses\s*\(/);
  });

  it("never catches the business read into an empty array", () => {
    expect(code).not.toMatch(/readActiveBusinesses\([^)]*\)[\s\S]{0,80}?\.catch\(\s*\(\)\s*=>\s*\[\]/);
    expect(code).not.toMatch(/getActiveBusinesses\([\s\S]{0,120}?\.catch/);
  });

  it("branches on the failed read and skips the tick", () => {
    expect(code).toContain("businessRead.ok");
    expect(code).toContain("business_discovery_failed");
  });

  it("does not heartbeat a healthy status when discovery failed", () => {
    // Letting the heartbeat go stale is the honest signal — the status enum has
    // no value meaning "alive but unable to discover work", and writing `idle`
    // is exactly what made a total outage look healthy.
    const branch = code.slice(
      code.indexOf("if (!businessRead.ok)"),
      code.indexOf("const businesses = businessRead.businesses"),
    );
    expect(branch.length, "expected a discovery-failure branch").toBeGreaterThan(0);
    expect(branch).not.toContain("heartbeat(");
    expect(branch).toContain("continue");
  });
});
