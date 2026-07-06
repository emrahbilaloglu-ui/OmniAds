#!/usr/bin/env node
// HEAD-vs-deployed decision diff gate (read-only).
//
// Turns "these pending commits are deploy-safe" from a code-review judgment
// into a proof: the SAME serialized live inputs are evaluated by two engine
// checkouts and the guarded outputs must agree on label and confidence;
// badge differences must sit inside an explicit allowlist.
//
// Usage (three phases, orchestrated by the npm script or by hand):
//   --dump=/path/inputs.json            serialize live inputs (needs DB)
//   --evaluate=/path/inputs.json --out=/path/results.json   pure compute
//   --compare=/path/a.json,/path/b.json [--allowBadges=t1,t2]  diff gate
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CreativeCampaignLabelMap } from "@/lib/creative-decision-engine/campaign-label-guard";
import {
  applyCreativeCampaignLabelGuard,
  buildCreativeCampaignLabelMap,
  withCreativeCampaignLabelContext,
} from "@/lib/creative-decision-engine/campaign-label-guard";
import { decideCreative } from "@/lib/creative-decision-engine/engine";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  return (
    process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ??
    null
  );
}

function writeJson(path: string, value: unknown) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value)}\n`);
  return absolute;
}

async function dump(outPath: string) {
  // DB-touching imports stay inside the dump phase so the evaluate phase is
  // pure compute and runs identically in an old checkout.
  const { getDb, resetDbClientCache } = await import("@/lib/db");
  const { WarehouseDataSource } = await import(
    "@/lib/creative-decision-engine/data-source"
  );
  const { listEnabledBusinessIds } = await import(
    "@/lib/creative-decision-engine/feature-flags"
  );
  const { resolveAccountDecisionProfile } = await import(
    "@/lib/creative-decision-engine/account-decision-profile"
  );
  const { readMetaCampaignLabels } = await import("@/lib/meta/campaign-labels");
  const { configureOperationalScriptRuntime } = await import(
    "@/scripts/_operational-runtime"
  );
  configureOperationalScriptRuntime({ lane: "read_only_observation" });

  const asOf = arg("asOf") ?? new Date().toISOString().slice(0, 10);
  const source = new WarehouseDataSource();
  const businessIds = await listEnabledBusinessIds();
  const businesses = [] as unknown[];
  for (const businessId of businessIds) {
    const inputs = await source.listCreativeInputs({ businessId, asOf });
    const labels = await readMetaCampaignLabels({ businessId });
    const profile = await resolveAccountDecisionProfile({
      businessId,
      asOf,
      dataSource: source,
    });
    const dataHealth = await source.getDataHealth({ businessId, asOf });
    businesses.push({ businessId, inputs, labels, profile, dataHealth });
  }
  const path = writeJson(outPath, { asOf, businesses });
  console.log(JSON.stringify({ phase: "dump", asOf, path, businesses: businesses.length }));
  await resetDbClientCache();
  void getDb;
}

function evaluate(inputPath: string, outPath: string) {
  const fixture = JSON.parse(readFileSync(resolve(inputPath), "utf8")) as {
    asOf: string;
    businesses: Array<{
      businessId: string;
      inputs: Array<Record<string, unknown>>;
      labels: unknown[];
      profile: Record<string, unknown>;
      dataHealth: Record<string, unknown>;
    }>;
  };
  const results: Record<
    string,
    { label: string; confidence: number; badges: string[] }
  > = {};
  for (const business of fixture.businesses) {
    const map: CreativeCampaignLabelMap = buildCreativeCampaignLabelMap(
      business.labels as never,
    );
    for (const creativeInput of business.inputs) {
      const enriched = withCreativeCampaignLabelContext(
        creativeInput as never,
        map,
      );
      const guarded = applyCreativeCampaignLabelGuard({
        decision: decideCreative(
          enriched,
          business.profile as never,
          business.dataHealth as never,
        ),
        input: enriched,
        campaignLabelsById: map,
      });
      results[`${business.businessId}::${String(creativeInput.creativeId)}`] = {
        label: guarded.label,
        confidence: guarded.confidence,
        badges: guarded.badges.map((badge) => badge.type).sort(),
      };
    }
  }
  const path = writeJson(outPath, { engineVersion: ENGINE_VERSION, results });
  console.log(
    JSON.stringify({ phase: "evaluate", engineVersion: ENGINE_VERSION, path, decisions: Object.keys(results).length }),
  );
}

function compare(paths: string, allowBadgesCsv: string | null) {
  const [pathA, pathB] = paths.split(",");
  const a = JSON.parse(readFileSync(resolve(pathA), "utf8")) as {
    results: Record<string, { label: string; confidence: number; badges: string[] }>;
  };
  const b = JSON.parse(readFileSync(resolve(pathB), "utf8")) as {
    results: Record<string, { label: string; confidence: number; badges: string[] }>;
  };
  const allowedBadges = new Set(
    (allowBadgesCsv ?? "").split(",").map((item) => item.trim()).filter(Boolean),
  );
  const keys = new Set([...Object.keys(a.results), ...Object.keys(b.results)]);
  const labelDiffs: string[] = [];
  const confidenceDiffs: string[] = [];
  const badgeViolations: string[] = [];
  let allowedBadgeDiffs = 0;
  for (const key of keys) {
    const left = a.results[key];
    const right = b.results[key];
    if (!left || !right) {
      labelDiffs.push(`${key}: present in only one result set`);
      continue;
    }
    if (left.label !== right.label) {
      labelDiffs.push(`${key}: ${left.label} -> ${right.label}`);
    }
    if (left.confidence !== right.confidence) {
      confidenceDiffs.push(`${key}: ${left.confidence} -> ${right.confidence}`);
    }
    const leftSet = new Set(left.badges);
    const rightSet = new Set(right.badges);
    const added = right.badges.filter((badge) => !leftSet.has(badge));
    const removed = left.badges.filter((badge) => !rightSet.has(badge));
    for (const badge of [...added, ...removed]) {
      if (allowedBadges.has(badge)) allowedBadgeDiffs += 1;
      else badgeViolations.push(`${key}: badge diff ${badge}`);
    }
  }
  const pass =
    labelDiffs.length === 0 &&
    confidenceDiffs.length === 0 &&
    badgeViolations.length === 0;
  console.log(
    JSON.stringify(
      {
        phase: "compare",
        decisions: keys.size,
        pass,
        labelDiffs: labelDiffs.slice(0, 20),
        labelDiffCount: labelDiffs.length,
        confidenceDiffs: confidenceDiffs.slice(0, 20),
        confidenceDiffCount: confidenceDiffs.length,
        badgeViolations: badgeViolations.slice(0, 20),
        badgeViolationCount: badgeViolations.length,
        allowedBadgeDiffs,
        allowedBadges: [...allowedBadges],
      },
      null,
      2,
    ),
  );
  if (!pass) process.exitCode = 1;
}

async function main() {
  const dumpPath = arg("dump");
  const evaluatePath = arg("evaluate");
  const comparePaths = arg("compare");
  if (dumpPath) return dump(dumpPath);
  if (evaluatePath) {
    const outPath = arg("out");
    if (!outPath) throw new Error("--evaluate requires --out=<results.json>");
    return evaluate(evaluatePath, outPath);
  }
  if (comparePaths) return compare(comparePaths, arg("allowBadges"));
  throw new Error("one of --dump / --evaluate / --compare is required");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
