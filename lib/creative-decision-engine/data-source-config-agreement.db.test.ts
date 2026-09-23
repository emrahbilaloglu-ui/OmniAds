/**
 * The production loader compares provider enum values with older warehouse
 * display labels in PostgreSQL. Run its emitted predicate against PostgreSQL:
 * JavaScript-only fixtures cannot catch a mismatch in SQL normalization.
 */
import { describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";

import { metaConfigTokenAgreementSql } from "./data-source";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const AGREEMENT_SQL = `SELECT (${metaConfigTokenAgreementSql("$1::text", "$2::text")}) AS agrees`;

async function agrees(left: string | null, right: string | null) {
  const [row] = await getDb().query<{ agrees: boolean }>(AGREEMENT_SQL, [
    left,
    right,
  ]);
  return row?.agrees;
}

describe.runIf(SEAM)("native config value agreement in PostgreSQL", () => {
  it("recognizes the provider enum behind a warehouse display label", async () => {
    expect(await agrees("OFFSITE_CONVERSIONS", "Offsite Conversions")).toBe(
      true,
    );
    expect(await agrees("OUTCOME_SALES", "outcome sales")).toBe(true);
    expect(await agrees("PURCHASE", "Purchase")).toBe(true);
  });

  it("keeps different optimization and conversion meanings separate", async () => {
    expect(await agrees("VALUE", "RETURN_ON_AD_SPEND")).toBe(false);
    expect(await agrees("PURCHASE", "OTHER")).toBe(false);
    expect(await agrees("A/B", "A_B")).toBe(false);
  });

  it("does not turn a missing value into an observed value", async () => {
    expect(await agrees(null, "OFFSITE_CONVERSIONS")).toBe(false);
    expect(await agrees("OFFSITE_CONVERSIONS", null)).toBe(false);
    // Null agreement alone cannot grant authority: the caller also requires a
    // receipt tier and a non-none field readiness.
    expect(await agrees(null, null)).toBe(true);
  });
});
