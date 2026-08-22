/**
 * WP16 item 4 — prove a surface body is reachable from a route, by module graph.
 *
 * The pattern this exists to catch is the one the master plan's §5.1 keeps
 * finding: a body that is written, tested and reachable by nobody. Three
 * confirmed instances so far —
 *
 *   - `components/zero-base/meta/decisions/decisions-client.tsx` held the ONLY
 *     caller of the decision-workflow endpoint (finding 14, fixed in WP8);
 *   - `components/zero-base/manage/manage-clients.tsx` is the only consumer of
 *     `saveProviderAssignments` and no route mounts it (found in WP3);
 *   - `components/creatives/briefing/CreativesBriefingPage.tsx` renders a
 *     hardcoded window label nobody can see (found in WP5).
 *
 * A grep cannot answer this. A module can be imported by a test, by a sibling
 * that is itself unmounted, or by a barrel nothing pulls — and all three look
 * like "it is imported". So this walks the real import graph from every
 * `page`/`layout`/`route` file under `app/`, following relative and
 * `@/`-aliased specifiers including dynamic `import()`, and reports which of
 * the registry's declared `mountedBody` files it reaches.
 *
 * Test files are deliberately NOT roots and are not followed. A body reachable
 * only from a test is precisely the defect.
 *
 * Run: `npx tsx scripts/meta/verify-mounted-bodies.ts`
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { META_SURFACES } from "@/lib/meta/surface-registry";

const ROOT = process.cwd();
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/** Every routable file under `app/` — the only real entry points. */
function routeEntryPoints(dir = path.join(ROOT, "app")): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...routeEntryPoints(full));
      continue;
    }
    if (isTestFile(entry)) continue;
    if (/^(page|layout|route|template|default)\.[jt]sx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/** Resolve an import specifier the way the tsconfig paths do. */
function resolveSpecifier(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? path.join(ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(from), specifier)
      : null;
  if (!base) return null; // A package. Not our graph.

  for (const candidate of [
    base,
    ...EXTENSIONS.map((extension) => `${base}${extension}`),
    ...EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
const DYNAMIC = /import\(\s*["']([^"']+)["']\s*\)/g;

function specifiersIn(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [IMPORT, DYNAMIC]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) found.push(match[1]!);
  }
  return found;
}

export function reachableFromRoutes(): Set<string> {
  const seen = new Set<string>();
  const queue = routeEntryPoints();
  for (const entry of queue) seen.add(entry);

  while (queue.length > 0) {
    const file = queue.pop()!;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const specifier of specifiersIn(source)) {
      const resolved = resolveSpecifier(file, specifier);
      if (!resolved || seen.has(resolved) || isTestFile(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return seen;
}

export function unmountedRegistryBodies(): string[] {
  const reachable = reachableFromRoutes();
  return META_SURFACES.filter(
    (surface) => !reachable.has(path.join(ROOT, surface.mountedBody)),
  ).map((surface) => `${surface.surfaceId} → ${surface.mountedBody}`);
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]!).endsWith("verify-mounted-bodies.ts");

if (invokedDirectly) {
  const unmounted = unmountedRegistryBodies();
  if (unmounted.length === 0) {
    console.log(
      `PASS: every registry mountedBody is reachable from a route (${META_SURFACES.length} surfaces).`,
    );
    process.exit(0);
  }
  console.error("FAIL: registry bodies no route can reach:");
  for (const entry of unmounted) console.error(`  - ${entry}`);
  process.exit(1);
}
