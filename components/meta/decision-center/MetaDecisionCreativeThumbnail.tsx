"use client";

import { useEffect, useRef, useState } from "react";

const RECOVERY_CACHE_MS = 5 * 60_000;
const MAX_RECOVERY_REQUESTS = 2;
const recoveryCache = new Map<string, { expiresAt: number; result: Promise<string | null> }>();
const recoveryQueue: Array<() => void> = [];
let activeRecoveryRequests = 0;

function scheduleRecovery(load: () => Promise<string | null>): Promise<string | null> {
  return new Promise((resolve) => {
    const run = () => {
      activeRecoveryRequests += 1;
      void load()
        .then(resolve, () => resolve(null))
        .finally(() => {
          activeRecoveryRequests -= 1;
          recoveryQueue.shift()?.();
        });
    };
    if (activeRecoveryRequests < MAX_RECOVERY_REQUESTS) run();
    else recoveryQueue.push(run);
  });
}

function recoverThumbnail(url: string): Promise<string | null> {
  const cached = recoveryCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const result = scheduleRecovery(async () => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { thumbnailUrl?: unknown };
    return typeof body.thumbnailUrl === "string" && /^https:\/\//.test(body.thumbnailUrl)
      ? body.thumbnailUrl
      : null;
  });
  const entry = { expiresAt: Date.now() + RECOVERY_CACHE_MS, result };
  recoveryCache.set(url, entry);
  // A provider or network failure is retryable soon; a valid signed URL can
  // be shared between duplicate cards for this page session.
  void result.then((fresh) => {
    if (!fresh) entry.expiresAt = Date.now() + 30_000;
  });
  if (recoveryCache.size > 200) recoveryCache.delete(recoveryCache.keys().next().value!);
  return result;
}

/** Recovers only a thumbnail that the browser actually tried and failed to load. */
export function MetaDecisionCreativeThumbnail({
  thumbnailUrl,
  recoveryUrl,
  className,
  mobile = false,
  evidencePreview = false,
}: {
  thumbnailUrl?: string | null;
  recoveryUrl?: string | null;
  className: string;
  mobile?: boolean;
  evidencePreview?: boolean;
}) {
  const [source, setSource] = useState(thumbnailUrl ?? null);
  const attempted = useRef(false);
  const generation = useRef(0);
  const missingSourcePlaceholder = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    generation.current += 1;
    attempted.current = false;
    setSource(thumbnailUrl ?? null);
    return () => { generation.current += 1; };
  }, [thumbnailUrl, recoveryUrl]);

  useEffect(() => {
    // A missing warehouse URL is not proof that Meta has no thumbnail. Only
    // query once the placeholder is near the viewport, so a long decision
    // queue does not turn an empty media field into a bulk provider read.
    if (source || thumbnailUrl || !recoveryUrl || attempted.current) return;
    const placeholder = missingSourcePlaceholder.current;
    if (!placeholder) return;
    let cancelled = false;
    const recover = () => {
      if (attempted.current) return;
      attempted.current = true;
      const currentGeneration = generation.current;
      void recoverThumbnail(recoveryUrl).then((fresh) => {
        if (!cancelled && generation.current === currentGeneration) setSource(fresh);
      });
    };
    if (typeof IntersectionObserver === "undefined") {
      recover();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        recover();
      }
    }, { rootMargin: "200px" });
    observer.observe(placeholder);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [source, thumbnailUrl, recoveryUrl]);

  if (!source) {
    return !thumbnailUrl && recoveryUrl ? (
      <span
        ref={missingSourcePlaceholder}
        className={className}
        data-meta-thumbnail-placeholder
        aria-hidden="true"
      />
    ) : null;
  }
  return (
    <img
      alt=""
      className={className}
      data-creative-evidence-preview={evidencePreview ? "served" : undefined}
      data-mobile-creative-thumbnail={mobile ? "" : undefined}
      loading="lazy"
      src={source}
      onError={() => {
        if (!recoveryUrl || attempted.current) {
          setSource(null);
          return;
        }
        attempted.current = true;
        const currentGeneration = generation.current;
        void recoverThumbnail(recoveryUrl).then((fresh) => {
          if (generation.current !== currentGeneration) return;
          setSource(fresh && fresh !== source ? fresh : null);
        });
      }}
    />
  );
}
