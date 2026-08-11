"use client";

/**
 * User menu — profile, language, theme, logout. Exactly those four.
 *
 * The legacy menu accumulated entries that led nowhere. The design fixes the
 * set, so anything not on this list is not reachable from here; adding an item
 * means changing this list and the test that pins it.
 */
import Link from "next/link";

import { ThemeControl } from "@/components/theme/theme-control";
import { Button } from "@/components/zero-base/primitives/button";
import { ZeroBasePopover } from "@/components/zero-base/primitives/overlays";

export const USER_MENU_ITEMS = ["profile", "language", "theme", "logout"] as const;

export function UserMenu({ name, onLogout }: { name: string; onLogout: () => void }) {
  return (
    <ZeroBasePopover
      label="Account"
      trigger={
        <Button variant="secondary" aria-label={`Account — ${name}`} data-user-menu-trigger="">
          {name}
        </Button>
      }
    >
      <div style={{ display: "grid", gap: 10, minWidth: 220 }}>
        <Link
          href="/me/account-security"
          data-user-menu-item="profile"
          style={{ fontSize: 13, color: "var(--ledger-accent-action)", minHeight: 24 }}
        >
          Account &amp; security
        </Link>
        <Link
          href="/me/language"
          data-user-menu-item="language"
          style={{ fontSize: 13, color: "var(--ledger-accent-action)", minHeight: 24 }}
        >
          Language
        </Link>
        <div data-user-menu-item="theme">
          <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>Theme</p>
          <ThemeControl />
        </div>
        <Button variant="secondary" onClick={onLogout} data-user-menu-item="logout">
          Log out
        </Button>
      </div>
    </ZeroBasePopover>
  );
}
