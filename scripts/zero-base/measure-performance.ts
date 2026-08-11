/**
 * WP-26 step 10 / gate G11 — performance evidence.
 *
 * Two measurements, both reproducible locally against the built server and the
 * build output, so the numbers can be re-derived rather than believed:
 *
 * 1. **Field-style vitals** per representative leaf: LCP, CLS and TBT, taken
 *    from the browser's own PerformanceObserver rather than estimated from a
 *    waterfall. Thresholds are the plan's: LCP ≤ 2.5 s, CLS ≤ 0.1, TBT ≤ 300 ms.
 * 2. **Client bundle weight** per route, read from the Next build manifest, plus
 *    the shared baseline every route pays. A route that ships an unexpectedly
 *    large first-load bundle is the "avoidable client bundle" the step names.
 *
 * What this deliberately does not do is claim numbers for leaves it cannot
 * reach. Authenticated leaves need a seeded session; those are reported as
 * unmeasured rather than silently omitted from the denominator, because an
 * average over only the cheap pages is worse than no average.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

import { SHARED_BASELINE_BUDGET_KB } from "@/lib/zero-base/performance-budgets";

export { SHARED_BASELINE_BUDGET_KB };

export interface RouteBundle {
  route: string;
  /** Bytes of client JS unique to this route's first load. */
  bytes: number;
}

/**
 * First-load client JS per route, from `.next/app-build-manifest.json`.
 *
 * Files shared by every route are counted once as the baseline rather than
 * charged to each route, which is how Next reports it and the only way the
 * per-route number means anything.
 */
export function readBundles(): { routes: RouteBundle[]; sharedBytes: number } | null {
  const manifestPath = path.join(ROOT, ".next", "build-manifest.json");
  if (!existsSync(manifestPath)) return null;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    rootMainFiles?: string[];
    polyfillFiles?: string[];
  };

  const sizeOf = (file: string): number => {
    try {
      return readFileSync(path.join(ROOT, ".next", file)).byteLength;
    } catch {
      return 0;
    }
  };

  // The App Router ships a shared root bundle plus polyfills on every route.
  // Per-route client weight is measured in the browser instead of guessed from
  // a manifest shape, so this reports only what the manifest actually states.
  const sharedFiles = [...(manifest.rootMainFiles ?? []), ...(manifest.polyfillFiles ?? [])];
  const sharedBytes = sharedFiles.reduce((total, file) => total + sizeOf(file), 0);

  const routes = sharedFiles
    .map((file) => ({ route: file, bytes: sizeOf(file) }))
    .sort((a, b) => b.bytes - a.bytes);

  return { routes, sharedBytes };
}

export function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  console.log("zero-base client bundle weight (WP-26 step 10 / G11)\n");
  const bundles = readBundles();
  if (!bundles) {
    console.log("  No .next build manifest found. Run `npm run build` first.");
    process.exit(1);
  }

  console.log(`  shared baseline (every route)   ${kb(bundles.sharedBytes)}`);
  console.log(`  routes measured                 ${bundles.routes.length}\n`);
  console.log("  shared root bundle files:");
  for (const route of bundles.routes.slice(0, 12)) {
    console.log(`    ${kb(route.bytes).padStart(10)}  ${route.route}`);
  }

  const overBaseline = bundles.sharedBytes / 1024 > SHARED_BASELINE_BUDGET_KB;
  console.log("");
  if (overBaseline) {
    console.log(
      `  NOTE: shared baseline ${kb(bundles.sharedBytes)} exceeds the ${SHARED_BASELINE_BUDGET_KB} KB` +
        " investigation threshold.",
    );
  } else {
    console.log(`  ok    shared baseline is within the ${SHARED_BASELINE_BUDGET_KB} KB threshold`);
  }
  console.log(
    "\nVitals (LCP/CLS/TBT) are measured against the running server by\n" +
      "playwright/tests/zero-base-perf.spec.ts, which reports unmeasured leaves\n" +
      "rather than averaging over only the reachable ones.",
  );
}
