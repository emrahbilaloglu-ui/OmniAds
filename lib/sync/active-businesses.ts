import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";

export interface ActiveBusinessRow {
  id: string;
  name: string;
}

export interface GetActiveBusinessesOptions {
  prioritizedIds?: string[] | null;
}

function normalizeBusinessIds(value?: string[] | null) {
  return Array.from(
    new Set(
      (value ?? [])
        .map((entry) => entry?.trim())
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
}

export type ActiveBusinessesRead =
  | { ok: true; businesses: ActiveBusinessRow[] }
  | {
      ok: false;
      reason: "schema_not_ready" | "readiness_probe_failed" | "query_failed";
      message: string;
      error: unknown;
    };

/**
 * Read the active-business list WITHOUT collapsing "could not read it" into
 * "there are none".
 *
 * Callers that must fail closed use this. `getActiveBusinesses` below keeps the
 * older lossy contract for the eight callers that depend on it.
 */
export async function readActiveBusinesses(
  limit?: number,
  options?: GetActiveBusinessesOptions,
): Promise<ActiveBusinessesRead> {
  let readiness: Awaited<ReturnType<typeof getDbSchemaReadiness>>;
  try {
    readiness = await getDbSchemaReadiness({ tables: ["businesses"] });
  } catch (error) {
    return {
      ok: false,
      reason: "readiness_probe_failed",
      message: error instanceof Error ? error.message : String(error),
      error,
    };
  }
  if (!readiness.ready) {
    return {
      ok: false,
      reason: "schema_not_ready",
      message: "the businesses table is not ready",
      error: null,
    };
  }

  try {
    return { ok: true, businesses: await queryActiveBusinesses(limit, options) };
  } catch (error) {
    return {
      ok: false,
      reason: "query_failed",
      message: error instanceof Error ? error.message : String(error),
      error,
    };
  }
}

/**
 * Lossy by design and unchanged: a not-ready schema yields [], a query error
 * propagates. Do not "improve" this without auditing every caller — the sync
 * cron deliberately uses readActiveBusinesses instead.
 */
export async function getActiveBusinesses(
  limit?: number,
  options?: GetActiveBusinessesOptions,
) {
  const readiness = await getDbSchemaReadiness({
    tables: ["businesses"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return [];
  }
  return queryActiveBusinesses(limit, options);
}

async function queryActiveBusinesses(
  limit?: number,
  options?: GetActiveBusinessesOptions,
) {
  const sql = getDb();
  const prioritizedIds = normalizeBusinessIds(options?.prioritizedIds);
  const requestedLimit = Math.max(1, limit ?? 500);
  const effectiveLimit = Math.max(requestedLimit, prioritizedIds.length || 0);
  return (await sql`
    WITH ranked_businesses AS (
      SELECT
        id,
        name,
        created_at,
        CASE
          WHEN id::text = ANY(${prioritizedIds}::text[]) THEN 0
          ELSE 1
        END AS priority_group,
        COALESCE(array_position(${prioritizedIds}::text[], id::text), 2147483647) AS priority_rank
      FROM businesses
      WHERE is_demo_business = FALSE
    )
    SELECT id, name
    FROM ranked_businesses
    ORDER BY priority_group, priority_rank, created_at
    LIMIT ${effectiveLimit}
  `) as ActiveBusinessRow[];
}
