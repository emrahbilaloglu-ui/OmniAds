import { describe, expect, it } from "vitest";
import { LIVE_MEASUREMENT } from "./db-growth-fence";

/**
 * Where the bytes actually are — pinned, because the attribution was wrong.
 *
 * The append-forever raw-snapshot RECEIPT tables were widely believed to be the
 * cause of the production database's size. They are not: at the moment
 * LIVE_MEASUREMENT was taken they held nothing at all, and the fence's own
 * comment records them as "New relations: zero today". Neither appears in the
 * measured set.
 *
 * The dominant term is Meta CONFIGURATION history — three tables, ~67 GB,
 * ~46% of the recorded database — and most of it has no delete path in any code
 * path, gated or not. These tests exist so that a future reader reaches for the
 * right table, and so that a change to the measurement cannot silently move the
 * conclusion.
 */
describe("growth attribution", () => {
  const measured = Object.entries(LIVE_MEASUREMENT.tableBytes);

  it("does not attribute any measured bytes to the observation receipt tables", () => {
    const receiptTables = measured.filter(([name]) => name.includes("observation"));
    expect(
      receiptTables,
      "the receipt tables were 'zero today' at measurement; if they now carry bytes, the attribution below must be revisited",
    ).toEqual([]);
  });

  it("ranks the Meta config trio as the dominant term", () => {
    const trio =
      LIVE_MEASUREMENT.tableBytes.meta_config_snapshots +
      LIVE_MEASUREMENT.tableBytes.meta_campaign_config_history +
      LIVE_MEASUREMENT.tableBytes.meta_adset_config_history;

    const share = trio / LIVE_MEASUREMENT.databaseBytes;
    expect(share).toBeGreaterThan(0.4);
    expect(
      trio,
      "the three config-history tables are the largest thing in the database",
    ).toBeGreaterThan(LIVE_MEASUREMENT.tableBytes.meta_raw_snapshots);
  });

  it("records that the measured set is NOT a census", () => {
    const measuredTotal = measured.reduce((sum, [, value]) => sum + value, 0);
    const covered = measuredTotal / LIVE_MEASUREMENT.databaseBytes;
    // ~18% of the database was never measured. Any conclusion drawn from the
    // ranking alone is drawn from an incomplete picture, and scripts/db-growth-census.ts
    // exists to close that gap with a real query.
    expect(covered).toBeLessThan(0.9);
    expect(covered).toBeGreaterThan(0.5);
  });

  it("preserves the unresolved volume contradiction rather than papering over it", () => {
    // The recorded database is LARGER than the recorded filesystem usage of the
    // volume it supposedly occupies. Both cannot be simultaneously true of the
    // same filesystem. The fence assumes the pessimistic direction and says the
    // gap is unexplained; this test stops anyone "fixing" it by editing a
    // number instead of measuring.
    expect(LIVE_MEASUREMENT.databaseBytes).toBeGreaterThan(
      LIVE_MEASUREMENT.volume.usedBytes,
    );
  });

  it("keeps the volume triple internally coherent, which is why it looks like a real df", () => {
    const { capacityBytes, usedBytes, availableBytes } = LIVE_MEASUREMENT.volume;
    const reserved = capacityBytes - (usedBytes + availableBytes);
    const reservedFraction = reserved / capacityBytes;
    // A filesystem reserved-block remainder, ~0.5%. Three invented numbers
    // would not land here.
    expect(reservedFraction).toBeGreaterThan(0);
    expect(reservedFraction).toBeLessThan(0.02);
  });
});
