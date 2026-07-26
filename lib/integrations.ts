import { getDb, runDbTransaction } from "@/lib/db";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  isEncryptedIntegrationSecret,
} from "@/lib/integration-secrets";
import { resolveBusinessReferenceIds } from "@/lib/provider-account-reference-store";
import { recomputeBusinessDerivedTimezone } from "@/lib/business-timezone";

/**
 * A write computed under one connection generation, refused because the
 * connection has moved on.
 *
 * Its own class so callers can tell "the user reconnected while I was working"
 * from a provider error or a database failure. Recoverable: the caller re-reads
 * and retries under the new generation, or reports a reconnect to the user.
 */
export class ProviderConnectionGenerationConflictError extends Error {
  readonly businessId: string;
  readonly provider: string;
  readonly expected: string | null;
  readonly observed: string | null;
  constructor(input: {
    businessId: string;
    provider: string;
    expected: string | null;
    observed: string | null;
  }) {
    super(
      `Provider connection generation changed for ${input.provider}: expected ${
        input.expected ?? "none"
      }, observed ${input.observed ?? "none"}.`,
    );
    this.name = "ProviderConnectionGenerationConflictError";
    this.businessId = input.businessId;
    this.provider = input.provider;
    this.expected = input.expected;
    this.observed = input.observed;
  }
}

export type IntegrationProviderType =
  | "shopify"
  | "meta"
  | "google"
  | "search_console"
  | "tiktok"
  | "pinterest"
  | "snapchat"
  | "ga4"
  | "klaviyo";

export interface IntegrationRow {
  id: string;
  business_id: string;
  provider: IntegrationProviderType;
  status: string;
  provider_account_id: string | null;
  provider_account_name: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  scopes: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  connected_at: string | null;
  disconnected_at: string | null;
  /**
   * Monotonic, nonsecret generation of this provider connection.
   *
   * A reconnect used to be invisible: `connected_at` is COALESCEd to the
   * ORIGINAL value, so disconnecting and reconnecting — even as a different
   * user — produced a connection that looked byte-identical to the previous
   * one. Anything binding evidence to "the connection it was captured under"
   * therefore kept validating across a reconnect. This increments on every
   * reconnect and every credential replacement, so a snapshot taken under the
   * old credential can be recognised as such without ever comparing secrets.
   *
   * Optional in the type because the column is additive and rows read from a
   * catalog that predates it have no value; the hydrator always populates it,
   * and every consumer reads it as `?? 1`, which is the correct meaning of "this
   * connection has never been re-established".
   */
  connection_generation?: number;
  created_at: string;
  updated_at: string;
}

export const INTEGRATION_REQUIRED_TABLES = [
  "provider_connections",
  "integration_credentials",
] as const;

export type IntegrationMetadataRow = Omit<IntegrationRow, "access_token" | "refresh_token"> & {
  access_token: null;
  refresh_token: null;
  has_refresh_token?: boolean;
};

function hydrateIntegrationRow(row: IntegrationRow): IntegrationRow {
  return {
    ...row,
    access_token: decryptIntegrationSecret(row.access_token),
    refresh_token: decryptIntegrationSecret(row.refresh_token),
  };
}

function hydrateIntegrationMetadataRow(
  row: Omit<IntegrationRow, "access_token" | "refresh_token"> & {
    has_refresh_token?: boolean;
  },
): IntegrationMetadataRow {
  return {
    ...row,
    access_token: null,
    refresh_token: null,
    has_refresh_token: row.has_refresh_token ?? false,
  };
}

interface NormalizedIntegrationConnectionRow {
  id: string;
  business_id: string;
  provider: IntegrationProviderType;
  status: string;
  provider_account_ref_id: string | null;
  provider_account_id: string | null;
  provider_account_name: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  connection_generation: number | string | null;
  created_at: string;
  updated_at: string;
}

interface NormalizedIntegrationCredentialRow {
  provider_connection_id: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  scopes: string | null;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
}

