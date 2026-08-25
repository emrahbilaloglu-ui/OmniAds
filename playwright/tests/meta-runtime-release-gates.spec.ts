/**
 * What a release gate does, asked of two running servers.
 *
 * A gate has two halves — the refusal and the capability — and one process can
 * only ever show one of them. The harness therefore runs two standalone builds
 * against the SAME database and the SAME fixture, differing only in release-gate
 * environment, and every case here asks both the same question. The difference
 * between the two answers is the gate.
 *
 * Four gates are opened on the second server: the Meta Stop, the decision
 * workflow, the share mint and the account picker. Every one of them acts on
 * our own database and contacts no provider. `META_LAUNCHPAD_EXECUTION` and
 * `META_AUTOMATION_LIVE_WRITES` are opened NOWHERE in this harness: their next
 * step is a call to Meta, and no local evidence may be produced by making one.
 *
 * Three properties are under test, and the third is the one that matters most:
 *
 *   1. shut  → the server refuses, with a §9.1 code and no variable name, and
 *              nothing durable changes;
 *   2. open  → the capability works, and a DB read-back proves it rather than
 *              the response's own optimism;
 *   3. open  → NO authorization is granted. Another tenant, an unassigned
 *              account and a reviewer are refused exactly as before. A gate
 *              decides what is OFFERED, never what is PERMITTED, and an
 *              environment flip that widened access would make every other
 *              guarantee in this file worthless.
 */
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

import { openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();

interface ApiResult {
  status: number;
  body: string;
}

/**
 * POST from a page on the target origin, so the session cookie travels and the
 * request is the one the product makes.
 *
 * The cookie is issued for `127.0.0.1` and cookies ignore the port, so a single
 * sign-in reaches both servers.
 */
async function postTo(
  page: Page,
  baseUrl: string,
  path: string,
  payload: unknown,
): Promise<ApiResult> {
  if (!page.url().startsWith(baseUrl)) {
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  }
  return page.evaluate(
    async ({ url, body }: { url: string; body: unknown }) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.text()).slice(0, 1200) };
    },
    { url: path, body: payload },
  );
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

/** The stored Stop, read from the table rather than from the response. */
async function readStop(businessId: string): Promise<boolean | null> {
  return withDb(async (client) => {
    const rows = await client.query<{ kill_switch_engaged: boolean }>(
      "SELECT kill_switch_engaged FROM meta_automation_business_controls WHERE business_id = $1",
      [businessId],
    );
    return rows.rows[0]?.kill_switch_engaged ?? null;
  });
}

/*
 * No sign-in here. The `meta-runtime-chromium` project carries one storage
 * state for the whole run, because logging in per test trips the login
 * throttle — a 429 in the middle of a gate sweep reads as a gate failure. The
 * cookie is issued for `127.0.0.1` and cookies ignore the port, so the same
 * session reaches both servers.
 */

