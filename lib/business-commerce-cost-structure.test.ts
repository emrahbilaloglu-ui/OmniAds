import { beforeEach, describe, expect, it, vi } from "vitest";

import { component, structure } from "@/lib/commerce-cost/__tests__/fixtures";
import { costStructureRevision } from "@/lib/commerce-cost/revision";
import type { CommerceCostStructure } from "@/src/types/commerce-cost";

/**
 * The store's job is to make two things impossible: two operators both writing
 * version N, and a caller mistaking unreadable storage for an empty one.
 *
 * Every statement the store issues is recorded in order, because the ORDER is
 * the contract — the advisory lock has to come before the read it protects, or
 * it protects nothing.
 */

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const RECORDED_AT = "2026-09-17T09:00:00.000Z";

interface RecordedCall {
  text: string;
  values: unknown[];
}

const calls: RecordedCall[] = [];

/** What the fake database currently holds; each test sets this up. */
const state: {
  current: { version: number; revision: string } | null;
  currentStructure: CommerceCostStructure | null;
  historyMaxVersion: number | null;
  readThrows: unknown;
  writeThrows: unknown;
  historyRows: Array<Record<string, unknown>>;
} = {
  current: null,
  currentStructure: null,
  historyMaxVersion: null,
  readThrows: null,
  writeThrows: null,
  historyRows: [],
};

const readiness = { ready: true, missingTables: [] as string[], checkedAt: RECORDED_AT };

vi.mock("@/lib/db", () => {
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });

    if (text.includes("pg_advisory_xact_lock")) return [];

    if (text.includes("/* commerce-cost-structure-current */")) {
      if (state.readThrows) throw state.readThrows;
      return [
        {
          current_version: state.current?.version ?? null,
          current_revision: state.current?.revision ?? null,
          current_structure: state.currentStructure
            ? JSON.stringify(state.currentStructure)
            : null,
          history_version: state.historyMaxVersion,
        },
      ];
    }

    if (text.includes("/* commerce-cost-structure-write */")) {
      if (state.writeThrows) throw state.writeThrows;
      // Echo back what the statement was asked to store, the way RETURNING does.
      const [, , version, revision, , , structureJson] = values;
      return [
        {
          business_id: BUSINESS_ID,
          version,
          revision,
          structure: structureJson,
          recorded_at: RECORDED_AT,
          updated_by_user_id: "user-1",
          created_at: RECORDED_AT,
          updated_at: RECORDED_AT,
        },
      ];
    }

    if (text.includes("/* commerce-cost-structure-read */")) {
      if (state.readThrows) throw state.readThrows;
      if (!state.current) return [];
      return [
        {
          business_id: BUSINESS_ID,
          version: state.current.version,
          revision: state.current.revision,
          structure: JSON.stringify(
            structure({ businessId: BUSINESS_ID, version: state.current.version }),
          ),
          recorded_at: RECORDED_AT,
          updated_by_user_id: "user-1",
          created_at: RECORDED_AT,
          updated_at: RECORDED_AT,
        },
      ];
    }

    if (text.includes("/* commerce-cost-structure-history */")) {
      if (state.readThrows) throw state.readThrows;
      return state.historyRows;
    }

    return [];
  }) as unknown as ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
    query: ReturnType<typeof vi.fn>;
  };
  sql.query = vi.fn(async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    return [];
  });

  return {
    getDb: vi.fn(() => sql),
    // Pass-through: the callback runs, and getDb() hands back the same fake.
    runDbTransaction: vi.fn(async (callback: () => Promise<unknown>) => callback()),
  };
});

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => readiness),
  isMissingRelationError: vi.fn(
    (error: unknown) => (error as { code?: string } | null)?.code === "42P01",
  ),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  resolveBusinessReferenceIds: vi.fn(
    async (ids: string[]) => new Map(ids.map((id) => [id, id] as const)),
  ),
}));

const db = await import("@/lib/db");
const store = await import("@/lib/business-commerce-cost-structure");

function stored(version: number): CommerceCostStructure {
  return structure({ businessId: BUSINESS_ID, version });
}

