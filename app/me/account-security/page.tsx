import { getSessionFromCookies } from "@/lib/auth";
import { AccountSecurityClient } from "@/components/zero-base/account/account-security-client";

export const dynamic = "force-dynamic";

export default async function AccountSecurityPage() {
  const session = await getSessionFromCookies();
  if (!session) return null;
  return (
    <AccountSecurityClient
      name={session.user.name}
      email={session.user.email}
      currentSessionId={session.sessionId}
      language={session.user.language}
    />
  );
}
