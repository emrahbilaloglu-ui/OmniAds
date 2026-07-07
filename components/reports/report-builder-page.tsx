"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FileDown, Copy, Link2 } from "lucide-react";
import { DateRangePicker, DEFAULT_DATE_RANGE, getPresetDates } from "@/components/date-range/DateRangePicker";
import type { DateRangeValue } from "@/components/date-range/DateRangePicker";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { useAppStore } from "@/store/app-store";
import type { CustomReportRecord, RenderedReportPayload } from "@/lib/custom-reports";
import { ReportCanvas } from "@/components/reports/report-canvas";
import { usePreferencesStore } from "@/store/preferences-store";

const ReportBuilder = dynamic(
  () => import("@/components/reports/report-builder").then((module) => module.ReportBuilder),
  {
    ssr: false,
    loading: () => (
      <div className="rounded-xl border bg-white p-8 text-sm text-muted-foreground">
        Loading builder...
      </div>
    ),
  }
);

async function fetchReport(reportId: string) {
  const response = await fetch(`/api/reports/${reportId}`, { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { message?: string } | null)?.message ?? "Failed to load report.");
  }
  return (payload as { report: CustomReportRecord }).report;
}

async function fetchRenderedReport(reportId: string, startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const url = `/api/reports/${reportId}/render${params.toString() ? `?${params}` : ""}`;
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { message?: string } | null)?.message ?? "Failed to render report.");
  }
  return (payload as { report: RenderedReportPayload }).report;
}

