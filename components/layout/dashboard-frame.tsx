"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BusinessGuard } from "@/components/layout/business-guard";
import {
  GlobalSearch,
  resolveGlobalSearchShortcut,
} from "@/components/layout/GlobalSearch";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { shouldClaimMobileReadOnly } from "@/lib/mobile-write-capability";
import { AppRail } from "@/components/layout/v2/app-rail";
import { useIsNarrow } from "@/components/layout/v2/use-narrow";
import { MetaScreenView } from "@/components/layout/v2/meta-screen-view";
import type { ProviderScopeCatalog } from "@/lib/zero-base/provider-scope-server";
import {
  AppTopbar,
  useScopedEnvelopeBusiness,
} from "@/components/layout/v2/app-topbar";
import { CommandPalette } from "@/components/layout/v2/command-palette";
import { useAppStore } from "@/store/app-store";

interface DashboardFrameProps {
  userName: string;
  /**
   * The provider accounts this business has assigned, resolved on the server.
   *
   * Forwarded to the topbar's account control. Presentation only: the catalog
   * lists what MAY be selected, and the server re-authorizes whatever is
   * selected on the next render.
   */
  providerCatalogs?: readonly ProviderScopeCatalog[];
  /** Server-read: why changing the ad account is refused, when it is. */
  accountChangeRefusalReason?: string | null;
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

const ROUTE_OWNED_GOOGLE_SURFACES = new Set([
  "/platforms/google",
  "/platforms/google/advisor",
  "/platforms/google/search",
  "/platforms/google/products",
  "/platforms/google/assets",
  "/platforms/google/plan",
  "/app/google/overview",
  "/app/google/advisor",
  "/app/google/search",
  "/app/google/products",
  "/app/google/assets-audiences",
  "/app/google/plan",
]);

function publicDashboardPath(pathname: string | null) {
  if (!pathname) return null;
  return pathname.replace(/^\/c\/[^/]+(?=\/|$)/, "/app");
}

function hasRouteOwnedMetaSurface(pathname: string | null) {
  const route = publicDashboardPath(pathname);
  return Boolean(
    route &&
    (ROUTE_OWNED_META_SURFACES.has(route) ||
      route.startsWith("/app/meta/") ||
      route.startsWith("/app/creative/")),
  );
}

function hasRouteOwnedGoogleSurface(pathname: string | null) {
  const route = publicDashboardPath(pathname);
  return Boolean(route && ROUTE_OWNED_GOOGLE_SURFACES.has(route));
}

function hasRouteOwnedMobileSurface(pathname: string | null) {
  return hasRouteOwnedMetaSurface(pathname) || hasRouteOwnedGoogleSurface(pathname);
}

/** The skip link's target. Exported so a test can name the same id the shell does. */
export const DASHBOARD_MAIN_ID = "adv-main-content";

function mobileSurfaceForPath(pathname: string | null) {
  // Pages with route-owned mobile read-only surfaces need their real payloads.
  // The shell keeps only the generic note for those routes.
  if (hasRouteOwnedMobileSurface(pathname)) {
    return null;
  }
  const route = publicDashboardPath(pathname);
  if (
    route?.startsWith("/platforms/meta/") ||
    route?.startsWith("/app/meta/") ||
    route?.startsWith("/app/creative/")
  ) {
    return "meta-evidence";
  }
  return null;
}

function mobileReadonlyMessageForPath(pathname: string | null) {
  const route = publicDashboardPath(pathname);
  if (route === "/platforms/meta" || route === "/app/meta/decisions") {
    return "Rows open evidence here. Writes stay on desktop.";
  }
  if (
    route === "/platforms/meta/automation" ||
    route === "/app/meta/automation"
  ) {
    return "Guardrails are view-only here. Writes stay on desktop.";
  }
  if (
    route === "/platforms/meta/launchpad" ||
    route === "/app/meta/launchpad"
  ) {
    return "Launch state is view-only here. Writes stay on desktop.";
  }
  if (route === "/platforms/meta/history" || route === "/app/meta/history") {
    return "History is read-only. Persisted evidence stays account-scoped.";
  }
  if (
    route?.startsWith("/platforms/meta/") ||
    route?.startsWith("/app/meta/") ||
    route?.startsWith("/app/creative/")
  ) {
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
    <section
      className="ad-mobile-device"
      aria-label="Meta evidence mobile read-only"
      data-mobile-kind={kind}
    >
      <div className="ad-mobile-screen">
        <MobileStatusLine context="evidence · read-only" />
        <div className="ad-mobile-title">
          <h2>{businessName}</h2>
          <p>Meta surface · {currency ?? "currency —"}</p>
        </div>
        <article className="ad-mobile-heat">
          <strong>Evidence opens here; writes stay on desktop.</strong>
          <span>
            No pause, launch, bid, or automation write controls render on
            mobile.
          </span>
        </article>
        <p className="ad-mobile-copy">
          Mobile is intentionally read-only. Server-owned labels, confidence,
          and action authority stay on the desktop decision workflow{" "}
          <span className="ad-mobile-cite">[1]</span>. Missing metrics render as{" "}
          <b>—</b>, never as zero <span className="ad-mobile-cite">[2]</span>.
        </p>
        <div className="ad-mobile-desktop-note">
          Act on desktop — this device is read-only by design.
        </div>
      </div>
    </section>
  );
}

/**
 * Dashboard v2 shell (design decision D1): one chrome for every route. The old
 * legacy/console split is gone — Overview no longer gets its own frame.
 */
export function DashboardFrame({
  userName,
  providerCatalogs = [],
  accountChangeRefusalReason = null,
  children,
}: DashboardFrameProps) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  /*
   * Where focus goes when the drawer closes, and whether the rail IS a drawer.
   *
   * Both belong to the frame rather than to the rail: the frame owns the
   * hamburger, and the breakpoint is a property of the shell rather than of the
   * navigation inside it.
   */
  const navTriggerRef = useRef<HTMLButtonElement | null>(null);
  const narrow = useIsNarrow();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const mobileSurface = mobileSurfaceForPath(pathname);
  const mobileReadonlyMessage = mobileReadonlyMessageForPath(pathname);
  const routeOwnsMobileSurface = hasRouteOwnedMobileSurface(pathname);
  // Which routes claim mobile read-only is a capability decision, not a shell
  // opinion — it comes from the same module the write paths consult. Settings
  // and Integrations render working write controls at phone width, so the
  // banner must not appear over them.
  const claimsMobileReadOnly = shouldClaimMobileReadOnly(pathname);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const scopedBusiness = useScopedEnvelopeBusiness(pathname ?? "");
  /**
   * The same business the switcher names, resolved the same way.
   *
   * This held a second, different rule — `businesses[0]` when the selection
   * did not match — so the mobile surface could name one workspace and print
   * another's currency while the topbar named a third. A shell must not have
   * two answers to "which business", and a currency must never be borrowed
   * from whichever workspace happens to sort first.
   */
  const selectedBusiness = scopedBusiness
    ? { name: scopedBusiness.name, currency: scopedBusiness.configuredCurrency }
    : (businesses.find((business) => business.id === selectedBusinessId) ??
      null);

