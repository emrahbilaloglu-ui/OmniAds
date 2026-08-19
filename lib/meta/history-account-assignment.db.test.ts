/**
 * ITEM 11 — History resolves accounts through the CURRENT assignment, proven
 * against a REAL PostgreSQL.
 *
 * `META_HISTORY_ACCOUNTS_SQL` is a string. A mocked database can only prove
 * that the string was passed somewhere; whether `business_provider_accounts`
 * actually filters the row out is a fact about PostgreSQL, so it is asserted by
 * PostgreSQL here.
 *
 * The defect this pins: `business_provider_accounts` carries TWO facts in one
 * table. A row is the immutable historical identity binding — created once,
 * never deleted, because many rows reference it as provenance — and
 * `is_selected` is the current selection. Deselecting an account only flips the
 * flag. History's account read ignored the flag entirely, so it answered with
 * the identity binding: an account the operator had removed from the business
 * still appeared in History's scope, and because `/api/meta/history` validates
 * the caller's `providerAccountId` against exactly that list, the deselected
 * account's journal, currency and name were still served to anyone who asked
 * for it by id. Every other surface in the product resolves scope through
 * `getProviderAccountAssignments`, which has always filtered `is_selected`.
 *
 * Also pinned: cross-business isolation. Both statements are scoped by
 * `business_id`, so another business's selected account is absent — a widening
 * here would leak one tenant's journal into another's screen.
 *
 * Run by `scripts/ephemeral-postgres-meta-history-assignment-seam.ts`, which
 * boots a throwaway cluster on a random free port (never 5432, never 15432) and
 * migrates it from zero. Outside that harness every test below is SKIPPED
 * rather than silently run against whatever `DATABASE_URL` happens to be —
 * which, in this repo, is production. A skipped run is not a pass.
 *
 * No provider client is imported anywhere in this file. Real provider writes
 * performed: zero.
 */
import { beforeAll, describe, expect, it } from "vitest";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

const { getDb } = await import("@/lib/db");
const { readMetaHistoryAccounts, readMetaHistoryAssignedAccountIds } =
  await import("@/lib/meta/history-read-model");

const seeded = { businessId: "", otherBusinessId: "" };

const SELECTED = "act_history_selected";
const DESELECTED = "act_history_deselected";
const OTHER_BUSINESS_ACCOUNT = "act_history_other_business";

