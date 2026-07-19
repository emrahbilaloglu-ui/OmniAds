import { getMetaWriteBlockState } from "@/lib/meta/automation-control-plane";
import type { DecisionOriginAdExecutionBlocker } from "@/lib/creative-decision-engine/execution-safety";

export interface MetaAdsWriteContext {
  businessId: string;
  providerAccountId: string;
  accessToken: string;
}

export interface MetaAdsWriteOptions {
  dryRun?: boolean;
}

export interface MetaAdStatusMutationBaseline {
  businessId: string;
  providerAccountId: string;
  adId: string;
  creativeId: string;
  campaignId: string;
  adsetId: string;
}

export interface MetaAdStatusWriteOptions extends MetaAdsWriteOptions {
  /**
   * Runs only after all adapter-side read/precondition/write-block checks pass,
   * immediately before the single provider POST begins.
   */
  beforeMutationAttempt?: (
    baseline: MetaAdStatusMutationBaseline,
  ) => Promise<void>;
}

export interface MetaAdsWriteError {
  code: string;
  message: string;
}

export const META_PROVIDER_OUTCOME_AMBIGUOUS_CODE =
  "provider_outcome_ambiguous";

export interface MetaProviderMutationAttemptReceipt {
  attemptCount: 1;
  method: "POST";
  path: string;
  attemptedAt: string;
  completedAt: string;
  providerResponseReceived: boolean;
  providerResponseSuccessful?: boolean;
  httpStatus: number | null;
  outcome: "provider_response_received" | "outcome_ambiguous";
  automaticRetryAttempted: false;
  transportError: MetaAdsWriteError | null;
}

export interface MetaAdDuplicateSourceIdentity {
  adId: string | null;
  providerAccountId: string | null;
  creativeId: string | null;
  observedAt: string;
}

export type MetaAdExecutionStateReadBlocker = Extract<
  DecisionOriginAdExecutionBlocker,
  | "ad_not_found"
  | "ad_identity_mismatch"
  | "current_ad_state_unverified"
  | "current_ad_state_rejected"
  | "meta_account_unresolved"
  | "provider_account_mismatch"
>;

export interface MetaAdsWouldHaveWritten {
  method: MetaFetchMethod;
  path: string;
  body?: Record<string, unknown>;
}

export type MetaAdsWriteFailure = {
  ok: false;
  error: MetaAdsWriteError;
  httpStatus: number;
  providerMutationAttempted?: boolean;
  providerOutcome?: "definite_failure" | "outcome_ambiguous";
  mutationAttempt?: MetaProviderMutationAttemptReceipt | null;
  sourceIdentity?: MetaAdDuplicateSourceIdentity | null;
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
  mutationAttempt?: MetaProviderMutationAttemptReceipt | null;
  providerHttpStatus?: number | null;
};

export type MetaAdExecutionStateRead =
  | {
      ok: true;
      adId: string;
      providerAccountId: string;
      creativeId: string | null;
      campaignId: string | null;
      campaignConfiguredStatus: string | null;
      campaignEffectiveStatus: string | null;
      adsetId: string | null;
      adsetConfiguredStatus: string | null;
      adsetEffectiveStatus: string | null;
      configuredStatus: string | null;
      effectiveStatus: string | null;
      policyEligible: boolean | null;
      reviewStatus: string | null;
      observedAt: string;
      /**
       * Present on every provider-backed runtime success. Optional only for
       * backwards-compatible typed test doubles; callers that need durable
       * evidence must fail closed when it is absent.
       */
      providerGetEvidence?: Record<string, unknown>;
    }
  | {
      ok: false;
      adId: string | null;
      error: MetaAdsWriteError;
      httpStatus: number | null;
      preflightBlocker: MetaAdExecutionStateReadBlocker;
    };

type MetaAdExecutionStateReadSuccess = Extract<
  MetaAdExecutionStateRead,
  { ok: true }
>;

interface ExactMetaAdStatusWriteGeometry {
  adId: string;
  providerAccountId: string;
  creativeId: string;
  campaignId: string;
  adsetId: string;
  configuredStatus: string;
  effectiveStatus: string;
  campaignConfiguredStatus: string;
  campaignEffectiveStatus: string;
  adsetConfiguredStatus: string;
  adsetEffectiveStatus: string;
  policyEligible: boolean;
  reviewStatus: string | null;
  observedAt: string;
  providerGetEvidence: Record<string, unknown>;
}

export type MetaEntityExecutionScope = "campaign" | "adset";

