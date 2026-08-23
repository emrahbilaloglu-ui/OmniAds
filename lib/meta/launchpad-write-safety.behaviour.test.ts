import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The pre-POST authority snapshot is mocked open, and only that.
 *
 * `getMetaAdsWriteBlockFailure` reads the kill switch, the connection
 * generation and the account selection atomically at the literal pre-POST
 * boundary — a database read these cases have no database for. Its own
 * behaviour is covered by `lib/meta/ads-write.test.ts`; leaving it live here
 * would make every case below fail on `meta_account_authority_unknown` and
 * prove nothing about the read-back.
 *
 * Mocked open rather than removed: the guard still runs, it is simply answered.
 * `rejectIfLaunchpadMetaWritesBlocked` at the route covers the closed answer.
 */
vi.mock("@/lib/meta/ads-write", async () => {
  const actual = await vi.importActual<typeof import("@/lib/meta/ads-write")>(
    "@/lib/meta/ads-write",
  );
  return { ...actual, getMetaAdsWriteBlockFailure: vi.fn(async () => null) };
});

import type { MetaAdsWriteContext } from "@/lib/meta/ads-write";

const { createCampaign, preflightMetaLaunchCreatives } = await import(
  "@/lib/meta/launch-write"
);

/**
 * Behavioural evidence for the Launchpad write-safety declarations.
 *
 * `lib/meta/write-safety-contract.ts` is a declaration, and the master plan is
 * explicit that a passing test for a declaration is not proof the declared
 * production behavior exists. These cases exercise the real modules against a
 * stubbed Meta and assert the behavior itself, so the declaration has evidence
 * behind it rather than an author's reading.
 *
 * They also caught the inverse error: the previous audit declared SIX of these
 * steps missing because it read the route and never opened this module.
 */
const CTX: MetaAdsWriteContext = {
  businessId: "biz_1",
  providerAccountId: "act_100",
  accessToken: "tok",
  connectionGeneration: "gen:connected",
} as unknown as MetaAdsWriteContext;

const CAMPAIGN_INPUT = {
  name: "August prospecting",
  objective: "OUTCOME_SALES",
  status: "PAUSED",
  specialAdCategories: [],
} as never;

interface Call {
  url: string;
  method: string;
}

/**
 * A Meta stub that records every request, so a test can assert the *shape* of
 * the exchange — one POST, then a separate GET — rather than only its result.
 */
