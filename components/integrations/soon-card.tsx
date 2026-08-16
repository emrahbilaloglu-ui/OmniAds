"use client";

import Image from "next/image";

import { getProviderLabel } from "@/components/integrations/oauth";
import type { IntegrationProvider } from "@/store/integrations-store";

interface SoonCardProps {
  provider: IntegrationProvider;
  logoSrc: string | null;
  /**
   * What is actually true about this connector today.
   *
   * The design shows an ETA here. We do not have one — no date is scheduled for
   * any of these — so this says what is known instead. A made-up quarter would
   * read as a commitment the product has not made.
   */
  note: string;
}

/**
 * A provider with no live connector.
 *
 * Dashed border and a greyed logo on purpose: the design keeps these visually
 * unfinished so a roadmap card can never be mistaken for a working one, and
 * they stay out of the sidebar until the integration is real.
 */
export function SoonCard({ provider, logoSrc, note }: SoonCardProps) {
  const label = getProviderLabel(provider);

  return (
    <article className="flex items-center gap-[10px] rounded-[14px] border border-dashed border-[#c9d2e0] bg-[rgba(255,255,255,0.6)] px-4 py-[14px]">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
        {logoSrc ? (
          <Image
            src={logoSrc}
            alt={label}
            width={17}
            height={17}
            className="object-contain opacity-75 grayscale"
          />
        ) : null}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-[7px]">
          <span className="truncate text-[13.5px] font-semibold text-[var(--adv-ink-2)]">
            {label}
          </span>
          <span className="rounded-[4px] bg-[var(--adv-fill-2)] px-1.5 py-[1.5px] font-[family-name:var(--adv-font-mono)] text-[8.5px] tracking-[0.08em] text-[var(--adv-ink-3)]">
            SOON
          </span>
        </span>
        <span className="mt-0.5 block text-[11.5px] text-[var(--adv-ink-4)]">{note}</span>
      </span>
    </article>
  );
}
