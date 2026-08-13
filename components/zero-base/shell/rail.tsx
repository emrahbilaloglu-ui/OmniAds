"use client";

/**
 * The 232 px navigation rail.
 *
 * B02 is the constraint that shapes this: at a short viewport the rail must
 * still show its footer identity row, and the nav area — not the whole rail —
 * takes the scroll. A rail that scrolls as one block pushes the identity row
 * off-screen, so the nav is `overflow-y: auto` inside a flex column and the
 * footer is a sibling that cannot be scrolled away.
 *
 * Modules the actor cannot reach are absent, never disabled teasers.
 */
import Link from "next/link";

import { isNavHrefActive, navHref, railLabel, type NavGroup } from "@/lib/zero-base/navigation";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export const RAIL_WIDTH = 232;

export interface RailProps {
  groups: readonly NavGroup[];
  businessId: string | null;
  pathname: string;
  /** Workspace chrome drawn above navigation. */
  workspaceMode?: "agency" | "client" | "account";
  workspaceName?: string;
  onSwitchBusiness?: () => void;
  /** Footer identity row — must remain visible at any viewport height. */
  footer: React.ReactNode;
}

const GROUP_META: Record<string, { label: string; section: string; badge?: string }> = {
  home: { label: "Home", section: "" },
  meta: { label: "Meta", section: "Channels" },
  creative: { label: "Creative Intelligence", section: "Channels", badge: "META" },
  google: { label: "Google Ads", section: "Channels" },
  analytics: { label: "Analytics", section: "Channels" },
  reports: { label: "Reports", section: "Delivery" },
  manage: { label: "Manage", section: "Manage" },
};

const GROUP_ICON: Record<string, string> = {
  home: "⌂",
  meta: "◎",
  creative: "✦",
  google: "G",
  analytics: "⌁",
  reports: "▤",
};

function groupActive(group: NavGroup, pathname: string, businessId: string | null): boolean {
  return group.items.some((item) => {
    const href = navHref(item.url, businessId);
    return isNavHrefActive(href, pathname);
  });
}

