"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ReportCanvas } from "@/components/reports/report-canvas";
import type { RenderedReportPayload } from "@/lib/custom-reports";

async function fetchRenderedReport(reportId: string) {
  const response = await fetch(`/api/reports/${reportId}/render`, { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { message?: string } | null)?.message ?? "Failed to load printable report.");
  }
  return (payload as { report: RenderedReportPayload }).report;
}

export function ReportPrintPage({ reportId }: { reportId: string }) {
  const reportQuery = useQuery({
    queryKey: ["custom-report-print", reportId],
    queryFn: () => fetchRenderedReport(reportId),
    enabled: Boolean(reportId),
  });

  useEffect(() => {
    if (!reportQuery.data) return;
    const timeoutId = window.setTimeout(() => window.print(), 250);
    return () => window.clearTimeout(timeoutId);
  }, [reportQuery.data]);

  return (
    <div className="min-h-screen bg-white p-8 print:p-0">
      {reportQuery.isLoading ? (
        <div className="rounded-xl border p-10 text-sm text-neutral-500">Preparing printable report...</div>
      ) : reportQuery.error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-sm text-red-700">
          {reportQuery.error instanceof Error ? reportQuery.error.message : "Printable report failed."}
        </div>
      ) : reportQuery.data ? (
        <div className="mx-auto max-w-7xl space-y-6">
          <div className="flex items-center justify-end print:hidden">
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-xl border px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Print Again
            </button>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-white px-6 py-6 print:border-0 print:shadow-none">
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">Printable Report</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-neutral-950">
              {reportQuery.data.name}
            </h1>
            {reportQuery.data.description ? (
              <p className="mt-3 max-w-3xl text-sm leading-6 text-neutral-600">
                {reportQuery.data.description}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-4 text-sm text-neutral-500">
              <span>{reportQuery.data.dateRangeLabel}</span>
              <span>Generated {new Date(reportQuery.data.generatedAt).toLocaleString()}</span>
            </div>
          </div>
          <ReportCanvas report={reportQuery.data} />
        </div>
      ) : null}
    </div>
  );
}
