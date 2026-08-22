import { describe, expect, it } from "vitest";

import { accountSwitchQuery } from "@/lib/dashboard/account-scope-url";

/**
 * WP4 item 7 — switching account must not carry the previous account's state.
 *
 * The failure this prevents is the plan's rollback trigger 3: after switching
 * from account A to account B, the surface shows A's data. A selected row, an
 * open inspector, a cursor or a Launchpad handoff are all facts about A; in B
 * they name nothing, or — on a business that happens to hold both — something
 * that exists and must not be shown.
 */
describe("accountSwitchQuery", () => {
  it("sets the new account", () => {
    expect(accountSwitchQuery("", "act_2").get("providerAccountId")).toBe("act_2");
  });

  it("drops every account-scoped parameter", () => {
    const next = accountSwitchQuery(
      new URLSearchParams({
        providerAccountId: "act_1",
        row: "ad:123",
        creativeId: "cr_9",
        campaignId: "camp_1",
        adsetId: "adset_1",
        entity: "ad",
        cursor: "opaque",
        handoff: "h1.token",
        handoffDraft: "h1",
        launchpadMode: "add_to_existing",
        launchpadStep: "review",
        inspector: "open",
        q: "search",
      }).toString(),
      "act_2",
    );
    expect(next.get("providerAccountId")).toBe("act_2");
    for (const dropped of [
      "row",
      "creativeId",
      "campaignId",
      "adsetId",
      "entity",
      "cursor",
      "handoff",
      "handoffDraft",
      "launchpadMode",
      "launchpadStep",
      "inspector",
      "q",
    ]) {
      expect(next.get(dropped), dropped).toBeNull();
    }
  });

  it("is an allowlist, so a parameter nobody has invented yet is dropped too", () => {
    // The point of the allowlist: a blocklist stays correct only until the next
    // account-scoped parameter is added.
    const next = accountSwitchQuery(
      "somethingInventedLater=abc&anotherOne=def",
      "act_2",
    );
    expect(next.get("somethingInventedLater")).toBeNull();
    expect(next.get("anotherOne")).toBeNull();
    expect([...next.keys()].sort()).toEqual(["providerAccountId"]);
  });

  it("keeps the date window, because days are not accounts", () => {
    const next = accountSwitchQuery(
      "window=28d&startDate=2026-07-01&endDate=2026-07-28&row=ad:1",
      "act_2",
    );
    expect(next.get("window")).toBe("28d");
    expect(next.get("startDate")).toBe("2026-07-01");
    expect(next.get("endDate")).toBe("2026-07-28");
    expect(next.get("row")).toBeNull();
  });

  it("keeps a stated businessId but never introduces one", () => {
    expect(accountSwitchQuery("businessId=biz_1", "act_2").get("businessId")).toBe(
      "biz_1",
    );
    // On routes that state no business, the session cookie is the scope of
    // record; writing one here would re-scope the page as a side effect of
    // choosing an account.
    expect(accountSwitchQuery("", "act_2").get("businessId")).toBeNull();
  });

  it("ignores a blank account rather than writing an empty parameter", () => {
    // `?providerAccountId=` is not "no account" to a reader that only checks
    // for the key's presence.
    expect(accountSwitchQuery("row=ad:1", "   ").get("providerAccountId")).toBeNull();
  });
});
