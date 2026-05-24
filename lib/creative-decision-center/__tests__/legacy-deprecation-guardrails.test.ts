import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

const ARCHIVE_DIR = "lib/archive/v1-v2-v21";
const ACTIVE_SCAN_DIRS = ["app", "components", "src", "lib"];
const SOURCE_FILE_PATTERN = /\.(ts|tsx|mts|cts)$/;
const FORBIDDEN_LEGACY_ALIASES = [
  "@/lib/creative-decision-os",
  "@/lib/creative-decision-os-v2",
  "@/lib/creative-decision-os-v2-preview",
  "@/lib/creative-decision-os-snapshots",
  "@/lib/creative-operator-policy",
  "@/lib/creative-operator-surface",
] as const;
const ARCHIVE_ALIAS = "@/lib/archive/v1-v2-v21";
const ARCHIVE_SENTINELS = [
  "lib/archive/v1-v2-v21/app/api/creatives/decision-os/route.ts",
  "lib/archive/v1-v2-v21/lib/creative-decision-os.ts",
  "lib/archive/v1-v2-v21/lib/creative-decision-os-v2.ts",
  "lib/archive/v1-v2-v21/lib/creative-decision-os-snapshots.ts",
  "lib/archive/v1-v2-v21/lib/creative-operator-policy.ts",
  "lib/archive/v1-v2-v21/lib/creative-operator-surface.ts",
  "lib/archive/v1-v2-v21/components/creatives/CreativeDecisionOsDrawer.tsx",
  "lib/archive/v1-v2-v21/components/creatives/CreativeDecisionOsDrawer.test.tsx",
  "lib/archive/v1-v2-v21/components/creatives/CreativeDecisionCenterSurface.tsx",
] as const;

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizePath(path: string): string {
  return toPosix(normalize(path));
}

function isUnderArchive(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === ARCHIVE_DIR || normalized.startsWith(`${ARCHIVE_DIR}/`);
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir) || isUnderArchive(dir)) return [];

  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) return listFiles(path);
    return stats.isFile() ? [normalizePath(path)] : [];
  });
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importExportPattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s*)?["']([^"']+)["']/g;
  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const pattern of [importExportPattern, dynamicImportPattern]) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

function aliasMatches(specifier: string, alias: string): boolean {
  return specifier === alias || specifier.startsWith(`${alias}/`);
}

function pathMatchesModule(path: string, modulePath: string): boolean {
  const normalized = normalizePath(path).replace(/\.(ts|tsx|mts|cts)$/, "");
  return normalized === modulePath || normalized.startsWith(`${modulePath}/`);
}

function isForbiddenSpecifier(file: string, specifier: string): boolean {
  if (aliasMatches(specifier, ARCHIVE_ALIAS)) return true;
  if (FORBIDDEN_LEGACY_ALIASES.some((alias) => aliasMatches(specifier, alias))) {
    return true;
  }

  if (!specifier.startsWith(".")) return false;

  const resolved = normalizePath(join(dirname(file), specifier));
  if (isUnderArchive(resolved)) return true;

  return FORBIDDEN_LEGACY_ALIASES.map((alias) => alias.replace("@/", "")).some(
    (modulePath) => pathMatchesModule(resolved, modulePath),
  );
}

describe("Creative Decision Center PR14 legacy deprecation guardrails", () => {
  it("keeps legacy V1/V2/operator files archived as compatibility sentinels", () => {
    for (const path of ARCHIVE_SENTINELS) {
      expect(existsSync(path), `missing archived sentinel: ${path}`).toBe(true);
    }
  });

  it("keeps archived legacy code outside active typecheck and test discovery", () => {
    const tsconfig = JSON.parse(read("tsconfig.json")) as { exclude?: string[] };
    expect(tsconfig.exclude).toContain("lib/archive/v1-v2-v21/**");
    expect(read("vitest.config.ts")).toContain('"lib/archive/v1-v2-v21/**"');
  });

  it("does not import legacy V1/V2/operator modules or archived modules from active source", () => {
    const matches = ACTIVE_SCAN_DIRS.flatMap(listFiles)
      .filter((path) => SOURCE_FILE_PATTERN.test(path))
      .filter((path) => !isUnderArchive(path))
      .flatMap((path) =>
        extractImportSpecifiers(read(path))
          .filter((specifier) => isForbiddenSpecifier(path, specifier))
          .map((specifier) => `${path} imports ${specifier}`),
      );

    expect(matches).toEqual([]);
  });

  it("preserves old snapshot compatibility fields in the archived response adapter", () => {
    const snapshots = read(
      "lib/archive/v1-v2-v21/lib/creative-decision-os-snapshots.ts",
    );

    expect(snapshots).toMatch(/decisionOs:\s*CreativeDecisionOsV1Response\s*\|\s*null/);
    expect(snapshots).toMatch(/decisionCenter:\s*DecisionCenterSnapshot\s*\|\s*null/);
    expect(snapshots).toContain(
      'decisionOs: snapshot?.status === "ready" ? snapshot.payload : null',
    );
    expect(snapshots).toContain("decisionCenter: input.decisionCenter ?? null");
  });

  it("preserves archived V2.1 empty-snapshot fallback copy for old render paths", () => {
    expect(
      read("lib/archive/v1-v2-v21/components/creatives/CreativeDecisionOsDrawer.tsx"),
    ).toContain(
      "No validated V2.1 actions are present in this snapshot. Legacy Decision OS remains available below.",
    );
    expect(
      read(
        "lib/archive/v1-v2-v21/components/creatives/CreativeDecisionOsDrawer.test.tsx",
      ),
    ).toContain("Legacy Decision OS remains available below.");
    expect(
      read(
        "lib/archive/v1-v2-v21/components/creatives/CreativeDecisionCenterSurface.tsx",
      ),
    ).toContain("Legacy Decision OS remains the active explanation surface.");
  });
});
