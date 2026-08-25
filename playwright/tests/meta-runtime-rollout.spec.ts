/**
 * WP4's rollout acceptance, on running servers:
 * *"ZERO_BASE_UI_MODE off, allowlist ve on senaryoları /c ve /app yollarında
 * çalışıyor."*
 *
 * Until now none of it worked, and no test could have noticed. The mode
 * defaults to `off`; the only route that acted on it —
 * `app/c/[businessId]/layout.tsx` — is unreachable, because
 * `resolvePublicRouteRedirect` rewrites `/c/:businessId/**` into `/app/**`
 * before any page renders; and `/app` read the predicate only to report it in
 * an envelope. So the shipped configuration said "rolled back" while the
 * canonical console served every surface.
 *
 * Four postures are exercised here, three of them on their own server, because
 * a mode is a property of a process and one process can only be in one:
 *
 *   on             → the canonical owner renders
 *   allowlist, in  → the canonical owner renders
 *   allowlist, out → the preserved legacy owner
 *   off            → the preserved legacy owner
 *
 * And the two entry families are checked separately. `/c` and `/app` must agree,
 * which they do for a structural reason rather than a coincidental one: `/c` is
 * rewritten into `/app`, so both meet the same decision in the same dispatcher.
 */
import { expect, test, type Page } from "@playwright/test";

import { runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();

/** In the allowlist. Everything else in the fixture is outside it. */
const LISTED = handle.businesses.oneAccount;
const UNLISTED = handle.businesses.manyAccounts;

/**
 * Where a request ended up, without asserting on page text.
 *
 * The canonical console and the legacy console are different route families, so
 * the URL is the honest signal — and it is the one an operator would see. Body
 * text would drift with copy; a pathname does not.
 */
async function landing(
  page: Page,
  baseUrl: string,
  path: string,
): Promise<{ pathname: string; search: string }> {
  await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load");

  /*
   * Settle on the URL, not on the load event.
   *
   * A `redirect()` from a Server Component does not always arrive as a 307 on
   * the document request: Next can serve a 200 whose payload instructs the
   * client to navigate, and then the address bar changes AFTER `load`. Reading
   * `page.url()` at that moment reports the URL asked for rather than the one
   * arrived at — which is how the first run of this file reported every
   * fallback as "stayed canonical" while the server was redirecting correctly.
   *
   * Two identical consecutive reads is the signal, the same one `openSurface`
   * uses for content.
   */
  let previous: string | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = page.url();
    if (current === previous) break;
    previous = current;
    await page.waitForTimeout(100);
  }

  const url = new URL(page.url());
  return { pathname: url.pathname, search: url.search };
}

/**
 * The surfaces under test, and the legacy owner each falls back to.
 *
 * Derived by hand HERE on purpose, unlike the production map: a test that
 * imported the same table the code derives from would agree with it whatever it
 * said. These are the destinations read out of the legacy route tree.
 */
const SURFACES = [
  { appPath: "/app/meta/decisions", legacy: "/platforms/meta" },
  { appPath: "/app/meta/history", legacy: "/platforms/meta/history" },
  { appPath: "/app/meta/automation", legacy: "/platforms/meta/automation" },
  { appPath: "/app/meta/launchpad", legacy: "/platforms/meta/launchpad" },
  { appPath: "/app/creative/performance", legacy: "/platforms/meta/creatives" },
  { appPath: "/app/creative/copies", legacy: "/platforms/meta/copies" },
  { appPath: "/app/creative/audiences", legacy: "/platforms/meta/audiences" },
  { appPath: "/app/manage/integrations", legacy: "/integrations" },
  // The four the compatibility table alone would have refused: their URLs never
  // changed, so they are not "changed legacy paths", and their screens render.
  { appPath: "/app/klaviyo", legacy: "/platforms/klaviyo" },
  { appPath: "/app/google/products", legacy: "/platforms/google/products" },
  { appPath: "/app/google/plan", legacy: "/platforms/google/plan" },
  { appPath: "/app/manage/plan", legacy: "/settings" },
] as const;

/** Introduced with the canonical console. Nothing earlier to fall back to. */
const NO_LEGACY_OWNER = [
  "/app/meta/intelligence",
  "/app/creative/briefs",
  "/app/creative/shares",
] as const;

test.describe("on — the canonical owner renders", () => {
  for (const surface of SURFACES) {
    test(`${surface.appPath} stays canonical`, async ({ page }) => {
      const { pathname } = await landing(page, handle.baseUrl, surface.appPath);
      expect(pathname).toBe(surface.appPath);
    });
  }

  test("and /c reaches the same place", async ({ page }) => {
    const { pathname } = await landing(
      page,
      handle.baseUrl,
      `/c/${LISTED}/meta/decisions`,
    );
    expect(pathname).toBe("/app/meta/decisions");
  });
});

