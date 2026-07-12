"use client";

import { Bell, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { BusinessSelector } from "@/components/business/BusinessSelector";
import { PersonalAccountMenu } from "@/components/layout/PersonalAccountMenu";
import { PlatformSwitcher } from "@/components/layout/PlatformSwitcher";
import { BusinessGuard } from "@/components/layout/business-guard";
import { DesktopSidebar } from "@/components/layout/sidebar";
import { SidebarContent } from "@/components/layout/sidebar-content";
import { Topbar } from "@/components/layout/topbar";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";

interface DashboardFrameProps {
  userName: string;
  children: React.ReactNode;
}

const SIDEBAR_COLLAPSED_KEY = "adsecute:sidebar-collapsed";

const ROUTE_OWNED_META_SURFACES = new Set([
  "/platforms/meta",
  "/platforms/meta/automation",
  "/platforms/meta/launchpad",
  "/platforms/meta/history",
  "/platforms/meta/creatives",
  "/platforms/meta/copies",
  "/platforms/meta/landing-pages",
  "/platforms/meta/creative-inbox",
  "/platforms/meta/audiences",
]);

function hasRouteOwnedMetaSurface(pathname: string | null) {
  return Boolean(pathname && ROUTE_OWNED_META_SURFACES.has(pathname));
}

function isOverviewPath(pathname: string | null) {
  return pathname === "/overview" || pathname?.startsWith("/overview/");
}

function mobileSurfaceForPath(pathname: string | null) {
  // Pages with route-owned mobile read-only surfaces need their real payloads.
  // The shell keeps only the generic note for those routes.
  if (hasRouteOwnedMetaSurface(pathname)) {
    return null;
  }
  if (pathname?.startsWith("/platforms/meta/")) return "meta-evidence";
  return null;
}

function mobileReadonlyMessageForPath(pathname: string | null) {
  if (pathname === "/platforms/meta") {
    return "Rows open evidence here. Writes stay on desktop.";
  }
  if (pathname === "/platforms/meta/automation") {
    return "Guardrails are view-only here. Writes stay on desktop.";
  }
  if (pathname === "/platforms/meta/launchpad") {
    return "Launch state is view-only here. Writes stay on desktop.";
  }
  if (pathname === "/platforms/meta/history") {
    return "History is read-only. Persisted evidence stays account-scoped.";
  }
  if (pathname?.startsWith("/platforms/meta/")) {
    return "Creative analysis is available here. Provider writes stay on desktop.";
  }
  return "Evidence opens here. Writes stay on desktop.";
}

function LegacyDashboardFrame({ userName, children }: DashboardFrameProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <DesktopSidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar userName={userName} />
        <main className="flex-1 overflow-y-auto bg-neutral-50 p-3 sm:p-4 md:p-6">
          <BusinessGuard>{children}</BusinessGuard>
        </main>
      </div>
    </div>
  );
}

function ConsoleTopbar({ userName }: { userName: string }) {
  return (
    <header className="ad-console-topbar">
      <div className="ad-console-brand flex min-w-0 items-center gap-2">
        <BrandLogo
          className="gap-2"
          markClassName="h-[18px] w-[18px] rounded-[4px]"
          textClassName="text-[13px] font-semibold leading-none text-[var(--adc-ink)]"
          size={18}
        />
      </div>
      <div className="ad-console-divider h-[18px] w-px bg-[var(--adc-b1)]" />
      <div className="ad-console-business">
        <BusinessSelector />
      </div>
      <div className="ad-console-platform">
        <PlatformSwitcher />
      </div>
      <div className="min-w-0 flex-1" />
      <button
        type="button"
        className="hidden h-7 items-center gap-2 rounded-[6px] border border-[var(--adc-b1)] bg-[var(--adc-s1)] px-2.5 text-[12px] text-[var(--adc-ink3)] md:inline-flex"
      >
        Jump or act...
        <span className="rounded border border-[var(--adc-b2)] px-1 font-mono text-[10px]">⌘K</span>
      </button>
      <button
        type="button"
        className="grid h-7 w-7 place-items-center rounded-[6px] border border-[var(--adc-b1)] text-[var(--adc-ink2)] hover:bg-[var(--adc-s3)]"
        aria-label="Notifications"
      >
        <Bell className="h-3.5 w-3.5" />
      </button>
      <PersonalAccountMenu userName={userName} />
    </header>
  );
}

