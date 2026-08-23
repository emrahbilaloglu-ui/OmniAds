/**
 * The refusals, on the running server.
 *
 * The plan's P1 concern was that the Launchpad execution gate might be a claim
 * rather than a control: a document, a default-off flag and a unit test are
 * three ways of describing a refusal without ever making one. This asks the
 * built server, over HTTP, with a real session, and reads what it answers.
 *
 * What is proven here is the SHIPPED posture — every release gate at its
 * default, which is off. The opposite branch (gate open, safety contract
 * incomplete) cannot be produced from outside without opening the gate, and
 * opening it on a route whose next steps reach Meta is not something a test may
 * do. That branch is proven against the injected pure decision in
 * `lib/meta/launchpad-write-safety.behaviour.test.ts`, and the split is
 * deliberate: this file proves the wiring, that one proves the decision.
 *
 * No provider call is made by anything in this file.
 */
import { expect, test } from "@playwright/test";
import { Client } from "pg";

import { openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();

interface ApiResult {
  status: number;
  body: string;
}

async function post(
  page: import("@playwright/test").Page,
  path: string,
  payload: unknown,
): Promise<ApiResult> {
  // From a same-origin page, so the session cookie travels and the request is
  // the one the product actually makes.
  await openSurface(page, handle, `/c/${handle.businesses.oneAccount}/meta/launchpad`);
  return page.evaluate(
    async ({ url, body }: { url: string; body: unknown }) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.text()).slice(0, 900) };
    },
    { url: path, body: payload },
  );
}

test.describe("Launchpad execution is refused by the server, not by the screen", () => {
  test("a launch POST is refused with the gate reason", async ({ page }) => {
    const result = await post(page, "/api/launchpad/meta/launch", {
      businessId: handle.businesses.oneAccount,
      providerAccountId: handle.accounts.one,
      idempotencyKey: "runtime-evidence-launch-probe",
      payload: { campaign: { name: "probe" }, adSets: [], ads: [] },
    });

    expect(result.status, result.body).toBe(503);
    expect(result.body).toContain("launchpad_execution_disabled");
    // The operator-facing reason, and no environment variable name in it.
    expect(result.body).toMatch(/unavailable in this deployment|not enabled/i);
    expect(result.body).not.toMatch(/META_[A-Z_]+/);
  });

  test("add-to-existing is refused the same way", async ({ page }) => {
    const result = await post(page, "/api/launchpad/meta/add-to-existing", {
      businessId: handle.businesses.oneAccount,
      providerAccountId: handle.accounts.one,
      idempotencyKey: "runtime-evidence-add-probe",
      payload: {},
    });

    expect([404, 503]).toContain(result.status);
    if (result.status === 503) {
      expect(result.body).toContain("launchpad_execution");
      expect(result.body).not.toMatch(/META_[A-Z_]+/);
    }
  });

  test("the refusal happens before anything is written", async () => {
    /**
     * §10's ordering claim, checked rather than read: the gate sits before
     * account resolution, credential reads and any provider call. A refusal
     * that had already started an attempt would leave a row behind.
     */
    const client = new Client({ connectionString: process.env.META_RUNTIME_DATABASE_URL });
    await client.connect();
    try {
      const intents = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM meta_launch_intents",
      );
      expect(intents.rows[0]!.count, "a refused launch created a LaunchIntent").toBe("0");

      const actions = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM meta_ads_action_log",
      );
      expect(actions.rows[0]!.count, "a refused launch wrote an action log row").toBe("0");
    } finally {
      await client.end();
    }
  });
});

test.describe("the screen says the same thing the server does", () => {
  test("Launchpad presents execution as disabled with a reason, before any click", async ({
    page,
  }) => {
    await openSurface(page, handle, `/c/${handle.businesses.oneAccount}/meta/launchpad`);
    const text = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");

    // The posture is stated on the surface: PAUSED-only creates, a separate
    // activation step, and a lineage record for every write.
    expect(text).toMatch(/PAUSED/);
    expect(text).toMatch(/Activation is a separate/i);
    // And no environment variable name is shown to an operator.
    expect(text).not.toMatch(/META_[A-Z_]+/);
  });
});

test.describe("no gate name leaks to the browser", () => {
  test("no canonical surface prints a release-gate variable name", async ({ page }) => {
    const leaked: string[] = [];
    for (const path of [
      `/c/${handle.businesses.oneAccount}/meta/launchpad`,
      `/c/${handle.businesses.oneAccount}/meta/automation`,
      `/c/${handle.businesses.oneAccount}/meta/decisions`,
      `/c/${handle.businesses.oneAccount}/creative/shares`,
    ]) {
      await openSurface(page, handle, path);
      const html = await page.content();
      const match = /META_[A-Z0-9_]{4,}/.exec(html);
      if (match) leaked.push(`${path}: ${match[0]}`);
    }
    expect(leaked, "surfaces that showed an operator a gate variable name").toEqual([]);
  });
});
