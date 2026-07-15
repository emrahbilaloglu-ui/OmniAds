import { describe, expect, it } from "vitest";
import { NATIVE_AD_DB_BATCH_SIZE, chunkDecisionRows } from "../batching";

describe("decision database batching", () => {
  it("bounds every batch without dropping or reordering rows", () => {
    const rows = Array.from(
      { length: NATIVE_AD_DB_BATCH_SIZE * 2 + 1 },
      (_, index) => index,
    );

    const batches = chunkDecisionRows(rows);

    expect(batches.map((batch) => batch.length)).toEqual([
      NATIVE_AD_DB_BATCH_SIZE,
      NATIVE_AD_DB_BATCH_SIZE,
      1,
    ]);
    expect(batches.flat()).toEqual(rows);
  });

  it("rejects an invalid batch size", () => {
    expect(() => chunkDecisionRows([1], 0)).toThrow("positive integer");
  });
});
