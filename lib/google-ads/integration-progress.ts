import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import {
  boundGoogleAdsWorkPercent,
  describeGoogleAdsFreshness,
  isGoogleAdsControlPlaneClosed,
  resolveGoogleAdsFreshnessView,
  type GoogleAdsFreshnessView,
} from "@/lib/google-ads/sync-progress-ux";
import type { MetaUiLanguage } from "@/lib/meta/ui-status";
import { shouldSuppressRecoverableGoogleSyncIssue } from "@/lib/sync/user-visible-sync";

export type GoogleIntegrationProgressStageState =
  | "ready"
  | "working"
  | "waiting"
  | "blocked";

export type GoogleIntegrationProgressStageKey =
  | "connection"
  | "queue_worker"
  | "core_data"
  | "selected_range"
  | "freshness"
  | "analysis"
  | "attention";

export interface GoogleIntegrationProgressStage {
  key: GoogleIntegrationProgressStageKey;
  title: string;
  state: GoogleIntegrationProgressStageState;
  label: string;
  detail: string;
  percent: number | null;
  evidence: string | null;
}

export interface GoogleIntegrationProgressModel {
  stages: GoogleIntegrationProgressStage[];
  attentionNeeded: boolean;
}

function clampPercent(value: number | null | undefined) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value ?? 0)));
}

function getStageTitle(
  key: GoogleIntegrationProgressStageKey,
  language: MetaUiLanguage,
) {
  switch (key) {
    case "connection":
      return language === "tr" ? "Bağlantı" : "Connection";
    case "queue_worker":
      return language === "tr" ? "Kuyruk / worker" : "Queue / worker";
    case "core_data":
      return language === "tr" ? "Çekirdek veri" : "Core data";
    case "selected_range":
      return language === "tr" ? "Görünür kapsam" : "Visible coverage";
    case "freshness":
      return language === "tr" ? "Veri tazeliği" : "Data freshness";
    case "analysis":
      return language === "tr" ? "Analiz / advisor" : "Analysis / advisor";
    default:
      return language === "tr" ? "Dikkat / toparlama" : "Attention / recovery";
  }
}

function getQueueEvidence(
  status: GoogleAdsStatusResponse,
  language: MetaUiLanguage,
) {
  const parts: string[] = [];
  const queueDepth = status.jobHealth?.queueDepth ?? 0;
  const leasedPartitions = status.jobHealth?.leasedPartitions ?? 0;
  const deadLetterPartitions = status.jobHealth?.deadLetterPartitions ?? 0;
  const repairCount = status.repairPlan?.recommendations?.length ?? 0;

  if (deadLetterPartitions > 0) {
    parts.push(language === "tr" ? `Dead ${deadLetterPartitions}` : `Dead ${deadLetterPartitions}`);
  }
  if (queueDepth > 0) {
    parts.push(language === "tr" ? `Kuyruk ${queueDepth}` : `Queue ${queueDepth}`);
  }
  if (leasedPartitions > 0) {
    parts.push(language === "tr" ? `Lease ${leasedPartitions}` : `Leased ${leasedPartitions}`);
  }
  if (repairCount > 0) {
    parts.push(language === "tr" ? `Toparlama ${repairCount}` : `Recovery ${repairCount}`);
  }
  return parts.length > 0 ? parts.join(" • ") : null;
}

function localizeSurfaceName(
  scope: string,
  language: MetaUiLanguage,
) {
  switch (scope) {
    case "campaign_daily":
      return language === "tr" ? "kampanya kapsamı" : "campaign coverage";
    case "search_term_daily":
      return language === "tr" ? "arama sorguları" : "search intelligence";
    case "product_daily":
      return language === "tr" ? "ürün performansı" : "product performance";
    case "asset_daily":
      return language === "tr" ? "asset performansı" : "asset performance";
    case "asset_group_daily":
      return language === "tr" ? "asset group kapsamı" : "asset group coverage";
    case "geo_daily":
      return language === "tr" ? "coğrafi performans" : "geo performance";
    case "device_daily":
      return language === "tr" ? "cihaz performansı" : "device performance";
    case "audience_daily":
      return language === "tr" ? "kitle performansı" : "audience performance";
    default:
      return scope.replace(/_/g, " ");
  }
}

