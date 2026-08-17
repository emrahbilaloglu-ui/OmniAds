import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";

/** The design's column is "Revenue · 28d" (design 1710), so the window is 28 days. */
export const KLAVIYO_FLOW_WINDOW_DAYS = 28;

export const KLAVIYO_WAREHOUSE_TABLES = ["klaviyo_flow_metrics"] as const;

export interface KlaviyoFlowMetricRow {
  flowId: string;
  flowName: string | null;
  flowStatus: string | null;
  currency: string | null;
  /** Attributed conversion value over the window; null when Klaviyo did not report one. */
  revenue: number | null;
  /** Fraction in [0,1]; null when Klaviyo did not report one. */
  openRate: number | null;
  recipients: number | null;
}

export interface KlaviyoFlowSnapshot {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  fetchedAt: string;
  providerAccountId: string;
  rows: KlaviyoFlowMetricRow[];
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Replace this account's snapshot for one window.
 *
 * DELETE-then-INSERT inside one transaction rather than a bare upsert, because
 * a flow the user archived in Klaviyo must DISAPPEAR from the table. An upsert
 * alone would leave last week's row sitting there forever, and a stale flow row
 * is exactly the kind of quiet fabrication this surface must not do.
 */
export async function replaceKlaviyoFlowMetrics(input: {
  businessId: string;
  providerAccountId: string;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  fetchedAt: Date;
  rows: KlaviyoFlowMetricRow[];
}): Promise<{ written: number }> {
  const sql = getDb();
  const fetchedAt = input.fetchedAt.toISOString();

  await sql`
    DELETE FROM klaviyo_flow_metrics
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND window_days = ${input.windowDays}
  `;

  for (const row of input.rows) {
    await sql`
      INSERT INTO klaviyo_flow_metrics (
        business_id, provider_account_id, flow_id, window_days,
        window_start, window_end,
        flow_name, flow_status, currency,
        revenue, open_rate, recipients,
        source_fetched_at, updated_at
      ) VALUES (
        ${input.businessId}, ${input.providerAccountId}, ${row.flowId}, ${input.windowDays},
        ${input.windowStart}, ${input.windowEnd},
        ${row.flowName}, ${row.flowStatus}, ${row.currency},
        ${row.revenue}, ${row.openRate}, ${row.recipients},
        ${fetchedAt}, ${fetchedAt}
      )
      ON CONFLICT (business_id, provider_account_id, flow_id, window_days) DO UPDATE SET
        window_start      = EXCLUDED.window_start,
        window_end        = EXCLUDED.window_end,
        flow_name         = EXCLUDED.flow_name,
        flow_status       = EXCLUDED.flow_status,
        currency          = EXCLUDED.currency,
        revenue           = EXCLUDED.revenue,
        open_rate         = EXCLUDED.open_rate,
        recipients        = EXCLUDED.recipients,
        source_fetched_at = EXCLUDED.source_fetched_at,
        updated_at        = EXCLUDED.updated_at
    `;
  }

  return { written: input.rows.length };
}

/**
 * The most recent stored snapshot for a business, or null.
 *
 * `null` — never an empty snapshot — when the table does not exist yet or holds
 * no row for this business. The caller turns that into the design's single
 * em-dash row; an empty `rows` array means something different and true: the
 * sync ran and the account genuinely has no flows.
 */
export async function readKlaviyoFlowSnapshot(input: {
  businessId: string;
  windowDays?: number;
}): Promise<KlaviyoFlowSnapshot | null> {
  const windowDays = input.windowDays ?? KLAVIYO_FLOW_WINDOW_DAYS;

  // The table is additive and a running instance may predate the migration.
  // Probing readiness first keeps a missing table an honest "no snapshot"
  // rather than a 500 on a read path.
  const readiness = await getDbSchemaReadiness({
    tables: [...KLAVIYO_WAREHOUSE_TABLES],
  });
  if (!readiness.ready) return null;

  const sql = getDb();
  const rows = (await sql`
    SELECT provider_account_id,
           flow_id,
           flow_name,
           flow_status,
           currency,
           revenue,
           open_rate,
           recipients,
           window_start::text  AS window_start,
           window_end::text    AS window_end,
           source_fetched_at
    FROM klaviyo_flow_metrics
    WHERE business_id = ${input.businessId}
      AND window_days = ${windowDays}
    ORDER BY revenue DESC NULLS LAST, flow_name ASC NULLS LAST, flow_id ASC
  `) as Array<Record<string, unknown>>;

  if (rows.length === 0) return null;

  const first = rows[0];
  const fetchedAtRaw = first.source_fetched_at;
  const fetchedAt =
    fetchedAtRaw instanceof Date
      ? fetchedAtRaw.toISOString()
      : (toStringOrNull(fetchedAtRaw) ?? new Date(0).toISOString());

  return {
    windowDays,
    windowStart: toStringOrNull(first.window_start) ?? "",
    windowEnd: toStringOrNull(first.window_end) ?? "",
    fetchedAt,
    providerAccountId: toStringOrNull(first.provider_account_id) ?? "",
    rows: rows.map((row) => ({
      flowId: toStringOrNull(row.flow_id) ?? "",
      flowName: toStringOrNull(row.flow_name),
      flowStatus: toStringOrNull(row.flow_status),
      currency: toStringOrNull(row.currency),
      revenue: toNumberOrNull(row.revenue),
      openRate: toNumberOrNull(row.open_rate),
      recipients: toNumberOrNull(row.recipients),
    })),
  };
}