export function Rail({
  groups,
  businessId,
  pathname,
  workspaceMode = businessId ? "client" : "agency",
  footer,
}: RailProps) {
  const copy = useCopy();
  const isClient = workspaceMode === "client";
  let lastSection = "__start__";

  return (
    <nav
      aria-label={copy.primary}
      data-rail=""
      style={{
        width: RAIL_WIDTH,
        flex: `0 0 ${RAIL_WIDTH}px`,
        // 232px is the drawn width, so the 1px border has to live inside it —
        // content-box sizing makes the rail 233px and shifts every column.
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        // Fills the viewport so the footer can sit at the bottom of it.
        height: "100%",
        background: "var(--ledger-bg-surface)",
        borderRight: "1px solid var(--ledger-border-subtle)",
      }}
    >
      <div
        data-rail-brand=""
        style={{
          flex: "0 0 auto",
          padding: "14px 12px 10px",
          borderBottom: "1px solid var(--ledger-border-subtle)",
        }}
      >
        <a
          href={isClient && businessId ? "/app/home" : "/a/desk"}
          data-ctl="live:nav"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--ledger-ink-primary)",
            textDecoration: "none",
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: "0.08em",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "grid",
              placeItems: "center",
              width: 20,
              height: 20,
              borderRadius: 5,
              color: "var(--ledger-bg-surface)",
              background: "var(--ledger-accent-action)",
              fontSize: 12,
              letterSpacing: 0,
            }}
          >
            A
          </span>
          {copy.brandName}
        </a>

        {workspaceMode !== "account" ? (
          <div
            aria-label={copy.workspaceScope}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              marginTop: 12,
              border: "1px solid var(--ledger-border-control)",
              borderRadius: "var(--ledger-radius-button)",
              overflow: "hidden",
            }}
          >
            <a
              href="/a/desk"
              data-ctl="live:AUTH-10 scope-switch"
              data-current-scope={workspaceMode === "agency" ? "true" : undefined}
              style={{
                padding: "5px 8px",
                color: workspaceMode === "agency" ? "var(--ledger-accent-action)" : "var(--ledger-ink-secondary)",
                background: workspaceMode === "agency" ? "var(--ledger-accent-tint)" : "var(--ledger-bg-surface)",
                textAlign: "center",
                textDecoration: "none",
                fontSize: 12,
                fontWeight: workspaceMode === "agency" ? 600 : 500,
              }}
            >
              {copy.agency}
            </a>
            <a
              href={businessId ? "/app/home" : "/select-business"}
              data-ctl="live:AUTH-10 scope-switch"
              data-current-scope={workspaceMode === "client" ? "true" : undefined}
              style={{
                padding: "5px 8px",
                borderLeft: "1px solid var(--ledger-border-control)",
                color: workspaceMode === "client" ? "var(--ledger-accent-action)" : "var(--ledger-ink-secondary)",
                background: workspaceMode === "client" ? "var(--ledger-accent-tint)" : "var(--ledger-bg-surface)",
                textAlign: "center",
                textDecoration: "none",
                fontSize: 12,
                fontWeight: workspaceMode === "client" ? 600 : 500,
              }}
            >
              {copy.client}
            </a>
          </div>
        ) : null}

      </div>

      <div
        data-rail-nav=""
        style={{
          // Only this area scrolls. The footer below is a sibling.
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          padding: "10px 8px 16px",
        }}
      >
        {groups.map((group) => {
          const meta = GROUP_META[group.id] ?? { label: group.label, section: group.label };
          const active = groupActive(group, pathname, businessId);
          const firstSection = lastSection === "__start__";
          const sectionChanged = meta.section !== lastSection;
          lastSection = meta.section;
          const firstHref = navHref(group.items[0]?.url ?? "#", businessId);
          const flatClientItems = isClient && group.id === "manage";

          return (
            <div key={group.id} style={{ marginBottom: active ? 12 : 3 }}>
              {sectionChanged && meta.section ? (
                <p
                  aria-hidden="true"
                  style={{
                    margin: firstSection ? "0 0 5px" : "14px 0 5px",
                    padding: "0 8px",
                    fontFamily: "var(--font-adc-mono), ui-monospace, monospace",
                    fontSize: 12,
                    lineHeight: "14px",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "var(--ledger-ink-tertiary)",
                  }}
                >
                  {meta.section}
                </p>
              ) : null}

              {isClient && !flatClientItems ? (
                <a
                  href={firstHref}
                  data-rail-group={group.id}
                  data-ctl="live:nav"
                  aria-current={active ? "page" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    minHeight: 34,
                    gap: 6,
                    padding: "6px 8px",
                    borderLeft: active ? "3px solid var(--ledger-accent-action)" : "3px solid transparent",
                    borderRadius: "var(--ledger-radius-input)",
                    color: active ? "var(--ledger-accent-action)" : "var(--ledger-ink-primary)",
                    background: active ? "var(--ledger-accent-tint)" : "transparent",
                    textDecoration: "none",
                    fontSize: 13,
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  <span aria-hidden="true" style={{ width: 18, textAlign: "center", color: "var(--ledger-ink-secondary)" }}>
                    {GROUP_ICON[group.id] ?? "·"}
                  </span>
                  <span style={{ flex: 1 }}>{meta.label}</span>
                  {meta.badge ? (
                    <span
                      style={{
                        padding: "1px 5px",
                        borderRadius: 999,
                        background: "var(--ledger-accent-tint)",
                        color: "var(--ledger-accent-action)",
                        fontSize: 12,
                        fontFamily: "var(--font-adc-mono), monospace",
                      }}
                    >
                      {meta.badge}
                    </span>
                  ) : null}
                </a>
              ) : !isClient ? (
                <p
                  aria-hidden="true"
                  style={{ margin: "0 0 4px", padding: "0 8px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}
                >
                  {group.label}
                </p>
              ) : null}

              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: !isClient || flatClientItems ? "block" : "none",
                }}
              >
                {group.items.map((item) => {
                const href = navHref(item.url, businessId);
                const current = href === pathname;
                return (
                  <li key={item.leaf}>
                    <Link
                      href={href}
                      data-ctl="live:nav"
                      aria-current={current ? "page" : undefined}
                      style={{
                        display: "block",
                        padding: isClient ? "7px 8px" : "7px 8px",
                        minHeight: 34,
                        fontSize: 13,
                        lineHeight: "18px",
                        borderRadius: "var(--ledger-radius-input)",
                        textDecoration: "none",
                        color: current ? "var(--ledger-accent-action)" : "var(--ledger-ink-primary)",
                        background: current ? "var(--ledger-accent-tint)" : "transparent",
                        borderLeft: current
                          ? "3px solid var(--ledger-accent-action)"
                          : "3px solid transparent",
                      }}
                    >
                      {railLabel(item.label)}
                    </Link>
                  </li>
                );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      <div
        data-rail-footer=""
        style={{
          flex: "0 0 auto",
          padding: 12,
          borderTop: "1px solid var(--ledger-border-subtle)",
        }}
      >
        {footer}
      </div>
    </nav>
  );
}
