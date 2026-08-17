import { beforeEach, describe, expect, it, vi } from "vitest";

const getProviderAccountAssignments = vi.hoisted(() => vi.fn());
const readProviderAccountSnapshot = vi.hoisted(() => vi.fn());

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments,
}));
vi.mock("@/lib/provider-account-snapshots", () => ({
  readProviderAccountSnapshot,
}));

import {
  readProviderScopeCatalog,
  resolveProviderAccountId,
} from "@/lib/zero-base/provider-scope-server";

describe("provider scope server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderAccountAssignments.mockResolvedValue(null);
    readProviderAccountSnapshot.mockResolvedValue(null);
  });

  it("auto-selects the only assigned account", async () => {
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1"] });
    expect(
      await resolveProviderAccountId({ businessId: "b1", provider: "meta" }),
    ).toBe("act_1");
  });

  it("requires an explicit selection for a portfolio", async () => {
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1", "act_2"] });
    expect(
      await resolveProviderAccountId({ businessId: "b1", provider: "meta" }),
    ).toBeNull();
  });

  it("refuses a requested account that is not assigned to this business", async () => {
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1"] });
    expect(
      await resolveProviderAccountId({
        businessId: "b1",
        provider: "meta",
        requestedAccountId: "act_other",
      }),
    ).toBeNull();
  });

  it("reuses the route catalog so identity and selection share one authority snapshot", async () => {
    const catalog = {
      provider: "google" as const,
      accounts: [
        { id: "4931182201", label: "Primary", currency: "USD", timezone: "UTC" },
      ],
    };

    await expect(
      resolveProviderAccountId({
        businessId: "b1",
        provider: "google",
        requestedAccountId: "4931182201",
        catalog,
      }),
    ).resolves.toBe("4931182201");

    expect(getProviderAccountAssignments).not.toHaveBeenCalled();
    expect(readProviderAccountSnapshot).not.toHaveBeenCalled();
  });

  it("uses snapshot names only for assigned ids", async () => {
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1"] });
    readProviderAccountSnapshot.mockResolvedValue({
      accounts: [
        { id: "act_1", name: "Primary", currency: "USD" },
        { id: "act_unassigned", name: "Must not leak" },
      ],
      meta: {},
    });
    expect(await readProviderScopeCatalog("b1", "meta")).toEqual({
      provider: "meta",
      accounts: [
        { id: "act_1", label: "Primary", currency: "USD", timezone: null },
      ],
    });
  });
});
