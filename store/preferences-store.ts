import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { savedViewScopeKey, type SavedView } from "@/lib/saved-views";
import type { DateRangeValue } from "@/components/date-range/DateRangePicker";
import type { CreativeDateRangeValue } from "@/components/creatives/CreativesTopSection";
import { syncLanguageCookie, type AppLanguage } from "@/lib/i18n";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_ATTRIBUTE,
  resolveTheme,
  syncThemeCookie,
  type ThemePreference,
} from "@/lib/theme";
import {
  appendUniqueMetric,
  dedupeMetricKeys,
  moveMetric,
  removeMetric,
  replaceMetric,
} from "@/store/preferences-support";

export type ReportDateRangePreference = "7d" | "14d" | "30d" | "90d";
export type MetricDisplayPreference = "compact" | "detailed";
export type TableDensityPreference = "comfortable" | "compact";
export type AppLanguagePreference = AppLanguage;
export type OperatorSurfacePreset = "action_first" | "creative_rich" | "media_limited";
export type ThemePreferenceValue = ThemePreference;

interface PreferencesState {
  language: AppLanguagePreference;
  /** system | light | dark. What renders is resolved separately. */
  theme: ThemePreferenceValue;
  defaultDateRange: ReportDateRangePreference;
  metricDisplay: MetricDisplayPreference;
  tableDensity: TableDensityPreference;
  heatmapEnabled: boolean;
  metaOperatorPreset: OperatorSurfacePreset;
  overviewPinsByContext: Record<string, string[]>;
  /** Saved views, keyed by surface::businessId so scopes cannot bleed. */
  savedViewsByScope: Record<string, SavedView[]>;
  // Persistent date range selections per surface
  dashboardDateRange: DateRangeValue | null;
  metaDateRange: DateRangeValue | null;
  commandCenterDateRange: DateRangeValue | null;
  creativeDateRange: CreativeDateRangeValue | null;
  setLanguage: (value: AppLanguagePreference) => void;
  setTheme: (value: ThemePreferenceValue) => void;
  setDashboardDateRange: (value: DateRangeValue) => void;
  setMetaDateRange: (value: DateRangeValue) => void;
  setCommandCenterDateRange: (value: DateRangeValue) => void;
  setCreativeDateRange: (value: CreativeDateRangeValue) => void;
  setDefaultDateRange: (value: ReportDateRangePreference) => void;
  setMetricDisplay: (value: MetricDisplayPreference) => void;
  setTableDensity: (value: TableDensityPreference) => void;
  setHeatmapEnabled: (value: boolean) => void;
  setMetaOperatorPreset: (value: OperatorSurfacePreset) => void;
  setOverviewPins: (contextKey: string, metrics: string[]) => void;
  pinOverviewMetric: (contextKey: string, metricKey: string) => void;
  unpinOverviewMetric: (contextKey: string, metricKey: string) => void;
  replaceOverviewMetric: (contextKey: string, currentMetricKey: string, nextMetricKey: string) => void;
  moveOverviewMetric: (contextKey: string, metricKey: string, direction: "left" | "right") => void;
  saveView: (view: SavedView) => void;
  deleteSavedView: (surface: string, businessId: string, viewId: string) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      language: "en",
      theme: DEFAULT_THEME_PREFERENCE,
      defaultDateRange: "30d",
      metricDisplay: "detailed",
      tableDensity: "comfortable",
      heatmapEnabled: true,
      metaOperatorPreset: "action_first",
      overviewPinsByContext: {},
      savedViewsByScope: {},
      dashboardDateRange: null,
      metaDateRange: null,
      commandCenterDateRange: null,
      creativeDateRange: null,
      setLanguage: (value) => {
        syncLanguageCookie(value);
        set({ language: value });
      },
      // The cookie is the authority the server reads on the next request; the
      // attribute is what repaints this one. Both are written, in that order.
      setTheme: (value) => {
        syncThemeCookie(value);
        if (typeof document !== "undefined") {
          const prefersDark =
            typeof window !== "undefined" && typeof window.matchMedia === "function"
              ? window.matchMedia("(prefers-color-scheme: dark)").matches
              : false;
          document.documentElement.setAttribute(
            THEME_ATTRIBUTE,
            resolveTheme(value, prefersDark),
          );
        }
        set({ theme: value });
      },
      setDashboardDateRange: (value) => set({ dashboardDateRange: value }),
      setMetaDateRange: (value) => set({ metaDateRange: value }),
      setCommandCenterDateRange: (value) => set({ commandCenterDateRange: value }),
      setCreativeDateRange: (value) => set({ creativeDateRange: value }),
      setDefaultDateRange: (value) => set({ defaultDateRange: value }),
      setMetricDisplay: (value) => set({ metricDisplay: value }),
      setTableDensity: (value) => set({ tableDensity: value }),
      setHeatmapEnabled: (value) => set({ heatmapEnabled: value }),
      setMetaOperatorPreset: (value) => set({ metaOperatorPreset: value }),
      setOverviewPins: (contextKey, metrics) =>
        set((state) => ({
          overviewPinsByContext: {
            ...state.overviewPinsByContext,
            [contextKey]: dedupeMetricKeys(metrics),
          },
        })),
      pinOverviewMetric: (contextKey, metricKey) =>
        set((state) => {
          const current = state.overviewPinsByContext[contextKey] ?? [];
          if (current.includes(metricKey)) return state;
          return {
            overviewPinsByContext: {
              ...state.overviewPinsByContext,
              [contextKey]: appendUniqueMetric(current, metricKey),
            },
          };
        }),
      unpinOverviewMetric: (contextKey, metricKey) =>
        set((state) => ({
          overviewPinsByContext: {
            ...state.overviewPinsByContext,
            [contextKey]: removeMetric(
              state.overviewPinsByContext[contextKey] ?? [],
              metricKey
            ),
          },
        })),
      replaceOverviewMetric: (contextKey, currentMetricKey, nextMetricKey) =>
        set((state) => {
          const current = state.overviewPinsByContext[contextKey] ?? [];
          return {
            overviewPinsByContext: {
              ...state.overviewPinsByContext,
              [contextKey]: replaceMetric(current, currentMetricKey, nextMetricKey),
            },
          };
        }),
      moveOverviewMetric: (contextKey, metricKey, direction) =>
        set((state) => {
          const current = state.overviewPinsByContext[contextKey] ?? [];
          const next = moveMetric(current, metricKey, direction);
          if (next === current) return state;
          return {
            overviewPinsByContext: {
              ...state.overviewPinsByContext,
              [contextKey]: next,
            },
          };
        }),
      saveView: (view) =>
        set((state) => {
          const key = savedViewScopeKey(view.surface, view.businessId);
          const current = state.savedViewsByScope[key] ?? [];
          return {
            savedViewsByScope: {
              ...state.savedViewsByScope,
              [key]: [...current.filter((item) => item.id !== view.id), view],
            },
          };
        }),
      deleteSavedView: (surface, businessId, viewId) =>
        set((state) => {
          const key = savedViewScopeKey(surface, businessId);
          const current = state.savedViewsByScope[key] ?? [];
          return {
            savedViewsByScope: {
              ...state.savedViewsByScope,
              [key]: current.filter((item) => item.id !== viewId),
            },
          };
        }),
    }),
    {
      name: "omniads-preferences-store-v1",
      storage: createJSONStorage(() => localStorage),
    }
  )
);
