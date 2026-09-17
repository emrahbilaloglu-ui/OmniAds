"use client";

import { useEffect, useState } from "react";
import { sameMetricKeyOrder, uniqueMetricKeys } from "./kpi-grid";
import { sameOverviewLayout, type LayoutEntry } from "./overview-layout";

type CustomizationDraft = {
  /** The business/workspace the draft was started for. */
  context: string;
  /** What was on screen when the session started. Dirty means "differs from this". */
  baselineKpiKeys: string[];
  baselineLayout: LayoutEntry[];
  kpiKeys: string[];
  /** True while the KPI draft is an untouched "Restore defaults". */
  kpiDefaultsRestored: boolean;
  layout: LayoutEntry[];
};

/**
 * One customize session for the Overview: KPI order and section layout are
 * edited as a single draft and saved or discarded together.
 *
 * - Nothing is written until `save`, and only the parts the owner changed.
 * - "Changed" is measured against the snapshot taken when the session
 *   started, so a background refetch that shifts the live defaults can never
 *   turn an untouched session into a save.
 * - A draft belongs to the context it was started in. Switching business or
 *   workspace discards it; switching back does not resume it.
 */
export function useOverviewCustomization({
  context,
  savedKpiKeys,
  defaultKpiKeys,
  savedLayout,
  onSaveKpis,
  onRestoreKpiDefaults,
  onSaveLayout,
}: {
  context: string;
  savedKpiKeys: readonly string[];
  defaultKpiKeys: readonly string[];
  savedLayout: readonly LayoutEntry[];
  onSaveKpis: (keys: string[]) => void;
  /** Called instead of `onSaveKpis` when the saved result is a restore to defaults. */
  onRestoreKpiDefaults: () => void;
  onSaveLayout: (layout: LayoutEntry[]) => void;
}) {
  const [draft, setDraft] = useState<CustomizationDraft | null>(null);
  const active = draft?.context === context ? draft : null;

  useEffect(() => {
    if (draft && draft.context !== context) setDraft(null);
  }, [context, draft]);

  const kpiDirty = active ? !sameMetricKeyOrder(active.kpiKeys, active.baselineKpiKeys) : false;
  const layoutDirty = active ? !sameOverviewLayout(active.layout, active.baselineLayout) : false;

  const start = () => {
    const kpiKeys = uniqueMetricKeys(savedKpiKeys);
    setDraft({
      context,
      baselineKpiKeys: kpiKeys,
      baselineLayout: [...savedLayout],
      kpiKeys,
      kpiDefaultsRestored: false,
      layout: [...savedLayout],
    });
  };

  const cancel = () => setDraft(null);

  const save = () => {
    if (!active) return;
    if (kpiDirty) {
      if (active.kpiDefaultsRestored) onRestoreKpiDefaults();
      else onSaveKpis(active.kpiKeys);
    }
    if (layoutDirty) onSaveLayout(active.layout);
    setDraft(null);
  };

  const setKpiKeys = (keys: string[]) =>
    setDraft((current) =>
      current ? { ...current, kpiKeys: uniqueMetricKeys(keys), kpiDefaultsRestored: false } : current,
    );

  const restoreKpiDefaults = () =>
    setDraft((current) =>
      current ? { ...current, kpiKeys: uniqueMetricKeys(defaultKpiKeys), kpiDefaultsRestored: true } : current,
    );

  const setLayout = (layout: LayoutEntry[]) =>
    setDraft((current) => (current ? { ...current, layout } : current));

  return {
    editing: active !== null,
    dirty: kpiDirty || layoutDirty,
    kpiKeys: active?.kpiKeys ?? savedKpiKeys,
    layout: active?.layout ?? savedLayout,
    start,
    cancel,
    save,
    setKpiKeys,
    restoreKpiDefaults,
    setLayout,
  };
}