function buildSelectedRangeEvidence(
  status: GoogleAdsStatusResponse,
  language: MetaUiLanguage,
) {
  const range = status.warehouse?.coverage?.selectedRange;
  if (range?.totalDays && range.totalDays > 0) {
    // Deliberately worded as row presence, not readiness. These counts come
    // from `SELECT DISTINCT date`: they say a day was written at least once,
    // never that it was re-read after it closed. The freshness stage answers
    // that question, and only it may.
    const rowsThrough = range.readyThroughDate
      ? language === "tr"
        ? `Kayıt: ${range.readyThroughDate}`
        : `Rows through ${range.readyThroughDate}`
      : null;
    return [
      language === "tr"
        ? `${range.completedDays}/${range.totalDays} gün veri`
        : `${range.completedDays}/${range.totalDays} days with data`,
      rowsThrough,
    ]
      .filter(Boolean)
      .join(" • ");
  }

  return null;
}

function getFreshnessLabel(view: GoogleAdsFreshnessView, language: MetaUiLanguage) {
  if (language !== "tr") return view.label;
  switch (view.state) {
    case "settled":
      return "politika gereği kapandı";
    case "converging":
      return "yenileniyor";
    case "provisional":
      return "geçici";
    case "missing":
      return "veri eksik";
    default:
      return "bilinmiyor";
  }
}

function describeFreshness(view: GoogleAdsFreshnessView, language: MetaUiLanguage) {
  if (language !== "tr") return describeGoogleAdsFreshness(view);
  if (view.settled) {
    return view.conversionLookbackDays != null
      ? `${view.conversionLookbackDays} günlük dönüşüm penceresine göre kapandı; Google bu pencere içinde dönüşümleri hâlâ revize edebilir.`
      : "Yapılandırılmış dönüşüm penceresine göre kapandı; Google bu pencere içinde dönüşümleri hâlâ revize edebilir.";
  }
  switch (view.state) {
    case "converging":
      return "Tüm günler kapandıktan sonra yeniden okundu; dönüşüm penceresi içinde yeni dönüşümler gelebilir.";
    case "provisional":
      return "En az bir gün kapandıktan sonra hiç yeniden okunmadı; bu kapsam geçici.";
    case "missing":
      return "Seçili aralığın bir bölümünde henüz hiç veri yok.";
    default:
      return "Google Ads tazelik kanıtı okunamadı; doğrulanana kadar sorgulanmaya devam ediliyor.";
  }
}

function toDayCount(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0;
}

function buildFreshnessEvidence(
  status: GoogleAdsStatusResponse,
  view: GoogleAdsFreshnessView,
  language: MetaUiLanguage,
) {
  const summary = status.freshness;
  if (!view.evidenceAvailable || !summary) return null;
  const scopes = Array.isArray(summary.scopes) ? summary.scopes : [];
  const totalDays = toDayCount(summary.totalDays);
  if (scopes.length === 0 || totalDays === 0) return null;

  // The weakest scope decides, exactly as it does server-side: a range is not
  // observed because most of its surfaces were.
  const observedDays = scopes.reduce(
    (weakest, scope) => Math.min(weakest, toDayCount(scope.postCloseObservedDays)),
    Number.POSITIVE_INFINITY,
  );
  const dueNowDays = scopes.reduce(
    (worst, scope) => Math.max(worst, toDayCount(scope.dueNowDays)),
    0,
  );

  const parts = [
    language === "tr"
      ? `${Math.min(observedDays, totalDays)}/${totalDays} gün kapanış sonrası okundu`
      : `${Math.min(observedDays, totalDays)}/${totalDays} days re-read after close`,
  ];
  if (dueNowDays > 0) {
    parts.push(
      language === "tr" ? `${dueNowDays} gün sırada` : `${dueNowDays} days due now`,
    );
  }
  return parts.join(" • ");
}

