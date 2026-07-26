import crypto from "node:crypto";
import { shopifyAdminGraphql } from "@/lib/shopify/admin";

export const SHOPIFY_SYNC_WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "REFUNDS_CREATE",
  "RETURNS_REQUEST",
  "RETURNS_APPROVE",
  "RETURNS_UPDATE",
  "RETURNS_PROCESS",
  "RETURNS_CLOSE",
  "RETURNS_REOPEN",
  "RETURNS_CANCEL",
  "RETURNS_DECLINE",
] as const;

export type ShopifySyncWebhookTopic = (typeof SHOPIFY_SYNC_WEBHOOK_TOPICS)[number];

function envNumber(name: string, fallback: number) {
  const parsed = Number(process.env[name] ?? String(fallback));
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export interface ShopifySyncWebhookRepairPolicy {
  supported: boolean;
  entity: "orders" | "refunds" | "returns" | "unknown";
  action: "create" | "update" | "cancel" | "ignore";
  shouldTriggerSync: boolean;
  recentWindowDays: number;
  eventTimestamp: string | null;
  eventAgeDays: number | null;
  windowExpanded: boolean;
  recentTargets: {
    orders: boolean;
    returns: boolean;
  };
  allowHistorical: boolean;
  triggerReason: string | null;
}

function buildReturnPolicy(action: ShopifySyncWebhookRepairPolicy["action"]) {
  return {
    supported: true,
    entity: "returns" as const,
    action,
    shouldTriggerSync: true,
    recentWindowDays: envNumber("SHOPIFY_WEBHOOK_RETURN_SYNC_DAYS", 14),
    eventTimestamp: null,
    eventAgeDays: null,
    windowExpanded: false,
    recentTargets: { orders: true, returns: true },
    allowHistorical: false,
    triggerReason: `webhook:returns:${action}`,
  };
}

export function classifyShopifySyncWebhookTopic(
  topic: string | null | undefined
): ShopifySyncWebhookRepairPolicy {
  switch (topic) {
    case "ORDERS_CREATE":
      return {
        supported: true,
        entity: "orders" as const,
        action: "create" as const,
        shouldTriggerSync: true,
        recentWindowDays: envNumber("SHOPIFY_WEBHOOK_ORDER_SYNC_DAYS", 3),
        eventTimestamp: null,
        eventAgeDays: null,
        windowExpanded: false,
        recentTargets: { orders: true, returns: false },
        allowHistorical: false,
        triggerReason: "webhook:orders:create",
      };
    case "ORDERS_UPDATED":
      return {
        supported: true,
        entity: "orders" as const,
        action: "update" as const,
        shouldTriggerSync: true,
        recentWindowDays: envNumber("SHOPIFY_WEBHOOK_ORDER_SYNC_DAYS", 3),
        eventTimestamp: null,
        eventAgeDays: null,
        windowExpanded: false,
        recentTargets: { orders: true, returns: false },
        allowHistorical: false,
        triggerReason: "webhook:orders:update",
      };
    case "ORDERS_CANCELLED":
      return {
        supported: true,
        entity: "orders" as const,
        action: "cancel" as const,
        shouldTriggerSync: true,
        recentWindowDays: envNumber("SHOPIFY_WEBHOOK_ORDER_SYNC_DAYS", 3),
        eventTimestamp: null,
        eventAgeDays: null,
        windowExpanded: false,
        recentTargets: { orders: true, returns: false },
        allowHistorical: false,
        triggerReason: "webhook:orders:cancel",
      };
    case "REFUNDS_CREATE":
      return {
        supported: true,
        entity: "refunds" as const,
        action: "create" as const,
        shouldTriggerSync: true,
        recentWindowDays: envNumber("SHOPIFY_WEBHOOK_REFUND_SYNC_DAYS", 14),
        eventTimestamp: null,
        eventAgeDays: null,
        windowExpanded: false,
        recentTargets: { orders: true, returns: true },
        allowHistorical: false,
        triggerReason: "webhook:refunds:create",
      };
    case "RETURNS_REQUEST":
      return buildReturnPolicy("create");
    case "RETURNS_APPROVE":
    case "RETURNS_UPDATE":
    case "RETURNS_PROCESS":
    case "RETURNS_CLOSE":
    case "RETURNS_REOPEN":
    case "RETURNS_CANCEL":
    case "RETURNS_DECLINE":
      return buildReturnPolicy("update");
    default:
      return {
        supported: false,
        entity: "unknown" as const,
        action: "ignore" as const,
        shouldTriggerSync: false,
        recentWindowDays: 0,
        eventTimestamp: null,
        eventAgeDays: null,
        windowExpanded: false,
        recentTargets: { orders: false, returns: false },
        allowHistorical: false,
        triggerReason: null,
      };
  }
}

function parseWebhookTimestamp(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}

function resolveWebhookEventTimestamp(payload: unknown) {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (!record) return null;
  return (
    parseWebhookTimestamp(record.updated_at) ??
    parseWebhookTimestamp(record.processed_at) ??
    parseWebhookTimestamp(record.cancelled_at) ??
    parseWebhookTimestamp(record.created_at) ??
    parseWebhookTimestamp(record.closed_at) ??
    null
  );
}

function computeEventAgeDays(eventTimestamp: string, receivedAt: Date) {
  const ageMs = receivedAt.getTime() - new Date(eventTimestamp).getTime();
  if (!Number.isFinite(ageMs)) return null;
  if (ageMs <= 0) return 0;
  return Math.ceil(ageMs / 86_400_000);
}

export function resolveShopifySyncWebhookRepairPolicy(input: {
  topic: string | null | undefined;
  payload: unknown;
  receivedAt?: Date;
}) {
  const base = classifyShopifySyncWebhookTopic(input.topic);
  const receivedAt = input.receivedAt ?? new Date();
  const eventTimestamp = resolveWebhookEventTimestamp(input.payload);
  const eventAgeDays =
    eventTimestamp === null ? null : computeEventAgeDays(eventTimestamp, receivedAt);
  const maxWindowDays = envNumber("SHOPIFY_WEBHOOK_MAX_SYNC_DAYS", 30);
  const expandedRecentWindowDays =
    eventAgeDays === null ? base.recentWindowDays : Math.max(base.recentWindowDays, eventAgeDays + 1);

  return {
    ...base,
    eventTimestamp,
    eventAgeDays,
    recentWindowDays: Math.min(expandedRecentWindowDays, maxWindowDays),
    windowExpanded:
      eventAgeDays !== null &&
      Math.min(expandedRecentWindowDays, maxWindowDays) > base.recentWindowDays,
  } satisfies ShopifySyncWebhookRepairPolicy;
}

function getShopifyWebhookBaseUrl() {
  const base =
    process.env.SHOPIFY_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "http://localhost:3000";
  return base.replace(/\/$/, "");
}

export function buildShopifyWebhookCallbackUrl(pathname: string) {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${getShopifyWebhookBaseUrl()}${path}`;
}

export function buildShopifyWebhookPayloadHash(input: {
  topic: string;
  shopDomain: string;
  body: string;
}) {
  return crypto
    .createHash("sha1")
    .update(`${input.shopDomain}:${input.topic}:${input.body}`)
    .digest("hex");
}

interface ExistingWebhookPayload {
  webhookSubscriptions?: {
    nodes?: Array<{
      id?: string | null;
      topic?: string | null;
      endpoint?: {
        __typename?: string | null;
        callbackUrl?: string | null;
      } | null;
    }>;
  };
}

const LIST_WEBHOOKS_QUERY = `
  query ShopifyWebhookSubscriptions {
    webhookSubscriptions(first: 100) {
      nodes {
        id
        topic
        endpoint {
          __typename
          ... on WebhookHttpEndpoint {
            callbackUrl
          }
        }
      }
    }
  }
`;

const CREATE_WEBHOOK_MUTATION = `
  mutation ShopifyWebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: {
        callbackUrl: $callbackUrl
        format: JSON
      }
    ) {
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * The authority re-check every Shopify provider request must pass, and the
 * reason it is a REQUIRED field rather than an option.
 *
 * Registration is a verify-then-create sequence: one list, then one create per
 * missing topic — thirteen separate round trips at full drift. Callers used to
 * re-check the stored grant ONCE, immediately before this function was invoked,
 * which covers the instant before the first request and nothing after it. A
 * reconnect or a revoke landing between request 1 and request 2 left every
 * remaining create going out under a credential the business had already
 * replaced or withdrawn — subscribing the previous shop's order events, or
 * writing to a store the user had disconnected — and the function still returned
 * a receipt that read like complete success.
 *
 * So the guard is invoked immediately before EACH request, and it is mandatory
 * at the type level. An optional guard, or one with a default, is a guard the
 * next caller forgets: it would compile, run, and silently restore exactly the
 * window this exists to close. Omitting it must be a compile error.
 *
 * `assertStillAuthorized` THROWS when the grant has moved. A throw is also what
 * an authority read that could not be answered produces, and that is deliberate:
 * "I could not tell" must stop the sequence, never be read as "unchanged".
 */
export interface ShopifyGrantGuardedInput {
  shopId: string;
  accessToken: string;
  assertStillAuthorized: () => Promise<void>;
}

/** The state of the shop's subscriptions as one list call observed them. */
export interface ShopifySyncWebhookVerification {
  callbackUrl: string;
  existingTopics: string[];
  desiredTopics: ShopifySyncWebhookTopic[];
  missingTopics: ShopifySyncWebhookTopic[];
  extraTopics: string[];
}

/**
 * The request the sequence was about to send when the grant moved.
 *
 * Named per topic rather than as a bare index so a stopped receipt says which
 * subscription was never attempted without the reader having to re-derive it.
 */
export type ShopifySyncWebhookStopPoint =
  | "list_webhook_subscriptions"
  | `create_webhook_subscription:${ShopifySyncWebhookTopic}`;

/**
 * Complete and partial are different outcomes and are typed as different things.
 *
 * The verification fields live only on the `verified`/`registered` arms, so a
 * caller cannot reach `missingTopics` — or read `created` as "everything" —
 * without first narrowing on `status` and confronting the stop.
 */
export type ShopifySyncWebhookVerifyResult =
  | ({ status: "verified" } & ShopifySyncWebhookVerification)
  | {
      status: "stopped";
      stoppedBefore: "list_webhook_subscriptions";
      reason: string;
      callbackUrl: string;
      created: ShopifySyncWebhookTopic[];
      notCreated: ShopifySyncWebhookTopic[];
    };

export type ShopifySyncWebhookRegisterResult =
  | ({
      status: "registered";
      created: ShopifySyncWebhookTopic[];
      notCreated: ShopifySyncWebhookTopic[];
    } & ShopifySyncWebhookVerification)
  | {
      status: "stopped";
      stoppedBefore: ShopifySyncWebhookStopPoint;
      reason: string;
      callbackUrl: string;
      /** Subscriptions this sequence actually created before it stopped. */
      created: ShopifySyncWebhookTopic[];
      /** Subscriptions it had established were missing and never attempted. */
      notCreated: ShopifySyncWebhookTopic[];
      /** Null when the stop happened before the list call answered. */
      verification: ShopifySyncWebhookVerification | null;
    };

/**
 * The one hole the required field cannot close on its own.
 *
 * TypeScript compares METHOD-shorthand parameters bivariantly, so a caller that
 * routes these functions through its own adapter interface — `registerWebhooks(
 * input: { shopId, accessToken }): Promise<unknown>` in
 * `lib/shopify/install-context.ts` is exactly that shape — assigns cleanly even
 * though the adapter can never supply the guard. The call would then reach the
 * loop with `assertStillAuthorized` undefined.
 *
 * Fail closed and fail LEGIBLY. Without this the missing guard still stops the
 * sequence, because the resulting TypeError is caught as a refusal — but it would
 * be reported as "the grant moved", which is not what happened and would send
 * whoever reads the receipt looking for a reconnect that never occurred.
 */
export function assertGrantGuardPresent(
  input: { assertStillAuthorized?: unknown },
  callSite: string,
): void {
  if (typeof input.assertStillAuthorized !== "function") {
    throw new Error(
      `${callSite} was called without assertStillAuthorized. A Shopify request must never be sent without re-checking, immediately beforehand, the grant it was built from.`,
    );
  }
}

/**
 * Run the guard and report a refusal as a value.
 *
 * The refusal is deliberately NOT re-thrown: a throw here would be
 * indistinguishable from a Shopify error at the call site, and a caller cannot
 * tell "the provider rejected the mutation" from "we refused to send it" out of
 * a generic `Error`. Every provider call below is left outside this try, so a
 * genuine provider failure still fails as a failure.
 */
async function refusalFromGuard(
  assertStillAuthorized: () => Promise<void>,
): Promise<string | null> {
  try {
    await assertStillAuthorized();
    return null;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return detail.trim().length > 0 ? detail : "The Shopify grant is no longer current.";
  }
}

export async function registerShopifySyncWebhooks(
  input: ShopifyGrantGuardedInput,
): Promise<ShopifySyncWebhookRegisterResult> {
  assertGrantGuardPresent(input, "registerShopifySyncWebhooks");
  const verification = await verifyShopifySyncWebhooks(input);
  if (verification.status === "stopped") {
    return {
      status: "stopped",
      stoppedBefore: verification.stoppedBefore,
      reason: verification.reason,
      callbackUrl: verification.callbackUrl,
      created: [],
      notCreated: verification.notCreated,
      verification: null,
    };
  }

  const plan: ShopifySyncWebhookVerification = {
    callbackUrl: verification.callbackUrl,
    existingTopics: verification.existingTopics,
    desiredTopics: verification.desiredTopics,
    missingTopics: verification.missingTopics,
    extraTopics: verification.extraTopics,
  };
  const created: ShopifySyncWebhookTopic[] = [];

  for (let index = 0; index < plan.missingTopics.length; index += 1) {
    const topic = plan.missingTopics[index] as ShopifySyncWebhookTopic;
    // Immediately before THIS request, not once before the loop. The grant can
    // move between any two iterations.
    const refusal = await refusalFromGuard(input.assertStillAuthorized);
    if (refusal) {
      return {
        status: "stopped",
        stoppedBefore: `create_webhook_subscription:${topic}`,
        reason: refusal,
        callbackUrl: plan.callbackUrl,
        created,
        notCreated: plan.missingTopics.slice(index),
        verification: plan,
      };
    }

    const payload = await shopifyAdminGraphql<{
      webhookSubscriptionCreate?: {
        userErrors?: Array<{ message?: string | null } | null> | null;
      } | null;
    }>({
      shopId: input.shopId,
      accessToken: input.accessToken,
      query: CREATE_WEBHOOK_MUTATION,
      variables: {
        topic,
        callbackUrl: plan.callbackUrl,
      },
    });
    const error = payload.webhookSubscriptionCreate?.userErrors?.find((row) => row?.message)?.message;
    if (error) {
      throw new Error(error);
    }
    created.push(topic);
  }

  return {
    ...plan,
    status: "registered",
    created,
    notCreated: [],
  };
}

export async function verifyShopifySyncWebhooks(
  input: ShopifyGrantGuardedInput,
): Promise<ShopifySyncWebhookVerifyResult> {
  assertGrantGuardPresent(input, "verifyShopifySyncWebhooks");
  const callbackUrl = buildShopifyWebhookCallbackUrl("/api/webhooks/shopify/sync");
  const desiredTopics = [...SHOPIFY_SYNC_WEBHOOK_TOPICS];

  // The list is a read, but it is a read performed with the shop's access token
  // against a shop the business may no longer hold. A revoked or superseded
  // grant must not leave the process at all, so the guard runs before it too.
  const refusal = await refusalFromGuard(input.assertStillAuthorized);
  if (refusal) {
    return {
      status: "stopped",
      stoppedBefore: "list_webhook_subscriptions",
      reason: refusal,
      callbackUrl,
      created: [],
      notCreated: desiredTopics,
    };
  }

  const existing = await shopifyAdminGraphql<ExistingWebhookPayload>({
    shopId: input.shopId,
    accessToken: input.accessToken,
    query: LIST_WEBHOOKS_QUERY,
  }).catch(() => null);

  const existingTopics = new Set(
    (existing?.webhookSubscriptions?.nodes ?? [])
      .filter((node) => node?.endpoint?.__typename === "WebhookHttpEndpoint")
      .filter((node) => node?.endpoint?.callbackUrl === callbackUrl)
      .map((node) => node?.topic)
      .filter((topic): topic is string => Boolean(topic))
  );

  const missingTopics = desiredTopics.filter((topic) => !existingTopics.has(topic));
  const extraTopics = [...existingTopics].filter((topic) => !desiredTopics.includes(topic as ShopifySyncWebhookTopic));
  return {
    status: "verified",
    callbackUrl,
    existingTopics: [...existingTopics],
    desiredTopics,
    missingTopics,
    extraTopics,
  };
}
