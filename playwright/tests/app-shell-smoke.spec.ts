import { expect, test } from "@playwright/test";

/**
 * The shell itself, on desktop and on mobile.
 *
 * Two production regressions motivated this file, and neither was catchable by
 * any existing test: the public header rendered with only the logo and no
 * visible "Log in", and /overview rendered its top bar and content with NO left
 * navigation at all — an authenticated app you cannot navigate.
 *
 * Both are shell-level, so they are asserted at the shell level: is the primary
 * way to move around the product actually VISIBLE to a user at this viewport.
 * `toBeVisible()` rather than presence, because both regressions had the markup
 * in the DOM the whole time — it was hidden, not missing, and a presence check
 * would have stayed green through both.
 */

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

// ── Public shell ───────────────────────────────────────────────────────────

test.describe("public shell", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("desktop: header exposes a visible Log in that reaches /login", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/");

    const login = page.getByRole("link", { name: "Log in", exact: true });
    await expect(login).toBeVisible();
    await expect(login).toHaveAttribute("href", /\/login/);

    await login.click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator("#email")).toBeVisible();
  });

  test("mobile: a sign-in path is reachable without a desktop-only control", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/");

    // Below md the desktop cluster is hidden by design. What must NOT happen is
    // that the ONLY way in disappears with it: either a visible Log in remains,
    // or the menu that contains it is reachable and labelled.
    const directLogin = page.getByRole("link", { name: "Log in", exact: true });
    if (await directLogin.isVisible().catch(() => false)) {
      await directLogin.click();
    } else {
      const toggle = page.getByRole("button", { name: /menu/i });
      await expect(
        toggle,
        "below md there is no visible Log in and no labelled menu button, so the product cannot be entered on a phone",
      ).toBeVisible();
      await toggle.click();
      const menuLogin = page.getByRole("link", { name: "Log in", exact: true });
      await expect(menuLogin).toBeVisible();
      await menuLogin.click();
    }

    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator("#email")).toBeVisible();
  });

  test("login page carries its own way back to the marketing site", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/login");
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();

    // The title said this and the body did not check it: every auth screen used
    // to be a dead end, with the brand mark rendered aria-hidden.
    const home = page.getByRole("link", { name: /adsecute home|^Adsecute$/i }).first();
    await expect(home).toBeVisible();
    await home.click();
    await expect(page).toHaveURL(/\/$|\/$/);
  });

  test("Enter submits the sign-in form", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/login");
    // The inputs used to live in a bare <div> behind a type="button", so Enter
    // did nothing at all. Wrong credentials on purpose: the point is that
    // something HAPPENS, not that it succeeds.
    await page.locator("#email").fill("not-a-real-user@adsecute.invalid");
    await page.locator("#password").fill("definitely-not-the-password");
    await page.locator("#password").press("Enter");
    await expect(page.locator(".ad-auth-alert")).toBeVisible();
  });

  test("public legal pages keep the marketing header and its Log in", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    // These are exactly where the footer sends people; they used to replace the
    // header with a logo and a back-link, dropping every route to sign in.
    for (const route of ["/privacy", "/terms", "/security"]) {
      await page.goto(route);
      await expect(
        page.getByRole("link", { name: "Log in", exact: true }),
        `${route} has no visible Log in`,
      ).toBeVisible();
    }
  });
});

// ── Authenticated shell ────────────────────────────────────────────────────

// Real destinations only. `/platforms` has no page of its own — it is a URL
// prefix, not a route — and asserting against it tests the 404 page, not the
// shell.
const PRIMARY_ROUTES = ["/overview", "/platforms/meta", "/integrations", "/settings", "/insights"];

test.describe("authenticated shell", () => {
  test("desktop: primary navigation is visible on every core route", async ({ page }) => {
    await page.setViewportSize(DESKTOP);

    for (const route of PRIMARY_ROUTES) {
      await page.goto(route);
      // Not redirected to login — the fixture is signed in.
      await expect(page).not.toHaveURL(/\/login/);

      const sidebar = page.locator("[data-shell-sidebar]");
      await expect(
        sidebar,
        `${route} rendered without a visible left navigation; the app is unnavigable there`,
      ).toBeVisible();

      // A rail with no destinations in it is not navigation.
      const links = sidebar.getByRole("link");
      expect(await links.count(), `${route} sidebar contains no links`).toBeGreaterThan(0);
    }
  });

  test("desktop: the shell persists across navigation, it is not a per-route accident", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/overview");
    await expect(page.locator("[data-shell-sidebar]")).toBeVisible();

    const target = page.locator("[data-shell-sidebar]").getByRole("link").first();
    const href = await target.getAttribute("href");
    await target.click();
    if (href) await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    await expect(
      page.locator("[data-shell-sidebar]"),
      "the sidebar disappeared after navigating from /overview",
    ).toBeVisible();
  });

  test("mobile: authenticated navigation is reachable", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/overview");
    await expect(page).not.toHaveURL(/\/login/);

    // The desktop rail is hidden below md by design. Something has to replace
    // it, or the authenticated product cannot be navigated on a phone at all.
    const drawerToggle = page.getByRole("button", { name: /open navigation|menu|navigation/i });
    await expect(
      drawerToggle,
      "no mobile navigation control on an authenticated route; the sidebar is hidden below md and nothing replaces it",
    ).toBeVisible();

    await drawerToggle.click();
    const mobileNav = page.locator("[data-shell-mobile-nav]");
    await expect(mobileNav).toBeVisible();
    expect(await mobileNav.getByRole("link").count()).toBeGreaterThan(0);
  });

  test("no console errors while the shell renders", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(String(error)));

    await page.setViewportSize(DESKTOP);
    await page.goto("/overview");
    await expect(page.locator("[data-shell-sidebar]")).toBeVisible();

    const ignorable = /favicon|third-party cookie|Download the React DevTools/i;
    const real = errors.filter((entry) => !ignorable.test(entry));
    expect(real, `console errors while rendering the shell:\n${real.join("\n")}`).toEqual([]);
  });
});