  useEffect(() => {
    setNavOpen(false);
    setCommandPaletteOpen(false);
  }, [pathname]);

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
        isOpen: commandPaletteOpen,
        isComposing: event.isComposing,
      });

      if (action === "ignore") return;
      event.preventDefault();
      setCommandPaletteOpen(action === "open");
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [commandPaletteOpen]);

  return (
    <div className="ad-console-shell adv-shell">
      {/*
        WP17 — skip link.

        The zero-base shell has had one since it was written; nothing mounts
        that shell. Every canonical route (`/app/**` and the `/c/**` twins) and
        every legacy one renders THIS frame, so until now a keyboard user tabbed
        through the entire rail — every product, every module, every sub-item —
        before reaching the page on every navigation.

        Off-screen until focused, so it changes nothing visually; `<main>` takes
        `tabIndex={-1}` so activating it MOVES focus rather than only scrolling,
        which is the difference between a working skip link and an anchor that
        leaves the next Tab back at the top of the rail.
      */}
      <a
        href={`#${DASHBOARD_MAIN_ID}`}
        data-skip-link=""
        className="absolute left-2 top-[-100px] z-[60] rounded-[var(--adv-r-input,8px)] border border-[var(--adv-accent,#2a5fe2)] bg-white px-3.5 py-2.5 text-[13px] font-semibold text-[var(--adv-accent,#2a5fe2)] no-underline focus:top-2"
      >
        Skip to main content
      </a>
      {/* WP17: one screen_view per mounted Meta surface, resolved from the WP2
          registry so it cannot drift from the surfaces that exist. Renders
          nothing. */}
      <MetaScreenView />
      {navOpen ? (
        <div
          className="fixed inset-0 z-50 bg-[rgba(11,16,32,0.45)] lg:hidden"
          role="presentation"
          onClick={() => setNavOpen(false)}
        />
      ) : null}
      <AppRail
        userName={userName}
        open={navOpen}
        narrow={narrow}
        onNavigate={() => setNavOpen(false)}
        onClose={() => setNavOpen(false)}
        returnFocusTo={navTriggerRef}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AppTopbar
          userName={userName}
          providerCatalogs={providerCatalogs}
          accountChangeRefusalReason={accountChangeRefusalReason}
          navOpen={navOpen}
          navTriggerRef={navTriggerRef}
          onOpenNav={() => setNavOpen(true)}
          search={
            <GlobalSearch
              open={commandPaletteOpen}
              onOpen={() => setCommandPaletteOpen(true)}
            />
          }
          notifications={<NotificationBell />}
        />
        <main
          className="adv-main"
          id={DASHBOARD_MAIN_ID}
          tabIndex={-1}
          data-mobile-surface={mobileSurface ?? "none"}
        >
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
          <div className="ad-console-desktop-content adv-page">
            <BusinessGuard>{children}</BusinessGuard>
          </div>
        </main>
      </div>
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
      />
    </div>
  );
}
