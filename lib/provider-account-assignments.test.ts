import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sync/global-kill-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/global-kill-switch")>();
  return {
    ...actual,
    // Lanes default to OFF so a host cannot resume writing before an operator
    // says so. These suites are about the code behind the switch, not the
    // switch itself, which has its own tests.
    assertSyncLaneEnabled: vi.fn(() => ({
      lane: "meta_sync" as const,
      enabled: true,
      reason: "enabled" as const,
    })),
  };
});

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  // The selection writer runs identity upsert, binding upsert, deselect and
  // exact readback in one transaction; run it inline here.
  runDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `business-ref-${businessId}`] as const),
    );
  }),
}));

const db = await import("@/lib/db");
const assignments = await import("@/lib/provider-account-assignments");

describe("provider account assignments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes canonical assignment rows and reads back the aggregate", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      // Physical identity validation: the writer refuses to bind an account
      // whose provider_accounts row it cannot resolve, so the fake must answer
      // it truthfully rather than let the writer proceed on an empty result.
      if (query.includes("FROM provider_accounts")) {
        return [
          { id: "pa-1", external_account_id: "acc_1" },
          { id: "pa-2", external_account_id: "acc_2" },
        ];
      }
      // Physical identity audit of the selected bindings. Returning no rows
      // means every binding's ref id resolves to the external account id it
      // claims; the negative case has its own test below.
      if (query.includes("IS DISTINCT FROM bpa.provider_account_id")) {
        return [];
      }
      // Exact in-transaction readback of the selected set, in order. Keyed on
      // the absence of ARRAY_AGG so it cannot shadow the aggregate reader,
      // which selects from the same two tables.
      if (
        query.includes("bpa.is_selected") &&
        !query.includes("ARRAY_AGG") &&
        query.includes("ORDER BY bpa.position")
      ) {
        return [{ account_id: "acc_1" }, { account_id: "acc_2" }];
      }
      if (query.includes("FROM business_provider_accounts")) {
        return [
          {
            id: "assignment-1",
            business_id: "biz_1",
            provider: "google",
            account_ids: ["acc_1", "acc_2"],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const { upsertProviderAccountAssignments } = await import("@/lib/provider-account-assignments");
    const result = await upsertProviderAccountAssignments({
      businessId: "biz_1",
      provider: "google",
      accountIds: ["acc_1", "acc_2"],
    });

    expect(result.id).toBe("assignment-1");
    expect(queries.join("\n")).toContain("INSERT INTO provider_accounts");
    expect(queries.join("\n")).toContain("INSERT INTO business_provider_accounts");
    expect(queries.join("\n")).toContain("business_ref_id");
    // Identity bindings must survive deselection.
    expect(queries.join("\n")).not.toContain("DELETE FROM business_provider_accounts");
    expect(queries.join("\n")).toContain("SET is_selected = FALSE");
    expect(queries.join("\n")).toContain("pg_advisory_xact_lock_shared");
  });

  it("reads aggregated assignments from normalized rows", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("FROM business_provider_accounts")) {
        return [
          {
            id: "assignment-1",
            business_id: "biz_1",
            provider: "meta",
            account_ids: ["acc_1", "acc_2"],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const { getProviderAccountAssignments } = await import("@/lib/provider-account-assignments");
    const row = await getProviderAccountAssignments("biz_1", "meta");

    expect(row).toEqual({
      id: "assignment-1",
      business_id: "biz_1",
      provider: "meta",
      account_ids: ["acc_1", "acc_2"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    expect(queries.join("\n")).toContain("(ARRAY_AGG(bpa.id ORDER BY bpa.position, bpa.id))[1] AS id");
  });

  it("refuses a binding whose ref id resolves to a different account", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM provider_accounts")) {
        return [{ id: "pa-1", external_account_id: "acc_1" }];
      }
      if (query.includes("IS DISTINCT FROM bpa.provider_account_id")) {
        // The binding claims acc_1 but its ref id resolves to acc_other. Every
        // historical reference through this binding would point at the wrong
        // account, and the upsert's ON CONFLICT arbitrates on the ref id alone,
        // so DO UPDATE would leave it in place.
        return [
          { bound_account_id: "acc_1", identity_account_id: "acc_other" },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(db.runDbTransaction).mockImplementation(
      async (fn: () => Promise<unknown>) => fn(),
    );

    await expect(
      assignments.replaceProviderAccountSelection({
        businessId: "biz_1",
        provider: "google",
        accountIds: ["acc_1"],
      }),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
  });
});
