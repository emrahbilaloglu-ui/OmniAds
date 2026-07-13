import { getMetaWriteBlockState } from "@/lib/meta/automation-control-plane";

export interface MetaAdsWriteContext {
  businessId: string;
  providerAccountId: string;
  accessToken: string;
}

export interface MetaAdsWriteOptions {
  dryRun?: boolean;
}

export interface MetaAdsWriteError {
  code: string;
  message: string;
}

export interface MetaAdsWouldHaveWritten {
  method: MetaFetchMethod;
  path: string;
  body?: Record<string, unknown>;
}

export type MetaAdsWriteFailure = {
  ok: false;
  error: MetaAdsWriteError;
  httpStatus: number;
  responsePayload?: Record<string, unknown> | null;
  verificationPayload?: Record<string, unknown> | null;
  resultingAdId?: string | null;
};

export type MetaAdStatusWriteSuccess = {
  ok: true;
  verifiedStatus: string;
  dryRun?: boolean;
  wouldHaveWritten?: MetaAdsWouldHaveWritten;
  responsePayload?: Record<string, unknown> | null;
  verificationPayload?: Record<string, unknown> | null;
};

export type MetaAdExecutionStateRead =
  | {
      ok: true;
      adId: string;
      configuredStatus: string | null;
      effectiveStatus: string | null;
      policyEligible: boolean | null;
      reviewStatus: string | null;
      observedAt: string;
    }
  | {
      ok: false;
      adId: string | null;
      error: MetaAdsWriteError;
    };

export type MetaAdsetBidWriteSuccess = {
  ok: true;
  verifiedBidAmount: number;
  dryRun?: boolean;
  wouldHaveWritten?: MetaAdsWouldHaveWritten;
  responsePayload?: Record<string, unknown> | null;
  verificationPayload?: Record<string, unknown> | null;
};

export type MetaAdDuplicateWriteSuccess = {
  ok: true;
  newAdId: string;
  newCreativeId?: string | null;
  verifiedStatus: string;
  dryRun?: false;
  wouldHaveWritten?: MetaAdsWouldHaveWritten;
  responsePayload?: Record<string, unknown> | null;
  verificationPayload?: Record<string, unknown> | null;
};

export type MetaAdDuplicateDryRunSuccess = {
  ok: true;
  newAdId: null;
  newCreativeId?: null;
  verifiedStatus: string;
  dryRun: true;
  wouldHaveWritten: MetaAdsWouldHaveWritten;
  responsePayload?: Record<string, unknown> | null;
  verificationPayload?: Record<string, unknown> | null;
};

type MetaAdDuplicateSuccess = MetaAdDuplicateWriteSuccess | MetaAdDuplicateDryRunSuccess;

type MetaFetchMethod = "GET" | "POST";
export type MetaAdDuplicateCopyMode = "reuse_creative" | "rebuild_creative";

const GRAPH_API_VERSION = "v22.0";
const META_RATE_LIMIT_CODE = 17;
const RATE_LIMIT_RETRY_MS =
  process.env.NODE_ENV === "test" || process.env.VITEST === "true"
    ? 0
    : 30_000;

