"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Building2, ChevronsUpDown, Menu, Search } from "lucide-react";
import {
  DateRangePicker,
  getTodayIsoForTimeZone,
} from "@/components/date-range/DateRangePicker";
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
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { getTranslations } from "@/lib/i18n";
import { useAppStore } from "@/store/app-store";
import { usePreferencesStore } from "@/store/preferences-store";
import { cn } from "@/lib/utils";
import { CommandPalette } from "./command-palette";
import { useWorkspaceSyncState } from "./use-shell-signals";

const SYNC_TONE: Record<string, "pos" | "info" | "warn" | "neutral"> = {
  fresh: "pos",
  syncing: "info",
  attention: "warn",
  unknown: "neutral",
};

function BusinessControl() {
  const router = useRouter();
  const language = usePreferencesStore((state) => state.language);
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const selectBusiness = useAppStore((state) => state.selectBusiness);
  const hasHydrated = useAppStore((state) => state.hasHydrated);
  const authBootstrapStatus = useAppStore((state) => state.authBootstrapStatus);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const t = getTranslations(language).layout;

  const selected = businesses.find((item) => item.id === selectedBusinessId) ?? null;
  const selectedIsDemo = isDemoBusinessSelected(selectedBusinessId, businesses);

  async function handleSelect(businessId: string) {
    if (businessId === selectedBusinessId || pendingId) return;
    setPendingId(businessId);
    const previous = selectedBusinessId;
    selectBusiness(businessId);
    const response = await fetch("/api/auth/switch-business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId }),
    }).catch(() => null);
    if (!response?.ok) {
      selectBusiness(previous ?? null);
      logClientAuthEvent("business_switch_failed", {
        attemptedBusinessId: businessId,
        previousBusinessId: previous,
      });
      setPendingId(null);
      return;
    }
    logClientAuthEvent("business_switch_succeeded", { activeBusinessId: businessId });
    setPendingId(null);
    router.refresh();
  }

  if (!hasHydrated || authBootstrapStatus !== "ready") {
    return <span className="h-9 w-[190px] shrink-0 rounded-[9px] bg-[var(--adv-fill)]" />;
  }

  if (businesses.length === 0) {
    return (
      <button
        type="button"
        className="adv-btn"
        onClick={() => router.push("/businesses/new")}
      >
        <Building2 className="h-[15px] w-[15px] text-[var(--adv-accent)]" aria-hidden="true" />
        {t.createBusiness}
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The design's business switcher runs a half-point larger than the
            other topbar controls. */}
        <button type="button" className="adv-btn max-w-[240px] text-[13.5px]">
          <Building2 className="h-[15px] w-[15px] shrink-0 text-[var(--adv-accent)]" aria-hidden="true" />
          <span className="min-w-0 truncate text-[13.5px]">
            {selected?.name ?? t.selectBusiness}
          </span>
          {selectedIsDemo ? <span className="adv-tag" data-tone="pos">Demo</span> : null}
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
            {business.id === selectedBusinessId ? (
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
  const router = useRouter();
  const [dateRange, setDateRange] = usePersistentDateRange();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sync = useWorkspaceSyncState();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  // Rolling presets must resolve against the workspace's own clock, not the
  // viewer's browser timezone, so "today" means the same day the data does.
  const workspaceTimeZone =
    businesses.find((business) => business.id === selectedBusinessId)?.timezone ?? "UTC";
  const workspaceReferenceDate = getTodayIsoForTimeZone(workspaceTimeZone);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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

        {/* The shell contract asks every frame to expose brand, business and
            platform regions by name; the v2 chrome has all three, so it carries
            the same hooks rather than renaming the contract. */}
        <span className="ad-console-business contents">
          <BusinessControl />
        </span>

        <span className="adv-topbar-divider hidden sm:block" />

        {/* The picker is main's, which drops the four comparison presets the
            server never computed. Its v2 trigger variant is not ported yet, so
            the chips render in the default layout. */}
        <DateRangePicker
          value={dateRange}
          onChange={setDateRange}
          testId="shell-date-range-picker"
          label="Date range"
          referenceDate={workspaceReferenceDate}
          timeZoneLabel={workspaceTimeZone}
        />

        <span className="flex-1" />

        {search ? (
          <div className="adv-search-slot">{search}</div>
        ) : (
          <button
            type="button"
            className="adv-search"
            onClick={() => setPaletteOpen(true)}
          >
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left">Jump or act…</span>
            <span className="adv-kbd">⌘K</span>
          </button>
        )}

        <span className="adv-pill" data-tone={SYNC_TONE[sync.tone]} title={sync.label}>
          <span className="adv-pill-dot" />
          <span data-topbar-secondary>{sync.label}</span>
        </span>

        {notifications}

        <button
          type="button"
          className="adv-icon-btn"
          aria-label="Sync health"
          onClick={() => router.push("/integrations")}
        >
          <Bell className="h-[15px] w-[15px]" aria-hidden="true" />
          {sync.tone === "attention" ? (
            <span
              className="absolute right-[7px] top-[6px] h-[7px] w-[7px] rounded-full border-[1.5px] border-white bg-[var(--adv-alert)]"
              aria-hidden="true"
            />
          ) : null}
        </button>

        <button
          type="button"
          onClick={() => router.push("/settings")}
          aria-label="Account"
          className={cn(
            "grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full",
            "bg-[var(--adv-accent)] text-[12px] font-semibold text-white",
          )}
        >
          {userName.trim().slice(0, 1).toUpperCase() || "?"}
        </button>
      </header>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </>
  );
}
