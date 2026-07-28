import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/shopify/admin", () => ({
  shopifyAdminGraphql: vi.fn(),
}));

const admin = await import("@/lib/shopify/admin");
const {
  SHOPIFY_CUSTOMER_EVENTS_PIXEL_STEP,
  buildShopifyCustomerEventsIngestUrl,
  registerShopifyCustomerEventsPixel,
} = await import("@/lib/shopify/pixels");

const SHOP = "test-shop.myshopify.com";
/** A fixture shape, never a real credential — and asserted absent from receipts. */
const ACCESS_TOKEN = "shpat_unit_fixture_not_a_real_token";
const INGEST_URL = "https://app.example.com/api/webhooks/shopify/customer-events";

interface GraphqlCall {
  shopId: string;
  accessToken: string;
  query: string;
  variables?: Record<string, unknown>;
}

type GrantState = "current" | "reconnected" | "revoked" | "unreadable";

const RECONNECTED_MESSAGE =
  "The Shopify connection moved from generation 2:connected to 3:connected while this install was finalizing.";
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
    observed,
    assertStillAuthorized: async () => {
      observed.push(state);
      if (state === "reconnected") throw new Error(RECONNECTED_MESSAGE);
      if (state === "revoked") throw new Error(REVOKED_MESSAGE);
      if (state === "unreadable") throw new Error(UNREADABLE_MESSAGE);
    },
  };
}

/**
 * A recording transport with an explicit barrier: `onResolve` fires at the
 * instant a call yields its value, so "resolving call 1 moves the grant" is a
 * synchronous consequence of that call completing. No timers, no sleeps.
 */
function transport(options: {
  onResolve?: (call: GraphqlCall, index: number) => void;
  userErrors?: Array<{ message: string }>;
}) {
  const calls: GraphqlCall[] = [];
  vi.mocked(admin.shopifyAdminGraphql).mockImplementation((async (call: GraphqlCall) => {
    const index = calls.length;
    calls.push(call);
    const payload = {
      webPixelCreate: {
        userErrors: options.userErrors ?? [],
        webPixel: { id: `gid://shopify/WebPixel/${index + 1}` },
      },
    };
    options.onResolve?.(call, index);
    return payload;
  }) as never);
  return calls;
}

