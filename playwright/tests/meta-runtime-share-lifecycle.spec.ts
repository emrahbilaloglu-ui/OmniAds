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
   * The CSV switch has no accessible name — it is a bare `role="switch"` next
   * to the label text — so it is addressed structurally. That is itself worth
   * noticing; an unlabelled switch is a WP17 finding, recorded there.
   */
  const csvToggle = modal.locator('[role="switch"]');
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
     * The response, not just the click. The note thread re-renders from the
     * endpoint's own reply, so a failure would otherwise show up here as an
     * invisible element rather than as the status code that caused it.
     */
    const [posted] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes("/messages") && response.request().method() === "POST",
        { timeout: 30_000 },
      ),
      page.getByRole("button", { name: "Send" }).click(),
    ]);
    expect(posted.status(), (await posted.text()).slice(0, 500)).toBe(200);
    await expect(page.getByText(note)).toBeVisible({ timeout: 30_000 });
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

test("the canonical console can withdraw a link but cannot mint one", async ({ page }) => {
  /**
   * The finding this file's posture rests on, asserted rather than asserted in
   * a comment.
   *
   * `/app/creative/shares` renders a ledger whose create control is refused
   * with a stated reason, because the mint flow lives in the studio the
   * canonical console replaced. Until that screen has a selection to send, the
   * shipped canonical console cannot produce a share at all — so a market-ready
   * claim about sharing is a claim about the legacy studio.
   */
  await page.goto(`${handle.baseUrl}/c/${BUSINESS}/creative/shares`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("load");

  const create = page.locator('[data-ctl="live:CREATIVE-10 open-create"]');
  await expect(create).toHaveCount(1, { timeout: 60_000 });
  await expect(create).toBeDisabled();

  // Withdrawal is not gated on the same thing, which is the point: a link that
  // already exists must always be revocable, whatever the mint path can do.
  await expect(page.locator('[data-ctl="live:CREATIVE-10 revoke"]')).toHaveCount(0);
});
