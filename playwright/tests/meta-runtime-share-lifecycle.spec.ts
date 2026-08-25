/**
 * WP11's whole share lifecycle, driven through mounted controls and read back
 * out of the database:
 *
 *   mint → list → open publicly → CSV → message → rotate →
 *   the old token stops working → revoke → the new token stops working
 *
 * ## Why this runs against `legacyMintBaseUrl`
 *
 * Minting exists in exactly one mounted component: the legacy Creative
 * Studio's share modal. The canonical console's Shares tab lists, rotates and
 * revokes, but passes `onCreate={undefined}` — it has no creative selection to
 * send, and the mint endpoint refuses a snapshot holding no creatives. So on a
 * `ZERO_BASE_UI_MODE=on` server there is no way to mint through the UI at all.
 *
 * That is a finding, not a workaround, and it is pinned below rather than left
 * implied. `ZERO_BASE_UI_MODE` defaults to off, so the posture this file drives
 * — rollback on, mint gate open — is the one a deployment is in today.
 *
 * ## Why the assertions read the database
 *
 * A share is a bearer credential with a lifetime. "The row disappeared from a
 * list" and "the link no longer opens" are different claims from "the snapshot
 * is revoked in storage", and only the last one is what a rotated-away link
 * actually depends on. Each step therefore asserts both halves: what the
 * operator sees, and what the row says.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

import { runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();
const BUSINESS = handle.businesses.oneAccount;
const ACCOUNT = handle.accounts.one;
const STUDIO = `/platforms/meta/creatives?providerAccountId=${encodeURIComponent(ACCOUNT)}`;

/**
 * The studio's own default window: twenty-eight days ending YESTERDAY.
 *
 * Spelled out rather than left to the endpoint's default, which is thirty days
 * ENDING TODAY — and today has no warehouse rows, so
 * `hasCreativeWarehouseCoverage` fails and the read falls through to a live
 * Meta call this harness has no credential for. The probe would then report
 * `no_data` about a fixture that is present and complete.
 */
const WINDOW = (() => {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
})();

/**
 * The whole lifecycle is one ordered story on one link.
 *
 * Split into independent tests each would have to mint its own share, and
 * "the token minted in step one is the token revoked in step eight" is the
 * claim worth making.
 */
test.describe.configure({ mode: "serial" });

interface ShareRow {
  token: string;
  revoked_at: string | null;
  business_id: string;
  payload: { creatives?: unknown[]; audience?: string; title?: string };
  /**
   * Its own column, not a key inside `payload`.
   *
   * `appendCreativeShareMessage` writes `messages = messages || …::jsonb`, so a
   * spec that looked in the payload found nothing and would have called a
   * working append a silent failure.
   */
  messages: unknown[] | null;
}

async function shareRows(): Promise<ShareRow[]> {
  const client = new Client({ connectionString: handle.databaseUrl });
  await client.connect();
  try {
    const result = await client.query<ShareRow>(
      `SELECT token, revoked_at, business_id::text AS business_id, payload, messages
         FROM creative_share_snapshots
        WHERE business_id::text = $1
        ORDER BY created_at ASC`,
      [BUSINESS],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

/**
 * Sign in and select the workspace the legacy console reads from its store.
 *
 * The legacy studio is not a `[businessId]` route: it takes the business from
 * the persisted app store and the account from the query string. Clicking
 * through `/select-business` is how an operator sets the first, so that is how
 * this sets it — a spec that wrote the store key directly would be asserting
 * against a fixture of its own making.
 */
async function enterStudio(page: Page): Promise<void> {
  await page.goto(`${handle.legacyMintBaseUrl}/login`, { waitUntil: "domcontentloaded" });
  const login = await page.evaluate(
    async (actor: { email: string; password: string }) => {
      const result = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(actor),
      });
      return { status: result.status, body: await result.text() };
    },
    { email: handle.operator.email, password: handle.operator.password },
  );
  expect(login.status, login.body).toBe(200);

  await page.goto(`${handle.legacyMintBaseUrl}/select-business`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: /One Account Co\./ }).first().click();
  await page.waitForURL((url) => !url.pathname.startsWith("/select-business"), {
    timeout: 30_000,
  });

  await page.goto(`${handle.legacyMintBaseUrl}${STUDIO}`, { waitUntil: "domcontentloaded" });
}

/** Session and workspace only — used by the fixture probe, which has no table. */
const enterStudioSession = enterStudio;

