"use client";

/**
 * Text input with a visible label and an error that does not steal focus.
 *
 * Two rules the design is explicit about and that are easy to get wrong:
 * the label is always a real `<label>` above the field — never a placeholder,
 * which disappears exactly when the user needs it — and validation errors are
 * announced without moving focus, because yanking focus mid-typing loses the
 * user's place.
 */
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  /** Verbatim server or validation text. Never softened. */
  error?: string | null;
  hint?: ReactNode;
  /** Right-aligns and switches to the mono face, for money and counts. */
  numeric?: boolean;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { label, error, hint, numeric, style, ...rest },
  ref,
) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label
        htmlFor={inputId}
        style={{ fontSize: 12, fontWeight: 500, lineHeight: "16px", color: "var(--ledger-ink-secondary)" }}
      >
        {label}
      </label>
      <input
        {...rest}
        id={inputId}
        ref={ref}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        style={{
          minHeight: 44,
          padding: "10px 12px",
          borderRadius: "var(--ledger-radius-input)",
          border: `1px solid ${error ? "var(--ledger-semantic-danger)" : "var(--ledger-border-control)"}`,
          background: "var(--ledger-bg-surface)",
          color: "var(--ledger-ink-primary)",
          fontSize: 13,
          lineHeight: "19px",
          fontFamily: numeric ? "var(--font-adc-mono), ui-monospace, monospace" : "inherit",
          textAlign: numeric ? "right" : "left",
          ...style,
        }}
      />
      {hint ? (
        <span id={hintId} style={{ fontSize: 12, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}>
          {hint}
        </span>
      ) : null}
      {error ? (
        // role=alert announces without moving focus; the caret stays put.
        <span
          id={errorId}
          role="alert"
          data-input-error=""
          style={{
            fontSize: 12,
            lineHeight: "16px",
            color: "var(--ledger-semantic-danger)",
            display: "flex",
            gap: 6,
            alignItems: "flex-start",
          }}
        >
          {/* Paired with text, never colour alone. */}
          <span aria-hidden="true">!</span>
          <span>{error}</span>
        </span>
      ) : null}
    </div>
  );
});
