/**
 * The 0 / 1 / N provider-account fixture, written to a real database.
 *
 * D6 fixes three distinct account postures and says a surface must behave
 * differently in each: zero accounts means "connect or assign", one account may
 * be selected automatically, and N accounts require an explicit selection —
 * with `null` meaning "not selected", never "all accounts". Every claim the
 * branch makes about those postures has so far been made by a unit test holding
 * a hand-built object. This seeds three real businesses, one per posture, so the
 * claim can be made against the mounted route instead.
 *
 * Nothing here is a mock. The rows go through the same tables the production
 * readers query, created by the same migrations, and the password is a real
 * bcrypt hash the real login route verifies.
 */
import bcrypt from "bcryptjs";
import { Client } from "pg";

/** Stable ids so evidence can name a row and a later run can find it again. */
export const RUNTIME_OPERATOR_ID = "e0000000-0000-4000-8000-000000000001";
export const RUNTIME_OPERATOR_EMAIL = "runtime-evidence@adsecute.local";

export const BUSINESS_ZERO_ACCOUNTS = "e0000000-0000-4000-8000-0000000000a0";
export const BUSINESS_ONE_ACCOUNT = "e0000000-0000-4000-8000-0000000000a1";
export const BUSINESS_MANY_ACCOUNTS = "e0000000-0000-4000-8000-0000000000a2";
/** A second tenant, for the isolation checks. Never assigned to the operator. */
export const BUSINESS_OTHER_TENANT = "e0000000-0000-4000-8000-0000000000b0";
export const OTHER_TENANT_OWNER_ID = "e0000000-0000-4000-8000-000000000002";

export const ACCOUNT_ONE = "act_1000000000000001";
export const ACCOUNT_MANY_A = "act_1000000000000002";
export const ACCOUNT_MANY_B = "act_1000000000000003";
export const ACCOUNT_OTHER_TENANT = "act_1000000000000009";

/**
 * Journal rows the History surface really reads.
 *
 * Three provider writes against one ad, with three different outcomes. They
 * exist so two things can be proven that a rowless fixture cannot show: that a
 * surface with rows reports `success` rather than `empty-proven`, and that the
 * number of rows the database holds is the number the screen prints — WP12's
 * "match database counts to rendered counts", which had never been checked.
 *
 * `silent_failure` is included on purpose. It is the outcome the product exists
 * to surface: a write the provider accepted and did not apply.
 */
export const JOURNAL_AD_ID = "23850000000000001";
export const JOURNAL_ROWS = [
  { action: "pause", status: "success", errorCode: null },
  { action: "resume", status: "failure", errorCode: "provider_rejected" },
  { action: "pause", status: "silent_failure", errorCode: null },
] as const;

export interface RuntimeSeed {
  operator: { id: string; email: string; password: string };
  businesses: {
    zeroAccounts: string;
    oneAccount: string;
    manyAccounts: string;
    otherTenant: string;
  };
  accounts: {
    one: string;
    manyA: string;
    manyB: string;
    otherTenant: string;
  };
}

