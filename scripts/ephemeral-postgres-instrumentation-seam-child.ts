// Child of ephemeral-postgres-migrations-check: proves the product
// instrumentation sink against real storage.
//
// Contract tests can prove the validator; only real PostgreSQL can prove that
// the CHECK constraints actually refuse, that the scope/tenancy rule is enforced
// by the database rather than by the caller, that the purge deletes exactly the
// expired rows and is idempotent, and that sink health is readable afterwards.
//
// DATABASE_URL is pre-set by the parent to the ephemeral server.
import { getDb } from "@/lib/db";
import {
  purgeExpiredProductInstrumentation,
  readProductInstrumentationSinkHealth,
  recordProductInstrumentationEvent,
} from "@/lib/product-instrumentation";

const LABEL = "instrumentation-seam";

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

const BUSINESS_ID = "i0000000-0000-4000-8000-000000000001";

async function count(where = "TRUE", values: unknown[] = []) {
  const rows = (await getDb().query(
    `SELECT count(*)::int AS n FROM product_instrumentation_events WHERE ${where}`,
    values,
  )) as unknown as Array<{ n: number }>;
  return rows[0]!.n;
}

async function insertRaw(columns: string, values: unknown[]) {
  const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
  await getDb().query(
    `INSERT INTO product_instrumentation_events (${columns}) VALUES (${placeholders})`,
    values,
  );
}

async function refuses(label: string, run: () => Promise<unknown>) {
  let refused = false;
  try {
    await run();
  } catch {
    refused = true;
  }
  if (!refused) fail(label, "the database accepted a row it must refuse");
}

async function main() {
  const db = getDb();
  await db.query(`DELETE FROM product_instrumentation_events`);
  await db.query(`DELETE FROM product_instrumentation_sink_health`);

  const base =
    "contract_version, business_id, scope, event_name, surface, outcome, occurred_at, retain_until";

  // ------------------------------------------------------------ constraints
  // The vocabularies are enforced by the database, not only by the validator.
  await refuses("unknown event name", () =>
    insertRaw(base, [
      "product-instrumentation-event.v1",
      BUSINESS_ID,
      "business",
      "made_up_event",
      "overview",
      "ok",
      "2026-08-09T10:00:00.000Z",
      "2026-11-07",
    ]),
  );
  await refuses("unknown surface", () =>
    insertRaw(base, [
      "product-instrumentation-event.v1",
      BUSINESS_ID,
      "business",
      "agency_today_viewed",
      "made_up_surface",
      "ok",
      "2026-08-09T10:00:00.000Z",
      "2026-11-07",
    ]),
  );
  // Scope/tenancy: the businesses[0] bug is impossible at the storage layer.
  await refuses("portfolio scope carrying a business", () =>
    insertRaw(base, [
      "product-instrumentation-event.v1",
      BUSINESS_ID,
      "portfolio",
      "agency_today_viewed",
      "overview",
      "ok",
      "2026-08-09T10:00:00.000Z",
      "2026-11-07",
    ]),
  );
  await refuses("business scope with no business", () =>
    insertRaw(base, [
      "product-instrumentation-event.v1",
      null,
      "business",
      "agency_today_viewed",
      "overview",
      "ok",
      "2026-08-09T10:00:00.000Z",
      "2026-11-07",
    ]),
  );
  await refuses("failure with no code", () =>
    insertRaw(base + ", failure_code", [
      "product-instrumentation-event.v1",
      BUSINESS_ID,
      "business",
      "agency_today_viewed",
      "overview",
      "failed",
      "2026-08-09T10:00:00.000Z",
      "2026-11-07",
      null,
    ]),
  );
  expectEqual(await count(), 0, "no refused row was persisted");

  // ------------------------------------------------------------ no free text
  // Every TEXT column in the shipped table is constrained; nothing accepts an
  // arbitrary string that could carry a query, a token, ad copy or PII.
  const textColumns = (await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'product_instrumentation_events'
       AND data_type IN ('text', 'character varying')`,
  )) as unknown as Array<{ column_name: string }>;
  const constraints = (await db.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'product_instrumentation_events'::regclass`,
  )) as unknown as Array<{ def: string }>;
  const allDefs = constraints.map((row) => row.def).join(" ");
  for (const { column_name: column } of textColumns) {
    if (column === "business_id") continue; // an opaque tenant id, not free text
    if (!allDefs.includes(column)) {
      fail("free text", `${column} is an unconstrained TEXT column`);
    }
  }

  // ------------------------------------------------------------ real writes
  const portfolio = await recordProductInstrumentationEvent({
    businessId: null,
    scope: "portfolio",
    eventName: "agency_today_viewed",
    surface: "overview",
    outcome: "ok",
    itemCount: 3,
    occurredAt: new Date().toISOString(),
  });
  expectEqual(portfolio, { recorded: true }, "a portfolio event is recorded");

  const business = await recordProductInstrumentationEvent({
    businessId: BUSINESS_ID,
    scope: "business",
    eventName: "decision_workflow_changed",
    surface: "meta_decision_inspector",
    outcome: "ok",
    occurredAt: new Date().toISOString(),
  });
  expectEqual(business, { recorded: true }, "a business event is recorded");
  expectEqual(await count(), 2, "both real writes landed");

  // ------------------------------------------------------------ sink health
  const health = await readProductInstrumentationSinkHealth();
  if (health.recorded < 2) {
    fail("sink health", `expected at least 2 recorded, got ${health.recorded}`);
  }
  expectEqual(health.degraded, false, "a healthy sink reports itself healthy");

  const rejected = await recordProductInstrumentationEvent({
    businessId: "biz",
    scope: "portfolio",
    eventName: "agency_today_viewed",
    surface: "overview",
    outcome: "ok",
    occurredAt: new Date().toISOString(),
  });
  expectEqual(
    rejected,
    { recorded: false, reason: "invalid_event" },
    "a mis-scoped event is refused before storage",
  );
  const degraded = await readProductInstrumentationSinkHealth();
  expectEqual(
    degraded.degraded,
    true,
    "a refused write makes the sink visibly degraded to an operator",
  );

  // ------------------------------------------------------------ retention
  await insertRaw(base, [
    "product-instrumentation-event.v1",
    BUSINESS_ID,
    "business",
    "agency_today_viewed",
    "overview",
    "ok",
    "2026-01-01T00:00:00.000Z",
    "2026-04-01",
  ]);
  const beforePurge = await count();
  const purged = await purgeExpiredProductInstrumentation("2026-08-09");
  expectEqual(purged, 1, "the purge removed exactly the expired row");
  expectEqual(
    await count(),
    beforePurge - 1,
    "the purge left unexpired rows alone",
  );

  const secondPurge = await purgeExpiredProductInstrumentation("2026-08-09");
  expectEqual(secondPurge, 0, "the purge is idempotent");

  console.log(
    `[${LABEL}] PASS: vocabularies and scope/tenancy enforced by the database, no unconstrained TEXT column, real writes land, refused writes make the sink visibly degraded, and the retention purge removes exactly the expired rows and is idempotent.`,
  );
}

main()
  .then(async () => {
    const db = getDb();
    await db.query(`DELETE FROM product_instrumentation_events`);
    await db.query(`DELETE FROM product_instrumentation_sink_health`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });
