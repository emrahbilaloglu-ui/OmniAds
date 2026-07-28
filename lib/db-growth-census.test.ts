import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOP,
  MAX_TOP,
  MIN_TOP,
  parseExactTable,
  parseTop,
} from "./db-growth-census";

/**
 * The census is read-only, but its two arguments still reach a statement: --top
 * becomes a LIMIT and --table is interpolated as a relation name (a relation
 * cannot be a bind parameter). Both are validated before they get there.
 *
 * The privilege behaviour these arguments sit alongside — a denied
 * pg_ls_waldir() degrading explicitly instead of taking the whole census down —
 * is decided by PostgreSQL and is proven in
 * scripts/ephemeral-postgres-census-least-privilege-seam.ts. These tests cover
 * only the pure parsing.
 */
describe("parseTop", () => {
  it("defaults when absent, so an ordinary run needs no argument", () => {
    expect(parseTop(null)).toEqual({ top: DEFAULT_TOP });
    expect(parseTop("")).toEqual({ top: DEFAULT_TOP });
  });

  it("accepts a plain bounded integer", () => {
    expect(parseTop("40")).toEqual({ top: 40 });
    expect(parseTop(String(MIN_TOP))).toEqual({ top: MIN_TOP });
    expect(parseTop(String(MAX_TOP))).toEqual({ top: MAX_TOP });
  });

  it("refuses malformed input rather than silently substituting the default", () => {
    // `--top=abc` quietly becoming 30 is how someone believes they censused 400
    // relations when they censused 30. A bad bound must stop the run.
    for (const raw of ["abc", "1.5", "1e9", " 12x", "NaN", "Infinity", "-", "+5"]) {
      expect(parseTop(raw), `expected '${raw}' to be refused`).toHaveProperty("error");
    }
  });

  it("refuses a non-positive or unbounded LIMIT", () => {
    expect(parseTop("0")).toHaveProperty("error");
    expect(parseTop("-5")).toHaveProperty("error");
    expect(parseTop(String(MAX_TOP + 1))).toHaveProperty("error");
    expect(parseTop("999999")).toHaveProperty("error");
  });

  it("refuses anything statement-shaped", () => {
    expect(parseTop("10; DROP TABLE users")).toHaveProperty("error");
    expect(parseTop("10 OR 1=1")).toHaveProperty("error");
  });
});

describe("parseExactTable", () => {
  it("accepts a lower-case unquoted identifier", () => {
    expect(parseExactTable("meta_config_snapshots")).toEqual({
      table: "meta_config_snapshots",
    });
    expect(parseExactTable("  meta_raw_snapshots  ")).toEqual({
      table: "meta_raw_snapshots",
    });
  });

  it("requires a name at all", () => {
    expect(parseExactTable(null)).toHaveProperty("error");
    expect(parseExactTable("")).toHaveProperty("error");
  });

  it("refuses anything that could close the identifier or add a statement", () => {
    for (const raw of [
      'census_probe"; DROP TABLE x --',
      "pg_class; SELECT 1",
      "public.meta_raw_snapshots",
      "meta raw snapshots",
      "meta-raw-snapshots",
      "Meta_Raw_Snapshots",
      "1_leading_digit",
      "tbl'; --",
    ]) {
      expect(parseExactTable(raw), `expected '${raw}' to be refused`).toHaveProperty("error");
    }
  });

  it("refuses an identifier PostgreSQL would truncate", () => {
    // Over NAMEDATALEN-1 the server silently truncates, so the operator would
    // be counting a different relation than the one they typed.
    expect(parseExactTable("x".repeat(63))).toEqual({ table: "x".repeat(63) });
    expect(parseExactTable("x".repeat(64))).toHaveProperty("error");
  });
});
