import { getDb, runDbTransaction } from "@/lib/db";
import type { IntegrationProviderType } from "@/lib/integrations";
import { resolveBusinessReferenceIds } from "@/lib/provider-account-reference-store";

export interface ProviderAccountAssignmentRow {
  id: string;
  business_id: string;
  provider: IntegrationProviderType;
  account_ids: string[];
  created_at: string;
  updated_at: string;
}

export const PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES = [
  "business_provider_accounts",
  "provider_accounts",
] as const;

async function readAssignmentRowsByBusiness(
  businessId: string,
  provider: IntegrationProviderType,
): Promise<ProviderAccountAssignmentRow | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      (ARRAY_AGG(bpa.id ORDER BY bpa.position, bpa.id))[1] AS id,
      bpa.business_id,
      bpa.provider,
      ARRAY_AGG(pa.external_account_id ORDER BY bpa.position, bpa.id) AS account_ids,
      MIN(bpa.created_at) AS created_at,
      MAX(bpa.updated_at) AS updated_at
    FROM business_provider_accounts bpa
    INNER JOIN provider_accounts pa
      ON pa.id = bpa.provider_account_ref_id
    WHERE bpa.business_id = ${businessId}
      AND bpa.provider = ${provider}
      AND bpa.is_selected
    GROUP BY bpa.business_id, bpa.provider
    LIMIT 1
  `) as Array<ProviderAccountAssignmentRow>;

  return rows[0] ?? null;
}

/**
 * Lock namespace for provider account selection.
 *
 * Two levels, taken in a fixed order so they compose with provider write
 * authority rather than deadlocking against it:
 *   1. provider-global, held SHARED by a per-business assignment and
 *      EXCLUSIVE by a provider-wide reset, so a reset happens entirely before
 *      or entirely after each assignment, never through the middle of one;
 *   2. business+provider, held EXCLUSIVE, so two concurrent replacements for
 *      the same business serialise.
 */
const PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE = 0x50415353;

function buildProviderLockKey(provider: IntegrationProviderType) {
  return `provider_account_selection:${provider}`;
}

function buildBusinessLockKey(
  businessId: string,
  provider: IntegrationProviderType,
) {
  return `provider_account_selection:${provider}:${businessId}`;
}

/** Deterministic normalisation: trimmed, non-empty, de-duplicated, order kept. */
export function normalizeProviderAccountIds(
  accountIds: readonly string[],
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of accountIds) {
    const accountId = String(raw ?? "").trim();
    if (!accountId || seen.has(accountId)) continue;
    seen.add(accountId);
    normalized.push(accountId);
  }
  return normalized;
}

export class ProviderAccountSelectionError extends Error {
  constructor(
    readonly code:
      | "identity_missing"
      | "identity_mismatch"
      | "readback_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ProviderAccountSelectionError";
  }
}

/**
 * Replaces the current selection for one business+provider.
 *
 * Identity bindings survive deselection: rows are never deleted, only marked
 * unselected, because many historical references treat a binding as immutable
 * identity. The whole operation runs in one transaction with an exact readback,
 * so a partial selection can never be observed or reported as success.
 */
export async function replaceProviderAccountSelection(input: {
  businessId: string;
  provider: IntegrationProviderType;
  accountIds: readonly string[];
}): Promise<string[]> {
  const accountIds = normalizeProviderAccountIds(input.accountIds);
  const businessRefIds = await resolveBusinessReferenceIds([input.businessId]);
  const businessRefId = businessRefIds.get(input.businessId) ?? null;

  return runDbTransaction(async () => {
    const sql = getDb();
    await sql`
      SELECT pg_advisory_xact_lock_shared(
        ${PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE}::int,
        hashtext(${buildProviderLockKey(input.provider)})
      )
    `;
    await sql`
      SELECT pg_advisory_xact_lock(
        ${PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE}::int,
        hashtext(${buildBusinessLockKey(input.businessId, input.provider)})
      )
    `;

    if (accountIds.length > 0) {
      // Identity rows are created once and never rewritten. ORDER BY keeps
      // concurrent inserts of the same set in a stable order so two callers
      // cannot deadlock against each other.
      await sql`
        INSERT INTO provider_accounts (provider, external_account_id)
        SELECT ${input.provider}, account_id
        FROM unnest(${accountIds}::TEXT[]) AS account_id
        ORDER BY account_id
        ON CONFLICT (provider, external_account_id) DO NOTHING
      `;

      const identities = (await sql`
        SELECT id::text AS id, external_account_id
        FROM provider_accounts
        WHERE provider = ${input.provider}
          AND external_account_id = ANY(${accountIds}::TEXT[])
      `) as Array<{ id: string; external_account_id: string }>;
      if (identities.length !== accountIds.length) {
        const found = new Set(identities.map((row) => row.external_account_id));
        throw new ProviderAccountSelectionError(
          "identity_missing",
          `Provider account identity missing for: ${accountIds
            .filter((accountId) => !found.has(accountId))
            .join(", ")}`,
        );
      }

      // The binding upsert never rewrites provider_account_id: that column is
      // the physical identity a historical reference resolves through, and
      // changing it would silently re-point history at another account.
      await sql`
        INSERT INTO business_provider_accounts (
          business_id, business_ref_id, provider, provider_account_ref_id,
          provider_account_id, position, is_selected
        )
        SELECT
          ${input.businessId},
          ${businessRefId},
          ${input.provider},
          pa.id,
          pa.external_account_id,
          account.ordinality - 1,
          TRUE
        FROM unnest(${accountIds}::TEXT[]) WITH ORDINALITY
          AS account(account_id, ordinality)
        INNER JOIN provider_accounts pa
          ON pa.provider = ${input.provider}
         AND pa.external_account_id = account.account_id
        ORDER BY pa.id
        ON CONFLICT (business_id, provider, provider_account_ref_id) DO UPDATE SET
          business_ref_id = COALESCE(
            business_provider_accounts.business_ref_id,
            EXCLUDED.business_ref_id
          ),
          position = EXCLUDED.position,
          is_selected = TRUE,
          updated_at = now()
      `;
    }

    // Deselect, never delete.
    await sql`
      UPDATE business_provider_accounts
      SET is_selected = FALSE, updated_at = now()
      WHERE business_id = ${input.businessId}
        AND provider = ${input.provider}
        AND is_selected
        AND NOT (provider_account_id = ANY(${accountIds}::TEXT[]))
    `;

    // Exact readback inside the same transaction: what the caller is told was
    // selected is what is durably selected, in order.
    const readback = (await sql`
      SELECT pa.external_account_id AS account_id
      FROM business_provider_accounts bpa
      INNER JOIN provider_accounts pa
        ON pa.id = bpa.provider_account_ref_id
      WHERE bpa.business_id = ${input.businessId}
        AND bpa.provider = ${input.provider}
        AND bpa.is_selected
      ORDER BY bpa.position, bpa.id
    `) as Array<{ account_id: string }>;
    const selected = readback.map((row) => String(row.account_id));
    if (
      selected.length !== accountIds.length ||
      selected.some((accountId, index) => accountId !== accountIds[index])
    ) {
      throw new ProviderAccountSelectionError(
        "readback_mismatch",
        `Selection readback mismatch: expected [${accountIds.join(", ")}], got [${selected.join(", ")}]`,
      );
    }
    return selected;
  });
}

export async function upsertProviderAccountAssignments(params: {
  businessId: string;
  provider: IntegrationProviderType;
  accountIds: string[];
}): Promise<ProviderAccountAssignmentRow> {
  const selected = await replaceProviderAccountSelection(params);
  const row = await readAssignmentRowsByBusiness(params.businessId, params.provider);
  if (!row) {
    // An empty selection is a legitimate outcome, not a failure: the caller
    // deselected everything and the grouped reader returns no row for it.
    if (selected.length === 0) {
      return {
        id: "",
        business_id: params.businessId,
        provider: params.provider,
        account_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }
    throw new Error("Failed to persist provider account assignments.");
  }
  return row;
}

export async function getProviderAccountAssignments(
  businessId: string,
  provider: IntegrationProviderType
): Promise<ProviderAccountAssignmentRow | null> {
  return readAssignmentRowsByBusiness(businessId, provider);
}

/**
 * Deselects every account for one business+provider while preserving the
 * historical binding rows.
 */
export async function clearProviderAccountAssignments(
  businessId: string,
  provider: IntegrationProviderType
): Promise<void> {
  await replaceProviderAccountSelection({
    businessId,
    provider,
    accountIds: [],
  });
}

/**
 * Deselects every account for a provider across all businesses. Takes the
 * provider-global lock EXCLUSIVE so it can never run through the middle of a
 * per-business assignment, which holds the same lock shared.
 */
export async function clearAllProviderAccountAssignmentsForProvider(
  provider: IntegrationProviderType
): Promise<void> {
  await runDbTransaction(async () => {
    const sql = getDb();
    await sql`
      SELECT pg_advisory_xact_lock(
        ${PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE}::int,
        hashtext(${buildProviderLockKey(provider)})
      )
    `;
    await sql`
      UPDATE business_provider_accounts
      SET is_selected = FALSE, updated_at = now()
      WHERE provider = ${provider}
        AND is_selected
    `;
  });
}
