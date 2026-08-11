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
  RenderedWidgetCard,
  ReportShareDisabled,
  type ReportSummary,
} from "@/components/zero-base/reports/report-views";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import type { GridState } from "@/lib/zero-base/reports/builder-model";
import {
  adaptRenderedReport,
  baseDocument,
  buildCreateBody,
  buildDuplicateBody,
  buildPatchBody,
  exportWidgetCsvUrl,
  fromReportDocument,
  toReportDocument,
} from "@/lib/zero-base/reports/report-documents";
import type { CustomReportDocument, RenderedReportWidget } from "@/lib/custom-reports";
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
  /**
   * The stored document this edit started from.
   *
   * Kept whole so that saving preserves `metricKey`, `yMetrics`, `breakdown`,
   * `accountId`, `limit`, `columns`, `tableDimension`, `axisMode`, `text`,
   * `subtitle` and the document-level settings. Rebuilding from the grid alone
   * destroyed all of them on every save.
   */
  const [stored, setStored] = useState<CustomReportDocument | null>(null);
  // A new report is ready immediately; an edit is not ready until it loads.
  const [loaded, setLoaded] = useState(!reportId);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Edit loads the stored record and reads its definition back into the grid.
  useEffect(() => {
    if (!reportId) return;
    let cancelled = false;
    fetch(`/api/reports/${encodeURIComponent(reportId)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((json: { report?: { name?: string; definition?: unknown } } | null) => {
        if (cancelled) return;
        if (!json?.report) {
          // Never fall through to a blank canvas: an empty builder is
          // indistinguishable from a report whose widgets were all deleted.
          setLoadError("This report could not be read, so its layout is not shown.");
          return;
        }
        setName(json.report.name ?? "Untitled report");
        setStored(baseDocument(json.report.definition));
        setInitial({ widgets: fromReportDocument(json.report.definition) });
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoadError("This report could not be read, so its layout is not shown.");
      });
    return () => {
      cancelled = true;
    };
  }, [reportId]);

  const save = useCallback(
    async (state: GridState) => {
      setError(null);
      // A GridState is not a CustomReportDocument, and both routes require a
      // name. Sending the raw grid was a guaranteed 400.
      // `base` carries every stored field the grid does not model.
      const document = toReportDocument({ widgets: state.widgets, base: stored });
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
    [businessId, name, reportId, router, stored],
  );

  if (loadError) {
    return (
      <p role="status" data-report-error="" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
        {loadError}
      </p>
    );
  }

  if (!loaded) {
    return (
      <p role="status" data-builder-loading="" style={{ margin: 0, fontSize: 12.5 }}>
        Loading this report&rsquo;s layout&hellip;
      </p>
    );
  }

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
  const [report, setReport] = useState<{
    name: string;
    dateRangeLabel: string | null;
    generatedAt: string | null;
    startDate: string | null;
    endDate: string | null;
    widgets: RenderedReportWidget[];
  } | null>(null);
  const [exportState, setExportState] = useState<Record<string, { pending: boolean; error: string | null }>>({});
  /** widget id -> stored dataSource, for the per-source CSV guard. */
  const [sources, setSources] = useState<Record<string, string>>({});
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
        setReason(null);
        setReport(adapted.value);
      }
      setSurface({ kind: "ready" });
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, reportId, nonce]);

  // The rendered payload carries no dataSource — the renderer reads it off the
  // definition and does not echo it — so the CSV guard reads the definition.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/reports/${encodeURIComponent(reportId)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((json: { report?: { definition?: unknown } } | null) => {
        if (cancelled) return;
        const document = baseDocument(json?.report?.definition);
        if (!document) return;
        setSources(
          Object.fromEntries(
            document.widgets
              .filter((widget) => widget.dataSource)
              .map((widget) => [widget.id, String(widget.dataSource)]),
          ),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [reportId]);

  /**
   * Export one widget through the real endpoint, as a real download.
   *
   * Fetched rather than navigated so a refusal can be shown: the route answers
   * 400 `table_widget_required` with a message, and a bare location change
   * would drop it and leave the operator with no file and no explanation.
   */
  const exportCsv = useCallback(
    async (widgetId: string) => {
      setExportState((current) => ({ ...current, [widgetId]: { pending: true, error: null } }));
      const url = exportWidgetCsvUrl({
        reportId,
        widgetId,
        startDate: report?.startDate,
        endDate: report?.endDate,
      });
      const response = await fetch(url, { cache: "no-store" }).catch(() => null);
      if (!response?.ok) {
        const json = (await response?.json().catch(() => null)) as { message?: string } | null;
        setExportState((current) => ({
          ...current,
          [widgetId]: {
            pending: false,
            error: json?.message ?? "The export could not be produced, so no file was downloaded.",
          },
        }));
        return;
      }

      const blob = await response.blob().catch(() => null);
      if (!blob) {
        setExportState((current) => ({
          ...current,
          [widgetId]: { pending: false, error: "The export arrived but could not be read as a file." },
        }));
        return;
      }
      // The route names the file in Content-Disposition; honour it when present.
      const disposition = response.headers?.get?.("Content-Disposition") ?? "";
      const named = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = named ?? `${widgetId}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
      setExportState((current) => ({ ...current, [widgetId]: { pending: false, error: null } }));
    },
    [report?.endDate, report?.startDate, reportId],
  );

  return (
    <SurfaceStateBoundary state={surface}>
      <div data-reports-surface={print ? "print" : "viewer"} style={{ display: "grid", gap: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{report?.name ?? "Report"}</h1>
        {report?.dateRangeLabel ? (
          <p data-report-range="" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
            {report.dateRangeLabel}
            {report.generatedAt ? ` · generated ${report.generatedAt}` : ""}
          </p>
        ) : null}
        {reason ? (
          <p data-report-unavailable="" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
            {reason}
          </p>
        ) : null}
        {(report?.widgets ?? []).map((widget) => (
          <RenderedWidgetCard
            // The widget's own id. Keying on dataSource gave every card the
            // same key, because the rendered payload has no dataSource at all.
            key={widget.id}
            widget={widget}
            sourceId={sources[widget.id] ?? null}
            onRetry={() => setNonce((v) => v + 1)}
            onExportCsv={() => void exportCsv(widget.id)}
            exportState={exportState[widget.id]}
          />
        ))}
        {print ? null : <ReportShareDisabled />}
      </div>
    </SurfaceStateBoundary>
  );
}
