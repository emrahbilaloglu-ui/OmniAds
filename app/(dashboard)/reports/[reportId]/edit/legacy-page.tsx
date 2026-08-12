import { ReportBuilderPage } from "@/components/reports/report-builder-page";

export default async function ReportEditPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  return <ReportBuilderPage mode="edit" reportId={reportId} />;
}
