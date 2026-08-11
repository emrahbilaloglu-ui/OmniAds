/**
 * The report builder grid (H38).
 *
 * A drag-and-drop canvas that only responds to a pointer excludes anyone who
 * cannot use one, so every operation — move, resize, undo — is expressed here
 * as a pure transition that a key press and a pointer drag both call. The
 * keyboard path is not a reduced fallback; it is the same model.
 *
 * Undo is a real stack rather than an inverse-operation guess: an inverse that
 * is computed can be wrong at a boundary (a widget clamped at the edge does not
 * move back the way it moved in), and an operator who presses undo and gets
 * something else stops trusting the canvas.
 */

export const GRID_COLUMNS = 12;
export const MIN_WIDTH = 2;
export const MIN_HEIGHT = 1;

export interface Widget {
  id: string;
  sourceId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridState {
  widgets: Widget[];
}

export type GridAction =
  | { kind: "move"; id: string; dx: number; dy: number }
  | { kind: "resize"; id: string; dw: number; dh: number }
  | { kind: "add"; widget: Widget }
  | { kind: "remove"; id: string };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Apply one action. Pure: the same input always produces the same grid. */
export function applyAction(state: GridState, action: GridAction): GridState {
  switch (action.kind) {
    case "add":
      return { widgets: [...state.widgets, action.widget] };
    case "remove":
      return { widgets: state.widgets.filter((widget) => widget.id !== action.id) };
    case "move":
      return {
        widgets: state.widgets.map((widget) =>
          widget.id === action.id
            ? {
                ...widget,
                // Clamped at the edges: a widget pushed past the grid would
                // render off-canvas and be unreachable by keyboard.
                x: clamp(widget.x + action.dx, 0, GRID_COLUMNS - widget.w),
                y: Math.max(0, widget.y + action.dy),
              }
            : widget,
        ),
      };
    case "resize":
      return {
        widgets: state.widgets.map((widget) => {
          if (widget.id !== action.id) return widget;
          const w = clamp(widget.w + action.dw, MIN_WIDTH, GRID_COLUMNS - widget.x);
          const h = Math.max(MIN_HEIGHT, widget.h + action.dh);
          return { ...widget, w, h };
        }),
      };
  }
}

export interface History {
  past: GridState[];
  present: GridState;
}

export function newHistory(present: GridState): History {
  return { past: [], present };
}

/** Push a change, recording the exact prior state rather than an inverse. */
export function commit(history: History, action: GridAction): History {
  const next = applyAction(history.present, action);
  return { past: [...history.past, history.present], present: next };
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: previous };
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}

/** Keyboard bindings. The same actions a pointer drag produces. */
export function keyboardAction(input: {
  key: string;
  shiftKey: boolean;
  selectedId: string | null;
}): GridAction | { kind: "undo" } | null {
  if (!input.selectedId) return null;
  const id = input.selectedId;
  if (input.key.toLowerCase() === "z") return { kind: "undo" };
  const step = 1;
  switch (input.key) {
    case "ArrowLeft":
      return input.shiftKey
        ? { kind: "resize", id, dw: -step, dh: 0 }
        : { kind: "move", id, dx: -step, dy: 0 };
    case "ArrowRight":
      return input.shiftKey
        ? { kind: "resize", id, dw: step, dh: 0 }
        : { kind: "move", id, dx: step, dy: 0 };
    case "ArrowUp":
      return input.shiftKey
        ? { kind: "resize", id, dw: 0, dh: -step }
        : { kind: "move", id, dx: 0, dy: -step };
    case "ArrowDown":
      return input.shiftKey
        ? { kind: "resize", id, dw: 0, dh: step }
        : { kind: "move", id, dx: 0, dy: step };
    default:
      return null;
  }
}

/* ------------------------------------------------------------ widget state */

export type WidgetState =
  | { kind: "ready" }
  | { kind: "empty"; grammar: string }
  | { kind: "error"; grammar: string; retryable: true };

/**
 * One widget failing must not blank the page.
 *
 * Each widget carries its own state so a failed source shows an error and a
 * retry inside its own frame while its neighbours keep rendering.
 */
export function widgetStateFor(input: {
  loaded: boolean;
  failed: boolean;
  rowCount: number;
  emptyGrammar: string | null;
  errorGrammar: string | null;
}): WidgetState {
  if (input.failed) {
    return {
      kind: "error",
      grammar: input.errorGrammar ?? "This source failed.",
      retryable: true,
    };
  }
  if (input.loaded && input.rowCount === 0) {
    return { kind: "empty", grammar: input.emptyGrammar ?? "Nothing was served for this window." };
  }
  return { kind: "ready" };
}