async function openStudio(page: Page): Promise<void> {
  await enterStudio(page);
  await expect(page.locator("[data-creative-studio-asset-row]").first()).toBeVisible({
    timeout: 60_000,
  });
}

/**
 * The public page for a token, on the server that minted it.
 *
 * The ready panel shows an ABSOLUTE URL — it is meant to be pasted to somebody
 * outside the product — so concatenating it onto a base produced a string that
 * was not a URL at all. The token is the durable part; the origin is this
 * harness's business.
 */
const publicPage = (token: string) => `${handle.legacyMintBaseUrl}/share/creative/${token}`;

/** The refusal region's text, which must not vary with WHY the token is dead. */
async function unavailableText(page: Page): Promise<string> {
  return (
    (await page.locator('[data-public-share="unavailable"]').innerText()).replace(/\s+/g, " ").trim()
  );
}

let mintedToken = "";
let rotatedToken = "";
let publicUrl = "";

/**
 * The fixture, checked in the product's own terms before anything is built on
 * it.
 *
 * A studio with no rows disables Share, and the failure then reads as "the
 * share control is broken" rather than "the warehouse served nothing". This
 * asks the endpoint the table reads and prints what it actually said.
 */
test("the studio's creative warehouse serves the fixture", async ({ page }) => {
  await enterStudioSession(page);
  const payload = await page.evaluate(async (url: string) => {
    const result = await fetch(url, { credentials: "include" });
    return { status: result.status, body: await result.text() };
  }, `/api/meta/creatives?businessId=${BUSINESS}&providerAccountId=${encodeURIComponent(ACCOUNT)}&groupBy=creative&format=all&sort=spend&mediaMode=full&start=${WINDOW.start}&end=${WINDOW.end}`);

  expect(payload.status, payload.body.slice(0, 2000)).toBe(200);
  const json = JSON.parse(payload.body) as { status?: string; rows?: unknown[] };
  expect(json.status ?? "ok", payload.body.slice(0, 2000)).toBe("ok");
  expect((json.rows ?? []).length, payload.body.slice(0, 2000)).toBeGreaterThanOrEqual(2);
});

test("mint — a selection in the studio becomes a stored snapshot", async ({ page }) => {
  await openStudio(page);

  const before = await shareRows();

  // Two rows ticked, so the snapshot proves a SELECTION was carried rather
  // than the account being shared wholesale.
  const rows = page.locator("[data-creative-studio-asset-row]");
  await rows.nth(0).click();
  await rows.nth(1).click();

  const share = page.getByRole("button", { name: "Share selected creatives with client" });
  await expect(share).toBeEnabled();
  await share.click();

  const modal = page.locator('[data-testid="studio-share-modal"]');
  await expect(modal).toBeVisible();

  /*
   * The buyer preset, deliberately — it is the audience with the most to
   * withhold and the only one that can carry a CSV, so it is the one worth
   * driving end to end. It also requires the financial-data acknowledgement,
   * which is a real gate rather than a formality: the mint endpoint refuses a
   * buyer share without it.
   */
  await modal.locator('[data-share-audience-option="buyer"]').click();
  await modal.getByRole("checkbox", { name: /share these financial metrics/i }).click();
  /*
   * By name. It used to be a bare `role="switch"` whose only description was a
   * sibling paragraph it did not point at, so a screen reader announced
   * "switch, on" and nothing else — found here, because this spec could not
   * address it by name either, and fixed in `ShareSnapshotModal`.
   */
  const csvToggle = modal.getByRole("switch", { name: "Allow CSV download" });
  await expect(csvToggle).toHaveCount(1);
  if ((await csvToggle.getAttribute("aria-checked")) !== "true") await csvToggle.click();
  await expect(csvToggle).toHaveAttribute("aria-checked", "true");

  await modal.getByRole("button", { name: "Create link" }).click();

  const linkField = modal.locator("[data-studio-share-link]");
  await expect(linkField).toBeVisible({ timeout: 60_000 });
  publicUrl = (await linkField.inputValue()).trim();
  expect(publicUrl, "the ready panel showed no URL").toMatch(/\/share\/creative\/[0-9a-f]{32}$/);
  mintedToken = publicUrl.split("/").pop()!;

  const after = await shareRows();
  expect(after.length, "no snapshot row was written").toBe(before.length + 1);
  const stored = after.find((row) => row.token === mintedToken);
  expect(stored, `the token the UI showed is not in storage: ${mintedToken}`).toBeDefined();
  expect(stored!.revoked_at).toBeNull();
  expect(stored!.business_id).toBe(BUSINESS);
  // The selection, in the row rather than on the screen.
  expect(stored!.payload.creatives).toHaveLength(2);
  expect(stored!.payload.audience).toBe("buyer");
});

