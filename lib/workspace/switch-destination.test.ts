import { describe, expect, it } from "vitest";

import {
  ACCOUNT_RESET_ANNOUNCEMENT,
  resolveSwitchDestination,
  shouldEvictQueryKeyOnSwitch,
} from "@/lib/workspace/switch-destination";

const NEXT = "biz_next";

function destination(currentPath: string, currentSearch = "") {
  return resolveSwitchDestination({ currentPath, currentSearch, nextBusinessId: NEXT });
}

describe("resolveSwitchDestination", () => {
  it("preserves a collection surface across the switch", () => {
    for (const surface of [
      "/meta/decisions",
      "/creative/inbox",
      "/creative/briefs",
      "/google/overview",
      "/analytics/seo",
      "/reports",
      "/manage/team",
      "/home",
    ]) {
      const result = destination(`/c/biz_prev${surface}`);
      expect(result.path, surface).toBe(`/c/${NEXT}${surface}`);
      expect(result.resetToCollection, surface).toBe(false);
    }
  });

  it("falls back to the collection for every detail route", () => {
    const cases: Array<[string, string]> = [
      ["/c/biz_prev/reports/r_9", `/c/${NEXT}/reports`],
      ["/c/biz_prev/reports/r_9/edit", `/c/${NEXT}/reports`],
      ["/c/biz_prev/reports/r_9/print", `/c/${NEXT}/reports`],
      ["/c/biz_prev/reports/new", `/c/${NEXT}/reports`],
      ["/c/biz_prev/creative/cr_4", `/c/${NEXT}/creative/inbox`],
      [
        "/c/biz_prev/manage/integrations/callback/meta",
        `/c/${NEXT}/manage/integrations`,
      ],
    ];
    for (const [from, to] of cases) {
      const result = destination(from);
      expect(result.path, from).toBe(to);
      expect(result.resetToCollection, from).toBe(true);
    }
  });

  it("does not mistake a creative collection leaf for a creative ID", () => {
    // `/creative/shares` is a leaf; only an unknown segment is a detail route.
    const result = destination("/c/biz_prev/creative/shares");
    expect(result.path).toBe(`/c/${NEXT}/creative/shares`);
    expect(result.resetToCollection).toBe(false);
  });

  it("drops every parameter naming a record in the previous client", () => {
    const result = destination(
      "/c/biz_prev/meta/decisions",
      "?account=act_1&decision=d_2&entity=e_3&creative=cr_4&report=r_5&view=table",
    );
    expect(result.path).toBe(`/c/${NEXT}/meta/decisions?view=table`);
    expect(result.droppedParams.sort()).toEqual([
      "account",
      "creative",
      "decision",
      "entity",
      "report",
    ]);
  });

  it("drops OAuth callback context that cannot transfer", () => {
    const result = destination(
      "/c/biz_prev/manage/integrations",
      "?callback=meta&state=s_1&code=c_1",
    );
    expect(result.path).toBe(`/c/${NEXT}/manage/integrations`);
    expect(result.droppedParams.sort()).toEqual(["callback", "code", "state"]);
  });

  it("announces only the account reset, and only when an account was dropped", () => {
    expect(destination("/c/biz_prev/meta/decisions", "?account=act_1").announcement).toBe(
      ACCOUNT_RESET_ANNOUNCEMENT,
    );
    expect(destination("/c/biz_prev/meta/decisions", "?report=r_5").announcement).toBeNull();
    expect(destination("/c/biz_prev/meta/decisions").announcement).toBeNull();
  });

  it("sends non-client surfaces to the new client's home", () => {
    for (const path of ["/a/desk", "/a/desk/clients", "/ops/status", "/settings", "/"]) {
      expect(destination(path).path, path).toBe(`/c/${NEXT}/home`);
    }
  });

  it("never leaves the previous business ID in the destination", () => {
    const paths = [
      "/c/biz_prev/home",
      "/c/biz_prev/reports/r_9/edit",
      "/c/biz_prev/creative/cr_4",
      "/c/biz_prev/manage/integrations/callback/meta",
    ];
    for (const path of paths) {
      expect(destination(path, "?account=act_1").path, path).not.toContain("biz_prev");
    }
  });
});

describe("shouldEvictQueryKeyOnSwitch", () => {
  it("evicts any cache key scoped to the previous business", () => {
    expect(shouldEvictQueryKeyOnSwitch(["meta", "decisions", "biz_prev"], "biz_prev")).toBe(true);
    expect(shouldEvictQueryKeyOnSwitch(["meta", "decisions", "biz_next"], "biz_prev")).toBe(false);
    expect(shouldEvictQueryKeyOnSwitch([], "biz_prev")).toBe(false);
  });
});
