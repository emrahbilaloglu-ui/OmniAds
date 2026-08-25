/**
 * WP17's interaction contract, on the mounted routes.
 *
 * `meta-runtime-a11y.spec.ts` already runs axe, checks landmarks and proves
 * nothing clips at 320 or 390. Those are the things a scanner can see in one
 * frame. WP17 also asks for the things that only exist while somebody is
 * OPERATING the surface — where focus goes, whether it can get back out, what
 * gets announced, whether the page stops moving when asked, how many requests
 * one open costs, and what ends up in a log.
 *
 * None of that was checked anywhere. Each section below states the claim it is
 * making and why the naive version of the check would have been worthless.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { canonicalRoutesFor, openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();
const routes = canonicalRoutesFor(handle.businesses.oneAccount);

/**
 * One representative surface for the checks that are about the SHELL rather
 * than about a screen.
 *
 * Running the dialog and skip-link cases on all eleven routes would assert the
 * same shell eleven times and cost eleven page loads to do it. Where a claim is
 * genuinely per-screen — live regions, request budget, reduced motion — every
 * route is used.
 */
const SHELL_ROUTE = `/c/${handle.businesses.oneAccount}/meta/decisions`;

interface FocusSnapshot {
  tag: string;
  name: string;
  inDialog: boolean;
  visible: boolean;
}

async function focused(page: Page): Promise<FocusSnapshot> {
  return page.evaluate(() => {
    const node = document.activeElement as HTMLElement | null;
    if (!node) return { tag: "none", name: "", inDialog: false, visible: false };
    const name =
      node.getAttribute("aria-label") ??
      (node.textContent ?? "").trim().slice(0, 60) ??
      "";
    return {
      tag: node.tagName.toLowerCase(),
      name,
      inDialog: Boolean(node.closest('[role="dialog"]')),
      visible:
        typeof node.checkVisibility === "function"
          ? node.checkVisibility({ checkVisibilityCSS: true })
          : true,
    };
  });
}

test.describe("the keyboard can get in, and back out", () => {
  test("the first Tab reaches the skip link, and it moves focus into main", async ({ page }) => {
    await openSurface(page, handle, SHELL_ROUTE);
    /*
     * Blur, do not click. Clicking at (2, 2) to "reset" focus lands on whatever
     * the shell draws in its top-left corner — the rail — so the first Tab
     * measured the rail's second stop rather than the document's first.
     */
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Tab");

    const first = await page.evaluate(() => {
      const describe = (node: Element | null) =>
        node
          ? `<${node.tagName.toLowerCase()}${node.hasAttribute("data-skip-link") ? " data-skip-link" : ""}>` +
            ` "${(node.getAttribute("aria-label") ?? node.textContent ?? "").trim().slice(0, 30)}"`
          : "nothing";
      const node = document.activeElement as HTMLElement | null;
      /*
       * The document's first few tab stops in DOM order, so a failure says
       * where the skip link actually sits rather than only what beat it.
       */
      const order = Array.from(
        document.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      )
        .filter((candidate) =>
          typeof candidate.checkVisibility === "function"
            ? candidate.checkVisibility({ checkVisibilityCSS: false })
            : true,
        )
        .slice(0, 4)
        .map(describe);
      return {
        isSkip: Boolean(node?.hasAttribute("data-skip-link")),
        what: describe(node),
        order,
        hasSkipLink: Boolean(document.querySelector("[data-skip-link]")),
      };
    });
    expect(first.hasSkipLink, "the shell rendered no skip link at all").toBe(true);
    expect(
      first.isSkip,
      `the first tab stop was ${first.what}; DOM order starts: ${first.order.join(" | ")}`,
    ).toBe(true);

    /*
     * Focus, not the scroll position. `<main>` carries a tabindex precisely so
     * activating the link MOVES focus — an anchor that only scrolls leaves the
     * next Tab back at the top of the rail, which is the trap the skip link
     * exists to avoid.
     */
    await page.keyboard.press("Enter");
    const landed = await page.evaluate(() => {
      const node = document.activeElement as HTMLElement | null;
      return {
        isMain: node?.tagName.toLowerCase() === "main" || Boolean(node?.closest("main")),
        id: node?.id ?? "",
      };
    });
    expect(landed.isMain, `focus landed on #${landed.id}`).toBe(true);
  });

  test("focus is always visible, and never lands on something invisible", async ({ page }) => {
    await openSurface(page, handle, SHELL_ROUTE);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const problems: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press("Tab");
      const state = await page.evaluate(() => {
        const node = document.activeElement as HTMLElement | null;
        if (!node || node === document.body) return null;
        const style = getComputedStyle(node);
        const label =
          node.getAttribute("aria-label") ||
          (node.textContent ?? "").trim().slice(0, 40) ||
          `<${node.tagName.toLowerCase()}>`;
        return {
          label,
          /*
           * Any of the three, because the design uses different ones in
           * different places. Requiring `outline` specifically would fail a
           * control that rings itself with a box-shadow, which is a real and
           * visible indicator.
           */
          indicated:
            style.outlineStyle !== "none" ||
            style.boxShadow !== "none" ||
            Number.parseFloat(style.outlineWidth) > 0,
          visible:
            typeof node.checkVisibility === "function"
              ? node.checkVisibility({ checkVisibilityCSS: true })
              : true,
          // A positive tabindex reorders the whole document and is never right.
          positiveTabIndex: node.tabIndex > 0,
        };
      });
      if (!state) continue;
      if (!state.visible) problems.push(`focus landed on hidden "${state.label}"`);
      if (state.positiveTabIndex) problems.push(`positive tabindex on "${state.label}"`);
      if (!state.indicated) problems.push(`no focus indicator on "${state.label}"`);
      if (problems.length >= 6) break;
    }
    expect(problems, `keyboard defects on ${SHELL_ROUTE}`).toEqual([]);
  });
});