describe("shopify customer-events pixel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    // These tests used to DELETE the secret, which meant they asserted the
    // null-token path was acceptable. It is not: webPixelCreate is a create,
    // not an upsert, and the caller marks the shop already_registered — so a
    // pixel written with a null token is never re-created, and every event it
    // sends is now refused. The pixel creation refuses instead; see the
    // dedicated test below.
    process.env.SHOPIFY_CUSTOMER_EVENTS_SECRET = "sh_customer_events_fixture_secret";
  });

  it("builds the ingest url from the app url", () => {
    expect(buildShopifyCustomerEventsIngestUrl()).toBe(INGEST_URL);
  });

  it("creates the pixel and asks permission immediately before the request", async () => {
    const authority = grant();
    const calls = transport({});

    const result = await registerShopifyCustomerEventsPixel({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    expect(calls).toHaveLength(1);
    expect(authority.observed).toEqual(["current"]);
    expect(result.status).toBe("registered");
    if (result.status !== "registered") throw new Error("unreachable");
    expect(result.endpoint).toBe(INGEST_URL);
    expect(result.pixelId).toBe("gid://shopify/WebPixel/1");
    expect(result.created).toEqual([SHOPIFY_CUSTOMER_EVENTS_PIXEL_STEP]);
    expect(result.notCreated).toEqual([]);
  });

  it("sends nothing when the grant moved before the create", async () => {
    const authority = grant("reconnected");
    const calls = transport({});

    const result = await registerShopifyCustomerEventsPixel({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    expect(calls).toEqual([]);
    expect(admin.shopifyAdminGraphql).toHaveBeenCalledTimes(0);
    expect(result.status).toBe("stopped");
    if (result.status !== "stopped") throw new Error("unreachable");
    expect(result.stoppedBefore).toBe("create_customer_events_web_pixel");
    expect(result.reason).toBe(RECONNECTED_MESSAGE);
    expect(result.created).toEqual([]);
    expect(result.notCreated).toEqual([SHOPIFY_CUSTOMER_EVENTS_PIXEL_STEP]);
    // `pixelId` does not exist on the stopped arm: a caller cannot record a
    // marker for a pixel that was never created without narrowing first.
    expect("pixelId" in result).toBe(false);
  });

  it("stops the SECOND pixel request when resolving the first one moved the grant", async () => {
    const authority = grant();
    // The barrier. Resolving call 1 flips the authority, so the guard throws
    // from that moment on — exactly the shape of a reconnect landing between two
    // provider round trips of one install.
    const calls = transport({
      onResolve: (_call, index) => {
        if (index === 0) authority.move("reconnected");
      },
    });

    const first = await registerShopifyCustomerEventsPixel({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });
    const second = await registerShopifyCustomerEventsPixel({
      shopId: "reconnected-shop.myshopify.com",
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    // Exact count AND argument: one request left the process, for the original
    // shop. The second never reached the transport.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.shopId).toBe(SHOP);
    expect(calls.map((call) => call.shopId)).not.toContain("reconnected-shop.myshopify.com");

    expect(first.status).toBe("registered");
    expect(second.status).toBe("stopped");
    if (second.status !== "stopped") throw new Error("unreachable");
    expect(second.reason).toBe(RECONNECTED_MESSAGE);
    expect(second.created).toEqual([]);
    expect(second.notCreated).toEqual([SHOPIFY_CUSTOMER_EVENTS_PIXEL_STEP]);
  });

  it("sends nothing when the connection was REVOKED", async () => {
    const authority = grant("revoked");
    const calls = transport({});

    const result = await registerShopifyCustomerEventsPixel({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    expect(calls).toEqual([]);
    expect(result.status).toBe("stopped");
    if (result.status !== "stopped") throw new Error("unreachable");
    expect(result.reason).toBe(REVOKED_MESSAGE);
    expect(result.notCreated).toEqual([SHOPIFY_CUSTOMER_EVENTS_PIXEL_STEP]);
  });

  it("stops rather than proceeding when the authority read itself FAILS", async () => {
    const authority = grant("unreadable");
    const calls = transport({});

    const result = await registerShopifyCustomerEventsPixel({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    // An unanswerable authority read is not "unchanged".
    expect(calls).toEqual([]);
    expect(result.status).toBe("stopped");
    if (result.status !== "stopped") throw new Error("unreachable");
    expect(result.reason).toBe(UNREADABLE_MESSAGE);
    expect(result.created).toEqual([]);
  });

  it("reports a Shopify user error as a failure, not as a stop", async () => {
    const authority = grant();
    transport({ userErrors: [{ message: "Web pixel already exists" }] });

    await expect(
      registerShopifyCustomerEventsPixel({
        shopId: SHOP,
        accessToken: ACCESS_TOKEN,
        assertStillAuthorized: authority.assertStillAuthorized,
      }),
    ).rejects.toThrow("Web pixel already exists");
  });

  it("refuses to send anything when a caller slipped past the required field", async () => {
    const calls = transport({});

    await expect(
      registerShopifyCustomerEventsPixel({ shopId: SHOP, accessToken: ACCESS_TOKEN } as never),
    ).rejects.toThrow(
      /registerShopifyCustomerEventsPixel was called without assertStillAuthorized/,
    );
    expect(calls).toEqual([]);
  });

  it("refuses to create a pixel that could never authenticate", async () => {
    // The ingest route fails closed on an unset secret, and a pixel is created
    // once and never re-created — so writing one with a null token would leave
    // the shop permanently unable to send events, unrepairable by later
    // configuration. Stopping keeps the shop re-registerable.
    delete process.env.SHOPIFY_CUSTOMER_EVENTS_SECRET;
    const authority = grant();
    const result = await registerShopifyCustomerEventsPixel({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    expect(result.status).toBe("stopped");
    expect(result.created).toEqual([]);
    if (result.status !== "stopped") throw new Error("expected a stop");
    expect(result.reason).toMatch(/SHOPIFY_CUSTOMER_EVENTS_SECRET/);
  });

  it("never puts the access token or the ingest secret into a receipt", async () => {
    process.env.SHOPIFY_CUSTOMER_EVENTS_SECRET = "sh_customer_events_fixture_secret";
    const authority = grant();
    transport({});

    const registered = await registerShopifyCustomerEventsPixel({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });
    authority.move("revoked");
    const stopped = await registerShopifyCustomerEventsPixel({
      shopId: SHOP,
      accessToken: ACCESS_TOKEN,
      assertStillAuthorized: authority.assertStillAuthorized,
    });

    for (const receipt of [registered, stopped]) {
      expect(JSON.stringify(receipt)).not.toContain(ACCESS_TOKEN);
      expect(JSON.stringify(receipt)).not.toContain("shpat_");
      expect(JSON.stringify(receipt)).not.toContain("sh_customer_events_fixture_secret");
    }
  });
});
