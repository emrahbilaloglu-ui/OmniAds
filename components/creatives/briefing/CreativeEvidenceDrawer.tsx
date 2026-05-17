"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQueries } from "@tanstack/react-query";
import { ArrowRight, Plus, TestTube2, X } from "lucide-react";
import {
  asDecisionLabel,
  cardAdset,
  cardCampaign,
  cardId,
  cardName,
  confidenceValue,
  numberOrZero,
} from "@/components/creatives/briefing/card-utils";
import {
  getCreativeScopeId,
  isCutPrimaryAction,
} from "@/components/creatives/briefing/action-handlers";
import { getCreativeFormatPresentation } from "@/components/creatives/briefing/creative-format";
import {
  mapBriefingPrimaryToLaunchpadMode,
  type LaunchpadBridgeMode,
} from "@/components/creatives/briefing/launchpad-bridge";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import { formatCurrency, formatRoas } from "@/lib/briefing/utils";
import { formatPercentSmart } from "@/lib/metric-format";

type EvidenceTone = "default" | "warn" | "positive";

interface EvidenceItem {
  title: string;
  body: string;
  source: string;
  tone?: EvidenceTone;
}

interface CreativeEvidenceDrawerProps {
  open: boolean;
  card: BriefingCreativeCard | null;
  businessId?: string | null;
  deferred?: boolean;
  cutPending?: boolean;
  onClose: () => void;
  onCut: (card: BriefingCreativeCard) => void;
  onDefer: (id: string) => void;
  onUndefer: (id: string) => void;
  onLaunchpad: (card: BriefingCreativeCard, mode: LaunchpadBridgeMode) => void;
}

interface CreativeEvidenceDrawerContentProps
  extends Omit<CreativeEvidenceDrawerProps, "open" | "card"> {
  card: BriefingCreativeCard;
}

type EvidencePlacement = "Reels" | "Feed" | "Stories";

interface EvidencePreviewPlacementConfig {
  key: string;
  label: EvidencePlacement;
  adFormats: string[];
  viewport: {
    width: number;
    height: number;
  };
}

const EVIDENCE_PREVIEW_VIEWPORT = {
  width: 430,
  height: 932,
} as const;

const EVIDENCE_PREVIEW_PLACEMENTS: EvidencePreviewPlacementConfig[] = [
  {
    key: "reels",
    label: "Reels",
    adFormats: [
      "INSTAGRAM_REELS",
      "FACEBOOK_REELS_MOBILE",
      "FACEBOOK_PROFILE_REELS",
      "INSTAGRAM_PROFILE_REELS",
    ],
    viewport: EVIDENCE_PREVIEW_VIEWPORT,
  },
  {
    key: "feed",
    label: "Feed",
    adFormats: [
      "MOBILE_FEED_STANDARD",
      "INSTAGRAM_STANDARD",
      "INSTAGRAM_FEED_WEB_M_SITE",
    ],
    viewport: EVIDENCE_PREVIEW_VIEWPORT,
  },
  {
    key: "stories",
    label: "Stories",
    adFormats: [
      "INSTAGRAM_STORY",
      "FACEBOOK_STORY_MOBILE",
      "MESSENGER_MOBILE_STORY_MEDIA",
    ],
    viewport: EVIDENCE_PREVIEW_VIEWPORT,
  },
];

function chipClass(label: string) {
  if (label === "cut" || label === "below_breakeven" || label === "diagnose") {
    return "chip--action";
  }
  if (label === "scale" || label === "switch" || label === "promote") {
    return "chip--action";
  }
  if (label === "refresh" || label === "test_more" || label === "rebuild") {
    return "chip--watch";
  }
  if (label === "keep") return "chip--healthy";
  return "chip--ghost";
}

function labelText(label: string) {
  if (label === "test_more") return "Fresh test";
  if (label === "below_breakeven") return "Cut";
  return label.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function campaignContext(card: BriefingCreativeCard) {
  if (card.campaignLabelStatus === "unlabeled") {
    return { label: "Unlabeled campaign", className: "chip--warn" };
  }
  if (card.campaignKind === "main") {
    return { label: "Main campaign", className: "chip--healthy" };
  }
  if (card.campaignKind === "test") {
    return { label: "Test campaign", className: "chip--info" };
  }
  if (card.campaignKind === "mixed") {
    return { label: "Mixed campaign", className: "chip--watch" };
  }
  return { label: "Campaign context unavailable", className: "chip--ghost" };
}

function sourceText(card: BriefingCreativeCard, fallback: string) {
  return card.sourceDataSource?.trim() || fallback;
}

function formatCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unavailable";
  return Math.round(value).toLocaleString("en-US");
}

