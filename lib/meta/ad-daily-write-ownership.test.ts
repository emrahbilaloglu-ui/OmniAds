import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: () => {
    throw new Error("db_touched");
  },
  getDbWithTimeout: () => {
    throw new Error("db_touched");
  },
  runDbTransaction: async (fn: () => Promise<unknown>) => fn(),
}));

import {
  META_AD_DAILY_UNAUTHORIZED_WRITE_CODE,
  upsertMetaAdDailyRows,
} from "@/lib/meta/warehouse";

const warehouse = readFileSync("lib/meta/warehouse.ts", "utf8");
const creativesWarehouse = readFileSync(
  "lib/meta/creatives-warehouse.ts",
  "utf8",
);
const insightsSync = readFileSync("lib/api/meta.ts", "utf8");

function row() {
  return {
    businessId: "biz-1",
    providerAccountId: "act_1",
    date: "2026-08-09",
    adId: "ad-1",
  } as never;
}

describe("meta_ad_daily has exactly one owner (D066)", () => {
  it("refuses a write that declares no authority", async () => {
    await expect(
      upsertMetaAdDailyRows([row()], undefined as never),
    ).rejects.toThrow(META_AD_DAILY_UNAUTHORIZED_WRITE_CODE);
  });

  it("refuses the retired creative_enrichment lane by name", async () => {
    await expect(
      upsertMetaAdDailyRows([row()], {
        writeMode: "creative_enrichment",
      } as never),
    ).rejects.toThrow(META_AD_DAILY_UNAUTHORIZED_WRITE_CODE);
  });

  it("refuses any unknown mode rather than defaulting to authoritative", async () => {
    for (const mode of ["", "AUTHORITATIVE_FACT", "authoritative", "fact", null]) {
      await expect(
        upsertMetaAdDailyRows([row()], { writeMode: mode } as never),
      ).rejects.toThrow(META_AD_DAILY_UNAUTHORIZED_WRITE_CODE);
    }
  });

  it("fails closed before touching the database, even with zero rows", async () => {
    // The empty-rows shortcut must not become an authorization bypass: an
    // unauthorized caller is refused whether or not it happens to have rows.
    await expect(
      upsertMetaAdDailyRows([], undefined as never),
    ).rejects.toThrow(META_AD_DAILY_UNAUTHORIZED_WRITE_CODE);
  });

  it("reaches the database only once authority is declared", async () => {
    // The mocked db throws "db_touched"; seeing it proves the guard passed and
    // nothing earlier silently swallowed the call.
    await expect(
      upsertMetaAdDailyRows([row()], { writeMode: "authoritative_fact" }),
    ).rejects.toThrow(/db_touched|meta_warehouse/);
  });
});

describe("the owner is authoritative insights sync, and only it", () => {
  it("declares authority at the authoritative slice replacement", () => {
    expect(warehouse).toContain(`await upsertMetaAdDailyRows(input.rows, {
      writeMode: "authoritative_fact",
    });`);
  });

  it("declares authority at the insights sync write", () => {
    expect(insightsSync).toContain(`await upsertMetaAdDailyRows(adRows, {
              writeMode: "authoritative_fact",
            });`);
  });

  it("performs zero meta_ad_daily writes from creatives metadata sync", () => {
    expect(creativesWarehouse).not.toContain("upsertMetaAdDailyRows(");
  });

  it("keeps the creative daily, dimension and media writers it does own", () => {
    expect(creativesWarehouse).toContain("upsertMetaCreativeDailyRows(");
    expect(creativesWarehouse).toContain("upsertMetaCreativeMediaRows(");
  });
});

describe("the authoritative payload carries no media presentation keys", () => {
  it("strips them recursively before persisting payload_json", () => {
    const start = warehouse.indexOf(
      "export async function upsertMetaAdDailyRows(",
    );
    const end = warehouse.indexOf("\nexport ", start + 1);
    const body = warehouse.slice(start, end);
    expect(body).toContain(
      "stripMetaCreativeMediaPayload(row.payloadJson ?? null)",
    );
  });
});