test.describe("off — the preserved legacy owner, never a 404", () => {
  for (const surface of SURFACES) {
    test(`${surface.appPath} falls back to ${surface.legacy}`, async ({ page }) => {
      const { pathname } = await landing(
        page,
        handle.rolledBackBaseUrl,
        surface.appPath,
      );
      expect(pathname).toBe(surface.legacy);
    });
  }

  test("/c falls back too, because it is rewritten into /app first", async ({ page }) => {
    const { pathname } = await landing(
      page,
      handle.rolledBackBaseUrl,
      `/c/${LISTED}/meta/decisions`,
    );
    expect(pathname).toBe("/platforms/meta");
  });

  test("the legacy spelling stays put rather than bouncing back", async ({ page }) => {
    /**
     * The loop, checked from the other end.
     *
     * `compatibility.ts` sends a legacy path to the canonical URL when the mode
     * is on. If it did that while the mode is off, the two halves would trade
     * the request for ever. One predicate governs both, so it cannot — and this
     * asks the running server rather than trusting the argument.
     */
    const { pathname } = await landing(
      page,
      handle.rolledBackBaseUrl,
      "/platforms/meta",
    );
    expect(pathname).toBe("/platforms/meta");
  });

  test("the query survives the hop", async ({ page }) => {
    /**
     * Asserted on the URL the hop LANDED on, not on the one that is there when
     * the dust settles.
     *
     * The legacy History page re-resolves its own window on arrival — it
     * replaces a bare `startDate` with a full `window`/`startDate`/`endDate`
     * triple. That is the destination doing its job, and checking the final
     * address bar would be asserting the destination's behaviour rather than
     * the hop's. So every URL the page visits is recorded, and the claim is
     * that the query arrived intact at the legacy route.
     */
    const visited: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) visited.push(frame.url());
    });

    const { pathname } = await landing(
      page,
      handle.rolledBackBaseUrl,
      "/app/meta/history?kind=writes&startDate=2026-07-01",
    );
    expect(pathname).toBe("/platforms/meta/history");

    const arrival = visited.find((url) => url.includes("/platforms/meta/history"));
    expect(arrival, `no navigation to the legacy route: ${visited.join(" → ")}`).toBeDefined();
    const arrived = new URL(arrival!).searchParams;
    expect(arrived.get("kind")).toBe("writes");
    expect(arrived.get("startDate")).toBe("2026-07-01");
  });

  for (const appPath of NO_LEGACY_OWNER) {
    test(`${appPath} names itself rather than borrowing a screen`, async ({ page }) => {
      const { pathname } = await landing(page, handle.rolledBackBaseUrl, appPath);
      // It did not redirect anywhere, and it is not a 404.
      expect(pathname).toBe(appPath);
      await expect(page.locator("[data-rolled-back-surface]")).toHaveCount(1);
      await expect(page.locator("[data-rolled-back-surface]")).toHaveAttribute(
        "data-rolled-back-reason",
        "mode-off",
      );
    });
  }
});

test.describe("allowlist — one business in, the rest out", () => {
  test("the named business gets the canonical console", async ({ page }) => {
    const { pathname } = await landing(
      page,
      handle.allowlistBaseUrl,
      `/c/${LISTED}/meta/decisions`,
    );
    expect(pathname).toBe("/app/meta/decisions");
  });

  test("a business the list does not name gets the legacy owner", async ({ page }) => {
    /*
     * The switch is what makes this a real allowlist test rather than two
     * separate ones: the same server, the same session, two businesses, two
     * different answers.
     */
    const { pathname } = await landing(
      page,
      handle.allowlistBaseUrl,
      `/c/${UNLISTED}/meta/decisions`,
    );
    expect(pathname).toBe("/platforms/meta");
  });

  test("and switching back returns to the canonical console", async ({ page }) => {
    // A decision that stuck to the session rather than to the business would
    // pass the two cases above and fail this one.
    await landing(page, handle.allowlistBaseUrl, `/c/${UNLISTED}/meta/decisions`);
    const { pathname } = await landing(
      page,
      handle.allowlistBaseUrl,
      `/c/${LISTED}/meta/decisions`,
    );
    expect(pathname).toBe("/app/meta/decisions");
  });

  test("an unlisted business still gets a named refusal for a new-only surface", async ({
    page,
  }) => {
    const { pathname } = await landing(
      page,
      handle.allowlistBaseUrl,
      `/c/${UNLISTED}/creative/shares`,
    );
    expect(pathname).toBe("/app/creative/shares");
    await expect(page.locator("[data-rolled-back-surface]")).toHaveAttribute(
      "data-rolled-back-reason",
      "not-enabled",
    );
  });
});

test.describe("the rollback grants nothing and discloses nothing", () => {
  test("an unauthenticated request still goes to login, not to a legacy body", async ({
    browser,
  }) => {
    /**
     * Ordering, asserted rather than argued: authorization runs before the
     * rollout decision. A fallback that redirected first would answer "does
     * this business exist" with a `Location` header for anyone who can type a
     * URL.
     */
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      const { pathname } = await landing(
        page,
        handle.rolledBackBaseUrl,
        `/c/${LISTED}/meta/decisions`,
      );
      expect(pathname).toBe("/login");
    } finally {
      await context.close();
    }
  });

  test("a business the operator is not a member of is still refused", async ({ page }) => {
    // The rollback must not become a softer door into another tenant.
    const response = await page.goto(
      `${handle.rolledBackBaseUrl}/c/${handle.businesses.otherTenant}/meta/decisions`,
      { waitUntil: "domcontentloaded" },
    );
    expect(response?.status()).toBeGreaterThanOrEqual(400);
  });

  test("no rolled-back page names the environment variable", async ({ page }) => {
    // An operator cannot set a deployment variable and must not be sent looking
    // for one — the same rule the release gates follow.
    for (const appPath of NO_LEGACY_OWNER) {
      await landing(page, handle.rolledBackBaseUrl, appPath);
      expect(await page.content()).not.toMatch(/ZERO_BASE_UI_[A-Z_]*/);
    }
  });
});
