import { ReportPrintPage } from "@/components/reports/report-print-page";

export default async function ReportPrintRoute({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  return <ReportPrintPage reportId={reportId} />;
}
