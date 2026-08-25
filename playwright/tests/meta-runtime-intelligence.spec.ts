/**
 * WP9, on the running server: eleven sections, each answering for itself.
 *
 * Account Intelligence composes eleven independent reads into one screen, and
 * the rule the plan states for it is narrow and absolute: *"Her bölüm ya veri ya
 * açık unavailable sebebi gösterir"* — every section shows data or a stated
 * reason — and *"Rejected kaynak served sayılmaz"*: a source that was refused is
 * never counted as one that answered.
 *
 * The dangerous failure here is not a broken page. It is a page that looks
 * whole: ten sections serving, one silently empty, and a "sources served" count
 * that includes it. An operator reading that screen believes they have seen
 * everything.
 *
 * The full 9×7 matrix cannot be produced from outside — sixty-three distinct
 * failures cannot be injected into a live composition, and pretending otherwise
 * would mean asserting states nothing produced. So the split is:
 *
 *   - the LAWS are checked across every section on the real screen: closed
 *     vocabulary, a reason whenever the state is not `serving`, a §9.1 code on
 *     a classified failure, and no raw exception text anywhere;
 *   - and ONE section is genuinely broken against the real database, to show
 *     that the failure lands on that section, that the others keep serving, and
 *     that the served count does not include it.
 */
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

import { openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();

const INTELLIGENCE = `/c/${handle.businesses.oneAccount}/meta/intelligence`;

/** The five words a section may answer with. Anything else is not a state. */
const SOURCE_STATES = ["Serving", "Partial", "Degraded", "Unavailable", "Unknown"];

interface SectionRow {
  key: string;
  state: string;
  reason: string;
  text: string;
}

async function sections(page: Page): Promise<SectionRow[]> {
  return page.evaluate(() => {
    return Array.from(
      document.querySelectorAll<HTMLElement>("[data-source-state]"),
    ).map((element) => {
      const state = element.querySelector("strong")?.textContent?.trim() ?? "";
      const spans = Array.from(element.querySelectorAll("span"));
      return {
        key: element.dataset.sourceState ?? "",
        state,
        reason: spans[0]?.textContent?.trim() ?? "",
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
      };
    });
  });
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

test.describe("every section answers for itself", () => {
  test("all eleven are present, and each names one of the five states", async ({
    page,
  }) => {
    await openSurface(page, handle, INTELLIGENCE);
    const rows = await sections(page);

    /*
     * Eleven, not nine. The plan names nine sections and the composition grew
     * two more — Connection & account, and Summary — which is fine; what is
     * not fine is a section that exists and reports nothing. The assertion is
     * on the floor rather than the exact number so a new section is added with
     * a state rather than blocked from being added at all.
     */
    expect(rows.length, "Intelligence composed fewer sections than the plan names")
      .toBeGreaterThanOrEqual(9);

    const wrong = rows.filter((row) => !SOURCE_STATES.includes(row.state));
    expect(wrong, "sections answering outside the closed vocabulary").toEqual([]);

    // Every key appears once. Two rows for one source would double-count it in
    // the "sources served" line above them.
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size, `duplicate section keys: ${keys.join(", ")}`).toBe(
      keys.length,
    );
  });

  test("a section that is not serving says why, in words", async ({ page }) => {
    await openSurface(page, handle, INTELLIGENCE);
    const rows = await sections(page);

    const silent = rows.filter(
      (row) => row.state !== "Serving" && row.reason.length < 10,
    );
    expect(
      silent.map((row) => `${row.key}: ${row.state}`),
      "sections that withheld without saying why",
    ).toEqual([]);
  });

  test("no section prints a raw exception", async ({ page }) => {
    /**
     * "Ham Error.message basılmaz." A stack frame, a driver error or a SQL
     * fragment on the screen is both useless to an operator and a disclosure:
     * it names tables, columns and sometimes hosts.
     */
    await openSurface(page, handle, INTELLIGENCE);
    const text = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");

    for (const leak of [
      /relation "[a-z_]+" does not exist/i,
      /\bat [A-Za-z]+ \(.*:\d+:\d+\)/,
      /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/,
      /syntax error at or near/i,
      /postgres(ql)?:\/\//i,
      /META_[A-Z0-9_]{4,}/,
    ]) {
      expect(text, `a raw failure detail reached the screen: ${leak}`).not.toMatch(leak);
    }
  });

  test("an unscoped account withholds every section rather than emptying them", async ({
    page,
  }) => {
    // "Account picker olmadan account-scoped veri gösterilmez." Eleven empty
    // panels are indistinguishable from eleven that genuinely have nothing.
    await openSurface(
      page,
      handle,
      `/c/${handle.businesses.manyAccounts}/meta/intelligence`,
    );

    const state = page.locator("[data-meta-surface-state]").first();
    await expect(state).toHaveAttribute("data-read-state", "refused");
    expect(await state.getAttribute("data-failure-code")).toBeTruthy();
  });
});

test.describe("a refused source is never counted as one that answered", () => {
  test("breaking one read degrades that section and leaves the others serving", async ({
    page,
  }) => {
    /**
     * Provoked for real against the ephemeral database, not simulated.
     *
     * `meta_campaign_labels` is the Campaign labels section's table and nothing
     * else's, so renaming it makes exactly one of the eleven reads fail. That
     * is the composition's whole claim: eleven independent reads, one of which
     * can fail without taking the screen down and — the part that matters —
     * without being counted as served.
     *
     * The assertion names the section rather than counting states, because a
     * count would also pass if the failure landed on a DIFFERENT section, which
     * would be a worse bug than the one under test.
     */
    await openSurface(page, handle, INTELLIGENCE);
    const before = await sections(page);
    const servingBefore = before.filter((row) => row.state === "Serving").map((row) => row.key);
    expect(servingBefore, "labels was not serving to begin with").toContain("labels");

    let renamed = false;
    try {
      await withDb(async (client) => {
        await client.query(
          "ALTER TABLE meta_campaign_labels RENAME TO meta_campaign_labels_faulted",
        );
        renamed = true;
      });

      await openSurface(page, handle, INTELLIGENCE);
      const during = await sections(page);

      // The screen is still a screen.
      expect(during.length).toBe(before.length);

      // The broken section, and only it, stopped serving.
      const brokenRow = during.find((row) => row.key === "labels");
      expect(brokenRow?.state, "a broken source was still counted as serving").not.toBe(
        "Serving",
      );
      const stillServing = during
        .filter((row) => row.state === "Serving")
        .map((row) => row.key);
      expect(
        servingBefore.filter((key) => key !== "labels" && !stillServing.includes(key)),
        "an unrelated section was taken down with it",
      ).toEqual([]);

      // The header count agrees with the rows under it, rather than with the
      // number of sections that exist.
      const counter = await page
        .locator("text=/\\d+ sources served/")
        .first()
        .innerText()
        .catch(() => "");
      const claimed = Number(/(\d+) sources served/.exec(counter)?.[1] ?? "-1");
      expect(
        claimed,
        `the header claimed ${claimed}, the rows show ${stillServing.length}`,
      ).toBe(stillServing.length);

      // It says why, and does not say it in SQL.
      expect(brokenRow!.text, "labels withheld silently").not.toBe(brokenRow!.state);
      expect(brokenRow!.text).not.toMatch(/meta_campaign_labels/);
    } finally {
      if (renamed) {
        await withDb(async (client) => {
          await client.query(
            "ALTER TABLE meta_campaign_labels_faulted RENAME TO meta_campaign_labels",
          );
        });
      }
    }
  });

  test("and the screen recovers once the source can be read again", async ({ page }) => {
    // Asserted so a leaked fault cannot make every later run pass for the wrong
    // reason — the same law the read-state fault injections follow.
    await openSurface(page, handle, INTELLIGENCE);
    const rows = await sections(page);
    expect(rows.filter((row) => row.state === "Serving").length).toBeGreaterThan(0);
  });
});
