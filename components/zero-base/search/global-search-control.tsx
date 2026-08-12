"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  SearchOverlay,
  useSearchHotkey,
} from "@/components/zero-base/search/search-overlay";
import { SEARCH_SCOPE_LABEL, type ZeroBaseSearchResult } from "@/lib/zero-base/search-adapter";
import type { CollectionEnvelope } from "@/lib/zero-base/state-types";

type SearchResponse = CollectionEnvelope<ZeroBaseSearchResult> & {
  reason?: string;
};

/**
 * The shipping owner of global search.
 *
 * The accepted TopBar drew a search field, but the previous implementation only
 * mounted SearchOverlay inside the static frame harness. This control owns the
 * real trigger, `/` hotkey, bounded request and permission-empty state.
 */
export function GlobalSearchControl({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [envelope, setEnvelope] = useState<CollectionEnvelope<ZeroBaseSearchResult> | null>(null);
  const [loading, setLoading] = useState(false);
  const [permissionEmpty, setPermissionEmpty] = useState(false);
  const request = useRef<AbortController | null>(null);

  const openSearch = useCallback(() => setOpen(true), []);
  useSearchHotkey(openSearch);

  useEffect(() => {
    request.current?.abort();
    setPermissionEmpty(false);

    const normalized = query.trim();
    if (normalized.length < 2) {
      setEnvelope(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/search?contract=zero-base.v1&q=${encodeURIComponent(normalized)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) throw new Error(`Search failed (${response.status})`);
        const payload = (await response.json()) as SearchResponse;
        setPermissionEmpty(payload.reason === "permission_empty");
        setEnvelope({
          items: Array.isArray(payload.items) ? payload.items : [],
          servedCount: payload.servedCount ?? 0,
          totalCount: payload.totalCount ?? 0,
          cap: payload.cap ?? 50,
          nextCursor: payload.nextCursor ?? null,
          truncated: Boolean(payload.truncated),
          disclosure: payload.disclosure ?? null,
        });
      } catch (error) {
        if ((error as Error).name !== "AbortError") setEnvelope(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <>
      <button
        type="button"
        data-global-search-trigger=""
        data-ctl="live:SCOPE-11 search"
        onClick={openSearch}
        aria-label={SEARCH_SCOPE_LABEL}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: compact ? 44 : "min(420px, 38vw)",
          minWidth: compact ? 44 : 260,
          minHeight: 34,
          padding: compact ? "0 12px" : "0 10px",
          border: "1px solid var(--ledger-border-control)",
          borderRadius: "var(--ledger-radius-button)",
          background: "var(--ledger-bg-inset)",
          color: "var(--ledger-ink-secondary)",
          cursor: "pointer",
          fontSize: 13,
          textAlign: "left",
        }}
      >
        <span aria-hidden="true" style={{ fontFamily: "var(--font-adc-mono), monospace" }}>⌕</span>
        {compact ? null : <span style={{ flex: 1 }}>{SEARCH_SCOPE_LABEL}</span>}
        {compact ? null : (
          <kbd
            style={{
              minWidth: 22,
              padding: "1px 5px",
              border: "1px solid var(--ledger-border-subtle)",
              borderRadius: 4,
              background: "var(--ledger-bg-surface)",
              fontSize: 12,
              textAlign: "center",
            }}
          >
            /
          </kbd>
        )}
      </button>
      <SearchOverlay
        open={open}
        onOpenChange={setOpen}
        query={query}
        onQueryChange={setQuery}
        envelope={envelope}
        loading={loading}
        permissionEmpty={permissionEmpty}
      />
    </>
  );
}
