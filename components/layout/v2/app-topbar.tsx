"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronsUpDown, Menu } from "lucide-react";
import {
  DateRangePicker,
  getTodayIsoForTimeZone,
} from "@/components/date-range/DateRangePicker";
import { useOptionalWorkspaceContext } from "@/components/workspace/workspace-context-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { getTranslations } from "@/lib/i18n";
import { useAppStore } from "@/store/app-store";
import { usePreferencesStore } from "@/store/preferences-store";
import { useWorkspaceSyncState } from "./use-shell-signals";

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

function useScopedEnvelopeBusiness(pathname: string) {
  const workspace = useOptionalWorkspaceContext();
  return pathname.match(/^\/c\/[^/]+(?:\/|$)/)
    ? (workspace?.business ?? null)
    : null;
}

function BusinessControl() {
  const router = useRouter();
  const pathname = usePathname() ?? "";
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
    if (!scopedDestination) selectBusiness(businessId);
    const response = await fetch("/api/auth/switch-business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId }),
    }).catch(() => null);
    if (!response?.ok) {
      if (!scopedDestination) selectBusiness(previous ?? null);
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
      router.replace(scopedDestination);
    } else {
      router.refresh();
    }
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
  const scopedBusiness = useScopedEnvelopeBusiness(pathname);
  const [dateRange, setDateRange] = usePersistentDateRange();
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
          onChange={setDateRange}
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
