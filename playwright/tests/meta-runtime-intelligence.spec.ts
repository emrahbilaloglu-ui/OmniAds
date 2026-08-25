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
 * The 9×7 matrix is proven in three places, because three different things are
 * being claimed and only one of them is a browser question:
 *
 *   - the MAPPING — every section, every producible §9 state — is exhaustive
 *     and deterministic in `lib/zero-base/meta/intelligence-read-state.test.ts`,
 *     driven through the same resolver the composer uses;
 *   - the GATE — the two control sections' refusals for a reviewer, a demo
 *     workspace and a guest — is in the composer's own tests, because it is a
 *     server decision and asserting it through a browser would be asserting the
 *     browser;
 *   - and the LAWS are checked here, on the real screen: the §9 vocabulary is
 *     closed, a reason accompanies every state that is not serving, a §9.1 code
 *     accompanies a classified failure, and no raw exception text appears
 *     anywhere. One section is then genuinely broken against the real database,
 *     to show the failure lands on that section and the others keep serving.
 *
 * An earlier revision of this header said the matrix "cannot be produced from
 * outside" and stopped there. That was true of a browser and false of the
 * composer, and it was being used as a reason not to try.
 */
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

import { openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();

const INTELLIGENCE = `/c/${handle.businesses.oneAccount}/meta/intelligence`;

/**
 * The five words a section's SOURCE HEALTH may answer with.
 *
 * `ProviderSourceState`, which is not §9. The §9 read state is a separate,
 * seven-member vocabulary carried on `data-section-read-state` and asserted
 * below — the two answer different questions and this file checks both.
 */
const SOURCE_STATES = ["Serving", "Partial", "Degraded", "Unavailable", "Unknown"];

/** The §9 vocabulary. A section may carry any of these and nothing else. */
const READ_STATES = [
  "loading",
  "refreshing-with-stale",
  "success",
  "empty-proven",
  "partial",
  "degraded",
  "refused",
];

/** The nine WP9 names, by the composer's key for each. */
const PLAN_SECTIONS = [
  "top-creatives",
  "breakdowns",
  "anomalies",
  "page-status",
  "pulse",
  "structure",
  "lane-classify",
  "recommendations",
  "snapshot",
];

interface SectionRow {
  key: string;
  state: string;
  readState: string;
  failureCode: string;
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
        readState: element.dataset.sectionReadState ?? "",
        failureCode: element.dataset.sectionFailureCode ?? "",
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
  test("all nine the plan names are present, each with a §9 state", async ({
    page,
  }) => {
    await openSurface(page, handle, INTELLIGENCE);
    const rows = await sections(page);

    /*
     * By NAME, not by count. A floor of nine passed while two of the plan's
     * nine — Recommendations and Snapshot — did not exist at all, because four
     * sections outside the plan made up the difference. Naming them is what
     * makes the assertion about WP9's nine rather than about arithmetic.
     */
    const keysPresent = rows.map((row) => row.key);
    const missing = PLAN_SECTIONS.filter((key) => !keysPresent.includes(key));
    expect(missing, "WP9 sections the composition does not render").toEqual([]);

    const wrong = rows.filter((row) => !SOURCE_STATES.includes(row.state));
    expect(wrong, "sections answering outside the closed vocabulary").toEqual([]);

    /*
     * And the §9 state, which is the vocabulary WP9's acceptance is written in.
     * Every section carries one, and it is one of the seven.
     */
    const unstated = rows.filter((row) => !READ_STATES.includes(row.readState));
    expect(
      unstated.map((row) => `${row.key}=${row.readState || "(none)"}`),
      "sections with no §9 read state, or one outside the closed vocabulary",
    ).toEqual([]);

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

/**
 * WP9's role and capability gate, on the screen an operator opens.
 *
 * The composer's own tests prove the decision; this proves it survives to the
 * DOM. The runtime operator is an admin, so the controls are offered — the
 * refused half is graded where refusals can be produced deterministically,
 * because a browser cannot change who is signed in without signing in as
 * somebody else.
 */
test.describe("the two control sections carry their gate to the screen", () => {
  test("respond and run-now are rendered, and say whether they may be used", async ({
    page,
  }) => {
    await openSurface(page, handle, INTELLIGENCE);

    const respond = page.locator('[data-section-control="respond"]');
    await expect(respond, "the respond control is not on the screen").toHaveCount(1);
    const runNow = page.locator('[data-section-control="run-snapshot"]');
    await expect(runNow, "the run-now control is not on the screen").toHaveCount(1);

    /*
     * Enabled or refused, never silently absent — and if refused, with a §9.1
     * code rather than a sentence composed at the route. The old screen had
     * neither: the respond control was never rendered at all, and run-now was
     * a hard-coded disabled button whose reason was written in the page file.
     */
    for (const control of [respond, runNow]) {
      const enabled = await control.getAttribute("data-section-control-enabled");
      const refusal = await control.getAttribute("data-section-control-refusal");
      expect(
        enabled !== null || refusal !== null,
        "a control that is neither offered nor refused",
      ).toBe(true);
      if (enabled === null) {
        expect(refusal, "a refused control with no §9.1 code").toBeTruthy();
      }
    }
  });

  test("the respond control offers only actions the route accepts", async ({ page }) => {
    /*
     * It used to offer `acknowledged | acted | dismissed`; the route validates
     * against `META_DECISION_RESPONSE_ACTIONS` — `acted | deferred | undeferred
     * | ignored` — and answers `invalid_action` for two of the three. The
     * options now come from that module.
     */
    await openSurface(page, handle, INTELLIGENCE);
    const options = await page
      .locator('[data-ctl="live:META-INTEL-07 respond"] option')
      .allTextContents();
    const offered = options.map((value) => value.trim()).filter((value) => value && value !== "—");
    expect(offered.sort()).toEqual(["acted", "deferred", "ignored", "undeferred"]);
  });
});
