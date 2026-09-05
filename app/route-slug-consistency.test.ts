/**
 * Two dynamic segments at one path must share a slug name, or nothing boots.
 *
 * Reproduced on 2026-09-05 by starting the app for the first time since the
 * activation route was added: `intents/[id]` and `intents/[intentId]` are the
 * same position in the router, and Next refuses the whole build —
 *
 *   Error: You cannot use different slug names for the same dynamic path
 *   ('id' !== 'intentId').
 *
 * Not one page failed; the server exited during startup. Every unit test still
 * passed, typecheck passed, and `scripts/meta/verify-mounted-bodies.ts` passed,
 * because an import graph can reach a module that the router will never mount.
 * The only thing that catches this is either booting the app or reading the
 * directory names, and reading them costs milliseconds.
 */
import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";

const APP_ROOT = path.join(process.cwd(), "app");

/** Every directory whose children include more than one `[slug]` name. */
function collectConflicts(dir: string, rel: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const directories = entries.filter((entry) => entry.isDirectory());
  const dynamic = directories
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("[") && name.endsWith("]"))
    // A catch-all and an optional catch-all are different positions from a
    // plain segment, so they are compared within their own kind.
    .map((name) => ({
      name,
      kind: name.startsWith("[[") ? "optional_catch_all"
        : name.startsWith("[...") ? "catch_all" : "single",
      slug: name.replace(/^\[+\.{0,3}/, "").replace(/\]+$/, ""),
    }));
  for (const kind of ["single", "catch_all", "optional_catch_all"]) {
    const slugs = new Set(
      dynamic.filter((entry) => entry.kind === kind).map((entry) => entry.slug),
    );
    if (slugs.size > 1) {
      out.push(`${rel || "app"}: ${[...slugs].sort().join(" vs ")}`);
    }
  }
  for (const entry of directories) {
    if (entry.name === "node_modules") continue;
    collectConflicts(
      path.join(dir, entry.name),
      rel ? `${rel}/${entry.name}` : entry.name,
      out,
    );
  }
}

describe("the app router can actually mount every route", () => {
  it("never gives one dynamic position two slug names", () => {
    const conflicts: string[] = [];
    collectConflicts(APP_ROOT, "", conflicts);
    /*
      A failure here is not a style issue. The app does not start: no page, no
      API route, no health check. Rename one of the directories so both
      positions agree, and update the handler's `params` type with it.
    */
    expect(conflicts).toEqual([]);
  });
});
