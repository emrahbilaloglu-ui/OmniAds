// D077 static isolation guard: the compaction executor must be unreachable
// from app runtime, never scheduled, and the evidence/plan paths must be
// provably read-only.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const EXECUTOR_SPECIFIER = "state-history-compaction-executor";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "archive")
      continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("D077 state-history compaction isolation", () => {
  const files = [
    ...walk(join(ROOT, "app")),
    ...walk(join(ROOT, "components")),
    ...walk(join(ROOT, "lib")),
  ];

  it("no app runtime, component, or lib module imports the executor", () => {
    const allowed = new Set([
      "lib/meta/state-history-compaction-executor.ts",
      "lib/meta/__tests__/state-history-compaction-isolation.test.ts",
    ]);
    // Import statements only: a comment may legitimately NAME the executor
    // (the planner's header does) without making it reachable.
    const importPattern = new RegExp(
      String.raw`(from\s+["'][^"']*${EXECUTOR_SPECIFIER}|import\(\s*["'][^"']*${EXECUTOR_SPECIFIER}|require\(\s*["'][^"']*${EXECUTOR_SPECIFIER})`,
    );
    const offenders = files.filter((file) => {
      const rel = relative(ROOT, file);
      if (allowed.has(rel)) return false;
      if (/\.test\.tsx?$/.test(rel)) return false;
      return importPattern.test(readFileSync(file, "utf8"));
    });
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it("nothing schedules the executor: no cron/schedule surface names it and no npm script executes it", () => {
    const scheduleSuspects = files.filter((file) =>
      /cron|schedule/i.test(relative(ROOT, file)),
    );
    for (const file of scheduleSuspects) {
      expect(readFileSync(file, "utf8")).not.toContain(EXECUTOR_SPECIFIER);
    }
    const packageJson = readFileSync(join(ROOT, "package.json"), "utf8");
    expect(packageJson).not.toContain("state-history-compaction-cli");
  });

  it("the readiness surfaces read measurements only — no executor, no token, no mutation affordance", () => {
    const route = readFileSync(
      join(ROOT, "app/api/admin/engine-v3/readiness/route.ts"),
      "utf8",
    );
    expect(route).not.toContain(EXECUTOR_SPECIFIER);
    const helper = readFileSync(
      join(ROOT, "lib/meta/state-history-compaction-readiness.ts"),
      "utf8",
    );
    expect(helper).not.toContain(EXECUTOR_SPECIFIER);
    expect(helper).not.toContain("expectedApprovalToken");
    expect(helper).toContain("NOT_EXECUTED");
    // Journal-read provenance: unreadable is never presented as empty.
    expect(helper).toContain("UNKNOWN_JOURNAL_UNAVAILABLE");
    expect(helper).toContain("compaction_journal_read_unavailable");
    // Business-scoped journal read, parameterized — never a global latest-N.
    expect(helper).toContain("$1 = ANY(business_ids)");
    // The withdrawn hard-coded deployment assertion must not return; the
    // D075 evidence is measured from manifest_kind presence.
    expect(helper).not.toContain("d075_delta_manifests_not_deployed");
    expect(helper).toContain("manifest_kind IS NOT NULL");
    const view = readFileSync(
      join(
        ROOT,
        "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
      ),
      "utf8",
    );
    expect(view).not.toContain(EXECUTOR_SPECIFIER);
    expect(view).not.toContain("expectedApprovalToken");
    expect(view).not.toContain("planStateHistoryCompaction");
  });

  it("the CLI plan path is transaction-enforced read-only and the execute path demands the approval trio", () => {
    const cli = readFileSync(
      join(ROOT, "scripts/state-history-compaction-cli.ts"),
      "utf8",
    );
    expect(cli).toContain(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(cli).toContain("--approval-token");
    expect(cli).toContain("--acknowledge-physical-shrink-required");
    expect(cli).toContain("--business-ids");
  });

  it("the planner refuses a writable session in its own code, not only in the CLI", () => {
    const planner = readFileSync(
      join(ROOT, "lib/meta/state-history-compaction.ts"),
      "utf8",
    );
    expect(planner).toContain("SHOW transaction_read_only");
    expect(planner).toContain("SHOW transaction_isolation");
    expect(planner).toContain(
      "refuses to run outside a READ ONLY transaction",
    );
    expect(planner).toContain(
      "refuses to run outside a REPEATABLE READ transaction",
    );
    // The planner must never contain a mutation STATEMENT (statement-position
    // keyword; "ON DELETE RESTRICT" in comments is fine).
    expect(planner).not.toMatch(/^\s*(DELETE|UPDATE|INSERT|TRUNCATE)\s/m);
  });

  it("the production evidence bundle script is read-only enforced", () => {
    const bundle = readFileSync(
      join(
        ROOT,
        "scripts/creative-decision-center/h11b-context-lifecycle-bundle.ts",
      ),
      "utf8",
    );
    expect(bundle).toContain("SET TRANSACTION READ ONLY");
  });
});
