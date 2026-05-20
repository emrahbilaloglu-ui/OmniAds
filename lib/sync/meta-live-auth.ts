import { resolveMetaCredentials } from "@/lib/api/meta";

export type MetaLiveAccountAccessStatus =
  | "valid"
  | "invalid"
  | "missing_credentials"
  | "unknown";

export interface MetaLiveAccountAccessValidation {
  status: MetaLiveAccountAccessStatus;
  checkedAccountCount: number;
  validAccountIds: string[];
  invalidAccountIds: string[];
  unknownAccountIds: string[];
  errorMessage: string | null;
}

const DEFAULT_META_LIVE_AUTH_TIMEOUT_MS = 5_000;

function emptyMetaLiveAccountAccessValidation(
  status: MetaLiveAccountAccessStatus,
  errorMessage: string | null,
): MetaLiveAccountAccessValidation {
  return {
    status,
    checkedAccountCount: 0,
    validAccountIds: [],
    invalidAccountIds: [],
    unknownAccountIds: [],
    errorMessage,
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function validateSingleMetaAccountAccess(input: {
  accountId: string;
  accessToken: string;
  timeoutMs: number;
}) {
  const url = new URL(`https://graph.facebook.com/v25.0/${input.accountId}`);
  url.searchParams.set("fields", "id");
  url.searchParams.set("access_token", input.accessToken);

  try {
    const response = await fetch(url.toString(), {
      cache: "no-store",
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    if (response.ok) {
      return {
        accountId: input.accountId,
        status: "valid" as const,
        errorMessage: null,
      };
    }
    const json = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    return {
      accountId: input.accountId,
      status: "invalid" as const,
      errorMessage:
        json.error?.message ?? `Meta account access probe failed with status ${response.status}.`,
    };
  } catch (error) {
    return {
      accountId: input.accountId,
      status: "unknown" as const,
      errorMessage: getErrorMessage(error),
    };
  }
}

export async function validateMetaLiveAccountAccess(input: {
  businessId: string;
  timeoutMs?: number;
}): Promise<MetaLiveAccountAccessValidation> {
  const credentials = await resolveMetaCredentials(input.businessId).catch((error) => ({
    credentials: null,
    errorMessage: getErrorMessage(error),
  }));

  if (credentials && "errorMessage" in credentials) {
    return emptyMetaLiveAccountAccessValidation("unknown", credentials.errorMessage);
  }

  if (!credentials?.accessToken || credentials.accountIds.length === 0) {
    return emptyMetaLiveAccountAccessValidation(
      "missing_credentials",
      "No connected Meta access token or assigned ad account was available.",
    );
  }

  const timeoutMs = Math.max(
    1_000,
    Math.min(input.timeoutMs ?? DEFAULT_META_LIVE_AUTH_TIMEOUT_MS, 15_000),
  );
  const results = await Promise.all(
    credentials.accountIds.map((accountId) =>
      validateSingleMetaAccountAccess({
        accountId,
        accessToken: credentials.accessToken,
        timeoutMs,
      }),
    ),
  );
  const validAccountIds = results
    .filter((result) => result.status === "valid")
    .map((result) => result.accountId);
  const invalidAccountIds = results
    .filter((result) => result.status === "invalid")
    .map((result) => result.accountId);
  const unknownAccountIds = results
    .filter((result) => result.status === "unknown")
    .map((result) => result.accountId);
  const errorMessage =
    results.find((result) => result.errorMessage)?.errorMessage ?? null;
  const status: MetaLiveAccountAccessStatus =
    invalidAccountIds.length > 0
      ? "invalid"
      : unknownAccountIds.length > 0
        ? "unknown"
        : "valid";

  return {
    status,
    checkedAccountCount: results.length,
    validAccountIds,
    invalidAccountIds,
    unknownAccountIds,
    errorMessage,
  };
}
