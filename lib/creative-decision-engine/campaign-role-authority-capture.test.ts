import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_ROLE_AUTHORITY_CONTRACT,
  UPSERT_ROLE_AUTHORITY_QUERY,
} from "@/lib/creative-decision-engine/jobs/campaign-context-job";
import { D086_REQUIRED_ROLE_COLUMNS } from "@/lib/meta/budget-readiness-retention";

const MIGRATIONS = readFileSync("lib/migrations.ts", "utf8");

/**
 * The relation the budget path reads did not exist in production.
 *
 * Its DDL lived only in `lib/meta/budget-readiness-retention.ts`, which nothing
 * but an audit script applies, so `budget-proposal-source-loader.ts` read a
 * missing table, caught the error into `unknown`, and raised no proposal — for
 * a reason no surface could show. These cases hold the three halves together:
 * the migration creates it, the reader's own column contract is satisfied, and
 * the job writes it.
 */
describe("retained campaign-role authority", () => {
  it("is created by the production migrations, not only by an audit script", () => {
    expect(MIGRATIONS).toContain(
      "CREATE TABLE IF NOT EXISTS engine_v3_campaign_role_authority",
    );
    expect(MIGRATIONS).toContain(
      "idx_engine_v3_campaign_role_authority_latest",
    );
  });

  it("provides every column the readiness contract requires", () => {
    const start = MIGRATIONS.indexOf(
      "CREATE TABLE IF NOT EXISTS engine_v3_campaign_role_authority",
    );
    const ddl = MIGRATIONS.slice(start, start + 2000);
    for (const column of D086_REQUIRED_ROLE_COLUMNS) {
      expect(ddl, `missing column ${column}`).toContain(column);
    }
  });

  it("keeps the account non-empty, which is what makes the record account-scoped", () => {
    const start = MIGRATIONS.indexOf(
      "CREATE TABLE IF NOT EXISTS engine_v3_campaign_role_authority",
    );
    const ddl = MIGRATIONS.slice(start, start + 2000);
    expect(ddl).toContain("provider_account_id TEXT        NOT NULL");
    expect(ddl).toContain("CHECK (provider_account_id <> '')");
  });

  it("writes exactly the required columns, under its own contract", () => {
    for (const column of D086_REQUIRED_ROLE_COLUMNS) {
      expect(UPSERT_ROLE_AUTHORITY_QUERY, `not written: ${column}`).toContain(
        column,
      );
    }
    expect(CAMPAIGN_ROLE_AUTHORITY_CONTRACT).toBe(
      "engine-v3-campaign-role-authority.v1",
    );
    // The source is a literal in the statement: this job only ever records an
    // automatic inference, and no input can make it claim otherwise.
    expect(UPSERT_ROLE_AUTHORITY_QUERY).toContain("'system_inferred'");
  });

  it("re-observes a day rather than answering it twice", () => {
    expect(UPSERT_ROLE_AUTHORITY_QUERY).toContain(
      "ON CONFLICT (business_id, provider_account_id, campaign_id, as_of_date, resolver_version)",
    );
    // The day it speaks for has not changed, so its effective clock does not.
    expect(UPSERT_ROLE_AUTHORITY_QUERY).toContain("recorded_at = now()");
    expect(UPSERT_ROLE_AUTHORITY_QUERY).not.toContain("effective_at = EXCLUDED");
  });
});
