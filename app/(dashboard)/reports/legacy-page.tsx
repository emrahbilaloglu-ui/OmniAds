"use client";

import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { TemplateMiniPreview, TemplateProviders } from "@/components/reports/template-mini-preview";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store/app-store";
import { CUSTOM_REPORT_TEMPLATES, type CustomReportRecord } from "@/lib/custom-reports";
import { PlanGate } from "@/components/pricing/PlanGate";
import { usePreferencesStore } from "@/store/preferences-store";
import { ProductSection } from "@/components/ui/product-surface";
import { WorkspaceSurface } from "@/components/workspace/workspace-surface";

async function fetchReports(businessId: string) {
  const response = await fetch(`/api/reports?businessId=${encodeURIComponent(businessId)}`, {
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { message?: string } | null)?.message ?? "Failed to load reports.");
  }
  const body = payload as {
    reports: CustomReportRecord[];
    generatedAt?: string | null;
  };
  // The read's own time travels with the rows so the surface can date itself
  // from when it read, not from when someone last edited a report.
  return { reports: body.reports, generatedAt: body.generatedAt ?? null };
}

export default function ReportsPage() {
  const language = usePreferencesStore((state) => state.language);
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businessId = selectedBusinessId ?? "";
  const queryClient = useQueryClient();
  const business = businesses.find((item) => item.id === selectedBusinessId) ?? null;
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busyReportId, setBusyReportId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<"recent" | "name">("recent");

  const reportsQuery = useQuery({
    queryKey: ["custom-reports", businessId],
    enabled: Boolean(selectedBusinessId),
    queryFn: () => fetchReports(businessId),
  });
  // One freshness contract across every Tier-0 surface. Derived from the
  // query state this surface already has, so it cannot drift from what is
  // actually on screen.
  useTierZeroFreshness({
    surface: "reports",
    isLoading: reportsQuery.isLoading,
    isFetching: reportsQuery.isFetching,
    error: reportsQuery.error,
    // The newest row's `updatedAt` is when a human last saved a report
    // definition, not when this list was read. Keep it as row content.
    asOf: measuredAsOf(reportsQuery.data?.generatedAt ?? null),
    businessId: selectedBusinessId,
    onRetry: () => void reportsQuery.refetch(),
  });
  const reports = reportsQuery.data?.reports ?? [];
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredReports = (normalizedQuery
    ? reports.filter((report) => {
        const category =
          CUSTOM_REPORT_TEMPLATES.find((template) => template.id === report.templateId)?.category ?? "";
        return [report.name, report.description ?? "", category]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);
      })
    : reports
  ).slice().sort((left, right) => {
    if (sortMode === "name") return left.name.localeCompare(right.name);
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });

  if (!selectedBusinessId) return <BusinessEmptyState />;

  const invalidateReports = async () => {
    await queryClient.invalidateQueries({ queryKey: ["custom-reports", businessId] });
  };

  const handleDuplicate = async (report: CustomReportRecord) => {
    setBusyReportId(report.id);
    setActionMessage(null);
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId,
        name: `${report.name} Copy`,
        description: report.description,
        templateId: report.templateId,
        definition: report.definition,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setActionMessage((payload as { message?: string } | null)?.message ?? "Failed to duplicate report.");
      setBusyReportId(null);
      return;
    }
    await invalidateReports();
    setBusyReportId(null);
    setActionMessage("Report duplicated.");
  };

  const handleDelete = async (reportId: string) => {
    setBusyReportId(reportId);
    setActionMessage(null);
    const response = await fetch(`/api/reports/${reportId}`, { method: "DELETE" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setActionMessage((payload as { message?: string } | null)?.message ?? "Failed to delete report.");
      setBusyReportId(null);
      return;
    }
    await invalidateReports();
    setBusyReportId(null);
    setActionMessage("Report deleted.");
  };

  return (
    <PlanGate requiredPlan="pro">
    <WorkspaceSurface
      eyebrow={
        // v2 puts the identity in the eyebrow and keeps the title a bare noun.
        language === "tr"
          ? business?.name ? `Büyüme · ${business.name}` : "Büyüme · Müşteriye hazır çıktı"
          : business?.name ? `Growth · ${business.name}` : "Growth · Client-ready output"
      }
      title={language === "tr" ? "Raporlar" : "Reports"}
      description={
        language === "tr"
          ? "Rapor formatlarını kaydedin, paylaşın veya CSV olarak dışa aktarın."
          : "Save report formats, share as a link, or export tables as CSV."
      }
      meta={
        <span className="font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
          {language === "tr"
            ? "her rapor PDF · paylaşım linki · tablo başına CSV olarak dışa aktarılır"
            : "every report exports as PDF · share link · CSV per table"}
        </span>
      }
      actions={
        <Button asChild size="sm" className="bg-[var(--adv-accent)] text-[var(--adc-s2)] hover:bg-[var(--adv-accent-hover)]">
          <Link href="/reports/new">{language === "tr" ? "+ Yeni rapor" : "+ New report"}</Link>
        </Button>
      }
    >

      <section className="grid gap-3 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.25fr)]">
        <ProductSection
          title={language === "tr" ? "Kayitli Raporlar" : "Saved Reports"}
          description={language === "tr" ? "Kayitli her rapor aktif ise aittir." : "Every saved report belongs to the active business."}
          actions={actionMessage ? <p className="text-[12px] text-[var(--adc-ink3)]">{actionMessage}</p> : null}
        >
          {reports.length > 5 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={language === "tr" ? "Raporlarda ara..." : "Search reports..."}
                className="h-8 min-w-[220px] rounded-[6px] border border-[var(--adc-b1)] bg-[var(--adc-s1)] px-2.5 text-[12.5px] text-[var(--adc-ink)] outline-none focus:border-[var(--adc-b2)]"
              />
              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as "recent" | "name")}
                className="h-8 rounded-[6px] border border-[var(--adc-b1)] bg-[var(--adc-s1)] px-2.5 text-[12.5px] text-[var(--adc-ink)] outline-none focus:border-[var(--adc-b2)]"
              >
                <option value="recent">{language === "tr" ? "Sirala: Son güncellenen" : "Sort: Recently updated"}</option>
                <option value="name">{language === "tr" ? "Sirala: Ad" : "Sort: Name"}</option>
              </select>
            </div>
          ) : null}

          {reportsQuery.isLoading ? (
            <div className="mt-4 rounded-[8px] border border-dashed border-[var(--adc-b2)] bg-[var(--adc-s1)] p-6 text-[12px] text-[var(--adc-ink3)]">
              {language === "tr" ? "Kayitli raporlar yükleniyor..." : "Loading saved reports..."}
            </div>
          ) : reportsQuery.error ? (
            <div className="mt-4 rounded-[8px] border border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)] p-4 text-[12px] text-[var(--adc-danger-fg)]">
              {reportsQuery.error instanceof Error ? reportsQuery.error.message : language === "tr" ? "Raporlar yüklenemedi." : "Failed to load reports."}
            </div>
          ) : reports.length === 0 ? (
            <div className="mt-4 rounded-[8px] border border-dashed border-[var(--adc-b2)] bg-[var(--adc-s1)] p-6 text-[12px] text-[var(--adc-ink3)]">
              {language === "tr" ? "Henüz kayıtlı rapor yok. Bir template ile başlayın veya boş bir rapor oluşturun." : "No saved reports yet. Start from a template or create a blank report."}
            </div>
          ) : filteredReports.length === 0 ? (
            <div className="mt-4 rounded-[8px] border border-dashed border-[var(--adc-b2)] bg-[var(--adc-s1)] p-6 text-[12px] text-[var(--adc-ink3)]">
              {language === "tr" ? "Bu aramaya uyan rapor bulunamadi." : "No reports match this search yet."}
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              {filteredReports.map((report) => (
                <div
                  key={report.id}
                  className="rounded-[8px] border border-[var(--adc-b1)] bg-[var(--adc-s2)] px-3 py-3 transition hover:border-[var(--adc-b2)] hover:bg-[var(--adc-s1)]"
                >
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px]">
                    <Link href={`/reports/${report.id}`} className="block">
                      <h3 className="text-[13px] font-semibold text-[var(--adc-ink)]">{report.name}</h3>
                      <p className="mt-1 text-[12px] text-[var(--adc-ink3)]">
                        {report.description || (language === "tr" ? "Henüz açıklama yok." : "No description yet.")}
                      </p>
                      <p className="mt-2 font-mono text-[10.5px] text-[var(--adc-ink3)]">
                        {language === "tr" ? "Güncellendi" : "Updated"} {new Date(report.updatedAt).toLocaleString()}
                      </p>
                    </Link>
                    <Link href={`/reports/${report.id}`} className="block">
                      <TemplateMiniPreview definition={report.definition} />
                    </Link>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <span className="rounded-[5px] border border-[var(--adc-b1)] bg-[var(--adc-s1)] px-2 py-1 font-mono text-[10.5px] font-medium text-[var(--adc-ink3)]">
                      {report.definition?.widgets?.length ?? 0} {language === "tr" ? "widget" : "widgets"}
                    </span>
                    <div className="flex flex-wrap gap-2">
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/reports/${report.id}`}>{language === "tr" ? "Düzenle" : "Edit"}</Link>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDuplicate(report)}
                        disabled={busyReportId === report.id}
                      >
                        {language === "tr" ? "Kopyala" : "Duplicate"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete(report.id)}
                        disabled={busyReportId === report.id}
                      >
                        {language === "tr" ? "Sil" : "Delete"}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ProductSection>

        <ProductSection
          title={language === "tr" ? "Template Galerisi" : "Template Gallery"}
          description={language === "tr" ? "Tek tıkla bir yapıyla başlayın, sonra her widget ve slot'u özelleştirin." : "Start with a one-click structure, then customize every widget and slot."}
        >
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {CUSTOM_REPORT_TEMPLATES.map((template) => (
              <Link
                key={template.id}
                href={`/reports/new?template=${template.id}`}
                className="rounded-[10px] border border-dashed border-[var(--adc-b1)] bg-[var(--adc-s2)] p-4 transition hover:border-[var(--adc-b2)] hover:bg-[var(--adc-s1)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="rounded-[4px] border border-[var(--adc-b1)] bg-[var(--adc-s1)] px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-normal text-[var(--adc-ink3)]">
                    {template.category}
                  </span>
                  <TemplateProviders template={template} />
                </div>
                <TemplateMiniPreview definition={template.definition} className="mt-6" />
                <h3 className="mt-4 text-[13px] font-semibold text-[var(--adc-ink)]">{template.name}</h3>
                <p className="mt-1 text-[11.5px] leading-5 text-[var(--adc-ink3)]">{template.description}</p>
                <p className="mt-3 text-[11px] text-[var(--adc-ink3)]">
                  {template.definition.widgets.length} widgets · share link · CSV · print
                </p>
              </Link>
            ))}
          </div>
        </ProductSection>
      </section>
    </WorkspaceSurface>
    </PlanGate>
  );
}
