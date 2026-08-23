/**
 * WP17 security, measured rather than asserted.
 *
 * The WP16/WP17 report is explicit that this was PARTIAL: WP9 closed one real
 * token-leak path and *"tenant isolation, CSRF and rate limiting were not
 * re-audited."* Each of those is a runtime question — whether a request from
 * this browser, with this session, is refused — and none of them can be settled
 * by reading the source.
 *
 * Tenant isolation lives in `meta-runtime-scope.spec.ts`, beside the account
 * postures it is really about.
 */
import { expect, test } from "@playwright/test";

import { canonicalRoutesFor, openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();
const routes = canonicalRoutesFor(handle.businesses.oneAccount);

/**
 * The seeded access token.
 *
 * Not a credential — it reaches no provider — but it is stored exactly where a
 * real one is, so anything that would leak a real token leaks this one.
 */
const SEEDED_TOKEN = "runtime-evidence-not-a-real-token";

test.describe("no secret reaches the browser", () => {
  test("no rendered surface contains the stored provider token", async ({ page }) => {
    const leaked: string[] = [];
    for (const route of routes) {
      await openSurface(page, handle, route.path);
      const html = await page.content();
      if (html.includes(SEEDED_TOKEN)) leaked.push(route.surfaceId);
      // The Graph host in a client payload is how the token leak WP9 fixed
      // reached the browser: a provider URL carrying `access_token=`.
      if (/graph\.facebook\.com[^"']*access_token=/.test(html)) {
        leaked.push(`${route.surfaceId} (graph url with token)`);
      }
    }
    expect(leaked, "surfaces that shipped a secret to the client").toEqual([]);
  });

  test("no API response body carries the stored provider token", async ({ page }) => {
    const leaked: string[] = [];
    page.on("response", async (response) => {
      if (!response.url().includes("/api/")) return;
      const type = response.headers()["content-type"] ?? "";
      if (!type.includes("json") && !type.includes("text")) return;
      const body = await response.text().catch(() => "");
      if (body.includes(SEEDED_TOKEN)) leaked.push(response.url().replace(handle.baseUrl, ""));
    });
    for (const route of routes) {
      await openSurface(page, handle, route.path);
    }
    await page.waitForTimeout(1000);
    expect(leaked, "API responses that returned a secret").toEqual([]);
  });
});

test.describe("the session cookie is not readable by script", () => {
  test("the auth cookie is HttpOnly", async ({ page, context }) => {
    await openSurface(page, handle, `/c/${handle.businesses.oneAccount}/meta/decisions`);
    const cookies = await context.cookies();
    const auth = cookies.filter((cookie) => /session|auth|token/i.test(cookie.name));
    expect(auth.length, `no session cookie found among ${cookies.map((c) => c.name).join(", ")}`)
      .toBeGreaterThan(0);
    const readable = auth.filter((cookie) => !cookie.httpOnly).map((cookie) => cookie.name);
    expect(readable, "session cookies a script could read").toEqual([]);

    const fromScript = await page.evaluate(() => document.cookie);
    expect(fromScript).not.toContain(SEEDED_TOKEN);
    for (const cookie of auth) expect(fromScript).not.toContain(cookie.value);
  });
});

test.describe("a state-changing request needs more than a session", () => {
  /**
   * A cross-site form post carries the cookie. If that is all a write needs,
   * any page the operator visits can act as them.
   *
   * The browser owns `Origin` and will not let a script set it, so what this
   * actually sends is the shape a cross-site form can send with no preflight:
   * `application/x-www-form-urlencoded`, cookies attached, no JSON content type
   * and no custom header. A route that accepts that is reachable from any site
   * the operator is logged in on.
   */
  test("a simple form-encoded POST with only the session cookie is refused", async ({ page }) => {
    await openSurface(page, handle, `/c/${handle.businesses.oneAccount}/meta/decisions`);
    const result = await page.evaluate(async () => {
      const response = await fetch("/api/businesses", {
        method: "POST",
        // A form content type is what a cross-site form can send without a
        // preflight; JSON cannot be sent cross-origin without CORS consent.
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        credentials: "include",
        body: "name=csrf-probe",
      });
      return { status: response.status, body: (await response.text()).slice(0, 200) };
    });
    expect(
      result.status,
      `a form-encoded POST was accepted: ${result.body}`,
    ).toBeGreaterThanOrEqual(400);
  });
});

test.describe("login is rate limited", () => {
  test("repeated wrong passwords are throttled before they are guessed", async ({ page }) => {
    await page.goto(`${handle.baseUrl}/login`);
    const statuses = await page.evaluate(async (email: string) => {
      const seen: number[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: `wrong-${attempt}` }),
        });
        seen.push(response.status);
      }
      return seen;
    }, handle.operator.email);

    expect(statuses.some((status) => status === 429), `statuses: ${statuses.join(",")}`).toBe(true);
    expect(statuses.every((status) => status !== 200)).toBe(true);
  });
});
