"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Check,
  ChevronRight,
  Cloud,
  FileEdit,
  LayoutTemplate,
  Pause,
  PauseCircle,
  PlusCircle,
  PlayCircle,
  Rocket,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useAppStore } from "@/store/app-store";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import {
  fetchCreativeDecisionEngineV3,
  fetchMetaCreatives,
  mapApiRowToUiRow,
} from "@/app/(dashboard)/platforms/meta/creatives/page-support";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import {
  amountFromMinorUnits,
  amountToMinorUnits,
  normalizeMetaAddToExistingPayload,
  normalizeMetaLaunchPayload,
  type MetaAddToExistingPayload,
  type MetaLaunchPayload,
} from "@/lib/launchpad/meta";
import {
  LaunchpadCreativeSelection,
} from "@/components/launchpad/LaunchpadCreativeSelection";
import {
  LaunchpadCampaignBasics,
  type LaunchpadCampaignBasicsState,
} from "@/components/launchpad/LaunchpadCampaignBasics";
import {
  LaunchpadBudget,
  type LaunchpadBudgetState,
} from "@/components/launchpad/LaunchpadBudget";
import {
  LaunchpadAdSets,
  makeDefaultLaunchpadAdSet,
  type LaunchpadAdSetState,
} from "@/components/launchpad/LaunchpadAdSets";
import {
  LaunchpadAddToExistingTarget,
  makeDefaultAddToExistingTargetState,
  defaultCreativeAddName,
  getSelectedExistingCampaigns,
  getSelectedExistingTargets,
  type LaunchpadAddToExistingState,
} from "@/components/launchpad/LaunchpadAddToExistingTarget";
import { LaunchpadReview } from "@/components/launchpad/LaunchpadReview";
import {
  LaunchpadProgress,
  type LaunchpadProgressResult,
} from "@/components/launchpad/LaunchpadProgress";
import {
  DEFAULT_ATTRIBUTION_PRESET_ID,
  findMatchingAttributionPreset,
  getAttributionPresetById,
  type MetaAttributionSpecItem,
} from "@/lib/launchpad/attribution-presets";
import {
  applyRecentAdActionsToRows,
  resolveLaunchpadAdActionId,
  type LaunchpadRecentAdAction,
} from "@/lib/launchpad/recent-ad-actions";
import { cn } from "@/lib/utils";

type LaunchpadMode = "new_campaign" | "add_to_existing" | "manage_existing";
type WizardStep = "creatives" | "basics" | "budget" | "adsets" | "target" | "review" | "progress";
type LaunchpadSurface = "index" | "wizard";
type MetaBriefingLaunchMode = "rebuild" | "duplicate" | "apply_bid";

interface LaunchTemplate {
  id: string;
  name: string;
  description: string | null;
  source: "manual" | "auto_recent";
  payload: MetaLaunchPayload;
  updatedAt?: string;
}

interface LaunchDraft {
  id: string;
  name: string;
  payload: MetaLaunchPayload | MetaAddToExistingPayload;
  status: "draft" | "queued" | "launched" | "failed";
  updatedAt: string;
  lastError?: Record<string, unknown> | null;
}

const MODE_A_STEPS: Array<{ id: WizardStep; label: string }> = [
  { id: "creatives", label: "Creatives" },
  { id: "basics", label: "Campaign" },
  { id: "budget", label: "Budget" },
  { id: "adsets", label: "Ad sets" },
  { id: "review", label: "Review" },
];

const MODE_B_STEPS: Array<{ id: WizardStep; label: string }> = [
  { id: "creatives", label: "Creatives" },
  { id: "target", label: "Target" },
  { id: "review", label: "Review" },
];

const MODE_MANAGE_STEPS: Array<{ id: WizardStep; label: string }> = [
  { id: "creatives", label: "Creatives" },
  { id: "review", label: "Review" },
];

function isoDateDaysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function defaultCampaignName() {
  return `Meta Sales Launch ${todayIso()}`;
}

function countriesFromInput(value: string) {
  return value
    .split(",")
    .map((country) => country.trim().toUpperCase())
    .filter(Boolean);
}

function attributionSpecFromState(adSet: LaunchpadAdSetState) {
  return adSet.attributionSpec.map((item) => ({
    eventType: item.event_type,
    windowDays: item.window_days,
  }));
}

function stateFromPayloadAdSet(adSet: MetaLaunchPayload["adSets"][number], index: number): LaunchpadAdSetState {
  const attributionSpec: MetaAttributionSpecItem[] = adSet.attributionSpec.map((item) => ({
    event_type: item.eventType,
    window_days: item.windowDays,
  }));
  const preset = findMatchingAttributionPreset(attributionSpec);
  return {
    clientId: adSet.clientId || `template-adset-${index + 1}`,
    name: adSet.name,
    optimizationGoal: adSet.optimizationGoal,
    pixelId: adSet.pixelId,
    customEventType: adSet.customEventType,
    countries: adSet.targeting.countries.join(", "),
    ageMin: String(adSet.targeting.ageMin),
    ageMax: String(adSet.targeting.ageMax),
    advantageAudience: adSet.targeting.advantageAudience,
    advantagePlacements: adSet.targeting.advantagePlacements,
    publisherPlatforms: adSet.targeting.publisherPlatforms ?? [],
    facebookPositions: adSet.targeting.facebookPositions ?? [],
    instagramPositions: adSet.targeting.instagramPositions ?? [],
    attributionPresetId: preset?.id ?? "custom",
    attributionSpec:
      attributionSpec.length > 0
        ? attributionSpec
        : getAttributionPresetById(DEFAULT_ATTRIBUTION_PRESET_ID)?.attributionSpec ?? [
            { event_type: "CLICK_THROUGH", window_days: 7 },
          ],
    budgetAmount: adSet.budget?.amountMinor
      ? amountFromMinorUnits(adSet.budget.amountMinor)
      : "",
    bidStrategy: adSet.budget?.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
    bidAmount: adSet.budget?.bidAmountMinor
      ? amountFromMinorUnits(adSet.budget.bidAmountMinor)
      : "",
  };
}

async function readLaunchpadJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json().catch(() => null) as Promise<unknown>;
}

async function loadLaunchpadLibrary(businessId: string) {
  const [manual, recent, drafts] = await Promise.all([
    readLaunchpadJson(`/api/launchpad/meta/templates?businessId=${encodeURIComponent(businessId)}`),
    readLaunchpadJson(`/api/launchpad/meta/templates/recent?businessId=${encodeURIComponent(businessId)}`),
    readLaunchpadJson(`/api/launchpad/meta/drafts?businessId=${encodeURIComponent(businessId)}`),
  ]);
  const manualTemplates = isLaunchpadArrayPayload(manual, "templates");
  const recentTemplates = isLaunchpadArrayPayload(recent, "templates");
  return {
    templates: [...recentTemplates, ...manualTemplates] as LaunchTemplate[],
    drafts: isLaunchpadArrayPayload(drafts, "drafts") as LaunchDraft[],
  };
}