test.describe("the Meta Stop, engaged and released against the real database", () => {
  const automation = `/api/meta/automation?businessId=${handle.businesses.oneAccount}&providerAccountId=${handle.accounts.one}`;

  test("is refused on the shipped server, and stores nothing", async ({ page }) => {
    const before = await readStop(handle.businesses.oneAccount);

    const result = await postTo(page, handle.baseUrl, automation, {
      action: "engage_kill_switch",
      reason: "runtime evidence probe",
    });

    expect(result.status, result.body).toBe(503);
    expect(result.body).toContain("automation_stop_disabled");
    expect(result.body).toMatch(/not enabled yet/i);
    expect(result.body).not.toMatch(/META_[A-Z_]+/);
    expect(await readStop(handle.businesses.oneAccount)).toBe(before);
  });

  test("engages, reads back, releases, reads back, and does it again", async ({
    page,
  }) => {
    /**
     * The reversibility proof, which is the whole reason the gate holds ENGAGE
     * and never RELEASE. A stop that cannot be lifted is worse than no stop, so
     * "it engaged" is not the claim worth making — "it engaged, and then it let
     * go, and then it did both again" is.
     *
     * Every assertion is a SELECT against the control table, not a reading of
     * the response body. The route re-reads its own write and could report a
     * success it did not persist; the table cannot.
     */
    const engageOnce = async () => {
      const result = await postTo(page, handle.gatesOpenBaseUrl, automation, {
        action: "engage_kill_switch",
        reason: "runtime evidence reversibility probe",
      });
      expect(result.status, result.body).toBe(200);
    };
    const releaseOnce = async () => {
      const result = await postTo(page, handle.gatesOpenBaseUrl, automation, {
        action: "release_kill_switch",
      });
      expect(result.status, result.body).toBe(200);
    };

    await engageOnce();
    expect(await readStop(handle.businesses.oneAccount), "engage did not persist").toBe(
      true,
    );

    await releaseOnce();
    expect(await readStop(handle.businesses.oneAccount), "release did not persist").toBe(
      false,
    );

    // Twice, because a one-way mechanism can pass a single round trip: an
    // engage that only worked from a fresh row, or a release that only worked
    // once, would both survive the first two steps.
    await engageOnce();
    expect(await readStop(handle.businesses.oneAccount)).toBe(true);
    await releaseOnce();
    expect(await readStop(handle.businesses.oneAccount)).toBe(false);
  });

  test("writes both directions into the activity ledger", async ({ page }) => {
    // A stop nobody can account for afterwards is a stop that happened in
    // secret. Both directions are recorded, and the release is not silent.
    const countRows = async () =>
      withDb(async (client) => {
        const rows = await client.query<{ activity_type: string; count: string }>(
          `SELECT activity_type, COUNT(*)::text AS count
             FROM meta_automation_activity_ledger
            WHERE business_id = $1
              AND activity_type IN ('business_kill_switch_engaged', 'business_kill_switch_released')
            GROUP BY activity_type`,
          [handle.businesses.oneAccount],
        );
        return new Map(rows.rows.map((row) => [row.activity_type, Number(row.count)]));
      });

    const before = await countRows();
    await postTo(page, handle.gatesOpenBaseUrl, automation, {
      action: "engage_kill_switch",
      reason: "runtime evidence ledger probe",
    });
    await postTo(page, handle.gatesOpenBaseUrl, automation, {
      action: "release_kill_switch",
    });
    const after = await countRows();

    expect(
      (after.get("business_kill_switch_engaged") ?? 0) -
        (before.get("business_kill_switch_engaged") ?? 0),
    ).toBe(1);
    expect(
      (after.get("business_kill_switch_released") ?? 0) -
        (before.get("business_kill_switch_released") ?? 0),
    ).toBe(1);
  });

  test("releases at the SHIPPED gate setting too", async ({ page }) => {
    /**
     * The asymmetry, proven where it counts. Engaging is held; lifting is not,
     * at any setting. This engages on the open server and then releases through
     * the shipped one — the deployment an operator would actually be sitting in
     * — so a stop can never be stranded by the rollout state that created it.
     */
    await postTo(page, handle.gatesOpenBaseUrl, automation, {
      action: "engage_kill_switch",
      reason: "runtime evidence asymmetry probe",
    });
    expect(await readStop(handle.businesses.oneAccount)).toBe(true);

    const released = await postTo(page, handle.baseUrl, automation, {
      action: "release_kill_switch",
    });

    expect(released.status, released.body).toBe(200);
    expect(await readStop(handle.businesses.oneAccount)).toBe(false);
  });

  test("offers the control on screen, disabled with its reason", async ({ page }) => {
    await openSurface(
      page,
      handle,
      `/c/${handle.businesses.oneAccount}/meta/automation`,
    );

    const control = page.locator('[data-field="business-writes-control"] button');
    await expect(control).toHaveCount(1);
    // The Stop is released at this point, so the offered direction is engage.
    await expect(control).toBeDisabled();
    await expect(control).toHaveAttribute("data-ctl", "disabled:AUTOMATION-STOP engage");

    const text = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
    expect(text).toMatch(/a stop that cannot be released is worse than no stop/i);
    expect(text).not.toMatch(/META_[A-Z_]+/);
  });

  test("offers a live control on the open server", async ({ page }) => {
    await openSurface(
      page,
      handle,
      `/c/${handle.businesses.oneAccount}/meta/automation`,
      handle.gatesOpenBaseUrl,
    );

    const control = page.locator('[data-field="business-writes-control"] button');
    await expect(control).toHaveCount(1);
    await expect(control).toHaveAttribute("data-ctl", "live:AUTOMATION-STOP engage");
    await expect(control).toBeEnabled();
  });
});

