"use client";

/**
 * Global search overlay.
 *
 * Labelled exactly `Businesses + Meta entities`, because the honest scope is
 * narrower than "search" implies — a buyer who types a Google campaign name
 * and gets nothing should be able to see why without guessing.
 *
 * `/` opens it from anywhere except a text field, where `/` is a character the
 * user is trying to type. Escape closes and returns focus to whatever opened
 * it. Results keep focus in the input and move a virtual cursor, the same APG
 * pattern the combobox uses.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { ZeroBaseSheet } from "@/components/zero-base/primitives/overlays";
import {
  SEARCH_PERMISSION_EMPTY,
  SEARCH_SCOPE_LABEL,
  SEARCH_ZERO_RESULT,
  type ZeroBaseSearchResult,
} from "@/lib/zero-base/search-adapter";
import type { CollectionEnvelope } from "@/lib/zero-base/state-types";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export interface SearchOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  envelope: CollectionEnvelope<ZeroBaseSearchResult> | null;
  loading?: boolean;
  permissionEmpty?: boolean;
}

/** Opens on `/`, but never while the user is typing into a field. */
export function useSearchHotkey(onOpen: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      onOpen();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onOpen]);
}

export function SearchOverlay({
  open,
  onOpenChange,
  query,
  onQueryChange,
  envelope,
  loading,
  permissionEmpty,
}: SearchOverlayProps) {
  const copy = useCopy();
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const items = envelope?.items ?? [];
  const listboxId = "zero-base-search-listbox";

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (items.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((current) => (current + delta + items.length) % items.length);
        return;
      }
      if (event.key === "Enter") {
        const item = items[activeIndex];
        if (!item?.href) return;
        event.preventDefault();
        // Cmd/Ctrl+Enter opens in a new tab, matching every other list in the
        // product rather than inventing a shortcut.
        if (event.metaKey || event.ctrlKey) {
          window.open(item.href, "_blank", "noopener");
        } else {
          window.location.assign(item.href);
        }
        onOpenChange(false);
      }
    },
    [activeIndex, items, onOpenChange],
  );

  return (
    <ZeroBaseSheet open={open} onOpenChange={onOpenChange} title={copy.findAnything} side="bottom">
      <label htmlFor="zero-base-search-input" style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
        {SEARCH_SCOPE_LABEL}
      </label>
      <input
        id="zero-base-search-input"
        ref={inputRef}
        role="combobox"
        aria-expanded={items.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-label={SEARCH_SCOPE_LABEL}
        aria-activedescendant={items[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
        autoFocus
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
        style={{
          marginTop: 4,
          width: "100%",
          minHeight: 44,
          padding: "10px 12px",
          fontSize: 13,
          borderRadius: "var(--ledger-radius-input)",
          border: "1px solid var(--ledger-border-control)",
          background: "var(--ledger-bg-surface)",
          color: "var(--ledger-ink-primary)",
        }}
      />

      {permissionEmpty ? (
        <p data-search-state="permission-empty" style={{ fontSize: 13, marginTop: 12, color: "var(--ledger-ink-secondary)" }}>
          {SEARCH_PERMISSION_EMPTY}
        </p>
      ) : loading ? (
        <p role="status" aria-live="polite" style={{ fontSize: 13, marginTop: 12, color: "var(--ledger-ink-secondary)" }}>
          Searching…
        </p>
      ) : envelope && items.length === 0 ? (
        <p data-search-state="zero-result" style={{ fontSize: 13, marginTop: 12, color: "var(--ledger-ink-secondary)" }}>
          {SEARCH_ZERO_RESULT}
        </p>
      ) : (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={SEARCH_SCOPE_LABEL}
          data-el="search-results"
          data-collection="search"
          style={{ listStyle: "none", margin: "12px 0 0", padding: 0 }}
        >
          {items.map((item, index) => (
            <li
              key={`${item.entityType}:${item.entityId}`}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              style={{
                borderRadius: "var(--ledger-radius-input)",
                background: index === activeIndex ? "var(--ledger-accent-tint)" : "transparent",
              }}
            >
              {item.href ? (
                <Link
                  data-ctl="live:SCOPE-12 result"
                  href={item.href}
                  onClick={() => onOpenChange(false)}
                  style={{ display: "block", minHeight: 44, padding: "10px 12px", fontSize: 13, textDecoration: "none", color: "var(--ledger-ink-primary)" }}
                >
                  {item.name}
                  <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                    {item.group}
                    {item.businessName ? ` · ${item.businessName}` : ""}
                  </span>
                </Link>
              ) : (
                // No canonical destination resolves this row, so it is not
                // drawn as a link — a dead link is worse than a plain row.
                <span style={{ display: "block", padding: "10px 12px", fontSize: 13, color: "var(--ledger-ink-tertiary)" }}>
                  {item.name} — no canonical destination
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {envelope?.disclosure ? (
        <p data-search-disclosure="" style={{ fontSize: 12, marginTop: 8, color: "var(--ledger-ink-tertiary)" }}>
          {envelope.disclosure}
        </p>
      ) : null}
    </ZeroBaseSheet>
  );
}
