import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { reachableFromRoutes } from "@/scripts/meta/verify-mounted-bodies";

/**
 * WP16 — is the DOM the gates measure the DOM a user sees?
 *
 * The visual, accessibility, responsive and fidelity gates all run against
 * `playwright/.harness`, which `build-shell-harness.tsx` renders from a fixed
 * list of components. Nothing checked that those components are the ones a
 * route actually mounts.
 *
 * Measured: it renders **12** component bodies and **3** of them are reachable
 * by no route — the zero-base Home, Decisions and Automation views. The routes
 * mount `app/(dashboard)/overview/legacy-page.tsx`,
 * `components/meta/redesign/MetaPlatformPage.tsx` and
 * `app/(dashboard)/platforms/meta/automation/automation-view.tsx` instead. The
 * shell primitives the harness renders — rail, context bar, skip link, data
 * table, repair panel — ARE the mounted ones, so most of the chrome evidence is
 * about the real thing and three whole surfaces are not.
 *
 * That is the plan's §5.1 finding 2 stated as a number, and it is the reason
 * "the design gates are green" has not meant "what the operator sees is right".
 *
 * This test does not retarget the harness — that is a separate change, because
 * the mounted bodies are client components with routers, query clients and
 * stores that `renderToStaticMarkup` cannot drive without a data-layer harness
 * of its own. It makes the mismatch a tracked, enumerated fact that fails when
 * it grows, which is the prerequisite for retargeting it deliberately rather
 * than discovering the gap again later.
 */
const HARNESS_BUILDER = "scripts/zero-base/build-shell-harness.tsx";

/**
 * Component modules the harness imports and renders.
 *
 * Type-only imports are excluded: `import type { X } from "@/components/..."`
 * pulls no DOM and its module may not even be a component. Counting one as a
 * rendered body would report a mismatch that does not exist.
 *
 * The extension is resolved against the filesystem rather than assumed, because
 * some of these are `.ts` and a guessed `.tsx` resolves to nothing — which then
 * reads as "unreachable" for a file that is simply named differently.
 */
function harnessRenderedBodies(): string[] {
  const source = readFileSync(HARNESS_BUILDER, "utf8");
  const found = new Set<string>();
  for (const match of source.matchAll(
    /(^|\n)\s*import\s+(?!type\s)[\s\S]*?from "@\/(components\/[^"]+)"/g,
  )) {
    const base = match[2]!;
    for (const extension of [".tsx", ".ts"]) {
      if (existsSync(path.join(process.cwd(), `${base}${extension}`))) {
        found.add(`${base}${extension}`);
        break;
      }
    }
  }
  return [...found].sort();
}

const reachable = reachableFromRoutes();

function isReachable(file: string): boolean {
  return reachable.has(path.join(process.cwd(), file));
}

/**
 * Bodies the harness renders that NO route mounts.
 *
 * Every entry is a surface whose visual, a11y and responsive evidence describes
 * something no operator can open. They are listed rather than tolerated
 * silently, and the list is asserted exactly: adding one fails, and — just as
 * importantly — mounting one and forgetting to remove it here fails too.
 */
const UNREACHABLE_HARNESS_BODIES = [
  // Route mounts app/(dashboard)/overview/legacy-page.tsx
  "components/zero-base/home/home-view.tsx",
  // Route mounts app/(dashboard)/platforms/meta/automation/automation-view.tsx
  "components/zero-base/meta/automation/automation-view.tsx",
  // Route mounts components/meta/redesign/MetaPlatformPage.tsx
  "components/zero-base/meta/decisions/decisions-view.tsx",
] as const;

describe("harness DOM versus user-visible DOM", () => {
  it("finds the bodies the harness renders, so a pass is not vacuous", () => {
    expect(harnessRenderedBodies().length).toBeGreaterThan(5);
  });

  it("enumerates exactly which harness bodies no route can reach", () => {
    const unreachable = harnessRenderedBodies().filter((file) => !isReachable(file));
    expect(unreachable).toEqual([...UNREACHABLE_HARNESS_BODIES]);
  });

  it("does reach some of them, so the detector is not simply saying no", () => {
    const reached = harnessRenderedBodies().filter((file) => isReachable(file));
    expect(reached.length).toBeGreaterThan(0);
    // The three Meta surfaces whose harness evidence IS about the mounted body.
    expect(reached).toContain("components/zero-base/meta/history/history-view.tsx");
    expect(reached).toContain(
      "components/zero-base/meta/intelligence/intelligence-view.tsx",
    );
    expect(reached).toContain("components/zero-base/creative/public-share-page.tsx");
  });

  it("keeps the harness buildable, which it was not", () => {
    /**
     * `npm run zero-base:shell:harness` failed on the first CSS-module import,
     * so every gate that starts by building the harness — a11y, responsive,
     * visual, frames, fidelity — had been failing at step one. The stub is what
     * lets a plain tsx script import a component that imports CSS.
     */
    const source = readFileSync(HARNESS_BUILDER, "utf8");
    expect(source).toContain('import "./css-module-stub.cts"');
    // Before any component import, or the loader has already thrown.
    expect(source.indexOf('import "./css-module-stub.cts"')).toBeLessThan(
      source.indexOf('from "@/components/'),
    );
  });
});
