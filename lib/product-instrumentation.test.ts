import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  fail: false,
  inserts: [] as Array<{ text: string; values: unknown[] }>,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    query: async (text: string, values: unknown[]) => {
      if (state.fail) throw new Error("connection terminated");
      state.inserts.push({ text, values });
      return [];
    },
  }),
}));

import {
  PRODUCT_INSTRUMENTATION_RETENTION_DAYS,
  describeProductInstrumentationPosture,
  recordProductInstrumentationEvent,
  retainUntil,
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
    eventName: "agency_today_viewed",
    surface: "overview",
    outcome: "ok",
    occurredAt: "2026-08-09T10:00:00.000Z",
    ...overrides,
  };
}

describe("the sink records nothing that identifies a person", () => {
  it("has no person-scoped field in its event contract", () => {
    for (const forbidden of [
      "userId",
      "user_id",
      "email",
      "sessionId",
      "session_id",
      "ipAddress",
    ]) {
      expect(source, `${forbidden} must not be part of the contract`).not.toContain(
        `${forbidden}:`,
      );
    }
  });

  it("has no free-text column in the shipped schema", () => {
    const start = migrations.indexOf("CREATE TABLE IF NOT EXISTS product_instrumentation_events");
    const table = migrations.slice(start, migrations.indexOf(")\n      `", start));
    // Every TEXT column is either bounded by a CHECK vocabulary or a length cap.
    for (const line of table.split("\n")) {
      if (!/\bTEXT\b/.test(line)) continue;
      expect(
        /CHECK|length\(/.test(line) || /contract_version/.test(line) || /business_id/.test(line),
        `unbounded TEXT column: ${line.trim()}`,
      ).toBe(true);
    }
  });

  it("is tenant-scoped by business, and says so in its posture", () => {
    const posture = describeProductInstrumentationPosture();
    expect(posture.tenantScoped).toBe(true);
    expect(posture.personScoped).toBe(false);
    expect(posture.sink).toBe("first_party_postgres");
  });
});

describe("retention is stated with the data", () => {
  it("stamps every row with the date it stops being needed", () => {
    expect(retainUntil("2026-08-09T10:00:00.000Z")).toBe("2026-11-07");
  });

  it("reports the same window in its posture as it writes", () => {
    expect(describeProductInstrumentationPosture().retentionDays).toBe(
      PRODUCT_INSTRUMENTATION_RETENTION_DAYS,
    );
  });

  it("refuses an occurredAt it cannot date", () => {
    expect(() => retainUntil("not-a-date")).toThrow();
  });
});

describe("malformed events are refused at the edge", () => {
  it("rejects an unknown event name rather than storing it", () => {
    expect(
      validateProductInstrumentationEvent(
        event({ eventName: "made_up" as never }),
      ),
    ).toEqual({ ok: false, reason: "unknown_event_name" });
  });

  it("requires a failure to carry a bounded code", () => {
    expect(
      validateProductInstrumentationEvent(event({ outcome: "failed" })),
    ).toEqual({ ok: false, reason: "failure_requires_code" });
    expect(
      validateProductInstrumentationEvent(
        event({ outcome: "failed", failureCode: "made_up" as never }),
      ),
    ).toEqual({ ok: false, reason: "unknown_failure_code" });
    expect(
      validateProductInstrumentationEvent(
        event({ outcome: "failed", failureCode: "upstream_timeout" }),
      ),
    ).toEqual({ ok: true });
  });

  it("requires a tenant", () => {
    expect(
      validateProductInstrumentationEvent(event({ businessId: "  " })),
    ).toEqual({ ok: false, reason: "missing_business" });
  });
});

describe("a failing sink is visible, never silent", () => {
  it("reports an invalid event instead of recording it", async () => {
    state.fail = false;
    state.inserts.length = 0;
    const result = await recordProductInstrumentationEvent(
      event({ outcome: "failed" }),
    );
    expect(result).toEqual({ recorded: false, reason: "invalid_event" });
    expect(state.inserts).toHaveLength(0);
  });

  it("reports an unavailable sink instead of throwing into the request", async () => {
    state.fail = true;
    const result = await recordProductInstrumentationEvent(event());
    expect(result).toEqual({ recorded: false, reason: "sink_unavailable" });
  });

  it("records a valid event with its retention stamped", async () => {
    state.fail = false;
    state.inserts.length = 0;
    const result = await recordProductInstrumentationEvent(event());
    expect(result).toEqual({ recorded: true });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]!.values).toContain("2026-11-07");
    expect(state.inserts[0]!.text).toContain("product_instrumentation_events");
  });
});
