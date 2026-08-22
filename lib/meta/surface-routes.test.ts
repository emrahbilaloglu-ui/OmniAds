import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { getRailJumpTargets, getRailModel } from "@/components/layout/v2/nav-model";
import { dashboardHrefForRouteFamily } from "@/lib/dashboard-v2/screen-registry";
import { META_SURFACES, allSurfaceSpellings } from "@/lib/meta/surface-registry";

/**
 * T4 — route existence. "Zero 404s" as an assertion rather than a hope.
 *
 * Resolves a URL the way Next's App Router does, against the files on disk, so
 * a rail row pointing at a path no route serves fails here instead of being
 * found by an operator. This is exactly how `/platforms/meta/decisions` was
 * caught: it sat in the legacy→app translation table, translated cleanly, and
 * served a 404 because no directory backed it.
 */

/** `/app/**` is served by one catch-all that dispatches on the path segments. */
const APP_CATCHALL = "app/app/[[...path]]/page.tsx";

/**
 * Walk the `app/` tree the way the App Router does.
 *
 * Concrete segments win over dynamic ones, `(group)` directories are invisible
 * in the URL, and `[param]` matches any single segment. Written out rather than
 * string-matched because the two things that break here — a dynamic segment
 * (`[businessId]`) and a route group (`(dashboard)`) — are precisely the two
 * that make a naive `app/${path}/page.tsx` lookup report a real route missing.
 */
function resolveInTree(dir: string, segments: readonly string[]): string | null {
  if (segments.length === 0) {
    const page = `${dir}/page.tsx`;
    return existsSync(page) ? page : null;
  }
  const [head, ...rest] = segments as [string, ...string[]];

  const literal = `${dir}/${head}`;
  if (existsSync(literal)) {
    const found = resolveInTree(literal, rest);
    if (found) return found;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  // A dynamic segment matches this one. `[[...x]]` and `[...x]` swallow the
  // rest of the path; `[x]` takes exactly one.
  for (const entry of entries) {
    if (!entry.startsWith("[")) continue;
    const child = `${dir}/${entry}`;
    if (entry.startsWith("[[...") || entry.startsWith("[...")) {
      const page = `${child}/page.tsx`;
      if (existsSync(page)) return page;
      continue;
    }
    const found = resolveInTree(child, rest);
    if (found) return found;
  }

  // Route groups are directories that do not appear in the URL at all.
  for (const entry of entries) {
    if (!entry.startsWith("(") || !entry.endsWith(")")) continue;
    const found = resolveInTree(`${dir}/${entry}`, segments);
    if (found) return found;
  }

  return null;
}

function routeFileFor(urlPath: string): string | null {
  const path = urlPath.replace(/^\/+|\/+$/g, "");
  if (!path) return null;
  return resolveInTree("app", path.split("/"));
}

describe("every navigable Meta surface resolves to a route file", () => {
  it.each(allSurfaceSpellings())(
    "$kind $path ($surfaceId)",
    ({ path }) => {
      expect(routeFileFor(path), path).not.toBeNull();
    },
  );

  it("dispatches every /app alias inside the catch-all's table", async () => {
    // Existence of the catch-all is not enough: an alias it does not list falls
    // through to `notFound()`, which is a 404 with a 200-shaped route file.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(APP_CATCHALL, "utf8");
    for (const surface of META_SURFACES) {
      for (const alias of surface.aliases) {
        const key = alias.replace(/^\/app\/?/, "");
        if (!key || key.includes("[")) continue;
        expect(source, `${surface.surfaceId} → ${alias}`).toContain(`"${key}"`);
      }
    }
  });

  it("resolves every Meta rail href in all three route families", () => {
    const meta = getRailModel("en").platforms.find((p) => p.id === "meta")!;
    const families = [
      { here: "/c/biz_1/meta/decisions", label: "business-scoped" },
      { here: "/app/meta/decisions", label: "session-scoped" },
      { here: "/platforms/meta", label: "legacy" },
    ];

    for (const link of meta.children) {
      for (const family of families) {
        const href = dashboardHrefForRouteFamily(link.href, family.here);
        const path = href.split(/[?#]/, 1)[0]!;
        expect(
          routeFileFor(path),
          `${link.id} in ${family.label} family → ${path}`,
        ).not.toBeNull();
      }
    }
  });

  it("resolves every command-palette jump target", () => {
    // The palette is a navigation surface like any other; a target that 404s is
    // the same defect as a rail row that does.
    for (const target of getRailJumpTargets(getRailModel("en"))) {
      const path = target.href.split(/[?#]/, 1)[0]!;
      expect(routeFileFor(path), `${target.label} → ${path}`).not.toBeNull();
    }
  });
});
