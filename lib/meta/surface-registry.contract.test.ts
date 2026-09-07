import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { getPlatformLayer2Items } from "@/components/layout/nav-items";
import {
  getRailJumpTargets,
  getRailModel,
  isPlatformFamilyActive,
  isRailLinkActive,
} from "@/components/layout/v2/nav-model";
import {
  dashboardHrefForRouteFamily,
  dashboardScreenForPath,
} from "@/lib/dashboard-v2/screen-registry";
import {
  META_SURFACES,
  allSurfaceSpellings,
  creativeStudioTabSurfaces,
  metaRailSurfaces,
  metaSurfaceById,
  surfaceUsesReportingWindow,
} from "@/lib/meta/surface-registry";
import { COMPATIBILITY_TABLE } from "@/lib/zero-base/compatibility";

const BUSINESS = "biz_1";

function scoped(canonicalRoute: string) {
  return canonicalRoute.replace("[businessId]", BUSINESS);
}

/**
 * T3 of the master plan: the one test that reads the surface registry and every
 * table that used to hold a private opinion about the same surfaces, in the same
 * run. Before this existed, each of them could be individually green while
 * disagreeing with all the others — which is exactly the state the plan's §5.1
 * findings 3, 4 and 5 describe.
 */
describe("surface registry ↔ every other route/nav table", () => {
  it("names a mounted body that exists on disk", () => {
    // The check that catches a "ported" surface nobody routed: a registry entry
    // can claim any file, and this is what stops it claiming one that is not
    // there.
    for (const surface of META_SURFACES) {
      expect(
        existsSync(surface.mountedBody),
        `${surface.surfaceId} → ${surface.mountedBody}`,
      ).toBe(true);
    }
  });

  it("has unique ids, canonical routes and rail positions", () => {
    const ids = META_SURFACES.map((s) => s.surfaceId);
    expect(new Set(ids).size).toBe(ids.length);

    const routes = META_SURFACES.map((s) => s.canonicalRoute);
    expect(new Set(routes).size).toBe(routes.length);

    const orders = metaRailSurfaces().map((s) => s.railOrder);
    expect(orders).toEqual([1, 2, 3, 4, 5]);
  });

  it("carries only usable Meta rail entries in their fixed order", () => {
    expect(metaRailSurfaces().map((s) => s.label)).toEqual([
      "Decisions",
      "Creative Studio",
      "Launchpad",
      "Automation",
      "History",
    ]);
  });

  it("carries D3's five Creative Studio tabs", () => {
    expect(creativeStudioTabSurfaces().map((s) => s.label)).toEqual([
      "Creative Studio",
      "Copies",
      "Landing Pages",
      "Inbox",
      "Audiences",
    ]);
  });

  it("agrees with the rail adapter on the Meta group", () => {
    const railLabels = getPlatformLayer2Items("meta", "en").map((i) => i.label);
    expect(railLabels).toEqual(metaRailSurfaces().map((s) => s.label));
  });

  it("resolves every canonical route to a screen", () => {
    // `null` here is what made History light up Decisions: an unresolved path
    // falls through to whichever row happens to claim it.
    for (const surface of META_SURFACES) {
      if (surface.role === "public") continue;
      if (surface.canonicalRoute.includes("[creativeId]")) continue;
      expect(
        dashboardScreenForPath(scoped(surface.canonicalRoute)),
        surface.canonicalRoute,
      ).not.toBeNull();
    }
  });

  it("resolves every alias and legacy spelling to a screen", () => {
    for (const spelling of allSurfaceSpellings()) {
      if (spelling.kind === "canonical") continue;
      if (spelling.path.includes("[creativeId]")) continue;
      if (spelling.path === "/integrations") continue; // Workspace, not Meta rail.
      expect(
        dashboardScreenForPath(spelling.path),
        `${spelling.surfaceId} ${spelling.kind} ${spelling.path}`,
      ).not.toBeNull();
    }
  });

  it("lights exactly one Meta rail row per rail surface, in all three families", () => {
    const model = getRailModel("en");
    const meta = model.platforms.find((p) => p.id === "meta")!;

    for (const surface of metaRailSurfaces()) {
      for (const path of [
        scoped(surface.canonicalRoute),
        ...surface.aliases,
        ...surface.legacyRedirect,
      ]) {
        const active = meta.children.filter((link) =>
          isRailLinkActive(link, path),
        );
        expect(active.length, `${surface.surfaceId} @ ${path}`).toBe(1);
        expect(active[0]!.label, `${surface.surfaceId} @ ${path}`).toBe(
          surface.label,
        );
        // …and the platform group itself stays lit, so the operator is never
        // told they have left Meta while reading a Meta surface.
        expect(isPlatformFamilyActive(meta, path), path).toBe(true);
      }
    }
  });

  it("keeps the Creative Studio hub lit on its tabs and sub-surfaces", () => {
    const model = getRailModel("en");
    const meta = model.platforms.find((p) => p.id === "meta")!;
    const subs = META_SURFACES.filter(
      (s) =>
        s.parentSurfaceId === "creative-studio" &&
        !s.canonicalRoute.includes("[creativeId]"),
    );

    for (const surface of subs) {
      const path = scoped(surface.canonicalRoute);
      const active = meta.children.filter((link) =>
        isRailLinkActive(link, path),
      );
      expect(
        active.map((l) => l.label),
        path,
      ).toEqual(["Creative Studio"]);
      expect(isPlatformFamilyActive(meta, path), path).toBe(true);
    }
  });

  it("never lights Decisions while the operator is reading History", () => {
    // The plan's §5.1 finding 4, pinned by name so a regression is unmistakable.
    const model = getRailModel("en");
    const meta = model.platforms.find((p) => p.id === "meta")!;
    const decisions = meta.children.find((l) => l.id === "pulse")!;

    for (const path of [
      "/c/biz_1/meta/history",
      "/app/meta/history",
      "/platforms/meta/history",
    ]) {
      expect(isRailLinkActive(decisions, path), path).toBe(false);
    }
  });

  it("offers every rail surface in the command palette", () => {
    const targets = getRailJumpTargets(getRailModel("en"));
    for (const surface of metaRailSurfaces()) {
      expect(
        targets.some((t) => t.label === `Meta · ${surface.label}`),
        surface.label,
      ).toBe(true);
    }
  });

  it("keeps a /c/:businessId visitor inside their own business scope", () => {
    /**
     * The scope bug this guards: an href with no legacy spelling used to pass
     * through unchanged, so clicking Account Intelligence from
     * `/c/biz_1/meta/decisions` navigated to `/app/meta/intelligence`, which
     * re-scopes from `session.activeBusinessId` — a *different* business than
     * the one being read. That is the plan's rollback trigger 1.
     */
    const model = getRailModel("en");
    const meta = model.platforms.find((p) => p.id === "meta")!;
    const here = "/c/biz_1/meta/decisions";

    for (const link of meta.children) {
      const href = dashboardHrefForRouteFamily(link.href, here);
      expect(href.startsWith("/c/biz_1/"), `${link.id} → ${href}`).toBe(true);
    }
  });

  it("routes /platforms/meta/audiences to Creative Studio Audiences, per ADR-004", () => {
    const audiences = metaSurfaceById("creative-audiences")!;
    expect(audiences.legacyRedirect).toContain("/platforms/meta/audiences");

    // …and the compatibility table, which is what actually redirects, agrees.
    const target = COMPATIBILITY_TABLE.find(
      (row) => row.route === "/platforms/meta/audiences",
    );
    expect(target?.canonicalUrls).toEqual([
      "/c/[businessId]/creative/audiences",
    ]);
    expect(target?.canonicalUrls).toEqual([audiences.canonicalRoute]);
  });

  it("applies the reporting-range picker only where a range means something", () => {
    // §8.2. A control-state surface showed an active range it never applied, so
    // the operator read current state through a window that did nothing.
    expect(
      surfaceUsesReportingWindow(metaSurfaceById("meta-automation")!),
    ).toBe(false);
    expect(
      surfaceUsesReportingWindow(metaSurfaceById("manage-integrations")!),
    ).toBe(false);
    expect(
      surfaceUsesReportingWindow(metaSurfaceById("creative-shares")!),
    ).toBe(false);

    expect(
      surfaceUsesReportingWindow(metaSurfaceById("creative-studio")!),
    ).toBe(true);
    expect(surfaceUsesReportingWindow(metaSurfaceById("meta-history")!)).toBe(
      true,
    );
    expect(surfaceUsesReportingWindow(metaSurfaceById("creative-inbox")!)).toBe(
      true,
    );
  });

  it("requires one physical Meta account wherever account-scoped data is served", () => {
    // D6. The three exceptions are stated rather than assumed: the public share
    // carries a frozen token scope, the Shares ledger is business-wide, and
    // Integrations decides assignments rather than consuming one.
    const exceptions = new Map([
      ["public-creative-share", "token_public"],
      ["creative-shares", "business_scope"],
      ["manage-integrations", "assignment"],
    ]);
    for (const surface of META_SURFACES) {
      expect(surface.providerAccountCapability, surface.surfaceId).toBe(
        exceptions.get(surface.surfaceId) ?? "single_physical",
      );
    }
  });

  it("names a release gate for every surface that can reach the provider", () => {
    for (const surface of META_SURFACES) {
      if (surface.actionCapability === "gated_provider_write") {
        expect(surface.gate, surface.surfaceId).toBeTruthy();
      }
    }
  });
});