function saveInput(overrides: Partial<Parameters<typeof store.saveCostStructure>[0]> = {}) {
  return {
    businessId: BUSINESS_ID,
    structure: stored(1),
    expectedRevision: store.costStructureAbsentRevision(BUSINESS_ID),
    recordedAt: RECORDED_AT,
    updatedByUserId: "user-1",
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  state.current = null;
  state.currentStructure = null;
  state.historyMaxVersion = null;
  state.readThrows = null;
  state.writeThrows = null;
  state.historyRows = [];
  readiness.ready = true;
  readiness.missingTables = [];
  vi.clearAllMocks();
});

describe("saveCostStructure: atomicity", () => {
  it("opens one transaction and takes the business lock before reading anything", async () => {
    await store.saveCostStructure(saveInput());

    expect(db.runDbTransaction).toHaveBeenCalledTimes(1);
    // The lock must be FIRST. Taken after the read, it would not stop two
    // writers from both seeing version 0 and both computing version 1.
    expect(calls[0]?.text).toContain("pg_advisory_xact_lock");
    expect(calls[0]?.values).toContain(`business_commerce_cost_structure:${BUSINESS_ID}`);
    expect(calls[1]?.text).toContain("/* commerce-cost-structure-current */");
  });

  it("locks per business, so two businesses do not serialise against each other", async () => {
    await store.saveCostStructure(saveInput());
    const other = "22222222-2222-4222-8222-222222222222";
    await store.saveCostStructure(
      saveInput({
        businessId: other,
        structure: { ...stored(1), businessId: other },
        expectedRevision: store.costStructureAbsentRevision(other),
      }),
    );

    const lockKeys = calls
      .filter((call) => call.text.includes("pg_advisory_xact_lock"))
      .map((call) => call.values.find((value) => typeof value === "string"));
    expect(lockKeys).toEqual([
      `business_commerce_cost_structure:${BUSINESS_ID}`,
      `business_commerce_cost_structure:${other}`,
    ]);
  });

  it("writes the current row and its history in one statement", async () => {
    await store.saveCostStructure(saveInput());

    const write = calls.find((call) => call.text.includes("/* commerce-cost-structure-write */"));
    expect(write).toBeTruthy();
    // One statement, so there is no ordering in which a current row exists at a
    // version the history cannot explain.
    expect(write?.text).toContain("INSERT INTO business_commerce_cost_structures");
    expect(write?.text).toContain("INSERT INTO business_commerce_cost_structure_history");
    expect(
      calls.filter((call) => /INSERT INTO business_commerce_cost/.test(call.text)),
    ).toHaveLength(1);
  });

  it("reads the current row FOR UPDATE", async () => {
    await store.saveCostStructure(saveInput());
    const read = calls.find((call) => call.text.includes("/* commerce-cost-structure-current */"));
    expect(read?.text).toContain("FOR UPDATE");
  });
});

describe("saveCostStructure: server authority", () => {
  it("replaces the businessId, version and recordedAt the caller supplied", async () => {
    state.current = { version: 4, revision: costStructureRevision(stored(4)) };
    state.historyMaxVersion = 4;

    const result = await store.saveCostStructure(
      saveInput({
        structure: {
          ...stored(1),
          businessId: "someone-elses-business",
          version: 999,
          recordedAt: "1999-01-01T00:00:00.000Z",
        },
        expectedRevision: state.current.revision,
      }),
    );

    expect(result.stored.structure.businessId).toBe(BUSINESS_ID);
    expect(result.stored.structure.version).toBe(5);
    expect(result.stored.structure.recordedAt).toBe(RECORDED_AT);
    expect(result.previousVersion).toBe(4);
  });

  it("computes the revision from what it stores, not from what it was handed", async () => {
    const result = await store.saveCostStructure(
      saveInput({ structure: { ...stored(1), version: 999 } }),
    );

    expect(result.stored.revision).toBe(costStructureRevision(result.stored.structure));
    expect(result.stored.revision).not.toBe(
      costStructureRevision({ ...stored(1), version: 999 }),
    );
  });

  it("turns a saved legacy preview into an operator structure", async () => {
    // Otherwise the first save would store `legacy_import` forever, and
    // `legacyStructureNeedsConfirmation` would hold it unactivatable no matter
    // how carefully the operator confirmed it.
    const result = await store.saveCostStructure(
      saveInput({ structure: { ...stored(1), origin: "legacy_import", confirmed: true } }),
    );

    expect(result.stored.structure.origin).toBe("operator");
    // Confirmation stays the operator's statement, not the server's.
    expect(result.stored.structure.confirmed).toBe(true);
  });

  it("does not let a save claim it was a template or an import", async () => {
    for (const origin of ["template", "legacy_import"] as const) {
      const result = await store.saveCostStructure(
        saveInput({ structure: { ...stored(1), origin } }),
      );
      expect(result.stored.structure.origin).toBe("operator");
    }
  });

  it("stamps the recordedAt it was given, so the structure and its components agree", async () => {
    // The HTTP boundary stamps component recordedAt while sanitising. A second
    // clock read here would leave the two disagreeing by microseconds about
    // when this version was recorded.
    const result = await store.saveCostStructure(
      saveInput({ recordedAt: "2026-05-05T05:05:05.000Z" }),
    );
    expect(result.stored.structure.recordedAt).toBe("2026-05-05T05:05:05.000Z");
  });

  it("starts at version 1 and advances by one", async () => {
    const first = await store.saveCostStructure(saveInput());
    expect(first.stored.version).toBe(1);
    expect(first.previousVersion).toBeNull();

    state.current = { version: 1, revision: first.stored.revision };
    state.historyMaxVersion = 1;
    const second = await store.saveCostStructure(
      saveInput({ expectedRevision: first.stored.revision }),
    );
    expect(second.stored.version).toBe(2);
  });

  it("never reuses a version the history has already recorded", async () => {
    // A current row removed without its history would otherwise restart at 1 and
    // give two different answers to "what was version 1".
    state.current = null;
    state.historyMaxVersion = 7;

    const result = await store.saveCostStructure(saveInput());
    expect(result.stored.version).toBe(8);
  });
});

