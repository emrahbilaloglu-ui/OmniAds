/**
 * The container's job is scope, and getting scope wrong is silent.
 *
 * `canonicalDecisionReadModel` does not throw when the account is missing — it
 * returns a successful, *empty* presentation coded `provider_account_required`.
 * So the two functions that decide which account and which days get read are
 * the difference between "this account has nothing to act on" and "no account
 * was ever read". Both failures render as a calm, empty queue unless these hold.
 */
import { describe, expect, it } from "vitest";

import {
  readDecisionWindow,
  resolveDecisionAccount,
} from "@/components/meta/decision-center/DecisionCenterView";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";

function account(id: string): MetaHistoryAccount {
  return { id, name: `Account ${id}`, currency: "USD", timezone: "UTC" };
}

describe("which account the Decision Center reads", () => {
  it("selects the only assigned account without being asked", () => {
    expect(resolveDecisionAccount([account("act_1")], null)?.id).toBe("act_1");
  });

  it("honours an explicit account when it is assigned to this business", () => {
    const accounts = [account("act_1"), account("act_2")];
    expect(resolveDecisionAccount(accounts, "act_2")?.id).toBe("act_2");
  });

  /**
   * A URL naming an account this business does not own must not be forwarded.
   * Resolving to null withholds the read; returning the first account instead
   * would show one advertiser's spend under another's name.
   */
  it("refuses an account that is not assigned, rather than falling back to another", () => {
    const accounts = [account("act_1"), account("act_2")];
    expect(resolveDecisionAccount(accounts, "act_999")).toBeNull();
  });

  it("does not guess when several accounts are assigned and none is named", () => {
    expect(resolveDecisionAccount([account("act_1"), account("act_2")], null)).toBeNull();
  });

  it("resolves nothing when no account is assigned", () => {
    expect(resolveDecisionAccount([], "act_1")).toBeNull();
  });
});

describe("which days the Decision Center scopes metrics to", () => {
  const params = (entries: Record<string, string>) => new URLSearchParams(entries);

  it("defaults to 28 days when the URL says nothing", () => {
    expect(readDecisionWindow(params({}))).toMatchObject({ key: "28d", label: "Last 28 days" });
  });

  it("carries a supported window through to the API", () => {
    expect(readDecisionWindow(params({ window: "7d" }))).toMatchObject({
      key: "7d",
      label: "Last 7 days",
    });
  });

  /**
   * An unrecognised window is not passed on. The API would answer for some
   * other range, and the header would still read whatever the URL claimed.
   */
  it("falls back instead of forwarding an unsupported window", () => {
    expect(readDecisionWindow(params({ window: "all-time" })).key).toBe("28d");
  });

  it("accepts a custom range only when both bounds are real dates", () => {
    expect(
      readDecisionWindow(params({ window: "custom", startDate: "2026-08-01", endDate: "2026-08-14" })),
    ).toMatchObject({ key: "custom", startDate: "2026-08-01", endDate: "2026-08-14" });
  });

  it("falls back when a custom range is missing or malformed bounds", () => {
    expect(readDecisionWindow(params({ window: "custom" })).key).toBe("28d");
    expect(readDecisionWindow(params({ window: "custom", startDate: "yesterday", endDate: "today" })).key).toBe(
      "28d",
    );
  });
});
