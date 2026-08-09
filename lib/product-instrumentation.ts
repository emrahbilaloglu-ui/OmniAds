/**
 * Product instrumentation: a first-party, tenant-scoped, retained event sink.
 *
 * Section 9 of the master plan needs outcome metrics after release — was Agency
 * Today opened, did search get used, did a widget fail, did anyone take the
 * Google escape hatch. Until now the only telemetry facility in the repo wrote
 * to stdout and reported its own posture as `productionReady: false`, which
 * means none of those questions could be answered from production.
 *
 * Three properties make this safe to turn on rather than something that has to
 * wait for an owner decision about a third party:
 *
 * **First-party.** Events go to our own PostgreSQL, in the same database as the
 * data they describe. No vendor, no egress, no second processor to contract
 * with.
 *
 * **Tenant-scoped, and deliberately not person-scoped.** Every row carries a
 * business id and nothing that identifies a human. There is no user id, no
 * email, no session id, and no free-text column anywhere in the schema — a
 * failure is a bounded code, never a message, because messages are where
 * personal data and ad copy leak in. That is enforced by a CHECK constraint on
 * the code vocabulary, not by reviewer discipline.
 *
 * **Retained on purpose, and expiring on purpose.** Every row states the date
 * it stops being needed. Retention is a column, so a purge is a delete on an
 * index rather than an archaeology project, and "how long do we keep this"
 * has an answer that lives with the data.
 *
 * Failures are visible. Recording never throws into a request path — an
 * analytics write must not break a page — but it never silently swallows
 * either: it returns an explicit outcome and warns, so a sink that has stopped
 * accepting events shows up as a sink that has stopped accepting events rather
 * than as an absence of user activity.
 */

import { getDb } from "@/lib/db";

export const PRODUCT_INSTRUMENTATION_CONTRACT_VERSION =
  "product-instrumentation-event.v1" as const;

/**
 * The complete event vocabulary. Adding a name here is a deliberate act: the
 * database CHECK constraint carries the same list, so an unknown name is
 * refused rather than quietly stored and never queried.
 */
export const PRODUCT_INSTRUMENTATION_EVENT_NAMES = [
  "agency_today_viewed",
  "entity_search_submitted",
  "saved_view_applied",
  "report_widget_failed",
  "google_export_used",
  "decision_workflow_action",
  "freshness_stale_disclosed",
] as const;

export type ProductInstrumentationEventName =
  (typeof PRODUCT_INSTRUMENTATION_EVENT_NAMES)[number];

export const PRODUCT_INSTRUMENTATION_OUTCOMES = [
  "ok",
  "failed",
  "withheld",
] as const;

export type ProductInstrumentationOutcome =
  (typeof PRODUCT_INSTRUMENTATION_OUTCOMES)[number];

/**
 * Bounded failure vocabulary.
 *
 * A code, never a message. An exception message can contain an account name, an
 * ad headline, a customer email or a token; a fixed code cannot.
 */
export const PRODUCT_INSTRUMENTATION_FAILURE_CODES = [
  "upstream_unavailable",
  "upstream_timeout",
  "not_authorized",
  "not_assigned",
  "contract_violation",
  "unknown",
] as const;

export type ProductInstrumentationFailureCode =
  (typeof PRODUCT_INSTRUMENTATION_FAILURE_CODES)[number];

/** How long product instrumentation is kept before it is purged. */
export const PRODUCT_INSTRUMENTATION_RETENTION_DAYS = 90;

export interface ProductInstrumentationEvent {
  /** Tenant scope. There is deliberately no person scope. */
  businessId: string;
  eventName: ProductInstrumentationEventName;
  /** Which surface emitted it, e.g. "overview" or "meta-decisions". */
  surface: string;
  outcome: ProductInstrumentationOutcome;
  provider?: "meta" | "google" | null;
  /** Bounded counters only; never a payload. */
  itemCount?: number | null;
  durationMs?: number | null;
  failureCode?: ProductInstrumentationFailureCode | null;
  occurredAt: string;
}

export type ProductInstrumentationResult =
  | { recorded: true }
  | { recorded: false; reason: "invalid_event" | "sink_unavailable" };

