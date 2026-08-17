import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Klaviyo warehouse's two promises about a refresh:
 *
 *   1. Replacing a snapshot is ATOMIC. The delete that clears last night's rows
 *      and the inserts that write tonight's either both land or neither does,
 *      so a refresh that dies halfway leaves the last complete snapshot in
 *      place rather than an empty or half-written table.
 *   2. A completed import that found NOTHING is a real, readable outcome —
 *      distinguishable from an import that never landed. The first renders the
 *      design's empty table with its five headers; the second renders the
 *      single em-dash row.
 */

type StoredRow = Record<string, unknown>;

let store: StoredRow[] = [];
let insertsBeforeFailure: number | null = null;
let insertsSeen = 0;

const sql = vi.fn(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ? ");

    if (/DELETE\s+FROM\s+klaviyo_flow_metrics/i.test(text)) {
      const [businessId, providerAccountId, windowDays] = values;
      store = store.filter(
        (row) =>
          !(
            row.business_id === businessId &&
            row.provider_account_id === providerAccountId &&
            row.window_days === windowDays
          ),
      );
      return [];
    }

    if (/INSERT\s+INTO\s+klaviyo_flow_metrics/i.test(text)) {
      if (
        insertsBeforeFailure !== null &&
        insertsSeen >= insertsBeforeFailure
      ) {
        insertsSeen += 1;
        throw new Error("insert failed");
      }
      insertsSeen += 1;
      const [
        businessId,
        providerAccountId,
        flowId,
        windowDays,
        windowStart,
        windowEnd,
        flowName,
        flowStatus,
        currency,
        revenue,
        openRate,
        recipients,
        sourceFetchedAt,
      ] = values;
      store = store.filter(
        (row) =>
          !(
            row.business_id === businessId &&
            row.provider_account_id === providerAccountId &&
            row.flow_id === flowId &&
            row.window_days === windowDays
          ),
      );
      store.push({
        business_id: businessId,
        provider_account_id: providerAccountId,
        flow_id: flowId,
        window_days: windowDays,
        window_start: windowStart,
        window_end: windowEnd,
        flow_name: flowName,
        flow_status: flowStatus,
        currency,
        revenue,
        open_rate: openRate,
        recipients,
        source_fetched_at: sourceFetchedAt,
      });
      return [];
    }

    if (/FROM\s+klaviyo_flow_metrics/i.test(text)) {
      const [businessId, windowDays] = values;
      return store.filter(
        (row) =>
          row.business_id === businessId && row.window_days === windowDays,
      );
    }

    throw new Error(`Unexpected query in test: ${text}`);
  },
);

/**
 * A transaction that actually rolls back, so "atomic" is something the test can
 * observe rather than something the mock asserts on faith.
 */
const runDbTransaction = vi.fn(async (fn: () => Promise<unknown>) => {
  const backup = store.map((row) => ({ ...row }));
  try {
    return await fn();
  } catch (error) {
    store = backup;
    throw error;
  }
});

const getDbSchemaReadiness = vi.fn();
const readLatestProviderReportSyncJob = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: () => sql,
  runDbTransaction: (fn: () => Promise<unknown>) => runDbTransaction(fn),
}));
vi.mock("@/lib/db-schema-readiness", () => ({ getDbSchemaReadiness }));
vi.mock("@/lib/provider-report-sync-evidence", () => ({
  readLatestProviderReportSyncJob,
}));

const {
  KLAVIYO_FLOW_WINDOW_DAYS,
  readKlaviyoFlowSnapshot,
  replaceKlaviyoFlowMetrics,
} = await import("@/lib/klaviyo/warehouse");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function row(flowId: string, revenue: number | null) {
  return {
    flowId,
    flowName: `Flow ${flowId}`,
    flowStatus: "live",
    currency: "USD",
    revenue,
    openRate: 0.4,
    recipients: 100,
  };
}

function replaceInput(rows: ReturnType<typeof row>[], fetchedAt: string) {
  return {
    businessId: BUSINESS_ID,
    providerAccountId: "acct_1",
    windowDays: KLAVIYO_FLOW_WINDOW_DAYS,
    windowStart: "2026-07-20",
    windowEnd: "2026-08-17",
    fetchedAt: new Date(fetchedAt),
    rows,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store = [];
  insertsBeforeFailure = null;
  insertsSeen = 0;
  getDbSchemaReadiness.mockResolvedValue({ ready: true, missingTables: [] });
  readLatestProviderReportSyncJob.mockResolvedValue(null);
});

