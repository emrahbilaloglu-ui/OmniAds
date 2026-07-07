"use client";

import type { ReactNode } from "react";
import { Calculator } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIntegrationsStore, type IntegrationProvider } from "@/store/integrations-store";

type SupportedSource =
  | "meta"
  | "google_ads"
  | "tiktok_ads"
  | "pinterest"
  | "shopify"
  | "ga4"
  | "klaviyo"
  | "stripe"
  | "cost_model";

const BRAND_META: Record<
  SupportedSource,
  {
    label: string;
    shortLabel: string;
    className: string;
  }
> = {
  meta: {
    label: "Meta Ads",
    shortLabel: "M",
    className: "bg-[#E7F0FF] text-[#1864FF] ring-[#B5CCFF]",
  },
  google_ads: {
    label: "Google Ads",
    shortLabel: "G",
    className: "bg-[#EDF7ED] text-[#188038] ring-[#C7E7CC]",
  },
  tiktok_ads: {
    label: "TikTok Ads",
    shortLabel: "T",
    className: "bg-[#EEF2FF] text-[#111827] ring-[#D9E0FF]",
  },
  pinterest: {
    label: "Pinterest",
    shortLabel: "P",
    className: "bg-[#FDECEC] text-[#C62828] ring-[#F7C8C8]",
  },
  shopify: {
    label: "Shopify",
    shortLabel: "S",
    className: "bg-[#ECFDF3] text-[#15803D] ring-[#B7F0C8]",
  },
  ga4: {
    label: "Google Analytics 4",
    shortLabel: "GA",
    className: "bg-[#FFF4E5] text-[#D97706] ring-[#FFD7A1]",
  },
  klaviyo: {
    label: "Klaviyo",
    shortLabel: "K",
    className: "bg-[#F2FDE8] text-[#3F6212] ring-[#DAF2B6]",
  },
  stripe: {
    label: "Stripe",
    shortLabel: "S",
    className: "bg-[#EEF2FF] text-[#635BFF] ring-[#D3D8FF]",
  },
  cost_model: {
    label: "Manual cost model",
    shortLabel: "CM",
    className: "bg-neutral-100 text-neutral-700 ring-neutral-200",
  },
};

const AD_PLATFORM_PROVIDER_MAP: Record<IntegrationProvider, SupportedSource | null> = {
  meta: "meta",
  google: "google_ads",
  tiktok: "tiktok_ads",
  pinterest: "pinterest",
  snapchat: null,
  shopify: null,
  search_console: null,
  ga4: null,
  klaviyo: null,
};

const LOGO_ASSET_BY_SOURCE: Partial<Record<SupportedSource, string>> = {
  meta: "/platform-logos/Meta.png",
  google_ads: "/platform-logos/googleAds.svg",
  tiktok_ads: "/platform-logos/tiktok.svg",
  pinterest: "/platform-logos/Pinterest.svg",
  shopify: "/platform-logos/shopify_glyph.svg",
  ga4: "/platform-logos/GA4.svg",
  klaviyo: "/platform-logos/Klaviyo.svg",
};

export function MetricSourceLogos({
  sourceKey,
  sourceLabel,
  businessId,
  maxVisible = 4,
  align = "right",
}: {
  sourceKey?: string | null;
  sourceLabel?: string | null;
  businessId?: string;
  maxVisible?: number;
  align?: "left" | "right";
}) {
  const byBusinessId = useIntegrationsStore((state) => state.byBusinessId);
  const integrations = businessId ? byBusinessId[businessId] : undefined;
  const sources = resolveMetricSources({ sourceKey, sourceLabel, integrations });

  if (sources.length === 0) return null;

  const visible = sources.slice(0, maxVisible);
  const overflow = sources.slice(maxVisible);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5",
        align === "right" ? "justify-end" : "justify-start"
      )}
      aria-label={`Metric sources: ${sources.map((source) => BRAND_META[source].label).join(", ")}`}
    >
      {visible.map((source) => {
        const logoSrc = LOGO_ASSET_BY_SOURCE[source];
        if (logoSrc) {
          return (
            <SourceLogo
              key={source}
              source={source}
              title={BRAND_META[source].label}
              src={logoSrc}
            />
          );
        }
        if (source === "cost_model") {
          return (
            <SourceMonogram key={source} source={source} title={BRAND_META[source].label}>
              <Calculator className="h-3.5 w-3.5" aria-hidden="true" />
            </SourceMonogram>
          );
        }
        return (
          <SourceMonogram key={source} source={source} title={BRAND_META[source].label}>
            {BRAND_META[source].shortLabel}
          </SourceMonogram>
        );
      })}
      {overflow.length > 0 ? (
        <span
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-neutral-200 bg-white px-1.5 text-[10px] font-semibold text-neutral-500"
          title={overflow.map((source) => BRAND_META[source].label).join(", ")}
          aria-label={`Additional sources: ${overflow
            .map((source) => BRAND_META[source].label)
            .join(", ")}`}
        >
          +{overflow.length}
        </span>
      ) : null}
    </div>
  );
}

