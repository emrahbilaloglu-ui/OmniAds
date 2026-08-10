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
  formatOptionalFixed,
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
    aspect: string;
  };
  fitMode: "cover" | "contain";
}

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
    viewport: {
      width: 540,
      height: 960,
      aspect: "9 / 16",
    },
    fitMode: "cover",
  },
  {
    key: "feed",
    label: "Feed",
    adFormats: [
      "MOBILE_FEED_STANDARD",
      "INSTAGRAM_STANDARD",
      "INSTAGRAM_FEED_WEB_M_SITE",
    ],
    viewport: {
      width: 540,
      height: 675,
      aspect: "4 / 5",
    },
    fitMode: "contain",
  },
  {
    key: "stories",
    label: "Stories",
    adFormats: [
      "INSTAGRAM_STORY",
      "FACEBOOK_STORY_MOBILE",
      "MESSENGER_MOBILE_STORY_MEDIA",
    ],
    viewport: {
      width: 540,
      height: 960,
      aspect: "9 / 16",
    },
    fitMode: "cover",
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

function decisionCenterText(value: string | null | undefined) {
  return value?.trim()
    ? value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
    : "Unavailable";
}

function decisionCenterMissingDataText(value: string[] | null | undefined) {
  return value && value.length > 0 ? value.join(", ") : "none";
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
    // Honest formatting: a metric the payload omits renders as an em dash, never
    // a fabricated 0.00x / zero-currency. Currency stays per-card via formatCurrency.
    const roasText = hasNumeric(card.roas) ? formatRoas(card.roas) : "—";
    const spendText = hasNumeric(card.spend) ? formatCurrency(card.spend) : "—";
    const cpaText = hasNumeric(card.cpa) ? formatCurrency(card.cpa) : "—";
    items.push({
      title: `ROAS ${roasText} - spend ${spendText}`,
      body: `Purchases ${formatCount(card.purchases)}; CPA ${cpaText}; confidence ${formatOptionalFixed(card.confidence, 0, "%")}.`,
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
  placement: EvidencePreviewPlacementConfig,
) {
  if (!html) return null;
  const { viewport, fitMode } = placement;
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
      #adsecute-meta-preview-fit iframe {
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
      #adsecute-meta-preview-content {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        overflow: hidden !important;
        transform-origin: top left !important;
        will-change: transform !important;
      }
      #adsecute-meta-preview-fit iframe {
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
        const FIT_MODE = "${fitMode}";
        const FIT_ID = "adsecute-meta-preview-fit";
        const CONTENT_ID = "adsecute-meta-preview-content";
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
          let content = document.getElementById(CONTENT_ID);
          if (!wrapper) {
            wrapper = document.createElement("div");
            wrapper.id = FIT_ID;
            content = document.createElement("div");
            content.id = CONTENT_ID;
            wrapper.appendChild(content);
            const nodes = Array.from(document.body.childNodes).filter((node) => {
              return node !== wrapper && !(node.nodeType === Node.ELEMENT_NODE && node.tagName === "SCRIPT");
            });
            document.body.insertBefore(wrapper, document.body.firstChild);
            nodes.forEach((node) => content.appendChild(node));
          } else if (!content) {
            content = document.createElement("div");
            content.id = CONTENT_ID;
            const nodes = Array.from(wrapper.childNodes).filter((node) => {
              return node !== content && !(node.nodeType === Node.ELEMENT_NODE && node.tagName === "SCRIPT");
            });
            wrapper.appendChild(content);
            nodes.forEach((node) => content.appendChild(node));
          }
          return { wrapper, content };
        };

        const readFrameDimension = (frame, name, fallback) => {
          const stored = Number.parseFloat(frame.dataset[name] || "");
          const axis = name === "adsecuteNativeWidth" ? "width" : "height";
          const attr = Number.parseFloat(frame.getAttribute(name === "adsecuteNativeWidth" ? "width" : "height") || "");
          const rect = frame.getBoundingClientRect();
          const measured = axis === "width" ? rect.width : rect.height;
          let content = 0;
          try {
            const doc = frame.contentDocument;
            const body = doc?.body;
            const root = doc?.documentElement;
            content = axis === "width"
              ? Math.max(
                  body?.scrollWidth || 0,
                  root?.scrollWidth || 0,
                  body?.offsetWidth || 0,
                  root?.offsetWidth || 0
                )
              : Math.max(
                  body?.scrollHeight || 0,
                  root?.scrollHeight || 0,
                  body?.offsetHeight || 0,
                  root?.offsetHeight || 0
                );
          } catch {
            content = 0;
          }
          const value = Math.max(
            Number.isFinite(stored) && stored > 0 ? stored : 0,
            Number.isFinite(content) && content > 0 ? content : 0,
            Number.isFinite(attr) && attr > 0 ? attr : 0,
            Number.isFinite(measured) && measured > 0 ? measured : 0,
            fallback
          );
          frame.dataset[name] = String(value);
          return value;
        };

        const fitScaleFor = (width, height) => {
          const ratioWidth = VIEWPORT_WIDTH / width;
          const ratioHeight = VIEWPORT_HEIGHT / height;
          const scale = FIT_MODE === "cover"
            ? Math.max(ratioWidth, ratioHeight)
            : Math.min(ratioWidth, ratioHeight);
          return Number.isFinite(scale) && scale > 0 ? scale : 1;
        };

        const fitNestedPreviewFrames = (wrapper) => {
          const frames = Array.from(wrapper.querySelectorAll("iframe"));
          if (frames.length === 0) return false;
          frames.forEach((frame, index) => {
            if (frame.parentElement !== wrapper) {
              wrapper.appendChild(frame);
            }
            frame.style.setProperty("z-index", index === 0 ? "1" : "0", "important");
            frame.style.setProperty("visibility", index === 0 ? "visible" : "hidden", "important");
            frame.style.setProperty("pointer-events", index === 0 ? "auto" : "none", "important");
            const nativeWidth = readFrameDimension(frame, "adsecuteNativeWidth", VIEWPORT_WIDTH);
            const nativeHeight = readFrameDimension(frame, "adsecuteNativeHeight", VIEWPORT_HEIGHT);
            const scale = fitScaleFor(nativeWidth, nativeHeight);
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
            frame.style.setProperty("overflow-x", "hidden", "important");
            frame.style.setProperty("overflow-y", "hidden", "important");
            frame.style.setProperty("scrollbar-width", "none", "important");
          });
          return true;
        };

        const readContentDimension = (content, axis) => {
          const rect = content.getBoundingClientRect();
          const measured = axis === "width" ? rect.width : rect.height;
          const scroll = axis === "width" ? content.scrollWidth : content.scrollHeight;
          const offset = axis === "width" ? content.offsetWidth : content.offsetHeight;
          const childExtent = Array.from(content.children).reduce((max, child) => {
            const childRect = child.getBoundingClientRect();
            return Math.max(max, axis === "width" ? childRect.right - rect.left : childRect.bottom - rect.top);
          }, 0);
          return Math.max(
            Number.isFinite(scroll) && scroll > 0 ? scroll : 0,
            Number.isFinite(offset) && offset > 0 ? offset : 0,
            Number.isFinite(measured) && measured > 0 ? measured : 0,
            Number.isFinite(childExtent) && childExtent > 0 ? childExtent : 0,
            axis === "width" ? VIEWPORT_WIDTH : VIEWPORT_HEIGHT
          );
        };

        const fitContentLayer = (content) => {
          content.style.setProperty("position", "absolute", "important");
          content.style.setProperty("top", "0", "important");
          content.style.setProperty("left", "0", "important");
          content.style.setProperty("transform", "none", "important");
          const width = readContentDimension(content, "width");
          const height = readContentDimension(content, "height");
          const scale = fitScaleFor(width, height);
          const x = (VIEWPORT_WIDTH - width * scale) / 2;
          const y = (VIEWPORT_HEIGHT - height * scale) / 2;
          content.style.setProperty("width", width + "px", "important");
          content.style.setProperty("height", height + "px", "important");
          content.style.setProperty("min-width", width + "px", "important");
          content.style.setProperty("min-height", height + "px", "important");
          content.style.setProperty("transform-origin", "top left", "important");
          content.style.setProperty("transform", "translate(" + x + "px, " + y + "px) scale(" + scale + ")", "important");
          content.style.setProperty("overflow", "hidden", "important");
        };

        const fitPreview = () => {
          if (fitting) return;
          fitting = true;
          requestAnimationFrame(() => {
            applyViewport();
            const fitNodes = ensureFitWrapper();
            if (!fitNodes) {
              fitting = false;
              return;
            }
            const { wrapper, content } = fitNodes;
            forceNoScroll();
            wrapper.style.removeProperty("transform");
            wrapper.style.setProperty("width", VIEWPORT_WIDTH + "px", "important");
            wrapper.style.setProperty("height", VIEWPORT_HEIGHT + "px", "important");
            wrapper.style.setProperty("overflow", "hidden", "important");
            if (fitNestedPreviewFrames(wrapper)) {
              fitting = false;
              return;
            }
            if (content) fitContentLayer(content);
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
    () => buildEvidenceLivePreviewSrcDoc(livePreviewHtml, selectedPlacementConfig),
    [livePreviewHtml, selectedPlacementConfig],
  );
  const previewScale = useMemo(() => {
    if (previewScreenSize.width <= 0 || previewScreenSize.height <= 0) return 1;
    const scale = Math.min(
      previewScreenSize.width / selectedPlacementConfig.viewport.width,
      previewScreenSize.height / selectedPlacementConfig.viewport.height,
    );
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  }, [
    previewScreenSize.height,
    previewScreenSize.width,
    selectedPlacementConfig.viewport.height,
    selectedPlacementConfig.viewport.width,
  ]);
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
  const decisionCenterRow = card.decisionCenterRow ?? null;
  const primaryMode = mapBriefingPrimaryToLaunchpadMode(card);
  const cutPrimary = isCutPrimaryAction(card);
  const scopeId = getCreativeScopeId(card);
  const cardTitle = primaryActionLabel(card);
  const hasPrimaryAction = cutPrimary || Boolean(primaryMode);
  const automationReadiness = card.automationReadiness ?? null;
  const automationTier = automationReadiness?.tier
    ? automationReadiness.tier.replace(/_/g, " ")
    : "read only";

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
              <div
                className="creative-evidence-preview-slot creative-evidence-preview-slot--live"
                data-media-shape={format.shape}
                data-preview-placement={selectedPlacementConfig.key}
                style={
                  {
                    "--preview-aspect": selectedPlacementConfig.viewport.aspect,
                  } as CSSProperties
                }
              >
                <div ref={previewScreenRef} className="creative-evidence-screen-inner">
                  {livePreviewSrcDoc ? (
                    <div
                      className="creative-evidence-preview-frame-shell"
                      style={
                        {
                          "--preview-native-width": `${selectedPlacementConfig.viewport.width}px`,
                          "--preview-native-height": `${selectedPlacementConfig.viewport.height}px`,
                          "--preview-scale": previewScale,
                          "--preview-aspect": selectedPlacementConfig.viewport.aspect,
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

            {hasNumeric(card.roas) ||
            hasNumeric(card.spend) ||
            hasNumeric(card.cpa) ||
            hasNumeric(card.purchases) ? (
              <section className="creative-evidence-section">
                {/* Triple-Whale-calm hero-numeral strip: the key metrics read as
                    large tabular numerals; anything the payload omits renders as
                    an em dash, never 0. Currency stays per-card via formatCurrency. */}
                <div
                  data-testid="creative-evidence-keymetrics"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    overflow: "hidden",
                    border: "1px solid var(--border, #ecedef)",
                    borderRadius: "8px",
                    background: "var(--surface, #ffffff)",
                  }}
                >
                  {[
                    {
                      key: "roas",
                      label: "ROAS",
                      value: hasNumeric(card.roas) ? formatRoas(card.roas) : "—",
                      color:
                        hasNumeric(card.roas) && numberOrZero(card.roas) >= 2
                          ? "var(--ok, #0e9f6e)"
                          : hasNumeric(card.roas) && numberOrZero(card.roas) < 1
                            ? "var(--danger, #e11d48)"
                            : "var(--ink, #10151c)",
                    },
                    {
                      key: "spend",
                      label: "Spend",
                      value: hasNumeric(card.spend) ? formatCurrency(card.spend) : "—",
                      color: "var(--ink, #10151c)",
                    },
                    {
                      key: "cpa",
                      label: "CPA",
                      value: hasNumeric(card.cpa) ? formatCurrency(card.cpa) : "—",
                      color: "var(--ink, #10151c)",
                    },
                    {
                      key: "purch",
                      label: "Purchases",
                      value: hasNumeric(card.purchases)
                        ? formatCount(card.purchases)
                        : "—",
                      color: "var(--ink, #10151c)",
                    },
                  ].map((metric, index) => (
                    <div
                      key={metric.key}
                      style={{
                        padding: "10px 12px",
                        borderRight:
                          index < 3 ? "1px solid var(--border, #ecedef)" : undefined,
                      }}
                    >
                      <div
                        style={{
                          color: "var(--muted, #6b7280)",
                          fontSize: "12px",
                          fontWeight: 600,
                          letterSpacing: "0.04em",
                          textTransform: "uppercase",
                        }}
                      >
                        {metric.label}
                      </div>
                      <div
                        style={{
                          marginTop: "2px",
                          color: metric.color,
                          fontSize: "26px",
                          fontWeight: 650,
                          lineHeight: 1.1,
                          letterSpacing: "-0.01em",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {metric.value}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

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

            {card.targetRoas != null ||
            card.truthSource ||
            card.preAuthorityLabel ||
            card.authorityBlocker ||
            card.pendingTransition ||
            (card.blockers?.length ?? 0) > 0 ? (
              <section className="creative-evidence-section">
                <h4>Decision basis</h4>
                <ul className="creative-evidence-list">
                  {card.preAuthorityLabel ? (
                    <li className="creative-evidence-list-item">
                      <div>
                        <b>
                          Mathematical / semantic verdict: {decisionCenterText(String(card.preAuthorityLabel))}
                        </b>
                        This is evidence before authority restrictions and never grants a provider action by itself.
                        <span className="src">/api/creatives/briefing - preAuthorityLabel</span>
                      </div>
                    </li>
                  ) : null}
                  {card.authorityBlocker ? (
                    <li className="creative-evidence-list-item warn">
                      <div>
                        <b>
                          First authority blocker: {decisionCenterText(String(card.authorityBlocker))}
                        </b>
                        This first effective gate held the mathematical verdict before publication.
                        <span className="src">/api/creatives/briefing - authorityBlocker</span>
                      </div>
                    </li>
                  ) : null}
                  {card.pendingTransition && card.rawLabel ? (
                    <li className="creative-evidence-list-item warn">
                      <div>
                        <b>Pending transition - held at previous decision</b>
                        Today's raw engine signal is "{String(card.rawLabel)}"; the published
                        label changes only if the signal holds a second evaluation.
                        <span className="src">/api/creatives/briefing - rawLabel / pendingTransition</span>
                      </div>
                    </li>
                  ) : null}
                  {card.targetRoas != null ? (
                    <li className="creative-evidence-list-item">
                      <div>
                        <b>Target ROAS {card.targetRoas.toFixed(2)}</b>
                        {card.ratioToTarget != null
                          ? `Creative is at ${(card.ratioToTarget * 100).toFixed(0)}% of target`
                          : "Ratio to target unavailable in payload"}
                        <span className="src">/api/creatives/briefing - targetRoas / ratioToTarget</span>
                      </div>
                    </li>
                  ) : null}
                  {card.truthSource ? (
                    <li className="creative-evidence-list-item">
                      <div>
                        <b>Truth source: {decisionCenterText(String(card.truthSource))}</b>
                        Target and thresholds derive from this server-computed source.
                        <span className="src">/api/creatives/briefing - truthSource</span>
                      </div>
                    </li>
                  ) : null}
                  {(card.blockers ?? []).map((blocker) => (
                    <li
                      key={blocker.predicate}
                      className={
                        blocker.severity === "warning"
                          ? "creative-evidence-list-item warn"
                          : "creative-evidence-list-item"
                      }
                    >
                      <div>
                        <b>
                          Blocker: {decisionCenterText(blocker.predicate)} ({blocker.status})
                        </b>
                        {blocker.reason}
                        <span className="src">
                          observed {blocker.observed ?? "n/a"} - threshold {blocker.threshold ?? "n/a"}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {(card.decisionHistory?.length ?? 0) > 0 ? (
              <section className="creative-evidence-section">
                <h4>Decision history (30d)</h4>
                <ul className="creative-evidence-list">
                  {(card.decisionHistory ?? []).map((entry) => (
                    <li
                      key={`${entry.date}-${entry.currentLabel}`}
                      className="creative-evidence-list-item"
                    >
                      <div>
                        <b>
                          {entry.date}: {entry.previousLabel ?? "(first)"} {"->"}{" "}
                          {entry.currentLabel}
                        </b>
                        {entry.realizedOutcome7d
                          ? `7d realized outcome: ${entry.realizedOutcome7d}`
                          : "7d outcome window not closed or not computed yet"}
                        <span className="src">
                          engine_v3_decision_events + decision_outcomes (7d)
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {decisionCenterRow ? (
              <section className="creative-evidence-section">
                <h4>Decision Center</h4>
                <div className="creative-evidence-callout">
                  <strong>{decisionCenterRow.buyerLabel}</strong>
                  <p>{decisionCenterRow.oneLine}</p>
                  <span className="src">
                    decision center - {decisionCenterRow.engine.contractVersion} -{" "}
                    {decisionCenterRow.engine.engineVersion}
                  </span>
                </div>
                <ul className="creative-evidence-list">
                  <li className="creative-evidence-list-item">
                    <div>
                      <b>
                        {decisionCenterText(decisionCenterRow.buyerAction)} -{" "}
                        {decisionCenterRow.engine.primaryDecision}
                      </b>
                      {decisionCenterText(decisionCenterRow.engine.problemClass)} -{" "}
                      {decisionCenterText(decisionCenterRow.engine.actionability)}
                      <span className="src">
                        buyerAction {decisionCenterRow.buyerAction} - execution{" "}
                        {decisionCenterRow.executionAction ?? "none"}
                      </span>
                    </div>
                  </li>
                  <li className="creative-evidence-list-item">
                    <div>
                      <b>
                        Priority {decisionCenterRow.priority} - confidence{" "}
                        {decisionCenterRow.confidenceBand}
                      </b>
                      {decisionCenterRow.nextStep}
                      <span className="src">
                        sourceDecision {decisionCenterRow.sourceDecision ?? "unavailable"}
                      </span>
                    </div>
                  </li>
                  <li className="creative-evidence-list-item">
                    <div>
                      <b>
                        Queue {String(decisionCenterRow.engine.queueEligible)} - apply{" "}
                        {String(decisionCenterRow.engine.applyEligible)}
                      </b>
                      Missing data:{" "}
                      {decisionCenterMissingDataText(decisionCenterRow.missingData)}
                      <span className="src">
                        engine queue {String(decisionCenterRow.engine.queueEligible)} -
                        apply {String(decisionCenterRow.engine.applyEligible)}
                      </span>
                    </div>
                  </li>
                </ul>
              </section>
            ) : null}

            <section className="creative-evidence-section">
              <h4>Automation readiness</h4>
              <div className="creative-evidence-callout">
                <strong>
                  {automationReadiness
                    ? `Tier: ${automationTier}`
                    : "Read-only until readiness evidence exists"}
                </strong>
                <p>
                  {automationReadiness?.reason ??
                    "This drawer only renders server-supplied evidence and never derives readiness from tracking, label, confidence, or placement."}
                </p>
                {automationReadiness?.blockers?.length ? (
                  <span className="src">
                    blocked by {automationReadiness.blockers.join(", ")}
                  </span>
                ) : (
                  <span className="src">
                    /api/creatives/briefing - automationReadiness
                  </span>
                )}
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
