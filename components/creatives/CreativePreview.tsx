"use client";

import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { cn } from "@/lib/utils";

type CreativePreviewProps = {
  id?: string;
  name: string;
  cachedUrl?: string | null;
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
  previewUrl?: string | null;
  sourcePriority?: Array<string | null | undefined>;
  assetState?: "ready" | "pending" | "missing";
  format?: "image" | "video" | "catalog";
  isCatalog?: boolean;
  badgeLabel?: string | null;
  pendingLabel?: string;
  className?: string;
  size?: "card" | "thumb";
};

const SIZE_MAP: Record<NonNullable<CreativePreviewProps["size"]>, string> = {
  card: "aspect-square w-full rounded-lg",
  thumb: "h-full w-full rounded",
};

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

function dedupeSources(sources: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const source of sources) {
    const normalized = normalizeUrl(source);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    resolved.push(normalized);
  }

  return resolved;
}

export function CreativePreview({
  id,
  name,
  cachedUrl,
  thumbnailUrl,
  imageUrl,
  previewUrl,
  sourcePriority,
  assetState,
  format = "image",
  isCatalog = false,
  badgeLabel,
  pendingLabel,
  className,
  size = "card",
}: CreativePreviewProps) {
  const usingProvidedPriority = Boolean(sourcePriority);
  const sources = dedupeSources(
    usingProvidedPriority
      ? sourcePriority ?? []
      : [
          imageUrl,
          previewUrl,
          cachedUrl,
          thumbnailUrl,
        ]
  );
  const primarySource = sources[0] ?? null;

  const resolvedBadgeLabel =
    badgeLabel === undefined
      ? isCatalog
        ? "Catalog"
        : format === "video"
        ? "Video"
        : "Feed"
      : badgeLabel;
  const resolvedAssetState =
    assetState ?? (sources.length > 0 ? "ready" : "missing");

  return (
    <div className="relative overflow-hidden bg-muted">
      <CreativeRenderSurface
        id={id}
        name={name}
        preview={{
          render_mode: format === "video" ? "video" : "image",
          image_url: usingProvidedPriority
            ? primarySource
            : imageUrl ?? previewUrl ?? cachedUrl ?? thumbnailUrl ?? null,
          video_url: null,
          poster_url: usingProvidedPriority
            ? primarySource
            : previewUrl ?? cachedUrl ?? thumbnailUrl ?? null,
          source: usingProvidedPriority
            ? primarySource
              ? "image_url"
              : null
            : imageUrl
            ? "image_url"
            : previewUrl
            ? "preview_url"
            : thumbnailUrl
            ? "thumbnail_url"
            : null,
          is_catalog: isCatalog,
        }}
        size={size === "thumb" ? "thumb" : "card"}
        mode="asset"
        assetState={resolvedAssetState}
        assetFallbacks={sources}
        assetUpgradeSources={sources}
        pendingLabel={pendingLabel ?? (size === "card" && resolvedAssetState === "pending" ? "Waiting for Meta" : undefined)}
        className={cn(SIZE_MAP[size], className)}
      />
      {resolvedBadgeLabel ? (
        <span className="absolute bottom-1.5 left-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
          {resolvedBadgeLabel}
        </span>
      ) : null}
    </div>
  );
}
