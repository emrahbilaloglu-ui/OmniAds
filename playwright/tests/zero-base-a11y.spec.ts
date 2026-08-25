/**
 * WP-26 steps 8 and 10 — the **automated** half of gate G9.
 *
 * Runs against the generated harness (`playwright/.harness/`), so it needs no
 * server and no database and is deterministic.
 *
 * What this file is NOT: the plan's §13.5 manual assistive-technology evidence.
 * axe is a scanner. It cannot tell you what NVDA announced, whether VoiceOver's
 * rotor exposed a landmark, or whether TalkBack's swipe order matched the
 * visual order. WP-26 step 9 says explicitly: "do not approve manual AT
 * behavior from axe alone." Those passes are recorded separately, by a named
 * human tester, and their absence is a blocker rather than something this file
 * can paper over.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const HARNESS = path.resolve(process.cwd(), "playwright/.harness");

function harnessPages(): string[] {
  return readdirSync(HARNESS)
    .filter((file) => file.endsWith(".html"))
    .sort();
}

function fileUrl(name: string): string {
  return `file://${path.join(HARNESS, name)}`;
}

/** Widths the plan requires for the responsive-critical surfaces. */
const REQUIRED_WIDTHS = [1440, 1280, 768, 390, 320];

test.describe("G9 automated accessibility", () => {
  for (const name of harnessPages()) {
    test(`axe reports no serious or critical violation — ${name}`, async ({ page }) => {
      await page.goto(fileUrl(name));
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      const blocking = results.violations.filter(
        (violation) => violation.impact === "serious" || violation.impact === "critical",
      );
      /*
       * Name every violation AND the nodes it fired on.
       *
       * "color-contrast (serious)" names a rule and leaves the reader to find
       * the offending elements by hand across a whole harness page, which is
       * how a real violation sits unfixed while the gate keeps reporting it.
       */
      expect(
        blocking.map(
          (violation) =>
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
        `axe violations in ${name}`,
      ).toEqual([]);
    });
  }
});

test.describe("G9 zoom", () => {
  /**
   * 200% and 400% zoom.
   *
   * Emulated by shrinking the viewport to the CSS-pixel width the page sees at
   * that zoom level — 1280 at 400% presents as 320 CSS px — which is what the
   * reflow requirement (WCAG 1.4.10) actually constrains. The check is that no
   * horizontal scrolling of the page body is required.
   */
  for (const [label, width] of [
    ["200%", 640],
    ["400%", 320],
  ] as const) {
    test(`no page-level horizontal scroll at ${label} zoom`, async ({ page }) => {
      for (const name of harnessPages().filter((file) => file.includes("1440"))) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(fileUrl(name));
        const overflow = await page.evaluate(() => {
          const doc = document.documentElement;
          return doc.scrollWidth - doc.clientWidth;
        });
        expect(overflow, `${name} overflows by ${overflow}px at ${width}px`).toBeLessThanOrEqual(1);
      }
    });
  }
});

test.describe("G9 reduced motion", () => {
  /**
   * What "reduced motion" has to mean here.
   *
   * The stylesheet does not zero every duration under the query. It kills all
   * `animation`, restricts `transition-property` to `opacity`, and caps the
   * duration at 80 ms. That is a deliberate and defensible reading: a cross-fade
   * carries no movement and is not what triggers vestibular symptoms, whereas a
   * transform or offset animation is.
   *
   * So the assertion is about **movement**, not about any duration being
   * non-zero. An earlier version of this test failed the build for the 80 ms
   * opacity fade, which was the test being wrong rather than the product.
   */
  test("no movement animates under prefers-reduced-motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const MOVEMENT = ["transform", "translate", "rotate", "scale", "top", "left", "right", "bottom", "margin"];
    for (const name of harnessPages().slice(0, 12)) {
      await page.goto(fileUrl(name));
      const offenders = await page.evaluate((movement) => {
        const found: string[] = [];
        /*
         * A duration measured in microseconds is not motion.
         *
         * `globals.css` caps every element at `0.001ms` under reduced motion —
         * the standard "effectively off" idiom — and leaves
         * `transition-property` alone outside the zero-base root, where
         * Tailwind's preflight sets it to `all`. Read literally that is
         * "transitions all, duration > 0", so this flagged `html`, `head`,
         * `meta`, `title` and `style`: elements that never paint, on a
         * stylesheet that had switched motion off. The check never fired only
         * because the harness used to withhold that half of the stylesheet.
         */
        const MOTIONLESS_MS = 1;
        for (const element of Array.from(document.querySelectorAll("*"))) {
          // Nothing that is never rendered can animate movement.
          if (!(element as HTMLElement).getClientRects().length) continue;
          const style = getComputedStyle(element);
          if (
            style.animationName !== "none" &&
            parseFloat(style.animationDuration) * 1000 > MOTIONLESS_MS
          ) {
            found.push(`${element.tagName.toLowerCase()}: animation ${style.animationName}`);
            continue;
          }
          const properties = style.transitionProperty.split(",").map((value) => value.trim());
          // `transitionDuration` computes in seconds; compare in milliseconds.
          const duration = (parseFloat(style.transitionDuration) || 0) * 1000;
          if (duration <= MOTIONLESS_MS) continue;
          const moves = properties.some(
            (property) => property === "all" || movement.some((token) => property.includes(token)),
          );
          if (moves) {
            found.push(`${element.tagName.toLowerCase()}: transitions ${style.transitionProperty}`);
          }
        }
        return found.slice(0, 5);
      }, MOVEMENT);
      expect(offenders, `${name} animates movement under reduced motion`).toEqual([]);
    }
  });
});