describe("replaceKlaviyoFlowMetrics", () => {
  it("runs the delete and every insert inside ONE transaction", async () => {
    await replaceKlaviyoFlowMetrics(
      replaceInput([row("flow_1", 10), row("flow_2", 20)], "2026-08-17T00:00:00.000Z"),
    );

    expect(runDbTransaction).toHaveBeenCalledTimes(1);
  });

  it("leaves the previous snapshot intact when an insert fails halfway", async () => {
    await replaceKlaviyoFlowMetrics(
      replaceInput(
        [row("flow_1", 10), row("flow_2", 20)],
        "2026-08-16T00:00:00.000Z",
      ),
    );
    const before = await readKlaviyoFlowSnapshot({ businessId: BUSINESS_ID });
    expect(before?.rows).toHaveLength(2);

    // The refresh dies after its first insert. Without a transaction the delete
    // has already happened and the account's flows are simply gone.
    insertsBeforeFailure = 1;
    await expect(
      replaceKlaviyoFlowMetrics(
        replaceInput(
          [row("flow_3", 30), row("flow_4", 40)],
          "2026-08-17T00:00:00.000Z",
        ),
      ),
    ).rejects.toThrow("insert failed");

    const after = await readKlaviyoFlowSnapshot({ businessId: BUSINESS_ID });
    expect(after?.rows.map((entry) => entry.flowId).sort()).toEqual([
      "flow_1",
      "flow_2",
    ]);
  });
});

describe("readKlaviyoFlowSnapshot", () => {
  it("returns a successful EMPTY snapshot when a completed import found no flows", async () => {
    readLatestProviderReportSyncJob.mockResolvedValue({
      status: "done",
      triggeredAt: "2026-08-17T00:00:00.000Z",
      startedAt: "2026-08-17T00:00:00.000Z",
      completedAt: "2026-08-17T00:00:05.000Z",
      errorMessage: null,
    });

    const snapshot = await readKlaviyoFlowSnapshot({ businessId: BUSINESS_ID });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.rows).toEqual([]);
    expect(snapshot?.fetchedAt).toBe("2026-08-17T00:00:05.000Z");
    expect(snapshot?.windowDays).toBe(KLAVIYO_FLOW_WINDOW_DAYS);
    expect(readLatestProviderReportSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        provider: "klaviyo",
        reportType: "flow_values",
      }),
    );
  });

  it("still returns null when no import has ever landed", async () => {
    readLatestProviderReportSyncJob.mockResolvedValue(null);
    expect(await readKlaviyoFlowSnapshot({ businessId: BUSINESS_ID })).toBeNull();
  });

  it("does not call a running or failed import a snapshot", async () => {
    for (const status of ["running", "failed", "pending"]) {
      readLatestProviderReportSyncJob.mockResolvedValue({
        status,
        triggeredAt: "2026-08-17T00:00:00.000Z",
        startedAt: "2026-08-17T00:00:00.000Z",
        completedAt: status === "failed" ? "2026-08-17T00:00:05.000Z" : null,
        errorMessage: null,
      });
      expect(
        await readKlaviyoFlowSnapshot({ businessId: BUSINESS_ID }),
      ).toBeNull();
    }
  });

  it("prefers the stored rows over the job row when the account has flows", async () => {
    readLatestProviderReportSyncJob.mockResolvedValue({
      status: "done",
      triggeredAt: "2026-08-17T00:00:00.000Z",
      startedAt: "2026-08-17T00:00:00.000Z",
      completedAt: "2026-08-17T00:00:05.000Z",
      errorMessage: null,
    });
    await replaceKlaviyoFlowMetrics(
      replaceInput([row("flow_1", 10)], "2026-08-17T00:00:00.000Z"),
    );

    const snapshot = await readKlaviyoFlowSnapshot({ businessId: BUSINESS_ID });
    expect(snapshot?.rows).toHaveLength(1);
    expect(snapshot?.windowStart).toBe("2026-07-20");
    expect(snapshot?.providerAccountId).toBe("acct_1");
  });

  it("returns null — not an empty snapshot — when the table does not exist yet", async () => {
    getDbSchemaReadiness.mockResolvedValue({
      ready: false,
      missingTables: ["klaviyo_flow_metrics"],
    });
    readLatestProviderReportSyncJob.mockResolvedValue({
      status: "done",
      triggeredAt: "2026-08-17T00:00:00.000Z",
      startedAt: "2026-08-17T00:00:00.000Z",
      completedAt: "2026-08-17T00:00:05.000Z",
      errorMessage: null,
    });

    expect(await readKlaviyoFlowSnapshot({ businessId: BUSINESS_ID })).toBeNull();
  });
});
