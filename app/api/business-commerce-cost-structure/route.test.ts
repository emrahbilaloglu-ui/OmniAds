import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The HTTP contract.
 *
 * Four things this suite refuses to let regress:
 *  - Cost-source meaning and storage readiness stay separate. A missing
 *    versioned store may serve an honest legacy/empty preview, but never a
 *    saveable one; writes remain unavailable until storage exists.
 *  - A write is refused before the payload is examined, not after.
 *  - The concurrency token is mandatory, and a first save is checked like any
 *    other save.
 *  - A preview is never activatable, however cleanly it validates.
 */

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const STORED_REVISION = "a".repeat(64);

const mocks = vi.hoisted(() => ({
  requireBusinessAccess: vi.fn(),
  getStoredCostStructure: vi.fn(),
  saveCostStructure: vi.fn(),
  buildCostStructurePreview: vi.fn(),
  getBusinessCurrency: vi.fn(),
  rejectIfReviewerReadOnly: vi.fn(),
  rejectIfMetaOperatorDemoWrite: vi.fn(),
  readLaunchpadWriteAuthority: vi.fn(),
}));

vi.mock("@/lib/access", () => ({ requireBusinessAccess: mocks.requireBusinessAccess }));
vi.mock("@/lib/account-store", () => ({ getBusinessCurrency: mocks.getBusinessCurrency }));
vi.mock("@/lib/meta/reviewer-write-guard", () => ({
  rejectIfReviewerReadOnly: mocks.rejectIfReviewerReadOnly,
}));
vi.mock("@/app/api/meta/demo-write-authority", () => ({
  rejectIfMetaOperatorDemoWrite: mocks.rejectIfMetaOperatorDemoWrite,
}));
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: mocks.readLaunchpadWriteAuthority,
}));
vi.mock("@/lib/business-commerce-cost-preview", () => ({
  buildCostStructurePreview: mocks.buildCostStructurePreview,
}));
vi.mock("@/lib/business-commerce-cost-structure", async () => {
  // The error classes and the sentinel are the contract under test, so the real
  // ones are used; only the two database entry points are replaced.
  const actual = await vi.importActual<typeof import("@/lib/business-commerce-cost-structure")>(
    "@/lib/business-commerce-cost-structure",
  );
  return {
    ...actual,
    getStoredCostStructure: mocks.getStoredCostStructure,
    saveCostStructure: mocks.saveCostStructure,
  };
});

const { GET, PUT } = await import("@/app/api/business-commerce-cost-structure/route");
const { component, structure } = await import("@/lib/commerce-cost/__tests__/fixtures");
const storeModule = await import("@/lib/business-commerce-cost-structure");
const ABSENT_REVISION = storeModule.costStructureAbsentRevision(BUSINESS_ID);

function confirmedStructure() {
  return structure({
    businessId: BUSINESS_ID,
    version: 3,
    origin: "operator",
    confirmed: true,
    components: [component({ id: "cogs" })],
  });
}

function storedRecord() {
  return {
    businessId: BUSINESS_ID,
    version: 3,
    revision: STORED_REVISION,
    structure: confirmedStructure(),
    recordedAt: "2026-09-17T09:00:00.000Z",
    updatedByUserId: "user-1",
    createdAt: "2026-09-17T09:00:00.000Z",
    updatedAt: "2026-09-17T09:00:00.000Z",
  };
}

function getRequest(query = `?businessId=${BUSINESS_ID}`) {
  return new NextRequest(`http://localhost/api/business-commerce-cost-structure${query}`);
}

