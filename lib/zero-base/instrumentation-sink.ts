/**
 * v2 sink write.
 *
 * Writes into the same `product_instrumentation_events` table as v1 — the
 * whole point of the additive migration — and swallows every failure. A
 * telemetry write that can throw into a render path is worse than no
 * telemetry, so this returns void and never rejects; the sink-health counters
 * remain the operator-visible record of degradation.
 *
 * A repeated `event_id` is a no-op rather than an error: an offline client
 * that retries must not double-count, and the partial unique index makes that
 * a database guarantee rather than a hope.
 */
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { INSTRUMENTATION_V2_CONTRACT } from "@/lib/zero-base/instrumentation-schema";
import type { AcceptedInstrumentationEvent } from "@/lib/zero-base/instrumentation-contract";

/** Matches the v1 retention window. */
const RETENTION_DAYS = 90;

export async function recordZeroBaseScreenView(
  event: AcceptedInstrumentationEvent,
  now: Date = new Date(),
): Promise<void> {
  try {
    const readiness = await getDbSchemaReadiness({
      tables: ["product_instrumentation_events"],
    }).catch(() => null);
    if (!readiness?.ready) return;

    const retainUntil = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const sql = getDb();
    await sql`
      INSERT INTO product_instrumentation_events (
        contract_version, business_id, scope, event_name, surface, outcome,
        occurred_at, retain_until, event_id, actor_role, width_bucket,
        account_id, properties
      ) VALUES (
        ${INSTRUMENTATION_V2_CONTRACT},
        ${event.businessId},
        ${event.businessId ? "business" : "portfolio"},
        ${event.event},
        ${event.surface},
        'ok',
        ${now.toISOString()},
        ${retainUntil},
        ${event.eventId},
        ${event.actorRole},
        ${event.widthBucket},
        ${event.accountId},
        ${JSON.stringify(event.properties)}
      )
      ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
    `;
  } catch {
    // Deliberately silent: instrumentation must never block navigation.
  }
}