describe("saveCostStructure: concurrency", () => {
  it("refuses a stale token and reports the current one", async () => {
    state.current = { version: 3, revision: costStructureRevision(stored(3)) };
    state.historyMaxVersion = 3;

    await expect(
      store.saveCostStructure(saveInput({ expectedRevision: "a".repeat(64) })),
    ).rejects.toMatchObject({
      name: "CostStructureRevisionConflictError",
      currentRevision: state.current.revision,
      currentVersion: 3,
    });

    // Nothing was written.
    expect(calls.some((call) => call.text.includes("commerce-cost-structure-write"))).toBe(false);
  });

  it("refuses a first save when someone else already created version 1", async () => {
    state.current = { version: 1, revision: costStructureRevision(stored(1)) };
    state.historyMaxVersion = 1;

    await expect(
      store.saveCostStructure(
        saveInput({ expectedRevision: store.costStructureAbsentRevision(BUSINESS_ID) }),
      ),
    ).rejects.toMatchObject({ name: "CostStructureRevisionConflictError", currentVersion: 1 });
  });

  it("accepts only the absent token scoped to this business", async () => {
    const withToken = await store.saveCostStructure(
      saveInput({ expectedRevision: store.costStructureAbsentRevision(BUSINESS_ID) }),
    );
    expect(withToken.stored.version).toBe(1);

    const otherBusinessToken = store.costStructureAbsentRevision(
      "22222222-2222-4222-8222-222222222222",
    );
    await expect(
      store.saveCostStructure(saveInput({ expectedRevision: otherBusinessToken })),
    ).rejects.toBeInstanceOf(store.CostStructureRevisionConflictError);
  });

  it("reports the absent sentinel, not null, when a stale token meets an empty store", async () => {
    // So the caller always has a token it can retry with.
    await expect(
      store.saveCostStructure(saveInput({ expectedRevision: "b".repeat(64) })),
    ).rejects.toMatchObject({
      currentRevision: store.costStructureAbsentRevision(BUSINESS_ID),
      currentVersion: 0,
    });
  });

  it("creates a stable, business-scoped absent revision", () => {
    const token = store.costStructureAbsentRevision(BUSINESS_ID);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(
      store.costStructureAbsentRevision("22222222-2222-4222-8222-222222222222"),
    );
    expect(costStructureRevision(stored(1))).not.toBe(token);
  });
});

