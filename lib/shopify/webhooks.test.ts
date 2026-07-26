import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/shopify/admin", () => ({
  shopifyAdminGraphql: vi.fn(),
}));

const admin = await import("@/lib/shopify/admin");
const {
  SHOPIFY_SYNC_WEBHOOK_TOPICS,
  buildShopifyWebhookCallbackUrl,
  classifyShopifySyncWebhookTopic,
  resolveShopifySyncWebhookRepairPolicy,
  registerShopifySyncWebhooks,
  verifyShopifySyncWebhooks,
} = await import("@/lib/shopify/webhooks");
type ShopifySyncWebhookTopic = (typeof SHOPIFY_SYNC_WEBHOOK_TOPICS)[number];

const CALLBACK_URL = "https://app.example.com/api/webhooks/shopify/sync";
const SHOP = "test-shop.myshopify.com";
/**
 * Never asserted against a real credential, and asserted to be ABSENT from every
 * receipt these functions return.
 */
const ACCESS_TOKEN = "shpat_unit_fixture_not_a_real_token";

interface GraphqlCall {
  shopId: string;
  accessToken: string;
  query: string;
  variables?: Record<string, unknown>;
}

/**
 * The grant as a mutable state the fake transport can move.
 *
 * `assertStillAuthorized` is what the real callers build out of
 * `assertShopifyGrantUnchanged`: it resolves while the stored grant is the one
 * the call was built from, and THROWS otherwise — including when the authority
 * read itself could not be answered, which must stop the sequence rather than
 * pass as "unchanged".
 */
type GrantState = "current" | "reconnected" | "revoked" | "unreadable";

const RECONNECTED_MESSAGE =
  "The Shopify connection moved from generation 4:connected to 5:connected while this install was finalizing.";
const REVOKED_MESSAGE =
  "The Shopify connection is no longer connected for this business.";
const UNREADABLE_MESSAGE =
  "shopify_authority_unknown: Connection terminated unexpectedly";

function grant(initial: GrantState = "current") {
  let state: GrantState = initial;
  const observed: GrantState[] = [];
  return {
    move(next: GrantState) {
      state = next;
    },
    /** One entry per time a provider request asked permission to be sent. */
    observed,
    assertStillAuthorized: async () => {
      observed.push(state);
      if (state === "reconnected") throw new Error(RECONNECTED_MESSAGE);
      if (state === "revoked") throw new Error(REVOKED_MESSAGE);
      if (state === "unreadable") throw new Error(UNREADABLE_MESSAGE);
    },
  };
}

function isListCall(call: GraphqlCall) {
  return call.query.includes("webhookSubscriptions(first:");
}

function isCreateCall(call: GraphqlCall) {
  return call.query.includes("webhookSubscriptionCreate");
}

/**
 * A recording transport with an explicit barrier.
 *
 * `onResolve` runs at the instant a call produces its value, so "resolving call
 * N moves the grant" is a synchronous consequence of that call completing —
 * no timers, no sleeps, no ordering left to the event loop.
 */
function transport(options: {
  existingTopics?: readonly string[];
  onResolve?: (call: GraphqlCall, index: number) => void;
}) {
  const calls: GraphqlCall[] = [];
  vi.mocked(admin.shopifyAdminGraphql).mockImplementation((async (call: GraphqlCall) => {
    const index = calls.length;
    calls.push(call);
    const payload = isListCall(call)
      ? {
          webhookSubscriptions: {
            nodes: (options.existingTopics ?? []).map((topic) => ({
              topic,
              endpoint: {
                __typename: "WebhookHttpEndpoint",
                callbackUrl: CALLBACK_URL,
              },
            })),
          },
        }
      : { webhookSubscriptionCreate: { userErrors: [] } };
    options.onResolve?.(call, index);
    return payload;
  }) as never);
  return calls;
}

function createdTopics(calls: GraphqlCall[]) {
  return calls.filter(isCreateCall).map((call) => call.variables?.topic);
}

