"use client";

/**
 * Reports library, builder, viewer and print (H37–H40).
 *
 * The canonical report UI has **no mint or share control anywhere**. WP-03A's
 * fail-closed branch is the server's answer; a button here would be a control
 * whose only outcome is a refusal, and its absence is asserted by test.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { RenderedReportWidget } from "@/lib/custom-reports";

import { DataTable } from "@/components/zero-base/collections/data-table";
import { Button } from "@/components/zero-base/primitives/button";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
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

/* --------------------------------------------------------------- library */

export interface ReportSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export function ReportLibraryView({
  reports,
  onCreate,
  onDuplicate,
  unavailableReason,
}: {
  reports: readonly ReportSummary[];
  onCreate?: () => void;
  onDuplicate?: (id: string) => void;
  unavailableReason?: string | null;
}) {
  if (unavailableReason) {
    return (
      <div data-reports-surface="library">
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Reports</h1>
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      </div>
    );
  }
  return (
    <div data-reports-surface="library">
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>Reports</h1>
      <div style={{ marginTop: 12 }}>
        <Button variant="secondary" data-report-create="" onClick={onCreate}>
          New report
        </Button>
      </div>
      {reports.length === 0 ? (
        <p data-reports="empty" style={{ marginTop: 12, fontSize: 12.5, color: "var(--ledger-ink-tertiary)" }}>
          No reports have been created for this business yet.
        </p>
      ) : (
        <div style={{ marginTop: 16 }}>
          <DataTable
            caption="Reports"
            rows={[...reports]}
            rowKey={(row) => row.id}
            columns={[
              { id: "name", header: "Report", render: (row) => row.name },
              { id: "updated", header: "Updated", render: (row) => row.updatedAt },
              {
                id: "actions",
                header: "Actions",
                render: (row) => (
                  <Button variant="secondary" data-report-duplicate={row.id} onClick={() => onDuplicate?.(row.id)}>
                    Duplicate
                  </Button>
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- builder */

export function ReportBuilderView({
  initial,
  name,
  onNameChange,
  onSave,
}: {
  initial: GridState;
  /** Both save routes require a name, so the builder collects one. */
  name?: string;
  onNameChange?: (name: string) => void;
  onSave?: (state: GridState) => void;
}) {
  const [history, setHistory] = useState(() => newHistory(initial));
  const [selected, setSelected] = useState<string | null>(initial.widgets[0]?.id ?? null);
  const [message, setMessage] = useState("");

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
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>Report builder</h1>

      <p role="status" aria-live="polite" data-builder-live="" style={{ margin: "6px 0 0", fontSize: 12, minHeight: 16 }}>
        {message}
      </p>

      <section aria-label="Name" style={{ marginTop: 12, maxWidth: 360 }}>
        <TextInput
          label="Report name"
          data-report-name=""
          value={name ?? ""}
          onChange={(event) => onNameChange?.(event.target.value)}
          hint="Required — both save routes refuse a report without one."
        />
      </section>

      <section aria-label="Sources" style={{ marginTop: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Sources</h2>
        <ul data-source-picker="" style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
          {addable.map((source) => (
            <li key={source.id}>
              <Button
                variant="secondary"
                data-source-add={source.id}
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
                {source.label}
              </Button>
            </li>
          ))}
          {COMING_SOON_SOURCES.map((source) => {
            const gate = canAddSource(source.id);
            return (
              <li key={source.id}>
                {/* Disabled, never hidden: hidden reads as "this data does not
                    exist" rather than "not wired yet". */}
                <Button
                  variant="secondary"
                  data-source-unavailable={source.id}
                  state={{ kind: "disabled", reason: gate.ok ? "" : gate.reason, code: "source_unavailable" }}
                >
                  {source.label}
                </Button>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-label="Canvas" style={{ marginTop: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Canvas</h2>
        <p style={{ margin: "4px 0 8px", fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
          Arrow keys move the selected widget; Shift with an arrow resizes it; Z undoes.
        </p>
        <div
          data-builder-canvas=""
          role="application"
          aria-label="Report canvas"
          tabIndex={0}
          onKeyDown={onKeyDown}
          style={{ display: "grid", gap: 6, padding: 8, border: "1px solid var(--ledger-border-control)", borderRadius: 8 }}
        >
          {history.present.widgets.map((widget) => (
            <button
              key={widget.id}
              type="button"
              data-widget={widget.id}
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
              }}
            >
              {sourceById(widget.sourceId)?.label ?? widget.label ?? widget.sourceId}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
          <Button
            variant="secondary"
            data-builder-undo=""
            state={canUndo(history) ? { kind: "enabled" } : { kind: "disabled", reason: "Nothing to undo." }}
            onClick={() => setHistory((current) => undo(current))}
          >
            Undo
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
            Save
          </Button>
        </div>
      </section>
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
}: {
  widget: RenderedReportWidget;
  sourceId: string | null;
  onRetry?: () => void;
  onExportCsv?: () => void;
}) {
  const rows = widget.rows ?? [];
  const columns = widget.columns ?? Object.keys(rows[0] ?? {});
  const csv = sourceId
    ? canExportCsv(sourceId)
    : { ok: false as const, reason: "This widget's source could not be read, so export is withheld." };

  return (
    <section
      data-report-widget={widget.id}
      data-widget-type={widget.type}
      aria-label={widget.title}
      style={{ display: "grid", gap: 6 }}
    >
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{widget.title}</h3>
      {widget.subtitle ? (
        <p style={{ margin: 0, fontSize: 11.5, color: "var(--ledger-ink-tertiary)" }}>{widget.subtitle}</p>
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
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>{widget.errorMessage}</p>
          {widget.retryable ? (
            <Button variant="secondary" data-widget-retry={widget.id} onClick={onRetry}>
              Retry
            </Button>
          ) : (
            <p data-widget-retry-blocked={widget.id} style={{ margin: 0, fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
              The renderer did not mark this failure as retryable.
            </p>
          )}
        </div>
      ) : widget.emptyMessage ? (
        <p data-widget-state="empty" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-ink-tertiary)" }}>
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
          <p data-widget-text={widget.id} style={{ margin: 0, fontSize: 12.5, lineHeight: "18px" }}>
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
          <Button variant="quiet" data-widget-csv={widget.id} onClick={onExportCsv}>
            Export CSV
          </Button>
        </div>
      ) : (
        <p data-widget-csv-blocked={widget.id} style={{ margin: 0, fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
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

export function ReportShareDisabled() {
  return (
    <section data-report-share="disabled" aria-label="Sharing" style={{ marginTop: 20 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Sharing</h2>
      <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
        Report sharing is not available from this product. There is no control here to mint a link.
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
