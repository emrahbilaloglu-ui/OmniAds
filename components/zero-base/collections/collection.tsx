"use client";

/**
 * Collection wrapper: state, disclosure, and paging.
 *
 * The disclosure line is the reason this exists. A capped list that just shows
 * 50 rows reads as "there are 50 things"; the user then makes a decision on a
 * silently truncated set. So whenever the server truncated, the X-of-Y line is
 * rendered — and when the total is unknown, it says so rather than implying
 * the served count is the total.
 */
import type { ReactNode } from "react";

import { Button } from "@/components/zero-base/primitives/button";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import {
  truncationDisclosure,
  type CollectionEnvelope,
  type SurfaceState,
} from "@/lib/zero-base/state-types";

export interface CollectionProps<T> {
  envelope: CollectionEnvelope<T>;
  state: SurfaceState;
  children: ReactNode;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  onRetry?: () => void;
}

export function Collection<T>({
  envelope,
  state,
  children,
  onLoadMore,
  loadingMore,
  onRetry,
}: CollectionProps<T>) {
  const disclosure = envelope.disclosure ?? truncationDisclosure(envelope);
  const atEnd = envelope.nextCursor === null;

  return (
    <div>
      <SurfaceStateBoundary state={state} onRetry={onRetry}>
        {children}

        {/* Count is stated even when nothing was truncated, so the number on
            screen is never left for the reader to infer. */}
        <p
          data-collection-count=""
          style={{ fontSize: 12, lineHeight: "16px", marginTop: 12, color: "var(--ledger-ink-tertiary)" }}
        >
          {disclosure ??
            (envelope.totalCount === null
              ? `Showing ${envelope.servedCount}.`
              : `Showing ${envelope.servedCount} of ${envelope.totalCount}.`)}
          {envelope.cap !== null && envelope.truncated ? ` Capped at ${envelope.cap}.` : ""}
        </p>

        {onLoadMore ? (
          <Button
            variant="secondary"
            primaryTarget
            state={
              loadingMore
                ? { kind: "busy", label: "Loading…" }
                : atEnd
                  ? {
                      kind: "disabled",
                      reason:
                        envelope.totalCount === null
                          ? "All served rows are shown."
                          : `All ${envelope.totalCount} are shown.`,
                    }
                  : { kind: "enabled" }
            }
            onClick={onLoadMore}
            style={{ marginTop: 8 }}
          >
            Load more
          </Button>
        ) : null}

        {/* Announced so a screen-reader user learns the new count after paging
            without having to hunt for it. */}
        <span
          role="status"
          aria-live="polite"
          style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}
        >
          {envelope.servedCount} shown
        </span>
      </SurfaceStateBoundary>
    </div>
  );
}