/**
 * The stage that answers the question row existence never could: have these
 * days been re-read since they closed?
 *
 * It renders in every state, including `unknown` — neutral, never green, never
 * an error. Its absence is what let a green workspace stand over a day captured
 * once at 01:40 and never looked at again.
 */
function buildFreshnessStage(
  status: GoogleAdsStatusResponse,
  language: MetaUiLanguage,
  view: GoogleAdsFreshnessView,
): GoogleIntegrationProgressStage {
  const state: GoogleIntegrationProgressStageState = view.settled
    ? "ready"
    : view.state === "converging" || view.state === "provisional"
      ? "working"
      : // `missing` and `unknown` are neutral: one is a fact about the data, the
        // other an admission about us. Neither is a failure the user can fix.
        "waiting";

  return {
    key: "freshness",
    title: getStageTitle("freshness", language),
    state,
    label: getFreshnessLabel(view, language),
    detail: describeFreshness(view, language),
    // No verdict, no number. A percent we cannot back is worse than none.
    percent: view.evidenceAvailable ? view.percent : null,
    evidence: buildFreshnessEvidence(status, view, language),
  };
}

function getAnalysisEvidence(
  status: GoogleAdsStatusResponse,
  language: MetaUiLanguage,
) {
  const advisor = status.advisor;
  if (!advisor) return null;
  const parts: string[] = [];
  if (advisor.readinessWindowDays) {
    parts.push(
      language === "tr"
        ? `${advisor.readinessWindowDays} günlük destek`
        : `${advisor.readinessWindowDays}-day support`,
    );
  }
  if (advisor.missingSurfaces.length > 0) {
    parts.push(
      language === "tr"
        ? `Bekleyen ${advisor.missingSurfaces
            .slice(0, 3)
            .map((scope) => localizeSurfaceName(scope, language))
            .join(", ")}`
        : `Pending ${advisor.missingSurfaces
            .slice(0, 3)
            .map((scope) => localizeSurfaceName(scope, language))
            .join(", ")}`,
    );
  }
  return parts.length > 0 ? parts.join(" • ") : null;
}

function getAttentionEvidence(
  status: GoogleAdsStatusResponse,
  language: MetaUiLanguage,
) {
  const parts: string[] = [];
  const repairCount = status.repairPlan?.recommendations?.length ?? 0;
  const blockerClass = status.blockerClass;
  const controlPlaneErrors = status.controlPlaneErrors;

  if (repairCount > 0) {
    parts.push(
      language === "tr"
        ? `${repairCount} toparlama önerisi`
        : `${repairCount} repair recommendation${repairCount === 1 ? "" : "s"}`,
    );
  }
  if (blockerClass && blockerClass !== "none") {
    parts.push(blockerClass.replace(/_/g, " "));
  }
  if (controlPlaneErrors) {
    const errorCount = Object.values(controlPlaneErrors).filter(Boolean).length;
    if (errorCount > 0) {
      parts.push(
        language === "tr"
          ? `${errorCount} control-plane hata`
          : `${errorCount} control-plane error${errorCount === 1 ? "" : "s"}`,
      );
    }
  }
  return parts.length > 0 ? parts.join(" • ") : null;
}

function buildConnectionStage(
  status: GoogleAdsStatusResponse,
  language: MetaUiLanguage,
): GoogleIntegrationProgressStage {
  const assignedCount = status.assignedAccountIds.length;
  return {
    key: "connection",
    title: getStageTitle("connection", language),
    state: "ready",
    label: language === "tr" ? "bağlı" : "connected",
    detail:
      assignedCount > 1
        ? language === "tr"
          ? `Bu workspace için ${assignedCount} Google Ads hesabı atanmış.`
          : `${assignedCount} Google Ads accounts are assigned to this workspace.`
        : language === "tr"
          ? "Bu workspace için Google Ads hesabı atanmış."
          : "Google Ads account is assigned to this workspace.",
    percent: null,
    evidence: status.primaryAccountTimezone
      ? language === "tr"
        ? `Birincil saat dilimi ${status.primaryAccountTimezone}`
        : `Primary timezone ${status.primaryAccountTimezone}`
      : null,
  };
}

