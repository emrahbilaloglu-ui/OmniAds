"use client";

/**
 * Reports library, builder, viewer and print (H37–H40).
 *
 * The canonical report UI has **no mint or share control anywhere**. WP-03A's
 * fail-closed branch is the server's answer; a button here would be a control
 * whose only outcome is a refusal, and its absence is asserted by test.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  CUSTOM_REPORT_TEMPLATES,
  type CustomReportDocument,
  type RenderedReportWidget,
} from "@/lib/custom-reports";
import { TemplateMiniPreview, TemplateProviders } from "@/components/reports/template-mini-preview";

import { DataTable } from "@/components/zero-base/collections/data-table";
import { Button } from "@/components/zero-base/primitives/button";
import { ZeroBaseDialog } from "@/components/zero-base/primitives/overlays";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import { widgetIsExportable } from "@/lib/zero-base/reports/report-documents";
import {
  COMING_SOON_SOURCES,
  RENDERABLE_SOURCES,
  canAddSource,
  canExportCsv,
  sourceById,
} from "@/lib/zero-base/reports/report-catalog";
import {
  canUndo,
  commit,
  keyboardAction,
  newHistory,
  undo,
  type GridState,
  type Widget,
} from "@/lib/zero-base/reports/builder-model";
import { useCopy, useZeroBaseLanguage } from "@/components/zero-base/i18n/copy-provider";

/* --------------------------------------------------------------- library */

export interface ReportSummary {
  id: string;
  name: string;
  description?: string | null;
  templateId?: string | null;
  definition?: CustomReportDocument;
  updatedAt: string;
}

