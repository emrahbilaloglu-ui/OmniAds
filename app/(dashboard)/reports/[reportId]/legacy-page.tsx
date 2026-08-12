import { ReportBuilderPage } from "@/components/reports/report-builder-page";

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  return <ReportBuilderPage mode="view" reportId={reportId} />;
}
