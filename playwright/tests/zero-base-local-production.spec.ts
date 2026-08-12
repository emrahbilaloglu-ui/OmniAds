/**
 * Local production smoke (§13.2) — credential-free.
 *
 * The release gate has to prove that what a build produces actually boots and
 * serves, not only that the sources compile. Everything else in the aggregate
 * measures a dev render or a static harness; this is the only stage that runs
 * the real standalone server the deploy would run.
 *
 * It asks nothing that needs a secret. The environment it boots with is
 * committed and worthless: the database host is `.invalid`, which by RFC 2606
 * never resolves, and no provider id is real. That is deliberate — a gate that
 * only runs on a machine holding someone's personal `.env.local` is a gate CI
 * can never hold, and a gate CI cannot hold is not a release gate.
 *
 * So the questions are the ones a credential cannot help with:
 *
 *  - do the public surfaces render at all in a production build;
 *  - did the Ledger design system actually ship in the production CSS, or only
 *    in the dev render every other stage measures;
 *  - are the vendored faces served, so the typography is the shipping one;
 *  - does the auth boundary still refuse an unauthenticated request by sending
 *    it to login, rather than erroring its way into a page.
 *
 * Nothing here writes, and nothing reaches a provider.
 */
import { test, expect } from "@playwright/test";

import { MARKETING_PAGES } from "../../scripts/zero-base/capture-marketing-snapshots";

/**
 * The surfaces a person with no account can reach, and nothing else.
 *
 * The marketing set is not restated here — it is read from `MARKETING_PAGES`,
 * the same list the copy snapshot and the marketing tests use, so a new public
 * surface cannot be added there and quietly stay out of the smoke that proves
 * it renders. `marketing.test.ts` pins that list's exact ids, which makes the
 * denominator below exact rather than a hopeful sample.
 *
 * Two public auth pages are added because they are reachable without an
 * account and render deterministically.
 *
 * Excluded, each for a stated reason rather than by omission:
 *
 *  - `/reset` and `/select-language` redirect (307) rather than render, so a
 *    200 assertion would be wrong about them;
 *  - `/share/creative/[token]` and `/share/report/[token]` need a valid token,
 *    and an invalid one exercises the refusal path, not the render path. They
 *    belong in a smoke with a real local fixture, which this is not;
 *  - `/shopify/connect` is an install landing surface whose behaviour depends
 *    on Shopify-supplied query parameters.
 */
const PUBLIC_ROUTES = [
  ...MARKETING_PAGES.map((page) => page.url),
  "/login",
  "/signup",
] as const;

test.describe("zero-base local production smoke", () => {
  test("every public surface renders from the production build", async ({ page }) => {
    // The count is asserted so a surface silently dropped from the list is a
    // failure rather than a smaller, still-green run.
    expect(PUBLIC_ROUTES.length, "the public surface set changed").toBe(12);
    for (const route of PUBLIC_ROUTES) {
      const response = await page.goto(route, { waitUntil: "domcontentloaded" });
      expect(response, `${route} returned no response`).not.toBeNull();
      expect(response!.status(), `${route} did not render`).toBe(200);
      // A page that renders its own crash is still a 200.
      const body = await page.locator("body").innerText();
      expect(body.toLowerCase(), `${route} rendered an error page`).not.toContain(
        "application error",
      );
      expect(body.trim().length, `${route} rendered nothing`).toBeGreaterThan(0);
    }
  });

  test("the Ledger design system shipped in the production CSS", async ({ page, request }) => {
    await page.goto("/login", { waitUntil: "domcontentloaded" });

    const hrefs = await page
      .locator('link[rel="stylesheet"]')
      .evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).getAttribute("href") ?? ""));
    expect(hrefs.length, "the production page served no stylesheet").toBeGreaterThan(0);

    let tokens = 0;
    let root = 0;
    for (const href of hrefs) {
      const css = await (await request.get(href)).text();
      // Counting, not just presence: a single stray token would pass a boolean.
      tokens += (css.match(/--ledger-/g) ?? []).length;
      root += (css.match(/adc-ui/g) ?? []).length;
    }
    expect(tokens, "no Ledger token reached the production CSS").toBeGreaterThan(50);
    expect(root, "the zero-base root selector never shipped").toBeGreaterThan(0);
  });

  test("the vendored Ledger faces are served, not fallen back to", async ({ request }) => {
    // The frame harness had to embed these because a static file cannot resolve
    // `next/font`; production serves them from `public/`, and every screenshot
    // in the evidence set is only the shipping typeface if this holds.
    for (const face of [
      "/fonts/zero-base/schibsted-grotesk-variable.woff2",
      "/fonts/zero-base/fragment-mono-400.woff2",
    ]) {
      const response = await request.get(face);
      expect(response.status(), `${face} is not served`).toBe(200);
      expect(Number(response.headers()["content-length"] ?? 0), `${face} is empty`).toBeGreaterThan(
        1000,
      );
    }
  });

  test("an unauthenticated request to a workspace surface is refused, not served", async ({
    request,
  }) => {
    const response = await request.get("/overview", { maxRedirects: 0 });
    expect([302, 303, 307, 308], "an unauthenticated /overview was not redirected").toContain(
      response.status(),
    );
    expect(response.headers()["location"] ?? "", "the refusal did not lead to login").toContain(
      "/login",
    );
  });
});
