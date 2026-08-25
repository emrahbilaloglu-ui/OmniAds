/**
 * WP6 — the §9 read state, on the mounted surfaces.
 *
 * The contract was defined and adopted by nothing: seven states, a closed
 * failure dictionary, and no production body that decided one or rendered one.
 * A surface could be read from outside and there was no way to tell "there is
 * nothing here" from "we could not read it", which is the distinction the
 * contract exists for.
 *
 * Every assertion here is against the real mounted route, over HTTP, with a
 * real session and the ephemeral database — including the degraded case, which
 * is provoked by breaking a real table and then repairing it rather than by
 * mocking a failure that cannot happen.
 */
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

import { META_READ_STATES } from "../../lib/meta/read-state-contract";
import { canonicalRoutesFor, openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();

/** The six surfaces WP6 names, in the order the plan lists them. */
const WP6_SURFACES = [
  "meta-decisions",
  "meta-intelligence",
  "creative-studio",
  "meta-history",
  "meta-launchpad",
  "meta-automation",
] as const;

interface ObservedState {
  surface: string | null;
  state: string | null;
  code: string | null;
  account: string | null;
  text: string;
}

async function readSurfaceState(page: Page): Promise<ObservedState | null> {
  return page.evaluate(() => {
    const node = document.querySelector("[data-meta-surface-state]");
    if (!node) return null;
    return {
      surface: node.getAttribute("data-meta-surface-state"),
      state: node.getAttribute("data-read-state"),
      code: node.getAttribute("data-failure-code"),
      account: node.getAttribute("data-provider-account"),
      text: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
    };
  });
}

function routeFor(surfaceId: string, businessId: string): string {
  const route = canonicalRoutesFor(businessId).find((entry) => entry.surfaceId === surfaceId);
  if (!route) throw new Error(`${surfaceId} has no canonical route`);
  return route.path;
}

test.describe("every WP6 surface states its read state", () => {
  for (const surfaceId of WP6_SURFACES) {
    test(`${surfaceId} carries a state from the closed vocabulary`, async ({ page }) => {
      await openSurface(page, handle, routeFor(surfaceId, handle.businesses.oneAccount));
      const observed = await readSurfaceState(page);

      expect(observed, `${surfaceId} rendered no §9 region at all`).not.toBeNull();
      expect(observed!.surface).toBe(surfaceId);
      expect(META_READ_STATES).toContain(observed!.state);
      // And it is not still claiming to be reading. A surface that has settled
      // and still says "Loading" is its own untruth, and it is what the
      // page-only half of this envelope used to leave on screen for ever.
      expect(observed!.state, `${surfaceId} never left loading`).not.toBe("loading");
    });
  }
});

test.describe("refused — D6, and never an empty screen instead", () => {
  for (const surfaceId of WP6_SURFACES) {
    test(`${surfaceId} is withheld, with a code, when no account is assigned`, async ({ page }) => {
      await openSurface(page, handle, routeFor(surfaceId, handle.businesses.zeroAccounts));
      const observed = await readSurfaceState(page);

      expect(observed, `${surfaceId} rendered no §9 region`).not.toBeNull();
      expect(observed!.state).toBe("refused");
      expect(observed!.code).toBe("provider_account_not_assigned");
      // The scope attribute is empty because there is no scope — not because
      // the attribute was forgotten.
      expect(observed!.account).toBeNull();
      // The operator sentence, not a status word.
      expect(observed!.text).toMatch(/not assigned to this workspace/);
    });
  }
});

test.describe("served — the state names what the read actually did", () => {
  test("a surface with an account and no rows is proven-empty, not degraded", async ({ page }) => {
    /*
     * The many-account business with an account CHOSEN, and no journal at all,
     * so proven-empty is the honest answer — a different answer from the one
     * the same screen must give when the journal cannot be read, which the
     * degraded case below provokes for real.
     *
     * The choice is explicit because the fixture now assigns this business two
     * accounts. It previously assigned one (the sibling was seeded unselected),
     * so this case was reading the 1-account posture and calling it many.
     */
    await openSurface(
      page,
      handle,
      `${routeFor("meta-history", handle.businesses.manyAccounts)}?providerAccountId=${handle.accounts.manyA}`,
    );
    const observed = await readSurfaceState(page);
    expect(observed!.state).toBe("empty-proven");
    expect(observed!.code).toBeNull();
  });

  test("a surface whose sources answered with rows is serving", async ({ page }) => {
    // History, whose journal the fixture seeds with three real action rows.
    // Automation is deliberately NOT the example any more: with an empty
    // ledger, no rules and no promotion records, `empty-proven` is its honest
    // answer and asserting `success` there would have been asserting a read
    // that returned nothing.
    await openSurface(page, handle, routeFor("meta-history", handle.businesses.oneAccount));
    const observed = await readSurfaceState(page);
    expect(observed!.state).toBe("success");
    expect(observed!.code).toBeNull();
  });

  test("a surface whose sources all answered with nothing is proven-empty", async ({ page }) => {
    // The many-account business with an account chosen, and no activity at all.
    // On the one-account business Automation reads the same action log History
    // does, so the seeded writes reach its ledger and `success` is the honest
    // answer there — a distinction worth having both sides of.
    await openSurface(
      page,
      handle,
      `${routeFor("meta-automation", handle.businesses.manyAccounts)}?providerAccountId=${handle.accounts.manyA}`,
    );
    const observed = await readSurfaceState(page);
    expect(observed!.state).toBe("empty-proven");
    expect(observed!.code).toBeNull();
  });

  test("a surface where one source did not answer is partly served", async ({ page }) => {
    // Account Intelligence composes eleven sections against a warehouse that
    // has not been prepared for this window. Some answer and some cannot, and
    // presenting that subset as the whole is the collapse §9 forbids.
    await openSurface(page, handle, routeFor("meta-intelligence", handle.businesses.oneAccount));
    const observed = await readSurfaceState(page);
    expect(observed!.state).toBe("partial");
    expect(observed!.code).toBe("source_read_failed");
    expect(observed!.text).toMatch(/unknown rather than zero/);
  });
});

test.describe("loading — observed while the read is genuinely in flight", () => {
  test("a client-reading surface says it is loading until its payload lands", async ({ page }) => {
    /*
     * Held, not mocked.
     *
     * The surface's own request is delayed and then allowed through unchanged,
     * so what is observed is the real route answering slowly rather than a
     * stubbed body. The first flush of the server HTML cannot be used for this:
     * the page content streams inside a Suspense boundary, so the region is not
     * in the initial bytes at all.
     */
    let released: (() => void) | null = null;
    const holding = new Promise<void>((resolve) => {
      released = resolve;
    });
    await page.route("**/api/meta/decisions-workspace**", async (route) => {
      await holding;
      // The handler outlives the test's own unroute when a request is released
      // at teardown; continuing an already-handled route is not a failure of
      // what is being measured.
      await route.continue().catch(() => {});
    });

    const navigation = page.goto(
      `${handle.baseUrl}${routeFor("meta-decisions", handle.businesses.oneAccount)}`,
      { waitUntil: "domcontentloaded" },
    );
    /*
     * Attached, not visible.
     *
     * `[data-meta-surface-state]` is the attribute carrier — the element every
     * gate reads `data-read-state` from — and it has no box of its own. Its
     * VISIBLE content is the notice inside it, and for `loading` that notice is
     * pinned out of flow so a state that always ends cannot move the page when
     * it does. Waiting for the carrier to be visible waits for a box that does
     * not exist and never will.
     */
    await page.waitForSelector("[data-meta-surface-state]", {
      state: "attached",
      timeout: 30_000,
    });
    const whileReading = await readSurfaceState(page);
    expect(whileReading!.state, "the surface claimed a state before it had read").toBe("loading");
    expect(whileReading!.text).toMatch(/Nothing below is final yet/);

    released!();
    await navigation;
    await page.unroute("**/api/meta/decisions-workspace**");

    // And it stops saying so once the payload lands, which is the half that
    // makes the first assertion mean something.
    await expect
      .poll(async () => (await readSurfaceState(page))?.state, { timeout: 30_000 })
      .not.toBe("loading");
  });
});

test.describe("refreshing-with-stale — rows on screen while a newer read runs", () => {
  test("a refresh over served rows is labelled, not blanked and not presented as current", async ({
    page,
  }) => {
    /*
     * §9's fourth state, and the one a spinner destroys.
     *
     * The surface is loaded, then a second read is held open while the previous
     * rows are still on screen. Blanking them to a skeleton throws away
     * readable evidence; leaving them unlabelled presents the previous window's
     * figures as the current window's. The state says which it is.
     */
    await openSurface(page, handle, routeFor("meta-decisions", handle.businesses.oneAccount));
    expect((await readSurfaceState(page))!.state).not.toBe("loading");

    let released: (() => void) | null = null;
    const holding = new Promise<void>((resolve) => {
      released = resolve;
    });
    await page.route("**/api/meta/decisions-workspace**", async (route) => {
      await holding;
      // The handler outlives the test's own unroute when a request is released
      // at teardown; continuing an already-handled route is not a failure of
      // what is being measured.
      await route.continue().catch(() => {});
    });

    // A window change through the shell's own control, which is the way an
    // operator triggers a second read. A synthetic history push does not: the
    // surface reads the window from the control's state, so nothing refetches
    // and the test would have been asserting against a page that never moved.
    await page.click("button.adv-date-range-trigger");
    await page.getByRole("button", { name: /Last 7 days/ }).first().click();
    // The picker stages a choice and applies it on confirm — choosing without
    // applying changes nothing, which is why a click on the preset alone left
    // the surface untouched and this test asserting against a page that had not
    // moved.
    await page.getByRole("button", { name: /^Apply$/ }).first().click();

    await expect
      .poll(async () => (await readSurfaceState(page))?.state, { timeout: 20_000 })
      .toBe("refreshing-with-stale");

    released!();
    await page.unroute("**/api/meta/decisions-workspace**");
    await expect
      .poll(async () => (await readSurfaceState(page))?.state, { timeout: 30_000 })
      .not.toBe("refreshing-with-stale");
  });
});

test.describe("degraded — a real failure, provoked against the real database", () => {
  const JOURNAL_TABLE = "meta_ads_action_log";

  test("an unreadable source is degraded, and is not the empty screen", async ({ page }) => {
    /*
     * Fault injection, not a mock.
     *
     * The table History reads is renamed out from under the running server,
     * the surface is opened, and the table is put back. Nothing is stubbed, so
     * what this proves is that the deployed code path — the `catch` in the
     * page, the resolver, the region — turns a genuine read failure into
     * `degraded` rather than into a journal with nothing in it.
     *
     * The rename is reversed in a `finally`, and the database is a throwaway
     * cluster this harness created, so the blast radius is this test.
     */
    const client = new Client({ connectionString: process.env.META_RUNTIME_DATABASE_URL });
    await client.connect();
    let renamed = false;
    try {
      await client.query(`ALTER TABLE ${JOURNAL_TABLE} RENAME TO ${JOURNAL_TABLE}_faulted`);
      renamed = true;

      await openSurface(page, handle, routeFor("meta-history", handle.businesses.oneAccount));
      const observed = await readSurfaceState(page);

      expect(observed, "the §9 region vanished under a read failure").not.toBeNull();
      expect(observed!.state).toBe("degraded");
      expect(observed!.code).toBe("source_read_failed");
      expect(observed!.text).toMatch(/unknown rather than zero/);
      // The load-bearing half: this is NOT the answer the same screen gives
      // when the journal is genuinely empty.
      expect(observed!.state).not.toBe("empty-proven");
    } finally {
      if (renamed) {
        await client.query(`ALTER TABLE ${JOURNAL_TABLE}_faulted RENAME TO ${JOURNAL_TABLE}`);
      }
      await client.end();
    }
  });

  test("an unreadable control plane is unavailable, not a screen of safe defaults", async ({
    page,
  }) => {
    /*
     * The most dangerous shape of this defect on this branch.
     *
     * Automation renders a kill switch, guardrails and a readiness tier. When
     * the control plane cannot be read, those fields fall back to their
     * defaults — and the defaults look safe. An operator reading "dry run only,
     * max 3 actions/day" from an unreadable source is reading a reassurance
     * nobody measured. §9.1 has `supervision_state_unavailable` for exactly
     * this, and it now reaches the screen.
     */
    const client = new Client({ connectionString: process.env.META_RUNTIME_DATABASE_URL });
    await client.connect();
    let renamed = false;
    try {
      await client.query(
        "ALTER TABLE meta_automation_business_controls RENAME TO meta_automation_business_controls_faulted",
      );
      renamed = true;

      await openSurface(page, handle, routeFor("meta-automation", handle.businesses.oneAccount));
      const observed = await readSurfaceState(page);

      expect(observed!.state).toBe("degraded");
      expect(observed!.code).toBe("supervision_state_unavailable");
      expect(observed!.text).toMatch(/unknown rather than the defaults/);
    } finally {
      if (renamed) {
        await client.query(
          "ALTER TABLE meta_automation_business_controls_faulted RENAME TO meta_automation_business_controls",
        );
      }
      await client.end();
    }
  });

  test("and the screen recovers once the source can be read again", async ({ page }) => {
    // The repair is asserted too, so a leaked fault cannot make every later
    // run pass for the wrong reason.
    await openSurface(page, handle, routeFor("meta-history", handle.businesses.oneAccount));
    expect((await readSurfaceState(page))!.state).toBe("success");

    await openSurface(page, handle, routeFor("meta-automation", handle.businesses.oneAccount));
    expect((await readSurfaceState(page))!.state).toBe("success");
  });
});

test.describe("the region decides nothing", () => {
  test("its state always comes with the failure code the dictionary owns", async ({ page }) => {
    // A state that has a reason must carry one, and a state that has none must
    // not invent one. Checked across every WP6 surface and both fixtures.
    for (const businessId of [handle.businesses.oneAccount, handle.businesses.zeroAccounts]) {
      for (const surfaceId of WP6_SURFACES) {
        await openSurface(page, handle, routeFor(surfaceId, businessId));
        const observed = await readSurfaceState(page);
        if (!observed) continue;
        const needsReason = ["degraded", "refused", "partial"].includes(observed.state ?? "");
        expect(
          Boolean(observed.code),
          `${surfaceId} on ${businessId}: state ${observed.state} carried code ${observed.code}`,
        ).toBe(needsReason);
      }
    }
  });
});
