"use client";

import { NotificationBell } from "@/components/notifications/NotificationBell";
import { shouldClaimMobileReadOnly } from "@/lib/mobile-write-capability";
import { TierZeroFreshnessBar } from "@/components/states/TierZeroFreshnessBar";
import { Bell, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { BusinessSelector } from "@/components/business/BusinessSelector";
import { PersonalAccountMenu } from "@/components/layout/PersonalAccountMenu";
import { GlobalSearch } from "@/components/layout/GlobalSearch";
import { PlatformSwitcher } from "@/components/layout/PlatformSwitcher";
import { BusinessGuard } from "@/components/layout/business-guard";
import { MobileNav } from "@/components/layout/mobile-nav";
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
        {/*
          Overview renders through this frame rather than the console one, so
          the freshness bar has to be here too. It was mounted only in
          ConsoleTopbar, which meant Overview reported its data age to a bar
          that was never on screen -- the surface looked wired and said nothing.
        */}
        <div className="ad-legacy-freshness border-b border-neutral-200 bg-white px-3 py-1 sm:px-4 md:px-6">
          <TierZeroFreshnessBar />
        </div>
        <main id="main-content" className="flex-1 overflow-y-auto bg-neutral-50 p-3 sm:p-4 md:p-6">
          <BusinessGuard>{children}</BusinessGuard>
        </main>
      </div>
    </div>
  );
}

function ConsoleTopbar({ userName }: { userName: string }) {
  return (
    <header className="ad-console-topbar">
      <MobileNav variant="console" />
      {/*
        The active surface's data age, in one place with one wording. A surface
        that has reported nothing renders as unknown rather than silently, since
        silence reads as "current".

        Wrapped so the stylesheet can move it to its own row below 720px. It
        used to share the single 50px bar with brand, platform, notifications
        and the account menu, and at 320px they physically overlapped -- two
        separate hit targets sharing pixels, so a tap near the seam landed on
        whichever was painted last. Hiding the freshness would have solved the
        geometry by removing the honesty, so it gets a row instead.
      */}
      <div className="ad-console-freshness">
        <TierZeroFreshnessBar />
      </div>
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
      {/* Replaces the removed "Jump or act… ⌘K" control. That one advertised a
          way to navigate that did not exist; this one queries a real server
          search and goes where it says it will. */}
      <GlobalSearch />
      <NotificationBell />
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
  const claimsMobileReadOnly = shouldClaimMobileReadOnly(pathname);
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
          id="main-content"
          className="min-w-0 flex-1 overflow-y-auto bg-[var(--adc-s1)]"
          data-mobile-surface={mobileSurface ?? "none"}
        >
          {/*
            The claim is made only where it is true.
            
            This used to render whenever a route did not own its own mobile
            surface, which included Settings and Integrations -- both of which
            render working write controls at the same width. The banner told an
            operator their changes would not be saved, directly above the
            controls that save them, and the safe reading of that is to stop
            trying. D5 gates provider mutation to desktop; it never covered
            account or workspace settings, and that is the distinction the old
            condition flattened.
          */}
          {claimsMobileReadOnly && !routeOwnsMobileSurface ? (
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
