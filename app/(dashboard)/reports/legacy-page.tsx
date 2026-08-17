"use client";

import { ReportsExactContainer } from "@/components/reports/reports-exact-container";

/**
 * Reports.
 *
 * The v2 screen is one surface with three tabs — my reports, templates and the
 * builder — so opening a report to edit it is a tab change, not a different
 * page. Every route that reaches Reports mounts this same component; the
 * builder entry points hand it an initial tab and a report or template id.
 */
export default function ReportsPage({
  initialTab = "mine",
  initialReportId = null,
  initialTemplateId = null,
}: {
  initialTab?: "mine" | "templates" | "builder";
  initialReportId?: string | null;
  initialTemplateId?: string | null;
} = {}) {
  return (
    <ReportsExactContainer
      initialTab={initialTab}
      initialReportId={initialReportId}
      initialTemplateId={initialTemplateId}
    />
  );
}