function putRequest(body: unknown) {
  return new NextRequest("http://localhost/api/business-commerce-cost-structure", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  const { businessId: _ignored, version: _v, recordedAt: _r, ...rest } = confirmedStructure();
  return {
    businessId: BUSINESS_ID,
    expectedRevision: STORED_REVISION,
    structure: rest,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireBusinessAccess.mockResolvedValue({
    session: { user: { id: "user-1", email: "operator@adsecute.com" } },
    membership: { businessId: BUSINESS_ID, role: "collaborator" },
  });
  mocks.rejectIfReviewerReadOnly.mockReturnValue(null);
  mocks.rejectIfMetaOperatorDemoWrite.mockResolvedValue(null);
  mocks.readLaunchpadWriteAuthority.mockResolvedValue("live");
  mocks.getBusinessCurrency.mockResolvedValue("TRY");
  mocks.getStoredCostStructure.mockResolvedValue(null);
  mocks.buildCostStructurePreview.mockResolvedValue({
    structure: structure({ businessId: BUSINESS_ID, version: 0, origin: "legacy_import", confirmed: false }),
    source: "legacy_preview",
    unreadableSources: [],
    ambiguousLegacyZeros: ["business_cost_models.shipping_percent"],
  });
  mocks.saveCostStructure.mockResolvedValue({ stored: storedRecord(), previousVersion: 2 });
});

describe("GET", () => {
  it("requires a business scope before reading anything", async () => {
    const response = await GET(getRequest(""));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "missing_business_id" });
    expect(mocks.getStoredCostStructure).not.toHaveBeenCalled();
  });

  it("returns the authorization refusal without touching the store", async () => {
    mocks.requireBusinessAccess.mockResolvedValue({
      error: NextResponse.json({ error: "auth_error" }, { status: 403 }),
    });
    const response = await GET(getRequest());
    expect(response.status).toBe(403);
    expect(mocks.getStoredCostStructure).not.toHaveBeenCalled();
  });

  it("serves a stored structure with its revision", async () => {
    mocks.getStoredCostStructure.mockResolvedValue(storedRecord());

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.source).toBe("stored");
    expect(body.revision).toBe(STORED_REVISION);
    expect(body.version).toBe(3);
    expect(body.structure.components).toHaveLength(1);
    expect(mocks.buildCostStructurePreview).not.toHaveBeenCalled();
  });

  it("serves the legacy preview when nothing is stored, and says so", async () => {
    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.source).toBe("legacy_preview");
    expect(body.version).toBe(0);
    expect(body.structure.confirmed).toBe(false);
    // Never presented as stored: a preview cannot be activated.
    expect(body.activatable).toBe(false);
    expect(body.needsConfirmation).toBe(true);
    expect(body.ambiguousLegacyZeros).toEqual(["business_cost_models.shipping_percent"]);
  });

  it("returns a saveable token for the absent case rather than a null a client must special-case", async () => {
    const response = await GET(getRequest());
    const body = await response.json();

    expect(body.revision).toBe(ABSENT_REVISION);
    expect(body.revision).toBe(storeModule.costStructureAbsentRevision(BUSINESS_ID));
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serves an honest empty draft when there is nothing to preview", async () => {
    mocks.buildCostStructurePreview.mockResolvedValue({
      structure: structure({ businessId: BUSINESS_ID, version: 0, components: [] }),
      source: "empty",
      unreadableSources: [],
      ambiguousLegacyZeros: [],
    });

    const body = await (await GET(getRequest())).json();
    expect(body.source).toBe("empty");
    expect(body.structure.components).toEqual([]);
    expect(body.activatable).toBe(false);
  });

  it("serves a read-only preview when versioned storage has not been migrated", async () => {
    mocks.getStoredCostStructure.mockRejectedValue(
      new storeModule.CostStructureSchemaUnavailableError(["business_commerce_cost_structures"]),
    );

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.source).toBe("legacy_preview");
    expect(body.structure.confirmed).toBe(false);
    expect(body.revision).toBe(ABSENT_REVISION);
    expect(body.activatable).toBe(false);
    expect(body.storage).toEqual({
      ready: false,
      missingTables: ["business_commerce_cost_structures"],
    });
    expect(body.permissions.canEdit).toBe(false);
    expect(body.permissions.reason).toContain("storage");
    expect(mocks.buildCostStructurePreview).toHaveBeenCalledOnce();
  });

  it("marks a stored, confirmed, valid structure activatable", async () => {
    mocks.getStoredCostStructure.mockResolvedValue(storedRecord());
    const body = await (await GET(getRequest())).json();
    expect(body.needsConfirmation).toBe(false);
    expect(body.activatable).toBe(true);
  });

  it("does not mark a stored but unconfirmed structure activatable", async () => {
    mocks.getStoredCostStructure.mockResolvedValue({
      ...storedRecord(),
      structure: { ...confirmedStructure(), confirmed: false },
    });
    const body = await (await GET(getRequest())).json();
    expect(body.activatable).toBe(false);
  });

  it("does not call an empty confirmed structure activatable", async () => {
    const empty = {
      ...storedRecord(),
      structure: { ...storedRecord().structure, confirmed: true, components: [] },
    };
    mocks.getStoredCostStructure.mockResolvedValue(empty);

    const body = await (await GET(getRequest())).json();
    expect(body.activatable).toBe(false);
  });

  it("tells a reviewer it cannot edit without refusing the read", async () => {
    mocks.rejectIfReviewerReadOnly.mockReturnValue(
      NextResponse.json({ ok: false }, { status: 403 }),
    );
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.permissions.canEdit).toBe(false);
    expect(body.permissions.reason).toContain("Reviewer");
  });

  it("tells a demo workspace it cannot edit without refusing the read", async () => {
    mocks.readLaunchpadWriteAuthority.mockResolvedValue("demo");
    const body = await (await GET(getRequest())).json();
    expect(body.permissions.canEdit).toBe(false);
    expect(body.permissions.reason).toContain("Demo");
  });
});

