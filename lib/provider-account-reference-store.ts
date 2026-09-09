import { getDb } from "@/lib/db";
import { isMissingRelationError } from "@/lib/db-schema-readiness";

export interface ProviderAccountReferenceInput {
  externalAccountId: string;
  accountName?: string | null;
  currency?: string | null;
  timezone?: string | null;
  isManager?: boolean | null;
  metadata?: Record<string, unknown> | null;
}

function normalizeText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function dedupeProviderAccountInputs(accounts: ProviderAccountReferenceInput[]) {
  const byExternalId = new Map<string, ProviderAccountReferenceInput>();

  for (const account of accounts) {
    const externalAccountId = normalizeText(account.externalAccountId);
    if (!externalAccountId) continue;

    const current = byExternalId.get(externalAccountId);
    byExternalId.set(externalAccountId, {
      externalAccountId,
      accountName: normalizeText(account.accountName) ?? current?.accountName ?? null,
      currency: normalizeText(account.currency) ?? current?.currency ?? null,
      timezone: normalizeText(account.timezone) ?? current?.timezone ?? null,
      isManager:
        typeof account.isManager === "boolean"
          ? account.isManager
          : current?.isManager ?? null,
      metadata: {
        ...(current?.metadata ?? {}),
        ...(account.metadata ?? {}),
      },
    });
  }

  return [...byExternalId.values()];
}

export async function resolveBusinessReferenceIds(businessIds: string[]) {
  const normalizedBusinessIds = [...new Set(businessIds.map((value) => value.trim()).filter(Boolean))];
  if (normalizedBusinessIds.length === 0) {
    return new Map<string, string>();
  }

  const sql = getDb();

  try {
    const rows = (await sql.query(
      `
        SELECT
          id::text AS business_id,
          id::text AS business_ref_id
        FROM businesses
        WHERE id::text = ANY($1::text[])
      `,
      [normalizedBusinessIds],
    )) as Array<{ business_id: string; business_ref_id: string }>;

    return new Map(rows.map((row) => [row.business_id, row.business_ref_id] as const));
  } catch (error) {
    if (isMissingRelationError(error, ["businesses"])) {
      return new Map<string, string>();
    }
    throw error;
  }
}

/**
 * ── ROUND 22, ITEM 1: WHO MAY MOVE THE TIMEZONE BINDING ─────────────────────
 *
 * `provider_accounts.timezone` is the DB-bound account calendar. The Meta
 * partition authority resolves the provider-local day from it precisely because
 * it is NOT the caller's credential payload -- `resolveMetaPartitionDateAuthority`
 * reads the `business_provider_accounts` -> `provider_accounts` binding, and
 * the recent-edit authority judges every receipt against the day that binding
 * defines.
 *
 * The upsert below then wrote `timezone = COALESCE(EXCLUDED.timezone, existing)`
 * for EVERY caller. So any ordinary daily/raw/reference write -- which carries
 * whatever timezone the credential payload or a cached account snapshot
 * happened to hold -- silently overwrote the binding. One core sync was enough:
 * a business bound to America/Los_Angeles came back as Europe/Istanbul, and
 * from that moment the "DB-bound" calendar WAS the credential payload, wearing
 * the binding's name. Round 21's lifecycle seam restored the value by hand
 * between its two runs, which is how the defect stayed invisible.
 *
 *   "preserve"  (DEFAULT) -- an existing non-null binding wins. A null binding
 *               is still populated, so initial discovery works unchanged.
 *   "reconcile" -- the incoming value wins. Reserved for a FRESH provider
 *               account-profile/discovery read that has already passed its own
 *               generation CAS; see `lib/provider-account-snapshots.ts`.
 *
 * The default is the safe one on purpose: a new call site has to ask for the
 * authority to move a binding, and asking is reviewable.
 */
export type ProviderAccountTimezoneAuthority = "preserve" | "reconcile";

export interface ProviderAccountReferenceBindings {
  /** external_account_id -> provider_accounts.id */
  refIds: Map<string, string>;
  /**
   * external_account_id -> the timezone the binding ACTUALLY holds after this
   * call. Ordinary writers stamp their rows from this rather than from the
   * value they passed in, so a row can never disagree with the binding that
   * governs the day it belongs to.
   */
  timezones: Map<string, string>;
}