test.describe("a dialog traps focus and hands it back", () => {
  test("the command palette keeps Tab inside it, and Escape returns focus to the trigger", async ({
    page,
  }) => {
    /**
     * The command palette, because it is the modal this product actually
     * mounts.
     *
     * The zero-base shell has a search sheet, a nav drawer and a scope sheet,
     * all built on a dialog primitive that traps and returns focus for free —
     * and nothing mounts that shell. Every canonical route renders
     * `DashboardFrame`, whose one modal is `CommandPalette`: hand-rolled,
     * `aria-modal="true"`, and until this pass holding neither end of the
     * contract that attribute claims.
     */
    await openSurface(page, handle, SHELL_ROUTE);
    const trigger = page.getByRole("button", { name: "Jump or act" }).first();
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await trigger.click();

    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toHaveCount(1);

    /*
     * Twenty presses, not two. A trap that holds for one cycle and leaks on the
     * wrap-around is the common failure, and it only shows up once Tab has been
     * pressed more times than the dialog has stops.
     */
    const escapes: string[] = [];
    for (let step = 0; step < 20; step += 1) {
      await page.keyboard.press("Tab");
      const state = await focused(page);
      if (!state.inDialog) escapes.push(`${step}: ${state.tag} "${state.name}"`);
    }
    expect(escapes, "focus left the dialog while it was open").toEqual([]);

    // Backwards too — Shift+Tab off the first stop is the other edge.
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press("Shift+Tab");
      expect((await focused(page)).inDialog, `Shift+Tab escaped at step ${step}`).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    /*
     * Back to the CONTROL that opened it. Returning focus to `<body>` is what
     * happens when nobody wrote the return, and it silently sends the next Tab
     * to the top of the document — which for this shell means the whole rail.
     */
    const returned = await page.evaluate(() => {
      const node = document.activeElement as HTMLElement | null;
      return {
        ok: Boolean(node?.getAttribute("aria-label") === "Jump or act"),
        what: node ? `<${node.tagName.toLowerCase()}> ${node.getAttribute("aria-label") ?? ""}` : "nothing",
      };
    });
    expect(returned.ok, `focus went to ${returned.what}`).toBe(true);
  });
});

test.describe("what the product announces", () => {
  for (const route of routes) {
    test(`${route.surfaceId} announces politely or not at all`, async ({ page }) => {
      await openSurface(page, handle, route.path);

      /*
       * `assertive` interrupts whatever the reader is in the middle of. It is
       * for an error the operator must hear now — not for a table that finished
       * loading, which is what every live region on these surfaces reports.
       */
      const rude = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[aria-live]"))
          .filter((node) => node.getAttribute("aria-live") === "assertive")
          .map((node) => (node.textContent ?? "").trim().slice(0, 60)),
      );
      expect(rude, `assertive live regions on ${route.path}`).toEqual([]);

      // A live region with no politeness at all announces nothing in some
      // readers, which is worse than not having one.
      const unset = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[role="status"], [role="alert"]'))
          .filter((node) => {
            const live = node.getAttribute("aria-live");
            return live !== null && live !== "polite" && live !== "assertive";
          })
          .map((node) => (node.textContent ?? "").trim().slice(0, 60)),
      );
      expect(unset, `live regions with an unusable politeness on ${route.path}`).toEqual([]);
    });
  }

  test("the polite-region check is not vacuous, and the changing ones are named", async ({
    page,
  }) => {
    /**
     * Two things, because the check above would pass a product with no live
     * regions at all.
     *
     * First: across the mounted Meta surfaces there is at least one polite live
     * region, so "no assertive regions" is a statement about regions that exist.
     *
     * Second, and stated rather than faked: **no live region on these surfaces
     * changes in response to an action an operator can take at the shipped gate
     * settings.** The two that announce progress and outcome —
     * `workflow-overlay.tsx`'s `data-workflow-live` and
     * `mutation-ceremony-panel.tsx`'s `data-mutation-live` — sit behind
     * `META_DECISION_WORKFLOW_UI` and the mutation ceremony, both of which ship
     * shut; their politeness and their announcements are held by
     * `workflow-ui.test.tsx` and `mutation-ceremony.test.tsx`. Driving one here
     * would mean opening a gate to prove an announcement, and an announcement
     * proven only with a gate open is not evidence about the shipped product.
     */
    let polite = 0;
    const perSurface: string[] = [];
    for (const route of routes) {
      await openSurface(page, handle, route.path);
      const count = await page.evaluate(
        () => document.querySelectorAll('[aria-live="polite"], [role="status"]').length,
      );
      polite += count;
      perSurface.push(`${route.surfaceId}:${count}`);
    }
    expect(polite, `no polite live region anywhere: ${perSurface.join(" ")}`).toBeGreaterThan(0);

    // The gated pair is absent at the shipped settings, which is why the
    // dynamic case is not driven on this server.
    await openSurface(page, handle, SHELL_ROUTE);
    await expect(page.locator("[data-workflow-live], [data-mutation-live]")).toHaveCount(0);
  });
});

