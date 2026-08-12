import { redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Session-scoped application boundary.
 *
 * The active business is authorised on every request but is deliberately not
 * part of the public URL.  Business switching changes the authenticated
 * session, then returns to the same human-readable `/app/**` surface.
 *
 * The routed client page supplies the canonical ClientShell through its
 * existing `/c/[businessId]` route boundary. Mounting another ClientShell here
 * duplicates the entire navigation, scope bar and main landmark.
 */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionFromCookies();
  if (!session) redirect(`/login?next=${encodeURIComponent("/app/home")}`);
  if (!session.activeBusinessId) {
    redirect(`/select-business?next=${encodeURIComponent("/app/home")}`);
  }

  return children;
}
