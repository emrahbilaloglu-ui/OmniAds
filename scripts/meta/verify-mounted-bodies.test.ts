import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  reachableFromRoutes,
  unmountedRegistryBodies,
} from "@/scripts/meta/verify-mounted-bodies";

const ROOT = process.cwd();
const reachable = reachableFromRoutes();

function isReachable(file: string): boolean {
  return reachable.has(path.join(ROOT, file));
}

/**
 * WP16 item 4 — "Import graph AST veya module graph ile doğrulanır; grep tek
 * başına yeterli değildir."
 *
 * A grep cannot answer "does a route reach this file": a module can be imported
 * by a test, by a sibling that is itself unmounted, or by a barrel nothing
 * pulls, and all three look like "it is imported". This walks the real graph
 * from every routable file under `app/`.
 */
describe("mounted-body reachability", () => {
  it("reaches every body the surface registry declares", () => {
    expect(unmountedRegistryBodies()).toEqual([]);
  });

  it("actually reaches things, so a pass is not vacuous", () => {
    // A gate that cannot distinguish anything is not a gate. These are the
    // production bodies the plan's §11 matrix names.
    expect(isReachable("components/meta/redesign/MetaPlatformPage.tsx")).toBe(true);
    expect(isReachable("components/creatives/CreativeStudioExact.tsx")).toBe(true);
    expect(
      isReachable("app/(dashboard)/platforms/meta/automation/automation-view.tsx"),
    ).toBe(true);
  });

  it("does NOT reach the bodies this plan found unmounted", () => {
    /**
     * The three instances of the pattern, and the proof the detector works.
     *
     * `manage-clients.tsx` is the only consumer of `saveProviderAssignments`
     * (found in WP3), and `CreativesBriefingPage.tsx` renders a hardcoded
     * "Spend today" nobody can see (found in WP5). Both are real code, imported
     * by real tests, and no route can reach either.
     *
     * If one of these ever becomes reachable, this test fails — which is the
     * right signal in both directions: either it was mounted deliberately (and
     * this list should shrink) or something started pulling a dead body into
     * the bundle.
     */
    expect(isReachable("components/zero-base/manage/manage-clients.tsx")).toBe(false);
    expect(
      isReachable("components/creatives/briefing/CreativesBriefingPage.tsx"),
    ).toBe(false);
  });

  it("does not follow test files into the graph", () => {
    // A body reachable only from a test is precisely the defect this detects,
    // so tests must never be roots or edges.
    for (const file of reachable) {
      expect(file, file).not.toMatch(/\.(test|spec)\.[cm]?[jt]sx?$/);
    }
  });
});
