"use client";

/**
 * The data boundary for Commercial Truth.
 *
 * Every fact the design draws is read from a real endpoint here:
 *  - the target pack, its cost structure and the live cost model context from
 *    `/api/business-commercial-settings`;
 *  - the monthly fixed base from that same snapshot's cost-model context, and
 *    written back through `/api/business-cost-model`, which is where the column
 *    actually lives;
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
import { useCallback, useEffect, useMemo, useState } from "react";

import { CommercialTruthExact } from "@/components/commercial-truth/CommercialTruthExact";
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
import {
  createEmptyTargetPack,
  type BusinessCommercialTruthSnapshot,
} from "@/src/types/business-commercial";
import { useAppStore } from "@/store/app-store";

type DraftMap = Partial<Record<CommercialTruthFieldId, string>>;

interface SettingsResponse {
  snapshot?: BusinessCommercialTruthSnapshot | null;
  revision?: string | null;
  permissions?: { canEdit?: boolean } | null;
  message?: string;
}

interface OverviewPin {
  id: string;
  value: number | null;
}

/** Parses "62%", "$58.00" and "3.80" without inventing a value for "" or "—". */
function parseLooseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === TRUTH_DASH) return null;
  const parsed = Number.parseFloat(trimmed.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRatio(value: string | undefined): number | null {
  const parsed = parseLooseNumber(value);
  if (parsed === null) return null;
  return parsed / 100;
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

  const loadSnapshot = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/business-commercial-settings?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as SettingsResponse | null;
      if (!response.ok || !payload?.snapshot) {
        throw new Error(payload?.message ?? "Could not load the target pack.");
      }
      setSnapshot(payload.snapshot);
      setRevision(typeof payload.revision === "string" ? payload.revision : null);
      setCanEdit(Boolean(payload.permissions?.canEdit));
      setDrafts({});
      setError(null);
    } catch (loadError: unknown) {
      setSnapshot(null);
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
    void loadWindow();
    void loadCampaigns();
  }, [loadCampaigns, loadHistory, loadSnapshot, loadWindow]);

  const targetPack = snapshot?.targetPack ?? null;
  const costModel = snapshot?.costModelContext ?? null;

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
      fields: baseModel.fields.map((field) =>
        drafts[field.id] === undefined ? field : { ...field, value: drafts[field.id] as string },
      ),
    }),
    [baseModel, drafts],
  );

  const handleSave = useCallback(async () => {
    if (!snapshot || !revision) {
      setError("Commercial truth was not loaded. Refresh before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const pack = snapshot.targetPack ?? createEmptyTargetPack();
      const existingCosts = pack.costStructure ?? null;
      const grossMargin = parseRatio(drafts.grossMargin);
      const cogsPercent =
        drafts.grossMargin === undefined
          ? (existingCosts?.cogsPercent ?? null)
          : grossMargin === null
            ? null
            : 1 - grossMargin;
      const shippingPercent =
        drafts.shippingCost === undefined
          ? (existingCosts?.shippingPercent ?? null)
          : parseRatio(drafts.shippingCost);
      const paymentProcessingPercent =
        drafts.paymentFees === undefined
          ? (existingCosts?.paymentProcessingPercent ?? null)
          : parseRatio(drafts.paymentFees);

      const nextSnapshot: BusinessCommercialTruthSnapshot = {
        ...snapshot,
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
          costStructure: {
            cogsPercent,
            shippingPercent,
            fulfillmentPercent: existingCosts?.fulfillmentPercent ?? null,
            paymentProcessingPercent,
          },
        },
      };

      const response = await fetch("/api/business-commercial-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, snapshot: nextSnapshot, expectedRevision: revision }),
      });
      const payload = (await response.json().catch(() => null)) as SettingsResponse | null;
      if (!response.ok || !payload?.snapshot) {
        throw new Error(payload?.message ?? "Could not save the target pack.");
      }

      // `business_cost_models` is the table overview profit estimates, reports
      // and the Google advisor read (lib/overview-summary-support.ts,
      // lib/google-ads/serving.ts). The pack's own cost structure overrides it
      // on this screen, so writing only the pack looked correct here while the
      // rest of the product kept costing at the stale percentages. Any edit to
      // one of the four cost fields therefore mirrors into that table, not just
      // an edit that happens to include the monthly fixed base.
      const costFieldsTouched =
        drafts.grossMargin !== undefined ||
        drafts.shippingCost !== undefined ||
        drafts.paymentFees !== undefined ||
        drafts.fixedCosts !== undefined;
      if (costFieldsTouched) {
        // The route takes all four columns together, so an edit to one of them
        // carries the other three at their stored values — the pack's override
        // first, then the live cost model. Nothing the operator did not touch
        // is blanked, and nothing absent is invented.
        const fixedCost =
          drafts.fixedCosts === undefined
            ? (costModel?.fixedCost ?? null)
            : parseLooseNumber(drafts.fixedCosts);
        const effective = {
          cogsPercent: cogsPercent ?? costModel?.cogsPercent ?? null,
          shippingPercent: shippingPercent ?? costModel?.shippingPercent ?? null,
          feePercent: paymentProcessingPercent ?? costModel?.feePercent ?? null,
        };
        const incomplete =
          fixedCost === null ||
          effective.cogsPercent === null ||
          effective.shippingPercent === null ||
          effective.feePercent === null;
        // The monthly fixed base lives only on the cost model, so an edit that
        // names it and cannot be written is a failure the operator must see.
        if (incomplete && drafts.fixedCosts !== undefined) {
          throw new Error(
            "Fixed costs need gross margin, shipping cost and payment fees to be set as well.",
          );
        }
        if (!incomplete) {
          const costResponse = await fetch("/api/business-cost-model", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ businessId, ...effective, fixedCost }),
          });
          if (!costResponse.ok) {
            const costPayload = (await costResponse.json().catch(() => null)) as {
              message?: string;
            } | null;
            throw new Error(costPayload?.message ?? "Could not save the cost model.");
          }
        }
      }

      setDrafts({});
      await Promise.all([loadSnapshot(), loadHistory()]);
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the target pack.");
    } finally {
      setSaving(false);
    }
  }, [businessId, costModel, drafts, loadHistory, loadSnapshot, revision, snapshot]);

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
    />
  );
}

export default CommercialTruthScreen;
