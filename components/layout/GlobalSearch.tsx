"use client";

/**
 * What a shell keystroke should do to the command palette.
 *
 * The shortcut stays inert while an operator is typing or composing text. The
 * palette's own input handles Escape locally; this resolver covers the global
 * launcher and body-level close path mounted by DashboardFrame.
 */
export type GlobalSearchShortcutAction = "open" | "close" | "ignore";

export function resolveGlobalSearchShortcut(input: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  target: "body" | "input" | "textarea" | "contenteditable";
  isOpen?: boolean;
  isComposing?: boolean;
  inOwnField?: boolean;
}): GlobalSearchShortcutAction {
  if (input.isComposing) return "ignore";

  if (input.key === "Escape") {
    if (!input.isOpen) return "ignore";
    if (input.target === "body" || input.inOwnField) return "close";
    return "ignore";
  }

  if (input.key.toLowerCase() !== "k") return "ignore";
  if (!input.metaKey && !input.ctrlKey) return "ignore";
  if (input.target !== "body") return "ignore";
  return "open";
}

/** The canonical topbar launcher. Search happens only inside CommandPalette. */
export function GlobalSearch({
  open,
  onOpen,
}: {
  open: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="adv-search hidden md:inline-flex"
      aria-label="Jump or act"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls="dashboard-command-palette"
      onClick={onOpen}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      >
        <path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35" />
      </svg>
      <span className="min-w-0 flex-1 truncate text-left">Jump or act…</span>
      <span
        data-search-shortcut-hint="true"
        aria-hidden="true"
        className="adv-kbd ml-auto"
      >
        ⌘K
      </span>
    </button>
  );
}