describe("PUT: who may write, decided before the payload is read", () => {
  it("refuses a reviewer without examining the body", async () => {
    mocks.rejectIfReviewerReadOnly.mockReturnValue(
      NextResponse.json({ ok: false, error: { code: "reviewer_read_only" } }, { status: 403 }),
    );

    const response = await PUT(putRequest({ businessId: BUSINESS_ID, structure: "nonsense" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "reviewer_read_only" },
    });
    expect(mocks.saveCostStructure).not.toHaveBeenCalled();
  });

  it("refuses a demo workspace without examining the body", async () => {
    mocks.rejectIfMetaOperatorDemoWrite.mockResolvedValue(
      NextResponse.json({ ok: false, error: { code: "demo_business_read_only" } }, { status: 403 }),
    );

    const response = await PUT(putRequest({ businessId: BUSINESS_ID, structure: "nonsense" }));

    expect(response.status).toBe(403);
    expect(mocks.saveCostStructure).not.toHaveBeenCalled();
  });

  it("refuses when demo status cannot be confirmed", async () => {
    mocks.rejectIfMetaOperatorDemoWrite.mockResolvedValue(
      NextResponse.json({ ok: false, error: { code: "demo_status_unverified" } }, { status: 503 }),
    );

    const response = await PUT(putRequest(validBody()));
    expect(response.status).toBe(503);
    expect(mocks.saveCostStructure).not.toHaveBeenCalled();
  });

  it("requires a business id before authorizing", async () => {
    const response = await PUT(putRequest({ structure: {} }));
    expect(response.status).toBe(400);
    expect(mocks.requireBusinessAccess).not.toHaveBeenCalled();
  });

  it("writes under the server-resolved business and stamps the acting user", async () => {
    await PUT(putRequest(validBody()));

    expect(mocks.saveCostStructure).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, updatedByUserId: "user-1" }),
    );
  });
});

