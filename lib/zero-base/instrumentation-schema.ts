/**
 * The v2 instrumentation schema, as SQL, generated from the vendored contract.
 *
 * Additive by construction: one table, extended in place. A second table would
 * split the retention job, the health counters and every operator query in
 * two, so the existing `product_instrumentation_events` gains nullable columns
 * and widened CHECK constraints instead.
 *
 * The allowlists are widened, never replaced — every v1 event name and surface
 * survives alongside the 74 zero-base surfaces, so events already written stay
 * readable and v1 emitters keep working during rollout.
 */
import {
  GENERATED_INSTRUMENTATION,
  type InstrumentationPropertyKey,
} from "@/lib/zero-base/generated-contracts";

export const INSTRUMENTATION_V1_CONTRACT = "product-instrumentation-event.v1";
export const INSTRUMENTATION_V2_CONTRACT = "product-instrumentation-event.v2";

/** Width buckets, matching the design's responsive breakpoints. */
export const WIDTH_BUCKETS = ["w320", "w390", "w768", "w1280", "w1440"] as const;
export type WidthBucket = (typeof WIDTH_BUCKETS)[number];

/** Server-derived, never client-supplied. */
export const ACTOR_ROLES = [
  "anonymous",
  "authenticated",
  "guest",
  "collaborator",
  "admin",
  "platform_admin",
] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

/** Zero-base surfaces from the vendored ledger, sorted for a stable diff. */
export const ZERO_BASE_SURFACES: readonly string[] = [
  ...new Set(GENERATED_INSTRUMENTATION.map((row) => row.surface)),
].sort();

export const ZERO_BASE_EVENTS: readonly string[] = [
  ...new Set(GENERATED_INSTRUMENTATION.map((row) => row.event)),
].sort();

export const ZERO_BASE_PROPERTY_KEYS: readonly InstrumentationPropertyKey[] = [
  ...new Set(GENERATED_INSTRUMENTATION.flatMap((row) => row.properties)),
].sort();

function quoteList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

/**
 * Additive upgrade. Every statement is idempotent so it runs identically on a
 * fresh database and on one that already holds v1 rows.
 */
