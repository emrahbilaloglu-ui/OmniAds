"use client";

import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Check,
  Cloud,
  ExternalLink,
  FileCheck2,
  FileEdit,
  LayoutTemplate,
  ListChecks,
  Megaphone,
  PlusCircle,
  Rocket,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
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
  buildLaunchpadSelectionSummary,
} from "@/components/launchpad/LaunchpadCreativeSelection";
import { formatMoney } from "@/components/meta/redesign/meta-card-utils";
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
import { LaunchpadManageExistingReview } from "@/components/launchpad/LaunchpadManageExistingReview";
import { normalizeCurrencyCode } from "@/components/creatives/money";
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
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import type {
  MetaLaunchIntent,
  MetaLaunchIntentCapability,
} from "@/lib/launchpad/meta-launch-intent";
import type { MetaLaunchStoreCapability } from "@/lib/launchpad/meta-store-capability";
import { LaunchIntentReceiptRows } from "./LaunchIntentReceiptRows";
import { launchpadLibraryCount } from "./launchpad-library-count";
import styles from "./page.module.css";

type LaunchpadMode = "new_campaign" | "add_to_existing" | "manage_existing";
type WizardStep =
  | "source"
  | "scope"
  | "creatives"
  | "basics"
  | "adsets"
  | "review"
  | "progress";
type MetaBriefingLaunchMode = "rebuild" | "duplicate" | "apply_bid";

interface LaunchpadLegacyHandoff {
  source: "decision" | "brief";
  requestedMode: MetaBriefingLaunchMode | null;
  creativeIds: string[];
  campaignIds: string[];
  adsetIds: string[];
  sourceDecisionId: string | null;
  sourceDecisionSnapshotId: string | null;
  creativeBriefId: string | null;
}

interface LaunchTemplate {
  id: string;
  providerAccountId: string;
  name: string;
  description: string | null;
  source: "manual" | "auto_recent";
  payload: MetaLaunchPayload;
  updatedAt?: string;
}
interface LaunchDraft {
  id: string;
  providerAccountId: string;
  name: string;
  payload: MetaLaunchPayload | MetaAddToExistingPayload;
  status: "draft" | "queued" | "launched" | "failed";
  updatedAt: string;
  lastError?: Record<string, unknown> | null;
}

const LAUNCH_STEPS: Array<{
  id: Exclude<WizardStep, "progress">;
  label: string;
}> = [
  { id: "source", label: "Source & mode" },
  { id: "scope", label: "Account & scope" },
  { id: "creatives", label: "Creative selection" },
  { id: "basics", label: "Campaign & budget" },
  { id: "adsets", label: "Ad sets & targeting" },
  { id: "review", label: "Review" },
];

function launchpadModeFromQuery(value: string | null): LaunchpadMode {
  return value === "add_to_existing" || value === "manage_existing"
    ? value
    : "new_campaign";
}

function launchpadStepFromQuery(value: string | null): WizardStep {
  const steps: WizardStep[] = [
    "source",
    "scope",
    "creatives",
    "basics",
    "adsets",
    "review",
    "progress",
  ];
  return steps.includes(value as WizardStep) ? (value as WizardStep) : "source";
}

function launchpadModeLabel(mode: LaunchpadMode) {
  if (mode === "add_to_existing") return "Add to existing";
  if (mode === "manage_existing") return "Manage existing ads";
  return "New campaign";
}

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

function parseLaunchpadLegacyHandoff(
  query: string,
): LaunchpadLegacyHandoff | null {
  const params = new URLSearchParams(query);
  const sourceDecisionId = params.get("sourceDecisionId")?.trim() || null;
  const sourceDecisionSnapshotId =
    params.get("sourceDecisionSnapshotId")?.trim() || null;
  const creativeBriefId = params.get("creativeBriefId")?.trim() || null;
  const source =
    creativeBriefId || params.get("fromBriefing") === "true"
      ? "brief"
      : sourceDecisionId ||
          sourceDecisionSnapshotId ||
          params.get("fromMetaBriefing") === "true"
        ? "decision"
        : null;
  if (!source) return null;
  const parseIds = (key: string) =>
    (params.get(key) ?? "")
      .split(",")
      .map((id) => decodeURIComponent(id.trim()))
      .filter(Boolean);
  const rawMode = params.get("mode");
  const requestedMode =
    rawMode === "rebuild" || rawMode === "duplicate" || rawMode === "apply_bid"
      ? rawMode
      : null;
  return {
    source,
    requestedMode,
    creativeIds: parseIds("creativeIds"),
    campaignIds: parseIds("campaignIds"),
    adsetIds: parseIds("adsetIds"),
    sourceDecisionId,
    sourceDecisionSnapshotId,
    creativeBriefId,
  };
}

function hasVerifiedLaunchpadLineage(
  handoff: LaunchpadLegacyHandoff | null,
): boolean {
  if (!handoff) return false;
  if (handoff.source === "brief") return Boolean(handoff.creativeBriefId);
  return Boolean(handoff.sourceDecisionId && handoff.sourceDecisionSnapshotId);
}

function attributionSpecFromState(adSet: LaunchpadAdSetState) {
  return adSet.attributionSpec.map((item) => ({
    eventType: item.event_type,
    windowDays: item.window_days,
  }));
}

function stateFromPayloadAdSet(
  adSet: MetaLaunchPayload["adSets"][number],
  index: number,
): LaunchpadAdSetState {
  const attributionSpec: MetaAttributionSpecItem[] = adSet.attributionSpec.map(
    (item) => ({
      event_type: item.eventType,
      window_days: item.windowDays,
    }),
  );
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
        : (getAttributionPresetById(DEFAULT_ATTRIBUTION_PRESET_ID)
            ?.attributionSpec ?? [
            { event_type: "CLICK_THROUGH", window_days: 7 },
          ]),
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

function launchStoreCapabilityFromPayload(
  payload: unknown,
): MetaLaunchStoreCapability | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const capability = (payload as { capability?: unknown }).capability;
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) return null;
  const candidate = capability as Partial<MetaLaunchStoreCapability>;
  if (
    (candidate.status !== "ready" && candidate.status !== "migration_required") ||
    typeof candidate.canRead !== "boolean" ||
    typeof candidate.canWrite !== "boolean" ||
    !Array.isArray(candidate.missingColumns)
  ) {
    return null;
  }
  return {
    status: candidate.status,
    canRead: candidate.canRead,
    canWrite: candidate.canWrite,
    missingColumns: candidate.missingColumns.filter(
      (column): column is string => typeof column === "string",
    ),
  };
}

async function loadLaunchpadLibrary(
  businessId: string,
  providerAccountId: string,
) {
  const scope = `businessId=${encodeURIComponent(businessId)}&providerAccountId=${encodeURIComponent(providerAccountId)}`;
  const [manual, recent, drafts, intents] = await Promise.all([
    readLaunchpadJson(`/api/launchpad/meta/templates?${scope}`),
    readLaunchpadJson(`/api/launchpad/meta/templates/recent?${scope}`),
    readLaunchpadJson(`/api/launchpad/meta/drafts?${scope}`),
    readLaunchpadJson(`/api/launchpad/meta/intents?${scope}&limit=12`),
  ]);
  const manualTemplates = isLaunchpadArrayPayload(manual, "templates");
  const recentTemplates = isLaunchpadArrayPayload(recent, "templates");
  return {
    templates: [...recentTemplates, ...manualTemplates].filter(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        (row as { providerAccountId?: unknown }).providerAccountId ===
          providerAccountId,
    ) as LaunchTemplate[],
    drafts: isLaunchpadArrayPayload(drafts, "drafts").filter(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        (row as { providerAccountId?: unknown }).providerAccountId ===
          providerAccountId,
    ) as LaunchDraft[],
    intents: isLaunchpadArrayPayload(intents, "intents").filter(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        (row as { providerAccountId?: unknown }).providerAccountId ===
          providerAccountId,
    ) as MetaLaunchIntent[],
    launchIntentCapability: launchIntentCapabilityFromPayload(intents),
    draftCapability: launchStoreCapabilityFromPayload(drafts),
    templateCapability: launchStoreCapabilityFromPayload(manual),
  };
}

