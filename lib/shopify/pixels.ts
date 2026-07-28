import { shopifyAdminGraphql } from "@/lib/shopify/admin";
import {
  assertGrantGuardPresent,
  buildShopifyWebhookCallbackUrl,
  type ShopifyGrantGuardedInput,
} from "@/lib/shopify/webhooks";

const WEB_PIXEL_CREATE_MUTATION = `
  mutation ShopifyWebPixelCreate($settings: JSON!) {
    webPixelCreate(webPixel: { settings: $settings }) {
      userErrors {
        field
        message
      }
      webPixel {
        id
      }
    }
  }
`;

export function buildShopifyCustomerEventsIngestUrl() {
  return buildShopifyWebhookCallbackUrl("/api/webhooks/shopify/customer-events");
}

/**
 * The one external mutation this module performs, named so a stopped receipt
 * says which pixel was and was not created rather than only that something was
 * refused.
 */
export const SHOPIFY_CUSTOMER_EVENTS_PIXEL_STEP = "customer_events_web_pixel";

export type ShopifyCustomerEventsPixelStep =
  typeof SHOPIFY_CUSTOMER_EVENTS_PIXEL_STEP;

/**
 * Created and not-created are reported explicitly, and `pixelId` exists only on
 * the `registered` arm.
 *
 * `webPixelCreate` is a create, not an upsert, and the caller records a durable
 * marker from this result that suppresses every later registration for the shop.
 * A stop that read as success would therefore write a marker for a pixel that
 * does not exist, and the shop's customer events would never be ingested at all.
 */
export type ShopifyCustomerEventsPixelResult =
  | {
      status: "registered";
      endpoint: string;
      pixelId: string | null;
      created: ShopifyCustomerEventsPixelStep[];
      notCreated: ShopifyCustomerEventsPixelStep[];
    }
  | {
      status: "stopped";
      stoppedBefore: "create_customer_events_web_pixel";
      reason: string;
      endpoint: string;
      created: ShopifyCustomerEventsPixelStep[];
      notCreated: ShopifyCustomerEventsPixelStep[];
    };

/**
 * Create the customer-events web pixel, under a grant re-checked immediately
 * before the request leaves the process.
 *
 * The guard is required rather than optional for the reason spelled out on
 * `ShopifyGrantGuardedInput`: a finalize holds a plaintext access token across
 * the whole of its webhook registration before it reaches this call, and a
 * reconnect landing in that window would otherwise put a pixel — pointed at THIS
 * deployment's ingest endpoint, carrying this deployment's shared secret — onto a
 * store the business no longer holds.
 */
export async function registerShopifyCustomerEventsPixel(
  input: ShopifyGrantGuardedInput,
): Promise<ShopifyCustomerEventsPixelResult> {
  assertGrantGuardPresent(input, "registerShopifyCustomerEventsPixel");
  const endpoint = buildShopifyCustomerEventsIngestUrl();

  // Immediately before the only request this function sends. A refusal is
  // returned as a value, never thrown, so it cannot be mistaken for a Shopify
  // error — and an authority read that failed arrives here as a throw from the
  // guard, which stops the call rather than passing as "unchanged".
  let refusal: string | null = null;
  try {
    await input.assertStillAuthorized();
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    refusal = detail.trim().length > 0 ? detail : "The Shopify grant is no longer current.";
  }
  if (refusal) {
    return {
      status: "stopped",
      stoppedBefore: "create_customer_events_web_pixel",
      reason: refusal,
      endpoint,
      created: [],
      notCreated: [SHOPIFY_CUSTOMER_EVENTS_PIXEL_STEP],
    };
  }

  // Refuse rather than create a pixel that can never work.
  //
  // webPixelCreate is a create, not an upsert, and the caller marks the shop
  // already_registered afterwards — so a pixel written with a null token is
  // never re-created. Since the ingest route now fails closed on an unset
  // secret, such a pixel would 403 forever, and no amount of later configuration
  // would repair it. Stopping here keeps the shop re-registerable once the
  // secret is set.
  const customerEventsSecret = process.env.SHOPIFY_CUSTOMER_EVENTS_SECRET?.trim();
  if (!customerEventsSecret) {
    return {
      status: "stopped",
      stoppedBefore: "create_customer_events_web_pixel",
      reason:
        "SHOPIFY_CUSTOMER_EVENTS_SECRET is not configured, so the pixel would carry no token and its events would be refused. Set it and re-register.",
      endpoint,
      created: [],
      notCreated: [SHOPIFY_CUSTOMER_EVENTS_PIXEL_STEP],
    };
  }

  const settings = JSON.stringify({
    endpoint,
    authToken: customerEventsSecret,
  });
  const payload = await shopifyAdminGraphql<{
    webPixelCreate?: {
      userErrors?: Array<{ message?: string | null } | null> | null;
      webPixel?: { id?: string | null } | null;
    } | null;
  }>({
    shopId: input.shopId,
    accessToken: input.accessToken,
    query: WEB_PIXEL_CREATE_MUTATION,
    variables: {
      settings,
    },
  });
  const error = payload.webPixelCreate?.userErrors?.find((row) => row?.message)?.message;
  if (error) throw new Error(error);
  return {
    status: "registered",
    endpoint,
    pixelId: payload.webPixelCreate?.webPixel?.id ?? null,
    created: [SHOPIFY_CUSTOMER_EVENTS_PIXEL_STEP],
    notCreated: [],
  };
}
