/**
 * WP12, on the running server: the rows on screen are the rows in the database.
 *
 * History unions sixteen sources into nine event families, and until now the
 * surface offered one filter — outcome — while `kind` and `entity` were parsed
 * by the read model and passed as `null` by every caller. Nine families arrived
 * as one undifferentiated stream, and the only way to ask for one of them was
 * to hand-write a query string the UI never produced.
 *
 * Both filters now reach the server, and this proves it the only way that is
 * worth anything: by comparing what the screen shows against what the database
 * holds.
 *
 * ## Why the per-family expectation is a law rather than a query
 *
 * Re-implementing the union here would be re-deriving the implementation, and a
 * test that derives its expectation from the code under test agrees with a bug
 * as readily as with correct code. So the families are checked by a property
 * instead: the nine filtered counts must SUM to the unfiltered count. A filter
 * that never reached the server returns the whole journal nine times and the
 * sum is nine times too large — which is exactly the defect, caught without
 * knowing what any single family should contain.
 *
 * One family IS checked against SQL directly: `writes` comes from a single
 * table this fixture seeds, so there the DB↔UI equality can be exact.
 */
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

import { META_HISTORY_KINDS } from "../../lib/meta/history-contract";
import { openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();

const BUSINESS = handle.businesses.oneAccount;

/**
 * A window wide enough to hold the whole fixture.
 *
 * Stated rather than defaulted: the default is the last 28 days ending
 * yesterday, and a count compared against "whatever that resolves to today" is
 * a count that changes at midnight.
 */
const FROM = "2026-07-01";
const TO = "2026-12-31";

function historyUrl(extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    window: "custom",
    startDate: FROM,
    endDate: TO,
    ...extra,
  });
  return `/c/${BUSINESS}/meta/history?${params.toString()}`;
}

/** The rows the table is actually showing. */
async function renderedRows(page: Page): Promise<number> {
  return page.locator('[data-collection="history"] tbody tr').count();
}

async function withDb<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.META_RUNTIME_DATABASE_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

