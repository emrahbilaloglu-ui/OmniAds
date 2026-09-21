"use client";

/**
 * The data boundary for Commercial Truth.
 *
 * Every fact the design draws is read from a real endpoint here:
 *  - the target pack and legacy cost-model context from
 *    `/api/business-commercial-settings`;
 *  - the versioned, composable cost authority from
 *    `/api/business-commerce-cost-structure`;
 *  - window spend and revenue from `/api/overview-summary`, which is what makes
 *    the blended-MER slice of the revenue split honest;
 *  - campaign spend from both `/api/meta/campaigns` and
 *    `/api/google-ads/campaigns`, so "all labeled spend" means all of it;
 *  - the change log from `/api/business-commercial-settings/history`.
 *
 * Every windowed read is issued with the explicit 28-day range the screen's
 * labels claim (see `commercial-truth-window.ts`); none of them is left to its
 * route's 30-day default.
 *
 * Nothing is defaulted. A pack without a target ROAS produces bands with no
 * range and rows with no verdict, because a verdict computed against a guessed
 * anchor would be a fabricated decision.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CommercialTruthExact } from "@/components/commercial-truth/CommercialTruthExact";
import {
  CommerceCostModelEditor,
  type CommerceCostModelSource,
} from "@/components/commercial-truth/CommerceCostModelEditor";
import { ShopifyCostSourcePanel } from "@/components/commercial-truth/ShopifyCostSourcePanel";
import {
  buildCommercialTruthExactModel,
  type CommercialTruthCampaignSource,
  type CommercialTruthHistorySource,
} from "@/components/commercial-truth/commercial-truth-exact-adapter";
import {
  TRUTH_DASH,
  type CommercialTruthFieldId,
} from "@/components/commercial-truth/commercial-truth-exact-model";
import { buildCommercialTruthWindow } from "@/components/commercial-truth/commercial-truth-window";
import type { BreakEvenRoasPreview } from "@/lib/commerce-cost/break-even-preview";
import {
  createEmptyTargetPack,
  type BusinessCommercialTruthSnapshot,
} from "@/src/types/business-commercial";
import type {
  CommerceCostStructure,
  CostStructureIssue,
} from "@/src/types/commerce-cost";
import { useAppStore } from "@/store/app-store";

type DraftMap = Partial<Record<CommercialTruthFieldId, string>>;

interface SettingsResponse {
  snapshot?: BusinessCommercialTruthSnapshot | null;
  revision?: string | null;
  permissions?: { canEdit?: boolean } | null;
  message?: string;
}

interface CostStructureResponse {
  structure?: CommerceCostStructure | null;
  source?: CommerceCostModelSource;
  revision?: string | null;
  issues?: CostStructureIssue[];
  unreadableLegacySources?: string[];
  ambiguousLegacyZeros?: string[];
  storage?: { ready?: boolean; missingTables?: string[] } | null;
  permissions?: { canEdit?: boolean } | null;
  message?: string;
  currentRevision?: string | null;
}

interface OverviewPin {
  id: string;
  value: number | null;
}

interface BreakEvenPreviewResponse {
  preview?: BreakEvenRoasPreview | null;
  message?: string;
}

/** Parses "62%", "$58.00" and "3.80" without inventing a value for "" or "—". */
function parseLooseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === TRUTH_DASH) return null;
  const parsed = Number.parseFloat(trimmed.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function CommercialTruthScreen({
  businessId,
  showHeader = true,
}: {
  businessId: string;
  showHeader?: boolean;
}) {
  const business = useAppStore((state) =>
    state.businesses.find((candidate) => candidate.id === businessId),
  );

  const [snapshot, setSnapshot] = useState<BusinessCommercialTruthSnapshot | null>(null);
  const [snapshotBusinessId, setSnapshotBusinessId] = useState<string | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [history, setHistory] = useState<CommercialTruthHistorySource[]>([]);
  const [actor, setActor] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<CommercialTruthCampaignSource[]>([]);
  const [windowTotals, setWindowTotals] = useState<{
    spend: number | null;
    revenue: number | null;
  }>({ spend: null, revenue: null });
  const [costStructure, setCostStructure] = useState<CommerceCostStructure | null>(null);
  const [costBusinessId, setCostBusinessId] = useState<string | null>(null);
  const [costDraft, setCostDraft] = useState<CommerceCostStructure | null>(null);
  const [costSource, setCostSource] = useState<CommerceCostModelSource>("empty");
  const [costRevision, setCostRevision] = useState<string | null>(null);
  const [costIssues, setCostIssues] = useState<CostStructureIssue[]>([]);
  const [costSourceWarnings, setCostSourceWarnings] = useState<string[]>([]);
  const [costCanEdit, setCostCanEdit] = useState(false);
  const [costSaving, setCostSaving] = useState(false);
  const [costError, setCostError] = useState<string | null>(null);
  const [breakEvenPreview, setBreakEvenPreview] = useState<BreakEvenRoasPreview | null>(null);
  const [breakEvenPreviewLoading, setBreakEvenPreviewLoading] = useState(false);
  const [breakEvenPreviewError, setBreakEvenPreviewError] = useState<string | null>(null);
  const [costCatalogRevision, setCostCatalogRevision] = useState(0);
  const snapshotLoadSequence = useRef(0);
  const costLoadSequence = useRef(0);
  const currentBusinessIdRef = useRef(businessId);
  currentBusinessIdRef.current = businessId;

  const loadSnapshot = useCallback(async () => {
    const sequence = ++snapshotLoadSequence.current;
    setSnapshotBusinessId(null);
    setSnapshot(null);
    setRevision(null);
    setCanEdit(false);
    setDrafts({});
    try {
      const response = await fetch(
        `/api/business-commercial-settings?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as SettingsResponse | null;
      if (sequence !== snapshotLoadSequence.current || currentBusinessIdRef.current !== businessId) return;
      if (!response.ok || !payload?.snapshot) {
        throw new Error(payload?.message ?? "Could not load the target pack.");
      }
      setSnapshot(payload.snapshot);
      setSnapshotBusinessId(businessId);
      setRevision(typeof payload.revision === "string" ? payload.revision : null);
      setCanEdit(Boolean(payload.permissions?.canEdit));
      setDrafts({});
      setError(null);
    } catch (loadError: unknown) {
      if (sequence !== snapshotLoadSequence.current || currentBusinessIdRef.current !== businessId) return;
      setSnapshot(null);
      setSnapshotBusinessId(null);
      setRevision(null);
      setCanEdit(false);
      setError(loadError instanceof Error ? loadError.message : "Could not load the target pack.");
    }
  }, [businessId]);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/business-commercial-settings/history?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as {
        entries?: CommercialTruthHistorySource[];
      } | null;
      const entries = payload?.entries ?? [];
      setHistory(entries);
      setActor(entries.find((entry) => entry.actor)?.actor ?? null);
    } catch {
      setHistory([]);
      setActor(null);
    }
  }, [businessId]);

  const loadCostStructure = useCallback(async () => {
    const sequence = ++costLoadSequence.current;
    setCostBusinessId(null);
    setCostStructure(null);
    setCostDraft(null);
    setCostRevision(null);
    setCostCanEdit(false);
    try {
      const response = await fetch(
        `/api/business-commerce-cost-structure?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as CostStructureResponse | null;
      if (sequence !== costLoadSequence.current || currentBusinessIdRef.current !== businessId) return;
      if (!response.ok || !payload?.structure || !payload.source) {
        throw new Error(payload?.message ?? "Could not load the cost model.");
      }
      setCostStructure(payload.structure);
      setCostDraft(payload.structure);
      setCostBusinessId(businessId);
      setCostSource(payload.source);
      setCostRevision(typeof payload.revision === "string" ? payload.revision : null);
      setCostIssues(payload.issues ?? []);
      setCostSourceWarnings([
        ...(payload.storage?.ready === false
          ? [
              "Versioned cost-model storage is not ready yet. This is a read-only preview from the current cost settings; saving stays disabled until migrations are applied.",
            ]
          : []),
        ...(payload.ambiguousLegacyZeros?.length
          ? [
              "Some zeroes from the old cost form were left as gaps because that form could not distinguish a default from a real zero.",
            ]
          : []),
        ...(payload.unreadableLegacySources?.length
          ? ["Some legacy cost settings could not be read. Review the missing families before saving."]
          : []),
      ]);
      setCostCanEdit(Boolean(payload.permissions?.canEdit));
      setCostError(null);
    } catch (loadError: unknown) {
      if (sequence !== costLoadSequence.current || currentBusinessIdRef.current !== businessId) return;
      setCostStructure(null);
      setCostDraft(null);
      setCostBusinessId(null);
      setCostRevision(null);
      setCostIssues([]);
      setCostSourceWarnings([]);
      setCostCanEdit(false);
      setCostError(
        loadError instanceof Error ? loadError.message : "Could not load the cost model.",
      );
    }
  }, [businessId]);

  const loadWindow = useCallback(async () => {
    try {
      const truthWindow = buildCommercialTruthWindow(business?.timezone ?? null);
      const response = await fetch(
        `/api/overview-summary?businessId=${encodeURIComponent(businessId)}` +
          `&startDate=${truthWindow.startDate}&endDate=${truthWindow.endDate}`,
      );
      const payload = (await response.json().catch(() => null)) as {
        summary?: { pins?: OverviewPin[] } | null;
      } | null;
      const pins = payload?.summary?.pins ?? [];
      setWindowTotals({
        spend: finite(pins.find((pin) => pin.id === "pins-spend")?.value),
        revenue: finite(pins.find((pin) => pin.id === "pins-revenue")?.value),
      });
    } catch {
      setWindowTotals({ spend: null, revenue: null });
    }
  }, [business?.timezone, businessId]);

  const loadCampaigns = useCallback(async () => {
    const truthWindow = buildCommercialTruthWindow(business?.timezone ?? null);
    const query = `businessId=${encodeURIComponent(businessId)}`;
    const [meta, google] = await Promise.all([
      // Meta takes the window as explicit dates.
      fetch(
        `/api/meta/campaigns?${query}&startDate=${truthWindow.startDate}&endDate=${truthWindow.endDate}`,
      )
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null),
      // Google's preset ranges have no 28, so the same window goes as a custom
      // one — `getDateRangeForQuery` returns customStart/customEnd verbatim.
      fetch(
        `/api/google-ads/campaigns?${query}&dateRange=custom` +
          `&customStart=${truthWindow.startDate}&customEnd=${truthWindow.endDate}&compareMode=none`,
      )
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null),
    ]);

    const metaRows = Array.isArray((meta as { rows?: unknown[] } | null)?.rows)
      ? ((meta as { rows: Array<Record<string, unknown>> }).rows ?? [])
      : [];
    const googleRows = Array.isArray((google as { rows?: unknown[] } | null)?.rows)
      ? ((google as { rows: Array<Record<string, unknown>> }).rows ?? [])
      : [];

    // The design's `level` is the entity the row IS, and both readers serve
    // campaign rows exclusively — `/api/meta/campaigns` returns one row per
    // campaign, and so does `/api/google-ads/campaigns`. It is emphatically not
    // `budgetLevel`, which says where the BUDGET sits (lib/meta/live.ts:354
    // sets it to "campaign" only when a campaign-level budget exists), so
    // reading it as the entity level printed "Meta · Ad set" on every campaign
    // in a demo workspace.
    setCampaigns([
      ...metaRows.map((row, index) => ({
        id: `meta:${String(row.id ?? index)}`,
        name: String(row.name ?? TRUTH_DASH),
        platform: "Meta" as const,
        level: "Campaign",
        spend: finite(row.spend),
        revenue: finite(row.revenue),
        roas: finite(row.roas),
      })),
      ...googleRows.map((row, index) => ({
        id: `google:${String(row.id ?? index)}`,
        name: String(row.name ?? TRUTH_DASH),
        platform: "Google" as const,
        level: "Campaign",
        spend: finite(row.spend),
        revenue: finite(row.revenue),
        roas: finite(row.roas),
      })),
    ]);
  }, [business?.timezone, businessId]);

  useEffect(() => {
    void loadSnapshot();
    void loadHistory();
    void loadCostStructure();
    void loadWindow();
    void loadCampaigns();
  }, [loadCampaigns, loadCostStructure, loadHistory, loadSnapshot, loadWindow]);

  useEffect(() => {
    if (!costDraft || costBusinessId !== businessId) {
      setBreakEvenPreview(null);
      setBreakEvenPreviewLoading(false);
      setBreakEvenPreviewError(null);
      return;
    }

    const controller = new AbortController();
    const truthWindow = buildCommercialTruthWindow(business?.timezone ?? null);
    setBreakEvenPreviewLoading(true);
    setBreakEvenPreviewError(null);

    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/business-commerce-break-even-preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              businessId,
              structure: costDraft,
              startDate: truthWindow.startDate,
              endDate: truthWindow.endDate,
            }),
            signal: controller.signal,
          });
          const payload = (await response.json().catch(() => null)) as BreakEvenPreviewResponse | null;
          if (controller.signal.aborted || currentBusinessIdRef.current !== businessId) return;
          if (!response.ok || !payload?.preview) {
            throw new Error(payload?.message ?? "Could not calculate the draft break-even ROAS.");
          }
          setBreakEvenPreview(payload.preview);
          setBreakEvenPreviewError(null);
        } catch (previewError: unknown) {
          if (controller.signal.aborted) return;
          setBreakEvenPreview(null);
          setBreakEvenPreviewError(
            previewError instanceof Error
              ? previewError.message
              : "Could not calculate the draft break-even ROAS.",
          );
        } finally {
          if (!controller.signal.aborted) setBreakEvenPreviewLoading(false);
        }
      })();
    }, 300);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [business?.timezone, businessId, costBusinessId, costDraft, costCatalogRevision]);

  const activeSnapshot = snapshotBusinessId === businessId ? snapshot : null;
  const targetPack = activeSnapshot?.targetPack ?? null;
  const costModel = activeSnapshot?.costModelContext ?? null;

  const baseModel = useMemo(
    () =>
      buildCommercialTruthExactModel({
        business: {
          name: business?.name ?? null,
          currency: business?.currency ?? null,
          timezone: business?.timezone ?? null,
        },
        targetPack: targetPack
          ? {
              targetRoas: targetPack.targetRoas,
              breakEvenRoas: targetPack.breakEvenRoas,
              targetCpa: targetPack.targetCpa,
              aovAssumption: targetPack.aovAssumption,
              costStructure: targetPack.costStructure ?? null,
              updatedAt: targetPack.updatedAt,
            }
          : null,
        costModel: costModel
          ? {
              cogsPercent: costModel.cogsPercent,
              shippingPercent: costModel.shippingPercent,
              feePercent: costModel.feePercent,
              fixedCost: costModel.fixedCost,
            }
          : null,
        window: windowTotals,
        campaigns,
        history,
        pack: {
          canEdit,
          saving,
          dirty: Object.keys(drafts).length > 0,
          error,
          lastUpdatedActor: actor,
        },
        draft: {
          ...(drafts.targetRoas !== undefined
            ? { targetRoas: parseLooseNumber(drafts.targetRoas) }
            : {}),
          ...(drafts.breakevenRoas !== undefined
            ? { breakevenRoas: parseLooseNumber(drafts.breakevenRoas) }
            : {}),
        },
      }),
    [
      actor,
      business?.currency,
      business?.name,
      business?.timezone,
      campaigns,
      canEdit,
      costModel,
      drafts,
      error,
      history,
      saving,
      targetPack,
      windowTotals,
    ],
  );

  // A field the operator is editing shows exactly what they typed; every other
  // field shows what the server served.
  const model = useMemo(
    () => ({
      ...baseModel,
      // Cost inputs now live in the versioned component editor below. Keeping
      // the old percentage inputs beside it would create two competing write
      // paths for the same economic truth.
      fields: baseModel.fields
        .filter((field) =>
          ["targetRoas", "breakevenRoas", "aovFloor", "cpaCeiling"].includes(field.id),
        )
        .map((field) =>
          drafts[field.id] === undefined ? field : { ...field, value: drafts[field.id] as string },
        ),
    }),
    [baseModel, drafts],
  );

  const handleCostSave = useCallback(async () => {
    if (!costDraft || costRevision === null || costBusinessId !== businessId) {
      setCostError("The latest cost model revision is unavailable. Reload before saving.");
      return;
    }
    setCostSaving(true);
    setCostError(null);
    try {
      const response = await fetch("/api/business-commerce-cost-structure", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          structure: costDraft,
          expectedRevision: costRevision,
        }),
      });
      const payload = (await response.json().catch(() => null)) as CostStructureResponse | null;
      if (currentBusinessIdRef.current !== businessId) return;
      if (!response.ok || !payload?.structure || !payload.source) {
        if (response.status === 409 && payload?.currentRevision) {
          throw new Error("The cost model changed in another editor. Reload before saving again.");
        }
        const issueDetails = (payload?.issues ?? [])
          .map((issue) => issue.detail)
          .filter(Boolean)
          .slice(0, 3)
          .join(" ");
        throw new Error(
          [payload?.message ?? "Could not save the cost model.", issueDetails]
            .filter(Boolean)
            .join(" "),
        );
      }
      setCostStructure(payload.structure);
      setCostDraft(payload.structure);
      setCostSource(payload.source);
      setCostRevision(typeof payload.revision === "string" ? payload.revision : null);
      setCostIssues(payload.issues ?? []);
      setCostSourceWarnings([]);
      setCostCanEdit(Boolean(payload.permissions?.canEdit));
    } catch (saveError: unknown) {
      setCostError(
        saveError instanceof Error ? saveError.message : "Could not save the cost model.",
      );
    } finally {
      setCostSaving(false);
    }
  }, [businessId, costBusinessId, costDraft, costRevision]);

  const handleSave = useCallback(async () => {
    if (!activeSnapshot || !revision || snapshotBusinessId !== businessId) {
      setError("Commercial truth was not loaded. Refresh before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const pack = activeSnapshot.targetPack ?? createEmptyTargetPack();

      const nextSnapshot: BusinessCommercialTruthSnapshot = {
        ...activeSnapshot,
        targetPack: {
          ...pack,
          targetRoas:
            drafts.targetRoas === undefined ? pack.targetRoas : parseLooseNumber(drafts.targetRoas),
          breakEvenRoas:
            drafts.breakevenRoas === undefined
              ? pack.breakEvenRoas
              : parseLooseNumber(drafts.breakevenRoas),
          targetCpa:
            drafts.cpaCeiling === undefined ? pack.targetCpa : parseLooseNumber(drafts.cpaCeiling),
          aovAssumption:
            drafts.aovFloor === undefined
              ? pack.aovAssumption
              : parseLooseNumber(drafts.aovFloor),
        },
      };

      const response = await fetch("/api/business-commercial-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, snapshot: nextSnapshot, expectedRevision: revision }),
      });
      const payload = (await response.json().catch(() => null)) as SettingsResponse | null;
      if (currentBusinessIdRef.current !== businessId) return;
      if (!response.ok || !payload?.snapshot) {
        throw new Error(payload?.message ?? "Could not save the target pack.");
      }

      setDrafts({});
      await Promise.all([loadSnapshot(), loadHistory()]);
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the target pack.");
    } finally {
      setSaving(false);
    }
  }, [activeSnapshot, businessId, drafts, loadHistory, loadSnapshot, revision, snapshotBusinessId]);

  return (
    <CommercialTruthExact
      model={model}
      showHeader={showHeader}
      onFieldChange={(field, value) => setDrafts((current) => ({ ...current, [field]: value }))}
      onSave={() => void handleSave()}
      onDiscard={() => {
        setDrafts({});
        setError(null);
      }}
      costModelEditor={
        costDraft && costBusinessId === businessId ? (
          <>
            <ShopifyCostSourcePanel
              businessId={businessId}
              structure={costDraft}
              canEdit={costCanEdit}
              saving={costSaving}
              onChange={setCostDraft}
              onCatalogSynced={() => setCostCatalogRevision((revision) => revision + 1)}
            />
            <CommerceCostModelEditor
              structure={costDraft}
              source={costSource}
              canEdit={costCanEdit}
              saving={costSaving}
              serverIssues={costIssues}
              sourceWarnings={costSourceWarnings}
              error={costError}
              dirty={costDraft !== costStructure}
              breakEvenPreview={breakEvenPreview}
              breakEvenPreviewLoading={breakEvenPreviewLoading}
              breakEvenPreviewError={breakEvenPreviewError}
              targetPackBreakEvenRoas={
                drafts.breakevenRoas === undefined
                  ? targetPack?.breakEvenRoas ?? null
                  : parseLooseNumber(drafts.breakevenRoas)
              }
              onChange={setCostDraft}
              onSave={() => void handleCostSave()}
              onDiscard={() => {
                setCostDraft(costStructure);
                setCostError(null);
              }}
            />
          </>
        ) : costError ? (
          <div role="alert">{costError}</div>
        ) : null
      }
    />
  );
}

export default CommercialTruthScreen;
