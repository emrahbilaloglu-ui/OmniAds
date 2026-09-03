/**
 * D088 — the replay is hash-bound, two-laned, and honest about zero.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  D088_PINNED_INPUTS,
  D088_REPLAY_CUTOFFS,
  buildD088Replay,
} from "@/scripts/audits/d088-budget-counterfactual-replay";

const report = buildD088Replay(process.cwd());

describe("D088 replay — bound to frozen inputs by content", () => {
  it("pins every input by full SHA-256, and they all match", () => {
    expect(D088_PINNED_INPUTS.length).toBeGreaterThanOrEqual(3);
    for (const input of D088_PINNED_INPUTS) {
      expect(input.sha256, input.key).toMatch(/^[0-9a-f]{64}$/);
    }
    // The build above already verified them; reaching here is the proof.
    expect(report.inputs).toEqual(D088_PINNED_INPUTS);
  });

  it("REFUSES to produce a cell when a pinned input drifts", () => {
    const dir = mkdtempSync(join(tmpdir(), "d088-replay-"));
    try {
      for (const input of D088_PINNED_INPUTS) {
        cpSync(input.path, join(dir, input.path), { force: true });
      }
      const censusPath = join(dir, D088_PINNED_INPUTS[0]!.path);
      const census = JSON.parse(readFileSync(censusPath, "utf8")) as {
        businesses: Array<Record<string, unknown>>;
      };
      census.businesses[0]!.roleAccountScoped = 999;
      writeFileSync(censusPath, JSON.stringify(census), "utf8");
      expect(() => buildD088Replay(dir)).toThrowError(/not the pinned/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("D088 replay — two lanes, never mixed", () => {
  it("replays all six businesses across more than one cutoff", () => {
    const names = new Set(report.cells.map((c) => c.business));
    for (const expected of [
      "IwaStore", "Grandmix", "Bilsem Zeka", "TheSwaf", "IwaTR", "ColorFullWorldsTR",
    ]) {
      expect(names, expected).toContain(expected);
    }
    expect(D088_REPLAY_CUTOFFS.length).toBeGreaterThan(1);
  });

  it("keeps the assumption lane out of production authority", () => {
    const production = report.cells.filter((c) => c.lane === "production-authority");
    expect(production.length).toBe(18);
    // Not one production cell claims a determinable budget fact.
    expect(production.every((c) => c.determinable === false)).toBe(true);
    expect(production.every((c) => c.ownerGrain === null)).toBe(true);
    for (const cell of production) {
      expect(cell.refusals).toContain("no_retained_canonical_budget_fact");
      expect(cell.refusals).toContain("no_fresh_provider_baseline_in_replay");
    }
  });

  it("exercises BOTH owner grains and BOTH directions in the assumption lane", () => {
    const assumption = report.totals["counterfactual-assumption"];
    expect(assumption.campaign).toBeGreaterThan(0);
    expect(assumption.adset).toBeGreaterThan(0);
    expect(assumption.increase).toBeGreaterThan(0);
    expect(assumption.decrease).toBeGreaterThan(0);
  });

  it("would write in NO cell of EITHER lane", () => {
    expect(report.totals["production-authority"].wouldWrite).toBe(0);
    expect(report.totals["counterfactual-assumption"].wouldWrite).toBe(0);
    expect(report.cells.every((c) => c.wouldWrite === false)).toBe(true);
  });

  it("catches every assumption cell on the default-off gate, by name", () => {
    expect(report.guardrailCatches["d087:automation_disabled"])
      .toBe(report.totals["counterfactual-assumption"].cells);
  });

  it("reports activation as NOT ready, with its named conditions", () => {
    expect(report.activationVerdict.ready).toBe(false);
    expect(report.activationVerdict.blockers).toContain("global_gate_closed");
    expect(report.activationVerdict.blockers).toContain("budget_mode_not_auto");
  });

  it("says plainly why zero is a measurement", () => {
    expect(report.honesty).toMatch(/no per-entity canonical budget fact/);
    expect(report.honesty).toMatch(/describe the code, never an account/);
  });

  it("opens no database handle and names no provider host", () => {
    const source = readFileSync(
      "scripts/audits/d088-budget-counterfactual-replay.ts", "utf8");
    for (const forbidden of ["getDb(", "graph.facebook.com", "fetch(", "DATABASE_URL"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
