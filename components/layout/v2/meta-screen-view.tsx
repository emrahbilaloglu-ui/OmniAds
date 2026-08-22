"use client";

/**
 * One `screen_view` per mounted Meta surface, emitted from the shell.
 *
 * Emitted here rather than inside each body for two reasons.
 *
 * The rule that makes the number mean anything — **once per surface and
 * business, not once per render** — belongs in one place. Five bodies each
 * calling `emitProductInstrumentation` would each own that rule, and the first
 * one to get it wrong would inflate its own count with its own loading states.
 *
 * And the surfaces that most needed it, Account Intelligence and History, do not
 * receive `businessId` as a prop at all. Threading one through two component
 * signatures and their routes purely so they could emit telemetry would make
 * every one of those files harder to read for a reason none of them is about.
 *
 * The surface is resolved from the pathname through the WP2 registry, so this
 * cannot drift from the surfaces that actually exist — and a path the registry
 * does not know emits nothing rather than guessing a name the sink would reject.
 */
import { usePathname } from "next/navigation";

import {
  INSTRUMENTATION_SURFACE_BY_SURFACE_ID,
  useScreenView,
} from "@/components/meta/use-screen-view";
import { useOptionalWorkspaceContext } from "@/components/workspace/workspace-context-provider";
import { metaSurfaceForPathname } from "@/lib/meta/surface-registry";

export function MetaScreenView() {
  const pathname = usePathname() ?? "";
  const workspace = useOptionalWorkspaceContext();
  const surface = metaSurfaceForPathname(pathname);
  const instrumentationSurface = surface
    ? INSTRUMENTATION_SURFACE_BY_SURFACE_ID[surface.surfaceId]
    : undefined;

  useScreenView({
    // A surface the registry does not know, or one with no instrumentation
    // name, falls back to "system" and is held closed by `ready` below — it
    // emits nothing at all rather than attributing a view to the wrong screen.
    surface: instrumentationSurface ?? "system",
    businessId: workspace?.business?.id ?? null,
    ready: Boolean(instrumentationSurface),
  });

  return null;
}
