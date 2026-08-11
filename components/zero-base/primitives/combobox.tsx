"use client";

/**
 * Combobox — business switcher, account/property/site pickers.
 *
 * Follows the APG combobox pattern directly: focus stays in the input and a
 * virtual cursor moves through the list via `aria-activedescendant`. This is
 * why the listbox is not a Radix Popover — a popover moves focus into its own
 * content when it opens, which pulls focus out of the input and makes typing
 * impossible. It is portalled by hand into the canonical host instead, so it
 * still inherits Ledger tokens rather than legacy `:root` ones.
 *
 * "No matches" is a rendered state with a way out, not an empty popup.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useZeroBasePortalContainer } from "@/components/zero-base/portal/portal-host";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Second line — account id, plan, whatever disambiguates duplicates. */
  detail?: string;
}

export interface ComboboxProps {
  label: string;
  options: readonly ComboboxOption[];
  value: string | null;
  onChange: (value: string) => void;
  /** Shown while a selection is being persisted, then read back. */
  status?: "idle" | "saving" | "saved";
  placeholder?: string;
}

export function Combobox({
  label,
  options,
  value,
  onChange,
  status = "idle",
  placeholder = "Search…",
}: ComboboxProps) {
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const container = useZeroBasePortalContainer();

  // The list is position:fixed inside the host, so it needs the input's box.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (rect) setAnchor({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        (option.detail?.toLowerCase().includes(needle) ?? false),
    );
  }, [options, query]);

  const selected = options.find((option) => option.value === value) ?? null;

  const commit = (option: ComboboxOption) => {
    onChange(option.value);
    setOpen(false);
    setQuery("");
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) =>
        filtered.length === 0 ? 0 : (current + delta + filtered.length) % filtered.length,
      );
      return;
    }
    if (event.key === "Enter" && open) {
      const option = filtered[activeIndex];
      if (option) {
        event.preventDefault();
        commit(option);
      }
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      setQuery("");
    }
  };

  const listbox = (
    <ul
      id={listboxId}
      role="listbox"
      aria-label={label}
      style={{
        position: "fixed",
        top: anchor?.top ?? 0,
        left: anchor?.left ?? 0,
        minWidth: anchor?.width ?? 240,
        listStyle: "none",
        margin: 0,
        padding: 4,
        maxHeight: 280,
        overflowY: "auto",
        background: "var(--ledger-bg-surface)",
        color: "var(--ledger-ink-primary)",
        border: "1px solid var(--ledger-border-control)",
        borderRadius: "var(--ledger-radius-panel)",
        boxShadow: "var(--ledger-elevation-2)",
      }}
    >
      {filtered.length === 0 ? (
        <li
          role="option"
          aria-selected={false}
          aria-disabled
          data-empty=""
          style={{ padding: "10px 12px", fontSize: 13, lineHeight: "19px", color: "var(--ledger-ink-tertiary)" }}
        >
          No matches for “{query}”.{" "}
          <button
            type="button"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            style={{
              minHeight: 24,
              background: "transparent",
              border: 0,
              padding: 0,
              color: "var(--ledger-accent-action)",
              cursor: "pointer",
              fontSize: 13,
              textDecoration: "underline",
            }}
          >
            Clear search
          </button>
        </li>
      ) : (
        filtered.map((option, index) => {
          const active = index === activeIndex;
          return (
            <li
              key={option.value}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              onMouseEnter={() => setActiveIndex(index)}
              // onMouseDown, not onClick: click fires after blur, which would
              // close the list before the selection lands.
              onMouseDown={(event) => {
                event.preventDefault();
                commit(option);
              }}
              style={{
                padding: "8px 12px",
                minHeight: 24,
                fontSize: 13,
                lineHeight: "19px",
                cursor: "pointer",
                background: active ? "var(--ledger-accent-tint)" : "transparent",
                color: active ? "var(--ledger-accent-action)" : "var(--ledger-ink-primary)",
                borderRadius: "var(--ledger-radius-input)",
              }}
            >
              {option.label}
              {option.detail ? (
                <span
                  style={{
                    display: "block",
                    fontFamily: "var(--font-adc-mono), ui-monospace, monospace",
                    fontSize: 12,
                    lineHeight: "16px",
                    color: "var(--ledger-ink-tertiary)",
                  }}
                >
                  {option.detail}
                </span>
              ) : null}
            </li>
          );
        })
      )}
    </ul>
  );

  return (
    <div>
      <label
        htmlFor={inputId}
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 500,
          lineHeight: "16px",
          color: "var(--ledger-ink-secondary)",
        }}
      >
        {label}
      </label>
      <input
        id={inputId}
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={open && filtered[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
        value={open ? query : (selected?.label ?? "")}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setQuery("");
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
          if (!open) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        style={{
          marginTop: 4,
          width: "100%",
          minHeight: 44,
          padding: "10px 12px",
          fontSize: 13,
          lineHeight: "19px",
          borderRadius: "var(--ledger-radius-input)",
          border: "1px solid var(--ledger-border-control)",
          background: "var(--ledger-bg-surface)",
          color: "var(--ledger-ink-primary)",
        }}
      />
      {open && container ? createPortal(listbox, container) : null}
      {/* Read-back: the user sees the selection confirmed, not assumed. */}
      <p
        aria-live="polite"
        style={{ fontSize: 12, lineHeight: "16px", marginTop: 4, color: "var(--ledger-ink-tertiary)" }}
      >
        {status === "saving"
          ? "Saving…"
          : status === "saved" && selected
            ? `Saved — ${selected.label}`
            : selected
              ? `Selected — ${selected.label}`
              : "Nothing selected"}
      </p>
    </div>
  );
}
