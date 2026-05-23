import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_DIR = "lib/creative-decision-center";
const V3_BRIDGE_FILE = join(SOURCE_DIR, "v3-bridge.ts");
const SOURCE_FILES = [
  "contracts.ts",
  "validators.ts",
  "invariants.ts",
  "adapter.ts",
  "snapshot-builder.ts",
  "index.ts",
  "v3-bridge.ts",
].map((file) => join(SOURCE_DIR, file));
const RUNTIME_DIRS = [
  "app",
  "components",
  "lib/creative-decision-engine",
  "lib/meta",
  "scripts/creative-decision-center",
];
/**
 * PR7A allowlist: the briefing API route consumes the snapshot builder to
 * emit the additive `decisionCenter` response shape behind an explicit
 * `?decisionCenter=1` flag. The briefing response type imports
 * `DecisionCenterSnapshot` as a type-only contract so callers can read it
 * without forcing UI consumption. The matching test mirrors the same set so
 * route-test stubs survive the isolation sweep. Every other file under
 * RUNTIME_DIRS must keep its hands off the center module.
 */
const ALLOWED_RUNTIME_IMPORTERS = new Set<string>([
  "app/api/creatives/briefing/route.ts",
  "app/api/creatives/briefing/route.test.ts",
  "components/creatives/briefing/types.ts",
]);

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) return listFiles(path);
    return stats.isFile() ? [path] : [];
  });
}

function fileContains(path: string, pattern: RegExp): boolean {
  return pattern.test(readFileSync(path, "utf8"));
}

describe("Creative Decision Center PR4 module isolation", () => {
  it("does not import runtime, archive, DB, network, or file mutation modules", () => {
    const commonForbidden = [
      /from\s+["']@\/lib\/meta/,
      /from\s+["']@\/app/,
      /from\s+["']@\/components/,
      /from\s+["']@\/lib\/archive/,
      /\bdecideCreative\b/,
      /\bfinalizeDecision\b/,
      /\benforceHardActionEligibility\b/,
      /\bapplyCreativeCampaignLabelGuard\b/,
      /\bGateContext\b/,
      /\bAccountDecisionProfile\b/,
      /\bCreativeInput\b/,
      /\bwriteFile\b/,
      /\bappendFile\b/,
      /\bcreateWriteStream\b/,
      /\bfetch\(/,
      /\bgetDb\b/,
      /\bdrizzle\b/,
      /\bnew Pool\b/,
      /\bpostgres\b/,
      /process\.env/,
    ];

    const matches = SOURCE_FILES.flatMap((path) => {
      const forbidden =
        path === V3_BRIDGE_FILE
          ? [
              ...commonForbidden,
              /import\s+(?!type\b)[\s\S]*?from\s+["']@\/lib\/creative-decision-engine/,
              /from\s+["']@\/lib\/creative-decision-engine(?!\/types["'])/,
            ]
          : [
              ...commonForbidden,
              /from\s+["']@\/lib\/creative-decision-engine/,
              /\bDecisionOutput\b/,
              /\bDecisionLabel\b/,
            ];

      return forbidden
        .filter((pattern) => fileContains(path, pattern))
        .map((pattern) => `${path}:${pattern.source}`);
    });

    expect(matches).toEqual([]);
  });

  it("allows only type-only V3 type imports inside the isolated bridge", () => {
    const source = readFileSync(V3_BRIDGE_FILE, "utf8");

    expect(source).toMatch(
      /import type[\s\S]*?from\s+["']@\/lib\/creative-decision-engine\/types["']/,
    );
    expect(source).not.toMatch(
      /import\s+(?!type\b)[\s\S]*?from\s+["']@\/lib\/creative-decision-engine/,
    );
    expect(source).not.toMatch(
      /\b(decideCreative|finalizeDecision|enforceHardActionEligibility|applyCreativeCampaignLabelGuard)\b/,
    );
  });

  it("is not imported by active runtime or probe paths outside the PR7A allowlist", () => {
    const files = RUNTIME_DIRS.flatMap(listFiles).filter((path) =>
      /\.(ts|tsx|mts|cts)$/.test(path),
    );
    const importPattern = /@\/lib\/creative-decision-center/;
    const matches = files
      .filter((path) => fileContains(path, importPattern))
      .filter((path) => !ALLOWED_RUNTIME_IMPORTERS.has(path));

    expect(matches).toEqual([]);
  });

  it("keeps every PR7A allowlisted runtime importer on disk so the test can detect drift", () => {
    for (const path of ALLOWED_RUNTIME_IMPORTERS) {
      expect(existsSync(path), `missing allowlisted importer: ${path}`).toBe(true);
    }
  });

  it("does not let UI components other than the typed response interface consume the center module", () => {
    const componentImporters = listFiles("components")
      .filter((path) => /\.(ts|tsx|mts|cts)$/.test(path))
      .filter((path) => fileContains(path, /@\/lib\/creative-decision-center/));
    const unexpected = componentImporters.filter(
      (path) => !ALLOWED_RUNTIME_IMPORTERS.has(path),
    );
    expect(unexpected).toEqual([]);
    // Defensive: even the allowlisted components/briefing/types.ts must only
    // import the public response types. A future component file that adds adapter,
    // validator, invariant, or version-constant imports here would be a UI
    // compute leak.
    const briefingTypes = "components/creatives/briefing/types.ts";
    if (existsSync(briefingTypes)) {
      const source = readFileSync(briefingTypes, "utf8");
      expect(source).toMatch(
        /import type[\s\S]*?\{[\s\S]*?DecisionCenterSnapshot[\s\S]*?\}[\s\S]*?from\s+["']@\/lib\/creative-decision-center["']/,
      );
      expect(source).toMatch(
        /import type[\s\S]*?\{[\s\S]*?CreativeDecisionCenterRowDecision[\s\S]*?\}[\s\S]*?from\s+["']@\/lib\/creative-decision-center["']/,
      );
      expect(source).not.toMatch(
        /\b(adaptCreativeDecisionToRow|adaptCreativeDecisionsToRows|assembleDecisionCenterSnapshot|validateDecisionCenterSnapshot|validateCreativeDecisionCenterRowDecision|auditDecisionCenterSnapshotInvariants|auditCreativeDecisionCenterRowInvariants|bridgeV3DecisionToV21|bridgeV3DecisionToAdapterInput|CREATIVE_DECISION_CENTER_ADAPTER_VERSION|CREATIVE_DECISION_CENTER_SNAPSHOT_BUILDER_VERSION|CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION)\b/,
      );
    }
  });
});
