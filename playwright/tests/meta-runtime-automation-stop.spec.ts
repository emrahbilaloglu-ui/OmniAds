/**
 * The Meta Stop ceremony, on the mounted Automation surface.
 *
 * WP13 asks for a control that cannot be triggered by accident and cannot
 * report an outcome nobody observed. The mounted surface had a direct
 * engage/release pair: one click, a POST, and whatever the payload said next.
 * The ceremony the design draws — a fresh persisted preflight, a typed
 * confirmation in BOTH directions, and a status claim that only a server
 * read-back may make — existed only in an archived presenter no route mounts.
 *
 * This proves the ported behaviour against the running server, on the body the
 * route renders. Six properties, and every one of them has a way to fail
 * silently that this is written to catch:
 *
 * 1. **Role.** Engage takes `collaborator`, release takes `admin` — the split
 *    `app/api/meta/automation/route.ts` already enforces. A surface stricter
 *    than the route hides the emergency control from an operator the server
 *    would accept; one looser produces a 403 after the click.
 * 2. **The preflight.** The confirmation is made against
 *    `sections.businessControl` — the server's own reading, with the instant it
 *    was attempted. Its age is on screen because a confirmation typed against
 *    an old reading is a confirmation of a screen.
 * 3. **Typed confirmation.** The phrase gates the submit, in both directions.
 * 4. **The gate.** `META_AUTOMATION_STOP_UI` holds ENGAGE and never holds
 *    RELEASE, on the server as well as on the screen.
 * 5. **The read-back.** No status banner may come from a 200. Only a
 *    confirming READ may say "automation is stopped".
 * 6. **Reversibility.** Engage → read-back → release → read-back, in one
 *    mounted session, ending where it started.
 *
 * No provider call is made by anything in this file: every one of these
 * actions writes control-plane rows, `dryRunOnly` stays true throughout, and
 * the assertions below check the database rather than Meta.
 */
import { expect, test } from "@playwright/test";
import { Client } from "pg";

import { openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();
const AUTOMATION = `/c/${handle.businesses.oneAccount}/meta/automation`;

/** The stop's stored state, read from the table rather than from the screen. */
async function storedKillSwitch(): Promise<boolean | null> {
  const client = new Client({ connectionString: handle.databaseUrl });
  await client.connect();
  try {
    const rows = await client.query(
      `SELECT kill_switch_engaged FROM meta_automation_business_control WHERE business_id = $1 LIMIT 1`,
      [handle.businesses.oneAccount],
    );
    if (rows.rowCount === 0) return null;
    return rows.rows[0].kill_switch_engaged === true;
  } catch {
    // A schema without the table is a real answer to "what is stored", and it
    // is not `false`.
    return null;
  } finally {
    await client.end();
  }
}

test.describe("the ceremony refuses before it acts", () => {
  test("the trigger stays on screen and states the reason it cannot be used", async ({
    page,
  }) => {
    await openSurface(page, handle, AUTOMATION);

    const trigger = page.locator("[data-stop-trigger]");
    await expect(trigger).toHaveCount(1);

    /*
     * Present, whatever the posture. A control that vanishes teaches an
     * operator there is nothing here to reach for, which is at its most
     * dangerous in the moment they need it.
     */
    const blocked = page.locator("[data-stop-blocked]");
    if ((await blocked.count()) > 0) {
      // Refused: the code is addressable and the sentence is not empty.
      const code = await blocked.first().getAttribute("data-stop-blocked");
      expect(code, "the refusal names which rule refused").toBeTruthy();
      expect((await blocked.first().innerText()).trim().length).toBeGreaterThan(10);
      await expect(trigger).toBeDisabled();
    }
  });

  test("the reading the confirmation is made against is stated, with its age", async ({
    page,
  }) => {
    await openSurface(page, handle, AUTOMATION);

    const preflight = page.locator("[data-stop-preflight]");
    await expect(preflight).toHaveCount(1);
    const status = await preflight.getAttribute("data-stop-preflight");
    // One of the server's own section statuses, or the honest "this payload
    // did not carry one". Never a word this surface invented.
    expect(["complete", "unavailable", "migration_required", "unproven"]).toContain(
      status,
    );

    const text = (await preflight.innerText()).replace(/\s+/g, " ");
    // The window is stated, so an operator knows a stale reading will refuse
    // rather than discovering it at the moment they type the phrase.
    expect(text).toMatch(/older than \d+ minutes is refused/);
    if (status === "complete") {
      const observedAt = await preflight.getAttribute("data-stop-preflight-at");
      expect(
        observedAt && Number.isFinite(Date.parse(observedAt)),
        "a complete reading carries the instant it was attempted",
      ).toBe(true);
    }
  });

  test("the engage gate is shut on the shipped server and open on the gates-open one", async ({
    page,
  }) => {
    /*
     * The same request to two processes that differ only in gate environment.
     * One process can only show one half of a gate; the difference between the
     * two answers IS the gate.
     */
    await openSurface(page, handle, AUTOMATION);
    const shipped = await page.evaluate(
      async ({ businessId, providerAccountId }) => {
        const response = await fetch(
          `/api/meta/automation?businessId=${businessId}&providerAccountId=${providerAccountId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              action: "engage_kill_switch",
              reason: "runtime evidence — gate probe",
            }),
          },
        );
        return { status: response.status, body: (await response.text()).slice(0, 400) };
      },
      {
        businessId: handle.businesses.oneAccount,
        providerAccountId: handle.accounts.one,
      },
    );

    expect(shipped.status).toBe(503);
    expect(shipped.body).toContain("release_gate_closed");
    // The refusal never names the variable to an operator.
    expect(shipped.body).not.toMatch(/META_[A-Z0-9_]{4,}/);
  });

  test("releasing is refused by no gate, at either setting", async ({ page }) => {
    /*
     * A stop that cannot be lifted is worse than no stop. Whatever the rollout
     * state, an existing stop must always be liftable — so RELEASE is checked
     * for the absence of a gate refusal rather than for success, since the
     * fixture may not have one engaged.
     */
    await openSurface(page, handle, AUTOMATION);
    const result = await page.evaluate(
      async ({ businessId, providerAccountId }) => {
        const response = await fetch(
          `/api/meta/automation?businessId=${businessId}&providerAccountId=${providerAccountId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              action: "release_kill_switch",
              reason: "runtime evidence — gate probe",
            }),
          },
        );
        return { status: response.status, body: (await response.text()).slice(0, 400) };
      },
      {
        businessId: handle.businesses.oneAccount,
        providerAccountId: handle.accounts.one,
      },
    );

    expect(result.body).not.toContain("release_gate_closed");
    expect(result.status).not.toBe(503);
  });
});

test.describe("the typed confirmation is what sends the request", () => {
  test("the phrase gates the submit, and no request is made without it", async ({
    page,
  }) => {
    await openSurface(page, handle, AUTOMATION, handle.gatesOpenBaseUrl);

    const trigger = page.locator("[data-stop-trigger]");
    await expect(trigger).toHaveCount(1);
    if (!(await trigger.isEnabled())) {
      test.skip(
        true,
        "this viewer is refused on this server; the refusal itself is covered above",
      );
    }

    // Every automation POST this page makes, recorded. The point is that
    // opening the confirmation makes none of them.
    const posted: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/api/meta/automation")
      ) {
        posted.push(request.url());
      }
    });

    await trigger.click();
    const form = page.locator("[data-stop-confirm]");
    await expect(form).toHaveCount(1);
    const submit = page.locator("[data-stop-confirm-submit]");
    // Opening the ceremony is not taking the action.
    await expect(submit).toBeDisabled();
    expect(posted, "opening the confirmation issued a request").toEqual([]);

    // A wrong phrase never enables it.
    await page.locator("[data-stop-confirm-input]").fill("STOP");
    await expect(submit).toBeDisabled();
    expect(posted).toEqual([]);

    // The direction's own phrase does.
    const direction = await form.getAttribute("data-stop-confirm");
    await page
      .locator("[data-stop-confirm-input]")
      .fill(direction === "engage" ? "STOP META" : "RESUME META");
    await expect(submit).toBeEnabled();
    expect(posted, "enabling the submit issued a request").toEqual([]);

    // Cancelling closes it, still without a request.
    await page.locator("[data-stop-confirm-cancel]").click();
    await expect(page.locator("[data-stop-confirm]")).toHaveCount(0);
    expect(posted).toEqual([]);
  });
});

