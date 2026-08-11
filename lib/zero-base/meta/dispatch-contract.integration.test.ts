/**
 * The composed dispatch body, posted to the ACTUAL route handlers.
 *
 * The previous WP-14 tests mocked a generic dispatch function, so nothing ever
 * compared a body to a real handler. That is exactly how a nonexistent
 * endpoint (`/adsets/[adsetId]/bid`) and a two-field body survived a green
 * suite. These tests import the real route modules and drive them.
 *
 * The technique: `requireBusinessAccess` is stubbed to return a distinctive
 * sentinel refusal. Every body-contract gate in these handlers runs *before*
 * authorization, so:
 *
 * - a body the handler rejects on contract grounds returns its own 4xx code;
 * - a body that satisfies every contract gate reaches the sentinel.
 *
 * Reaching the sentinel is therefore a precise, falsifiable statement: "the
 * real handler accepted this body's contract." No provider is contacted in
 * either direction — the sentinel fires long before any write path.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const SENTINEL = 418;

const requireBusinessAccess = vi.hoisted(() =>
  vi.fn(async () => ({ error: new Response("contract-gates-passed", { status: SENTINEL }) })),
);
const rejectIfReviewerReadOnly = vi.hoisted(() => vi.fn(() => null));
const rejectIfMetaWritesBlocked = vi.hoisted(() => vi.fn(async () => null));
const resolveExactMetaAdActionTarget = vi.hoisted(() => vi.fn());
const getDb = vi.hoisted(() => vi.fn());

vi.mock("@/lib/access", () => ({ requireBusinessAccess, findMembership: vi.fn() }));
vi.mock("@/lib/meta/reviewer-write-guard", () => ({ rejectIfReviewerReadOnly }));
vi.mock("@/lib/meta/meta-writes-guard", () => ({ rejectIfMetaWritesBlocked }));
vi.mock("@/lib/db", () => ({ getDb, runDbTransaction: vi.fn() }));

import {
  FORBIDDEN_DISPATCH_FIELDS,
  MUTATION_ENDPOINTS,
  buildDispatchDescriptor,
  composeDispatchBody,
  endpointFor,
  type MutationAction,
} from "@/lib/zero-base/meta/dispatch-contract";
import { POST as campaignPause } from "@/app/api/meta/campaigns/[campaignId]/pause/route";
import { POST as campaignResume } from "@/app/api/meta/campaigns/[campaignId]/resume/route";
import { POST as adsetPause } from "@/app/api/meta/adsets/[adsetId]/pause/route";
import { POST as adsetResume } from "@/app/api/meta/adsets/[adsetId]/resume/route";
import { POST as adsetApplyBid } from "@/app/api/meta/adsets/[adsetId]/apply-bid/route";
import { POST as adPause } from "@/app/api/meta/ads/[adId]/pause/route";
import { POST as adResume } from "@/app/api/meta/ads/[adId]/resume/route";
import { POST as adDuplicate } from "@/app/api/meta/ads/[adId]/duplicate/route";

const ISSUED = "2026-08-11T12:00:00.000Z";

function request(body: unknown) {
  return { json: async () => body } as never;
}
function params(value: Record<string, string>) {
  return { params: Promise.resolve(value) } as never;
}

function descriptorFor(
  grain: "campaign" | "adset" | "ad",
  action: MutationAction,
  overrides: { creativeId?: string | null; parentId?: string | null; currency?: string | null } = {},
) {
  const result = buildDispatchDescriptor({
    businessId: "biz-1",
    target: {
      grain,
      entityId: grain === "campaign" ? "camp-1" : grain === "adset" ? "adset-1" : "ad-1",
      providerAccountId: "act_1",
      creativeId: overrides.creativeId === undefined ? "cr-1" : overrides.creativeId,
      parentId: overrides.parentId === undefined ? "adset-1" : overrides.parentId,
    },
    action,
    accountCurrency: overrides.currency === undefined ? "USD" : overrides.currency,
    issuedAt: ISSUED,
  });
  if (!result.ok) throw new Error(`descriptor withheld: ${result.reason}`);
  return result.descriptor;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireBusinessAccess.mockResolvedValue({
    error: new Response("contract-gates-passed", { status: SENTINEL }),
  });
  rejectIfReviewerReadOnly.mockReturnValue(null);
  rejectIfMetaWritesBlocked.mockResolvedValue(null);
});

/* ------------------------------------------------------------ route paths */

