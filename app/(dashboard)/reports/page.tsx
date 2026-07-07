"use client";

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

async function fetchReports(businessId: string) {
  const response = await fetch(`/api/reports?businessId=${encodeURIComponent(businessId)}`, {
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { message?: string } | null)?.message ?? "Failed to load reports.");
  }
  return (payload as { reports: CustomReportRecord[] }).reports;
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
  const reports = reportsQuery.data ?? [];
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
    <div className="space-y-6">
      <section className="rounded-xl border border-neutral-200 bg-white p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-500">
              {language === "tr" ? "Ozel Raporlama" : "Custom Reporting"}
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
              {language === "tr"
                ? `${business?.name ?? "bu iş"} için tek tıkla raporlar oluşturun`
                : `Build one-click reports for ${business?.name ?? "this business"}`}
            </h1>
            <p className="text-sm leading-6 text-neutral-500">
              {language === "tr"
                ? "Her iş altında tekrar kullanılabilir rapor formatları kaydedin, bir template ile başlayın, sonra çıktıyı public link olarak paylaşın veya tablo widget'larını CSV olarak dışa aktarın."
                : "Save reusable report formats under each business, start from a template, then share the final output as a public link or export table widgets as CSV."}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/reports/new">{language === "tr" ? "Boş Rapor Oluştur" : "Create Blank Report"}</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)]">
        <div className="rounded-xl border border-neutral-200 bg-white p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">{language === "tr" ? "Kayitli Raporlar" : "Saved Reports"}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {language === "tr" ? "Kayitli her rapor aktif ise aittir." : "Every saved report belongs to the active business."}
              </p>
            </div>
            {actionMessage ? <p className="text-sm text-neutral-500">{actionMessage}</p> : null}
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={language === "tr" ? "Raporlarda ara..." : "Search reports..."}
              className="min-w-[220px] rounded-xl border px-3 py-2 text-sm"
            />
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as "recent" | "name")}
              className="rounded-xl border px-3 py-2 text-sm"
            >
              <option value="recent">{language === "tr" ? "Sirala: Son güncellenen" : "Sort: Recently updated"}</option>
              <option value="name">{language === "tr" ? "Sirala: Ad" : "Sort: Name"}</option>
            </select>
          </div>

          {reportsQuery.isLoading ? (
            <div className="mt-6 rounded-2xl border border-dashed p-10 text-sm text-muted-foreground">
              {language === "tr" ? "Kayitli raporlar yükleniyor..." : "Loading saved reports..."}
            </div>
          ) : reportsQuery.error ? (
            <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
              {reportsQuery.error instanceof Error ? reportsQuery.error.message : language === "tr" ? "Raporlar yüklenemedi." : "Failed to load reports."}
            </div>
          ) : reports.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-dashed p-10 text-sm text-muted-foreground">
              {language === "tr" ? "Henüz kayıtlı rapor yok. Bir template ile başlayın veya boş bir rapor oluşturun." : "No saved reports yet. Start from a template or create a blank report."}
            </div>
          ) : filteredReports.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-dashed p-10 text-sm text-muted-foreground">
              {language === "tr" ? "Bu aramaya uyan rapor bulunamadi." : "No reports match this search yet."}
            </div>
          ) : (
            <div className="mt-6 space-y-3">
              {filteredReports.map((report) => (
                <div
                  key={report.id}
                  className="rounded-xl border border-neutral-200 px-4 py-4 transition hover:border-neutral-300 hover:bg-neutral-50"
                >
                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
                    <Link href={`/reports/${report.id}`} className="block">
                      <h3 className="text-base font-semibold text-neutral-950">{report.name}</h3>
                      <p className="mt-1 text-sm text-neutral-500">
                        {report.description || (language === "tr" ? "Henüz açıklama yok." : "No description yet.")}
                      </p>
                      <p className="mt-3 text-xs text-neutral-400">
                        {language === "tr" ? "Güncellendi" : "Updated"} {new Date(report.updatedAt).toLocaleString()}
                      </p>
                    </Link>
                    <Link href={`/reports/${report.id}`} className="block">
                      <TemplateMiniPreview definition={report.definition} />
                    </Link>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
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
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white p-6">
          <div>
            <h2 className="text-xl font-semibold">{language === "tr" ? "Template Galerisi" : "Template Gallery"}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {language === "tr" ? "Tek tıkla bir yapıyla başlayın, sonra her widget ve slot'u özelleştirin." : "Start with a one-click structure, then customize every widget and slot."}
            </p>
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {CUSTOM_REPORT_TEMPLATES.map((template) => (
              <Link
                key={template.id}
                href={`/reports/new?template=${template.id}`}
                className="rounded-xl border border-neutral-200 bg-white p-5 transition hover:border-neutral-300 hover:bg-neutral-50"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-500">
                    {template.category}
                  </span>
                  <TemplateProviders template={template} />
                </div>
                <TemplateMiniPreview definition={template.definition} className="mt-8" />
                <h3 className="mt-5 text-lg font-semibold text-neutral-900">{template.name}</h3>
                <p className="mt-2 text-sm leading-6 text-neutral-500">{template.description}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
    </PlanGate>
  );
}
