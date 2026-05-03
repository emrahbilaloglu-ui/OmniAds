import type { MetaStatusResponse } from "@/lib/meta/status-types";
import {
  getMetaExtendedCompleteness,
  getMetaPageReadiness,
  hasMetaExtendedCompletenessLag,
} from "@/lib/meta/page-readiness";
import {
  getMetaPageStatusMessaging,
  type MetaUiLanguage,
} from "@/lib/meta/ui-status";

function getLocale(language: MetaUiLanguage) {
  return language === "tr" ? "tr-TR" : "en-US";
}

export function formatMetaDate(
  value: string | null | undefined,
  language: MetaUiLanguage
) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getLocale(language), {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function formatMetaDateTime(
  value: string | null | undefined,
  language: MetaUiLanguage
) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getLocale(language), {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatMetaReadyThroughDate(
  value: string | null | undefined,
  language: MetaUiLanguage
) {
  const formatted = formatMetaDate(value, language);
  if (!formatted) return null;
  return language === "tr" ? `Hazır: ${formatted}` : `Ready through ${formatted}`;
}

export function formatMetaHistoricalOldestReachedDate(
  value: string | null | undefined,
  language: MetaUiLanguage
) {
  const formatted = formatMetaDate(value, language);
  if (!formatted) return null;
  return language === "tr"
    ? `DB'deki en eski tarih: ${formatted}`
    : `Oldest stored date: ${formatted}`;
}

function getMetaSyncCaptionContext(status: MetaStatusResponse) {
  const pageReadiness = getMetaPageReadiness(status);
  const phaseLabel = status.latestSync?.phaseLabel ?? "";
  if (pageReadiness && !pageReadiness.complete) {
    return "selected_range";
  }
  if (
    status.state === "paused" ||
    status.state === "stale" ||
    status.state === "action_required"
  ) {
    return "operational";
  }
  if (phaseLabel === "Preparing today's data" || phaseLabel === "Syncing recent history") {
    return "today_or_recent";
  }
  if (phaseLabel === "Preparing selected dates") {
    return "selected_range";
  }
  if (phaseLabel === "Backfilling historical data") {
    return "historical";
  }
  if (status.warehouse?.coverage?.selectedRange && !status.warehouse.coverage.selectedRange.isComplete) {
    return "selected_range";
  }
  return "default";
}

function getMetaExtendedLagDescription(
  status: MetaStatusResponse,
  language: MetaUiLanguage
) {
  const extendedCompleteness = getMetaExtendedCompleteness(status);
  if (!extendedCompleteness || extendedCompleteness.complete) return null;

  if (extendedCompleteness.state === "blocked") {
    return language === "tr"
      ? "Özet ve kampanyalar hazır. Bazı breakdown yüzeyleri bu seçim için kullanılamıyor."
      : "Summary and campaigns are ready. Some breakdown surfaces are unavailable for this selection.";
  }

  if (status.pageReadiness?.selectedRangeMode === "current_day_live") {
    return language === "tr"
      ? "Özet ve kampanyalar hazır. Bugünün breakdown yüzeyleri arka planda tamamlanıyor."
      : "Summary and campaigns are ready. Current-day breakdown surfaces continue preparing in the background.";
  }

  if (status.warehouse?.coverage?.selectedRange) {
    return language === "tr"
      ? "Özet ve kampanyalar hazır. Seçili aralığın breakdown yüzeyleri arka planda tamamlanıyor."
      : "Summary and campaigns are ready. Breakdown surfaces for the selected range continue preparing in the background.";
  }

  return language === "tr"
    ? "Özet ve kampanyalar hazır. Breakdown geçmişi arka planda tamamlanıyor."
    : "Summary and campaigns are ready. Breakdown history continues preparing in the background.";
}

export function getMetaSyncTitle(
  status: MetaStatusResponse,
  language: MetaUiLanguage
) {
  if (status.state === "action_required") {
    return language === "tr"
      ? "Meta senkronu için müdahale gerekiyor"
      : "Meta sync needs attention";
  }
  if (status.state === "paused") {
    return language === "tr"
      ? "Meta kuyruğu senkron worker'ını bekliyor"
      : "Meta queue is waiting for the sync worker";
  }
  if (status.state === "stale") {
    return language === "tr"
      ? "Meta senkronu ilerlemeyi doğrulayamıyor"
      : "Meta sync needs progress confirmation";
  }
  if (hasMetaExtendedCompletenessLag(status)) {
    return language === "tr"
      ? "Meta çekirdek verisi hazır"
      : "Meta core data is ready";
  }

  const pageMessages = getMetaPageStatusMessaging(status, language);
  if (pageMessages.banner.title) return pageMessages.banner.title;
  if (status.domainReadiness?.summary) {
    return language === "tr" ? "Meta veri hazırlığı devam ediyor" : "Meta sync is still preparing data";
  }
  if (status.readinessLevel === "usable" && status.state !== "ready") {
    return language === "tr"
      ? "Meta dashboard kullanılabilir, derin senkron sürüyor"
      : "Meta dashboard is usable while deep sync continues";
  }
  if (status.latestSync?.phaseLabel) return status.latestSync.phaseLabel;
  if (status.state === "partial") {
    return language === "tr"
      ? "Meta verileri kademeli olarak hazır oluyor"
      : "Meta data is becoming available progressively";
  }
  return language === "tr"
    ? "Meta geçmiş verileri hazırlanıyor"
    : "Meta historical data is syncing";
}

export function getMetaSyncDescription(
  status: MetaStatusResponse,
  language: MetaUiLanguage
) {
  if (status.state === "action_required") {
    return language === "tr"
      ? "Arka plan senkronu tamamlanamadı. Entegrasyonu kontrol edin veya senkronu yeniden başlatın."
      : "Background sync stopped before finishing. Review the integration or restart the sync.";
  }
  if (status.state === "paused") {
    return language === "tr"
      ? "Kuyruktaki işler korunur. Worker yeniden devreye girdiğinde senkron otomatik devam eder."
      : "Queued work is safe. Sync will resume automatically when the worker becomes active again.";
  }
  if (status.state === "stale") {
    return language === "tr"
      ? "Çekirdek Meta doğrusu görünür olsa da arka plan ilerlemesi şu anda doğrulanamıyor."
      : "Core Meta truth may already be visible, but background progress cannot be verified right now.";
  }
  if (hasMetaExtendedCompletenessLag(status)) {
    return (
      getMetaExtendedLagDescription(status, language) ??
      (language === "tr"
        ? "Özet ve kampanyalar hazır. Breakdown hazırlığı arka planda devam ediyor."
        : "Summary and campaigns are ready. Breakdown preparation continues in the background.")
    );
  }

  const pageMessages = getMetaPageStatusMessaging(status, language);
  if (pageMessages.banner.description) return pageMessages.banner.description;
  if (status.domainReadiness?.summary) {
    return status.domainReadiness.summary;
  }
  if (status.readinessLevel === "usable" && status.state !== "ready") {
    return language === "tr"
      ? "Özet ve kampanya görünümü hazır. Breakdown ve kreatif yüzeyleri arka planda tamamlanır."
      : "Summary and campaign views are ready. Breakdown and creative surfaces continue in the background.";
  }
  if (status.state === "partial") {
    return language === "tr"
      ? "Hazır olan bölümleri kullanabilirsiniz; kalan veri arka planda hazırlanmaya devam eder."
      : "You can use the sections that are ready while the remaining data continues preparing in the background.";
  }
  return language === "tr"
    ? "Veriler hazırlanırken hazır olan bölümler kademeli olarak açılır."
    : "Available sections will unlock progressively while the rest of the data is prepared.";
}

export function getMetaSyncCaption(
  status: MetaStatusResponse,
  language: MetaUiLanguage
) {
  const latestSync = status.latestSync;
  if (!latestSync) return null;
  const context = getMetaSyncCaptionContext(status);

  const parts: string[] = [];
  if (status.domainReadiness?.summary) {
    parts.push(status.domainReadiness.summary);
  }
  if (
    typeof latestSync.completedDays === "number" &&
    typeof latestSync.totalDays === "number" &&
    latestSync.totalDays > 0
  ) {
    parts.push(
      language === "tr"
        ? `${latestSync.completedDays}/${latestSync.totalDays} gün`
        : `${latestSync.completedDays}/${latestSync.totalDays} days`
    );
  }

  if (context === "historical") {
    const latestLoadedDate = formatMetaHistoricalOldestReachedDate(
      status.warehouse?.firstDate ?? latestSync.readyThroughDate,
      language
    );
    if (latestLoadedDate) parts.push(latestLoadedDate);
    return parts.length > 0 ? parts.join(" • ") : null;
  }

  if (context === "operational") {
    return parts.length > 0 ? parts.join(" • ") : null;
  }

  const readyThrough = formatMetaReadyThroughDate(latestSync.readyThroughDate, language);
  if (readyThrough) parts.push(readyThrough);
  return parts.length > 0 ? parts.join(" • ") : null;
}

export function getMetaStatusNotice(
  status: MetaStatusResponse,
  language: MetaUiLanguage
) {
  if (status.state === "connected_no_assignment") {
    return language === "tr"
      ? "Bağlantı hazır, ancak bu workspace için henüz bir Meta reklam hesabı atanmadı."
      : "The connection is ready, but no Meta ad account has been assigned to this workspace yet.";
  }
  if (status.state === "action_required") {
    return status.latestSync?.lastError
      ? status.latestSync.lastError
      : getMetaSyncDescription(status, language);
  }
  if (hasMetaExtendedCompletenessLag(status)) {
    return getMetaExtendedLagDescription(status, language);
  }
  const pageMessages = getMetaPageStatusMessaging(status, language);
  if (pageMessages.banner.visible) {
    return pageMessages.banner.description ?? getMetaSyncDescription(status, language);
  }
  if (status.state === "ready" && status.latestSync?.finishedAt) {
    const finishedAt = formatMetaDateTime(status.latestSync.finishedAt, language);
    return language === "tr"
      ? `Geçmiş veri hazır. Son senkron ${finishedAt ?? status.latestSync.finishedAt} tarihinde tamamlandı.`
      : `Historical data is ready. The last sync finished ${finishedAt ?? status.latestSync.finishedAt}.`;
  }
  return null;
}