describe("PUT: the concurrency token", () => {
  it("refuses a body with no expectedRevision at all", async () => {
    const body = validBody();
    delete (body as Record<string, unknown>).expectedRevision;

    const response = await PUT(putRequest(body));

    expect(response.status).toBe(422);
    const payload = await response.json();
    expect(payload.error).toBe("invalid_expected_revision");
    // The refusal tells the caller what token to use for a first save.
    expect(payload.absentRevision).toBe(ABSENT_REVISION);
    expect(mocks.saveCostStructure).not.toHaveBeenCalled();
  });

  it("refuses a malformed token", async () => {
    for (const expectedRevision of ["not-a-hash", "A".repeat(64), 7, {}, "abc"]) {
      const response = await PUT(putRequest(validBody({ expectedRevision })));
      expect(response.status, JSON.stringify(expectedRevision)).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: "invalid_expected_revision",
      });
    }
    expect(mocks.saveCostStructure).not.toHaveBeenCalled();
  });

  it("accepts the absent sentinel for a first save", async () => {
    const response = await PUT(putRequest(validBody({ expectedRevision: ABSENT_REVISION })));

    expect(response.status).toBe(200);
    expect(mocks.saveCostStructure).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: ABSENT_REVISION }),
    );
  });

  it("rejects null because absence must be scoped to the business", async () => {
    const response = await PUT(putRequest(validBody({ expectedRevision: null })));

    expect(response.status).toBe(422);
    expect(mocks.saveCostStructure).not.toHaveBeenCalled();
  });

  it("round-trips: the token GET hands out for an empty store is one PUT accepts", async () => {
    const getBody = await (await GET(getRequest())).json();

    const response = await PUT(putRequest(validBody({ expectedRevision: getBody.revision })));

    expect(response.status).toBe(200);
    expect(mocks.saveCostStructure).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: getBody.revision }),
    );
  });

  it("round-trips: the token GET hands out for a stored structure is one PUT accepts", async () => {
    mocks.getStoredCostStructure.mockResolvedValue(storedRecord());
    const getBody = await (await GET(getRequest())).json();

    const response = await PUT(putRequest(validBody({ expectedRevision: getBody.revision })));

    expect(response.status).toBe(200);
    expect(mocks.saveCostStructure).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: STORED_REVISION }),
    );
  });

  it("answers 409 with the current revision when the token is stale", async () => {
    mocks.saveCostStructure.mockRejectedValue(
      new storeModule.CostStructureRevisionConflictError("c".repeat(64), 9),
    );

    const response = await PUT(putRequest(validBody()));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("commerce_cost_structure_changed");
    // The caller gets a token it can retry with.
    expect(body.currentRevision).toBe("c".repeat(64));
    expect(body.currentVersion).toBe(9);
  });

  it("answers 409 with the absent token when a first save lost the race and was undone", async () => {
    mocks.saveCostStructure.mockRejectedValue(
      new storeModule.CostStructureRevisionConflictError(ABSENT_REVISION, 0),
    );

    const body = await (
      await PUT(putRequest(validBody({ expectedRevision: ABSENT_REVISION })))
    ).json();
    expect(body.currentRevision).toBe(ABSENT_REVISION);
  });
});

