/**
 * D087 — the historical simulation reports what it can prove, and no more.
 */
import { describe, expect, it } from "vitest";

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  D087_CENSUS_PATH,
  D087_EXPECTED_CENSUS_SHA256,
  D087_SIMULATION_CUTOFFS,
  buildD087Simulation,
} from "@/scripts/audits/d087-budget-write-simulation";

const report = buildD087Simulation(process.cwd());

describe("D087 simulation — six real businesses, no fabricated eligibility", () => {
  it("replays every pinned business at every cutoff", () => {
    const names = new Set(report.cells.map((c) => c.business));
    for (const expected of [
      "IwaStore", "Grandmix", "Bilsem Zeka", "TheSwaf", "IwaTR", "ColorFullWorldsTR",
    ]) {
      expect(names, expected).toContain(expected);
    }
    expect(report.totals.cells).toBe(names.size * D087_SIMULATION_CUTOFFS.length);
  });

  it("reports ZERO eligible cells and says exactly why", () => {
    expect(report.totals.eligible).toBe(0);
    expect(report.whyNoEligibleCell).toMatch(/fresh provider baseline/);
    expect(report.whyNoEligibleCell).toMatch(/canonical budget fact/);
  });

  it("names a REASON for every not-determinable cell, never an empty verdict", () => {
    for (const cell of report.cells) {
      if (cell.determinable) continue;
      expect(cell.notDeterminableBecause.length, cell.business).toBeGreaterThan(0);
      for (const reason of cell.notDeterminableBecause) {
        expect(reason).toMatch(/^[a-z0-9_]+$/);
      }
    }
  });

  it("no cell is ever eligible while activation is off", () => {
    expect(report.cells.every((c) => c.eligible === false)).toBe(true);
  });

  it("reads the FROZEN census and rewrites nothing", () => {
    const before = readFileSync(D087_CENSUS_PATH, "utf8");
    buildD087Simulation(process.cwd());
    expect(readFileSync(D087_CENSUS_PATH, "utf8")).toBe(before);
  });

  it("C1: publishes the REAL sha256 of the accepted frozen census", () => {
    /*
      The previous field published the hex FILE LENGTH under a name that said
      sha256. A same-length edit would have passed it, which is the one thing a
      content hash exists to catch.
    */
    expect(report.censusSha256).toBe(D087_EXPECTED_CENSUS_SHA256);
    expect(report.censusSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(report)).not.toContain("censusSha256Prefix");
  });

  it("C1: REFUSES to produce a single cell from a tampered census", () => {
    const dir = mkdtempSync(join(tmpdir(), "d087-census-"));
    try {
      const target = join(dir, D087_CENSUS_PATH);
      cpSync(D087_CENSUS_PATH, target, { recursive: false, force: true, errorOnExist: false });
      // Only possible because cpSync created the parents; write a tampered copy.
      const original = JSON.parse(readFileSync(D087_CENSUS_PATH, "utf8")) as {
        businesses: Array<Record<string, unknown>>;
      };
      original.businesses[0]!.roleAccountScoped = 999;
      writeFileSync(target, JSON.stringify(original), "utf8");
      expect(() => buildD087Simulation(dir)).toThrowError(/not the accepted/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens no database handle and names no provider host", () => {
    const source = readFileSync("scripts/audits/d087-budget-write-simulation.ts", "utf8");
    for (const forbidden of ["getDb(", "graph.facebook.com", "fetch(", "DATABASE_URL"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