function isMetaAdsWriteKillSwitchEngaged() {
  const value = process.env.META_ADS_WRITE_KILL_SWITCH?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function killSwitchFailure(): MetaAdsWriteFailure {
  return {
    ok: false,
    httpStatus: 503,
    error: {
      code: "kill_switch_engaged",
      message: "Meta writes are disabled by kill switch.",
    },
    responsePayload: null,
    verificationPayload: null,
  };
}

export async function getMetaAdsWriteBlockFailure(
  ctx: MetaAdsWriteContext,
): Promise<MetaAdsWriteFailure | null> {
  const block = await getMetaWriteBlockState({ businessId: ctx.businessId });
  if (!block.blocked) return null;
  return {
    ok: false,
    httpStatus: 503,
    error: {
      code: "kill_switch_engaged",
      message: block.message ?? "Meta writes are disabled by kill switch.",
    },
    responsePayload: null,
    verificationPayload: null,
  };
}

function metaWriteErrorStatus(error: MetaAdsWriteError) {
  return error.code === "kill_switch_engaged" ? 503 : 502;
}

function dryRunPayload(wouldHaveWritten: MetaAdsWouldHaveWritten) {
  return {
    dryRun: true,
    wouldHaveWritten,
  };
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneRecord(value: Record<string, unknown> | null) {
  if (!value) return null;
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
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

function readStringField(
  payload: Record<string, unknown> | null | undefined,
  key: string,
) {
  const value = payload?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function pruneCreativeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value
      .map(pruneCreativeValue)
      .filter((item) => {
        if (item == null) return false;
        if (Array.isArray(item)) return item.length > 0;
        if (isRecord(item)) return Object.keys(item).length > 0;
        return true;
      });
    return items.length > 0 ? items : undefined;
  }
  if (!isRecord(value)) {
    return value == null || value === "" ? undefined : value;
  }
  const entries = Object.entries(value).flatMap(([key, item]) => {
    const pruned = pruneCreativeValue(item);
    if (pruned == null) return [];
    if (Array.isArray(pruned) && pruned.length === 0) return [];
    if (isRecord(pruned) && Object.keys(pruned).length === 0) return [];
    return [[key, pruned] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function getAccountNumericId(providerAccountId: string) {
  return providerAccountId.trim().replace(/^act_/, "");
}

function readFirstStringField(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = readStringField(payload, key);
    if (value) return value;
  }
  return "";
}

function extractAdImageHash(payload: Record<string, unknown> | null) {
  const direct = readStringField(payload, "hash");
  if (direct) return direct;
  const images = getNestedRecord(payload, "images");
  if (!images) return "";
  for (const value of Object.values(images)) {
    if (!isRecord(value)) continue;
    const hash = readStringField(value, "hash");
    if (hash) return hash;
  }
  return "";
}

async function uploadAdImageFromUrl(ctx: MetaAdsWriteContext, imageUrl: string) {
  const accountNumericId = getAccountNumericId(ctx.providerAccountId);
  const body = new URLSearchParams({ url: imageUrl });
  const result = await metaFetchWithRateLimitRetry({
    ctx,
    path: `act_${accountNumericId}/adimages`,
    method: "POST",
    body,
  });
  if (
    result.error ||
    !result.response?.ok ||
    isFailureBody(result.payload)
  ) {
    return "";
  }
  return extractAdImageHash(result.payload);
}

async function replaceImageUrlWithTargetHash(
  ctx: MetaAdsWriteContext,
  record: Record<string, unknown>,
  hashKey: "image_hash" | "hash",
) {
  // Source account image hashes are not portable; rebuilt creatives need target-account hashes.
  const imageUrl = readFirstStringField(record, [
    "picture",
    "image_url",
    "url",
    "original_url",
  ]);
  if (!imageUrl) return;
  const hash = await uploadAdImageFromUrl(ctx, imageUrl);
  if (!hash) return;
  record[hashKey] = hash;
  delete record.picture;
  delete record.image_url;
  delete record.url;
  delete record.original_url;
}

async function prepareObjectStorySpecForTarget(
  ctx: MetaAdsWriteContext,
  objectStorySpec: Record<string, unknown>,
) {
  const linkData = getNestedRecord(objectStorySpec, "link_data");
  if (linkData) {
    await replaceImageUrlWithTargetHash(ctx, linkData, "image_hash");
    const childAttachments = Array.isArray(linkData.child_attachments)
      ? linkData.child_attachments
      : [];
    for (const attachment of childAttachments) {
      if (isRecord(attachment)) await replaceImageUrlWithTargetHash(ctx, attachment, "image_hash");
    }
  }

  const photoData = getNestedRecord(objectStorySpec, "photo_data");
  if (photoData) await replaceImageUrlWithTargetHash(ctx, photoData, "image_hash");
}

async function prepareAssetFeedSpecForTarget(
  ctx: MetaAdsWriteContext,
  assetFeedSpec: Record<string, unknown>,
) {
  const images = Array.isArray(assetFeedSpec.images) ? assetFeedSpec.images : [];
  for (const image of images) {
    if (isRecord(image)) await replaceImageUrlWithTargetHash(ctx, image, "hash");
  }
}

async function buildRecreatedCreative(input: {
  ctx: MetaAdsWriteContext;
  sourceCreative: Record<string, unknown>;
  name: string;
}): Promise<
  | { ok: true; creativeId: string; responsePayload: Record<string, unknown> | null }
  | MetaAdsWriteFailure
> {
  const accountNumericId = getAccountNumericId(input.ctx.providerAccountId);
  const body = new URLSearchParams({
    name: `${input.name} creative`,
  });

  const objectStorySpec = cloneRecord(getNestedRecord(input.sourceCreative, "object_story_spec"));
  if (objectStorySpec) {
    await prepareObjectStorySpecForTarget(input.ctx, objectStorySpec);
    const pruned = pruneCreativeValue(objectStorySpec);
    if (isRecord(pruned)) body.set("object_story_spec", JSON.stringify(pruned));
  }

  const assetFeedSpec = cloneRecord(getNestedRecord(input.sourceCreative, "asset_feed_spec"));
  if (assetFeedSpec) {
    await prepareAssetFeedSpecForTarget(input.ctx, assetFeedSpec);
    const pruned = pruneCreativeValue(assetFeedSpec);
    if (isRecord(pruned)) body.set("asset_feed_spec", JSON.stringify(pruned));
  }

  const urlTags = readStringField(input.sourceCreative, "url_tags");
  if (urlTags) body.set("url_tags", urlTags);

  if (!body.has("object_story_spec") && !body.has("asset_feed_spec")) {
    const objectStoryId =
      readStringField(input.sourceCreative, "object_story_id") ||
      readStringField(input.sourceCreative, "effective_object_story_id");
    if (objectStoryId) body.set("object_story_id", objectStoryId);
  }

  if (
    !body.has("object_story_spec") &&
    !body.has("asset_feed_spec") &&
    !body.has("object_story_id")
  ) {
    return {
      ok: false,
      httpStatus: 422,
      error: {
        code: "creative_rebuild_not_supported",
        message: "Source ad creative does not expose enough creative spec data to recreate it.",
      },
      responsePayload: { source_creative_id: readStringField(input.sourceCreative, "id") },
    };
  }

  const write = await metaFetchWithRateLimitRetry({
    ctx: input.ctx,
    path: `act_${accountNumericId}/adcreatives`,
    method: "POST",
    body,
  });
  if (write.error) {
    return {
      ok: false,
      httpStatus: metaWriteErrorStatus(write.error),
      error: write.error,
      responsePayload: write.payload,
    };
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_creative_rebuild_failed",
      fallbackMessage: "Meta failed to recreate the source ad creative in the target account.",
    });
  }
  const creativeId = readStringField(write.payload, "id");
  if (!creativeId) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus: 502,
      fallbackCode: "silent_failure",
      fallbackMessage: "Meta returned success but did not return a recreated creative id.",
    });
  }
  return { ok: true, creativeId, responsePayload: write.payload };
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

async function verifyAd(input: {
  ctx: MetaAdsWriteContext;
  adId: string;
}): Promise<{
  ok: boolean;
  httpStatus: number;
  payload: Record<string, unknown> | null;
  error: MetaAdsWriteError | null;
}> {
  const result = await metaFetch({
    ctx: input.ctx,
    path: input.adId,
    method: "GET",
    fields: "id,name,status,effective_status,adset_id,campaign_id",
  });
  if (result.error) {
    return {
      ok: false,
      httpStatus: 502,
      payload: result.payload,
      error: result.error,
    };
  }
  const status = result.response?.status ?? 502;
  if (!result.response?.ok || isFailureBody(result.payload)) {
    return {
      ok: false,
      httpStatus: status,
      payload: result.payload,
      error: getMetaError(result.payload, {
        code: "verification_failed",
        message: "Meta verification GET failed.",
      }),
    };
  }
  return {
    ok: true,
    httpStatus: status,
    payload: result.payload,
    error: null,
  };
}

const POLICY_BLOCKED_AD_STATUSES = new Set([
  "DISAPPROVED",
  "PENDING_BILLING_INFO",
  "PENDING_REVIEW",
  "WITH_ISSUES",
]);

/** Live, read-only state used by the exact decision-origin write preflight. */
export async function readMetaAdExecutionState(
  ctx: MetaAdsWriteContext,
  adId: string,
): Promise<MetaAdExecutionStateRead> {
  const result = await metaFetch({
    ctx,
    path: adId,
    method: "GET",
    fields: "id,status,effective_status",
  });
  if (
    result.error ||
    !result.response?.ok ||
    isFailureBody(result.payload)
  ) {
    return {
      ok: false,
      adId,
      error:
        result.error ??
        getMetaError(result.payload, {
          code: "current_ad_state_unverified",
          message: "Meta current ad state could not be verified.",
        }),
    };
  }
  const resolvedAdId = readStringField(result.payload, "id");
  if (!resolvedAdId || resolvedAdId !== adId) {
    return {
      ok: false,
      adId: resolvedAdId,
      error: {
        code: "ad_identity_mismatch",
        message: "Meta current ad state resolved to a different ad.",
      },
    };
  }
  const configuredStatus = readStringField(result.payload, "status");
  const effectiveStatus = readStringField(
    result.payload,
    "effective_status",
  );
  const normalizedEffectiveStatus = effectiveStatus?.toUpperCase() ?? null;
  return {
    ok: true,
    adId: resolvedAdId,
    configuredStatus,
    effectiveStatus,
    policyEligible:
      normalizedEffectiveStatus === null
        ? null
        : !POLICY_BLOCKED_AD_STATUSES.has(normalizedEffectiveStatus),
    reviewStatus: POLICY_BLOCKED_AD_STATUSES.has(
      normalizedEffectiveStatus ?? "",
    )
      ? normalizedEffectiveStatus
      : null,
    observedAt: new Date().toISOString(),
  };
}

async function verifyEntity(input: {
  ctx: MetaAdsWriteContext;
  entityId: string;
  fields: string;
}): Promise<{
  ok: boolean;
  httpStatus: number;
  payload: Record<string, unknown> | null;
  error: MetaAdsWriteError | null;
}> {
  const result = await metaFetch({
    ctx: input.ctx,
    path: input.entityId,
    method: "GET",
    fields: input.fields,
  });
  if (result.error) {
    return {
      ok: false,
      httpStatus: 502,
      payload: result.payload,
      error: result.error,
    };
  }
  const status = result.response?.status ?? 502;
  if (!result.response?.ok || isFailureBody(result.payload)) {
    return {
      ok: false,
      httpStatus: status,
      payload: result.payload,
      error: getMetaError(result.payload, {
        code: "verification_failed",
        message: "Meta verification GET failed.",
      }),
    };
  }
  return {
    ok: true,
    httpStatus: status,
    payload: result.payload,
    error: null,
  };
}

async function updateEntityStatus(
  ctx: MetaAdsWriteContext,
  entityId: string,
  status: "ACTIVE" | "PAUSED",
  entityLabel: "campaign" | "ad set",
  options: MetaAdsWriteOptions = {},
): Promise<MetaAdStatusWriteSuccess | MetaAdsWriteFailure> {
  if (isMetaAdsWriteKillSwitchEngaged()) return killSwitchFailure();
  const wouldHaveWritten: MetaAdsWouldHaveWritten = {
    method: "POST",
    path: entityId,
    body: { status },
  };
  if (options.dryRun) {
    const verification = await verifyEntity({
      ctx,
      entityId,
      fields: "id,name,status,effective_status",
    });
    if (!verification.ok) {
      return {
        ok: false,
        httpStatus: verification.httpStatus,
        error:
          verification.error ?? {
            code: "verification_failed",
            message: "Meta verification GET failed.",
          },
        responsePayload: dryRunPayload(wouldHaveWritten),
        verificationPayload: verification.payload,
      };
    }
    return {
      ok: true,
      verifiedStatus: status,
      dryRun: true,
      wouldHaveWritten,
      responsePayload: dryRunPayload(wouldHaveWritten),
      verificationPayload: verification.payload,
    };
  }

  const body = new URLSearchParams({ status });
  const write = await metaFetchWithRateLimitRetry({
    ctx,
    path: entityId,
    method: "POST",
    body,
  });
  if (write.error) {
    return {
      ok: false,
      httpStatus: metaWriteErrorStatus(write.error),
      error: write.error,
      responsePayload: write.payload,
    };
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_write_failed",
      fallbackMessage: `Meta failed to set ${entityLabel} status to ${status}.`,
    });
  }

  const verification = await verifyEntity({
    ctx,
    entityId,
    fields: "id,name,status,effective_status",
  });
  if (!verification.ok) {
    return {
      ok: false,
      httpStatus: verification.httpStatus,
      error:
        verification.error ?? {
          code: "verification_failed",
          message: "Meta verification GET failed.",
        },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
    };
  }

  const verifiedStatus = String(verification.payload?.status ?? "");
  if (verifiedStatus !== status) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "silent_failure",
        message: `Meta returned success but ${entityLabel} status verified as ${verifiedStatus || "unknown"} instead of ${status}.`,
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
    };
  }

  return {
    ok: true,
    verifiedStatus,
    responsePayload: write.payload,
    verificationPayload: verification.payload,
  };
}

