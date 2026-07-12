import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCreateMetaCreativeBriefRequest } from "@/lib/meta/creative-brief-contract";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const db = await import("@/lib/db");
const store = await import("@/lib/meta/creative-brief-store");

const snapshotId = "018f3f55-630d-7f9f-8c19-bbd7d45db001";
const briefId = "018f3f55-630d-7f9f-8c19-bbd7d45db002";
const now = "2026-07-10T10:00:00.000Z";

function request() {
  return parseCreateMetaCreativeBriefRequest({
    businessId: "00000000-0000-4000-8000-000000000001",
    providerAccountId: "act_1",
    idempotencyKey: "brief-create-1",
    sourceDecision: { snapshotId, trigger: "Fatigued former winner" },
    content: {
      keep: "Keep the product proof",
      change: "Change the hook",
      next: "Produce three variants",
    },
  });
}

function sourceRow() {
  return {
    snapshot_id: snapshotId,
    creative_id: "creative_1",
    engine_version: "v3-test",
    snapshot_as_of: "2026-07-10",
    scope_type: "account",
    scope_id: "*",
    published_label: "refresh",
    raw_label: "refresh",
    reason: "Fatigue composite",
    badges: [
      { type: "fatigue_composite", label: "Fatigue", severity: "warning" },
    ],
  };
}

function briefRow(overrides: Record<string, unknown> = {}) {
  return {
    id: briefId,
    business_id: "00000000-0000-4000-8000-000000000001",
    provider_account_id: "act_1",
    contract_version: "meta-creative-brief.v1",
    create_request_hash: "hash_1",
    source_decision_id: "mdd_1234567890abcdef12345678",
    source_snapshot_id: snapshotId,
    source_creative_id: "creative_1",
    source_engine_version: "v3-test",
    source_snapshot_as_of: "2026-07-10",
    source_scope_type: "account",
    source_scope_id: "*",
    source_published_label: "refresh",
    source_raw_label: "refresh",
    source_reason: "Fatigue composite",
    source_badges_json: [
      { type: "fatigue_composite", label: "Fatigue", severity: "warning" },
    ],
    source_trigger: "Fatigued former winner",
    keep_text: "Keep the product proof",
    change_text: "Change the hook",
    next_text: "Produce three variants",
    status: "draft",
    version: 1,
    created_by: "00000000-0000-4000-8000-000000000010",
    updated_by: "00000000-0000-4000-8000-000000000010",
    reviewed_by: null,
    created_at: now,
    updated_at: now,
    reviewed_at: null,
    ...overrides,
  };
}

function mockQuery(responses: unknown[][]) {
  const queries: Array<{ text: string; params: unknown[] | undefined }> = [];
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    queries.push({ text, params });
    return responses.shift() ?? [];
  });
  vi.mocked(db.getDb).mockReturnValue({ query } as never);
  return { query, queries };
}

