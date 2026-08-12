"use client";

/**
 * Server-seeded workspace context.
 *
 * The envelope is resolved on the server — it is the only place that can prove
 * membership and provider binding — and handed to the client as inert data.
 * Nothing here fetches or re-derives it, because a client that can recompute
 * its own scope is a client that can widen it.
 */
import { createContext, useContext, type ReactNode } from "react";

import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

const WorkspaceContext = createContext<WorkspaceContextEnvelope | null>(null);

export function WorkspaceContextProvider({
  value,
  children,
}: {
  value: WorkspaceContextEnvelope;
  children: ReactNode;
}) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** Throws outside a provider: a surface without scope must not render. */
export function useWorkspaceContext(): WorkspaceContextEnvelope {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error("useWorkspaceContext used outside a WorkspaceContextProvider");
  }
  return value;
}

/** Null-safe variant for chrome that renders before a scope exists. */
export function useOptionalWorkspaceContext(): WorkspaceContextEnvelope | null {
  return useContext(WorkspaceContext);
}
