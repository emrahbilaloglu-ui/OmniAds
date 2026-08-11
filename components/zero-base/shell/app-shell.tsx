"use client";

/**
 * The canonical shell: skip link, rail or drawer, top bar, context bar, main.
 *
 * The top bar carries breadcrumb, search and the user menu — and nothing else.
 * No bell, no Help, no What's New, no "Jump or act". Those were controls that
 * looked live and did nothing, and the design removes them rather than
 * disabling them, because a disabled control still claims the capability
 * exists.
 *
 * Below 768 px the rail becomes a complete drawer — the same items, not a
 * reduced set — and the context bar compresses to a two-line sticky header
 * that opens the scope sheet. Mobile is never a read-only placeholder.
 */
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { Rail } from "@/components/zero-base/shell/rail";
import { NavDrawer } from "@/components/zero-base/shell/nav-drawer";
import { ContextBar } from "@/components/zero-base/shell/context-bar";
import { SkipLink, MAIN_CONTENT_ID, MAIN_CONTENT_TABINDEX } from "@/components/zero-base/shell/skip-link";
import {
  ScopeSheet,
  type ScopeFacts,
  type ScopePickers,
} from "@/components/zero-base/primitives/scope-sheet";
import { ZERO_BASE_ROOT_ATTRIBUTE, ZERO_BASE_ROOT_VALUE } from "@/lib/design/ledger-tokens";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";
import type { NavGroup } from "@/lib/zero-base/navigation";

/**
 * At and below this width the rail is replaced by a drawer.
 *
 * Inclusive: the accepted design's B05 is "Rail-to-drawer at 768 — open", so
 * 768 itself is a drawer width, not the last rail width.
 */
export const DRAWER_BREAKPOINT = 768;

/** The one place the breakpoint is turned into a decision. */
export function isNarrowWidth(width: number): boolean {
  return width <= DRAWER_BREAKPOINT;
}

export interface AppShellProps {
  groups: readonly NavGroup[];
  businessId: string | null;
  pathname: string;
  /** Breadcrumb / surface title. */
  title: string;
  scope: ScopeFacts | null;
  railFooter: ReactNode;
  topBarActions?: ReactNode;
  /**
   * Viewport class to render before the client can measure one.
   *
   * `matchMedia` is unavailable during server rendering, so without a hint the
   * first paint is always the wide composition — which, at 390, is the wrong
   * shell entirely: rail instead of drawer, full context bar instead of the
   * compact one. Callers that already know the width pass it; the media query
   * still owns the value from mount onwards.
   */
  initialNarrow?: boolean;
  /** Drawer and scope sheet are named states the shell can be built in. */
  initialDrawerOpen?: boolean;
  initialScopeOpen?: boolean;
  /** Omitted handlers mean the actor cannot re-scope; the row shows no picker. */
  scopePickers?: ScopePickers;
  /**
   * Where to go back to, when this client scope was entered from the agency
   * desk. Absent for an operator who arrived directly, because offering a
   * "return" to a desk they never came from is a fabricated history.
   */
  agencyReturn?: { href: string; label: string } | null;
  children: ReactNode;
}

