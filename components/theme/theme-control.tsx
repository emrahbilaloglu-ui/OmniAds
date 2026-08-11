"use client";

/**
 * Theme control: a three-option radio group, not a two-state toggle.
 *
 * A toggle cannot express "follow my OS", so choosing dark once would silently
 * opt the user out of ever following it again. The three options are rendered
 * as a real radiogroup so arrow keys move between them and screen readers
 * announce the set — `role="radio"` rather than three buttons that look
 * selected.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { usePreferencesStore } from "@/store/preferences-store";
import {
  THEME_ATTRIBUTE,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; hint: string }> = [
  { value: "system", label: "System", hint: "Follow your device setting" },
  { value: "light", label: "Light", hint: "Always light" },
  { value: "dark", label: "Dark", hint: "Always dark" },
];

export function ThemeControl({ className }: { className?: string }) {
  const theme = usePreferencesStore((state) => state.theme);
  const setTheme = usePreferencesStore((state) => state.setTheme);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Kept live: a user changing their OS theme while the page is open should
  // see it follow, not wait for a reload.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      setSystemPrefersDark(query.matches);
      if (usePreferencesStore.getState().theme === "system") {
        document.documentElement.setAttribute(
          THEME_ATTRIBUTE,
          query.matches ? "dark" : "light",
        );
      }
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  const resolved: ResolvedTheme = resolveTheme(theme, systemPrefersDark);
  const selectedIndex = OPTIONS.findIndex((option) => option.value === theme);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const last = OPTIONS.length - 1;
      let next = selectedIndex < 0 ? 0 : selectedIndex;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        next = selectedIndex >= last ? 0 : selectedIndex + 1;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        next = selectedIndex <= 0 ? last : selectedIndex - 1;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = last;
      }
      setTheme(OPTIONS[next].value);
      buttonRefs.current[next]?.focus();
    },
    [selectedIndex, setTheme],
  );

  return (
    <div className={className}>
      <div
        role="radiogroup"
        aria-label="Theme"
        onKeyDown={onKeyDown}
        style={{ display: "flex", gap: 4 }}
      >
        {OPTIONS.map((option, index) => {
          const checked = option.value === theme;
          return (
            <button
              key={option.value}
              ref={(node) => {
                buttonRefs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              // Roving tabindex: the group is one tab stop, arrows move inside.
              tabIndex={checked || (selectedIndex < 0 && index === 0) ? 0 : -1}
              title={option.hint}
              onClick={() => setTheme(option.value)}
              style={{
                minHeight: 24,
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: 500,
                borderRadius: "var(--ledger-radius-input)",
                cursor: "pointer",
                color: checked ? "var(--ledger-accent-action)" : "var(--ledger-ink-secondary)",
                background: checked ? "var(--ledger-accent-tint)" : "transparent",
                border: `1px solid ${checked ? "var(--ledger-accent-action)" : "var(--ledger-border-control)"}`,
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {/* Says what "System" currently resolves to, so the choice is not opaque. */}
      <p
        aria-live="polite"
        style={{ fontSize: 12, lineHeight: "16px", marginTop: 6, color: "var(--ledger-ink-tertiary)" }}
      >
        {theme === "system" ? `Following your device — currently ${resolved}.` : `Always ${resolved}.`}
      </p>
    </div>
  );
}
