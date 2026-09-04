import { resolveMetaAccountAuthority } from "@/lib/meta/account-context";
import { assertProviderWriteAuthorityUnchanged } from "@/lib/provider-write-authority";
import { createHash } from "node:crypto";
import { getMetaWriteBlockState } from "@/lib/meta/automation-control-plane";
import { recordAutomationGuardBlock } from "@/lib/meta/automation-rules-store";
import type { DecisionOriginAdExecutionBlocker } from "@/lib/creative-decision-engine/execution-safety";
import {
  BUDGET_MUTATION_BODY_KEYS,
  BUDGET_READBACK_FIELDS,
} from "@/lib/meta/budget-write-capability";

export interface MetaAdsWriteContext {
  businessId: string;
  providerAccountId: string;
  accessToken: string;
  /**
   * The `connection_generation:status` this `accessToken` was read under.
   *
   * Selection is not the whole of authority. A user can reconnect Meta as a
   * different principal while the ad account stays selected by id, and the
   * token captured before that reconnect would still be POSTed — writing to a
   * live account through a credential the user has already replaced. The
   * pre-POST check refuses on any change.
   *
   * REQUIRED, and deliberately so. While it was optional, Launchpad built its
   * context without it and every Launchpad campaign, ad-set, ad, pause and
   * resume silently took the "nothing to check" branch below — the exact state
   * the guard exists to prevent. Optionality made that omission compile.
   */
  connectionGeneration: string;
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
  /** The exact read-back fault retained when the public outcome is ambiguous. */
  verificationFailure?: MetaAdsWriteError | null;
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

/**
 * D087 — a budget write that a fresh read-back CONFIRMED.
 *
 * A transport 2xx is not success. The verified fields below come from a
 * separate GET of the same node after the write, and the adapter refuses unless
 * the account, the field and the exact minor-unit value all match what was
 * intended. `previousAmountMinor` is the value the read-back replaced, which is
 * what a later rollback has to restore and the only value it may restore.
 */
export type MetaEntityBudgetWriteSuccess = {
  ok: true;
  scope: MetaEntityExecutionScope;
  entityId: string;
  budgetField: "daily_budget" | "lifetime_budget";
  verifiedAmountMinor: number;
  verifiedCurrency: string;
  previousAmountMinor: number | null;
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
  mutationAttempt: MetaProviderMutationAttemptReceipt;
  verificationObservedAt: string;
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

export const META_ACCOUNT_NOT_SELECTED_CODE = "meta_account_not_selected";
export const META_ACCOUNT_AUTHORITY_UNKNOWN_CODE = "meta_account_authority_unknown";

/**
 * A refusal that must stop the rest of a batch rather than be retried per item.
 *
 * Deselection does not un-happen between two items of a loop, and an unreadable
 * authority will not become readable by asking again immediately. Continuing
 * either way means more provider calls that must not happen.
 */
export function isMetaWriteAuthorityFailure(
  error: Pick<MetaAdsWriteError, "code"> | null | undefined,
): boolean {
  return (
    error?.code === META_ACCOUNT_NOT_SELECTED_CODE ||
    error?.code === META_ACCOUNT_AUTHORITY_UNKNOWN_CODE
  );
}

export async function getMetaAdsWriteBlockFailure(
  ctx: MetaAdsWriteContext,
): Promise<MetaAdsWriteFailure | null> {
  const block = await getMetaWriteBlockState({ businessId: ctx.businessId });
  if (block.blocked) {
    // "Hard block · logged". This is the one place a guard rule's fired count
    // becomes real: a provider write was actually attempted and refused here.
    // Recording it must never turn the refusal into a pass, so it is awaited
    // inside a catch and its failure is discarded — the block below returns
    // either way.
    if (block.reason === "automation_guard_rule" && block.guardRule) {
      try {
        await recordAutomationGuardBlock({
          businessId: ctx.businessId,
          ruleId: block.guardRule.id,
          ruleName: block.guardRule.name,
          reason: block.message ?? "Provider write hard-blocked by guard rule.",
          providerAccountId: ctx.providerAccountId,
          at: new Date(),
        });
      } catch {
        // A logging failure is not a licence to write.
      }
    }
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

  // ONE atomic authority snapshot at the literal pre-POST boundary.
  //
  // The credential, its generation, the connection status and the selection of
  // THIS account all have to be true at the same instant. Reading them
  // separately — a generation query here, an authority query there — leaves a
  // window between each pair in which the user can reconnect or deselect, and
  // the POST goes out anyway.
  //
  // A read failure is 503, never an optional null: "I could not tell" must not
  // be indistinguishable from "there is no generation to check".
  // Unconditional. This used to be a ternary that fell back to `{ ok: true }`
  // when the caller omitted the generation, which turned a missing field into a
  // silent pass — "there is no generation to check" was exactly the state the
  // comment above forbids, and Launchpad sat in it.
  const atomicAuthority = await assertProviderWriteAuthorityUnchanged({
    businessId: ctx.businessId,
    provider: "meta",
    accountId: ctx.providerAccountId,
    expectedConnectionGeneration: ctx.connectionGeneration,
  });
  if (!atomicAuthority.ok) {
    return {
      ok: false,
      httpStatus: atomicAuthority.httpStatus,
      providerMutationAttempted: false,
      error: {
        code:
          atomicAuthority.httpStatus === 503
            ? META_ACCOUNT_AUTHORITY_UNKNOWN_CODE
            : META_ACCOUNT_NOT_SELECTED_CODE,
        message: atomicAuthority.message,
      },
      responsePayload: null,
      verificationPayload: null,
    };
  }

  const authority = await resolveMetaAccountAuthority(
    ctx.businessId,
    ctx.providerAccountId,
  );
  if (authority.state === "unknown_error") {
    return {
      ok: false,
      httpStatus: 503,
      providerMutationAttempted: false,
      error: {
        code: META_ACCOUNT_AUTHORITY_UNKNOWN_CODE,
        message:
          "Could not verify that this Meta ad account is currently selected. No provider write was attempted.",
      },
      responsePayload: null,
      verificationPayload: null,
    };
  }
  if (authority.state !== "authorized") {
    return {
      ok: false,
      httpStatus: 409,
      providerMutationAttempted: false,
      error: {
        code: META_ACCOUNT_NOT_SELECTED_CODE,
        message:
          "This Meta ad account is not currently selected for this business. Historical data remains readable; provider writes are refused.",
      },
      responsePayload: null,
      verificationPayload: null,
    };
  }
  return null;
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

const META_DUPLICATE_EVIDENCE_SENSITIVE_KEY =
  /(^|_)(authorization|access_?tokens?|refresh_?tokens?|secrets?|passwords?|credentials?|cookies?|api_?keys?|appsecret_?proof)($|_)/i;

function redactMetaDuplicateEvidence(
  value: unknown,
  accessToken: string,
  depth = 0,
): unknown {
  if (depth > 20) return "[redacted-depth-limit]";
  if (typeof value === "string") {
    const sanitized = sanitizeMetaMessage(value);
    return accessToken ? sanitized.split(accessToken).join("[redacted]") : sanitized;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      redactMetaDuplicateEvidence(item, accessToken, depth + 1),
    );
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      META_DUPLICATE_EVIDENCE_SENSITIVE_KEY.test(key)
        ? "[redacted]"
        : redactMetaDuplicateEvidence(item, accessToken, depth + 1),
    ]),
  );
}

export function redactMetaAdDuplicateProviderEvidence(
  value: Record<string, unknown> | null,
  accessToken: string,
) {
  return value
    ? (redactMetaDuplicateEvidence(value, accessToken) as Record<
        string,
        unknown
      >)
    : null;
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
  redirect?: "follow" | "error";
  timeoutMs?: number;
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
      redirect:
        input.redirect ?? (input.method === "POST" ? "error" : "follow"),
      signal: AbortSignal.timeout(
        Math.max(
          1,
          Math.min(
            META_ADS_PROVIDER_FETCH_TIMEOUT_MS,
            Math.floor(input.timeoutMs ?? META_ADS_PROVIDER_FETCH_TIMEOUT_MS),
          ),
        ),
      ),
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
  /**
   * The last awaited operation before the provider request is constructed and
   * sent. Budget writes use this for their provider-side compare-and-set read:
   * every control-plane and durable-journal await must already be complete.
   */
  beforeProviderMutation?: () => Promise<void>;
  uncertainHttpResponseIsAmbiguous?: boolean;
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
  const runPreMutationHook = async (hook: (() => Promise<void>) | undefined) => {
    try {
      await hook?.();
      return null;
    } catch (error) {
      const typedError =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string; message?: unknown })
          : null;
      return {
        code: typedError?.code ?? "before_mutation_attempt_failed",
        message: sanitizeMetaMessage(
          typedError && typeof typedError.message === "string"
            ? typedError.message
            : error instanceof Error
              ? error.message
              : String(error),
        ),
      } satisfies MetaAdsWriteError;
    }
  };

  const journalFailure = await runPreMutationHook(input.beforeMutationAttempt);
  if (journalFailure) {
    return {
      response: null,
      payload: null,
      error: journalFailure,
      mutationAttempt: null,
    };
  }

  const boundaryFailure = await runPreMutationHook(input.beforeProviderMutation);
  if (boundaryFailure) {
    return {
      response: null,
      payload: null,
      error: boundaryFailure,
      mutationAttempt: null,
    };
  }
  // Provider POSTs have no provider-side idempotency contract. A transport
  // exception after request upload can hide a committed mutation, so never
  // issue a second POST automatically. Ordinary writes retain their existing
  // HTTP semantics; duplicate-create applies the stricter ambiguity classifier
  // below for retryable, transient, malformed, and missing-id responses.
  const attemptedAt = new Date().toISOString();
  const result = await metaFetch(input);
  const completedAt = new Date().toISOString();
  const providerResponseReceived = result.response != null;
  const providerResponseSuccessful = Boolean(
    result.response?.ok && !isFailureBody(result.payload),
  );
  const providerError = getNestedRecord(result.payload, "error");
  const providerErrorCodeValue = providerError?.code;
  const providerErrorCodeIsNumeric =
    (typeof providerErrorCodeValue === "number" &&
      Number.isInteger(providerErrorCodeValue) &&
      providerErrorCodeValue >= 0) ||
    (typeof providerErrorCodeValue === "string" &&
      /^[0-9]+$/.test(providerErrorCodeValue));
  const providerErrorCode = Number(providerErrorCodeValue);
  const exactNonRetryableProviderRejection = Boolean(
    result.response &&
      result.response.status >= 400 &&
      result.response.status < 500 &&
      ![408, 425, 429].includes(result.response.status) &&
      providerError &&
      providerErrorCodeIsNumeric &&
      ![1, 2, 4, 17, 32, 341, 613].includes(providerErrorCode) &&
      providerError.is_transient === false &&
      readStringField(providerError, "message"),
  );
  const uncertainProviderResponse = Boolean(
    input.uncertainHttpResponseIsAmbiguous &&
      providerResponseReceived &&
      !providerResponseSuccessful &&
      !exactNonRetryableProviderRejection,
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
      outcome: providerResponseReceived && !uncertainProviderResponse
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
  if (input.mutationAttempt?.outcome === "outcome_ambiguous") {
    return {
      ok: false,
      httpStatus: input.httpStatus,
      providerMutationAttempted: true,
      providerOutcome: "outcome_ambiguous",
      mutationAttempt: input.mutationAttempt,
      error: {
        code: META_PROVIDER_OUTCOME_AMBIGUOUS_CODE,
        message:
          "Meta returned a response that does not prove the create was rejected before commit. Reconcile exact provider state before any retry.",
      },
      responsePayload: input.payload,
      verificationPayload: input.verificationPayload ?? null,
      resultingAdId: input.resultingAdId ?? null,
    };
  }
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

export interface MetaAdDuplicateProviderObservation {
  id: string;
  name: string;
  providerAccountId: string;
  status: string;
  effectiveStatus: string | null;
  targetAdsetId: string;
  creativeId: string;
  observedAt: string;
  providerGetEvidence: Record<string, unknown>;
}

export type MetaAdDuplicateProviderPointRead =
  | { ok: true; observation: MetaAdDuplicateProviderObservation }
  | {
      ok: false;
      blocker: "provider_read_unavailable" | "provider_identity_drift";
      httpStatus: number | null;
      observedAt: string;
      evidence: Record<string, unknown> | null;
    };

export interface MetaAdDuplicateProviderScan {
  complete: boolean;
  blocker:
    | null
    | "provider_read_unavailable"
    | "pagination_cycle"
    | "pagination_segment_limit"
    | "provider_identity_drift";
  pageCount: number;
  observationCount: number;
  exactMatches: MetaAdDuplicateProviderObservation[];
  exactMatchIds: string[];
  segmentStartAfterCursor: string | null;
  segmentStartCursorHash: string | null;
  segmentEndAfterCursor: string | null;
  segmentEndCursorHash: string | null;
  visitedCursorHashes: string[];
  observedAt: string;
  evidence: Record<string, unknown>;
}

interface MetaAdDuplicateLookupTarget {
  marker: string;
  canonicalAdName: string;
  targetAdsetId: string;
  creativeId: string;
  requestedStatus: "PAUSED";
}

const META_AD_DUPLICATE_MAX_CURSOR_LENGTH = 2_048;

function metaAdDuplicateCursorHash(cursor: string | null) {
  return createHash("sha256")
    .update(cursor == null ? "first:" : `cursor:${cursor}`, "utf8")
    .digest("hex");
}

function normalizeMetaAdDuplicateAfterCursor(
  value: string | null | undefined,
  accessToken: string,
) {
  if (value == null) return null;
  const cursor = value.trim();
  if (
    !cursor ||
    cursor !== value ||
    cursor.length > META_AD_DUPLICATE_MAX_CURSOR_LENGTH ||
    /[\r\n\t\s]/.test(cursor) ||
    /https?:\/\//i.test(cursor) ||
    /access_?token|authorization|bearer/i.test(cursor) ||
    (accessToken && cursor.includes(accessToken))
  ) {
    return null;
  }
  return cursor;
}

function parseMetaAdDuplicateObservation(input: {
  payload: Record<string, unknown>;
  ctx: MetaAdsWriteContext;
  observedAt: string;
}): MetaAdDuplicateProviderObservation | null {
  const id = readStringField(input.payload, "id");
  const name = readStringField(input.payload, "name");
  const providerAccountId = normalizeProviderAccountId(
    readStringField(input.payload, "account_id"),
  );
  if (
    !id ||
    !name ||
    providerAccountId !==
      normalizeProviderAccountId(input.ctx.providerAccountId)
  ) {
    return null;
  }
  const creative = getNestedRecord(input.payload, "creative");
  const targetAdsetId = readStringField(input.payload, "adset_id");
  const creativeId = readStringField(creative, "id");
  const status = readStringField(input.payload, "status").toUpperCase();
  if (!targetAdsetId || !creativeId || !status) {
    return null;
  }
  return {
    id,
    name,
    providerAccountId,
    status,
    effectiveStatus:
      readStringField(input.payload, "effective_status").toUpperCase() ||
      null,
    targetAdsetId,
    creativeId,
    observedAt: input.observedAt,
    providerGetEvidence: redactMetaAdDuplicateProviderEvidence(
      cloneRecord(input.payload),
      input.ctx.accessToken,
    )!,
  };
}

function exactMetaAdDuplicateObservation(
  observation: MetaAdDuplicateProviderObservation,
  target: MetaAdDuplicateLookupTarget,
) {
  return (
    observation.name === target.canonicalAdName &&
    observation.name.includes(target.marker) &&
    observation.targetAdsetId === target.targetAdsetId &&
    observation.creativeId === target.creativeId &&
    observation.status === target.requestedStatus
  );
}

export async function readMetaAdDuplicateProviderObservation(input: {
  ctx: MetaAdsWriteContext;
  adId: string;
  target: MetaAdDuplicateLookupTarget;
  timeoutMs?: number;
}): Promise<MetaAdDuplicateProviderPointRead> {
  const observedAt = new Date().toISOString();
  const result = await metaFetch({
    ctx: input.ctx,
    path: input.adId,
    method: "GET",
    fields:
      "id,name,account_id,status,effective_status,adset_id,creative{id}",
    redirect: "error",
    timeoutMs: input.timeoutMs,
  });
  if (
    result.error ||
    !result.response?.ok ||
    isFailureBody(result.payload)
  ) {
    return {
      ok: false,
      blocker: "provider_read_unavailable",
      httpStatus: result.response?.status ?? null,
      observedAt,
      evidence: redactMetaAdDuplicateProviderEvidence(
        result.payload,
        input.ctx.accessToken,
      ),
    };
  }
  const observation = result.payload
    ? parseMetaAdDuplicateObservation({
        payload: result.payload,
        ctx: input.ctx,
        observedAt,
      })
    : null;
  if (
    !observation ||
    observation.id !== input.adId ||
    !exactMetaAdDuplicateObservation(observation, input.target)
  ) {
    return {
      ok: false,
      blocker: "provider_identity_drift",
      httpStatus: result.response.status,
      observedAt,
      evidence: redactMetaAdDuplicateProviderEvidence(
        result.payload,
        input.ctx.accessToken,
      ),
    };
  }
  return { ok: true, observation };
}

/**
 * Traverses the physical account's complete Ads edge. Interrupted, cyclic,
 * over-limit, or malformed pagination is explicitly incomplete and therefore
 * can never authorize an absence release.
 */
export async function scanMetaAdDuplicatesByMarker(input: {
  ctx: MetaAdsWriteContext;
  target: MetaAdDuplicateLookupTarget;
  maxPages?: number;
  maxDurationMs?: number;
  afterCursor?: string | null;
  visitedCursorHashes?: string[];
  cumulativePageCount?: number;
  cumulativeObservationCount?: number;
  cumulativeExactMatchIds?: string[];
}): Promise<MetaAdDuplicateProviderScan> {
  const maxPages = Math.max(1, Math.min(1_000, input.maxPages ?? 250));
  const maxDurationMs = Math.max(
    50,
    Math.min(60_000, input.maxDurationMs ?? 15_000),
  );
  const scanStartedAt = Date.now();
  const accountNumericId = getAccountNumericId(input.ctx.providerAccountId);
  let nextUrl: URL | null = buildGraphUrl(
    `act_${accountNumericId}/ads`,
    input.ctx.accessToken,
  );
  const providerFields =
    "id,name,account_id,status,effective_status,adset_id,creative{id}";
  nextUrl.searchParams.set("fields", providerFields);
  nextUrl.searchParams.set("limit", "100");
  const segmentStartAfterCursor = normalizeMetaAdDuplicateAfterCursor(
    input.afterCursor,
    input.ctx.accessToken,
  );
  const invalidStartCursor =
    input.afterCursor != null && segmentStartAfterCursor == null;
  if (segmentStartAfterCursor) {
    nextUrl.searchParams.set("after", segmentStartAfterCursor);
  }
  const expectedPathname = nextUrl.pathname;
  const allowedQueryParams = new Set([
    "access_token",
    "fields",
    "limit",
    "after",
  ]);
  const priorVisitedCursorHashes = input.visitedCursorHashes ?? [];
  const invalidVisitedCursorHashes = priorVisitedCursorHashes.some(
    (hash) => !/^[0-9a-f]{64}$/.test(hash),
  );
  const visitedCursorHashes = new Set(priorVisitedCursorHashes);
  const visitedUrls = new Set<string>();
  const exactMatches: MetaAdDuplicateProviderObservation[] = [];
  const exactMatchIds = new Set(input.cumulativeExactMatchIds ?? []);
  const priorPageCount = Math.max(
    0,
    Math.floor(input.cumulativePageCount ?? 0),
  );
  const priorObservationCount = Math.max(
    0,
    Math.floor(input.cumulativeObservationCount ?? 0),
  );
  const pages: Array<Record<string, unknown>> = [];
  let pageCount = 0;
  let successfulPageCount = 0;
  let successfulObservationCount = 0;
  let blocker: MetaAdDuplicateProviderScan["blocker"] = null;
  let segmentEndAfterCursor: string | null = null;
  const observedAt = new Date().toISOString();

  if (invalidStartCursor || invalidVisitedCursorHashes) {
    blocker = "provider_identity_drift";
    nextUrl = null;
  }

  while (nextUrl) {
    if (
      nextUrl.protocol !== "https:" ||
      nextUrl.hostname !== "graph.facebook.com" ||
      nextUrl.port !== "" ||
      nextUrl.username !== "" ||
      nextUrl.password !== "" ||
      nextUrl.hash !== "" ||
      nextUrl.pathname !== expectedPathname ||
      [...nextUrl.searchParams.keys()].some(
        (key) => !allowedQueryParams.has(key),
      ) ||
      nextUrl.searchParams.getAll("access_token").length !== 1 ||
      nextUrl.searchParams.get("access_token") !== input.ctx.accessToken ||
      nextUrl.searchParams.getAll("fields").length !== 1 ||
      nextUrl.searchParams.get("fields") !== providerFields ||
      nextUrl.searchParams.getAll("limit").length !== 1 ||
      !/^[1-9][0-9]*$/.test(nextUrl.searchParams.get("limit") ?? "") ||
      nextUrl.searchParams.get("limit") !== "100" ||
      nextUrl.searchParams.getAll("after").length > 1 ||
      (pageCount > 0 &&
        !(nextUrl.searchParams.get("after") ?? "").trim())
    ) {
      blocker = "provider_identity_drift";
      break;
    }
    const pageKey = nextUrl.toString();
    const pageAfterCursor = normalizeMetaAdDuplicateAfterCursor(
      nextUrl.searchParams.get("after"),
      input.ctx.accessToken,
    );
    const pageCursorHash = metaAdDuplicateCursorHash(pageAfterCursor);
    if (
      visitedUrls.has(pageKey) ||
      visitedCursorHashes.has(pageCursorHash)
    ) {
      blocker = "pagination_cycle";
      break;
    }
    const remainingMs = maxDurationMs - (Date.now() - scanStartedAt);
    if (remainingMs <= 0) {
      segmentEndAfterCursor = normalizeMetaAdDuplicateAfterCursor(
        nextUrl.searchParams.get("after"),
        input.ctx.accessToken,
      );
      blocker = segmentEndAfterCursor
        ? "pagination_segment_limit"
        : "provider_read_unavailable";
      break;
    }
    if (pageCount >= maxPages) {
      segmentEndAfterCursor = normalizeMetaAdDuplicateAfterCursor(
        nextUrl.searchParams.get("after"),
        input.ctx.accessToken,
      );
      blocker = segmentEndAfterCursor
        ? "pagination_segment_limit"
        : "provider_identity_drift";
      break;
    }
    visitedUrls.add(pageKey);
    pageCount += 1;
    let response: Response;
    try {
      response = await fetch(pageKey, {
        method: "GET",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.min(META_ADS_PROVIDER_FETCH_TIMEOUT_MS, remainingMs),
        ),
      });
    } catch {
      blocker = "provider_read_unavailable";
      segmentEndAfterCursor = pageAfterCursor;
      break;
    }
    const payload = await readResponseJson(response);
    if (!response.ok || isFailureBody(payload)) {
      blocker = "provider_read_unavailable";
      segmentEndAfterCursor = pageAfterCursor;
      pages.push({ page: pageCount, httpStatus: response.status, ok: false });
      break;
    }
    if (!payload || !Array.isArray(payload.data)) {
      blocker = "provider_identity_drift";
      break;
    }
    const data = payload.data;
    let pageObservationCount = 0;
    const pageExactMatches: MetaAdDuplicateProviderObservation[] = [];
    for (const raw of data) {
      if (!isRecord(raw)) {
        blocker = "provider_identity_drift";
        break;
      }
      pageObservationCount += 1;
      const id = readStringField(raw, "id");
      const name = readStringField(raw, "name");
      const providerAccountId = normalizeProviderAccountId(
        readStringField(raw, "account_id"),
      );
      if (
        !id ||
        !name ||
        providerAccountId !==
          normalizeProviderAccountId(input.ctx.providerAccountId)
      ) {
        blocker = "provider_identity_drift";
        break;
      }
      const isCandidate =
        name === input.target.canonicalAdName ||
        name.includes(input.target.marker);
      if (!isCandidate) {
        continue;
      }
      const observation = parseMetaAdDuplicateObservation({
        payload: raw,
        ctx: input.ctx,
        observedAt,
      });
      if (!observation) {
        blocker = "provider_identity_drift";
        break;
      }
      if (exactMetaAdDuplicateObservation(observation, input.target)) {
        pageExactMatches.push(observation);
      } else if (
        observation.name === input.target.canonicalAdName ||
        observation.name.includes(input.target.marker)
      ) {
        blocker = "provider_identity_drift";
        break;
      }
    }
    if (blocker) break;
    let parsedNextUrl: URL | null = null;
    const hasPaging = Object.prototype.hasOwnProperty.call(payload, "paging");
    const rawPaging = payload.paging;
    if (!hasPaging || rawPaging === null) {
      parsedNextUrl = null;
    } else if (!isRecord(rawPaging)) {
      blocker = "provider_identity_drift";
    } else {
      const hasNext = Object.prototype.hasOwnProperty.call(
        rawPaging,
        "next",
      );
      const rawNextValue = rawPaging.next;
      if (!hasNext || rawNextValue === null) {
        parsedNextUrl = null;
      } else if (
        typeof rawNextValue !== "string" ||
        !rawNextValue.trim() ||
        rawNextValue !== rawNextValue.trim()
      ) {
        blocker = "provider_identity_drift";
      } else {
        try {
          parsedNextUrl = new URL(rawNextValue);
          const parsedAfterCursor = normalizeMetaAdDuplicateAfterCursor(
            parsedNextUrl.searchParams.get("after"),
            input.ctx.accessToken,
          );
          if (!parsedAfterCursor) {
            blocker = "provider_identity_drift";
            parsedNextUrl = null;
          }
        } catch {
          blocker = "provider_identity_drift";
          parsedNextUrl = null;
        }
      }
    }
    if (blocker) break;
    visitedCursorHashes.add(pageCursorHash);
    successfulPageCount += 1;
    successfulObservationCount += pageObservationCount;
    for (const observation of pageExactMatches) {
      exactMatches.push(observation);
      if (exactMatchIds.size < 2) exactMatchIds.add(observation.id);
    }
    pages.push({
      page: pageCount,
      httpStatus: response.status,
      rowCount: data.length,
      afterCursorHash: pageCursorHash,
    });
    nextUrl = parsedNextUrl;
  }

  const complete = blocker === null && nextUrl === null;
  const cumulativePageCount = priorPageCount + successfulPageCount;
  const cumulativeObservationCount =
    priorObservationCount + successfulObservationCount;
  const segmentStartCursorHash = segmentStartAfterCursor
    ? metaAdDuplicateCursorHash(segmentStartAfterCursor)
    : null;
  const segmentEndCursorHash = segmentEndAfterCursor
    ? metaAdDuplicateCursorHash(segmentEndAfterCursor)
    : null;
  return {
    complete,
    blocker,
    pageCount: cumulativePageCount,
    observationCount: cumulativeObservationCount,
    exactMatches,
    exactMatchIds: [...exactMatchIds],
    segmentStartAfterCursor,
    segmentStartCursorHash,
    segmentEndAfterCursor,
    segmentEndCursorHash,
    visitedCursorHashes: [...visitedCursorHashes],
    observedAt,
    evidence: {
      contractVersion: "meta-ad-duplicate-provider-scan.v1",
      providerAccountId: normalizeProviderAccountId(
        input.ctx.providerAccountId,
      ),
      marker: input.target.marker,
      canonicalAdName: input.target.canonicalAdName,
      targetAdsetId: input.target.targetAdsetId,
      creativeId: input.target.creativeId,
      requestedStatus: input.target.requestedStatus,
      providerAdsPathname: expectedPathname,
      maxPages,
      maxDurationMs,
      complete,
      blocker,
      pageCount: cumulativePageCount,
      observationCount: cumulativeObservationCount,
      exactMatchIds: [...exactMatchIds],
      segmentPageCount: successfulPageCount,
      segmentObservationCount: successfulObservationCount,
      segmentStartCursorHash,
      segmentEndCursorHash,
      visitedCursorHashes: [...visitedCursorHashes],
      pages,
      observedAt,
    },
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

/**
 * D087 — update a campaign or ad-set budget, then PROVE it.
 *
 * The shape follows `updateAdsetBidAmount` deliberately: the same kill switch,
 * the same transport, the same failure builders, and the same "verify or fail"
 * ending. What it adds is that a budget read-back has more than one way to be
 * wrong, so each is separated: the node that answered must be the node written,
 * on the account written, in the currency the retained fact named, with the
 * intended field carrying the intended value. Any other combination — including
 * the RIGHT value in the WRONG field — is a failure, not a success.
 */
/**
 * D088 C1 — read the CURRENT budget of one node through the existing read
 * boundary, for a compare-and-set baseline.
 *
 * It is the same `verifyEntity` every write already verifies with, so the
 * baseline a preflight compares against and the value the adapter re-checks
 * before POSTing come from one code path rather than two that can disagree.
 * It issues a GET and nothing else.
 */
export async function readMetaEntityBudgetState(
  ctx: MetaAdsWriteContext,
  input: {
    entityId: string;
    budgetField: "daily_budget" | "lifetime_budget";
    /**
     * The ad account's VERIFIED currency, from the account profile the budget
     * write context carries.
     *
     * PR #272 review: this used to be read off the campaign/ad-set payload.
     * Meta has no currency field on those nodes, so asking for it made the
     * whole GET fail — and the only value that could ever have arrived here
     * instead was one the caller made up. Currency belongs to the account,
     * `account_id` is verified against the context on every read, and this is
     * the account's own normalised code.
     */
    accountCurrency: string;
  },
): Promise<{
  ok: true;
  entityId: string;
  providerAccountId: string;
  budgetField: "daily_budget" | "lifetime_budget";
  amountMinor: number;
  currency: string;
  readAtMs: number;
} | { ok: false; reason: string }> {
  // Unknown currency is refusal, before any provider contact — and a caller
  // that supplies no string at all is exactly that, not a crash.
  const currency = typeof input.accountCurrency === "string"
    ? input.accountCurrency.trim() : "";
  if (currency === "") return { ok: false, reason: "account_currency_missing" };
  const verification = await verifyEntity({
    ctx, entityId: input.entityId, fields: BUDGET_READBACK_FIELDS,
  });
  if (!verification.ok) {
    return { ok: false, reason: verification.error?.code ?? "verification_failed" };
  }
  const payload = verification.payload;
  const raw = payload?.[input.budgetField];
  const amount = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "budget_not_reported" };
  }
  return {
    ok: true,
    entityId: input.entityId,
    providerAccountId: ctx.providerAccountId,
    budgetField: input.budgetField,
    amountMinor: Math.round(amount),
    currency,
    readAtMs: Date.now(),
  };
}

