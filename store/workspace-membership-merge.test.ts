import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "@/store/app-store";

const OWNER = "user_1";
const A = { id: "biz_a", name: "Alpha", currency: "TRY", timezone: "Europe/Istanbul" };
const B = { id: "biz_b", name: "Beta", currency: "USD", timezone: "UTC" };

beforeEach(() => {
  useAppStore.getState().clearWorkspaceState();
});

/**
 * WP4 item 11 — a surface that knows about one business must not erase the rest.
 *
 * `LegacyInteriorBridge` called `setWorkspaceSnapshot` with a one-element array,
 * and that action means "this is the complete list". Mounting any legacy
 * interior page therefore emptied the workspace switcher down to one entry and
 * the operator watched their other workspaces disappear.
 */
describe("workspace membership merge", () => {
  it("keeps memberships the caller did not mention", () => {
    useAppStore.getState().setWorkspaceSnapshot(OWNER, [A, B], A.id);
    useAppStore.getState().upsertWorkspaceBusiness(OWNER, B, true);

    const state = useAppStore.getState();
    expect(state.businesses.map((item) => item.id).sort()).toEqual([A.id, B.id]);
    expect(state.selectedBusinessId).toBe(B.id);
  });

  it("updates an existing membership in place rather than duplicating it", () => {
    useAppStore.getState().setWorkspaceSnapshot(OWNER, [A, B], A.id);
    useAppStore.getState().upsertWorkspaceBusiness(
      OWNER,
      { ...A, name: "Alpha Renamed" },
      false,
    );

    const state = useAppStore.getState();
    expect(state.businesses).toHaveLength(2);
    expect(state.businesses.find((item) => item.id === A.id)?.name).toBe(
      "Alpha Renamed",
    );
    // Not asked to select, so the current selection stands.
    expect(state.selectedBusinessId).toBe(A.id);
  });

  it("adds a business the store had never seen", () => {
    useAppStore.getState().setWorkspaceSnapshot(OWNER, [A], A.id);
    useAppStore.getState().upsertWorkspaceBusiness(OWNER, B, true);
    expect(useAppStore.getState().businesses).toHaveLength(2);
  });

  it("discards another user's list instead of merging into it", () => {
    // Tenant isolation: one account's workspace names must never appear in
    // another account's switcher.
    useAppStore.getState().setWorkspaceSnapshot("user_other", [A, B], A.id);
    useAppStore.getState().upsertWorkspaceBusiness(OWNER, B, true);

    const state = useAppStore.getState();
    expect(state.workspaceOwnerId).toBe(OWNER);
    expect(state.businesses.map((item) => item.id)).toEqual([B.id]);
  });

  it("does not claim the membership list has been resolved", () => {
    // One business is not proof the list was read, and claiming otherwise would
    // stop the bootstrap that would actually read it.
    useAppStore.getState().upsertWorkspaceBusiness(OWNER, A, true);
    expect(useAppStore.getState().workspaceResolved).toBe(false);
  });
});
