"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, LayoutTemplate } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAppStore } from "@/store/app-store";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import {
  fetchCreativeDecisionEngineV3,
  fetchMetaCreatives,
  mapApiRowToUiRow,
} from "@/app/(dashboard)/creatives/page-support";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import {
  amountFromMinorUnits,
  amountToMinorUnits,
  normalizeMetaLaunchPayload,
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

type LaunchpadMode = "new_campaign" | "add_to_existing";
type WizardStep = "creatives" | "basics" | "budget" | "adsets" | "target" | "review" | "progress";

interface LaunchTemplate {
  id: string;
  name: string;
  description: string | null;
  source: "manual" | "auto_recent";
  payload: MetaLaunchPayload;
}

const MODE_A_STEPS: Array<{ id: WizardStep; label: string }> = [
  { id: "creatives", label: "Creatives" },
  { id: "basics", label: "Basics" },
  { id: "budget", label: "Budget" },
  { id: "adsets", label: "Ad sets" },
  { id: "review", label: "Review" },
  { id: "progress", label: "Progress" },
];

const MODE_B_STEPS: Array<{ id: WizardStep; label: string }> = [
  { id: "creatives", label: "Creatives" },
  { id: "target", label: "Target" },
  { id: "review", label: "Review" },
  { id: "progress", label: "Progress" },
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

export default function MetaLaunchpadPage() {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const activeBusiness = businesses.find((business) => business.id === selectedBusinessId);
  const businessId = selectedBusinessId ?? "";
  const currency = activeBusiness?.currency ?? "USD";

  const [step, setStep] = useState<WizardStep>("creatives");
  const [mode, setMode] = useState<LaunchpadMode>("new_campaign");
  const [creatives, setCreatives] = useState<MetaCreativeRow[]>([]);
  const [creativeLoading, setCreativeLoading] = useState(false);
  const [creativeError, setCreativeError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<DecisionOutput[]>([]);
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
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);
  const [launchLoading, setLaunchLoading] = useState(false);
  const [launchResult, setLaunchResult] = useState<LaunchpadProgressResult | null>(null);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    setCreativeLoading(true);
    setCreativeError(null);
    fetchMetaCreatives({
      businessId,
      start: isoDateDaysAgo(29),
      end: todayIso(),
      groupBy: "creative",
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
    Promise.all([
      fetch(`/api/launchpad/meta/templates?businessId=${encodeURIComponent(businessId)}`).then((res) => res.json()),
      fetch(`/api/launchpad/meta/templates/recent?businessId=${encodeURIComponent(businessId)}`).then((res) => res.json()),
    ])
      .then(([manual, recent]) => {
        if (cancelled) return;
        const manualTemplates = Array.isArray(manual?.templates) ? manual.templates : [];
        const recentTemplates = Array.isArray(recent?.templates) ? recent.templates : [];
        setTemplates([...recentTemplates, ...manualTemplates]);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const decisionByCreativeId = useMemo(
    () => new Map(decisions.map((decision) => [decision.creativeId, decision])),
    [decisions],
  );
  const selectedCreatives = useMemo(() => {
    const selected = new Set(selectedCreativeIds);
    return creatives.filter((creative) => selected.has(creative.creativeId));
  }, [creatives, selectedCreativeIds]);

  const payload = useMemo(
    () =>
      normalizeMetaLaunchPayload({
        mode: "new_campaign",
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
    [adSets, budget, campaign, selectedCreatives],
  );
  const addToExistingPayload = useMemo(
    () => ({
      mode: "add_to_existing" as const,
      targetCampaignId: addToExistingTarget.targetCampaign?.id ?? "",
      targetAdsetId: addToExistingTarget.targetAdset?.id ?? "",
      targetCampaignName: addToExistingTarget.targetCampaign?.name ?? null,
      targetAdsetName: addToExistingTarget.targetAdset?.name ?? null,
      creativeIds: selectedCreatives.map((creative) => creative.creativeId),
      creatives: selectedCreatives.map((creative) => ({
        creativeId: creative.creativeId,
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
    }),
    [addToExistingTarget, selectedCreatives],
  );

  const activeSteps = mode === "add_to_existing" ? MODE_B_STEPS : MODE_A_STEPS;
  const currentStepIndex = activeSteps.findIndex((item) => item.id === step);
  const canGoNext =
    step === "creatives"
      ? selectedCreativeIds.length > 0
      : step === "target"
        ? Boolean(addToExistingTarget.targetCampaign && addToExistingTarget.targetAdset)
      : step === "basics"
        ? campaign.name.trim().length > 0
        : step !== "progress";

  const toggleCreative = useCallback((row: MetaCreativeRow) => {
    setSelectedCreativeIds((prev) => {
      if (prev.includes(row.creativeId)) {
        return prev.filter((id) => id !== row.creativeId);
      }
      return [...prev, row.creativeId];
    });
  }, []);

  function goNext() {
    const next = activeSteps[Math.min(currentStepIndex + 1, activeSteps.length - 1)];
    if (next) setStep(next.id);
  }

  function goBack() {
    const prev = activeSteps[Math.max(currentStepIndex - 1, 0)];
    if (prev) setStep(prev.id);
  }

  function modeHasState(activeMode: LaunchpadMode) {
    if (selectedCreativeIds.length > 0 || launchResult) return true;
    if (activeMode === "add_to_existing") {
      return Boolean(
        addToExistingTarget.targetCampaign ||
          addToExistingTarget.targetAdset ||
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

  function switchMode(nextMode: LaunchpadMode) {
    if (nextMode === mode) return;
    const dirty = modeHasState(mode);
    if (
      dirty &&
      typeof window !== "undefined" &&
      !window.confirm("Switch launch modes and reset the current wizard state?")
    ) {
      return;
    }
    setMode(nextMode);
    setSelectedCreativeIds([]);
    setAddToExistingTarget(makeDefaultAddToExistingTargetState());
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

  function applyTemplate(template: LaunchTemplate) {
    const next = normalizeMetaLaunchPayload(template.payload);
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
    const existingCreativeIds = new Set(creatives.map((creative) => creative.creativeId));
    const templateCreativeIds = next.creativeIds.filter((creativeId) =>
      existingCreativeIds.has(creativeId),
    );
    if (templateCreativeIds.length > 0) setSelectedCreativeIds(templateCreativeIds);
    setTemplateMessage(`Applied ${template.name}`);
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
    setTemplateMessage(response.ok ? "Template saved" : "Template save failed");
  }

  async function saveDraft() {
    const response = await fetch("/api/launchpad/meta/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId,
        name:
          mode === "add_to_existing"
            ? `Add to ${addToExistingTarget.targetAdset?.name ?? "existing ad set"}`
            : campaign.name || defaultCampaignName(),
        payload: mode === "add_to_existing" ? addToExistingPayload : payload,
      }),
    });
    setTemplateMessage(response.ok ? "Draft saved" : "Draft save failed");
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
                creativeIds: addToExistingPayload.creativeIds,
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

  function resetWizard() {
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

  if (!businessId) {
    return <div className="text-sm text-muted-foreground">Select a business.</div>;
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6" data-testid="meta-launchpad-page">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Meta Launchpad</h1>
          <p className="text-sm text-muted-foreground">
            {mode === "add_to_existing"
              ? `${addToExistingPayload.creatives.length} creatives -> existing ad set`
              : `${payload.adSets.length} ad sets x ${payload.creatives.length} creatives = ${
                  payload.adSets.length * payload.creatives.length
                } ads`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">OUTCOME_SALES</Badge>
          <Badge variant="outline">PAUSED</Badge>
        </div>
      </div>

      <div className="inline-flex w-fit rounded-md border bg-muted p-1" data-testid="launchpad-mode-selector">
        <button
          type="button"
          onClick={() => switchMode("new_campaign")}
          className={`rounded px-3 py-1.5 text-sm ${
            mode === "new_campaign" ? "bg-background font-medium shadow-sm" : "text-muted-foreground"
          }`}
        >
          Launch new campaign
        </button>
        <button
          type="button"
          onClick={() => switchMode("add_to_existing")}
          className={`rounded px-3 py-1.5 text-sm ${
            mode === "add_to_existing" ? "bg-background font-medium shadow-sm" : "text-muted-foreground"
          }`}
        >
          Add to existing campaign
        </button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[260px_1fr]">
        <aside className="space-y-4">
          <div className="rounded-md border p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Steps
            </p>
            <div className="space-y-1">
              {activeSteps.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={item.id === "progress" && step !== "progress"}
                  onClick={() => setStep(item.id)}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${
                    item.id === step
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                >
                  <span>{item.label}</span>
                  <span className="text-xs">{index + 1}</span>
                </button>
              ))}
            </div>
          </div>

          {mode === "new_campaign" ? (
          <div className="rounded-md border p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <LayoutTemplate className="h-4 w-4" />
              Templates
            </div>
            <div className="space-y-2">
              {templates.slice(0, 8).map((template) => (
                <button
                  key={`${template.source}-${template.id}`}
                  type="button"
                  onClick={() => applyTemplate(template)}
                  className="w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <span className="block font-medium">{template.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {template.source === "auto_recent" ? "Recent" : "Manual"}
                    {template.description ? ` / ${template.description}` : ""}
                  </span>
                </button>
              ))}
              {templates.length === 0 ? (
                <p className="text-sm text-muted-foreground">No templates yet.</p>
              ) : null}
            </div>
            {templateMessage ? (
              <p className="mt-3 text-xs text-muted-foreground">{templateMessage}</p>
            ) : null}
          </div>
          ) : null}
        </aside>

        <main className="rounded-md border bg-background p-5">
          {creativeError ? (
            <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              {creativeError}
            </div>
          ) : null}

          {step === "creatives" ? (
            <LaunchpadCreativeSelection
              rows={creatives}
              selectedCreativeIds={selectedCreativeIds}
              decisionByCreativeId={decisionByCreativeId}
              loading={creativeLoading}
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
          {step === "review" ? (
            <LaunchpadReview
              mode={mode}
              businessId={businessId}
              payload={mode === "add_to_existing" ? addToExistingPayload : payload}
              selectedCreatives={selectedCreatives}
              decisionByCreativeId={decisionByCreativeId}
              targetSummary={
                mode === "add_to_existing"
                  ? {
                      campaignName: addToExistingTarget.targetCampaign?.name ?? null,
                      adsetName: addToExistingTarget.targetAdset?.name ?? null,
                      currentAdCount: addToExistingTarget.targetAdset?.currentAdCount ?? null,
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

          {step !== "progress" ? (
            <div className="mt-6 flex items-center justify-between border-t pt-4">
              <Button
                type="button"
                variant="outline"
                disabled={currentStepIndex === 0}
                onClick={goBack}
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <Button type="button" disabled={!canGoNext} onClick={goNext}>
                Next
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
