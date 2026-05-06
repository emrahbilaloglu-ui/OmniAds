export interface MetaAdsWriteContext {
  businessId: string;
  providerAccountId: string;
  accessToken: string;
}

export interface MetaAdsWriteError {
  code: string;
  message: string;
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
  responsePayload?: Record<string, unknown> | null;
  verificationPayload?: Record<string, unknown> | null;
};

export type MetaAdDuplicateWriteSuccess = {
  ok: true;
  newAdId: string;
  verifiedStatus: string;
  responsePayload?: Record<string, unknown> | null;
  verificationPayload?: Record<string, unknown> | null;
};

type MetaFetchMethod = "GET" | "POST";

const GRAPH_API_VERSION = "v22.0";
const META_RATE_LIMIT_CODE = 17;
const RATE_LIMIT_RETRY_MS =
  process.env.NODE_ENV === "test" || process.env.VITEST === "true"
    ? 0
    : 30_000;

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

function getAccountNumericId(providerAccountId: string) {
  return providerAccountId.trim().replace(/^act_/, "");
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
  const first = await metaFetch(input);
  if (
    first.response &&
    !first.response.ok &&
    isRateLimitPayload(first.payload)
  ) {
    await delay(RATE_LIMIT_RETRY_MS);
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

async function updateAdStatus(
  ctx: MetaAdsWriteContext,
  adId: string,
  status: "ACTIVE" | "PAUSED",
): Promise<MetaAdStatusWriteSuccess | MetaAdsWriteFailure> {
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
      httpStatus: 502,
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
): Promise<MetaAdStatusWriteSuccess | MetaAdsWriteFailure> {
  return updateAdStatus(ctx, adId, "PAUSED");
}

export async function resumeAd(
  ctx: MetaAdsWriteContext,
  adId: string,
): Promise<MetaAdStatusWriteSuccess | MetaAdsWriteFailure> {
  return updateAdStatus(ctx, adId, "ACTIVE");
}

export async function duplicateAd(
  ctx: MetaAdsWriteContext,
  input: {
    adId: string;
    targetAdsetId: string;
    name?: string;
    activateAfterCreate: boolean;
  },
): Promise<MetaAdDuplicateWriteSuccess | MetaAdsWriteFailure> {
  const sourceAd = await metaFetch({
    ctx,
    path: input.adId,
    method: "GET",
    fields: "name,creative{id},adset_id",
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

  const statusOption = input.activateAfterCreate ? "ACTIVE" : "PAUSED";
  const sourceName = readStringField(sourceAd.payload, "name");
  const name =
    typeof input.name === "string" && input.name.trim().length > 0
      ? input.name.trim()
      : `${sourceName || input.adId} (copy)`;
  const accountNumericId = getAccountNumericId(ctx.providerAccountId);
  const body = new URLSearchParams({
    name,
    adset_id: input.targetAdsetId,
    creative: JSON.stringify({ creative_id: sourceCreativeId }),
    status: statusOption,
  });

  const write = await metaFetchWithRateLimitRetry({
    ctx,
    path: `act_${accountNumericId}/ads`,
    method: "POST",
    body,
  });
  if (write.error) {
    return {
      ok: false,
      httpStatus: 502,
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
    verifiedCreativeId !== sourceCreativeId
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
    verifiedStatus,
    responsePayload: write.payload,
    verificationPayload: verification.payload,
  };
}
