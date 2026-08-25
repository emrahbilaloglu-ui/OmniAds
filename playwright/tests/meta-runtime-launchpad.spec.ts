/**
 * WP14, on the running server: everything before a provider write.
 *
 * Launchpad's whole posture is that preparation is not execution. Drafts,
 * templates, intents and validation are fully available; the create calls are
 * held behind `META_LAUNCHPAD_EXECUTION`, and `meta-runtime-write-gates.spec.ts`
 * proves the hold. What that file cannot show is that the available half is
 * genuinely available — a Launchpad where nothing can be drafted is not
 * "execution disabled", it is a screen that does nothing, and the two look
 * identical from outside.
 *
 * So this walks the full lifecycle against the real database: create, edit,
 * list, validate, delete, each with a read-back from the table rather than from
 * the response. And after every step it checks the two tables a provider write
 * would leave a mark in, because the claim being made is not merely "it worked"
 * but "it worked and Meta was never contacted".
 */
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

import { openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();

const BUSINESS = handle.businesses.oneAccount;
const ACCOUNT = handle.accounts.one;

interface ApiResult {
  status: number;
  body: string;
  json: Record<string, unknown> | null;
}

async function api(
  page: Page,
  method: "GET" | "POST" | "DELETE",
  path: string,
  payload?: unknown,
): Promise<ApiResult> {
  if (!page.url().startsWith(handle.baseUrl)) {
    await openSurface(page, handle, `/c/${BUSINESS}/meta/launchpad`);
  }
  return page.evaluate(
    async ({
      url,
      verb,
      body,
    }: {
      url: string;
      verb: string;
      body: unknown;
    }) => {
      const response = await fetch(url, {
        method: verb,
        credentials: "include",
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      const text = await response.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      return { status: response.status, body: text.slice(0, 900), json: parsed };
    },
    { url: path, verb: method, body: payload },
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

/**
 * The two tables a provider write leaves a mark in.
 *
 * A launch records an intent before it calls Meta and an action-log row for
 * what came back, so "nothing was sent" is checkable from here rather than by
 * trusting that no `fetch` happened inside the server process. Measured as a
 * DIFFERENCE: the fixture seeds journal rows, and an absolute "the table is
 * empty" assertion would be measuring the seed.
 */
async function providerWriteMarks(): Promise<{ intents: number; actions: number }> {
  return withDb(async (client) => {
    const intents = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM meta_launch_intents WHERE business_id = $1",
      [BUSINESS],
    );
    const actions = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM meta_ads_action_log WHERE business_id = $1",
      [BUSINESS],
    );
    return {
      intents: Number(intents.rows[0]!.count),
      actions: Number(actions.rows[0]!.count),
    };
  });
}

async function readDraft(id: string): Promise<{ name: string; payload: unknown } | null> {
  return withDb(async (client) => {
    const rows = await client.query<{ name: string; payload: unknown }>(
      "SELECT name, payload_json AS payload FROM meta_launch_drafts WHERE id = $1",
      [id],
    );
    const row = rows.rows[0];
    return row ? { name: row.name, payload: row.payload } : null;
  });
}

/**
 * A minimal but real create payload: one campaign, one ad set, one ad.
 *
 * The variable part is the CAMPAIGN NAME, not the ad copy. The store normalises
 * a payload into its canonical `LaunchPayload` shape on the way in — creatives
 * arrive through their own path and an ad's primary text does not survive that
 * — so a marker placed there would vanish and the edit would look like it had
 * not been stored.
 */
function draftPayload(marker: string) {
  return {
    campaign: {
      name: `Runtime evidence campaign (${marker})`,
      objective: "OUTCOME_SALES",
      status: "PAUSED",
    },
    adSets: [
      {
        name: "Runtime evidence ad set",
        dailyBudgetMinor: 100000,
        optimizationGoal: "OFFSITE_CONVERSIONS",
        status: "PAUSED",
      },
    ],
    ads: [{ name: "Runtime evidence ad", primaryText: marker, status: "PAUSED" }],
  };
}

test.describe("a draft's whole life, with Meta never contacted", () => {
  test("creates, edits, lists, validates and deletes", async ({ page }) => {
    const before = await providerWriteMarks();

    // ---- create --------------------------------------------------------
    const created = await api(page, "POST", "/api/launchpad/meta/drafts", {
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      name: "Runtime evidence draft",
      payload: draftPayload("first"),
    });
    expect(created.status, created.body).toBe(200);
    const draftId = (created.json?.draft as { id?: string } | undefined)?.id;
    expect(draftId, "the create returned no draft id").toBeTruthy();

    // Read back from the table, not from the response: a route that answered
    // with the object it built in memory would pass a response-only check.
    expect(await readDraft(draftId!)).toMatchObject({ name: "Runtime evidence draft" });

    // ---- edit ----------------------------------------------------------
    const edited = await api(page, "POST", "/api/launchpad/meta/drafts", {
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      id: draftId,
      name: "Runtime evidence draft (edited)",
      payload: draftPayload("second"),
    });
    expect(edited.status, edited.body).toBe(200);
    expect((edited.json?.draft as { id?: string } | undefined)?.id, "the edit forked a new row")
      .toBe(draftId);

    const afterEdit = await readDraft(draftId!);
    expect(afterEdit?.name).toBe("Runtime evidence draft (edited)");
    // The stored payload really changed, not just the row's name.
    expect(JSON.stringify(afterEdit?.payload)).toContain("(second)");
    expect(JSON.stringify(afterEdit?.payload)).not.toContain("(first)");

    // ---- list ----------------------------------------------------------
    const listed = await api(
      page,
      "GET",
      `/api/launchpad/meta/drafts?businessId=${BUSINESS}&providerAccountId=${ACCOUNT}`,
    );
    expect(listed.status, listed.body).toBe(200);
    const drafts = (listed.json?.drafts ?? []) as { id: string }[];
    expect(drafts.some((draft) => draft.id === draftId)).toBe(true);

    // ---- validate ------------------------------------------------------
    const validated = await api(page, "POST", "/api/launchpad/meta/validate", {
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      payload: draftPayload("second"),
    });
    /*
     * A verdict, whatever it says. Validation reports blockers — this fixture
     * has no pixel and no billing status, so blockers are the expected and
     * correct answer — and the claim under test is that the route ANSWERS
     * rather than that it approves. A validation that refused to run would be
     * the WP14 defect; a validation that found problems is validation working.
     */
    expect(validated.status, validated.body).toBe(200);
    expect(validated.json).toHaveProperty("ok");
    expect(Array.isArray((validated.json as { blockers?: unknown }).blockers)).toBe(true);

    // ---- delete --------------------------------------------------------
    const deleted = await api(
      page,
      "DELETE",
      `/api/launchpad/meta/drafts/${draftId}?businessId=${BUSINESS}&providerAccountId=${ACCOUNT}`,
    );
    expect(deleted.status, deleted.body).toBe(200);
    expect(await readDraft(draftId!), "the draft survived its own deletion").toBeNull();

    // ---- and Meta was never contacted ---------------------------------
    expect(await providerWriteMarks(), "preparation reached the provider").toEqual(before);
  });

  test("refuses a draft for an account this business is not assigned", async ({ page }) => {
    // Scope is not a formality here: a draft is stored against an account and
    // is later launched into it, so an unassigned account accepted at draft
    // time is an unassigned account launched into later.
    const result = await api(page, "POST", "/api/launchpad/meta/drafts", {
      businessId: BUSINESS,
      providerAccountId: handle.accounts.manyA,
      name: "Foreign account draft",
      payload: draftPayload("nope"),
    });

    expect([400, 403, 404]).toContain(result.status);
    expect(result.body).not.toContain('"ok":true');
  });

  test("refuses a nameless draft rather than storing an unfindable one", async ({
    page,
  }) => {
    const result = await api(page, "POST", "/api/launchpad/meta/drafts", {
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      name: "   ",
      payload: draftPayload("nameless"),
    });

    expect(result.status).toBe(400);
    expect(result.body).toContain("draft_name_required");
  });
});

test.describe("the screen states the posture it is actually in", () => {
  test("Launchpad offers preparation and holds execution, with a reason", async ({
    page,
  }) => {
    await openSurface(page, handle, `/c/${BUSINESS}/meta/launchpad`);
    const text = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");

    // The two halves of the posture, both stated: what is available now, and
    // what is not and why. A Launchpad that stated neither would look broken;
    // one that stated only the refusal would look like it does nothing.
    expect(text).toMatch(/PAUSED/);
    expect(text).toMatch(/Activation is a separate/i);
    expect(text).not.toMatch(/META_[A-Z_]+/);

    // And its §9 region agrees that the surface itself is readable.
    const state = page.locator("[data-meta-surface-state]").first();
    await expect(state).toHaveCount(1);
    expect(await state.getAttribute("data-read-state")).not.toBe("degraded");
  });
});