async function connectAccount(
  client: Client,
  input: {
    businessId: string;
    externalAccountId: string;
    accountName: string;
    currency: string;
    timezone: string;
    selected: boolean;
    position: number;
  },
): Promise<void> {
  const account = await client.query<{ id: string }>(
    `INSERT INTO provider_accounts (provider, external_account_id, account_name, currency, timezone, is_manager)
     VALUES ('meta', $1, $2, $3, $4, FALSE)
     ON CONFLICT (provider, external_account_id)
       DO UPDATE SET account_name = EXCLUDED.account_name
     RETURNING id`,
    [input.externalAccountId, input.accountName, input.currency, input.timezone],
  );
  const refId = account.rows[0]!.id;

  await client.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected)
     VALUES ($1, 'meta', $2, $3, $4, $5)
     ON CONFLICT (business_id, provider, provider_account_ref_id)
       DO UPDATE SET is_selected = EXCLUDED.is_selected, position = EXCLUDED.position`,
    [input.businessId, refId, input.externalAccountId, input.position, input.selected],
  );

  if (input.selected) {
    await client.query(
      `UPDATE provider_connections
          SET provider_account_ref_id = $2,
              provider_account_id = $3,
              provider_account_name = $4,
              updated_at = now()
        WHERE business_id = $1 AND provider = 'meta'`,
      [input.businessId, refId, input.externalAccountId, input.accountName],
    );
  }
}

async function connectMeta(client: Client, businessId: string): Promise<void> {
  const connection = await client.query<{ id: string }>(
    `INSERT INTO provider_connections (business_id, provider, status, connected_at)
     VALUES ($1, 'meta', 'connected', now())
     ON CONFLICT (business_id, provider)
       DO UPDATE SET status = 'connected', connected_at = now()
     RETURNING id`,
    [businessId],
  );
  await client.query(
    `INSERT INTO integration_credentials (provider_connection_id, access_token, token_expires_at, scopes)
     VALUES ($1, $2, now() + interval '60 days', 'ads_read,ads_management')
     ON CONFLICT (provider_connection_id)
       DO UPDATE SET access_token = EXCLUDED.access_token,
                     token_expires_at = EXCLUDED.token_expires_at`,
    [
      connection.rows[0]!.id,
      // Not a credential. It is never sent anywhere: the harness makes no
      // provider call, and every Graph request in this branch is refused by the
      // release gates before a token is read.
      "runtime-evidence-not-a-real-token",
    ],
  );
}

export async function seedRuntimeEvidence(databaseUrl: string): Promise<RuntimeSeed> {
  const password = `Runtime-${Math.abs(hash(databaseUrl))}-Evidence!`;
  const passwordHash = await bcrypt.hash(password, 10);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Runtime Evidence Operator', $2, $3)
       ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [RUNTIME_OPERATOR_ID, RUNTIME_OPERATOR_EMAIL, passwordHash],
    );
    await client.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Other Tenant Owner', 'other-tenant@adsecute.local', $2)
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_TENANT_OWNER_ID, passwordHash],
    );

    const businesses: [string, string, string, string, string][] = [
      [BUSINESS_ZERO_ACCOUNTS, "Zero Accounts Co.", RUNTIME_OPERATOR_ID, "America/New_York", "USD"],
      [BUSINESS_ONE_ACCOUNT, "One Account Co.", RUNTIME_OPERATOR_ID, "Europe/Istanbul", "TRY"],
      [BUSINESS_MANY_ACCOUNTS, "Many Accounts Co.", RUNTIME_OPERATOR_ID, "Europe/London", "GBP"],
      [BUSINESS_OTHER_TENANT, "Other Tenant Co.", OTHER_TENANT_OWNER_ID, "UTC", "EUR"],
    ];
    for (const [id, name, ownerId, timezone, currency] of businesses) {
      await client.query(
        `INSERT INTO businesses (id, name, owner_id, timezone, currency)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [id, name, ownerId, timezone, currency],
      );
    }

    // The operator is a member of the first three and of nothing else. The
    // fourth business exists precisely so "no membership" is a real state a
    // request can be made against rather than a described one.
    for (const businessId of [BUSINESS_ZERO_ACCOUNTS, BUSINESS_ONE_ACCOUNT, BUSINESS_MANY_ACCOUNTS]) {
      await client.query(
        `INSERT INTO memberships (user_id, business_id, role, status)
         VALUES ($1, $2, 'admin', 'active')
         ON CONFLICT (user_id, business_id) DO UPDATE SET role = 'admin', status = 'active'`,
        [RUNTIME_OPERATOR_ID, businessId],
      );
    }
    await client.query(
      `INSERT INTO memberships (user_id, business_id, role, status)
       VALUES ($1, $2, 'admin', 'active')
       ON CONFLICT (user_id, business_id) DO NOTHING`,
      [OTHER_TENANT_OWNER_ID, BUSINESS_OTHER_TENANT],
    );

    // Meta is connected everywhere. The posture difference is the account set,
    // not the connection: "connected but nothing assigned" is exactly D6's zero
    // case and is the one a demo tenant most often lands in.
    for (const [id] of businesses) await connectMeta(client, id);

    await connectAccount(client, {
      businessId: BUSINESS_ONE_ACCOUNT,
      externalAccountId: ACCOUNT_ONE,
      accountName: "One Account Co. — Main",
      currency: "TRY",
      timezone: "Europe/Istanbul",
      selected: true,
      position: 0,
    });
    await connectAccount(client, {
      businessId: BUSINESS_MANY_ACCOUNTS,
      externalAccountId: ACCOUNT_MANY_A,
      accountName: "Many Accounts Co. — Retail",
      currency: "GBP",
      timezone: "Europe/London",
      selected: true,
      position: 0,
    });
    await connectAccount(client, {
      businessId: BUSINESS_MANY_ACCOUNTS,
      externalAccountId: ACCOUNT_MANY_B,
      accountName: "Many Accounts Co. — Wholesale",
      currency: "GBP",
      timezone: "Europe/London",
      selected: false,
      position: 1,
    });
    await connectAccount(client, {
      businessId: BUSINESS_OTHER_TENANT,
      externalAccountId: ACCOUNT_OTHER_TENANT,
      accountName: "Other Tenant Co. — Main",
      currency: "EUR",
      timezone: "UTC",
      selected: true,
      position: 0,
    });

    await seedHistoryJournal(client);

    return {
      operator: { id: RUNTIME_OPERATOR_ID, email: RUNTIME_OPERATOR_EMAIL, password },
      businesses: {
        zeroAccounts: BUSINESS_ZERO_ACCOUNTS,
        oneAccount: BUSINESS_ONE_ACCOUNT,
        manyAccounts: BUSINESS_MANY_ACCOUNTS,
        otherTenant: BUSINESS_OTHER_TENANT,
      },
      accounts: {
        one: ACCOUNT_ONE,
        manyA: ACCOUNT_MANY_A,
        manyB: ACCOUNT_MANY_B,
        otherTenant: ACCOUNT_OTHER_TENANT,
      },
    };
  } finally {
    await client.end();
  }
}

