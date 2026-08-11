import { redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { readAgencyDirectorySource } from "@/lib/zero-base/agency-directory-server";
import { AgencyDeskView } from "@/components/zero-base/agency/agency-desk-view";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";

export const dynamic = "force-dynamic";

/**
 * Agency Desk — Today.
 *
 * The layout has already proven Agency context; this only reads. It shows the
 * same alphabetical directory as /a/desk/clients rather than a ranked "today"
 * list, because a ranking would need the cross-client money the Withheld
 * explainer sets out as unavailable.
 */
export default async function AgencyDeskPage() {
  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor("/a/desk"));

  const businesses = await readAgencyDirectorySource({
    userId: session.user.id,
    email: session.user.email,
  });

  return <AgencyDeskView businesses={businesses} />;
}
