"use client";

/**
 * Tabs.
 *
 * The design is specific about one thing here: an unavailable tab is never
 * hidden. Hiding it makes the surface look like the capability does not exist;
 * showing it with a truth-state panel tells the user it exists and why they
 * cannot see it yet. So `unavailableReason` renders the panel in place of the
 * content rather than removing the tab.
 *
 * Arrow-key roving, Home/End and the tablist roles come from Radix.
 */
import { Tabs as RadixTabs } from "radix-ui";
import type { ReactNode } from "react";

import { UnavailableState } from "@/components/zero-base/states/surface-state";

export interface ZeroBaseTab {
  id: string;
  label: string;
  content: ReactNode;
  /** Present ⇒ the tab stays visible and shows a truth-state panel. */
  unavailableReason?: string;
  code?: string;
}

export function ZeroBaseTabs({
  tabs,
  value,
  onValueChange,
  label,
  tabCtl = "live:tab",
}: {
  tabs: readonly ZeroBaseTab[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  /**
   * Contract key the triggers satisfy.
   *
   * Defaults to the generic tab contract. Surfaces where switching tabs *is* a
   * named product action — the Decisions lanes, for instance — pass their own,
   * because "changed lane" and "changed tab" are not the same event.
   */
  tabCtl?: string;
}) {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange}>
      <RadixTabs.List
        aria-label={label}
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--ledger-border-subtle)",
          // Overflowing tabs scroll rather than wrap or disappear.
          overflowX: "auto",
        }}
      >
        {tabs.map((tab) => (
          <RadixTabs.Trigger
            key={tab.id}
            value={tab.id}
            data-unavailable={tab.unavailableReason ? "" : undefined}
            data-ctl={tabCtl}
            style={{
              minHeight: 44,
              padding: "10px 14px",
              fontSize: 13,
              fontWeight: 600,
              lineHeight: "19px",
              whiteSpace: "nowrap",
              background: "transparent",
              color:
                tab.id === value ? "var(--ledger-accent-action)" : "var(--ledger-ink-secondary)",
              // Selection is an underline; the focus ring is separate and both
              // are visible at once.
              borderBottom:
                tab.id === value ? "2px solid var(--ledger-accent-action)" : "2px solid transparent",
              cursor: "pointer",
            }}
          >
            {tab.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {tabs.map((tab) => (
        <RadixTabs.Content key={tab.id} value={tab.id} style={{ paddingTop: 16 }}>
          {tab.unavailableReason ? (
            <UnavailableState reason={tab.unavailableReason} code={tab.code} />
          ) : (
            tab.content
          )}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