function buildQueueStage(
  status: GoogleAdsStatusResponse,
  language: MetaUiLanguage,
): GoogleIntegrationProgressStage {
  if (isGoogleAdsControlPlaneClosed(status)) {
    return {
      key: "queue_worker",
      title: getStageTitle("queue_worker", language),
      state: "ready",
      label: language === "tr" ? "kuyruk temiz" : "queue clear",
      detail:
        language === "tr"
          ? "Kullanılabilir veri hazır; arka plan yenilemeleri planlandıkça çalışır."
          : "Usable data is ready; background refresh runs when scheduled.",
      percent: null,
      evidence: null,
    };
  }
  const suppressRecoverableSync = shouldSuppressRecoverableGoogleSyncIssue(status);

  const queueDepth = status.jobHealth?.queueDepth ?? 0;
  const leasedPartitions = status.jobHealth?.leasedPartitions ?? 0;
  const deadLetterPartitions = status.jobHealth?.deadLetterPartitions ?? 0;
  const progressState = status.operations?.progressState ?? null;
  const state =
    deadLetterPartitions > 0 ||
    progressState === "blocked" ||
    status.blockerClass === "queue_blocked"
      ? suppressRecoverableSync
        ? "working"
        : "blocked"
      : status.state === "paused" ||
          progressState === "partial_stuck" ||
          (queueDepth > 0 && leasedPartitions === 0)
        ? "waiting"
        : leasedPartitions > 0 ||
            progressState === "syncing" ||
            progressState === "partial_progressing" ||
            status.latestSync?.status === "running" ||
            status.latestSync?.status === "pending" ||
            queueDepth > 0
          ? "working"
          : "ready";

  const label =
    state === "blocked"
      ? language === "tr"
        ? "müdahale gerekiyor"
        : "attention needed"
      : state === "waiting"
        ? language === "tr"
          ? "kuyruk beklemede"
          : "queue waiting"
        : state === "working"
          ? language === "tr"
            ? "worker aktif"
            : "worker active"
          : language === "tr"
            ? "kuyruk temiz"
            : "queue clear";
  const detail =
    state === "blocked"
      ? language === "tr"
        ? "Google Ads kuyruk sağlığı temiz biçimde tamamlanmadan önce toparlanmalı."
        : "Google Ads queue health needs recovery before it can finish cleanly."
      : state === "waiting"
        ? language === "tr"
          ? "Kuyruktaki Google Ads işi worker'ın devam etmesini bekliyor."
          : "Queued Google Ads work is waiting for the worker to continue."
        : state === "working"
          ? language === "tr"
            ? "Google Ads senkronu kuyruktaki işi aktif olarak işliyor."
            : "Google Ads sync is actively processing queued work."
          : language === "tr"
            ? "Bekleyen Google Ads işi yok."
            : "No queued Google Ads work is waiting right now.";

  return {
    key: "queue_worker",
    title: getStageTitle("queue_worker", language),
    state,
    label,
    detail,
    percent: null,
    evidence: getQueueEvidence(status, language),
  };
}

