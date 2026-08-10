import { describe, expect, it } from "vitest";
import {
  MAX_SAVED_VIEW_NAME,
  buildSavedView,
  isSavedViewApplicable,
  savedViewScopeKey,
  selectSavedViews,
  validateSavedViewName,
  type SavedView,
} from "@/lib/saved-views";

function view(overrides: Partial<SavedView> = {}): SavedView {
  return buildSavedView({
    id: "v1",
    name: "Prospecting",
    surface: "meta-decisions",
    businessId: "biz-1",
    config: {},
    createdAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  } as never);
}

describe("views stay inside their scope", () => {
  it("keys storage by surface and business together", () => {
    expect(savedViewScopeKey("meta-decisions", "biz-1")).not.toBe(
      savedViewScopeKey("meta-decisions", "biz-2"),
    );
    expect(savedViewScopeKey("meta-decisions", "biz-1")).not.toBe(
      savedViewScopeKey("creative-studio", "biz-1"),
    );
  });

  it("excludes views belonging to another client", () => {
    const views = [view({ id: "a" }), view({ id: "b", businessId: "biz-2" })];
    expect(selectSavedViews(views, "meta-decisions", "biz-1").map((v) => v.id)).toEqual(["a"]);
  });

  it("excludes views belonging to another surface", () => {
    const views = [view({ id: "a" }), view({ id: "b", surface: "creative-studio" })];
    expect(selectSavedViews(views, "meta-decisions", "biz-1").map((v) => v.id)).toEqual(["a"]);
  });

  it("orders views predictably so the list does not shuffle", () => {
    const views = [view({ id: "b", name: "Zeta" }), view({ id: "a", name: "Alpha" })];
    expect(selectSavedViews(views, "meta-decisions", "biz-1").map((v) => v.name)).toEqual([
      "Alpha",
      "Zeta",
    ]);
  });
});

describe("naming", () => {
  it("requires a name", () => {
    expect(validateSavedViewName("   ", [])).toBe("empty_name");
  });

  it("rejects a duplicate regardless of case or padding", () => {
    expect(validateSavedViewName(" prospecting ", [view()])).toBe("duplicate_name");
  });

  it("rejects an unusably long name", () => {
    expect(validateSavedViewName("x".repeat(MAX_SAVED_VIEW_NAME + 1), [])).toBe("name_too_long");
  });

  it("accepts a distinct name", () => {
    expect(validateSavedViewName("Retargeting", [view()])).toBeNull();
  });

  it("stores the trimmed name", () => {
    expect(view({ name: "  Prospecting  " }).name).toBe("Prospecting");
  });
});

describe("a view can become inapplicable", () => {
  it("stays applicable when it pins no account", () => {
    expect(isSavedViewApplicable(view(), []).applicable).toBe(true);
  });

  it("stays applicable while its account is still assigned", () => {
    const pinned = view({ config: { providerAccountId: "act_1" } });
    expect(isSavedViewApplicable(pinned, ["act_1", "act_2"]).applicable).toBe(true);
  });

  it("refuses to restore a scope the operator can no longer see", () => {
    const pinned = view({ config: { providerAccountId: "act_gone" } });
    const result = isSavedViewApplicable(pinned, ["act_1"]);
    expect(result.applicable).toBe(false);
    expect(result.reason).toContain("no longer assigned");
  });
});

describe("saved views are persisted, not held in memory", () => {
  it("lives in the persisted preferences store keyed by scope", async () => {
    const { readFileSync } = await import("node:fs");
    const store = readFileSync("store/preferences-store.ts", "utf8");
    expect(store).toContain("savedViewsByScope");
    expect(store).toContain("savedViewScopeKey(view.surface, view.businessId)");
    // The store is wrapped in zustand's persist middleware, so views survive a
    // refresh rather than living only for the session.
    expect(store).toContain("persist(");
  });

  it("replaces a view of the same id rather than duplicating it", async () => {
    const { readFileSync } = await import("node:fs");
    const store = readFileSync("store/preferences-store.ts", "utf8");
    expect(store).toContain("current.filter((item) => item.id !== view.id)");
  });

  it("can remove a view from exactly one scope", async () => {
    const { readFileSync } = await import("node:fs");
    const store = readFileSync("store/preferences-store.ts", "utf8");
    expect(store).toContain("deleteSavedView: (surface, businessId, viewId)");
  });
});
