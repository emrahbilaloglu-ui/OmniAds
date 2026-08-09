"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  buildLandingPageRuleReport,
  formatLandingPageArchetypeLabel,
} from "@/lib/landing-pages/rule-engine";
import { getTranslations } from "@/lib/i18n";
import { usePreferencesStore } from "@/store/preferences-store";
import { getLandingPageAiCommentary } from "@/src/services";
import type { LandingPagePerformanceRow } from "@/src/types/landing-pages";
import {
  getDropOffLabel,
  resolveLandingPageAbsoluteUrl,
  toAiReport,
} from "@/components/landing-pages/support";

interface LandingPageDetailDrawerProps {
  businessId: string;
  row: LandingPagePerformanceRow | null;
  open: boolean;
  currency: string | null;
  siteBaseUrl: string | null;
  onOpenChange: (open: boolean) => void;
}

export function LandingPageDetailDrawer({
  businessId,
  row,
  open,
  currency,
  siteBaseUrl,
  onOpenChange,
}: LandingPageDetailDrawerProps) {
  const [aiAnalysisRequested, setAiAnalysisRequested] = useState(false);
  const language = usePreferencesStore((state) => state.language);
  const t = getTranslations(language).landingPages;
  const aiReport = row
    ? {
        ...toAiReport(row),
        url: resolveLandingPageAbsoluteUrl(row.path, siteBaseUrl),
      }
    : null;
  const ruleReport = row ? buildLandingPageRuleReport(row, language) : null;

  useEffect(() => {
    if (!open) {
      setAiAnalysisRequested(false);
      return;
    }
    setAiAnalysisRequested(false);
  }, [open, row?.path]);

  const commentaryQuery = useQuery({
    queryKey: ["landing-page-ai-commentary", businessId, aiReport?.path ?? "", aiReport?.sessions ?? 0, aiReport?.purchases ?? 0],
    enabled: false,
    queryFn: () => {
      if (!aiReport || !ruleReport) throw new Error("Missing landing page AI report.");
      return getLandingPageAiCommentary(businessId, aiReport, ruleReport);
    },
    retry: 1,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-[1140px] overflow-y-auto border-l border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s1,#f5f5f3)] p-0 sm:max-w-[1140px]">
        {row ? (
          <>
            <SheetHeader className="border-b border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] px-6 py-5">
              <SheetTitle className="text-xl text-[var(--adc-ink,#1a1c1f)]">{row.title}</SheetTitle>
              <SheetDescription className="font-mono text-xs text-[var(--adc-ink3,#7d838c)]">
                {row.path}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-5 p-6">
              {ruleReport ? (
                <section className="rounded-[var(--r-lg,8px)] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--adc-ink3,#7d838c)]">
                        {language === "tr" ? "GA4 huni sezgisi" : "GA4 funnel heuristic"}
                      </p>
                      <h3 className="mt-1 text-[17px] font-semibold text-[var(--adc-ink,#1a1c1f)]">
                        {formatLandingPageArchetypeLabel(ruleReport.archetype, language)}
                      </h3>
                    </div>
                    <span className="rounded-[4px] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s1,#f5f5f3)] px-2 py-1 text-[12px] font-semibold text-[var(--adc-ink3,#7d838c)]">
                      {language === "tr" ? "Yalnızca tanılama" : "Diagnostic only"}
                    </span>
                  </div>

                  <p className="mt-2.5 text-sm leading-6 text-[var(--adc-ink2,#4a4f56)]">{ruleReport.summary}</p>

                  <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
                    <CompactMetricCell
                      label={language === "tr" ? "Sezgisel puan" : "Heuristic score"}
                      value={`${ruleReport.score}/100`}
                    />
                    <CompactMetricCell
                      label={language === "tr" ? "Sezgisel güven" : "Heuristic confidence"}
                      value={`${Math.round(ruleReport.confidence * 100)}%`}
                    />
                    <CompactMetricCell
                      label={t.pageType}
                      value={formatLandingPageArchetypeLabel(ruleReport.archetype, language)}
                    />
                    <CompactMetricCell
                      label={t.primaryLeak}
                      value={getDropOffLabel(ruleReport.primaryLeak, language)}
                    />
                  </div>

                  <div className="mt-3 grid gap-3 xl:grid-cols-2">
                    <ListBlock title={t.strengths} items={ruleReport.strengths} emptyText={t.noStrongAdvantages} />
                    <ListBlock title={t.issues} items={ruleReport.issues} emptyText={t.noDominantIssue} />
                  </div>

                  <div className="mt-3 grid gap-3 xl:grid-cols-2">
                    <ListBlock title={t.risks} items={ruleReport.risks} emptyText={t.noUnusualRisks} />
                    <div className="rounded-[var(--r-lg,8px)] border border-[var(--adc-info-bd,#c5d6f1)] bg-[var(--adc-info-bg,#ebf1fb)] p-3 text-[12px] leading-5 text-[var(--adc-info-fg,#1d5fc4)]">
                      <p>
                        {language === "tr"
                          ? "Bu skor ve tanılar tarayıcıdaki GA4 sezgisidir; Meta buyerAction değildir."
                          : "These scores and diagnostics are a browser-side GA4 heuristic, not a Meta buyerAction."}
                      </p>
                      <Link
                        href={`/platforms/meta?businessId=${encodeURIComponent(businessId)}&landingPage=${encodeURIComponent(row.path)}`}
                        className="mt-2 inline-flex items-center gap-1 font-semibold"
                      >
                        {language === "tr" ? "Decisions içinde aç" : "Open in Decisions"}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
                    <ScorePill
                      label={t.trafficQuality}
                      value={ruleReport.scoreBreakdown.trafficQuality}
                      description={t.trafficQualityDescription}
                    />
                    <ScorePill
                      label={t.discovery}
                      value={ruleReport.scoreBreakdown.discovery}
                      description={t.discoveryDescription}
                    />
                    <ScorePill
                      label={t.intent}
                      value={ruleReport.scoreBreakdown.intent}
                      description={t.intentDescription}
                    />
                    <ScorePill
                      label={t.checkout}
                      value={ruleReport.scoreBreakdown.checkout}
                      description={t.checkoutDescription}
                    />
                    <ScorePill
                      label={t.revenueEfficiency}
                      value={ruleReport.scoreBreakdown.revenueEfficiency}
                      description={t.revenueEfficiencyDescription}
                    />
                  </div>
                </section>
              ) : null}

              <section className="rounded-[var(--r-lg,11px)] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] p-5 ">
                <div className="mb-4 flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-[var(--adc-ink3,#7d838c)]" />
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--adc-ink3,#7d838c)]">
                      {t.uxAudit}
                    </p>
                    <p className="mt-1 text-sm text-[var(--adc-ink3,#7d838c)]">
                      {t.uxAuditDescription}
                    </p>
                  </div>
                </div>

                {!aiAnalysisRequested ? (
                  <div className="space-y-3">
                    <p className="text-sm text-[var(--adc-ink3,#7d838c)]">
                      {t.runAuditPrompt}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setAiAnalysisRequested(true);
                        commentaryQuery.refetch();
                      }}
                      className="border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] text-[var(--adc-ink,#1a1c1f)] hover:bg-[var(--adc-s1,#f5f5f3)]"
                    >
                      {t.runAudit}
                    </Button>
                  </div>
                ) : commentaryQuery.isLoading || commentaryQuery.isFetching ? (
                  <div className="space-y-2">
                    <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--adc-b1,#e4e4e0)]" />
                    <div className="h-4 w-full animate-pulse rounded bg-[var(--adc-b1,#e4e4e0)]" />
                    <div className="h-4 w-5/6 animate-pulse rounded bg-[var(--adc-b1,#e4e4e0)]" />
                  </div>
                ) : commentaryQuery.isError ? (
                  <div className="space-y-3">
                    <div className="rounded-[var(--r-lg,11px)] border border-[var(--adc-caution-bd,#e8d5a6)] bg-[var(--adc-caution-bg,#faf2df)] px-4 py-3 text-sm text-[var(--adc-caution-fg,#86590a)]">
                      {t.auditLoadError}
                    </div>
                    <Button type="button" variant="outline" onClick={() => commentaryQuery.refetch()}>
                      {t.retryAudit}
                    </Button>
                  </div>
                ) : commentaryQuery.data ? (
                  <div className="space-y-4">
                    <span className="inline-flex rounded-[4px] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s1,#f5f5f3)] px-2 py-1 text-[12px] font-semibold text-[var(--adc-ink3,#7d838c)]">
                      {language === "tr" ? "Taslak analiz · Meta kararı değil" : "Draft analysis · not a Meta decision"}
                    </span>
                    <p className="text-sm leading-6 text-[var(--adc-ink2,#4a4f56)]">
                      {commentaryQuery.data.commentary.summary}
                    </p>

                    <AiList title={t.criticalFindings} items={commentaryQuery.data.commentary.insights} />
                    <AiList title={t.quickWins} items={commentaryQuery.data.commentary.recommendations} />
                    <AiList title={t.uxRisks} items={commentaryQuery.data.commentary.risks} />
                    <Button type="button" variant="outline" onClick={() => commentaryQuery.refetch()}>
                      {t.rerunAudit}
                    </Button>
                  </div>
                ) : null}
              </section>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ListBlock({
  title,
  items,
  ordered = false,
  emptyText,
}: {
  title: string;
  items: string[];
  ordered?: boolean;
  emptyText?: string;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--adc-ink3,#7d838c)]">{title}</p>
      {items.length > 0 ? (
        <ul className="space-y-2 text-sm text-[var(--adc-ink2,#4a4f56)]">
          {items.map((item, index) => (
            <li
              key={`${title}-${item}`}
              className="rounded-[var(--r-lg,11px)] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s1,#f5f5f3)] px-4 py-2.5"
            >
              {ordered ? `${index + 1}. ` : ""}{item}
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-[var(--r-lg,11px)] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s1,#f5f5f3)] px-4 py-2.5 text-sm text-[var(--adc-ink3,#7d838c)]">
          {emptyText ?? "No items."}
        </div>
      )}
    </div>
  );
}

function AiList({ title, items }: { title: string; items: string[] }) {
  return <ListBlock title={title} items={items} />;
}

function CompactMetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--r-lg,11px)] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] px-3 py-1.5">
      <p className="text-[12px] uppercase tracking-[0.16em] text-[var(--adc-ink3,#7d838c)]">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-[var(--adc-ink,#1a1c1f)]">{value}</p>
    </div>
  );
}

function ScorePill({
  label,
  value,
  description,
}: {
  label: string;
  value: number;
  description: string;
}) {
  const language = usePreferencesStore((state) => state.language);
  const rounded = Math.round(value);
  const tone = scoreTone(rounded, language);

  return (
    <div className="rounded-[var(--r-lg,11px)] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--adc-ink3,#7d838c)]">{label}</p>
          <p className="mt-1 text-lg font-semibold text-[var(--adc-ink,#1a1c1f)]">{tone.label}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold text-[var(--adc-ink,#1a1c1f)]" style={{ fontFeatureSettings: "'tnum'" }}>{rounded}</p>
          <p className="text-[11px] text-[var(--adc-ink3,#7d838c)]">{language === "tr" ? "100 üzerinden" : "out of 100"}</p>
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--adc-s3,#ededea)]">
        <div
          className={`h-full rounded-full ${tone.barClass}`}
          style={{ width: `${rounded}%` }}
        />
      </div>
      <p className="mt-2.5 text-sm leading-5 text-[var(--adc-ink3,#7d838c)]">{description}</p>
    </div>
  );
}

function scoreTone(value: number, language: "en" | "tr"): { label: string; barClass: string } {
  if (value >= 80) return { label: language === "tr" ? "Güçlü" : "Strong", barClass: "bg-[var(--adc-pos-fg,#0b6b4f)]" };
  if (value >= 60) return { label: language === "tr" ? "Saglikli" : "Healthy", barClass: "bg-[var(--adc-info-fg,#1d5fc4)]" };
  if (value >= 40) return { label: language === "tr" ? "Karışık" : "Mixed", barClass: "bg-[var(--adc-caution-fg,#86590a)]" };
  return { label: language === "tr" ? "Zayıf" : "Weak", barClass: "bg-[var(--adc-danger-fg,#a6224a)]" };
}