test("list — the manager shows the link that was just minted", async ({ page }) => {
  await openStudio(page);
  await page.locator("[data-creative-studio-shared-links-button]").click();

  const manager = page.locator('[data-testid="shared-links-manager"]');
  await expect(manager).toBeVisible();
  await expect(manager.locator(`[data-share-link-row="${mintedToken}"]`)).toHaveCount(1);
});

test("open — the public page serves the snapshot to a visitor with no session", async ({
  browser,
}) => {
  /*
   * A fresh context with no storage state. Opening it in the signed-in one
   * would prove the page renders for its author, which is not the question a
   * share link asks.
   */
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto(`${publicPage(mintedToken)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator('[data-public-share="ready"]')).toHaveCount(1);
    await expect(page.locator("[data-share-creative]")).toHaveCount(2);
    // Never the workspace's own identity, to a stranger holding a link.
    expect(await page.content()).not.toContain(BUSINESS);
    expect(await page.content()).not.toContain(handle.operator.email);
  } finally {
    await context.close();
  }
});

test("CSV — the download the public page offers actually produces one", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto(`${publicPage(mintedToken)}`, {
      waitUntil: "domcontentloaded",
    });
    const csv = page.locator("[data-public-share-csv]");
    await expect(csv).toHaveCount(1);
    const href = await csv.getAttribute("data-public-share-csv-href");
    expect(href, "the CSV control rendered without a target").toBeTruthy();

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      csv.click(),
    ]);
    const file = await download.path();
    expect(file, "the click produced no file").toBeTruthy();
    const body = readFileSync(file!, "utf8");
    // A header and a line per shared creative — the same two the snapshot holds.
    expect(body.split(/\r?\n/).filter((line) => line.trim().length > 0)).toHaveLength(3);
    expect(path.basename(download.suggestedFilename())).toMatch(/\.csv$/);
  } finally {
    await context.close();
  }
});

test("message — a note left by the recipient is stored against the snapshot", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const note = "Runtime evidence: the hooks in the first three seconds need a rebrief.";
  try {
    await page.goto(`${publicPage(mintedToken)}`, {
      waitUntil: "domcontentloaded",
    });
    const box = page.getByRole("textbox", { name: /note/i }).first();
    await box.fill(note);

    /*
     * The OUTCOME, not the response object.
     *
     * This used to wait on the POST and read its body for the failure message.
     * Reading a response body from the test races the page's own read of the
     * same stream: under load the composer's `await response.json()` never
     * settled, so the note stayed in the textbox, the thread said "No notes
     * yet", and the failure read as "the note is not visible" while the server
     * had stored it and answered correctly. The test was breaking the thing it
     * was measuring.
     *
     * So: click, then assert what an operator would see, and let the console
     * listener carry the diagnosis if it does not appear.
     */
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(String(error?.message ?? error)));

    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(note),
      `the note never reached the thread. console: ${consoleErrors.join(" | ") || "(silent)"}`,
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await context.close();
  }

  const stored = (await shareRows()).find((row) => row.token === mintedToken);
  expect(stored?.messages ?? [], "the note never reached the row").toHaveLength(1);
  expect(JSON.stringify(stored!.messages)).toContain(note);
});

test("rotate — a new link is issued and the old row is revoked", async ({ page }) => {
  await openStudio(page);
  await page.locator("[data-creative-studio-shared-links-button]").click();

  const manager = page.locator('[data-testid="shared-links-manager"]');
  const row = manager.locator(`[data-share-link-row="${mintedToken}"]`);
  await row.getByRole("button", { name: "Rotate" }).click();
  await page.getByRole("button", { name: "Rotate link" }).click();

  const fresh = page.getByRole("textbox", { name: "New share URL" });
  await expect(fresh).toBeVisible({ timeout: 60_000 });
  const rotatedUrl = (await fresh.inputValue()).trim();
  rotatedToken = rotatedUrl.split("/").pop()!;
  expect(rotatedToken).not.toBe(mintedToken);

  const rows = await shareRows();
  const old = rows.find((entry) => entry.token === mintedToken);
  const next = rows.find((entry) => entry.token === rotatedToken);
  expect(old?.revoked_at, "the rotated-away token is still live in storage").not.toBeNull();
  expect(next, "the rotation issued a token that was never stored").toBeDefined();
  expect(next!.revoked_at).toBeNull();
  // The content is frozen, so rotation carries it rather than re-deriving it.
  expect(next!.payload.creatives).toHaveLength(2);
});

test("the old token is unavailable, and says nothing about why", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto(publicPage(mintedToken), {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator('[data-public-share="unavailable"]')).toHaveCount(1);
    await expect(page.locator('[data-public-share="ready"]')).toHaveCount(0);

    /*
     * The same page a token that never existed gets — asserted as an
     * equality, not as a word ban.
     *
     * The shared sentence deliberately lists every cause at once: *"It may
     * have expired, been withdrawn, or never existed."* Forbidding the word
     * "expired" would forbid the correct copy. What must hold is that the two
     * cases are INDISTINGUISHABLE, because telling a stranger that their link
     * was once a working door is the one fact this view exists to withhold.
     */
    const rotatedAway = await unavailableText(page);

    await page.goto(publicPage("f".repeat(32)), { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-public-share="unavailable"]')).toHaveCount(1);
    const neverExisted = await unavailableText(page);

    expect(rotatedAway).toBe(neverExisted);
    expect(rotatedAway.length, "the refusal said nothing at all").toBeGreaterThan(20);
    // And neither one leaks the token it was asked about.
    expect(rotatedAway).not.toContain(mintedToken);
  } finally {
    await context.close();
  }
});

test("revoke — the rotated link is withdrawn, in the list and in the row", async ({ page }) => {
  await openStudio(page);
  await page.locator("[data-creative-studio-shared-links-button]").click();

  const manager = page.locator('[data-testid="shared-links-manager"]');
  const row = manager.locator(`[data-share-link-row="${rotatedToken}"]`);
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("button", { name: "Revoke link" }).click();
  await expect(page.getByRole("button", { name: "Done" }).first()).toBeVisible({
    timeout: 60_000,
  });

  const stored = (await shareRows()).find((entry) => entry.token === rotatedToken);
  expect(stored?.revoked_at, "revoke left the row live").not.toBeNull();
});

test("and the revoked link no longer opens", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto(publicPage(rotatedToken), {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator('[data-public-share="unavailable"]')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

/**
 * The same lifecycle, on the CANONICAL console.
 *
 * This used to be a single test recording that `/app/creative/shares` could not
 * mint at all: it passed `onCreate={undefined}` because it had no creative
 * selection to send, and the mint endpoint refuses a snapshot holding none. The
 * ledger now reads the same creatives the Performance tab reads and mints from
 * a ticked selection, so the finding is closed and this is the proof.
 *
 * It runs on `gatesOpenBaseUrl` — the canonical console with
 * `META_PUBLIC_SHARE_MINT` open — and the shipped-gate refusal is checked
 * separately below, on the server where the gate is at its shipped value.
 *
 * The window is named in the URL rather than left to the default, and the
 * reason is a real property of the read rather than a convenience: the
 * canonical default window ends TODAY, and `getMetaCreativesApiPayload` sends
 * any range containing the current day to a live provider read regardless of
 * warehouse coverage. This harness has no provider, so the default window
 * serves nothing anywhere. A scoped link — which is what `creativesListHref`
 * builds — is the honest way to ask for a window the warehouse can answer.
 */
const CANONICAL_SHARES = `/c/${BUSINESS}/creative/shares?providerAccountId=${encodeURIComponent(
  ACCOUNT,
)}&start=${WINDOW.start}&end=${WINDOW.end}`;

async function openCanonicalShares(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}${CANONICAL_SHARES}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load");
  const create = page.locator('[data-ctl="live:CREATIVE-10 open-create"]');
  await expect(create).toHaveCount(1, { timeout: 60_000 });
  /*
   * Settled, not merely present. The mint control is refused while the
   * creatives read is in flight — the zero-base `Button` expresses that as
   * `aria-disabled`, absent when enabled — so clicking it too early does
   * nothing and the next wait times out describing the wrong thing.
   */
  await expect(create).toBeEnabled({ timeout: 60_000 });
}

test.describe("the canonical console mints its own shares", () => {
  /*
   * Headroom, not a workaround. The mint runs in well under a second once the
   * console has loaded; the extra budget is for the five servers this harness
   * runs on one machine, where a cold first paint can take most of a minute
   * without anything being wrong.
   */
  test.setTimeout(180_000);

  let canonicalToken = "";

  test("the ledger's own creatives read serves this scope", async ({ page }) => {
    /*
     * The same probe the legacy studio gets, for the same reason: a mint
     * control that is refused because the read served nothing is a different
     * failure from one that is refused because the gate is shut, and a test
     * that starts by clicking cannot tell them apart.
     */
    await page.goto(`${handle.gatesOpenBaseUrl}${CANONICAL_SHARES}`, {
      waitUntil: "domcontentloaded",
    });
    const payload = await page.evaluate(async (url: string) => {
      const result = await fetch(url, { credentials: "include" });
      return { status: result.status, body: await result.text() };
    }, `/api/meta/creatives?businessId=${BUSINESS}&providerAccountId=${encodeURIComponent(ACCOUNT)}&groupBy=creative&format=all&sort=spend&start=${WINDOW.start}&end=${WINDOW.end}`);

    expect(payload.status, payload.body.slice(0, 800)).toBe(200);
    const json = JSON.parse(payload.body) as { status?: string; rows?: unknown[] };
    expect(json.status ?? "ok", payload.body.slice(0, 800)).toBe("ok");
    expect((json.rows ?? []).length, payload.body.slice(0, 800)).toBeGreaterThanOrEqual(2);
  });

  test("a ticked selection becomes a stored snapshot", async ({ page }) => {
    await openCanonicalShares(page, handle.gatesOpenBaseUrl);

    const before = await shareRows();
    const create = page.locator('[data-ctl="live:CREATIVE-10 open-create"]');
    await expect(create, "the canonical ledger still refuses to mint").toBeEnabled();
    await create.click();

    // The selection is the half this screen never had.
    await expect(
      page.locator("[data-share-dialog-backdrop]"),
      "the mint control was enabled and the dialog did not open",
    ).toHaveCount(1, { timeout: 30_000 });

    /*
     * No `textContent()` in an assertion message.
     *
     * Playwright's message argument is evaluated eagerly, and `textContent()`
     * on a locator matching nothing AUTO-WAITS — so a diagnostic for the empty
     * case blocked the whole test until its budget ran out, and the failure
     * pointed at the assertion it was supposed to explain. Anything read for a
     * message has to be non-blocking; `count()` is.
     */
    const options = page.locator("[data-share-creative-option]");
    const empties = await page.locator('[data-share-selection="empty"]').count();
    await expect(
      options.first(),
      empties > 0
        ? "the dialog opened saying there is nothing to share"
        : "the dialog opened with no selectable creatives and no note either",
    ).toBeVisible({ timeout: 30_000 });
    expect(
      await options.count(),
      "the ledger offered no creatives to share",
    ).toBeGreaterThanOrEqual(2);
    await options.nth(0).locator("input").check();
    await options.nth(1).locator("input").check();

    await page.locator("input[data-share-title]").fill("Canonical console snapshot");
    const expiry = new Date();
    expiry.setUTCDate(expiry.getUTCDate() + 14);
    await page.locator("input[data-share-expires]").fill(expiry.toISOString().slice(0, 10));

    /*
     * Enabled before clicked. A disabled control swallows the click and the
     * response wait then times out with nothing to read — a two-minute failure
     * that names the wrong thing. The refusal sentence is what says why.
     */
    const submit = page.locator("[data-share-create]");
    const submitState = await submit.evaluate((node) => ({
      ctl: node.getAttribute("data-ctl"),
      disabled: node.getAttribute("aria-disabled"),
      reason: node.getAttribute("title") ?? node.getAttribute("aria-describedby"),
      text: (node.parentElement?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    }));
    expect(submitState.ctl, JSON.stringify(submitState)).toBe("live:CREATIVE-10 mint");

    /*
     * Click, then read the database. Waiting on the POST and reading its body
     * races the client's own read of the same stream — see the note test — and
     * the claim here is about a stored snapshot rather than about a status
     * code, so the row is the better witness. The dialog closing is the
     * client's own signal that the POST succeeded.
     */
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await submit.click();

    /*
     * Whichever comes first, then say which. Waiting only for the dialog to
     * close turns any refusal into a bare timeout, and the refusal sentence is
     * the whole diagnosis — the server's 503 for a shut gate, its 400 for a
     * payload it will not take, or nothing at all if the click never fired.
     */
    const outcome = await Promise.race([
      page
        .locator("[data-share-dialog-backdrop]")
        .waitFor({ state: "detached", timeout: 45_000 })
        .then(() => "closed" as const),
      page
        .locator("[data-share-error]")
        .waitFor({ state: "visible", timeout: 45_000 })
        .then(() => "refused" as const),
    ]).catch(() => "neither" as const);
    // `count()` first: `textContent()` auto-waits, and a message that blocks is
    // a message that replaces the failure it was written to explain.
    const refusal =
      (await page.locator("[data-share-error]").count()) > 0
        ? await page.locator("[data-share-error]").first().textContent()
        : null;
    expect(
      outcome,
      `mint said "${refusal ?? "(nothing)"}"; console: ${consoleErrors.join(" | ") || "(silent)"}`,
    ).toBe("closed");

    const after = await shareRows();
    expect(after.length, "no snapshot row was written").toBe(before.length + 1);
    const stored = after.find(
      (row) => !before.some((earlier) => earlier.token === row.token),
    );
    expect(stored, "the POST answered 200 and stored nothing").toBeDefined();
    canonicalToken = stored!.token;

    // The selection, and the audience the server actually accepts.
    expect(stored!.payload.creatives).toHaveLength(2);
    expect(stored!.payload.audience).toBe("creative_team");
    expect(stored!.revoked_at).toBeNull();
  });

  test("the minted link opens for a visitor with no session", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      await page.goto(`${handle.gatesOpenBaseUrl}/share/creative/${canonicalToken}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator('[data-public-share="ready"]')).toHaveCount(1);
      await expect(page.locator("[data-share-creative]")).toHaveCount(2);
    } finally {
      await context.close();
    }
  });

  test("a creative-team share withholds what the buyer tier carries", async ({ browser }) => {
    /**
     * The tier is the point of the audience, so it is checked on the page a
     * recipient actually opens rather than on the payload.
     *
     * `resolveCreativeStudioSharePolicy` gives the creator tier no CSV and no
     * buyer decision language; `toPublicShare` then refuses a CSV for any
     * audience but `buyer`. Both halves are asserted, because either one alone
     * would let the other rot.
     */
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      await page.goto(`${handle.gatesOpenBaseUrl}/share/creative/${canonicalToken}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator('[data-share-audience="creative_team"]')).toHaveCount(1);
      await expect(
        page.locator("[data-public-share-csv]"),
        "a creative-team share offered a CSV export",
      ).toHaveCount(0);
      await expect(
        page.locator("[data-share-financial-warning]"),
        "a creative-team share carried the buyer financial warning",
      ).toHaveCount(0);
      // And never the workspace's own identity.
      expect(await page.content()).not.toContain(BUSINESS);
    } finally {
      await context.close();
    }
  });

  test("and the canonical ledger can withdraw what it minted", async ({ page }) => {
    await openCanonicalShares(page, handle.gatesOpenBaseUrl);
    const revoke = page.locator(`[data-share-revoke="${canonicalToken}"]`);
    await expect(revoke).toHaveCount(1);
    await expect(revoke).toBeEnabled();
    await revoke.click();

    // The row, polled rather than raced: the ledger refetches after the DELETE
    // and the claim is about storage, not about a response object.
    await expect
      .poll(
        async () =>
          (await shareRows()).find((row) => row.token === canonicalToken)?.revoked_at ?? null,
        { timeout: 30_000, message: "revoke left the row live" },
      )
      .not.toBeNull();
  });

  test("at the shipped gate setting the mint is refused, and withdrawal is not", async ({
    page,
  }) => {
    /**
     * The other half of the gate, on the server that ships it shut. The mint
     * control carries the server's own sentence; every revoke control that
     * exists stays enabled, because withdrawing a link that already exists must
     * never wait on a rollout flag.
     */
    await page.goto(`${handle.baseUrl}${CANONICAL_SHARES}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load");

    const create = page.locator('[data-ctl="live:CREATIVE-10 open-create"]');
    await expect(create).toHaveCount(1, { timeout: 60_000 });
    await expect(create).toBeDisabled();

    const revoke = page.locator('[data-ctl="live:CREATIVE-10 revoke"]');
    for (let index = 0; index < (await revoke.count()); index += 1) {
      await expect(revoke.nth(index), `revoke ${index} is disabled`).toBeEnabled();
    }
  });
});
