import ReportsPage from "@/app/(dashboard)/reports/legacy-page";

/**
 * `/reports/new` is the builder tab of the Reports screen, opened on a blank
 * document (or on a template when one is named). It is a separate URL only so
 * the "+ New report" action stays linkable; the surface is the same one.
 */
export default async function NewReportPage({
  searchParams,
}: {
  searchParams?: Promise<{ template?: string }>;
}) {
  const template = (await searchParams)?.template ?? null;
  return <ReportsPage initialTab="builder" initialTemplateId={template} />;
}