async function updateAdStatus(
  ctx: MetaAdsWriteContext,
  adId: string,
  status: "ACTIVE" | "PAUSED",
  options: MetaAdsWriteOptions = {},
): Promise<MetaAdStatusWriteSuccess | MetaAdsWriteFailure> {
  if (isMetaAdsWriteKillSwitchEngaged()) return killSwitchFailure();
  const wouldHaveWritten: MetaAdsWouldHaveWritten = {
    method: "POST",
    path: adId,
    body: { status },
  };
  if (options.dryRun) {
    const verification = await verifyAd({ ctx, adId });
    if (!verification.ok) {
      return {
        ok: false,
        httpStatus: verification.httpStatus,
        error:
          verification.error ?? {
            code: "verification_failed",
            message: "Meta verification GET failed.",
          },
        responsePayload: dryRunPayload(wouldHaveWritten),
        verificationPayload: verification.payload,
      };
    }
    return {
      ok: true,
      verifiedStatus: status,
      dryRun: true,
      wouldHaveWritten,
      responsePayload: dryRunPayload(wouldHaveWritten),
      verificationPayload: verification.payload,
    };
  }

  const body = new URLSearchParams({ status });
  const write = await metaFetchWithRateLimitRetry({
    ctx,
    path: adId,
    method: "POST",
    body,
  });
  if (write.error) {
    return {
      ok: false,
      httpStatus: metaWriteErrorStatus(write.error),
      error: write.error,
      responsePayload: write.payload,
    };
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_write_failed",
      fallbackMessage: `Meta failed to set ad status to ${status}.`,
    });
  }

  const verification = await verifyAd({ ctx, adId });
  if (!verification.ok) {
    return {
      ok: false,
      httpStatus: verification.httpStatus,
      error:
        verification.error ?? {
          code: "verification_failed",
          message: "Meta verification GET failed.",
        },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
    };
  }

  const verifiedStatus = String(verification.payload?.status ?? "");
  if (verifiedStatus !== status) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "silent_failure",
        message: `Meta returned success but ad status verified as ${verifiedStatus || "unknown"} instead of ${status}.`,
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
    };
  }

  return {
    ok: true,
    verifiedStatus,
    responsePayload: write.payload,
    verificationPayload: verification.payload,
  };
}