/** Deterministic per cluster, so a rerun on the same URL keeps the password. */
function hash(value: string): number {
  let out = 0;
  for (let index = 0; index < value.length; index += 1) {
    out = (out * 31 + value.charCodeAt(index)) | 0;
  }
  return out;
}

/**
 * One ad dimension and three action-log rows, for the one-account business.
 *
 * The journal joins an action row to a dimension row to name the entity and to
 * scope it to a provider account, so both halves are needed or the rows exist
 * and reach no screen. Written with fixed ids so a rerun is idempotent and a
 * count assertion can name what it is counting.
 */
async function seedHistoryJournal(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO meta_ad_dimensions
       (business_id, provider_account_id, campaign_id, adset_id, ad_id,
        ad_name_current, ad_status, first_seen_at, last_seen_at, source_updated_at)
     VALUES ($1, $2, 'cmp_runtime_1', 'adset_runtime_1', $3,
             'Runtime evidence ad', 'PAUSED', now() - interval '20 days',
             now() - interval '1 day', now() - interval '1 day')
     ON CONFLICT (business_id, provider_account_id, ad_id) DO NOTHING`,
    [BUSINESS_ONE_ACCOUNT, ACCOUNT_ONE, JOURNAL_AD_ID],
  );

  // Cleared first, so a rerun against a surviving cluster cannot multiply the
  // count the rendered-versus-stored assertion depends on.
  await client.query("DELETE FROM meta_ads_action_log WHERE business_id = $1", [
    BUSINESS_ONE_ACCOUNT,
  ]);
  let offset = 0;
  for (const row of JOURNAL_ROWS) {
    offset += 1;
    await client.query(
      `INSERT INTO meta_ads_action_log
         (business_id, ad_id, action, source, requested_at, status, error_code,
          payload_request, payload_response, verified_at)
       VALUES ($1, $2, $3, 'ui_manual', now() - ($4 || ' hours')::interval, $5, $6,
               jsonb_build_object('scope_type', 'ad'),
               jsonb_build_object('accepted', true),
               CASE WHEN $5 = 'success' THEN now() - ($4 || ' hours')::interval ELSE NULL END)`,
      [BUSINESS_ONE_ACCOUNT, JOURNAL_AD_ID, row.action, String(offset), row.status, row.errorCode],
    );
  }
}