function SourceLogo({
  source,
  title,
  src,
}: {
  source: SupportedSource;
  title: string;
  src: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] w-[18px] items-center justify-center overflow-hidden rounded-full bg-white ring-1",
        BRAND_META[source].className.split(" ").find((token) => token.startsWith("ring-"))
      )}
      title={title}
      aria-label={title}
    >
      <img
        src={src}
        alt={title}
        className="h-[12px] w-[12px] object-contain"
        loading="lazy"
      />
    </span>
  );
}

function SourceMonogram({
  source,
  title,
  children,
}: {
  source: SupportedSource;
  title: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 ring-1 text-[9px] font-semibold tracking-tight",
        BRAND_META[source].className
      )}
      title={title}
      aria-label={title}
    >
      {children}
    </span>
  );
}

function resolveMetricSources({
  sourceKey,
  sourceLabel,
  integrations,
}: {
  sourceKey?: string | null;
  sourceLabel?: string | null;
  integrations?: Partial<Record<IntegrationProvider, { status?: string }>>;
}) {
  const connectedAdSources = getConnectedAdSources(integrations);
  const adSources: SupportedSource[] =
    connectedAdSources.length > 0 ? connectedAdSources : ["meta", "google_ads"];
  const combined = `${sourceKey ?? ""} ${sourceLabel ?? ""}`.toLowerCase();
  const sources: SupportedSource[] = [];

  const push = (source: SupportedSource | null) => {
    if (!source || sources.includes(source)) return;
    sources.push(source);
  };

  const mappedSourceKey = mapSourceKey(sourceKey, adSources);
  if (mappedSourceKey) {
    if (Array.isArray(mappedSourceKey)) {
      mappedSourceKey.forEach(push);
    } else {
      push(mappedSourceKey);
    }
    return sources;
  }

  if (combined.includes("shopify")) push("shopify");
  if (combined.includes("ga4") || combined.includes("google analytics")) push("ga4");
  if (combined.includes("meta")) push("meta");
  if (combined.includes("google ads") || /\bgoogle\b/.test(combined)) push("google_ads");
  if (combined.includes("tiktok")) push("tiktok_ads");
  if (combined.includes("pinterest")) push("pinterest");
  if (combined.includes("klaviyo")) push("klaviyo");
  if (combined.includes("stripe")) push("stripe");
  if (combined.includes("manual cost model")) push("cost_model");
  if (combined.includes("ad platforms") || combined.includes("ad spend")) {
    adSources.forEach(push);
  }

  return sources;
}

function mapSourceKey(sourceKey: string | null | undefined, adSources: SupportedSource[]) {
  const normalized = sourceKey?.toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "shopify" ||
    normalized === "shopify_ledger" ||
    normalized === "shopify_warehouse" ||
    normalized === "shopify_live_fallback"
  ) {
    return "shopify";
  }
  if (normalized === "ga4" || normalized === "ga4_fallback") return "ga4";
  if (normalized === "meta") return "meta";
  if (normalized === "google" || normalized === "google_ads") return "google_ads";
  if (normalized === "tiktok" || normalized === "tiktok_ads") return "tiktok_ads";
  if (normalized === "pinterest") return "pinterest";
  if (normalized === "klaviyo") return "klaviyo";
  if (normalized === "stripe") return "stripe";
  if (normalized === "manual_cost_model") return "cost_model";
  if (normalized === "ad_platforms") return adSources;
  if (normalized === "unavailable") return [];
  return null;
}

function getConnectedAdSources(
  integrations?: Partial<Record<IntegrationProvider, { status?: string }>>
) {
  if (!integrations) return [] as SupportedSource[];

  return (["meta", "google", "tiktok", "pinterest", "snapchat"] as IntegrationProvider[])
    .filter((provider) => integrations[provider]?.status === "connected")
    .map((provider) => AD_PLATFORM_PROVIDER_MAP[provider])
    .filter((source): source is SupportedSource => Boolean(source));
}