function formatMaybePercent(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unavailable";
  return formatPercentSmart(value);
}

function hasNumeric(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value);
}

function buildEvidenceItems(card: BriefingCreativeCard): EvidenceItem[] {
  const source = sourceText(card, "/api/creatives/briefing");
  const label = asDecisionLabel(card.label);
  const items: EvidenceItem[] = [];
  const hasPerformance =
    hasNumeric(card.roas) ||
    hasNumeric(card.spend) ||
    hasNumeric(card.purchases) ||
    hasNumeric(card.cpa);

  if (card.reason?.trim()) {
    items.push({
      title: labelText(label),
      body: card.reason.trim(),
      source: `${source} - decision - label ${label}`,
      tone: label === "cut" || label === "below_breakeven" ? "warn" : "default",
    });
  }

  if (hasPerformance) {
    items.push({
      title: `ROAS ${formatRoas(card.roas)} - spend ${formatCurrency(card.spend)}`,
      body: `Purchases ${formatCount(card.purchases)}; CPA ${formatCurrency(card.cpa)}; confidence ${confidenceValue(card)}%.`,
      source: `${source} - mature metrics`,
      tone: numberOrZero(card.roas) >= 2 ? "positive" : numberOrZero(card.roas) < 1 ? "warn" : "default",
    });
  }

  if (
    hasNumeric(card.ctr) ||
    hasNumeric(card.addToCart) ||
    hasNumeric(card.frequency) ||
    card.fatigue != null ||
    hasNumeric(card.ctrFunnel?.value)
  ) {
    const funnelCtr = hasNumeric(card.ctrFunnel?.value) ? card.ctrFunnel?.value : card.ctr;
    items.push({
      title: `CTR funnel - ${formatMaybePercent(funnelCtr)} / ATC ${formatCount(card.addToCart)}`,
      body: `Frequency ${hasNumeric(card.frequency) ? numberOrZero(card.frequency).toFixed(1) : "unavailable"}; fatigue ${card.fatigue ? "active" : "not active"}.`,
      source: `${source} - ctrFunnel - fatigue`,
      tone: card.fatigue ? "warn" : "default",
    });
  }

  if (card.bestPlacement || card.placementList?.length) {
    const placementCount = card.placementList?.length || card.placements || 0;
    items.push({
      title: `Best placement - ${card.bestPlacement || "unavailable"}`,
      body: `${cardCampaign(card)} / ${cardAdset(card)}${placementCount ? `; ${placementCount} placement${placementCount === 1 ? "" : "s"} in briefing payload.` : "."}`,
      source: `${source} - bestPlacement`,
    });
  }

  return items;
}

function activePlacement(card: BriefingCreativeCard): EvidencePlacement {
  const placement = (card.bestPlacement || "").toLowerCase();
  if (placement.includes("reel")) return "Reels";
  if (placement.includes("stor")) return "Stories";
  return "Feed";
}

function getPreviewCreativeId(card: BriefingCreativeCard) {
  return card.creativeId?.trim() || card.id?.trim() || "";
}

function getPreviewAdId(card: BriefingCreativeCard) {
  return (
    card.realAdId?.trim() ||
    card.metaAdId?.trim() ||
    card.effectiveAdId?.trim() ||
    card.adId?.trim() ||
    ""
  );
}