describe("storage that cannot be read is not storage that is empty", () => {
  it("throws rather than returning null when the schema is not ready", async () => {
    readiness.ready = false;
    readiness.missingTables = ["business_commerce_cost_structures"];

    await expect(store.getStoredCostStructure(BUSINESS_ID)).rejects.toMatchObject({
      name: "CostStructureSchemaUnavailableError",
      missingTables: ["business_commerce_cost_structures"],
    });
  });

  it("throws rather than returning null when the relation is missing", async () => {
    state.readThrows = Object.assign(new Error("relation does not exist"), { code: "42P01" });

    await expect(store.getStoredCostStructure(BUSINESS_ID)).rejects.toBeInstanceOf(
      store.CostStructureSchemaUnavailableError,
    );
  });

  it("returns null only when the table is readable and holds nothing", async () => {
    state.current = null;
    await expect(store.getStoredCostStructure(BUSINESS_ID)).resolves.toBeNull();
  });

  it("refuses to write, and writes nothing, when the schema is not ready", async () => {
    readiness.ready = false;
    readiness.missingTables = ["business_commerce_cost_structure_history"];

    await expect(store.saveCostStructure(saveInput())).rejects.toBeInstanceOf(
      store.CostStructureSchemaUnavailableError,
    );
    expect(db.runDbTransaction).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("does not convert a genuine database error into unavailability", async () => {
    state.writeThrows = Object.assign(new Error("deadlock detected"), { code: "40P01" });

    await expect(store.saveCostStructure(saveInput())).rejects.toThrow("deadlock detected");
  });
});

describe("history reads", () => {
  it("returns versions newest first without loading every structure", async () => {
    state.historyRows = [
      {
        version: 2,
        revision: "b".repeat(64),
        effective_from: RECORDED_AT,
        recorded_at: RECORDED_AT,
        updated_by_user_id: "user-1",
        origin: "operator",
        confirmed: true,
      },
      {
        version: 1,
        revision: "a".repeat(64),
        effective_from: RECORDED_AT,
        recorded_at: RECORDED_AT,
        updated_by_user_id: null,
        origin: "legacy_import",
        confirmed: false,
      },
    ];

    const history = await store.listCostStructureHistory({ businessId: BUSINESS_ID });

    expect(history.map((entry) => entry.version)).toEqual([2, 1]);
    expect(history[0]).toMatchObject({ origin: "operator", confirmed: true });
    // A history listing answers "what happened and who did it", so it must not
    // pay to deserialise every stored blob to do it.
    const read = calls.find((call) => call.text.includes("commerce-cost-structure-history"));
    expect(read?.text).not.toContain("structure,");
    expect(read?.text).toContain("ORDER BY version DESC");
  });

  it("bounds the limit rather than trusting the caller", async () => {
    await store.listCostStructureHistory({ businessId: BUSINESS_ID, limit: 10_000 });
    const read = calls.find((call) => call.text.includes("commerce-cost-structure-history"));
    expect(read?.values).toContain(200);
  });
});

describe("the fixture structure stays a valid save target", () => {
  it("round-trips a component through the stored structure", async () => {
    const result = await store.saveCostStructure(
      saveInput({
        structure: structure({
          businessId: BUSINESS_ID,
          components: [component({ id: "cogs" })],
        }),
      }),
    );
    expect(result.stored.structure.components[0]?.id).toBe("cogs");
  });
});

describe("components are reconciled against the row read under the lock", () => {
  const OLD = "2026-01-01T00:00:00.000Z";

  /** Puts a stored structure in place and returns the token to save against. */
  function givenStored(components: ReturnType<typeof component>[]) {
    const current = structure({ businessId: BUSINESS_ID, version: 2, components });
    state.currentStructure = current;
    state.current = { version: 2, revision: costStructureRevision(current) };
    state.historyMaxVersion = 2;
    return state.current.revision;
  }

  it("reads the stored structure in the same statement it locks the row with", async () => {
    const expectedRevision = givenStored([component({ id: "cogs", recordedAt: OLD })]);
    await store.saveCostStructure(
      saveInput({
        structure: structure({ components: [component({ id: "cogs", recordedAt: OLD })] }),
        expectedRevision,
      }),
    );

    const read = calls.find((call) => call.text.includes("commerce-cost-structure-current"));
    // Reconciling against a structure read anywhere else would decide
    // "unchanged" from a state someone may have replaced since.
    expect(read?.text).toContain("structure");
    expect(read?.text).toContain("FOR UPDATE");
    expect(calls.indexOf(read!)).toBe(1);
    expect(calls[0]?.text).toContain("pg_advisory_xact_lock");
  });

  it("does not move the transaction time of a component nobody edited", async () => {
    const stored = component({ id: "cogs", version: 3, recordedAt: OLD });
    const shipping = component({
      id: "shipping",
      family: "outbound_shipping",
      version: 1,
      recordedAt: OLD,
    });
    const expectedRevision = givenStored([stored, shipping]);

    const result = await store.saveCostStructure(
      saveInput({
        structure: structure({
          components: [
            { ...stored },
            { ...shipping, basis: { kind: "amount_per_unit", amount: 42 } },
          ],
        }),
        expectedRevision,
        recordedAt: RECORDED_AT,
      }),
    );

    const [cogs, edited] = result.stored.structure.components;
    expect(cogs?.recordedAt).toBe(OLD);
    expect(cogs?.version).toBe(3);
    expect(edited?.recordedAt).toBe(RECORDED_AT);
    expect(edited?.version).toBe(2);
    expect(result.components.unchanged).toEqual(["cogs"]);
    expect(result.components.changed).toEqual([
      { id: "shipping", fromVersion: 1, toVersion: 2 },
    ]);
  });

  it("ignores a component version the caller supplied", async () => {
    const stored = component({ id: "cogs", version: 3, recordedAt: OLD });
    const expectedRevision = givenStored([stored]);

    const result = await store.saveCostStructure(
      saveInput({
        structure: structure({
          components: [{ ...stored, version: 900, label: "edited" }],
        }),
        expectedRevision,
      }),
    );

    expect(result.stored.structure.components[0]?.version).toBe(4);
  });

  it("stamps the acting user on what it changed", async () => {
    const stored = component({ id: "cogs", version: 1, recordedAt: OLD });
    const expectedRevision = givenStored([stored]);

    const result = await store.saveCostStructure(
      saveInput({
        structure: structure({ components: [{ ...stored, label: "edited" }] }),
        expectedRevision,
        updatedByUserId: "user-2",
      }),
    );

    expect(result.stored.structure.components[0]?.audit).toMatchObject({
      createdBy: "user-2",
      createdAt: RECORDED_AT,
    });
  });

  it("replaces a component when it is retired, leaving nothing active behind", async () => {
    const stored = component({ id: "cogs", version: 1, status: "active", recordedAt: OLD });
    const expectedRevision = givenStored([stored]);

    const result = await store.saveCostStructure(
      saveInput({
        structure: structure({ components: [{ ...stored, status: "retired" }] }),
        expectedRevision,
      }),
    );

    const components = result.stored.structure.components;
    expect(components).toHaveLength(1);
    expect(components[0]?.status).toBe("retired");
    expect(components.some((entry) => entry.status === "active")).toBe(false);
    expect(result.components.retired).toEqual(["cogs"]);
  });

  it("still advances the structure version when no component changed", async () => {
    // The save is a real event even when it changed no component: someone
    // confirmed this structure, and that belongs in the history.
    const stored = component({ id: "cogs", version: 1, recordedAt: OLD });
    const expectedRevision = givenStored([stored]);

    const result = await store.saveCostStructure(
      saveInput({ structure: structure({ components: [{ ...stored }] }), expectedRevision }),
    );

    expect(result.stored.version).toBe(3);
    expect(result.components.changed).toEqual([]);
    expect(result.stored.structure.components[0]?.recordedAt).toBe(OLD);
  });

  it("refuses a structure carrying one component id twice", async () => {
    const expectedRevision = givenStored([component({ id: "cogs" })]);

    await expect(
      store.saveCostStructure(
        saveInput({
          structure: structure({
            components: [component({ id: "cogs" }), component({ id: "cogs", version: 2 })],
          }),
          expectedRevision,
        }),
      ),
    ).rejects.toMatchObject({ name: "DuplicateCostComponentIdError" });

    expect(calls.some((call) => call.text.includes("commerce-cost-structure-write"))).toBe(false);
  });

  it("starts every component at version 1 on a first save", async () => {
    const result = await store.saveCostStructure(
      saveInput({
        structure: structure({
          components: [
            component({ id: "cogs", version: 44 }),
            component({ id: "shipping", family: "outbound_shipping", version: 9 }),
          ],
        }),
      }),
    );

    expect(result.stored.structure.components.map((entry) => entry.version)).toEqual([1, 1]);
    expect(result.components.added).toEqual(["cogs", "shipping"]);
  });
});
