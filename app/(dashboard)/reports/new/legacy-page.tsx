import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { ReportBuilderPage } from "@/components/reports/report-builder-page";

export default async function NewReportPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string }>;
}) {
  const { template } = await searchParams;
  return <ReportBuilderPage mode="new" templateId={template ?? null} />;
}
