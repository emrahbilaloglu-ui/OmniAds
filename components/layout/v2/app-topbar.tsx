"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronsUpDown, Menu } from "lucide-react";
import {
  DateRangePicker,
  getTodayIsoForTimeZone,
  type DateRangeValue,
} from "@/components/date-range/DateRangePicker";
import {
  applyDateWindowToParams,
  DATE_WINDOW_PARAMS,
  hrefWithParams,
} from "@/lib/dashboard/date-window-url";
import { useOptionalWorkspaceContext } from "@/components/workspace/workspace-context-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useCanonicalDateWindowUrl,
  usePersistentDateRange,
} from "@/hooks/use-persistent-date-range";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { getTranslations } from "@/lib/i18n";
import { useAppStore } from "@/store/app-store";
import { usePreferencesStore } from "@/store/preferences-store";
import {
  useConfirmedShellBusinessId,
  useWorkspaceSyncState,
} from "./use-shell-signals";

const SYNC_TONE: Record<string, "pos" | "info" | "warn" | "neutral"> = {
  fresh: "pos",
  syncing: "info",
  attention: "warn",
  unknown: "neutral",
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
}

function BuildingIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[15px] w-[15px] shrink-0 text-[var(--adv-accent)]"
      aria-hidden="true"
    >
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18 M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2 M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2 M10 6h4 M10 10h4 M10 14h4" />
    </svg>
  );
}

export function scopedBusinessSwitchDestination(
  pathname: string,
  businessId: string,
): string | null {
  const scopedMatch = pathname.match(/^\/c\/[^/]+(\/.*)?$/);
  if (!scopedMatch) return null;
  return `/c/${encodeURIComponent(businessId)}${scopedMatch[1] ?? "/home"}`;
}

/**
 * ITEM 9 — the query that survives a workspace switch, and nothing else.
 *
 * Switching A -> B must not carry A's account scope. `providerAccountId`,
 * campaign / ad set / creative / entity ids, an account-scoped cursor, a
 * Launchpad handoff reference and account-specific filter state are all facts
 * about A's ad account; in B they name nothing. Carrying one is not a cosmetic
 * leak — every downstream reader takes the URL as the surface's scope, so B's
 * rail mints `?providerAccountId=<A's account>` links and B's requests go out
 * asking for A's account, which either fails closed as
 * `provider_account_not_assigned` or, worse, resolves for an operator who
 * happens to have both.
 *
 * This is therefore an ALLOWLIST, not a blocklist. A blocklist has to
 * enumerate every account-scoped parameter in the tree and stays correct only
 * until someone adds the next one; an allowlist is wrong only about parameters
 * we deliberately chose to keep. Exactly two kinds are kept:
 *
 * - The date window (`window`/`startDate`/`endDate`). It names days, not
 *   accounts, and ITEM 9 explicitly permits preserving it. The days are
 *   absolute, so B measures the same days A did; B's own clock reappears the
 *   moment the operator touches the picker.
 * - `businessId`, and only when the URL already stated one — a legacy link's
 *   body reads that parameter, so leaving A's id there after a confirmed
 *   switch would reproduce the shell/body split. It is rewritten to B rather
 *   than carried, and it is never introduced onto a URL that did not have it,
 *   because on those routes the session cookie is the scope of record.
 */
export function businessSwitchQuery(
  currentQuery: string,
  businessId: string,
): URLSearchParams {
  const current = new URLSearchParams(currentQuery);
  const next = new URLSearchParams();
  for (const key of DATE_WINDOW_PARAMS) {
    const value = current.get(key)?.trim() ?? "";
    if (value) next.set(key, value);
  }
  if ((current.get("businessId") ?? "").trim()) {
    next.set("businessId", businessId);
  }
  return next;
}

/** Order-insensitive, so a reordered but identical query is not a change. */
function sameQuery(a: URLSearchParams, b: URLSearchParams): boolean {
  const normalize = (params: URLSearchParams) => {
    const copy = new URLSearchParams(params);
    copy.sort();
    return copy.toString();
  };
  return normalize(a) === normalize(b);
}

/**
 * The query as the address bar currently holds it.
 *
 * `history.replaceState` is how the window is stated on the URL, and the App
 * Router's own snapshot can trail it by a render. Reading the live location
 * keeps every parameter this control rewrites — business, provider account,
 * cursors — from being written back from a stale copy.
 */
function currentQueryString(searchParams: ReturnType<typeof useSearchParams>) {
  if (typeof window !== "undefined") return window.location.search;
  return searchParams?.toString() ?? "";
}

