import ReportsPage from "@/app/(dashboard)/reports/legacy-page";

/**
 * Editing a report is the builder tab of the Reports screen with that report
 * loaded — the same surface the "Open in builder" row action reaches.
 */
export default async function EditReportPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  return <ReportsPage initialTab="builder" initialReportId={reportId} />;
}