function stubMeta(handler: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? "GET" };
      calls.push(call);
      const { status = 200, body } = handler(call);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("step 15/16 — the read-back is independent, and it verifies exactly", () => {
  it("issues a separate GET after the create and does not trust the POST response", async () => {
    const calls = stubMeta((call) =>
      call.method === "POST"
        ? { body: { id: "23842" } }
        : {
            body: {
              id: "23842",
              account_id: "act_100",
              status: "PAUSED",
              objective: "OUTCOME_SALES",
            },
          },
    );

    const result = await createCampaign(CTX, CAMPAIGN_INPUT);

    expect(result.ok).toBe(true);
    // One POST, then a distinct GET. §10.1: "A provider 200 response is not a
    // read-back."
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    expect(calls[1]!.url).toContain("23842");
    // The GET asks for the exact fields the verification compares.
    expect(calls[1]!.url).toContain("account_id");
    expect(calls[1]!.url).toContain("status");
  });

  it("fails closed when the read-back returns a different id", async () => {
    stubMeta((call) =>
      call.method === "POST"
        ? { body: { id: "23842" } }
        : {
            body: {
              id: "99999",
              account_id: "act_100",
              status: "PAUSED",
              objective: "OUTCOME_SALES",
            },
          },
    );
    const result = await createCampaign(CTX, CAMPAIGN_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("silent_failure");
  });

  it("fails closed when the read-back names a different account", async () => {
    // The case that matters most: a create that landed somewhere else must
    // never be reported as success.
    stubMeta((call) =>
      call.method === "POST"
        ? { body: { id: "23842" } }
        : {
            body: {
              id: "23842",
              account_id: "act_999",
              status: "PAUSED",
              objective: "OUTCOME_SALES",
            },
          },
    );
    const result = await createCampaign(CTX, CAMPAIGN_INPUT);
    expect(result.ok).toBe(false);
  });

  it("fails closed when the read-back does not show PAUSED", async () => {
    // ADR-003 rule 4: a Launchpad create may only produce PAUSED entities. A
    // campaign that came back ACTIVE is spending money nobody authorised.
    stubMeta((call) =>
      call.method === "POST"
        ? { body: { id: "23842" } }
        : {
            body: {
              id: "23842",
              account_id: "act_100",
              status: "ACTIVE",
              objective: "OUTCOME_SALES",
            },
          },
    );
    const result = await createCampaign(CTX, CAMPAIGN_INPUT);
    expect(result.ok).toBe(false);
  });

  it("fails closed when the create returns no id at all", async () => {
    stubMeta(() => ({ body: { success: true } }));
    const result = await createCampaign(CTX, CAMPAIGN_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("silent_failure");
  });

  it("keeps the created id on an unverifiable outcome instead of discarding it", async () => {
    /**
     * The ambiguity that must not become a definite failure. Meta created
     * something; the verification could not confirm it. Throwing the id away
     * would leave an orphan nobody can find.
     */
    stubMeta((call) =>
      call.method === "POST" ? { body: { id: "23842" } } : { status: 500, body: {} },
    );
    const result = await createCampaign(CTX, CAMPAIGN_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.resultingAdId).toBe("23842");
  });
});

describe("step 13 — at most one provider POST, never retried", () => {
  it("does not retry a failed create", async () => {
    const calls = stubMeta((call) =>
      call.method === "POST"
        ? { status: 500, body: { error: { message: "boom" } } }
        : { body: {} },
    );
    const result = await createCampaign(CTX, CAMPAIGN_INPUT);
    expect(result.ok).toBe(false);
    // §10.1: "A provider create or duplicate POST is never retried
    // automatically." Exactly one POST, and no verification GET after a create
    // that did not happen.
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("does not retry a create that times out at the transport", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "POST") {
          posts += 1;
          throw new Error("ETIMEDOUT");
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const result = await createCampaign(CTX, CAMPAIGN_INPUT);
    expect(result.ok).toBe(false);
    expect(posts).toBe(1);
  });
});

describe("step 6 — a fresh provider read binds identity before any create", () => {
  it("reads every requested creative from Meta and binds id and account", async () => {
    const calls = stubMeta(() => ({
      body: { id: "cr_1", account_id: "act_100" },
    }));
    const result = await preflightMetaLaunchCreatives(CTX, ["cr_1"]);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("cr_1");
    // A timestamp the receipt can age. Not a boolean.
    expect(Date.parse(result.checkedAt)).toBeGreaterThan(0);
  });

  it("blocks when the creative belongs to a different account", async () => {
    // A creative from another account would be created into this one. The
    // preflight is what stops that, before any POST.
    stubMeta(() => ({ body: { id: "cr_1", account_id: "act_999" } }));
    const result = await preflightMetaLaunchCreatives(CTX, ["cr_1"]);
    expect(result.ok).toBe(false);
    expect(result.checks[0]!.ok).toBe(false);
  });

  it("blocks when Meta does not return the exact requested id", async () => {
    stubMeta(() => ({ body: { id: "cr_other", account_id: "act_100" } }));
    const result = await preflightMetaLaunchCreatives(CTX, ["cr_1"]);
    expect(result.ok).toBe(false);
    if (result.checks[0]!.error) {
      expect(result.checks[0]!.error.code).toBe("creative_id_mismatch");
    }
  });

  it("blocks when the creative cannot be read at all", async () => {
    // An unreadable creative is not a valid one. Proceeding would create an ad
    // from something we never proved exists.
    stubMeta(() => ({ status: 400, body: { error: { message: "not found" } } }));
    const result = await preflightMetaLaunchCreatives(CTX, ["cr_1"]);
    expect(result.ok).toBe(false);
  });
});