export function ReportBuilderPage({
  mode,
  reportId,
  templateId,
}: {
  mode: "new" | "edit" | "view";
  reportId?: string;
  templateId?: string | null;
}) {
  const language = usePreferencesStore((state) => state.language);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businessId = selectedBusinessId ?? "";

  const [viewDateRange, setViewDateRange] = useState<DateRangeValue>({ ...DEFAULT_DATE_RANGE, rangePreset: "30d" });
  const [exportOpen, setExportOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [csvLoading, setCsvLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [exportOpen]);

  const reportQuery = useQuery({
    queryKey: ["custom-report", reportId],
    enabled: (mode === "edit") && Boolean(reportId),
    queryFn: () => fetchReport(reportId as string),
  });

  const { start: viewStart, end: viewEnd } = getPresetDates(viewDateRange.rangePreset, viewDateRange.customStart, viewDateRange.customEnd);

  const renderedQuery = useQuery({
    queryKey: ["custom-report-view", reportId, viewStart, viewEnd],
    enabled: mode === "view" && Boolean(reportId),
    queryFn: () => fetchRenderedReport(reportId as string, viewStart, viewEnd),
  });

  if (!selectedBusinessId) return <BusinessEmptyState />;

  // ── View mode ──────────────────────────────────────────────────────────────
  if (mode === "view") {
    if (renderedQuery.isLoading) {
      return (
        <div className="rounded-xl border bg-white p-8 text-sm text-muted-foreground animate-pulse">
          {language === "tr" ? "Rapor yükleniyor..." : "Loading report..."}
        </div>
      );
    }
    if (renderedQuery.error || !renderedQuery.data) {
      return (
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-sm text-red-700">
          {renderedQuery.error instanceof Error ? renderedQuery.error.message : language === "tr" ? "Rapor yüklenemedi." : "Failed to load report."}
        </div>
      );
    }
    const report = renderedQuery.data;

    const handleCsvExport = async () => {
      setCsvLoading(true);
      try {
        const params = new URLSearchParams({ startDate: viewStart, endDate: viewEnd });
        const url = `/api/reports/${reportId}/export?${params}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error("Export failed");
        const blob = await response.blob();
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = `${report.name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase()}.csv`;
        a.click();
        URL.revokeObjectURL(objUrl);
      } catch {
        // silent
      } finally {
        setCsvLoading(false);
      }
    };

    const handleShareLink = async () => {
      setShareLoading(true);
      try {
        const response = await fetch(`/api/reports/${reportId}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expiryDays: 7 }),
        });
        const payload = await response.json().catch(() => null);
        if (response.ok) setShareUrl((payload as { url?: string })?.url ?? null);
      } finally {
        setShareLoading(false);
      }
    };

    const copyShareUrl = async () => {
      if (!shareUrl) return;
      await navigator.clipboard.writeText(`${window.location.origin}${shareUrl}`).catch(() => null);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };

    return (
      <div className="min-h-screen bg-[#f6f7fb]">
        {/* Header */}
        <div className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur px-6 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Link
                href="/reports"
                className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50 transition"
              >
                {language === "tr" ? "← Geri" : "← Back"}
              </Link>
              <h1 className="text-base font-semibold text-neutral-900">{report.name}</h1>
            </div>
            <div className="flex items-center gap-2">
              {/* Date range selector */}
              <DateRangePicker
                value={viewDateRange}
                onChange={setViewDateRange}
                showComparisonTrigger={false}
              />

              {/* Export dropdown */}
              <div ref={exportRef} className="relative">
                <button
                  type="button"
                  onClick={() => setExportOpen((o) => !o)}
                  className="inline-flex items-center gap-1.5 rounded-full border bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 transition"
                >
                  {language === "tr" ? "Disa Aktar" : "Export"}
                  <ChevronDown className="h-3.5 w-3.5 text-neutral-400" />
                </button>
                {exportOpen && (
                  <div className="absolute right-0 top-10 z-50 w-[280px] rounded-xl border bg-white p-3 shadow-lg">
                    <button
                      type="button"
                      onClick={handleShareLink}
                      disabled={shareLoading}
                      className="flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-xs hover:bg-neutral-50 disabled:opacity-60 transition"
                    >
                      <Link2 className="h-3.5 w-3.5 shrink-0" />
                      {shareLoading ? (language === "tr" ? "Link oluşturuluyor..." : "Generating link...") : language === "tr" ? "Link paylaş" : "Share link"}
                    </button>
                    <button
                      type="button"
                      onClick={handleCsvExport}
                      disabled={csvLoading}
                      className="mt-2 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-xs hover:bg-neutral-50 disabled:opacity-60 transition"
                    >
                      <FileDown className="h-3.5 w-3.5 shrink-0" />
                      {csvLoading ? (language === "tr" ? "Disa aktariliyor..." : "Exporting...") : "Export CSV"}
                    </button>
                    {shareUrl && (
                      <div className="mt-2 rounded-lg border bg-neutral-50 p-2">
                        <p className="mb-1 text-[11px] text-neutral-500">{language === "tr" ? "Paylaşım linki hazır" : "Share link ready"}</p>
                        <div className="flex items-center gap-1.5">
                          <input
                            readOnly
                            value={`${typeof window !== "undefined" ? window.location.origin : ""}${shareUrl}`}
                            className="h-7 flex-1 rounded border bg-white px-2 text-[11px] text-neutral-600 min-w-0"
                          />
                          <button
                            type="button"
                            onClick={copyShareUrl}
                            className="inline-flex h-7 shrink-0 items-center gap-1 rounded border px-2 text-[11px] hover:bg-neutral-100 transition"
                          >
                            <Copy className="h-3 w-3" />
                            {copied ? (language === "tr" ? "Kopyalandi!" : "Copied!") : language === "tr" ? "Kopyala" : "Copy"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <Link
                href={`/reports/${reportId}/edit`}
                className="rounded-full bg-neutral-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 transition"
              >
                {language === "tr" ? "Düzenle" : "Edit"}
              </Link>
            </div>
          </div>
        </div>
        {/* Canvas */}
        <div className="mx-auto max-w-[1400px] px-6 py-8">
          {renderedQuery.isFetching ? (
            <div className="flex items-center justify-center py-16 text-sm text-neutral-400">{language === "tr" ? "Yükleniyor..." : "Loading..."}</div>
          ) : (
            <ReportCanvas report={report} />
          )}
        </div>
      </div>
    );
  }

  // ── Edit mode ──────────────────────────────────────────────────────────────
  if (mode === "edit" && reportQuery.isLoading) {
    return (
      <div className="rounded-xl border bg-white p-8 text-sm text-muted-foreground">
        {language === "tr" ? "Rapor yükleniyor..." : "Loading report..."}
      </div>
    );
  }

  if (mode === "edit" && reportQuery.error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-sm text-red-700">
        {reportQuery.error instanceof Error ? reportQuery.error.message : language === "tr" ? "Rapor yüklenemedi." : "Failed to load report."}
      </div>
    );
  }

  return (
    <ReportBuilder
      businessId={businessId}
      initialRecord={reportQuery.data ?? null}
      initialTemplateId={templateId ?? null}
    />
  );
}
