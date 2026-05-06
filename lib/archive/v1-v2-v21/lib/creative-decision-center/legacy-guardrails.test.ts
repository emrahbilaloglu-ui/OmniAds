import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    const stats = statSync(path);

    if (stats.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|jsx?)$/.test(entry) ? [path] : [];
  });
}

describe("Creative Decision Center legacy migration guardrails", () => {
  it("keeps the first migration route name and legacy snapshot modules in place", () => {
    expect(existsSync("app/api/creatives/decision-os/route.ts")).toBe(true);
    expect(existsSync("lib/creative-decision-os.ts")).toBe(true);
    expect(existsSync("lib/creative-decision-os-v2.ts")).toBe(true);
    expect(existsSync("lib/creative-operator-policy.ts")).toBe(true);
    expect(existsSync("lib/creative-operator-surface.ts")).toBe(true);
    expect(existsSync("lib/operator-surface.ts")).toBe(true);
  });

  it("keeps the additive API field and does not rename decisionOs to a legacy key", () => {
    const snapshotsSource = readFileSync("lib/creative-decision-os-snapshots.ts", "utf8");
    const routeSource = readFileSync("app/api/creatives/decision-os/route.ts", "utf8");

    expect(snapshotsSource).toMatch(/\bdecisionOs:/);
    expect(snapshotsSource).toMatch(/\bdecisionCenter:/);
    expect(snapshotsSource).not.toMatch(/\blegacyDecisionOs\b/);
    expect(routeSource).not.toMatch(/\blegacyDecisionOs\b/);
  });

  it("prevents Creative UI code from computing buyer actions or emitting row-level aggregate actions", () => {
    const files = [
      ...sourceFiles("app/(dashboard)/creatives"),
      ...sourceFiles("components/creatives"),
    ];
    const offenders = files.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      const issues: string[] = [];
      if (/\bbuyerAction\s*[:=]/.test(source)) issues.push("buyerAction compute shape");
      if (source.includes("brief_variation")) issues.push("row aggregate literal");
      return issues.map((issue) => `${path}: ${issue}`);
    });

    expect(offenders).toEqual([]);
  });
});
