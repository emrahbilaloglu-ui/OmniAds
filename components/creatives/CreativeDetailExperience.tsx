"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { formatMoney, resolveCreativeCurrency } from "@/components/creatives/money";
import { DateRangePicker } from "@/components/date-range/DateRangePicker";
import {
  formatCreativeDateLabel,
  type CreativeDateRangeValue,
} from "@/components/creatives/CreativesTopSection";
import { fetchMetaCreativeDetailPreview } from "@/app/(dashboard)/platforms/meta/creatives/page-support";
import {
  creativeDateRangeToStandard,
  standardDateRangeToCreative,
} from "@/components/creatives/creatives-top-section-support";
import { CreativeEngineV3EvidenceSection } from "@/components/creatives/CreativeEngineV3EvidenceSection";
import { CreativeAdActionsSection } from "@/components/creatives/CreativeAdActionsSection";
import type { AiCreativeHistoricalWindows as CreativeHistoricalWindows } from "@/lib/meta/creative-scoring";
import { getCreativeDisplayPills } from "@/lib/meta/creative-taxonomy";

interface CreativeDetailExperienceProps {
  businessId: string;
  row: MetaCreativeRow | null;
  allRows: MetaCreativeRow[];
  campaignScopeId?: string | null;
  creativeHistoryById?: Map<string, CreativeHistoricalWindows>;
  open: boolean;
  notes: string;
  dateRange: CreativeDateRangeValue;
  defaultCurrency: string | null;
  onOpenChange: (open: boolean) => void;
  onNotesChange: (value: string) => void;
  onDateRangeChange: (next: CreativeDateRangeValue) => void;
}

const LIVE_PREVIEW_MIN_WIDTH = 420;
const LIVE_PREVIEW_MIN_HEIGHT = 720;
const LIVE_PREVIEW_DEFAULT_WIDTH = 680;
const LIVE_PREVIEW_DEFAULT_HEIGHT = 1200;
const LIVE_PREVIEW_STAGE_MAX_WIDTH = 980;