function MobileStatusLine({
  context,
  snapshot = "snapshot —",
}: {
  context: string;
  snapshot?: string;
}) {
  return (
    <>
      <div className="ad-mobile-status">
        <span>--:--</span>
        <span>{context}</span>
      </div>
      <div className="ad-mobile-freshness">synced — · {snapshot}</div>
    </>
  );
}

function MobileMetaReadOnlySurface({
  kind,
  businessName,
  currency,
}: {
  kind: "meta-evidence";
  businessName: string;
  currency: string | null;
}) {
  return (
    <section className="ad-mobile-device" aria-label="Meta evidence mobile read-only" data-mobile-kind={kind}>
      <div className="ad-mobile-screen">
        <MobileStatusLine context="evidence · read-only" />
        <div className="ad-mobile-title">
          <h2>{businessName}</h2>
          <p>Meta surface · {currency ?? "currency —"}</p>
        </div>
        <article className="ad-mobile-heat">
          <strong>Evidence opens here; writes stay on desktop.</strong>
          <span>No pause, launch, bid, or automation write controls render on mobile.</span>
        </article>
        <p className="ad-mobile-copy">
          Mobile is intentionally read-only. Server-owned labels, confidence, and action authority stay on
          the desktop decision workflow <span className="ad-mobile-cite">[1]</span>. Missing metrics render
          as <b>—</b>, never as zero <span className="ad-mobile-cite">[2]</span>.
        </p>
        <div className="ad-mobile-desktop-note">Act on desktop — this device is read-only by design.</div>
      </div>
    </section>
  );
}

export function DashboardFrame({ userName, children }: DashboardFrameProps) {
  const pathname = usePathname();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarPreferenceReady, setSidebarPreferenceReady] = useState(false);
  const mobileSurface = mobileSurfaceForPath(pathname);
  const mobileReadonlyMessage = mobileReadonlyMessageForPath(pathname);
  const routeOwnsMobileSurface = hasRouteOwnedMetaSurface(pathname);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusiness =
    businesses.find((business) => business.id === selectedBusinessId) ?? businesses[0] ?? null;

  useEffect(() => {
    try {
      setSidebarCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
    } catch {
      setSidebarCollapsed(false);
    } finally {
      setSidebarPreferenceReady(true);
    }
  }, []);

  const toggleSidebar = () => {
    if (!sidebarPreferenceReady) return;
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // The visual state still works when storage is unavailable.
    }
  };

  if (isOverviewPath(pathname)) {
    return <LegacyDashboardFrame userName={userName}>{children}</LegacyDashboardFrame>;
  }

  return (
    <div className="ad-console-shell flex h-screen flex-col overflow-hidden">
      <ConsoleTopbar userName={userName} />
      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "relative hidden shrink-0 transition-[width] duration-150 md:block",
            sidebarCollapsed ? "w-[56px]" : "w-[196px]",
          )}
        >
          <SidebarContent variant="console" collapsed={sidebarCollapsed} />
          <button
            type="button"
            onClick={toggleSidebar}
            disabled={!sidebarPreferenceReady}
            className="absolute -right-3 top-3 z-30 grid h-6 w-6 place-items-center rounded-full border border-[var(--adc-b1)] bg-[var(--adc-s2)] text-[var(--adc-ink3)] shadow-sm hover:text-[var(--adc-ink)]"
            aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
            title={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </aside>
        <main
          className="min-w-0 flex-1 overflow-y-auto bg-[var(--adc-s1)]"
          data-mobile-surface={mobileSurface ?? "none"}
        >
          {!routeOwnsMobileSurface ? (
            <div className="ad-console-mobile-readonly" role="note">
              <span data-mono>Adsecute · mobile read-only</span>
              <span>{mobileReadonlyMessage}</span>
            </div>
          ) : null}
          {mobileSurface ? (
            <div className="ad-console-mobile-stage">
              <MobileMetaReadOnlySurface
                kind={mobileSurface}
                businessName={selectedBusiness?.name ?? "Selected business"}
                currency={selectedBusiness?.currency ?? null}
              />
            </div>
          ) : null}
          <div className="ad-console-desktop-content">
            <BusinessGuard>{children}</BusinessGuard>
          </div>
        </main>
      </div>
    </div>
  );
}
