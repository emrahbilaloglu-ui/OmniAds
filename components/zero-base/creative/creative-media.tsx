"use client";

/**
 * Creative media with an honest missing state.
 *
 * A blank frame reads as a loading bug and invites a reload that will never
 * help. When no preview was captured the surface says so, in words, at the size
 * the image would have been — so the row's shape does not change and the reason
 * travels with it.
 */
import type { MediaState } from "@/lib/zero-base/creative/performance-adapter";

const BOX = 44;

export function CreativeMedia({ state, label }: { state: MediaState; label: string }) {
  if (state.kind === "missing") {
    return (
      <span
        data-creative-media="missing"
        title={state.reason}
        style={{
          width: BOX,
          height: BOX,
          flex: `0 0 ${BOX}px`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--ledger-radius-control)",
          border: "1px dashed var(--ledger-border-control)",
          fontSize: 9,
          lineHeight: "11px",
          textAlign: "center",
          color: "var(--ledger-ink-tertiary)",
          padding: 2,
        }}
      >
        No preview
      </span>
    );
  }
  return (
    <img
      src={state.url}
      alt={`Preview of ${label}`}
      data-creative-media="ready"
      data-media-origin={state.origin}
      width={BOX}
      height={BOX}
      loading="lazy"
      style={{
        width: BOX,
        height: BOX,
        flex: `0 0 ${BOX}px`,
        objectFit: "cover",
        borderRadius: "var(--ledger-radius-control)",
        border: "1px solid var(--ledger-border-control)",
      }}
    />
  );
}
