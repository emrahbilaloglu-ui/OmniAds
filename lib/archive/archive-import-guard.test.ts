import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const scanRoots = ["app", "components", "lib", "src", "scripts"];
const archiveRoot = path.join(repoRoot, "lib", "archive");
const importPattern = /\bfrom\s+["']([^"']+)["']/g;

function isTsFile(filePath: string) {
  return filePath.endsWith(".ts") || filePath.endsWith(".tsx");
}

function isInsideArchive(filePath: string) {
  const relative = path.relative(archiveRoot, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const entries = readdirSync(root);
  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    if (isInsideArchive(fullPath)) continue;
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (stats.isFile() && isTsFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function resolveImport(fromFile: string, specifier: string) {
  if (specifier.startsWith("@/")) {
    return path.resolve(repoRoot, specifier.slice(2));
  }
  if (specifier.startsWith("lib/archive/")) {
    return path.resolve(repoRoot, specifier);
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return path.resolve(path.dirname(fromFile), specifier);
  }
  return null;
}

function resolvesToArchive(fromFile: string, specifier: string) {
  const resolved = resolveImport(fromFile, specifier);
  if (!resolved) return false;
  const relative = path.relative(archiveRoot, resolved);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

describe("archive import guard", () => {
  it("prevents serving files from importing lib/archive", () => {
    const violations: string[] = [];
    const files = scanRoots.flatMap((root) => walkFiles(path.join(repoRoot, root)));

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? "";
        if (!resolvesToArchive(file, specifier)) continue;
        violations.push(`${path.relative(repoRoot, file)} -> ${specifier}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