async function loadRecentLaunchpadAdActions(
  businessId: string,
  providerAccountId: string,
) {
  const payload = await readLaunchpadJson(
    `/api/launchpad/meta/recent-ad-actions?businessId=${encodeURIComponent(businessId)}&providerAccountId=${encodeURIComponent(providerAccountId)}`,
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return [];
  const actions = (payload as Record<string, unknown>).actions;
  return Array.isArray(actions) ? (actions as LaunchpadRecentAdAction[]) : [];
}

function isLaunchpadArrayPayload(
  payload: unknown,
  key: "templates" | "drafts" | "intents",
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function launchIntentCapabilityFromPayload(
  payload: unknown,
): MetaLaunchIntentCapability | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const capability = (payload as Record<string, unknown>).capability;
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
    return null;
  }
  const record = capability as Record<string, unknown>;
  if (
    (record.status !== "ready" && record.status !== "migration_required") ||
    typeof record.canRead !== "boolean" ||
    typeof record.canWrite !== "boolean" ||
    !Array.isArray(record.missingTables) ||
    typeof record.checkedAt !== "string"
  ) {
    return null;
  }
  return {
    status: record.status,
    canRead: record.canRead,
    canWrite: record.canWrite,
    missingTables: record.missingTables.filter(
      (value): value is string => typeof value === "string",
    ),
    checkedAt: record.checkedAt,
  };
}

function summarizeTemplate(template: LaunchTemplate) {
  const adSets = template.payload.adSets.length;
  const budget = template.payload.budget.mode;
  const source = template.source === "auto_recent" ? "Auto recent" : "Manual";
  return `${source} · ${budget} · ${adSets} ad set${adSets === 1 ? "" : "s"}`;
}

