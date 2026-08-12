import { OpsIncidentSurface } from "@/components/zero-base/ops/ops-incident-surface";
import AdminIntegrations from "@/app/admin/integrations/legacy-page";

export const dynamic = "force-dynamic";

/**
 * Canonical Ops mirror of /admin/integrations.
 *
 * The admin component is mounted as-is, so confirmation, progress, error and
 * read-back semantics are literally the same code. Only the surrounding shell
 * differs; adapting composition without duplicating operational logic is the
 * point of this work package.
 */
export default function Page() {
  return (
    <>
      <AdminIntegrations />
      {/* Flow J, mounted in production rather than only in a test. */}
      <OpsIncidentSurface />
    </>
  );
}
