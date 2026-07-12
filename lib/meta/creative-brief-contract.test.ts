import { describe, expect, it } from "vitest";
import {
  buildMetaCreativeBriefCreateRequestHash,
  buildMetaCreativeDecisionId,
  MetaCreativeBriefValidationError,
  parseCreateMetaCreativeBriefRequest,
  parsePatchMetaCreativeBriefRequest,
} from "@/lib/meta/creative-brief-contract";

const sourceSnapshotId = "018f3f55-630d-7f9f-8c19-bbd7d45db001";

function createBody() {
  return {
    businessId: " business_1 ",
    providerAccountId: " act_1 ",
    idempotencyKey: " brief-create-1 ",
    sourceDecision: {
      snapshotId: sourceSnapshotId.toUpperCase(),
      trigger: " Fatigued former winner ",
    },
    content: {
      keep: " Keep the first-frame product proof. ",
      change: " Replace the second hook. ",
      next: " Produce three 9:16 variants. ",
    },
  };
}

describe("Meta Creative Brief contract", () => {
  it("normalizes create input and defaults to draft", () => {
    expect(parseCreateMetaCreativeBriefRequest(createBody())).toEqual({
      businessId: "business_1",
      providerAccountId: "act_1",
      idempotencyKey: "brief-create-1",
      sourceDecision: {
        snapshotId: sourceSnapshotId,
        trigger: "Fatigued former winner",
      },
      content: {
        keep: "Keep the first-frame product proof.",
        change: "Replace the second hook.",
        next: "Produce three 9:16 variants.",
      },
      status: "draft",
    });
  });

  it("rejects non-UUID snapshot references", () => {
    expect(() =>
      parseCreateMetaCreativeBriefRequest({
        ...createBody(),
        sourceDecision: { snapshotId: "snapshot_1", trigger: "Fatigue" },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<MetaCreativeBriefValidationError>>({
        code: "invalid_source_snapshot_id",
      }),
    );
  });

  it("keeps empty draft content explicit instead of fabricating copy", () => {
    const parsed = parseCreateMetaCreativeBriefRequest({
      ...createBody(),
      content: { keep: "", change: "", next: "" },
    });
    expect(parsed.content).toEqual({ keep: "", change: "", next: "" });
  });

  it("rejects attempts to patch immutable source linkage", () => {
    expect(() =>
      parsePatchMetaCreativeBriefRequest({
        expectedVersion: 1,
        sourceDecision: { snapshotId: sourceSnapshotId },
        content: { keep: "Same" },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<MetaCreativeBriefValidationError>>({
        code: "source_decision_immutable",
      }),
    );
  });

  it("requires optimistic concurrency and at least one editable field", () => {
    expect(() =>
      parsePatchMetaCreativeBriefRequest({ expectedVersion: 0, status: "draft" }),
    ).toThrow("expectedVersion must be a positive integer");
    expect(() =>
      parsePatchMetaCreativeBriefRequest({ expectedVersion: 1 }),
    ).toThrow("PATCH must change content or status");
  });

  it("normalizes partial content patches without filling absent fields", () => {
    expect(
      parsePatchMetaCreativeBriefRequest({
        expectedVersion: 4,
        content: { change: " Tighten the opening. " },
      }),
    ).toEqual({
      expectedVersion: 4,
      content: { change: "Tighten the opening." },
      status: undefined,
    });
  });

  it("uses stable account-scoped decision identity", () => {
    const first = buildMetaCreativeDecisionId({
      businessId: "business_1",
      providerAccountId: "act_1",
      creativeId: "creative_1",
      scopeType: "account",
      scopeId: "*",
    });
    const second = buildMetaCreativeDecisionId({
      businessId: "business_1",
      providerAccountId: "act_2",
      creativeId: "creative_1",
      scopeType: "account",
      scopeId: "*",
    });
    expect(first).toMatch(/^mdd_[0-9a-f]{24}$/);
    expect(first).not.toBe(second);
  });

  it("hashes normalized create intent deterministically", () => {
    const parsed = parseCreateMetaCreativeBriefRequest(createBody());
    expect(buildMetaCreativeBriefCreateRequestHash(parsed)).toBe(
      buildMetaCreativeBriefCreateRequestHash(structuredClone(parsed)),
    );
    expect(
      buildMetaCreativeBriefCreateRequestHash({
        ...parsed,
        content: { ...parsed.content, next: "A different deliverable" },
      }),
    ).not.toBe(buildMetaCreativeBriefCreateRequestHash(parsed));
  });
});