export async function updateEntityBudget(
  ctx: MetaAdsWriteContext,
  input: {
    scope: MetaEntityExecutionScope;
    entityId: string;
    budgetField: "daily_budget" | "lifetime_budget";
    amountMinor: number;
    /**
     * The ad account's VERIFIED currency, from the account profile the budget
     * write context carries — not the request's own claim about itself.
     *
     * PR #272 review: the caller used to pass `request.currency` straight
     * through, so a proposal that named the wrong currency proved itself. The
     * value that arrives here is now the one the account actually holds, and
     * the preflight has already refused any request whose own currency
     * disagrees with it — before this adapter is reached at all.
     */
    expectedCurrency: string;
    /**
     * The value the caller's accepted baseline says the account holds RIGHT NOW.
     *
     * D087 C1: the orchestrator's compare-and-set ran against a read taken
     * milliseconds earlier, and this adapter then took a second read of its own
     * without comparing it to anything. An operator change landing between the
     * two was overwritten by the POST. This is the value the pre-POST read must
     * still show, and the POST does not happen unless it does.
     */
    expectedPreviousAmountMinor: number;
    /**
     * Persists the durable dispatch marker before the final provider-side
     * compare-and-set read. A false/throwing marker vetoes the mutation.
     */
    beforeProviderPost?: () => Promise<boolean>;
    dryRun?: boolean;
  },
): Promise<MetaEntityBudgetWriteSuccess | MetaAdsWriteFailure> {
  if (isMetaAdsWriteKillSwitchEngaged()) return killSwitchFailure();

  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    return {
      ok: false,
      httpStatus: 400,
      providerMutationAttempted: false,
      error: {
        code: "invalid_budget_amount",
        message: "A budget amount must be a positive, exact, safe integer of minor units.",
      },
      responsePayload: null,
      verificationPayload: null,
    };
  }

  const amountMinor = input.amountMinor;
  const wouldHaveWritten: MetaAdsWouldHaveWritten = {
    method: "POST",
    path: input.entityId,
    body: { [input.budgetField]: amountMinor },
  };

  const readBack = async (payload: Record<string, unknown> | null) => {
    const verification = await verifyEntity({
      ctx,
      entityId: input.entityId,
      fields: BUDGET_READBACK_FIELDS,
    });
    if (!verification.ok) {
      return {
        failure: {
          ok: false as const,
          httpStatus: verification.httpStatus,
          providerOutcome: "definite_failure" as const,
          error:
            verification.error ?? {
              code: "verification_failed",
              message: "Meta accepted the budget write, but verification failed.",
            },
          responsePayload: payload,
          verificationPayload: verification.payload,
        },
        payload: verification.payload,
      };
    }
    return { failure: null, payload: verification.payload };
  };

  const mismatch = (
    code: string,
    message: string,
    payload: Record<string, unknown> | null,
    verificationPayload: Record<string, unknown> | null,
  ): MetaAdsWriteFailure => ({
    ok: false,
    httpStatus: 502,
    providerOutcome: "definite_failure",
    error: { code, message },
    responsePayload: payload,
    verificationPayload,
  });

  /**
   * Every way a budget read can fail to be about this write.
   *
   * Used TWICE with different expectations: before the POST it must show the
   * accepted previous value, and after it must show the intended one. Sharing
   * one classifier is deliberate — a guard weaker than the verification would
   * be a guard that lets through exactly what the verification catches.
   */
  const classifyRead = (
    verificationPayload: Record<string, unknown> | null,
    payload: Record<string, unknown> | null,
    expect: { amountMinor: number; prefix: "precondition" | "readback" },
  ): { failure: MetaAdsWriteFailure | null; amount: number; currency: string } => {
    const none = { amount: Number.NaN, currency: "" };
    const verifiedId = typeof verificationPayload?.id === "string"
      ? verificationPayload.id : "";
    if (verifiedId !== input.entityId) {
      return {
        failure: mismatch(
          `${expect.prefix}_entity_mismatch`,
          `Meta answered for ${verifiedId || "no entity"} rather than ${input.entityId}.`,
          payload, verificationPayload,
        ),
        ...none,
      };
    }
    const verifiedAccount = typeof verificationPayload?.account_id === "string"
      ? verificationPayload.account_id : "";
    // Meta reports `account_id` without the `act_` prefix the context carries.
    const contextAccount = ctx.providerAccountId.replace(/^act_/, "");
    if (verifiedAccount.replace(/^act_/, "") !== contextAccount) {
      return {
        failure: mismatch(
          `${expect.prefix}_account_mismatch`,
          "Meta answered for a different ad account.",
          payload, verificationPayload,
        ),
        ...none,
      };
    }
    /*
      D087 C1 asked Meta for the entity's `currency` and refused an empty
      answer. PR #272 review: that answer was ALWAYS going to be empty —
      currency is an ad-account field, never a campaign or ad-set one, and
      asking for it made Meta reject the entire GET.

      What proves the currency here is the pair above it: `account_id` was
      verified against this context, and an ad account holds exactly one
      currency. So the account's own verified code is the currency of this
      budget, and the only thing left to refuse is not having one.
    */
    const verifiedCurrency = typeof input.expectedCurrency === "string"
      ? input.expectedCurrency.trim() : "";
    if (verifiedCurrency === "") {
      return {
        failure: mismatch(
          `${expect.prefix}_currency_absent`,
          `No verified account currency was supplied for ${input.entityId}, so the `
          + "minor-unit amount cannot be proven to mean anything.",
          payload, verificationPayload,
        ),
        ...none,
      };
    }
    const raw = verificationPayload?.[input.budgetField];
    const verifiedAmount = typeof raw === "string" || typeof raw === "number"
      ? Number(raw) : Number.NaN;
    if (!Number.isFinite(verifiedAmount)) {
      return {
        failure: mismatch(
          `${expect.prefix}_field_absent`,
          `Meta did not report ${input.budgetField} for ${input.entityId}.`,
          payload, verificationPayload,
        ),
        ...none,
      };
    }
    if (Math.round(verifiedAmount) !== expect.amountMinor) {
      return {
        failure: mismatch(
          expect.prefix === "precondition" ? "precondition_amount_mismatch" : "silent_failure",
          expect.prefix === "precondition"
            ? `The account holds ${Math.round(verifiedAmount)} for ${input.budgetField}, not the `
              + `${expect.amountMinor} this proposal was accepted against; it changed after `
              + "preflight and nothing may be written over it."
            : `Meta returned success but ${input.budgetField} verified as ${Math.round(verifiedAmount)}.`,
          payload, verificationPayload,
        ),
        ...none,
      };
    }
    return {
      failure: null,
      amount: Math.round(verifiedAmount),
      currency: verifiedCurrency,
    };
  };

  if (input.dryRun) {
    const pre = await readBack(dryRunPayload(wouldHaveWritten));
    if (pre.failure) return pre.failure;
    const guard = classifyRead(pre.payload, dryRunPayload(wouldHaveWritten), {
      amountMinor: input.expectedPreviousAmountMinor, prefix: "precondition",
    });
    if (guard.failure) return guard.failure;
    return {
      ok: true,
      scope: input.scope,
      entityId: input.entityId,
      budgetField: input.budgetField,
      verifiedAmountMinor: amountMinor,
      verifiedCurrency: guard.currency,
      previousAmountMinor: guard.amount,
      dryRun: true,
      wouldHaveWritten,
      responsePayload: dryRunPayload(wouldHaveWritten),
      verificationPayload: pre.payload,
    };
  }

  const body = new URLSearchParams({
    [BUDGET_MUTATION_BODY_KEYS[input.budgetField]]: String(amountMinor),
  });
  let finalPreconditionFailure: MetaAdsWriteFailure | null = null;
  let previousAmountMinor = Number.NaN;

  const write = await metaFetchWriteOnce({
    ctx,
    path: input.entityId,
    method: "POST",
    body,
    /*
      `metaFetchWriteOnce` runs the complete kill-switch/control/authority gate
      before this callback. Consequently a write that is already blocked never
      gets a dispatch marker.
    */
    beforeMutationAttempt: input.beforeProviderPost
      ? async () => {
          const marked = await input.beforeProviderPost?.().catch(() => false);
          if (!marked) {
            throw {
              code: "dispatch_marker_unavailable",
              message:
                "The dispatch marker could not be persisted, so no Meta budget write was attempted.",
            };
          }
        }
      : undefined,
    /*
      THE LAST WORD BEFORE THE POST.

      This provider read deliberately happens AFTER every asynchronous
      control-plane check and durable marker write. `metaFetchWriteOnce` calls
      no other awaited hook after it; the next operation is the one Meta POST.
      A concurrent budget edit during either earlier await is therefore seen
      here and refused instead of being overwritten.

      Meta does not expose a conditional/versioned budget mutation. Therefore
      the separate GET and POST still have an irreducible provider/network race;
      this is the narrowest application-level check, not an atomic CAS claim.

      The marker can exist when this final comparison refuses. The returned
      failure still proves that no provider mutation was attempted and normal
      settlement closes it as failed. Only a process crash in this tiny window
      remains conservatively reconcilable, which is safer than retrying an
      unknown provider outcome.
    */
    beforeProviderMutation: async () => {
      const before = await readBack(null);
      if (before.failure) {
        finalPreconditionFailure = {
          ...before.failure,
          providerMutationAttempted: false,
        };
        throw before.failure.error;
      }
      const precondition = classifyRead(before.payload, null, {
        amountMinor: input.expectedPreviousAmountMinor,
        prefix: "precondition",
      });
      if (precondition.failure) {
        finalPreconditionFailure = {
          ...precondition.failure,
          providerMutationAttempted: false,
        };
        throw precondition.failure.error;
      }
      previousAmountMinor = precondition.amount;
    },
  });
  if (finalPreconditionFailure) return finalPreconditionFailure;
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
      fallbackCode: "meta_budget_write_failed",
      fallbackMessage: `Meta failed to update the ${input.scope} ${input.budgetField}.`,
      mutationAttempt: write.mutationAttempt,
    });
  }

  /*
    PRE-DEPLOY AUDIT — past this line the POST WAS SENT and Meta answered 2xx.

    Both failures below are read-back failures, not write failures: the budget
    may already have moved. They carried only `mutationAttempt`, and the D087
    journal reads `providerMutationAttempted`, so the durable row said
    `provider_attempted = false` for precisely the case where money may have
    changed — the one an operator reconciles first.
  */
  const after = await readBack(write.payload);
  if (after.failure) {
    return {
      ...after.failure,
      httpStatus: 502,
      providerMutationAttempted: true,
      /*
        The POST above was accepted, but this GET did not establish the state
        Meta committed. Calling that a definite failure permits a second
        adjustment against an account whose budget may already have moved.
        Hold the proposal for exact reconciliation instead.
      */
      providerOutcome: "outcome_ambiguous",
      mutationAttempt: write.mutationAttempt,
      verificationFailure: after.failure.error,
      error: {
        code: META_PROVIDER_OUTCOME_AMBIGUOUS_CODE,
        message:
          "Meta accepted the budget write, but its post-write state could not be verified. Reconcile the exact provider state before any retry.",
      },
      responsePayload: write.payload,
    };
  }
  const verdict = classifyRead(after.payload, write.payload, {
    amountMinor, prefix: "readback",
  });
  if (verdict.failure) {
    return {
      ...verdict.failure,
      httpStatus: 502,
      providerMutationAttempted: true,
      providerOutcome: "outcome_ambiguous",
      mutationAttempt: write.mutationAttempt,
      verificationFailure: verdict.failure.error,
      error: {
        code: META_PROVIDER_OUTCOME_AMBIGUOUS_CODE,
        message:
          "Meta accepted the budget write, but its post-write state did not match the approved change. Reconcile the exact provider state before any retry.",
      },
    };
  }

  return {
    ok: true,
    scope: input.scope,
    entityId: input.entityId,
    budgetField: input.budgetField,
    verifiedAmountMinor: verdict.amount,
    verifiedCurrency: verdict.currency,
    previousAmountMinor,
    responsePayload: write.payload,
    verificationPayload: after.payload,
  };
}