async function seed() {
  const sql = getDb();
  const [user] = (await sql`
    INSERT INTO users (name, email, password_hash)
    VALUES ('History seam', 'history-assignment@example.invalid', 'x')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [business] = (await sql`
    INSERT INTO businesses (name, owner_id)
    VALUES ('History assignment business', ${user!.id}::uuid)
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [otherBusiness] = (await sql`
    INSERT INTO businesses (name, owner_id)
    VALUES ('Another tenant', ${user!.id}::uuid)
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  seeded.businessId = business!.id;
  seeded.otherBusinessId = otherBusiness!.id;

  for (const [externalId, name] of [
    [SELECTED, "Selected account"],
    [DESELECTED, "Deselected account"],
    [OTHER_BUSINESS_ACCOUNT, "Someone else's account"],
  ] as const) {
    await sql`
      INSERT INTO provider_accounts (provider, external_account_id, account_name, currency, timezone)
      VALUES ('meta', ${externalId}, ${name}, 'EUR', 'Europe/Istanbul')
      ON CONFLICT (provider, external_account_id) DO NOTHING
    `;
  }

  const bind = async (
    businessId: string,
    externalId: string,
    isSelected: boolean,
    position: number,
  ) => {
    await sql`
      INSERT INTO business_provider_accounts (
        business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected
      )
      SELECT ${businessId}, 'meta', pa.id, pa.external_account_id, ${position}, ${isSelected}
      FROM provider_accounts pa
      WHERE pa.provider = 'meta' AND pa.external_account_id = ${externalId}
    `;
  };

  // The deselected account is bound FIRST, so a read that ignores the flag
  // would return it at position 0 — the account a "pick the first one" fallback
  // would land on.
  await bind(seeded.businessId, DESELECTED, false, 0);
  await bind(seeded.businessId, SELECTED, true, 1);
  await bind(seeded.otherBusinessId, OTHER_BUSINESS_ACCOUNT, true, 0);

  // Warehouse rows for every account, including the deselected one. This is the
  // realistic state: observations already collected do not disappear when an
  // account is deselected, and they must not be able to put it back on screen.
  for (const [businessId, accountId] of [
    [seeded.businessId, SELECTED],
    [seeded.businessId, DESELECTED],
    [seeded.otherBusinessId, OTHER_BUSINESS_ACCOUNT],
  ] as const) {
    await sql`
      INSERT INTO meta_account_daily (
        business_id, provider_account_id, date, account_name,
        account_timezone, account_currency
      )
      VALUES (${businessId}, ${accountId}, CURRENT_DATE - 1, ${`${accountId} warehouse name`},
              'Europe/Istanbul', 'EUR')
      ON CONFLICT (business_id, provider_account_id, date) DO NOTHING
    `;
  }
}

describe.skipIf(!SEAM)(
  "Meta History account scope is the current assignment",
  () => {
    beforeAll(async () => {
      await seed();
    });

    it("omits a bound account whose selection was withdrawn", async () => {
      const accounts = await readMetaHistoryAccounts(seeded.businessId);
      const ids = accounts.map((account) => account.id);

      expect(ids).toContain(SELECTED);
      // The identity row is still there, and so are its warehouse rows. Neither
      // is an assignment.
      expect(ids).not.toContain(DESELECTED);
    });

    it("keeps the withdrawn row in the table it was never allowed to delete", async () => {
      // Proving the omission is a FILTER, not a deletion. Deleting the binding
      // would break every row that references it as provenance, which is why
      // `is_selected` exists in the first place.
      const rows = (await getDb()`
        SELECT provider_account_id, is_selected
        FROM business_provider_accounts
        WHERE business_id = ${seeded.businessId} AND provider = 'meta'
        ORDER BY position
      `) as Array<{ provider_account_id: string; is_selected: boolean }>;

      expect(rows.map((row) => row.provider_account_id)).toEqual([
        DESELECTED,
        SELECTED,
      ]);
      expect(rows[0]!.is_selected).toBe(false);
    });

    it("agrees with the canonical assignment guard the rest of the product reads", async () => {
      const assigned = await readMetaHistoryAssignedAccountIds(
        seeded.businessId,
      );

      expect(assigned).toEqual([SELECTED]);
    });

    it("does not reach another business's selected account", async () => {
      const accounts = await readMetaHistoryAccounts(seeded.businessId);
      const assigned = await readMetaHistoryAssignedAccountIds(
        seeded.businessId,
      );

      expect(accounts.map((account) => account.id)).not.toContain(
        OTHER_BUSINESS_ACCOUNT,
      );
      expect(assigned).not.toContain(OTHER_BUSINESS_ACCOUNT);
    });

    it("still serves the selected account's identity facts", async () => {
      // Narrowing must not cost the surface the currency it needs. A missing
      // currency here would become an em-dash on screen at best, and a silent
      // USD at worst.
      const accounts = await readMetaHistoryAccounts(seeded.businessId);
      const selected = accounts.find((account) => account.id === SELECTED);

      expect(selected).toBeTruthy();
      expect(selected!.currency).toBe("EUR");
      expect(selected!.name).toBe("Selected account");
    });

    it("re-selecting restores the account without re-creating the binding", async () => {
      const sql = getDb();
      const before = (await sql`
        SELECT id::text AS id FROM business_provider_accounts
        WHERE business_id = ${seeded.businessId}
          AND provider = 'meta'
          AND provider_account_id = ${DESELECTED}
      `) as Array<{ id: string }>;

      await sql`
        UPDATE business_provider_accounts
        SET is_selected = TRUE
        WHERE business_id = ${seeded.businessId}
          AND provider = 'meta'
          AND provider_account_id = ${DESELECTED}
      `;

      const accounts = await readMetaHistoryAccounts(seeded.businessId);
      expect(accounts.map((account) => account.id)).toContain(DESELECTED);

      const after = (await sql`
        SELECT id::text AS id FROM business_provider_accounts
        WHERE business_id = ${seeded.businessId}
          AND provider = 'meta'
          AND provider_account_id = ${DESELECTED}
      `) as Array<{ id: string }>;
      // Same row id: the binding was never destroyed and re-made, so nothing
      // that references it as provenance was ever orphaned.
      expect(after[0]!.id).toBe(before[0]!.id);

      await sql`
        UPDATE business_provider_accounts
        SET is_selected = FALSE
        WHERE business_id = ${seeded.businessId}
          AND provider = 'meta'
          AND provider_account_id = ${DESELECTED}
      `;
    });
  },
);
