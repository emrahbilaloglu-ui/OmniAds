import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * A route module may only export what Next.js accepts.
 *
 * WHY THIS TEST EXISTS. `app/api/meta/copies/route.ts` exported a pure helper
 * so a test could assert the mapping directly instead of inferring it from a
 * rendered string — a good reason with the wrong home. Typecheck passed, the
 * whole vitest suite passed, lint passed, and the production build failed:
 *
 *   Type error: Route "app/api/meta/copies/route.ts" does not match the
 *   required types of a Next.js Route.
 *     "resolveCopiesRowsObservedAt" is not a valid Route export field.
 *
 * `next build` is the only gate that catches it, and it is the slowest and
 * last one to run. That is a poor place to learn it. This test moves the same
 * finding into the ordinary suite, where it costs a few milliseconds.
 *
 * TYPE exports are fine and deliberately allowed: they are erased before the
 * module exists at runtime, which is why the build named only the function.
 */

const ALLOWED_VALUE_EXPORTS = new Set([
  // Handlers.
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  // Segment config Next.js reads off the module.
  "dynamic",
  "dynamicParams",
  "revalidate",
  "fetchCache",
  "runtime",
  "preferredRegion",
  "maxDuration",
  "generateStaticParams",
]);

/** `export const X`, `export function X`, `export async function X`. */
const VALUE_EXPORT = /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

function routeFiles(): string[] {
  const listed = execFileSync(
    "git",
    ["ls-files", "app/**/route.ts", "app/**/route.tsx"],
    { encoding: "utf8" },
  );
  return listed.split("\n").map((line) => line.trim()).filter(Boolean);
}

describe("every API route exports only what Next.js accepts", () => {
  const files = routeFiles();

  it("finds the route modules at all", () => {
    // Guards the guard: a glob that silently matches nothing would make every
    // assertion below vacuously true.
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)("%s exports no non-Next value", (file) => {
    const source = readFileSync(file, "utf8");
    const offenders: string[] = [];
    for (const match of source.matchAll(VALUE_EXPORT)) {
      const name = match[1];
      if (!ALLOWED_VALUE_EXPORTS.has(name)) offenders.push(name);
    }
    expect(
      offenders,
      `${file} exports ${offenders.join(", ")}. Next.js rejects any non-verb ` +
        `value export on a route module and the production build fails. Move ` +
        `the symbol to a sibling file and import it here.`,
    ).toEqual([]);
  });
});
