/**
 * WP2, on the running server: one surface, several spellings, one answer.
 *
 * The registry states that each Meta surface has a canonical `/c/:businessId/…`
 * route, a session-scoped `/app/…` twin and, for most of them, a pre-v2
 * `/platforms/…` spelling. `surface-registry.contract.test.ts` proves those
 * tables agree with each other. It cannot prove what an operator gets, because
 * a table can be internally consistent and still describe a route that 404s, a
 * twin that mounts a different body, or a rail that lights the wrong row —
 * which is the exact defect WP2 was written for: reading History lit up
 * Decisions, and Intelligence lit up nothing at all.
 *
 * So this asks the server. For every surface and every spelling of it:
 *
 *   - the page resolves rather than 404ing;
 *   - exactly ONE Meta rail row is active, and it is this surface's row (or its
 *     hub's, for a tab);
 *   - the twin mounts the same body as the canonical route, compared on the
 *     heading and the §9 region rather than on the whole text, so a figure that
 *     moves between two reads cannot make two identical screens look different.
 *
 * Order matters and is deliberate: the canonical route is visited first because
 * `/c/:businessId/…` redirects through `/switch-business/:id`, which is what
 * makes the session-scoped twin resolve to the same business. A twin checked
 * without that step would be reading whichever business the session happened to
 * hold.
 */
import { expect, test, type Page } from "@playwright/test";

