"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type CreativeRenderPayload = {
  render_mode: "video" | "image" | "unavailable";
  image_url: string | null;
  video_url: string | null;
  poster_url: string | null;
  source: string | null;
  is_catalog: boolean;
};

type CreativeRenderSurfaceProps = {
  id?: string;
  name: string;
  preview: CreativeRenderPayload;
  className?: string;
  badgeClassName?: string;
  size?: "thumb" | "card" | "large";
  mode?: "asset" | "full";
  assetState?: "ready" | "pending" | "missing";
  assetFallbacks?: (string | null | undefined)[];
  assetUpgradeSources?: (string | null | undefined)[];
  pendingRevealDelayMs?: number;
  pendingLabel?: string;
  onAssetSettled?: () => void;
};

type ResolvedAssetSource = {
  src: string;
  source: string;
};

const SIZE_MAP: Record<NonNullable<CreativeRenderSurfaceProps["size"]>, string> = {
  thumb: "h-10 w-10 rounded",
  card: "aspect-square w-full",
  large: "aspect-[4/5] w-full rounded-lg",
};

const LOG_LIMIT = 5;
let assetLogCount = 0;
let fullLogCount = 0;
let thumbnailRenderLogCount = 0;
let thumbnailLoadLogCount = 0;

function normalizeUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) return trimmed;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) return `https://${trimmed}`;

  return null;
}

function isMetaCdnUrl(url: string): boolean {
  try {
    const normalized = normalizeUrl(url);
    if (!normalized || normalized.startsWith("/")) return false;

    const host = new URL(normalized).hostname.toLowerCase();
    return (
      host.endsWith(".fbcdn.net") ||
      host.endsWith(".facebook.com") ||
      host.endsWith(".fbsbx.com") ||
      host.endsWith(".cdninstagram.com")
    );
  } catch {
    return false;
  }
}

function proxyUrl(src: string): string {
  return `/api/media/meta-preview?src=${encodeURIComponent(src)}`;
}

function dedupeSourcesInOrder(candidates: Array<{ src: string | null; source: string }>): ResolvedAssetSource[] {
  const seen = new Set<string>();
  const resolved: ResolvedAssetSource[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeUrl(candidate.src);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    resolved.push({
      src: normalized,
      source: candidate.source,
    });
  }

  return resolved;
}

function resolveAssetSources(
  preview: CreativeRenderPayload,
  assetFallbacks: (string | null | undefined)[] | undefined,
  _size: NonNullable<CreativeRenderSurfaceProps["size"]>
): ResolvedAssetSource[] {
  return dedupeSourcesInOrder([
    ...(assetFallbacks ?? []).map((src, index) => ({ src: src ?? null, source: `fallback_${index}` })),
    { src: preview.image_url, source: "preview.image_url" },
    { src: preview.poster_url, source: "preview.poster_url" },
  ]);
}

function PreviewFallback({ frameClass, name }: { frameClass: string; name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div
      className={cn(
        frameClass,
        "flex flex-col items-center justify-center gap-2 bg-neutral-100 p-2 text-neutral-600"
      )}
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-full border border-neutral-300 bg-white text-xs font-semibold">
        {initials || "NA"}
      </div>
      <div className="line-clamp-2 px-1 text-center text-[10px] font-medium">
        No media preview
      </div>
    </div>
  );
}

function PreviewLoadingPlaceholder({ frameClass }: { frameClass: string }) {
  return (
    <div className={cn(frameClass, "animate-pulse bg-neutral-100")} aria-hidden="true" />
  );
}

function PreviewPendingState({
  frameClass,
  label,
}: {
  frameClass: string;
  label: string;
}) {
  return (
    <div
      className={cn(
        frameClass,
        "flex flex-col items-center justify-center gap-3 bg-neutral-100 p-3 text-neutral-600"
      )}
    >
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-500" aria-hidden="true" />
      <div className="text-center text-[11px] font-medium">{label}</div>
    </div>
  );
}

