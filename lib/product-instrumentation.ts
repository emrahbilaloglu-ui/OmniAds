/**
 * Product instrumentation: a first-party, tenant-scoped, retained event sink.
 *
 * Section 9 of the master plan needs outcome metrics after release — was Agency
 * Today opened, did search get used, did a widget fail, did anyone take the
 * Google escape hatch. The only prior telemetry facility wrote to stdout and
 * reported its own posture as `productionReady: false`, so none of those
 * questions could be answered from production.
 *
 * **First-party.** Events go to our own PostgreSQL, in the same database as the
 * data they describe. No vendor, no egress, no second processor.
 *
 * **Honestly scoped.** An event is either scoped to one business, or it is a
 * portfolio event that spans the viewer's whole workspace. A portfolio event
 * carries `businessId: null` and a count — never the first business in an
 * array, which would silently attribute cross-tenant work to one tenant and
 * make per-client metrics wrong in a way nobody would notice.
 *
 * **Not person-scoped.** No user id, email, session id, or IP. Every string
 * field is drawn from a closed allowlist enforced by a database CHECK, so there
 * is nowhere for a query, an exception message, a token, an ad headline or a
 * customer detail to land. Free text is impossible by construction, not by
 * reviewer vigilance.
 *
 * **Retained on purpose, expiring on purpose.** Every row states the date it
 * stops being needed, and `runProductInstrumentationRetentionIfDue` runs from
 * the same cron the other maintenance jobs use. Retention that is only a column
 * is not retention.
 *
 * **Failures are visible to an operator, not just to a log.** Every write
 * outcome is counted in `product_instrumentation_sink_health`, which the sink's
 * own health read exposes. A sink that has stopped accepting events reads as a
 * broken sink rather than as an absence of user activity.
 */

import { getDb } from "@/lib/db";

export const PRODUCT_INSTRUMENTATION_CONTRACT_VERSION =
  "product-instrumentation-event.v1" as const;

/**
 * The event vocabulary: master-plan section 9's minimum, in full.
 *
 * Every name here has a real emission point in shipped code, proven by
 * `product-instrumentation-emitters.test.ts`, which fails on an orphan in
 * either direction. A declared name with nothing emitting it reads like
 * coverage in the schema and in a dashboard while measuring nothing.
 *
 * Server-owned truth is emitted server-side. The provider lifecycle and the
 * notification lifecycle never come from the client telemetry endpoint: a
 * browser can report intent, but only the server knows whether a claim was
 * created, whether a POST went out, or whether a delivery was attempted.
 */
export const PRODUCT_INSTRUMENTATION_EVENT_NAMES = [
  // Agency Today
  "agency_today_viewed",
  "agency_today_client_opened",
  // Global search
  "search_submitted",
  "search_zero_result",
  "search_result_opened",
  // Saved views
  "saved_view_created",
  "saved_view_applied",
  // Decisions
  "decision_opened",
  "decision_evidence_viewed",
  "decision_workflow_changed",
  // Reports
  "report_generated",
  "report_widget_failed",
  "report_widget_retried",
  "report_share_created",
  "report_print_opened",
  "report_csv_created",
  // The Google escape-hatch events (google_copy_used, google_csv_used,
  // google_deep_link_used) were retired with the escape hatch itself: the
  // canonical Search screen draws no export or deep-link control, so nothing
  // emits them. They stay in the database CHECK so already-recorded rows remain
  // valid, and are out of the vocabulary so no new emission can claim a use
  // that no control produces.
  // Provider health recovery
  "provider_health_recovery_started",
  "provider_health_recovery_completed",
  // Notification lifecycle (server-owned)
  "notification_attempted",
  "notification_delivered",
  "notification_opened",
  "notification_acknowledged",
  // Guarded action lifecycle (server-owned)
  "guarded_action_preflight",
  "guarded_action_dry_run",
  "guarded_action_confirmed",
  "guarded_action_provider_attempted",
  "guarded_action_verified",
  "guarded_action_failed",
  "guarded_action_ambiguous",
  "guarded_action_reconciled",
  // Mobile Tier-0
  "mobile_tier0_started",
  "mobile_tier0_completed",
  // Freshness disclosure
  "freshness_stale_disclosed",
  /**
   * A mounted surface was rendered for an operator.
   *
   * The vendored leaf ledger declares `event: "screen_view"` for every leaf,
   * and this vocabulary had no such name — so the one event every screen owes
   * could not be emitted at all, and WP17's "her mounted Meta yüzeyi
   * screen_view" was unmeetable rather than unmet.
   *
   * Deliberately carries no identifier beyond the closed `surface` allowlist
   * and the business scope every other event already carries.
   */
  "screen_view",
] as const;

export type ProductInstrumentationEventName =
  (typeof PRODUCT_INSTRUMENTATION_EVENT_NAMES)[number];