export type MetaEntityExecutionStateRead =
  | {
      ok: true;
      scopeType: MetaEntityExecutionScope;
      entityId: string;
      providerAccountId: string;
      configuredStatus: string | null;
      effectiveStatus: string | null;
      campaignId: string | null;
      campaignProviderAccountId: string | null;
      campaignConfiguredStatus: string | null;
      campaignEffectiveStatus: string | null;
      observedAt: string;
    }
  | {
      ok: false;
      scopeType: MetaEntityExecutionScope;
      entityId: string | null;
      error: MetaAdsWriteError;
      httpStatus: number | null;
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
  sourceIdentity: MetaAdDuplicateSourceIdentity;
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
  sourceIdentity: MetaAdDuplicateSourceIdentity;
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
export const META_ADS_PROVIDER_FETCH_TIMEOUT_MS = 30_000;

function isMetaAdsWriteKillSwitchEngaged() {
  const value = process.env.META_ADS_WRITE_KILL_SWITCH?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function killSwitchFailure(): MetaAdsWriteFailure {
  return {
    ok: false,
    httpStatus: 503,
    providerMutationAttempted: false,
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
    providerMutationAttempted: false,
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

export function isMetaProviderOutcomeAmbiguous(
  result: Pick<MetaAdsWriteFailure, "error" | "providerOutcome">,
) {
  return (
    result.providerOutcome === "outcome_ambiguous" ||
    result.error.code === META_PROVIDER_OUTCOME_AMBIGUOUS_CODE
  );
}

export function metaAdsWriteFailureLogStatus(
  result: Pick<
    MetaAdsWriteFailure,
    "error" | "providerOutcome" | "mutationAttempt"
  >,
): "failure" | "silent_failure" {
  return result.error.code === "silent_failure" ||
    hasSuccessfulMetaProviderMutationAttempt(result) ||
    isMetaProviderOutcomeAmbiguous(result)
    ? "silent_failure"
    : "failure";
}

export function hasSuccessfulMetaProviderMutationAttempt(
  result: Pick<MetaAdsWriteFailure, "mutationAttempt">,
) {
  return result.mutationAttempt?.providerResponseSuccessful === true;
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

const RETRYABLE_META_READ_ERROR_CODES = new Set([
  "network_error",
  "rate_limited",
  "4",
  "17",
  "32",
  "613",
]);

function classifyMetaAdExecutionReadFailure(input: {
  httpStatus: number | null;
  error: MetaAdsWriteError;
}): MetaAdExecutionStateReadBlocker {
  const code = input.error.code.trim().toLowerCase();
  const status = input.httpStatus;
  if (
    RETRYABLE_META_READ_ERROR_CODES.has(code) ||
    status === 429 ||
    (status != null && status >= 500)
  ) {
    return "current_ad_state_unverified";
  }
  if (status === 404 || code === "100" || code === "ad_not_found") {
    return "ad_not_found";
  }
  if (
    status === 401 ||
    status === 403 ||
    code === "102" ||
    code === "190" ||
    code === "200"
  ) {
    return "meta_account_unresolved";
  }
  if (status != null && status >= 400 && status < 500) {
    return "current_ad_state_rejected";
  }
  return "current_ad_state_unverified";
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

function normalizeProviderAccountId(providerAccountId: string) {
  const numericId = getAccountNumericId(providerAccountId);
  return numericId ? `act_${numericId}` : "";
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
  const result = await metaFetchWriteOnce({
    ctx,
    path: `act_${accountNumericId}/adimages`,
    method: "POST",
    body,
  });
  if (result.error) {
    return buildWriteTransportFailure({
      error: result.error,
      payload: result.payload,
      mutationAttempt: result.mutationAttempt,
    });
  }
  const httpStatus = result.response?.status ?? 502;
  if (!result.response?.ok || isFailureBody(result.payload)) {
    return buildWriteFailure({
      payload: result.payload,
      httpStatus,
      fallbackCode: "meta_image_upload_failed",
      fallbackMessage:
        "Meta failed to upload the source image into the target account.",
      mutationAttempt: result.mutationAttempt,
    });
  }
  const hash = extractAdImageHash(result.payload);
  if (!hash) {
    return buildWriteFailure({
      payload: result.payload,
      httpStatus: 502,
      fallbackCode: "silent_failure",
      fallbackMessage:
        "Meta accepted the image upload but did not return an image hash.",
      mutationAttempt: result.mutationAttempt,
    });
  }
  return { ok: true as const, hash };
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
  if (!imageUrl) return null;
  const upload = await uploadAdImageFromUrl(ctx, imageUrl);
  if (!upload.ok) return upload;
  record[hashKey] = upload.hash;
  delete record.picture;
  delete record.image_url;
  delete record.url;
  delete record.original_url;
  return null;
}

async function prepareObjectStorySpecForTarget(
  ctx: MetaAdsWriteContext,
  objectStorySpec: Record<string, unknown>,
) {
  const linkData = getNestedRecord(objectStorySpec, "link_data");
  if (linkData) {
    const linkFailure = await replaceImageUrlWithTargetHash(
      ctx,
      linkData,
      "image_hash",
    );
    if (linkFailure) return linkFailure;
    const childAttachments = Array.isArray(linkData.child_attachments)
      ? linkData.child_attachments
      : [];
    for (const attachment of childAttachments) {
      if (!isRecord(attachment)) continue;
      const attachmentFailure = await replaceImageUrlWithTargetHash(
        ctx,
        attachment,
        "image_hash",
      );
      if (attachmentFailure) return attachmentFailure;
    }
  }

  const photoData = getNestedRecord(objectStorySpec, "photo_data");
  if (photoData) {
    const photoFailure = await replaceImageUrlWithTargetHash(
      ctx,
      photoData,
      "image_hash",
    );
    if (photoFailure) return photoFailure;
  }
  return null;
}

async function prepareAssetFeedSpecForTarget(
  ctx: MetaAdsWriteContext,
  assetFeedSpec: Record<string, unknown>,
) {
  const images = Array.isArray(assetFeedSpec.images) ? assetFeedSpec.images : [];
  for (const image of images) {
    if (!isRecord(image)) continue;
    const imageFailure = await replaceImageUrlWithTargetHash(
      ctx,
      image,
      "hash",
    );
    if (imageFailure) return imageFailure;
  }
  return null;
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
    const preparationFailure = await prepareObjectStorySpecForTarget(
      input.ctx,
      objectStorySpec,
    );
    if (preparationFailure) return preparationFailure;
    const pruned = pruneCreativeValue(objectStorySpec);
    if (isRecord(pruned)) body.set("object_story_spec", JSON.stringify(pruned));
  }

  const assetFeedSpec = cloneRecord(getNestedRecord(input.sourceCreative, "asset_feed_spec"));
  if (assetFeedSpec) {
    const preparationFailure = await prepareAssetFeedSpecForTarget(
      input.ctx,
      assetFeedSpec,
    );
    if (preparationFailure) return preparationFailure;
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

  const write = await metaFetchWriteOnce({
    ctx: input.ctx,
    path: `act_${accountNumericId}/adcreatives`,
    method: "POST",
    body,
  });
  if (write.error) {
    return buildWriteTransportFailure({
      error: write.error,
      payload: write.payload,
      mutationAttempt: write.mutationAttempt,
    });
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_creative_rebuild_failed",
      fallbackMessage: "Meta failed to recreate the source ad creative in the target account.",
      mutationAttempt: write.mutationAttempt,
    });
  }
  const creativeId = readStringField(write.payload, "id");
  if (!creativeId) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus: 502,
      fallbackCode: "silent_failure",
      fallbackMessage: "Meta returned success but did not return a recreated creative id.",
      mutationAttempt: write.mutationAttempt,
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
      redirect: input.method === "POST" ? "error" : "follow",
      signal: AbortSignal.timeout(META_ADS_PROVIDER_FETCH_TIMEOUT_MS),
    });
    const payload = await readResponseJson(response);
    return { response, payload, error: null };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "";
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const timedOut =
      errorName === "AbortError" ||
      errorName === "TimeoutError" ||
      /timed out|timeout|abort|aborted/i.test(errorMessage);
    return {
      response: null,
      payload: null,
      error: {
        code: "network_error",
        message: sanitizeMetaMessage(
          timedOut
            ? `Meta provider ${input.method} timed out after ${META_ADS_PROVIDER_FETCH_TIMEOUT_MS}ms.`
            : errorMessage,
        ),
      },
    };
  }
}

async function metaFetchWriteOnce(input: {
  ctx: MetaAdsWriteContext;
  path: string;
  method: "POST";
  body?: URLSearchParams;
  beforeMutationAttempt?: () => Promise<void>;
}): Promise<{
  response: Response | null;
  payload: Record<string, unknown> | null;
  error: MetaAdsWriteError | null;
  mutationAttempt: MetaProviderMutationAttemptReceipt | null;
}> {
  const initialBlock = await getMetaAdsWriteBlockFailure(input.ctx);
  if (initialBlock) {
    return {
      response: null,
      payload: null,
      error: initialBlock.error,
      mutationAttempt: null,
    };
  }
  try {
    await input.beforeMutationAttempt?.();
  } catch (error) {
    const typedError =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string; message?: unknown })
        : null;
    return {
      response: null,
      payload: null,
      error: {
        code: typedError?.code ?? "before_mutation_attempt_failed",
        message: sanitizeMetaMessage(
          typedError && typeof typedError.message === "string"
            ? typedError.message
            : error instanceof Error
              ? error.message
              : String(error),
        ),
      },
      mutationAttempt: null,
    };
  }
  // Provider POSTs have no provider-side idempotency contract. A transport
  // exception after request upload can hide a committed mutation, so never
  // issue a second POST automatically. An HTTP rejection is definitive and
  // remains an ordinary failure.
  const attemptedAt = new Date().toISOString();
  const result = await metaFetch(input);
  const completedAt = new Date().toISOString();
  const providerResponseReceived = result.response != null;
  const providerResponseSuccessful = Boolean(
    result.response?.ok && !isFailureBody(result.payload),
  );
  return {
    ...result,
    mutationAttempt: {
      attemptCount: 1,
      method: "POST",
      path: input.path,
      attemptedAt,
      completedAt,
      providerResponseReceived,
      providerResponseSuccessful,
      httpStatus: result.response?.status ?? null,
      outcome: providerResponseReceived
        ? "provider_response_received"
        : "outcome_ambiguous",
      automaticRetryAttempted: false,
      transportError: providerResponseReceived ? null : result.error,
    },
  };
}

