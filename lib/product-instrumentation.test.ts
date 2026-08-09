import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  fail: false,
  hang: false,
  inserts: [] as Array<{ text: string; values: unknown[] }>,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    query: async (text: string, values: unknown[]) => {
      if (text.includes("product_instrumentation_sink_health")) {
        state.inserts.push({ text, values });
        return [];
      }
      if (state.fail) throw new Error("connection terminated: SELECT secret");
      if (state.hang) await new Promise((resolve) => setTimeout(resolve, 5_000));
      state.inserts.push({ text, values });
      return [];
    },
  }),
}));

import {
  PRODUCT_INSTRUMENTATION_EVENT_NAMES,
  PRODUCT_INSTRUMENTATION_RETENTION_DAYS,
  PRODUCT_INSTRUMENTATION_SURFACES,
  describeProductInstrumentationPosture,
  recordProductInstrumentationEvent,
  retainUntil,
  runProductInstrumentationRetentionIfDue,
  validateProductInstrumentationEvent,
  type ProductInstrumentationEvent,
} from "@/lib/product-instrumentation";

const migrations = readFileSync("lib/migrations.ts", "utf8");
const source = readFileSync("lib/product-instrumentation.ts", "utf8");

function event(
  overrides: Partial<ProductInstrumentationEvent> = {},
): ProductInstrumentationEvent {
  return {
    businessId: "biz-1",
    scope: "business",
    eventName: "decision_workflow_changed",
    surface: "meta_decision_inspector",
    outcome: "ok",
    occurredAt: "2026-08-09T10:00:00.000Z",
    ...overrides,
  };
}

describe("nothing recorded can identify a person or carry free text", () => {
  it("has no person-scoped field in the contract", () => {
    for (const forbidden of [
      "userId",
      "user_id",
      "email",
      "sessionId",
      "session_id",
      "ipAddress",
    ]) {
      expect(source).not.toContain(`${forbidden}:`);
    }
  });

  it("never records an exception message", () => {
    // A driver error can carry the failing statement, and the statement carries
    // the row. The catch must not read `error.message` at all.
    const catchBlock = source.slice(source.indexOf("} catch {"));
    expect(catchBlock).not.toContain("error.message");
    expect(source).not.toContain("String(error)");
  });

  it("constrains every string column to an allowlist in the shipped schema", () => {
    const start = migrations.indexOf(
      "CREATE TABLE IF NOT EXISTS product_instrumentation_events",
    );
    const table = migrations.slice(start, migrations.indexOf("      `);", start));
    for (const line of table.split("\n")) {
      if (!/\bTEXT\b/.test(line)) continue;
      const bounded =
        /CHECK/.test(line) ||
        /contract_version/.test(line) ||
        /business_id/.test(line);
      expect(bounded, `unbounded TEXT column: ${line.trim()}`).toBe(true);
    }
  });

  it("declares its posture from properties the schema actually has", () => {
    const posture = describeProductInstrumentationPosture();
    expect(posture).toMatchObject({
      sink: "first_party_postgres",
      tenantScoped: true,
      personScoped: false,
      retentionScheduled: true,
      freeTextColumns: 0,
    });
  });
});

describe("scope and tenancy must agree", () => {
  it("refuses a business event with no business", () => {
    expect(
      validateProductInstrumentationEvent(
        event({ scope: "business", businessId: null }),
      ),
    ).toEqual({ ok: false, reason: "business_scope_requires_business" });
  });

  it("refuses a portfolio event that names one business", () => {
    // This is the businesses[0] bug: cross-tenant work attributed to one tenant.
    expect(
      validateProductInstrumentationEvent(
        event({ scope: "portfolio", businessId: "biz-1" }),
      ),
    ).toEqual({ ok: false, reason: "portfolio_scope_forbids_business" });
  });

  it("accepts a correctly scoped portfolio event", () => {
    expect(
      validateProductInstrumentationEvent(
        event({ scope: "portfolio", businessId: null, eventName: "search_submitted", surface: "global_search" }),
      ),
    ).toEqual({ ok: true });
  });

  it("is enforced by the database, not only by the validator", () => {
    expect(migrations).toContain("product_instrumentation_scope_tenancy");
    expect(migrations).toContain(
      "(scope = 'portfolio' AND business_id IS NULL)",
    );
  });
});

describe("malformed events are refused at the edge", () => {
  it("rejects an unknown event name, surface, outcome and failure code", () => {
    expect(
      validateProductInstrumentationEvent(event({ eventName: "made_up" as never })),
    ).toEqual({ ok: false, reason: "unknown_event_name" });
    expect(
      validateProductInstrumentationEvent(event({ surface: "made_up" as never })),
    ).toEqual({ ok: false, reason: "unknown_surface" });
    expect(
      validateProductInstrumentationEvent(event({ outcome: "made_up" as never })),
    ).toEqual({ ok: false, reason: "unknown_outcome" });
    expect(
      validateProductInstrumentationEvent(
        event({ outcome: "failed", failureCode: "made_up" as never }),
      ),
    ).toEqual({ ok: false, reason: "unknown_failure_code" });
  });

  it("requires a failure to carry a bounded code", () => {
    expect(
      validateProductInstrumentationEvent(event({ outcome: "failed" })),
    ).toEqual({ ok: false, reason: "failure_requires_code" });
  });
});