/** Closed allowlist. `surface` may never be free text. */
export const PRODUCT_INSTRUMENTATION_SURFACES = [
  "overview",
  "global_search",
  "meta_decisions",
  "meta_decision_inspector",
  "creative_studio",
  "reports",
  "google_ads",
  "integrations",
  "settings",
  "launchpad",
  "automation",
  // The two rail rows D3 adds. Both routes have existed and worked all along;
  // neither had a surface name here, so nothing they emitted could be attributed
  // to them.
  "meta_intelligence",
  "meta_history",
  "mobile",
  "system",
  /*
   * The Creative Studio leaves, each addressable.
   *
   * `creative_studio` above stays for ever: production rows carry it and the
   * database CHECK validates existing rows, so this list may grow and may never
   * shrink. What it could not do until now is TELL THE TABS APART — eight
   * contracted leaves emitted one name, so per-tab adoption was unreadable from
   * the data. Every name below is already accepted by the stored constraint
   * (`V1_SURFACES ∪ ZERO_BASE_SURFACES ∪ RATIFIED_EXTRA_SURFACES`), which
   * `product-instrumentation.contract.test.ts` asserts rather than assumes:
   * emitting a name the database would reject is a 23514 in production and a
   * green test suite here.
   */
  "creative_performance",
  "creative_copies",
  "creative_landing_pages",
  "creative_inbox",
  "creative_audiences",
  "creative_briefs",
  "creative_shares",
  "creative_detail",
  "share_creative",
] as const;

export type ProductInstrumentationSurface =
  (typeof PRODUCT_INSTRUMENTATION_SURFACES)[number];

export const PRODUCT_INSTRUMENTATION_OUTCOMES = [
  "ok",
  "failed",
  "withheld",
] as const;

export type ProductInstrumentationOutcome =
  (typeof PRODUCT_INSTRUMENTATION_OUTCOMES)[number];

/**
 * Bounded failure vocabulary: a code, never a message. An exception message can
 * contain an account name, an ad headline, a customer email or a token.
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

/** How long product instrumentation is kept before the retention job deletes it. */
export const PRODUCT_INSTRUMENTATION_RETENTION_DAYS = 90;

/**
 * A write is bounded so instrumentation can never hold a request open. The
 * budget is deliberately small: this is analytics, and a slow sink must degrade
 * to a recorded failure rather than to a slow page.
 */
export const PRODUCT_INSTRUMENTATION_WRITE_TIMEOUT_MS = 750;

export type ProductInstrumentationScope = "business" | "portfolio";