function buildCoreStage(
  status: GoogleAdsStatusResponse,
  language: MetaUiLanguage,
  freshness: GoogleAdsFreshnessView,
): GoogleIntegrationProgressStage {
  const core = status.domains?.core;
  const requiredCoverage = status.requiredScopeCompletion;
  const state: GoogleIntegrationProgressStageState =
    core?.state === "ready"
      ? "ready"
      : status.state === "paused"
        ? "waiting"
        : status.state === "action_required" && !status.panel?.coreUsable
          ? "blocked"
          : "working";

  return {
    key: "core_data",
    title: getStageTitle("core_data", language),
    state,
    label:
      state === "ready"
        ? language === "tr"
          ? "çekirdek hazır"
          : "core ready"
        : state === "waiting"
          ? language === "tr"
            ? "çekirdek beklemede"
            : "core waiting"
          : state === "blocked"
            ? language === "tr"
              ? "çekirdek bloklu"
              : "core blocked"
            : language === "tr"
              ? "çekirdek hazırlanıyor"
              : "core preparing",
    detail:
      state === "ready" && requiredCoverage && !requiredCoverage.complete
        ? language === "tr"
          ? "Çekirdek harcama ve kampanya özeti kullanılabilir; geçmiş kapsam arka planda tamamlanıyor."
          : "Core spend and campaign summary are usable; historical coverage continues in the background."
        : core?.detail ??
      (language === "tr"
        ? "Özet ve kampanya verisi hâlâ hazırlanıyor."
        : "Summary and campaign data are still being prepared."),
    percent:
      state !== "ready" && requiredCoverage && !requiredCoverage.complete
        ? // `requiredCoverage.percent` is completedDays/totalDays. It may show
          // how far the backfill has walked, never more completion than the
          // freshness verdict allows.
          boundGoogleAdsWorkPercent(clampPercent(requiredCoverage.percent) ?? 0, freshness)
        : null,
    evidence:
      requiredCoverage?.readyThroughDate
        ? language === "tr"
          ? `Hazır: ${requiredCoverage.readyThroughDate}`
          : `Ready through ${requiredCoverage.readyThroughDate}`
        : null,
  };
}

function buildSelectedRangeStage(
  status: GoogleAdsStatusResponse,
  language: MetaUiLanguage,
  freshness: GoogleAdsFreshnessView,
): GoogleIntegrationProgressStage {
  const selectedRange = status.domains?.selectedRange;
  const range = status.warehouse?.coverage?.selectedRange;
  const requiredCoverage = status.requiredScopeCompletion;
  const showHistoricalBackfill =
    status.panel?.coreUsable === true &&
    requiredCoverage != null &&
    !requiredCoverage.complete &&
    !range;
  const percent =
    range && range.totalDays > 0 && !range.isComplete
      ? // This used to be `completedDays / totalDays * 100` — row existence
        // dressed up as progress, the arithmetic that let a day read once at
        // 01:40 count as done forever. The verdict owns the number now, and
        // when there is no verdict we publish no percent at all.
        (freshness.evidenceAvailable ? freshness.percent : null)
      : showHistoricalBackfill
        ? boundGoogleAdsWorkPercent(clampPercent(requiredCoverage.percent) ?? 0, freshness)
      : null;
  const state: GoogleIntegrationProgressStageState =
    showHistoricalBackfill
      ? "working"
      : selectedRange?.state === "ready"
      ? "ready"
      : selectedRange?.state === "partial"
        ? "working"
        : status.state === "paused"
          ? "waiting"
          : "working";

  return {
    key: "selected_range",
    title: showHistoricalBackfill
      ? language === "tr"
        ? "Geçmiş backfill"
        : "Historical backfill"
      : getStageTitle("selected_range", language),
    state,
    label:
      showHistoricalBackfill
        ? language === "tr"
          ? "arka planda"
          : "background"
        : selectedRange?.state === "ready"
        ? language === "tr"
          ? "kapsam hazır"
          : "coverage ready"
        : selectedRange?.state === "partial"
          ? language === "tr"
            ? "kapsam kısmi"
            : "coverage partial"
          : status.selectedRangeReadinessBasis?.mode === "current_day_live"
            ? language === "tr"
              ? "canlı kapsam"
              : "live coverage"
            : language === "tr"
              ? "kapsam hazırlanıyor"
              : "coverage preparing",
    detail:
      showHistoricalBackfill
        ? language === "tr"
          ? "Google Ads geçmiş kapsamı kullanılabilir çekirdek veri üzerinden arka planda tamamlanıyor."
          : "Google Ads historical coverage is backfilling in the background while core data stays usable."
        : selectedRange?.detail ??
      (language === "tr"
        ? "Görünür raporlama yüzeyleri hazırlanıyor."
        : "Visible reporting surfaces are still preparing."),
    percent,
    evidence: showHistoricalBackfill
      ? requiredCoverage.readyThroughDate
        ? language === "tr"
          ? `Hazır: ${requiredCoverage.readyThroughDate}`
          : `Ready through ${requiredCoverage.readyThroughDate}`
        : null
      : buildSelectedRangeEvidence(status, language),
  };
}

