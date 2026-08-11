"use client";

/**
 * Server-seeded rollout state.
 *
 * The rollout config stays server-owned — it is read in `app/layout.tsx` and
 * handed down as inert data. It is deliberately NOT exposed through a
 * `NEXT_PUBLIC_*` variable: those are readable and forgeable by the client, and
 * the plan is explicit that they are never a boundary. Passing the resolved
 * value down keeps the single reader on the server while still letting client
 * compositions like the login form choose their presentation.
 *
 * Presentation is all this decides. Nothing gated here grants access; the
 * authorizer refuses a direct call regardless of what the shell drew.
 */
import { createContext, useContext, type ReactNode } from "react";

export interface ZeroBaseUiState {
  /** True when canonical chrome should be drawn for this request. */
  canonical: boolean;
}

const RolloutContext = createContext<ZeroBaseUiState>({ canonical: false });

export function ZeroBaseRolloutProvider({
  value,
  children,
}: {
  value: ZeroBaseUiState;
  children: ReactNode;
}) {
  return <RolloutContext.Provider value={value}>{children}</RolloutContext.Provider>;
}

/** Defaults to legacy: an unwrapped tree renders exactly as it did before. */
export function useZeroBaseUi(): ZeroBaseUiState {
  return useContext(RolloutContext);
}