function buildLivePreviewSrcDoc(html: string | null): string | null {
  if (!html) return null;
  const injectedStyles = `
    <style>
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background: transparent !important;
        width: max-content !important;
        height: max-content !important;
      }
      body {
        display: flex;
        justify-content: center;
        align-items: flex-start;
      }
      body > * {
        flex-shrink: 0;
      }
      * {
        scrollbar-width: none !important;
      }
      *::-webkit-scrollbar {
        width: 0 !important;
        height: 0 !important;
        display: none !important;
      }
      iframe, video, img, canvas, svg {
        max-width: 100% !important;
      }
      [style*="overflow: scroll"],
      [style*="overflow:scroll"],
      [style*="overflow-y: scroll"],
      [style*="overflow-y:scroll"],
      [style*="overflow: auto"],
      [style*="overflow:auto"],
      [style*="overflow-y: auto"],
      [style*="overflow-y:auto"] {
        overflow: visible !important;
        overflow-y: visible !important;
        max-height: none !important;
        height: auto !important;
      }
    </style>
    <script>
      (() => {
        let processed = new WeakSet();

        const forceStyle = (node, property, value) => {
          if (!(node instanceof HTMLElement)) return;
          node.style.setProperty(property, value, "important");
        };

        const expandNode = (node) => {
          if (!(node instanceof HTMLElement)) return;
          processed.add(node);

          forceStyle(node, "scrollbar-width", "none");
          forceStyle(node, "overflow", "visible");
          forceStyle(node, "overflow-y", "visible");
          forceStyle(node, "overflow-x", "visible");
          forceStyle(node, "max-height", "none");
          forceStyle(node, "height", "auto");
          forceStyle(node, "max-width", "none");
          forceStyle(node, "width", "auto");
          if (node.scrollHeight > node.clientHeight + 4) {
            forceStyle(node, "min-height", node.scrollHeight + "px");
          }
          if (node.scrollWidth > node.clientWidth + 4) {
            forceStyle(node, "min-width", node.scrollWidth + "px");
          }
        };

        const normalize = () => {
          const root = document.documentElement;
          const body = document.body;
          if (!root || !body) return;

          forceStyle(root, "overflow", "visible");
          forceStyle(root, "overflow-y", "visible");
          forceStyle(root, "overflow-x", "visible");
          forceStyle(root, "max-height", "none");
          forceStyle(root, "scrollbar-width", "none");
          forceStyle(body, "overflow", "visible");
          forceStyle(body, "overflow-y", "visible");
          forceStyle(body, "overflow-x", "visible");
          forceStyle(body, "max-height", "none");
          forceStyle(body, "scrollbar-width", "none");

          const nodes = body.querySelectorAll("*");
          for (const node of nodes) {
            if (!(node instanceof HTMLElement)) continue;
            const computed = window.getComputedStyle(node);
            const isScrollableY =
              (computed.overflowY === "auto" || computed.overflowY === "scroll" || computed.overflow === "auto" || computed.overflow === "scroll") &&
              node.scrollHeight > node.clientHeight + 4;
            const isScrollableX =
              (computed.overflowX === "auto" || computed.overflowX === "scroll" || computed.overflow === "auto" || computed.overflow === "scroll") &&
              node.scrollWidth > node.clientWidth + 4;

            if (isScrollableY || isScrollableX || processed.has(node)) {
              expandNode(node);
            }
          }
        };

        const run = () => {
          normalize();
          requestAnimationFrame(normalize);
          window.setTimeout(normalize, 60);
          window.setTimeout(normalize, 220);
          window.setTimeout(normalize, 600);
        };

        const observer = new MutationObserver(() => {
          processed = new WeakSet();
          run();
        });

        const intervalId = window.setInterval(() => {
          run();
        }, 800);

        if (document.readyState === "complete") {
          run();
        } else {
          window.addEventListener("load", run, { once: true });
        }

        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["style", "class"],
        });

        window.addEventListener("beforeunload", () => {
          observer.disconnect();
          window.clearInterval(intervalId);
        });
      })();
    </script>
  `;

  if (html.includes("</head>")) {
    return html.replace("</head>", `${injectedStyles}</head>`);
  }

  return `${injectedStyles}${html}`;
}