test.describe("the decision workflow, moved and read back", () => {
  const workflow = "/api/meta/decision-workflow";
  async function readRecord(
    decisionKey: string,
  ): Promise<{ state: string; version: number } | null> {
    return withDb(async (client) => {
      const rows = await client.query<{ state: string; state_version: number }>(
        "SELECT state, state_version FROM decision_workflow_state WHERE business_id = $1 AND decision_key = $2",
        [handle.businesses.oneAccount, decisionKey],
      );
      const row = rows.rows[0];
      return row ? { state: row.state, version: Number(row.state_version) } : null;
    });
  }

  /**
   * A key nobody else has touched — including a previous run of this same test.
   *
   * The overlay is durable by design, so a fixed key made the second run start
   * at whatever version the first left behind, and the failure read as a
   * workflow defect rather than as a test reusing its own state. `testId` alone
   * was not enough: it is stable across runs, which is exactly the property
   * that has to be avoided here.
   */
  function freshKey(testInfo: { testId: string; retry: number }): string {
    return `runtime-evidence-workflow-${testInfo.testId}-${testInfo.retry}-${Date.now()}`;
  }

  test("is refused on the shipped server, and stores nothing", async ({ page }, testInfo) => {
    const decisionKey = freshKey(testInfo);

    const result = await postTo(page, handle.baseUrl, workflow, {
      businessId: handle.businesses.oneAccount,
      decisionKey,
      action: "acknowledge",
      expectedVersion: 1,
    });

    expect(result.status, result.body).toBe(503);
    expect(result.body).toContain("decision_workflow_disabled");
    expect(result.body).not.toMatch(/META_[A-Z_]+/);
    expect(await readRecord(decisionKey), "a refused transition stored state").toBeNull();
  });

  test("acknowledges, defers, resolves, reopens — and refuses a stale version", async ({
    page,
  }, testInfo) => {
    const decisionKey = freshKey(testInfo);
    const move = async (action: string, expectedVersion: number, extra = {}) => {
      const result = await postTo(page, handle.gatesOpenBaseUrl, workflow, {
        businessId: handle.businesses.oneAccount,
        decisionKey,
        action,
        expectedVersion,
        ...extra,
      });
      expect(result.status, `${action}: ${result.body}`).toBe(200);
    };

    /*
     * Every assertion is a SELECT. The route answers with the record it just
     * built in memory and would report a transition it failed to persist.
     *
     * An unseen decision starts at version 1, not 0 — `newWorkflowRecord`
     * hands out an open record with `stateVersion: 1` before anything is
     * stored — so the first transition sends 1.
     */
    await move("acknowledge", 1);
    expect(await readRecord(decisionKey)).toEqual({ state: "acknowledged", version: 2 });

    await move("defer", 2, { snoozeUntil: "2099-01-01T00:00:00.000Z" });
    expect(await readRecord(decisionKey)).toMatchObject({ state: "deferred", version: 3 });

    await move("resolve", 3, { reasonCode: "applied" });
    expect(await readRecord(decisionKey)).toMatchObject({ state: "resolved", version: 4 });

    await move("reopen", 4);
    expect(await readRecord(decisionKey)).toMatchObject({ state: "open", version: 5 });

    /*
     * Two operators, one decision. The second one's screen still says version 4
     * after the first has moved it to 5, and that write must LOSE rather than
     * quietly overwrite a state it never saw.
     */
    const stale = await postTo(page, handle.gatesOpenBaseUrl, workflow, {
      businessId: handle.businesses.oneAccount,
      decisionKey,
      action: "acknowledge",
      expectedVersion: 4,
    });

    expect(stale.status, stale.body).toBe(409);
    expect(stale.body).toContain("version_conflict");
    expect(await readRecord(decisionKey)).toMatchObject({ state: "open", version: 5 });
  });
});