describe("retention is stated with the data and actually scheduled", () => {
  it("stamps every row with the date it stops being needed", () => {
    expect(retainUntil("2026-08-09T10:00:00.000Z")).toBe("2026-11-07");
    expect(describeProductInstrumentationPosture().retentionDays).toBe(
      PRODUCT_INSTRUMENTATION_RETENTION_DAYS,
    );
  });

  it("skips outside its window and runs inside it", async () => {
    const notDue = await runProductInstrumentationRetentionIfDue(
      new Date("2026-08-09T10:00:00.000Z"),
    );
    expect(notDue).toMatchObject({ skipped: true, reason: "not_due" });

    state.fail = false;
    const due = await runProductInstrumentationRetentionIfDue(
      new Date("2026-08-09T03:00:00.000Z"),
    );
    expect(due).toMatchObject({ skipped: false, day: "2026-08-09" });
  });

  it("is wired into the cron the other maintenance jobs use", () => {
    const cron = readFileSync("app/api/sync/cron/route.ts", "utf8");
    expect(cron).toContain("runProductInstrumentationRetentionIfDue");
  });
});

describe("a failing sink is visible to an operator, never silent", () => {
  it("counts an invalid event instead of recording it", async () => {
    state.fail = false;
    state.inserts.length = 0;
    const result = await recordProductInstrumentationEvent(
      event({ outcome: "failed" }),
    );
    expect(result).toEqual({ recorded: false, reason: "invalid_event" });
    const health = state.inserts.filter((row) =>
      row.text.includes("sink_health"),
    );
    expect(health).toHaveLength(1);
    expect(health[0]!.values).toContain("invalid_event");
  });

  it("counts an unavailable sink instead of throwing into the request", async () => {
    state.fail = true;
    state.inserts.length = 0;
    const result = await recordProductInstrumentationEvent(event());
    expect(result).toEqual({ recorded: false, reason: "sink_unavailable" });
    expect(
      state.inserts.some((row) => row.values.includes("sink_unavailable")),
    ).toBe(true);
    state.fail = false;
  });

  it("records a valid event with its retention stamped and counts it", async () => {
    state.fail = false;
    state.inserts.length = 0;
    const result = await recordProductInstrumentationEvent(event());
    expect(result).toEqual({ recorded: true });
    const write = state.inserts.find((row) =>
      row.text.includes("INSERT INTO product_instrumentation_events"),
    );
    expect(write).toBeDefined();
    expect(write!.values).toContain("2026-11-07");
    expect(
      state.inserts.some((row) => row.values.includes("recorded")),
    ).toBe(true);
  });

  it("has a health table so degradation is readable, not just logged", () => {
    expect(migrations).toContain(
      "CREATE TABLE IF NOT EXISTS product_instrumentation_sink_health",
    );
    expect(source).toContain("readProductInstrumentationSinkHealth");
    expect(source).toContain("degraded:");
  });
});

describe("writes are awaited and bounded", () => {
  it("never detaches the write from the request", () => {
    // An unawaited promise can be terminated when the request ends, losing
    // events exactly when the system is busiest.
    expect(source).not.toContain("void recordProductInstrumentationEvent");
    for (const emitter of [
      "app/api/agency-today/route.ts",
      "app/api/search/route.ts",
    ]) {
      const text = readFileSync(emitter, "utf8");
      expect(text).toContain("await recordProductInstrumentationEvent(");
      expect(text).not.toContain("void recordProductInstrumentationEvent(");
    }
  });

  it("bounds the write so a slow sink degrades to a recorded failure", async () => {
    state.fail = false;
    state.hang = true;
    state.inserts.length = 0;
    const result = await recordProductInstrumentationEvent(event());
    expect(result).toEqual({ recorded: false, reason: "timeout" });
    expect(state.inserts.some((row) => row.values.includes("timeout"))).toBe(true);
    state.hang = false;
  }, 10_000);
});

describe("the vocabulary matches the shipped schema exactly", () => {
  it("declares every event name in the database CHECK", () => {
    for (const name of PRODUCT_INSTRUMENTATION_EVENT_NAMES) {
      expect(migrations, `${name} missing from the schema`).toContain(`'${name}'`);
    }
  });

  it("declares every surface in the database CHECK", () => {
    for (const surface of PRODUCT_INSTRUMENTATION_SURFACES) {
      expect(migrations, `${surface} missing from the schema`).toContain(
        `'${surface}'`,
      );
    }
  });
});
