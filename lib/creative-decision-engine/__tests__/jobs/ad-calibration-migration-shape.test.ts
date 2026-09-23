/**
 * Does the migration reach an EXISTING table, or only a brand-new one?
 *
 * This file exists because of a bug that a migration-from-zero gate cannot see.
 * `.v6` added `config_authority_counts_json` to `CREATE TABLE IF NOT EXISTS` and
 * nowhere else. On a fresh database that is the whole schema and every check
 * passes. On the live database the CREATE is a no-op, the column never appears,
 * and the first `.v6` INSERT fails with `undefined_column` — confirmed
 * read-only against the live catalog, which had `contract_version` and no
 * `config_authority_counts_json`.
 *
 * So the invariant is asserted structurally, for every column, rather than
 * remembered for the one that broke: a column this build requires must be
 * declared BOTH in the create path and in an additive ALTER.
 */
import { describe, expect, it } from "vitest";

import {
  ALTER_NATIVE_AD_CALIBRATION_CONTRACT_VERSION_SQL,
  CREATE_NATIVE_AD_CALIBRATION_BATCH_TABLE_SQL,
  CREATE_NATIVE_AD_CALIBRATION_TABLE_SQL,
  NATIVE_AD_CALIBRATION_BATCH_TABLE,
  NATIVE_AD_CALIBRATION_COLUMN_CONTRACTS,
  NATIVE_AD_CALIBRATION_MIGRATION_SQL,
  NATIVE_AD_CALIBRATION_TABLE,
} from "../../jobs/ad-calibration-job";

const CREATE_SQL: Record<string, string> = {
  [NATIVE_AD_CALIBRATION_BATCH_TABLE]: CREATE_NATIVE_AD_CALIBRATION_BATCH_TABLE_SQL,
  [NATIVE_AD_CALIBRATION_TABLE]: CREATE_NATIVE_AD_CALIBRATION_TABLE_SQL,
};

/** Columns present since the table's first shipped shape need no ALTER. */
const ORIGINAL_SHAPE = new Set(
  Object.keys(NATIVE_AD_CALIBRATION_COLUMN_CONTRACTS()[NATIVE_AD_CALIBRATION_TABLE]),
);

describe("every required column is declared in the create path", () => {
  for (const [table, contract] of Object.entries(
    NATIVE_AD_CALIBRATION_COLUMN_CONTRACTS(),
  )) {
    it(`covers ${table}`, () => {
      const sql = CREATE_SQL[table]!;
      for (const column of Object.keys(contract)) {
        expect(sql, `${table}.${column}`).toMatch(
          new RegExp(`\\b${column}\\b`),
        );
      }
    });
  }
});

describe("columns added after the first shape also reach an existing table", () => {
  /*
    The list is explicit rather than derived, because "which columns postdate the
    original shape" is a fact about history that the current file cannot know.
    Adding a column to the contract without adding it here fails the test below,
    which is the prompt to decide whether it needs an ALTER.
  */
  const ADDED_AFTER_FIRST_SHAPE = [
    "contract_version",
    "config_authority_counts_json",
  ];

  it.each(ADDED_AFTER_FIRST_SHAPE)("ALTERs in %s", (column) => {
    expect(ALTER_NATIVE_AD_CALIBRATION_CONTRACT_VERSION_SQL).toContain(
      `ADD COLUMN IF NOT EXISTS ${column}`,
    );
  });

  it("runs those ALTERs as part of the migration", () => {
    for (const column of ADDED_AFTER_FIRST_SHAPE) {
      expect(NATIVE_AD_CALIBRATION_MIGRATION_SQL).toContain(
        `ADD COLUMN IF NOT EXISTS ${column}`,
      );
    }
  });

  it("knows every column it claims to cover", () => {
    for (const column of ADDED_AFTER_FIRST_SHAPE) {
      expect(ORIGINAL_SHAPE.has(column), column).toBe(true);
    }
  });

  /*
    The new column must stay NULLABLE with no default. A `.v5` row never measured
    its sample's config authority, and a zeroed default would claim it measured
    and found nothing authoritative — a much stronger statement than silence.
  */
  it("adds the counts column without a default, so .v5 rows stay silent", () => {
    expect(ALTER_NATIVE_AD_CALIBRATION_CONTRACT_VERSION_SQL).toContain(
      "ADD COLUMN IF NOT EXISTS config_authority_counts_json JSONB",
    );
    expect(ALTER_NATIVE_AD_CALIBRATION_CONTRACT_VERSION_SQL).not.toContain(
      "config_authority_counts_json JSONB NOT NULL",
    );
    expect(
      NATIVE_AD_CALIBRATION_COLUMN_CONTRACTS()[NATIVE_AD_CALIBRATION_TABLE]![
        "config_authority_counts_json"
      ],
    ).toEqual({ type: "jsonb", notNull: false, default: null });
  });
});