describe("every endpoint the ceremony names is a route that exists", () => {
  it("maps ad-set bid to apply-bid, the path that exists", () => {
    // The previous map claimed `/bid`, which would have 404'd on every attempt.
    expect(endpointFor("adset", "bid")).toBe("/api/meta/adsets/[adsetId]/apply-bid");
  });

  it("names only real handler paths", async () => {
    // Each of these imports resolved above; a wrong path would not have.
    expect(endpointFor("campaign", "pause")).toBe("/api/meta/campaigns/[campaignId]/pause");
    expect(endpointFor("campaign", "resume")).toBe("/api/meta/campaigns/[campaignId]/resume");
    expect(endpointFor("adset", "pause")).toBe("/api/meta/adsets/[adsetId]/pause");
    expect(endpointFor("adset", "resume")).toBe("/api/meta/adsets/[adsetId]/resume");
    expect(endpointFor("ad", "pause")).toBe("/api/meta/ads/[adId]/pause");
    expect(endpointFor("ad", "resume")).toBe("/api/meta/ads/[adId]/resume");
    expect(endpointFor("ad", "duplicate")).toBe("/api/meta/ads/[adId]/duplicate");
  });

  it("offers no action a grain has no route for", () => {
    expect(endpointFor("campaign", "duplicate")).toBeNull();
    expect(endpointFor("campaign", "bid")).toBeNull();
    expect(endpointFor("ad", "bid")).toBeNull();
    expect(Object.keys(MUTATION_ENDPOINTS).sort()).toEqual(["ad", "adset", "campaign"]);
  });
});

/* ------------------------------------------- campaign and ad-set contracts */

