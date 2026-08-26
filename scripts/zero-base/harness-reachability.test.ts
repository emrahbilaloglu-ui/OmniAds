import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { reachableFrom, reachableFromRoutes } from "@/scripts/meta/verify-mounted-bodies";

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
  // Route mounts components/meta/redesign/MetaPlatformPage.tsx
  "components/zero-base/_reference/meta-decisions-view.tsx",
] as const;

/**
 * The archived Automation presenter is deliberately NOT on the list above, and
 * is deliberately still on disk.
 *
 * The list is "bodies the HARNESS renders that no route can reach". H19 and H20
 * now render `MetaAutomationView`, the body the route mounts, so the archived
 * presenter is no longer harness-rendered and the list is two.
 *
 * The file stays because deleting it is a product decision rather than a
 * cleanup. It is the only implementation of the stop CEREMONY the design's H20
 * calls a "release preflight" — type-to-confirm, success announced only once a
 * read-back agrees, an explicitly unknown outcome when the confirming read
 * fails — and the mounted body has a direct engage/release pair with a server
 * refusal and no preflight. Deleting it deletes that ceremony and the flow-I
 * suite that encodes its laws; whether the mounted stop should GAIN the
 * ceremony is a call the master plan does not make, and building one to justify
 * a deletion would be inventing a feature.
 *
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

/**
 * Every path that produces RELEASE EVIDENCE about how the product looks.
 *
 * D2 is binding: the mounted production bodies own the pixels. So the visual,
 * accessibility, responsive, fidelity and frame gates must measure those bodies
 * — and a gate that reaches an archived `_reference` body is not measuring the
 * product, it is measuring a copy of it that no operator can open.
 *
 * Four of these roots are `.spec.ts` files, which is why the walk below cannot
 * reuse `reachableFromRoutes()`: that one skips tests deliberately, because a
 * component imported only by its own test is not mounted. Here the spec IS the
 * entry point, and an archived body pulled in through one would be the exact
 * drift this gate exists to catch.
 */
const RELEASE_EVIDENCE_ROOTS = [
  "scripts/zero-base/build-shell-harness.tsx",
  "scripts/zero-base/build-frame-harness.tsx",
  "scripts/zero-base/frame-registry.tsx",
  "scripts/zero-base/frame-shell.tsx",
  "scripts/zero-base/reconcile-frames.ts",
  "scripts/zero-base/verify-reference-anatomy.ts",
  "scripts/zero-base/verify-reference-fidelity.ts",
  "scripts/zero-base/visual-regression.ts",
  "playwright/tests/zero-base-a11y.spec.ts",
  "playwright/tests/zero-base-visual.spec.ts",
  "playwright/tests/zero-base-frames.spec.ts",
];

/**
 * Bodies the release evidence is still allowed to reach, and why.
 *
 * This list is the WP16 debt, stated as data. It shrinks to empty as each
 * harness is repointed at its production owner; it may never grow. An entry
 * here is a promise that the gate measuring that surface is measuring a copy,
 * and the reason is recorded beside it so nobody has to re-derive why.
 */
const PERMITTED_REFERENCE_BODIES: Record<string, string> = {
  "components/zero-base/_reference/home-view.tsx":
    "The four FEATURES exist now — the mounted Overview carries data-el=home-kpis, data-el=source-readiness with data-collection=sources, live:chart-table-toggle, live:ECON-04 divergence-link and live:MOBILE-01, all fed by real reads (/api/integrations/status, the meta and google status reads it already performed, and the Commercial Truth target pack), and app/(dashboard)/overview/page.test.tsx asserts every marker against the rendered mounted body. Two things still hold the harness. First the same paint system that holds Decisions: the mounted body and the v2 cards it composes paint with 70 raw hex values and the .adv-* layer, and the fidelity gate accepts only Ledger tokens. Second, unlike MetaDecisionCenterExact, this body is not props-only: legacy-page.tsx is a zero-prop client component with 19 hook call sites (useQuery, useRouter, usePathname, useAppStore, usePersistentDateRange, useTierZeroFreshness), so the harness cannot render it without a presenter extraction. That extraction is worth doing WITH the re-vendor and not before it, because on its own it would produce a harness that renders the mounted body and still fails fidelity for the paint.",
  "components/zero-base/_reference/meta-decisions-view.tsx":
    "Held by the PAINT SYSTEM, and by nothing else any more. The repoint was run: pointing the eleven Decisions artboards at the mounted MetaDecisionCenterExact took the anatomy gate to 83/83 with the mounted body, and left the fidelity gate reporting 229 findings across those eleven artboards — every single one `untokenised-colour`. The mounted console is painted in the adv system (Instrument Sans, Space Grotesk, --adv-*) and the accepted package is the Ledger one. Both ways to make that green are refused: repainting this one surface leaves it foreign to the other twelve, and adding these frames to PAINT_SYSTEM_DEBT raises a ceiling that may only fall. Everything else is already done and already proven — the markers are on the mounted body, the fixture drives the real adapter, the CSS module is wired into the frame harness, and scripts/zero-base/decisions-repoint-readiness.test.ts asserts every required data-el, data-ctl and data-collection of H09, H10, H11, H12, B02, B06, B07, H52, H57, P06 and P07 against the rendered mounted body on every run. The repoint is one line in frame-registry.tsx on the day the design owner re-vendors the package."
};

