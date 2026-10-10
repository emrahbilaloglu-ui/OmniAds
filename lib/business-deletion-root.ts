import type { PoolClient } from "pg";

// A single root DELETE runs every incoming business FK trigger. Give it the
// remaining approved operation budget, with the same finite 30m ceiling.
// Cleanup pages keep their own 30s bound; this cannot extend the job deadline.
export const BUSINESS_ERASURE_ROOT_STATEMENT_CAP_MS = 30 * 60_000;

/** Background caller only, on the SAME lock-owning transactional backend.
 * All incoming FKs remain active. The existing transaction wrapper restores
 * its ordinary 30s cap before COMMIT and rolls back on every rejection. */
export async function deleteBackgroundBusinessRoot(
  client: Pick<PoolClient, "query">,
  businessId: string,
  deadlineAtMs: number,
): Promise<{ id: string }[]> {
  const remaining = () => {
    const ms = Math.min(BUSINESS_ERASURE_ROOT_STATEMENT_CAP_MS, Math.floor(deadlineAtMs - Date.now()));
    if (!Number.isFinite(ms) || ms <= 0) throw new Error("Business root erasure deadline exceeded");
    return ms;
  };
  const bounded = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Business root erasure deadline exceeded")), ms);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const cap = remaining();
  // Server cancellation is mandatory: a client timer alone could leave a
  // mutation running. SET LOCAL cannot escape this transaction/session.
  await bounded(client.query(`SET LOCAL statement_timeout = ${cap}`), Math.min(30_000, cap));
  const queryCap = remaining();
  const result = await bounded(client.query<{ id: string }>(
    "DELETE FROM businesses WHERE id=$1::uuid RETURNING id", [businessId],
  ), queryCap);
  return result.rows;
}
