import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/migrations", () => ({
  runMigrations: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/provider-platform-date", () => ({
  getProviderPlatformDateBoundaries: vi.fn(),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  /*
    ROUND 22, ITEM 1: the bindings view of the same store. `refIds` is what the
    id-only helper returns; `timezones` is what the binding actually holds
    afterwards, which writers now stamp their rows from. Mocked here as the
    identity of what was passed, because these suites are not about the binding
    rule -- lib/provider-account-timezone-authority.db.test.ts proves that
    against a real PostgreSQL.
  */
  ensureProviderAccountReferenceBindings: vi.fn(
    async ({
      accounts,
    }: {
      accounts: Array<{ externalAccountId: string; timezone?: string | null }>;
    }) => ({
      refIds: new Map(
        accounts.map(
          (account) =>
            [account.externalAccountId, `provider-ref-${account.externalAccountId}`] as const,
        ),
      ),
      timezones: new Map(
        accounts
          .filter((account) => (account.timezone ?? "").trim().length > 0)
          .map((account) => [account.externalAccountId, String(account.timezone)] as const),
      ),
    }),
  ),
  ensureProviderAccountReferenceIds: vi.fn(async ({ accounts }: { accounts: Array<{ externalAccountId: string }> }) => {
    return new Map(
      accounts.map((account) => [account.externalAccountId, `${account.externalAccountId}-ref`] as const),
    );
  }),
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `${businessId}-ref`] as const),
    );
  }),
}));

const migrations = await import("@/lib/migrations");
const db = await import("@/lib/db");
const platformDate = await import("@/lib/provider-platform-date");
const rollover = await import("@/lib/sync/provider-day-rollover");

describe("provider day rollover state", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(migrations.runMigrations).mockResolvedValue(undefined);
  });

  it("detects rollover on first observation and stores provider-account D-1 target", async () => {
    const queries: string[] = [];
    const sql = vi
      .fn(async (strings: TemplateStringsArray) => {
        queries.push(strings.join(" "));
        return [];
      });
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(platformDate.getProviderPlatformDateBoundaries).mockResolvedValue([
      {
        provider: "google",
        businessId: "biz-1",
        providerAccountId: "acct-1",
        timeZone: "America/Los_Angeles",
        currentDate: "2026-04-08",
        previousDate: "2026-04-07",
        isPrimary: true,
      },
    ] as never);

    const result = await rollover.syncProviderDayRolloverState({
      provider: "google_ads",
      businessId: "biz-1",
    });

    expect(result).toEqual([
      expect.objectContaining({
        provider: "google_ads",
        providerAccountId: "acct-1",
        currentD1TargetDate: "2026-04-07",
        rolloverDetected: true,
      }),
    ]);
    expect(queries.join("\n")).toContain("business_ref_id");
    expect(queries.join("\n")).toContain("provider_account_ref_id");
  });

  it("does not flag rollover when the same provider date is observed again", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([
        {
          provider: "meta",
          business_id: "biz-1",
          provider_account_id: "act_1",
          last_observed_current_date: "2026-04-08",
          current_d1_target_date: "2026-04-07",
          rollover_detected_at: "2026-04-08T00:00:01.000Z",
          d1_finalize_started_at: "2026-04-08T00:00:05.000Z",
          d1_finalize_completed_at: null,
          last_recovery_at: null,
          created_at: "2026-04-08T00:00:01.000Z",
          updated_at: "2026-04-08T00:00:05.000Z",
        },
      ])
      .mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(platformDate.getProviderPlatformDateBoundaries).mockResolvedValue([
      {
        provider: "meta",
        businessId: "biz-1",
        providerAccountId: "act_1",
        timeZone: "America/Anchorage",
        currentDate: "2026-04-08",
        previousDate: "2026-04-07",
        isPrimary: true,
      },
    ] as never);

    const result = await rollover.syncProviderDayRolloverState({
      provider: "meta",
      businessId: "biz-1",
    });

    expect(result).toEqual([
      expect.objectContaining({
        provider: "meta",
        providerAccountId: "act_1",
        currentD1TargetDate: "2026-04-07",
        rolloverDetected: false,
        d1FinalizeStartedAt: "2026-04-08T00:00:05.000Z",
      }),
    ]);
  });
});