export function ReportLibraryView({
  reports,
  businessId,
  onCreate,
  onDuplicate,
  onDelete,
  onLoadMore,
  totalCount,
  unavailableReason,
}: {
  reports: readonly ReportSummary[];
  businessId?: string;
  onCreate?: () => void;
  onDuplicate?: (id: string) => void;
  /** Absent when the actor cannot delete; the control states the reason. */
  onDelete?: (id: string) => void;
  onLoadMore?: () => void;
  /** Reports the server said exist. Null means it did not say. */
  totalCount?: number | null;
  unavailableReason?: string | null;
}) {
  const copy = useCopy();
  const language = useZeroBaseLanguage();
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<"recent" | "name">("recent");
  const [deleteCandidate, setDeleteCandidate] = useState<ReportSummary | null>(null);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleReports = [...reports]
    .filter((report) => {
      if (!normalizedQuery) return true;
      const category = CUSTOM_REPORT_TEMPLATES.find((template) => template.id === report.templateId)?.category ?? "";
      return [report.name, report.description ?? "", category]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .sort((left, right) =>
      sortMode === "name"
        ? left.name.localeCompare(right.name)
        : new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );
  if (unavailableReason) {
    return (
      <div data-reports-surface="library">
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{copy.reportsTitle}</h1>
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      </div>
    );
  }
  return (
    <div data-reports-surface="library" data-el="reports-lib">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{copy.reportsTitle}</h1>
          <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>Save report formats, export tables as CSV, or start from a reusable template.</p>
        </div>
        <Button
          variant="secondary"
          data-report-create=""
          data-ctl="live:REPORT-13 new"
          onClick={onCreate}
        >
          {copy.newReport}
        </Button>
      </div>
      <div data-report-library-columns="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.05fr) minmax(0, 1.25fr)", gap: 12, alignItems: "start" }}>
        <section style={{ padding: 16, border: "1px solid var(--ledger-border-subtle)", borderRadius: 10, background: "var(--ledger-bg-surface)" }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>{language === "tr" ? "Kayıtlı Raporlar" : "Saved Reports"}</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>Every saved report belongs to the active business.</p>
          {reports.length > 5 ? <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            <input aria-label="Search reports" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search reports..." style={{ minHeight: 34, minWidth: 220, padding: "6px 9px", border: "1px solid var(--ledger-border-control)", borderRadius: 6, background: "var(--ledger-bg-surface)" }} />
            <select aria-label="Sort reports" value={sortMode} onChange={(event) => setSortMode(event.target.value as "recent" | "name")} style={{ minHeight: 34, padding: "6px 9px", border: "1px solid var(--ledger-border-control)", borderRadius: 6, background: "var(--ledger-bg-surface)" }}><option value="recent">Sort: Recently updated</option><option value="name">Sort: Name</option></select>
          </div> : null}
          {reports.length === 0 ? <p data-reports="empty" style={{ marginTop: 16, padding: 20, border: "1px dashed var(--ledger-border-control)", borderRadius: 8, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{copy.noReports}</p> : visibleReports.length === 0 ? <p style={{ marginTop: 16, fontSize: 12 }}>No reports match this search.</p> : <div data-collection="reports" role="list" aria-label={copy.reportsTitle} style={{ display: "grid", gap: 8, marginTop: 16 }}>
            {visibleReports.map((report) => <article key={report.id} role="listitem" style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: 8, background: "var(--ledger-bg-surface)" }}>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 150px", gap: 12 }}>
                <a href={`/app/reports/${report.id}`} data-ctl="live:REPORT-08 open" style={{ color: "inherit", textDecoration: "none" }}><h3 style={{ margin: 0, fontSize: 13 }}>{report.name}</h3><p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{report.description || "No description yet."}</p><p style={{ margin: "8px 0 0", fontFamily: "var(--font-adc-mono), monospace", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>Updated {new Date(report.updatedAt).toLocaleString()}</p></a>
                {report.definition ? <a href={`/app/reports/${report.id}`} aria-label={`Open ${report.name}`}><TemplateMiniPreview definition={report.definition} /></a> : null}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}><span style={{ padding: "3px 7px", border: "1px solid var(--ledger-border-subtle)", borderRadius: 5, fontFamily: "var(--font-adc-mono), monospace", fontSize: 12 }}>{report.definition?.widgets.length ?? 0} widgets</span><span style={{ display: "flex", gap: 6 }}><a href={`/app/reports/${report.id}/edit`} data-ctl="live:REPORT-02 edit" style={{ alignSelf: "center", color: "var(--ledger-accent-action)", fontSize: 12 }}>{copy.edit}</a><Button variant="secondary" data-report-duplicate={report.id} data-ctl="live:REPORT-01 duplicate" onClick={() => onDuplicate?.(report.id)}>{copy.duplicate}</Button><Button variant="danger" data-report-delete={report.id} data-ctl="gated:REPORT-01 delete" state={onDelete ? { kind: "enabled" } : { kind: "disabled", reason: "Deleting a report needs an admin role on this business." }} onClick={() => setDeleteCandidate(report)}>{copy.delete}</Button></span></div>
            </article>)}
          </div>}
          <p data-reports-disclosure="" data-collection="h37-reports" data-cst={onLoadMore ? "paged" : "complete"} style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{totalCount == null ? `Showing ${reports.length} reports.` : `Showing ${reports.length} of ${totalCount} reports.`}</p>
          {onLoadMore ? <Button variant="secondary" data-report-load-more="" data-ctl="live:REPORT-01 load-more" onClick={onLoadMore} style={{ marginTop: 8 }}>{copy.loadMore}</Button> : null}
        </section>
        <section style={{ padding: 16, border: "1px solid var(--ledger-border-subtle)", borderRadius: 10, background: "var(--ledger-bg-surface)" }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Template Gallery</h2><p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>Start with a one-click structure, then customize every widget and slot.</p>
          <div data-template-gallery="" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginTop: 16 }}>{CUSTOM_REPORT_TEMPLATES.map((template) => <a key={template.id} href={`/app/reports/new?template=${template.id}`} style={{ padding: 14, border: "1px dashed var(--ledger-border-control)", borderRadius: 10, color: "inherit", textDecoration: "none" }}><div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span style={{ padding: "2px 6px", border: "1px solid var(--ledger-border-subtle)", borderRadius: 4, fontFamily: "var(--font-adc-mono), monospace", fontSize: 12, textTransform: "uppercase" }}>{template.category}</span><TemplateProviders template={template} /></div><TemplateMiniPreview definition={template.definition} className="mt-6" /><h3 style={{ margin: "14px 0 0", fontSize: 13 }}>{template.name}</h3><p style={{ margin: "5px 0 0", fontSize: 12, lineHeight: "18px", color: "var(--ledger-ink-tertiary)" }}>{template.description}</p><p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{template.definition.widgets.length} widgets · CSV · print</p></a>)}</div>
        </section>
      </div>
      <ZeroBaseDialog open={deleteCandidate !== null} onOpenChange={(open) => { if (!open) setDeleteCandidate(null); }} title="Delete saved report?" description={deleteCandidate ? `This permanently deletes “${deleteCandidate.name}”. This action cannot be undone.` : null} confirmLabel="Delete report" confirmCtl="gated:REPORT-01 delete-confirm" destructive onConfirm={() => { if (!deleteCandidate) return; onDelete?.(deleteCandidate.id); setDeleteCandidate(null); }} />
      <style>{`@media (max-width: 1040px) { [data-report-library-columns] { grid-template-columns: 1fr !important; } } @media (max-width: 620px) { [data-template-gallery] { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

/* --------------------------------------------------------------- builder */

function BuilderWidgetPreview({ widget, selected, selectedLabel }: { widget: Widget; selected: boolean; selectedLabel: string }) {
  const source = sourceById(widget.sourceId);
  const label = source?.label ?? widget.label ?? widget.sourceId;
  const isTrend = source?.id === "overview_trend";
  const isTable = source?.widget.includes("table") ?? false;
  return (
    <span style={{ display: "grid", height: "100%", minHeight: 0 }}>
      {selected ? (
        <span style={{ display: "flex", justifyContent: "space-between", gap: 8, margin: "-8px -8px 8px", padding: "4px 8px", background: "var(--ledger-accent-tint)", borderBottom: "1px solid var(--ledger-accent-action)", color: "var(--ledger-accent-action)", fontFamily: "var(--font-adc-mono), monospace", fontSize: 12, fontWeight: 700 }}>
          <span>{selectedLabel}</span>
          <span>row {widget.y + 1} · col {widget.x + 1} · {widget.w}×{widget.h}</span>
        </span>
      ) : null}
      <strong style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)", fontWeight: 500 }}>{label}</strong>
      {isTrend ? (
        <span aria-hidden="true" style={{ display: "flex", alignItems: "end", gap: 4, height: 44, marginTop: 8 }}>
          {[38, 54, 46, 68, 60, 82].map((height, index) => (
            <span key={height + index} style={{ flex: 1, height: `${height}%`, borderRadius: 3, background: index > 2 ? "var(--ledger-accent-action)" : "var(--ledger-accent-tint)" }} />
          ))}
        </span>
      ) : isTable ? (
        <span aria-hidden="true" style={{ display: "grid", gap: 5, marginTop: 8 }}>
          {[72, 54, 84].map((width) => (
            <span key={width} style={{ display: "block", width: `${width}%`, height: 6, borderRadius: 3, background: "var(--ledger-bg-inset)" }} />
          ))}
        </span>
      ) : source?.id === "overview_summary" ? (
        <span style={{ display: "block", marginTop: 8, fontFamily: "var(--font-adc-mono), monospace", fontSize: 17, color: "var(--ledger-ink-primary)" }}>{source.widget}</span>
      ) : (
        <span style={{ display: "block", marginTop: 8, fontSize: 12, color: "var(--ledger-ink-secondary)" }}>{source?.widget ?? label}</span>
      )}
    </span>
  );
}

export function ReportBuilderView({
  initial,
  name,
  onNameChange,
  onSave,
  onExportCsv,
  onRetryWidgets,
}: {
  initial: GridState;
  /** Both save routes require a name, so the builder collects one. */
  name?: string;
  onNameChange?: (name: string) => void;
  onSave?: (state: GridState) => void;
  onExportCsv?: () => void;
  /** Re-requests only the widgets that failed, not the whole report. */
  onRetryWidgets?: () => void;
}) {
  const copy = useCopy();
  const [history, setHistory] = useState(() => newHistory(initial));
  const [selected, setSelected] = useState<string | null>(initial.widgets[0]?.id ?? null);
  const [message, setMessage] = useState("");
  const [keyboardMode, setKeyboardMode] = useState(false);
  const [breakdown, setBreakdown] = useState("none");

  /**
   * Adopt a later `initial`.
   *
   * `useState` captures its argument once. The edit route loads its record
   * asynchronously and hands the grid down afterwards, so the mounted builder
   * stayed permanently blank on every stored report. The caller is expected to
   * gate on load as well; this is the second line of defence, and it only fires
   * when the identity actually changes so it cannot stomp an in-progress edit.
   */
  useEffect(() => {
    setHistory(newHistory(initial));
    setSelected(initial.widgets[0]?.id ?? null);
  }, [initial]);

  const dispatch = useCallback(
    (action: Parameters<typeof commit>[1]) => {
      setHistory((current) => commit(current, action));
    },
    [],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const action = keyboardAction({ key: event.key, shiftKey: event.shiftKey, selectedId: selected });
      if (!action) return;
      event.preventDefault();
      if (action.kind === "undo") {
        setHistory((current) => undo(current));
        setMessage("Undone.");
        return;
      }
      dispatch(action);
      setMessage(action.kind === "move" ? "Widget moved." : "Widget resized.");
    },
    [dispatch, selected],
  );

  const addable = useMemo(() => RENDERABLE_SOURCES, []);

  return (
    <div data-reports-surface="builder">
      <h1 style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", clipPath: "inset(50%)", whiteSpace: "nowrap" }}>{copy.reportBuilder}</h1>

      <p role="status" aria-live="polite" data-builder-live="" style={{ margin: message ? "0 0 8px" : 0, fontSize: 12, minHeight: message ? 16 : 0 }}>
        {message}
      </p>

      <div data-report-builder-grid="" style={{ display: "grid", gridTemplateColumns: "250px minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
      <aside style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)", position: "sticky", top: 112 }}>
      <section aria-label={copy.sources}>
        <h2 style={{ margin: 0, fontFamily: "var(--font-adc-mono), monospace", fontSize: 12, fontWeight: 500, letterSpacing: ".07em", color: "var(--ledger-ink-secondary)" }}>{copy.sources}</h2>
        <ul
          data-source-picker=""
          data-el="builder-sources"
          data-collection="sources"
          style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 4 }}
        >
          {addable.map((source) => (
            <li key={source.id}>
              <button
                type="button"
                data-source-add={source.id}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 34, padding: "4px 8px", border: `1px solid ${history.present.widgets.some((widget) => widget.sourceId === source.id) ? "var(--ledger-accent-action)" : "var(--ledger-border-subtle)"}`, borderRadius: 7, background: history.present.widgets.some((widget) => widget.sourceId === source.id) ? "var(--ledger-accent-tint)" : "var(--ledger-bg-surface)", color: "var(--ledger-ink-primary)", fontSize: 12, fontWeight: 600, textAlign: "left", cursor: "pointer" }}
                onClick={() =>
                  dispatch({
                    kind: "add",
                    widget: {
                      id: `w${Date.now()}-${source.id}`,
                      sourceId: source.id,
                      x: 0,
                      y: 0,
                      w: 4,
                      h: 2,
                    },
                  })
                }
              >
                <span aria-hidden="true" style={{ display: "grid", placeItems: "center", width: 16, height: 16, flex: "0 0 16px", border: "1px solid var(--ledger-accent-action)", borderRadius: 4, background: history.present.widgets.some((widget) => widget.sourceId === source.id) ? "var(--ledger-accent-action)" : "transparent", color: "var(--ledger-bg-surface)", fontSize: 12 }}>{history.present.widgets.some((widget) => widget.sourceId === source.id) ? "✓" : ""}</span>
                <span>{source.label}</span>
              </button>
            </li>
          ))}
          {COMING_SOON_SOURCES.map((source) => {
            const gate = canAddSource(source.id);
            return (
              <li key={source.id}>
                {/* Disabled, never hidden: hidden reads as "this data does not
                    exist" rather than "not wired yet". */}
                <button
                  type="button"
                  data-source-unavailable={source.id}
                  aria-disabled="true"
                  title={gate.ok ? "" : gate.reason}
                  onClick={(event) => event.preventDefault()}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 34, padding: "4px 8px", border: "1px dashed var(--ledger-border-control)", borderRadius: 7, background: "var(--ledger-bg-surface)", color: "var(--ledger-ink-secondary)", fontSize: 12, textAlign: "left", cursor: "not-allowed" }}
                >
                  <span aria-hidden="true" style={{ width: 15, height: 15, flex: "0 0 15px", border: "1px solid var(--ledger-border-control)", borderRadius: 4 }} />
                  <span style={{ flex: 1 }}>{source.label}</span><span style={{ fontFamily: "var(--font-adc-mono), monospace", fontSize: 12 }}>{source.reason}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <p style={{ margin: "7px 0 0", fontFamily: "var(--font-adc-mono), monospace", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
          {RENDERABLE_SOURCES.length + COMING_SOON_SOURCES.length} of {RENDERABLE_SOURCES.length + COMING_SOON_SOURCES.length} catalog sources · {RENDERABLE_SOURCES.length} renderable
        </p>
      </section>
      <section aria-label={copy.breakdown} style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--ledger-border-subtle)" }}>
        <h2 style={{ margin: 0, fontFamily: "var(--font-adc-mono), monospace", fontSize: 12, fontWeight: 500, letterSpacing: ".07em", color: "var(--ledger-ink-secondary)" }}>{copy.breakdown}</h2>
        <label style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, opacity: 0, pointerEvents: "none", whiteSpace: "nowrap" }}>
          {copy.breakdown}
          <select data-ctl="live:REPORT-07 breakdown" value={breakdown} onChange={(event) => setBreakdown(event.target.value)}>
            {["day", "week", "campaign", "ad set", "ad", "placement", "age"].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
          {["day", "week", "campaign", "ad set", "ad", "placement", "age"].map((value) => (
            <button
              key={value}
              type="button"
              data-breakdown-choice={value}
              aria-pressed={breakdown === value}
              onClick={() => setBreakdown(value)}
              style={{ minHeight: 30, padding: "3px 9px", border: `1px solid ${breakdown === value ? "var(--ledger-accent-action)" : "var(--ledger-border-subtle)"}`, borderRadius: 999, background: breakdown === value ? "var(--ledger-accent-tint)" : "var(--ledger-bg-surface)", color: "var(--ledger-accent-action)", fontSize: 12, cursor: "pointer" }}
            >
              {value}
            </button>
          ))}
        </div>
        <div data-el="source-contracts" style={{ marginTop: 8, padding: "8px 10px", border: "1px dashed var(--ledger-border-control)", borderRadius: 7, fontSize: 12, lineHeight: "17px", color: "var(--ledger-ink-secondary)" }}>
          {copy.sourceContractsNote}
        </div>
      </section>
      </aside>

      <section aria-label={copy.canvas} style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "end", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ minWidth: 220, flex: "1 1 320px" }}>
            <TextInput
              label={copy.reportName}
              data-report-name=""
              value={name ?? ""}
              onChange={(event) => onNameChange?.(event.target.value)}
            />
          </div>
          <span style={{ font: "12px/1.3 var(--font-mono, monospace)", color: "var(--ledger-ink-tertiary)" }}>{history.present.widgets.length} widgets · 12-column grid</span>
        </div>
        <p style={{ margin: "4px 0 8px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          Arrow keys move the selected widget; Shift with an arrow resizes it; Z undoes.
        </p>
        {/*
          The nudge toolbar — the single-pointer alternative to dragging
          (WCAG 2.5.7). It sits above the canvas rather than floating over it,
          so it can never cover the content being arranged — the reference
          draws it there — and it only exists once a widget is selected,
          because there is otherwise nothing for it to act on.
        */}
        {selected ? (
          <div
            data-builder-nudge-toolbar=""
            role="group"
            aria-label={`Move or resize ${sourceById(
              history.present.widgets.find((w) => w.id === selected)?.sourceId ?? "",
            )?.label ?? "the selected widget"}`}
            style={{ margin: "8px 0", display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}
          >
            {(
              [
                { label: "Move left", dx: -1, dy: 0 },
                { label: "Move right", dx: 1, dy: 0 },
                { label: "Move up", dx: 0, dy: -1 },
                { label: "Move down", dx: 0, dy: 1 },
              ] as const
            ).map((step) => (
              <Button
                key={step.label}
                variant="secondary"
                data-ctl="live:REPORT-03 nudge-move"
                aria-label={step.label}
                onClick={() => {
                  dispatch({ kind: "move", id: selected, dx: step.dx, dy: step.dy });
                  setMessage(`${step.label}.`);
                }}
                style={{ minWidth: 32, minHeight: 32, padding: "2px 8px" }}
              >
                {step.label === "Move left" ? "←" : step.label === "Move right" ? "→" : step.label === "Move up" ? "↑" : "↓"}
              </Button>
            ))}
            {(
              [
                { label: "Narrower", dw: -1, dh: 0 },
                { label: "Wider", dw: 1, dh: 0 },
                { label: "Shorter", dw: 0, dh: -1 },
                { label: "Taller", dw: 0, dh: 1 },
              ] as const
            ).map((step) => (
              <Button
                key={step.label}
                variant="secondary"
                data-ctl="live:REPORT-03 nudge-resize"
                aria-label={step.label}
                onClick={() => {
                  // The reducer clamps to min 1x1 and the grid width, so the
                  // toolbar never needs to know the bounds itself.
                  dispatch({ kind: "resize", id: selected, dw: step.dw, dh: step.dh });
                  setMessage(`${step.label}.`);
                }}
                style={{ minWidth: 34, minHeight: 32, padding: "2px 7px" }}
              >
                {step.label === "Narrower" ? "W−" : step.label === "Wider" ? "W+" : step.label === "Shorter" ? "H−" : "H+"}
              </Button>
            ))}
            <Button
              variant="secondary"
              data-ctl="live:REPORT-03 keyboard-mode"
              aria-pressed={keyboardMode}
              onClick={() => {
                setKeyboardMode((current) => !current);
                setMessage(
                  keyboardMode ? "Keyboard mode off." : "Keyboard mode on. Arrows move, Shift resizes.",
                );
              }}
              style={{ minHeight: 32, padding: "2px 8px" }}
            >
              {copy.keyboardMode}
            </Button>
            <Button
              variant="secondary"
              data-ctl="live:REPORT-03 exit"
              onClick={() => {
                setKeyboardMode(false);
                setSelected(null);
                setMessage("Layout committed.");
              }}
              style={{ minHeight: 32, padding: "2px 8px" }}
            >
              {copy.done}
            </Button>
          </div>
        ) : null}

        <div
          data-builder-canvas=""
          data-collection="table"
          role="application"
          aria-label={copy.reportCanvas}
          tabIndex={0}
          onKeyDown={onKeyDown}
          style={{ display: "grid", gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gridAutoRows: 40, gap: 8, minHeight: 310, padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: 12, background: "var(--ledger-bg-surface)" }}
        >
          {history.present.widgets.map((widget) => (
            <button
              key={widget.id}
              type="button"
              data-widget={widget.id}
              data-ctl="live:REPORT-03 widget-select"
              data-widget-x={widget.x}
              data-widget-w={widget.w}
              aria-pressed={selected === widget.id}
              onClick={() => setSelected(widget.id)}
              style={{
                textAlign: "left",
                padding: 8,
                minHeight: 44,
                border: selected === widget.id ? "2px solid var(--ledger-accent-action)" : "1px solid var(--ledger-border-control)",
                borderRadius: 6,
                background: "var(--ledger-bg-surface)",
                color: "var(--ledger-ink-primary)",
                gridColumn: `${widget.x + 1} / span ${Math.max(1, widget.w)}`,
                gridRow: `span ${Math.max(1, widget.h)}`,
                boxShadow: selected === widget.id ? "0 0 0 1px var(--ledger-accent-action)" : "none",
              }}
            >
              <BuilderWidgetPreview widget={widget} selected={selected === widget.id} selectedLabel={copy.selected} />
            </button>
          ))}
        </div>
        <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
          <Button
            variant="secondary"
            data-builder-undo=""
            data-ctl="live:REPORT-03 undo"
            state={canUndo(history) ? { kind: "enabled" } : { kind: "disabled", reason: "Nothing to undo." }}
            onClick={() => setHistory((current) => undo(current))}
          >
            {copy.undo}
          </Button>
          <Button variant="secondary" data-ctl="live:REPORT-08 retry" onClick={onRetryWidgets}>
            {copy.retry}
          </Button>
          <Button
            variant="secondary"
            data-builder-save=""
            state={
              (name ?? "").trim()
                ? { kind: "enabled" }
                : { kind: "disabled", reason: "A report needs a name before it can be saved." }
            }
            onClick={() => onSave?.(history.present)}
          >
            {copy.save}
          </Button>
        </div>
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "flex-end" }}>
          <Button variant="secondary" data-ctl="live:REPORT-04 csv" onClick={onExportCsv}>
            {copy.downloadCsv}
          </Button>
        </div>
        {/* What each source will and will not answer. Discovering a breakdown
            limit after building a report around it is the expensive way to
            learn it — so the note is read where the breakdown is chosen. */}
        <div data-el="h38-handoff" style={{ marginTop: 8 }}>
          <p
            data-el="source-contracts"
            style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}
          >
            {copy.sourceContractsNote}
          </p>
        </div>
      </section>
      </div>
      <style>{`@media(max-width:820px){[data-report-builder-grid]{grid-template-columns:1fr!important}[data-report-builder-grid]>aside{position:static!important}[data-builder-canvas]{grid-template-columns:1fr!important}[data-builder-canvas]>button{grid-column:1/-1!important;grid-row:auto!important}}`}</style>
    </div>
  );
}

/* --------------------------------------------------- viewer / print widget */

/**
 * One rendered widget, rendered as the type it actually is.
 *
 * The renderer emits a different payload per widget type: a metric carries
 * `value`/`deltaLabel`, a trend carries `points` or `series`, a table carries
 * `rows`/`columns`, and text carries `text`. The previous version pushed all of
 * them through a `DataTable` fed from `rows`, so every metric, trend and text
 * widget in a healthy report rendered as an empty table.
 *
 * Nothing is recomputed here. The renderer has already formatted values against
 * the report's currency; this component places them.
 */
export function RenderedWidgetCard({
  widget,
  /**
   * The stored `dataSource` for this widget id, from the report's definition.
   * The rendered payload does not carry one, and the CSV guard is a per-source
   * rule — so an unreadable definition fails the guard closed rather than
   * offering an export whose safety is unknown.
   */
  sourceId,
  onRetry,
  onExportCsv,
  exportState,
}: {
  widget: RenderedReportWidget;
  sourceId: string | null;
  onRetry?: () => void;
  onExportCsv?: () => void;
  exportState?: { pending: boolean; error: string | null };
}) {
  const copy = useCopy();
  const rows = widget.rows ?? [];
  const columns = widget.columns ?? Object.keys(rows[0] ?? {});
  // Two independent guards: the catalog's per-source rule, and whether the
  // export route would actually accept this widget.
  const routeGuard = widgetIsExportable(widget);
  const sourceGuard = sourceId
    ? canExportCsv(sourceId)
    : { ok: false as const, reason: "This widget's source could not be read, so export is withheld." };
  const csv = !routeGuard.ok ? routeGuard : sourceGuard;

  return (
    <section
      data-report-widget={widget.id}
      data-widget-type={widget.type}
      aria-label={widget.title}
      style={{ display: "grid", gap: 6 }}
    >
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{widget.title}</h3>
      {widget.subtitle ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{widget.subtitle}</p>
      ) : null}

      {/* A warning rides alongside the content rather than replacing it. */}
      {widget.warning ? (
        <p data-widget-warning={widget.id} style={{ margin: 0, fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
          {widget.warning}
        </p>
      ) : null}

      {widget.errorMessage ? (
        <div data-widget-state="error">
          {/* Inside the widget frame: a failed source must not blank the page. */}
          <p style={{ margin: 0, fontSize: 12, color: "var(--ledger-semantic-warn)" }}>{widget.errorMessage}</p>
          {widget.retryable ? (
            <Button variant="secondary" data-widget-retry={widget.id} onClick={onRetry}>
              {copy.retry}
            </Button>
          ) : (
            <p data-widget-retry-blocked={widget.id} style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
              {copy.retryNotMarked}
            </p>
          )}
        </div>
      ) : widget.emptyMessage ? (
        <p data-widget-state="empty" style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {widget.emptyMessage}
        </p>
      ) : widget.type === "metric" ? (
        <div data-widget-state="ready">
          <p data-widget-value={widget.id} style={{ margin: 0, fontSize: 22, fontWeight: 700, lineHeight: "28px" }}>
            {widget.value ?? "Not served"}
          </p>
          {widget.deltaLabel ? (
            <p data-widget-delta={widget.id} style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
              {widget.deltaLabel}
            </p>
          ) : null}
        </div>
      ) : widget.type === "trend" || widget.type === "bar" ? (
        <div data-widget-state="ready" data-widget-axis={widget.axisMode ?? "adaptive"}>
          {/* Points are listed, not drawn: a value an operator cannot read off
              the surface is a value they cannot check. */}
          {(widget.series ?? []).map((series) => (
            <dl key={series.key ?? series.label} data-widget-series={series.key ?? series.label} style={{ margin: 0 }}>
              <dt style={{ fontSize: 12, fontWeight: 600 }}>{series.label}</dt>
              {series.points.map((point) => (
                <dd key={point.label} data-point={point.label} style={{ margin: 0, fontSize: 12 }}>
                  {point.label}: {point.value}
                </dd>
              ))}
            </dl>
          ))}
          {widget.points ? (
            <dl data-widget-points={widget.id} style={{ margin: 0 }}>
              {widget.points.map((point) => (
                <div key={point.label}>
                  <dt style={{ fontSize: 12, display: "inline" }}>{point.label}: </dt>
                  <dd data-point={point.label} style={{ margin: 0, fontSize: 12, display: "inline" }}>
                    {point.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : widget.type === "text" || widget.type === "section" ? (
        <div data-widget-state="ready">
          <p data-widget-text={widget.id} style={{ margin: 0, fontSize: 12, lineHeight: "18px" }}>
            {widget.text ?? ""}
          </p>
        </div>
      ) : (
        <div data-widget-state="ready">
          <DataTable
            caption={widget.title}
            rows={[...rows]}
            // The widget id plus the row's position in the served order. The
            // previous Math.random() key remounted every row on every render.
            rowKey={(row, index) => `${widget.id}:${String(row.id ?? row.name ?? index)}`}
            columns={columns.map((key) => ({
              id: key,
              header: key,
              render: (row: Record<string, string | number | null>) => {
                const cell = row[key];
                return cell === null || cell === undefined ? "" : String(cell);
              },
            }))}
          />
        </div>
      )}

      {csv.ok ? (
        <div>
          <Button
            variant="quiet"
            data-widget-csv={widget.id}
            state={exportState?.pending ? { kind: "busy", label: "Preparing\u2026" } : { kind: "enabled" }}
            onClick={onExportCsv}
          >
            {copy.exportCsv}
          </Button>
          {exportState?.error ? (
            <p data-widget-csv-error={widget.id} style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
              {exportState.error}
            </p>
          ) : null}
        </div>
      ) : (
        <p data-widget-csv-blocked={widget.id} style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {csv.reason}
        </p>
      )}
    </section>
  );
}

/* ---------------------------------------------------------- disabled share */

export const SHARE_PREREQUISITES = [
  "A written operator authorization recorded in Appendix C.",
  "A decision on what happens to share tokens that were already issued.",
] as const;

/**
 * The print / PDF view (H39).
 *
 * No chrome and no controls: paper has no rail, no context bar and nothing to
 * click. What it does carry is the scope and the window the figures were served
 * for — a printed page outlives the session that produced it, and a number
 * without its window is unreadable a week later.
 */
export function ReportPrintView({
  name,
  scopeLine,
  windowLabel,
  snapshotAt,
  children,
}: {
  name: string;
  scopeLine: string;
  windowLabel: string;
  snapshotAt: string;
  children?: ReactNode;
}) {
  return (
    <article data-el="print-view" data-report-print="" style={{ maxWidth: 960, margin: "0 auto" }}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{name}</h1>
      <p style={{ margin: "4px 0 16px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
        {scopeLine} · {windowLabel} · as of {snapshotAt}
      </p>
      {children}
    </article>
  );
}

export function ReportShareDisabled() {
  const copy = useCopy();
  return (
    <section
      data-report-share="disabled"
      data-el="share-disabled-panel"
      aria-label={copy.sharing}
      style={{ marginTop: 20 }}
    >
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.sharing}</h2>
      <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
        {copy.sharingUnavailable}
      </p>
      <ul data-share-prerequisites="" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        {SHARE_PREREQUISITES.map((item) => (
          <li key={item} style={{ fontSize: 12, lineHeight: "17px" }}>
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}
