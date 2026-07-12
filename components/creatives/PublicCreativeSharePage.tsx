"use client";

import { useMemo } from "react";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import type {
  SharePayload,
  SharePayloadCreative,
  SharedClientAction,
} from "./shareCreativeTypes";

type ClientPanelLanguage = "tr" | "en";

type PublicShareCreative = SharePayloadCreative & {
  mediaPreviewUrl?: string | null;
  cardPreviewUrl?: string | null;
  tableThumbnailUrl?: string | null;
  cachedThumbnailUrl?: string | null;
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
  previewUrl?: string | null;
};

const COPY = {
  tr: {
    badge: "Müşteri görünümü · salt okunur",
    creatorBadge: "Kreatif görünümü · salt okunur",
    pdf: "PDF indir",
    fallbackBusiness: "Adsecute",
    title: "Reklam sonuçlarınız",
    asOf: "veriler",
    asOfSuffix: "itibarıyla",
    spend: "Harcama (dönem)",
    spendSubKnown: "hesap para birimi",
    spendSubUnknown: "para birimi snapshot içinde yok",
    returnLabel: "Getiri",
    returnSub: "raporlanan satış / harcama",
    sales: "Reklam kaynaklı satış",
    salesSub: "Meta'nın raporladığı satış değeri",
    feedTitle: "Ne yaptık ve neden",
    noActions:
      "Bu dönemde değişiklik gerekmedi — kampanyalar hedefin üzerinde seyretti. Hiçbir işlem yapılmadığında bunu açıkça söyleriz.",
    missingActions:
      "Bu paylaşımda müşteri paneline uygun işlem geçmişi yok. Eksik aksiyon verisini uydurmuyoruz; yalnızca güvenle gösterilebilen kreatif özetlerini paylaşıyoruz.",
    outcomePending: "sonuç penceresi ayrıca doğrulanmalı",
    highlights: "Öne çıkan kreatifler",
    creatorHighlights: "Paylaşılan kreatifler",
    highlightNote:
      "Yalnızca paylaşılan snapshot içinde yeterli harcama veya satış değeri bulunan kreatifler listelenir.",
    creatorHighlightNote:
      "Bu görünüm yalnızca kreatif sinyallerini içerir; mutlak finansal ve hacim metrikleri paylaşılmaz.",
    degradedNote:
      "Şeffaflık notu: ölçüm sinyali bu dönemde eksik veya gecikmeli olabilir. Eksik veri 0 gibi gösterilmez ve kalıcı sonuç yorumu yapılmaz.",
    multiCurrency:
      "Bu snapshot birden fazla para birimi içeriyor. Harcama ve satış toplamları güvenli olmadığı için — olarak gösterildi.",
    footKnown:
      "Bu panel yalnızca paylaşılan business kapsamındaki verileri gösterir. Tutarlar hesap para birimindedir; eksik veri — olarak gösterilir, asla 0 değil. Sonuç ifadeleri korelasyon temellidir.",
    footUnknown:
      "Bu panel yalnızca paylaşılan business kapsamındaki verileri gösterir. Snapshot para birimi taşımıyorsa değerler kaynak formatıyla sınırlıdır; eksik veri — olarak gösterilir, asla 0 değil. Sonuç ifadeleri korelasyon temellidir.",
    readOnly: "client view",
    creatorReadOnly: "creative view",
    ctrAll: "CTR",
    linkCtr: "Link CTR",
    thumbstop: "Thumbstop",
    video100: "Video tamamlama",
    creatorFoot: "Bu görünüm yalnızca paylaşılmış kreatif sinyallerini gösterir.",
  },
  en: {
    badge: "Client view · read-only",
    creatorBadge: "Creative view · read-only",
    pdf: "Download PDF",
    fallbackBusiness: "Adsecute",
    title: "Your advertising results",
    asOf: "data as of",
    asOfSuffix: "",
    spend: "Spend (period)",
    spendSubKnown: "account currency",
    spendSubUnknown: "currency missing from snapshot",
    returnLabel: "Return",
    returnSub: "reported sales / spend",
    sales: "Ad-attributed sales",
    salesSub: "as reported by Meta",
    feedTitle: "What we did and why",
    noActions:
      "No changes were needed this period — campaigns stayed above target. When we do nothing, we say so plainly.",
    missingActions:
      "This share does not include a client-safe action history. We do not invent missing action data; only creative summaries that can be shown safely are included.",
    outcomePending: "outcome window needs separate verification",
    highlights: "Creative highlights",
    creatorHighlights: "Shared creatives",
    highlightNote:
      "Only creatives with enough spend or sales value inside this shared snapshot are listed.",
    creatorHighlightNote:
      "This view contains creative signals only; absolute financial and volume metrics are not shared.",
    degradedNote:
      "Transparency note: measurement signals may be missing or delayed for this period. Missing data is not shown as 0 and no permanent outcome claim is made.",
    multiCurrency:
      "This snapshot includes multiple currencies. Spend and sales totals are shown as — because cross-currency aggregation is unsafe.",
    footKnown:
      "This panel shows only the shared business scope. Amounts use the account currency; missing data renders as —, never 0. Outcome statements are correlational.",
    footUnknown:
      "This panel shows only the shared business scope. If the snapshot does not carry currency metadata, values are limited to the source format; missing data renders as —, never 0. Outcome statements are correlational.",
    readOnly: "client view",
    creatorReadOnly: "creative view",
    ctrAll: "CTR",
    linkCtr: "Link CTR",
    thumbstop: "Thumbstop",
    video100: "Video completion",
    creatorFoot: "This view shows only the shared creative signals.",
  },
} as const;

