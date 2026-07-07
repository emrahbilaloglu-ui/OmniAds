"use client";

import type { ReactNode } from "react";

export function SummarySection({
  title,
  description,
  action,
  children,
}: {
  title: ReactNode;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  // Triple-Whale-calm: sections are quiet groups, not nested cards. A low-key
  // header sits over content that renders as flat white cards on the neutral
  // canvas — the hairline card borders do the delineating, not a wrapper box.
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3 px-0.5">
        <div className="space-y-0.5">
          <h2 className="text-[15px] font-semibold tracking-tight text-neutral-900">{title}</h2>
          {description ? <p className="text-[13px] leading-snug text-neutral-500">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
