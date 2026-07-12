import {
  getMetaAdsWriteBlockFailure,
  type MetaAdsWriteContext,
  type MetaAdsWriteError,
  type MetaAdsWriteFailure,
} from "@/lib/meta/ads-write";

type MetaFetchMethod = "GET" | "POST";

const GRAPH_API_VERSION = "v22.0";
const META_RATE_LIMIT_CODE = 17;
const RATE_LIMIT_RETRY_MS =
  process.env.NODE_ENV === "test" || process.env.VITEST === "true"
    ? 0
    : 30_000;

export type MetaBidStrategy =
  | "LOWEST_COST_WITHOUT_CAP"
  | "LOWEST_COST_WITH_BID_CAP"
  | "COST_CAP";

export interface MetaLaunchCampaignInput {
  name: string;
  objective: "OUTCOME_SALES";
  status: "PAUSED";
  smartPromotionType?: "GUIDED_CREATION" | null;
  buyingType?: "AUCTION";
  specialAdCategories: string[];
  bidStrategy?: MetaBidStrategy;
  bidAmountMinor?: number;
  dailyBudgetMinor?: number;
  lifetimeBudgetMinor?: number;
  isAdsetBudgetSharingEnabled: boolean;
}

export interface MetaLaunchAdSetInput {
  campaignId: string;
  name: string;
  optimizationGoal:
    | "OFFSITE_CONVERSIONS"
    | "VALUE"
    | "LANDING_PAGE_VIEWS";
  billingEvent: "IMPRESSIONS";
  status: "PAUSED";
  promotedObject: {
    pixelId: string;
    customEventType: "PURCHASE" | "ADD_TO_CART" | "INITIATE_CHECKOUT";
  };
  targeting: {
    geoLocations: { countries: string[] };
    ageMin: number;
    ageMax: number;
    advantageAudience: 0 | 1;
    publisherPlatforms?: string[];
    facebookPositions?: string[];
    instagramPositions?: string[];
  };
  attributionSpec: Array<{
    eventType: "CLICK_THROUGH" | "VIEW_THROUGH" | "ENGAGED_VIDEO_VIEW";
    windowDays: 1 | 7;
  }>;
  dailyBudgetMinor?: number;
  lifetimeBudgetMinor?: number;
  bidStrategy?: MetaBidStrategy;
  bidAmountMinor?: number;
}

export interface MetaLaunchAdInput {
  adsetId: string;
  name: string;
  creativeId: string;
  status: "PAUSED";
}

export type MetaLaunchCampaignSuccess = {
  ok: true;
  campaignId: string;
  verifiedStatus: string;
  responsePayload?: Record<string, unknown> | null;
  verificationPayload?: Record<string, unknown> | null;
};

export type MetaLaunchAdSetSuccess = {
  ok: true;
  adsetId: string;
  verifiedStatus: string;
  responsePayload?: Record<string, unknown> | null;
  verificationPayload?: Record<string, unknown> | null;
};

export type MetaLaunchAdSuccess = {
  ok: true;
  adId: string;
  verifiedStatus: string;
  responsePayload?: Record<string, unknown> | null;
  verificationPayload?: Record<string, unknown> | null;
};