describe("PUT: malformed payloads", () => {
  it("refuses a body that is not JSON", async () => {
    const request = new NextRequest("http://localhost/api/business-commerce-cost-structure", {
      method: "PUT",
      body: "{ not json",
    });
    const response = await PUT(request);
    expect(response.status).toBe(400);
    expect(mocks.saveCostStructure).not.toHaveBeenCalled();
  });

  it("refuses a structure that is not an object", async () => {
    for (const structureValue of ["text", 42, [], null, true]) {
      const response = await PUT(putRequest(validBody({ structure: structureValue })));
      expect(response.status, JSON.stringify(structureValue)).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_cost_structure" });
    }
    expect(mocks.saveCostStructure).not.toHaveBeenCalled();
  });

  it("refuses an unknown enum with the path that carries it", async () => {
    const body = validBody();
    (body.structure as Record<string, unknown>).origin = "imported";

    const response = await PUT(putRequest(body));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.issues[0]).toMatchObject({
      path: "structure.origin",
      code: "unknown_value",
    });
    expect(mocks.saveCostStructure).not.toHaveBeenCalled();
  });

  it("refuses money that is not a finite number", async () => {
    const body = validBody();
    const [first] = (body.structure as unknown as { components: Record<string, unknown>[] })
      .components;
    first.basis = { kind: "amount_per_unit", amount: "120" };

    const response = await PUT(putRequest(body));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.issues[0]).toMatchObject({ code: "expected_finite_number" });
  });

  it("drops keys it does not know instead of storing them", async () => {
    const body = validBody();
    (body.structure as Record<string, unknown>).injected = { nested: true };

    await PUT(putRequest(body));

    const saved = mocks.saveCostStructure.mock.calls[0]?.[0] as {
      structure: Record<string, unknown>;
    };
    expect("injected" in saved.structure).toBe(false);
  });

  it("retains the explicit Shopify cost meaning and source precedence", async () => {
    const body = validBody();
    const [cogs] = (body.structure as unknown as { components: Record<string, unknown>[] })
      .components;
    cogs.embeds = ["inbound_logistics", "packaging"];
    cogs.refundBehaviour = "product_share_only";
    (body.structure as Record<string, unknown>).sourcePolicy = {
      productCostAuthority: "hybrid",
      shopifyUnitCost: {
        meaning: "custom_composite",
        includedFamilies: ["product_purchase", "inbound_logistics", "packaging"],
        minimumCoveragePercent: 90,
        missingCostPolicy: "manual_fallback",
        fallbackComponentId: "cogs",
        historicalPolicy: "manual_components_before_first_observation",
      },
    };

    await PUT(putRequest(body));

    const saved = mocks.saveCostStructure.mock.calls[0]?.[0] as {
      structure: { sourcePolicy?: unknown };
    };
    expect(saved.structure.sourcePolicy).toEqual({
      productCostAuthority: "hybrid",
      shopifyUnitCost: {
        meaning: "custom_composite",
        includedFamilies: ["product_purchase", "inbound_logistics", "packaging"],
        minimumCoveragePercent: 90,
        missingCostPolicy: "manual_fallback",
        fallbackComponentId: "cogs",
        historicalPolicy: "manual_components_before_first_observation",
      },
    });
  });

  it("takes the businessId from the session, never from the structure", async () => {
    const body = validBody();
    (body.structure as Record<string, unknown>).businessId = "someone-elses-business";

    await PUT(putRequest(body));

    const saved = mocks.saveCostStructure.mock.calls[0]?.[0] as {
      structure: { businessId: string };
    };
    expect(saved.structure.businessId).toBe(BUSINESS_ID);
  });

  it("passes one recordedAt to the store so the structure and its components agree", async () => {
    await PUT(putRequest(validBody()));

    const saved = mocks.saveCostStructure.mock.calls[0]?.[0] as {
      recordedAt: string;
      structure: { recordedAt: string; components: Array<{ recordedAt: string }> };
    };
    expect(saved.structure.recordedAt).toBe(saved.recordedAt);
    for (const entry of saved.structure.components) {
      expect(entry.recordedAt).toBe(saved.recordedAt);
    }
  });

  it("answers unavailable, not empty, when the store cannot be written", async () => {
    mocks.saveCostStructure.mockRejectedValue(
      new storeModule.CostStructureSchemaUnavailableError([
        "business_commerce_cost_structure_history",
      ]),
    );

    const response = await PUT(putRequest(validBody()));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.source).toBe("unavailable");
    expect(body.structure).toBeNull();
  });
});

describe("PUT: a successful save", () => {
  it("returns the stored structure as stored, with its new revision", async () => {
    const response = await PUT(putRequest(validBody()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.source).toBe("stored");
    expect(body.revision).toBe(STORED_REVISION);
    expect(body.version).toBe(3);
    expect(body.previousVersion).toBe(2);
    expect(body.permissions.canEdit).toBe(true);
  });

  it("turns a first save of the legacy preview into an operator structure", async () => {
    // What the operator saves is a preview they have now confirmed; the response
    // is a stored structure, not a preview.
    mocks.saveCostStructure.mockResolvedValue({
      stored: { ...storedRecord(), version: 1 },
      previousVersion: null,
    });

    const body = await (
      await PUT(putRequest(validBody({ expectedRevision: ABSENT_REVISION })))
    ).json();

    expect(body.source).toBe("stored");
    expect(body.version).toBe(1);
    expect(body.previousVersion).toBeNull();
    expect(body.structure.origin).toBe("operator");
  });
});
