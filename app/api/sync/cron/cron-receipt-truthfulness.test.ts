import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The scheduled cron is the only thing that runs sync in production, and its
 * response is the only receipt anyone ever sees. Two things were untrue in it:
 *
 *  1. An unreadable business list answered `ok:true, synced:0` with HTTP 200 —
 *     identical to a healthy cycle over zero businesses. A total sync outage
 *     was therefore indistinguishable from an idle one, and because the early
 *     return also skipped the gate/repair block, the mechanism that would later
 *     surface the outage stopped running at the same moment.
 *  2. `synced` was `businesses.length` — the size of the INPUT list. Thirteen
 *     businesses whose every lane threw still reported `synced: 13`.
 *
 * Asserted against the source because these are properties of which expression
 * is used, and route.test.ts mocks the reader — a mock cannot show that the
 * count came from the input rather than the outcomes.
 */
const source = fs.readFileSync(
  path.join(process.cwd(), "app/api/sync/cron/route.ts"),
  "utf8",
);

describe("sync cron receipt", () => {
  it("uses the fail-closed reader, not the one that swallows to an empty list", () => {
    expect(source).toContain("readActiveBusinesses");
    expect(
      source,
      "getActiveBusinesses() collapses an unreadable list into [], which is the defect",
    ).not.toMatch(/getActiveBusinesses\s*\(/);
  });

  it("never catches the business-list read into an empty array", () => {
    expect(source).not.toMatch(/readActiveBusinesses\(\)\s*\.catch/);
    expect(source).not.toMatch(/return\s*\[\]\s*as\s*Awaited/);
  });

  it("answers a failed read with ok:false and a non-2xx status", () => {
    const branch = source.slice(
      source.indexOf("if (!businessRead.ok)"),
      source.indexOf("const businesses = businessRead.businesses"),
    );
    expect(branch, "expected a fail-closed branch for an unreadable list").toBeTruthy();
    expect(branch).toContain("ok: false");
    expect(branch).toContain("business_list_unreadable");
    expect(branch).toMatch(/status:\s*503/);
  });

  it("still treats a genuine empty list as a success", () => {
    const branch = source.slice(
      source.indexOf("if (businesses.length === 0)"),
      source.indexOf("const results = await Promise.allSettled"),
    );
    expect(branch).toContain("ok: true");
    expect(branch).toContain("No active businesses.");
    expect(branch, "a genuine zero must not become a 503").not.toMatch(/status:\s*5\d\d/);
  });

  it("counts synced from outcomes, never from the size of the input list", () => {
    expect(
      source,
      "`synced: businesses.length` reports attempts as successes",
    ).not.toMatch(/synced:\s*businesses\.length/);
    expect(source).toMatch(/synced:\s*succeeded/);
    expect(source).toMatch(/const\s+succeeded\s*=\s*attempted\s*-\s*failed/);
  });

  it("reports partial failures instead of burying them in results[]", () => {
    expect(source).toContain("laneFailures");
    expect(source).toContain("businessFailures");
    expect(source).toMatch(/attempted,/);
    expect(source).toMatch(/failed,/);
  });
});
