"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppStore } from "@/store/app-store";
import { cn } from "@/lib/utils";
import { Building2, Check, ChevronsUpDown, Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { getTranslations } from "@/lib/i18n";
import { usePreferencesStore } from "@/store/preferences-store";
import { sanitizeNextPath } from "@/lib/auth-routing";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import {
  getBusinessPlatformOrDefault,
  getPlatformFromPathname,
} from "@/lib/navigation/platform-context";
import { getPlatformFirstHref } from "@/components/layout/nav-items";

function getInitials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function BusinessSelector() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const language = usePreferencesStore((state) => state.language);
  const hasHydrated = useAppStore((state) => state.hasHydrated);
  const authBootstrapStatus = useAppStore((state) => state.authBootstrapStatus);
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const selectBusiness = useAppStore((state) => state.selectBusiness);
  const [pendingBusinessId, setPendingBusinessId] = useState<string | null>(null);

  const selectedBusiness =
    businesses.find((item) => item.id === selectedBusinessId) ?? null;
  const isDemoOnlyWorkspace = businesses.length === 1 && Boolean(businesses[0]?.isDemoBusiness);
  const selectedIsDemo = isDemoBusinessSelected(selectedBusinessId, businesses);
  const t = getTranslations(language).layout;

  function getPostSwitchDestination(nextBusinessId?: string) {
    const query = searchParams.toString();
    const candidate = `${pathname}${query ? `?${query}` : ""}`;
    const sanitized = sanitizeNextPath(candidate);
    if (!sanitized) return "/overview";
    if (
      sanitized === "/" ||
      sanitized.startsWith("/login") ||
      sanitized.startsWith("/signup") ||
      sanitized.startsWith("/select-language") ||
      sanitized.startsWith("/businesses/new") ||
      sanitized.startsWith("/select-business")
    ) {
      return "/overview";
    }
    if (getPlatformFromPathname(sanitized.split("?")[0])) {
      return getPlatformFirstHref(getBusinessPlatformOrDefault(nextBusinessId), language);
    }
    return sanitized;
  }

  async function handleSelect(businessId: string) {
    if (businessId === selectedBusinessId || pendingBusinessId) return;
    setPendingBusinessId(businessId);
    const previousBusinessId = selectedBusinessId;
    const destination = getPostSwitchDestination(businessId);
    selectBusiness(businessId);
    const response = await fetch("/api/auth/switch-business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId }),
    }).catch(() => null);

    if (!response?.ok) {
      selectBusiness(previousBusinessId ?? null);
      logClientAuthEvent("business_switch_failed", {
        attemptedBusinessId: businessId,
        previousBusinessId,
      });
      setPendingBusinessId(null);
      return;
    }

    logClientAuthEvent("business_switch_succeeded", {
      activeBusinessId: businessId,
    });
    setPendingBusinessId(null);
    router.push(destination);
    router.refresh();
  }

  if (!hasHydrated || authBootstrapStatus !== "ready") {
    return null;
  }

  if (businesses.length === 0) {
    return (
      <Button
        variant="outline"
        className="h-9 gap-2 rounded-lg border-slate-200 bg-white px-3 text-sm shadow-sm transition-colors hover:bg-slate-50"
        onClick={() => router.push("/businesses/new")}
        >
        <Plus className="h-4 w-4" />
        <span className="hidden sm:inline">{t.createBusiness}</span>
      </Button>
    );
  }

  if (isDemoOnlyWorkspace && selectedBusiness) {
    return (
      <Button
        variant="outline"
        className="h-9 max-w-[220px] gap-2 rounded-lg border-slate-200 bg-white px-3 text-sm shadow-sm"
        disabled
      >
        <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary/10 text-[10px] font-bold text-primary">
          {getInitials(selectedBusiness.name)}
        </div>
        <span className="truncate hidden sm:block">{selectedBusiness.name}</span>
        {selectedIsDemo ? (
          <span className="inline-flex items-center px-1 py-px rounded border border-emerald-200 bg-emerald-50 text-emerald-700 text-[9px] font-semibold uppercase tracking-wider">
            Demo
          </span>
        ) : null}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-9 max-w-[220px] gap-2 rounded-lg border-slate-200 bg-white px-3 text-sm shadow-sm transition-colors hover:bg-slate-50"
        >
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary/10 text-[10px] font-bold text-primary">
            {selectedBusiness ? getInitials(selectedBusiness.name) : "SB"}
          </div>
          <span className="truncate hidden sm:block">
            {selectedBusiness?.name ?? t.selectBusiness}
          </span>
          {selectedIsDemo ? (
            <span className="inline-flex items-center px-1 py-px rounded border border-emerald-200 bg-emerald-50 text-emerald-700 text-[9px] font-semibold uppercase tracking-wider">
              Demo
            </span>
          ) : null}
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t.switchBusiness}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {businesses.map((business) => (
          <DropdownMenuItem
            key={business.id}
            onClick={() => void handleSelect(business.id)}
            className="cursor-pointer gap-2"
            disabled={pendingBusinessId === business.id}
          >
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary/10 text-[10px] font-bold text-primary">
              {getInitials(business.name)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {business.name}
                {business.isDemoBusiness ? (
                  <span className="ml-2 inline-flex items-center px-1 py-px rounded border border-emerald-200 bg-emerald-50 text-emerald-700 text-[9px] font-semibold uppercase tracking-wider">
                    Demo
                  </span>
                ) : null}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {business.timezone ?? "Timezone pending"} • {business.currency}
              </p>
            </div>
            <Check
              className={cn(
                "h-4 w-4 shrink-0",
                business.id === selectedBusinessId ? "opacity-100" : "opacity-0"
              )}
            />
          </DropdownMenuItem>
        ))}
        {!isDemoOnlyWorkspace ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => router.push("/select-business")}
              className="cursor-pointer gap-2 text-muted-foreground"
            >
              <Building2 className="h-4 w-4" />
              {t.manageBusinesses}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => router.push("/businesses/new")}
              className="cursor-pointer gap-2"
            >
              <Plus className="h-4 w-4" />
              {t.createNewBusiness}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
