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
  "components/zero-base/_reference/home-view.tsx",
  // Route mounts app/(dashboard)/platforms/meta/automation/automation-view.tsx
  "components/zero-base/_reference/meta-automation-view.tsx",
  // Route mounts components/meta/redesign/MetaPlatformPage.tsx
  "components/zero-base/_reference/meta-decisions-view.tsx",
] as const;

/**
 * Every unreachable body lives under `_reference`, and nothing else does.
 *
 * The list above is accurate and easy to miss: three paths in a test array do
 * not stop somebody importing one of these into a route next week under the
 * impression it is product code. The directory name says it, and this keeps
 * the two in agreement in both directions — a body that becomes reachable must
 * leave `_reference`, and one that becomes unreachable must enter it.
 */
const REFERENCE_DIR = "components/zero-base/_reference/";

describe("harness DOM versus user-visible DOM", () => {
  it("finds the bodies the harness renders, so a pass is not vacuous", () => {
    expect(harnessRenderedBodies().length).toBeGreaterThan(5);
  });

  it("enumerates exactly which harness bodies no route can reach", () => {
    const unreachable = harnessRenderedBodies().filter((file) => !isReachable(file));
    expect(unreachable).toEqual([...UNREACHABLE_HARNESS_BODIES]);
  });

  it("keeps every unreachable body under _reference, and nothing else there", () => {
    const bodies = harnessRenderedBodies();
    const misplaced = bodies.filter(
      (file) => file.startsWith(REFERENCE_DIR) !== !isReachable(file),
    );
    expect(
      misplaced,
      "a body whose reachability disagrees with the directory it lives in",
    ).toEqual([]);
  });

  it("never lets a route reach into _reference", () => {
    /*
     * The rollback for this move is `git mv` back and one edit to the list
     * above; the thing that must not happen silently in the meantime is a
     * route importing a body from here, which would make `_reference` a lie
     * without failing anything else.
     */
    const importers = [...reachable].filter((file) =>
      readFileSync(file, "utf8").includes("zero-base/_reference/"),
    );
    expect(
      importers.map((file) => path.relative(process.cwd(), file)),
      "route-reachable files importing from _reference",
    ).toEqual([]);
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
    expect(source).toContain('import "./css-module-stub"');
    // Before any component import, or the loader has already thrown.
    expect(source.indexOf('import "./css-module-stub"')).toBeLessThan(
      source.indexOf('from "@/components/'),
    );
  });
});
