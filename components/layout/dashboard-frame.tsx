"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BusinessGuard } from "@/components/layout/business-guard";
import { TierZeroFreshnessBar } from "@/components/states/TierZeroFreshnessBar";
import { AppRail } from "@/components/layout/v2/app-rail";
import { AppTopbar } from "@/components/layout/v2/app-topbar";
import { useAppStore } from "@/store/app-store";

interface DashboardFrameProps {
  userName: string;
  children: React.ReactNode;
}

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

function mobileSurfaceForPath(pathname: string | null) {
  // Pages with route-owned mobile read-only surfaces need their real payloads.
  // The shell keeps only the generic note for those routes.
  if (hasRouteOwnedMetaSurface(pathname)) {
    return null;
  }
  if (pathname?.startsWith("/platforms/meta/")) return "meta-evidence";
  return null;
}

/**
 * The read-only banner is a Meta-surface contract ("writes stay on desktop"),
 * not a shell-wide notice. Overview and the workspace screens are fully usable
 * on mobile, so they must not inherit it now that every route shares one frame.
 */
function showsMobileReadonlyNote(pathname: string | null) {
  return Boolean(pathname?.startsWith("/platforms/meta"));
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

/**
 * Dashboard v2 shell (design decision D1): one chrome for every route. The old
 * legacy/console split is gone — Overview no longer gets its own frame.
 */
export function DashboardFrame({ userName, children }: DashboardFrameProps) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const mobileSurface = mobileSurfaceForPath(pathname);
  const mobileReadonlyMessage = mobileReadonlyMessageForPath(pathname);
  const routeOwnsMobileSurface = hasRouteOwnedMetaSurface(pathname);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusiness =
    businesses.find((business) => business.id === selectedBusinessId) ?? businesses[0] ?? null;

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  return (
    <div className="ad-console-shell adv-shell">
      {navOpen ? (
        <div
          className="fixed inset-0 z-50 bg-[rgba(11,16,32,0.45)] lg:hidden"
          role="presentation"
          onClick={() => setNavOpen(false)}
        />
      ) : null}
      <AppRail userName={userName} open={navOpen} onNavigate={() => setNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AppTopbar userName={userName} onOpenNav={() => setNavOpen(true)} />
        {/* Every Tier-0 surface reports its data age through this one bar. A
            frame without it lets the reports go nowhere, and silence on screen
            reads as "current". */}
        <div className="ad-legacy-freshness border-b border-[var(--adv-hairline)] bg-[var(--adv-surface)] px-4 py-1">
          <TierZeroFreshnessBar />
        </div>
        <main
          className="adv-main"
          data-mobile-surface={mobileSurface ?? "none"}
        >
          {showsMobileReadonlyNote(pathname) && !routeOwnsMobileSurface ? (
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
          <div className="ad-console-desktop-content adv-page">
            <BusinessGuard>{children}</BusinessGuard>
          </div>
        </main>
      </div>
    </div>
  );
}
