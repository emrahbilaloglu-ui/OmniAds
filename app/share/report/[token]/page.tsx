import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { getCustomReportShareSnapshot } from "@/lib/custom-report-store";
import { ReportCanvas } from "@/components/reports/report-canvas";
import { ClientPanelPrintButton } from "@/components/client/ClientPanelPrintButton";
import { getLanguageFromCookieValue, LANGUAGE_COOKIE_NAME } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Shared Report",
  robots: { index: false, follow: false },
};

export default async function ShareReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const language = getLanguageFromCookieValue((await cookies()).get(LANGUAGE_COOKIE_NAME)?.value);
  const { token } = await params;
  const payload = await getCustomReportShareSnapshot(token);

  if (!payload) {
    return (
      <div className="ad-client-panel">
        <main className="ad-client-empty-state">
          <div className="ad-client-card">
            <h1>{language === "tr" ? "Paylaşim linki bulunamadi veya süresi doldu" : "Share link not found or expired"}</h1>
            <p>
              {language === "tr" ? "Bu paylaşilan raporun süresi dolmuş olabilir veya URL geçersiz olabilir." : "This shared report may have expired or the URL is invalid."}
            </p>
            <Link href="/">
              {language === "tr" ? "Adsecute'e don" : "Back to Adsecute"}
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const generatedAt = new Date(payload.generatedAt).toLocaleString(language === "tr" ? "tr-TR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
  const expiresAt = new Date(payload.expiresAt).toLocaleString(language === "tr" ? "tr-TR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
  const businessLabel =
    payload.businessName?.trim() ||
    (payload.businessId ? `Business ${payload.businessId.slice(0, 6)}` : "—");
  const clientLabel = payload.clientEmail?.trim() || (language === "tr" ? "client view" : "client view");
  const currencyLine = payload.currency
    ? language === "tr"
      ? `Tutarlar hesap para birimindedir (${payload.currency}); eksik veri — olarak gösterilir, asla 0 değil.`
      : `Amounts use the account currency (${payload.currency}); missing data renders as —, never 0.`
    : language === "tr"
      ? "Para birimi snapshot içinde yoksa değerler kaynak formatıyla sınırlıdır; eksik veri — olarak gösterilir, asla 0 değil."
      : "If currency metadata is missing, values stay limited to the source format; missing data renders as —, never 0.";

  return (
    <div className="ad-client-panel">
      <div className="ad-client-topbar">
        <div className="ad-client-mark" aria-hidden="true" />
        <div className="ad-client-business">{businessLabel}</div>
        <span className="ad-client-pill">{language === "tr" ? "Müşteri görünümü · salt okunur" : "Client view · read-only"}</span>
        <div className="ad-client-spacer" />
        <ClientPanelPrintButton label={language === "tr" ? "PDF indir" : "Download PDF"} />
        <span className="ad-client-email">{clientLabel}</span>
      </div>

      <main className="ad-client-content">
        <header>
          <h1 className="ad-client-title">{payload.name}</h1>
          <p className="ad-client-subtitle">
            {payload.dateRangeLabel} · {language === "tr" ? "veriler" : "data as of"} {generatedAt} UTC
          </p>
        </header>

        {payload.description ? (
          <section className="ad-client-card ad-client-note">{payload.description}</section>
        ) : null}

        <section className="ad-client-kpi-grid" aria-label="Shared report metadata">
          <div className="ad-client-card ad-client-kpi">
            <p>{language === "tr" ? "Rapor dönemi" : "Report period"}</p>
            <strong>{payload.dateRangeLabel || "—"}</strong>
            <span>{language === "tr" ? "paylaşılan tarih aralığı" : "shared date range"}</span>
          </div>
          <div className="ad-client-card ad-client-kpi">
            <p>{language === "tr" ? "Oluşturulma" : "Generated"}</p>
            <strong>{generatedAt}</strong>
            <span>UTC</span>
          </div>
          <div className="ad-client-card ad-client-kpi">
            <p>{language === "tr" ? "Link süresi" : "Link expiry"}</p>
            <strong>{expiresAt}</strong>
            <span>UTC</span>
          </div>
        </section>

        <div className="ad-client-banner">
          {language === "tr"
            ? "Şeffaflık notu: bu salt-okunur paylaşım rapor canvas'ını gösterir. Eksik metrikler — olarak kalmalı; sonuç yorumları korelasyon temellidir."
            : "Transparency note: this read-only share shows the report canvas. Missing metrics must remain —; outcome statements are correlational."}
        </div>

        <section>
          <h2 className="ad-client-section-title">{language === "tr" ? "Paylaşılan rapor" : "Shared report"}</h2>
          <div className="ad-client-card ad-client-report-canvas">
            <ReportCanvas report={payload} />
          </div>
        </section>

        <footer className="ad-client-footer">
          {language === "tr"
            ? `Bu panel yalnızca paylaşılan business kapsamındaki verileri gösterir. ${currencyLine} Sonuç ifadeleri korelasyon temellidir.`
            : `This panel shows only the shared business scope. ${currencyLine} Outcome statements are correlational.`}
        </footer>
      </main>
    </div>
  );
}
