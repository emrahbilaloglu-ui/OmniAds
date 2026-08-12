import { getSessionFromCookies } from "@/lib/auth";
import { AccountSecurityView } from "@/components/zero-base/account/account-security-view";

export const dynamic = "force-dynamic";

export default async function AccountSecurityPage() {
  const session = await getSessionFromCookies();
  if (!session) return null;
  return (
    <AccountSecurityView
      name={session.user.name}
      email={session.user.email}
      currentSessionId={session.sessionId}
    />
  );
}