function buildAnalysisStage(
  status: GoogleAdsStatusResponse,
  language: MetaUiLanguage,
): GoogleIntegrationProgressStage {
  const advisor = status.domains?.advisor;
  const advisorProgress = status.advisorProgress;
  const coreUsable = status.panel?.coreUsable === true;
  const state: GoogleIntegrationProgressStageState =
    advisor?.state === "ready"
      ? "ready"
      : status.state === "paused"
        ? "waiting"
        : status.operations?.advisorSnapshotBlockedReason && !coreUsable
          ? "blocked"
          : "working";

  return {
    key: "analysis",
    title: getStageTitle("analysis", language),
    state,
    label:
      state === "ready"
        ? language === "tr"
          ? "analiz hazır"
          : "analysis ready"
        : state === "waiting"
          ? language === "tr"
            ? "analiz beklemede"
            : "analysis waiting"
          : state === "blocked"
            ? language === "tr"
              ? "analiz bloklu"
              : "analysis blocked"
            : language === "tr"
              ? "analiz hazırlanıyor"
              : "analysis preparing",
    detail:
      advisor?.detail ??
      status.advisor?.blockingMessage ??
      (language === "tr"
        ? "Google Ads çok pencereli analiz kapsamı hazırlanıyor."
        : "Google Ads multi-window analysis coverage is still preparing."),
    percent:
      advisorProgress?.visible === true ? clampPercent(advisorProgress.percent) : null,
    evidence: getAnalysisEvidence(status, language),
  };
}

function shouldRenderAttentionStage(status: GoogleAdsStatusResponse) {
  if (shouldSuppressRecoverableGoogleSyncIssue(status)) {
    return false;
  }
  if (isGoogleAdsControlPlaneClosed(status)) {
    return false;
  }

  return Boolean(
    status.controlPlaneErrors &&
      Object.values(status.controlPlaneErrors).some(Boolean),
  ) ||
    Boolean(
      status.controlPlanePersistence?.exactRowsPresent === true &&
        ((status.releaseGate?.verdict != null &&
          status.releaseGate.verdict !== "pass") ||
          (status.repairPlan?.recommendations?.length ?? 0) > 0 ||
          (status.blockerClass != null && status.blockerClass !== "none")),
    ) ||
    status.state === "action_required" ||
    status.state === "stale";
}

function buildAttentionStage(
  status: GoogleAdsStatusResponse,
  language: MetaUiLanguage,
): GoogleIntegrationProgressStage {
  return {
    key: "attention",
    title: getStageTitle("attention", language),
    state: "blocked",
    label: language === "tr" ? "müdahale gerekiyor" : "attention needed",
    detail:
      status.releaseGate?.summary ??
      status.advisor?.blockingMessage ??
      (language === "tr"
        ? "Google Ads senkronu temiz biçimde tamamlanmadan önce toparlanmalı."
        : "Google Ads needs recovery before this sync can finish cleanly."),
    percent: null,
    evidence: getAttentionEvidence(status, language),
  };
}

export function resolveGoogleIntegrationProgress(
  status: GoogleAdsStatusResponse | undefined | null,
  language: MetaUiLanguage = "en",
): GoogleIntegrationProgressModel | null {
  if (!status?.connected) return null;
  if ((status.assignedAccountIds?.length ?? 0) === 0) return null;

  // One reading of the authoritative verdict, shared by every stage that would
  // otherwise reach for coverage on its own.
  const freshness = resolveGoogleAdsFreshnessView(status);

  const stages: GoogleIntegrationProgressStage[] = [
    buildConnectionStage(status, language),
    buildQueueStage(status, language),
    buildCoreStage(status, language, freshness),
    buildSelectedRangeStage(status, language, freshness),
    buildFreshnessStage(status, language, freshness),
    buildAnalysisStage(status, language),
  ];

  if (shouldRenderAttentionStage(status)) {
    stages.push(buildAttentionStage(status, language));
  }

  return {
    stages,
    attentionNeeded: stages.some((stage) => stage.key === "attention"),
  };
}
