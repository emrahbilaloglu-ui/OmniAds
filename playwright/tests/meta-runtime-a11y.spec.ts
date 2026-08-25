/**
 * WP16 item 2 and WP17 — accessibility and responsive, on the mounted routes.
 *
 * The existing G9 gate scans `playwright/.harness`, a set of pages a tsx script
 * renders from the zero-base component library. Three of the surfaces it draws
 * are mounted by no route at all, and the ones that are mounted are rendered
 * there without a router, a query client or a real payload. It is a real gate
 * over a real component library; it is not evidence about what an operator
 * opens.
 *
 * This runs the same scanner against the same routes the operator navigates to,
 * signed in, with the production build serving them.
 *
 * D13 is the responsive rule and it is narrow on purpose: the mobile design
 * direction does not change, but real content may not be hidden, unreachable or
 * clipped at 320 or 390.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { canonicalRoutesFor, openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();
const routes = canonicalRoutesFor(handle.businesses.oneAccount);

/** The widths WP17 names, narrowest last so a failure reads as a squeeze. */
const WIDTHS = [1440, 1024, 768, 390, 320] as const;

test.describe("axe on the mounted routes", () => {
  for (const route of routes) {
    for (const [width, theme] of [
      [1440, "light"],
      [390, "dark"],
    ] as const) {
      test(`${route.surfaceId} — ${width}px ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme });
        await openSurface(page, handle, route.path);

        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        const blocking = results.violations.filter(
          (violation) => violation.impact === "serious" || violation.impact === "critical",
        );
        expect(
          blocking.map(
            (violation) =>
              /*
               * The offending nodes, not only the rule name.
               *
               * "color-contrast ×2" names a rule and leaves the reader to find
               * the two elements by hand across a whole surface — which is how
               * a real violation sits unfixed while the gate keeps reporting
               * it. The selector and the failure summary are what turn this
               * into something somebody can act on.
               */
              `${violation.id} (${violation.impact}) — ${violation.help}\n` +
              violation.nodes
                .slice(0, 4)
                .map(
                  (node) =>
                    `    ${node.target.join(" ")}\n      ${(node.failureSummary ?? "")
                      .replace(/\s+/g, " ")
                      .trim()
                      .slice(0, 220)}`,
                )
                .join("\n"),
          ),
          `axe on ${route.path} at ${width}px ${theme}`,
        ).toEqual([]);
      });
    }
  }
});

test.describe("landmarks are unique", () => {
  /**
   * Outside the WCAG tag set, and it still matters.
   *
   * Three bodies rendered their own `<main>` inside the shell's — Audiences,
   * the creative detail experience and the coming-soon state — so those pages
   * offered a screen-reader user two "main content" targets with no way to tell
   * which was the page. axe files this under `best-practice`, which the tag
   * filter above excludes, so it is asked for by name.
   */
  for (const route of routes) {
    test(`${route.surfaceId} has one main landmark`, async ({ page }) => {
      await openSurface(page, handle, route.path);
      const results = await new AxeBuilder({ page })
        .withRules(["landmark-no-duplicate-main", "landmark-unique", "landmark-one-main"])
        .analyze();
      expect(
        results.violations.map(
          (violation) => `${violation.id} ×${violation.nodes.length} — ${violation.help}`,
        ),
        `landmark violations on ${route.path}`,
      ).toEqual([]);
    });
  }
});

/** Anything wider than the viewport that the page itself scrolls to reach. */
async function sidewaysOverflow(page: Page, width: number): Promise<string[]> {
  return page.evaluate((viewport: number) => {
    const offenders: string[] = [];
    const documentScrolls =
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    if (documentScrolls) {
      for (const node of Array.from(document.querySelectorAll("body *"))) {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right <= viewport + 1) continue;
        if (!(node as HTMLElement).checkVisibility({ checkVisibilityCSS: true })) continue;
        // A container that declares itself a horizontal scroller is allowed:
        // some content genuinely cannot fit 320px, and scrolling it inside its
        // own frame is the answer. Scrolling the whole surface is not.
        let ancestor: Element | null = node;
        let inDeclaredScroller = false;
        while (ancestor) {
          if (ancestor.hasAttribute("data-scroll-x")) {
            inDeclaredScroller = true;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        if (inDeclaredScroller) continue;
        offenders.push(
          `<${node.tagName.toLowerCase()}> right=${Math.round(rect.right)} "${(node.textContent ?? "").trim().slice(0, 40)}"`,
        );
        if (offenders.length >= 5) break;
      }
      if (offenders.length === 0) offenders.push("the document scrolls sideways, source unresolved");
    }
    return offenders;
  }, width);
}

test.describe("D13 — real content stays reachable as the viewport narrows", () => {
  for (const route of routes) {
    test(`${route.surfaceId} fits every required width`, async ({ page }) => {
      const failures: string[] = [];
      for (const width of WIDTHS) {
        for (const theme of ["light", "dark"] as const) {
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ colorScheme: theme });
          await openSurface(page, handle, route.path);

          for (const offender of await sidewaysOverflow(page, width)) {
            failures.push(`${width}px ${theme}: ${offender}`);
          }

          // Nothing that is on screen may be clipped to nothing: a control with
          // a zero box is a control the operator cannot press.
          const collapsed = await page.evaluate(() => {
            const dead: string[] = [];
            for (const node of Array.from(
              document.querySelectorAll("main button, main a[href], main select, main input"),
            )) {
              /*
               * `checkVisibility`, not `getComputedStyle(node).display`.
               *
               * Reading the element's own style says nothing about its
               * ancestors, and these surfaces ship a mobile composition and a
               * desktop one in the same DOM with one of them switched off.
               * Every control inside the hidden branch measures 0×0 and is not
               * a defect — it is the layout working. `checkVisibility` walks
               * the chain, which is the question being asked.
               */
              if (!(node as HTMLElement).checkVisibility({ checkVisibilityCSS: true })) continue;
              const rect = node.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) {
                dead.push(
                  `<${node.tagName.toLowerCase()}> "${(node.textContent ?? "").trim().slice(0, 30)}"`,
                );
              }
              if (dead.length >= 5) break;
            }
            return dead;
          });
          for (const control of collapsed) failures.push(`${width}px ${theme}: 0×0 ${control}`);
        }
      }
      expect(failures, `responsive defects on ${route.path}`).toEqual([]);
    });
  }
});
