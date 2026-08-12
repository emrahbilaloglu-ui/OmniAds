"use client";

/**
 * Public share media.
 *
 * Video here is watched by someone outside the workspace, often on a phone,
 * sometimes with sound off, sometimes with a flaky connection. So it carries
 * native controls (keyboard operable by default), a captions track when one was
 * served, an explicit error state, and a retry that actually re-attempts the
 * load rather than only re-rendering the message.
 */
import { useCallback, useRef, useState } from "react";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export interface ShareMediaSource {
  kind: "image" | "video";
  url: string;
  /** Served captions track. Absent means none was served — never faked. */
  captionsUrl?: string | null;
  captionsLabel?: string | null;
  alt: string;
}

export function ShareMedia({ source }: { source: ShareMediaSource | null }) {
  const copy = useCopy();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((value) => value + 1);
    // Re-attempt the load itself; re-rendering the message alone would look
    // like a retry without being one.
    videoRef.current?.load();
  }, []);

  if (!source) {
    return (
      <p data-share-media="missing" style={{ margin: 0, fontSize: 13, color: "var(--ledger-ink-tertiary)" }}>
        {copy.noMediaInShare}
      </p>
    );
  }

  if (failed) {
    return (
      <div data-share-media="error" style={{ display: "grid", gap: 8, justifyItems: "start" }}>
        <p style={{ margin: 0, fontSize: 13 }}>{copy.mediaCouldNotLoad}</p>
        <button
          type="button"
          data-share-media-retry=""
          data-ctl="live:media-retry"
          onClick={retry}
          style={{
            minHeight: 44,
            padding: "10px 14px",
            borderRadius: "var(--ledger-radius-button)",
            border: "1px solid var(--ledger-border-control)",
            background: "var(--ledger-bg-surface)",
            color: "var(--ledger-ink-primary)",
            cursor: "pointer",
          }}
        >
          {copy.tryAgain}
        </button>
      </div>
    );
  }

  if (source.kind === "video") {
    return (
      <video
        key={attempt}
        ref={videoRef}
        data-share-media="video"
        // The video element *is* the play control here: native controls are
        // keyboard operable, expose play/pause state to assistive technology
        // and handle captions. A custom button set would have to reimplement
        // all of that and would eventually get it wrong.
        data-ctl="live:media-play"
        controls
        preload="metadata"
        playsInline
        onError={() => setFailed(true)}
        style={{ width: "100%", maxWidth: "100%", height: "auto", borderRadius: "var(--ledger-radius-card)" }}
      >
        <source src={source.url} />
        {source.captionsUrl ? (
          <track
            kind="captions"
            src={source.captionsUrl}
            label={source.captionsLabel ?? "Captions"}
            data-share-captions=""
            default
          />
        ) : null}
        {source.alt}
      </video>
    );
  }

  return (
    <img
      key={attempt}
      src={source.url}
      alt={source.alt}
      data-share-media="image"
      onError={() => setFailed(true)}
      style={{ width: "100%", maxWidth: "100%", height: "auto", borderRadius: "var(--ledger-radius-card)" }}
    />
  );
}
