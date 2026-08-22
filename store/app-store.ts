import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { BusinessTimezoneSource } from "@/lib/business-timezone-types";

export const APP_STORE_PERSIST_KEY = "omniads-app-store-v2";

export interface Business {
  id: string;
  /**
   * `null` when the workspace record could not be read.
   *
   * A workspace whose name is unknown must not be labelled with its own UUID.
   * Presentation renders the unavailable mark instead, so an operator never
   * reads an identifier as if it were a name.
   */
  name: string | null;
  timezone: string | null;
  timezoneSource?: BusinessTimezoneSource;
  /**
   * The configured account currency, or `null` when the workspace has none.
   *
   * INVARIANTS.md: "Missing currency must not silently become USD, $, TRY, or
   * EUR." This field used to be a plain `string`, which forced every writer to
   * invent a code for a workspace that had never configured one — and the
   * inventor of choice was `"USD"`. Nullable is the only shape that lets a
   * missing currency reach presentation as a missing currency.
   */
  currency: string | null;
  isDemoBusiness?: boolean;
  industry?: string;
  platform?: string;
}

interface AppState {
  businesses: Business[];
  selectedBusinessId: string | null;
  workspaceOwnerId: string | null;
  hasHydrated: boolean;
  authBootstrapStatus: "idle" | "loading" | "ready";
  workspaceResolved: boolean;
  createBusiness: (name: string, currency: string) => string;
  deleteBusiness: (id: string) => string | null;
  setWorkspaceSnapshot: (
    workspaceOwnerId: string,
    businesses: Business[],
    selectedBusinessId: string | null
  ) => void;
  /**
   * Add or update ONE membership without discarding the rest.
   *
   * Distinct from `setWorkspaceSnapshot`, which means "this is the complete
   * authoritative list" and is correct to replace with. A caller that knows
   * only about the business currently being rendered must not use that: doing
   * so wipes every other workspace out of the switcher, and the operator sees
   * their memberships disappear until the next bootstrap re-reads them.
   *
   * A different `workspaceOwnerId` still replaces, because a list belonging to
   * another user is not something to merge into — that would leak one account's
   * workspace names into another's switcher.
   */
  upsertWorkspaceBusiness: (
    workspaceOwnerId: string,
    business: Business,
    selectAsActive?: boolean,
  ) => void;
  selectBusiness: (id: string | null) => void;
  clearWorkspaceState: () => void;
  setHasHydrated: (value: boolean) => void;
  setAuthBootstrapStatus: (value: "idle" | "loading" | "ready") => void;
  setWorkspaceResolved: (value: boolean) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      businesses: [],
      selectedBusinessId: null,
      workspaceOwnerId: null,
      hasHydrated: false,
      authBootstrapStatus: "idle",
      workspaceResolved: false,
      createBusiness: (name, currency) => {
        const id = crypto.randomUUID();
        set((state) => ({
          businesses: [
            ...state.businesses,
            {
              id,
              name: name.trim(),
              timezone: null,
              timezoneSource: null,
              currency,
            },
          ],
          selectedBusinessId: id,
        }));
        return id;
      },
      deleteBusiness: (id) => {
        let nextSelected: string | null = null;
        set((state) => {
          const remaining = state.businesses.filter((business) => business.id !== id);
          if (state.selectedBusinessId === id) {
            nextSelected = remaining[0]?.id ?? null;
          } else {
            nextSelected = state.selectedBusinessId;
          }
          return {
            businesses: remaining,
            selectedBusinessId: nextSelected,
          };
        });
        return nextSelected;
      },
      setWorkspaceSnapshot: (workspaceOwnerId, businesses, selectedBusinessId) =>
        set({
          workspaceOwnerId,
          businesses,
          selectedBusinessId:
            selectedBusinessId && businesses.some((item) => item.id === selectedBusinessId)
              ? selectedBusinessId
              : businesses[0]?.id ?? null,
          workspaceResolved: true,
        }),
      upsertWorkspaceBusiness: (workspaceOwnerId, business, selectAsActive = false) =>
        set((state) => {
          // A list captured under a different user is discarded rather than
          // merged: tenant isolation, not tidiness.
          const sameOwner =
            state.workspaceOwnerId === null ||
            state.workspaceOwnerId === workspaceOwnerId;
          const existing = sameOwner ? state.businesses : [];
          const index = existing.findIndex((item) => item.id === business.id);
          const businesses =
            index === -1
              ? [...existing, business]
              : existing.map((item, at) => (at === index ? business : item));
          return {
            workspaceOwnerId,
            businesses,
            selectedBusinessId: selectAsActive
              ? business.id
              : (state.selectedBusinessId ?? null),
            // Deliberately NOT `workspaceResolved: true`. One business is not
            // proof that the membership list has been read, and claiming it
            // would stop the bootstrap that would actually read it.
          };
        }),
      selectBusiness: (id) =>
        set((state) => ({
          selectedBusinessId: id && state.businesses.some((item) => item.id === id) ? id : null,
        })),
      clearWorkspaceState: () =>
        set({
          businesses: [],
          selectedBusinessId: null,
          workspaceOwnerId: null,
          workspaceResolved: false,
        }),
      setHasHydrated: (value) => set({ hasHydrated: value }),
      setAuthBootstrapStatus: (value) => set({ authBootstrapStatus: value }),
      setWorkspaceResolved: (value) => set({ workspaceResolved: value }),
    }),
    {
      name: APP_STORE_PERSIST_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        businesses: state.businesses,
        selectedBusinessId: state.selectedBusinessId,
        workspaceOwnerId: state.workspaceOwnerId,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
        state?.setWorkspaceResolved(Boolean(state?.businesses.length));
      },
    }
  )
);
