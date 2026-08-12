import { ReleaseAuthorityPanel } from "@/components/admin/release-authority-panel";
import { getReleaseAuthorityReport } from "@/lib/release-authority/report";

export const dynamic = "force-dynamic";

/**
 * Canonical Ops mirror of /admin/release-authority.
 *
 * The legacy page is a server component, so its own read model and panel are
 * reused directly rather than its route file being re-exported. The report and
 * the rendered authority semantics are unchanged.
 */
export default async function Page() {
  const report = await getReleaseAuthorityReport();
  return <ReleaseAuthorityPanel report={report} />;
}
