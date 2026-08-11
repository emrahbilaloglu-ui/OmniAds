/**
 * WP-23 Shopify entry, bound to the real start handler's behavior.
 *
 * A prior test asserted only that a pathname existed. That proved nothing: the
 * handler redirects any request without a `shop` to `/shopify/connect` and
 * drops `businessId` and `returnTo` on the way, because installation is owned
 * by the Shopify App Store or store admin. These tests invoke the handler.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SHOPIFY_SETUP_PATH,
  OAUTH_START_PROVIDERS,
  shopifyEntry,
} from "@/lib/zero-base/manage/manage-contract";

const BIZ = "55555555-5555-4555-8555-555555555555";

vi.mock("@/lib/auth", () => ({
  getSessionFromRequest: async () => ({ userId: "u1", activeBusinessId: BIZ }),
}));

const ENV = { ...process.env };

beforeEach(() => {
  process.env.SHOPIFY_CLIENT_ID = "test-client-id";
  process.env.SHOPIFY_CLIENT_SECRET = "test-client-secret";
  process.env.SHOPIFY_SCOPES = "read_orders";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
});

afterEach(() => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

async function callStart(query: string) {
  const { GET } = await import("@/app/api/oauth/shopify/start/route");
  const request = new NextRequest(`https://app.test/api/oauth/shopify/start${query}`);
  return GET(request);
}

describe("the real Shopify start handler", () => {
  it("REGRESSION: a request with no shop is not an OAuth start at all", async () => {
    const response = await callStart(
      `?businessId=${BIZ}&returnTo=${encodeURIComponent("/c/x/manage/integrations")}`,
    );
    const location = new URL(response.headers.get("location")!);
    // It goes to the setup surface, not to Shopify.
    expect(location.pathname).toBe(SHOPIFY_SETUP_PATH);
    expect(location.hostname).not.toContain("myshopify.com");
    // And the context we supplied is gone, so nothing can return here.
    expect(location.searchParams.get("businessId")).toBeNull();
    expect(location.searchParams.get("returnTo")).toBeNull();
  });

  it("a request WITH a shop does begin a real authorization round trip", async () => {
    const response = await callStart(
      `?shop=grandmix.myshopify.com&businessId=${BIZ}&returnTo=${encodeURIComponent("/c/x/manage/integrations")}`,
    );
    const location = new URL(response.headers.get("location")!);
    expect(location.hostname).toBe("grandmix.myshopify.com");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    // State carries the context, so the callback can return the operator.
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(response.cookies.get("shopify_oauth_state")?.value).toBeTruthy();
  });

  it("REGRESSION: Shopify is not listed as a generic completable OAuth start", () => {
    expect(Object.keys(OAUTH_START_PROVIDERS)).not.toContain("shopify");
  });
});

describe("shopifyEntry models those two outcomes", () => {
  it("offers external installation when no shop domain is known", () => {
    const entry = shopifyEntry({ businessId: BIZ, shopDomain: null });
    expect(entry.kind).toBe("external_install");
    expect(entry.href).toBe(SHOPIFY_SETUP_PATH);
    expect(entry.kind === "external_install" && entry.note).toMatch(/starts in Shopify/i);
  });

  it("offers direct reauthorization only for an authoritative myshopify domain", () => {
    const entry = shopifyEntry({ businessId: BIZ, shopDomain: "Grandmix.MyShopify.com" });
    expect(entry.kind).toBe("reauthorize");
    const url = new URL(entry.href, "https://app.test");
    expect(url.pathname).toBe("/api/oauth/shopify/start");
    // Lower-cased, exactly as normalizeShopifyShopDomain would.
    expect(url.searchParams.get("shop")).toBe("grandmix.myshopify.com");
    expect(url.searchParams.get("businessId")).toBe(BIZ);
  });

  it("refuses any domain the real normalizer would reject", () => {
    for (const domain of [
      "grandmix.example.com",
      "https://grandmix.myshopify.com",
      "-bad.myshopify.com",
      "myshopify.com",
      "  ",
    ]) {
      expect(shopifyEntry({ businessId: BIZ, shopDomain: domain }).kind, domain).toBe(
        "external_install",
      );
    }
  });
});

describe("the Shopify round trip is gated on collaborator at its own handlers", () => {
  const ROOT = process.cwd();

  it("REGRESSION: callback and finalize both require collaborator", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    for (const file of [
      "app/api/oauth/shopify/callback/route.ts",
      "app/api/oauth/shopify/finalize/route.ts",
    ]) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      // A guest who completes the external install is refused at the end of it,
      // which is why the UI must refuse before anything leaves the product.
      expect(text, file).toContain('minRole: "collaborator"');
    }
  });

  it("the handlers exist and expose the verbs the flow depends on", async () => {
    const callback = await import("@/app/api/oauth/shopify/callback/route");
    const finalize = await import("@/app/api/oauth/shopify/finalize/route");
    expect(typeof callback.GET).toBe("function");
    // finalize is a POST; there is no GET on it.
    expect(typeof finalize.POST).toBe("function");
  });
});
