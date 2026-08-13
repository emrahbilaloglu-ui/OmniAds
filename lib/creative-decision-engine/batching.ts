// Native-ad hydration joins metrics, hierarchy history, dimensions and
// lifecycle evidence. A 500-identity batch exceeds the production 30-second
// statement budget on large accounts; 100 keeps each query bounded while the
// caller still reconciles the complete manifest before publishing.
export const NATIVE_AD_DB_BATCH_SIZE = 100;

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