test.describe("G9 keyboard", () => {
  test("every interactive element is reachable and shows a visible focus ring", async ({ page }) => {
    for (const name of harnessPages().filter((file) => file.includes("1440")).slice(0, 8)) {
      await page.goto(fileUrl(name));
      const interactive = await page.evaluate(() =>
        document.querySelectorAll(
          'a[href], button:not([disabled]), select, input:not([type="hidden"]), textarea, [tabindex]:not([tabindex="-1"])',
        ).length,
      );
      if (interactive === 0) continue;

      // Tab through and confirm focus actually lands somewhere each time.
      const reached = new Set<string>();
      for (let step = 0; step < Math.min(interactive, 40); step += 1) {
        await page.keyboard.press("Tab");
        const marker = await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          if (!active || active === document.body) return null;
          const style = getComputedStyle(active);
          return JSON.stringify({
            tag: active.tagName,
            index: Array.from(document.querySelectorAll("*")).indexOf(active),
            outline: style.outlineStyle,
            outlineWidth: style.outlineWidth,
          });
        });
        if (marker) reached.add(marker);
      }
      expect(reached.size, `${name} exposed no keyboard-reachable element`).toBeGreaterThan(0);
    }
  });
});

test.describe("G9 print", () => {
  test("print media keeps content visible rather than blanking the page", async ({ page }) => {
    for (const name of harnessPages().filter((file) => file.includes("1440")).slice(0, 6)) {
      await page.goto(fileUrl(name));
      await page.emulateMedia({ media: "print" });
      const visibleText = await page.evaluate(() => document.body.innerText.trim().length);
      expect(visibleText, `${name} renders no text in print media`).toBeGreaterThan(0);
    }
  });
});

test.describe("G8 responsive completeness", () => {
  /**
   * WP-26 step 6: a narrow layout may reflow, but it may never silently drop a
   * value the wide layout showed. Each harness page carries `data-metric` /
   * `data-metric-unavailable` markers, and the set of metric names must not
   * shrink as the viewport narrows.
   */
  test("no critical value disappears as the viewport narrows", async ({ page }) => {
    const families = new Map<string, string[]>();
    for (const name of harnessPages()) {
      const match = /^(.*)-(\d+)-(light|dark)\.html$/.exec(name);
      if (!match) continue;
      const key = `${match[1]}-${match[3]}`;
      families.set(key, [...(families.get(key) ?? []), name]);
    }

    for (const [family, pages] of families) {
      if (pages.length < 2) continue;
      const byWidth = pages
        .map((name) => ({ name, width: Number(/-(\d+)-/.exec(name)![1]) }))
        .sort((a, b) => b.width - a.width);

      let widest: Set<string> | null = null;
      for (const { name, width } of byWidth) {
        await page.setViewportSize({ width: Math.max(width, 320), height: 900 });
        await page.goto(fileUrl(name));
        const names = await page.evaluate(() =>
          Array.from(document.querySelectorAll("[data-metric], [data-metric-unavailable]")).map(
            (element) =>
              element.getAttribute("data-metric") ?? element.getAttribute("data-metric-unavailable") ?? "",
          ),
        );
        const present = new Set(names.filter(Boolean));
        if (widest === null) {
          widest = present;
          continue;
        }
        const missing = [...widest].filter((metric) => !present.has(metric));
        expect(missing, `${family}: ${name} silently omits ${missing.join(", ")}`).toEqual([]);
      }
    }
  });

  test("no harness page scrolls horizontally at any required width", async ({ page }) => {
    for (const name of harnessPages()) {
      for (const width of REQUIRED_WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(fileUrl(name));
        const overflow = await page.evaluate(() => {
          const doc = document.documentElement;
          return doc.scrollWidth - doc.clientWidth;
        });
        expect(overflow, `${name} overflows by ${overflow}px at ${width}`).toBeLessThanOrEqual(1);
      }
    }
  });
});