function hydrateIntegrationRowFromNormalized(input: {
  connection: NormalizedIntegrationConnectionRow;
  credentials: NormalizedIntegrationCredentialRow | null;
}): IntegrationRow {
  return hydrateIntegrationRow({
    id: input.connection.id,
    business_id: input.connection.business_id,
    provider: input.connection.provider,
    status: input.connection.status,
    provider_account_id: input.connection.provider_account_id,
    provider_account_name: input.connection.provider_account_name,
    access_token: input.credentials?.access_token ?? null,
    refresh_token: input.credentials?.refresh_token ?? null,
    token_expires_at: input.credentials?.token_expires_at ?? null,
    scopes: input.credentials?.scopes ?? null,
    error_message: input.credentials?.error_message ?? null,
    metadata: input.credentials?.metadata ?? {},
    connected_at: input.connection.connected_at,
    disconnected_at: input.connection.disconnected_at,
    connection_generation: Number(input.connection.connection_generation ?? 1),
    created_at: input.connection.created_at,
    updated_at: input.connection.updated_at,
  });
}

async function readIntegrationRowsByBusiness(
  businessId: string,
  provider?: IntegrationProviderType,
): Promise<IntegrationRow[]> {
  const sql = getDb();
  const normalizedRows = provider
    ? ((await sql`
        SELECT
          pc.id,
          pc.business_id,
          pc.provider,
          pc.status,
          pc.provider_account_id,
          pc.provider_account_name,
          pc.connected_at,
          pc.disconnected_at,
          pc.connection_generation,
          pc.created_at,
          pc.updated_at,
          ic.access_token,
          ic.refresh_token,
          ic.token_expires_at,
          ic.scopes,
          ic.error_message,
          COALESCE(ic.metadata, '{}'::jsonb) AS metadata
        FROM provider_connections pc
        LEFT JOIN integration_credentials ic
          ON ic.provider_connection_id = pc.id
        WHERE pc.business_id = ${businessId}
          AND pc.provider = ${provider}
        ORDER BY pc.provider
      `) as Array<NormalizedIntegrationConnectionRow & NormalizedIntegrationCredentialRow>)
    : ((await sql`
        SELECT
          pc.id,
          pc.business_id,
          pc.provider,
          pc.status,
          pc.provider_account_id,
          pc.provider_account_name,
          pc.connected_at,
          pc.disconnected_at,
          pc.connection_generation,
          pc.created_at,
          pc.updated_at,
          ic.access_token,
          ic.refresh_token,
          ic.token_expires_at,
          ic.scopes,
          ic.error_message,
          COALESCE(ic.metadata, '{}'::jsonb) AS metadata
        FROM provider_connections pc
        LEFT JOIN integration_credentials ic
          ON ic.provider_connection_id = pc.id
        WHERE pc.business_id = ${businessId}
        ORDER BY pc.provider
      `) as Array<NormalizedIntegrationConnectionRow & NormalizedIntegrationCredentialRow>);

  return normalizedRows.map((row) =>
    hydrateIntegrationRowFromNormalized({
      connection: row,
      credentials: {
        provider_connection_id: row.id,
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        token_expires_at: row.token_expires_at,
        scopes: row.scopes,
        error_message: row.error_message,
        metadata: row.metadata,
      },
    }),
  );
}

async function readIntegrationByBusiness(
  businessId: string,
  provider: IntegrationProviderType,
): Promise<IntegrationRow | null> {
  const rows = await readIntegrationRowsByBusiness(businessId, provider);
  return rows[0] ?? null;
}

// ── Queries ────────────────────────────────────────────────────────

/** Get all integrations for a business */
export async function getIntegrationsByBusiness(
  businessId: string,
): Promise<IntegrationRow[]> {
  return readIntegrationRowsByBusiness(businessId);
}

/** Get a specific integration by business + provider */
export async function getIntegration(
  businessId: string,
  provider: IntegrationProviderType,
): Promise<IntegrationRow | null> {
  return readIntegrationByBusiness(businessId, provider);
}