test.describe("the event-family filter reaches the server", () => {
  test("the nine families sum to the whole journal", async ({ page }) => {
    await openSurface(page, handle, historyUrl());
    const total = await renderedRows(page);
    expect(total, "the fixture journal is empty, so this proves nothing").toBeGreaterThan(
      0,
    );

    const perFamily: Record<string, number> = {};
    for (const kind of META_HISTORY_KINDS) {
      await openSurface(page, handle, historyUrl({ kind }));
      perFamily[kind] = await renderedRows(page);
    }

    const sum = Object.values(perFamily).reduce((a, b) => a + b, 0);
    expect(
      sum,
      `the families do not partition the journal: ${JSON.stringify(perFamily)} against ${total}`,
    ).toBe(total);
  });

  test("`writes` matches the action log row-for-row", async ({ page }) => {
    /**
     * The one family whose source is a single table this fixture seeds, so the
     * comparison can be exact rather than a property. Everything else in
     * History is a union and would need the read model re-implemented here to
     * be counted independently.
     */
    const inDatabase = await withDb(async (client) => {
      const rows = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM meta_ads_action_log
          WHERE business_id = $1
            AND requested_at >= $2::date
            AND requested_at < ($3::date + interval '1 day')`,
        [BUSINESS, FROM, TO],
      );
      return Number(rows.rows[0]!.count);
    });
    expect(inDatabase, "no seeded write rows to compare against").toBeGreaterThan(0);

    await openSurface(page, handle, historyUrl({ kind: "writes" }));

    expect(
      await renderedRows(page),
      "the journal showed a different number of writes than the table holds",
    ).toBe(inDatabase);
  });

  test("a family with no rows renders none, and says so rather than erroring", async ({
    page,
  }) => {
    // A family the fixture never wrote to. Zero is the honest answer, and it
    // must arrive as an explained empty rather than as a broken surface.
    await openSurface(page, handle, historyUrl({ kind: "label_flips" }));

    expect(await renderedRows(page)).toBe(0);
    const state = page.locator("[data-meta-surface-state]").first();
    expect(await state.getAttribute("data-read-state")).not.toBe("degraded");
    const text = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
    expect(text, "an empty family with nothing said about it").toMatch(
      /no |not |none|empty|nothing/i,
    );
  });
});

test.describe("the entity filter reaches the server", () => {
  test("narrowing to one entity type never widens the journal", async ({ page }) => {
    await openSurface(page, handle, historyUrl());
    const total = await renderedRows(page);

    const counts: Record<string, number> = {};
    for (const entity of ["ad", "campaign", "adset", "account"]) {
      await openSurface(page, handle, historyUrl({ entity }));
      counts[entity] = await renderedRows(page);
      expect(
        counts[entity],
        `entity=${entity} returned more rows than the unfiltered journal`,
      ).toBeLessThanOrEqual(total);
    }

    // At least one of them must actually narrow, or the parameter is being
    // accepted and ignored — which is indistinguishable from "no filter" and is
    // the defect this replaces.
    expect(
      Object.values(counts).some((count) => count < total),
      `no entity filter narrowed anything: ${JSON.stringify(counts)} against ${total}`,
    ).toBe(true);
  });

  test("the fixture's own ad rows are reachable by entity", async ({ page }) => {
    // The seeded journal is three actions on one ad, so `entity=ad` must find
    // them and `entity=creative_brief` must not.
    await openSurface(page, handle, historyUrl({ kind: "writes", entity: "ad" }));
    expect(await renderedRows(page)).toBeGreaterThan(0);

    await openSurface(
      page,
      handle,
      historyUrl({ kind: "writes", entity: "creative_brief" }),
    );
    expect(await renderedRows(page)).toBe(0);
  });
});

test.describe("the filters exist on the screen, not only in the URL", () => {
  test("History offers an event-family control and an entity control", async ({
    page,
  }) => {
    /**
     * A filter reachable only by hand-editing a query string is a filter the
     * product does not have. Both controls are rendered, and both carry the
     * whole vocabulary — a control offering three of nine families would be a
     * different kind of lie.
     */
    await openSurface(page, handle, historyUrl());

    const kind = page.locator('[data-history-filter="kind"]');
    await expect(kind).toHaveCount(1);
    const kindOptions = await kind.locator("option").allTextContents();
    expect(kindOptions).toEqual(["all", ...META_HISTORY_KINDS]);

    const entity = page.locator('[data-history-filter="entity"]');
    await expect(entity).toHaveCount(1);
    expect((await entity.locator("option").allTextContents()).length).toBeGreaterThan(1);
  });

  test("choosing a family through the control re-reads from the server", async ({
    page,
  }) => {
    await openSurface(page, handle, historyUrl());
    const total = await renderedRows(page);
    expect(total).toBeGreaterThan(0);

    const requests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("/api/meta/history")) requests.push(url);
    });

    /*
     * A family the fixture never wrote to, deliberately.
     *
     * The seeded journal is entirely `writes`, so choosing `writes` narrows
     * nothing and a "fewer rows" assertion would pass for a control that did
     * not work at all. `label_flips` is the choice that can only empty the
     * table if the filter genuinely reached the server.
     */
    await page.selectOption('[data-history-filter="kind"]', "label_flips");

    // Debounced like the search box, so settle on the read rather than a timer.
    await expect
      .poll(() => requests.filter((url) => url.includes("kind=label_flips")).length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    await expect.poll(async () => renderedRows(page), { timeout: 15_000 }).toBe(0);

    // And back again: a filter that cannot be cleared is a filter that lies
    // about the journal from the moment it is used once.
    await page.selectOption('[data-history-filter="kind"]', "all");
    await expect
      .poll(async () => renderedRows(page), { timeout: 15_000 })
      .toBe(total);
  });
});