function buildEvidenceLivePreviewSrcDoc(
  html: string | null,
  viewport: { width: number; height: number },
) {
  if (!html) return null;
  const injectedHead = `
    <meta name="viewport" content="width=${viewport.width}, initial-scale=1, maximum-scale=1" />
    <style>
      html,
      body {
        margin: 0 !important;
        padding: 0 !important;
        width: ${viewport.width}px !important;
        min-width: ${viewport.width}px !important;
        height: ${viewport.height}px !important;
        min-height: ${viewport.height}px !important;
        overflow: hidden !important;
        background: transparent !important;
      }
      body {
        position: relative !important;
      }
      * {
        box-sizing: border-box !important;
        scrollbar-width: none !important;
      }
      *::-webkit-scrollbar {
        width: 0 !important;
        height: 0 !important;
        display: none !important;
      }
      iframe,
      video,
      img,
      canvas,
      svg {
        max-width: none !important;
      }
      iframe {
        border: 0 !important;
        overflow: hidden !important;
      }
      body > iframe,
      #adsecute-meta-preview-fit > iframe {
        display: block !important;
      }
      [style*="overflow: scroll"],
      [style*="overflow:scroll"],
      [style*="overflow: auto"],
      [style*="overflow:auto"],
      [style*="overflow-y: scroll"],
      [style*="overflow-y:scroll"],
      [style*="overflow-y: auto"],
      [style*="overflow-y:auto"],
      [style*="overflow-x: scroll"],
      [style*="overflow-x:scroll"],
      [style*="overflow-x: auto"],
      [style*="overflow-x:auto"] {
        overflow: hidden !important;
        scrollbar-width: none !important;
      }
      #adsecute-meta-preview-fit {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: ${viewport.width}px !important;
        height: ${viewport.height}px !important;
        overflow: hidden !important;
        transform-origin: top left !important;
        will-change: transform !important;
      }
      #adsecute-meta-preview-fit > iframe {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        display: block !important;
        border: 0 !important;
        overflow: hidden !important;
        transform-origin: top left !important;
      }
    </style>
    <script>
      (() => {
        const VIEWPORT_WIDTH = ${viewport.width};
        const VIEWPORT_HEIGHT = ${viewport.height};
        const FIT_ID = "adsecute-meta-preview-fit";
        let fitting = false;

        const applyViewport = () => {
          const body = document.body;
          const root = document.documentElement;
          if (!body || !root) return;
          root.style.setProperty("width", VIEWPORT_WIDTH + "px", "important");
          root.style.setProperty("min-width", VIEWPORT_WIDTH + "px", "important");
          root.style.setProperty("height", VIEWPORT_HEIGHT + "px", "important");
          root.style.setProperty("min-height", VIEWPORT_HEIGHT + "px", "important");
          root.style.setProperty("overflow", "hidden", "important");
          body.style.setProperty("width", VIEWPORT_WIDTH + "px", "important");
          body.style.setProperty("min-width", VIEWPORT_WIDTH + "px", "important");
          body.style.setProperty("height", VIEWPORT_HEIGHT + "px", "important");
          body.style.setProperty("min-height", VIEWPORT_HEIGHT + "px", "important");
          body.style.setProperty("overflow", "hidden", "important");
        };

        const forceNoScroll = () => {
          document.querySelectorAll("*").forEach((node) => {
            const element = node;
            const style = window.getComputedStyle(element);
            if (
              style.overflow === "auto" ||
              style.overflow === "scroll" ||
              style.overflowX === "auto" ||
              style.overflowX === "scroll" ||
              style.overflowY === "auto" ||
              style.overflowY === "scroll"
            ) {
              element.style.setProperty("overflow", "hidden", "important");
              element.style.setProperty("overflow-x", "hidden", "important");
              element.style.setProperty("overflow-y", "hidden", "important");
            }
          });
          document.querySelectorAll("iframe").forEach((frame) => {
            frame.setAttribute("scrolling", "no");
            frame.style.setProperty("display", "block", "important");
            frame.style.setProperty("overflow", "hidden", "important");
            frame.style.setProperty("border", "0", "important");
          });
        };

        const ensureFitWrapper = () => {
          if (!document.body) return null;
          let wrapper = document.getElementById(FIT_ID);
          if (wrapper) return wrapper;
          wrapper = document.createElement("div");
          wrapper.id = FIT_ID;
          const nodes = Array.from(document.body.childNodes).filter((node) => {
            return node !== wrapper && !(node.nodeType === Node.ELEMENT_NODE && node.tagName === "SCRIPT");
          });
          document.body.insertBefore(wrapper, document.body.firstChild);
          nodes.forEach((node) => wrapper.appendChild(node));
          return wrapper;
        };

        const readFrameDimension = (frame, name, fallback) => {
          const stored = Number.parseFloat(frame.dataset[name] || "");
          if (Number.isFinite(stored) && stored > 0) return stored;
          const attr = Number.parseFloat(frame.getAttribute(name === "adsecuteNativeWidth" ? "width" : "height") || "");
          if (Number.isFinite(attr) && attr > 0) {
            frame.dataset[name] = String(attr);
            return attr;
          }
          const rect = frame.getBoundingClientRect();
          const measured = name === "adsecuteNativeWidth" ? rect.width : rect.height;
          const value = Number.isFinite(measured) && measured > 0 ? measured : fallback;
          frame.dataset[name] = String(value);
          return value;
        };

        const fitNestedPreviewFrames = (wrapper) => {
          const frames = Array.from(wrapper.children).filter((node) => node.tagName === "IFRAME");
          if (frames.length === 0) return false;
          frames.forEach((frame) => {
            const nativeWidth = readFrameDimension(frame, "adsecuteNativeWidth", VIEWPORT_WIDTH);
            const nativeHeight = readFrameDimension(frame, "adsecuteNativeHeight", VIEWPORT_HEIGHT);
            const scale = Math.max(VIEWPORT_WIDTH / nativeWidth, VIEWPORT_HEIGHT / nativeHeight);
            const x = (VIEWPORT_WIDTH - nativeWidth * scale) / 2;
            const y = (VIEWPORT_HEIGHT - nativeHeight * scale) / 2;
            frame.setAttribute("scrolling", "no");
            frame.style.setProperty("position", "absolute", "important");
            frame.style.setProperty("top", "0", "important");
            frame.style.setProperty("left", "0", "important");
            frame.style.setProperty("width", nativeWidth + "px", "important");
            frame.style.setProperty("min-width", nativeWidth + "px", "important");
            frame.style.setProperty("max-width", nativeWidth + "px", "important");
            frame.style.setProperty("height", nativeHeight + "px", "important");
            frame.style.setProperty("min-height", nativeHeight + "px", "important");
            frame.style.setProperty("max-height", nativeHeight + "px", "important");
            frame.style.setProperty("transform-origin", "top left", "important");
            frame.style.setProperty("transform", "translate(" + x + "px, " + y + "px) scale(" + scale + ")", "important");
            frame.style.setProperty("overflow", "hidden", "important");
          });
          return true;
        };

        const fitPreview = () => {
          if (fitting) return;
          fitting = true;
          requestAnimationFrame(() => {
            applyViewport();
            const wrapper = ensureFitWrapper();
            if (!wrapper) {
              fitting = false;
              return;
            }
            forceNoScroll();
            wrapper.style.removeProperty("transform");
            wrapper.style.setProperty("width", VIEWPORT_WIDTH + "px", "important");
            wrapper.style.setProperty("height", VIEWPORT_HEIGHT + "px", "important");
            wrapper.style.setProperty("overflow", "hidden", "important");
            if (fitNestedPreviewFrames(wrapper)) {
              fitting = false;
              return;
            }
            const rect = wrapper.getBoundingClientRect();
            const width = Math.max(wrapper.scrollWidth, rect.width, 1);
            const height = Math.max(wrapper.scrollHeight, rect.height, 1);
            const scale = Math.min(VIEWPORT_WIDTH / width, VIEWPORT_HEIGHT / height);
            const x = Math.max((VIEWPORT_WIDTH - width * scale) / 2, 0);
            const y = Math.max((VIEWPORT_HEIGHT - height * scale) / 2, 0);
            wrapper.style.setProperty("width", width + "px", "important");
            wrapper.style.setProperty("height", height + "px", "important");
            wrapper.style.setProperty("transform", "translate(" + x + "px, " + y + "px) scale(" + scale + ")", "important");
            fitting = false;
          });
        };

        const run = () => {
          fitPreview();
          window.setTimeout(fitPreview, 80);
          window.setTimeout(fitPreview, 260);
          window.setTimeout(fitPreview, 700);
          window.setTimeout(fitPreview, 1400);
        };
        if (document.readyState === "complete") run();
        else window.addEventListener("load", run, { once: true });
        window.addEventListener("resize", run);
        const observer = new MutationObserver(run);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener("beforeunload", () => observer.disconnect());
      })();
    </script>
  `;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}${injectedHead}`);
  }

  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (match) => `${match}<head>${injectedHead}</head>`);
  }

  return `<!doctype html><html><head>${injectedHead}</head><body>${html}</body></html>`;
}

async function fetchEvidenceAdPreview(input: {
  businessId: string;
  creativeId: string;
  adId: string | null;
  adFormats: string[];
}) {
  const params = new URLSearchParams({
    businessId: input.businessId,
    creativeId: input.creativeId,
    adFormat: input.adFormats[0] ?? "",
    adFormats: input.adFormats.join(","),
  });
  if (input.adId) params.set("adId", input.adId);

  const response = await fetch(`/api/meta/creatives/detail?${params.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | {
        detail_preview?: {
          mode?: string | null;
          source?: string | null;
          ad_format?: string | null;
          html?: string | null;
          target_type?: string | null;
        } | null;
        message?: string;
      }
    | null;

  if (!response.ok) {
    throw new Error(payload?.message ?? `Meta ad preview failed (${response.status}).`);
  }

  const detail = payload?.detail_preview;
  return {
    html: typeof detail?.html === "string" && detail.html.trim() ? detail.html.trim() : null,
    adFormat: detail?.ad_format ?? null,
    source: detail?.source ?? null,
    targetType: detail?.target_type ?? null,
  };
}

