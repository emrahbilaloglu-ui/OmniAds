import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { PublicCreativeSharePage } from "@/components/creatives/PublicCreativeSharePage";
import { MOCK_SHARE_PAYLOAD } from "@/components/creatives/shareCreativeMock";
import { getCreativeShareSnapshot } from "@/lib/creative-share-store";
import { getLanguageFromCookieValue, LANGUAGE_COOKIE_NAME } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Shared Creatives",
  robots: { index: false, follow: false },
};

/**
 * Public share page — no auth required.
 */
export default async function ShareCreativePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const language = getLanguageFromCookieValue((await cookies()).get(LANGUAGE_COOKIE_NAME)?.value);
  const { token } = await params;
  const payload = token === MOCK_SHARE_PAYLOAD.token
    ? MOCK_SHARE_PAYLOAD
    : await getCreativeShareSnapshot(token, { recordOpen: true });
  if (!payload) {
    return (
      <div className="ad-client-panel">
        <main className="ad-client-empty-state">
          <div className="ad-client-card">
            <h1>{language === "tr" ? "Paylaşim linki bulunamadi veya süresi doldu" : "Share link not found or expired"}</h1>
            <p>
              {language === "tr" ? "Bu paylaşılan creative çıktıları süresi dolmuş olabilir veya URL geçersiz olabilir." : "This shared creatives export may have expired or the URL is invalid."}
            </p>
            <Link href="/">
              {language === "tr" ? "Adsecute'e don" : "Back to Adsecute"}
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return <PublicCreativeSharePage payload={payload} language={language} />;
}
