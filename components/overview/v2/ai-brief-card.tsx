"use client";

import { Sparkles } from "lucide-react";
import { getTranslations } from "@/lib/i18n";
import { usePreferencesStore } from "@/store/preferences-store";
import type { AiDailyInsightSnapshot } from "@/src/types/models";

type BriefKind = "Opportunity" | "Risk" | "Action";

const KIND_TONE: Record<BriefKind, string> = {
  Opportunity: "pos",
  Risk: "neg",
  Action: "info",
};

function toRows(insight: AiDailyInsightSnapshot) {
  const rows: Array<{ kind: BriefKind; text: string }> = [];
  for (const text of insight.opportunities) rows.push({ kind: "Opportunity", text });
  for (const text of insight.risks) rows.push({ kind: "Risk", text });
  for (const text of insight.recommendations) rows.push({ kind: "Action", text });
  return rows;
}

export function AiBriefCard({
  insight,
  loading,
  error,
  onRegenerate,
  regenerating,
}: {
  insight: AiDailyInsightSnapshot | null | undefined;
  loading?: boolean;
  error?: string | null;
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  const language = usePreferencesStore((state) => state.language);
  const translations = getTranslations(language);
  const t = translations.aiBrief;
  const rows = insight ? toRows(insight) : [];

  return (
    <article className="adv-card overflow-hidden">
      <div
        className="flex items-center gap-2.5 px-4 py-3.5"
        style={{ background: "var(--adv-rail)" }}
      >
        <span
          className="grid h-[26px] w-[26px] place-items-center rounded-[8px] text-white"
          style={{ background: "var(--adc-auto-fg)" }}
        >
          <Sparkles className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </span>
        <h2 className="adv-card-title !text-white">{t.dailyTitle}</h2>
        <span className="adv-mono ml-auto text-[10px] text-[#8B93A7]">
          {insight?.insightDate ?? "—"}
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        {loading ? (
          <>
            <span className="h-3 w-full animate-pulse rounded bg-[var(--adv-hairline)]" />
            <span className="h-3 w-5/6 animate-pulse rounded bg-[var(--adv-hairline)]" />
            <span className="h-3 w-2/3 animate-pulse rounded bg-[var(--adv-hairline)]" />
          </>
        ) : error ? (
          <p className="m-0 text-[13px] leading-[1.6] text-[var(--adc-danger-fg)]">
            {t.errorPrefix} {error}
          </p>
        ) : !insight ? (
          <p className="m-0 text-[13px] leading-[1.6] text-[var(--adv-ink-2)]">{t.empty}</p>
        ) : (
          <>
            <p className="m-0 text-[13px] leading-[1.6] text-[var(--adv-ink-2)]">
              {insight.summary}
            </p>
            {rows.map((row, index) => (
              <div
                key={`${row.kind}-${index}`}
                className="flex items-start gap-2.5 rounded-[var(--adv-r-tile)] border border-[var(--adv-hairline)] px-3 py-2.5"
              >
                <span className="adv-tag mt-px shrink-0" data-tone={KIND_TONE[row.kind]}>
                  {row.kind}
                </span>
                <span className="text-[12.5px] leading-[1.5] text-[var(--adv-ink)]">
                  {row.text}
                </span>
              </div>
            ))}
          </>
        )}
        {onRegenerate ? (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={regenerating}
            className="adv-btn h-8 justify-center !text-[12.5px] !text-[var(--adv-ink-2)]"
          >
            {regenerating ? translations.common.generating : t.regenerateBrief}
          </button>
        ) : null}
      </div>
    </article>
  );
}
