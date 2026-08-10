"use client";

import { emitProductInstrumentation } from "@/lib/product-instrumentation-client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { MIN_SEARCH_QUERY_LENGTH, isSearchableQuery } from "@/lib/entity-search";
import type { EntitySearchResult } from "@/lib/entity-search";

interface SearchResponse {
  query: string;
  results?: EntitySearchResult[];
  reason?: string;
}

const MATCH_LABEL: Record<EntitySearchResult["matchKind"], string> = {
  exact_id: "exact ID",
  exact_name: "exact name",
  prefix: "name starts with",
  contains: "name contains",
};

const TYPE_LABEL: Record<EntitySearchResult["entityType"], string> = {
  business: "Client",
  campaign: "Campaign",
  adset: "Ad set",
  ad: "Ad",
  report: "Report",
};

/**
 * Find an entity by name from anywhere in the shell.
 *
 * The decision surfaces carry capped lists, so a campaign the buyer remembers
 * by name was unreachable unless it happened to be on the visible page. This
 * queries the server directly rather than filtering what is already loaded.
 */

/**
 * What a keystroke should do to global search.
 *
 * Pure so the rules can be asserted directly, because most of them are about
 * when *not* to act. The platform menu advertised this shortcut for a while
 * with nothing behind it; making it real means also making it safe:
 *
 * - Cmd+K and Ctrl+K both open, because the product runs on both platforms.
 * - A bare "k" does nothing, or typing the letter anywhere would open a panel.
 * - Inside an input, textarea or contenteditable the key belongs to the field:
 *   Ctrl+K is a real editing shortcut, and stealing it loses someone's work.
 * - During IME composition nothing is intercepted at all; interrupting a
 *   composition can drop characters the user has already typed.
 * - Escape closes only when the panel is open, and still closes from inside
 *   search's own field, which is the one case where it must win.
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
  // An editable target keeps its own key.
  if (input.target !== "body") return "ignore";
  return "open";
}

export function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<EntitySearchResult[] | null>(null);
  const [state, setState] = useState<"idle" | "searching" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!isSearchableQuery(query)) {
      setResults(null);
      setState("idle");
      return;
    }

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setState("searching");

    // Debounced so typing does not fan out a request per keystroke.
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as SearchResponse | null;
        if (requestRef.current !== requestId) return;
        if (!response.ok) {
          // A failed search is a failure, not "no matches" — otherwise the
          // buyer concludes the campaign does not exist.
          setError(
            (payload as { message?: string } | null)?.message ?? "Search is unavailable.",
          );
          setState("error");
          return;
        }
        setResults(payload?.results ?? []);
        setState("ready");
      } catch {
        if (requestRef.current !== requestId) return;
        setError("Search is unavailable.");
        setState("error");
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [query]);

  // The shortcut, actually wired. `preventDefault` runs only when this handler
  // genuinely took the key, so every other keystroke keeps its browser default.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const node = event.target as HTMLElement | null;
      const tag = node?.tagName?.toLowerCase();
      const target: "body" | "input" | "textarea" | "contenteditable" =
        node?.isContentEditable
          ? "contenteditable"
          : tag === "input"
            ? "input"
            : tag === "textarea"
              ? "textarea"
              : "body";

      const action = resolveGlobalSearchShortcut({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        target,
        isOpen: open,
        isComposing: event.isComposing,
        inOwnField: node === inputRef.current,
      });

      if (action === "open") {
        event.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (action === "close") {
        event.preventDefault();
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  const showPanel = open && query.trim().length > 0;

  return (
    <div ref={containerRef} className="relative hidden md:block">
      <label className="sr-only" htmlFor="global-search">
        Search campaigns, ad sets, ads and clients
      </label>
      <div className="flex h-7 items-center gap-1.5 rounded-[6px] border border-[var(--adc-b1)] bg-[var(--adc-s1)] px-2">
        <Search className="h-3.5 w-3.5 text-[var(--adc-ink3)]" aria-hidden="true" />
        <input
          ref={inputRef}
          id="global-search"
          type="search"
          // A search box that opens a result list is a combobox. Without these
          // a screen-reader user is told nothing opened, and has no way to know
          // results appeared or how many.
          role="combobox"
          aria-expanded={open}
          aria-controls="global-search-results"
          aria-autocomplete="list"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
          placeholder="Search campaigns, ads, clients"
          className="w-56 bg-transparent text-[12px] text-[var(--adc-ink)] outline-none placeholder:text-[var(--adc-ink3)]"
        />
        {/* The hint belongs where the shortcut works. */}
        <kbd
          data-search-shortcut-hint="true"
          aria-hidden="true"
          className="ml-auto shrink-0 rounded border border-[var(--adc-b1)] px-1 text-[12px] font-mono text-[var(--adc-ink3)]"
        >
          ⌘K
        </kbd>
      </div>

      {showPanel ? (
        <div
          id="global-search-results"
          role="listbox"
          aria-label="Search results"
          className="absolute right-0 top-9 z-50 max-h-[22rem] w-[24rem] overflow-y-auto rounded-lg border border-[var(--adc-b1)] bg-white py-1 shadow-lg"
        >
          {!isSearchableQuery(query) ? (
            <p className="px-3 py-2 text-[12px] text-[var(--adc-ink3)]">
              Type at least {MIN_SEARCH_QUERY_LENGTH} characters.
            </p>
          ) : state === "searching" ? (
            <p className="px-3 py-2 text-[12px] text-[var(--adc-ink3)]">Searching…</p>
          ) : state === "error" ? (
            <p className="px-3 py-2 text-[12px] text-rose-700">{error}</p>
          ) : results && results.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-[var(--adc-ink3)]">
              Nothing matched “{query}”.
            </p>
          ) : (
            (results ?? []).map((result) => (
              <button
                key={`${result.entityType}-${result.entityId}`}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  // Section 9: search success is "a result was opened", not
                  // "results were shown". The query text is never sent.
                  emitProductInstrumentation({
                    eventName: "search_result_opened",
                    surface: "global_search",
                    outcome: "ok",
                    scope: "business",
                    businessId: result.businessId,
                  });
                  setOpen(false);
                  router.push(result.href);
                }}
                className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-[var(--adc-s1)]"
              >
                <span className="flex w-full items-center gap-2">
                  <span className="truncate text-[12.5px] font-medium text-[var(--adc-ink)]">
                    {result.name ?? result.entityId}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-[var(--adc-ink3)]">
                    {TYPE_LABEL[result.entityType]}
                  </span>
                </span>
                <span className="flex w-full items-center gap-2 text-[11px] text-[var(--adc-ink3)]">
                  {result.businessName ? <span>{result.businessName}</span> : null}
                  {result.status ? <span>· {result.status}</span> : null}
                  {/* Say why this matched, so a surprising hit is explainable. */}
                  <span className="ml-auto shrink-0">{MATCH_LABEL[result.matchKind]}</span>
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