function buildGraphUrl(path: string, accessToken: string) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`);
  url.searchParams.set("access_token", accessToken);
  return url;
}

function sanitizeMetaMessage(message: string) {
  return message
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMetaPayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function readResponseJson(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return null;
  try {
    return normalizeMetaPayload(JSON.parse(text));
  } catch {
    return { raw: sanitizeMetaMessage(text.slice(0, 500)) };
  }
}

function getNestedRecord(
  payload: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = payload?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringField(
  payload: Record<string, unknown> | null | undefined,
  key: string,
) {
  const value = payload?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function getMetaError(
  payload: Record<string, unknown> | null | undefined,
  fallback: { code: string; message: string },
): MetaAdsWriteError {
  const error = getNestedRecord(payload, "error");
  if (!error) return fallback;
  const rawCode = error.code ?? error.error_code ?? fallback.code;
  const rawMessage = error.message ?? error.error_message ?? fallback.message;
  return {
    code:
      Number(rawCode) === META_RATE_LIMIT_CODE
        ? "rate_limited"
        : String(rawCode || fallback.code),
    message: sanitizeMetaMessage(String(rawMessage || fallback.message)),
  };
}

function isRateLimitPayload(payload: Record<string, unknown> | null | undefined) {
  const error = getNestedRecord(payload, "error");
  return Number(error?.code) === META_RATE_LIMIT_CODE;
}

function isFailureBody(payload: Record<string, unknown> | null | undefined) {
  return Boolean(payload?.error) || payload?.success === false;
}

function getAccountNumericId(providerAccountId: string) {
  return providerAccountId.trim().replace(/^act_/, "");
}

function setOptionalNumber(
  body: URLSearchParams,
  key: string,
  value: number | undefined,
) {
  if (typeof value === "number" && Number.isFinite(value)) {
    body.set(key, String(Math.trunc(value)));
  }
}

async function metaFetch(input: {
  ctx: MetaAdsWriteContext;
  path: string;
  method: MetaFetchMethod;
  body?: URLSearchParams;
  fields?: string;
}): Promise<{
  response: Response | null;
  payload: Record<string, unknown> | null;
  error: MetaAdsWriteError | null;
}> {
  const url = buildGraphUrl(input.path, input.ctx.accessToken);
  if (input.fields) url.searchParams.set("fields", input.fields);

  try {
    const response = await fetch(url.toString(), {
      method: input.method,
      body: input.body,
      cache: "no-store",
    });
    const payload = await readResponseJson(response);
    return { response, payload, error: null };
  } catch (error) {
    return {
      response: null,
      payload: null,
      error: {
        code: "network_error",
        message: sanitizeMetaMessage(
          error instanceof Error ? error.message : String(error),
        ),
      },
    };
  }
}

async function metaFetchWithRateLimitRetry(input: {
  ctx: MetaAdsWriteContext;
  path: string;
  method: MetaFetchMethod;
  body?: URLSearchParams;
  fields?: string;
}) {
  const initialBlock = await getMetaAdsWriteBlockFailure(input.ctx);
  if (initialBlock) {
    return {
      response: null,
      payload: null,
      error: initialBlock.error,
    };
  }
  const first = await metaFetch(input);
  if (
    first.response &&
    !first.response.ok &&
    isRateLimitPayload(first.payload)
  ) {
    await delay(RATE_LIMIT_RETRY_MS);
    const retryBlock = await getMetaAdsWriteBlockFailure(input.ctx);
    if (retryBlock) {
      return {
        response: null,
        payload: null,
        error: retryBlock.error,
      };
    }
    return metaFetch(input);
  }
  return first;
}

function buildWriteFailure(input: {
  payload: Record<string, unknown> | null;
  httpStatus: number;
  fallbackCode: string;
  fallbackMessage: string;
  verificationPayload?: Record<string, unknown> | null;
  resultingAdId?: string | null;
}): MetaAdsWriteFailure {
  return {
    ok: false,
    httpStatus: input.httpStatus,
    error: getMetaError(input.payload, {
      code: input.fallbackCode,
      message: input.fallbackMessage,
    }),
    responsePayload: input.payload,
    verificationPayload: input.verificationPayload ?? null,
    resultingAdId: input.resultingAdId ?? null,
  };
}

function campaignBody(input: MetaLaunchCampaignInput) {
  const body = new URLSearchParams({
    name: input.name,
    objective: input.objective,
    status: input.status,
    buying_type: input.buyingType ?? "AUCTION",
    special_ad_categories: JSON.stringify(input.specialAdCategories ?? []),
    is_adset_budget_sharing_enabled: String(
      input.isAdsetBudgetSharingEnabled,
    ),
  });
  if (input.smartPromotionType) {
    body.set("smart_promotion_type", input.smartPromotionType);
  }
  if (input.bidStrategy) body.set("bid_strategy", input.bidStrategy);
  setOptionalNumber(body, "bid_amount", input.bidAmountMinor);
  setOptionalNumber(body, "daily_budget", input.dailyBudgetMinor);
  setOptionalNumber(body, "lifetime_budget", input.lifetimeBudgetMinor);
  return body;
}

function targetingBody(input: MetaLaunchAdSetInput["targeting"]) {
  const targeting: Record<string, unknown> = {
    geo_locations: {
      countries: input.geoLocations.countries,
    },
    age_min: input.ageMin,
    age_max: input.ageMax,
    targeting_automation: {
      advantage_audience: input.advantageAudience,
    },
  };
  if (input.publisherPlatforms?.length) {
    targeting.publisher_platforms = input.publisherPlatforms;
  }
  if (input.facebookPositions?.length) {
    targeting.facebook_positions = input.facebookPositions;
  }
  if (input.instagramPositions?.length) {
    targeting.instagram_positions = input.instagramPositions;
  }
  return targeting;
}

function attributionSpecBody(input: MetaLaunchAdSetInput["attributionSpec"]) {
  return input.map((item) => ({
    event_type: item.eventType,
    window_days: item.windowDays,
  }));
}

function adSetBody(input: MetaLaunchAdSetInput) {
  const body = new URLSearchParams({
    name: input.name,
    campaign_id: input.campaignId,
    optimization_goal: input.optimizationGoal,
    billing_event: input.billingEvent,
    status: input.status,
    promoted_object: JSON.stringify({
      pixel_id: input.promotedObject.pixelId,
      custom_event_type: input.promotedObject.customEventType,
    }),
    targeting: JSON.stringify(targetingBody(input.targeting)),
    attribution_spec: JSON.stringify(attributionSpecBody(input.attributionSpec)),
  });
  setOptionalNumber(body, "daily_budget", input.dailyBudgetMinor);
  setOptionalNumber(body, "lifetime_budget", input.lifetimeBudgetMinor);
  if (input.bidStrategy) body.set("bid_strategy", input.bidStrategy);
  setOptionalNumber(body, "bid_amount", input.bidAmountMinor);
  return body;
}

function adBody(input: MetaLaunchAdInput) {
  return new URLSearchParams({
    name: input.name,
    creative: JSON.stringify({ creative_id: input.creativeId }),
    status: input.status,
  });
}

function readPromotedObjectField(
  promotedObject: Record<string, unknown> | null,
  snakeKey: string,
  camelKey: string,
) {
  const value = promotedObject?.[snakeKey] ?? promotedObject?.[camelKey];
  return typeof value === "string" ? value.trim() : "";
}

export async function createCampaign(
  ctx: MetaAdsWriteContext,
  input: MetaLaunchCampaignInput,
): Promise<MetaLaunchCampaignSuccess | MetaAdsWriteFailure> {
  const accountNumericId = getAccountNumericId(ctx.providerAccountId);
  const write = await metaFetchWithRateLimitRetry({
    ctx,
    path: `act_${accountNumericId}/campaigns`,
    method: "POST",
    body: campaignBody(input),
  });
  if (write.error) {
    return {
      ok: false,
      httpStatus: write.error.code === "kill_switch_engaged" ? 503 : 502,
      error: write.error,
      responsePayload: write.payload,
    };
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_campaign_create_failed",
      fallbackMessage: "Meta failed to create the campaign.",
    });
  }
  const campaignId = readStringField(write.payload, "id");
  if (!campaignId) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus: 502,
      fallbackCode: "silent_failure",
      fallbackMessage: "Meta returned success but did not return a campaign id.",
    });
  }

  const verification = await metaFetch({
    ctx,
    path: campaignId,
    method: "GET",
    fields: "id,status,objective",
  });
  if (
    verification.error ||
    !verification.response?.ok ||
    isFailureBody(verification.payload)
  ) {
    return {
      ok: false,
      httpStatus: verification.response?.status ?? 502,
      error: {
        code: "silent_failure",
        message: "Meta created the campaign but it could not be verified.",
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
      resultingAdId: campaignId,
    };
  }
  const verifiedStatus = readStringField(verification.payload, "status");
  const verifiedObjective = readStringField(verification.payload, "objective");
  if (verifiedStatus !== input.status || verifiedObjective !== input.objective) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "silent_failure",
        message: "Meta created the campaign but verification did not match the requested status or objective.",
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
      resultingAdId: campaignId,
    };
  }

  return {
    ok: true,
    campaignId,
    verifiedStatus,
    responsePayload: write.payload,
    verificationPayload: verification.payload,
  };
}

export async function createAdSet(
  ctx: MetaAdsWriteContext,
  input: MetaLaunchAdSetInput,
): Promise<MetaLaunchAdSetSuccess | MetaAdsWriteFailure> {
  const write = await metaFetchWithRateLimitRetry({
    ctx,
    path: `${input.campaignId}/adsets`,
    method: "POST",
    body: adSetBody(input),
  });
  if (write.error) {
    return {
      ok: false,
      httpStatus: write.error.code === "kill_switch_engaged" ? 503 : 502,
      error: write.error,
      responsePayload: write.payload,
    };
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_adset_create_failed",
      fallbackMessage: "Meta failed to create the ad set.",
    });
  }
  const adsetId = readStringField(write.payload, "id");
  if (!adsetId) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus: 502,
      fallbackCode: "silent_failure",
      fallbackMessage: "Meta returned success but did not return an ad set id.",
    });
  }

  const verification = await metaFetch({
    ctx,
    path: adsetId,
    method: "GET",
    fields: "id,status,optimization_goal,promoted_object",
  });
  if (
    verification.error ||
    !verification.response?.ok ||
    isFailureBody(verification.payload)
  ) {
    return {
      ok: false,
      httpStatus: verification.response?.status ?? 502,
      error: {
        code: "silent_failure",
        message: "Meta created the ad set but it could not be verified.",
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
      resultingAdId: adsetId,
    };
  }
  const verifiedStatus = readStringField(verification.payload, "status");
  const verifiedOptimizationGoal = readStringField(
    verification.payload,
    "optimization_goal",
  );
  const promotedObject = getNestedRecord(
    verification.payload,
    "promoted_object",
  );
  const verifiedPixelId = readPromotedObjectField(
    promotedObject,
    "pixel_id",
    "pixelId",
  );
  const verifiedEvent = readPromotedObjectField(
    promotedObject,
    "custom_event_type",
    "customEventType",
  );
  if (
    verifiedStatus !== input.status ||
    verifiedOptimizationGoal !== input.optimizationGoal ||
    verifiedPixelId !== input.promotedObject.pixelId ||
    verifiedEvent !== input.promotedObject.customEventType
  ) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "silent_failure",
        message: "Meta created the ad set but verification did not match the requested status, optimization goal, or promoted object.",
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
      resultingAdId: adsetId,
    };
  }

  return {
    ok: true,
    adsetId,
    verifiedStatus,
    responsePayload: write.payload,
    verificationPayload: verification.payload,
  };
}

export async function createAd(
  ctx: MetaAdsWriteContext,
  input: MetaLaunchAdInput,
): Promise<MetaLaunchAdSuccess | MetaAdsWriteFailure> {
  const write = await metaFetchWithRateLimitRetry({
    ctx,
    path: `${input.adsetId}/ads`,
    method: "POST",
    body: adBody(input),
  });
  if (write.error) {
    return {
      ok: false,
      httpStatus: write.error.code === "kill_switch_engaged" ? 503 : 502,
      error: write.error,
      responsePayload: write.payload,
    };
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_ad_create_failed",
      fallbackMessage: "Meta failed to create the ad.",
    });
  }
  const adId = readStringField(write.payload, "id");
  if (!adId) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus: 502,
      fallbackCode: "silent_failure",
      fallbackMessage: "Meta returned success but did not return an ad id.",
    });
  }

  const verification = await metaFetch({
    ctx,
    path: adId,
    method: "GET",
    fields: "id,status,adset_id,creative{id}",
  });
  if (
    verification.error ||
    !verification.response?.ok ||
    isFailureBody(verification.payload)
  ) {
    return {
      ok: false,
      httpStatus: verification.response?.status ?? 502,
      error: {
        code: "silent_failure",
        message: "Meta created the ad but it could not be verified.",
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
      resultingAdId: adId,
    };
  }
  const verifiedStatus = readStringField(verification.payload, "status");
  const verifiedAdsetId = readStringField(verification.payload, "adset_id");
  const creative = getNestedRecord(verification.payload, "creative");
  const verifiedCreativeId =
    readStringField(creative, "id") || readStringField(creative, "creative_id");
  if (
    verifiedStatus !== input.status ||
    verifiedAdsetId !== input.adsetId ||
    verifiedCreativeId !== input.creativeId
  ) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "silent_failure",
        message: "Meta created the ad but verification did not match the requested status, ad set, or creative.",
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
      resultingAdId: adId,
    };
  }

  return {
    ok: true,
    adId,
    verifiedStatus,
    responsePayload: write.payload,
    verificationPayload: verification.payload,
  };
}
