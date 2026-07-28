import { AsyncLocalStorage } from "node:async_hooks";

/**
 * An in-memory stand-in for the two tables a credential write touches, faithful
 * in the three ways this defect actually turns on.
 *
 * 1. It ROUTES by statement and REFUSES anything it does not recognise. A write
 *    path that reaches for `provider_connections`, `business_provider_accounts`
 *    or `provider_account_assignments` fails loudly instead of quietly widening
 *    its column surface — which is the whole regression being guarded against.
 * 2. It implements `FOR UPDATE OF connection` as a real per-connection mutex
 *    held to end-of-transaction, so a compare-and-set is a compare-and-set and
 *    two concurrent refreshes serialise the way Postgres would serialise them.
 * 3. It implements ROLLBACK by restoring a pre-transaction snapshot, so a
 *    partial write is observable. A stubbed `runDbTransaction` that just calls
 *    its function through cannot fail the rollback test no matter how broken the
 *    implementation is.
 */

export interface FakeConnectionRow {
  id: string;
  business_id: string;
  business_ref_id: string | null;
  provider: string;
  status: string;
  provider_account_ref_id: string | null;
  provider_account_id: string | null;
  provider_account_name: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  connection_generation: number;
  created_at: string;
  updated_at: string;
}

export interface FakeCredentialRow {
  provider_connection_id: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  scopes: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface FakeSelectionRow {
  business_id: string;
  provider: string;
  provider_account_id: string;
  is_selected: boolean;
  updated_at: string;
}

export interface FakeStore {
  provider_connections: FakeConnectionRow[];
  integration_credentials: FakeCredentialRow[];
  /** Never routed. Present so "untouched" is asserted against real content. */
  business_provider_accounts: FakeSelectionRow[];
  provider_account_assignments: Array<Record<string, unknown>>;
  provider_accounts: Array<{ id: string; provider: string; external_account_id: string }>;
}

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

interface Tx {
  held: Map<string, () => void>;
}

export interface ProviderConnectionDbHarness {
  sql: SqlTag;
  runDbTransaction: <T>(fn: () => Promise<T>, options?: { timeoutMs?: number }) => Promise<T>;
  store: FakeStore;
  /** Every statement text this harness has served, in order. */
  queries: string[];
  snapshot: () => string;
  /** Make the NEXT credential UPDATE fail, as a database error would. */
  failNextCredentialUpdate: (message: string) => void;
  /** Run something in the middle of the credential write's transaction. */
  setBeforeCredentialUpdateHook: (hook: (() => void | Promise<void>) | null) => void;
}

export function createProviderConnectionDbHarness(
  seed: FakeStore,
): ProviderConnectionDbHarness {
  const store: FakeStore = structuredClone(seed);
  const queries: string[] = [];
  const txStorage = new AsyncLocalStorage<Tx>();
  // Chained mutex per lock key. The tail is assigned SYNCHRONOUSLY before any
  // await, so two acquirers cannot both observe the lock as free.
  const lockTail = new Map<string, Promise<void>>();
  let pendingCredentialUpdateFailure: string | null = null;
  let beforeCredentialUpdateHook: (() => void | Promise<void>) | null = null;

  async function acquireLock(key: string) {
    const tx = txStorage.getStore();
    if (!tx) throw new Error("FOR UPDATE outside a transaction.");
    if (tx.held.has(key)) return;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = lockTail.get(key) ?? Promise.resolve();
    lockTail.set(
      key,
      previous.then(() => mine),
    );
    await previous;
    tx.held.set(key, release);
  }

  function findConnection(businessId: string, provider: string) {
    return (
      store.provider_connections.find(
        (row) => row.business_id === businessId && row.provider === provider,
      ) ?? null
    );
  }

  function findCredential(connectionId: string) {
    return (
      store.integration_credentials.find(
        (row) => row.provider_connection_id === connectionId,
      ) ?? null
    );
  }

  const sql: SqlTag = async (strings, ...values) => {
    const query = strings.join("?");
    queries.push(query);

    // ── reads ──────────────────────────────────────────────────────────
    if (query.includes("FROM provider_connections pc")) {
      const [businessId, provider] = values as [string, string?];
      const rows = store.provider_connections.filter(
        (row) =>
          row.business_id === businessId && (provider == null || row.provider === provider),
      );
      return rows.map((row) => {
        const credential = findCredential(row.id);
        return {
          ...row,
          access_token: credential?.access_token ?? null,
          refresh_token: credential?.refresh_token ?? null,
          token_expires_at: credential?.token_expires_at ?? null,
          scopes: credential?.scopes ?? null,
          error_message: credential?.error_message ?? null,
          metadata: credential?.metadata ?? {},
        };
      });
    }

    if (query.includes("SELECT connection_generation::text AS generation")) {
      const [businessId, provider] = values as [string, string];
      const row = findConnection(businessId, provider);
      return row
        ? [{ generation: String(row.connection_generation), status: row.status }]
        : [];
    }

    // ── the locked read, shared by both write paths ────────────────────
    if (query.includes("FOR UPDATE OF connection")) {
      const [businessId, provider] = values as [string, string];
      const row = findConnection(businessId, provider);
      if (row) await acquireLock(row.id);
      if (!row) return [];
      const credential = findCredential(row.id);
      // `upsertIntegration` needs the previous refresh token to decide principal
      // identity; the narrow refresh path deliberately does not select it.
      if (query.includes("credential.refresh_token")) {
        return [
          {
            id: row.id,
            status: row.status,
            provider_account_id: row.provider_account_id,
            connection_generation: String(row.connection_generation),
            refresh_token: credential?.refresh_token ?? null,
            scopes: credential?.scopes ?? null,
          },
        ];
      }
      return [
        {
          id: row.id,
          status: row.status,
          connection_generation: String(row.connection_generation),
          scopes: credential?.scopes ?? null,
        },
      ];
    }

    // ── the NARROW credential write ────────────────────────────────────
    if (
      query.includes("UPDATE integration_credentials SET") &&
      query.includes("RETURNING token_expires_at, scopes")
    ) {
      if (beforeCredentialUpdateHook) {
        const hook = beforeCredentialUpdateHook;
        beforeCredentialUpdateHook = null;
        await hook();
      }
      if (pendingCredentialUpdateFailure) {
        const message = pendingCredentialUpdateFailure;
        pendingCredentialUpdateFailure = null;
        throw new Error(message);
      }
      const [accessToken, rotatedRefreshToken, tokenExpiresAt, updatedAt, connectionId] =
        values as [string | null, string | null, string | null, string, string];
      const credential = findCredential(connectionId);
      if (!credential) return [];
      credential.access_token = accessToken;
      credential.refresh_token = rotatedRefreshToken ?? credential.refresh_token;
      credential.token_expires_at = tokenExpiresAt;
      credential.updated_at = updatedAt;
      return [
        { token_expires_at: credential.token_expires_at, scopes: credential.scopes },
      ];
    }

    // ── upsertIntegration's three statements ───────────────────────────
    if (query.includes("INSERT INTO provider_accounts")) {
      const [provider, externalAccountId] = values as [string, string];
      const existing = store.provider_accounts.find(
        (row) => row.provider === provider && row.external_account_id === externalAccountId,
      );
      if (existing) return [{ id: existing.id }];
      const created = {
        id: `provider-account-${store.provider_accounts.length + 1}`,
        provider,
        external_account_id: externalAccountId,
      };
      store.provider_accounts.push(created);
      return [{ id: created.id }];
    }

    if (query.includes("INSERT INTO provider_connections")) {
      const businessId = values[0] as string;
      const provider = values[2] as string;
      const status = values[3] as string;
      const providerAccountRefId = values[4] as string | null;
      const providerAccountId = values[5] as string | null;
      const providerAccountName = values[6] as string | null;
      const connectedAt = values[7] as string | null;
      const now = values[10] as string;
      const replacesCredential = values[11] as boolean;
      const principalUnchanged = values[12] as boolean;
      const isReconnect = values[15] as boolean;
      const authorityChanged = values[16] as boolean;

      let row = findConnection(businessId, provider);
      if (!row) {
        row = {
          id: `connection-${store.provider_connections.length + 1}`,
          business_id: businessId,
          business_ref_id: values[1] as string | null,
          provider,
          status,
          provider_account_ref_id: providerAccountRefId,
          provider_account_id: providerAccountId,
          provider_account_name: providerAccountName,
          connected_at: connectedAt,
          disconnected_at: values[8] as string | null,
          connection_generation: 1,
          created_at: now,
          updated_at: now,
        };
        store.provider_connections.push(row);
        return [{ ...row }];
      }
      row.status = status;
      row.provider_account_ref_id = providerAccountRefId ?? row.provider_account_ref_id;
      row.provider_account_id =
        replacesCredential && !principalUnchanged
          ? providerAccountId
          : (providerAccountId ?? row.provider_account_id);
      row.provider_account_name =
        replacesCredential && !principalUnchanged
          ? providerAccountName
          : (providerAccountName ?? row.provider_account_name);
      row.connected_at = row.connected_at ?? connectedAt;
      row.disconnected_at =
        status === "disconnected" ? now : isReconnect ? null : row.disconnected_at;
      row.connection_generation += authorityChanged ? 1 : 0;
      row.updated_at = now;
      return [{ ...row }];
    }

    if (query.includes("INSERT INTO integration_credentials")) {
      const connectionId = values[0] as string;
      const accessToken = values[1] as string | null;
      const refreshToken = values[2] as string | null;
      const tokenExpiresAt = values[3] as string | null;
      const scopes = values[4] as string | null;
      const errorMessage = values[5] as string | null;
      const metadata = JSON.parse(values[6] as string) as Record<string, unknown>;
      const now = values[7] as string;
      const accessTokenSupplied = values[9] as boolean;
      const isReconnect = values[10] as boolean;
      const mergeMetadata = !(values[11] as boolean);

      let row = findCredential(connectionId);
      if (!row) {
        row = {
          provider_connection_id: connectionId,
          access_token: accessToken,
          refresh_token: refreshToken,
          token_expires_at: tokenExpiresAt,
          scopes,
          error_message: errorMessage,
          metadata,
          created_at: now,
          updated_at: now,
        };
        store.integration_credentials.push(row);
        return [{ ...row }];
      }
      row.access_token = accessToken ?? row.access_token;
      row.refresh_token = refreshToken;
      row.token_expires_at = accessTokenSupplied
        ? tokenExpiresAt
        : (tokenExpiresAt ?? row.token_expires_at);
      row.scopes = scopes ?? row.scopes;
      row.error_message = isReconnect ? errorMessage : (errorMessage ?? row.error_message);
      row.metadata = mergeMetadata
        ? Object.keys(metadata).length === 0
          ? row.metadata
          : { ...row.metadata, ...metadata }
        : metadata;
      row.updated_at = now;
      return [{ ...row }];
    }

    throw new Error(`Unexpected query: ${query.replace(/\s+/g, " ").trim()}`);
  };

  const runDbTransaction = async <T,>(
    fn: () => Promise<T>,
    _options?: { timeoutMs?: number },
  ): Promise<T> => {
    if (txStorage.getStore()) return fn();
    const tx: Tx = { held: new Map() };
    const before = structuredClone(store);
    try {
      return await txStorage.run(tx, fn);
    } catch (error) {
      // ROLLBACK. Restore in place so any reference held by a caller sees it.
      Object.assign(store, structuredClone(before));
      throw error;
    } finally {
      for (const release of tx.held.values()) release();
    }
  };

  return {
    sql,
    runDbTransaction,
    store,
    queries,
    snapshot: () => JSON.stringify(store),
    failNextCredentialUpdate: (message: string) => {
      pendingCredentialUpdateFailure = message;
    },
    setBeforeCredentialUpdateHook: (hook) => {
      beforeCredentialUpdateHook = hook;
    },
  };
}

/** A connected Google integration at generation 7, with a live credential. */
export function seedConnectedGoogleStore(input: {
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  tokenExpiresAt: string;
}): FakeStore {
  return {
    provider_connections: [
      {
        id: "connection-google",
        business_id: "biz_1",
        business_ref_id: "business-ref-biz_1",
        provider: "google",
        status: "connected",
        provider_account_ref_id: "provider-account-1",
        provider_account_id: "1234567890",
        provider_account_name: "Grandmix",
        connected_at: "2026-01-01T00:00:00.000Z",
        disconnected_at: null,
        connection_generation: 7,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-07-01T09:00:00.000Z",
      },
    ],
    integration_credentials: [
      {
        provider_connection_id: "connection-google",
        access_token: input.encryptedAccessToken,
        refresh_token: input.encryptedRefreshToken,
        token_expires_at: input.tokenExpiresAt,
        scopes: "https://www.googleapis.com/auth/adwords",
        error_message: null,
        metadata: { connectedVia: "oauth" },
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-07-01T09:00:00.000Z",
      },
    ],
    business_provider_accounts: [
      {
        business_id: "biz_1",
        provider: "google",
        provider_account_id: "1234567890",
        is_selected: true,
        updated_at: "2026-07-01T09:00:00.000Z",
      },
    ],
    provider_account_assignments: [
      { business_id: "biz_1", provider: "google", provider_account_id: "1234567890" },
    ],
    provider_accounts: [
      { id: "provider-account-1", provider: "google", external_account_id: "1234567890" },
    ],
  };
}
