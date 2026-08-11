"use client";

/**
 * Checkbox and radio group, built on native inputs.
 *
 * Native `<input type="checkbox">` and `type="radio"` already carry the
 * keyboard model, the roles and the form semantics, and a wrapping `<label>`
 * makes the whole row the hit target for free. Reimplementing either on top of
 * a div buys nothing and loses everything, so these are thin.
 *
 * Radio groups keep their disabled reason on the group rather than on each
 * option — a reason repeated eleven times is noise.
 */
import { useId, type InputHTMLAttributes, type ReactNode } from "react";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  /** Present ⇒ the box is inert and this is rendered inline. */
  disabledReason?: string;
  error?: string | null;
}

export function Checkbox({ label, disabledReason, error, ...rest }: CheckboxProps) {
  const id = useId();
  const reasonId = `${id}-reason`;
  const errorId = `${id}-error`;
  const disabled = Boolean(disabledReason);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {/* The label wraps the input, so the whole row is the target. */}
      <label
        htmlFor={id}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          minHeight: 24,
          padding: "4px 0",
          fontSize: 13,
          lineHeight: "19px",
          color: disabled ? "var(--ledger-ink-tertiary)" : "var(--ledger-ink-primary)",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        <input
          {...rest}
          id={id}
          type="checkbox"
          aria-disabled={disabled || undefined}
          aria-describedby={
            [disabled ? reasonId : null, error ? errorId : null].filter(Boolean).join(" ") ||
            undefined
          }
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            if (disabled) {
              event.preventDefault();
              return;
            }
            rest.onChange?.(event);
          }}
          style={{ width: 16, height: 16, marginTop: 2, accentColor: "var(--ledger-accent-action)" }}
        />
        <span>{label}</span>
      </label>
      {disabled ? (
        <span id={reasonId} data-disabled-reason="" style={{ fontSize: 12, lineHeight: "16px", marginLeft: 24, color: "var(--ledger-ink-tertiary)" }}>
          {disabledReason}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} role="alert" style={{ fontSize: 12, lineHeight: "16px", marginLeft: 24, color: "var(--ledger-semantic-danger)" }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  /** Per-option refusal, rendered inline beside that option. */
  disabledReason?: string;
}

export interface RadioGroupProps<T extends string> {
  legend: string;
  name: string;
  value: T | null;
  options: ReadonlyArray<RadioOption<T>>;
  onChange: (value: T) => void;
  orientation?: "horizontal" | "vertical";
}

/**
 * A real `<fieldset>` + `<legend>`, so the group name is announced before the
 * options and arrow-key selection comes from the platform.
 */
export function RadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  orientation = "horizontal",
}: RadioGroupProps<T>) {
  const groupId = useId();

  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}>
      <legend
        style={{ fontSize: 12, fontWeight: 500, lineHeight: "16px", color: "var(--ledger-ink-secondary)", padding: 0 }}
      >
        {legend}
      </legend>
      <div
        style={{
          display: "flex",
          flexDirection: orientation === "vertical" ? "column" : "row",
          flexWrap: "wrap",
          gap: orientation === "vertical" ? 4 : 12,
          marginTop: 6,
        }}
      >
        {options.map((option) => {
          const optionId = `${groupId}-${option.value}`;
          const reasonId = `${optionId}-reason`;
          const disabled = Boolean(option.disabledReason);
          return (
            <div key={option.value} style={{ display: "flex", flexDirection: "column" }}>
              <label
                htmlFor={optionId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minHeight: 24,
                  fontSize: 13,
                  lineHeight: "19px",
                  color: disabled ? "var(--ledger-ink-tertiary)" : "var(--ledger-ink-primary)",
                  cursor: disabled ? "not-allowed" : "pointer",
                }}
              >
                <input
                  id={optionId}
                  type="radio"
                  name={name}
                  value={option.value}
                  checked={value === option.value}
                  aria-disabled={disabled || undefined}
                  aria-describedby={disabled ? reasonId : undefined}
                  onChange={() => {
                    if (disabled) return;
                    onChange(option.value);
                  }}
                  style={{ width: 16, height: 16, accentColor: "var(--ledger-accent-action)" }}
                />
                <span>{option.label}</span>
              </label>
              {disabled ? (
                <span
                  id={reasonId}
                  data-disabled-reason=""
                  style={{ fontSize: 12, lineHeight: "16px", marginLeft: 24, color: "var(--ledger-ink-tertiary)" }}
                >
                  {option.disabledReason}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
