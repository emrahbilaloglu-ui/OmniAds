/**
 * D084 Correction 3 — responsive proof with a real CSS engine.
 *
 * WHAT r3 CLAIMED AND WHY IT WAS NOT PROOF. r3 asserted the layout by matching
 * the stylesheet text with a regex and by checking that jsdom had created the
 * DOM nodes. jsdom applies no CSS whatsoever: it can never report a resolved
 * `grid-template-columns`, a bounding box, an overlap or a horizontal overflow.
 * So neither check could observe the property being claimed.
 *
 * This renders the REAL Decision Center surface against its REAL stylesheet in
 * Chromium and measures the outcome: the computed column count, both direction
 * panels' bounding boxes, side-by-side versus stacked, no horizontal overflow,
 * no overlap, and the disabled CTA. Screenshots and a JSON receipt are written
 * as durable evidence.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

const HARNESS_DIR = path.join(process.cwd(), "playwright", ".harness");
const EVIDENCE_DIR = path.join(process.cwd(), "playwright", ".evidence", "d084-budget-evidence");

function harnessUrl(width: number): string {
  const file = path.join(HARNESS_DIR, `budget-evidence-${width}.html`);
  if (!existsSync(file)) {
    throw new Error(
      `missing harness page ${file}. Run: node --import tsx scripts/zero-base/build-budget-evidence-harness.tsx`,
    );
  }
  return pathToFileURL(file).href;
}

interface DirectionBox { x: number; y: number; width: number; height: number }

test.describe("budget-decision evidence layout, measured by a browser", () => {
  test.beforeAll(() => { mkdirSync(EVIDENCE_DIR, { recursive: true }); });

  for (const [label, width, height] of [
    ["desktop", 1440, 900],
    ["mobile", 390, 844],
  ] as const) {
    test(`${label} ${width}px: real computed layout`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(harnessUrl(width));

      const container = page.locator('[data-el="budget-directions"]');
      await expect(container).toHaveCount(1);
      const increase = page.locator('[data-el="budget-decision-direction"][data-direction="increase"]');
      const decrease = page.locator('[data-el="budget-decision-direction"][data-direction="decrease"]');
      await expect(increase).toBeVisible();
      await expect(decrease).toBeVisible();

      // The resolved value from the CSS engine, not the stylesheet text.
      const gridTemplateColumns = await container.evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns,
      );
      const tracks = gridTemplateColumns.trim().split(/\s+/);
      // `auto-fit` collapses tracks it does not fill to `0px`, so the resolved
      // value at 1440px is `450px 450px 0px`. Counting raw tracks would call
      // that three columns; the occupied count is what the layout means. This
      // is precisely the kind of thing a stylesheet regex cannot observe.
      const columnCount = tracks.filter((t) => Number.parseFloat(t) > 0).length;

      const box = async (loc: typeof increase): Promise<DirectionBox> => {
        const b = await loc.boundingBox();
        if (!b) throw new Error("no bounding box");
        return b;
      };
      const a = await box(increase);
      const b = await box(decrease);

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));

      const ctaDisabled = await page.locator('[data-el="budget-cta"]').evaluateAll(
        (nodes) => nodes.length > 0 && nodes.every((n) => (n as HTMLButtonElement).disabled),
      );

      // Lineage must be visibly distinguishable between the two directions.
      const increaseAvailability = await increase.locator('[data-el="commercial-availability"]').getAttribute("data-status");
      const decreaseAvailability = await decrease.locator('[data-el="commercial-availability"]').getAttribute("data-status");
      const increaseAction = await increase.locator('[data-el="direction-action"]').getAttribute("data-action");
      const decreaseAction = await decrease.locator('[data-el="direction-action"]').getAttribute("data-action");

      const sideBySide = Math.abs(a.y - b.y) < 4 && a.x !== b.x;
      const stacked = b.y >= a.y + a.height - 1;
      const overlap = !(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1);

      const receipt = {
        // Correction 4: this is NOT the authenticated surface. It is the real
        // component and the real stylesheet in a real CSS engine, driven by a
        // synthetic view model. The authenticated receipts live in
        // playwright/.evidence/d084-authenticated/.
        receiptKind: "static_component_harness",
        satisfiesAuthenticatedSurfaceGate: false,
        surface: "MetaDecisionCenterExact (real component, real MetaDecisionCenterExact.module.css, synthetic view model)",
        harnessUrl: harnessUrl(width),
        viewport: { width, height },
        gridTemplateColumns,
        resolvedTracks: tracks,
        occupiedColumnCount: columnCount,
        increase: a,
        decrease: b,
        sideBySide,
        stacked,
        overlap,
        overflow,
        ctaDisabled,
        commercialAvailability: { increase: increaseAvailability, decrease: decreaseAvailability },
        directionAction: { increase: increaseAction, decrease: decreaseAction },
      };
      writeFileSync(
        path.join(EVIDENCE_DIR, `layout-${label}-${width}.json`),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, `budget-evidence-${label}-${width}.png`),
        fullPage: true,
      });

      // --- the assertions the regex could never make ---
      if (label === "desktop") {
        expect(columnCount, `desktop must resolve to two occupied columns, got ${gridTemplateColumns}`).toBe(2);
        expect(sideBySide, "desktop panels must sit side by side").toBe(true);
        expect(stacked).toBe(false);
      } else {
        expect(columnCount, `mobile must resolve to one occupied column, got ${gridTemplateColumns}`).toBe(1);
        expect(stacked, "mobile panels must stack").toBe(true);
        expect(sideBySide).toBe(false);
      }
      expect(overlap, "direction panels must not overlap").toBe(false);
      expect(overflow.scrollWidth, "the page must not scroll horizontally")
        .toBeLessThanOrEqual(overflow.clientWidth + 1);
      expect(a.width).toBeGreaterThan(0);
      expect(b.width).toBeGreaterThan(0);
      expect(ctaDisabled, "every CTA must stay disabled").toBe(true);
      // The server's per-action lineage reaches the pixels, distinctly.
      expect(increaseAction).toBe("scale");
      expect(decreaseAction).toBe("cut");
      expect(increaseAvailability).toBe("resolved");
      expect(decreaseAvailability).toBe("read_failed");
      await expect(increase).toContainText("SCALE-SPECIFIC");
      await expect(decrease).toContainText("CUT-SPECIFIC");
      // The exact canonical code and contract must be VISIBLE text, not just
      // data attributes: r4 rendered the contract only as an attribute.
      await expect(increase).toContainText("Canonical code: SCALE_CODE");
      await expect(increase).toContainText("Canonical eligibility: false");
      await expect(increase).toContainText("adsecute.account-decision-profile.v1");
      await expect(decrease).toContainText("CUT-SPECIFIC: the account decision profile read failed");
      // The explanation must stay inside its own column.
      const pre = increase.locator('[data-el="commercial-anchor-explanation"]');
      if (await pre.count()) {
        const inside = await pre.evaluate((el) => {
          const col = el.closest('[data-el="budget-decision-direction"]') as HTMLElement;
          return el.getBoundingClientRect().right <= col.getBoundingClientRect().right + 1;
        });
        expect(inside, "the anchor explanation must not escape its column").toBe(true);
      }
    });
  }
});