function summarizeDraft(draft: LaunchDraft) {
  const payload = draft.payload;
  const mode =
    payload.mode === "add_to_existing" ? "Add to existing" : "New campaign";
  const creativeCount =
    payload.creativeIds?.length ?? payload.creatives?.length ?? 0;
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
  const message =
    typeof record.message === "string" ? record.message.trim() : "";
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

export default function MetaLaunchpadPage() {

  const searchParams = useSearchParams();
  const launchpadQuery = searchParams?.toString() ?? "";
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const activeBusiness = businesses.find(
    (business) => business.id === selectedBusinessId,
  );
  const businessId = selectedBusinessId ?? "";
  const requestedProviderAccountId =
    searchParams?.get("providerAccountId")?.trim() ?? "";
  const [providerAccounts, setProviderAccounts] = useState<
    MetaHistoryAccount[]
  >([]);
  const [selectedProviderAccountId, setSelectedProviderAccountId] =
    useState("");
  const [providerAccountsLoading, setProviderAccountsLoading] = useState(false);
  const [providerAccountsError, setProviderAccountsError] = useState<
    string | null
  >(null);
  const providerAccountId =
    selectedProviderAccountId ||
    (providerAccounts.length === 1 ? providerAccounts[0]!.id : "");
  const selectedProviderAccount =
    providerAccounts.find((account) => account.id === providerAccountId) ??
    null;
  const currency = normalizeCurrencyCode(selectedProviderAccount?.currency);
  const legacyHandoff = useMemo(
    () => parseLaunchpadLegacyHandoff(launchpadQuery),
    [launchpadQuery],
  );
  const requestedMode = launchpadModeFromQuery(
    searchParams?.get("launchpadMode") ?? null,
  );
  const requestedStep = launchpadStepFromQuery(
    searchParams?.get("launchpadStep") ?? null,
  );

  const [step, setStep] = useState<WizardStep>(requestedStep);
  const [mode, setMode] = useState<LaunchpadMode>(requestedMode);
  const [creatives, setCreatives] = useState<MetaCreativeRow[]>([]);
  const [creativeLoading, setCreativeLoading] = useState(false);
  const [creativeError, setCreativeError] = useState<string | null>(null);

  // One freshness contract across every Tier-0 surface. Derived from the
  // state this surface already has, so it cannot drift from what is on screen.
  useTierZeroFreshness({
    surface: "launchpad",
    isLoading: providerAccountsLoading,
    error: providerAccountsError ?? creativeError,
    // Launchpad composes what it is about to publish from live reads; the
    // accounts read is the one that gates the wizard.
    asOf: null,
    businessId: selectedBusinessId,
  });
  const [decisions, setDecisions] = useState<DecisionOutput[]>([]);
  const [recentAdActions, setRecentAdActions] = useState<
    LaunchpadRecentAdAction[]
  >([]);
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
  const [addToExistingTarget, setAddToExistingTarget] =
    useState<LaunchpadAddToExistingState>(
      makeDefaultAddToExistingTargetState(),
    );
  const [templates, setTemplates] = useState<LaunchTemplate[]>([]);
  const [drafts, setDrafts] = useState<LaunchDraft[]>([]);
  const [launchIntents, setLaunchIntents] = useState<MetaLaunchIntent[]>([]);
  const [launchIntentCapability, setLaunchIntentCapability] =
    useState<MetaLaunchIntentCapability | null>(null);
  const [draftCapability, setDraftCapability] =
    useState<MetaLaunchStoreCapability | null>(null);
  const [templateCapability, setTemplateCapability] =
    useState<MetaLaunchStoreCapability | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);
  const [appliedTemplateName, setAppliedTemplateName] = useState<string | null>(
    null,
  );
  const [launchLoading, setLaunchLoading] = useState(false);
  const [launchResult, setLaunchResult] =
    useState<LaunchpadProgressResult | null>(null);
  const [legacyHandoffActive, setLegacyHandoffActive] = useState(false);
  const [sourceDraftId, setSourceDraftId] = useState<string | null>(null);

  useEffect(() => {
    if (!businessId) {
      setProviderAccounts([]);
      setSelectedProviderAccountId("");
      return;
    }
    let cancelled = false;
    setProviderAccountsLoading(true);
    setProviderAccountsError(null);
    fetchMetaHistoryAccounts({ businessId })
      .then((accounts) => {
        if (cancelled) return;
        setProviderAccounts(accounts);
        setSelectedProviderAccountId((current) => {
          if (current && accounts.some((account) => account.id === current))
            return current;
          if (
            requestedProviderAccountId &&
            accounts.some(
              (account) => account.id === requestedProviderAccountId,
            )
          ) {
            return requestedProviderAccountId;
          }
          return "";
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProviderAccounts([]);
        setSelectedProviderAccountId("");
        setProviderAccountsError(
          error instanceof Error
            ? error.message
            : "Assigned Meta accounts could not load.",
        );
      })
      .finally(() => {
        if (!cancelled) setProviderAccountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, requestedProviderAccountId]);

  useEffect(() => {
    if (!legacyHandoff) return;
    const verified = hasVerifiedLaunchpadLineage(legacyHandoff);
    const exactWorkflowAvailable = legacyHandoff.requestedMode !== "apply_bid";
    const nextMode: LaunchpadMode =
      legacyHandoff.requestedMode === "duplicate"
        ? "add_to_existing"
        : "new_campaign";
    if (legacyHandoff.creativeIds.length > 0) {
      setSelectedCreativeIds(legacyHandoff.creativeIds);
    }
    setLegacyHandoffActive(verified && exactWorkflowAvailable);
    if (verified && exactWorkflowAvailable) {
      setMode(nextMode);
      setStep(
        nextMode === "add_to_existing"
          ? "adsets"
          : legacyHandoff.creativeIds.length > 0
            ? "basics"
            : "creatives",
      );
    } else {
      setStep("source");
    }
    setTemplateMessage(
      [
        `${legacyHandoff.source === "decision" ? "Decision" : "Brief"} handoff detected`,
        verified
          ? exactWorkflowAvailable
            ? "verified lineage will be persisted in the launch record"
            : "apply-bid execution is not part of the Launchpad contract"
          : "legacy URL prefill has no verifiable lineage",
        legacyHandoff.requestedMode
          ? `mode=${legacyHandoff.requestedMode}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }, [legacyHandoff]);

  useEffect(() => {
    if (!businessId || !providerAccountId) {
      setCreatives([]);
      return;
    }
    let cancelled = false;
    setCreativeLoading(true);
    setCreativeError(null);
    fetchMetaCreatives({
      businessId,
      providerAccountId,
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
        if (!cancelled)
          setCreativeError(
            error instanceof Error
              ? error.message
              : "Could not load creatives.",
          );
      })
      .finally(() => {
        if (!cancelled) setCreativeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, mode, providerAccountId]);

  useEffect(() => {
    if (!businessId || !providerAccountId) {
      setRecentAdActions([]);
      return;
    }
    let cancelled = false;
    loadRecentLaunchpadAdActions(businessId, providerAccountId)
      .then((actions) => {
        if (!cancelled) {
          setRecentAdActions(
            actions.filter((action) => action.accountId === providerAccountId),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setRecentAdActions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, providerAccountId]);

  useEffect(() => {
    if (!businessId || !providerAccountId || creatives.length === 0) {
      setDecisions([]);
      return;
    }
    let cancelled = false;
    fetchCreativeDecisionEngineV3({
      businessId,
      creativeIds: Array.from(
        new Set(creatives.map((creative) => creative.creativeId)),
      ),
    })
      .then((payload) => {
        if (!cancelled) setDecisions(payload.decisions ?? []);
      })
      .catch(() => {
        if (!cancelled) setDecisions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, creatives, providerAccountId]);

  useEffect(() => {
    if (!businessId || !providerAccountId) {
      setTemplates([]);
      setDrafts([]);
      setLaunchIntents([]);
      setLaunchIntentCapability(null);
      setDraftCapability(null);
      setTemplateCapability(null);
      return;
    }
    let cancelled = false;
    setLibraryLoading(true);
    loadLaunchpadLibrary(businessId, providerAccountId)
      .then((library) => {
        if (cancelled) return;
        setTemplates(library.templates);
        setDrafts(library.drafts);
        setLaunchIntents(library.intents);
        setLaunchIntentCapability(library.launchIntentCapability);
        setDraftCapability(library.draftCapability);
        setTemplateCapability(library.templateCapability);
      })
      .catch(() => {
        if (!cancelled) {
          setTemplates([]);
          setDrafts([]);
          setLaunchIntents([]);
          setLaunchIntentCapability(null);
          setDraftCapability(null);
          setTemplateCapability(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLibraryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, providerAccountId]);

  async function refreshLibrary() {
    if (!businessId || !providerAccountId) return;
    setLibraryLoading(true);
    try {
      const library = await loadLaunchpadLibrary(businessId, providerAccountId);
      setTemplates(library.templates);
      setDrafts(library.drafts);
      setLaunchIntents(library.intents);
      setLaunchIntentCapability(library.launchIntentCapability);
      setDraftCapability(library.draftCapability);
      setTemplateCapability(library.templateCapability);
    } catch {
      setTemplates([]);
      setDrafts([]);
      setLaunchIntents([]);
      setLaunchIntentCapability(null);
      setDraftCapability(null);
      setTemplateCapability(null);
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
        mode === "manage_existing" || mode === "add_to_existing"
          ? recentAdActions
          : [],
        currency,
        {
          surface:
            mode === "add_to_existing" ? "source_creatives" : "resulting_ads",
        },
      ),
    [creatives, currency, mode, recentAdActions],
  );
  const selectedCreatives = useMemo(() => {
    const selected = new Set(selectedCreativeIds);
    return launchpadCreatives.filter((creative) =>
      selected.has(
        mode === "manage_existing"
          ? resolveLaunchpadAdActionId(creative)
          : creative.creativeId,
      ),
    );
  }, [launchpadCreatives, mode, selectedCreativeIds]);
  const selectionSummary = useMemo(
    () =>
      buildLaunchpadSelectionSummary({
        selectedCreatives,
        decisionByCreativeId,
      }),
    [decisionByCreativeId, selectedCreatives],
  );

  const payload = useMemo(
    () =>
      normalizeMetaLaunchPayload({
        mode: "new_campaign",
        currencyCode: currency,
        campaign: {
          name: campaign.name,
          objective: "OUTCOME_SALES",
          smartPromotionType: campaign.smartPromotion
            ? "GUIDED_CREATION"
            : null,
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
  const addToExistingPayload = useMemo(() => {
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
      names: selectedCreatives.reduce<Record<string, string>>(
        (acc, creative) => {
          acc[creative.creativeId] =
            addToExistingTarget.nameOverrides[creative.creativeId] ??
            defaultCreativeAddName(creative);
          return acc;
        },
        {},
      ),
    };
  }, [
    addToExistingTarget.copyMode,
    addToExistingTarget.nameOverrides,
    selectedCreatives,
    selectedExistingTargets,
  ]);

  const activeLegacyHandoff =
    legacyHandoffActive && hasVerifiedLaunchpadLineage(legacyHandoff)
      ? legacyHandoff
      : null;
  const activeSteps = LAUNCH_STEPS;
  const currentStepIndex = activeSteps.findIndex((item) => item.id === step);
  const canGoNext =
    step === "source" || step === "scope"
      ? true
      : step === "creatives"
        ? selectedCreativeIds.length > 0
        : step === "adsets" && mode === "add_to_existing"
          ? selectedExistingCampaigns.length > 0 &&
            selectedExistingTargets.length === selectedExistingCampaigns.length
          : step === "basics" && mode === "new_campaign"
            ? campaign.name.trim().length > 0
            : step !== "progress";

  const toggleCreative = useCallback(
    (row: MetaCreativeRow) => {
      const selectionId =
        mode === "manage_existing"
          ? resolveLaunchpadAdActionId(row)
          : row.creativeId;
      setSelectedCreativeIds((prev) => {
        if (prev.includes(selectionId)) {
          return prev.filter((id) => id !== selectionId);
        }
        return [...prev, selectionId];
      });
    },
    [mode],
  );

  function goNext() {
    if (step === "review") return;
    const next =
      activeSteps[Math.min(currentStepIndex + 1, activeSteps.length - 1)];
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
    setSourceDraftId(null);
    setStep("source");
  }

  function changeProviderAccount(nextProviderAccountId: string) {
    if (nextProviderAccountId === providerAccountId) return;
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (nextProviderAccountId) {
        url.searchParams.set("providerAccountId", nextProviderAccountId);
      } else {
        url.searchParams.delete("providerAccountId");
      }
      for (const key of [
        "sourceDecisionId",
        "sourceDecisionSnapshotId",
        "creativeBriefId",
        "fromBriefing",
        "fromMetaBriefing",
        "creativeIds",
        "campaignIds",
        "adsetIds",
        "mode",
      ]) {
        url.searchParams.delete(key);
      }
      url.searchParams.set("launchpadMode", "new_campaign");
      url.searchParams.set("launchpadStep", "source");
      window.history.replaceState(null, "", url);
    }
    resetLaunchState();
    setMode("new_campaign");
    setTemplates([]);
    setDrafts([]);
    setLaunchIntents([]);
    setLaunchIntentCapability(null);
    setRecentAdActions([]);
    setDecisions([]);
    setCreatives([]);
    setAppliedTemplateName(null);
    setTemplateMessage(null);
    setLegacyHandoffActive(false);
    setSelectedProviderAccountId(nextProviderAccountId);
  }

  function clearAppliedTemplate() {
    resetLaunchState();
    setMode("new_campaign");
    setLegacyHandoffActive(false);
    setAppliedTemplateName(null);
    setTemplateMessage(null);
  }

  function startMode(nextMode: LaunchpadMode) {
    if (nextMode === mode) {
      setStep("scope");
      return;
    }
    setMode(nextMode);
    resetLaunchState();
    setLegacyHandoffActive(false);
    setAppliedTemplateName(null);
    setTemplateMessage(null);
    setStep("scope");
  }

  function openLegacyHandoff() {
    if (!legacyHandoff) return;
    if (legacyHandoff.requestedMode === "apply_bid") {
      setLegacyHandoffActive(false);
      setSelectedCreativeIds(legacyHandoff.creativeIds);
      setStep("source");
      setTemplateMessage(
        "Apply-bid lineage is verified, but Launchpad has no bid-write workflow. Continue from Decisions; no creation payload was inferred.",
      );
      return;
    }
    const nextMode =
      legacyHandoff.requestedMode === "duplicate"
        ? "add_to_existing"
        : "new_campaign";
    setMode(nextMode);
    setLegacyHandoffActive(hasVerifiedLaunchpadLineage(legacyHandoff));
    setAppliedTemplateName(null);
    setLaunchResult(null);
    setSelectedCreativeIds(legacyHandoff.creativeIds);
    setStep(
      nextMode === "add_to_existing"
        ? "adsets"
        : legacyHandoff.creativeIds.length > 0
          ? "basics"
          : "creatives",
    );
    setTemplateMessage(
      hasVerifiedLaunchpadLineage(legacyHandoff)
        ? `${legacyHandoff.source === "brief" ? "Reviewed brief" : "Decision snapshot"} lineage loaded · the launch record will be persisted before validation`
        : `Manual setup from legacy ${legacyHandoff.source} URL prefill · lineage unavailable`,
    );
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
      amount: next.budget.amountMinor
        ? amountFromMinorUnits(next.budget.amountMinor)
        : budget.amount,
      bidStrategy: next.budget.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
      bidAmount: next.budget.bidAmountMinor
        ? amountFromMinorUnits(next.budget.bidAmountMinor)
        : "",
    });
    if (next.adSets.length > 0) {
      setAdSets(next.adSets.map(stateFromPayloadAdSet));
    }
    const existingCreativeIds = new Set(
      launchpadCreatives.map((creative) => creative.creativeId),
    );
    const templateCreativeIds = next.creativeIds.filter((creativeId) =>
      existingCreativeIds.has(creativeId),
    );
    if (templateCreativeIds.length > 0)
      setSelectedCreativeIds(templateCreativeIds);
    setAppliedTemplateName(template.name);
    setSourceDraftId(null);
    setLegacyHandoffActive(false);
    setTemplateMessage(`Applied ${template.name}`);
    setStep("creatives");
  }

  function applyDraft(draft: LaunchDraft) {
    if (draft.providerAccountId !== providerAccountId) return;
    setSourceDraftId(draft.id);
    if (draft.payload.mode === "add_to_existing") {
      const next = normalizeMetaAddToExistingPayload(draft.payload);
      const targetCampaigns = next.targets
        .map(makePlaceholderCampaign)
        .filter(
          (
            campaign,
          ): campaign is NonNullable<
            LaunchpadAddToExistingState["targetCampaign"]
          > => Boolean(campaign),
        );
      const targetAdsetsByCampaignId = next.targets.reduce<
        NonNullable<LaunchpadAddToExistingState["targetAdsetsByCampaignId"]>
      >((acc, target) => {
        const adset = makePlaceholderAdset(target);
        if (target.targetCampaignId && adset)
          acc[target.targetCampaignId] = adset;
        return acc;
      }, {});
      setMode("add_to_existing");
      setAppliedTemplateName(null);
      setLegacyHandoffActive(false);
      setSelectedCreativeIds(next.creativeIds);
      setAddToExistingTarget({
        targetCampaign: targetCampaigns[0] ?? null,
        targetAdset: targetCampaigns[0]
          ? (targetAdsetsByCampaignId[targetCampaigns[0].id] ?? null)
          : null,
        targetCampaigns,
        targetAdsetsByCampaignId,
        copyMode: next.copyMode,
        nameOverrides: next.names ?? {},
      });
      setTemplateMessage(`Resumed ${draft.name}`);
      setLaunchResult(null);
      setStep("creatives");
      return;
    }

    const next = normalizeMetaLaunchPayload(draft.payload);
    setMode("new_campaign");
    setAppliedTemplateName(null);
    setLegacyHandoffActive(false);
    setCampaign({
      name: next.campaign.name || campaign.name,
      smartPromotion: next.campaign.smartPromotionType === "GUIDED_CREATION",
      specialAdCategories: next.campaign.specialAdCategories,
    });
    setBudget({
      mode: next.budget.mode,
      schedule: next.budget.schedule,
      amount: next.budget.amountMinor
        ? amountFromMinorUnits(next.budget.amountMinor)
        : budget.amount,
      bidStrategy: next.budget.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
      bidAmount: next.budget.bidAmountMinor
        ? amountFromMinorUnits(next.budget.bidAmountMinor)
        : "",
    });
    setAdSets(
      next.adSets.length > 0
        ? next.adSets.map(stateFromPayloadAdSet)
        : [makeDefaultLaunchpadAdSet(1, defaultCampaignName())],
    );
    setSelectedCreativeIds(next.creativeIds);
    setTemplateMessage(`Resumed ${draft.name}`);
    setLaunchResult(null);
    setStep("creatives");
  }

  async function saveTemplate() {
    if (templateCapability?.canWrite !== true) {
      setTemplateMessage(
        templateCapability?.status === "migration_required"
          ? "Saved templates require the pending account-scope database migration"
          : "Saved template storage capability is unavailable",
      );
      return;
    }
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
        providerAccountId,
        name: name.trim(),
        payload,
      }),
    });
    setAppliedTemplateName(null);
    setTemplateMessage(response.ok ? "Template saved" : "Template save failed");
    if (response.ok) await refreshLibrary();
  }

  async function saveDraft() {
    if (draftCapability?.canWrite !== true) {
      setTemplateMessage(
        draftCapability?.status === "migration_required"
          ? "Drafts require the pending account-scope database migration"
          : "Draft storage capability is unavailable",
      );
      return;
    }
    const response = await fetch("/api/launchpad/meta/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId,
        providerAccountId,
        name:
          mode === "add_to_existing"
            ? `Add to ${selectedExistingTargets.length || 1} existing target${selectedExistingTargets.length === 1 ? "" : "s"}`
            : campaign.name || defaultCampaignName(),
        payload: mode === "add_to_existing" ? addToExistingPayload : payload,
      }),
    });
    const responsePayload = (await response.json().catch(() => null)) as {
      draft?: { id?: string; providerAccountId?: string };
    } | null;
    if (
      response.ok &&
      responsePayload?.draft?.providerAccountId === providerAccountId &&
      responsePayload.draft.id
    ) {
      setSourceDraftId(responsePayload.draft.id);
    }
    setAppliedTemplateName(null);
    setTemplateMessage(response.ok ? "Draft saved" : "Draft save failed");
    if (response.ok) await refreshLibrary();
  }

  async function deleteDraft(draftId: string) {
    if (draftCapability?.canWrite !== true) {
      setTemplateMessage("Draft storage is not writable for this account.");
      return;
    }
    const response = await fetch(
      `/api/launchpad/meta/drafts/${encodeURIComponent(draftId)}?businessId=${encodeURIComponent(businessId)}&providerAccountId=${encodeURIComponent(providerAccountId)}`,
      { method: "DELETE" },
    );
    setAppliedTemplateName(null);
    setTemplateMessage(response.ok ? "Draft deleted" : "Draft delete failed");
    if (response.ok) await refreshLibrary();
  }

  async function deleteTemplate(template: LaunchTemplate) {
    if (template.source !== "manual") return;
    if (templateCapability?.canWrite !== true) {
      setTemplateMessage("Saved template storage is not writable for this account.");
      return;
    }
    const response = await fetch(
      `/api/launchpad/meta/templates/${encodeURIComponent(template.id)}?businessId=${encodeURIComponent(businessId)}&providerAccountId=${encodeURIComponent(providerAccountId)}`,
      { method: "DELETE" },
    );
    setAppliedTemplateName(null);
    setTemplateMessage(
      response.ok ? "Template deleted" : "Template delete failed",
    );
    if (response.ok) await refreshLibrary();
  }

  async function launchPaused() {
    if (!launchIntentCapability?.canWrite) {
      setStep("progress");
      setLaunchResult({
        ok: false,
        error: {
          code:
            launchIntentCapability?.status === "migration_required"
              ? "launch_intent_migration_required"
              : "launch_intent_capability_unavailable",
          message:
            launchIntentCapability?.status === "migration_required"
              ? "LaunchIntent storage needs the pending database migration. No provider request was sent."
              : "LaunchIntent storage capability could not be verified. No provider request was sent.",
        },
      });
      return;
    }
    if (!providerAccountId || !currency) {
      setStep("progress");
      setLaunchResult({
        ok: false,
        error: {
          code: !providerAccountId
            ? "provider_account_required"
            : "account_currency_required",
          message: !providerAccountId
            ? "Select an assigned Meta ad account before launching."
            : "The selected Meta account currency is unavailable; minor-unit writes are blocked.",
        },
      });
      return;
    }
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
                providerAccountId,
                targetCampaignId: addToExistingPayload.targetCampaignId,
                targetAdsetId: addToExistingPayload.targetAdsetId,
                copyMode: addToExistingPayload.copyMode,
                targets: addToExistingPayload.targets,
                creativeIds: addToExistingPayload.creativeIds,
                creatives: addToExistingPayload.creatives,
                names: addToExistingPayload.names,
                idempotencyKey,
                sourceDraftId,
                sourceDecisionId: activeLegacyHandoff?.sourceDecisionId ?? null,
                sourceDecisionSnapshotId:
                  activeLegacyHandoff?.sourceDecisionSnapshotId ?? null,
                creativeBriefId: activeLegacyHandoff?.creativeBriefId ?? null,
              }
            : {
                businessId,
                providerAccountId,
                payload,
                idempotencyKey,
                sourceDraftId,
                sourceDecisionId: activeLegacyHandoff?.sourceDecisionId ?? null,
                sourceDecisionSnapshotId:
                  activeLegacyHandoff?.sourceDecisionSnapshotId ?? null,
                creativeBriefId: activeLegacyHandoff?.creativeBriefId ?? null,
              },
        ),
      });
      const body = (await response
        .json()
        .catch(() => null)) as LaunchpadProgressResult | null;
      setLaunchResult(
        body ?? {
          ok: false,
          error: { code: "empty_response", message: "Empty response." },
        },
      );
      void refreshLibrary();
    } catch (error) {
      setLaunchResult({
        ok: false,
        error: {
          code: "launch_request_failed",
          message:
            error instanceof Error ? error.message : "Launch request failed.",
        },
      });
    } finally {
      setLaunchLoading(false);
    }
  }

  async function runBulkStatusAction(action: "pause", rows: MetaCreativeRow[]) {
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
          providerAccountId,
          action,
          ads: rows.map((row) => ({
            adId: resolveLaunchpadAdActionId(row),
            creativeId: row.creativeId,
            name: row.name,
          })),
          idempotencyKey,
        }),
      });
      const body = (await response
        .json()
        .catch(() => null)) as LaunchpadProgressResult | null;
      setLaunchResult(
        body ?? {
          ok: false,
          error: { code: "empty_response", message: "Empty response." },
        },
      );
    } catch (error) {
      setLaunchResult({
        ok: false,
        error: {
          code: "bulk_status_request_failed",
          message:
            error instanceof Error
              ? error.message
              : "Bulk status request failed.",
        },
      });
    } finally {
      setLaunchLoading(false);
    }
  }

  function resetWizard() {
    resetLaunchState();
    setLegacyHandoffActive(false);
  }

  const appliedTemplateMessageActive =
    appliedTemplateName != null &&
    templateMessage === `Applied ${appliedTemplateName}`;
  const wizardPrefilled = Boolean(activeLegacyHandoff);
  const wizardPrefillLabel =
    wizardPrefilled && legacyHandoff
      ? formatLaunchpadPrefillLabel(legacyHandoff, selectedCreativeIds.length)
      : null;
  const sourceLineageLabel = sourceDraftId
    ? `Draft · ${sourceDraftId}`
    : activeLegacyHandoff
      ? activeLegacyHandoff.source === "brief"
        ? "Reviewed Creative Brief"
        : "Decision snapshot"
      : "Manual";
  const desktopQuery = new URLSearchParams(launchpadQuery);
  desktopQuery.set("launchpadMode", mode);
  desktopQuery.set("launchpadStep", step);
  const desktopProviderAccountId =
    providerAccountId || requestedProviderAccountId;
  if (desktopProviderAccountId) {
    desktopQuery.set("providerAccountId", desktopProviderAccountId);
  } else {
    desktopQuery.delete("providerAccountId");
  }
  if (sourceDraftId) {
    desktopQuery.set("sourceDraftId", sourceDraftId);
  } else {
    desktopQuery.delete("sourceDraftId");
  }
  const desktopHref = `/platforms/meta/launchpad?${desktopQuery.toString()}`;

  if (!businessId) {
    return (
      <div className="ad-final">
        <div className="text-[13px] text-[var(--adc-ink3)] px-5 py-5">
          Select a business.
        </div>
      </div>
    );
  }

  const accountScopeBlocked =
    providerAccountsLoading ||
    Boolean(providerAccountsError) ||
    !providerAccountId ||
    !currency;

  if (accountScopeBlocked) {
    const scopeMessage = providerAccountsLoading
      ? "Loading assigned Meta ad accounts."
      : providerAccountsError
        ? providerAccountsError
        : !providerAccountId
          ? "Select one assigned Meta ad account. Launch data and provider writes remain withheld until the scope is explicit."
          : "The selected account currency is unavailable. Minor-unit budgets and provider writes remain blocked.";
    return (
      <div
        className={`ad-final meta-launchpad-final ${styles.route}`}
        data-testid="meta-launchpad-page"
      >
        <LaunchpadMobileSurface
          businessName={activeBusiness?.name ?? "Meta"}
          currency={currency}
          mode={mode}
          step={step}
          selectedCount={selectedCreativeIds.length}
          draftCount={drafts.length}
          templateCount={templates.length}
          libraryLoading={libraryLoading}
          creativeLoading={creativeLoading}
          providerAccountId={providerAccountId}
          sourceLineageLabel={sourceLineageLabel}
          desktopHref={desktopHref}
          statusMessage={scopeMessage}
        />
        <div className={styles.desktopSurface}>
          <div className={styles.workspace}>
            <LaunchpadContextBar
              businessId={businessId}
              businessName={activeBusiness?.name ?? "Meta"}
              currency={currency}
              providerAccounts={providerAccounts}
              providerAccountId={providerAccountId}
              accountLoading={providerAccountsLoading}
              onProviderAccountChange={changeProviderAccount}
            />
            <div
              className={styles.scopeBlock}
              data-testid="launchpad-account-required"
            >
              <ShieldCheck aria-hidden="true" className="h-4 w-4" />
              <div>
                <strong>Account scope required</strong>
                <p>{scopeMessage}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`ad-final meta-launchpad-final ${styles.route}`}
      data-testid="meta-launchpad-page"
    >
      <LaunchpadMobileSurface
        businessName={activeBusiness?.name ?? "Meta"}
        currency={currency}
        mode={mode}
        step={step}
        selectedCount={selectedCreativeIds.length}
        draftCount={drafts.length}
        templateCount={templates.length}
        libraryLoading={libraryLoading}
        creativeLoading={creativeLoading}
        providerAccountId={providerAccountId}
        sourceLineageLabel={sourceLineageLabel}
        desktopHref={desktopHref}
      />
      <div className={styles.desktopSurface}>
        <div className={styles.workspace}>
          <LaunchpadContextBar
            businessId={businessId}
            businessName={activeBusiness?.name ?? "Meta"}
            currency={currency}
            providerAccounts={providerAccounts}
            providerAccountId={providerAccountId}
            accountLoading={providerAccountsLoading}
            onProviderAccountChange={changeProviderAccount}
          />
          <div className={styles.wizardFrame}>
            <div className={styles.wizardHeader}>
              <div className={styles.wizardIdentity}>
                {step !== "source" && step !== "progress" ? (
                  <button
                    type="button"
                    onClick={() => setStep("source")}
                    className={styles.sourceButton}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Source
                  </button>
                ) : null}
                <div className={styles.wizardTitle}>
                  <strong>{launchpadModeLabel(mode)}</strong>
                  <span>
                    {sourceLineageLabel} · {providerAccountId} · {currency}
                  </span>
                </div>
                {wizardPrefilled ? (
                  <span className="chip chip--info">{wizardPrefillLabel}</span>
                ) : appliedTemplateMessageActive && appliedTemplateName ? (
                  <span className="chip chip--info">
                    Applied {appliedTemplateName}
                  </span>
                ) : null}
              </div>
              <div className={styles.wizardActions}>
                {templateMessage && !wizardPrefilled ? (
                  <span className={styles.saveMessage}>
                    <Cloud className="h-3.5 w-3.5 text-[var(--ok)]" />
                    {templateMessage}
                    {appliedTemplateMessageActive ? (
                      <button type="button" onClick={clearAppliedTemplate}>
                        Clear
                      </button>
                    ) : null}
                  </span>
                ) : null}
                {mode === "new_campaign" && step !== "source" ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={saveTemplate}
                    disabled={templateCapability?.canWrite !== true}
                    title={templateCapability?.canWrite === false ? "Pending account-scope database migration" : undefined}
                  >
                    <Bookmark className="h-3.5 w-3.5" />
                    Save template
                  </button>
                ) : null}
              </div>
            </div>

            <div className={styles.wizardGrid}>
              <aside className={styles.stepRail} aria-label="Launch steps">
                {step !== "progress" ? (
                  <>
                    <LaunchpadModeChooser
                      mode={mode}
                      onSelectMode={startMode}
                    />
                    <LaunchpadStepper
                      steps={activeSteps}
                      currentStep={step}
                      onSelectStep={setStep}
                    />
                  </>
                ) : (
                  <div className={styles.receiptRail}>
                    <span className="chip chip--info">
                      Provider write receipt
                    </span>
                    <p className="text-[12px] leading-relaxed text-[var(--muted)]">
                      Result state comes from the completed route response. No
                      simulated progress is shown.
                    </p>
                  </div>
                )}
              </aside>

              <main className={styles.editor}>
                {creativeError ? (
                  <div className="mb-4 rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-3 text-[13px] text-[var(--danger)]">
                    {creativeError}
                  </div>
                ) : null}

                {step === "source" ? (
                  <LaunchpadSourceStep
                    businessId={businessId}
                    providerAccountId={providerAccountId}
                    drafts={drafts}
                    templates={templates}
                    launchIntents={launchIntents}
                    launchIntentCapability={launchIntentCapability}
                    draftCapability={draftCapability}
                    templateCapability={templateCapability}
                    loading={libraryLoading}
                    message={templateMessage}
                    appliedTemplateName={
                      appliedTemplateMessageActive ? appliedTemplateName : null
                    }
                    legacyHandoff={legacyHandoff}
                    onOpenLegacyHandoff={openLegacyHandoff}
                    onApplyDraft={applyDraft}
                    onApplyTemplate={applyTemplate}
                    onClearAppliedTemplate={clearAppliedTemplate}
                    onDeleteDraft={deleteDraft}
                    onDeleteTemplate={deleteTemplate}
                  />
                ) : null}
                {step === "scope" ? (
                  <LaunchpadScopeStep
                    businessName={activeBusiness?.name ?? "Meta"}
                    providerAccountId={providerAccountId}
                    providerAccountName={
                      selectedProviderAccount?.name ?? providerAccountId
                    }
                    currency={currency}
                    mode={mode}
                    sourceLineageLabel={sourceLineageLabel}
                  />
                ) : null}
                {step === "creatives" ? (
                  <LaunchpadCreativeSelection
                    rows={launchpadCreatives}
                    selectedCreativeIds={selectedCreativeIds}
                    decisionByCreativeId={decisionByCreativeId}
                    loading={creativeLoading}
                    initialStatusFilter={
                      mode === "manage_existing" ? "all" : "active"
                    }
                    currency={currency}
                    getSelectionId={(row) =>
                      mode === "manage_existing"
                        ? resolveLaunchpadAdActionId(row)
                        : row.creativeId
                    }
                    onToggleCreative={toggleCreative}
                    onSetSelectedCreativeIds={setSelectedCreativeIds}
                  />
                ) : null}
                {step === "basics" ? (
                  mode === "new_campaign" ? (
                    <div className={styles.editorStack}>
                      <LaunchpadCampaignBasics
                        value={campaign}
                        onChange={setCampaign}
                      />
                      <LaunchpadBudget
                        value={budget}
                        currency={currency}
                        expectedCpa={null}
                        onChange={setBudget}
                      />
                    </div>
                  ) : (
                    <LaunchpadBoundaryStep
                      title={
                        mode === "add_to_existing"
                          ? "Campaign and budget are inherited"
                          : "No creation settings in this workflow"
                      }
                      description={
                        mode === "add_to_existing"
                          ? "The selected target campaign and ad set remain authoritative. Launchpad does not rewrite their budget while adding PAUSED ads."
                          : "Manage existing operates on selected ads. It does not create or edit campaign budgets."
                      }
                      rows={[
                        ["Mode", launchpadModeLabel(mode)],
                        ["Write boundary", "No budget mutation"],
                        ["Delivery", "PAUSED or risk-reducing pause only"],
                      ]}
                    />
                  )
                ) : null}
                {step === "adsets" ? (
                  mode === "new_campaign" ? (
                    <LaunchpadAdSets
                      value={adSets}
                      businessId={businessId}
                      campaignName={campaign.name}
                      budget={budget}
                      currency={currency}
                      onChange={setAdSets}
                    />
                  ) : mode === "add_to_existing" ? (
                    <LaunchpadAddToExistingTarget
                      businessId={businessId}
                      value={addToExistingTarget}
                      selectedCreatives={selectedCreatives}
                      currency={currency}
                      onChange={setAddToExistingTarget}
                    />
                  ) : (
                    <LaunchpadBoundaryStep
                      title="Selected ads define the provider scope"
                      description="Pause applies only to the exact selected Meta ad IDs. Campaign and ad-set structure remains unchanged."
                      rows={[
                        ["Selected ads", String(selectedCreativeIds.length)],
                        ["Current action", "Pause"],
                        ["ACTIVE publication", "Not available"],
                      ]}
                    />
                  )
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
                    payload={
                      mode === "add_to_existing"
                        ? addToExistingPayload
                        : payload
                    }
                    currencyCode={currency}
                    selectedCreatives={selectedCreatives}
                    decisionByCreativeId={decisionByCreativeId}
                    targetSummary={
                      mode === "add_to_existing"
                        ? {
                            campaignName:
                              selectedExistingTargets[0]?.campaign.name ?? null,
                            adsetName:
                              selectedExistingTargets[0]?.adset.name ?? null,
                            campaignCount: selectedExistingCampaigns.length,
                            targetCount: selectedExistingTargets.length,
                            currentAdCount: selectedExistingTargets.reduce(
                              (sum, target) =>
                                sum + target.adset.currentAdCount,
                              0,
                            ),
                            budgetLines: selectedExistingTargets.map(
                              ({ campaign: targetCampaign, adset }) => ({
                                label: `${targetCampaign.name} / ${adset.name}`,
                                amountMinor:
                                  adset.dailyBudgetMinor ??
                                  adset.lifetimeBudgetMinor ??
                                  targetCampaign.dailyBudgetMinor ??
                                  targetCampaign.lifetimeBudgetMinor ??
                                  null,
                                schedule:
                                  adset.dailyBudgetMinor != null ||
                                  (adset.lifetimeBudgetMinor == null &&
                                    targetCampaign.dailyBudgetMinor != null)
                                    ? ("daily" as const)
                                    : adset.lifetimeBudgetMinor != null ||
                                        targetCampaign.lifetimeBudgetMinor !=
                                          null
                                      ? ("lifetime" as const)
                                      : null,
                                source:
                                  adset.dailyBudgetMinor != null ||
                                  adset.lifetimeBudgetMinor != null
                                    ? ("ad set" as const)
                                    : targetCampaign.dailyBudgetMinor != null ||
                                        targetCampaign.lifetimeBudgetMinor !=
                                          null
                                      ? ("campaign" as const)
                                      : null,
                              }),
                            ),
                          }
                        : null
                    }
                    onSaveTemplate={
                      mode === "new_campaign" && templateCapability?.canWrite
                        ? saveTemplate
                        : undefined
                    }
                    onSaveDraft={draftCapability?.canWrite ? saveDraft : undefined}
                    onLaunch={launchPaused}
                    executionBlockedReason={
                      launchIntentCapability?.canWrite
                        ? null
                        : launchIntentCapability?.status === "migration_required"
                          ? "LaunchIntent storage migration is required before PAUSED creation can run."
                          : "LaunchIntent storage capability is still being verified."
                    }
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
            </div>

            {step !== "progress" ? (
              <div className={styles.footer}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="mono text-[12.5px] text-[var(--ink)]">
                      <strong className="font-semibold">
                        {launchpadFooterMathLine({
                          mode,
                          creativeCount: selectedCreativeIds.length,
                          adSetCount: adSets.length,
                          targetCount: selectedExistingTargets.length,
                        })}
                      </strong>
                    </div>
                    {selectionSummary.count > 0 ? (
                      <div className="mt-0.5 text-[11px] text-[var(--muted-2)] tabular-nums">
                        selection · spend{" "}
                        {selectionSummary.totalSpend == null
                          ? "unavailable"
                          : formatMoney(
                              selectionSummary.totalSpend,
                              currency,
                            )}{" "}
                        · weighted ROAS{" "}
                        {selectionSummary.averageRoas == null
                          ? "—"
                          : `${selectionSummary.averageRoas.toFixed(1)}x`}
                      </div>
                    ) : (
                      <div className="mt-0.5 text-[11px] text-[var(--muted-2)]">
                        Create changes provider state to PAUSED and cannot begin
                        delivery.
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      className="btn"
                      disabled={currentStepIndex <= 0}
                      onClick={goBack}
                    >
                      <ArrowLeft className="h-4 w-4" />
                      Back
                    </button>
                    {step === "review" ? (
                      <span className="btn btn--ghost" aria-disabled="true">
                        Launch action is in review
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={!canGoNext}
                        onClick={goNext}
                      >
                        Continue
                        <ArrowRight className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function LaunchpadMobileSurface({
  businessName,
  currency,
  providerAccountId,
  mode,
  step,
  selectedCount,
  draftCount,
  templateCount,
  libraryLoading,
  creativeLoading,
  sourceLineageLabel,
  desktopHref,
  statusMessage = null,
}: {
  businessName: string;
  currency: string | null;
  providerAccountId: string;
  mode: LaunchpadMode;
  step: WizardStep;
  selectedCount: number;
  draftCount: number;
  templateCount: number;
  libraryLoading: boolean;
  creativeLoading: boolean;
  sourceLineageLabel: string;
  desktopHref: string;
  statusMessage?: string | null;
}) {
  const loading = libraryLoading || creativeLoading;

  return (
    <section
      className={`meta-mobile-surface-stage ${styles.mobileSurface}`}
      data-testid="meta-mobile-launchpad"
      aria-label="Launchpad mobile read-only"
    >
      <header className={styles.mobileHeader}>
        <p>Launchpad · read-only</p>
        <h1>{businessName}</h1>
        <span>{launchpadModeLabel(mode)}</span>
      </header>
      <div className={styles.mobileBody}>
        {statusMessage ? (
          <div className={styles.mobileStatus} role="status">
            <ShieldCheck aria-hidden="true" className="h-4 w-4" />
            {statusMessage}
          </div>
        ) : null}
        <dl className={styles.mobileFacts}>
          <div>
            <dt>Current step</dt>
            <dd>{step}</dd>
          </div>
          <div>
            <dt>Lineage</dt>
            <dd>{sourceLineageLabel}</dd>
          </div>
          <div>
            <dt>Ad account</dt>
            <dd>{providerAccountId || "Not selected"}</dd>
          </div>
          <div>
            <dt>Currency</dt>
            <dd>{currency ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Selected</dt>
            <dd>{selectedCount}</dd>
          </div>
          <div>
            <dt>Library</dt>
            <dd>
              {loading
                ? "Loading"
                : `${draftCount} drafts · ${templateCount} templates`}
            </dd>
          </div>
        </dl>
        <div className={styles.mobilePolicy}>
          <ShieldCheck aria-hidden="true" className="h-4 w-4" />
          <p>
            No write controls are rendered on mobile. Desktop creation remains
            PAUSED-only and server validation runs before provider writes.
          </p>
        </div>
        <Link href={desktopHref} className={styles.mobileDeepLink}>
          Open this exact workflow on desktop
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}

function LaunchpadContextBar({
  businessId,
  businessName,
  currency,
  providerAccounts,
  providerAccountId,
  accountLoading,
  onProviderAccountChange,
}: {
  businessId: string;
  businessName: string;
  currency: string | null;
  providerAccounts: MetaHistoryAccount[];
  providerAccountId: string;
  accountLoading: boolean;
  onProviderAccountChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border)] pb-3">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-[var(--ink)]">
          Launchpad
        </div>
        <div className="mono mt-0.5 text-[11px] text-[var(--muted)]">
          Meta · {businessName} · {currency ?? "currency unavailable"}
        </div>
      </div>
      <span className="chip chip--warn">
        Guarded write surface — everything launches PAUSED
      </span>
      <div className="min-w-0 flex-1" />
      <label className="inline-flex h-8 items-center gap-2 rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] px-2 text-[11px] text-[var(--muted)]">
        Ad account
        <select
          aria-label="Meta ad account for Launchpad"
          value={providerAccountId}
          disabled={accountLoading}
          onChange={(event) =>
            onProviderAccountChange(event.currentTarget.value)
          }
          className="max-w-[220px] border-0 bg-transparent text-[var(--ink)] outline-none"
        >
          <option value="">
            {accountLoading
              ? "Loading accounts"
              : providerAccounts.length === 0
                ? "No assigned account"
                : "Select account"}
          </option>
          {providerAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name ?? account.id}
              {account.currency ? ` · ${account.currency}` : ""}
            </option>
          ))}
        </select>
      </label>
      <span className="chip chip--ghost">guards checked at write time</span>
      <Link
        href={buildMetaScopedHref("/platforms/meta", {
          businessId,
          providerAccountId,
        })}
        className="text-[12px] font-medium text-[var(--info)] hover:text-[var(--ink)]"
      >
        ← Decisions
      </Link>
    </div>
  );
}

function formatLaunchpadPrefillLabel(
  handoff: LaunchpadLegacyHandoff,
  selectedCount: number,
) {
  const action =
    handoff.requestedMode === "duplicate"
      ? "duplicate"
      : handoff.requestedMode === "apply_bid"
        ? "apply bid"
        : "rebuild";
  const count = Math.max(1, selectedCount);
  return `${hasVerifiedLaunchpadLineage(handoff) ? "Verified lineage" : "Legacy prefill"} · ${handoff.source} · ${action} · ${count} creative${count === 1 ? "" : "s"}`;
}

function launchpadFooterMathLine(input: {
  mode: LaunchpadMode;
  creativeCount: number;
  adSetCount: number;
  targetCount: number;
}) {
  if (input.mode === "new_campaign") {
    return `${input.creativeCount} creatives × ${input.adSetCount} ad set${input.adSetCount === 1 ? "" : "s"} = ${
      input.creativeCount * input.adSetCount
    } ads`;
  }
  if (input.mode === "add_to_existing") {
    const targetCount = Math.max(1, input.targetCount);
    return `${input.creativeCount} creatives × ${targetCount} target${targetCount === 1 ? "" : "s"} = ${
      input.creativeCount * targetCount
    } ads`;
  }
  return `${input.creativeCount} selected ads · PAUSE is current · ACTIVE is contract-required`;
}

function LaunchpadModeChooser({
  mode,
  onSelectMode,
}: {
  mode: LaunchpadMode;
  onSelectMode: (mode: LaunchpadMode) => void;
}) {
  const modes: Array<{
    id: LaunchpadMode;
    label: string;
    icon: typeof Megaphone;
  }> = [
    { id: "new_campaign", label: "New campaign", icon: Megaphone },
    { id: "add_to_existing", label: "Add to existing", icon: PlusCircle },
    { id: "manage_existing", label: "Pause existing ads", icon: Settings2 },
  ];
  return (
    <div className={styles.modeChooser} data-testid="launchpad-mode-selector">
      <span>Workflow</span>
      {modes.map((item) => {
        const Icon = item.icon;
        return (
          <button
            type="button"
            className={styles.modeButton}
            data-active={mode === item.id ? "true" : "false"}
            aria-pressed={mode === item.id}
            key={item.id}
            onClick={() => onSelectMode(item.id)}
          >
            <Icon aria-hidden="true" className="h-3.5 w-3.5" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function LaunchpadScopeStep({
  businessName,
  providerAccountId,
  providerAccountName,
  currency,
  mode,
  sourceLineageLabel,
}: {
  businessName: string;
  providerAccountId: string;
  providerAccountName: string;
  currency: string;
  mode: LaunchpadMode;
  sourceLineageLabel: string;
}) {
  return (
    <section className={styles.scopePanel} data-testid="launchpad-scope-step">
      <div className={styles.editorHeading}>
        <div>
          <p>Account & scope</p>
          <h2>Confirm the provider boundary</h2>
        </div>
        <span className="chip chip--healthy">Explicit scope</span>
      </div>
      <dl className={styles.scopeFacts}>
        <div>
          <dt>Business</dt>
          <dd>{businessName}</dd>
        </div>
        <div>
          <dt>Meta ad account</dt>
          <dd>
            {providerAccountName} · {providerAccountId}
          </dd>
        </div>
        <div>
          <dt>Currency</dt>
          <dd>{currency}</dd>
        </div>
        <div>
          <dt>Workflow</dt>
          <dd>{launchpadModeLabel(mode)}</dd>
        </div>
        <div>
          <dt>Lineage</dt>
          <dd>{sourceLineageLabel}</dd>
        </div>
        <div>
          <dt>Write posture</dt>
          <dd>Server validation · guard check · PAUSED creation</dd>
        </div>
      </dl>
      <p className={styles.boundaryNote}>
        Currency is never inferred across accounts. Provider writes remain
        blocked if this account scope or its currency becomes unreadable.
      </p>
    </section>
  );
}

function LaunchpadBoundaryStep({
  title,
  description,
  rows,
}: {
  title: string;
  description: string;
  rows: Array<[string, string]>;
}) {
  return (
    <section className={styles.boundaryPanel}>
      <div className={styles.editorHeading}>
        <div>
          <p>Workflow boundary</p>
          <h2>{title}</h2>
        </div>
        <ShieldCheck aria-hidden="true" className="h-4 w-4" />
      </div>
      <p className={styles.boundaryDescription}>{description}</p>
      <dl className={styles.boundaryFacts}>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function LaunchpadSourceStep({
  businessId,
  providerAccountId,
  drafts,
  templates,
  launchIntents,
  launchIntentCapability,
  draftCapability,
  templateCapability,
  loading,
  message,
  appliedTemplateName,
  legacyHandoff,
  onOpenLegacyHandoff,
  onApplyDraft,
  onApplyTemplate,
  onClearAppliedTemplate,
  onDeleteDraft,
  onDeleteTemplate,
}: {
  businessId: string;
  providerAccountId: string;
  drafts: LaunchDraft[];
  templates: LaunchTemplate[];
  launchIntents: MetaLaunchIntent[];
  launchIntentCapability: MetaLaunchIntentCapability | null;
  draftCapability: MetaLaunchStoreCapability | null;
  templateCapability: MetaLaunchStoreCapability | null;
  loading: boolean;
  message: string | null;
  appliedTemplateName: string | null;
  legacyHandoff: LaunchpadLegacyHandoff | null;
  onOpenLegacyHandoff: () => void;
  onApplyDraft: (draft: LaunchDraft) => void;
  onApplyTemplate: (template: LaunchTemplate) => void;
  onClearAppliedTemplate: () => void;
  onDeleteDraft: (draftId: string) => Promise<void>;
  onDeleteTemplate: (template: LaunchTemplate) => Promise<void>;
}) {
  const verifiedHandoff = hasVerifiedLaunchpadLineage(legacyHandoff);
  const applyBidUnsupported = legacyHandoff?.requestedMode === "apply_bid";
  return (
    <>
      <section
        className={styles.sourcePanel}
        data-testid="launchpad-source-step"
      >
        <div className={styles.sourceHeading}>
          <div>
            <p>Source</p>
            <h2>Continue from evidence or start manually</h2>
          </div>
          <span className="chip chip--warn">Creates PAUSED</span>
        </div>
        <div className={styles.sourceRows}>
          <div className={styles.sourceRow}>
            <ListChecks aria-hidden="true" className="h-4 w-4" />
            <div>
              <strong>Decision handoff</strong>
              <span>Decision and snapshot lineage are required.</span>
            </div>
            {legacyHandoff?.source === "decision" ? (
              <button
                type="button"
                className="btn btn--sm"
                onClick={onOpenLegacyHandoff}
              >
                {applyBidUnsupported
                  ? "Review handoff limit"
                  : verifiedHandoff
                    ? "Continue verified handoff"
                    : "Use prefill"}
              </button>
            ) : (
              <Link href={buildMetaScopedHref("/platforms/meta", { businessId, providerAccountId })} className="btn btn--sm">
                Decisions
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
          <div className={styles.sourceRow}>
            <FileCheck2 aria-hidden="true" className="h-4 w-4" />
            <div>
              <strong>Reviewed brief</strong>
              <span>Reviewed Creative Brief lineage is preserved.</span>
            </div>
            {legacyHandoff?.source === "brief" ? (
              <button
                type="button"
                className="btn btn--sm"
                onClick={onOpenLegacyHandoff}
              >
                {applyBidUnsupported
                  ? "Review handoff limit"
                  : verifiedHandoff
                    ? "Continue reviewed brief"
                    : "Use prefill"}
              </button>
            ) : (
              <Link href={buildMetaScopedHref("/platforms/meta/creatives", { businessId, providerAccountId })} className="btn btn--sm">
                Creative Studio
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
          <div className={styles.sourceRow}>
            <FileEdit aria-hidden="true" className="h-4 w-4" />
            <div>
              <strong>Manual or saved setup</strong>
              <span>
                Choose the workflow mode in the step rail or resume below.
              </span>
            </div>
            <span className="chip chip--ghost">Available</span>
          </div>
        </div>
      </section>

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

      <div className={styles.libraryGrid}>
        <LaunchpadLibraryCard
          icon={<FileEdit className="h-4 w-4 text-[var(--muted)]" />}
          title="Drafts"
          count={launchpadLibraryCount({
            rowCount: drafts.length,
            loading,
            capabilityStatus: draftCapability?.status ?? null,
          })}
        >
          {draftCapability?.status === "migration_required" ? (
            <p className="px-4 py-3 text-[13px] text-[var(--warn)]">
              Draft storage requires the pending account-scope database migration. Save and delete are disabled.
            </p>
          ) : null}
          {loading && drafts.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-[var(--muted)]">
              Loading drafts...
            </p>
          ) : null}
          {!loading && drafts.length === 0 && draftCapability?.status !== "migration_required" ? (
            <p className="px-4 py-3 text-[13px] text-[var(--muted)]">
              No drafts yet.
            </p>
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
                        <span className="block truncate text-[13px] font-medium text-[var(--ink)]">
                          {draft.name}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-[var(--muted)]">
                          {summarizeDraft(draft)}
                        </span>
                      </span>
                      <span className="hidden shrink-0 items-center gap-2 text-right text-[11px] text-[var(--muted)] sm:flex">
                        {formatRelativeTime(draft.updatedAt)}
                        {failed ? (
                          <span className="chip chip--action">
                            <span className="dot" />
                            Failed
                          </span>
                        ) : (
                          <span className="chip chip--ghost">Resume</span>
                        )}
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
                      <div className="mono text-[11px] text-[var(--danger)]">
                        stored error: {storedError}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                        The error is the server&apos;s, rendered verbatim. Fix
                        it, then resume.
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </LaunchpadLibraryCard>

        <LaunchpadLibraryCard
          icon={<LayoutTemplate className="h-4 w-4 text-[var(--muted)]" />}
          title="Templates"
          count={launchpadLibraryCount({
            rowCount: templates.length,
            loading,
            capabilityStatus: templateCapability?.status ?? null,
          })}
        >
          {templateCapability?.status === "migration_required" ? (
            <p className="px-4 py-3 text-[13px] text-[var(--warn)]">
              Saved templates require the pending account-scope migration. Recent account structures remain available below.
            </p>
          ) : null}
          {loading && templates.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-[var(--muted)]">
              Loading templates...
            </p>
          ) : null}
          {!loading && templates.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-[var(--muted)]">
              No templates yet.
            </p>
          ) : null}
          <div className="divide-y divide-[var(--border)]">
            {templates.map((template) => (
              <div
                key={`${template.source}-${template.id}`}
                className="group flex w-full items-center gap-3 px-4 py-3 transition hover:bg-[var(--hover)]"
              >
                <button
                  type="button"
                  onClick={() => onApplyTemplate(template)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--surface-3)] text-[var(--ink-3)]">
                    <LayoutTemplate className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-[13px] font-medium text-[var(--ink)]">
                        {template.name}
                      </span>
                      {template.source === "auto_recent" ? (
                        <span className="chip chip--auto shrink-0">
                          <Sparkles className="h-3 w-3" />
                          Auto
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-[var(--muted)]">
                      {template.description ?? summarizeTemplate(template)}
                    </span>
                    {template.source === "auto_recent" ? (
                      <span className="mt-1 flex flex-wrap gap-1.5">
                        <span className="mono rounded-[4px] border border-dashed border-[var(--border-3)] px-1.5 py-0.5 text-[12px] text-[var(--muted)]">
                          budget: placeholder — set at use
                        </span>
                        <span className="mono rounded-[4px] border border-dashed border-[var(--border-3)] px-1.5 py-0.5 text-[12px] text-[var(--muted)]">
                          countries: placeholder
                        </span>
                      </span>
                    ) : null}
                  </span>
                  <span className="hidden shrink-0 text-right text-[11px] text-[var(--muted)] sm:block">
                    <span className="chip chip--ghost">Use</span>
                  </span>
                </button>
                {template.source === "manual" && templateCapability?.canWrite ? (
                  <button
                    type="button"
                    onClick={() => {
                      void onDeleteTemplate(template);
                    }}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--muted-2)] opacity-80 transition hover:bg-[var(--danger-bg)] hover:text-[var(--danger)] group-hover:opacity-100"
                    aria-label={`Delete template ${template.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </LaunchpadLibraryCard>

        <LaunchpadLibraryCard
          icon={<FileCheck2 className="h-4 w-4 text-[var(--muted)]" />}
          title="Launch records"
          count={launchpadLibraryCount({
            rowCount: launchIntents.length,
            loading,
            capabilityStatus: launchIntentCapability?.status ?? null,
          })}
        >
          {loading && launchIntents.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-[var(--muted)]">
              Loading launch lineage...
            </p>
          ) : null}
          {!loading && launchIntents.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-[var(--muted)]">
              {launchIntentCapability?.status === "migration_required"
                ? "Launch records are unavailable until the pending LaunchIntent database migration is applied."
                : launchIntentCapability?.status === "ready"
                  ? "No account-scoped launch records yet."
                  : "Launch record storage capability is unavailable."}
            </p>
          ) : null}
          <LaunchIntentReceiptRows intents={launchIntents} />
        </LaunchpadLibraryCard>
      </div>

      <p className="text-[12px] leading-relaxed text-[var(--muted)]">
        Launchpad currently supports Sales campaigns only. Create paths land
        PAUSED. Activation inside Adsecute is Proposed/contract required and no
        current one-click ACTIVE action is rendered.
      </p>
    </>
  );
}

function LaunchpadLibraryCard({
  icon,
  title,
  count,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number | "Loading" | "Unavailable";
  children: ReactNode;
}) {
  return (
    <details className={styles.librarySection}>
      <summary className={styles.librarySummary}>
        {icon}
        <strong>{title}</strong>
        <span>{count}</span>
      </summary>
      <div className={styles.libraryBody}>{children}</div>
    </details>
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
    <ol className={styles.stepList}>
      {steps.map((item, index) => {
        const active = item.id === currentStep;
        const done = currentIndex >= 0 && index < currentIndex;
        const gated = currentIndex >= 0 && index > currentIndex;
        return (
          <li key={item.id} className={styles.stepItem}>
            <button
              type="button"
              onClick={() => onSelectStep(item.id)}
              disabled={gated}
              className={cn(
                styles.stepButton,
                active ? "bg-[var(--surface-3)]" : "",
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
                  styles.stepLabel,
                  "min-w-0 truncate text-[12px]",
                  active
                    ? "font-semibold text-[var(--ink)]"
                    : done
                      ? "text-[var(--ink-3)]"
                      : "text-[var(--muted)]",
                )}
              >
                {item.label}
              </span>
            </button>
            {index < steps.length - 1 ? (
              <span
                className={cn(
                  styles.stepConnector,
                  done ? "bg-[var(--ink)]" : "bg-[var(--border)]",
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
