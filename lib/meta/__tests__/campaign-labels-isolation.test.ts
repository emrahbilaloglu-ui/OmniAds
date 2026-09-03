import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D074 static guard: the manual campaign-label data layer is frozen
 * evaluation/migration evidence. Live runtime must never read or write
 * `meta_campaign_labels` / `meta_campaign_label_history`, and no live module
 * may import `@/lib/meta/campaign-labels`. Replay/simulation/seam scripts
 * under `scripts/` are the only allowed importers (plus tests and the module
 * itself); type-only imports of the deserialization shapes come from
 * `@/lib/meta/campaign-label-types`, which stays importable.
 */

const RUNTIME_DIRS = ["app", "components", "lib"] as const;

/**
 * Files allowed to reference the frozen module. Tests are allowed (they pin
 * the frozen behavior); `campaign-label-guard.ts` imports only the
 * deserialization TYPE via `campaign-label-types`, not this module, and is
 * listed defensively for its type-only `MetaCampaignLabel` usage.
 */
const ALLOWED = new Set<string>([
  join("lib", "meta", "campaign-labels.ts"),
  join("lib", "meta", "campaign-labels.test.ts"),
  join("lib", "meta", "__tests__", "campaign-labels-isolation.test.ts"),
]);

const IMPORT_PATTERN =
  /from\s+["'](?:@\/lib\/meta\/campaign-labels|(?:\.{1,2}\/)+campaign-labels)["']/;
const TABLE_PATTERN = /\bmeta_campaign_labels\b|\bmeta_campaign_label_history\b/;

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      // The archive is import-blocked separately (PR14) and node_modules is
      // not source.
      if (entry === "node_modules" || path === join("lib", "archive")) {
        return [];
      }
      return listFiles(path);
    }
    return stats.isFile() && /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || path.includes(`${join("__tests__", "")}`);
}