export const CreativeRenderSurface = memo(function CreativeRenderSurface({
  id,
  name,
  preview,
  className,
  badgeClassName,
  size = "card",
  mode = "full",
  assetState = "ready",
  assetFallbacks,
  assetUpgradeSources,
  pendingRevealDelayMs = 0,
  pendingLabel,
  onAssetSettled,
}: CreativeRenderSurfaceProps) {
  const frameClass = cn("relative overflow-hidden bg-muted/30", SIZE_MAP[size], className);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;

    if (mode === "asset") {
      if (assetLogCount >= LOG_LIMIT) return;
      assetLogCount += 1;
      const sources = resolveAssetSources(preview, assetFallbacks, size);
      console.log("[creative-render] ASSET mode", {
        id: id ?? null,
        name: name.slice(0, 40),
        render_mode: preview.render_mode,
        size,
        sources_count: sources.length,
        chosen_candidate: sources[0]
          ? {
              src: sources[0].src.slice(0, 80),
              source: sources[0].source,
            }
          : null,
      });
      return;
    }

    if (fullLogCount >= LOG_LIMIT) return;
    fullLogCount += 1;
    console.log("[creative-render] FULL mode", {
      id: id ?? null,
      name,
      render_mode: preview.render_mode,
      has_video: Boolean(preview.video_url),
      has_image: Boolean(preview.image_url || preview.poster_url),
      is_catalog: preview.is_catalog,
    });
  }, [assetFallbacks, id, mode, name, preview, size]);

  if (mode === "asset") {
    return (
      <AssetImage
        id={id}
        name={name}
        preview={preview}
        assetState={assetState}
        assetFallbacks={assetFallbacks}
        assetUpgradeSources={assetUpgradeSources}
        pendingRevealDelayMs={pendingRevealDelayMs}
        pendingLabel={pendingLabel}
        frameClass={frameClass}
        size={size}
        onAssetSettled={onAssetSettled}
      />
    );
  }

  if (preview.render_mode === "video" && preview.video_url) {
    return (
      <div className={frameClass}>
        <video
          src={preview.video_url}
          poster={preview.poster_url ?? undefined}
          controls
          muted
          playsInline
          preload="metadata"
          className="h-full w-full object-cover"
        />
        {badgeClassName ? <div className={badgeClassName} /> : null}
      </div>
    );
  }

  if (preview.render_mode === "image") {
    const src = normalizeUrl(preview.image_url) ?? normalizeUrl(preview.poster_url);
    if (!src) {
      return <PreviewFallback frameClass={frameClass} name={name} />;
    }

    return (
      <AssetFrame
        frameClass={frameClass}
        name={name}
        src={src}
        fallback={<PreviewFallback frameClass={frameClass} name={name} />}
      />
    );
  }

  return <PreviewFallback frameClass={frameClass} name={name} />;
});