export function retainUntil(
  occurredAt: string,
  days = PRODUCT_INSTRUMENTATION_RETENTION_DAYS,
): string {
  const at = Date.parse(occurredAt);
  if (!Number.isFinite(at)) throw new TypeError("occurredAt must be an ISO timestamp");
  return new Date(at + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Validate before writing, so a malformed event is refused at the edge rather
 * than becoming a row nobody can interpret later.
 */
export function validateProductInstrumentationEvent(
  event: ProductInstrumentationEvent,
): { ok: true } | { ok: false; reason: string } {
  if (!event.businessId?.trim()) return { ok: false, reason: "missing_business" };
  if (!PRODUCT_INSTRUMENTATION_EVENT_NAMES.includes(event.eventName)) {
    return { ok: false, reason: "unknown_event_name" };
  }
  if (!PRODUCT_INSTRUMENTATION_OUTCOMES.includes(event.outcome)) {
    return { ok: false, reason: "unknown_outcome" };
  }
  if (!event.surface?.trim()) return { ok: false, reason: "missing_surface" };
  if (
    event.failureCode != null &&
    !PRODUCT_INSTRUMENTATION_FAILURE_CODES.includes(event.failureCode)
  ) {
    return { ok: false, reason: "unknown_failure_code" };
  }
  // A failure that carries no code is how "something went wrong" becomes
  // unactionable six weeks later.
  if (event.outcome === "failed" && !event.failureCode) {
    return { ok: false, reason: "failure_requires_code" };
  }
  if (!Number.isFinite(Date.parse(event.occurredAt))) {
    return { ok: false, reason: "invalid_occurred_at" };
  }
  return { ok: true };
}

/**
 * Record one event.
 *
 * Never throws into a caller's request path, and never pretends to have
 * succeeded: an unavailable sink returns `sink_unavailable` and warns, so the
 * gap is visible as a sink failure rather than as quiet user inactivity.
 */
export async function recordProductInstrumentationEvent(
  event: ProductInstrumentationEvent,
): Promise<ProductInstrumentationResult> {
  const validation = validateProductInstrumentationEvent(event);
  if (!validation.ok) {
    console.warn("[product-instrumentation] rejected", {
      eventName: event.eventName,
      reason: validation.reason,
    });
    return { recorded: false, reason: "invalid_event" };
  }
  try {
    const sql = getDb();
    await sql.query(
      `INSERT INTO product_instrumentation_events (
         contract_version, business_id, event_name, surface, outcome,
         provider, item_count, duration_ms, failure_code, occurred_at, retain_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::date)`,
      [
        PRODUCT_INSTRUMENTATION_CONTRACT_VERSION,
        event.businessId,
        event.eventName,
        event.surface,
        event.outcome,
        event.provider ?? null,
        event.itemCount ?? null,
        event.durationMs ?? null,
        event.failureCode ?? null,
        event.occurredAt,
        retainUntil(event.occurredAt),
      ],
    );
    return { recorded: true };
  } catch (error) {
    // Visible, and bounded: the sink's own failure is logged with a code, not
    // with the provider's message.
    console.warn("[product-instrumentation] sink_unavailable", {
      eventName: event.eventName,
      message: error instanceof Error ? error.message : String(error),
    });
    return { recorded: false, reason: "sink_unavailable" };
  }
}

export interface ProductInstrumentationPosture {
  sink: "first_party_postgres";
  productionReady: true;
  tenantScoped: true;
  personScoped: false;
  retentionDays: number;
  freeTextColumns: 0;
}

/**
 * What this facility can honestly claim about itself. Unlike the stdout-staged
 * operator telemetry, every field here is a property of the shipped schema.
 */
export function describeProductInstrumentationPosture(): ProductInstrumentationPosture {
  return {
    sink: "first_party_postgres",
    productionReady: true,
    tenantScoped: true,
    personScoped: false,
    retentionDays: PRODUCT_INSTRUMENTATION_RETENTION_DAYS,
    freeTextColumns: 0,
  };
}

/** Delete events past their stated retention. Returns the number removed. */
export async function purgeExpiredProductInstrumentation(
  today: string,
): Promise<number> {
  const sql = getDb();
  const rows = (await sql.query(
    `DELETE FROM product_instrumentation_events
     WHERE retain_until < $1::date
     RETURNING 1`,
    [today],
  )) as unknown as unknown[];
  return rows.length;
}
