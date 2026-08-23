/**
 * D8, on the mounted routes: missing data is not zero.
 *
 * *"Bozuk, yetkisiz, eksik veya şeması hazır olmayan kaynak: boş liste, 0, —,
 * success olarak gösterilemez."* Every existing proof of that is a unit test
 * holding a hand-built model. The fixture this runs against is the real case:
 * a business with a connected Meta account, an explicit selection, and not one
 * row of warehouse data anywhere. Every number on every surface is therefore
 * unknown, and the surface has to say so.
 *
 * It found one. The Decision Center printed "Spend · today ₺0 — 0 conversions ·
 * 7d avg 0" because `totals()` reduces an empty row set to zero, on the same
 * screen that said the warehouse was still being prepared.
 */
import { expect, test, type Page } from "@playwright/test";

import { canonicalRoutesFor, openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();
const routes = canonicalRoutesFor(handle.businesses.oneAccount);

/**
 * Value-shaped text that would be a claim about the world.
 *
 * Deliberately narrow. A **count** of served rows is not a metric — "Action Now
 * 0" and "Campaigns & ad sets served 0" are true statements about a set the
 * surface really did read, and D8 is about a measurement that was never taken.
 * What is caught here is a money, ratio or rate value rendered as zero.
 */
const ZERO_METRIC = /^(?:[$€₺£]\s?0(?:[.,]00?)?|0(?:[.,]0+)?\s?(?:x|%)|0[.,]00)$/;

async function zeroMetrics(page: Page): Promise<string[]> {
  return page.evaluate((pattern: string) => {
    const test = new RegExp(pattern);
    const found: string[] = [];
    for (const node of Array.from(document.querySelectorAll("main *"))) {
      if (node.children.length > 0) continue;
      if (!(node as HTMLElement).checkVisibility({ checkVisibilityCSS: true })) continue;
      const text = (node.textContent ?? "").trim();
      if (!test.test(text)) continue;
      const label = (node.parentElement?.textContent ?? "").trim().replace(/\s+/g, " ");
      found.push(`"${text}" in "${label.slice(0, 60)}"`);
      if (found.length >= 6) break;
    }
    return found;
  }, ZERO_METRIC.source);
}

test.describe("D8 — an unobserved measurement is never rendered as zero", () => {
  for (const route of routes) {
    test(`${route.surfaceId} states the absence instead of inventing a value`, async ({ page }) => {
      await openSurface(page, handle, route.path);
      const offenders = await zeroMetrics(page);
      expect(
        offenders,
        `${route.path} rendered a zero-valued metric for an account with no warehouse data`,
      ).toEqual([]);
    });
  }
});

test.describe("an empty collection is never rendered bare", () => {
  /**
   * §9's `empty-proven` versus `degraded`, in the form that can be checked from
   * outside: a table or list with no rows must not simply stop. Either it says
   * something, or it renders the em-dash placeholder that means "not served".
   * A bare set of column headers with nothing under them is the collapse the
   * state contract exists to prevent — it reads as "there is nothing here" when
   * the truth may be "we could not read it".
   *
   * What this cannot check is that the surface NAMES its state. No production
   * body emits the §9 read state at all, which is WP6's open item and is
   * recorded as a finding rather than asserted here.
   */
  for (const route of routes) {
    test(`${route.surfaceId} leaves no empty collection unexplained`, async ({ page }) => {
      await openSurface(page, handle, route.path);
      const bare = await page.evaluate(() => {
        const offenders: string[] = [];
        const collections = document.querySelectorAll(
          "main table, main [role='list'], main [data-collection]",
        );
        for (const node of Array.from(collections)) {
          if (!(node as HTMLElement).checkVisibility({ checkVisibilityCSS: true })) continue;
          const rows = node.querySelectorAll("tbody tr, [role='listitem'], li");
          if (rows.length > 0) continue;
          // Nothing under the headers. The surrounding block must account for
          // it — a sentence, or the em-dash that stands for "not served".
          const container = node.closest("section, article, div") ?? node;
          const text = (container.textContent ?? "").replace(/\s+/g, " ");
          const accounts =
            text.includes("—") ||
            /no |not |none|empty|unavailable|withheld|yet\b/i.test(text);
          if (!accounts) {
            offenders.push(
              `<${node.tagName.toLowerCase()}> with no rows in "${text.slice(0, 70)}"`,
            );
          }
          if (offenders.length >= 4) break;
        }
        return offenders;
      });
      expect(bare, `${route.path} rendered an empty collection with no account of it`).toEqual([]);
    });
  }
});

test.describe("D7 — the evidence window is stated where a surface claims one", () => {
  /**
   * Three separate clocks, and the plan forbids using one for another. What is
   * checked here is the weaker, checkable half: a surface that reads a window
   * names the window it read, so the number on screen can be tied to a period.
   */
  const WINDOWED = ["meta-intelligence", "meta-history", "creative-audiences"];
  for (const route of routes.filter((entry) => WINDOWED.includes(entry.surfaceId))) {
    test(`${route.surfaceId} names its evidence window`, async ({ page }) => {
      await openSurface(page, handle, route.path);
      const text = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
      // An ISO date pair. The exact wording differs per surface and is not the
      // contract; naming the period is.
      expect(
        /\d{4}-\d{2}-\d{2}\s*(?:to|→|-|–)\s*\d{4}-\d{2}-\d{2}/.test(text),
        `${route.path} did not state the window it read:\n${text.slice(0, 300)}`,
      ).toBe(true);
    });
  }
});

test.describe("D6 — an account-scoped surface withholds without an account", () => {
  /**
   * The zero-account business. Every account-scoped surface must refuse rather
   * than render an empty version of itself, because an empty Decisions queue and
   * a Decisions queue that was never scoped look identical.
   */
  const ACCOUNT_SCOPED = ["meta-decisions", "meta-intelligence", "meta-history"];
  for (const surfaceId of ACCOUNT_SCOPED) {
    test(`${surfaceId} withholds when no account is assigned`, async ({ page }) => {
      const route = canonicalRoutesFor(handle.businesses.zeroAccounts).find(
        (entry) => entry.surfaceId === surfaceId,
      )!;
      await openSurface(page, handle, route.path);
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      expect(text).toContain("No Meta ad account");
      expect(await zeroMetrics(page)).toEqual([]);
    });
  }
});
