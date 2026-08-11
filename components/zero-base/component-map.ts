/**
 * Design component → production implementation.
 *
 * WP-05's acceptance criterion is that every component in the vendored
 * `spec/semantics.js` resolves to something real. "Something real" is either a
 * zero-base primitive or a plain native element — the latter is a perfectly
 * good answer for a link or a status region, but it has to be argued rather
 * than assumed, so `kind: "native"` requires a note.
 *
 * The vendored list is read at test time rather than copied here, so adding a
 * component to the design fails the coverage test instead of being missed.
 * That read lives in the test, not in this module: this file sits under
 * components/ and must stay free of node builtins so it can never drag
 * `node:fs` into a client bundle.
 */
export type ImplementationKind = "primitive" | "native";

export interface ComponentMapping {
  /** Exact `component` string from spec/semantics.js. */
  component: string;
  kind: ImplementationKind;
  /** Module path, or the element for native mappings. */
  implementation: string;
  /** Required for native mappings: why no primitive is warranted. */
  note?: string;
}

export const COMPONENT_MAP: readonly ComponentMapping[] = [
  {
    component: "Button (primary/secondary/danger)",
    kind: "primitive",
    implementation: "components/zero-base/primitives/button.tsx → Button",
  },
  {
    component: "Icon button (nudge, close, menu ⋯)",
    kind: "primitive",
    implementation: "components/zero-base/primitives/button.tsx → IconButton",
  },
  {
    component: "Row button (decision/list rows)",
    kind: "primitive",
    implementation: "components/zero-base/collections/data-table.tsx → DataTable row header cell",
  },
  {
    component: "Link action (Open · Edit · Duplicate)",
    kind: "native",
    implementation: "<a href> / next/link",
    note:
      "A navigation link must be a real anchor: middle-click, copy-link and " +
      "browser history all come from the element and cannot be reimplemented.",
  },
  {
    component: "Menu button + menu",
    kind: "primitive",
    implementation: "components/zero-base/primitives/overlays.tsx → ZeroBaseMenu",
  },
  {
    component: "Tabs",
    kind: "primitive",
    implementation: "components/zero-base/primitives/tabs.tsx → ZeroBaseTabs",
  },
  {
    component: "Segmented / radio group (scope, lanes, tiers)",
    kind: "primitive",
    implementation: "components/zero-base/primitives/choice.tsx → RadioGroup",
  },
  {
    component: "Checkbox (assignment, ack, mark-applied)",
    kind: "primitive",
    implementation: "components/zero-base/primitives/choice.tsx → Checkbox",
  },
  {
    component: "Text input (auth, settings, economics)",
    kind: "primitive",
    implementation: "components/zero-base/primitives/text-input.tsx → TextInput",
  },
  {
    component: "Combobox (business switcher, account/property/site pickers)",
    kind: "primitive",
    implementation: "components/zero-base/primitives/combobox.tsx → Combobox",
  },
  {
    component: "Global search overlay",
    kind: "primitive",
    implementation: "components/zero-base/search/search-overlay.tsx → SearchOverlay (WP-08)",
  },
  {
    component: "Nav rail / drawer item",
    kind: "primitive",
    implementation: "components/zero-base/shell/rail.tsx → RailItem (WP-06)",
  },
  {
    component: "Inspector / sheet (drawer)",
    kind: "primitive",
    implementation: "components/zero-base/primitives/overlays.tsx → ZeroBaseSheet",
  },
  {
    component: "Dialog (confirm / destructive)",
    kind: "primitive",
    implementation: "components/zero-base/primitives/overlays.tsx → ZeroBaseDialog",
  },
  {
    component: "Selectable card (report widget)",
    kind: "primitive",
    implementation: "components/zero-base/collections/widget-grid.tsx → WidgetGrid",
  },
  {
    component: "Dot pagination (carousel)",
    kind: "primitive",
    implementation: "components/zero-base/collections/collection.tsx → Collection paging controls",
  },
  {
    component: "Chart/table toggle",
    kind: "primitive",
    implementation: "components/zero-base/charts/chart.tsx → Chart",
  },
  {
    component: "Load more / cursor pagination",
    kind: "primitive",
    implementation: "components/zero-base/collections/collection.tsx → Collection",
  },
  {
    component: "Media play / retry",
    kind: "primitive",
    implementation: "components/zero-base/states/live-region.tsx → MediaPlayer",
  },
  {
    component: "Status / live region",
    kind: "primitive",
    implementation: "components/zero-base/states/live-region.tsx → LiveRegion",
  },
  {
    component: "Scope sheet trigger (mobile header)",
    kind: "primitive",
    implementation: "components/zero-base/primitives/scope-sheet.tsx → ScopeSheet",
  },
  {
    component: "Disabled control with reason",
    kind: "primitive",
    implementation:
      "components/zero-base/primitives/button.tsx → Button with ControlState kind 'disabled'",
  },
];