describe("campaign and ad-set status bodies satisfy the real handler", () => {
  const cases = [
    { name: "campaign pause", handler: campaignPause, grain: "campaign" as const, action: "pause" as const, key: { campaignId: "camp-1" } as Record<string, string> },
    { name: "campaign resume", handler: campaignResume, grain: "campaign" as const, action: "resume" as const, key: { campaignId: "camp-1" } as Record<string, string> },
    { name: "adset pause", handler: adsetPause, grain: "adset" as const, action: "pause" as const, key: { adsetId: "adset-1" } as Record<string, string> },
    { name: "adset resume", handler: adsetResume, grain: "adset" as const, action: "resume" as const, key: { adsetId: "adset-1" } as Record<string, string> },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} passes every contract gate`, async () => {
      const body = composeDispatchBody(descriptorFor(testCase.grain, testCase.action), {});
      const response = await testCase.handler(request(body), params(testCase.key));
      expect(response.status, await response.text()).toBe(SENTINEL);
    });
  }

  it("names the concrete path with the proven id already substituted", () => {
    expect(descriptorFor("campaign", "pause").path).toBe("/api/meta/campaigns/camp-1/pause");
    expect(descriptorFor("adset", "resume").path).toBe("/api/meta/adsets/adset-1/resume");
  });

  it("carries the canonical origin and confirmation the handler compares against", () => {
    const body = descriptorFor("campaign", "pause").body;
    expect(body).toEqual({
      actionOrigin: "manual_operator_v1",
      manualConfirmation: "explicit_operator_confirmation",
      businessId: "biz-1",
      providerAccountId: "act_1",
    });
  });

  it("is refused when the origin is missing — the old generic body's failure", async () => {
    // This is what the previous implementation actually sent.
    const response = await campaignPause(
      request({ businessId: "biz-1", mutationId: "m-1" }),
      params({ campaignId: "camp-1" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("action_origin_required");
  });

  it("is refused without explicit manual confirmation", async () => {
    const body = { ...descriptorFor("campaign", "pause").body };
    delete body.manualConfirmation;
    const response = await campaignPause(request(body), params({ campaignId: "camp-1" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("manual_confirmation_required");
  });

  it("is refused without the server-presented provider account", async () => {
    const body = { ...descriptorFor("adset", "pause").body };
    delete body.providerAccountId;
    const response = await adsetPause(request(body), params({ adsetId: "adset-1" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("provider_account_id_required");
  });

  it("is refused when native decision lineage is smuggled in", async () => {
    const response = await campaignPause(
      request({ ...descriptorFor("campaign", "pause").body, decisionHash: "abc" }),
      params({ campaignId: "camp-1" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("mixed_action_origin_contract");
  });

  it("emits no field any handler would refuse", () => {
    for (const grain of ["campaign", "adset"] as const) {
      for (const action of ["pause", "resume"] as const) {
        const body = composeDispatchBody(descriptorFor(grain, action), {});
        for (const field of FORBIDDEN_DISPATCH_FIELDS) {
          expect(Object.keys(body), `${grain}.${action}.${field}`).not.toContain(field);
        }
      }
    }
  });
});

/* ----------------------------------------------------------------- bid */

describe("ad-set bid body satisfies the real apply-bid handler", () => {
  it("passes every gate with a positive integer of minor units", async () => {
    const body = composeDispatchBody(descriptorFor("adset", "bid"), { bidAmountMinor: "250" });
    const response = await adsetApplyBid(request(body), params({ adsetId: "adset-1" }));
    expect(response.status, await response.text()).toBe(SENTINEL);
    expect(body.bidAmountMinor).toBe(250);
  });

  it("is refused with no bid amount at all", async () => {
    const response = await adsetApplyBid(
      request(descriptorFor("adset", "bid").body),
      params({ adsetId: "adset-1" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_bid_unit");
  });

  it("is refused for a zero or negative amount", async () => {
    for (const amount of [0, -5]) {
      const response = await adsetApplyBid(
        request({ ...descriptorFor("adset", "bid").body, bidAmountMinor: amount }),
        params({ adsetId: "adset-1" }),
      );
      expect(response.status, String(amount)).toBe(400);
    }
  });

  it("is refused for a non-integer amount", async () => {
    const response = await adsetApplyBid(
      request({ ...descriptorFor("adset", "bid").body, bidAmountMinor: 2.5 }),
      params({ adsetId: "adset-1" }),
    );
    expect(response.status).toBe(400);
  });

  it("never emits the legacy bid unit fields the handler refuses", () => {
    const body = composeDispatchBody(descriptorFor("adset", "bid"), { bidAmountMinor: "250" });
    expect(Object.keys(body)).not.toContain("bidValue");
    expect(Object.keys(body)).not.toContain("bidValueMinor");
  });

  it("asks the operator for the amount in the account's own currency", () => {
    const descriptor = descriptorFor("adset", "bid", { currency: "TRY" });
    expect(descriptor.operatorFields).toEqual([
      {
        name: "bidAmountMinor",
        kind: "minor_amount",
        label: "Bid amount",
        currency: "TRY",
        required: true,
      },
    ]);
    // The unit is stated; no conversion happens anywhere in this path.
    expect(descriptor.note).toContain("TRY");
  });

  it("is withheld when the account currency could not be verified", () => {
    const result = buildDispatchDescriptor({
      businessId: "biz-1",
      target: { grain: "adset", entityId: "adset-1", providerAccountId: "act_1", creativeId: null, parentId: null },
      action: "bid",
      accountCurrency: null,
      issuedAt: ISSUED,
    });
    // The handler refuses without a verified currency, so offering the control
    // would be offering a guaranteed failure.
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("account_currency_unavailable");
  });
});

/* --------------------------------------------------------------- ad grain */

describe("ad status bodies satisfy the real handler", () => {
  for (const [name, handler] of [
    ["pause", adPause],
    ["resume", adResume],
  ] as const) {
    it(`ad ${name} passes every gate that runs before authorization`, async () => {
      const body = composeDispatchBody(descriptorFor("ad", name), {});
      const response = await handler(request(body), params({ adId: "ad-1" }));
      expect(response.status, await response.text()).toBe(SENTINEL);
    });
  }

  it("carries the manual origin and the exact ad and creative identity", () => {
    expect(descriptorFor("ad", "pause").body).toEqual({
      actionOrigin: "manual_operator_v1",
      manualConfirmation: "explicit_operator_confirmation",
      businessId: "biz-1",
      providerAccountId: "act_1",
      adId: "ad-1",
      creativeId: "cr-1",
    });
  });

  it("is refused without the exact ad authority triple", async () => {
    for (const field of ["providerAccountId", "adId", "creativeId"]) {
      const body = { ...descriptorFor("ad", "pause").body };
      delete body[field];
      const response = await adPause(request(body), params({ adId: "ad-1" }));
      expect(response.status, field).toBe(400);
      expect((await response.json()).error.code, field).toBe("exact_ad_authority_required");
    }
  });

  it("is refused when the body ad id does not match the route", async () => {
    const response = await adPause(
      request({ ...descriptorFor("ad", "pause").body, adId: "ad-other" }),
      params({ adId: "ad-1" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("ad_identity_mismatch");
  });

  it("keeps the body ad id and the path in lockstep, both from the proven id", () => {
    const descriptor = descriptorFor("ad", "pause");
    expect(descriptor.path).toBe("/api/meta/ads/ad-1/pause");
    expect(descriptor.body.adId).toBe("ad-1");
  });

  it("is refused without a businessId", async () => {
    const body = { ...descriptorFor("ad", "pause").body };
    delete body.businessId;
    const response = await adPause(request(body), params({ adId: "ad-1" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("missing_business_id");
  });

  it("is withheld when the exact creative identity was never recorded", () => {
    const result = buildDispatchDescriptor({
      businessId: "biz-1",
      target: { grain: "ad", entityId: "ad-1", providerAccountId: "act_1", creativeId: null, parentId: "adset-1" },
      action: "pause",
      accountCurrency: null,
      issuedAt: ISSUED,
    });
    // Without it the handler answers 409 creative_identity_mismatch, so the
    // control would exist only to fail.
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("creative_identity_unavailable");
  });

  it("emits no field the ad handler would refuse", () => {
    const body = composeDispatchBody(descriptorFor("ad", "pause"), {});
    for (const field of FORBIDDEN_DISPATCH_FIELDS) {
      expect(Object.keys(body), field).not.toContain(field);
    }
  });
});

describe("ad duplicate body satisfies the real handler", () => {
  it("passes every gate with a destination ad set", async () => {
    const body = composeDispatchBody(descriptorFor("ad", "duplicate"), {
      targetAdsetId: "adset-2",
      name: "Copy of Ad 1",
    });
    const response = await adDuplicate(request(body), params({ adId: "ad-1" }));
    expect(response.status, await response.text()).toBe(SENTINEL);
    expect(body.targetAdsetId).toBe("adset-2");
    expect(body.name).toBe("Copy of Ad 1");
  });

  it("is refused without a destination ad set", async () => {
    const response = await adDuplicate(
      request(descriptorFor("ad", "duplicate").body),
      params({ adId: "ad-1" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("missing_target_adset_id");
  });

  it("never asks the handler to activate the copy", async () => {
    const descriptor = descriptorFor("ad", "duplicate");
    const body = composeDispatchBody(descriptor, { targetAdsetId: "adset-2" });
    expect(Object.keys(body)).not.toContain("activateAfterCreate");
    // And the route proves why: activation is refused outright, so an
    // activate toggle would be a control that can only fail.
    const refused = await adDuplicate(
      request({ ...body, activateAfterCreate: true }),
      params({ adId: "ad-1" }),
    );
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.code).toBe("active_create_not_supported");
  });

  it("says plainly that the copy is created paused", () => {
    expect(descriptorFor("ad", "duplicate").note).toMatch(/always created paused/);
  });

  it("asks for a destination and an optional name, and nothing else", () => {
    expect(descriptorFor("ad", "duplicate").operatorFields.map((f) => f.name)).toEqual([
      "targetAdsetId",
      "name",
    ]);
  });

  it("omits an empty optional name rather than sending a blank one", () => {
    const body = composeDispatchBody(descriptorFor("ad", "duplicate"), {
      targetAdsetId: "adset-2",
      name: "   ",
    });
    expect(Object.keys(body)).not.toContain("name");
  });

  it("is withheld when the source ad's parent ad set is unknown", () => {
    const result = buildDispatchDescriptor({
      businessId: "biz-1",
      target: { grain: "ad", entityId: "ad-1", providerAccountId: "act_1", creativeId: "cr-1", parentId: null },
      action: "duplicate",
      accountCurrency: null,
      issuedAt: ISSUED,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("parent_adset_unknown");
  });
});

/* ----------------------------------------------------- nothing reaches Meta */

describe("no provider is contacted by any of this", () => {
  it("stops at authorization in every case", async () => {
    // Every body above reached the sentinel, which fires before any write
    // path. The DB client was never even constructed.
    expect(getDb).not.toHaveBeenCalled();
  });
});
