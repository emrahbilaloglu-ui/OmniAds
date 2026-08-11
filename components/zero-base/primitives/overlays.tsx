"use client";

/**
 * Dialog, menu, popover and sheet — every zero-base overlay.
 *
 * All four share one non-negotiable detail: `container` is the canonical
 * portal host, never the default `document.body`. Portalling to body puts the
 * overlay outside `[data-adc-ui="zero-base"]`, where the Ledger custom
 * properties do not resolve, so it silently renders with legacy colours and
 * the legacy focus ring. That is exactly the failure the primitive tests
 * assert against.
 *
 * Focus trap and Escape-to-close come from Radix and are not reimplemented.
 * Focus *return* is handled here — see `useFocusReturn` for why Radix's own
 * restore does not fire for externally-controlled overlays. Also added: the
 * Ledger surface, the confirm-phrase gate, and initial focus landing on the
 * least destructive control.
 */
import {
  Dialog as RadixDialog,
  DropdownMenu as RadixDropdownMenu,
  Popover as RadixPopover,
} from "radix-ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useZeroBasePortalContainer } from "@/components/zero-base/portal/portal-host";
import { Button } from "@/components/zero-base/primitives/button";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

const overlaySurface: React.CSSProperties = {
  background: "var(--ledger-bg-surface)",
  color: "var(--ledger-ink-primary)",
  border: "1px solid var(--ledger-border-control)",
  boxShadow: "var(--ledger-elevation-2)",
};

const scrimStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--ledger-scrim)",
};

/**
 * Explicit focus return.
 *
 * Radix restores focus on unmount, but only when it can identify the element
 * that opened the overlay — which it cannot when `open` is driven by external
 * state rather than a `Dialog.Trigger`, and focus then falls to `<body>`. That
 * strands keyboard users at the top of the document every time they press
 * Escape. This records the opener itself and puts focus back.
 */
function useFocusReturn(open: boolean) {
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      if (active instanceof HTMLElement) openerRef.current = active;
    }
  }, [open]);

  return useCallback((event: Event) => {
    const opener = openerRef.current;
    if (!opener || !opener.isConnected) return;
    event.preventDefault();
    opener.focus();
  }, []);
}

/* ------------------------------------------------------------------ dialog */

export interface ZeroBaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Restates scope and before → after, so the user confirms a fact. */
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
  /** When set, the exact phrase must be typed before confirm enables. */
  confirmPhrase?: string;
  /** Verbatim failure text. The dialog stays open so nothing is lost. */
  error?: string | null;
  submitting?: boolean;
}

