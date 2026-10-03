import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/** Column-level literal consumer ledger, including the two operator readers
 * omitted from the older table-level ledger. This is not transitive/live census. */
const ledger = [
  ["app/api/creatives/decision-engine-v3/evidence/route.ts", "reader", 5],
  ["lib/creative-decision-engine/ad-evaluation-schema.ts", "ddl", 2],
  ["lib/creative-decision-engine/evaluation-store.ts", "inline-writer-schema", 8],
  ["lib/creative-decision-engine/jobs/ad-decision-outcomes-job.ts", "reader", 4],
  ["lib/creative-decision-engine/native-campaign-context-storage.ts", "central-accessor-ddl", 4],
  ["lib/migrations.ts", "ddl", 2],
  ["scripts/audits/d078-lattice-seed.ts", "fixture", 1],
  ["scripts/creative-decision-center/native-ad-account-aov-authority-replay.ts", "reader", 5],
  ["scripts/creative-decision-center/native-ad-natural-wave-operational-verifier.ts", "reader", 2],
  ["scripts/ephemeral-postgres-migrations-check.ts", "fixture", 3],
  ["scripts/ephemeral-postgres-native-ad-decision-seam.ts", "fixture", 2],
  ["scripts/ephemeral-postgres-native-ad-fact-ownership-seam-child.ts", "fixture", 1],
  ["scripts/ephemeral-postgres-state-history-compaction-seam-child.ts", "fixture", 1],
  ["scripts/manual-cut-refusal-seam.ts", "fixture", 1],
  ["scripts/native-archive-production-schema-seam.ts", "fixture", 1],
  ["scripts/native-calibration-parent-archive-seam.ts", "fixture", 1],
  ["scripts/native-campaign-context-storage-seam.ts", "fixture", 5],
] as const;
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (["node_modules", ".next", "archive", "__tests__"].includes(entry.name)) return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : /\.(?:tsx?|mts|cts)$/.test(entry.name) && !entry.name.includes(".test.") ? [full] : [];
  });
}
function validate(actual: Map<string, string>): string[] {
  const expected = new Map(ledger.map(([path, role, count]) => [path, { role, count }]));
  const issues: string[] = [];
  for (const [path, content] of actual) {
    const count = (content.match(/\bcampaign_context_json\b/g) ?? []).length;
    if (!count) continue;
    const declared = expected.get(path as typeof ledger[number][0]);
    if (!declared || count !== declared.count) issues.push(`${path}: unclassified/changed column references`);
    if (declared?.role === "reader" && (!content.includes('nativeCampaignContextSql("evaluation")') ||
      /\b(?:evaluation|ev|e)\.campaign_context_json\b/.test(content))) issues.push(`${path}: raw native SQL read`);
  }
  for (const [path] of ledger) if (!actual.has(path)) issues.push(`${path}: declared source missing`);
  return issues;
}
describe("campaign context column consumers", () => {
  const actual = new Map(["app", "components", "lib", "scripts"].flatMap(root => sources(join(process.cwd(), root)))
    .map(path => [relative(process.cwd(), path), readFileSync(path, "utf8")] as const));
  it("accounts for active column references and all four native readers", () => expect(validate(actual)).toEqual([]));
  it("a new raw reader fails closure", () => {
    const changed = new Map(actual); changed.set("lib/new-undeclared-native-reader.ts", "SELECT campaign_context_json FROM engine_v3_ad_decision_evaluations");
    expect(validate(changed)).toContain("lib/new-undeclared-native-reader.ts: unclassified/changed column references");
  });
  it("a raw read introduced in a declared reader also fails", () => {
    const changed = new Map(actual), path = "app/api/creatives/decision-engine-v3/evidence/route.ts";
    changed.set(path, changed.get(path)! + "\nSELECT evaluation.campaign_context_json;");
    expect(validate(changed)).toContain(`${path}: raw native SQL read`);
  });
  it("outcomes fail closed rather than manufacture an empty context", () => {
    const content = actual.get("lib/creative-decision-engine/jobs/ad-decision-outcomes-job.ts")!;
    expect(content).toContain("campaignContext: requireNativeCampaignContext(row.campaign_context_json)");
    expect(content).not.toContain("record(row.campaign_context_json) ?? {}");
  });
});
