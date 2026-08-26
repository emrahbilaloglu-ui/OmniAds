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
import { expect, test, type Locator, type Page } from "@playwright/test";
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
/** The sentence a refused control renders beside itself, or "" when it has none. */
async function reasonOf(control: Locator): Promise<string> {
  const reason = control.locator("[data-section-control-reason]");
  return (await reason.count()) > 0
    ? ((await reason.first().textContent()) ?? "").trim()
    : "";
}

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
        enabled !== null || refusal !== null || (await reasonOf(control)) !== "",
        "a control that is neither offered nor refused",
      ).toBe(true);
      if (enabled === null) {
        /*
         * A refused control must SAY why. Usually that is a §9.1 code, but not
         * always: a snapshot that served no recommendations leaves the respond
         * control with nothing to act on, and calling a measured zero a
         * failure would report an absence as a defect. Either way the operator
         * gets a sentence — an unusable control with no reason is the state
         * this test exists to forbid.
         */
        expect(
          refusal || (await reasonOf(control)),
          "a refused control that gives no reason at all",
        ).toBeTruthy();
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

/**
 * WP9's respond control, all the way to the row it writes.
 *
 * The control was rendered and gated and led nowhere: the composer read every
 * recommendation, kept only `.length`, and the handler answered a click by
 * telling the operator to open Decision Center. This drives the mounted
 * control and then asks the database what it recorded — a 200 is not evidence
 * that anything was written, and `meta_decision_responses` is where the answer
 * actually lives.
 */
/**
 * One recommendation, seeded so the control has a real subject.
 *
 * The D6 fixture writes no decision snapshot — the engine's output is not part
 * of what it describes — so without this the respond control is correctly
 * refused and the write path is never exercised against the database. The row
 * is the surface's own contract: `readLatestMetaDecisionSnapshot` takes
 * `MAX(snapshot_date)` where `kind = 'recommendation'`, so one row is a served
 * recommendation.
 */
const SEEDED_REC_ID = "runtime_evidence_rec_1";

/**
 * The row identity these seeds must name (D-M011).
 *
 * The four-column primary key was replaced by a five-column unique index that
 * includes `provider_account_id`, so two assigned accounts can hold a row of
 * the same type on the same day. An `ON CONFLICT` inferring the OLD four
 * columns matches no constraint and fails with 42P10 — which is why the target
 * is written once here rather than repeated at each seed.
 */
const SNAPSHOT_IDENTITY_CONFLICT =
  "ON CONFLICT (scope_type, scope_id, snapshot_date, rec_type, provider_account_id)";

async function seedRecommendation() {
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO meta_decision_snapshots_daily
         (scope_type, scope_id, business_id, provider_account_id, snapshot_date,
          rec_id, rec_type, level, decision_state, confidence_score,
          recommended_action, reasoning, engine_version, kind)
       VALUES ('account', $1, $2, $1, CURRENT_DATE, $3, 'runtime_evidence',
          'account', 'act', 0.9, 'Hold spend while the evidence settles.',
          'Seeded by the runtime evidence harness.', 'runtime-evidence', 'recommendation')
       ${SNAPSHOT_IDENTITY_CONFLICT} DO NOTHING`,
      [handle.accounts.one, handle.businesses.oneAccount, SEEDED_REC_ID],
    );
  });
}

async function clearSeededRecommendation() {
  await withDb(async (client) => {
    await client.query(
      "DELETE FROM meta_decision_responses WHERE rec_id = $1",
      [SEEDED_REC_ID],
    );
    await client.query(
      "DELETE FROM meta_decision_snapshots_daily WHERE rec_id = $1",
      [SEEDED_REC_ID],
    );
  });
}

test.describe("responding to a recommendation records a row", () => {
  test.beforeEach(seedRecommendation);
  test.afterEach(clearSeededRecommendation);

  test("the served id reaches meta_decision_responses, and nothing else does", async ({
    page,
  }) => {
    await openSurface(page, handle, INTELLIGENCE);

    const respond = page.locator('[data-section-control="respond"]');
    await expect(respond).toHaveCount(1);
    const targetCount = Number(
      (await respond.getAttribute("data-respond-target-count")) ?? "0",
    );

    if (targetCount === 0) {
      /*
       * The fixture's snapshot served no recommendation. That is a real state
       * and the law still holds: the control refuses, says why in the server's
       * own words, and offers no subject to act on.
       */
      expect(await respond.getAttribute("data-section-control-enabled")).toBeNull();
      expect(await reasonOf(respond)).toContain("nothing to respond to");
      await expect(
        page.locator('[data-ctl="live:META-INTEL-07 respond-target"]'),
      ).toHaveCount(0);
      return;
    }

    // The id the SERVER offered. Nothing in this test composes one.
    const recId = await respond.getAttribute("data-respond-target");
    expect(recId, "an offered target with no id").toBeTruthy();

    const before = await withDb(async (client) =>
      Number(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM meta_decision_responses WHERE business_id = $1 AND rec_id = $2",
            [handle.businesses.oneAccount, recId],
          )
        ).rows[0].n,
      ),
    );

    await page
      .locator('[data-ctl="live:META-INTEL-07 respond"]')
      .selectOption("deferred");

    await expect(page.locator("[data-intelligence-control-notice]")).toContainText(
      String(recId),
    );

    const rows = await withDb(async (client) =>
      (
        await client.query(
          "SELECT rec_id, business_id, action FROM meta_decision_responses WHERE business_id = $1 AND rec_id = $2 ORDER BY timestamp DESC",
          [handle.businesses.oneAccount, recId],
        )
      ).rows,
    );

    expect(rows.length).toBe(before + 1);
    expect(rows[0]).toMatchObject({
      rec_id: recId,
      business_id: handle.businesses.oneAccount,
      action: "deferred",
    });
  });

  /**
   * The identifier is the SERVER's to verify, and this proves it against a
   * real database rather than a mock.
   *
   * `meta_decision_responses.rec_id` has no foreign key — `lib/triage-events.ts`
   * is a second writer whose ids are synthetic and never have a snapshot row —
   * so until the route checked, a caller could record an operator decision
   * against any string, and `lib/meta/outcome-accrual.ts` would later read that
   * row back as evidence that an operator acted.
   */
  test("the server refuses an id it never served, and writes no row", async ({
    page,
  }) => {
    await openSurface(page, handle, INTELLIGENCE);

    const invented = "runtime_evidence_never_served_1";
    const posted = await page.evaluate(
      async ({ businessId, recId }) => {
        const response = await fetch("/api/meta/recommendations/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ businessId, recId, action: "acted" }),
        });
        return { status: response.status, body: (await response.text()).slice(0, 400) };
      },
      { businessId: handle.businesses.oneAccount, recId: invented },
    );

    expect(posted.status).toBe(404);
    expect(posted.body).toContain("recommendation_not_served");

    const rows = await withDb(async (client) =>
      Number(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM meta_decision_responses WHERE rec_id = $1",
            [invented],
          )
        ).rows[0].n,
      ),
    );
    expect(rows, "a refused response still reached the table").toBe(0);
  });

  test("the server refuses another workspace's recommendation", async ({ page }) => {
    await openSurface(page, handle, INTELLIGENCE);

    /*
     * The id IS served — to a different business. Scope is the property being
     * tested, so the row exists and only `business_id` differs.
     */
    const foreign = "runtime_evidence_foreign_rec_1";
    await withDb(async (client) => {
      await client.query(
        `INSERT INTO meta_decision_snapshots_daily
           (scope_type, scope_id, business_id, provider_account_id, snapshot_date,
            rec_id, rec_type, level, decision_state, confidence_score,
            recommended_action, reasoning, engine_version, kind)
         VALUES ('account', $1, $1, NULL, CURRENT_DATE, $2, 'runtime_evidence_foreign',
            'account', 'act', 0.9, 'Hold spend.', 'Seeded for a scope test.',
            'runtime-evidence', 'recommendation')
         ${SNAPSHOT_IDENTITY_CONFLICT} DO NOTHING`,
        [handle.businesses.otherTenant, foreign],
      );
    });

    try {
      const posted = await page.evaluate(
        async ({ businessId, recId }) => {
          const response = await fetch("/api/meta/recommendations/respond", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ businessId, recId, action: "acted" }),
          });
          return { status: response.status, body: (await response.text()).slice(0, 400) };
        },
        { businessId: handle.businesses.oneAccount, recId: foreign },
      );

      expect(posted.status).toBe(404);
      expect(posted.body).toContain("recommendation_not_served");

      const rows = await withDb(async (client) =>
        Number(
          (
            await client.query(
              "SELECT count(*)::int AS n FROM meta_decision_responses WHERE rec_id = $1",
              [foreign],
            )
          ).rows[0].n,
        ),
      );
      expect(rows).toBe(0);
    } finally {
      await withDb(async (client) => {
        await client.query(
          "DELETE FROM meta_decision_snapshots_daily WHERE rec_id = $1",
          [foreign],
        );
      });
    }
  });

  test("reaches no provider", async ({ page }) => {
    const provider: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (/facebook\.com|graph\.facebook|googleapis\.com/.test(url)) provider.push(url);
    });

    await openSurface(page, handle, INTELLIGENCE);
    const respond = page.locator('[data-section-control="respond"]');
    /*
     * Driven only when there is something to drive. The target count is the
     * honest gate: a control with no served recommendation is refused, and
     * clicking at it would be waiting on a select that is disabled for a
     * reason the server already stated.
     */
    const targetCount = Number(
      (await respond.getAttribute("data-respond-target-count")) ?? "0",
    );
    if (targetCount > 0) {
      await page
        .locator('[data-ctl="live:META-INTEL-07 respond"]')
        .selectOption("acted");
      await expect(page.locator("[data-intelligence-control-notice]")).toBeVisible();
    }

    expect(provider, "a provider call from an operator response").toEqual([]);
  });
});

/**
 * D6 on the running server: one physical provider account, proven.
 *
 * The snapshot could not say which account a recommendation was about, so an
 * account-scoped surface served another account's rows under this account's
 * heading and the respond control acted on them. These cases seed real rows
 * with real lineage and drive the mounted surface and the write boundary.
 *
 * Every row seeded here is deleted afterwards, including on failure.
 */
test.describe("recommendations are scoped to one physical account", () => {
  const A = "runtime_evidence_acct_a_rec";
  const B = "runtime_evidence_acct_b_rec";
  /** The SAME id under two accounts, which is what a collision looks like. */
  const COLLIDING = "runtime_evidence_colliding_rec";
  const seeded = [A, B, COLLIDING];

  async function seedRow(input: {
    recId: string;
    account: string | null;
    business: string;
    daysAgo?: number;
    recType: string;
  }) {
    await withDb(async (client) => {
      await client.query(
        `INSERT INTO meta_decision_snapshots_daily
           (scope_type, scope_id, business_id, provider_account_id, snapshot_date,
            rec_id, rec_type, level, decision_state, confidence_score,
            recommended_action, reasoning, engine_version, kind)
         VALUES ('account', $1, $1, $2, CURRENT_DATE - ($3::int), $4, $5,
            'account', 'act', 0.9, 'Hold spend.', 'Seeded by the runtime harness.',
            'runtime-evidence', 'recommendation')
         ${SNAPSHOT_IDENTITY_CONFLICT} DO NOTHING`,
        [input.business, input.account, input.daysAgo ?? 0, input.recId, input.recType],
      );
    });
  }

  test.afterEach(async () => {
    await withDb(async (client) => {
      await client.query(
        "DELETE FROM meta_decision_responses WHERE rec_id = ANY($1::text[])",
        [seeded],
      );
      await client.query(
        "DELETE FROM meta_decision_snapshots_daily WHERE rec_id = ANY($1::text[])",
        [seeded],
      );
    });
  });

  async function respond(
    page: Page,
    body: { businessId: string; providerAccountId: string | null; recId: string; action: string },
  ) {
    return page.evaluate(async (payload) => {
      const response = await fetch("/api/meta/recommendations/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: (await response.text()).slice(0, 300) };
    }, body);
  }

  /** Which accounts actually carry a stored response for this id. */
  async function responseAccounts(recId: string, business: string) {
    return withDb(async (client) =>
      (
        await client.query(
          `SELECT provider_account_id FROM meta_decision_responses
           WHERE business_id = $1 AND rec_id = $2
           ORDER BY provider_account_id`,
          [business, recId],
        )
      ).rows.map((row: { provider_account_id: string | null }) => row.provider_account_id),
    );
  }

  /** How many snapshot rows carry this id — 2 is what a collision looks like. */
  async function snapshotRowCount(recId: string, business: string) {
    return withDb(async (client) =>
      Number(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM meta_decision_snapshots_daily WHERE business_id = $1 AND rec_id = $2",
            [business, recId],
          )
        ).rows[0].n,
      ),
    );
  }

  async function responseCount(recId: string, business: string) {
    return withDb(async (client) =>
      Number(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM meta_decision_responses WHERE business_id = $1 AND rec_id = $2",
            [business, recId],
          )
        ).rows[0].n,
      ),
    );
  }

  test("a recommendation belonging to another account is refused", async ({ page }) => {
    const business = handle.businesses.manyAccounts;
    await seedRow({ recId: B, account: handle.accounts.manyB, business, recType: "rt_b" });
    await openSurface(
      page,
      handle,
      `/c/${business}/meta/intelligence?providerAccountId=${handle.accounts.manyA}`,
    );

    // Account A is selected; the row belongs to account B.
    const refused = await respond(page, {
      businessId: business,
      providerAccountId: handle.accounts.manyA,
      recId: B,
      action: "acted",
    });

    expect(refused.status).toBe(404);
    expect(refused.body).toContain("recommendation_not_served");
    expect(await responseCount(B, business)).toBe(0);
  });

  test("the same rec id under two accounts stays separated", async ({ page }) => {
    const business = handle.businesses.manyAccounts;
    /*
     * A REAL collision: the same rec id, the same rec type and the same day
     * under BOTH accounts.
     *
     * This case used to seed the id under account A only, so account B was
     * refused for having no row at all — which the four-column primary key
     * would also have produced, and which proves nothing about isolation. Two
     * rows of one identity can only coexist because the identity index now
     * includes the account (D-M011), and only then does refusing B mean the
     * boundary chose the right one of two candidates rather than finding none.
     */
    for (const account of [handle.accounts.manyA, handle.accounts.manyB]) {
      await seedRow({
        recId: COLLIDING,
        account,
        business,
        recType: "rt_collide",
      });
    }
    expect(await snapshotRowCount(COLLIDING, business)).toBe(2);

    await openSurface(
      page,
      handle,
      `/c/${business}/meta/intelligence?providerAccountId=${handle.accounts.manyA}`,
    );

    // Under account A the id is served, so the response is recorded.
    const accepted = await respond(page, {
      businessId: business,
      providerAccountId: handle.accounts.manyA,
      recId: COLLIDING,
      action: "acted",
    });
    expect(accepted.status).toBe(200);
    expect(await responseCount(COLLIDING, business)).toBe(1);

    // The response landed under A, and ONLY under A. Both rows exist, so a
    // count alone cannot show that — the lineage on the stored row is what
    // proves which of the two the boundary answered.
    expect(await responseAccounts(COLLIDING, business)).toEqual([
      handle.accounts.manyA,
    ]);

    // Account B holds its own row for the same id, so it is served there too,
    // and its response is a SEPARATE row rather than a duplicate or an
    // overwrite of A's.
    const acceptedUnderB = await respond(page, {
      businessId: business,
      providerAccountId: handle.accounts.manyB,
      recId: COLLIDING,
      action: "acted",
    });
    expect(acceptedUnderB.status).toBe(200);
    expect(await responseCount(COLLIDING, business)).toBe(2);
    expect(await responseAccounts(COLLIDING, business)).toEqual(
      [handle.accounts.manyA, handle.accounts.manyB].sort(),
    );

    // ...and an account this workspace does not hold is still refused, so the
    // rule is "the row that belongs to THIS account", not "any row".
    const refused = await respond(page, {
      businessId: business,
      providerAccountId: "act_not_assigned_to_this_workspace",
      recId: COLLIDING,
      action: "acted",
    });
    expect(refused.status).toBe(404);
    expect(await responseCount(COLLIDING, business)).toBe(2);
  });

  /*
   * A deferral is per account too, and the chain proves it: A defers, B cannot
   * lift A's deferral, and A can. Before D-M012 the undefer predicate matched
   * on business + rec id, so B's undefer would have lifted A's.
   */
  test("a defer/undefer chain in one account cannot be driven from the other", async ({
    page,
  }) => {
    const business = handle.businesses.manyAccounts;
    for (const account of [handle.accounts.manyA, handle.accounts.manyB]) {
      await seedRow({ recId: COLLIDING, account, business, recType: "rt_collide" });
    }
    await openSurface(
      page,
      handle,
      `/c/${business}/meta/intelligence?providerAccountId=${handle.accounts.manyA}`,
    );

    const deferred = await respond(page, {
      businessId: business,
      providerAccountId: handle.accounts.manyA,
      recId: COLLIDING,
      action: "deferred",
    });
    expect(deferred.status).toBe(200);

    const undeferFromB = await respond(page, {
      businessId: business,
      providerAccountId: handle.accounts.manyB,
      recId: COLLIDING,
      action: "undeferred",
    });
    expect(undeferFromB.status).toBe(404);

    const undeferFromA = await respond(page, {
      businessId: business,
      providerAccountId: handle.accounts.manyA,
      recId: COLLIDING,
      action: "undeferred",
    });
    expect(undeferFromA.status).toBe(200);
  });

  /*
   * The freshness defect, end to end. The id is real, this account's, and
   * inside any reasonable window — it is simply not in the CURRENT snapshot.
   */
  test("an id from an older snapshot is refused for acted", async ({ page }) => {
    const business = handle.businesses.oneAccount;
    const account = handle.accounts.one;
    await seedRow({
      recId: A,
      account,
      business,
      daysAgo: 3,
      recType: "rt_stale",
    });
    // A newer snapshot for the same account, which is what makes the older one
    // stale rather than merely old.
    await seedRow({
      recId: "runtime_evidence_current_rec",
      account,
      business,
      daysAgo: 0,
      recType: "rt_current",
    });
    seeded.push("runtime_evidence_current_rec");
    await openSurface(
      page,
      handle,
      `/c/${business}/meta/intelligence?providerAccountId=${account}`,
    );

    const refused = await respond(page, {
      businessId: business,
      providerAccountId: account,
      recId: A,
      action: "acted",
    });

    expect(refused.status).toBe(404);
    expect(refused.body).toContain("recommendation_not_served");
    expect(await responseCount(A, business)).toBe(0);

    // And the current one IS accepted, so the refusal is about staleness rather
    // than about the seeding being wrong.
    const accepted = await respond(page, {
      businessId: business,
      providerAccountId: account,
      recId: "runtime_evidence_current_rec",
      action: "acted",
    });
    expect(accepted.status).toBe(200);
  });

  /*
   * Legacy rows: written before the lineage column existed, so their account
   * cannot be proven. They are withheld, never shown for every account.
   */
  test("a row with no proven account lineage is withheld, not shared", async ({ page }) => {
    const business = handle.businesses.oneAccount;
    await seedRow({ recId: A, account: null, business, recType: "rt_legacy" });
    await openSurface(
      page,
      handle,
      `/c/${business}/meta/intelligence?providerAccountId=${handle.accounts.one}`,
    );

    const refused = await respond(page, {
      businessId: business,
      providerAccountId: handle.accounts.one,
      recId: A,
      action: "acted",
    });

    expect(refused.status).toBe(404);
    expect(await responseCount(A, business)).toBe(0);
  });

  test("a response with no account at all is refused", async ({ page }) => {
    const business = handle.businesses.oneAccount;
    await seedRow({ recId: A, account: handle.accounts.one, business, recType: "rt_noacct" });
    await openSurface(page, handle, INTELLIGENCE);

    const refused = await respond(page, {
      businessId: business,
      providerAccountId: null,
      recId: A,
      action: "acted",
    });

    // "The current snapshot" is a per-account fact, so an unscoped response
    // cannot be authorized — it does not fall back to business-wide.
    expect(refused.status).toBe(404);
    expect(await responseCount(A, business)).toBe(0);
  });
});
