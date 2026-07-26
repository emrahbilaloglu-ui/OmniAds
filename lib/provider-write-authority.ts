import { getDb } from "@/lib/db";

/**
 * Everything a provider write needs to be authorised, read in ONE statement.
 *
 * The two providers each assembled this from separate reads. Google checked the
 * generation, then resolved the integration, then read the assignments. Meta read
 * the token from one query and the generation from another. Every gap between
 * those reads is a window in which the user can reconnect or deselect, and the
 * request goes out anyway — carrying a credential that has been replaced, to an
 * account that is no longer selected, under a connection that no longer exists.
 *
 * One statement means one MVCC snapshot: the credential, its generation, the
 * connection status and the selection of the exact account are all true at the
 * same instant, or the whole thing is refused.
 *
 * `unknown` is a distinct outcome from `revoked`. A database that cannot answer
 * is not the user removing an account, and reporting it as one turns a transient
 * outage into a terminal "you deselected this" that no retry recovers from.
 */
export type ProviderWriteAuthorityState =
  | "authorized"
  | "revoked"
  | "unknown_error";

export interface ProviderWriteAuthoritySnapshot {
  state: ProviderWriteAuthorityState;
  /** `generation:status`, the exact credential identity of this connection. */
  connectionGeneration: string | null;
  accessToken: string | null;
  providerAccountId: string;
  detail: string | null;
}

/**
 * Normalisation must match the provider's own identity rules, or a selected
 * account looks unselected because of formatting.
 */
function normalizeAccountId(provider: string, value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (provider === "google") return raw.replace(/[^0-9]/g, "");
  return raw.toLowerCase();
}

/**
 * Read the complete authority for one account, atomically.
 *
 * Returns the ENCRYPTED access token exactly as stored; the caller decrypts it
 * through the same path it always has. Nothing here logs or returns a secret in
 * the clear.
 */
export async function readProviderWriteAuthority(input: {
  businessId: string;
  provider: "meta" | "google";
  accountId: string;
}): Promise<ProviderWriteAuthoritySnapshot> {
  const wanted = normalizeAccountId(input.provider, input.accountId);
  if (!wanted) {
    return {
      state: "revoked",
      connectionGeneration: null,
      accessToken: null,
      providerAccountId: input.accountId,
      detail: "No provider account id was supplied.",
    };
  }

  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT
        connection.status,
        connection.connection_generation::text AS connection_generation,
        credential.access_token,
        EXISTS (
          SELECT 1
          FROM business_provider_accounts binding
          WHERE binding.business_id = connection.business_id
            AND binding.provider = connection.provider
            AND binding.is_selected
            AND CASE
                  WHEN connection.provider = 'google'
                    THEN regexp_replace(binding.provider_account_id, '[^0-9]', '', 'g')
                  ELSE lower(binding.provider_account_id)
                END = ${wanted}
        ) AS account_selected
      FROM provider_connections connection
      LEFT JOIN integration_credentials credential
        ON credential.provider_connection_id = connection.id
      WHERE connection.business_id = ${input.businessId}
        AND connection.provider = ${input.provider}
      LIMIT 1
    `) as Array<{
      status: string;
      connection_generation: string;
      access_token: string | null;
      account_selected: boolean;
    }>;

    const row = rows[0];
    if (!row || row.status !== "connected" || !row.access_token) {
      return {
        state: "revoked",
        connectionGeneration: row
          ? `${row.connection_generation}:${row.status}`
          : null,
        accessToken: null,
        providerAccountId: input.accountId,
        detail: "The provider connection is not connected.",
      };
    }
    if (!row.account_selected) {
      return {
        state: "revoked",
        connectionGeneration: `${row.connection_generation}:${row.status}`,
        accessToken: null,
        providerAccountId: input.accountId,
        detail: "This account is not currently selected for this business.",
      };
    }
    return {
      state: "authorized",
      connectionGeneration: `${row.connection_generation}:${row.status}`,
      accessToken: row.access_token,
      providerAccountId: input.accountId,
      detail: null,
    };
  } catch (error: unknown) {
    // NEVER an optional null. A generation or authority read that fails is
    // "I could not tell", which is a 503 — reporting it as absent authority
    // would make an outage indistinguishable from a revocation, and reporting it
    // as no-generation would silently disable the check it exists to perform.
    return {
      state: "unknown_error",
      connectionGeneration: null,
      accessToken: null,
      providerAccountId: input.accountId,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Re-read the authority immediately before a POST and require it to be
 * IDENTICAL to the one the request was built from.
 *
 * "Still selected" is not enough: a user can reconnect as a different principal
 * while the account stays selected by id, and the token captured before that
 * reconnect would still be sent. The generation is what makes that visible.
 */
export async function assertProviderWriteAuthorityUnchanged(input: {
  businessId: string;
  provider: "meta" | "google";
  accountId: string;
  expectedConnectionGeneration: string | null;
}): Promise<
  | { ok: true }
  | { ok: false; httpStatus: 409 | 503; code: string; message: string }
> {
  const authority = await readProviderWriteAuthority(input);
  if (authority.state === "unknown_error") {
    return {
      ok: false,
      httpStatus: 503,
      code: "provider_write_authority_unknown",
      message:
        "Could not verify this account's current authority. No provider request was made.",
    };
  }
  if (authority.state !== "authorized") {
    return {
      ok: false,
      httpStatus: 409,
      code: "provider_account_not_selected",
      message:
        authority.detail ??
        "This account is not currently selected for this business.",
    };
  }
  if (
    input.expectedConnectionGeneration != null &&
    authority.connectionGeneration !== input.expectedConnectionGeneration
  ) {
    return {
      ok: false,
      httpStatus: 409,
      code: "provider_connection_changed",
      message:
        "The provider connection changed after this credential was read. The request was refused rather than sent with a superseded token.",
    };
  }
  return { ok: true };
}
