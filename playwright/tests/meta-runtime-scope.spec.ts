/**
 * D6 and D14, against the mounted routes.
 *
 * D6 fixes three account postures and forbids the two dishonest answers: `null`
 * must never mean "all accounts", and an invalid or revoked selection must never
 * fall back silently. Until now every proof of that was a unit test holding an
 * object it had built itself. This drives the real `/c/:businessId/...` routes
 * with a real session against a real database, which is what D14 requires
 * before anything may be called ready.
 */
import { expect, test } from "@playwright/test";
import { Client } from "pg";

import {
  canonicalRoutesFor,
  openSurface,
  runtimeHandle,
  type RuntimeHandle,
} from "../helpers/meta-runtime";

const handle: RuntimeHandle = runtimeHandle();

/** The top bar states the resolved account, so it is where the posture shows. */
async function scopeText(page: import("@playwright/test").Page): Promise<string> {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

test.describe("D6 — the three account postures, on the real surface", () => {
  test("zero accounts says so, and never renders account data as empty", async ({ page }) => {
    await openSurface(page, handle, `/c/${handle.businesses.zeroAccounts}/meta/decisions`);

    const text = await scopeText(page);
    // The stated posture. "No Meta ad account" is a refusal to scope, which is
    // D6's zero case; a zero, an empty list or a dash would be D8's defect.
    expect(text).toContain("No Meta ad account");
    // And it must not have borrowed another business's account.
    expect(text).not.toContain(handle.accounts.one);
    expect(text).not.toContain(handle.accounts.manyA);
    expect(text).not.toContain(handle.accounts.otherTenant);
  });

  test("one account resolves to that account", async ({ page }) => {
    await openSurface(page, handle, `/c/${handle.businesses.oneAccount}/meta/decisions`);

    const text = await scopeText(page);
    expect(text).toContain(handle.accounts.one);
    expect(text).not.toContain("No Meta ad account");
  });

  test("many accounts resolves to the selected one, not to both and not to all", async ({
    page,
  }) => {
    await openSurface(page, handle, `/c/${handle.businesses.manyAccounts}/meta/decisions`);

    const text = await scopeText(page);
    expect(text).toContain(handle.accounts.manyA);
    // The unselected sibling must not appear in the resolved scope. A surface
    // that showed both would be reading "all accounts", which D6 forbids.
    const scope = await page.locator("[data-account-scope], header").first().innerText();
    expect(scope).not.toContain(handle.accounts.manyB);
  });
});

test.describe("switching business cannot leave the previous account on screen", () => {
  /**
   * The plan's rollback trigger 3.
   *
   * Cross-account cache keys were business-scoped only, so switching served the
   * previous account's rows under the new business's name. This walks the two
   * postures in one session, which is the sequence that produced it.
   */
  test("one account, then zero accounts, in the same session", async ({ page }) => {
    await openSurface(page, handle, `/c/${handle.businesses.oneAccount}/meta/decisions`);
    expect(await scopeText(page)).toContain(handle.accounts.one);

    await openSurface(page, handle, `/c/${handle.businesses.zeroAccounts}/meta/decisions`);
    const after = await scopeText(page);
    expect(after).toContain("No Meta ad account");
    expect(after).not.toContain(handle.accounts.one);
  });

  test("many accounts, then one account, in the same session", async ({ page }) => {
    await openSurface(page, handle, `/c/${handle.businesses.manyAccounts}/meta/decisions`);
    expect(await scopeText(page)).toContain(handle.accounts.manyA);

    await openSurface(page, handle, `/c/${handle.businesses.oneAccount}/meta/decisions`);
    const after = await scopeText(page);
    expect(after).toContain(handle.accounts.one);
    expect(after).not.toContain(handle.accounts.manyA);
  });
});

test.describe("tenant isolation", () => {
  test("a business the operator is not a member of serves no data", async ({ page }) => {
    await page.goto(`${handle.baseUrl}/c/${handle.businesses.otherTenant}/meta/decisions`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("load");

    const text = await scopeText(page);
    expect(text).not.toContain(handle.accounts.otherTenant);
    expect(text).not.toContain("Other Tenant Co.");
  });

  test("the API refuses the same business by id", async ({ page }) => {
    // A same-origin page first: `fetch("/api/…")` from `about:blank` has no
    // base URL to resolve against, and the resulting TypeError would read as
    // a refusal that never happened.
    await page.goto(`${handle.baseUrl}/c/${handle.businesses.oneAccount}/meta/decisions`, {
      waitUntil: "domcontentloaded",
    });
    const result = await page.evaluate(async (businessId: string) => {
      const response = await fetch(`/api/businesses/${businessId}`, {
        credentials: "include",
        cache: "no-store",
      });
      return { status: response.status, body: (await response.text()).slice(0, 400) };
    }, handle.businesses.otherTenant);

    expect(result.status, result.body).toBeGreaterThanOrEqual(400);
    expect(result.body).not.toContain("Other Tenant Co.");
  });
});

test.describe("no session, no surface", () => {
  // The one place the shared operator session must not apply.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("every canonical route refuses an unauthenticated request", async ({ page }) => {
    const refused: string[] = [];
    for (const route of canonicalRoutesFor(handle.businesses.oneAccount)) {
      const response = await page.goto(`${handle.baseUrl}${route.path}`, {
        waitUntil: "domcontentloaded",
      });
      const url = page.url();
      const body = await page.locator("body").innerText();
      const landedOnLogin = /\/login/.test(url) || body.includes("Sign in");
      const servedScope = body.includes(handle.accounts.one);
      if (!landedOnLogin || servedScope) {
        refused.push(`${route.surfaceId} → ${response?.status()} ${url}`);
      }
    }
    expect(refused, "routes that served something without a session").toEqual([]);
  });
});

test.describe("the fixture is real, and the read-back proves it", () => {
  /**
   * The rows the surface read are the rows in the database.
   *
   * Without this, "the page said act_1000000000000001" only proves the page
   * says something; it does not prove it came from the selection contract.
   */
  test("the selection contract holds exactly one selected account per business", async () => {
    const client = new Client({ connectionString: process.env.META_RUNTIME_DATABASE_URL });
    await client.connect();
    try {
      const rows = await client.query<{ business_id: string; selected: string; total: string }>(
        `SELECT business_id,
                COUNT(*) FILTER (WHERE is_selected) AS selected,
                COUNT(*) AS total
           FROM business_provider_accounts
          WHERE provider = 'meta'
          GROUP BY business_id
          ORDER BY business_id`,
      );
      const byBusiness = new Map(rows.rows.map((row) => [row.business_id, row]));

      expect(byBusiness.get(handle.businesses.zeroAccounts)).toBeUndefined();
      expect(byBusiness.get(handle.businesses.oneAccount)).toMatchObject({
        selected: "1",
        total: "1",
      });
      expect(byBusiness.get(handle.businesses.manyAccounts)).toMatchObject({
        selected: "1",
        total: "2",
      });
    } finally {
      await client.end();
    }
  });
});
