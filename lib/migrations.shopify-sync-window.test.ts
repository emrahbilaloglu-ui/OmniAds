/**
 * The shopify_sync_state retained-window migration must FAIL LOUDLY.
 *
 * Its two `ADD COLUMN IF NOT EXISTS` statements and their backfill each carried
 * a `.catch(() => {})`, under an outer `.catch(() => {})` on the group. So a
 * lock timeout or a permissions error during deployment let `runMigrations`
 * report success while the columns were absent — and the application code that
 * ships alongside them selects and writes those columns unconditionally
 * (`lib/shopify/sync-state.ts` in its INSERT column list and ON CONFLICT SET,
 * `lib/creative-decision-engine/shopify-aov-source.ts` in its SELECT). The
 * observable result would be every observed-Shopify-AOV read degrading to
 * unavailable — the rung this release adds to the spend-unit ladder — and every
 * later sync failing on the upsert.
 *
 * The from-zero gate cannot catch this: there the CREATE TABLE supplies the
 * columns, so the ALTERs are no-ops. Only the UPGRADE path can, which is what
 * this file drives, with the statement made to fail on purpose.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/startup-diagnostics", () => ({
  logStartupError: vi.fn(),
  logStartupEvent: vi.fn(),
}));

vi.mock("@/lib/migration-verification", () => ({
  verifyMigrationSchemaContract: vi.fn(async () => ({ verified: 0 })),
}));

vi.mock("@/lib/meta/automation-claim-schema-verification", () => ({
  assertMetaAutomationClaimSchema: vi.fn(async () => []),
}));

vi.mock("@/lib/meta/budget-schema-verification", () => ({
  assertD088BudgetSchema: vi.fn(async () => ({
    contract: "meta.d088-budget-schema-verification.v1",
    verified: [],
  })),
  D088BudgetSchemaError: class extends Error {},
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  getDbWithTimeout: vi.fn(),
  runDbTransaction: vi.fn(async (operation: () => Promise<unknown>) =>
    operation(),
  ),
  withPinnedDbClient: vi.fn(),
  runPinnedDbTransaction: vi.fn(),
}));

const db = await import("@/lib/db");
const { migrationDbMockModule } = await import(
  "@/lib/__tests__/pinned-migration-client-mock"
);

function makeSql(failWhen: (text: string) => boolean) {
  return Object.assign(
    vi.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join(" ");
      if (failWhen(text)) throw new Error(`lock timeout: ${text.slice(0, 60)}`);
      return [];
    }),
    {
      query: vi.fn(async (query: string) => {
        if (failWhen(query)) throw new Error(`lock timeout: ${query.slice(0, 60)}`);
        return [];
      }),
    },
  );
}

async function runWith(failWhen: (text: string) => boolean) {
  const sql = makeSql(failWhen);
  const pinned = migrationDbMockModule(sql as never);
  vi.mocked(db.getDb).mockReturnValue(sql as never);
  vi.mocked(db.getDbWithTimeout).mockReturnValue(sql as never);
  vi.mocked(db.withPinnedDbClient).mockImplementation(
    pinned.withPinnedDbClient as never,
  );
  vi.mocked(db.runPinnedDbTransaction).mockImplementation(
    pinned.runPinnedDbTransaction as never,
  );
  const migrations = await import("@/lib/migrations");
  return migrations.runMigrations({
    force: true,
    reason: "shopify-window-proof",
    verifyNativeSchemaCapabilities: false,
  });
}

describe("shopify_sync_state retained-window migration group", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.ENABLE_RUNTIME_MIGRATIONS = "true";
  });

  it("baseline: completes when nothing fails", async () => {
    await expect(runWith(() => false)).resolves.toBeUndefined();
  });

  it("fails the migration when the start-column ALTER fails", async () => {
    await expect(
      runWith((text) =>
        text.includes("ADD COLUMN IF NOT EXISTS latest_successful_sync_window_start"),
      ),
    ).rejects.toThrow(/lock timeout/);
  });

  it("fails the migration when the end-column ALTER fails", async () => {
    await expect(
      runWith((text) =>
        text.includes("ADD COLUMN IF NOT EXISTS latest_successful_sync_window_end"),
      ),
    ).rejects.toThrow(/lock timeout/);
  });

  it("fails the migration when the retained-window backfill fails", async () => {
    await expect(
      runWith((text) =>
        text.includes("SET latest_successful_sync_window_start = latest_sync_window_start"),
      ),
    ).rejects.toThrow(/lock timeout/);
  });
});