async function loadRecentLaunchpadAdActions(businessId: string) {
  const payload = await readLaunchpadJson(
    `/api/launchpad/meta/recent-ad-actions?businessId=${encodeURIComponent(businessId)}`,
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const actions = (payload as Record<string, unknown>).actions;
  return Array.isArray(actions) ? (actions as LaunchpadRecentAdAction[]) : [];
}

function isLaunchpadArrayPayload(payload: unknown, key: "templates" | "drafts") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function summarizeTemplate(template: LaunchTemplate) {
  const adSets = template.payload.adSets.length;
  const budget = template.payload.budget.mode;
  const source = template.source === "auto_recent" ? "Auto recent" : "Manual";
  return `${source} · ${budget} · ${adSets} ad set${adSets === 1 ? "" : "s"}`;
}

function summarizeDraft(draft: LaunchDraft) {
  const payload = draft.payload;
  const mode = payload.mode === "add_to_existing" ? "Add to existing" : "New campaign";
  const creativeCount = payload.creativeIds?.length ?? payload.creatives?.length ?? 0;
  const target =
    payload.mode === "add_to_existing"
      ? `${payload.targets?.length ?? 1} target${(payload.targets?.length ?? 1) === 1 ? "" : "s"}`
      : payload.campaign?.name || "campaign";
  return `${mode} · ${creativeCount} creative${creativeCount === 1 ? "" : "s"} · ${target}`;
}

function draftStoredError(draft: LaunchDraft): string | null {
  const error = draft.lastError;
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message.trim() : "";
  const code = typeof record.code === "string" ? record.code.trim() : "";
  if (message && code && message !== code) return `${code} — ${message}`;
  return message || code || null;
}

function formatRelativeTime(value: string | undefined) {
  if (!value) return "Saved";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "Saved";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function makePlaceholderCampaign(
  target: MetaAddToExistingPayload["targets"][number],
): LaunchpadAddToExistingState["targetCampaign"] {
  if (!target.targetCampaignId) return null;
  return {
    id: target.targetCampaignId,
    name: target.targetCampaignName || target.targetCampaignId,
    objective: "OUTCOME_SALES",
    status: null,
    effectiveStatus: null,
    dailyBudgetMinor: null,
    lifetimeBudgetMinor: null,
    isAdsetBudgetSharingEnabled: true,
    adsetCount: target.targetAdsetId ? 1 : 0,
    lastSpend28d: 0,
  };
}

function makePlaceholderAdset(
  target: MetaAddToExistingPayload["targets"][number],
): LaunchpadAddToExistingState["targetAdset"] {
  if (!target.targetAdsetId) return null;
  return {
    id: target.targetAdsetId,
    name: target.targetAdsetName || target.targetAdsetId,
    status: null,
    effectiveStatus: null,
    optimizationGoal: null,
    billingEvent: null,
    pixelId: null,
    customEventType: null,
    dailyBudgetMinor: null,
    lifetimeBudgetMinor: null,
    attributionSpec: [],
    attributionSummary: "Inherited from existing ad set",
    targeting: {
      geoCountries: [],
      ageMin: 18,
      ageMax: 65,
      advantageAudience: true,
      placementSummary: "Inherited",
    },
    currentAdCount: 0,
    last7dSpend: 0,
    last7dRoas: null,
  };
}

function normalizeMetaAdStatus(value: string | null | undefined) {
  const status = value?.trim().toUpperCase();
  return status && status.length > 0 ? status : "UNKNOWN";
}

export default function MetaLaunchpadPage() {
  const searchParams = useSearchParams();
  const launchpadQuery = searchParams?.toString() ?? "";
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const activeBusiness = businesses.find((business) => business.id === selectedBusinessId);
  const businessId = selectedBusinessId ?? "";
  const currency = activeBusiness?.currency ?? "USD";

  const [surface, setSurface] = useState<LaunchpadSurface>("index");
  const [step, setStep] = useState<WizardStep>("creatives");
  const [mode, setMode] = useState<LaunchpadMode>("new_campaign");
  const [creatives, setCreatives] = useState<MetaCreativeRow[]>([]);
  const [creativeLoading, setCreativeLoading] = useState(false);
  const [creativeError, setCreativeError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<DecisionOutput[]>([]);
  const [recentAdActions, setRecentAdActions] = useState<LaunchpadRecentAdAction[]>([]);
  const [selectedCreativeIds, setSelectedCreativeIds] = useState<string[]>([]);
  const [campaign, setCampaign] = useState<LaunchpadCampaignBasicsState>({
    name: defaultCampaignName(),
    smartPromotion: false,
    specialAdCategories: [],
  });
  const [budget, setBudget] = useState<LaunchpadBudgetState>({
    mode: "CBO",
    schedule: "daily",
    amount: "50",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    bidAmount: "",
  });
  const [adSets, setAdSets] = useState<LaunchpadAdSetState[]>([
    makeDefaultLaunchpadAdSet(1, defaultCampaignName()),
  ]);
  const [addToExistingTarget, setAddToExistingTarget] = useState<LaunchpadAddToExistingState>(
    makeDefaultAddToExistingTargetState(),
  );
  const [templates, setTemplates] = useState<LaunchTemplate[]>([]);
  const [drafts, setDrafts] = useState<LaunchDraft[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);
  const [appliedTemplateName, setAppliedTemplateName] = useState<string | null>(null);
  const [launchLoading, setLaunchLoading] = useState(false);
  const [launchResult, setLaunchResult] = useState<LaunchpadProgressResult | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(launchpadQuery);
    const fromMetaBriefing = params.get("fromMetaBriefing") === "true";
    const fromCreativeBriefing = params.get("fromBriefing") === "true";
    const creativeIds = (params.get("creativeIds") ?? "")
      .split(",")
      .map((id) => decodeURIComponent(id.trim()))
      .filter(Boolean);
    const campaignIds = (params.get("campaignIds") ?? "")
      .split(",")
      .map((id) => decodeURIComponent(id.trim()))
      .filter(Boolean);
    const adsetIds = (params.get("adsetIds") ?? "")
      .split(",")
      .map((id) => decodeURIComponent(id.trim()))
      .filter(Boolean);
    const requestedMode = params.get("mode") as MetaBriefingLaunchMode | null;

    if (!fromMetaBriefing && !fromCreativeBriefing) return;
    if (creativeIds.length > 0) setSelectedCreativeIds(creativeIds);
    if (campaignIds.length === 0 && adsetIds.length === 0) return;

    if (requestedMode === "duplicate") {
      setMode("add_to_existing");
      setStep("target");
    } else {
      setMode("new_campaign");
      setStep("basics");
    }
    setSurface("wizard");
    setTemplateMessage(
      [
        "Meta briefing prefill",
        requestedMode ? `mode=${requestedMode}` : null,
        campaignIds.length > 0 ? `campaignIds=${campaignIds.join(",")}` : null,
        adsetIds.length > 0 ? `adsetIds=${adsetIds.join(",")}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }, [launchpadQuery]);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    setCreativeLoading(true);
    setCreativeError(null);
    fetchMetaCreatives({
      businessId,
      start: isoDateDaysAgo(29),
      end: todayIso(),
      groupBy: mode === "manage_existing" ? "ad" : "creative",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    })
      .then((payload) => {
        if (cancelled) return;
        setCreatives(payload.rows.map(mapApiRowToUiRow));
      })
      .catch((error: unknown) => {
        if (!cancelled) setCreativeError(error instanceof Error ? error.message : "Could not load creatives.");
      })
      .finally(() => {
        if (!cancelled) setCreativeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, mode]);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    loadRecentLaunchpadAdActions(businessId)
      .then((actions) => {
        if (!cancelled) setRecentAdActions(actions);
      })
      .catch(() => {
        if (!cancelled) setRecentAdActions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    fetchCreativeDecisionEngineV3({ businessId })
      .then((payload) => {
        if (!cancelled) setDecisions(payload.decisions ?? []);
      })
      .catch(() => {
        if (!cancelled) setDecisions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    setLibraryLoading(true);
    loadLaunchpadLibrary(businessId)
      .then((library) => {
        if (cancelled) return;
        setTemplates(library.templates);
        setDrafts(library.drafts);
      })
      .catch(() => {
        if (!cancelled) {
          setTemplates([]);
          setDrafts([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLibraryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  async function refreshLibrary() {
    if (!businessId) return;
    setLibraryLoading(true);
    try {
      const library = await loadLaunchpadLibrary(businessId);
      setTemplates(library.templates);
      setDrafts(library.drafts);
    } catch {
      setTemplates([]);
      setDrafts([]);
    } finally {
      setLibraryLoading(false);
    }
  }

  const decisionByCreativeId = useMemo(
    () => new Map(decisions.map((decision) => [decision.creativeId, decision])),
    [decisions],
  );
  const launchpadCreatives = useMemo(
    () =>
      applyRecentAdActionsToRows(
        creatives,
        mode === "manage_existing" || mode === "add_to_existing" ? recentAdActions : [],
        currency,
        { surface: mode === "add_to_existing" ? "source_creatives" : "resulting_ads" },
      ),
    [creatives, currency, mode, recentAdActions],
  );
  const selectedCreatives = useMemo(() => {
    const selected = new Set(selectedCreativeIds);
    return launchpadCreatives.filter((creative) =>
      selected.has(mode === "manage_existing" ? resolveLaunchpadAdActionId(creative) : creative.creativeId),
    );
  }, [launchpadCreatives, mode, selectedCreativeIds]);

  const payload = useMemo(
    () =>
      normalizeMetaLaunchPayload({
        mode: "new_campaign",
        currencyCode: currency,
        campaign: {
          name: campaign.name,
          objective: "OUTCOME_SALES",
          smartPromotionType: campaign.smartPromotion ? "GUIDED_CREATION" : null,
          specialAdCategories: campaign.specialAdCategories,
        },
        budget:
          budget.mode === "CBO"
            ? {
                mode: "CBO",
                schedule: budget.schedule ?? "daily",
                amountMinor: amountToMinorUnits(budget.amount ?? ""),
                bidStrategy: budget.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
                bidAmountMinor: amountToMinorUnits(budget.bidAmount ?? ""),
              }
            : {
                mode: "ABO",
              },
        creatives: selectedCreatives.map((creative) => ({
          creativeId: creative.creativeId,
          sourceAdId: creative.realAdId?.trim() || creative.id,
          name: creative.name,
        })),
        adSets: adSets.map((adSet) => ({
          clientId: adSet.clientId,
          name: adSet.name,
          optimizationGoal: adSet.optimizationGoal,
          pixelId: adSet.pixelId,
          customEventType: adSet.customEventType,
          targeting: {
            countries: countriesFromInput(adSet.countries),
            ageMin: Number(adSet.ageMin) || 18,
            ageMax: Number(adSet.ageMax) || 65,
            advantageAudience: adSet.advantageAudience,
            advantagePlacements: adSet.advantagePlacements,
            publisherPlatforms: adSet.publisherPlatforms,
            facebookPositions: adSet.facebookPositions,
            instagramPositions: adSet.instagramPositions,
          },
          attributionSpec: attributionSpecFromState(adSet),
          budget:
            budget.mode === "ABO"
              ? {
                  mode: "ABO",
                  schedule: "daily",
                  amountMinor: amountToMinorUnits(adSet.budgetAmount ?? ""),
                  bidStrategy: adSet.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
                  bidAmountMinor: amountToMinorUnits(adSet.bidAmount ?? ""),
                }
              : null,
        })),
      }),
    [adSets, budget, campaign, currency, selectedCreatives],
  );
  const selectedExistingTargets = useMemo(
    () => getSelectedExistingTargets(addToExistingTarget),
    [addToExistingTarget],
  );
  const selectedExistingCampaigns = useMemo(
    () => getSelectedExistingCampaigns(addToExistingTarget),
    [addToExistingTarget],
  );
  const addToExistingPayload = useMemo(
    () => {
      const firstTarget = selectedExistingTargets[0] ?? null;
      const copyMode = addToExistingTarget.copyMode ?? "rebuild_creative";
      return {
        mode: "add_to_existing" as const,
        targetCampaignId: firstTarget?.campaign.id ?? "",
        targetAdsetId: firstTarget?.adset.id ?? "",
        targetCampaignName: firstTarget?.campaign.name ?? null,
        targetAdsetName: firstTarget?.adset.name ?? null,
        copyMode,
        targets: selectedExistingTargets.map(({ campaign, adset }) => ({
          targetCampaignId: campaign.id,
          targetAdsetId: adset.id,
          targetCampaignName: campaign.name,
          targetAdsetName: adset.name,
        })),
        creativeIds: selectedCreatives.map((creative) => creative.creativeId),
        creatives: selectedCreatives.map((creative) => ({
          creativeId: creative.creativeId,
          sourceAdId: creative.realAdId?.trim() || creative.id,
          name: creative.name,
          nameOverride:
            addToExistingTarget.nameOverrides[creative.creativeId] ??
            defaultCreativeAddName(creative),
        })),
        names: selectedCreatives.reduce<Record<string, string>>((acc, creative) => {
          acc[creative.creativeId] =
            addToExistingTarget.nameOverrides[creative.creativeId] ??
            defaultCreativeAddName(creative);
          return acc;
        }, {}),
      };
    },
    [addToExistingTarget.copyMode, addToExistingTarget.nameOverrides, selectedCreatives, selectedExistingTargets],
  );

  const activeSteps =
    mode === "add_to_existing"
      ? MODE_B_STEPS
      : mode === "manage_existing"
        ? MODE_MANAGE_STEPS
        : MODE_A_STEPS;
  const currentStepIndex = activeSteps.findIndex((item) => item.id === step);
  const canGoNext =
    step === "creatives"
      ? selectedCreativeIds.length > 0
      : step === "target"
        ? selectedExistingCampaigns.length > 0 &&
          selectedExistingTargets.length === selectedExistingCampaigns.length
      : step === "basics"
        ? campaign.name.trim().length > 0
        : step !== "progress";

  const toggleCreative = useCallback((row: MetaCreativeRow) => {
    const selectionId = mode === "manage_existing" ? resolveLaunchpadAdActionId(row) : row.creativeId;
    setSelectedCreativeIds((prev) => {
      if (prev.includes(selectionId)) {
        return prev.filter((id) => id !== selectionId);
      }
      return [...prev, selectionId];
    });
  }, [mode]);

  function goNext() {
    if (step === "review") return;
    const next = activeSteps[Math.min(currentStepIndex + 1, activeSteps.length - 1)];
    if (next) setStep(next.id);
  }

  function goBack() {
    const prev = activeSteps[Math.max(currentStepIndex - 1, 0)];
    if (prev) setStep(prev.id);
  }

  function resetLaunchState() {
    setSelectedCreativeIds([]);
    setCampaign({
      name: defaultCampaignName(),
      smartPromotion: false,
      specialAdCategories: [],
    });
    setBudget({
      mode: "CBO",
      schedule: "daily",
      amount: "50",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      bidAmount: "",
    });
    setAdSets([makeDefaultLaunchpadAdSet(1, defaultCampaignName())]);
    setAddToExistingTarget(makeDefaultAddToExistingTargetState());
    setLaunchResult(null);
    setStep("creatives");
  }

  function clearAppliedTemplate() {
    resetLaunchState();
    setMode("new_campaign");
    setAppliedTemplateName(null);
    setTemplateMessage(null);
    setSurface("index");
  }

  function startMode(nextMode: LaunchpadMode) {
    setMode(nextMode);
    resetLaunchState();
    setAppliedTemplateName(null);
    setTemplateMessage(null);
    setSurface("wizard");
  }

  function modeHasState(activeMode: LaunchpadMode) {
    if (selectedCreativeIds.length > 0 || launchResult) return true;
    if (activeMode === "add_to_existing") {
      return Boolean(
        selectedExistingCampaigns.length > 0 ||
          selectedExistingTargets.length > 0 ||
          addToExistingTarget.targetCampaign ||
          addToExistingTarget.targetAdset ||
          addToExistingTarget.copyMode !== "rebuild_creative" ||
          Object.keys(addToExistingTarget.nameOverrides).length > 0,
      );
    }
    return (
      campaign.name !== defaultCampaignName() ||
      budget.mode !== "CBO" ||
      adSets.length !== 1 ||
      adSets[0]?.pixelId !== ""
    );
  }

  function returnToIndex() {
    const dirty = modeHasState(mode);
    if (
      dirty &&
      typeof window !== "undefined" &&
      !window.confirm("Discard the current launch setup and return to Launchpad?")
    ) {
      return;
    }
    resetLaunchState();
    setSurface("index");
  }

  function applyTemplate(template: LaunchTemplate) {
    const next = normalizeMetaLaunchPayload(template.payload);
    setMode("new_campaign");
    setCampaign({
      name: next.campaign.name || campaign.name,
      smartPromotion: next.campaign.smartPromotionType === "GUIDED_CREATION",
      specialAdCategories: next.campaign.specialAdCategories,
    });
    setBudget({
      mode: next.budget.mode,
      schedule: next.budget.schedule,
      amount: next.budget.amountMinor ? amountFromMinorUnits(next.budget.amountMinor) : budget.amount,
      bidStrategy: next.budget.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
      bidAmount: next.budget.bidAmountMinor ? amountFromMinorUnits(next.budget.bidAmountMinor) : "",
    });
    if (next.adSets.length > 0) {
      setAdSets(next.adSets.map(stateFromPayloadAdSet));
    }
    const existingCreativeIds = new Set(launchpadCreatives.map((creative) => creative.creativeId));
    const templateCreativeIds = next.creativeIds.filter((creativeId) =>
      existingCreativeIds.has(creativeId),
    );
    if (templateCreativeIds.length > 0) setSelectedCreativeIds(templateCreativeIds);
    setAppliedTemplateName(template.name);
    setTemplateMessage(`Applied ${template.name}`);
    setSurface("wizard");
    setStep("creatives");
  }

  function applyDraft(draft: LaunchDraft) {
    if (draft.payload.mode === "add_to_existing") {
      const next = normalizeMetaAddToExistingPayload(draft.payload);
      const targetCampaigns = next.targets
        .map(makePlaceholderCampaign)
        .filter((campaign): campaign is NonNullable<LaunchpadAddToExistingState["targetCampaign"]> =>
          Boolean(campaign),
        );
      const targetAdsetsByCampaignId = next.targets.reduce<
        NonNullable<LaunchpadAddToExistingState["targetAdsetsByCampaignId"]>
      >((acc, target) => {
        const adset = makePlaceholderAdset(target);
        if (target.targetCampaignId && adset) acc[target.targetCampaignId] = adset;
        return acc;
      }, {});
      setMode("add_to_existing");
      setAppliedTemplateName(null);
      setSelectedCreativeIds(next.creativeIds);
      setAddToExistingTarget({
        targetCampaign: targetCampaigns[0] ?? null,
        targetAdset: targetCampaigns[0]
          ? targetAdsetsByCampaignId[targetCampaigns[0].id] ?? null
          : null,
        targetCampaigns,
        targetAdsetsByCampaignId,
        copyMode: next.copyMode,
        nameOverrides: next.names ?? {},
      });
      setTemplateMessage(`Resumed ${draft.name}`);
      setLaunchResult(null);
      setSurface("wizard");
      setStep("creatives");
      return;
    }

    const next = normalizeMetaLaunchPayload(draft.payload);
    setMode("new_campaign");
    setAppliedTemplateName(null);
    setCampaign({
      name: next.campaign.name || campaign.name,
      smartPromotion: next.campaign.smartPromotionType === "GUIDED_CREATION",
      specialAdCategories: next.campaign.specialAdCategories,
    });
    setBudget({
      mode: next.budget.mode,
      schedule: next.budget.schedule,
      amount: next.budget.amountMinor ? amountFromMinorUnits(next.budget.amountMinor) : budget.amount,
      bidStrategy: next.budget.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
      bidAmount: next.budget.bidAmountMinor ? amountFromMinorUnits(next.budget.bidAmountMinor) : "",
    });
    setAdSets(next.adSets.length > 0 ? next.adSets.map(stateFromPayloadAdSet) : [makeDefaultLaunchpadAdSet(1, defaultCampaignName())]);
    setSelectedCreativeIds(next.creativeIds);
    setTemplateMessage(`Resumed ${draft.name}`);
    setLaunchResult(null);
    setSurface("wizard");
    setStep("creatives");
  }

  async function saveTemplate() {
    const name =
      typeof window !== "undefined"
        ? window.prompt("Template name", campaign.name)
        : campaign.name;
    if (!name?.trim()) return;
    const response = await fetch("/api/launchpad/meta/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId,
        name: name.trim(),
        payload,
      }),
    });
    setAppliedTemplateName(null);
    setTemplateMessage(response.ok ? "Template saved" : "Template save failed");
    if (response.ok) await refreshLibrary();
  }

  async function saveDraft() {
    const response = await fetch("/api/launchpad/meta/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId,
        name:
          mode === "add_to_existing"
            ? `Add to ${selectedExistingTargets.length || 1} existing target${selectedExistingTargets.length === 1 ? "" : "s"}`
            : campaign.name || defaultCampaignName(),
        payload: mode === "add_to_existing" ? addToExistingPayload : payload,
      }),
    });
    setAppliedTemplateName(null);
    setTemplateMessage(response.ok ? "Draft saved" : "Draft save failed");
    if (response.ok) await refreshLibrary();
  }

  async function deleteDraft(draftId: string) {
    const response = await fetch(
      `/api/launchpad/meta/drafts/${encodeURIComponent(draftId)}?businessId=${encodeURIComponent(businessId)}`,
      { method: "DELETE" },
    );
    setAppliedTemplateName(null);
    setTemplateMessage(response.ok ? "Draft deleted" : "Draft delete failed");
    if (response.ok) await refreshLibrary();
  }

  async function deleteTemplate(template: LaunchTemplate) {
    if (template.source !== "manual") return;
    const response = await fetch(
      `/api/launchpad/meta/templates/${encodeURIComponent(template.id)}?businessId=${encodeURIComponent(businessId)}`,
      { method: "DELETE" },
    );
    setAppliedTemplateName(null);
    setTemplateMessage(response.ok ? "Template deleted" : "Template delete failed");
    if (response.ok) await refreshLibrary();
  }

  async function launchPaused() {
    setStep("progress");
    setLaunchLoading(true);
    setLaunchResult(null);
    const idempotencyKey =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}`;
    try {
      const endpoint =
        mode === "add_to_existing"
          ? "/api/launchpad/meta/add-to-existing"
          : "/api/launchpad/meta/launch";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "add_to_existing"
            ? {
                businessId,
                targetCampaignId: addToExistingPayload.targetCampaignId,
                targetAdsetId: addToExistingPayload.targetAdsetId,
                copyMode: addToExistingPayload.copyMode,
                targets: addToExistingPayload.targets,
                creativeIds: addToExistingPayload.creativeIds,
                creatives: addToExistingPayload.creatives,
                names: addToExistingPayload.names,
                idempotencyKey,
              }
            : { businessId, payload, idempotencyKey },
        ),
      });
      const body = (await response.json().catch(() => null)) as LaunchpadProgressResult | null;
      setLaunchResult(body ?? { ok: false, error: { code: "empty_response", message: "Empty response." } });
    } catch (error) {
      setLaunchResult({
        ok: false,
        error: {
          code: "launch_request_failed",
          message: error instanceof Error ? error.message : "Launch request failed.",
        },
      });
    } finally {
      setLaunchLoading(false);
    }
  }

  async function runBulkStatusAction(action: "pause" | "resume", rows: MetaCreativeRow[]) {
    setStep("progress");
    setLaunchLoading(true);
    setLaunchResult(null);
    const idempotencyKey =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}`;
    try {
      const response = await fetch("/api/launchpad/meta/bulk-ad-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          action,
          ads: rows.map((row) => ({
            adId: resolveLaunchpadAdActionId(row),
            creativeId: row.creativeId,
            name: row.name,
          })),
          idempotencyKey,
        }),
      });
      const body = (await response.json().catch(() => null)) as LaunchpadProgressResult | null;
      setLaunchResult(body ?? { ok: false, error: { code: "empty_response", message: "Empty response." } });
    } catch (error) {
      setLaunchResult({
        ok: false,
        error: {
          code: "bulk_status_request_failed",
          message: error instanceof Error ? error.message : "Bulk status request failed.",
        },
      });
    } finally {
      setLaunchLoading(false);
    }
  }

  function resetWizard() {
    resetLaunchState();
    setSurface("index");
  }

  const appliedTemplateMessageActive =
    appliedTemplateName != null && templateMessage === `Applied ${appliedTemplateName}`;

  if (!businessId) {
    return <div className="text-sm text-muted-foreground">Select a business.</div>;
  }

  return (
    <div className="ad-final" data-testid="meta-launchpad-page">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 py-1">
      {surface === "index" ? (
        <LaunchpadIndex
          drafts={drafts}
          templates={templates}
          loading={libraryLoading}
          message={templateMessage}
          appliedTemplateName={appliedTemplateMessageActive ? appliedTemplateName : null}
          onStartMode={startMode}
          onApplyDraft={applyDraft}
          onApplyTemplate={applyTemplate}
          onClearAppliedTemplate={clearAppliedTemplate}
          onDeleteDraft={deleteDraft}
          onDeleteTemplate={deleteTemplate}
        />
      ) : (
        <div className="overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface)]">
          <div className="border-b border-[var(--border)] bg-[var(--surface)] px-5 py-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  onClick={returnToIndex}
                  className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--muted)] hover:text-[var(--ink)]"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Mode
                </button>
                <div className="hidden h-4 w-px bg-[var(--border-2)] sm:block" />
                <button
                  type="button"
                  onClick={returnToIndex}
                  className="text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"
                >
                  Launchpad
                </button>
                <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-2)]" />
                <span className="truncate text-[12px] font-semibold text-[var(--ink)]">
                  {mode === "new_campaign"
                    ? "New campaign"
                    : mode === "add_to_existing"
                      ? "Add to existing"
                      : "Manage existing ads"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {templateMessage ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
                    <Cloud className="h-3.5 w-3.5 text-[var(--ok)]" />
                    {templateMessage}
                    {appliedTemplateMessageActive ? (
                      <button
                        type="button"
                        onClick={clearAppliedTemplate}
                        className="ml-1 rounded-[6px] border border-[var(--border-2)] bg-[var(--surface)] px-1.5 py-0.5 font-medium text-[var(--ink-3)] hover:border-[var(--danger-bd)] hover:bg-[var(--danger-bg)] hover:text-[var(--danger)]"
                      >
                        Clear
                      </button>
                    ) : null}
                  </span>
                ) : null}
                <PausedBadge verbose />
                {mode === "new_campaign" ? (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={saveTemplate}>
                    <Bookmark className="h-3.5 w-3.5" />
                    Save as template
                  </button>
                ) : null}
              </div>
            </div>
            {step !== "progress" ? (
              <div className="mt-4">
                <LaunchpadStepper
                  steps={activeSteps}
                  currentStep={step}
                  onSelectStep={setStep}
                />
              </div>
            ) : null}
          </div>

          <main className="bg-[var(--bg)] px-5 py-5">
            {creativeError ? (
              <div className="mb-4 rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-3 text-[13px] text-[var(--danger)]">
                {creativeError}
              </div>
            ) : null}

            {step === "creatives" ? (
              <LaunchpadCreativeSelection
                rows={launchpadCreatives}
                selectedCreativeIds={selectedCreativeIds}
                decisionByCreativeId={decisionByCreativeId}
                loading={creativeLoading}
                initialStatusFilter={mode === "manage_existing" ? "all" : "active"}
                currency={currency}
                getSelectionId={(row) =>
                  mode === "manage_existing" ? resolveLaunchpadAdActionId(row) : row.creativeId
                }
                onToggleCreative={toggleCreative}
                onSetSelectedCreativeIds={setSelectedCreativeIds}
              />
            ) : null}
            {step === "basics" ? (
              <LaunchpadCampaignBasics value={campaign} onChange={setCampaign} />
            ) : null}
            {step === "budget" ? (
              <LaunchpadBudget
                value={budget}
                currency={currency}
                expectedCpa={null}
                onChange={setBudget}
              />
            ) : null}
            {step === "adsets" ? (
              <LaunchpadAdSets
                value={adSets}
                businessId={businessId}
                campaignName={campaign.name}
                budget={budget}
                onChange={setAdSets}
              />
            ) : null}
            {step === "target" ? (
              <LaunchpadAddToExistingTarget
                businessId={businessId}
                value={addToExistingTarget}
                selectedCreatives={selectedCreatives}
                onChange={setAddToExistingTarget}
              />
            ) : null}
            {step === "review" && mode === "manage_existing" ? (
              <LaunchpadManageExistingReview
                selectedCreatives={selectedCreatives}
                onRun={runBulkStatusAction}
              />
            ) : null}
            {step === "review" && mode !== "manage_existing" ? (
              <LaunchpadReview
                mode={mode}
                businessId={businessId}
                payload={mode === "add_to_existing" ? addToExistingPayload : payload}
                selectedCreatives={selectedCreatives}
                decisionByCreativeId={decisionByCreativeId}
                targetSummary={
                  mode === "add_to_existing"
                    ? {
                        campaignName: selectedExistingTargets[0]?.campaign.name ?? null,
                        adsetName: selectedExistingTargets[0]?.adset.name ?? null,
                        campaignCount: selectedExistingCampaigns.length,
                        targetCount: selectedExistingTargets.length,
                        currentAdCount: selectedExistingTargets.reduce(
                          (sum, target) => sum + target.adset.currentAdCount,
                          0,
                        ),
                      }
                    : null
                }
                onSaveTemplate={mode === "new_campaign" ? saveTemplate : undefined}
                onSaveDraft={saveDraft}
                onLaunch={launchPaused}
              />
            ) : null}
            {step === "progress" ? (
              <LaunchpadProgress
                mode={mode}
                loading={launchLoading}
                result={launchResult}
                onDone={resetWizard}
              />
            ) : null}
          </main>

          {step !== "progress" && step !== "review" ? (
            <div className="sticky bottom-0 z-10 border-t border-[var(--border)] bg-[var(--surface)] px-5 py-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-[var(--muted)]">
                  <span className="tabular-nums">
                    <strong className="text-[16px] font-[650] text-[var(--ink)]">{selectedCreativeIds.length}</strong> creatives
                  </span>
                  {mode === "new_campaign" ? (
                    <>
                      <span className="text-[var(--muted-2)]">·</span>
                      <span className="tabular-nums">
                        <strong className="text-[16px] font-[650] text-[var(--ink)]">{adSets.length}</strong> ad set{adSets.length === 1 ? "" : "s"}
                      </span>
                      <span className="text-[var(--muted-2)]">·</span>
                      <span className="tabular-nums">
                        <strong className="text-[16px] font-[650] text-[var(--ink)]">{adSets.length * selectedCreativeIds.length}</strong> ads
                      </span>
                    </>
                  ) : null}
                  {mode === "add_to_existing" ? (
                    <>
                      <span className="text-[var(--muted-2)]">·</span>
                      <span className="tabular-nums">
                        <strong className="text-[16px] font-[650] text-[var(--ink)]">{selectedExistingTargets.length}</strong> target{selectedExistingTargets.length === 1 ? "" : "s"}
                      </span>
                      <span className="text-[var(--muted-2)]">·</span>
                      <span className="tabular-nums">
                        <strong className="text-[16px] font-[650] text-[var(--ink)]">{selectedExistingTargets.length * selectedCreativeIds.length}</strong> ads
                      </span>
                    </>
                  ) : null}
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="btn"
                    disabled={currentStepIndex === 0}
                    onClick={goBack}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </button>
                  <button type="button" className="btn btn--primary" disabled={!canGoNext} onClick={goNext}>
                    Continue
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
      </div>
    </div>
  );
}

function LaunchpadIndex({
  drafts,
  templates,
  loading,
  message,
  appliedTemplateName,
  onStartMode,
  onApplyDraft,
  onApplyTemplate,
  onClearAppliedTemplate,
  onDeleteDraft,
  onDeleteTemplate,
}: {
  drafts: LaunchDraft[];
  templates: LaunchTemplate[];
  loading: boolean;
  message: string | null;
  appliedTemplateName: string | null;
  onStartMode: (mode: LaunchpadMode) => void;
  onApplyDraft: (draft: LaunchDraft) => void;
  onApplyTemplate: (template: LaunchTemplate) => void;
  onClearAppliedTemplate: () => void;
  onDeleteDraft: (draftId: string) => Promise<void>;
  onDeleteTemplate: (template: LaunchTemplate) => Promise<void>;
}) {
  return (
    <>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-[11.5px] text-[var(--muted)]">
            Platforms · <b className="font-semibold text-[var(--ink-3)]">Meta</b> · Launchpad
          </div>
          <h1 className="mt-0.5 text-[20px] font-bold tracking-[-0.02em] text-[var(--ink)]">Launchpad · Meta</h1>
          <p className="mt-1 max-w-3xl text-[13px] text-[var(--muted)]">
            Spin up campaigns or scale existing winners. All launches are created PAUSED and must be activated manually in Meta.
          </p>
        </div>
        <PausedBadge verbose />
      </header>

      <div className="grid gap-3 md:grid-cols-3" data-testid="launchpad-mode-selector">
        <ModeCard
          icon={<Rocket className="h-5 w-5" />}
          title="Launch new campaign"
          description="Pick creatives, set budget, configure ad sets, and write a paused campaign to Meta."
          meta="Creatives → Campaign → Budget → Ad sets → Review"
          onClick={() => onStartMode("new_campaign")}
        />
        <ModeCard
          icon={<PlusCircle className="h-5 w-5" />}
          title="Add ads to existing"
          description="Push selected creatives into an ad set you already run while inheriting targeting and budget."
          meta="Creatives → Target → Review · one ad set per campaign"
          onClick={() => onStartMode("add_to_existing")}
        />
        <ModeCard
          icon={<Settings className="h-5 w-5" />}
          title="Manage existing ads"
          description="Pause selected active ads or resume selected paused ads in bulk."
          meta="Creatives → Review · bulk status change"
          onClick={() => onStartMode("manage_existing")}
        />
      </div>

      {message ? (
        <div className="flex flex-col gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[12px] text-[var(--ink-3)] sm:flex-row sm:items-center sm:justify-between">
          <span>{message}</span>
          {appliedTemplateName ? (
            <button
              type="button"
              onClick={onClearAppliedTemplate}
              className="btn btn--sm w-fit"
            >
              Clear applied template
            </button>
          ) : null}
        </div>
      ) : null}

      <LaunchpadLibrarySection
        icon={<FileEdit className="h-4 w-4 text-[var(--muted)]" />}
        title="Drafts"
        count={drafts.length}
      >
        <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
          {loading && drafts.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-[var(--muted)]">Loading drafts...</p>
          ) : null}
          {!loading && drafts.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-[var(--muted)]">No drafts yet.</p>
          ) : null}
          <div className="divide-y divide-[var(--border)]">
            {drafts.map((draft) => {
              const failed = draft.status === "failed";
              const storedError = draftStoredError(draft);
              return (
              <div
                key={draft.id}
                className="group flex w-full flex-col gap-2 px-4 py-3 transition hover:bg-[var(--hover)]"
              >
                <div className="flex w-full items-center gap-3">
                <button
                  type="button"
                  onClick={() => onApplyDraft(draft)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--surface-3)] text-[var(--ink-3)]">
                    {draft.payload.mode === "add_to_existing" ? (
                      <PlusCircle className="h-4 w-4" />
                    ) : (
                      <Rocket className="h-4 w-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-[var(--ink)]">{draft.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-[var(--muted)]">{summarizeDraft(draft)}</span>
                  </span>
                  <span className="hidden shrink-0 items-center gap-2 text-right text-[11px] text-[var(--muted)] sm:flex">
                    {formatRelativeTime(draft.updatedAt)}
                    {failed ? (
                      <span className="chip chip--action">
                        <span className="dot" />
                        Failed
                      </span>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void onDeleteDraft(draft.id);
                  }}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--muted-2)] opacity-80 transition hover:bg-[var(--danger-bg)] hover:text-[var(--danger)] group-hover:opacity-100"
                  aria-label={`Delete draft ${draft.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                </div>
                {failed && storedError ? (
                  <div className="rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] px-3 py-2">
                    <div className="mono text-[11px] text-[var(--danger)]">stored error: {storedError}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                      The error is the server&apos;s, rendered verbatim. Fix it, then resume.
                    </div>
                  </div>
                ) : null}
              </div>
              );
            })}
          </div>
        </div>
      </LaunchpadLibrarySection>

      <LaunchpadLibrarySection
        icon={<LayoutTemplate className="h-4 w-4 text-[var(--muted)]" />}
        title="Templates"
        count={templates.length}
      >
        {loading && templates.length === 0 ? (
          <p className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-[13px] text-[var(--muted)]">
            Loading templates...
          </p>
        ) : null}
        {!loading && templates.length === 0 ? (
          <p className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-[13px] text-[var(--muted)]">
            No templates yet.
          </p>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <div
              key={`${template.source}-${template.id}`}
              className="group rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-3 transition hover:border-[var(--border-3)] hover:bg-[var(--hover)]"
            >
              <button
                type="button"
                onClick={() => onApplyTemplate(template)}
                className="w-full text-left"
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-[var(--ink)]">{template.name}</span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-[var(--muted)]">
                      {template.description ?? summarizeTemplate(template)}
                    </span>
                  </span>
                  {template.source === "auto_recent" ? (
                    <span className="chip chip--auto">
                      <Sparkles className="h-3 w-3" />
                      Auto
                    </span>
                  ) : null}
                </span>
              </button>
              <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-[var(--muted-2)]">
                <span>{summarizeTemplate(template)}</span>
                {template.source === "manual" ? (
                  <button
                    type="button"
                    onClick={() => {
                      void onDeleteTemplate(template);
                    }}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--muted-2)] transition hover:bg-[var(--danger-bg)] hover:text-[var(--danger)]"
                    aria-label={`Delete template ${template.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </LaunchpadLibrarySection>
    </>
  );
}

function LaunchpadManageExistingReview({
  selectedCreatives,
  onRun,
}: {
  selectedCreatives: MetaCreativeRow[];
  onRun: (action: "pause" | "resume", rows: MetaCreativeRow[]) => void;
}) {
  const activeRows = selectedCreatives.filter(
    (creative) => normalizeMetaAdStatus(creative.effectiveStatus) === "ACTIVE",
  );
  const pausedRows = selectedCreatives.filter(
    (creative) => normalizeMetaAdStatus(creative.effectiveStatus) === "PAUSED",
  );
  const unknownRows = selectedCreatives.filter((creative) => {
    const status = normalizeMetaAdStatus(creative.effectiveStatus);
    return status !== "ACTIVE" && status !== "PAUSED";
  });
  const missingActionIds = selectedCreatives.filter((creative) => !resolveLaunchpadAdActionId(creative));

  return (
    <section className="space-y-5" data-testid="launchpad-manage-existing-review">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">Manage existing ads</h2>
        <p className="text-[13px] text-[var(--muted)]">
          Use the same Meta ad status path as Creative Detail, applied to the selected rows.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryTile label="Selected" value={`${selectedCreatives.length}`} />
        <SummaryTile label="Active" value={`${activeRows.length}`} />
        <SummaryTile label="Paused" value={`${pausedRows.length}`} />
        <SummaryTile label="Other" value={`${unknownRows.length}`} />
      </div>

      {missingActionIds.length > 0 ? (
        <div className="rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-3 text-[13px] text-[var(--danger)]">
          {missingActionIds.length} selected row cannot be mapped to a Meta ad id.
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-[var(--warn-bg)] text-[var(--warn)]">
              <PauseCircle className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-[var(--ink)]">Pause selected active ads</p>
              <p className="mt-1 text-[13px] text-[var(--muted)]">
                {activeRows.length} active ad{activeRows.length === 1 ? "" : "s"} will be set to PAUSED.
              </p>
              <button
                type="button"
                className="btn btn--primary mt-4"
                disabled={activeRows.length === 0 || missingActionIds.length > 0}
                onClick={() => onRun("pause", activeRows)}
              >
                <PauseCircle className="h-4 w-4" />
                Pause selected ({activeRows.length})
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-[var(--ok-bg)] text-[var(--ok)]">
              <PlayCircle className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-[var(--ink)]">Resume selected paused ads</p>
              <p className="mt-1 text-[13px] text-[var(--muted)]">
                {pausedRows.length} paused ad{pausedRows.length === 1 ? "" : "s"} will be set to ACTIVE.
              </p>
              <div className="mt-3 rounded-[8px] border border-[var(--warn-bd)] bg-[var(--warn-bg)] px-3 py-2 text-[12px] text-[var(--warn)]">
                Resume is an activation write — that ad starts spending immediately. It is never paused-by-default.
              </div>
              <button
                type="button"
                className="btn btn--primary mt-3"
                disabled={pausedRows.length === 0 || missingActionIds.length > 0}
                onClick={() => onRun("resume", pausedRows)}
              >
                <PlayCircle className="h-4 w-4" />
                Resume selected ({pausedRows.length})
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
        <div className="border-b border-[var(--border)] px-4 py-3 text-[13px] font-semibold text-[var(--ink)]">Selected ads</div>
        <div className="max-h-[360px] divide-y divide-[var(--border)] overflow-auto">
          {selectedCreatives.map((creative) => (
            <div key={creative.creativeId} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-[var(--ink)]">{creative.name}</p>
                <p className="mono text-[11px] text-[var(--muted)]">
                  {resolveLaunchpadAdActionId(creative)} · {creative.campaignName ?? "No campaign"}
                </p>
              </div>
              <span className="chip">{normalizeMetaAdStatus(creative.effectiveStatus)}</span>
            </div>
          ))}
          {selectedCreatives.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-[var(--muted)]">No ads selected.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <p className="text-[11.5px] text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-[26px] font-[650] leading-none tracking-[-0.02em] tabular-nums text-[var(--ink)]">{value}</p>
    </div>
  );
}

function ModeCard({
  icon,
  title,
  description,
  meta,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition hover:border-[var(--border-3)]"
    >
      <span className="flex items-start justify-between">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-[8px] bg-[var(--surface-3)] text-[var(--ink-3)] transition group-hover:bg-[var(--hover)]">
          {icon}
        </span>
        <ArrowRight className="h-4 w-4 text-[var(--muted-2)] transition group-hover:translate-x-0.5 group-hover:text-[var(--brand)]" />
      </span>
      <span className="mt-4 block text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">{title}</span>
      <span className="mt-1 block text-[12px] leading-relaxed text-[var(--muted)]">{description}</span>
      <span className="mono mt-3 block text-[10.5px] text-[var(--muted-2)]">{meta}</span>
    </button>
  );
}

function LaunchpadLibrarySection({
  icon,
  title,
  count,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ink)]">
          {icon}
          {title}
          <span className="mono text-[11px] font-normal text-[var(--muted)]">{count}</span>
        </h2>
      </div>
      {children}
    </section>
  );
}

function LaunchpadStepper({
  steps,
  currentStep,
  onSelectStep,
}: {
  steps: Array<{ id: WizardStep; label: string }>;
  currentStep: WizardStep;
  onSelectStep: (step: WizardStep) => void;
}) {
  const currentIndex = steps.findIndex((step) => step.id === currentStep);
  return (
    <ol className="flex w-full items-center gap-2 overflow-x-auto">
      {steps.map((item, index) => {
        const active = item.id === currentStep;
        const done = currentIndex >= 0 && index < currentIndex;
        const gated = currentIndex >= 0 && index > currentIndex;
        return (
          <li key={item.id} className="flex min-w-0 flex-1 items-center gap-2">
            <button
              type="button"
              onClick={() => onSelectStep(item.id)}
              disabled={gated}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-[6px] px-1 py-1 text-left",
                gated ? "cursor-default" : "cursor-pointer",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums",
                  done
                    ? "border-[var(--ink)] bg-[var(--ink)] text-white"
                    : active
                      ? "border-[var(--ink)] bg-[var(--surface-3)] text-[var(--ink)]"
                      : "border-[var(--border-2)] bg-[var(--surface)] text-[var(--muted)]",
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <span
                className={cn(
                  "hidden whitespace-nowrap text-[12px] sm:inline",
                  active ? "font-semibold text-[var(--ink)]" : done ? "text-[var(--ink-3)]" : "text-[var(--muted)]",
                )}
              >
                {item.label}
              </span>
            </button>
            {index < steps.length - 1 ? (
              <span className={cn("h-px min-w-6 flex-1", done ? "bg-[var(--ink)]" : "bg-[var(--border)]")} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function PausedBadge({ verbose = false }: { verbose?: boolean }) {
  return (
    <span className="chip chip--warn w-fit">
      <Pause className="h-3 w-3" />
      Will launch as PAUSED{verbose ? " — activate manually in Meta" : ""}
    </span>
  );
}