export async function ensureProviderAccountReferenceBindings(input: {
  provider: string;
  accounts: ProviderAccountReferenceInput[];
  timezoneAuthority?: ProviderAccountTimezoneAuthority;
}): Promise<ProviderAccountReferenceBindings> {
  const accounts = dedupeProviderAccountInputs(input.accounts);
  if (accounts.length === 0) {
    return { refIds: new Map(), timezones: new Map() };
  }

  const sql = getDb();
  const payload = JSON.stringify(
    accounts.map((account) => ({
      external_account_id: account.externalAccountId,
      account_name: account.accountName ?? null,
      currency: account.currency ?? null,
      timezone: account.timezone ?? null,
      is_manager: account.isManager ?? null,
      metadata: account.metadata ?? {},
    })),
  );

  /*
    Not interpolated user input: a two-value switch chosen in this module. The
    "preserve" arm puts the EXISTING value first, so a non-null binding is never
    displaced; the "reconcile" arm is the historical behaviour and is reachable
    only from the fresh-discovery path.
  */
  const timezoneRule =
    (input.timezoneAuthority ?? "preserve") === "reconcile"
      ? "COALESCE(EXCLUDED.timezone, provider_accounts.timezone)"
      : "COALESCE(provider_accounts.timezone, EXCLUDED.timezone)";

  try {
    await sql.query(
      `
        WITH input_accounts AS (
          SELECT
            NULLIF(TRIM(record.external_account_id), '') AS external_account_id,
            NULLIF(TRIM(record.account_name), '') AS account_name,
            NULLIF(TRIM(record.currency), '') AS currency,
            NULLIF(TRIM(record.timezone), '') AS timezone,
            record.is_manager AS is_manager,
            COALESCE(record.metadata, '{}'::jsonb) AS metadata
          FROM jsonb_to_recordset($1::jsonb) AS record(
            external_account_id text,
            account_name text,
            currency text,
            timezone text,
            is_manager boolean,
            metadata jsonb
          )
        )
        INSERT INTO provider_accounts (
          provider,
          external_account_id,
          account_name,
          currency,
          timezone,
          is_manager,
          metadata,
          created_at,
          updated_at
        )
        SELECT
          $2::text,
          external_account_id,
          account_name,
          currency,
          timezone,
          is_manager,
          metadata,
          now(),
          now()
        FROM input_accounts
        WHERE external_account_id IS NOT NULL
        ON CONFLICT (provider, external_account_id) DO UPDATE SET
          account_name = COALESCE(EXCLUDED.account_name, provider_accounts.account_name),
          currency = COALESCE(EXCLUDED.currency, provider_accounts.currency),
          timezone = ${timezoneRule},
          is_manager = COALESCE(EXCLUDED.is_manager, provider_accounts.is_manager),
          metadata = CASE
            WHEN EXCLUDED.metadata = '{}'::jsonb THEN provider_accounts.metadata
            ELSE provider_accounts.metadata || EXCLUDED.metadata
          END,
          updated_at = now()
      `,
      [payload, input.provider],
    );

    const rows = (await sql.query(
      `
        SELECT
          id::text AS provider_account_ref_id,
          external_account_id,
          timezone
        FROM provider_accounts
        WHERE provider = $1
          AND external_account_id = ANY($2::text[])
      `,
      [input.provider, accounts.map((account) => account.externalAccountId)],
    )) as Array<{
      provider_account_ref_id: string;
      external_account_id: string;
      timezone: string | null;
    }>;

    const timezones = new Map<string, string>();
    for (const row of rows) {
      const bound = normalizeText(row.timezone);
      if (bound) timezones.set(row.external_account_id, bound);
    }
    return {
      refIds: new Map(
        rows.map(
          (row) => [row.external_account_id, row.provider_account_ref_id] as const,
        ),
      ),
      timezones,
    };
  } catch (error) {
    if (isMissingRelationError(error, ["provider_accounts"])) {
      return { refIds: new Map(), timezones: new Map() };
    }
    throw error;
  }
}

/**
 * The id-only view, kept for the many callers that need nothing else.
 *
 * Deliberately NOT given a `timezoneAuthority`: a caller that wants to move a
 * binding has to go through `ensureProviderAccountReferenceBindings` and say so
 * explicitly, which makes the authority visible at the call site.
 */
export async function ensureProviderAccountReferenceIds(input: {
  provider: string;
  accounts: ProviderAccountReferenceInput[];
}) {
  const { refIds } = await ensureProviderAccountReferenceBindings(input);
  return refIds;
}
