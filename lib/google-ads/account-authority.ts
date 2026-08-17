import { getIntegration } from "@/lib/integrations";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { normalizeGoogleCustomerId } from "@/lib/google-ads/account-id";

export { normalizeGoogleCustomerId } from "@/lib/google-ads/account-id";

/**
 * Tri-state current-selection authority for a Google Ads customer.
 *
 * The Meta side already distinguishes revocation from uncertainty; the Google
 * advisor writeback distinguished neither, because it did not check selection at
 * all. It took an `accountId` straight from the request body and used the shared
 * business credential, so any customer id the credential could reach was
 * writable — apply, batch and rollback alike.
 *
 * `unknown_error` exists so a database outage reads as "I could not tell" —
 * retryable — rather than as "you removed this account", which is terminal and
 * would be reported to the user as a revocation that never happened.
 */
export type GoogleAdsAccountAuthorityState =
  | "authorized"
  | "confirmed_revoked"
  | "unknown_error";

export interface GoogleAdsAccountAuthorityDecision {
  state: GoogleAdsAccountAuthorityState;
  errorMessage: string | null;
}

export interface GoogleAdsReadAccountAuthorityFailure {
  code:
    | typeof GOOGLE_ADS_ACCOUNT_NOT_SELECTED_CODE
    | typeof GOOGLE_ADS_ACCOUNT_AUTHORITY_UNKNOWN_CODE;
  httpStatus: 409 | 503;
  message: string;
}

export const GOOGLE_ADS_ACCOUNT_NOT_SELECTED_CODE = "google_account_not_selected";
export const GOOGLE_ADS_ACCOUNT_AUTHORITY_UNKNOWN_CODE =
  "google_account_authority_unknown";

export class GoogleAdsAccountAuthorityError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly accountId: string;
  constructor(input: { code: string; httpStatus: number; accountId: string; message: string }) {
    super(input.message);
    this.name = "GoogleAdsAccountAuthorityError";
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.accountId = input.accountId;
  }
}

export function isGoogleAdsAccountAuthorityError(
  error: unknown,
): error is GoogleAdsAccountAuthorityError {
  return (
    error instanceof GoogleAdsAccountAuthorityError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "GoogleAdsAccountAuthorityError")
  );
}

export async function resolveGoogleAdsAccountAuthority(
  businessId: string,
  accountId: string,
): Promise<GoogleAdsAccountAuthorityDecision> {
  try {
    const [integration, assignments] = await Promise.all([
      getIntegration(businessId, "google"),
      getProviderAccountAssignments(businessId, "google"),
    ]);
    if (integration?.status !== "connected" || !integration.access_token) {
      return { state: "confirmed_revoked", errorMessage: null };
    }
    const wanted = normalizeGoogleCustomerId(accountId);
    if (!wanted) return { state: "confirmed_revoked", errorMessage: null };
    const selected = (assignments?.account_ids ?? []).map(normalizeGoogleCustomerId);
    return selected.includes(wanted)
      ? { state: "authorized", errorMessage: null }
      : { state: "confirmed_revoked", errorMessage: null };
  } catch (error) {
    return {
      state: "unknown_error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Assignment-only authority for persisted reporting reads.
 *
 * Unlike provider mutation, a warehouse read does not require a currently
 * connected credential. It does require the customer to remain explicitly
 * assigned to this business. This keeps historical reporting available during
 * reconnects without letting a request select any customer visible to a shared
 * credential.
 */
export async function resolveGoogleAdsReadAccountAuthority(
  businessId: string,
  accountId: string,
): Promise<GoogleAdsAccountAuthorityDecision> {
  try {
    const assignments = await getProviderAccountAssignments(businessId, "google");
    const wanted = normalizeGoogleCustomerId(accountId);
    if (!wanted) return { state: "confirmed_revoked", errorMessage: null };
    const selected = (assignments?.account_ids ?? []).map(normalizeGoogleCustomerId);
    return selected.includes(wanted)
      ? { state: "authorized", errorMessage: null }
      : { state: "confirmed_revoked", errorMessage: null };
  } catch (error) {
    return {
      state: "unknown_error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

/** A route-ready refusal, or null when the reporting account is authorized. */
export function googleAdsReadAccountAuthorityFailure(
  authority: GoogleAdsAccountAuthorityDecision,
): GoogleAdsReadAccountAuthorityFailure | null {
  if (authority.state === "authorized") return null;
  if (authority.state === "unknown_error") {
    return {
      code: GOOGLE_ADS_ACCOUNT_AUTHORITY_UNKNOWN_CODE,
      httpStatus: 503,
      message:
        "Could not verify that this Google Ads account is assigned to the business. No reporting data was read.",
    };
  }
  return {
    code: GOOGLE_ADS_ACCOUNT_NOT_SELECTED_CODE,
    httpStatus: 409,
    message:
      "This Google Ads account is not assigned to this business. No reporting data was read.",
  };
}

/**
 * Throwing form for the immediate pre-request boundary.
 *
 * Throws rather than returning a falsy value so no caller can render a refusal
 * as a benign skip, and so a batch loop stops at the first refusal instead of
 * continuing to call the provider for every remaining item.
 */
export async function assertGoogleAdsAccountAuthority(input: {
  businessId: string;
  accountId: string;
  /**
   * The `generation:status` token the access token about to be sent was read
   * under.
   *
   * Selection alone is not authority. A user can reconnect Google as a different
   * principal while an account stays selected by id, and the token captured
   * before that reconnect would still be POSTed — writing to an account through
   * a credential the user has already replaced. Checking the generation at the
   * literal pre-request boundary makes that a refusal.
   */
  expectedConnectionGeneration?: string | null;
}): Promise<void> {
  // ONE atomic snapshot: credential, generation, connection status and this
  // account's selection settled together. The generation check used to precede
  // two further independent reads, so the answer was assembled from three
  // different instants and a reconnect between any pair went unnoticed.
  if (input.expectedConnectionGeneration != null) {
    const { assertProviderWriteAuthorityUnchanged } = await import(
      "@/lib/provider-write-authority"
    );
    const atomic = await assertProviderWriteAuthorityUnchanged({
      businessId: input.businessId,
      provider: "google",
      accountId: input.accountId,
      expectedConnectionGeneration: input.expectedConnectionGeneration,
    });
    if (!atomic.ok) {
      throw new GoogleAdsAccountAuthorityError({
        code:
          atomic.httpStatus === 503
            ? GOOGLE_ADS_ACCOUNT_AUTHORITY_UNKNOWN_CODE
            : GOOGLE_ADS_ACCOUNT_NOT_SELECTED_CODE,
        httpStatus: atomic.httpStatus,
        accountId: input.accountId,
        message: atomic.message,
      });
    }
    return;
  }
  const authority = await resolveGoogleAdsAccountAuthority(
    input.businessId,
    input.accountId,
  );
  if (authority.state === "authorized") return;
  if (authority.state === "unknown_error") {
    throw new GoogleAdsAccountAuthorityError({
      code: GOOGLE_ADS_ACCOUNT_AUTHORITY_UNKNOWN_CODE,
      httpStatus: 503,
      accountId: input.accountId,
      message:
        "Could not verify that this Google Ads account is currently selected. No provider request was made.",
    });
  }
  throw new GoogleAdsAccountAuthorityError({
    code: GOOGLE_ADS_ACCOUNT_NOT_SELECTED_CODE,
    httpStatus: 409,
    accountId: input.accountId,
    message:
      "This Google Ads account is not currently selected for this business. Historical data remains readable; provider writes are refused.",
  });
}