test.describe("the public share mint", () => {
  const share = "/api/creatives/share";

  function shareBody(title: string) {
    return {
      title,
      dateRange: "Last 7d",
      expiresAt: "2099-01-01T00:00:00.000Z",
      businessId: handle.businesses.oneAccount,
      providerAccountId: handle.accounts.one,
      metrics: ["ctrAll"],
      includeNotes: false,
      audience: "creative_team",
      creatives: [
        {
          id: "runtime_evidence_creative",
          name: "Runtime evidence",
          format: "image",
          launchDate: "2026-08-01",
          preview: {
            render_mode: "unavailable",
            image_url: null,
            video_url: null,
            poster_url: null,
            source: null,
            is_catalog: false,
          },
        },
      ],
    };
  }

  async function countShares(): Promise<number> {
    return withDb(async (client) => {
      const rows = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM creative_share_snapshots WHERE business_id = $1",
        [handle.businesses.oneAccount],
      );
      return Number(rows.rows[0]?.count ?? "0");
    });
  }

  test("is refused on the shipped server, and mints nothing", async ({ page }) => {
    const before = await countShares();

    const result = await postTo(
      page,
      handle.baseUrl,
      share,
      shareBody("runtime evidence refused mint"),
    );

    expect(result.status, result.body).toBe(503);
    expect(result.body).toContain("public_share_mint_disabled");
    expect(result.body).toMatch(/rotated or revoked/i);
    expect(result.body).not.toMatch(/META_[A-Z_]+/);
    expect(await countShares()).toBe(before);
  });

  test("mints on the open server and the row is really there", async ({ page }) => {
    const before = await countShares();

    const result = await postTo(
      page,
      handle.gatesOpenBaseUrl,
      share,
      shareBody("runtime evidence mint"),
    );

    expect(result.status, result.body).toBe(200);
    expect(await countShares(), "a 200 that minted nothing").toBe(before + 1);
  });

  test("keeps withdrawal available at the SHIPPED gate setting", async ({ page }) => {
    /**
     * The gate is about issuing NEW links. An existing one must be revocable
     * whatever the rollout state — a share that cannot be withdrawn is a worse
     * outcome than a share that was never offered.
     *
     * Asked of the shipped server, and the assertion is only that the answer is
     * NOT the mint refusal: the token below does not exist, so the honest reply
     * is a not-found. What must never come back is "this capability is off".
     */
    await page.goto(`${handle.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(
      async (url: string) => {
        const response = await fetch(url, { method: "DELETE", credentials: "include" });
        return { status: response.status, body: (await response.text()).slice(0, 600) };
      },
      // Relative: an absolute URL to the other server would be a cross-origin
      // request and would fail as CORS rather than as anything about the gate.
      `/api/creatives/share/${"f".repeat(32)}?businessId=${handle.businesses.oneAccount}`,
    );

    expect(result.status).not.toBe(503);
    expect(result.body).not.toContain("public_share_mint_disabled");
  });
});

test.describe("an open gate grants no authorization", () => {
  /**
   * The property that makes every other one in this file worth having.
   *
   * `release-gates.ts` states it — *"Turning a gate on does not grant access to
   * a business, a provider account, a role or a write"* — and until now nothing
   * checked it. These run against the server with four gates OPEN and assert
   * that the access layer answers exactly as it does with them shut.
   */
  test("another tenant's business is still refused", async ({ page }) => {
    const result = await postTo(
      page,
      handle.gatesOpenBaseUrl,
      `/api/meta/automation?businessId=${handle.businesses.otherTenant}&providerAccountId=${handle.accounts.otherTenant}`,
      { action: "engage_kill_switch", reason: "cross-tenant probe" },
    );

    expect([401, 403, 404]).toContain(result.status);
    expect(result.body).not.toContain("automation_stop_disabled");
    expect(await readStop(handle.businesses.otherTenant)).not.toBe(true);
  });

  test("an unassigned account is still refused, and never falls back", async ({
    page,
  }) => {
    const result = await postTo(
      page,
      handle.gatesOpenBaseUrl,
      `/api/meta/automation?businessId=${handle.businesses.oneAccount}&providerAccountId=${handle.accounts.manyA}`,
      { action: "engage_kill_switch", reason: "foreign account probe" },
    );

    expect(result.status, result.body).toBe(403);
    expect(result.body).toContain("account_not_assigned");
  });

  test("a business with no assigned account cannot be stopped by scope alone", async ({
    page,
  }) => {
    const result = await postTo(
      page,
      handle.gatesOpenBaseUrl,
      `/api/meta/automation?businessId=${handle.businesses.zeroAccounts}`,
      { action: "engage_kill_switch", reason: "zero-account probe" },
    );

    expect(result.status, result.body).toBe(400);
    expect(await readStop(handle.businesses.zeroAccounts)).not.toBe(true);
  });

  test("the workflow gate does not turn a foreign business into a writable one", async ({
    page,
  }) => {
    const result = await postTo(page, handle.gatesOpenBaseUrl, "/api/meta/decision-workflow", {
      businessId: handle.businesses.otherTenant,
      decisionKey: "cross-tenant-workflow-probe",
      action: "acknowledge",
      expectedVersion: 0,
    });

    expect([401, 403, 404]).toContain(result.status);
    expect(
      await withDb(async (client) =>
        client.query("SELECT 1 FROM decision_workflow_state WHERE decision_key = $1", [
          "cross-tenant-workflow-probe",
        ]),
      ).then((rows) => rows.rowCount),
    ).toBe(0);
  });
});

test.describe("the account picker gate governs the offer, not the scope", () => {
  test("locks the selection on the shipped server and says why", async ({ page }) => {
    await openSurface(
      page,
      handle,
      `/c/${handle.businesses.manyAccounts}/meta/decisions`,
    );

    const locked = page.locator("[data-account-change-refused]");
    await expect(locked).toHaveCount(1);
    const text = (await locked.innerText()).replace(/\s+/g, " ");
    expect(text.length, "a locked picker with no name is a dead end").toBeGreaterThan(0);
    expect(await page.content()).not.toMatch(/META_[A-Z0-9_]{4,}/);
  });

  test("exits account_required by a real selection on the open server", async ({
    page,
  }) => {
    /**
     * D6's `account_required` is a REFUSAL, not a dead end: an account is
     * assigned, several are, and the operator has not said which. The way out
     * is a selection, and this proves the way out exists rather than asserting
     * the refusal and stopping there.
     */
    await openSurface(
      page,
      handle,
      `/c/${handle.businesses.manyAccounts}/meta/decisions`,
      handle.gatesOpenBaseUrl,
    );
    await expect(
      page.locator('[data-meta-surface-state][data-read-state="refused"]'),
    ).toHaveCount(1);

    await openSurface(
      page,
      handle,
      `/c/${handle.businesses.manyAccounts}/meta/decisions?providerAccountId=${handle.accounts.manyA}`,
      handle.gatesOpenBaseUrl,
    );

    const state = page.locator("[data-meta-surface-state]").first();
    await expect(state).not.toHaveAttribute("data-read-state", "refused");
    await expect(state).toHaveAttribute("data-provider-account", handle.accounts.manyA);
  });

  test("still refuses an account this business is not assigned", async ({ page }) => {
    /*
     * With the picker OPEN. A selection widens nothing: an id from another
     * tenant is refused rather than silently replaced by one this business does
     * have, which would answer a question about account A with account B's
     * data.
     *
     * Asserted on the surface's own §9 state rather than by scanning the page
     * for account ids — the picker legitimately lists the assigned accounts, so
     * their presence in the DOM says nothing about what was read.
     */
    await openSurface(
      page,
      handle,
      `/c/${handle.businesses.manyAccounts}/meta/decisions?providerAccountId=${handle.accounts.otherTenant}`,
      handle.gatesOpenBaseUrl,
    );

    const state = page.locator("[data-meta-surface-state]").first();
    await expect(state).toHaveAttribute("data-read-state", "refused");
    await expect(state).toHaveAttribute(
      "data-failure-code",
      "provider_account_not_assigned",
    );
    // And no fallback happened: the refused scope carries no account at all.
    expect(await state.getAttribute("data-provider-account")).toBeNull();
  });
});