describe("release evidence measures the mounted bodies", () => {
  it("reaches only the archived bodies this list still permits", () => {
    const roots = RELEASE_EVIDENCE_ROOTS.map((file) => path.join(process.cwd(), file)).filter(
      (file) => existsSync(file),
    );
    expect(roots.length, "a release-evidence root was renamed or removed").toBe(
      RELEASE_EVIDENCE_ROOTS.length,
    );

    const reached = [...reachableFrom(roots, { followTests: true })]
      .map((file) => path.relative(process.cwd(), file))
      .filter((file) => file.startsWith(REFERENCE_DIR))
      .sort();

    const unpermitted = reached.filter((file) => !(file in PERMITTED_REFERENCE_BODIES));
    expect(
      unpermitted,
      "release evidence reached an archived body with no recorded reason",
    ).toEqual([]);
  });

  it("keeps every permitted entry justified, and keeps the list shrinking", () => {
    for (const [file, why] of Object.entries(PERMITTED_REFERENCE_BODIES)) {
      expect(existsSync(path.join(process.cwd(), file)), `${file} no longer exists`).toBe(true);
      expect(why.length, `${file} is permitted with no reason`).toBeGreaterThan(60);
    }
    /*
     * A ceiling, not a floor. Three archived bodies exist; two are still
     * reached. When a harness is repointed its entry comes out of the list and
     * this number comes down with it — it must never go up.
     *
     * Two, since the Automation harness was repointed: H19 and H20 now render
     * `MetaAutomationView`, the body the route mounts, and the archived
     * Automation presenter is gone.
     */
    expect(Object.keys(PERMITTED_REFERENCE_BODIES).length).toBeLessThanOrEqual(2);
  });

  it("keeps every H19/H20 marker on the body the route mounts", () => {
    /*
     * This used to assert the GAP: `gated:AUTO-03 mode` named a control the
     * mounted Automation body did not have — the autonomy ladder rendered
     * read-only captions — so the harness had to keep grading the archived
     * presenter, and the test asserted the absence so that building the control
     * would be what removed the entry rather than an edit to a list.
     *
     * The control exists now, so the assertion inverts: every marker H19 and
     * H20 require is on the mounted body, and the archived presenter is gone.
     */
    const mounted = readFileSync(
      path.join(process.cwd(), "app/(dashboard)/platforms/meta/automation/automation-view.tsx"),
      "utf8",
    );
    for (const marker of [
      'data-ctl="gated:AUTO-01A engage"',
      'data-ctl="gated:AUTO-02 release"',
      'data-ctl="gated:AUTO-03 mode"',
      'data-el="google-posture-row"',
      'data-el="guardrails-readonly"',
      // The KIND, not the artboard-prefixed id: `collectionKind` strips `h19-`
      // before comparing, so a body carrying the prefix fails the gate.
      'data-collection="guardrails"',
    ]) {
      expect(mounted, `the mounted Automation body lost ${marker}`).toContain(marker);
    }

    /*
     * And the release evidence does not reach the archived presenter any more.
     * The file still exists — see `UNREACHABLE_HARNESS_BODIES` for why — but no
     * gate that produces release evidence renders it, which is the property
     * `PERMITTED_REFERENCE_BODIES` exists to hold.
     */
    const reached = [...reachableFrom(
      RELEASE_EVIDENCE_ROOTS.map((file) => path.join(process.cwd(), file)).filter((file) =>
        existsSync(file),
      ),
      { followTests: true },
    )].map((file) => path.relative(process.cwd(), file));
    expect(reached).not.toContain("components/zero-base/_reference/meta-automation-view.tsx");
  });
});
