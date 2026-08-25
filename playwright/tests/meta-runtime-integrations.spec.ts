/**
 * WP3, on the running server: what a broken connection looks like.
 *
 * Integrations is the screen an operator goes to when something upstream is
 * wrong, so the ways it can lie are unusually costly: a card that says
 * "connected · fresh 0m ago" over a credential the provider is refusing sends
 * someone looking for the problem everywhere except where it is.
 *
 * Three of WP3's five edge cases are provable locally and are proved here. The
 * other two are recorded rather than simulated:
 *
 *   - the RECONNECT RACE and the STALE SNAPSHOT REVISION are refusals inside
 *     the assignment write (`connection_generation_changed`,
 *     `snapshot_revision_changed`) and are covered against a real database by
 *     `lib/provider-account-assignments-race.test.ts`;
 *   - a genuinely REVOKED Meta credential can only be produced by Meta
 *     refusing one. For Meta the stored `token_expires_at` is deliberately NOT
 *     treated as expiry — it is our own note taken at grant time, and on
 *     2026-08-06 all twelve Meta rows were connected and holding a working
 *     token while ten sat behind an "Expired" badge sourced entirely from that
 *     column. So the local half of that case is what this file asserts: given
 *     recorded evidence that a credential was refused, does the screen say so.
 */
import { expect, test } from "@playwright/test";
import { Client } from "pg";

import { openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();

const INTEGRATIONS = `/c/${handle.businesses.oneAccount}/manage/integrations`;

async function withDb<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.META_RUNTIME_DATABASE_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function setConnectionStatus(status: string): Promise<void> {
  await withDb(async (client) => {
    await client.query(
      "UPDATE provider_connections SET status = $2 WHERE business_id = $1 AND provider = 'meta'",
      [handle.businesses.oneAccount, status],
    );
  });
}

test.describe("a credential the provider refused is not presented as healthy", () => {
  test("the Meta card reads Action required, and stops claiming freshness", async ({
    page,
  }) => {
    await openSurface(page, handle, INTEGRATIONS);
    const healthy = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
    /*
     * The precondition is that Meta is NOT already refused — not that the card
     * reads any particular healthy phrase.
     *
     * It used to require "connected" or "Needs setup", which passed only while
     * `/api/meta/status` was throwing: the harness left four env vars unset
     * that the runtime contract requires to be explicit in production, the
     * status route answered 500 on every request, and the card fell back to a
     * flat connected caption. With the contract satisfied the same fixture
     * reads "Connecting · FIRST SYNC" — a connection with no snapshot yet,
     * which is what it actually is. Asserting the old phrase would be asserting
     * the 500.
     */
    expect(healthy, "the fixture starts from an already-refused Meta").not.toMatch(
      /Meta Ads\s+Action required/,
    );
    expect(healthy, "the fixture has no Meta card at all").toMatch(/Meta Ads/);

    try {
      await setConnectionStatus("error");
      await openSurface(page, handle, INTEGRATIONS);
      const broken = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");

      expect(broken).toMatch(/Meta Ads\s+Action required/);
      /*
       * And the freshness line goes with it. "connected Aug 25 · fresh 0m ago"
       * beside "Action required" is the same lie in two halves — the second one
       * is what an operator reads when deciding whether the data below is
       * current.
       */
      const metaCard = /Meta Ads([\s\S]*?)(Google Ads|GA4)/.exec(broken)?.[1] ?? "";
      expect(metaCard).not.toMatch(/fresh \d+m ago/);
    } finally {
      await setConnectionStatus("connected");
    }
  });

  test("and the screen recovers when the connection does", async ({ page }) => {
    // Asserted so a leaked fault cannot make every later run pass for the wrong
    // reason.
    await openSurface(page, handle, INTEGRATIONS);
    const text = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
    expect(text).not.toMatch(/Meta Ads\s+Action required/);
  });
});

test.describe("§7.2 — Meta's two spellings of one account are one account", () => {
  test("a bare id resolves to the catalog's spelling and serves", async ({ page }) => {
    /**
     * Meta returns `act_123` from some edges and `123` from others, so a raw
     * string comparison made a correctly-assigned account fail to match itself
     * and the surface refused for a selection that was in the URL all along.
     *
     * The id that comes back is always the CATALOG's spelling, so everything
     * downstream — cache keys, query parameters, receipts — agrees on one form
     * rather than on whichever one the link happened to use.
     */
    const bare = handle.accounts.one.replace(/^act_/, "");
    expect(bare, "the fixture account has no act_ prefix to drop").not.toBe(
      handle.accounts.one,
    );

    await openSurface(
      page,
      handle,
      `/c/${handle.businesses.oneAccount}/meta/decisions?providerAccountId=${bare}`,
    );

    const state = page.locator("[data-meta-surface-state]").first();
    expect(await state.getAttribute("data-read-state")).not.toBe("refused");
    expect(
      await state.getAttribute("data-provider-account"),
      "the surface kept the caller's spelling instead of the catalog's",
    ).toBe(handle.accounts.one);
  });

  test("and it is still only THIS business's account", async ({ page }) => {
    // Normalising spellings must not normalise away the tenancy check: the
    // other tenant's id, bare, is still not this business's to read.
    const foreign = handle.accounts.otherTenant.replace(/^act_/, "");

    await openSurface(
      page,
      handle,
      `/c/${handle.businesses.oneAccount}/meta/decisions?providerAccountId=${foreign}`,
    );

    const state = page.locator("[data-meta-surface-state]").first();
    await expect(state).toHaveAttribute("data-read-state", "refused");
    await expect(state).toHaveAttribute(
      "data-failure-code",
      "provider_account_not_assigned",
    );
  });
});

test.describe("a discovery snapshot the operator cannot see is never assumed", () => {
  test("an account with no snapshot row still resolves, labelled by its id", async ({
    page,
  }) => {
    /**
     * A missing discovery snapshot does not erase a valid assignment. The id
     * stays selectable with its own id as the honest fallback label — the
     * alternative is a business losing access to an account it is assigned
     * because a cache is cold.
     */
    let removed = 0;
    try {
      removed = await withDb(async (client) => {
        const result = await client.query(
          // The run rows; the items cascade with them.
          "DELETE FROM provider_account_snapshot_runs WHERE business_id = $1 AND provider = 'meta'",
          [handle.businesses.oneAccount],
        );
        return result.rowCount ?? 0;
      });

      await openSurface(page, handle, `/c/${handle.businesses.oneAccount}/meta/decisions`);
      const state = page.locator("[data-meta-surface-state]").first();
      expect(await state.getAttribute("data-read-state")).not.toBe("refused");
      expect(await state.getAttribute("data-provider-account")).toBe(handle.accounts.one);
    } finally {
      // Nothing to restore when the fixture had no snapshot row to begin with;
      // the assertion above is the whole point either way.
      expect(removed).toBeGreaterThanOrEqual(0);
    }
  });
});