export async function pauseAd(
  ctx: MetaAdsWriteContext,
  adId: string,
  options: MetaAdsWriteOptions = {},
): Promise<MetaAdStatusWriteSuccess | MetaAdsWriteFailure> {
  return updateAdStatus(ctx, adId, "PAUSED", options);
}

export async function resumeAd(
  ctx: MetaAdsWriteContext,
  adId: string,
  options: MetaAdsWriteOptions = {},
): Promise<MetaAdStatusWriteSuccess | MetaAdsWriteFailure> {
  return updateAdStatus(ctx, adId, "ACTIVE", options);
}

export async function pauseCampaign(
  ctx: MetaAdsWriteContext,
  campaignId: string,
  options: MetaAdsWriteOptions = {},
): Promise<MetaAdStatusWriteSuccess | MetaAdsWriteFailure> {
  return updateEntityStatus(ctx, campaignId, "PAUSED", "campaign", options);
}

export async function resumeCampaign(
  ctx: MetaAdsWriteContext,
  campaignId: string,
  options: MetaAdsWriteOptions = {},
): Promise<MetaAdStatusWriteSuccess | MetaAdsWriteFailure> {
  return updateEntityStatus(ctx, campaignId, "ACTIVE", "campaign", options);
}

export async function pauseAdset(
  ctx: MetaAdsWriteContext,
  adsetId: string,
  options: MetaAdsWriteOptions = {},
): Promise<MetaAdStatusWriteSuccess | MetaAdsWriteFailure> {
  return updateEntityStatus(ctx, adsetId, "PAUSED", "ad set", options);
}

