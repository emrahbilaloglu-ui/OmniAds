"use client";

/**
 * Buttons, and the disabled-with-reason contract.
 *
 * A disabled control that does not say why is the single most common way this
 * product used to lie: the user sees a dead button and has to guess. So a
 * disabled button here is `aria-disabled`, not the `disabled` attribute —
 * meaning it stays focusable and discoverable — and the reason is rendered
 * inline and wired through `aria-describedby`. A tooltip is not acceptable:
 * it is unreachable by keyboard and invisible on touch.
 *
 * `aria-disabled` also means the click must be suppressed in JS, which is done
 * here rather than left to each caller.
 */
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from "react";

import type { ControlState } from "@/lib/zero-base/state-types";

export type ButtonVariant = "primary" | "secondary" | "danger" | "quiet";

export interface ZeroBaseButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  variant?: ButtonVariant;
  state?: ControlState;
  /** Marks a primary mobile action, which must be drawn at ≥44px. */
  primaryTarget?: boolean;
  children: ReactNode;
}

const VARIANT_STYLE: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: "var(--ledger-accent-action)",
    color: "var(--ledger-bg-surface)",
    border: "1px solid var(--ledger-accent-action)",
  },
  secondary: {
    background: "var(--ledger-bg-surface)",
    color: "var(--ledger-ink-primary)",
    border: "1px solid var(--ledger-border-control)",
  },
  danger: {
    background: "var(--ledger-bg-surface)",
    color: "var(--ledger-semantic-danger)",
    border: "1px solid var(--ledger-semantic-danger)",
  },
  quiet: {
    background: "transparent",
    color: "var(--ledger-accent-action)",
    border: "1px solid transparent",
  },
};

export const Button = forwardRef<HTMLButtonElement, ZeroBaseButtonProps>(function Button(
  { variant = "secondary", state = { kind: "enabled" }, primaryTarget, children, style, onClick, ...rest },
  ref,
) {
  const reasonId = useId();
  const disabled = state.kind === "disabled";
  const busy = state.kind === "busy";

  return (
    <>
      <button
        {...rest}
        ref={ref}
        type={rest.type ?? "button"}
        aria-disabled={disabled || busy || undefined}
        aria-describedby={disabled ? reasonId : rest["aria-describedby"]}
        aria-busy={busy || undefined}
        data-variant={variant}
        data-primary={primaryTarget ? "" : undefined}
        onClick={(event) => {
          // aria-disabled does not stop activation the way `disabled` does.
          if (disabled || busy) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
        style={{
          ...VARIANT_STYLE[variant],
          minHeight: primaryTarget ? 44 : 24,
          minWidth: 24,
          padding: primaryTarget ? "10px 16px" : "8px 14px",
          borderRadius: "var(--ledger-radius-button)",
          fontSize: 13,
          fontWeight: 600,
          lineHeight: "19px",
          cursor: disabled ? "not-allowed" : busy ? "progress" : "pointer",
          opacity: disabled ? 0.72 : 1,
          borderStyle: disabled ? "dashed" : "solid",
          transition: "background var(--ledger-motion-fast) var(--ledger-motion-easing)",
          ...style,
        }}
      >
        {busy && state.label ? state.label : children}
      </button>
      {disabled ? (
        <span
          id={reasonId}
          data-disabled-reason=""
          style={{
            display: "block",
            fontSize: 12,
            lineHeight: "16px",
            marginTop: 4,
            color: "var(--ledger-ink-tertiary)",
            // Never truncated: a reason the user cannot read is not a reason.
            overflowWrap: "anywhere",
          }}
        >
          {state.reason}
        </span>
      ) : null}
    </>
  );
});

export interface IconButtonProps extends Omit<ZeroBaseButtonProps, "children" | "variant"> {
  /** Exact action, e.g. "Move left one column". Never just "Move". */
  label: string;
  children: ReactNode;
}

/**
 * Icon-only button. The label is mandatory and becomes the accessible name —
 * an icon button without one is indistinguishable from decoration.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, primaryTarget, ...rest },
  ref,
) {
  return (
    <Button
      {...rest}
      ref={ref}
      variant="quiet"
      primaryTarget={primaryTarget}
      aria-label={label}
      title={label}
      style={{ padding: primaryTarget ? 10 : 4, minWidth: primaryTarget ? 44 : 24, ...rest.style }}
    >
      {children}
    </Button>
  );
});
