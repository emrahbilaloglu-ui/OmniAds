"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { STUDIO_TABS } from "@/components/creatives/StudioOsView";

/**
 * The design's Creative Studio tab row. Studio is one screen with five
 * surfaces, so the sibling routes (copies, landers, inbox, audiences) carry the
 * same row with their own pill lit rather than looking like separate screens.
 *
 * The current query string rides along so the account scope and the creative
 * date window survive a tab switch.
 */
export function StudioTabRow({ active }: { active: (typeof STUDIO_TABS)[number]["key"] }) {
  const params = useSearchParams();
  // The Assets surface owns the "tab" param for its own sub-views; carrying it
  // onto a sibling would light the wrong pill there.
  const query = new URLSearchParams(params?.toString() ?? "");
  query.delete("tab");
  const suffix = query.toString() ? `?${query.toString()}` : "";

  return (
    <div
      role="tablist"
      aria-label="Creative Studio views"
      className="flex flex-wrap items-center gap-2"
    >
      {STUDIO_TABS.map((tab) => {
        const on = tab.key === active;
        return (
          <Link
            key={tab.key}
            role="tab"
            aria-selected={on}
            href={`${tab.href}${suffix}`}
            className="inline-flex h-8 items-center gap-[7px] rounded-full border px-[13px] text-[12.5px] font-semibold no-underline"
            style={{
              borderColor: on ? "var(--adv-accent-bd)" : "var(--adv-border)",
              background: on ? "var(--adv-accent-bg)" : "var(--adv-surface)",
              color: on ? "var(--adv-accent)" : "var(--adv-ink-2)",
            }}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
