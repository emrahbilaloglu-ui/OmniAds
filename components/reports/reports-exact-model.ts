/**
 * View model for the v2 Reports screen — the three tabs (my reports,
 * templates, builder) and everything the builder's three columns draw.
 *
 * Nothing in here is fetched or computed. The adapter maps real report
 * records and rendered widget payloads onto these shapes, and
 * `ReportsExact` renders them. That split is what makes the screen's copy
 * testable without a browser and its data testable without React.
 */

export type ReportsTabId = "mine" | "templates" | "builder";

export interface ReportsTabModel {
  id: ReportsTabId;
  label: string;
  /** Rendered inside the pill's mono counter. */
  count: number;
  active: boolean;
}

export interface SavedReportModel {
  id: string;
  name: string;
  /** "—" whenever no send state is established for this report. */
  status: string;
  statusBg: string;
  statusFg: string;
  /** Top band of the row's 86px mosaic thumbnail. */
  thumbTone: string;
  description: string;
  meta: string;
  /** False while a row action is in flight, so the row cannot be double-fired. */
  busy: boolean;
}

export interface ReportTemplateBlockModel {
  height: string;
  span: number;
  background: string;
}

export interface ReportTemplateContentModel {
  /** Zero-padded ordinal, e.g. "01". */
  n: string;
  t: string;
}

export interface ReportTemplateModel {
  id: string;
  category: string;
  categoryBg: string;
  categoryFg: string;
  cadence: string;
  name: string;
  description: string;
  blocks: ReportTemplateBlockModel[];
  contents: ReportTemplateContentModel[];
  meta: string;
}

/** The block kinds the v2 palette offers, in the design's own vocabulary. */
export type BuilderBlockKind =
  | "kpi"
  | "kpirow"
  | "line"
  | "bar"
  | "donut"
  | "funnel"
  | "table"
  | "heat"
  | "ai"
  | "text"
  | "brief";

export type BuilderBlockSize = "S" | "M" | "L";

export interface BuilderPaletteItemModel {
  /** Stable key the container resolves back to a palette entry. */
  key: string;
  kind: BuilderBlockKind;
  label: string;
  /** Right-hand mono tag naming where the block reads from. */
  source: string;
  /** SVG path data for the 11px glyph. */
  icon: string;
  iconBg: string;
}

export interface BuilderPaletteGroupModel {
  name: string;
  items: BuilderPaletteItemModel[];
}

export interface BuilderMiniStatModel {
  k: string;
  v: string;
}

export interface BuilderBarModel {
  height: string;
  accent: boolean;
}

export interface BuilderLegendEntryModel {
  color: string;
  text: string;
}

/**
 * A block body is either drawn from measured data or explicitly unavailable.
 * There is no third state: a block whose figures could not be established
 * renders an em dash rather than a zero or a decorative placeholder.
 *
 * `ai`, `funnel`, `heat` and `brief` carry no payload because no renderer
 * measures them yet (REPORTS-37). They are still their own kinds rather than
 * `unavailable`, so the design's inner geometry is drawn and the em dash sits
 * inside it — a block that reports nothing must still look like the block the
 * client will receive, not like a blank box.
 */
export type BuilderBlockBodyModel =
  | { kind: "kpi"; value: string; delta: string; deltaTone: string }
  | { kind: "kpirow"; minis: BuilderMiniStatModel[] }
  | { kind: "line"; path: string; area: string }
  | { kind: "bar"; bars: BuilderBarModel[] }
  | { kind: "donut"; gradient: string; legend: BuilderLegendEntryModel[] }
  | { kind: "table"; rows: string[] }
  | { kind: "text" }
  | { kind: "ai" }
  | { kind: "funnel" }
  | { kind: "heat" }
  | { kind: "brief" }
  | { kind: "unavailable" };

export interface BuilderBlockModel {
  uid: string;
  title: string;
  size: BuilderBlockSize;
  /** Chip caption: the size letter itself. */
  sizeLabel: string;
  /** Literal CSS width from the design's S/M/L flow. */
  widthCss: string;
  borderColor: string;
  selected: boolean;
  kind: BuilderBlockKind;
  body: BuilderBlockBodyModel;
  sourceNote: string;
}

