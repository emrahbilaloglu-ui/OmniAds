type PreviewLike = {
  render_mode?: string | null;
  video_url?: string | null;
} | null;

export type CreativeFormatShape = "feed" | "portrait" | "square";

export type CreativeFormatSource = {
  format?: string | null;
  creativeVisualFormat?: string | null;
  creative_visual_format?: string | null;
  creativePrimaryType?: string | null;
  creative_primary_type?: string | null;
  creativePrimaryLabel?: string | null;
  creative_primary_label?: string | null;
  creativeSecondaryType?: string | null;
  creative_secondary_type?: string | null;
  creativeSecondaryLabel?: string | null;
  creative_secondary_label?: string | null;
  creativeDeliveryType?: string | null;
  creative_delivery_type?: string | null;
  isCatalog?: boolean | null;
  is_catalog?: boolean | null;
  placements?: number | null;
  preview?: PreviewLike;
};

export type CreativeFormatPresentation = {
  tag: string;
  detailLabel: string;
  shape: CreativeFormatShape;
  icon: string;
  ratio: "4:5" | "9:16" | "1:1";
  isVideo: boolean;
  isCarousel: boolean;
  isCatalog: boolean;
};

function normalized(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : "";
}

function displayText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function titleize(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getCreativeFormatPresentation(
  source: CreativeFormatSource,
): CreativeFormatPresentation {
  const format = normalized(source.format);
  const visualFormat = normalized(
    source.creativeVisualFormat ?? source.creative_visual_format,
  );
  const primaryType = normalized(
    source.creativePrimaryType ?? source.creative_primary_type,
  );
  const secondaryType = normalized(
    source.creativeSecondaryType ?? source.creative_secondary_type,
  );
  const deliveryType = normalized(
    source.creativeDeliveryType ?? source.creative_delivery_type,
  );
  const preview = source.preview;
  const hasPreviewVideo =
    normalized(preview?.render_mode) === "video" ||
    Boolean(displayText(preview?.video_url));
  const isCatalog =
    source.isCatalog === true ||
    source.is_catalog === true ||
    format === "catalog" ||
    primaryType === "catalog" ||
    deliveryType === "catalog";
  const isCarousel =
    visualFormat === "carousel" ||
    primaryType === "carousel" ||
    secondaryType === "carousel" ||
    (typeof source.placements === "number" && source.placements > 1);
  const isVideo =
    visualFormat === "video" ||
    format === "video" ||
    primaryType === "video" ||
    secondaryType === "video" ||
    hasPreviewVideo;
  const isFlexible = primaryType === "flexible" || deliveryType === "flexible";

  const tag = isCarousel
    ? "CAR"
    : isVideo
      ? "VID"
      : isCatalog
        ? "CAT"
        : isFlexible
          ? "FLEX"
          : "IMG";
  const shape: CreativeFormatShape = isCarousel
    ? "square"
    : isVideo
      ? "portrait"
      : "feed";
  const ratio = shape === "portrait" ? "9:16" : shape === "square" ? "1:1" : "4:5";
  const icon = isCarousel ? "▣" : isVideo ? "▶" : "▯";
  const primaryLabel =
    displayText(source.creativePrimaryLabel ?? source.creative_primary_label) ||
    (primaryType && primaryType !== "standard" ? titleize(primaryType) : "");
  const secondaryLabel =
    displayText(source.creativeSecondaryLabel ?? source.creative_secondary_label) ||
    (secondaryType ? titleize(secondaryType) : "");
  const visualLabel = isCarousel
    ? "Carousel"
    : isVideo
      ? "Video"
      : isCatalog
        ? "Catalog"
        : isFlexible
          ? "Flexible"
          : "Image";
  const detailLabel =
    primaryLabel && secondaryLabel
      ? `${primaryLabel} + ${secondaryLabel}`
      : primaryLabel || visualLabel;

  return {
    tag,
    detailLabel,
    shape,
    icon,
    ratio,
    isVideo,
    isCarousel,
    isCatalog,
  };
}
