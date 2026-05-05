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

async function updateAdName(input: {
  ctx: MetaAdsWriteContext;
  adId: string;
  name: string;
}): Promise<MetaAdsWriteFailure | null> {
  const body = new URLSearchParams({ name: input.name });
  const write = await metaFetchWithRateLimitRetry({
    ctx: input.ctx,
    path: input.adId,
    method: "POST",
    body,
  });
  if (write.error) {
    return {
      ok: false,
      httpStatus: 502,
      error: write.error,
      responsePayload: write.payload,
      resultingAdId: input.adId,
    };
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_name_update_failed",
      fallbackMessage: "Meta failed to set the copied ad name.",
      resultingAdId: input.adId,
    });
  }
  return null;
}

async function updateAdSetDailyBudget(input: {
  ctx: MetaAdsWriteContext;
  adsetId: string;
  dailyBudgetMinor: number;
  resultingAdId: string;
}): Promise<MetaAdsWriteFailure | null> {
  const body = new URLSearchParams({
    daily_budget: String(Math.round(input.dailyBudgetMinor)),
  });
  const write = await metaFetchWithRateLimitRetry({
    ctx: input.ctx,
    path: input.adsetId,
    method: "POST",
    body,
  });
  if (write.error) {
    return {
      ok: false,
      httpStatus: 502,
      error: write.error,
      responsePayload: write.payload,
      resultingAdId: input.resultingAdId,
    };
  }
  const httpStatus = write.response?.status ?? 502;
  if (!write.response?.ok || isFailureBody(write.payload)) {
    return buildWriteFailure({
      payload: write.payload,
      httpStatus,
      fallbackCode: "meta_budget_update_failed",
      fallbackMessage: "Meta failed to set the target ad set daily budget.",
      resultingAdId: input.resultingAdId,
    });
  }

  const verification = await metaFetch({
    ctx: input.ctx,
    path: input.adsetId,
    method: "GET",
    fields: "id,daily_budget",
  });
  const verifiedBudget = Number(verification.payload?.daily_budget);
  if (
    verification.error ||
    !verification.response?.ok ||
    verifiedBudget !== Math.round(input.dailyBudgetMinor)
  ) {
    return {
      ok: false,
      httpStatus: verification.response?.status ?? 502,
      error: {
        code: "silent_failure",
        message: "Meta returned success but the target ad set daily budget did not verify.",
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
      resultingAdId: input.resultingAdId,
    };
  }

  return null;
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
    dailyBudgetMinor?: number;
    name?: string;
    activateAfterCreate: boolean;
  },
): Promise<MetaAdDuplicateWriteSuccess | MetaAdsWriteFailure> {
  const statusOption = input.activateAfterCreate ? "ACTIVE" : "PAUSED";
  const body = new URLSearchParams({
    adset_id: input.targetAdsetId,
    status_option: statusOption,
  });
  body.set(
    "rename_options",
    JSON.stringify({ rename_strategy: "ONLY_TOP_LEVEL_RENAME" }),
  );

  const write = await metaFetchWithRateLimitRetry({
    ctx,
    path: `${input.adId}/copies`,
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
      fallbackMessage: "Meta failed to duplicate the ad.",
    });
  }

  const copiedAdId =
    typeof write.payload?.copied_ad_id === "string"
      ? write.payload.copied_ad_id.trim()
      : "";
  if (!copiedAdId) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "silent_failure",
        message: "Meta returned success but did not return copied_ad_id.",
      },
      responsePayload: write.payload,
    };
  }

  const trimmedName =
    typeof input.name === "string" && input.name.trim().length > 0
      ? input.name.trim()
      : null;
  if (trimmedName) {
    const nameFailure = await updateAdName({
      ctx,
      adId: copiedAdId,
      name: trimmedName,
    });
    if (nameFailure) return nameFailure;
  }

  if (
    typeof input.dailyBudgetMinor === "number" &&
    Number.isFinite(input.dailyBudgetMinor) &&
    input.dailyBudgetMinor > 0
  ) {
    const budgetFailure = await updateAdSetDailyBudget({
      ctx,
      adsetId: input.targetAdsetId,
      dailyBudgetMinor: input.dailyBudgetMinor,
      resultingAdId: copiedAdId,
    });
    if (budgetFailure) return budgetFailure;
  }

  const verification = await verifyAd({ ctx, adId: copiedAdId });
  if (!verification.ok) {
    return {
      ok: false,
      httpStatus: verification.httpStatus,
      error: {
        code: "silent_failure",
        message: "Meta returned copied_ad_id but the copied ad could not be verified.",
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
      resultingAdId: copiedAdId,
    };
  }

  const verifiedStatus = String(verification.payload?.status ?? "");
  const verifiedAdsetId = String(verification.payload?.adset_id ?? "");
  const verifiedName = String(verification.payload?.name ?? "");
  const nameMatches = !trimmedName || verifiedName === trimmedName;
  if (
    verifiedStatus !== statusOption ||
    verifiedAdsetId !== input.targetAdsetId ||
    !nameMatches
  ) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        code: "silent_failure",
        message: "Meta returned copied_ad_id but copied ad verification did not match the requested status, ad set, or name.",
      },
      responsePayload: write.payload,
      verificationPayload: verification.payload,
      resultingAdId: copiedAdId,
    };
  }

  return {
    ok: true,
    newAdId: copiedAdId,
    verifiedStatus,
    responsePayload: write.payload,
    verificationPayload: verification.payload,
  };
}
