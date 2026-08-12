import { getSessionFromCookies } from "@/lib/auth";
import { LanguageView } from "@/components/zero-base/account/language-view";

export const dynamic = "force-dynamic";

export default async function LanguagePage() {
  const session = await getSessionFromCookies();
  if (!session) return null;
  return <LanguageView current={session.user.language} />;
}
