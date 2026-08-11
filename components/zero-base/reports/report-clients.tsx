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
import {
  adaptRenderedReport,
  buildCreateBody,
  buildDuplicateBody,
  buildPatchBody,
  fromReportDocument,
  toReportDocument,
} from "@/lib/zero-base/reports/report-documents";
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

  const [error, setError] = useState<string | null>(null);

  /**
   * Duplicate reads the source record and creates from it.
   *
   * `POST /api/reports` requires businessId AND name, and has no `duplicateOf`
   * field — the previous body was a guaranteed 400.
   */
  const duplicate = useCallback(
    async (id: string) => {
      setError(null);
      const source = await fetch(`/api/reports/${encodeURIComponent(id)}`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
      const record = (source as { report?: { name?: string; description?: string | null; definition?: unknown } } | null)?.report ?? null;

      const body = buildDuplicateBody({ businessId, source: record });
      if ("error" in body) {
        setError(body.error);
        return;
      }
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!response?.ok) {
        const json = (await response?.json().catch(() => null)) as { message?: string } | null;
        setError(json?.message ?? "The report could not be duplicated.");
        return;
      }
      refresh();
    },
    [businessId, refresh],
  );

  return (
    <SurfaceStateBoundary state={surface}>
      <ReportLibraryView
        reports={reports}
        unavailableReason={reason ?? error}
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
  const [initial, setInitial] = useState<GridState>({ widgets: [] });
  const [name, setName] = useState("Untitled report");
  const [error, setError] = useState<string | null>(null);

  // Edit loads the stored record and reads its definition back into the grid.
  useEffect(() => {
    if (!reportId) return;
    let cancelled = false;
    fetch(`/api/reports/${encodeURIComponent(reportId)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((json: { report?: { name?: string; definition?: unknown } } | null) => {
        if (cancelled || !json?.report) return;
        setName(json.report.name ?? "Untitled report");
        setInitial({ widgets: fromReportDocument(json.report.definition) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [reportId]);

  const save = useCallback(
    async (state: GridState) => {
      setError(null);
      // A GridState is not a CustomReportDocument, and both routes require a
      // name. Sending the raw grid was a guaranteed 400.
      const document = toReportDocument({ widgets: state.widgets });
      const response = await fetch(
        reportId ? `/api/reports/${encodeURIComponent(reportId)}` : "/api/reports",
        {
          method: reportId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            reportId
              ? buildPatchBody({ name, document })
              : buildCreateBody({ businessId, name, document }),
          ),
        },
      ).catch(() => null);
      if (!response?.ok) {
        const json = (await response?.json().catch(() => null)) as { message?: string } | null;
        setError(json?.message ?? "The report could not be saved.");
        return;
      }
      router.push(`/c/${encodeURIComponent(businessId)}/reports`);
    },
    [businessId, name, reportId, router],
  );

  return (
    <>
      {error ? (
        <p role="status" data-report-error="" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
          {error}
        </p>
      ) : null}
      <ReportBuilderView
        initial={initial}
        name={name}
        onNameChange={setName}
        onSave={(state) => void save(state)}
      />
    </>
  );
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

  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The RENDER route returns the rendered widgets. `/api/reports/[id]`
      // returns a record, and reading widgets off it showed an empty report
      // for every healthy render.
      const response = await fetch(
        `/api/reports/${encodeURIComponent(reportId)}/render?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" },
      ).catch(() => null);
      if (cancelled) return;
      if (!response?.ok) {
        setReason(`The report could not be rendered (HTTP ${response?.status ?? "no response"}).`);
        setSurface({ kind: "ready" });
        return;
      }
      const adapted = adaptRenderedReport(await response.json().catch(() => null));
      if (cancelled) return;
      if (!adapted.ok) {
        setReason(adapted.reason);
      } else {
        setWidgets(
          adapted.value.widgets.map((widget) => ({
            sourceId: widget.dataSource,
            rows: widget.rows,
            failed: Boolean(widget.errorMessage),
          })),
        );
      }
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
        {reason ? (
          <p data-report-unavailable="" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
            {reason}
          </p>
        ) : null}
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
