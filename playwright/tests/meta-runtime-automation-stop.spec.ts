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
 * 4. **Incident reachability.** STOP remains available in both shipped and
 *    rollout-open postures; ordinary provider-write gates cannot hide it.
 * 5. **The read-back.** No status banner may come from a 200. Only a
 *    confirming READ may say "automation is stopped".
 * 6. **Reversibility.** Engage → read-back → release → read-back, in one
 *    mounted session, ending where it started.
 *
 * No provider call is made by anything in this file: every one of these
 * actions writes control-plane rows, `dryRunOnly` stays true throughout, and
 * the assertions below check the database rather than Meta.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { Client } from "pg";

import { openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();
const AUTOMATION = `/c/${handle.businesses.oneAccount}/meta/automation`;

/**
 * The responsive Automation view keeps the desktop and mobile controls mounted
 * and hides one with CSS. Runtime evidence must drive the control an operator
 * can reach at the current viewport; counting both mounted copies as two
 * ceremonies mistakes the responsive implementation for duplicate UI.
 */
function visibleStop(page: Page, selector: string): Locator {
  return page.locator(`:is(${selector}):visible`);
}

/** Open the desktop disclosure; mobile already renders the stop inline. */
async function revealStop(page: Page): Promise<void> {
  if ((await visibleStop(page, "[data-stop-trigger]").count()) > 0) return;
  const desktopControls = page.locator(
    'details:has([data-stop-trigger][data-surface="desktop"]):visible',
  );
  await expect(desktopControls).toHaveCount(1);
  if ((await desktopControls.getAttribute("open")) === null) {
    await desktopControls.locator(":scope > summary").click();
  }
  await expect(visibleStop(page, "[data-stop-trigger]")).toHaveCount(1);
}

async function postStop(
  page: Page,
  action: "engage_kill_switch" | "release_kill_switch",
) {
  return page.evaluate(
    async ({ businessId, providerAccountId, requestedAction }) => {
      const response = await fetch(
        `/api/meta/automation?businessId=${businessId}&providerAccountId=${providerAccountId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            action: requestedAction,
            reason: "runtime evidence — emergency stop reachability",
          }),
        },
      );
      return {
        status: response.status,
        body: (await response.text()).slice(0, 400),
      };
    },
    {
      businessId: handle.businesses.oneAccount,
      providerAccountId: handle.accounts.one,
      requestedAction: action,
    },
  );
}

/**
 * Whether the trigger will actually act.
 *
 * Not `isEnabled()`: the control is `aria-disabled` when refused rather than
 * `disabled`, so it stays in the tab order and the reason stays reachable —
 * and Playwright reads only the `disabled` attribute, so it would call a
 * refused control enabled. `data-stop-refused` is the state the body actually
 * carries.
 */
async function triggerActs(trigger: Locator): Promise<boolean> {
  return (await trigger.getAttribute("data-stop-refused")) === null;
}

/** The stop's stored state, read from the table rather than from the screen. */
async function storedKillSwitch(): Promise<boolean | null> {
  const client = new Client({ connectionString: handle.databaseUrl });
  await client.connect();
  try {
    const rows = await client.query(
      `SELECT kill_switch_engaged FROM meta_automation_business_controls WHERE business_id = $1 LIMIT 1`,
      [handle.businesses.oneAccount],
    );
    if (rows.rowCount === 0) return null;
    return rows.rows[0].kill_switch_engaged === true;
  } catch (error) {
    /*
     * A schema without the table is a real answer to "what is stored", and it
     * is not `false`. Anything else is this test being wrong, and it must say
     * so: a bare `catch { return null }` here swallowed a misspelt table name
     * and reported "the database holds nothing" for a row that existed.
     */
    if ((error as { code?: string }).code !== "42P01") throw error;
    return null;
  } finally {
    await client.end();
  }
}

/** Restore the shared fixture even when an assertion interrupts a ceremony. */
async function resetStoredKillSwitch(): Promise<void> {
  const client = new Client({ connectionString: handle.databaseUrl });
  await client.connect();
  try {
    await client.query(
      `UPDATE meta_automation_business_controls
          SET kill_switch_engaged = FALSE,
              kill_switch_reason = NULL,
              updated_at = NOW()
        WHERE business_id = $1`,
      [handle.businesses.oneAccount],
    );
  } finally {
    await client.end();
  }
}

test.describe("the ceremony refuses before it acts", () => {
  test.afterEach(async () => {
    await resetStoredKillSwitch();
  });

  test("the trigger is reachable and states the reason it cannot be used", async ({
    page,
  }) => {
    await openSurface(page, handle, AUTOMATION);
    await revealStop(page);

    const trigger = visibleStop(page, "[data-stop-trigger]");
    await expect(trigger).toHaveCount(1);

    /*
     * Reachable from the mounted Controls and limits disclosure, whatever the
     * posture, with the refusal still attached to the actual trigger.
     */
    const blocked = visibleStop(page, "[data-stop-blocked]");
    if ((await blocked.count()) > 0) {
      // Refused: the code is addressable and the sentence is not empty.
      const code = await blocked.first().getAttribute("data-stop-blocked");
      expect(code, "the refusal names which rule refused").toBeTruthy();
      expect((await blocked.first().innerText()).trim().length).toBeGreaterThan(
        10,
      );
      await expect(trigger).toBeDisabled();
    }
  });

  test("the reading the confirmation is made against is stated, with its age", async ({
    page,
  }) => {
    await openSurface(page, handle, AUTOMATION);
    await revealStop(page);

    const preflight = visibleStop(page, "[data-stop-preflight]");
    await expect(preflight).toHaveCount(1);
    const status = await preflight.getAttribute("data-stop-preflight");
    // One of the server's own section statuses, or the honest "this payload
    // did not carry one". Never a word this surface invented.
    expect([
      "complete",
      "unavailable",
      "migration_required",
      "unproven",
    ]).toContain(status);

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

  test("the emergency stop stays reachable in both rollout postures", async ({
    page,
  }) => {
    /*
     * STOP is an incident control, not a release capability. It must remain
     * reachable while normal provider writes are closed and while the other
     * UI gates are open. Each probe restores the precondition in `finally`.
     */
    for (const baseUrl of [handle.baseUrl, handle.gatesOpenBaseUrl]) {
      await openSurface(page, handle, AUTOMATION, baseUrl);
      await postStop(page, "release_kill_switch");
      const engaged = await postStop(page, "engage_kill_switch");
      expect(engaged.status).toBe(200);
      expect(engaged.body).not.toContain("automation_stop_disabled");
      const released = await postStop(page, "release_kill_switch");
      expect(released.status).toBe(200);
    }
  });

  test("releasing is refused by no gate, at either setting", async ({
    page,
  }) => {
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
        return {
          status: response.status,
          body: (await response.text()).slice(0, 400),
        };
      },
      {
        businessId: handle.businesses.oneAccount,
        providerAccountId: handle.accounts.one,
      },
    );

    expect(result.body).not.toContain("automation_stop_disabled");
    expect(result.status).not.toBe(503);
  });
});

test.describe("the typed confirmation is what sends the request", () => {
  test("the phrase gates the submit, and no request is made without it", async ({
    page,
  }) => {
    await openSurface(page, handle, AUTOMATION, handle.baseUrl);
    await revealStop(page);

    const trigger = visibleStop(page, "[data-stop-trigger]");
    await expect(trigger).toHaveCount(1);
    if (!(await triggerActs(trigger))) {
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
    const form = visibleStop(page, "[data-stop-confirm]");
    await expect(form).toHaveCount(1);
    const submit = visibleStop(page, "[data-stop-confirm-submit]");
    // Opening the ceremony is not taking the action.
    await expect(submit).toBeDisabled();
    expect(posted, "opening the confirmation issued a request").toEqual([]);

    // A wrong phrase never enables it.
    await visibleStop(page, "[data-stop-confirm-input]").fill("STOP");
    await expect(submit).toBeDisabled();
    expect(posted).toEqual([]);

    // The direction's own phrase does.
    const direction = await form.getAttribute("data-stop-confirm");
    await visibleStop(page, "[data-stop-confirm-input]").fill(
      direction === "engage" ? "STOP META" : "RESUME META",
    );
    await expect(submit).toBeEnabled();
    expect(posted, "enabling the submit issued a request").toEqual([]);

    // Cancelling closes it, still without a request.
    await visibleStop(page, "[data-stop-confirm-cancel]").click();
    await expect(visibleStop(page, "[data-stop-confirm]")).toHaveCount(0);
    expect(posted).toEqual([]);
  });
});

test.describe("only a read-back may announce an outcome", () => {
  test.afterEach(async () => {
    await resetStoredKillSwitch();
  });

  test("engage → read-back → release → read-back, in one mounted session", async ({
    page,
  }) => {
    await openSurface(page, handle, AUTOMATION, handle.gatesOpenBaseUrl);
    await revealStop(page);

    const trigger = visibleStop(page, "[data-stop-trigger]");
    if (!(await triggerActs(trigger))) {
      test.skip(true, "this viewer cannot change the stop on this server");
    }

    const before = await storedKillSwitch();

    // ---- engage -----------------------------------------------------------
    await trigger.click();
    const firstDirection = await visibleStop(
      page,
      "[data-stop-confirm]",
    ).getAttribute("data-stop-confirm");
    await visibleStop(page, "[data-stop-confirm-input]").fill(
      firstDirection === "engage" ? "STOP META" : "RESUME META",
    );
    await visibleStop(page, "[data-stop-confirm-submit]").click();
    await revealStop(page);

    /*
     * The banner is the read-back's, not the request's.
     *
     * `data-stop-status` may only exist once a confirming READ agreed with the
     * intent; anything else is `data-stop-unconfirmed`. Waiting for either
     * proves the surface reached a settled opinion; asserting the text proves
     * which opinion it is.
     */
    const settled = visibleStop(
      page,
      "[data-stop-status], [data-stop-unconfirmed]",
    );
    await expect(settled).toHaveCount(1, { timeout: 15_000 });

    const confirmed = visibleStop(page, "[data-stop-status]");
    if ((await confirmed.count()) === 1) {
      const message = (await confirmed.innerText()).replace(/\s+/g, " ");
      // The claim carries the evidence for itself.
      expect(message).toMatch(/Confirmed by read-back at /);
      // And the database agrees with the screen.
      const stored = await storedKillSwitch();
      expect(
        stored,
        "the screen claimed a state the database does not hold",
      ).toBe(firstDirection === "engage");
    } else {
      // Unconfirmed is a legitimate outcome and must never read as success.
      const message = (
        await visibleStop(page, "[data-stop-unconfirmed]").innerText()
      ).replace(/\s+/g, " ");
      expect(message).toMatch(/unknown|does not confirm|could not be read/i);
      expect(message).not.toMatch(/Confirmed by read-back/);
    }

    // ---- and back again ---------------------------------------------------
    await revealStop(page);
    const backTrigger = visibleStop(page, "[data-stop-trigger]");
    await expect(backTrigger).toHaveCount(1);
    if (await triggerActs(backTrigger)) {
      await backTrigger.click();
      const secondDirection = await visibleStop(
        page,
        "[data-stop-confirm]",
      ).getAttribute("data-stop-confirm");
      // The direction flipped, which is what reversibility means.
      expect(secondDirection).not.toBe(firstDirection);
      await visibleStop(page, "[data-stop-confirm-input]").fill(
        secondDirection === "engage" ? "STOP META" : "RESUME META",
      );
      await visibleStop(page, "[data-stop-confirm-submit]").click();
      await revealStop(page);
      await expect(
        visibleStop(page, "[data-stop-status], [data-stop-unconfirmed]"),
      ).toHaveCount(1, { timeout: 15_000 });

      /*
       * Compared as STATE, not as rows.
       *
       * A business that has never been stopped has no control row at all, and
       * the first engage creates one — so `null` before and `false` after is
       * the same fact twice: automation is not stopped. Comparing the raw
       * readings would call that a difference, and reversibility is a claim
       * about the state, not about whether a row exists.
       */
      const after = await storedKillSwitch();
      expect(after !== null, "the engage never reached the control table").toBe(
        true,
      );
      expect(after === true, "the session did not end where it started").toBe(
        before === true,
      );
    }
  });

  test("no automation control on this surface reaches a provider", async ({
    page,
  }) => {
    /*
     * The strongest form of the claim available from a browser: nothing on this
     * page addresses Meta at all. The guardrail row states the same fact from
     * the server's side, and both are asserted because either alone could be
     * true while the other is false.
     */
    const external: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (/facebook\.com|fbcdn\.net|graph\.facebook/.test(url))
        external.push(url);
    });

    await openSurface(page, handle, AUTOMATION, handle.baseUrl);
    await revealStop(page);
    const text = (await page.locator("main").first().innerText()).replace(
      /\s+/g,
      " ",
    );
    expect(text).toMatch(/preview only/i);
    expect(external, "the Automation surface addressed Meta").toEqual([]);
  });
});