interface PublicCreativeSharePageProps {
  payload: SharePayload;
  language?: ClientPanelLanguage;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatDateTime(value: string, language: ClientPanelLanguage) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "tr" ? "tr-TR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function normalizeCurrency(value: string | null | undefined) {
  const normalized = value?.trim().toUpperCase();
  return normalized || null;
}

function resolveCurrency(payload: SharePayload, creatives: PublicShareCreative[]) {
  const explicit = [
    normalizeCurrency(payload.currency),
    ...creatives.map((creative) => normalizeCurrency(creative.currency)),
  ].filter((currency): currency is string => Boolean(currency));
  const unique = Array.from(new Set(explicit));
  if (unique.length > 1) {
    return { currency: null, known: true, canAggregate: false };
  }
  if (unique.length === 1) {
    return { currency: unique[0], known: true, canAggregate: true };
  }
  return { currency: null, known: false, canAggregate: false };
}

function formatMoney(value: number | null, currency: string | null, language: ClientPanelLanguage) {
  if (!isFiniteNumber(value) || !currency) return "—";
  return new Intl.NumberFormat(language === "tr" ? "tr-TR" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatRoas(value: number | null, language: ClientPanelLanguage) {
  if (!isFiniteNumber(value)) return "—";
  const formatted = new Intl.NumberFormat(language === "tr" ? "tr-TR" : "en-US", {
    maximumFractionDigits: 2,
  }).format(value);
  return `${formatted}x`;
}

function formatRate(value: number, language: ClientPanelLanguage) {
  return `${new Intl.NumberFormat(language === "tr" ? "tr-TR" : "en-US", {
    maximumFractionDigits: 2,
  }).format(value)}%`;
}

function sumMetric(creatives: PublicShareCreative[], key: "spend" | "purchaseValue") {
  const values = creatives
    .map((creative) => creative[key])
    .filter((value): value is number => isFiniteNumber(value));
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function resolveBusinessLabel(
  payload: SharePayload,
  copy: typeof COPY.tr | typeof COPY.en,
  allowBusinessIdFallback: boolean,
) {
  if (payload.businessName?.trim()) return payload.businessName.trim();
  if (allowBusinessIdFallback && payload.businessId?.trim()) {
    return `Business ${payload.businessId.trim().slice(0, 6)}`;
  }
  return copy.fallbackBusiness;
}

function normalizeClientActionDate(action: SharedClientAction, language: ClientPanelLanguage) {
  if (!action.date.trim()) return "—";
  const parsed = new Date(action.date);
  if (Number.isNaN(parsed.getTime())) return action.date;
  return formatDateTime(action.date, language).split(",")[0] ?? action.date;
}

function buildFeed(actions: SharedClientAction[] | undefined, language: ClientPanelLanguage) {
  return (actions ?? [])
    .filter((action) => action.what.trim() && action.why.trim())
    .slice(0, 3)
    .map((action, index) => ({
      id: action.id || `${index}-${action.what}`,
      what: action.what,
      date: normalizeClientActionDate(action, language),
      why: action.why,
      outcome: action.outcome?.trim() || null,
      outcomeTone: action.outcomeTone === "positive" ? "positive" : "neutral",
    }));
}

function mediaLabel(creative: PublicShareCreative, language: ClientPanelLanguage) {
  if (creative.format === "video") return "video";
  if (creative.format === "catalog") return language === "tr" ? "katalog" : "catalog";
  return language === "tr" ? "görsel" : "image";
}

function mediaAspectRatio(creative: PublicShareCreative): string {
  const format = (creative.format ?? "").toLowerCase();
  if (format === "video" || format === "reel" || format === "story") return "9 / 16";
  if (format === "catalog" || format === "carousel") return "1 / 1";
  return "4 / 5";
}

function creatorSignalLine(
  creative: PublicShareCreative,
  language: ClientPanelLanguage,
  copy: typeof COPY.tr | typeof COPY.en,
) {
  const signals: Array<{ label: string; value: unknown }> = [
    { label: copy.ctrAll, value: creative.ctrAll },
    { label: copy.linkCtr, value: creative.linkCtr },
    { label: copy.thumbstop, value: creative.thumbstop },
    { label: copy.video100, value: creative.video100 },
  ];

  return signals
    .filter((signal): signal is { label: string; value: number } => isFiniteNumber(signal.value))
    .slice(0, 3)
    .map((signal) => `${signal.label} ${formatRate(signal.value, language)}`)
    .join(" · ");
}

export function PublicCreativeSharePage({ payload, language = "tr" }: PublicCreativeSharePageProps) {
  const copy = COPY[language];
  const creatives = payload.creatives as PublicShareCreative[];
  const isBuyer = typeof payload.audience === "undefined" || payload.audience === "buyer";
  const currencyInfo = useMemo(
    () => isBuyer
      ? resolveCurrency(payload, creatives)
      : { currency: null, known: false, canAggregate: false },
    [payload, creatives, isBuyer],
  );
  const totals = useMemo(() => {
    if (!isBuyer || !currencyInfo.canAggregate) {
      return { spend: null, sales: null, roas: null };
    }
    const spend = sumMetric(creatives, "spend");
    const sales = sumMetric(creatives, "purchaseValue");
    return {
      spend,
      sales,
      roas: spend !== null && sales !== null && spend > 0 ? sales / spend : null,
    };
  }, [creatives, currencyInfo.canAggregate, isBuyer]);

  const feed = useMemo(() => buildFeed(payload.clientActions, language), [payload.clientActions, language]);

  const highlights = useMemo(
    () => {
      if (!isBuyer) return creatives.slice(0, 3);
      return [...creatives]
        .sort((a, b) => (b.purchaseValue || b.spend || 0) - (a.purchaseValue || a.spend || 0))
        .slice(0, 3);
    },
    [creatives, isBuyer],
  );

  const asOf = formatDateTime(payload.frozenAt ?? payload.createdAt, language);
  const periodLine = `${payload.dateRange} · ${copy.asOf} ${asOf} UTC ${copy.asOfSuffix}`.trim();
  const businessLabel = resolveBusinessLabel(payload, copy, isBuyer);
  const trackingDegraded = isBuyer && (
    payload.trackingState === "tracking_degraded" || !currencyInfo.canAggregate
  );

  const printPdf = () => {
    if (typeof window !== "undefined") window.print();
  };

  return (
    <div className="ad-client-panel">
      <div className="ad-client-topbar">
        <div className="ad-client-mark" aria-hidden="true" />
        <div className="ad-client-business">{businessLabel}</div>
        <span className="ad-client-pill">{isBuyer ? copy.badge : copy.creatorBadge}</span>
        <div className="ad-client-spacer" />
        <button type="button" className="ad-client-outline-button" onClick={printPdf}>
          {copy.pdf}
        </button>
        <span className="ad-client-email">
          {isBuyer ? payload.clientEmail || copy.readOnly : copy.creatorReadOnly}
        </span>
      </div>

      <main className="ad-client-content">
        <header>
          <h1 className="ad-client-title">{payload.title || copy.title}</h1>
          <p className="ad-client-subtitle">{periodLine}</p>
        </header>

        {trackingDegraded ? (
          <div className="ad-client-banner">
            {!currencyInfo.canAggregate ? copy.multiCurrency : copy.degradedNote}
          </div>
        ) : null}

        {isBuyer ? (
          <>
            <section className="ad-client-kpi-grid" aria-label="Client KPI summary">
              <div className="ad-client-card ad-client-kpi">
                <p>{copy.spend}</p>
                <strong>{formatMoney(totals.spend, currencyInfo.currency, language)}</strong>
                <span>{currencyInfo.known ? `${copy.spendSubKnown} ${currencyInfo.currency ?? "—"}` : copy.spendSubUnknown}</span>
              </div>
              <div className="ad-client-card ad-client-kpi">
                <p>{copy.returnLabel}</p>
                <strong className="ad-client-positive">{formatRoas(totals.roas, language)}</strong>
                <span>{copy.returnSub}</span>
              </div>
              <div className="ad-client-card ad-client-kpi">
                <p>{copy.sales}</p>
                <strong>{formatMoney(totals.sales, currencyInfo.currency, language)}</strong>
                <span>{copy.salesSub}</span>
              </div>
            </section>

            <section>
              <h2 className="ad-client-section-title">{copy.feedTitle}</h2>
              {feed.length > 0 ? (
                <div className="ad-client-feed">
                  {feed.map((item) => (
                    <article key={item.id} className="ad-client-card ad-client-feed-item">
                      <div>
                        <h3>{item.what}</h3>
                        <time>{item.date}</time>
                      </div>
                      <p>{item.why}</p>
                      {item.outcome ? <span data-tone={item.outcomeTone}>{item.outcome}</span> : null}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="ad-client-card ad-client-empty">
                  {payload.trackingState === "no_actions" ? copy.noActions : copy.missingActions}
                </div>
              )}
            </section>
          </>
        ) : null}

        <section>
          <h2 className="ad-client-section-title ad-client-section-title-tight">
            {isBuyer ? copy.highlights : copy.creatorHighlights}
          </h2>
          <p className="ad-client-section-note">
            {isBuyer ? copy.highlightNote : copy.creatorHighlightNote}
          </p>
          <div className="ad-client-highlight-grid">
            {highlights.map((creative) => {
              const signalLine = isBuyer ? "" : creatorSignalLine(creative, language, copy);
              return (
                <article key={creative.id} className="ad-client-card ad-client-highlight">
                  <div className="ad-client-highlight-media" style={{ aspectRatio: mediaAspectRatio(creative) }}>
                    <CreativeRenderSurface
                      id={creative.id}
                      name={creative.name}
                      preview={creative.preview}
                      size="card"
                      mode="asset"
                      assetFallbacks={[
                        creative.mediaPreviewUrl,
                        creative.cardPreviewUrl,
                        creative.imageUrl,
                        creative.preview?.image_url,
                        creative.preview?.poster_url,
                        creative.previewUrl,
                        creative.cachedThumbnailUrl,
                        creative.thumbnailUrl,
                      ]}
                    />
                    <span>{mediaLabel(creative, language)}</span>
                  </div>
                  <div className="ad-client-highlight-body">
                    <h3>{creative.name}</h3>
                    {isBuyer ? (
                      <p>
                        {formatMoney(currencyInfo.canAggregate ? creative.spend ?? null : null, currencyInfo.currency, language)}
                        {" · "}
                        {formatRoas(isFiniteNumber(creative.roas) ? creative.roas : null, language)}
                      </p>
                    ) : signalLine ? <p>{signalLine}</p> : null}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        {isBuyer && payload.includeNotes && payload.note ? (
          <section className="ad-client-card ad-client-note">{payload.note}</section>
        ) : null}

        <footer className="ad-client-footer">
          {isBuyer
            ? currencyInfo.known ? copy.footKnown : copy.footUnknown
            : copy.creatorFoot}
        </footer>
      </main>
    </div>
  );
}