import { META_SURFACES } from "../../lib/meta/surface-registry";
import { openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();

/** Surfaces with a business-scoped route and no other required parameter. */
const ROUTED = META_SURFACES.filter(
  (surface) =>
    surface.canonicalRoute.includes("[businessId]") &&
    !surface.canonicalRoute.includes("[creativeId]"),
);

/**
 * The rail row that should light for a surface.
 *
 * Three cases, and the registry states which applies. A `hub` owns a row in the
 * Meta group and lights it. A `tab` or `sub` WITH a hub has no row of its own
 * and lights its hub's — reading Copies must light Creative Studio. A `sub`
 * with no hub is a workspace surface (Integrations) that owns a row elsewhere
 * in the rail and lights that.
 */
function expectedRailLabel(surfaceId: string): string {
  const surface = META_SURFACES.find((item) => item.surfaceId === surfaceId)!;
  if (surface.railOrder !== null) return surface.label;
  const parent = META_SURFACES.find(
    (item) => item.surfaceId === surface.parentSurfaceId,
  );
  return parent ? parent.label : surface.label;
}

/**
 * Which rail rows are lit, read from `data-active` rather than from a class so
 * styling can neither hide nor fake the answer.
 *
 * Leaves and families are separate facts, and they are carried by two different
 * attributes. A leaf's `data-active` says which SCREEN you are on and exactly
 * one may be lit; a platform row's `data-family` says which PRODUCT you are
 * inside and stays lit across every screen under it. Reading them together was
 * the first version of this helper and it made Integrations — a Workspace row,
 * outside the Meta children — look like a surface with no row at all.
 */
async function railState(page: Page): Promise<{
  leaves: string[];
  families: string[];
}> {
  return page.evaluate(() => {
    const text = (element: Element) =>
      (element.textContent ?? "").replace(/\s+/g, " ").trim();
    const lit = (selector: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
        (element) => element.dataset.active === "true",
      );
    return {
      leaves: lit(
        ".adv-rail-child[data-active], .adv-rail-item[data-active]:not(.adv-rail-item--platform)",
      ).map(text),
      /*
       * `data-family`, not `data-active`. On a platform row `data-active` means
       * "the product's own landing page is the current one" and is false on
       * every child screen; `data-family` is the one that means "you are
       * somewhere inside this product". Reading the wrong attribute made every
       * Meta screen look as though the rail had lost the Meta group.
       */
      families: Array.from(
        document.querySelectorAll<HTMLElement>(".adv-rail-item--platform[data-family]"),
      )
        .filter((element) => element.dataset.family === "true")
        .map((element) => element.dataset.platform ?? ""),
    };
  });
}

/** Whether a surface lives under the Meta product, and so lights its row. */
function isMetaFamily(canonicalRoute: string): boolean {
  return canonicalRoute.includes("/meta/") || canonicalRoute.includes("/creative/");
}

/**
 * A body's identity, stable across two reads of the same screen.
 *
 * The first heading names the surface and the §9 region names what the read
 * did. Both are decided by the body itself, and neither moves between two
 * loads the way a spend figure, a timestamp or a "synced —" line does.
 */
async function bodyIdentity(page: Page): Promise<{
  heading: string;
  surfaceState: string | null;
  readState: string | null;
}> {
  return page.evaluate(() => {
    const heading = document.querySelector("main h1, main h2");
    const region = document.querySelector<HTMLElement>("[data-meta-surface-state]");
    return {
      heading: (heading?.textContent ?? "").replace(/\s+/g, " ").trim(),
      surfaceState: region?.dataset.metaSurfaceState ?? null,
      readState: region?.dataset.readState ?? null,
    };
  });
}

test.describe("every canonical Meta route resolves and lights its own rail row", () => {
  for (const surface of ROUTED) {
    test(`${surface.surfaceId} — canonical`, async ({ page }) => {
      const path = surface.canonicalRoute.replace(
        "[businessId]",
        handle.businesses.oneAccount,
      );
      await openSurface(page, handle, path);

      // Not a 404 dressed as a page: the rail is only rendered by the shell.
      const rail = await railState(page);
      expect(rail.leaves, `${surface.surfaceId} lit no rail row`).toHaveLength(1);
      expect(rail.leaves[0]).toContain(expectedRailLabel(surface.surfaceId));
      /*
       * And the product row agrees. This is the other half of the WP2 defect:
       * the Meta group collapsed to inactive the moment an operator opened
       * Intelligence or History, so the rail claimed they had left Meta while
       * they were reading a Meta screen.
       */
      expect(rail.families.includes("meta")).toBe(isMetaFamily(surface.canonicalRoute));
    });
  }
});

test.describe("the /app twin mounts the same body as the canonical route", () => {
  for (const surface of ROUTED) {
    const alias = surface.aliases[0];
    if (!alias) continue;

    test(`${surface.surfaceId} — ${alias}`, async ({ page }) => {
      // Canonical first: this is what binds the session to the business, and
      // without it the twin would be read against whichever business the
      // session already held.
      await openSurface(
        page,
        handle,
        surface.canonicalRoute.replace("[businessId]", handle.businesses.oneAccount),
      );
      const canonical = await bodyIdentity(page);
      const canonicalRail = await railState(page);

      await openSurface(page, handle, alias);
      const twin = await bodyIdentity(page);
      const twinRail = await railState(page);

      expect(twin.heading, `${alias} mounted a different body`).toBe(canonical.heading);
      expect(twin.surfaceState).toBe(canonical.surfaceState);
      expect(twin.readState).toBe(canonical.readState);
      expect(twinRail).toEqual(canonicalRail);
    });
  }
});

test.describe("every pre-v2 spelling still lands on its surface", () => {
  for (const surface of ROUTED) {
    for (const legacy of surface.legacyRedirect) {
      test(`${surface.surfaceId} — ${legacy}`, async ({ page }) => {
        await openSurface(
          page,
          handle,
          surface.canonicalRoute.replace("[businessId]", handle.businesses.oneAccount),
        );
        const canonical = await bodyIdentity(page);

        await openSurface(page, handle, legacy);

        /*
         * A legacy spelling is allowed to redirect — that is what it is for —
         * so the assertion is about where it ENDS, not about the URL. It must
         * end on this surface, with this surface's row lit.
         */
        const rail = await railState(page);
        expect(rail.leaves, `${legacy} lit no rail row`).toHaveLength(1);
        expect(rail.leaves[0]).toContain(expectedRailLabel(surface.surfaceId));
        expect(await bodyIdentity(page)).toMatchObject({ heading: canonical.heading });
      });
    }
  }
});

test("no surface leaves the Meta rail with two rows lit at once", async ({ page }) => {
  /**
   * The WP2 defect stated as an invariant rather than per-route.
   *
   * Two lit rows and zero lit rows are the same lie in opposite directions:
   * the operator cannot tell from the rail which screen they are on. Walking
   * every surface in one session also catches the case a per-route test cannot
   * — a row that stays lit after navigating away.
   */
  const wrong: string[] = [];
  for (const surface of ROUTED) {
    await openSurface(
      page,
      handle,
      surface.canonicalRoute.replace("[businessId]", handle.businesses.oneAccount),
    );
    const rail = await railState(page);
    if (
      rail.leaves.length !== 1 ||
      !rail.leaves[0]!.includes(expectedRailLabel(surface.surfaceId)) ||
      rail.families.includes("meta") !== isMetaFamily(surface.canonicalRoute)
    ) {
      wrong.push(
        `${surface.surfaceId}: leaves [${rail.leaves.join(" | ")}] families [${rail.families.join(" | ")}]`,
      );
    }
  }
  expect(wrong, "surfaces whose rail row did not match the surface").toEqual([]);
});
