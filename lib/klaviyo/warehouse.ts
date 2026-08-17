import { getDb, runDbTransaction } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { readLatestProviderReportSyncJob } from "@/lib/provider-report-sync-evidence";

/** The design's column is "Revenue · 28d" (design 1710), so the window is 28 days. */
export const KLAVIYO_FLOW_WINDOW_DAYS = 28;

export const KLAVIYO_WAREHOUSE_TABLES = ["klaviyo_flow_metrics"] as const;

/**
 * How the Klaviyo importer stamps its own `provider_sync_jobs` row.
 *
 * They live here rather than in `lib/klaviyo/sync.ts` because BOTH sides need
 * them: the sync writes the row, and the read below uses it as the evidence
 * that an import completed. Keeping one spelling is what stops a completed
 * import from being invisible to the reader that looks for it.
 */
export const KLAVIYO_SYNC_PROVIDER = "klaviyo";
export const KLAVIYO_SYNC_REPORT_TYPE = "flow_values";

export function klaviyoSyncDateRangeKey(
  windowDays: number = KLAVIYO_FLOW_WINDOW_DAYS,
): string {
  return `last_${windowDays}d`;
}

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
  /**
   * The stored window's bounds — null ONLY for a completed-empty snapshot,
   * which has no stored row to carry them. See `readKlaviyoFlowSnapshot`.
   */
  windowStart: string | null;
  windowEnd: string | null;
  fetchedAt: string;
  /** Null for the same reason as the window bounds: no row, no account on it. */
  providerAccountId: string | null;
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
 * DELETE-then-INSERT rather than a bare upsert, because a flow the user
 * archived in Klaviyo must DISAPPEAR from the table. An upsert alone would
 * leave last week's row sitting there forever, and a stale flow row is exactly
 * the kind of quiet fabrication this surface must not do.
 *
 * ATOMIC, in `runDbTransaction`. The delete is destructive and the inserts are
 * what make it safe, so they are one unit: an insert that fails halfway rolls
 * the delete back and the last complete snapshot is still there, and no reader
 * can catch the table between the two and read the account as empty.
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
  return runDbTransaction(async () => {
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
  });
}

/**
 * A completed import that stored nothing, or null if none has completed.
 *
 * `klaviyo_flow_metrics` holds one row per flow, so an account with no flows
 * leaves no trace in it at all — the table looks exactly like a workspace whose
 * first import has never run. The distinction is recorded elsewhere and already
 * is: the importer stamps a `provider_sync_jobs` row and marks it `done`, which
 * is the same evidence `lib/provider-report-sync-evidence.ts` reads for GA4 and
 * Search Console on the integrations surface. A `done` job with no rows is the
 * honest "the import landed and there was nothing in it".
 *
 * Only `done` counts. A `running` job is an import in flight and a `failed` one
 * never landed; calling either an empty snapshot would turn a broken or pending
 * connection into a screen that says, definitively, "no flows".
 *
 * The window bounds and the account id come back NULL because no stored row
 * carries them and the job row does not record them. That is the same rule the
 * rest of this surface follows: an unsupplied fact is reported as unsupplied,
 * not reconstructed from a clock.
 */
async function readCompletedEmptyKlaviyoSnapshot(
  businessId: string,
  windowDays: number,
): Promise<KlaviyoFlowSnapshot | null> {
  const job = await readLatestProviderReportSyncJob({
    businessId,
    provider: KLAVIYO_SYNC_PROVIDER,
    reportType: KLAVIYO_SYNC_REPORT_TYPE,
    dateRangeKey: klaviyoSyncDateRangeKey(windowDays),
  }).catch(() => null);

  if (!job || job.status !== "done" || !job.completedAt) return null;

  return {
    windowDays,
    windowStart: null,
    windowEnd: null,
    fetchedAt: job.completedAt,
    providerAccountId: null,
    rows: [],
  };
}

/**
 * The most recent stored snapshot for a business, or null.
 *
 * `null` when the table does not exist yet, or when nothing is stored AND no
 * import has ever completed. The caller turns that into the design's single
 * em-dash row.
 *
 * A snapshot with an empty `rows` array means something different and true: an
 * import ran to completion and the account genuinely has no flows. The screen
 * draws its five headers over an empty table instead of claiming the source is
 * unavailable, and `hasSnapshot` is true, so the connection stops presenting as
 * perpetually syncing.
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

  if (rows.length === 0) {
    return readCompletedEmptyKlaviyoSnapshot(input.businessId, windowDays);
  }

  const first = rows[0];
  const fetchedAtRaw = first.source_fetched_at;
  const fetchedAt =
    fetchedAtRaw instanceof Date
      ? fetchedAtRaw.toISOString()
      : (toStringOrNull(fetchedAtRaw) ?? new Date(0).toISOString());

  return {
    windowDays,
    windowStart: toStringOrNull(first.window_start),
    windowEnd: toStringOrNull(first.window_end),
    fetchedAt,
    providerAccountId: toStringOrNull(first.provider_account_id),
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