export interface BuilderSelectOptionModel {
  value: string;
  label: string;
  /** Set when the option is drawn by the design but has no contract behind it. */
  disabled?: boolean;
}

export interface BuilderSizeOptionModel {
  size: BuilderBlockSize;
  label: string;
  active: boolean;
}

export interface BuilderBlockInspectorModel {
  mode: "block";
  kindLabel: string;
  title: string;
  metric: string;
  metricOptions: BuilderSelectOptionModel[];
  source: string;
  sourceOptions: BuilderSelectOptionModel[];
  dateRange: string;
  dateRangeOptions: BuilderSelectOptionModel[];
  /** True while no renderer honours a per-block window. */
  dateRangeDisabled: boolean;
  sizeOptions: BuilderSizeOptionModel[];
  compareOn: boolean;
  footnote: string;
}

export interface BuilderRecipientModel {
  label: string;
  removable: boolean;
}

export interface BuilderReportInspectorModel {
  mode: "report";
  client: string;
  clientOptions: BuilderSelectOptionModel[];
  clientDisabled: boolean;
  schedule: string;
  scheduleOptions: BuilderSelectOptionModel[];
  scheduleDisabled: boolean;
  recipients: BuilderRecipientModel[];
  recipientsDisabled: boolean;
  liveShareOn: boolean;
  liveShareDisabled: boolean;
  liveShareRole: string;
  hint: string;
}

export type BuilderInspectorModel = BuilderBlockInspectorModel | BuilderReportInspectorModel;

export interface BuilderModel {
  name: string;
  dateRange: string;
  dateRangeOptions: BuilderSelectOptionModel[];
  comparePillLabel: string;
  /** Mono counter, e.g. "5 blocks · autosaved". */
  counterLabel: string;
  /** Right-aligned mono line in the page header: client · range · page. */
  pageMeta: string;
  blocks: BuilderBlockModel[];
  palette: BuilderPaletteGroupModel[];
  paletteEyebrow: string;
  dropHint: string;
  inspector: BuilderInspectorModel;
  saveEnabled: boolean;
  saveLabel: string;
}

export interface ReportsMineModel {
  reports: SavedReportModel[];
  footnote: string;
}

export interface ReportsTemplatesModel {
  cards: ReportTemplateModel[];
  footnote: string;
}

export interface ReportsExactModel {
  eyebrow: string;
  title: string;
  newReportLabel: string;
  tabs: ReportsTabModel[];
  exportNote: string;
  activeTab: ReportsTabId;
  mine: ReportsMineModel;
  templates: ReportsTemplatesModel;
  builder: BuilderModel;
}

export interface ReportsExactHandlers {
  onSelectTab: (tab: ReportsTabId) => void;
  onNewReport: () => void;
  onOpenReport: (reportId: string) => void;
  onDuplicateReport: (reportId: string) => void;
  onShareReport: (reportId: string) => void;
  onExportReportPdf: (reportId: string) => void;
  onPreviewTemplate: (templateId: string) => void;
  onUseTemplate: (templateId: string) => void;
  onRenameReport: (name: string) => void;
  onChangeDateRange: (value: string) => void;
  onPreview: () => void;
  onSave: () => void;
  onPaletteAdd: (key: string) => void;
  onPaletteDragStart: (key: string) => void;
  onBlockSelect: (uid: string) => void;
  onBlockRemove: (uid: string) => void;
  onBlockCycleSize: (uid: string) => void;
  onBlockDragStart: (uid: string) => void;
  onBlockDropOn: (uid: string) => void;
  onDropEnd: () => void;
  onInspectorTitleChange: (value: string) => void;
  onInspectorMetricChange: (value: string) => void;
  onInspectorSourceChange: (value: string) => void;
  onInspectorSizeChange: (size: BuilderBlockSize) => void;
  onToggleCompare: () => void;
  onRemoveSelected: () => void;
}
