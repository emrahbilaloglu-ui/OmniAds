"use client";

/**
 * Announcements and media, both of which fail the same way when done casually.
 *
 * A live region has to exist in the DOM *before* the text it announces —
 * mounting a region and its message together announces nothing in most screen
 * readers. `LiveRegion` is therefore always rendered and only its content
 * changes.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/zero-base/primitives/button";

export function LiveRegion({
  message,
  assertive,
}: {
  message: string;
  assertive?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic="true"
      data-live-region=""
      style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}
    >
      {message}
    </div>
  );
}

/** Announces once, then clears, so the same message can be announced again. */
export function useAnnouncer(): [string, (message: string) => void] {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const announce = (next: string) => {
    setMessage("");
    if (timer.current) clearTimeout(timer.current);
    // A tick of empty content makes a repeated identical message register.
    timer.current = setTimeout(() => setMessage(next), 16);
  };

  return [message, announce];
}

export type MediaState = "poster" | "playing" | "failed";

/**
 * Creative media. A failure shows the provider's verbatim code and a retry —
 * never a silent black frame, which is indistinguishable from a slow load.
 */
export function MediaPlayer({
  name,
  posterUrl,
  state,
  errorCode,
  onPlay,
  onRetry,
  children,
}: {
  name: string;
  posterUrl?: string;
  state: MediaState;
  errorCode?: string;
  onPlay: () => void;
  onRetry: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        borderRadius: "var(--ledger-radius-card)",
        border: "1px solid var(--ledger-border-subtle)",
        overflow: "hidden",
        background: "var(--ledger-bg-inset)",
      }}
    >
      {state === "failed" ? (
        <div style={{ padding: 12 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--ledger-semantic-danger)" }}>
            Could not load {name}
          </p>
          {errorCode ? (
            <p
              style={{
                margin: "4px 0 0",
                fontFamily: "var(--font-adc-mono), ui-monospace, monospace",
                fontSize: 12,
                lineHeight: "16px",
                color: "var(--ledger-ink-tertiary)",
              }}
            >
              {errorCode}
            </p>
          ) : null}
          <Button variant="secondary" primaryTarget onClick={onRetry} style={{ marginTop: 8 }}>
            Retry
          </Button>
        </div>
      ) : state === "playing" ? (
        children
      ) : (
        <div style={{ position: "relative" }}>
          {posterUrl ? (
            // Plain <img>: the poster is a remote provider CDN URL, not a
            // local asset next/image can optimise.
            <img src={posterUrl} alt="" style={{ display: "block", width: "100%" }} />
          ) : (
            <div style={{ height: 160 }} />
          )}
          <Button
            variant="primary"
            primaryTarget
            onClick={onPlay}
            style={{ position: "absolute", left: 12, bottom: 12 }}
          >
            Play — {name}
          </Button>
        </div>
      )}
    </div>
  );
}