export async function getIntegrationsMetadataByBusiness(
  businessId: string,
): Promise<IntegrationMetadataRow[]> {
  return (await readIntegrationRowsByBusiness(businessId)).map((row) =>
    hydrateIntegrationMetadataRow({
      id: row.id,
      business_id: row.business_id,
      provider: row.provider,
      status: row.status,
      provider_account_id: row.provider_account_id,
      provider_account_name: row.provider_account_name,
      has_refresh_token: Boolean(row.refresh_token),
      token_expires_at: row.token_expires_at,
      scopes: row.scopes,
      error_message: row.error_message,
      metadata: row.metadata,
      connected_at: row.connected_at,
      disconnected_at: row.disconnected_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }),
  );
}

export async function getIntegrationMetadata(
  businessId: string,
  provider: IntegrationProviderType,
): Promise<IntegrationMetadataRow | null> {
  const row = await readIntegrationByBusiness(businessId, provider);
  if (!row) return null;
  return hydrateIntegrationMetadataRow({
    id: row.id,
    business_id: row.business_id,
    provider: row.provider,
    status: row.status,
    provider_account_id: row.provider_account_id,
    provider_account_name: row.provider_account_name,
    has_refresh_token: Boolean(row.refresh_token),
    token_expires_at: row.token_expires_at,
    scopes: row.scopes,
    error_message: row.error_message,
    metadata: row.metadata,
    connected_at: row.connected_at,
    disconnected_at: row.disconnected_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

/** Upsert an integration record after successful OAuth */
export async function upsertIntegration(params: {
  businessId: string;
  provider: IntegrationProviderType;
  status: string;
  providerAccountId?: string;
  providerAccountName?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  scopes?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  /**
   * The `connection_generation:status` token the caller read its inputs under,
   * from `readProviderConnectionGenerationToken`.
   *
   * Supplied by anything that computed its write from a previous read — a token
   * refresh in particular, which reads a refresh token, calls Google, and then
   * writes back. Without the CAS, an OAuth reconnect that lands during that call
   * is overwritten by the older refresh's result.
   */
  expectedConnectionGeneration?: string | null;
  /**
   * Positive declaration that this write is a credential refresh for the SAME
   * provider principal.
   *
   * Only a caller that just refreshed an existing token can know this. It exists
   * because absence of an account id is not evidence of sameness, and treating
   * it as such preserved one principal's refresh token and metadata under
   * another's grant.
   */
  samePrincipal?: boolean;
}): Promise<IntegrationRow> {
  const now = new Date().toISOString();
  const metadataJson = JSON.stringify(params.metadata ?? {});
  const accessToken = encryptIntegrationSecret(params.accessToken ?? null);
  const suppliedRefreshToken = encryptIntegrationSecret(params.refreshToken ?? null);
  // A supplied credential is a replacement, and a replacement is a new
  // generation whether or not the bytes changed — an OAuth re-grant frequently
  // returns the same token.
  const replacesCredential = params.accessToken != null || params.refreshToken != null;

  // ONE transaction for identity, connection and credential.
  //
  // These were three separate statements, so a reader between the second and
  // third saw the NEW provider account with the OLD token — account B under
  // credential A — and a credential write that failed left the connection
  // already pointing at the new account with no way back. Committing them
  // together makes a mixed generation unobservable and makes a failed credential
  // write roll the connection change back with it.
  const integration = await runDbTransaction(async () => {
  const sql = getDb();

  // The row this write is REPLACING, locked so nothing changes underneath the
  // decisions below. Everything about principal identity, generation and which
  // stale state to clear depends on knowing the previous row exactly.
  const currentRows = (await sql`
    SELECT connection.id,
           connection.status,
           connection.provider_account_id,
           connection.connection_generation::text AS connection_generation,
           credential.refresh_token,
           credential.scopes
    FROM provider_connections connection
    LEFT JOIN integration_credentials credential
      ON credential.provider_connection_id = connection.id
    WHERE connection.business_id = ${params.businessId}
      AND connection.provider = ${params.provider}
    FOR UPDATE OF connection
  `) as Array<{
    id: string;
    status: string;
    provider_account_id: string | null;
    connection_generation: string;
    refresh_token: string | null;
    scopes: string | null;
  }>;
  const current = currentRows[0] ?? null;

  // Generation CAS. The caller read its inputs under a specific generation; if
  // the connection has moved since, this write is describing a credential that
  // is no longer current and must not land.
  if (params.expectedConnectionGeneration != null) {
    const observed = current
      ? `${current.connection_generation}:${current.status}`
      : null;
    if (observed !== params.expectedConnectionGeneration) {
      throw new ProviderConnectionGenerationConflictError({
        businessId: params.businessId,
        provider: params.provider,
        expected: params.expectedConnectionGeneration,
        observed,
      });
    }
  }

  // Whose account is this, before and after.
  //
  // `COALESCE(EXCLUDED.refresh_token, existing.refresh_token)` combined
  // principal B's freshly-granted access token with principal A's refresh token
  // whenever the provider declined to return a new one — which Google does
  // routinely on re-consent. The connection then held two halves of two
  // different grants, and the next silent refresh minted an access token for A
  // while everything downstream believed it was talking to B.
  //
  // A refresh token is preserved ONLY when the provider principal is provably
  // unchanged: either the caller named the same account, or it named none at
  // all (a pure token refresh for this same connection). Otherwise it is
  // cleared, and the connection must be re-granted to obtain a new one.
  // Sameness must be PROVEN, not assumed from absence.
  //
  // `providerAccountId == null` was treated as "same principal", and the GSC and
  // GA4 callbacks legitimately supply no account id at all — so a reconnect as a
  // different Google user preserved the previous principal's refresh token,
  // property and site metadata under the new grant. Absence proves nothing; the
  // only positive evidence of sameness is an account id that MATCHES, or a
  // caller that explicitly declares this a same-principal credential refresh.
  const principalUnchanged =
    params.samePrincipal === true ||
    (params.providerAccountId != null &&
      current?.provider_account_id != null &&
      params.providerAccountId === current.provider_account_id) ||
    // Nothing to preserve: a connection with no recorded principal and no
    // credential cannot be leaking one.
    (current == null);
  const refreshToken =
    suppliedRefreshToken ?? (principalUnchanged ? (current?.refresh_token ?? null) : null);
  const clearedForeignRefreshToken =
    suppliedRefreshToken == null && !principalUnchanged && current?.refresh_token != null;
  // Metadata is provider-principal evidence too — a GA4 property id, a Search
  // Console site URL. Merging it across an unproven principal change carries
  // principal A's property into principal B's connection, and every consumer
  // reads it as B's.
  const mergeMetadata = principalUnchanged;

  // Every authority or identity change is a new generation, not just a
  // credential replacement: changing which provider account a connection points
  // at, or which scopes it holds, changes what it is allowed to do.
  const authorityChanged =
    replacesCredential ||
    clearedForeignRefreshToken ||
    (current != null && params.status !== current.status) ||
    (params.providerAccountId != null &&
      params.providerAccountId !== current?.provider_account_id) ||
    (params.scopes != null && params.scopes !== current?.scopes);

  // A reconnect CLEARS stale failure state. `COALESCE(EXCLUDED.error_message,
  // existing)` meant a connection that had failed kept reporting the old error
  // after a successful reconnect, and `disconnected_at` was never cleared, so
  // the row read as connected-and-also-disconnected.
  const isReconnect = params.status === "connected" && authorityChanged;

  let providerAccountRefId: string | null = null;
  if (params.providerAccountId) {
    const providerAccounts = (await sql`
      INSERT INTO provider_accounts (
        provider,
        external_account_id,
        account_name,
        metadata,
        created_at,
        updated_at
      ) VALUES (
        ${params.provider},
        ${params.providerAccountId},
        ${params.providerAccountName ?? null},
        ${metadataJson}::jsonb,
        ${now},
        ${now}
      )
      ON CONFLICT (provider, external_account_id) DO UPDATE SET
        account_name = COALESCE(EXCLUDED.account_name, provider_accounts.account_name),
        metadata = CASE
          WHEN EXCLUDED.metadata = '{}'::jsonb THEN provider_accounts.metadata
          ELSE provider_accounts.metadata || EXCLUDED.metadata
        END,
        updated_at = EXCLUDED.updated_at
      RETURNING id
    `) as Array<{ id: string }>;
    providerAccountRefId = providerAccounts[0]?.id ?? null;
  }

  const businessRefIds = await resolveBusinessReferenceIds([params.businessId]);
  const connections = (await sql`
    INSERT INTO provider_connections (
      business_id,
      business_ref_id,
      provider,
      status,
      provider_account_ref_id,
      provider_account_id,
      provider_account_name,
      connected_at,
      disconnected_at,
      created_at,
      updated_at
    ) VALUES (
      ${params.businessId},
      ${businessRefIds.get(params.businessId) ?? null},
      ${params.provider},
      ${params.status},
      ${providerAccountRefId},
      ${params.providerAccountId ?? null},
      ${params.providerAccountName ?? null},
      ${params.status === "connected" ? now : null},
      ${params.status === "disconnected" ? now : null},
      ${now},
      ${now}
    )
    ON CONFLICT (business_id, provider) DO UPDATE SET
      business_ref_id = COALESCE(provider_connections.business_ref_id, EXCLUDED.business_ref_id),
      status = EXCLUDED.status,
      provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, provider_connections.provider_account_ref_id),
      provider_account_id = COALESCE(EXCLUDED.provider_account_id, provider_connections.provider_account_id),
      provider_account_name = COALESCE(EXCLUDED.provider_account_name, provider_connections.provider_account_name),
      connected_at = COALESCE(provider_connections.connected_at, EXCLUDED.connected_at),
      disconnected_at = CASE
        WHEN EXCLUDED.status = 'disconnected'
          THEN COALESCE(EXCLUDED.disconnected_at, provider_connections.disconnected_at, now())
        -- A reconnect clears it. Leaving it set made the row read as connected
        -- and disconnected at the same time, and every consumer picked one.
        WHEN ${isReconnect} THEN NULL
        ELSE provider_connections.disconnected_at
      END,
      -- A reconnect, a credential replacement, an account change or a scope
      -- change is a NEW generation. Without this the row is byte-identical to
      -- the previous connection — connected_at is COALESCEd to the original —
      -- so evidence bound to "the connection it was captured under" kept
      -- validating across a disconnect, a reconnect by a different user, and a
      -- rotation.
      connection_generation = provider_connections.connection_generation +
        CASE WHEN ${authorityChanged} THEN 1 ELSE 0 END,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `) as NormalizedIntegrationConnectionRow[];
  const connection = connections[0];
  if (!connection) {
    throw new Error("Failed to upsert provider connection.");
  }

  const credentials = (await sql`
    INSERT INTO integration_credentials (
      provider_connection_id,
      access_token,
      refresh_token,
      token_expires_at,
      scopes,
      error_message,
      metadata,
      created_at,
      updated_at
    ) VALUES (
      ${connection.id},
      ${accessToken},
      ${refreshToken},
      ${params.tokenExpiresAt?.toISOString() ?? null},
      ${params.scopes ?? null},
      ${params.errorMessage ?? null},
      ${metadataJson}::jsonb,
      ${now},
      ${now}
    )
    ON CONFLICT (provider_connection_id) DO UPDATE SET
      access_token = COALESCE(EXCLUDED.access_token, integration_credentials.access_token),
      -- Written EXPLICITLY, never COALESCEd against whatever was there. The
      -- value was already decided above from the previous row and the principal
      -- identity, so a cleared foreign refresh token stays cleared.
      refresh_token = EXCLUDED.refresh_token,
      -- A new access token brings its own expiry. COALESCE kept the OLD expiry
      -- when a provider returned a token without one, so a fresh token looked
      -- expired (or an expired one looked fresh) depending on which way the
      -- previous value pointed.
      token_expires_at = CASE
        WHEN ${params.accessToken != null} THEN EXCLUDED.token_expires_at
        ELSE COALESCE(EXCLUDED.token_expires_at, integration_credentials.token_expires_at)
      END,
      scopes = COALESCE(EXCLUDED.scopes, integration_credentials.scopes),
      error_message = CASE
        -- A successful reconnect clears the failure that preceded it.
        WHEN ${isReconnect} THEN EXCLUDED.error_message
        ELSE COALESCE(EXCLUDED.error_message, integration_credentials.error_message)
      END,
      metadata = CASE
        WHEN NOT ${mergeMetadata} THEN EXCLUDED.metadata
        WHEN EXCLUDED.metadata = '{}'::jsonb THEN integration_credentials.metadata
        ELSE integration_credentials.metadata || EXCLUDED.metadata
      END,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `) as Array<NormalizedIntegrationCredentialRow>;

  return hydrateIntegrationRowFromNormalized({
    connection,
    credentials: credentials[0] ?? null,
  });
  });

  // Outside the transaction: a derived-timezone recompute is bookkeeping, and
  // failing it must not roll back a completed connection change.
  if (params.provider === "shopify" || params.provider === "ga4") {
    await recomputeBusinessDerivedTimezone(params.businessId).catch((error: unknown) => {
      console.warn("[integrations] business_timezone_recompute_failed", {
        businessId: params.businessId,
        provider: params.provider,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return integration;
}

/** Mark an integration as disconnected */
export async function disconnectIntegration(
  businessId: string,
  provider: IntegrationProviderType,
): Promise<void> {
  const sql = getDb();
  const connectionRows = (await sql`
    SELECT id
    FROM provider_connections
    WHERE business_id = ${businessId} AND provider = ${provider}
    LIMIT 1
  `) as Array<{ id: string }>;
  const connectionId = connectionRows[0]?.id ?? null;
  if (connectionId) {
    await sql`
      UPDATE provider_connections SET
        status           = 'disconnected',
        disconnected_at  = now(),
        updated_at       = now()
      WHERE id = ${connectionId}
    `;
    await sql`
      UPDATE integration_credentials SET
        access_token     = NULL,
        refresh_token    = NULL,
        token_expires_at = NULL,
        error_message    = NULL,
        metadata         = '{}'::jsonb,
        updated_at       = now()
      WHERE provider_connection_id = ${connectionId}
    `;
  }
  if (provider === "shopify" || provider === "ga4") {
    await recomputeBusinessDerivedTimezone(businessId).catch((error: unknown) => {
      console.warn("[integrations] business_timezone_recompute_failed", {
        businessId,
        provider,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export async function disconnectAllIntegrationsForProvider(
  provider: IntegrationProviderType
): Promise<void> {
  const sql = getDb();
  const impactedBusinessIds = new Set<string>();
  const impactedRows = (await sql`
    SELECT DISTINCT business_id
    FROM provider_connections
    WHERE provider = ${provider}
  `) as Array<{ business_id: string }>;
  for (const row of impactedRows) {
    if (row.business_id) impactedBusinessIds.add(row.business_id);
  }
  await sql`
    UPDATE provider_connections SET
      status           = 'disconnected',
      disconnected_at  = now(),
      updated_at       = now()
    WHERE provider = ${provider}
  `;
  await sql`
    UPDATE integration_credentials ic
    SET
      access_token     = NULL,
      refresh_token    = NULL,
      token_expires_at = NULL,
      error_message    = NULL,
      metadata         = '{}'::jsonb,
      updated_at       = now()
    FROM provider_connections pc
    WHERE pc.id = ic.provider_connection_id
      AND pc.provider = ${provider}
  `;
  if (provider === "shopify" || provider === "ga4") {
    await Promise.all(
      [...impactedBusinessIds].map((businessId) =>
        recomputeBusinessDerivedTimezone(businessId).catch((error: unknown) => {
          console.warn("[integrations] business_timezone_recompute_failed", {
            businessId,
            provider,
            message: error instanceof Error ? error.message : String(error),
          });
        }),
      ),
    );
  }
}

/** Mark an integration as error */
export async function setIntegrationError(
  businessId: string,
  provider: IntegrationProviderType,
  errorMessage: string,
): Promise<void> {
  const sql = getDb();
  const connectionRows = (await sql`
    SELECT id
    FROM provider_connections
    WHERE business_id = ${businessId} AND provider = ${provider}
    LIMIT 1
  `) as Array<{ id: string }>;
  const connectionId = connectionRows[0]?.id ?? null;
  if (connectionId) {
    await sql`
      UPDATE provider_connections SET
        status     = 'error',
        updated_at = now()
      WHERE id = ${connectionId}
    `;
    await sql`
      UPDATE integration_credentials SET
        error_message = ${errorMessage},
        updated_at    = now()
      WHERE provider_connection_id = ${connectionId}
    `;
  }
}

export async function mergeIntegrationMetadata(params: {
  businessId: string;
  provider: IntegrationProviderType;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const sql = getDb();
  const metadataJson = JSON.stringify(params.metadata ?? {});
  const connectionRows = (await sql`
    SELECT id
    FROM provider_connections
    WHERE business_id = ${params.businessId}
      AND provider = ${params.provider}
    LIMIT 1
  `) as Array<{ id: string }>;
  const connectionId = connectionRows[0]?.id ?? null;
  if (connectionId) {
    await sql`
      UPDATE integration_credentials
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${metadataJson}::jsonb,
          updated_at = now()
      WHERE provider_connection_id = ${connectionId}
    `;
  }
}

export async function backfillIntegrationSecretsEncryption(input?: {
  batchSize?: number;
}): Promise<{ scanned: number; updated: number }> {
  const sql = getDb();
  const batchSize = Math.max(1, Math.min(input?.batchSize ?? 100, 1000));
  let scanned = 0;
  let updated = 0;

  while (true) {
    const rows = (await sql`
      SELECT
        ic.id,
        pc.business_id,
        pc.provider,
        ic.access_token,
        ic.refresh_token
      FROM integration_credentials ic
      JOIN provider_connections pc
        ON pc.id = ic.provider_connection_id
      WHERE
        (ic.access_token IS NOT NULL AND ic.access_token NOT LIKE 'enc:v1:%')
        OR
        (ic.refresh_token IS NOT NULL AND ic.refresh_token NOT LIKE 'enc:v1:%')
      ORDER BY ic.id ASC
      LIMIT ${batchSize}
    `) as Array<{
      id: string;
      business_id: string;
      provider: string;
      access_token: string | null;
      refresh_token: string | null;
    }>;

    if (rows.length === 0) break;
    scanned += rows.length;

    for (const row of rows) {
      const nextAccessToken =
        row.access_token && !isEncryptedIntegrationSecret(row.access_token)
          ? encryptIntegrationSecret(row.access_token)
          : row.access_token;
      const nextRefreshToken =
        row.refresh_token && !isEncryptedIntegrationSecret(row.refresh_token)
          ? encryptIntegrationSecret(row.refresh_token)
          : row.refresh_token;

      if (
        nextAccessToken === row.access_token &&
        nextRefreshToken === row.refresh_token
      ) {
        continue;
      }

      await sql`
        UPDATE integration_credentials
        SET
          access_token = ${nextAccessToken},
          refresh_token = ${nextRefreshToken},
          updated_at = now()
        WHERE id = ${row.id}
      `;
      updated += 1;
    }

    if (rows.length < batchSize) break;
  }

  return { scanned, updated };
}
