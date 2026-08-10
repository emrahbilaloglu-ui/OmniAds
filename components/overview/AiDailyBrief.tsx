"use client";

import type { AiDailyInsightSnapshot } from "@/src/types/models";
import { Button } from "@/components/ui/button";
import { getTranslations } from "@/lib/i18n";
import { usePreferencesStore } from "@/store/preferences-store";

function SectionList({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  if (items.length === 0) return null;

  return (
    <section className="space-y-2 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-neutral-600">{title}</h3>
      <ul className="space-y-1.5 text-sm text-neutral-700">
        {items.map((item, index) => (
          <li key={`${title}_${index}`} className="flex items-start gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-neutral-400" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AiDailyBrief({
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
  const t = getTranslations(language).aiBrief;

  if (loading) {
    return (
      <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-4">
        <div className="h-4 w-48 animate-pulse rounded bg-neutral-200" />
        <div className="h-3 w-full animate-pulse rounded bg-neutral-100" />
        <div className="h-3 w-5/6 animate-pulse rounded bg-neutral-100" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
        {t.errorPrefix} {error}
      </div>
    );
  }

  if (!insight) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-600">
        {t.empty}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-neutral-900">{t.title}</h3>
        <div className="flex items-center gap-2">
          {onRegenerate ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRegenerate}
              disabled={Boolean(regenerating)}
            >
              {regenerating ? getTranslations(language).common.generating : getTranslations(language).common.regenerate}
            </Button>
          ) : null}
          <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-[12px] font-medium text-neutral-600">
            {t.insightDate}: {insight.insightDate}
          </span>
        </div>
      </div>

      <p className="text-sm leading-relaxed text-neutral-700">{insight.summary}</p>

      <div className="grid gap-3 lg:grid-cols-3">
        <SectionList title={t.opportunities} items={insight.opportunities} />
        <SectionList title={t.risks} items={insight.risks} />
        <SectionList title={t.recommendations} items={insight.recommendations} />
      </div>
    </div>
  );
}