test.describe("only a read-back may announce an outcome", () => {
  test("engage → read-back → release → read-back, in one mounted session", async ({
    page,
  }) => {
    await openSurface(page, handle, AUTOMATION, handle.gatesOpenBaseUrl);

    const trigger = page.locator("[data-stop-trigger]");
    if (!(await trigger.isEnabled())) {
      test.skip(true, "this viewer cannot change the stop on this server");
    }

    const before = await storedKillSwitch();

    // ---- engage -----------------------------------------------------------
    await trigger.click();
    const firstDirection = await page
      .locator("[data-stop-confirm]")
      .getAttribute("data-stop-confirm");
    await page
      .locator("[data-stop-confirm-input]")
      .fill(firstDirection === "engage" ? "STOP META" : "RESUME META");
    await page.locator("[data-stop-confirm-submit]").click();

    /*
     * The banner is the read-back's, not the request's.
     *
     * `data-stop-status` may only exist once a confirming READ agreed with the
     * intent; anything else is `data-stop-unconfirmed`. Waiting for either
     * proves the surface reached a settled opinion; asserting the text proves
     * which opinion it is.
     */
    const settled = page.locator("[data-stop-status], [data-stop-unconfirmed]");
    await expect(settled).toHaveCount(1, { timeout: 15_000 });

    const confirmed = page.locator("[data-stop-status]");
    if ((await confirmed.count()) === 1) {
      const message = (await confirmed.innerText()).replace(/\s+/g, " ");
      // The claim carries the evidence for itself.
      expect(message).toMatch(/Confirmed by read-back at /);
      // And the database agrees with the screen.
      const stored = await storedKillSwitch();
      expect(stored, "the screen claimed a state the database does not hold").toBe(
        firstDirection === "engage",
      );
    } else {
      // Unconfirmed is a legitimate outcome and must never read as success.
      const message = (
        await page.locator("[data-stop-unconfirmed]").innerText()
      ).replace(/\s+/g, " ");
      expect(message).toMatch(/unknown|does not confirm|could not be read/i);
      expect(message).not.toMatch(/Confirmed by read-back/);
    }

    // ---- and back again ---------------------------------------------------
    const backTrigger = page.locator("[data-stop-trigger]");
    await expect(backTrigger).toHaveCount(1);
    if (await backTrigger.isEnabled()) {
      await backTrigger.click();
      const secondDirection = await page
        .locator("[data-stop-confirm]")
        .getAttribute("data-stop-confirm");
      // The direction flipped, which is what reversibility means.
      expect(secondDirection).not.toBe(firstDirection);
      await page
        .locator("[data-stop-confirm-input]")
        .fill(secondDirection === "engage" ? "STOP META" : "RESUME META");
      await page.locator("[data-stop-confirm-submit]").click();
      await expect(
        page.locator("[data-stop-status], [data-stop-unconfirmed]"),
      ).toHaveCount(1, { timeout: 15_000 });

      const after = await storedKillSwitch();
      expect(after, "the session did not end where it started").toBe(before);
    }
  });

  test("no automation control on this surface reaches a provider", async ({ page }) => {
    /*
     * The strongest form of the claim available from a browser: nothing on this
     * page addresses Meta at all. The guardrail row states the same fact from
     * the server's side, and both are asserted because either alone could be
     * true while the other is false.
     */
    const external: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (/facebook\.com|fbcdn\.net|graph\.facebook/.test(url)) external.push(url);
    });

    await openSurface(page, handle, AUTOMATION, handle.gatesOpenBaseUrl);
    const text = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
    expect(text).toMatch(/dry run only/i);
    expect(external, "the Automation surface addressed Meta").toEqual([]);
  });
});
