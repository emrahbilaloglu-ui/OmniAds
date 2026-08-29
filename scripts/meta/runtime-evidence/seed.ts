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

import { META_CANONICAL_METRIC_SCHEMA_VERSION } from "@/lib/meta/canonical-metrics";

/** Stable ids so evidence can name a row and a later run can find it again. */
export const RUNTIME_OPERATOR_ID = "e0000000-0000-4000-8000-000000000001";
export const RUNTIME_OPERATOR_EMAIL = "runtime-evidence@adsecute.local";

export const BUSINESS_ZERO_ACCOUNTS = "e0000000-0000-4000-8000-0000000000a0";
export const BUSINESS_ONE_ACCOUNT = "e0000000-0000-4000-8000-0000000000a1";
export const BUSINESS_MANY_ACCOUNTS = "e0000000-0000-4000-8000-0000000000a2";
/**
 * One assigned account and NO timezone.
 *
 * D7 treats the reporting timezone as a fact that can be missing, and every
 * other business here has one — so the "missing" branch of every window label,
 * every as-of line and every day-boundary decision had no fixture to be read
 * against. A surface that quietly assumes UTC when it does not know is exactly
 * the D8 defect, one clock over.
 */
export const BUSINESS_NO_TIMEZONE = "e0000000-0000-4000-8000-0000000000a3";
export const ACCOUNT_NO_TIMEZONE = "act_1000000000000005";
/** A second tenant, for the isolation checks. Never assigned to the operator. */
export const BUSINESS_OTHER_TENANT = "e0000000-0000-4000-8000-0000000000b0";
export const OTHER_TENANT_OWNER_ID = "e0000000-0000-4000-8000-000000000002";

export const ACCOUNT_ONE = "act_1000000000000001";
export const ACCOUNT_MANY_A = "act_1000000000000002";
export const ACCOUNT_MANY_B = "act_1000000000000003";
/**
 * Known to the credential and NOT assigned.
 *
 * `ACCOUNT_MANY_B` used to carry this role, which is why the "many accounts"
 * business had only one assigned account. The two facts are separate — a
 * business can be assigned several accounts AND see one it has not been
 * assigned — so they now have an account each.
 */
export const ACCOUNT_MANY_UNASSIGNED = "act_1000000000000004";
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

/**
 * Two creatives the Creative Studio can actually list, and therefore share.
 *
 * WP11's lifecycle starts with a mint, and a mint starts with a selection: the
 * studio's Share control is disabled until at least one asset row is ticked,
 * and the server refuses a snapshot holding no creatives. The fixture had ad
 * DIMENSIONS but no creative rows and no daily metrics at all, so the assets
 * table was empty on every posture — which made the whole share lifecycle
 * unreachable through the mounted UI rather than merely untested.
 *
 * Two, not one: a snapshot of a single row cannot show that a selection is
 * respected rather than a whole account being shared.
 */
export const STUDIO_CREATIVE_IDS = ["120000000000000101", "120000000000000102"] as const;

/** Longer than the studio's 28-day default window; see `seedCreativeStudioAssets`. */
export const STUDIO_SEEDED_DAYS = 35;