/**
 * The business the server authorized for this render, when there is one.
 *
 * It was gated on `/c/**` only, which left `/app/**` with two rules for one
 * question: the page rendered `session.activeBusinessId` while this switcher,
 * the rail and the freshness pill rendered the client store. Both are seeded
 * from `/api/auth/me`, so they usually agreed — "usually" is not a scope
 * guarantee. Wherever the server states a business, that is the business;
 * where it states none (the legacy `/platforms/**` shell has no envelope at
 * all) the store answers, and it only ever holds what the server already
 * authorized.
 */
export function useScopedEnvelopeBusiness(_pathname?: string) {
  const workspace = useOptionalWorkspaceContext();
  return workspace?.business ?? null;
}

function BusinessControl() {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const scopedBusiness = useScopedEnvelopeBusiness(pathname);
  const language = usePreferencesStore((state) => state.language);
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const selectBusiness = useAppStore((state) => state.selectBusiness);
  const hasHydrated = useAppStore((state) => state.hasHydrated);
  const authBootstrapStatus = useAppStore((state) => state.authBootstrapStatus);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const t = getTranslations(language).layout;

  const effectiveSelectedBusinessId =
    scopedBusiness?.id ?? selectedBusinessId;
  const selected =
    scopedBusiness ??
    businesses.find((item) => item.id === effectiveSelectedBusinessId) ??
    null;

  async function handleSelect(businessId: string) {
    if (businessId === effectiveSelectedBusinessId || pendingId) return;
    setPendingId(businessId);
    const previous = selectedBusinessId;
    const scopedDestination = scopedBusinessSwitchDestination(
      pathname,
      businessId,
    );
    // Read A's query before the round trip, so what gets stripped is what the
    // operator was actually looking at when they switched.
    const previousQuery = new URLSearchParams(currentQueryString(searchParams));
    const nextQuery = businessSwitchQuery(previousQuery.toString(), businessId);
    const response = await fetch("/api/auth/switch-business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId }),
    }).catch(() => null);
    if (!response?.ok) {
      logClientAuthEvent("business_switch_failed", {
        attemptedBusinessId: businessId,
        previousBusinessId: previous,
      });
      setPendingId(null);
      return;
    }
    logClientAuthEvent("business_switch_succeeded", { activeBusinessId: businessId });
    setPendingId(null);
    if (scopedDestination) {
      // The path states B; the query keeps only what ITEM 9 permits. A scoped
      // route used to be left with a bare path, which happened to be safe —
      // this states the same guarantee on purpose instead of by omission, and
      // lets the operator keep the days they were looking at.
      router.replace(hrefWithParams(scopedDestination, nextQuery));
      return;
    }
    // The server moved the session first. Writing the store before that answer
    // arrived is what produced a transient render with this switcher on B and
    // the body still bound to A — an optimistic scope, which is the one thing
    // a scope must never be.
    selectBusiness(businessId);
    if (!sameQuery(nextQuery, previousQuery)) {
      // Something on this URL belonged to A: its business id, its provider
      // account, a cursor, a row selection. `router.replace` re-renders the
      // server surfaces against the stripped URL, which is what makes the
      // guarantee "no request for B carries A's account" true of the next
      // request rather than only of this component's state.
      router.replace(hrefWithParams(pathname, nextQuery));
    }
    // ALWAYS, including after the replace above.
    //
    // On `/app/**` the path does not change across a workspace switch — only
    // the query does — so the App Router treats the layout segment as already
    // satisfied and reuses it. Observed on :3000: after switching TheSwaf -> B
    // the page below re-rendered as B ("META · GRANDMIX · USD") while the
    // switcher above it, which reads `app/app/layout.tsx`'s envelope, still
    // said "TheSwaf". That is the shell and the body naming two businesses —
    // the split this control exists to end — reintroduced by a navigation that
    // only looked complete. `refresh` is what invalidates the layout the
    // envelope comes from.
    router.refresh();
  }

  if (
    !scopedBusiness &&
    (!hasHydrated || authBootstrapStatus !== "ready")
  ) {
    return <span className="h-9 w-[190px] shrink-0 rounded-[9px] bg-[var(--adv-fill)]" />;
  }

  if (businesses.length === 0 && !scopedBusiness) {
    return (
      <button
        type="button"
        className="adv-btn"
        onClick={() => router.push("/businesses/new")}
      >
        <BuildingIcon />
        {t.createBusiness}
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The design's business switcher runs a half-point larger than the
            other topbar controls. */}
        <button type="button" className="adv-btn text-[13.5px]">
          <BuildingIcon />
          <span className="text-[13.5px]">{selected?.name ?? t.selectBusiness}</span>
          <ChevronsUpDown className="h-[13px] w-[13px] shrink-0 text-[var(--adv-ink-3)]" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t.switchBusiness}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {businesses.map((business) => (
          <DropdownMenuItem
            key={business.id}
            onClick={() => void handleSelect(business.id)}
            disabled={pendingId === business.id}
            className="cursor-pointer gap-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{business.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {business.timezone ?? "Timezone pending"} · {business.currency}
              </span>
            </span>
            {business.id === effectiveSelectedBusinessId ? (
              <span className="adv-pill-dot bg-[var(--adv-accent)]" />
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => router.push("/select-business")}
          className="cursor-pointer text-muted-foreground"
        >
          {t.manageBusinesses}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => router.push("/businesses/new")}
          className="cursor-pointer"
        >
          {t.createNewBusiness}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppTopbar({
  userName,
  onOpenNav,
  search,
  notifications,
}: {
  userName: string;
  onOpenNav: () => void;
  /** The working search and notification controls, mounted by the frame. */
  search?: React.ReactNode;
  notifications?: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  const scopedBusiness = useScopedEnvelopeBusiness(pathname);
  const sync = useWorkspaceSyncState();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  // Rolling presets must resolve against the workspace's own clock, not the
  // viewer's browser timezone, so "today" means the same day the data does.
  const workspaceTimeZone =
    scopedBusiness?.businessTimezone ??
    businesses.find((business) => business.id === selectedBusinessId)
      ?.timezone ??
    "UTC";
  const workspaceReferenceDate = getTodayIsoForTimeZone(workspaceTimeZone);
  const [dateRange, setDateRange] = usePersistentDateRange(
    workspaceReferenceDate,
  );

  /**
   * ITEM 10 — the shell states the window before anything reads it.
   *
   * `useConfirmedShellBusinessId` is the gate, not a convenience: it is the one
   * value the shell is allowed to name a workspace by, and the workspace is
   * where the clock comes from. Before it resolves, `workspaceTimeZone` is the
   * "UTC" placeholder above, and canonicalizing against a placeholder would
   * state one window and then immediately state another.
   */
  const confirmedBusinessId = useConfirmedShellBusinessId();
  useCanonicalDateWindowUrl({
    referenceDate: workspaceReferenceDate,
    enabled: Boolean(confirmedBusinessId),
    navigate: (href) => router.replace(href),
  });

  /**
   * One authority for the window, and it is the URL.
   *
   * This control used to write a preferences store and nothing else: no
   * router, no history, no request. Six of the nine Meta surfaces never read
   * that store, and a server-rendered surface could not read it at all, so
   * moving the picker changed the label above the page and nothing underneath.
   * Stating the window on the URL is what makes the change reach a request —
   * `router.replace` so server-rendered surfaces re-render, and every other
   * parameter carried through untouched.
   */
  function applyDateRange(next: DateRangeValue) {
    const params = applyDateWindowToParams(
      new URLSearchParams(currentQueryString(searchParams)),
      next,
      workspaceReferenceDate,
    );
    setDateRange(next);
    router.replace(hrefWithParams(pathname, params));
  }

  return (
    <>
      <header className="adv-topbar">
        <button
          type="button"
          className="adv-icon-btn lg:hidden"
          onClick={onOpenNav}
          aria-label="Open navigation"
        >
          <Menu className="h-[15px] w-[15px]" aria-hidden="true" />
        </button>

        <BusinessControl />

        <span className="adv-topbar-divider hidden sm:block" />

        <DateRangePicker
          variant="v2"
          value={dateRange}
          onChange={applyDateRange}
          testId="shell-date-range-picker"
          label="Date range"
          referenceDate={workspaceReferenceDate}
          timeZoneLabel={workspaceTimeZone}
        />

        <span className="flex-1" />

        {search}

        <span
          className="adv-pill"
          data-tone={SYNC_TONE[sync.tone]}
          data-freshness-state={sync.freshnessState}
        >
          <span className="adv-pill-dot" />
          <span data-topbar-secondary>{sync.label}</span>
        </span>

        {notifications}

        <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9999px] bg-[var(--adv-accent)] text-[12px] font-semibold text-white">
          {initials(userName)}
        </span>
      </header>
    </>
  );
}
