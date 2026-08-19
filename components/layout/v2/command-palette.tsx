"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Building2, CornerDownLeft, Search } from "lucide-react";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { dashboardHrefForRouteFamily } from "@/lib/dashboard-v2/screen-registry";
import {
  MIN_SEARCH_QUERY_LENGTH,
  isSearchableQuery,
  type EntitySearchResult,
} from "@/lib/entity-search";
import { getTranslations } from "@/lib/i18n";
import { usePlan } from "@/lib/pricing/usePlan";
import { planRank } from "@/lib/pricing/usePlanLimits";
import { emitProductInstrumentation } from "@/lib/product-instrumentation-client";
import { useAppStore } from "@/store/app-store";
import { usePreferencesStore } from "@/store/preferences-store";
import { getRailJumpTargets, getRailModel } from "./nav-model";

interface SearchResponse {
  results?: EntitySearchResult[];
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

interface PaletteEntry {
  id: string;
  label: string;
  group: string;
  kind: "navigation" | "business" | "entity";
  hint?: string;
  description?: string;
  run: () => void | Promise<void>;
}

export function commandEntityHrefForRouteFamily({
  href,
  currentPathname,
  destinationBusinessId,
}: {
  href: string;
  currentPathname: string;
  destinationBusinessId: string;
}) {
  const destinationFamilyPathname = currentPathname.replace(
    /^\/c\/[^/]+(?=\/|$)/,
    `/c/${encodeURIComponent(destinationBusinessId)}`,
  );
  return dashboardHrefForRouteFamily(href, destinationFamilyPathname);
}

/**
 * The one search surface behind the canonical "Jump or act…" launcher. It
 * combines route jumps, workspace switches and the existing server-backed
 * entity search without adding a second topbar combobox or dropdown.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const language = usePreferencesStore((state) => state.language);
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const selectBusiness = useAppStore((state) => state.selectBusiness);
  const currentPlan = usePlan();
  const selectedIsDemo = isDemoBusinessSelected(selectedBusinessId, businesses);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [entityResults, setEntityResults] = useState<
    EntitySearchResult[] | null
  >(null);
  const [entityState, setEntityState] = useState<
    "idle" | "searching" | "ready" | "error"
  >("idle");
  const [entityError, setEntityError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef(0);
  const t = getTranslations(language).layout;

  const switchBusinessForNavigation = useCallback(
    async (businessId: string) => {
      if (businessId === selectedBusinessId) return true;
      const scoped = pathname.startsWith("/c/");
      const previous = selectedBusinessId;
      if (!scoped) selectBusiness(businessId);
      const response = await fetch("/api/auth/switch-business", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId }),
      }).catch(() => null);
      if (!response?.ok) {
        if (!scoped) selectBusiness(previous ?? null);
        logClientAuthEvent("business_switch_failed", {
          attemptedBusinessId: businessId,
          previousBusinessId: previous,
        });
        return false;
      }
      logClientAuthEvent("business_switch_succeeded", {
        activeBusinessId: businessId,
      });
      return true;
    },
    [pathname, selectBusiness, selectedBusinessId],
  );

  const staticEntries = useMemo<PaletteEntry[]>(() => {
    const model = getRailModel(language);
    const requiredPlanByHref = new Map(
      [
        ...model.home,
        ...model.platforms.flatMap((platform) => platform.children),
        ...model.growth,
        ...model.workspace,
      ].map((link) => [link.href, link.requiredPlan] as const),
    );
    const navEntries: PaletteEntry[] = getRailJumpTargets(model).map(
      (target) => ({
        id: `nav:${target.id}`,
        label: target.label,
        group: target.group,
        kind: "navigation",
        run: () => {
          const requiredPlan = requiredPlanByHref.get(target.href);
          const locked =
            !selectedIsDemo &&
            requiredPlan !== undefined &&
            planRank(currentPlan) < planRank(requiredPlan);
          router.push(
            dashboardHrefForRouteFamily(
              locked ? "/settings" : target.href,
              pathname,
            ),
          );
        },
      }),
    );

    const businessEntries: PaletteEntry[] = businesses
      .filter((business) => business.id !== selectedBusinessId)
      .map((business) => ({
        id: `business:${business.id}`,
        label: business.name ?? "—",
        group: t.switchBusiness,
        kind: "business",
        // A workspace with no configured currency shows the unavailable mark
        // in the same slot. It must not borrow "USD" from a neighbour
        // (INVARIANTS.md: missing currency must not silently become USD).
        hint: business.currency ?? "—",
        run: async () => {
          if (!(await switchBusinessForNavigation(business.id))) return;
          const scopedMatch = pathname.match(/^\/c\/[^/]+(\/.*)?$/);
          if (scopedMatch) {
            router.replace(
              `/c/${encodeURIComponent(business.id)}${scopedMatch[1] ?? "/home"}`,
            );
          } else {
            router.refresh();
          }
        },
      }));

    return [...navEntries, ...businessEntries];
  }, [
    businesses,
    currentPlan,
    language,
    pathname,
    router,
    selectedBusinessId,
    selectedIsDemo,
    switchBusinessForNavigation,
    t.switchBusiness,
  ]);

  const filteredStaticEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return staticEntries;
    return staticEntries.filter((entry) =>
      `${entry.group} ${entry.label}`.toLowerCase().includes(needle),
    );
  }, [query, staticEntries]);

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;

    if (!open || !isSearchableQuery(query)) {
      setEntityResults(null);
      setEntityState("idle");
      setEntityError(null);
      return;
    }

    setEntityState("searching");
    setEntityError(null);

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(query)}`,
          {
            headers: { Accept: "application/json" },
            cache: "no-store",
          },
        );
        const payload = (await response
          .json()
          .catch(() => null)) as SearchResponse | null;
        if (requestRef.current !== requestId) return;
        if (!response.ok) {
          setEntityError(
            (payload as { message?: string } | null)?.message ??
              "Search is unavailable.",
          );
          setEntityState("error");
          return;
        }
        setEntityResults(payload?.results ?? []);
        setEntityState("ready");
      } catch {
        if (requestRef.current !== requestId) return;
        setEntityError("Search is unavailable.");
        setEntityState("error");
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [open, query]);

  const entityEntries = useMemo<PaletteEntry[]>(
    () =>
      (entityResults ?? []).map((result) => ({
        id: `entity:${result.entityType}:${result.entityId}`,
        label: result.name ?? result.entityId,
        group: "Search",
        kind: "entity",
        hint: TYPE_LABEL[result.entityType],
        description: [
          result.businessName,
          result.status,
          MATCH_LABEL[result.matchKind],
        ]
          .filter(Boolean)
          .join(" · "),
        run: async () => {
          if (
            result.businessId !== selectedBusinessId &&
            !(await switchBusinessForNavigation(result.businessId))
          )
            return;
          emitProductInstrumentation({
            eventName: "search_result_opened",
            surface: "global_search",
            outcome: "ok",
            scope: "business",
            businessId: result.businessId,
          });
          router.push(
            commandEntityHrefForRouteFamily({
              href: result.href,
              currentPathname: pathname,
              destinationBusinessId: result.businessId,
            }),
          );
        },
      })),
    [
      entityResults,
      pathname,
      router,
      selectedBusinessId,
      switchBusinessForNavigation,
    ],
  );

  const results = useMemo(
    () => [...filteredStaticEntries, ...entityEntries],
    [entityEntries, filteredStaticEntries],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    setCursor((value) => Math.min(value, Math.max(0, results.length - 1)));
  }, [results.length]);

  if (!open) return null;

  const run = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    onOpenChange(false);
    void entry.run();
  };

  const trimmedQuery = query.trim();
  const showMinimumHint = trimmedQuery.length > 0 && !isSearchableQuery(query);
  const showNoMatch =
    isSearchableQuery(query) && entityState === "ready" && results.length === 0;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-[rgba(11,16,32,0.45)] px-4 pt-[12vh]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        id="dashboard-command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Jump or act"
        className="w-full max-w-[560px] overflow-hidden rounded-[var(--adv-r-card)] border border-[var(--adv-border)] bg-white shadow-[0_26px_72px_rgba(11,16,32,0.28)]"
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--adv-hairline)] px-4 py-3">
          <Search
            className="h-4 w-4 shrink-0 text-[var(--adv-ink-3)]"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            value={query}
            role="combobox"
            aria-label="Search navigation, businesses and entities"
            aria-expanded="true"
            aria-controls="dashboard-command-results"
            aria-autocomplete="list"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onOpenChange(false);
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((value) =>
                  Math.min(Math.max(0, results.length - 1), value + 1),
                );
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((value) => Math.max(0, value - 1));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                run(results[cursor]);
              }
            }}
            placeholder="Jump or act…"
            className="h-6 w-full border-0 bg-transparent text-[14px] text-[var(--adv-ink)] outline-none placeholder:text-[var(--adv-ink-4)]"
          />
          <span className="adv-kbd shrink-0">Esc</span>
        </div>
        <div
          id="dashboard-command-results"
          role="listbox"
          aria-label="Jump or act results"
          className="max-h-[52vh] overflow-y-auto py-1.5"
        >
          {results.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              aria-selected={index === cursor}
              onMouseEnter={() => setCursor(index)}
              onClick={() => run(entry)}
              data-active={index === cursor}
              className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13.5px] text-[var(--adv-ink)] data-[active=true]:bg-[var(--adv-accent-bg)]"
            >
              {entry.kind === "business" ? (
                <Building2
                  className="h-3.5 w-3.5 shrink-0 text-[var(--adv-accent)]"
                  aria-hidden="true"
                />
              ) : null}
              <span className="adv-mono text-[9.5px] uppercase tracking-[0.08em] text-[var(--adv-ink-3)]">
                {entry.group}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{entry.label}</span>
                {entry.description ? (
                  <span className="block truncate text-[11px] text-[var(--adv-ink-3)]">
                    {entry.description}
                  </span>
                ) : null}
              </span>
              {entry.hint ? (
                <span className="adv-mono text-[10px] text-[var(--adv-ink-4)]">
                  {entry.hint}
                </span>
              ) : null}
              {index === cursor ? (
                <CornerDownLeft
                  className="h-3.5 w-3.5 shrink-0 text-[var(--adv-ink-3)]"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          ))}

          <div aria-live="polite">
            {showMinimumHint ? (
              <p className="px-4 py-3 text-center text-[12px] text-[var(--adv-ink-3)]">
                Type at least {MIN_SEARCH_QUERY_LENGTH} characters to search
                entities.
              </p>
            ) : entityState === "searching" ? (
              <p className="px-4 py-3 text-center text-[12px] text-[var(--adv-ink-3)]">
                Searching…
              </p>
            ) : entityState === "error" ? (
              <p className="px-4 py-3 text-center text-[12px] text-[#e11d48]">
                {entityError}
              </p>
            ) : showNoMatch ? (
              <p className="px-4 py-6 text-center text-[13px] text-[var(--adv-ink-3)]">
                Nothing matches “{query}”.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