export function CreativeDetailExperience({
  businessId,
  row,
  campaignScopeId,
  open,
  notes,
  dateRange,
  defaultCurrency,
  onOpenChange,
  onNotesChange,
  onDateRangeChange,
}: CreativeDetailExperienceProps) {
  const livePreviewStageRef = useRef<HTMLDivElement | null>(null);
  const livePreviewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const [livePreviewScale, setLivePreviewScale] = useState(1);
  const [livePreviewContentSize, setLivePreviewContentSize] = useState({
    width: LIVE_PREVIEW_DEFAULT_WIDTH,
    height: LIVE_PREVIEW_DEFAULT_HEIGHT,
  });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onOpenChange, open]);

  const imageUrl = row ? resolveDetailImageUrl(row) : null;
  const canRequestHtml = Boolean(
    row?.creativeId && (row.previewManifest?.live_html_available ?? true)
  );

  const shouldFetchHtmlPreview =
    open &&
    Boolean(businessId) &&
    Boolean(row?.creativeId) &&
    canRequestHtml;

  const detailPreviewQuery = useQuery({
    queryKey: ["creative-detail-preview", businessId, row?.creativeId ?? ""],
    enabled: shouldFetchHtmlPreview,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      if (!row?.creativeId) return null;
      const payload = await fetchMetaCreativeDetailPreview({
        businessId,
        creativeId: row.creativeId,
      });
      const detail = payload.detail_preview;
      return typeof detail?.html === "string" && detail.html.trim().length > 0 ? detail.html : null;
    },
  });

  const currency = resolveCreativeCurrency(row?.currency ?? null, defaultCurrency);
  const detailPreviewHtml = detailPreviewQuery.data ?? null;
  const detailPreviewLoading = detailPreviewQuery.isFetching;
  const canShowHtml = Boolean(detailPreviewHtml);
  const livePreviewSrcDoc = useMemo(
    () => buildLivePreviewSrcDoc(detailPreviewHtml),
    [detailPreviewHtml]
  );
	  const taxonomyPills = row
	      ? getCreativeDisplayPills({
          creative_delivery_type: row.creativeDeliveryType,
          creative_visual_format: row.creativeVisualFormat,
          creative_primary_type: row.creativePrimaryType,
          creative_primary_label: row.creativePrimaryLabel,
          creative_secondary_type: row.creativeSecondaryType,
          creative_secondary_label: row.creativeSecondaryLabel,
          taxonomy_source: row.taxonomySource ?? null,
	        })
	    : { primaryLabel: null, secondaryLabel: null };

  useEffect(() => {
    const node = livePreviewStageRef.current;
    if (!node) return;

    const updateScale = () => {
      const bounds = node.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) {
        setLivePreviewScale(1);
        return;
      }

      const widthScale = bounds.width / livePreviewContentSize.width;
      const heightScale = bounds.height / livePreviewContentSize.height;
      const nextScale = Math.min(widthScale, heightScale, 1);
      setLivePreviewScale(Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 1);
    };

    updateScale();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updateScale());
    observer.observe(node);
    return () => observer.disconnect();
  }, [
    canShowHtml,
    detailPreviewLoading,
    imageUrl,
    livePreviewContentSize.height,
    livePreviewContentSize.width,
    open,
    row?.id,
  ]);

  useEffect(() => {
    if (!canShowHtml) {
      setLivePreviewContentSize({
        width: LIVE_PREVIEW_DEFAULT_WIDTH,
        height: LIVE_PREVIEW_DEFAULT_HEIGHT,
      });
      return;
    }

    const iframe = livePreviewFrameRef.current;
    if (!iframe) return;

    let frameObserver: ResizeObserver | null = null;
    let animationFrameId = 0;

    const updateFromFrame = () => {
      const frameDocument = iframe.contentDocument;
      const html = frameDocument?.documentElement ?? null;
      const body = frameDocument?.body ?? null;
      if (!html || !body) return;

      const nextWidth = Math.max(
        LIVE_PREVIEW_MIN_WIDTH,
        html.scrollWidth,
        body.scrollWidth,
        html.offsetWidth,
        body.offsetWidth
      );
      const nextHeight = Math.max(
        LIVE_PREVIEW_MIN_HEIGHT,
        html.scrollHeight,
        body.scrollHeight,
        html.offsetHeight,
        body.offsetHeight
      );

      html.style.width = `${nextWidth}px`;
      html.style.height = `${nextHeight}px`;
      html.style.overflow = "hidden";
      html.style.overflowY = "hidden";
      body.style.width = `${nextWidth}px`;
      body.style.height = `${nextHeight}px`;
      body.style.overflow = "hidden";
      body.style.overflowY = "hidden";

      setLivePreviewContentSize((current) => {
        if (current.width === nextWidth && current.height === nextHeight) {
          return current;
        }
        return { width: nextWidth, height: nextHeight };
      });
    };

    const scheduleUpdate = () => {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = requestAnimationFrame(updateFromFrame);
    };

    const handleLoad = () => {
      scheduleUpdate();
      const frameDocument = iframe.contentDocument;
      const html = frameDocument?.documentElement ?? null;
      const body = frameDocument?.body ?? null;
      if (typeof ResizeObserver === "undefined" || !html || !body) return;
      frameObserver?.disconnect();
      frameObserver = new ResizeObserver(() => scheduleUpdate());
      frameObserver.observe(html);
      frameObserver.observe(body);
    };

    if (iframe.contentDocument?.readyState === "complete") {
      handleLoad();
    }

    iframe.addEventListener("load", handleLoad);
    return () => {
      iframe.removeEventListener("load", handleLoad);
      frameObserver?.disconnect();
      cancelAnimationFrame(animationFrameId);
    };
  }, [canShowHtml, livePreviewSrcDoc]);

  if (!open || !row) return null;

  return (
    <div className="fixed inset-0 z-[90]">
      <div className="absolute inset-0 bg-neutral-950/55 backdrop-blur-[2px]" onClick={() => onOpenChange(false)} />

      <div className="absolute inset-2 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 shadow-[0_8px_24px_-12px_rgba(16,21,28,0.18)] md:inset-4">
        <header className="flex h-16 items-center justify-between border-b border-neutral-200 bg-white/95 px-4 backdrop-blur md:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-neutral-900">{row.name}</p>
            <p className="truncate text-xs text-neutral-500">{formatCreativeDateLabel(dateRange)}</p>
          </div>

          <div className="flex items-center gap-2">
            <DateRangePicker
              value={creativeDateRangeToStandard(dateRange)}
              onChange={(next) => onDateRangeChange(standardDateRangeToCreative(next))}
              showComparisonTrigger={false}
              rangePresets={["today", "yesterday", "7d", "14d", "30d", "365d", "lastMonth", "custom"]}
              className="shrink-0"
            />

            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-700 hover:bg-neutral-50"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <main
          className="grid h-[calc(100%-64px)] grid-cols-1 lg:grid-cols-[minmax(0,1.7fr)_minmax(340px,460px)]"
        >
          <section className="min-h-0 overflow-hidden px-3 py-3 md:px-4 md:py-4">
            <div className="mx-auto flex h-full w-full max-w-[1320px] flex-col">
              <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-neutral-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {taxonomyPills.primaryLabel ? <Pill value={taxonomyPills.primaryLabel} /> : null}
                    {taxonomyPills.secondaryLabel ? <Pill value={taxonomyPills.secondaryLabel} /> : null}
                    {row.launchDate ? <Pill value={`Launched ${row.launchDate}`} /> : null}
                  </div>
	                </div>

                <div className="min-h-0 flex-1 bg-[radial-gradient(circle_at_top,_#ffffff_0%,_#f5f5f5_72%,_#eeeeee_100%)] px-2 py-2 md:px-3 md:py-3">
                  <div className="flex h-full min-h-[560px] items-center justify-center px-2 py-4 md:min-h-[640px] md:px-4">
                    <div
                      ref={livePreviewStageRef}
                      className="relative flex h-full max-h-full min-h-0 w-full items-center justify-center overflow-hidden"
                      style={{ maxWidth: LIVE_PREVIEW_STAGE_MAX_WIDTH }}
                    >
                    {canShowHtml ? (
                      <div
                        className="shrink-0"
                        style={{
                          width: livePreviewContentSize.width,
                          height: livePreviewContentSize.height,
                          transform: `scale(${livePreviewScale})`,
                          transformOrigin: "center center",
                        }}
                      >
                        <iframe
                          ref={livePreviewFrameRef}
                          title={`${row.name} live preview`}
                          srcDoc={livePreviewSrcDoc ?? undefined}
                          scrolling="no"
                          className="h-full w-full bg-transparent"
                          style={{ border: 0 }}
                          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                        />
                      </div>
	                    ) : canRequestHtml && detailPreviewLoading ? (
	                      <div className="flex flex-col items-center justify-center gap-3 text-neutral-500">
	                        <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600" aria-hidden="true" />
	                        <p className="text-sm font-medium">Attempting live preview...</p>
	                      </div>
	                    ) : imageUrl ? (
	                      <div className="space-y-3">
	                        <div className="relative flex max-h-[78vh] w-full max-w-[860px] items-center justify-center overflow-hidden p-2">
	                          <img src={imageUrl} alt={row.name} className="relative z-[1] block max-h-[74vh] w-auto max-w-full object-contain" />
	                        </div>
	                      </div>
	                    ) : canRequestHtml ? (
	                      <p className="text-sm text-neutral-600">Live preview is unavailable.</p>
	                    ) : (
                      <p className="text-sm text-neutral-600">No renderable preview is available for this creative.</p>
                    )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <aside className="min-h-0 overflow-y-auto border-l border-neutral-200 bg-[#fafafa] p-4 md:p-4">
            <div className="flex flex-col gap-3">

	              <div
	                className="flex flex-col gap-2.5 rounded-xl border border-neutral-200 bg-white p-4"
	                data-testid="creative-detail-performance"
              >
                <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-neutral-500">Performance</p>
                <div
                  className="grid grid-cols-2 overflow-hidden rounded-xl border border-neutral-200"
                  style={{ gap: 1, background: "#e5e5e5" }}
	                >
	                  <PrimaryMetricTile label="Spend" value={formatMoney(row.spend, currency, defaultCurrency)} />
	                  <PrimaryMetricTile label="ROAS" value={`${row.roas.toFixed(2)}x`} />
	                  <PrimaryMetricTile label="Purchases" value={formatInteger(row.purchases)} />
	                  <PrimaryMetricTile label="CTR" value={`${row.ctrAll.toFixed(2)}%`} />
                </div>
                <div className="h-px bg-neutral-100" />
                <div className="grid grid-cols-2 gap-x-3.5 gap-y-1.5 text-[12px] tabular-nums">
                  <SecondaryMetricRow label="Purchase value" value={formatMoney(row.purchaseValue, currency, defaultCurrency)} />
                  <SecondaryMetricRow label="CPA" value={formatMoney(row.cpa, currency, defaultCurrency)} />
                  <SecondaryMetricRow label="Impressions" value={formatInteger(row.impressions)} />
	                  <SecondaryMetricRow label="Link clicks" value={formatInteger(row.linkClicks)} />
	                </div>
	              </div>

              {/* Notes */}
              <section className="rounded-xl border border-neutral-200 bg-white p-4">
                <h4 className="text-sm font-semibold text-neutral-900">Notes</h4>
                <textarea
                  value={notes}
                  onChange={(event) => onNotesChange(event.target.value)}
                  placeholder="Write hypotheses and test notes..."
                  className="mt-2 min-h-[100px] w-full rounded-xl border border-neutral-200 bg-neutral-50/50 px-3 py-2 text-sm outline-none focus:border-neutral-400"
                />
              </section>

              {row.creativeId && businessId ? (
                <CreativeEngineV3EvidenceSection
                  businessId={businessId}
                  creativeId={row.creativeId}
                  campaignId={campaignScopeId ?? null}
                  open={open}
                />
              ) : null}

              {businessId ? (
                <CreativeAdActionsSection
                  businessId={businessId}
                  row={row}
                  open={open}
                />
              ) : null}

            </div>
          </aside>

        </main>
      </div>
    </div>
  );
}

function Pill({ value }: { value: string }) {
  return <span className="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[12px] font-medium text-neutral-600">{value}</span>;
}

function formatInteger(value: number): string {
  return Math.round(Number.isFinite(value) ? value : 0).toLocaleString();
}

function resolveDetailImageUrl(row: MetaCreativeRow): string | null {
  const candidates = [
    row.previewManifest?.detail_image_src ?? null,
    row.previewManifest?.card_src ?? null,
    row.imageUrl,
    row.preview?.image_url,
    row.preview?.poster_url,
    row.thumbnailUrl,
    row.cardPreviewUrl,
    row.tableThumbnailUrl,
    row.cachedThumbnailUrl,
    row.previewUrl,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}

function PrimaryMetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 bg-white px-3 py-2.5">
      <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-neutral-500">{label}</span>
      <span className="text-[18px] font-semibold leading-none tracking-tight text-neutral-900">{value}</span>
    </div>
  );
}

function SecondaryMetricRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-neutral-500">{label}</span>
      <span className="text-right font-medium text-neutral-800">{value}</span>
    </>
  );
}