function AssetImage({
  id,
  name,
  preview,
  assetState,
  assetFallbacks,
  assetUpgradeSources,
  pendingRevealDelayMs,
  pendingLabel,
  frameClass,
  size,
  onAssetSettled,
}: {
  id?: string;
  name: string;
  preview: CreativeRenderPayload;
  assetState: NonNullable<CreativeRenderSurfaceProps["assetState"]>;
  assetFallbacks?: (string | null | undefined)[];
  assetUpgradeSources?: (string | null | undefined)[];
  pendingRevealDelayMs: number;
  pendingLabel?: string;
  frameClass: string;
  size: NonNullable<CreativeRenderSurfaceProps["size"]>;
  onAssetSettled?: () => void;
}) {
  const sources = useMemo(() => resolveAssetSources(preview, assetFallbacks, size), [preview, assetFallbacks, size]);
  const sourceKey = useMemo(() => sources.map((source) => source.src).join("|"), [sources]);
  const upgradeSources = useMemo(
    () =>
      dedupeSourcesInOrder(
        (assetUpgradeSources ?? []).map((src, index) => ({
          src: src ?? null,
          source: `upgrade_${index}`,
        }))
      ),
    [assetUpgradeSources]
  );
  const upgradeKey = useMemo(
    () => upgradeSources.map((source) => source.src).join("|"),
    [upgradeSources]
  );

  const [sourceIndex, setSourceIndex] = useState(0);
  const [useProxy, setUseProxy] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [upgradeIndex, setUpgradeIndex] = useState(0);
  const [displaySource, setDisplaySource] = useState<ResolvedAssetSource | null>(null);
  const [readyToUpgrade, setReadyToUpgrade] = useState(false);
  const [pendingRevealElapsed, setPendingRevealElapsed] = useState(assetState !== "pending" || pendingRevealDelayMs <= 0);
  const hasSettledRef = useRef(false);
  const loadedBaseSrcRef = useRef<string | null>(null);

  useEffect(() => {
    setSourceIndex(0);
    setUseProxy(false);
    setExhausted(false);
    setUpgradeIndex(0);
    setDisplaySource(null);
    setReadyToUpgrade(false);
    setPendingRevealElapsed(assetState !== "pending" || pendingRevealDelayMs <= 0);
    hasSettledRef.current = false;
    loadedBaseSrcRef.current = null;
    if (process.env.NODE_ENV !== "production") {
      console.log("[creative-render][reset]", {
        id: id ?? null,
        name,
        sourceKey,
      });
    }
  }, [assetState, id, name, pendingRevealDelayMs, sourceKey, upgradeKey]);

  const current = exhausted ? null : (sources[sourceIndex] ?? null);
  const currentDirectSrc = current?.src ?? null;
  const currentDisplaySrc =
    current && useProxy && isMetaCdnUrl(current.src) ? proxyUrl(current.src) : current?.src ?? null;

  useEffect(() => {
    if (assetState !== "pending" || pendingRevealDelayMs <= 0 || !currentDisplaySrc) {
      setPendingRevealElapsed(true);
      return;
    }
    setPendingRevealElapsed(false);
    const timeoutId = window.setTimeout(() => {
      setPendingRevealElapsed(true);
    }, pendingRevealDelayMs);
    return () => window.clearTimeout(timeoutId);
  }, [assetState, currentDisplaySrc, pendingRevealDelayMs]);

  useEffect(() => {
    if (hasSettledRef.current) return;
    if (!onAssetSettled) return;
    if (assetState === "ready" && current) return;
    hasSettledRef.current = true;
    onAssetSettled();
  }, [assetState, current, onAssetSettled]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (thumbnailRenderLogCount >= LOG_LIMIT) return;

    thumbnailRenderLogCount += 1;
    console.log("creative thumbnail render", {
      id: id ?? null,
      name,
      size,
      chosenSrc: current?.src ?? null,
      chosenSource: current?.source ?? null,
      sourceIndex,
      useProxy,
      exhausted,
    });
  }, [current, exhausted, id, name, size, sourceIndex, useProxy]);

  useEffect(() => {
    if (!current) {
      setDisplaySource((prev) => (prev === null ? prev : null));
      return;
    }

    if (!displaySource || displaySource.source.startsWith("fallback_")) {
      const nextSrc = currentDisplaySrc ?? current.src;
      const nextSource = current.source;

      setDisplaySource((prev) => {
        if (prev?.src === nextSrc && prev?.source === nextSource) {
          return prev;
        }
        return {
          src: nextSrc,
          source: nextSource,
        };
      });
    }
  }, [
    current?.src,
    current?.source,
    currentDisplaySrc,
    displaySource?.src,
    displaySource?.source,
  ]);

  useEffect(() => {
    if (!readyToUpgrade) return;
    if (!currentDirectSrc) return;
    if (displaySource && !displaySource.source.startsWith("fallback_")) return;

    const candidates = upgradeSources.filter(
      (candidate) =>
        candidate.src !== currentDirectSrc &&
        candidate.src !== loadedBaseSrcRef.current &&
        candidate.src !== displaySource?.src
    );
    const candidate = candidates[upgradeIndex] ?? null;
    if (!candidate) return;

    let cancelled = false;
    let proxyAttempted = false;
    const image = new Image();

    const resolveSrc = (src: string) =>
      !proxyAttempted && isMetaCdnUrl(src) ? src : isMetaCdnUrl(src) ? proxyUrl(src) : src;

    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.onload = () => {
      if (cancelled) return;
      setDisplaySource({
        src: resolveSrc(candidate.src),
        source: candidate.source,
      });
    };
    image.onerror = () => {
      if (cancelled) return;
      if (!proxyAttempted && isMetaCdnUrl(candidate.src)) {
        proxyAttempted = true;
        image.src = proxyUrl(candidate.src);
        return;
      }
      setUpgradeIndex((prev) => prev + 1);
    };
    image.src = candidate.src;

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [currentDirectSrc, displaySource, readyToUpgrade, upgradeIndex, upgradeSources]);

  const imgSrc = displaySource?.src ?? currentDisplaySrc ?? current?.src ?? null;

  const handleError = () => {
    if (!current) return;

    if (displaySource && !displaySource.source.startsWith("fallback_")) {
      setDisplaySource(
        current
          ? {
              src: currentDisplaySrc ?? current.src,
              source: current.source,
            }
          : null
      );
      setUpgradeIndex((prev) => prev + 1);
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      console.warn("[creative-render][handle-error]", {
        id: id ?? null,
        name,
        currentSource: current.source,
        currentSrc: current.src.slice(0, 180),
        sourceIndex,
        sourcesCount: sources.length,
        useProxy,
      });
    }
    if (!useProxy && isMetaCdnUrl(current.src)) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[creative-render][switch-proxy]", {
          id: id ?? null,
          name,
          fromSourceIndex: sourceIndex,
        });
      }
      setUseProxy(true);
      return;
    }

    if (sourceIndex < sources.length - 1) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[creative-render][next-source]", {
          id: id ?? null,
          name,
          fromSourceIndex: sourceIndex,
          toSourceIndex: sourceIndex + 1,
        });
      }
      setSourceIndex((prev) => prev + 1);
      setUseProxy(false);
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      console.warn("[creative-render][exhausted]", {
        id: id ?? null,
        name,
        sourceIndex,
        sourcesCount: sources.length,
      });
    }
    setExhausted(true);
  };

  if (!current || exhausted) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[creative-render][placeholder]", {
        id: id ?? null,
        name,
        reason: !current ? "no-current-source" : "exhausted",
        sourceIndex,
        sourcesCount: sources.length,
        exhausted,
      });
    }
    return <PreviewFallback frameClass={frameClass} name={name} />;
  }

  if (assetState === "pending" && !imgSrc) {
    return <PreviewPendingState frameClass={frameClass} label={pendingLabel ?? "Waiting for Meta"} />;
  }

  if (assetState === "pending" && !pendingRevealElapsed) {
    return <PreviewLoadingPlaceholder frameClass={frameClass} />;
  }

  if (!imgSrc) {
    return <PreviewFallback frameClass={frameClass} name={name} />;
  }

  return (
    <AssetFrame
      frameClass={frameClass}
      name={name}
      src={imgSrc}
      fallback={<PreviewFallback frameClass={frameClass} name={name} />}
      onError={handleError}
      imageKey={`${sourceIndex}_${useProxy}_${current.source}_${displaySource?.source ?? "base"}`}
      onLoadSuccess={() => {
        loadedBaseSrcRef.current = currentDirectSrc;
        setReadyToUpgrade(true);
        if (hasSettledRef.current) return;
        hasSettledRef.current = true;
        onAssetSettled?.();
      }}
    />
  );
}