describe("shopify webhook foundation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  });

  it("builds a canonical callback url", () => {
    expect(buildShopifyWebhookCallbackUrl("/api/webhooks/shopify/sync")).toBe(CALLBACK_URL);
  });

  it("registers only missing sync webhook topics", async () => {
    const authority = grant();
    const calls = transport({ existingTopics: ["ORDERS_CREATE"] });

    const result = await registerShopifySyncWebhooks({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    expect(result.status).toBe("registered");
    if (result.status !== "registered") throw new Error("unreachable");
    expect(result.callbackUrl).toBe(CALLBACK_URL);
    expect(result.existingTopics).toEqual(["ORDERS_CREATE"]);
    expect(result.desiredTopics).toEqual([...SHOPIFY_SYNC_WEBHOOK_TOPICS]);
    expect(result.created).toEqual(
      SHOPIFY_SYNC_WEBHOOK_TOPICS.filter((topic) => topic !== "ORDERS_CREATE"),
    );
    expect(result.notCreated).toEqual([]);
    expect(calls).toHaveLength(SHOPIFY_SYNC_WEBHOOK_TOPICS.length);
  });

  it("asks permission immediately before every request, not once for the sequence", async () => {
    const authority = grant();
    const calls = transport({ existingTopics: ["ORDERS_CREATE", "ORDERS_UPDATED"] });

    await registerShopifySyncWebhooks({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    // One list plus one create per missing topic, and one guard per request.
    expect(calls).toHaveLength(SHOPIFY_SYNC_WEBHOOK_TOPICS.length - 1);
    expect(authority.observed).toHaveLength(calls.length);
  });

  it("classifies supported topics into explicit repair policy", () => {
    const orderPolicy = classifyShopifySyncWebhookTopic("ORDERS_UPDATED");
    const refundPolicy = classifyShopifySyncWebhookTopic("REFUNDS_CREATE");
    const ignoredPolicy = classifyShopifySyncWebhookTopic("PRODUCTS_UPDATE");

    expect(orderPolicy).toEqual(
      expect.objectContaining({
        supported: true,
        entity: "orders",
        action: "update",
        recentTargets: { orders: true, returns: false },
        allowHistorical: false,
        triggerReason: "webhook:orders:update",
      })
    );
    expect(refundPolicy).toEqual(
      expect.objectContaining({
        supported: true,
        entity: "refunds",
        action: "create",
        recentTargets: { orders: true, returns: true },
      })
    );
    expect(classifyShopifySyncWebhookTopic("RETURNS_UPDATE")).toEqual(
      expect.objectContaining({
        supported: true,
        entity: "returns",
        shouldTriggerSync: true,
        recentTargets: { orders: true, returns: true },
      })
    );
    expect(ignoredPolicy).toEqual(
      expect.objectContaining({
        supported: false,
        shouldTriggerSync: false,
        recentTargets: { orders: false, returns: false },
      })
    );
  });

  it("expands the repair window for stale webhook payloads", () => {
    const policy = resolveShopifySyncWebhookRepairPolicy({
      topic: "ORDERS_UPDATED",
      payload: {
        id: "order_1",
        updated_at: "2026-03-20T10:00:00Z",
      },
      receivedAt: new Date("2026-04-02T10:00:00Z"),
    });

    expect(policy.eventTimestamp).toBe("2026-03-20T10:00:00.000Z");
    expect(policy.eventAgeDays).toBe(13);
    expect(policy.recentWindowDays).toBe(14);
    expect(policy.windowExpanded).toBe(true);
  });

  it("verifies missing webhook topics without creating duplicates", async () => {
    const authority = grant();
    transport({ existingTopics: ["ORDERS_CREATE"] });

    const result = await verifyShopifySyncWebhooks({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("unreachable");
    expect(result.missingTopics).toContain("RETURNS_UPDATE");
    expect(result.extraTopics).toEqual([]);
  });
});

describe("shopify webhook registration under a grant that moves mid-sequence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  });

  it("sends nothing at all when the grant moved before the list call", async () => {
    const authority = grant("reconnected");
    const calls = transport({});

    const result = await registerShopifySyncWebhooks({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    expect(calls).toEqual([]);
    expect(admin.shopifyAdminGraphql).toHaveBeenCalledTimes(0);
    expect(result.status).toBe("stopped");
    if (result.status !== "stopped") throw new Error("unreachable");
    expect(result.stoppedBefore).toBe("list_webhook_subscriptions");
    expect(result.reason).toBe(RECONNECTED_MESSAGE);
    expect(result.created).toEqual([]);
    expect(result.notCreated).toEqual([...SHOPIFY_SYNC_WEBHOOK_TOPICS]);
    expect(result.verification).toBeNull();
  });

  it("creates nothing when resolving the list call is what moved the grant", async () => {
    const authority = grant();
    // The barrier: the list call's own resolution flips the grant, so the guard
    // throws from that moment on. Nothing is timed.
    const calls = transport({
      onResolve: (_call, index) => {
        if (index === 0) authority.move("reconnected");
      },
    });

    const result = await registerShopifySyncWebhooks({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    // Asserted on the recorded call log by exact count AND by argument: exactly
    // one request left the process, and it was the read.
    expect(calls).toHaveLength(1);
    expect(isListCall(calls[0]!)).toBe(true);
    expect(calls.filter(isCreateCall)).toEqual([]);
    expect(createdTopics(calls)).toEqual([]);

    expect(result.status).toBe("stopped");
    if (result.status !== "stopped") throw new Error("unreachable");
    expect(result.stoppedBefore).toBe("create_webhook_subscription:ORDERS_CREATE");
    expect(result.reason).toBe(RECONNECTED_MESSAGE);
    expect(result.created).toEqual([]);
    expect(result.notCreated).toEqual([...SHOPIFY_SYNC_WEBHOOK_TOPICS]);
    expect(result.verification?.missingTopics).toEqual([...SHOPIFY_SYNC_WEBHOOK_TOPICS]);
  });

  it("stops the remaining creates when resolving the first create moved the grant", async () => {
    const alreadyThere = SHOPIFY_SYNC_WEBHOOK_TOPICS.slice(3);
    const missing = SHOPIFY_SYNC_WEBHOOK_TOPICS.slice(0, 3) as unknown as ShopifySyncWebhookTopic[];
    const authority = grant();
    const calls = transport({
      existingTopics: alreadyThere,
      // Resolving the FIRST create is the barrier.
      onResolve: (_call, index) => {
        if (index === 1) authority.move("reconnected");
      },
    });

    const result = await registerShopifySyncWebhooks({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    // The list plus exactly one create. Creates 2 and 3 are ABSENT from the log.
    expect(calls).toHaveLength(2);
    expect(isListCall(calls[0]!)).toBe(true);
    expect(createdTopics(calls)).toEqual([missing[0]]);
    expect(createdTopics(calls)).not.toContain(missing[1]);
    expect(createdTopics(calls)).not.toContain(missing[2]);

    expect(result.status).toBe("stopped");
    if (result.status !== "stopped") throw new Error("unreachable");
    // The receipt names what did and did not happen.
    expect(result.stoppedBefore).toBe(`create_webhook_subscription:${missing[1]}`);
    expect(result.created).toEqual([missing[0]]);
    expect(result.notCreated).toEqual([missing[1], missing[2]]);
    expect(result.verification?.missingTopics).toEqual(missing);
    expect(result.reason).toBe(RECONNECTED_MESSAGE);
  });

  it("stops the remaining creates when the connection was REVOKED mid-sequence", async () => {
    const alreadyThere = SHOPIFY_SYNC_WEBHOOK_TOPICS.slice(2);
    const missing = SHOPIFY_SYNC_WEBHOOK_TOPICS.slice(0, 2) as unknown as ShopifySyncWebhookTopic[];
    const authority = grant();
    const calls = transport({
      existingTopics: alreadyThere,
      onResolve: (_call, index) => {
        if (index === 1) authority.move("revoked");
      },
    });

    const result = await registerShopifySyncWebhooks({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    expect(calls).toHaveLength(2);
    expect(createdTopics(calls)).toEqual([missing[0]]);
    expect(result.status).toBe("stopped");
    if (result.status !== "stopped") throw new Error("unreachable");
    expect(result.reason).toBe(REVOKED_MESSAGE);
    expect(result.stoppedBefore).toBe(`create_webhook_subscription:${missing[1]}`);
    expect(result.created).toEqual([missing[0]]);
    expect(result.notCreated).toEqual([missing[1]]);
  });

  it("stops rather than continuing when the authority read itself FAILS mid-sequence", async () => {
    const alreadyThere = SHOPIFY_SYNC_WEBHOOK_TOPICS.slice(2);
    const missing = SHOPIFY_SYNC_WEBHOOK_TOPICS.slice(0, 2) as unknown as ShopifySyncWebhookTopic[];
    const authority = grant();
    const calls = transport({
      existingTopics: alreadyThere,
      onResolve: (_call, index) => {
        // Not a moved grant — a grant nobody can currently read. "I could not
        // tell" must never be read as "unchanged".
        if (index === 1) authority.move("unreadable");
      },
    });

    const result = await registerShopifySyncWebhooks({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    expect(calls).toHaveLength(2);
    expect(createdTopics(calls)).toEqual([missing[0]]);
    expect(createdTopics(calls)).not.toContain(missing[1]);
    expect(result.status).toBe("stopped");
    if (result.status !== "stopped") throw new Error("unreachable");
    expect(result.reason).toBe(UNREADABLE_MESSAGE);
    expect(result.notCreated).toEqual([missing[1]]);
  });

  it("refuses the list call itself when the grant is already gone", async () => {
    const authority = grant("revoked");
    const calls = transport({});

    const result = await verifyShopifySyncWebhooks({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    expect(calls).toEqual([]);
    expect(result.status).toBe("stopped");
    if (result.status !== "stopped") throw new Error("unreachable");
    expect(result.stoppedBefore).toBe("list_webhook_subscriptions");
    expect(result.reason).toBe(REVOKED_MESSAGE);
    expect(result.notCreated).toEqual([...SHOPIFY_SYNC_WEBHOOK_TOPICS]);
  });

  it("reports a Shopify user error as a failure, not as a stop", async () => {
    const authority = grant();
    vi.mocked(admin.shopifyAdminGraphql).mockImplementation((async (call: GraphqlCall) => {
      if (isListCall(call)) return { webhookSubscriptions: { nodes: [] } };
      return {
        webhookSubscriptionCreate: { userErrors: [{ message: "Topic is invalid" }] },
      };
    }) as never);

    await expect(
      registerShopifySyncWebhooks({
        shopId: SHOP,
        accessToken: ACCESS_TOKEN,
        assertStillAuthorized: authority.assertStillAuthorized,
      }),
    ).rejects.toThrow("Topic is invalid");
  });

  it("refuses to send anything when a caller slipped past the required field", async () => {
    // TypeScript compares method-shorthand parameters bivariantly, so an adapter
    // interface declaring only { shopId, accessToken } can still be satisfied by
    // these functions. That path must send nothing and say why.
    const calls = transport({});
    const withoutGuard = { shopId: SHOP, accessToken: ACCESS_TOKEN } as never;

    await expect(registerShopifySyncWebhooks(withoutGuard)).rejects.toThrow(
      /registerShopifySyncWebhooks was called without assertStillAuthorized/,
    );
    await expect(verifyShopifySyncWebhooks(withoutGuard)).rejects.toThrow(
      /verifyShopifySyncWebhooks was called without assertStillAuthorized/,
    );
    expect(calls).toEqual([]);
  });

  it("never puts the access token into a receipt", async () => {
    const authority = grant();
    transport({
      onResolve: (_call, index) => {
        if (index === 0) authority.move("reconnected");
      },
    });

    const stopped = await registerShopifySyncWebhooks({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    expect(JSON.stringify(stopped)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(stopped)).not.toContain("shpat_");
  });
});
