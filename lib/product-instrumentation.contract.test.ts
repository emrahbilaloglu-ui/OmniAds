/**
 * The two allowlists that must agree, and the one failure mode that hides.
 *
 * A product instrumentation event passes through two independent gates: the
 * runtime validator (`validateProductInstrumentationEvent`, which checks
 * `PRODUCT_INSTRUMENTATION_SURFACES`) and, later, a stored CHECK constraint on
 * `product_instrumentation_events.surface`.
 *
 * Those are written in different files, by different hands, at different times,
 * and nothing tied them together. Emitting a name the runtime accepts and the
 * database rejects produces a green test suite here and a `23514` in
 * production — on a write path that is deliberately fire-and-forget, so the
 * first symptom is a metric that silently stops arriving.
 *
 * ## Which constraint is the real one
 *
 * Not the `CREATE TABLE` literal in `lib/migrations.ts`. `CREATE TABLE IF NOT
 * EXISTS` is a no-op on an existing database, so on any deployed instance that
 * list is dead text. The effective allowlist is the one
 * `instrumentationV2UpgradeStatements()` drops and rebuilds on every migration
 * run: `V1_SURFACES ∪ ZERO_BASE_SURFACES ∪ RATIFIED_EXTRA_SURFACES`. That is
 * what this file compares against.
 *
 * ## Why the list may only grow
 *
 * `ADD CONSTRAINT ... CHECK` validates existing rows. A name that production
 * rows already carry can never be removed from the allowlist without the next
 * migration failing on its own data — which is why `creative_studio` stays
 * even though nothing emits it any more.
 */
import { describe, expect, it } from "vitest";

import {
  PRODUCT_INSTRUMENTATION_EVENT_NAMES,
  PRODUCT_INSTRUMENTATION_SURFACES,
  validateProductInstrumentationEvent,
} from "@/lib/product-instrumentation";
import {
  RATIFIED_EXTRA_SURFACES,
  V1_SURFACES,
  ZERO_BASE_EVENTS,
  ZERO_BASE_SURFACES,
  instrumentationV2UpgradeStatements,
} from "@/lib/zero-base/instrumentation-schema";
import { INSTRUMENTATION_SURFACE_BY_SURFACE_ID } from "@/components/meta/use-screen-view";
import { META_SURFACES } from "@/lib/meta/surface-registry";

/** The allowlist the database actually enforces after a migration run. */
const STORED_SURFACES = new Set<string>([
  ...V1_SURFACES,
  ...ZERO_BASE_SURFACES,
  ...RATIFIED_EXTRA_SURFACES,
]);

describe("nothing the runtime accepts can be rejected by the database", () => {
  it("keeps every runtime surface inside the stored constraint", () => {
    const rejected = PRODUCT_INSTRUMENTATION_SURFACES.filter(
      (surface) => !STORED_SURFACES.has(surface),
    );
    expect(
      rejected,
      "surfaces the validator accepts and the CHECK constraint would refuse",
    ).toEqual([]);
  });

  it("keeps every runtime event name inside the stored constraint", () => {
    // The same trap, one column over. The event CHECK is rebuilt from
    // `V1_EVENTS ∪ ZERO_BASE_EVENTS` by the same upgrade statements.
    // `ADD CONSTRAINT` as well as the name: the DROP statement mentions the
    // same constraint and would match first, leaving nothing to search.
    const statement = instrumentationV2UpgradeStatements().find(
      (sql) =>
        sql.includes("product_instrumentation_events_event_name_check") &&
        sql.includes("ADD CONSTRAINT"),
    );
    expect(statement, "the event-name constraint is no longer rebuilt").toBeDefined();
    const rejected = PRODUCT_INSTRUMENTATION_EVENT_NAMES.filter(
      (name) => !statement!.includes(`'${name}'`),
    );
    expect(
      rejected,
      "event names the validator accepts and the CHECK constraint would refuse",
    ).toEqual([]);
  });

  it("rebuilds both constraints additively, never with a CREATE TABLE", () => {
    /*
     * The shape the from-zero gate depends on: every statement idempotent, so
     * it runs identically on a fresh database and on one holding v1 rows.
     */
    for (const statement of instrumentationV2UpgradeStatements()) {
      expect(statement).not.toMatch(/CREATE\s+TABLE/i);
      expect(statement).toMatch(/IF NOT EXISTS|DROP CONSTRAINT IF EXISTS|ADD CONSTRAINT/);
    }
  });

  it("never drops a name production rows could already carry", () => {
    /*
     * `creative_studio` is the live case. Eight Creative leaves used to emit it
     * and stored rows hold it; `ADD CONSTRAINT ... CHECK` validates existing
     * rows, so removing it would make the next migration fail on its own data.
     * It stays in both lists for ever, whatever stops emitting it.
     */
    expect(V1_SURFACES).toContain("creative_studio");
    expect(PRODUCT_INSTRUMENTATION_SURFACES).toContain("creative_studio");
  });
});

describe("the Creative Studio tabs are told apart", () => {
  it("gives each contracted leaf its own name", () => {
    const creative = Object.entries(INSTRUMENTATION_SURFACE_BY_SURFACE_ID).filter(
      ([surfaceId]) => surfaceId.startsWith("creative-"),
    );
    expect(creative.length).toBeGreaterThanOrEqual(8);

    const names = creative.map(([, surface]) => surface);
    expect(
      new Set(names).size,
      `Creative leaves still share a name: ${JSON.stringify(Object.fromEntries(creative))}`,
    ).toBe(names.length);
  });

  it("no longer emits the collapsed name from any surface", () => {
    // The value stays legal; nothing may emit it. That distinction is the whole
    // point of an additive widening.
    expect(Object.values(INSTRUMENTATION_SURFACE_BY_SURFACE_ID)).not.toContain(
      "creative_studio",
    );
  });

  it("maps every registry surface to a name both gates accept", () => {
    const bad: string[] = [];
    for (const surface of META_SURFACES) {
      const name = INSTRUMENTATION_SURFACE_BY_SURFACE_ID[surface.surfaceId];
      if (!name) continue;
      if (!PRODUCT_INSTRUMENTATION_SURFACES.includes(name as never)) {
        bad.push(`${surface.surfaceId} → ${name} (validator)`);
      }
      if (!STORED_SURFACES.has(name)) {
        bad.push(`${surface.surfaceId} → ${name} (constraint)`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("accepts a real per-tab event end to end through the validator", () => {
    // The claim stated as a call rather than as a set comparison.
    for (const surface of [
      "creative_copies",
      "creative_landing_pages",
      "creative_inbox",
      "creative_audiences",
    ] as const) {
      expect(
        validateProductInstrumentationEvent({
          eventName: "screen_view",
          surface,
          scope: "business",
          businessId: "biz_1",
          outcome: "ok",
          occurredAt: "2026-08-25T00:00:00.000Z",
        }),
        surface,
      ).toEqual({ ok: true });
    }
  });
});

describe("the vendored ledger and the product's own vocabulary are different things", () => {
  it("has one event in the vendored ledger and many in the product", () => {
    /*
     * Worth pinning, because conflating them is how "the contract is one
     * event" became a reason not to look at the rest. The vendored design
     * package describes SCREENS and names exactly one event; the product's own
     * lifecycle vocabulary is far larger and is the thing WP17 asks about.
     */
    expect(ZERO_BASE_EVENTS).toEqual(["screen_view"]);
    expect(PRODUCT_INSTRUMENTATION_EVENT_NAMES.length).toBeGreaterThan(30);
    expect(PRODUCT_INSTRUMENTATION_EVENT_NAMES).toContain("screen_view");
  });
});