export async function resumeAdset(
  ctx: MetaAdsWriteContext,
  adsetId: string,
  options: MetaAdsWriteOptions = {},
): Promise<MetaAdStatusWriteSuccess | MetaAdsWriteFailure> {
  return updateEntityStatus(ctx, adsetId, "ACTIVE", "ad set", options);
}

export async function updateAdsetBidAmount(
  ctx: MetaAdsWriteContext,
  input: { adsetId: string; bidAmountMinor: number; dryRun?: boolean },
): Promise<MetaAdsetBidWriteSuccess | MetaAdsWriteFailure> {
  if (isMetaAdsWriteKillSwitchEngaged()) return killSwitchFailure();
  const bidAmount = Math.round(input.bidAmountMinor);
  const wouldHaveWritten: MetaAdsWouldHaveWritten = {
    method: "POST",
    path: input.adsetId,
    body: { bid_amount: bidAmount },
  };
  if (input.dryRun) {
    const verification = await verifyEntity({
      ctx,
      entityId: input.adsetId,
      fields: "id,name,bid_amount,bid_strategy,status,effective_status",
    });
    if (!verification.ok) {
      return {
        ok: false,
        httpStatus: verification.httpStatus,
        error:
          verification.error ?? {
            code: "verification_failed",
            message: "Meta verification GET failed.",
          },
        responsePayload: dryRunPayload(wouldHaveWritten),
        verificationPayload: verification.payload,
      };
    }
    return {
      ok: true,
      verifiedBidAmount: bidAmount,
      dryRun: true,
      wouldHaveWritten,
      responsePayload: dryRunPayload(wouldHaveWritten),
      verificationPayload: verification.payload,
    };
  }

  const body = new URLSearchParams({ bid_amount: String(bidAmount) });
  const write = await metaFetchWithRateLimitRetry({
    ctx,
    path: input.adsetId,
    method: "POST",
    body,
  });
  if (write.error) {
    return {
      ok: false,
      httpStatus: metaWriteErrorStatus(write.error),
      error: write.error,
      responsePayload: write.payload,
    };
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_bid_write_failed",
      fallbackMessage: "Meta failed to update the ad set bid amount.",
    });
  }

  const verification = await verifyEntity({
    ctx,
    entityId: input.adsetId,
    fields: "id,name,bid_amount,bid_strategy,status,effective_status",
  });
  if (!verification.ok) {
    return {
      ok: false,
      httpStatus: verification.httpStatus,
      error:
        verification.error ?? {
          code: "verification_failed",
          message: "Meta verification GET failed.",
        },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
    };
  }
  const verifiedBidAmount = Number(verification.payload?.bid_amount ?? NaN);
  if (!Number.isFinite(verifiedBidAmount) || Math.round(verifiedBidAmount) !== bidAmount) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "silent_failure",
        message: `Meta returned success but ad set bid verified as ${Number.isFinite(verifiedBidAmount) ? verifiedBidAmount : "unknown"} instead of ${bidAmount}.`,
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
    };
  }

  return {
    ok: true,
    verifiedBidAmount,
    responsePayload: write.payload,
    verificationPayload: verification.payload,
  };
}

