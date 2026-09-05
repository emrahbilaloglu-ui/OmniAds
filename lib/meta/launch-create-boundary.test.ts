/**
 * R3, at the actual provider boundary rather than one frame above it.
 *
 * The follow-up review asked for the authority re-read to sit "at each actual
 * provider boundary, not just in a test wrapper or one outer callback". The
 * caller-side check answers before the adapter does any work, which is the
 * cheap refusal and the one that produces the richer receipt; this pins the
 * BINDING one — inside the create primitive, after every adapter-side check and
 * immediately before the single POST, where a lapse can still prevent the write
 * rather than describe it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const posted: string[] = [];

vi.mock("@/lib/meta/ads-write", async () => {
  const actual = await vi.importActual<typeof import("@/lib/meta/ads-write")>(
    "@/lib/meta/ads-write",
  );
  return { ...actual, getMetaAdsWriteBlockFailure: vi.fn(async () => null) };
});

import type { MetaAdsWriteContext } from "@/lib/meta/ads-write";
const { createCampaign } = await import("@/lib/meta/launch-write");

const CTX = {
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

beforeEach(() => {
  posted.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET").toUpperCase() === "POST") posted.push(url);
    return new Response(
      JSON.stringify({ id: "120200000000001", name: "August prospecting", status: "PAUSED", account_id: "act_100", objective: "OUTCOME_SALES" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});

describe("a create asks its authority immediately before the request", () => {
  it("makes no POST at all when the hook refuses", async () => {
    const result = await createCampaign(CTX, CAMPAIGN_INPUT, {
      beforeMutationAttempt: async () => {
        throw Object.assign(new Error("authority withdrawn"), {
          code: "provider_mutation_withheld",
        });
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("provider_mutation_withheld");
    // The exact fact a reconciliation needs: nothing was attempted, so there is
    // nothing whose outcome is unknown.
    expect(result.mutationAttempt ?? null).toBeNull();
    expect(posted).toEqual([]);
  });

  it("names an unnamed throw rather than reporting nothing", async () => {
    const result = await createCampaign(CTX, CAMPAIGN_INPUT, {
      beforeMutationAttempt: async () => { throw new Error("db down"); },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("before_mutation_attempt_failed");
    expect(posted).toEqual([]);
  });

  it("posts once when the hook allows it, and once when there is no hook", async () => {
    const allowed = await createCampaign(CTX, CAMPAIGN_INPUT, {
      beforeMutationAttempt: async () => undefined,
    });
    expect(allowed.ok).toBe(true);
    expect(posted).toHaveLength(1);

    posted.length = 0;
    const bare = await createCampaign(CTX, CAMPAIGN_INPUT);
    expect(bare.ok).toBe(true);
    // A caller with nothing to re-prove is unchanged: one POST, no hook.
    expect(posted).toHaveLength(1);
  });
});
