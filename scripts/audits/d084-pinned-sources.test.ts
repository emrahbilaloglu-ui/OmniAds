import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  D084_PINNED_SOURCES,
  checkPinnedSources,
  extractAccountCurrency,
  extractBindings,
  extractConfigStates,
  extractDailySeries,
  extractOrigins,
  extractOwnerStates,
  extractPersistedDecisionCensus,
  extractResolvedTransitions,
  extractSourceClocks,
  extractTargetPackHistory,
  loadPinnedSources,
  retentionByEntity,
} from "@/scripts/audits/d084-pinned-sources";

const bundle = loadPinnedSources();

describe("r3 reads pinned bytes and nothing else", () => {
  it("imports no database client anywhere in the assembly path", () => {
    for (const file of [
      "scripts/audits/d084-pinned-sources.ts",
      "scripts/audits/d084-commercial-target-evidence.ts",
    ]) {
      const source = readFileSync(resolve(file), "utf8");
      // Only prose may mention it; no import, and no runtime handle.
      expect(source, file).not.toMatch(/^\s*import[^\n]*["']@\/lib\/db["']/m);
      expect(source, file).not.toMatch(/await import\(\s*["']@\/lib\/db["']/);
      expect(source, file).not.toMatch(/runDbTransaction|getDb\(/);
      expect(source, file).not.toMatch(/SET TRANSACTION|statement_timeout|REPEATABLE READ/);
    }
  });

  it("re-hashes every pinned source from disk rather than trusting a manifest", () => {
    const checks = checkPinnedSources();
    expect(checks).toHaveLength(D084_PINNED_SOURCES.length);
    for (const check of checks) {
      expect(check.matches, `${check.key} drifted`).toBe(true);
      expect(check.observedSha256).toBe(check.expectedSha256);
    }
    // Non-vacuity: a wrong reader must be caught.
    const forged = checkPinnedSources(() => Buffer.from("not the artifact"));
    expect(forged.every((c) => !c.matches)).toBe(true);
    expect(() => loadPinnedSources(() => Buffer.from("not the artifact"))).toThrow(/pinned source drifted/);
  });
});

describe("D080A already retained the daily series r2 went back to the database for", () => {
  const daily = extractDailySeries(bundle);

  it("carries the complete unfiltered fleet series, zero-spend rows included", () => {
    expect(daily.length).toBe(165_042);
    expect(daily.filter((d) => d.spend === 0).length).toBeGreaterThan(150_000);
    expect(new Set(daily.map((d) => d.businessId)).size).toBe(6);
    expect(new Set(daily.map((d) => d.providerAccountId)).size).toBe(7);
    expect(new Set(daily.map((d) => d.grain))).toEqual(new Set(["campaign", "adset"]));
  });

  it("carries owner lineage and raw budgets on every row", () => {
    expect(daily.every((d) => d.parentCampaignId !== null)).toBe(true);
    expect(daily.some((d) => d.dailyBudgetRaw !== null)).toBe(true);
  });

  it("supplies 1,634 of r2's 1,641 live rows with identical values", () => {
    const r2 = JSON.parse(
      readFileSync(resolve("docs/audits/generated/d084-commercial-target-evidence-2026-09-01.r2.json"), "utf8"),
    ) as { snapshot: { dailyDelivery: Array<Record<string, unknown>> } };
    const key = (b: unknown, a: unknown, g: unknown, e: unknown, d: unknown) => [b, a, g, e, d].join("|");
    const index = new Map(daily.map((r) => [key(r.businessId, r.providerAccountId, r.grain, r.entityId, r.date), r]));
    let matched = 0;
    let valueDifferences = 0;
    const only: string[] = [];
    for (const row of r2.snapshot.dailyDelivery) {
      const found = index.get(key(row.businessId, row.providerAccountId, row.grain, row.entityId, row.date));
      if (!found) { only.push(String(row.date)); continue; }
      matched += 1;
      if (found.spend !== row.spend || found.conversions !== row.conversions || found.revenue !== row.revenue) {
        valueDifferences += 1;
      }
    }
    expect(r2.snapshot.dailyDelivery).toHaveLength(1641);
    expect(matched).toBe(1634);
    expect(valueDifferences).toBe(0);
    // The seven r2-only rows are a retention gap, not a reason to re-read.
    expect(only).toHaveLength(7);
    expect(new Set(only)).toEqual(new Set(["2026-04-22"]));
  });

  it("reports actual retention per entity, which is what support is measured against", () => {
    const retention = retentionByEntity(daily);
    expect(retention.size).toBeGreaterThan(2000);
    for (const bounds of retention.values()) {
      expect(bounds.firstRetainedDate <= bounds.lastRetainedDate).toBe(true);
      // Nothing in the pinned series is dated after the pinned ceiling.
      expect(bounds.lastRetainedDate <= "2026-08-21").toBe(true);
    }
  });
});

describe("D080B retains the config lineage on BOTH clocks", () => {
  const config = extractConfigStates(bundle);

  it("carries an effective and a recorded clock on every row", () => {
    expect(config.length).toBe(11_623);
    expect(config.every((c) => c.effectiveFrom !== "")).toBe(true);
    expect(config.every((c) => c.capturedAt !== null)).toBe(true);
  });

  it("preserves the read lane rather than flattening it away", () => {
    expect(new Set(config.map((c) => c.lane))).toEqual(new Set(["strict_pit_authority"]));
  });
});

describe("the remaining pinned slices extract deterministically", () => {
  it("extracts owner states, clocks, bindings, currency, transitions, origins and packs", () => {
    expect(extractOwnerStates(bundle).length).toBe(462);
    expect(extractSourceClocks(bundle).length).toBeGreaterThan(0);
    expect(extractBindings(bundle)).toHaveLength(7);
    const currency = extractAccountCurrency(bundle);
    expect(Object.keys(currency)).toHaveLength(7);
    // Not one house currency: the fleet genuinely spans two.
    expect(new Set(Object.values(currency)).size).toBeGreaterThan(1);
    expect(extractResolvedTransitions(bundle)).toHaveLength(23);
    expect(extractOrigins(bundle)).toHaveLength(17);
    expect(extractTargetPackHistory(bundle)).toHaveLength(7);
    expect(extractPersistedDecisionCensus(bundle)).toHaveLength(6);
  });

  it("gives every transition a row identity that D080B's own key cannot", () => {
    const transitions = extractResolvedTransitions(bundle);
    // D080B's `key` is account|grain|entity: two transitions on one entity
    // share it, so it is an ENTITY key and merges rows when used as identity.
    expect(new Set(transitions.map((t) => t.sourceEntityKey)).size).toBe(21);
    expect(new Set(transitions.map((t) => t.sourceRowKey)).size).toBe(23);
  });

  it("is a pure function of the bytes: two extractions are identical", () => {
    const a = extractDailySeries(bundle);
    const b = extractDailySeries(loadPinnedSources());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
