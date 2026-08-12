import { ReleaseAuthorityPanel } from "@/components/admin/release-authority-panel";
import { getReleaseAuthorityReport } from "@/lib/release-authority/report";

export const dynamic = "force-dynamic";

export default async function AdminReleaseAuthorityPage() {
  const report = await getReleaseAuthorityReport();
  return <ReleaseAuthorityPanel report={report} />;
}