describe("Meta Creative Brief store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("verifies account-scoped snapshot lineage before inserting", async () => {
    const sql = mockQuery([[], [sourceRow()], [briefRow({ create_request_hash: "ignored" })]]);

    const result = await store.createMetaCreativeBrief({
      request: request(),
      createdBy: "00000000-0000-4000-8000-000000000010",
    });

    expect(result.created).toBe(true);
    expect(result.brief.sourceDecision).toMatchObject({
      snapshotId,
      creativeId: "creative_1",
      publishedLabel: "refresh",
      rawLabel: "refresh",
      trigger: "Fatigued former winner",
    });
    expect(sql.queries[1]?.text).toContain("provider_account_id = $2");
    expect(sql.queries[1]?.text).toContain("engine_v3_decision_snapshots_daily");
    expect(sql.queries[2]?.text).toContain(
      "ON CONFLICT (business_id, provider_account_id, idempotency_key) DO NOTHING",
    );
  });

  it("returns an identical idempotent replay without re-reading the source", async () => {
    const firstRequest = request();
    const hash = (
      await import("@/lib/meta/creative-brief-contract")
    ).buildMetaCreativeBriefCreateRequestHash(firstRequest);
    const sql = mockQuery([[briefRow({ create_request_hash: hash })]]);

    const result = await store.createMetaCreativeBrief({
      request: firstRequest,
      createdBy: "00000000-0000-4000-8000-000000000010",
    });

    expect(result.created).toBe(false);
    expect(sql.query).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of an idempotency key with a different create request", async () => {
    mockQuery([[briefRow({ create_request_hash: "different_hash" })]]);

    await expect(
      store.createMetaCreativeBrief({
        request: request(),
        createdBy: "00000000-0000-4000-8000-000000000010",
      }),
    ).rejects.toBeInstanceOf(store.MetaCreativeBriefIdempotencyConflictError);
  });

  it("rejects snapshots that cannot be proven inside the selected account", async () => {
    mockQuery([[], []]);

    await expect(
      store.createMetaCreativeBrief({
        request: request(),
        createdBy: "00000000-0000-4000-8000-000000000010",
      }),
    ).rejects.toBeInstanceOf(store.MetaCreativeBriefSourceNotFoundError);
  });

  it("scopes list reads by business and provider account", async () => {
    const sql = mockQuery([[briefRow()]]);

    const rows = await store.listMetaCreativeBriefs({
      businessId: "00000000-0000-4000-8000-000000000001",
      providerAccountId: "act_1",
      status: "draft",
    });

    expect(rows).toHaveLength(1);
    expect(sql.queries[0]?.text).toContain("business_id = $1::uuid");
    expect(sql.queries[0]?.text).toContain("provider_account_id = $2");
    expect(sql.queries[0]?.params?.slice(0, 3)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "act_1",
      "draft",
    ]);
  });

  it("updates only editable fields under the expected version", async () => {
    const sql = mockQuery([[briefRow({ version: 3, keep_text: "Keep this" })]]);

    const brief = await store.patchMetaCreativeBrief({
      businessId: "00000000-0000-4000-8000-000000000001",
      providerAccountId: "act_1",
      id: briefId,
      patch: {
        expectedVersion: 2,
        content: { keep: "Keep this" },
      },
      updatedBy: "00000000-0000-4000-8000-000000000010",
    });

    expect(brief.version).toBe(3);
    const update = sql.queries[0]?.text ?? "";
    const setClause = update.slice(update.indexOf("SET"), update.indexOf("WHERE"));
    expect(setClause).toContain("version = version + 1");
    expect(setClause).toContain("WHEN $14::boolean THEN 'draft'");
    expect(setClause).not.toContain("source_snapshot_id");
    expect(setClause).not.toContain("source_raw_label");
  });

  it("reports the current version after an optimistic concurrency miss", async () => {
    mockQuery([[], [{ version: 5 }]]);

    await expect(
      store.patchMetaCreativeBrief({
        businessId: "00000000-0000-4000-8000-000000000001",
        providerAccountId: "act_1",
        id: briefId,
        patch: { expectedVersion: 4, content: {}, status: "reviewed" },
        updatedBy: "00000000-0000-4000-8000-000000000010",
      }),
    ).rejects.toMatchObject({
      name: "MetaCreativeBriefVersionConflictError",
      expectedVersion: 4,
      currentVersion: 5,
    });
  });

  it("distinguishes an absent scoped brief from a version conflict", async () => {
    mockQuery([[], []]);

    await expect(
      store.patchMetaCreativeBrief({
        businessId: "00000000-0000-4000-8000-000000000001",
        providerAccountId: "act_1",
        id: briefId,
        patch: { expectedVersion: 1, content: {}, status: "draft" },
        updatedBy: "00000000-0000-4000-8000-000000000010",
      }),
    ).rejects.toBeInstanceOf(store.MetaCreativeBriefNotFoundError);
  });
});