export interface RuntimeSeed {
  operator: { id: string; email: string; password: string };
  businesses: {
    zeroAccounts: string;
    oneAccount: string;
    manyAccounts: string;
    noTimezone: string;
    otherTenant: string;
  };
  accounts: {
    one: string;
    manyA: string;
    manyB: string;
    manyUnassigned: string;
    noTimezone: string;
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
      /*
       * On the top plan, deliberately.
       *
       * The operator was seeded with no `plan_override`, which the billing
       * endpoint resolves to `starter` — and `PLAN_GATED_MODULES` records that
       * three Creative Studio tabs, Reports and Insights refuse to render below
       * Growth and Pro. So every legacy Creative surface in this harness was
       * answering "Growth plan required" rather than answering at all, and a
       * market-readiness corpus that never sees a surface is measuring the
       * paywall.
       *
       * The gate itself is proven by `plan-gated-modules.test.ts`, which holds
       * the list against every `PlanGate` in the tree. This fixture is for
       * everything BEHIND it.
       */
      `INSERT INTO users (id, name, email, password_hash, plan_override)
       VALUES ($1, 'Runtime Evidence Operator', $2, $3, 'scale')
       ON CONFLICT (id) DO UPDATE
         SET password_hash  = EXCLUDED.password_hash,
             plan_override  = EXCLUDED.plan_override`,
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

    // Written separately because the column is NULL and the tuple list above
    // is typed for four strings; spelling it out also keeps the missing fact
    // visible instead of hidden behind an empty cell in a table.
    await client.query(
      `INSERT INTO businesses (id, name, owner_id, timezone, currency)
       VALUES ($1, 'No Timezone Co.', $2, NULL, 'USD')
       ON CONFLICT (id) DO UPDATE SET timezone = NULL`,
      [BUSINESS_NO_TIMEZONE, RUNTIME_OPERATOR_ID],
    );

    // The operator is a member of the first four and of nothing else. The
    // other-tenant business exists precisely so "no membership" is a real state
    // a request can be made against rather than a described one.
    for (const businessId of [
      BUSINESS_ZERO_ACCOUNTS,
      BUSINESS_ONE_ACCOUNT,
      BUSINESS_MANY_ACCOUNTS,
      BUSINESS_NO_TIMEZONE,
    ]) {
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
      /*
       * ASSIGNED, not merely discovered.
       *
       * This was `false`, and `readProviderScopeCatalog` only ever returns
       * accounts with `is_selected`, so the "many accounts" business had
       * exactly ONE assigned account. Every N-account claim measured against
       * this fixture was measuring the 1-account posture under an N-account
       * name: no surface here had ever reached `account_required`, and no
       * picker had ever had a second option to offer.
       */
      selected: true,
      position: 1,
    });
    await connectAccount(client, {
      businessId: BUSINESS_MANY_ACCOUNTS,
      externalAccountId: ACCOUNT_MANY_UNASSIGNED,
      accountName: "Many Accounts Co. — Not assigned",
      currency: "GBP",
      timezone: "Europe/London",
      // Visible to the credential, never assigned: the case where a requested
      // id exists and is still refused.
      selected: false,
      position: 2,
    });

