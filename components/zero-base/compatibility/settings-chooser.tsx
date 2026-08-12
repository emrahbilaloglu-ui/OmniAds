/**
 * `/settings` after the split (WP-27A step 2).
 *
 * The one legacy path that maps to two canonical leaves: account security is
 * about the person, business settings are about the workspace. Picking one
 * would silently send half the traffic somewhere it did not ask for, and the
 * two are not interchangeable — one holds a password, the other holds a
 * currency.
 *
 * So it asks. Both destinations are named in the operator's own words, with
 * what lives behind each, because "Account" and "Business" alone do not tell
 * someone where the thing they were looking for went.
 */
"use client";

import Link from "next/link";

import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export function SettingsChooser({ destinations }: { destinations: readonly string[] }) {
  const copy = useCopy();
  const copyFor = (destination: string) =>
    destination.startsWith("/me/")
      ? { title: copy.accountAndSecurity, detail: copy.accountAndSecurityDetail }
      : { title: copy.businessSettings, detail: copy.businessSettingsDetail };

  return (
    <main
      data-settings-chooser=""
      data-el="settings-split"
      style={{ maxWidth: 560, margin: "0 auto", padding: 24 }}
    >
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>
        {copy.settings}
      </h1>
      <p
        style={{
          margin: "4px 0 16px",
          fontSize: 13,
          lineHeight: "19px",
          color: "var(--ledger-ink-secondary)",
        }}
      >
        {/* States the change rather than pretending nothing moved. */}
        {copy.settingsSplitNote}
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {destinations.map((destination) => {
          const entry = copyFor(destination);
          return (
            <li key={destination}>
              <Link
                href={destination}
                data-settings-destination={destination}
                data-ctl="live:nav"
                style={{
                  display: "block",
                  minHeight: 44,
                  padding: "12px 14px",
                  borderRadius: "var(--ledger-radius-card)",
                  border: "1px solid var(--ledger-border-control)",
                  background: "var(--ledger-bg-surface)",
                  color: "var(--ledger-ink-primary)",
                  textDecoration: "none",
                }}
              >
                <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>
                  {entry.title}
                </span>
                <span
                  style={{
                    display: "block",
                    marginTop: 2,
                    fontSize: 12,
                    lineHeight: "18px",
                    color: "var(--ledger-ink-secondary)",
                  }}
                >
                  {entry.detail}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