function primaryActionLabel(card: BriefingCreativeCard) {
  if (isCutPrimaryAction(card)) return card.primary?.label || "Cut";
  return card.primary?.label || labelText(asDecisionLabel(card.label));
}

function realAdLabel(card: BriefingCreativeCard) {
  return (
    card.realAdId?.trim() ||
    card.metaAdId?.trim() ||
    card.effectiveAdId?.trim() ||
    card.adId?.trim() ||
    "unavailable"
  );
}

export function CreativeEvidenceDrawer({
  open,
  card,
  businessId,
  deferred = false,
  cutPending = false,
  onClose,
  onCut,
  onDefer,
  onUndefer,
  onLaunchpad,
}: CreativeEvidenceDrawerProps) {
  if (!open || !card) return null;

  return (
    <CreativeEvidenceDrawerContent
      card={card}
      businessId={businessId}
      deferred={deferred}
      cutPending={cutPending}
      onClose={onClose}
      onCut={onCut}
      onDefer={onDefer}
      onUndefer={onUndefer}
      onLaunchpad={onLaunchpad}
    />
  );
}

function CreativeEvidenceDrawerContent({
  card,
  businessId,
  deferred = false,
  cutPending = false,
  onClose,
  onCut,
  onDefer,
  onUndefer,
  onLaunchpad,
}: CreativeEvidenceDrawerContentProps) {
  const previewScreenRef = useRef<HTMLDivElement | null>(null);
  const [selectedPlacement, setSelectedPlacement] = useState<EvidencePlacement>("Feed");
  const [previewScreenSize, setPreviewScreenSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    setSelectedPlacement(activePlacement(card));
  }, [card.bestPlacement, card.id]);

  const previewBusinessId = businessId?.trim() ?? "";
  const previewCreativeId = getPreviewCreativeId(card);
  const previewAdId = getPreviewAdId(card);
  const selectedPlacementConfig =
    EVIDENCE_PREVIEW_PLACEMENTS.find((item) => item.label === selectedPlacement) ??
    EVIDENCE_PREVIEW_PLACEMENTS[1];
  const livePreviewQueries = useQueries({
    queries: EVIDENCE_PREVIEW_PLACEMENTS.map((placement) => ({
      queryKey: [
        "creative-evidence-ad-preview",
        previewBusinessId,
        previewCreativeId,
        previewAdId,
        placement.key,
      ],
      enabled: Boolean(previewBusinessId) && Boolean(previewCreativeId),
      staleTime: 10 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
      queryFn: () =>
        fetchEvidenceAdPreview({
          businessId: previewBusinessId,
          creativeId: previewCreativeId,
          adId: previewAdId || null,
          adFormats: placement.adFormats,
        }),
    })),
  });
  const selectedPreviewIndex = EVIDENCE_PREVIEW_PLACEMENTS.findIndex(
    (item) => item.label === selectedPlacementConfig.label,
  );
  const livePreviewQuery = livePreviewQueries[selectedPreviewIndex];
  const livePreviewHtml = livePreviewQuery?.data?.html ?? null;
  const livePreviewSrcDoc = useMemo(
    () => buildEvidenceLivePreviewSrcDoc(livePreviewHtml, selectedPlacementConfig.viewport),
    [livePreviewHtml, selectedPlacementConfig.viewport],
  );
  const previewScale = useMemo(() => {
    if (previewScreenSize.width <= 0 || previewScreenSize.height <= 0) return 1;
    const scale = Math.min(
      previewScreenSize.width / selectedPlacementConfig.viewport.width,
      previewScreenSize.height / selectedPlacementConfig.viewport.height,
      1,
    );
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  }, [
    previewScreenSize.height,
    previewScreenSize.width,
    selectedPlacementConfig.viewport.height,
    selectedPlacementConfig.viewport.width,
  ]);
  const previewScaledSize = useMemo(
    () => ({
      width: Math.max(1, selectedPlacementConfig.viewport.width * previewScale),
      height: Math.max(1, selectedPlacementConfig.viewport.height * previewScale),
    }),
    [previewScale, selectedPlacementConfig.viewport.height, selectedPlacementConfig.viewport.width],
  );

  useEffect(() => {
    const node = previewScreenRef.current;
    if (!node) return;
    const updateSize = () => {
      const bounds = node.getBoundingClientRect();
      setPreviewScreenSize((current) => {
        const next = {
          width: bounds.width,
          height: bounds.height,
        };
        if (
          Math.abs(current.width - next.width) < 0.5 &&
          Math.abs(current.height - next.height) < 0.5
        ) {
          return current;
        }
        return next;
      });
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSize);
      return () => window.removeEventListener("resize", updateSize);
    }
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const format = getCreativeFormatPresentation({ ...card, preview: card.preview ?? null });
  const label = asDecisionLabel(card.label);
  const campaignChip = campaignContext(card);
  const evidenceItems = buildEvidenceItems(card);
  const primaryMode = mapBriefingPrimaryToLaunchpadMode(card);
  const cutPrimary = isCutPrimaryAction(card);
  const scopeId = getCreativeScopeId(card);
  const cardTitle = primaryActionLabel(card);
  const hasPrimaryAction = cutPrimary || Boolean(primaryMode);

  return (
    <div
      className="creative-evidence-drawer-shell"
      role="dialog"
      aria-modal="true"
      aria-label={`Evidence for ${cardName(card)}`}
    >
      <button
        type="button"
        className="creative-evidence-backdrop"
        aria-label="Close evidence"
        onClick={onClose}
      />
      <div className="creative-evidence-panel" data-media-shape={format.shape}>
        <div className="creative-evidence-layout">
          <section className="creative-evidence-stage" aria-label="Creative preview">
            <div className="creative-evidence-stage-wrap">
              <div className="creative-evidence-placement-tabs" aria-label="Placement preview">
                {EVIDENCE_PREVIEW_PLACEMENTS.map((placement) => (
                  <button
                    key={placement.key}
                    type="button"
                    className={placement.label === selectedPlacement ? "on" : ""}
                    onClick={() => setSelectedPlacement(placement.label)}
                  >
                    {placement.label}
                  </button>
                ))}
              </div>
              <div className="creative-evidence-phone creative-evidence-phone--live" data-media-shape={format.shape}>
                <span className="creative-evidence-notch" aria-hidden="true" />
                <div ref={previewScreenRef} className="creative-evidence-screen-inner">
                  {livePreviewSrcDoc ? (
                    <div
                      className="creative-evidence-preview-frame-shell"
                      style={
                        {
                          "--preview-native-width": `${selectedPlacementConfig.viewport.width}px`,
                          "--preview-native-height": `${selectedPlacementConfig.viewport.height}px`,
                          "--preview-scaled-width": `${previewScaledSize.width}px`,
                          "--preview-scaled-height": `${previewScaledSize.height}px`,
                          "--preview-scale": previewScale,
                        } as CSSProperties
                      }
                    >
                      <iframe
                        key={`${selectedPlacementConfig.key}-${livePreviewQuery?.data?.adFormat ?? "preview"}`}
                        title={`${cardName(card)} Meta ad preview`}
                        srcDoc={livePreviewSrcDoc}
                        className="creative-evidence-live-frame"
                        width={selectedPlacementConfig.viewport.width}
                        height={selectedPlacementConfig.viewport.height}
                        scrolling="no"
                        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                        referrerPolicy="no-referrer"
                      />
                    </div>
                  ) : livePreviewQuery?.isFetching ? (
                    <div className="creative-evidence-preview-state">
                      <span className="creative-evidence-spinner" aria-hidden="true" />
                      <b>Loading Meta ad preview</b>
                      <span>{selectedPlacementConfig.adFormats[0].replace(/_/g, " ").toLowerCase()}</span>
                    </div>
                  ) : (
                    <div className="creative-evidence-preview-state creative-evidence-preview-state--missing">
                      <b>Meta ad preview unavailable</b>
                      <span>
                        {previewBusinessId && previewCreativeId
                          ? "Meta did not return live preview HTML for this placement."
                          : "Creative or business id is missing from the briefing payload."}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div className="creative-evidence-meta-under">
                <b>{cardName(card)}</b> - {format.detailLabel}
                <br />
                {livePreviewQuery?.data?.adFormat
                  ? `Meta preview - ${livePreviewQuery.data.adFormat.replace(/_/g, " ").toLowerCase()}`
                  : `Meta preview requested - ${selectedPlacementConfig.adFormats[0].replace(/_/g, " ").toLowerCase()}`}
              </div>
            </div>
          </section>

          <aside className="creative-evidence-drawer">
            <div className="creative-evidence-drawer-head">
              <div className="creative-evidence-titleblock">
                <div className="creative-evidence-mono">
                  creative - {cardId(card)} - realAdId {realAdLabel(card)}
                </div>
                <h3>{cardTitle}</h3>
                <div className="creative-evidence-meta-line">
                  <span className={`chip ${chipClass(label)}`}>
                    <span className="dot" />
                    {labelText(label)}
                  </span>
                  <span className={`chip ${campaignChip.className}`}>
                    <span className="dot" />
                    {campaignChip.label}
                  </span>
                  <span className="creative-evidence-readiness-note">
                    readiness chip omitted - briefing payload does not emit it yet
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="creative-evidence-close"
                aria-label="Close evidence"
                onClick={onClose}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <section className="creative-evidence-section">
              <h4>Evidence</h4>
              {evidenceItems.length > 0 ? (
                <ul className="creative-evidence-list">
                  {evidenceItems.map((item) => (
                    <li
                      key={`${item.title}-${item.source}`}
                      className={item.tone ? `creative-evidence-list-item ${item.tone}` : "creative-evidence-list-item"}
                    >
                      <div>
                        <b>{item.title}</b>
                        {item.body}
                        <span className="src">{item.source}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="creative-evidence-unavailable">
                  <b>Evidence unavailable</b>
                  <p>
                    This drawer opened, but the briefing payload did not include
                    reason, performance, funnel, or placement evidence for this creative.
                  </p>
                  <span className="src">{sourceText(card, "/api/creatives/briefing")} - missing evidence fields</span>
                </div>
              )}
            </section>

            <section className="creative-evidence-section">
              <h4>Automation readiness</h4>
              <div className="creative-evidence-callout">
                <strong>Not emitted on /api/creatives/briefing</strong>
                <p>
                  Creative briefing does not currently carry an automationReadiness field.
                  Until it does, this drawer only renders server-supplied evidence and
                  never derives readiness from tracking, label, confidence, or placement.
                </p>
              </div>
            </section>

            <section className="creative-evidence-section">
              <h4>Operator history</h4>
              <ul className="creative-evidence-list">
                <li className="creative-evidence-list-item">
                  <div>
                    <b>{deferred ? "Deferred in triage state" : "No active operator response"}</b>
                    {deferred
                      ? "This creative is currently deferred in the creative triage state."
                      : "No defer state is active for this creative in the current briefing view."}
                    <span className="src">/api/triage/state - creative</span>
                  </div>
                </li>
              </ul>
            </section>

            <div className="creative-evidence-footer">
              {hasPrimaryAction ? (
                <button
                  type="button"
                  className={`btn ${cutPrimary ? "btn--danger" : "btn--primary"}`}
                  disabled={cutPending}
                  onClick={() => {
                    if (cutPrimary) {
                      onCut(card);
                      return;
                    }
                    if (primaryMode) onLaunchpad(card, primaryMode);
                  }}
                >
                  {cutPending ? "Working" : cardTitle}
                  {!cutPrimary ? <ArrowRight size={14} aria-hidden="true" /> : null}
                </button>
              ) : null}
              <button
                type="button"
                className="btn"
                onClick={() => onLaunchpad(card, "add_existing")}
              >
                <Plus size={14} aria-hidden="true" />
                Add to existing
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => onLaunchpad(card, "fresh_test")}
              >
                <TestTube2 size={14} aria-hidden="true" />
                Fresh test
              </button>
              {deferred ? (
                <button type="button" className="btn btn--ghost" onClick={() => onUndefer(scopeId)}>
                  Undo defer
                </button>
              ) : (
                <button type="button" className="btn btn--ghost" onClick={() => onDefer(scopeId)}>
                  Defer
                </button>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
