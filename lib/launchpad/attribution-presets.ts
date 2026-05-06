export type MetaAttributionEventType =
  | "CLICK_THROUGH"
  | "VIEW_THROUGH"
  | "ENGAGED_VIDEO_VIEW";

export interface MetaAttributionSpecItem {
  event_type: MetaAttributionEventType;
  window_days: 1 | 7;
}

export interface AttributionPreset {
  id:
    | "click_7d"
    | "click_7d_view_1d"
    | "click_7d_view_1d_engaged_1d"
    | "click_1d"
    | "click_1d_view_1d"
    | "custom";
  label: string;
  description?: string;
  attributionSpec: MetaAttributionSpecItem[];
  advanced?: boolean;
}

export const ATTRIBUTION_DIMENSIONS: MetaAttributionSpecItem[] = [
  { event_type: "CLICK_THROUGH", window_days: 7 },
  { event_type: "CLICK_THROUGH", window_days: 1 },
  { event_type: "VIEW_THROUGH", window_days: 1 },
  { event_type: "ENGAGED_VIDEO_VIEW", window_days: 1 },
];

export const ATTRIBUTION_PRESETS: AttributionPreset[] = [
  {
    id: "click_7d",
    label: "Click 7d (default)",
    attributionSpec: [{ event_type: "CLICK_THROUGH", window_days: 7 }],
  },
  {
    id: "click_7d_view_1d",
    label: "Click 7d + View 1d (e-commerce default)",
    attributionSpec: [
      { event_type: "CLICK_THROUGH", window_days: 7 },
      { event_type: "VIEW_THROUGH", window_days: 1 },
    ],
  },
  {
    id: "click_7d_view_1d_engaged_1d",
    label: "Click 7d + View 1d + Engaged 1d",
    attributionSpec: [
      { event_type: "CLICK_THROUGH", window_days: 7 },
      { event_type: "VIEW_THROUGH", window_days: 1 },
      { event_type: "ENGAGED_VIDEO_VIEW", window_days: 1 },
    ],
  },
  {
    id: "click_1d",
    label: "Click 1d only (strict)",
    attributionSpec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
  },
  {
    id: "click_1d_view_1d",
    label: "Click 1d + View 1d (consumer goods conservative)",
    attributionSpec: [
      { event_type: "CLICK_THROUGH", window_days: 1 },
      { event_type: "VIEW_THROUGH", window_days: 1 },
    ],
  },
  {
    id: "custom",
    label: "Custom...",
    attributionSpec: [{ event_type: "CLICK_THROUGH", window_days: 7 }],
    advanced: true,
  },
];

export const DEFAULT_ATTRIBUTION_PRESET_ID: AttributionPreset["id"] =
  "click_7d_view_1d";

function keyForSpec(spec: MetaAttributionSpecItem[]) {
  return spec
    .map((item) => `${item.event_type}:${item.window_days}`)
    .sort()
    .join("|");
}

export function attributionSpecHasClick(spec: MetaAttributionSpecItem[]) {
  return spec.some((item) => item.event_type === "CLICK_THROUGH");
}

export function getAttributionPresetById(id: string | null | undefined) {
  return ATTRIBUTION_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function findMatchingAttributionPreset(spec: MetaAttributionSpecItem[]) {
  const key = keyForSpec(spec);
  return (
    ATTRIBUTION_PRESETS.find(
      (preset) => !preset.advanced && keyForSpec(preset.attributionSpec) === key,
    ) ?? null
  );
}

export function summarizeAttributionSpec(spec: MetaAttributionSpecItem[]) {
  if (spec.length === 0) return "No attribution";
  return spec
    .map((item) => {
      const prefix =
        item.event_type === "CLICK_THROUGH"
          ? "Click"
          : item.event_type === "VIEW_THROUGH"
            ? "View"
            : "Engaged";
      return `${prefix} ${item.window_days}d`;
    })
    .join(" + ");
}

export function normalizeAttributionSpecItems(value: unknown): MetaAttributionSpecItem[] {
  if (!Array.isArray(value)) return [];
  const normalized: MetaAttributionSpecItem[] = [];
  value.forEach((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const record = item as Record<string, unknown>;
    const eventType = record.event_type ?? record.eventType;
    const windowDays = record.window_days ?? record.windowDays;
    if (
      eventType !== "CLICK_THROUGH" &&
      eventType !== "VIEW_THROUGH" &&
      eventType !== "ENGAGED_VIDEO_VIEW"
    ) {
      return;
    }
    if (windowDays !== 1 && windowDays !== 7) return;
    normalized.push({ event_type: eventType, window_days: windowDays });
  });
  return normalized;
}