export function ZeroBaseDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  onConfirm,
  destructive,
  confirmPhrase,
  error,
  submitting,
}: ZeroBaseDialogProps) {
  const copy = useCopy();
  const container = useZeroBasePortalContainer();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const onCloseAutoFocus = useFocusReturn(open);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  const phraseComplete = !confirmPhrase || typed === confirmPhrase;
  const confirmState = submitting
    ? ({ kind: "busy", label: "Working…" } as const)
    : phraseComplete
      ? ({ kind: "enabled" } as const)
      : ({ kind: "disabled", reason: `Type ${confirmPhrase} to enable this action.` } as const);

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal container={container}>
        <RadixDialog.Overlay style={scrimStyle} />
        <RadixDialog.Content
          // Least destructive control takes focus, so Enter cannot destroy.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
          onCloseAutoFocus={onCloseAutoFocus}
          style={{
            ...overlaySurface,
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "min(440px, calc(100vw - 32px))",
            maxHeight: "calc(100vh - 32px)",
            overflowY: "auto",
            borderRadius: "var(--ledger-radius-dialog)",
            padding: 20,
          }}
        >
          <RadixDialog.Title style={{ fontSize: 16, fontWeight: 600, lineHeight: "22px", margin: 0 }}>
            {title}
          </RadixDialog.Title>
          {description ? (
            <RadixDialog.Description
              style={{ fontSize: 13, lineHeight: "19px", color: "var(--ledger-ink-secondary)", marginTop: 8 }}
            >
              {description}
            </RadixDialog.Description>
          ) : null}
          {children}
          {confirmPhrase ? (
            <label style={{ display: "block", marginTop: 12, fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
              {copy.type} <code style={{ fontFamily: "var(--font-adc-mono), monospace" }}>{confirmPhrase}</code> to confirm
              <input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 4,
                  minHeight: 44,
                  padding: "10px 12px",
                  fontSize: 13,
                  borderRadius: "var(--ledger-radius-input)",
                  border: "1px solid var(--ledger-border-control)",
                  background: "var(--ledger-bg-surface)",
                  color: "var(--ledger-ink-primary)",
                }}
              />
            </label>
          ) : null}
          {error ? (
            <p
              role="alert"
              style={{ marginTop: 12, fontSize: 12, lineHeight: "16px", color: "var(--ledger-semantic-danger)" }}
            >
              {error}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <RadixDialog.Close asChild>
              <Button ref={cancelRef} variant="secondary">
                {copy.cancel}
              </Button>
            </RadixDialog.Close>
            <Button
              variant={destructive ? "danger" : "primary"}
              state={confirmState}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/* -------------------------------------------------------------------- menu */

export interface MenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  /** Present ⇒ item is inert and shows this inline, not as a tooltip. */
  disabledReason?: string;
}

export function ZeroBaseMenu({
  trigger,
  items,
  label,
}: {
  trigger: ReactNode;
  items: readonly MenuItem[];
  label: string;
}) {
  const container = useZeroBasePortalContainer();

  return (
    <RadixDropdownMenu.Root>
      <RadixDropdownMenu.Trigger asChild>{trigger}</RadixDropdownMenu.Trigger>
      <RadixDropdownMenu.Portal container={container}>
        <RadixDropdownMenu.Content
          aria-label={label}
          sideOffset={4}
          style={{ ...overlaySurface, minWidth: 200, borderRadius: "var(--ledger-radius-panel)", padding: 4 }}
        >
          {items.map((item) => {
            const disabled = Boolean(item.disabledReason);
            return (
              <RadixDropdownMenu.Item
                key={item.id}
                // Kept in the tab order when disabled so the reason is
                // discoverable rather than hidden behind a dead control.
                disabled={false}
                aria-disabled={disabled || undefined}
                onSelect={(event) => {
                  if (disabled) {
                    event.preventDefault();
                    return;
                  }
                  item.onSelect();
                }}
                style={{
                  display: "block",
                  padding: "8px 10px",
                  minHeight: 24,
                  fontSize: 13,
                  lineHeight: "19px",
                  borderRadius: "var(--ledger-radius-input)",
                  color: disabled ? "var(--ledger-ink-tertiary)" : "var(--ledger-ink-primary)",
                  cursor: disabled ? "not-allowed" : "pointer",
                  outline: "none",
                }}
              >
                {item.label}
                {disabled ? (
                  <span
                    data-disabled-reason=""
                    style={{ display: "block", fontSize: 12, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}
                  >
                    {item.disabledReason}
                  </span>
                ) : null}
              </RadixDropdownMenu.Item>
            );
          })}
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  );
}

/* ----------------------------------------------------------------- popover */

export function ZeroBasePopover({
  trigger,
  children,
  label,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  children: ReactNode;
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const container = useZeroBasePortalContainer();

  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal container={container}>
        <RadixPopover.Content
          aria-label={label}
          sideOffset={4}
          style={{ ...overlaySurface, borderRadius: "var(--ledger-radius-panel)", padding: 12 }}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/* ------------------------------------------------------------------- sheet */

export type SheetSide = "right" | "bottom";

/**
 * Drawer/sheet. Uses the dialog primitive because it *is* a modal dialog —
 * same trap, same Escape, same focus return — drawn from an edge.
 */
export function ZeroBaseSheet({
  open,
  onOpenChange,
  title,
  side = "right",
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  side?: SheetSide;
  /**
   * Sentence describing the sheet's purpose, announced after its title.
   *
   * Optional because some sheets — the navigation drawer, the scope sheet —
   * are wholly described by their own contents, and inventing a sentence for
   * them would add noise. When absent the dialog says so explicitly rather
   * than leaving `aria-describedby` dangling at a missing element.
   */
  description?: string;
  children: ReactNode;
}) {
  const copy = useCopy();
  const container = useZeroBasePortalContainer();
  const onCloseAutoFocus = useFocusReturn(open);
  const fromRight = side === "right";

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal container={container}>
        <RadixDialog.Overlay style={scrimStyle} />
        <RadixDialog.Content
          aria-label={title}
          // Explicitly undefined: Radix warns when a dialog has neither a
          // description nor a deliberate opt-out. When `description` is given,
          // the Description below wires this through context regardless.
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          style={{
            ...overlaySurface,
            position: "fixed",
            top: fromRight ? 0 : "auto",
            right: 0,
            bottom: 0,
            left: fromRight ? "auto" : 0,
            width: fromRight ? "min(480px, 100vw)" : "100vw",
            maxHeight: fromRight ? "100vh" : "85vh",
            overflowY: "auto",
            borderRadius: fromRight
              ? "var(--ledger-radius-dialog) 0 0 var(--ledger-radius-dialog)"
              : "var(--ledger-radius-dialog) var(--ledger-radius-dialog) 0 0",
            padding: 16,
          }}
        >
          <RadixDialog.Title style={{ fontSize: 16, fontWeight: 600, lineHeight: "22px", margin: 0 }}>
            {title}
          </RadixDialog.Title>
          {description ? (
            <RadixDialog.Description
              style={{
                margin: "4px 0 0",
                fontSize: 12.5,
                lineHeight: "18px",
                color: "var(--ledger-ink-secondary)",
              }}
            >
              {description}
            </RadixDialog.Description>
          ) : null}
          {children}
          <RadixDialog.Close asChild>
            <Button variant="secondary" primaryTarget style={{ marginTop: 16 }}>
              {copy.close}
            </Button>
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