function AssetFrame({
  frameClass,
  name,
  src,
  fallback,
  onError,
  imageKey,
  onLoadSuccess,
}: {
  frameClass: string;
  name: string;
  src: string;
  fallback: ReactNode;
  onError?: () => void;
  imageKey?: string;
  onLoadSuccess?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  useEffect(() => {
    if (shouldLoad) return;
    const node = frameRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: "240px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [shouldLoad]);

  if (failed) {
    return <>{fallback}</>;
  }

  if (!shouldLoad) {
    return (
      <div ref={frameRef} className={frameClass}>
        <PreviewLoadingPlaceholder frameClass="h-full w-full" />
      </div>
    );
  }

  return (
    <div ref={frameRef} className={frameClass}>
      <img
        key={imageKey ?? src}
        src={src}
        alt={name}
        className="h-full w-full object-cover"
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => {
          onLoadSuccess?.();
          if (process.env.NODE_ENV === "production") return;
          if (thumbnailLoadLogCount >= LOG_LIMIT) return;
          thumbnailLoadLogCount += 1;
          console.log("[creative-render][img-load]", {
            name,
            src: src.slice(0, 180),
          });
        }}
        onError={() => {
          if (process.env.NODE_ENV !== "production" && thumbnailLoadLogCount < LOG_LIMIT) {
            thumbnailLoadLogCount += 1;
            console.warn("[creative-render][img-error]", {
              name,
              src: src.slice(0, 180),
            });
          }
          if (onError) {
            onError();
            return;
          }
          setFailed(true);
        }}
      />
    </div>
  );
}