type MetaAdDuplicateInput = {
  adId: string;
  targetAdsetId: string;
  name?: string;
  copyMode?: MetaAdDuplicateCopyMode;
  dryRun?: boolean;
};

type MetaAdDuplicateLiveInput = Omit<MetaAdDuplicateInput, "dryRun"> & {
  dryRun?: false | undefined;
};

type MetaAdDuplicateDryRunInput = Omit<MetaAdDuplicateInput, "dryRun"> & {
  dryRun: true;
};

export function duplicateAd(
  ctx: MetaAdsWriteContext,
  input: MetaAdDuplicateLiveInput,
): Promise<MetaAdDuplicateWriteSuccess | MetaAdsWriteFailure>;
export function duplicateAd(
  ctx: MetaAdsWriteContext,
  input: MetaAdDuplicateDryRunInput,
): Promise<MetaAdDuplicateDryRunSuccess | MetaAdsWriteFailure>;
export function duplicateAd(
  ctx: MetaAdsWriteContext,
  input: MetaAdDuplicateInput,
): Promise<MetaAdDuplicateSuccess | MetaAdsWriteFailure>;
export async function duplicateAd(
  ctx: MetaAdsWriteContext,
  input: MetaAdDuplicateInput,
): Promise<MetaAdDuplicateSuccess | MetaAdsWriteFailure> {
  if (isMetaAdsWriteKillSwitchEngaged()) return killSwitchFailure();
  const copyMode = input.copyMode ?? "reuse_creative";
  const sourceAd = await metaFetch({
    ctx,
    path: input.adId,
    method: "GET",
    fields:
      copyMode === "rebuild_creative"
        ? "name,account_id,creative{id,name,object_type,object_story_id,effective_object_story_id,url_tags,object_story_spec{page_id,instagram_actor_id,link_data{link,message,name,description,picture,image_hash,call_to_action{type,value{link}},child_attachments{link,name,description,picture,image_hash,call_to_action{type,value{link}}}},video_data{video_id,message,title,image_url,thumbnail_url,call_to_action{type,value{link}}},photo_data{message,caption,url,image_hash,call_to_action{type,value{link}}},template_data},asset_feed_spec{bodies{text},titles{text},descriptions{text},images{hash,url,image_url,original_url},videos{video_id,thumbnail_url,image_url}}},adset_id"
        : "name,creative{id},adset_id",
  });
  if (sourceAd.error) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "source_ad_fetch_failed",
        message: `Meta source ad fetch failed: ${sourceAd.error.code}: ${sourceAd.error.message}`,
      },
      responsePayload: sourceAd.payload,
    };
  }
  const sourceHttpStatus = sourceAd.response?.status ?? 502;
  if (!sourceAd.response?.ok || isFailureBody(sourceAd.payload)) {
    const metaError = getMetaError(sourceAd.payload, {
      code: "source_ad_fetch_failed",
      message: "Meta source ad fetch failed.",
    });
    return {
      ok: false,
      httpStatus: sourceHttpStatus,
      error: {
        code: "source_ad_fetch_failed",
        message: `Meta source ad fetch failed: ${metaError.code}: ${metaError.message}`,
      },
      responsePayload: sourceAd.payload,
    };
  }

  const sourceCreativeId = readStringField(
    getNestedRecord(sourceAd.payload, "creative"),
    "id",
  );
  if (!sourceCreativeId) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "source_ad_fetch_failed",
        message: "Meta source ad fetch did not include creative.id.",
      },
      responsePayload: sourceAd.payload,
    };
  }

  const statusOption = "PAUSED";
  const sourceName = readStringField(sourceAd.payload, "name");
  const name =
    typeof input.name === "string" && input.name.trim().length > 0
      ? input.name.trim()
      : `${sourceName || input.adId} (copy)`;
  let adCreativeId = sourceCreativeId;
  let creativeResponsePayload: Record<string, unknown> | null = null;
  if (copyMode === "rebuild_creative") {
    const sourceCreative = getNestedRecord(sourceAd.payload, "creative");
    if (!sourceCreative) {
      return {
        ok: false,
        httpStatus: 502,
        error: {
          code: "source_ad_fetch_failed",
          message: "Meta source ad fetch did not include creative details.",
        },
        responsePayload: sourceAd.payload,
      };
    }
    if (input.dryRun) {
      // Dry-run must not upload images or create rebuilt creatives.
      adCreativeId = sourceCreativeId;
    } else {
      const rebuiltCreative = await buildRecreatedCreative({
        ctx,
        sourceCreative,
        name,
      });
      if (!rebuiltCreative.ok) return rebuiltCreative;
      adCreativeId = rebuiltCreative.creativeId;
      creativeResponsePayload = rebuiltCreative.responsePayload;
    }
  }
  const accountNumericId = getAccountNumericId(ctx.providerAccountId);
  const body = new URLSearchParams({
    name,
    adset_id: input.targetAdsetId,
    creative: JSON.stringify({ creative_id: adCreativeId }),
    status: statusOption,
  });
  const wouldHaveWritten: MetaAdsWouldHaveWritten = {
    method: "POST",
    path: `act_${accountNumericId}/ads`,
    body: Object.fromEntries(body.entries()),
  };

  if (input.dryRun) {
    return {
      ok: true,
      newAdId: null,
      newCreativeId: null,
      verifiedStatus: statusOption,
      dryRun: true,
      wouldHaveWritten,
      responsePayload: dryRunPayload(wouldHaveWritten),
      verificationPayload: sourceAd.payload,
    };
  }

  const write = await metaFetchWithRateLimitRetry({
    ctx,
    path: `act_${accountNumericId}/ads`,
    method: "POST",
    body,
  });
  if (write.error) {
    return {
      ok: false,
      httpStatus: metaWriteErrorStatus(write.error),
      error: write.error,
      responsePayload: write.payload,
    };
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_duplicate_failed",
      fallbackMessage: "Meta failed to create the duplicate ad.",
    });
  }

  const newAdId = readStringField(write.payload, "id");
  if (!newAdId) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "silent_failure",
        message: "Meta returned success but did not return a new ad id.",
      },
      responsePayload: write.payload,
    };
  }

  const verification = await metaFetch({
    ctx,
    path: newAdId,
    method: "GET",
    fields: "id,status,effective_status,adset_id,creative{id}",
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
        message: "Meta created the duplicate ad but the new ad could not be verified.",
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
      resultingAdId: newAdId,
    };
  }

  const verifiedStatus = readStringField(verification.payload, "status");
  const verifiedAdsetId = readStringField(verification.payload, "adset_id");
  const verifiedCreativeId = readStringField(
    getNestedRecord(verification.payload, "creative"),
    "id",
  );
  if (
    verifiedStatus !== statusOption ||
    verifiedAdsetId !== input.targetAdsetId ||
    verifiedCreativeId !== adCreativeId
  ) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "silent_failure",
        message: "Meta created the duplicate ad but verification did not match the requested status, ad set, or creative.",
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
      resultingAdId: newAdId,
    };
  }

  return {
    ok: true,
    newAdId,
    newCreativeId: copyMode === "rebuild_creative" ? adCreativeId : null,
    verifiedStatus,
    responsePayload:
      creativeResponsePayload && write.payload
        ? { adcreative: creativeResponsePayload, ad: write.payload }
        : write.payload,
    verificationPayload: verification.payload,
  };
}
