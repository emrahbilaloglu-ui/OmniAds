export const NATIVE_AD_DB_BATCH_SIZE = 500;

export function chunkDecisionRows<T>(
  rows: readonly T[],
  batchSize = NATIVE_AD_DB_BATCH_SIZE,
): T[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new TypeError("Decision batch size must be a positive integer.");
  }
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += batchSize) {
    batches.push(rows.slice(index, index + batchSize));
  }
  return batches;
}