    await connectMeta(client, BUSINESS_NO_TIMEZONE);
    await connectAccount(client, {
      businessId: BUSINESS_NO_TIMEZONE,
      externalAccountId: ACCOUNT_NO_TIMEZONE,
      accountName: "No Timezone Co. — Main",
      currency: "USD",
      // The ACCOUNT has one and the BUSINESS does not, which is the case worth
      // seeding: a surface that silently borrows the account's clock for the
      // business's day boundary is wrong in a way that only shows up near
      // midnight.
      timezone: "America/Los_Angeles",
      selected: true,
      position: 0,
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
    await seedCreativeStudioAssets(client);
    await assertD6Shape(client);

    return {
      operator: { id: RUNTIME_OPERATOR_ID, email: RUNTIME_OPERATOR_EMAIL, password },
      businesses: {
        zeroAccounts: BUSINESS_ZERO_ACCOUNTS,
        oneAccount: BUSINESS_ONE_ACCOUNT,
        manyAccounts: BUSINESS_MANY_ACCOUNTS,
        noTimezone: BUSINESS_NO_TIMEZONE,
        otherTenant: BUSINESS_OTHER_TENANT,
      },
      accounts: {
        one: ACCOUNT_ONE,
        manyA: ACCOUNT_MANY_A,
        manyB: ACCOUNT_MANY_B,
        manyUnassigned: ACCOUNT_MANY_UNASSIGNED,
        noTimezone: ACCOUNT_NO_TIMEZONE,
        otherTenant: ACCOUNT_OTHER_TENANT,
      },
    };
  } finally {
    await client.end();
  }
}

/**
 * The fixture is 0 / 1 / N, checked rather than assumed.
 *
 * `ACCOUNT_MANY_B` was seeded unselected, and every reader of an assignment
 * filters on `is_selected` — so the "many accounts" business had one assigned
 * account and every N-account assertion in this harness was silently measuring
 * the 1-account posture. A fixture that lies about its own shape makes every
 * test written against it agree with the wrong thing, so it is asserted here,
 * once, in the same terms the product reads it.
 */
async function assertD6Shape(client: Client): Promise<void> {
  const expected: ReadonlyArray<[string, string, number]> = [
    [BUSINESS_ZERO_ACCOUNTS, "zero", 0],
    [BUSINESS_ONE_ACCOUNT, "one", 1],
    [BUSINESS_MANY_ACCOUNTS, "many", 2],  // plus one discovered and unassigned
    [BUSINESS_NO_TIMEZONE, "no timezone", 1],
    [BUSINESS_OTHER_TENANT, "other tenant", 1],
  ];
  for (const [businessId, label, count] of expected) {
    const rows = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM business_provider_accounts
        WHERE business_id = $1 AND provider = 'meta' AND is_selected`,
      [businessId],
    );
    const actual = Number(rows.rows[0]?.count ?? "0");
    if (actual !== count) {
      throw new Error(
        `the ${label} fixture has ${actual} assigned Meta accounts, not ${count}. ` +
          "Every D6 assertion made against it would be measuring a posture it does not have.",
      );
    }
  }
}

/**
 * The Creative Studio's assets table, seeded so it has rows to tick.
 *
 * `groupBy=creative` reads `meta_creative_daily` joined to
 * `meta_creative_dimensions`; without both, the studio renders an empty table
 * and every share control below it is correctly disabled. Fourteen days ending
 * YESTERDAY for the same reason the journal is dated three days back — a
 * fixture written at `now()` sits inside the default window before local
 * midnight and outside it afterwards.
 *
 * `metric_schema_version` is the canonical version rather than the column
 * default: rows at v1 are read as pre-canonical and are excluded from the
 * metrics the studio prints.
 */
async function seedCreativeStudioAssets(client: Client): Promise<void> {
  // Cleared first, so a rerun against a surviving cluster cannot double a count
  // that a rendered-versus-stored assertion depends on.
  await client.query(
    "DELETE FROM meta_creative_daily WHERE business_id = $1 AND provider_account_id = $2",
    [BUSINESS_ONE_ACCOUNT, ACCOUNT_ONE],
  );

  for (const [index, creativeId] of STUDIO_CREATIVE_IDS.entries()) {
    const ordinal = index + 1;
    await client.query(
      `INSERT INTO meta_creative_dimensions
         (business_id, provider_account_id, campaign_id, adset_id, ad_id, creative_id,
          creative_name, headline, primary_text, destination_url, asset_type,
          projection_json, first_seen_at, last_seen_at, source_updated_at)
       VALUES ($1, $2, 'cmp_runtime_1', 'adset_runtime_1', $3, $4,
               $5, $6, $7, 'https://example.invalid/runtime-evidence', 'image',
               $8::jsonb,
               now() - interval '40 days', now() - interval '1 day', now() - interval '1 day')
       ON CONFLICT (business_id, provider_account_id, creative_id) DO UPDATE
         SET creative_name   = EXCLUDED.creative_name,
             projection_json = EXCLUDED.projection_json,
             last_seen_at    = EXCLUDED.last_seen_at`,
      [
        BUSINESS_ONE_ACCOUNT,
        ACCOUNT_ONE,
        `2385000000000010${ordinal}`,
        creativeId,
        `Runtime evidence creative ${ordinal}`,
        `Headline ${ordinal}`,
        `Primary text ${ordinal}`,
        JSON.stringify(studioProjection(creativeId, ordinal)),
      ],
    );

    for (let dayBack = 1; dayBack <= STUDIO_SEEDED_DAYS; dayBack += 1) {
      const spend = 40 * ordinal + dayBack;
      await client.query(
        `INSERT INTO meta_creative_daily
           (business_id, provider_account_id, date, campaign_id, adset_id, ad_id, creative_id,
            creative_name, headline, primary_text, destination_url, asset_type,
            account_timezone, account_currency,
            spend, impressions, clicks, conversions, revenue, roas, ctr, cpc, link_clicks,
            metric_schema_version)
         VALUES ($1, $2, (current_date - $3::int), 'cmp_runtime_1', 'adset_runtime_1', $4, $5,
                 $6, $7, $8, 'https://example.invalid/runtime-evidence', 'image',
                 'Europe/Istanbul', 'TRY',
                 $9, $10, $11, $12, $13, $14, $15, $16, $17,
                 $18)
         ON CONFLICT (business_id, provider_account_id, date, creative_id) DO NOTHING`,
        [
          BUSINESS_ONE_ACCOUNT,
          ACCOUNT_ONE,
          dayBack,
          `2385000000000010${ordinal}`,
          creativeId,
          `Runtime evidence creative ${ordinal}`,
          `Headline ${ordinal}`,
          `Primary text ${ordinal}`,
          spend,
          spend * 100,
          spend * 3,
          ordinal,
          spend * 2,
          2,
          0.03,
          spend / Math.max(1, spend * 3),
          spend * 2,
          META_CANONICAL_METRIC_SCHEMA_VERSION,
        ],
      );
    }
  }
}

/**
 * The dimension row's `projection_json`, which is not optional.
 *
 * `coerceRawCreativeRow` returns null for anything without `id`, `creative_id`
 * and a `copy_text` key, and the assembler drops every fact row whose
 * projection is null. A dimension seeded with the column default `{}` therefore
 * produces a warehouse read that reports `status: ok` with zero rows — coverage
 * satisfied, observation timestamp present, nothing rendered. That is the exact
 * shape this fixture hit before the projection was written.
 *
 * `currency` is required for a different reason: the warehouse throws
 * `meta_currency_unavailable` when no row carries one, and a throw here becomes
 * "Meta creative data could not be read for this scope."
 */
function studioProjection(creativeId: string, ordinal: number) {
  return {
    id: `2385000000000010${ordinal}`,
    creative_id: creativeId,
    object_story_id: null,
    effective_object_story_id: null,
    post_id: null,
    associated_ads_count: 1,
    account_id: ACCOUNT_ONE,
    account_name: "One Account Co. — Main",
    campaign_id: "cmp_runtime_1",
    campaign_name: "Runtime evidence campaign",
    adset_id: "adset_runtime_1",
    adset_name: "Runtime evidence ad set",
    currency: "TRY",
    name: `Runtime evidence creative ${ordinal}`,
    launch_date: null,
    copy_text: `Primary text ${ordinal}`,
    copy_variants: [`Primary text ${ordinal}`],
    headline_variants: [`Headline ${ordinal}`],
    description_variants: [],
    copy_source: null,
    copy_debug_sources: [],
    unresolved_reason: null,
    // No remote asset: the harness must not reach the network to render a row.
    preview_url: null,
    preview_source: null,
    thumbnail_url: null,
    image_url: null,
    table_thumbnail_url: null,
    card_preview_url: null,
    is_catalog: false,
    preview_state: "unavailable",
    preview: {
      render_mode: "unavailable",
      image_url: null,
      video_url: null,
      poster_url: null,
      source: null,
      is_catalog: false,
    },
    tags: [],
    ai_tags: {},
    format: "image",
    creative_type: "feed",
    creative_type_label: "Feed",
    creative_delivery_type: "standard",
    creative_visual_format: "image",
    creative_primary_type: "standard",
    creative_primary_label: "Standard",
    creative_secondary_type: null,
    creative_secondary_label: null,
    spend: 0,
    purchase_value: 0,
    roas: 0,
    cpa: 0,
    clicks: 0,
    cpc_link: 0,
    cpm: 0,
    ctr_all: 0,
    purchases: 0,
    impressions: 0,
    link_clicks: 0,
    landing_page_views: 0,
    add_to_cart: 0,
    initiate_checkout: 0,
    thumbstop: 0,
    click_to_atc: 0,
    atc_to_purchase: 0,
    leads: 0,
    messages: 0,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
  };
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
 * The journal joins an action row to a dimension row to name the entity, so
 * both halves are needed or the rows exist and reach no screen.
 *
 * The action row must also carry its OWN `provider_account_id`. Since
 * `43dd42345` the writes correlation matches on `action_log.provider_account_id`
 * directly and a null fails closed — the dimension join proves an entity by
 * that id exists under the selected account, not that it exists under no other,
 * so it was never account proof. Production persists the column on both write
 * paths in `lib/meta/ads-action-log.ts`; a fixture that omitted it was
 * describing a row shape the product no longer writes, and the surface
 * correctly rendered nothing for it.
 *
 * Dated three days back, not `now()`. The default evidence window is the last
 * 28 days ENDING YESTERDAY, so rows written at `now() - 3 hours` were inside it
 * before local midnight and outside it after — the same class of clock race
 * that `migrations-from-zero` hit in its own fixture. A History surface that
 * says `success` in the evening and `empty-proven` after midnight is not
 * reporting on the product.
 *
 * Written with fixed ids so a rerun is idempotent and a
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
         (business_id, provider_account_id, ad_id, action, source, requested_at,
          status, error_code, payload_request, payload_response, verified_at)
       VALUES ($1, $7, $2, $3, 'ui_manual',
               now() - interval '3 days' - ($4 || ' hours')::interval, $5, $6,
               jsonb_build_object('scope_type', 'ad'),
               jsonb_build_object('accepted', true),
               CASE WHEN $5 = 'success'
                    THEN now() - interval '3 days' - ($4 || ' hours')::interval
                    ELSE NULL END)`,
      [
        BUSINESS_ONE_ACCOUNT,
        JOURNAL_AD_ID,
        row.action,
        String(offset),
        row.status,
        row.errorCode,
        ACCOUNT_ONE,
      ],
    );
  }
}
