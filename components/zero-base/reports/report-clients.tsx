"use client";

/**
 * Data boundaries for the report routes.
 *
 * They read and write reports through the existing `/api/reports` endpoints.
 * None of them references the share mint endpoint: the canonical product does
 * not offer sharing, and WP-03A's server branch is the authority on that.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  ReportBuilderView,
  ReportLibraryView,
  ReportShareDisabled,
  ReportWidget,
  type ReportSummary,
} from "@/components/zero-base/reports/report-views";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import type { GridState } from "@/lib/zero-base/reports/builder-model";
import type { SurfaceState } from "@/lib/zero-base/state-types";

function useReports(businessId: string) {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading reports" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/reports?businessId=${encodeURIComponent(businessId)}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          if (!cancelled) {
            setReason(`Reports could not be read (HTTP ${response.status}).`);
            setSurface({ kind: "ready" });
          }
          return;
        }
        const json = (await response.json()) as { reports?: Array<Record<string, unknown>> };
        if (cancelled) return;
        // A 200 without the expected collection is degraded, not empty.
        if (!Array.isArray(json.reports)) {
          setReason("The reports response did not carry a reports array.");
          setSurface({ kind: "ready" });
          return;
        }
        setReports(
          json.reports.map((report, index) => ({
            id: String(report.id ?? index),
            name: String(report.name ?? "(untitled)"),
            updatedAt: String(report.updatedAt ?? report.updated_at ?? "Not reported"),
          })),
        );
        setSurface({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        setReason(error instanceof Error ? error.message : "Reports could not be reached.");
        setSurface({ kind: "ready" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, nonce]);

  return { reports, reason, surface, refresh: () => setNonce((v) => v + 1) };
}

export function ReportLibraryClient({ businessId }: { businessId: string }) {
  const router = useRouter();
  const { reports, reason, surface, refresh } = useReports(businessId);

  const duplicate = useCallback(
    async (id: string) => {
      await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, duplicateOf: id }),
      }).catch(() => null);
      refresh();
    },
    [businessId, refresh],
  );

  return (
    <SurfaceStateBoundary state={surface}>
      <ReportLibraryView
        reports={reports}
        unavailableReason={reason}
        onCreate={() => router.push(`/c/${encodeURIComponent(businessId)}/reports/new`)}
        onDuplicate={(id) => void duplicate(id)}
      />
    </SurfaceStateBoundary>
  );
}

export function ReportBuilderClient({
  businessId,
  reportId,
}: {
  businessId: string;
  reportId?: string;
}) {
  const router = useRouter();
  const save = useCallback(
    async (state: GridState) => {
      const response = await fetch(reportId ? `/api/reports/${encodeURIComponent(reportId)}` : "/api/reports", {
        method: reportId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, layout: state.widgets }),
      }).catch(() => null);
      if (response?.ok) router.push(`/c/${encodeURIComponent(businessId)}/reports`);
    },
    [businessId, reportId, router],
  );

  return <ReportBuilderView initial={{ widgets: [] }} onSave={(state) => void save(state)} />;
}

export function ReportViewerClient({
  businessId,
  reportId,
  print,
}: {
  businessId: string;
  reportId: string;
  print?: boolean;
}) {
  const [widgets, setWidgets] = useState<Array<{ sourceId: string; rows: Record<string, string>[]; failed: boolean }>>([]);
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading report" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch(
        `/api/reports/${encodeURIComponent(reportId)}?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" },
      ).catch(() => null);
      if (cancelled) return;
      const json = response?.ok ? ((await response.json()) as { widgets?: unknown[] }) : null;
      setWidgets(
        Array.isArray(json?.widgets)
          ? (json!.widgets as Array<Record<string, unknown>>).map((w) => ({
              sourceId: String(w.sourceId ?? ""),
              rows: Array.isArray(w.rows) ? (w.rows as Record<string, string>[]) : [],
              failed: w.failed === true,
            }))
          : [],
      );
      setSurface({ kind: "ready" });
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, reportId, nonce]);

  return (
    <SurfaceStateBoundary state={surface}>
      <div data-reports-surface={print ? "print" : "viewer"} style={{ display: "grid", gap: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Report</h1>
        {widgets.map((widget) => (
          <ReportWidget
            key={widget.sourceId}
            sourceId={widget.sourceId}
            loaded
            failed={widget.failed}
            rows={widget.rows}
            onRetry={() => setNonce((v) => v + 1)}
          />
        ))}
        {print ? null : <ReportShareDisabled />}
      </div>
    </SurfaceStateBoundary>
  );
}