export interface ProductInstrumentationEvent {
  /**
   * Tenant scope. `null` is only legal for a portfolio-scoped event, which
   * spans the viewer's whole workspace and belongs to no single business.
   */
  businessId: string | null;
  scope: ProductInstrumentationScope;
  eventName: ProductInstrumentationEventName;
  surface: ProductInstrumentationSurface;
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
  | { recorded: false; reason: "invalid_event" | "sink_unavailable" | "timeout" };

export function retainUntil(
  occurredAt: string,
  days = PRODUCT_INSTRUMENTATION_RETENTION_DAYS,
): string {
  const at = Date.parse(occurredAt);
  if (!Number.isFinite(at)) {
    throw new TypeError("occurredAt must be an ISO timestamp");
  }
  return new Date(at + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function validateProductInstrumentationEvent(
  event: ProductInstrumentationEvent,
): { ok: true } | { ok: false; reason: string } {
  if (!PRODUCT_INSTRUMENTATION_EVENT_NAMES.includes(event.eventName)) {
    return { ok: false, reason: "unknown_event_name" };
  }
  if (!PRODUCT_INSTRUMENTATION_SURFACES.includes(event.surface)) {
    return { ok: false, reason: "unknown_surface" };
  }
  if (!PRODUCT_INSTRUMENTATION_OUTCOMES.includes(event.outcome)) {
    return { ok: false, reason: "unknown_outcome" };
  }
  // Scope and tenancy must agree. A business event without a business would be
  // unattributable; a portfolio event with one would attribute cross-tenant
  // work to a single tenant, which is the failure this contract exists to stop.
  if (event.scope === "business" && !event.businessId?.trim()) {
    return { ok: false, reason: "business_scope_requires_business" };
  }
  if (event.scope === "portfolio" && event.businessId != null) {
    return { ok: false, reason: "portfolio_scope_forbids_business" };
  }
  if (
    event.failureCode != null &&
    !PRODUCT_INSTRUMENTATION_FAILURE_CODES.includes(event.failureCode)
  ) {
    return { ok: false, reason: "unknown_failure_code" };
  }
  if (event.outcome === "failed" && !event.failureCode) {
    return { ok: false, reason: "failure_requires_code" };
  }
  if (!Number.isFinite(Date.parse(event.occurredAt))) {
    return { ok: false, reason: "invalid_occurred_at" };
  }
  return { ok: true };
}

async function countSinkHealth(
  status: "recorded" | "invalid_event" | "sink_unavailable" | "timeout",
) {
  try {
    const sql = getDb();
    await sql.query(
      `INSERT INTO product_instrumentation_sink_health (day, status, event_count)
       VALUES (CURRENT_DATE, $1, 1)
       ON CONFLICT (day, status)
       DO UPDATE SET event_count = product_instrumentation_sink_health.event_count + 1,
                     updated_at = now()`,
      [status],
    );
  } catch {
    // The health counter is the last line; if the database is entirely gone
    // there is nothing further to record, and throwing here would turn an
    // analytics outage into a request failure.
  }
}

/**
 * Record one event.
 *
 * Awaited and bounded — never a detached promise. An unawaited write can be
 * terminated when the request ends, which loses events silently and exactly
 * when the system is busiest. The timeout keeps that await cheap.
 *
 * Never throws into a caller's request path, and never pretends to have
 * succeeded.
 */
export async function recordProductInstrumentationEvent(
  event: ProductInstrumentationEvent,
): Promise<ProductInstrumentationResult> {
  const validation = validateProductInstrumentationEvent(event);
  if (!validation.ok) {
    await countSinkHealth("invalid_event");
    return { recorded: false, reason: "invalid_event" };
  }
  try {
    const sql = getDb();
    const write = sql.query(
      `INSERT INTO product_instrumentation_events (
         contract_version, business_id, scope, event_name, surface, outcome,
         provider, item_count, duration_ms, failure_code, occurred_at, retain_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::date)`,
      [
        PRODUCT_INSTRUMENTATION_CONTRACT_VERSION,
        event.businessId,
        event.scope,
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(
        () => resolve("timeout"),
        PRODUCT_INSTRUMENTATION_WRITE_TIMEOUT_MS,
      );
    });
    try {
      const outcome = await Promise.race([write.then(() => "ok" as const), timeout]);
      if (outcome === "timeout") {
        await countSinkHealth("timeout");
        return { recorded: false, reason: "timeout" };
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    await countSinkHealth("recorded");
    return { recorded: true };
  } catch {
    // Deliberately no error message anywhere: a driver error can carry the
    // failing statement, and the statement carries the row.
    await countSinkHealth("sink_unavailable");
    return { recorded: false, reason: "sink_unavailable" };
  }
}

export interface ProductInstrumentationPosture {
  sink: "first_party_postgres";
  productionReady: true;
  tenantScoped: true;
  personScoped: false;
  retentionDays: number;
  retentionScheduled: true;
  freeTextColumns: 0;
}

export function describeProductInstrumentationPosture(): ProductInstrumentationPosture {
  return {
    sink: "first_party_postgres",
    productionReady: true,
    tenantScoped: true,
    personScoped: false,
    retentionDays: PRODUCT_INSTRUMENTATION_RETENTION_DAYS,
    retentionScheduled: true,
    freeTextColumns: 0,
  };
}

export interface ProductInstrumentationSinkHealth {
  day: string;
  recorded: number;
  invalidEvent: number;
  sinkUnavailable: number;
  timeout: number;
  /** True when any write failed today: the operator-visible alert condition. */
  degraded: boolean;
}

/**
 * Operator-visible sink health. This is what makes a failing sink a fact
 * someone can see rather than a line in a log nobody reads.
 */
export async function readProductInstrumentationSinkHealth(
  day?: string,
): Promise<ProductInstrumentationSinkHealth> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT status, event_count
     FROM product_instrumentation_sink_health
     WHERE day = COALESCE($1::date, CURRENT_DATE)`,
    [day ?? null],
  )) as unknown as Array<{ status: string; event_count: number | string }>;
  const byStatus = new Map(
    rows.map((row) => [row.status, Number(row.event_count)]),
  );
  const invalidEvent = byStatus.get("invalid_event") ?? 0;
  const sinkUnavailable = byStatus.get("sink_unavailable") ?? 0;
  const timeout = byStatus.get("timeout") ?? 0;
  return {
    day: day ?? new Date().toISOString().slice(0, 10),
    recorded: byStatus.get("recorded") ?? 0,
    invalidEvent,
    sinkUnavailable,
    timeout,
    degraded: invalidEvent + sinkUnavailable + timeout > 0,
  };
}

/** Delete events past their stated retention. Idempotent; returns rows removed. */
export async function purgeExpiredProductInstrumentation(
  today?: string,
): Promise<number> {
  const sql = getDb();
  const rows = (await sql.query(
    `DELETE FROM product_instrumentation_events
     WHERE retain_until < COALESCE($1::date, CURRENT_DATE)
     RETURNING 1`,
    [today ?? null],
  )) as unknown as unknown[];
  return rows.length;
}

/**
 * Scheduled retention, run from the same cron as the other maintenance jobs.
 *
 * Idempotent by construction: it deletes rows already past their stated
 * retention, so a second run in the same hour removes nothing and is harmless.
 */
export async function runProductInstrumentationRetentionIfDue(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== 3) {
    return { skipped: true as const, reason: "not_due" as const, day };
  }
  try {
    const purged = await purgeExpiredProductInstrumentation(day);
    return { skipped: false as const, day, purged };
  } catch {
    return { skipped: false as const, day, purged: 0, failed: true as const };
  }
}
