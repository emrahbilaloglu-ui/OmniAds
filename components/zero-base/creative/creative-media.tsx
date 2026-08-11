"use client";

/**
 * Creative media with an honest missing state.
 *
 * A blank frame reads as a loading bug and invites a reload that will never
 * help. When no preview was captured the surface says so, in words, at the size
 * the image would have been — so the row's shape does not change and the reason
 * travels with it.
 *
 * Four states, because the design's media board draws four and they are not
 * interchangeable: a still preview, a video that plays, an asset that *failed*
 * and can be retried, and one that was never captured. Collapsing "failed" into
 * "missing" is the specific mistake to avoid — a failure is worth retrying and
 * an absence is not, and offering retry on an asset that does not exist sends
 * the user round a loop that cannot succeed.
 */
import { useCallback, useId, useRef, useState } from "react";

import type { MediaState } from "@/lib/zero-base/creative/performance-adapter";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

const BOX = 44;

const frameStyle: React.CSSProperties = {
  width: BOX,
  height: BOX,
  flex: `0 0 ${BOX}px`,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "var(--ledger-radius-control)",
  fontSize: 12,
  lineHeight: "16px",
  textAlign: "center",
  padding: 2,
};

export function CreativeMedia({
  state,
  label,
  onRetry,
}: {
  state: MediaState;
  label: string;
  /** Absent when the caller cannot re-request; no retry control is drawn. */
  onRetry?: () => void;
}) {
  const copy = useCopy();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const statusId = useId();

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    setPlaying((current) => {
      const next = !current;
      // jsdom and older engines have no playback; the announced state must
      // still be correct, so it is tracked here rather than read back.
      if (video) {
        if (next) void video.play?.();
        else video.pause?.();
      }
      return next;
    });
  }, []);

  if (state.kind === "missing") {
    return (
      <span
        data-creative-media="missing"
        title={state.reason}
        style={{
          ...frameStyle,
          border: "1px dashed var(--ledger-border-control)",
          color: "var(--ledger-ink-tertiary)",
        }}
      >
        {copy.noPreview}
      </span>
    );
  }

  if (state.kind === "failed") {
    return (
      <span
        data-creative-media="failed"
        style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
      >
        {/* Poster stays, so the row keeps its shape and the alt text still
            describes what the asset was. */}
        <span
          role="img"
          aria-label={state.alt}
          style={{
            ...frameStyle,
            border: "1px solid var(--ledger-semantic-danger)",
            color: "var(--ledger-semantic-danger)",
          }}
        >
          !
        </span>
        <span style={{ minWidth: 0 }}>
          {/* Verbatim, not a paraphrase: the operator needs the actual error to
              tell a transient stream failure from a revoked asset. */}
          <span
            data-media-error=""
            style={{ display: "block", fontSize: 12, lineHeight: "16px", color: "var(--ledger-semantic-danger)" }}
          >
            {state.reason}
          </span>
          {onRetry ? (
            <button
              type="button"
              data-ctl="live:media-retry"
              onClick={onRetry}
              aria-label={`Retry loading ${label}`}
              style={{
                marginTop: 2,
                minHeight: 24,
                background: "none",
                border: "1px solid var(--ledger-border-control)",
                borderRadius: "var(--ledger-radius-control)",
                color: "var(--ledger-ink-secondary)",
                cursor: "pointer",
                fontSize: 12,
                padding: "2px 8px",
              }}
            >
              {copy.retry}
            </button>
          ) : null}
        </span>
      </span>
    );
  }

  if (state.kind === "video") {
    return (
      <span
        data-creative-media="video"
        style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
      >
        <video
          ref={videoRef}
          poster={state.poster}
          data-media-origin={state.origin}
          aria-label={`Video preview of ${label}`}
          width={BOX}
          height={BOX}
          style={{ ...frameStyle, objectFit: "cover", border: "1px solid var(--ledger-border-control)" }}
        >
          <source src={state.url} />
          {/* Captions are part of the contract, not an enhancement. */}
          {state.captionsUrl ? (
            <track kind="captions" src={state.captionsUrl} srcLang="en" label={copy.englishCaptions} default />
          ) : null}
        </video>
        <button
          type="button"
          data-ctl="live:media-play"
          onClick={togglePlay}
          aria-pressed={playing}
          aria-describedby={statusId}
          aria-label={playing ? `Pause ${label}` : `Play ${label}`}
          style={{
            minWidth: 24,
            minHeight: 24,
            background: "none",
            border: "1px solid var(--ledger-border-control)",
            borderRadius: "var(--ledger-radius-control)",
            color: "var(--ledger-ink-secondary)",
            cursor: "pointer",
            fontSize: 12,
            padding: "2px 8px",
          }}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <span id={statusId} role="status" aria-live="polite" style={{ fontSize: 12 }}>
          {playing ? copy.playing : copy.paused}
        </span>
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

/**
 * A multi-card creative, with its position stated rather than implied.
 *
 * "Card 2 of 5" is text, not a highlighted dot: a dot that is merely a
 * different colour tells a screen-reader user nothing, and tells a
 * colour-blind user very little. The dots are ≥24px because they are the
 * navigation.
 */
export function CreativeCarousel({
  cards,
  label,
}: {
  cards: ReadonlyArray<{ id: string; media: MediaState }>;
  label: string;
}) {
  const copy = useCopy();
  const [index, setIndex] = useState(0);
  const positionId = useId();
  const current = cards[index];
  const position = (n: number) =>
    copy.cardPosition.replace("{index}", String(n)).replace("{total}", String(cards.length));

  if (cards.length === 0) return null;

  return (
    <div data-creative-carousel="" aria-roledescription="carousel" aria-label={label}>
      <CreativeMedia state={current.media} label={`${label} — card ${index + 1}`} />
      <p id={positionId} role="status" aria-live="polite" style={{ margin: "4px 0 0", fontSize: 12 }}>
        {position(index + 1)}
      </p>
      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
        {cards.map((card, cardIndex) => (
          <button
            key={card.id}
            type="button"
            data-ctl="live:CREATIVE-02 carousel-dot"
            aria-current={cardIndex === index ? "true" : undefined}
            aria-label={position(cardIndex + 1)}
            aria-describedby={positionId}
            onClick={() => setIndex(cardIndex)}
            style={{
              width: 24,
              height: 24,
              borderRadius: "50%",
              border: "1px solid var(--ledger-border-control)",
              background:
                cardIndex === index ? "var(--ledger-accent-primary)" : "var(--ledger-bg-surface)",
              cursor: "pointer",
            }}
          />
        ))}
      </div>
    </div>
  );
}
