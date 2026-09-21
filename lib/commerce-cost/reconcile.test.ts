import { describe, expect, it } from "vitest";

import { component, lineCost, resolve, structure } from "./__tests__/fixtures";
import { DuplicateCostComponentIdError, reconcileCostComponents } from "./reconcile";
import type { CommerceCostComponent } from "@/src/types/commerce-cost";

/**
 * Reconciling a save against what is already stored.
 *
 * The thing under test is restraint: a save must change the transaction time
 * and version of exactly the components it changes, and nothing else. Those two
 * fields decide which record the runtime costs with.
 */

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-09-17T09:00:00.000Z";

function storedComponent(overrides: Partial<CommerceCostComponent> = {}) {
  return component({
    id: "cogs",
    version: 3,
    recordedAt: OLD,
    audit: { createdBy: "user-old", createdAt: OLD, note: "first entry" },
    ...overrides,
  });
}

function reconcile(
  previous: CommerceCostComponent[] | null,
  next: CommerceCostComponent[],
  actorUserId: string | null = "user-new",
) {
  return reconcileCostComponents({ previous, next, recordedAt: NOW, actorUserId });
}

describe("an unchanged component is left alone", () => {
  it("keeps the stored version, recordedAt and audit when nothing changed", () => {
    const stored = storedComponent();
    // The client sends back what GET gave it, with whatever version and clock
    // it happens to carry; none of that is allowed to matter.
    const submitted = { ...stored, version: 99, recordedAt: NOW, audit: undefined };

    const result = reconcile([stored], [submitted]);

    expect(result.components[0]).toEqual(stored);
    expect(result.components[0]?.recordedAt).toBe(OLD);
    expect(result.components[0]?.version).toBe(3);
    expect(result.components[0]?.audit?.createdBy).toBe("user-old");
    expect(result.unchanged).toEqual(["cogs"]);
    expect(result.changed).toEqual([]);
  });

  it("does not re-stamp untouched components when a sibling changes", () => {
    // The defect this exists to prevent: editing shipping moved the transaction
    // time of every other cost with it.
    const cogs = storedComponent({ id: "cogs", version: 3 });
    const shipping = storedComponent({ id: "shipping", version: 1, family: "outbound_shipping" });

    const result = reconcile(
      [cogs, shipping],
      [
        { ...cogs },
        { ...shipping, basis: { kind: "amount_per_unit", amount: 42 } },
      ],
    );

    expect(result.components[0]).toEqual(cogs);
    expect(result.components[0]?.recordedAt).toBe(OLD);
    expect(result.unchanged).toEqual(["cogs"]);
    expect(result.changed).toEqual([{ id: "shipping", fromVersion: 1, toVersion: 2 }]);
    expect(result.components[1]?.recordedAt).toBe(NOW);
  });

  it("saving a structure nobody touched produces the identical component list", () => {
    const stored = [storedComponent({ id: "a" }), storedComponent({ id: "b", version: 7 })];
    const result = reconcile(stored, stored.map((entry) => ({ ...entry })));

    expect(result.components).toEqual(stored);
    expect(result.changed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("ignores server-owned fields when deciding whether anything changed", () => {
    const stored = storedComponent();
    for (const drift of [
      { version: 1 },
      { recordedAt: "1999-01-01T00:00:00.000Z" },
      { audit: { createdBy: "someone-else", createdAt: NOW } },
      { supersededAt: NOW },
    ]) {
      const result = reconcile([stored], [{ ...stored, ...drift }]);
      expect(result.unchanged, JSON.stringify(drift)).toEqual(["cogs"]);
    }
  });
});

describe("a changed component supersedes, at a version the server assigns", () => {
  it("advances by exactly one and stamps the actor", () => {
    const stored = storedComponent({ version: 3 });
    const result = reconcile(
      [stored],
      [{ ...stored, version: 500, basis: { kind: "amount_per_unit", amount: 999 } }],
    );

    expect(result.components[0]?.version).toBe(4);
    expect(result.components[0]?.recordedAt).toBe(NOW);
    expect(result.components[0]?.audit).toMatchObject({
      createdBy: "user-new",
      createdAt: NOW,
    });
    expect(result.changed).toEqual([{ id: "cogs", fromVersion: 3, toVersion: 4 }]);
  });

  it("refuses to let the client choose the version, up or down", () => {
    const stored = storedComponent({ version: 3 });
    for (const claimed of [1, 3, 4, 900]) {
      const result = reconcile(
        [stored],
        [{ ...stored, version: claimed, label: `edit-${claimed}` }],
      );
      expect(result.components[0]?.version, `claimed ${claimed}`).toBe(4);
    }
  });

  it("keeps a note the operator wrote while taking the audit actor from the server", () => {
    const stored = storedComponent();
    const result = reconcile(
      [stored],
      [{ ...stored, label: "new label", audit: { note: "supplier raised prices", createdBy: "forged" } }],
    );

    expect(result.components[0]?.audit).toEqual({
      note: "supplier raised prices",
      createdBy: "user-new",
      createdAt: NOW,
    });
  });

  it("starts a component nobody stored before at version 1", () => {
    const result = reconcile(null, [storedComponent({ version: 42 })]);

    expect(result.components[0]?.version).toBe(1);
    expect(result.components[0]?.recordedAt).toBe(NOW);
    expect(result.added).toEqual(["cogs"]);
    expect(result.changed).toEqual([]);
  });
});

describe("retiring a component actually stops it costing", () => {
  it("replaces the stored record rather than appending beside it", () => {
    const active = storedComponent({ status: "active", version: 3 });
    const result = reconcile(
      [active],
      [{ ...active, status: "retired", supersededAt: "1999-01-01T00:00:00.000Z" }],
    );

    // One record per id. `activeComponents` drops non-active records BEFORE it
    // picks the latest version, so an appended retired v4 next to an active v3
    // would leave v3 as the newest survivor and the cost would keep applying.
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.status).toBe("retired");
    expect(result.components[0]?.version).toBe(4);
    expect(result.components[0]?.supersededAt).toBe(NOW);
    expect(result.retired).toEqual(["cogs"]);
  });

  it("removes the cost from a resolved order, end to end", () => {
    const active = component({
      id: "cogs",
      version: 1,
      status: "active",
      recordedAt: OLD,
      effectiveFrom: OLD,
      basis: { kind: "amount_per_unit", amount: 100 },
    });

    const before = resolve({ structure: structure({ components: [active] }) });
    expect(lineCost(before)).toBe(100);

    const retired = reconcile([active], [{ ...active, status: "retired" }]);
    const after = resolve({ structure: structure({ components: retired.components }) });

    // The retired record replaced the active one, so there is nothing left for
    // the resolver's latest-by-id step to pick — and the cost becomes UNSTATED,
    // not zero. Had the retired record been appended beside the active one, the
    // status filter would have dropped it and left the 100 still costing.
    const entry = after.entries.find((candidate) => candidate.family === "product_purchase");
    expect(entry).toMatchObject({
      family: "product_purchase",
      amount: null,
      state: "unknown",
      reasons: ["no_component_matched"],
    });
    expect(lineCost(after)).toBe(0);
  });

  it("does not report an already-retired component as newly retired", () => {
    const retired = storedComponent({ status: "retired", version: 4 });
    const result = reconcile([retired], [{ ...retired, label: "renamed" }]);

    expect(result.changed).toHaveLength(1);
    expect(result.retired).toEqual([]);
  });

  it("reports a component the operator dropped instead of resurrecting it", () => {
    const cogs = storedComponent({ id: "cogs" });
    const shipping = storedComponent({ id: "shipping", family: "outbound_shipping" });

    const result = reconcile([cogs, shipping], [{ ...cogs }]);

    expect(result.components.map((entry) => entry.id)).toEqual(["cogs"]);
    expect(result.removed).toEqual(["shipping"]);
  });
});

describe("the structure holds one record per id", () => {
  it("refuses a submission carrying the same id twice", () => {
    const stored = storedComponent();
    expect(() =>
      reconcile([stored], [{ ...stored, version: 3 }, { ...stored, version: 4, status: "retired" }]),
    ).toThrow(DuplicateCostComponentIdError);
  });

  it("names the id it refused", () => {
    expect(() => reconcile(null, [component({ id: "fees" }), component({ id: "fees" })])).toThrow(
      /"fees"/,
    );
  });

  it("collapses an inherited multi-version history to its latest record", () => {
    // A structure imported from elsewhere may carry several versions of an id.
    // The one that speaks for it is the highest version.
    const older = storedComponent({ version: 1, label: "old" });
    const newer = storedComponent({ version: 5, label: "current" });

    const result = reconcile([older, newer], [{ ...newer }]);

    expect(result.unchanged).toEqual(["cogs"]);
    expect(result.components).toEqual([newer]);
    expect(result.removed).toEqual([]);
  });

  it("supersedes the highest inherited version, not the first one read", () => {
    const older = storedComponent({ version: 1, label: "old" });
    const newer = storedComponent({ version: 5, label: "current" });

    const result = reconcile([older, newer], [{ ...newer, label: "edited" }]);
    expect(result.components[0]?.version).toBe(6);
  });
});

describe("component order is preserved, because the revision depends on it", () => {
  it("returns components in the order they were submitted", () => {
    const a = storedComponent({ id: "a" });
    const b = storedComponent({ id: "b" });
    const c = storedComponent({ id: "c" });

    const result = reconcile([a, b, c], [{ ...c }, { ...a }, { ...b, label: "edited" }]);
    expect(result.components.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });
});
