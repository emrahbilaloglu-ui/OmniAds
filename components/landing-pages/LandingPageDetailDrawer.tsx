"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
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
  formatLandingPageActionLabel,
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
      <SheetContent side="right" className="w-full max-w-[1140px] overflow-y-auto border-l border-neutral-200 bg-neutral-50 p-0 sm:max-w-[1140px]">
        {row ? (
          <>
            <SheetHeader className="border-b border-neutral-200 bg-white px-6 py-5">
              <SheetTitle className="text-xl text-neutral-900">{row.title}</SheetTitle>
              <SheetDescription className="font-mono text-xs text-neutral-500">
                {row.path}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-5 p-6">
              {ruleReport ? (
                <section className={`rounded-xl border p-4 ${getDecisionTheme(ruleReport.action)}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-neutral-500">
                        {t.aiInsight}
                      </p>
                      <h3 className="mt-1 text-[17px] font-semibold text-neutral-950">
                        {ruleHeadline(ruleReport.action, language)}
                      </h3>
                    </div>
                    <DecisionBadge action={ruleReport.action} language={language} />
                  </div>

                  <p className="mt-2.5 text-sm leading-6 text-neutral-700">{ruleReport.summary}</p>

                  <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
                    <CompactMetricCell label={t.decisionScore} value={`${ruleReport.score}/100`} />
                    <CompactMetricCell
                      label={t.confidence}
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
                    <ListBlock title={t.priorityActions} items={ruleReport.actions} ordered />
                    <ListBlock title={t.risks} items={ruleReport.risks} emptyText={t.noUnusualRisks} />
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

              <section className="rounded-xl border border-neutral-200 bg-white p-5 ">
                <div className="mb-4 flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-neutral-500" />
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-neutral-500">
                      {t.uxAudit}
                    </p>
                    <p className="mt-1 text-sm text-neutral-600">
                      {t.uxAuditDescription}
                    </p>
                  </div>
                </div>

                {!aiAnalysisRequested ? (
                  <div className="space-y-3">
                    <p className="text-sm text-neutral-600">
                      {t.runAuditPrompt}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setAiAnalysisRequested(true);
                        commentaryQuery.refetch();
                      }}
                      className="border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-50"
                    >
                      {t.runAudit}
                    </Button>
                  </div>
                ) : commentaryQuery.isLoading || commentaryQuery.isFetching ? (
                  <div className="space-y-2">
                    <div className="h-4 w-2/3 animate-pulse rounded bg-neutral-200" />
                    <div className="h-4 w-full animate-pulse rounded bg-neutral-200" />
                    <div className="h-4 w-5/6 animate-pulse rounded bg-neutral-200" />
                  </div>
                ) : commentaryQuery.isError ? (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                      {t.auditLoadError}
                    </div>
                    <Button type="button" variant="outline" onClick={() => commentaryQuery.refetch()}>
                      {t.retryAudit}
                    </Button>
                  </div>
                ) : commentaryQuery.data ? (
                  <div className="space-y-4">
                    <p className="text-sm leading-6 text-neutral-700">
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
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">{title}</p>
      {items.length > 0 ? (
        <ul className="space-y-2 text-sm text-neutral-700">
          {items.map((item, index) => (
            <li
              key={`${title}-${item}`}
              className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2.5"
            >
              {ordered ? `${index + 1}. ` : ""}{item}
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm text-neutral-500">
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
    <div className="rounded-xl border border-neutral-200 bg-white/85 px-3 py-1.5">
      <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-neutral-900">{value}</p>
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
    <div className="rounded-xl border border-neutral-200 bg-white/90 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500">{label}</p>
          <p className="mt-1 text-lg font-semibold text-neutral-950">{tone.label}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold text-neutral-950">{rounded}</p>
          <p className="text-[11px] text-neutral-500">{language === "tr" ? "100 üzerinden" : "out of 100"}</p>
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-100">
        <div
          className={`h-full rounded-full ${tone.barClass}`}
          style={{ width: `${rounded}%` }}
        />
      </div>
      <p className="mt-2.5 text-sm leading-5 text-neutral-600">{description}</p>
    </div>
  );
}

function DecisionBadge({
  action,
  language,
}: {
  action: ReturnType<typeof buildLandingPageRuleReport>["action"];
  language: "en" | "tr";
}) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${getDecisionBadgeClass(action)}`}
    >
      {formatLandingPageActionLabel(action, language)}
    </span>
  );
}

function ruleHeadline(action: ReturnType<typeof buildLandingPageRuleReport>["action"], language: "en" | "tr"): string {
  if (action === "scale") return language === "tr" ? "Kontrollü büyütme için hazır" : "Ready for controlled scale";
  if (action === "fix_above_fold") return language === "tr" ? "Ilk ekran deneyimini iyileştirin" : "Improve the first screen experience";
  if (action === "fix_product_discovery") return language === "tr" ? "Ana darbogaz ürün kesfi tarafinda" : "Discovery is the main bottleneck";
  if (action === "fix_product_story") return language === "tr" ? "Ürün hikayesi satın alma niyetini guclendirmiyor" : "Product story needs stronger buying intent";
  if (action === "fix_checkout_intent") return language === "tr" ? "Cart'tan checkout'a gecis ivmesi zayıf" : "Cart-to-checkout momentum needs work";
  if (action === "fix_late_checkout") return language === "tr" ? "Gec checkout sürtünmesi dönüşumleri baskiliyor" : "Late checkout friction is suppressing conversions";
  if (action === "tracking_audit") return language === "tr" ? "Daha derin CRO değişikliklerinden önce analytics'i doğrulayın" : "Validate analytics before deeper CRO changes";
  return language === "tr" ? "Daha geniş değişikliklerden önce bu sayfayı izleyin" : "Monitor this page before broader changes";
}

function getDecisionTheme(action: ReturnType<typeof buildLandingPageRuleReport>["action"]): string {
  if (action === "scale") return "border-emerald-200 bg-white";
  if (action === "tracking_audit") return "border-amber-300 bg-white";
  if (action === "watch") return "border-neutral-200 bg-white";
  return "border-orange-200 bg-white";
}

function getDecisionBadgeClass(action: ReturnType<typeof buildLandingPageRuleReport>["action"]): string {
  if (action === "scale") return "bg-emerald-600 text-white";
  if (action === "tracking_audit") return "bg-amber-500 text-white";
  if (action === "watch") return "bg-neutral-900 text-white";
  return "bg-orange-500 text-white";
}

function scoreTone(value: number, language: "en" | "tr"): { label: string; barClass: string } {
  if (value >= 80) return { label: language === "tr" ? "Güçlü" : "Strong", barClass: "bg-emerald-500" };
  if (value >= 60) return { label: language === "tr" ? "Saglikli" : "Healthy", barClass: "bg-blue-500" };
  if (value >= 40) return { label: language === "tr" ? "Karışık" : "Mixed", barClass: "bg-amber-500" };
  return { label: language === "tr" ? "Zayıf" : "Weak", barClass: "bg-orange-500" };
}