function buildAmbiguousWriteFailure(input: {
  error: MetaAdsWriteError;
  mutationAttempt: MetaProviderMutationAttemptReceipt;
  sourceIdentity?: MetaAdDuplicateSourceIdentity | null;
}): MetaAdsWriteFailure {
  const message =
    "Meta POST transport failed after the single mutation attempt began. " +
    "The provider outcome is unknown; do not issue another write until the exact provider state is reconciled.";
  return {
    ok: false,
    httpStatus: 502,
    providerMutationAttempted: true,
    providerOutcome: "outcome_ambiguous",
    mutationAttempt: input.mutationAttempt,
    error: {
      code: META_PROVIDER_OUTCOME_AMBIGUOUS_CODE,
      message,
    },
    ...(input.sourceIdentity === undefined
      ? {}
      : { sourceIdentity: input.sourceIdentity }),
    responsePayload: {
      provider_outcome: "outcome_ambiguous",
      mutation_attempt: input.mutationAttempt,
      transport_error: input.error,
      reconciliation_required: true,
      retry_disposition: "do_not_retry_before_exact_provider_reconciliation",
    },
    verificationPayload: null,
  };
}

function buildWriteTransportFailure(input: {
  error: MetaAdsWriteError;
  payload: Record<string, unknown> | null;
  mutationAttempt: MetaProviderMutationAttemptReceipt | null;
  sourceIdentity?: MetaAdDuplicateSourceIdentity | null;
}): MetaAdsWriteFailure {
  if (input.mutationAttempt?.outcome === "outcome_ambiguous") {
    return buildAmbiguousWriteFailure({
      error: input.error,
      mutationAttempt: input.mutationAttempt,
      ...(input.sourceIdentity === undefined
        ? {}
        : { sourceIdentity: input.sourceIdentity }),
    });
  }
  return {
    ok: false,
    httpStatus: metaWriteErrorStatus(input.error),
    providerMutationAttempted: input.mutationAttempt != null,
    error: input.error,
    ...(input.sourceIdentity === undefined
      ? {}
      : { sourceIdentity: input.sourceIdentity }),
    responsePayload: input.payload,
  };
}