describe("D074 manual campaign-label isolation", () => {
  const files = RUNTIME_DIRS.flatMap((dir) => listFiles(dir));

  it("no live runtime module imports @/lib/meta/campaign-labels", () => {
    const offenders = files.filter((path) => {
      if (ALLOWED.has(path)) return false;
      if (isTestFile(path)) return false;
      return IMPORT_PATTERN.test(readFileSync(path, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("no live runtime SQL touches the manual label tables", () => {
    const offenders = files.filter((path) => {
      if (ALLOWED.has(path)) return false;
      if (isTestFile(path)) return false;
      // Schema history (migrations + verification) legitimately names the
      // tables; it defines them without granting any decision authority.
      if (
        path === join("lib", "migrations.ts") ||
        path === join("lib", "migration-verification.ts")
      ) {
        return false;
      }
      const source = readFileSync(path, "utf8");
      if (!TABLE_PATTERN.test(source)) return false;
      // Comments explaining the removal are fine; executable references are
      // not. Keep this heuristic strict: any non-comment line naming the
      // tables fails.
      return source
        .split("\n")
        .some(
          (line) =>
            TABLE_PATTERN.test(line) &&
            !line.trimStart().startsWith("//") &&
            !line.trimStart().startsWith("*"),
        );
    });
    expect(offenders).toEqual([]);
  });

  /*
    PRE-DEPLOY AUDIT — `playwright/` runs against a REAL database.

    The scan above covers app/components/lib only, so two live statements
    against the frozen tables sat outside every guard: an INSERT that seeded a
    manual label no surface reads any more, and a DDL RENAME used as fault
    injection. Playwright specs are not "tests" for this purpose — they
    execute SQL against a database — so they are scanned for MUTATION, which
    is the thing the freeze forbids. A SELECT there stays allowed: reading the
    frozen tables as historical evidence is exactly what they are for.
  */
  it("no playwright spec MUTATES the frozen manual-label tables", () => {
    const specs = listFiles("playwright");
    const MUTATION = new RegExp(
      String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO|`
      + String.raw`ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE)\s+`
      + String.raw`(?:"?public"?\.)?"?meta_campaign_label(?:s|_history)"?`,
      "i",
    );
    const offenders = specs.filter((path) => {
      const source = readFileSync(path, "utf8");
      if (!TABLE_PATTERN.test(source)) return false;
      return source
        .split("\n")
        .some((line) =>
          MUTATION.test(line)
          && !line.trimStart().startsWith("//")
          && !line.trimStart().startsWith("*"));
    });
    expect(offenders).toEqual([]);
  });

  it("the frozen module is strictly read-only: no writer export, no transaction import, no mutation SQL", () => {
    const source = readFileSync(join("lib", "meta", "campaign-labels.ts"), "utf8");
    const executable = source
      .split("\n")
      .filter(
        (line) =>
          !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"),
      )
      .join("\n");

    // The manual write implementation is REMOVED, not merely unreachable.
    expect(executable).not.toMatch(/\bwriteMetaCampaignLabels\b/);
    expect(executable).not.toMatch(/\brunDbTransaction\b/);
    // SELECT-only historical evaluation is the entire allowed surface.
    expect(executable).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO)\s+meta_campaign_label(?:s|_history)\b/i,
    );
    // Belt and braces: no mutation verb ahead of either table name anywhere
    // in one executable statement, even reformatted.
    expect(executable).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b[^;`]{0,200}\bmeta_campaign_label/i,
    );
  });

  it("no module anywhere re-exports a manual label writer", () => {
    /*
      EXECUTABLE LINKAGE, NOT PROSE.

      This scanned for any textual occurrence of the writer's name, so it fired
      on `lib/meta/commercial-anchor-panel.test.ts` — a file that contains the
      token only inside its OWN forbidden-call list, i.e. a test enforcing this
      very rule. A guard that cannot tell a re-export from a file saying "must
      not re-export" reports the wrong thing while the real rule goes unchecked.

      The rule itself is UNCHANGED and no manual label path is restored: an
      import, a re-export, an export of the name, or a call of it is still an
      offence anywhere in the tree. Only comments and string literals are
      stripped first, and the positive controls below prove the detector still
      catches every real shape.
    */
    // Comments only: module SPECIFIERS are string literals, so a blanket
    // `export * from "…/campaign-labels"` is only visible before they are erased.
    const stripComments = (text: string) => text
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    // ...and identifiers are matched with literals erased, so a file that merely
    // QUOTES the name is not mistaken for one that reaches it.
    const stripAll = (text: string) => stripComments(text)
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");

    const reachesLabelWriter = (text: string): boolean => {
      const withSpecifiers = stripComments(text);
      const code = stripAll(text);
      return (
        // import { writeMetaCampaignLabels } / import writeMetaCampaignLabels from …
        /\bimport\b[^;]{0,400}\bwriteMetaCampaignLabels\b/.test(code)
        // export { writeMetaCampaignLabels } — the re-export this test is named for
        || /\bexport\s*\{[^}]*\bwriteMetaCampaignLabels\b/.test(code)
        // export function/const writeMetaCampaignLabels
        || /\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+writeMetaCampaignLabels\b/.test(code)
        // export * from the frozen module — a blanket re-export of whatever it has
        || /\bexport\s+\*[^;]{0,200}from\s*["'][^"']*campaign-labels["']/.test(withSpecifiers)
        // an actual call
        || /\bwriteMetaCampaignLabels\s*\(/.test(code)
        // require(...) followed by a member reference
        || /\brequire\s*\([^)]*\)[^;]{0,80}\bwriteMetaCampaignLabels\b/.test(code)
      );
    };

    /*
      This guard file is excluded from its own scan, and only this one.

      It necessarily CONTAINS every shape it forbids — that is what the positive
      controls below are — so scanning itself would make the guard permanently
      red for the wrong reason. The exclusion is exact and named rather than a
      pattern that could quietly cover other files.
    */
    const SELF = "lib/meta/__tests__/campaign-labels-isolation.test.ts";
    const scanned = files.filter((path) => !path.replace(/\\/g, "/").endsWith(SELF));
    expect(scanned.length, "the self-exclusion must remove exactly one file")
      .toBe(files.length - 1);
    const offenders = scanned.filter((path) => reachesLabelWriter(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);

    // POSITIVE CONTROLS — every real linkage shape is still caught.
    for (const real of [
      'import { writeMetaCampaignLabels } from "@/lib/meta/campaign-labels";',
      'import writeMetaCampaignLabels from "./campaign-labels";',
      "export { writeMetaCampaignLabels };",
      "export { writeMetaCampaignLabels } from \"./campaign-labels\";",
      "export async function writeMetaCampaignLabels(rows) { return rows; }",
      "export const writeMetaCampaignLabels = () => {};",
      'export * from "@/lib/meta/campaign-labels";',
      "await writeMetaCampaignLabels(db, rows);",
      'const m = require("./campaign-labels"); m.writeMetaCampaignLabels(rows);',
    ]) {
      expect(reachesLabelWriter(real), `missed: ${real}`).toBe(true);
    }
    // NEGATIVE CONTROLS — naming the forbidden thing is not doing it.
    for (const prose of [
      '// writeMetaCampaignLabels must never be re-exported',
      'expect(source).not.toMatch(/writeMetaCampaignLabels/);',
      'for (const call of ["writeMetaCampaignLabels"]) {}',
      "/* the writeMetaCampaignLabels implementation was removed in D074 */",
    ]) {
      expect(reachesLabelWriter(prose), `false positive: ${prose}`).toBe(false);
    }
  });

  it("the tombstone route stays a 410 with no DB import", () => {
    const route = readFileSync(
      join("app", "api", "meta", "campaign-labels", "route.ts"),
      "utf8",
    );
    expect(route).toContain("410");
    expect(route).toContain("campaign_labels_retired");
    expect(route).not.toMatch(/from\s+["']@\/lib\/db["']/);
    expect(route).not.toMatch(IMPORT_PATTERN);
  });

  /*
    PRE-DEPLOY AUDIT — the two claims the six guards above do NOT make.

    Everything above is about the DATA layer: the frozen module, its tables,
    its writer, the tombstone. None of it says anything about a screen. A UI
    that still offered "mark this campaign as Test" would satisfy every
    assertion above right up to the moment the request 410'd, and the operator
    would be looking at a control that cannot work.

    So: no live module may CALL the retired endpoint, and no live module may
    carry a manual-label write verb at all. Both are stated over the same
    walked file set the guards above use, so a new file is covered the day it
    is written rather than the day someone remembers to list it.
  */
  it("no live module calls the retired label endpoint", () => {
    const callers = files.filter((path) => {
      if (isTestFile(path)) return false;
      if (path === join("app", "api", "meta", "campaign-labels", "route.ts")) return false;
      return /["'`][^"'`]*\/api\/meta\/campaign-labels/.test(readFileSync(path, "utf8"));
    });
    expect(callers).toEqual([]);
  });

  it("no live module carries a manual-label write verb", () => {
    /*
      The names the removed product used, plus the shapes a re-introduction
      would most plausibly take. `MetaCampaignLabelInput` is included on
      purpose: it is the request body of the write that was removed, and a
      live module accepting it is a writer whether or not it says so.
    */
    const WRITE_VERBS = [
      "writeMetaCampaignLabels",
      "upsertMetaCampaignLabel",
      "setMetaCampaignLabel",
      "saveCampaignLabel",
      "updateCampaignLabel",
      "deleteCampaignLabel",
      "MetaCampaignLabelInput",
    ];
    /*
      `campaign-label-types.ts` DECLARES the removed write body, which the
      frozen module re-exports for the seam scripts. A declaration is not a
      writer, so the name is exempt THERE and only there — and the assertion
      below proves that file cannot become one: no database handle, and no
      function beyond the pure predicates it ships.
    */
    const DECLARING_FILE = join("lib", "meta", "campaign-label-types.ts");
    const offenders: string[] = [];
    for (const path of files) {
      if (isTestFile(path)) continue;
      if (ALLOWED.has(path)) continue;
      const source = readFileSync(path, "utf8");
      for (const verb of WRITE_VERBS) {
        if (path === DECLARING_FILE && verb === "MetaCampaignLabelInput") continue;
        if (new RegExp(`\\b${verb}\\b`).test(source)) {
          offenders.push(`${path}: ${verb}`);
        }
      }
    }
    expect(offenders).toEqual([]);

    // The exemption's own precondition.
    const types = readFileSync(DECLARING_FILE, "utf8");
    expect(types).not.toMatch(/from\s+["']@\/lib\/db["']/);
    expect(types).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect([...types.matchAll(/export function (\w+)/g)].map((m) => m[1]).sort()).toEqual([
      "isMetaCampaignKind",
      "isMetaCampaignLabelSource",
      "isMetaCampaignTestDimension",
      "labelKindDisplay",
      "testDimensionDisplay",
    ]);
  });

  /*
    And the ONE place a manual label is still allowed to appear at runtime: a
    serialized card from an older payload. It is provenance, never authority.
    `cardCampaignRoleStatus` folds it fail-closed — a legacy-only "labeled"
    renders UNRESOLVED — and that behaviour is pinned in
    components/creatives/briefing/card-utils.test.tsx. Asserted here as a
    SOURCE property so the two files cannot drift apart silently: the fold
    must keep refusing to return the canonical value from the legacy one.
  */
  it("the legacy card status is folded fail-closed, never promoted", () => {
    const source = readFileSync(
      join("components", "creatives", "briefing", "card-utils.tsx"),
      "utf8",
    );
    const fold = source.slice(source.indexOf("export function cardCampaignRoleStatus"));
    const body = fold.slice(0, fold.indexOf("\n}"));
    // The legacy value may be read, compared and used to answer "no campaign".
    // It may NEVER be the returned status on its own.
    expect(body).toContain("const legacy = card.campaignLabelStatus ?? null;");
    expect(body).not.toMatch(/return\s+legacy\s*;/);
    expect(body).toContain('if (legacy === "no_campaign") return "no_campaign";');
    expect(body).toContain('return "unresolved";');
  });
});