/**
 * D4: `lib/zero-base/navigation.ts` is a semantic **oracle**, never the runtime
 * renderer.
 *
 * The distinction matters because the two disagree on purpose. The generated
 * leaf ledger is a frozen inventory of the vendored package; the rail is the
 * shipped product, which D3 gives two rows the package predates. Rendering the
 * oracle would silently revert those, and asserting they match would force the
 * vendored package to be edited — which §17.1 forbids. So the rule is
 * containment: the oracle is read in tests and nowhere else.
 */
describe("navigation.ts is an oracle, not a renderer (D4)", () => {
  it("is not imported by any production layout or route", async () => {
    const { execSync } = await import("node:child_process");
    const hits = execSync(
      "git grep -l 'zero-base/navigation' -- 'app/**/*.tsx' 'app/**/*.ts' || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((file) => !file.includes(".test."));
    expect(hits).toEqual([]);
  });

  it("covers every canonical route the registry claims, so it can serve as an oracle", async () => {
    const { navGroupsFor } = await import("@/lib/zero-base/navigation");
    const known = new Set(
      navGroupsFor("Client").flatMap((group) => group.items.map((i) => i.url)),
    );

    // Every registry surface the oracle also knows must agree on the URL. Ones
    // the oracle does not know are listed explicitly below rather than skipped
    // silently, because "the ledger has never heard of this surface" is a fact
    // worth having written down.
    const notInOracle = META_SURFACES.filter(
      (surface) => !known.has(surface.canonicalRoute),
    ).map((s) => s.surfaceId);

    expect(notInOracle.sort()).toEqual(
      [
        /**
         * The ADR-004 divergence, and the only one. The vendored ledger has no
         * `creative/audiences` leaf because it records that URL as merged into
         * Meta Intelligence — a screen inventory that predates Dashboard v2
         * restoring Audiences as the fifth Creative Studio tab. The package is
         * left unedited (§17.1) and the divergence is recorded in
         * `docs/zero-base-design/v3/ACCEPTED_RESIDUALS.md`.
         */
        "creative-audiences",
        // Carries a dynamic id, so `isNavigable` excludes it from the rail.
        "creative-detail",
        // Public and unauthenticated: deliberately outside the client nav.
        "public-creative-share",
      ].sort(),
    );
  });

  it("backs D3's two added rail rows with the vendored leaf ledger", async () => {
    /**
     * Worth pinning, because it changes what kind of change D3 is.
     *
     * The design *file* draws four Meta children — its `metaFam` is
     * `['meta','creative','launchpad','automation']` — so at first reading,
     * Account Intelligence and History look like rows invented against the
     * authority. They are not. The vendored behavioural package already carries
     * `L-C-META-INTEL` and `L-C-META-HIST` as navigable Client leaves, so the
     * two authorities disagree with each other and D3 sides with the one that
     * governs behaviour (ADR-005 rule 2). The rows were missing from the rail,
     * not from the contract.
     */
    const { navGroupsFor } = await import("@/lib/zero-base/navigation");
    const meta = navGroupsFor("Client").find((group) => group.id === "meta")!;
    const leaves = meta.items.map((item) => item.leaf);
    expect(leaves).toContain("L-C-META-INTEL");
    expect(leaves).toContain("L-C-META-HIST");

    const byUrl = new Map(meta.items.map((item) => [item.url, item.leaf]));
    expect(
      byUrl.get(metaSurfaceById("meta-intelligence")!.canonicalRoute),
    ).toBe("L-C-META-INTEL");
    expect(byUrl.get(metaSurfaceById("meta-history")!.canonicalRoute)).toBe(
      "L-C-META-HIST",
    );
  });
});
