"use client";

/**
 * Report widget grid — keyboard-first, with undo.
 *
 * Drag-and-drop is not an accessible way to arrange a layout, so arrangement
 * is defined by keyboard first and pointer second: arrows move a selected
 * widget one cell, Shift+arrows resize it, Escape reverts the in-flight edit,
 * and Ctrl/Cmd+Z unwinds up to 50 steps. Every one of those announces the new
 * position, because a silent move is indistinguishable from a broken one.
 *
 * Hitting a boundary announces "edge reached" rather than doing nothing —
 * silence there reads as a bug.
 */
import { useCallback, useRef, useState } from "react";

import { IconButton } from "@/components/zero-base/primitives/button";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export interface WidgetPlacement {
  id: string;
  title: string;
  /** 1-based, matching what is announced to the user. */
  row: number;
  column: number;
  width: number;
  height: number;
}

export const UNDO_DEPTH = 50;

export interface WidgetGridProps {
  widgets: readonly WidgetPlacement[];
  columns: number;
  rows: number;
  onChange: (widgets: WidgetPlacement[]) => void;
}

function describe(widget: WidgetPlacement): string {
  return `${widget.title} — row ${widget.row}, col ${widget.column}, ${widget.width}×${widget.height}`;
}

export function WidgetGrid({ widgets, columns, rows, onChange }: WidgetGridProps) {
  const copy = useCopy();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const history = useRef<WidgetPlacement[][]>([]);
  // Snapshot taken when a widget is selected, so Escape reverts the whole edit
  // rather than one step of it.
  const editBaseline = useRef<WidgetPlacement[] | null>(null);

  const commit = useCallback(
    (next: WidgetPlacement[], message: string) => {
      history.current = [...history.current, widgets.map((w) => ({ ...w }))].slice(-UNDO_DEPTH);
      onChange(next);
      setAnnouncement(message);
    },
    [onChange, widgets],
  );

  const move = useCallback(
    (widget: WidgetPlacement, deltaRow: number, deltaColumn: number) => {
      const row = widget.row + deltaRow;
      const column = widget.column + deltaColumn;
      if (row < 1 || column < 1 || row + widget.height - 1 > rows || column + widget.width - 1 > columns) {
        setAnnouncement(`Edge reached — ${widget.title} stays at row ${widget.row}, col ${widget.column}.`);
        return;
      }
      const next = widgets.map((w) => (w.id === widget.id ? { ...w, row, column } : w));
      commit(next, describe({ ...widget, row, column }));
    },
    [columns, commit, rows, widgets],
  );

  const resize = useCallback(
    (widget: WidgetPlacement, deltaWidth: number, deltaHeight: number) => {
      const width = widget.width + deltaWidth;
      const height = widget.height + deltaHeight;
      if (
        width < 1 ||
        height < 1 ||
        widget.column + width - 1 > columns ||
        widget.row + height - 1 > rows
      ) {
        setAnnouncement(`Edge reached — ${widget.title} stays ${widget.width}×${widget.height}.`);
        return;
      }
      const next = widgets.map((w) => (w.id === widget.id ? { ...w, width, height } : w));
      commit(next, describe({ ...widget, width, height }));
    },
    [columns, commit, rows, widgets],
  );

  const undo = useCallback(() => {
    const previous = history.current.pop();
    if (!previous) {
      setAnnouncement("Nothing to undo.");
      return;
    }
    onChange(previous);
    setAnnouncement("Undone.");
  }, [onChange]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, widget: WidgetPlacement) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (editBaseline.current) {
        onChange(editBaseline.current.map((w) => ({ ...w })));
        setAnnouncement(`Reverted — ${widget.title} back to its previous position.`);
      }
      return;
    }
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    if (event.shiftKey) {
      // Shift resizes: rows grow height, columns grow width.
      resize(widget, delta[1], delta[0]);
    } else {
      move(widget, delta[0], delta[1]);
    }
  };

  return (
    <div>
      <div
        role="application"
        aria-label={copy.reportLayout}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: 12,
        }}
      >
        {widgets.map((widget) => {
          const selected = widget.id === selectedId;
          return (
            <div
              key={widget.id}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={describe(widget)}
              onFocus={() => {
                setSelectedId(widget.id);
                editBaseline.current = widgets.map((w) => ({ ...w }));
              }}
              onKeyDown={(event) => onKeyDown(event, widget)}
              style={{
                gridRow: `${widget.row} / span ${widget.height}`,
                gridColumn: `${widget.column} / span ${widget.width}`,
                minHeight: 88,
                padding: 12,
                borderRadius: "var(--ledger-radius-card)",
                background: "var(--ledger-bg-surface)",
                border: selected
                  ? "2px solid var(--ledger-accent-action)"
                  : "1px solid var(--ledger-border-subtle)",
              }}
            >
              <p style={{ margin: 0, fontSize: 14, fontWeight: 600, lineHeight: "20px" }}>{widget.title}</p>
              <p
                style={{
                  margin: "2px 0 0",
                  fontFamily: "var(--font-adc-mono), ui-monospace, monospace",
                  fontSize: 12,
                  lineHeight: "16px",
                  color: "var(--ledger-ink-tertiary)",
                }}
              >
                row {widget.row}, col {widget.column}, {widget.width}×{widget.height}
              </p>
              {/* Pointer equivalents of the keyboard moves, at mobile size. */}
              <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                <IconButton
                  label={`Move ${widget.title} left one column`}
                  primaryTarget
                  onClick={() => move(widget, 0, -1)}
                >
                  <span aria-hidden="true">←</span>
                </IconButton>
                <IconButton
                  label={`Move ${widget.title} right one column`}
                  primaryTarget
                  onClick={() => move(widget, 0, 1)}
                >
                  <span aria-hidden="true">→</span>
                </IconButton>
              </div>
            </div>
          );
        })}
      </div>
      <p role="status" aria-live="polite" data-grid-announcement="" style={{ fontSize: 12, marginTop: 8, color: "var(--ledger-ink-tertiary)" }}>
        {announcement}
      </p>
    </div>
  );
}