function buildWriteFailure(input: {
  payload: Record<string, unknown> | null;
  httpStatus: number;
  fallbackCode: string;
  fallbackMessage: string;
  mutationAttempt?: MetaProviderMutationAttemptReceipt | null;
  verificationPayload?: Record<string, unknown> | null;
  resultingAdId?: string | null;
}): MetaAdsWriteFailure {
  return {
    ok: false,
    httpStatus: input.httpStatus,
    providerMutationAttempted: input.mutationAttempt != null,
    providerOutcome: input.mutationAttempt
      ? "definite_failure"
      : undefined,
    mutationAttempt: input.mutationAttempt ?? undefined,
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
    fields:
      "id,account_id,name,status,effective_status,creative{id},adset{id,status,effective_status},campaign{id,status,effective_status}",
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
  const verifiedAdId = readStringField(result.payload, "id");
  const verifiedProviderAccountId = normalizeProviderAccountId(
    readStringField(result.payload, "account_id"),
  );
  if (
    verifiedAdId !== input.adId ||
    !verifiedProviderAccountId ||
    verifiedProviderAccountId !==
      normalizeProviderAccountId(input.ctx.providerAccountId)
  ) {
    return {
      ok: false,
      httpStatus: 502,
      payload: result.payload,
      error: {
        code:
          verifiedAdId !== input.adId
            ? "ad_identity_mismatch"
            : "provider_account_mismatch",
        message:
          verifiedAdId !== input.adId
            ? "Meta verification resolved to a different ad."
            : "Meta verification did not prove the expected provider account.",
      },
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
    fields:
      "id,account_id,status,effective_status,creative{id},adset{id,status,effective_status},campaign{id,status,effective_status}",
  });
  if (
    result.error ||
    !result.response?.ok ||
    isFailureBody(result.payload)
  ) {
    const error =
      result.error ??
      getMetaError(result.payload, {
        code: "current_ad_state_unverified",
        message: "Meta current ad state could not be verified.",
      });
    const httpStatus = result.response?.status ?? null;
    return {
      ok: false,
      adId,
      error,
      httpStatus,
      preflightBlocker: classifyMetaAdExecutionReadFailure({
        httpStatus,
        error,
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
      httpStatus: result.response.status,
      preflightBlocker: "ad_identity_mismatch",
    };
  }
  const providerAccountId = normalizeProviderAccountId(
    readStringField(result.payload, "account_id"),
  );
  const expectedProviderAccountId = normalizeProviderAccountId(
    ctx.providerAccountId,
  );
  if (!providerAccountId) {
    return {
      ok: false,
      adId: resolvedAdId,
      error: {
        code: "meta_account_unresolved",
        message: "Meta current ad state omitted account identity.",
      },
      httpStatus: result.response.status,
      preflightBlocker: "meta_account_unresolved",
    };
  }
  if (providerAccountId !== expectedProviderAccountId) {
    return {
      ok: false,
      adId: resolvedAdId,
      error: {
        code: "provider_account_mismatch",
        message: "Meta current ad state belongs to a different provider account.",
      },
      httpStatus: result.response.status,
      preflightBlocker: "provider_account_mismatch",
    };
  }
  const configuredStatus =
    readStringField(result.payload, "status") || null;
  const effectiveStatus =
    readStringField(result.payload, "effective_status") || null;
  const campaign = getNestedRecord(result.payload, "campaign");
  const adset = getNestedRecord(result.payload, "adset");
  const campaignId = readStringField(campaign, "id") || null;
  const campaignConfiguredStatus =
    readStringField(campaign, "status") || null;
  const campaignEffectiveStatus =
    readStringField(campaign, "effective_status") || null;
  const adsetId = readStringField(adset, "id") || null;
  const adsetConfiguredStatus = readStringField(adset, "status") || null;
  const adsetEffectiveStatus =
    readStringField(adset, "effective_status") || null;
  const creativeId =
    readStringField(getNestedRecord(result.payload, "creative"), "id") || null;
  const normalizedEffectiveStatus = effectiveStatus?.toUpperCase() ?? null;
  return {
    ok: true,
    adId: resolvedAdId,
    providerAccountId,
    creativeId,
    campaignId,
    campaignConfiguredStatus,
    campaignEffectiveStatus,
    adsetId,
    adsetConfiguredStatus,
    adsetEffectiveStatus,
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
    providerGetEvidence: cloneRecord(result.payload)!,
  };
}

function serializeAdStatusWriteObservation(
  state: MetaAdExecutionStateReadSuccess,
) {
  return {
    adId: state.adId,
    providerAccountId: state.providerAccountId,
    creativeId: state.creativeId,
    campaignId: state.campaignId,
    adsetId: state.adsetId,
    configuredStatus: state.configuredStatus,
    effectiveStatus: state.effectiveStatus,
    campaignConfiguredStatus: state.campaignConfiguredStatus,
    campaignEffectiveStatus: state.campaignEffectiveStatus,
    adsetConfiguredStatus: state.adsetConfiguredStatus,
    adsetEffectiveStatus: state.adsetEffectiveStatus,
    policyEligible: state.policyEligible,
    reviewStatus: state.reviewStatus,
    observedAt: state.observedAt,
    providerGetEvidence: cloneRecord(state.providerGetEvidence ?? null),
  };
}

function buildAdStatusWriteVerificationFailurePayload(input: {
  reason: string;
  state?: MetaAdExecutionStateReadSuccess | null;
}) {
  return {
    verificationFailureReason: input.reason,
    ...(input.state
      ? { observedExecutionState: serializeAdStatusWriteObservation(input.state) }
      : {}),
  };
}

function parseExactAdStatusWriteGeometry(
  state: MetaAdExecutionStateReadSuccess,
):
  | { ok: true; geometry: ExactMetaAdStatusWriteGeometry }
  | {
      ok: false;
      error: MetaAdsWriteError;
      verificationPayload: Record<string, unknown>;
    } {
  const requiredFields = [
    ["creativeId", state.creativeId],
    ["campaignId", state.campaignId],
    ["adsetId", state.adsetId],
    ["configuredStatus", state.configuredStatus],
    ["effectiveStatus", state.effectiveStatus],
    ["campaignConfiguredStatus", state.campaignConfiguredStatus],
    ["campaignEffectiveStatus", state.campaignEffectiveStatus],
    ["adsetConfiguredStatus", state.adsetConfiguredStatus],
    ["adsetEffectiveStatus", state.adsetEffectiveStatus],
    ["observedAt", state.observedAt],
  ] as const;
  const missingField = requiredFields.find(
    ([, value]) => typeof value !== "string" || value.length === 0,
  )?.[0];
  if (missingField || !state.providerGetEvidence) {
    const reason = missingField
      ? `missing_${missingField}`
      : "missing_provider_get_evidence";
    return {
      ok: false,
      error: {
        code: "verification_failed",
        message:
          "Meta ad status verification omitted required exact execution-state evidence.",
      },
      verificationPayload: buildAdStatusWriteVerificationFailurePayload({
        reason,
        state,
      }),
    };
  }

  return {
    ok: true,
    geometry: {
      adId: state.adId,
      providerAccountId: state.providerAccountId,
      creativeId: state.creativeId!,
      campaignId: state.campaignId!,
      adsetId: state.adsetId!,
      configuredStatus: state.configuredStatus!,
      effectiveStatus: state.effectiveStatus!,
      campaignConfiguredStatus: state.campaignConfiguredStatus!,
      campaignEffectiveStatus: state.campaignEffectiveStatus!,
      adsetConfiguredStatus: state.adsetConfiguredStatus!,
      adsetEffectiveStatus: state.adsetEffectiveStatus!,
      policyEligible: state.policyEligible === true,
      reviewStatus: state.reviewStatus,
      observedAt: state.observedAt,
      providerGetEvidence: cloneRecord(state.providerGetEvidence)!,
    },
  };
}

function findAdStatusWriteVerificationDrift(input: {
  before: ExactMetaAdStatusWriteGeometry;
  after: ExactMetaAdStatusWriteGeometry;
  requestedStatus: "ACTIVE" | "PAUSED";
}) {
  const identityFields = [
    ["adId", input.before.adId, input.after.adId],
    [
      "providerAccountId",
      input.before.providerAccountId,
      input.after.providerAccountId,
    ],
    ["creativeId", input.before.creativeId, input.after.creativeId],
    ["campaignId", input.before.campaignId, input.after.campaignId],
    ["adsetId", input.before.adsetId, input.after.adsetId],
  ] as const;
  const identityDrift = identityFields.find(
    ([, expected, observed]) => expected !== observed,
  );
  if (identityDrift) return `${identityDrift[0]}_drift`;
  if (input.after.configuredStatus !== input.requestedStatus) {
    return "configured_status_mismatch";
  }
  if (input.after.effectiveStatus !== input.requestedStatus) {
    return "effective_status_mismatch";
  }
  if (input.after.campaignConfiguredStatus !== "ACTIVE") {
    return "campaign_configured_status_not_active";
  }
  if (input.after.campaignEffectiveStatus !== "ACTIVE") {
    return "campaign_effective_status_not_active";
  }
  if (input.after.adsetConfiguredStatus !== "ACTIVE") {
    return "adset_configured_status_not_active";
  }
  if (input.after.adsetEffectiveStatus !== "ACTIVE") {
    return "adset_effective_status_not_active";
  }
  if (!input.after.policyEligible) return "policy_not_eligible";
  if (input.after.reviewStatus !== null) return "review_status_present";
  return null;
}

function findAdStatusWritePreconditionBlocker(input: {
  before: ExactMetaAdStatusWriteGeometry;
  requestedStatus: "ACTIVE" | "PAUSED";
}): MetaAdsWriteError & { reason: string } | null {
  if (!input.before.policyEligible) {
    return {
      code: "ad_policy_precondition_failed",
      message:
        "Meta ad status write blocked because the current ad is not policy eligible.",
      reason: "policy_not_eligible",
    };
  }
  if (input.before.reviewStatus !== null) {
    return {
      code: "ad_policy_precondition_failed",
      message:
        "Meta ad status write blocked because the current ad has an active review state.",
      reason: "review_status_present",
    };
  }

  const requiredCurrentStatus =
    input.requestedStatus === "PAUSED" ? "ACTIVE" : "PAUSED";
  if (
    input.before.configuredStatus === input.requestedStatus &&
    input.before.effectiveStatus === input.requestedStatus
  ) {
    return {
      code: "ad_status_already_requested",
      message:
        "Meta ad status write blocked because the ad is already in the requested exact state.",
      reason: "already_requested_state",
    };
  }
  if (input.before.configuredStatus !== requiredCurrentStatus) {
    return {
      code: "ad_status_precondition_failed",
      message:
        "Meta ad status write blocked because configured status does not satisfy the exact transition precondition.",
      reason: "configured_status_precondition_failed",
    };
  }
  if (input.before.effectiveStatus !== requiredCurrentStatus) {
    return {
      code: "ad_status_precondition_failed",
      message:
        "Meta ad status write blocked because effective status does not satisfy the exact transition precondition.",
      reason: "effective_status_precondition_failed",
    };
  }
  if (input.before.campaignConfiguredStatus !== "ACTIVE") {
    return {
      code: "campaign_status_precondition_failed",
      message:
        "Meta ad status write blocked because the campaign configured status is not ACTIVE.",
      reason: "campaign_configured_status_not_active",
    };
  }
  if (input.before.campaignEffectiveStatus !== "ACTIVE") {
    return {
      code: "campaign_status_precondition_failed",
      message:
        "Meta ad status write blocked because the campaign effective status is not ACTIVE.",
      reason: "campaign_effective_status_not_active",
    };
  }
  if (input.before.adsetConfiguredStatus !== "ACTIVE") {
    return {
      code: "adset_status_precondition_failed",
      message:
        "Meta ad status write blocked because the ad set configured status is not ACTIVE.",
      reason: "adset_configured_status_not_active",
    };
  }
  if (input.before.adsetEffectiveStatus !== "ACTIVE") {
    return {
      code: "adset_status_precondition_failed",
      message:
        "Meta ad status write blocked because the ad set effective status is not ACTIVE.",
      reason: "adset_effective_status_not_active",
    };
  }
  return null;
}

function buildAdStatusWriteVerificationPayload(
  geometry: ExactMetaAdStatusWriteGeometry,
) {
  return {
    contractVersion: "meta-ad-status-write-verification.v1",
    adId: geometry.adId,
    providerAccountId: geometry.providerAccountId,
    creativeId: geometry.creativeId,
    campaignId: geometry.campaignId,
    adsetId: geometry.adsetId,
    configuredStatus: geometry.configuredStatus,
    effectiveStatus: geometry.effectiveStatus,
    campaignConfiguredStatus: geometry.campaignConfiguredStatus,
    campaignEffectiveStatus: geometry.campaignEffectiveStatus,
    adsetConfiguredStatus: geometry.adsetConfiguredStatus,
    adsetEffectiveStatus: geometry.adsetEffectiveStatus,
    policyEligible: true,
    reviewStatus: null,
    observedAt: geometry.observedAt,
    providerGetEvidence: cloneRecord(geometry.providerGetEvidence)!,
  };
}

/**
 * Live, read-only entity state for manual campaign/ad-set write preflights.
 * Provider identity is taken from Meta's response and must match the selected
 * write context; it is never inferred from the context itself.
 */
export async function readMetaEntityExecutionState(
  ctx: MetaAdsWriteContext,
  scopeType: MetaEntityExecutionScope,
  entityId: string,
): Promise<MetaEntityExecutionStateRead> {
  const result = await metaFetch({
    ctx,
    path: entityId,
    method: "GET",
    fields:
      scopeType === "campaign"
        ? "id,account_id,status,effective_status"
        : "id,account_id,status,effective_status,campaign{id}",
  });
  if (
    result.error ||
    !result.response?.ok ||
    isFailureBody(result.payload)
  ) {
    return {
      ok: false,
      scopeType,
      entityId,
      error:
        result.error ??
        getMetaError(result.payload, {
          code: "current_entity_state_unverified",
          message: "Meta current entity state could not be verified.",
        }),
      httpStatus: result.response?.status ?? null,
    };
  }

  const resolvedEntityId = readStringField(result.payload, "id");
  const providerAccountId = normalizeProviderAccountId(
    readStringField(result.payload, "account_id"),
  );
  const expectedProviderAccountId = normalizeProviderAccountId(
    ctx.providerAccountId,
  );
  if (resolvedEntityId !== entityId) {
    return {
      ok: false,
      scopeType,
      entityId: resolvedEntityId || null,
      error: {
        code: "entity_identity_mismatch",
        message: "Meta current entity state resolved to a different entity.",
      },
      httpStatus: result.response.status,
    };
  }
  if (!providerAccountId || providerAccountId !== expectedProviderAccountId) {
    return {
      ok: false,
      scopeType,
      entityId: resolvedEntityId,
      error: {
        code: providerAccountId
          ? "provider_account_mismatch"
          : "meta_account_unresolved",
        message: providerAccountId
          ? "Meta current entity state belongs to a different provider account."
          : "Meta current entity state omitted account identity.",
      },
      httpStatus: result.response.status,
    };
  }

  let campaign =
    scopeType === "adset"
      ? getNestedRecord(result.payload, "campaign")
      : result.payload;
  if (scopeType === "adset") {
    const campaignId = readStringField(campaign, "id");
    if (campaignId) {
      const campaignResult = await metaFetch({
        ctx,
        path: campaignId,
        method: "GET",
        fields: "id,account_id,status,effective_status",
      });
      if (
        campaignResult.error ||
        !campaignResult.response?.ok ||
        isFailureBody(campaignResult.payload)
      ) {
        return {
          ok: false,
          scopeType,
          entityId: resolvedEntityId,
          error:
            campaignResult.error ??
            getMetaError(campaignResult.payload, {
              code: "current_hierarchy_state_unverified",
              message: "Meta parent campaign state could not be verified.",
            }),
          httpStatus: campaignResult.response?.status ?? null,
        };
      }
      const resolvedCampaignId = readStringField(
        campaignResult.payload,
        "id",
      );
      const campaignProviderAccountId = normalizeProviderAccountId(
        readStringField(campaignResult.payload, "account_id"),
      );
      if (resolvedCampaignId !== campaignId) {
        return {
          ok: false,
          scopeType,
          entityId: resolvedEntityId,
          error: {
            code: "entity_identity_mismatch",
            message: "Meta parent campaign resolved to a different entity.",
          },
          httpStatus: campaignResult.response.status,
        };
      }
      if (campaignProviderAccountId !== expectedProviderAccountId) {
        return {
          ok: false,
          scopeType,
          entityId: resolvedEntityId,
          error: {
            code: campaignProviderAccountId
              ? "provider_account_mismatch"
              : "meta_account_unresolved",
            message: campaignProviderAccountId
              ? "Meta parent campaign belongs to a different provider account."
              : "Meta parent campaign omitted account identity.",
          },
          httpStatus: campaignResult.response.status,
        };
      }
      campaign = campaignResult.payload;
    }
  }
  return {
    ok: true,
    scopeType,
    entityId: resolvedEntityId,
    providerAccountId,
    configuredStatus: readStringField(result.payload, "status") || null,
    effectiveStatus:
      readStringField(result.payload, "effective_status") || null,
    campaignId: readStringField(campaign, "id") || null,
    campaignProviderAccountId:
      normalizeProviderAccountId(readStringField(campaign, "account_id")) ||
      null,
    campaignConfiguredStatus:
      readStringField(campaign, "status") || null,
    campaignEffectiveStatus:
      readStringField(campaign, "effective_status") || null,
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
  const verifiedEntityId = readStringField(result.payload, "id");
  const verifiedProviderAccountId = normalizeProviderAccountId(
    readStringField(result.payload, "account_id"),
  );
  if (
    verifiedEntityId !== input.entityId ||
    !verifiedProviderAccountId ||
    verifiedProviderAccountId !==
      normalizeProviderAccountId(input.ctx.providerAccountId)
  ) {
    return {
      ok: false,
      httpStatus: 502,
      payload: result.payload,
      error: {
        code:
          verifiedEntityId !== input.entityId
            ? "entity_identity_mismatch"
            : "provider_account_mismatch",
        message:
          verifiedEntityId !== input.entityId
            ? "Meta verification resolved to a different entity."
            : "Meta verification did not prove the expected provider account.",
      },
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
      fields: "id,account_id,name,status,effective_status",
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
  const write = await metaFetchWriteOnce({
    ctx,
    path: entityId,
    method: "POST",
    body,
  });
  if (write.error) {
    return buildWriteTransportFailure({
      error: write.error,
      payload: write.payload,
      mutationAttempt: write.mutationAttempt,
    });
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_write_failed",
      fallbackMessage: `Meta failed to set ${entityLabel} status to ${status}.`,
      mutationAttempt: write.mutationAttempt,
    });
  }

  const verification = await verifyEntity({
    ctx,
    entityId,
    fields: "id,account_id,name,status,effective_status",
  });
  if (!verification.ok) {
    return {
      ok: false,
      httpStatus: verification.httpStatus,
      providerOutcome: "definite_failure",
      mutationAttempt: write.mutationAttempt,
      error:
        verification.error ?? {
          code: "verification_failed",
          message: `Meta accepted the ${entityLabel} status write, but verification failed.`,
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
      providerOutcome: "definite_failure",
      mutationAttempt: write.mutationAttempt,
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
  options: MetaAdStatusWriteOptions = {},
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

  // Bind the exact provider lineage immediately before the one allowed POST.
  // The caller routes perform their own authority preflight, but this client
  // must independently prevent a stale target from being reported as a
  // verified provider success.
  const beforeRead = await readMetaAdExecutionState(ctx, adId);
  if (!beforeRead.ok) {
    return {
      ok: false,
      httpStatus: beforeRead.httpStatus ?? 502,
      providerMutationAttempted: false,
      error: beforeRead.error,
      responsePayload: null,
      verificationPayload: buildAdStatusWriteVerificationFailurePayload({
        reason: beforeRead.preflightBlocker,
      }),
    };
  }
  const beforeGeometry = parseExactAdStatusWriteGeometry(beforeRead);
  if (!beforeGeometry.ok) {
    return {
      ok: false,
      httpStatus: 502,
      providerMutationAttempted: false,
      error: beforeGeometry.error,
      responsePayload: null,
      verificationPayload: beforeGeometry.verificationPayload,
    };
  }
  const preconditionBlocker = findAdStatusWritePreconditionBlocker({
    before: beforeGeometry.geometry,
    requestedStatus: status,
  });
  if (preconditionBlocker) {
    return {
      ok: false,
      httpStatus: 409,
      providerMutationAttempted: false,
      error: {
        code: preconditionBlocker.code,
        message: preconditionBlocker.message,
      },
      responsePayload: null,
      verificationPayload: buildAdStatusWriteVerificationFailurePayload({
        reason: preconditionBlocker.reason,
        state: beforeRead,
      }),
    };
  }

  const body = new URLSearchParams({ status });
  const mutationBaseline: MetaAdStatusMutationBaseline = {
    businessId: ctx.businessId,
    providerAccountId: beforeGeometry.geometry.providerAccountId,
    adId: beforeGeometry.geometry.adId,
    creativeId: beforeGeometry.geometry.creativeId,
    campaignId: beforeGeometry.geometry.campaignId,
    adsetId: beforeGeometry.geometry.adsetId,
  };
  const write = await metaFetchWriteOnce({
    ctx,
    path: adId,
    method: "POST",
    body,
    beforeMutationAttempt: options.beforeMutationAttempt
      ? () => options.beforeMutationAttempt!(mutationBaseline)
      : undefined,
  });
  if (write.error) {
    return buildWriteTransportFailure({
      error: write.error,
      payload: write.payload,
      mutationAttempt: write.mutationAttempt,
    });
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_write_failed",
      fallbackMessage: `Meta failed to set ad status to ${status}.`,
      mutationAttempt: write.mutationAttempt,
    });
  }

  const afterRead = await readMetaAdExecutionState(ctx, adId);
  if (!afterRead.ok) {
    return {
      ok: false,
      httpStatus: afterRead.httpStatus ?? 502,
      providerOutcome: "definite_failure",
      mutationAttempt: write.mutationAttempt,
      error: afterRead.error,
      responsePayload: write.payload,
      verificationPayload: buildAdStatusWriteVerificationFailurePayload({
        reason: afterRead.preflightBlocker,
      }),
    };
  }
  const afterGeometry = parseExactAdStatusWriteGeometry(afterRead);
  if (!afterGeometry.ok) {
    return {
      ok: false,
      httpStatus: 502,
      providerOutcome: "definite_failure",
      mutationAttempt: write.mutationAttempt,
      error: afterGeometry.error,
      responsePayload: write.payload,
      verificationPayload: afterGeometry.verificationPayload,
    };
  }
  const verificationDrift = findAdStatusWriteVerificationDrift({
    before: beforeGeometry.geometry,
    after: afterGeometry.geometry,
    requestedStatus: status,
  });
  if (verificationDrift) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "silent_failure",
        message:
          "Meta accepted the ad status write, but exact post-write execution-state verification failed.",
      },
      providerOutcome: "definite_failure",
      mutationAttempt: write.mutationAttempt,
      responsePayload: write.payload,
      verificationPayload: buildAdStatusWriteVerificationFailurePayload({
        reason: verificationDrift,
        state: afterRead,
      }),
    };
  }

  const verificationPayload = buildAdStatusWriteVerificationPayload(
    afterGeometry.geometry,
  );
  return {
    ok: true,
    verifiedStatus: afterGeometry.geometry.configuredStatus,
    responsePayload: write.payload,
    verificationPayload,
    mutationAttempt: write.mutationAttempt,
    providerHttpStatus: httpStatus,
  };
}

export async function pauseAd(
  ctx: MetaAdsWriteContext,
  adId: string,
  options: MetaAdStatusWriteOptions = {},
): Promise<MetaAdStatusWriteSuccess | MetaAdsWriteFailure> {
  return updateAdStatus(ctx, adId, "PAUSED", options);
}

export async function resumeAd(
  ctx: MetaAdsWriteContext,
  adId: string,
  options: MetaAdStatusWriteOptions = {},
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
      fields:
        "id,account_id,name,bid_amount,bid_strategy,status,effective_status",
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
  const write = await metaFetchWriteOnce({
    ctx,
    path: input.adsetId,
    method: "POST",
    body,
  });
  if (write.error) {
    return buildWriteTransportFailure({
      error: write.error,
      payload: write.payload,
      mutationAttempt: write.mutationAttempt,
    });
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_bid_write_failed",
      fallbackMessage: "Meta failed to update the ad set bid amount.",
      mutationAttempt: write.mutationAttempt,
    });
  }

  const verification = await verifyEntity({
    ctx,
    entityId: input.adsetId,
    fields:
      "id,account_id,name,bid_amount,bid_strategy,status,effective_status",
  });
  if (!verification.ok) {
    return {
      ok: false,
      httpStatus: verification.httpStatus,
      providerOutcome: "definite_failure",
      mutationAttempt: write.mutationAttempt,
      error:
        verification.error ?? {
          code: "verification_failed",
          message: "Meta accepted the ad set bid write, but verification failed.",
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
      providerOutcome: "definite_failure",
      mutationAttempt: write.mutationAttempt,
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
  expectedSourceCreativeId?: string;
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
        ? "id,name,account_id,status,effective_status,creative{id,name,object_type,object_story_id,effective_object_story_id,url_tags,object_story_spec{page_id,instagram_actor_id,link_data{link,message,name,description,picture,image_hash,call_to_action{type,value{link}},child_attachments{link,name,description,picture,image_hash,call_to_action{type,value{link}}}},video_data{video_id,message,title,image_url,thumbnail_url,call_to_action{type,value{link}}},photo_data{message,caption,url,image_hash,call_to_action{type,value{link}}},template_data},asset_feed_spec{bodies{text},titles{text},descriptions{text},images{hash,url,image_url,original_url},videos{video_id,thumbnail_url,image_url}}},adset_id"
        : "id,name,account_id,status,effective_status,creative{id},adset_id",
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
  const sourceAdId = readStringField(sourceAd.payload, "id");
  const sourceProviderAccountId = normalizeProviderAccountId(
    readStringField(sourceAd.payload, "account_id"),
  );
  const sourceCreativeId =
    readStringField(
      getNestedRecord(sourceAd.payload, "creative"),
      "id",
    ) || null;
  const sourceIdentity: MetaAdDuplicateSourceIdentity = {
    adId: sourceAdId || null,
    providerAccountId: sourceProviderAccountId || null,
    creativeId: sourceCreativeId,
    observedAt: new Date().toISOString(),
  };
  if (
    sourceAdId !== input.adId ||
    !sourceProviderAccountId ||
    sourceProviderAccountId !== normalizeProviderAccountId(ctx.providerAccountId)
  ) {
    return {
      ok: false,
      httpStatus: 409,
      error: {
        code:
          sourceAdId !== input.adId
            ? "source_ad_identity_mismatch"
            : "provider_account_mismatch",
        message:
          sourceAdId !== input.adId
            ? "Meta source ad resolved to a different ad."
            : "Meta source ad did not prove the expected provider account.",
      },
      sourceIdentity,
      responsePayload: sourceAd.payload,
    };
  }

  if (!sourceCreativeId) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "source_ad_fetch_failed",
        message: "Meta source ad fetch did not include creative.id.",
      },
      sourceIdentity,
      responsePayload: sourceAd.payload,
    };
  }
  if (
    input.expectedSourceCreativeId &&
    sourceCreativeId !== input.expectedSourceCreativeId
  ) {
    return {
      ok: false,
      httpStatus: 409,
      error: {
        code: "creative_identity_mismatch",
        message: "Meta source ad no longer references the expected creative.",
      },
      sourceIdentity,
      responsePayload: sourceAd.payload,
    };
  }
  const sourceEffectiveStatus = readStringField(
    sourceAd.payload,
    "effective_status",
  ).toUpperCase();
  if (
    !sourceEffectiveStatus ||
    POLICY_BLOCKED_AD_STATUSES.has(sourceEffectiveStatus)
  ) {
    return {
      ok: false,
      httpStatus: 409,
      error: {
        code: sourceEffectiveStatus
          ? "policy_blocked"
          : "policy_state_unverified",
        message: sourceEffectiveStatus
          ? `Meta source ad is ${sourceEffectiveStatus.toLowerCase()} and cannot be duplicated.`
          : "Meta source ad policy state could not be verified.",
      },
      sourceIdentity,
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
        sourceIdentity,
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
      if (!rebuiltCreative.ok) {
        return { ...rebuiltCreative, sourceIdentity };
      }
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
      sourceIdentity,
      verifiedStatus: statusOption,
      dryRun: true,
      wouldHaveWritten,
      responsePayload: dryRunPayload(wouldHaveWritten),
      verificationPayload: sourceAd.payload,
    };
  }

  const write = await metaFetchWriteOnce({
    ctx,
    path: `act_${accountNumericId}/ads`,
    method: "POST",
    body,
  });
  if (write.error) {
    return buildWriteTransportFailure({
      error: write.error,
      payload: write.payload,
      mutationAttempt: write.mutationAttempt,
      sourceIdentity,
    });
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return {
      ...buildWriteFailure({
        payload: write.payload,
        httpStatus,
        fallbackCode: "meta_duplicate_failed",
        fallbackMessage: "Meta failed to create the duplicate ad.",
        mutationAttempt: write.mutationAttempt,
      }),
      sourceIdentity,
    };
  }

  const newAdId = readStringField(write.payload, "id");
  if (!newAdId) {
    return {
      ok: false,
      httpStatus: 502,
      providerOutcome: "definite_failure",
      mutationAttempt: write.mutationAttempt,
      error: {
        code: "silent_failure",
        message: "Meta returned success but did not return a new ad id.",
      },
      sourceIdentity,
      responsePayload: write.payload,
    };
  }

  const verification = await metaFetch({
    ctx,
    path: newAdId,
    method: "GET",
    fields: "id,account_id,status,effective_status,adset_id,creative{id}",
  });
  if (
    verification.error ||
    !verification.response?.ok ||
    isFailureBody(verification.payload)
  ) {
    return {
      ok: false,
      httpStatus: verification.response?.status ?? 502,
      providerOutcome: "definite_failure",
      mutationAttempt: write.mutationAttempt,
      error: {
        code: "silent_failure",
        message: "Meta created the duplicate ad but the new ad could not be verified.",
      },
      sourceIdentity,
      responsePayload: write.payload,
      verificationPayload: verification.payload,
      resultingAdId: newAdId,
    };
  }

  const verifiedStatus = readStringField(verification.payload, "status");
  const verifiedAdId = readStringField(verification.payload, "id");
  const verifiedProviderAccountId = normalizeProviderAccountId(
    readStringField(verification.payload, "account_id"),
  );
  const verifiedAdsetId = readStringField(verification.payload, "adset_id");
  const verifiedCreativeId = readStringField(
    getNestedRecord(verification.payload, "creative"),
    "id",
  );
  if (
    verifiedStatus !== statusOption ||
    verifiedAdId !== newAdId ||
    verifiedProviderAccountId !==
      normalizeProviderAccountId(ctx.providerAccountId) ||
    verifiedAdsetId !== input.targetAdsetId ||
    verifiedCreativeId !== adCreativeId
  ) {
    return {
      ok: false,
      httpStatus: 502,
      providerOutcome: "definite_failure",
      mutationAttempt: write.mutationAttempt,
      error: {
        code: "silent_failure",
        message: "Meta created the duplicate ad but verification did not match the requested identity, account, status, ad set, or creative.",
      },
      sourceIdentity,
      responsePayload: write.payload,
      verificationPayload: verification.payload,
      resultingAdId: newAdId,
    };
  }

  return {
    ok: true,
    newAdId,
    newCreativeId: copyMode === "rebuild_creative" ? adCreativeId : null,
    sourceIdentity,
    verifiedStatus,
    responsePayload:
      creativeResponsePayload && write.payload
        ? { adcreative: creativeResponsePayload, ad: write.payload }
        : write.payload,
    verificationPayload: verification.payload,
  };
}