function useIsNarrow(initial: boolean): boolean {
  const [narrow, setNarrow] = useState(initial);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(max-width: ${DRAWER_BREAKPOINT}px)`);
    const apply = () => setNarrow(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return narrow;
}

/**
 * Return to the agency desk, with the desk's own context preserved.
 *
 * The href carries the search, cursor and row the operator left from, so
 * returning lands on the same page of the same list rather than at the top of
 * a freshly loaded one.
 */
const drawerScopeButton: React.CSSProperties = {
  minHeight: 44,
  textAlign: "left",
  background: "none",
  border: "1px solid var(--ledger-border-control)",
  borderRadius: "var(--ledger-radius-control)",
  color: "var(--ledger-ink-primary)",
  cursor: "pointer",
  fontSize: 13,
  padding: "0 8px",
};

function AgencyReturnLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      data-el="agency-return"
      data-flow-a-direction="return"
      style={{
        display: "block",
        marginBottom: 8,
        fontSize: 12,
        lineHeight: "16px",
        color: "var(--ledger-accent-action)",
        textDecoration: "none",
      }}
    >
      {label}
    </Link>
  );
}

export function AppShell({
  groups,
  businessId,
  pathname,
  title,
  scope,
  railFooter,
  topBarActions,
  initialNarrow = false,
  initialDrawerOpen = false,
  initialScopeOpen = false,
  scopePickers,
  agencyReturn,
  children,
}: AppShellProps) {
  const copy = useCopy();
  const narrow = useIsNarrow(initialNarrow);
  const [scopeOpen, setScopeOpen] = useState(initialScopeOpen);

  return (
    <div
      {...{ [ZERO_BASE_ROOT_ATTRIBUTE]: ZERO_BASE_ROOT_VALUE }}
      data-shell=""
      style={{
        // Bounded to the viewport, not min-height: a rail whose parent has no
        // definite height grows with its own nav list, which pushes the footer
        // identity row below the fold (B02). Height must be definite for
        // `min-height: 0` on the nav area to give it a real scroll range.
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        // The shell owns overflow so no child can create a page-level scroll.
        overflow: "hidden",
      }}
    >
      <ZeroBasePortalHost>
        <SkipLink />
        <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}>
          {!narrow ? (
            <Rail
              groups={groups}
              businessId={businessId}
              pathname={pathname}
              footer={
                <>
                  {agencyReturn ? <AgencyReturnLink {...agencyReturn} /> : null}
                  {railFooter}
                </>
              }
            />
          ) : null}

          <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minWidth: 0 }}>
            <header
              data-top-bar=""
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 16px",
                minHeight: 56,
                borderBottom: "1px solid var(--ledger-border-subtle)",
                background: "var(--ledger-bg-surface)",
              }}
            >
              {narrow ? (
                <NavDrawer
                  groups={groups}
                  businessId={businessId}
                  pathname={pathname}
                  footer={
                    <>
                      {agencyReturn ? <AgencyReturnLink {...agencyReturn} /> : null}
                      {/* The drawer is the mobile rail, so it carries the same
                          scope affordances rather than sending the operator to
                          a second surface to change business or scope. */}
                      {scopePickers?.onSwitchScope || scopePickers?.onSwitchBusiness ? (
                        <div style={{ display: "grid", gap: 4, marginBottom: 8 }}>
                          {scopePickers.onSwitchScope ? (
                            <button
                              type="button"
                              data-ctl="live:AUTH-10 scope-switch"
                              onClick={scopePickers.onSwitchScope}
                              style={drawerScopeButton}
                            >
                              {copy.switchScope}
                            </button>
                          ) : null}
                          {scopePickers.onSwitchBusiness ? (
                            <button
                              type="button"
                              data-ctl="live:AUTH-10 business-switcher"
                              onClick={scopePickers.onSwitchBusiness}
                              style={drawerScopeButton}
                            >
                              {copy.switchBusiness}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {railFooter}
                    </>
                  }
                  initialOpen={initialDrawerOpen}
                />
              ) : null}
              <h1
                style={{
                  margin: 0,
                  fontSize: 16,
                  fontWeight: 600,
                  lineHeight: "22px",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {title}
              </h1>
              <div style={{ flex: "1 1 auto" }} />
              {topBarActions}
            </header>

            {scope ? (
              <ContextBar
                facts={scope}
                compact={narrow}
                onOpenScopeSheet={() => setScopeOpen(true)}
              />
            ) : null}

            <main
              id={MAIN_CONTENT_ID}
              /**
               * Zero, not -1.
               *
               * This element owns both scroll axes, and a scroll container that
               * cannot be focused is unreachable by keyboard on any page whose
               * content has no focusable element of its own — a read-only
               * report, an unavailable state. `-1` kept the skip link working
               * but left those pages unscrollable without a mouse. Zero keeps
               * the skip target and adds the one tab stop that makes the region
               * operable, which is the documented remedy for
               * axe's scrollable-region-focusable.
               */
              tabIndex={MAIN_CONTENT_TABINDEX}
              style={{
                flex: "1 1 auto",
                minWidth: 0,
                minHeight: 0,
                padding: narrow ? 16 : 40,
                // The page no longer scrolls, so main owns both axes: wide
                // content scrolls sideways here rather than widening the page,
                // and long content scrolls vertically here rather than
                // stretching the rail.
                overflowX: "auto",
                overflowY: "auto",
              }}
            >
              {children}
            </main>
          </div>
        </div>

        {scope ? (
          <ScopeSheet
            open={scopeOpen}
            onOpenChange={setScopeOpen}
            facts={scope}
            pickers={scopePickers}
          />
        ) : null}
      </ZeroBasePortalHost>
    </div>
  );
}
