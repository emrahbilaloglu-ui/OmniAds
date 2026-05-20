import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_DIR = "lib/creative-decision-center";
const SOURCE_FILES = [
  "contracts.ts",
  "validators.ts",
  "invariants.ts",
  "adapter.ts",
  "index.ts",
].map((file) => join(SOURCE_DIR, file));
const RUNTIME_DIRS = [
  "app",
  "components",
  "lib/creative-decision-engine",
  "lib/meta",
  "scripts/creative-decision-center",
];

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
    const forbidden = [
      /from\s+["']@\/lib\/creative-decision-engine/,
      /from\s+["']@\/lib\/meta/,
      /from\s+["']@\/app/,
      /from\s+["']@\/components/,
      /from\s+["']@\/lib\/archive/,
      /\bdecideCreative\b/,
      /\bfinalizeDecision\b/,
      /\benforceHardActionEligibility\b/,
      /\bapplyCreativeCampaignLabelGuard\b/,
      /\bDecisionOutput\b/,
      /\bDecisionLabel\b/,
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

    const matches = SOURCE_FILES.flatMap((path) =>
      forbidden
        .filter((pattern) => fileContains(path, pattern))
        .map((pattern) => `${path}:${pattern.source}`),
    );

    expect(matches).toEqual([]);
  });

  it("is not imported by active runtime or probe paths in PR4", () => {
    const files = RUNTIME_DIRS.flatMap(listFiles).filter((path) =>
      /\.(ts|tsx|mts|cts)$/.test(path),
    );
    const importPattern = /@\/lib\/creative-decision-center/;
    const matches = files.filter((path) => fileContains(path, importPattern));

    expect(matches).toEqual([]);
  });
});