type MetaAdDuplicateInput = {
  adId: string;
  targetAdsetId: string;
  expectedSourceCreativeId?: string;
  name?: string;
  copyMode?: MetaAdDuplicateCopyMode;
  dryRun?: boolean;
  beforeMutationAttempt?: () => Promise<void>;
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
    redirect: "error",
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
    beforeMutationAttempt: input.beforeMutationAttempt,
    uncertainHttpResponseIsAmbiguous: true,
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
  const safeWritePayload = redactMetaAdDuplicateProviderEvidence(
    write.payload,
    ctx.accessToken,
  );
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return {
      ...buildWriteFailure({
        payload: safeWritePayload,
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
      providerOutcome: "outcome_ambiguous",
      mutationAttempt: write.mutationAttempt,
      error: {
        code: "silent_failure",
        message: "Meta returned success but did not return a new ad id.",
      },
      sourceIdentity,
      responsePayload: safeWritePayload,
    };
  }

  const verification = await metaFetch({
    ctx,
    path: newAdId,
    method: "GET",
    fields:
      "id,name,account_id,status,effective_status,adset_id,creative{id}",
    redirect: "error",
  });
  const verificationObservedAt = new Date().toISOString();
  const redactedVerificationPayload =
    redactMetaAdDuplicateProviderEvidence(
      verification.payload,
      ctx.accessToken,
    );
  const safeVerificationPayload = redactedVerificationPayload
    ? {
        ...redactedVerificationPayload,
        observedAt: verificationObservedAt,
      }
    : null;
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
      responsePayload: safeWritePayload,
      verificationPayload: safeVerificationPayload,
      resultingAdId: newAdId,
    };
  }

  const verifiedStatus = readStringField(verification.payload, "status");
  const verifiedAdId = readStringField(verification.payload, "id");
  const verifiedName = readStringField(verification.payload, "name");
  const verifiedProviderAccountId = normalizeProviderAccountId(
    readStringField(verification.payload, "account_id"),
  );
  const verifiedAdsetId = readStringField(verification.payload, "adset_id");
  const verifiedCreativeId = readStringField(
    getNestedRecord(verification.payload, "creative"),
    "id",
  );
  const requiresExactCanonicalName = name.includes("[ADSECUTE_DUP:");
  if (
    verifiedStatus !== statusOption ||
    verifiedAdId !== newAdId ||
    (requiresExactCanonicalName && verifiedName !== name) ||
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
        message: "Meta created the duplicate ad but verification did not match the requested identity, name, account, status, ad set, or creative.",
      },
      sourceIdentity,
      responsePayload: safeWritePayload,
      verificationPayload: safeVerificationPayload,
      resultingAdId: newAdId,
    };
  }

  return {
    ok: true,
    newAdId,
    newCreativeId: copyMode === "rebuild_creative" ? adCreativeId : null,
    sourceIdentity,
    verifiedStatus,
    mutationAttempt: write.mutationAttempt!,
    verificationObservedAt,
    responsePayload:
      creativeResponsePayload && safeWritePayload
        ? {
            adcreative: redactMetaAdDuplicateProviderEvidence(
              creativeResponsePayload,
              ctx.accessToken,
            ),
            ad: safeWritePayload,
          }
        : safeWritePayload,
    verificationPayload: safeVerificationPayload,
  };
}