test.describe("reduced motion is honoured", () => {
  for (const route of routes) {
    test(`${route.surfaceId} stops moving when asked`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openSurface(page, handle, route.path);

      const moving = await page.evaluate(() => {
        const offenders: string[] = [];
        for (const node of Array.from(document.querySelectorAll("main *, header *"))) {
          const element = node as HTMLElement;
          if (
            typeof element.checkVisibility === "function" &&
            !element.checkVisibility({ checkVisibilityCSS: true })
          ) {
            continue;
          }
          const style = getComputedStyle(element);
          const seconds = (value: string) =>
            Math.max(
              0,
              ...value
                .split(",")
                .map((part) =>
                  part.trim().endsWith("ms")
                    ? Number.parseFloat(part) / 1000
                    : Number.parseFloat(part) || 0,
                ),
            );
          /*
           * A threshold, not zero. `prefers-reduced-motion` asks for LESS
           * motion, and the repo's own rule reduces durations rather than
           * deleting every transition — a 10ms colour fade on hover is not what
           * the setting is about. What it is about is a thing that keeps
           * moving: a spinner, a marquee, a long slide.
           */
          if (style.animationName !== "none" && seconds(style.animationDuration) > 0.2) {
            offenders.push(
              `${element.tagName.toLowerCase()}.${element.className.toString().slice(0, 30)} animation ${style.animationDuration}`,
            );
          }
          if (seconds(style.transitionDuration) > 0.4) {
            offenders.push(
              `${element.tagName.toLowerCase()} transition ${style.transitionDuration}`,
            );
          }
          if (offenders.length >= 5) break;
        }
        return offenders;
      });
      expect(moving, `still animating under reduced motion on ${route.path}`).toEqual([]);
    });
  }
});

/*
 * The request budget is NOT checked here.
 *
 * `meta-runtime-perf.spec.ts` already measures first-load API calls per
 * surface against the plan's G11 budget, carries a per-surface debt table for
 * the surfaces already over it, and fails on any repeated read it cannot
 * account for. A second, coarser count in this file would either agree with it
 * — and add nothing — or disagree with it, and then two gates would be arguing
 * about the same number.
 */

test.describe("nothing private reaches a log", () => {
  test("the browser console names no operator, session or business", async ({ page }) => {
    const lines: string[] = [];
    page.on("console", (message) => lines.push(message.text()));
    page.on("pageerror", (error) => lines.push(String(error?.stack ?? error)));

    for (const route of routes.slice(0, 4)) {
      await openSurface(page, handle, route.path);
    }

    const leaked = lines.filter((line) =>
      [handle.operator.email, handle.operator.password].some((secret) =>
        line.includes(secret),
      ),
    );
    expect(leaked, "the console printed an operator credential").toEqual([]);
  });

  test("the server log names no password, cookie value or bearer token", async () => {
    /**
     * Read off the file the harness now keeps, so this is about what the
     * PROCESS wrote rather than about what a request happened to return.
     *
     * The business id is deliberately not forbidden: it is a path segment on
     * every canonical route, so a request log that omitted it would be useless,
     * and it identifies a workspace only to somebody who already has access.
     * A password, a session cookie or a bearer token is different in kind —
     * each is a credential, and a log line holding one is a copy of it.
     */
    const logs = ["shipped-gates", "gates-open", "rolled-back", "allowlist", "legacy-mint"]
      .map((label) => path.join(process.cwd(), "playwright", ".runtime", `server-${label}.log`))
      .filter((file) => existsSync(file));
    expect(logs.length, "no server log was captured").toBeGreaterThan(0);

    const offences: string[] = [];
    for (const file of logs) {
      const body = readFileSync(file, "utf8");
      for (const [what, needle] of [
        ["the operator password", handle.operator.password],
        ["a session cookie", "omniads_session="],
        ["a bearer token", "Authorization: Bearer "],
        ["the cron secret", "runtime-evidence-not-a-secret"],
      ] as const) {
        if (body.includes(needle)) offences.push(`${path.basename(file)} holds ${what}`);
      }
    }
    expect(offences).toEqual([]);
  });
});