export function instrumentationV2UpgradeStatements(): string[] {
  return [
    // 1 · New columns, all nullable: existing rows stay valid untouched.
    `ALTER TABLE product_instrumentation_events
       ADD COLUMN IF NOT EXISTS event_id UUID,
       ADD COLUMN IF NOT EXISTS actor_role TEXT,
       ADD COLUMN IF NOT EXISTS width_bucket TEXT,
       ADD COLUMN IF NOT EXISTS account_id TEXT,
       ADD COLUMN IF NOT EXISTS properties JSONB`,

    // 2 · Idempotency for zero-base emitters. Partial, so the thirty-odd
    //     thousand v1 rows with a NULL event_id do not collide with each other.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_product_instrumentation_event_id
       ON product_instrumentation_events (event_id)
       WHERE event_id IS NOT NULL`,

    `CREATE INDEX IF NOT EXISTS idx_product_instrumentation_surface_occurred
       ON product_instrumentation_events (surface, occurred_at DESC)`,

    // 3 · Widen the contract-version check to accept v2 as well as v1.
    `ALTER TABLE product_instrumentation_events
       DROP CONSTRAINT IF EXISTS product_instrumentation_events_contract_version_check`,
    `ALTER TABLE product_instrumentation_events
       ADD CONSTRAINT product_instrumentation_events_contract_version_check
       CHECK (contract_version IN ('${INSTRUMENTATION_V1_CONTRACT}', '${INSTRUMENTATION_V2_CONTRACT}'))`,

    // 4 · Widen event_name and surface. The v1 values are re-stated in full so
    //     this is provably a superset rather than a replacement.
    `ALTER TABLE product_instrumentation_events
       DROP CONSTRAINT IF EXISTS product_instrumentation_events_event_name_check`,
    `ALTER TABLE product_instrumentation_events
       ADD CONSTRAINT product_instrumentation_events_event_name_check
       CHECK (event_name IN (${quoteList([...V1_EVENT_NAMES, ...ZERO_BASE_EVENTS])}))`,

    `ALTER TABLE product_instrumentation_events
       DROP CONSTRAINT IF EXISTS product_instrumentation_events_surface_check`,
    `ALTER TABLE product_instrumentation_events
       ADD CONSTRAINT product_instrumentation_events_surface_check
       CHECK (surface IN (${quoteList([
         ...V1_SURFACES,
         ...ZERO_BASE_SURFACES,
         ...RATIFIED_EXTRA_SURFACES,
       ])}))`,

    // 5 · v2 rows must carry the server-derived fields; v1 rows must not be
    //     retro-fitted with them. The constraint is written so both hold.
    `ALTER TABLE product_instrumentation_events
       DROP CONSTRAINT IF EXISTS product_instrumentation_v2_requires_actor`,
    `ALTER TABLE product_instrumentation_events
       ADD CONSTRAINT product_instrumentation_v2_requires_actor
       CHECK (
         contract_version <> '${INSTRUMENTATION_V2_CONTRACT}'
         OR (actor_role IS NOT NULL AND width_bucket IS NOT NULL)
       )`,

    `ALTER TABLE product_instrumentation_events
       DROP CONSTRAINT IF EXISTS product_instrumentation_actor_role_check`,
    `ALTER TABLE product_instrumentation_events
       ADD CONSTRAINT product_instrumentation_actor_role_check
       CHECK (actor_role IS NULL OR actor_role IN (${quoteList(ACTOR_ROLES)}))`,

    `ALTER TABLE product_instrumentation_events
       DROP CONSTRAINT IF EXISTS product_instrumentation_width_bucket_check`,
    `ALTER TABLE product_instrumentation_events
       ADD CONSTRAINT product_instrumentation_width_bucket_check
       CHECK (width_bucket IS NULL OR width_bucket IN (${quoteList(WIDTH_BUCKETS)}))`,

    // 6 · account_id is an opaque provider reference, so it gets a format
    //     constraint rather than an allowlist. The pattern is what does the
    //     work: it bans spaces, slashes and colons, so a Search Console site
    //     URL or any other free text cannot land here — such a value has to be
    //     normalised to an opaque id before it reaches telemetry.
    `ALTER TABLE product_instrumentation_events
       DROP CONSTRAINT IF EXISTS product_instrumentation_account_id_shape`,
    `ALTER TABLE product_instrumentation_events
       ADD CONSTRAINT product_instrumentation_account_id_shape
       CHECK (account_id IS NULL OR account_id ~ '^[A-Za-z0-9_-]{1,64}$')`,

    // 7 · Bounded payload. A JSONB blob with no ceiling is where a query
    //     string or a stack trace eventually lands.
    `ALTER TABLE product_instrumentation_events
       DROP CONSTRAINT IF EXISTS product_instrumentation_properties_bounded`,
    `ALTER TABLE product_instrumentation_events
       ADD CONSTRAINT product_instrumentation_properties_bounded
       CHECK (
         properties IS NULL
         OR (jsonb_typeof(properties) = 'object' AND length(properties::text) <= 2048)
       )`,
  ];
}

/** v1 vocabularies, restated so the widened checks are provably supersets. */
export const V1_EVENT_NAMES: readonly string[] = [
  "agency_today_viewed", "agency_today_client_opened", "search_submitted",
  "search_zero_result", "search_result_opened", "saved_view_created",
  "saved_view_applied", "decision_opened", "decision_evidence_viewed",
  "decision_workflow_changed", "report_generated", "report_widget_failed",
  "report_widget_retried", "report_share_created", "report_print_opened",
  "report_csv_created", "google_copy_used", "google_csv_used",
  "google_deep_link_used", "provider_health_recovery_started",
  "provider_health_recovery_completed", "notification_attempted",
  "notification_delivered", "notification_opened", "notification_acknowledged",
  "guarded_action_preflight", "guarded_action_dry_run", "guarded_action_confirmed",
  "guarded_action_provider_attempted", "guarded_action_verified",
  "guarded_action_failed", "guarded_action_ambiguous", "guarded_action_reconciled",
  "mobile_tier0_started", "mobile_tier0_completed", "freshness_stale_disclosed",
];

/**
 * One surface the vendored contract does not name, added additively.
 *
 * `creative_audiences` is the fifth Creative Studio view. The archived package
 * predates that exact screen and records `/platforms/meta/audiences` as merged
 * into Meta Intelligence, which is why it is absent from
 * `GENERATED_INSTRUMENTATION` and therefore from `ZERO_BASE_SURFACES`. The
 * divergence is already ratified as `docs/adr-004-meta-audiences-destination.md`
 * and `lib/zero-base/compatibility.ts` overrides the same record for routing;
 * this is the telemetry half of the same decision.
 *
 * Additive only. `ADD CONSTRAINT ... CHECK` validates existing rows, so this
 * allowlist may grow and may never shrink — `creative_studio` in particular
 * stays for ever, because production rows already carry it.
 */
export const RATIFIED_EXTRA_SURFACES: readonly string[] = ["creative_audiences"];

export const V1_SURFACES: readonly string[] = [
  "overview", "global_search", "meta_decisions", "meta_decision_inspector",
  "creative_studio", "reports", "google_ads", "integrations", "settings",
  "launchpad", "automation", "mobile", "system",
];
