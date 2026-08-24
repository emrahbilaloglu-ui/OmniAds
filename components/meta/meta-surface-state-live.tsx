"use client";

/**
 * The §9 region for a surface that reads its data in the browser.
 *
 * Three of the six mounted Meta surfaces fetch their own payload — Decisions,
 * Launchpad and Creative Studio — so the page that rendered them can only state
 * what it knew before the fetch. That is a real and useful half (scope,
 * authority, capability), and on its own it leaves a "Loading" banner above a
 * fully rendered screen, which is its own untruth.
 *
 * This closes the gap without giving the client an opinion. The body publishes
 * the envelope the SERVER put in its payload, verbatim; this subscribes and
 * renders whichever of the two `laterMetaSurfaceState` selects. Nothing here
 * inspects a row count, a length, or an error — the two things it can do are
 * forward and display.
 *
 * ## Why a module store rather than context
 *
 * The publisher is a data hook deep inside a legacy body and the subscriber is
 * a sibling of that body's root, rendered by the page. Threading a provider
 * between them would mean editing the shell, the page and the body for a value
 * that is a singleton per surface anyway. The store is keyed by surface id, so
 * two surfaces cannot read each other's state, and it is cleared on unmount so
 * a stale envelope cannot survive a navigation.
 */
import { useEffect, useState } from "react";

import type { MetaResponseEnvelope } from "@/lib/meta/read-state-contract";
import { laterMetaSurfaceState } from "@/lib/meta/surface-read-state";
import { MetaSurfaceState } from "@/components/meta/MetaSurfaceState";

type Envelope = MetaResponseEnvelope<null>;
type Listener = (envelope: Envelope | null) => void;

const published = new Map<string, Envelope | null>();
const refreshingBy = new Map<string, boolean>();
const listeners = new Map<string, Set<Listener>>();

/**
 * Forward the server's envelope for a surface.
 *
 * Called from a body with the value the payload carried. A body that has no
 * `readState` publishes `null`, which leaves the page's envelope showing —
 * silence is not an assertion that everything is fine.
 */
export function publishMetaSurfaceState(surfaceId: string, envelope: Envelope | null): void {
  published.set(surfaceId, envelope ?? null);
  notify(surfaceId);
}

/**
 * Report that a newer read is in flight over rows already on screen.
 *
 * An observation, not a state: only the body knows a request is running, and
 * what that means for the surface is decided by `laterMetaSurfaceState`. A body
 * that decided for itself that stale rows may be shown unlabelled is what §9's
 * fourth state exists to prevent.
 */
export function publishMetaSurfaceRefreshing(surfaceId: string, refreshing: boolean): void {
  refreshingBy.set(surfaceId, refreshing);
  notify(surfaceId);
}

function notify(surfaceId: string): void {
  const envelope = published.get(surfaceId) ?? null;
  for (const listener of listeners.get(surfaceId) ?? []) listener(envelope);
}

function subscribe(surfaceId: string, listener: Listener): () => void {
  const set = listeners.get(surfaceId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(surfaceId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(surfaceId);
      // A surface nobody is watching keeps no envelope: navigating away and
      // back must re-read rather than re-show what was true last time.
      published.delete(surfaceId);
      refreshingBy.delete(surfaceId);
    }
  };
}

export function MetaSurfaceStateLive({
  surfaceId,
  initial,
}: {
  surfaceId: string;
  /** The page's envelope — scope, authority, capability. Never null. */
  initial: Envelope;
}) {
  const [served, setServed] = useState<Envelope | null>(() => published.get(surfaceId) ?? null);
  const [refreshing, setRefreshing] = useState<boolean>(
    () => refreshingBy.get(surfaceId) === true,
  );

  useEffect(
    () =>
      subscribe(surfaceId, (envelope) => {
        setServed(envelope);
        // The refreshing flag lives beside the envelope and changes without it,
        // so it is held in state rather than read during render — a value read
        // from a module map at render time is not something React will re-read.
        setRefreshing(refreshingBy.get(surfaceId) === true);
      }),
    [surfaceId],
  );

  return (
    <MetaSurfaceState
      envelope={laterMetaSurfaceState(initial, served, refreshing)}
      surfaceId={surfaceId}
    />
  );
}
