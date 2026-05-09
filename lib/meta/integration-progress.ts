import { buildMetaIntegrationSummary } from "@/lib/meta/integration-summary";
import {
  formatMetaHistoricalOldestReachedDate,
  formatMetaReadyThroughDate,
  getMetaSyncDescription,
} from "@/lib/meta/ui";
import type {
  MetaIntegrationSummary,
  MetaIntegrationSummaryScope,
  MetaStatusResponse,
} from "@/lib/meta/status-types";
import type { MetaUiLanguage } from "@/lib/meta/ui-status";
import { shouldSuppressRecoverableMetaSyncIssue } from "@/lib/sync/user-visible-sync";

export type MetaIntegrationProgressStageState =
  | "ready"
  | "working"
  | "waiting"
  | "blocked";

export type MetaIntegrationProgressStageKey =
  | "connection"
  | "queue_worker"
  | "core_data"
  | "priority_window"
  | "extended_surfaces"
  | "attention";

export interface MetaIntegrationProgressStage {
  key: MetaIntegrationProgressStageKey;
  title: string;
  state: MetaIntegrationProgressStageState;
  label: string;
  detail: string;
  percent: number | null;
  evidence: string | null;
}

export interface MetaIntegrationProgressModel {
  stages: MetaIntegrationProgressStage[];
  attentionNeeded: boolean;
}

function localizePriorityTitle(
  scope: MetaIntegrationSummaryScope,
  language: MetaUiLanguage
) {
  if (scope === "selected_range") {
    return language === "tr" ? "Seçili aralık" : "Selected range";
  }
  if (scope === "current_day") {
    return language === "tr" ? "Bugün" : "Current day";
  }
  return language === "tr" ? "Çekirdek kapsam" : "Core coverage";
}

function getStageTitle(
  key: MetaIntegrationProgressStageKey,
  scope: MetaIntegrationSummaryScope,
  language: MetaUiLanguage
) {
  if (key === "connection") {
    return language === "tr" ? "Bağlantı" : "Connection";
  }
  if (key === "queue_worker") {
    return language === "tr" ? "Kuyruk / worker" : "Queue / worker";
  }
  if (key === "core_data") {
    return language === "tr" ? "Çekirdek veri" : "Core data";
  }
  if (key === "priority_window") {
    return localizePriorityTitle(scope, language);
  }
  if (key === "extended_surfaces") {
    return language === "tr" ? "Genişletilmiş yüzeyler" : "Extended surfaces";
  }
  return language === "tr" ? "Dikkat / toparlama" : "Attention / recovery";
}

function isWorkerUnavailableStage(
  stage: MetaIntegrationSummary["stages"][number],
  status: MetaStatusResponse
) {
  return (
    stage.key === "queue_worker" &&
    status.operations?.workerHealthy === false &&
    (status.jobHealth?.queueDepth ?? 0) > 0 &&
    (status.jobHealth?.leasedPartitions ?? 0) === 0
  );
}

function localizeStageLabel(
  stage: MetaIntegrationSummary["stages"][number],
  status: MetaStatusResponse,
  language: MetaUiLanguage
) {
  if (isWorkerUnavailableStage(stage, status)) {
    return language === "tr" ? "worker kullanılamıyor" : "worker unavailable";
  }

  const code = stage.code;
  switch (code) {
    case "connected":
      return language === "tr" ? "bağlı" : "connected";
    case "queue_clear":
      return language === "tr" ? "kuyruk temiz" : "queue clear";
    case "queue_active":
      return language === "tr" ? "worker aktif" : "worker active";
    case "queue_waiting":
      return language === "tr" ? "kuyruk beklemede" : "queue waiting";
    case "queue_blocked":
      return language === "tr" ? "müdahale gerekiyor" : "attention needed";
    case "queue_stale":
      return language === "tr" ? "ilerleme doğrulanamıyor" : "progress stale";
    case "core_ready":
      return language === "tr" ? "çekirdek hazır" : "core ready";
    case "core_preparing":
      return language === "tr" ? "çekirdek hazırlanıyor" : "core preparing";
    case "core_waiting":
      return language === "tr" ? "çekirdek beklemede" : "core waiting";
    case "core_blocked":
      return language === "tr" ? "çekirdek bloklu" : "core blocked";
    case "recent_window_ready":
      return language === "tr" ? "çekirdek kapsam hazır" : "core coverage ready";
    case "recent_window_preparing":
      return language === "tr"
        ? "çekirdek kapsam hazırlanıyor"
        : "core coverage preparing";
    case "recent_window_waiting":
      return language === "tr" ? "çekirdek kapsam beklemede" : "core coverage waiting";
    case "selected_range_ready":
      return language === "tr" ? "aralık hazır" : "range ready";
    case "selected_range_preparing":
      return language === "tr" ? "aralık hazırlanıyor" : "range preparing";
    case "selected_range_waiting":
      return language === "tr" ? "aralık beklemede" : "range waiting";
    case "selected_range_blocked":
      return language === "tr" ? "aralık bloklu" : "range blocked";
    case "current_day_ready":
      return language === "tr" ? "bugün hazır" : "today ready";
    case "current_day_preparing":
      return language === "tr" ? "bugün hazırlanıyor" : "today preparing";
    case "current_day_waiting":
      return language === "tr" ? "bugün beklemede" : "today waiting";
    case "current_day_blocked":
      return language === "tr" ? "bugün bloklu" : "today blocked";
    case "extended_ready":
      return language === "tr" ? "genişletilmiş hazır" : "extended ready";
    case "breakdowns_preparing":
      return language === "tr"
        ? "breakdownlar hazırlanıyor"
        : "breakdowns preparing";
    case "recent_extended_preparing":
      return language === "tr"
        ? "genişletilmiş hazırlanıyor"
        : "extended preparing";
    case "historical_extended_preparing":
      return language === "tr" ? "geçmiş tamamlanıyor" : "history continuing";
    case "extended_waiting":
      return language === "tr"
        ? "genişletilmiş beklemede"
        : "extended waiting";
    case "extended_blocked":
      return language === "tr" ? "genişletilmiş bloklu" : "extended blocked";
    case "attention_needed":
      return language === "tr" ? "müdahale gerekiyor" : "attention needed";
    case "recovery_running":
      return language === "tr" ? "toparlama sürüyor" : "recovery running";
    case "recovery_available":
      return language === "tr" ? "toparlama mevcut" : "recovery available";
    case "progress_stale":
      return language === "tr" ? "ilerleme doğrulanamıyor" : "progress stale";
    default:
      return code;
  }
}

function localizeBlockingReasonCode(code: string, language: MetaUiLanguage) {
  switch (code) {
    case "required_dead_letter_partitions":
      return language === "tr" ? "Dead letter var" : "Dead letter present";
    case "retryable_failed_partitions":
      return language === "tr" ? "Retry kuyruğu" : "Retry backlog";
    case "operations_worker_offline":
      return language === "tr" ? "Worker çevrimdışı" : "Worker offline";
    case "operations_lease_denied":
      return language === "tr" ? "Lease bekliyor" : "Lease waiting";
    case "operations_queue_backlogged":
      return language === "tr" ? "Kuyruk birikti" : "Queue backlogged";
    case "blocked_publication_mismatch":
      return language === "tr"
        ? "Yayınlanmış doğrusu bloklu"
        : "Published truth blocked";
    case "repair_required_authoritative_retry":
      return language === "tr"
        ? "Yayınlanmış doğrusu yeniden denenmeli"
        : "Published truth needs retry";
    case "historical_verification_failed":
      return language === "tr" ? "Geçmiş doğrusu hazır değil" : "Historical truth not ready";
    default:
      return code.replace(/_/g, " ");
  }
}

function localizeRepairActionKind(kind: string, language: MetaUiLanguage) {
  switch (kind) {
    case "replay_dead_letters":
      return language === "tr" ? "Dead letter replay" : "Replay dead letters";
    case "requeue_failed":
      return language === "tr"
        ? "Başarısız partition'ları yeniden kuyruğa al"
        : "Retry failed partitions";
    case "retry_authoritative_refresh":
      return language === "tr"
        ? "Yayınlanmış doğrusunu yeniden dene"
        : "Retry published truth";
    case "inspect_blocked_publication_mismatch":
      return language === "tr"
        ? "Bloklu yayın farkını incele"
        : "Review blocked published truth";
    case "inspect_stale_leases":
      return language === "tr" ? "Bayat lease'leri incele" : "Review stale leases";
    case "refresh_queue":
      return language === "tr" ? "Kuyruğu yenile" : "Refresh queue";
    default:
      return kind.replace(/_/g, " ");
  }
}

function localizePendingSurface(code: string, language: MetaUiLanguage) {
  switch (code) {
    case "account_daily":
      return language === "tr" ? "özet" : "summary";
    case "campaign_daily":
      return language === "tr" ? "kampanyalar" : "campaigns";
    case "adset_daily":
      return language === "tr" ? "reklam setleri" : "ad sets";
    case "ad_daily":
      return language === "tr" ? "reklamlar" : "ads";
    case "creative_daily":
      return language === "tr" ? "kreatifler" : "creatives";
    case "breakdowns":
      return language === "tr" ? "breakdownlar" : "breakdowns";
    default:
      return code.replace(/_/g, " ");
  }
}

function buildPendingSurfaceEvidence(
  surfaces: string[],
  language: MetaUiLanguage
) {
  if (surfaces.length === 0) return null;
  const labels = Array.from(new Set(surfaces.map((surface) => localizePendingSurface(surface, language))));
  const preview = labels.slice(0, 3).join(", ");
  if (labels.length > 3) {
    return language === "tr"
      ? `Bekleyen ${preview} ve fazlası`
      : `Pending ${preview}, and more`;
  }
  return language === "tr" ? `Bekleyen ${preview}` : `Pending ${preview}`;
}

function buildCountEvidence(
  completedDays: number | undefined,
  totalDays: number | undefined,
  language: MetaUiLanguage
) {
  if (
    !Number.isFinite(completedDays) ||
    !Number.isFinite(totalDays) ||
    (totalDays ?? 0) <= 0
  ) {
    return null;
  }
  return language === "tr"
    ? `${completedDays}/${totalDays} gün`
    : `${completedDays}/${totalDays} days`;
}

function pluralize(
  count: number,
  language: MetaUiLanguage,
  singular: string,
  plural: string
) {
  if (language === "tr") return `${count} ${plural}`;
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildQueueEvidence(
  stage: MetaIntegrationSummary["stages"][number],
  language: MetaUiLanguage
) {
  const evidence = stage.evidence;
  if (!evidence) return null;
  const parts: string[] = [];
  if (typeof evidence.blockerCount === "number" && evidence.blockerCodes?.length) {
    parts.push(
      ...Array.from(new Set(evidence.blockerCodes))
        .slice(0, 2)
        .map((code) => localizeBlockingReasonCode(code, language))
    );
  }
  if (typeof evidence.queueDepth === "number") {
    parts.push(language === "tr" ? `Kuyruk ${evidence.queueDepth}` : `Queue ${evidence.queueDepth}`);
  }
  if (typeof evidence.leasedPartitions === "number") {
    parts.push(language === "tr" ? `Lease ${evidence.leasedPartitions}` : `Leased ${evidence.leasedPartitions}`);
  }
  if (typeof evidence.retryableFailedPartitions === "number") {
    parts.push(language === "tr" ? `Retry ${evidence.retryableFailedPartitions}` : `Retry ${evidence.retryableFailedPartitions}`);
  }
  if (typeof evidence.deadLetterPartitions === "number") {
    parts.push(language === "tr" ? `Dead ${evidence.deadLetterPartitions}` : `Dead ${evidence.deadLetterPartitions}`);
  }
  return parts.length > 0 ? parts.join(" • ") : null;
}

function buildAttentionEvidence(
  stage: MetaIntegrationSummary["stages"][number],
  language: MetaUiLanguage
) {
  const evidence = stage.evidence;
  if (!evidence) return null;
  const parts: string[] = [];
  if (evidence.blockerCodes?.length) {
    parts.push(
      ...Array.from(new Set(evidence.blockerCodes))
        .slice(0, 2)
        .map((code) => localizeBlockingReasonCode(code, language))
    );
  } else if (typeof evidence.blockerCount === "number") {
    parts.push(
      pluralize(
        evidence.blockerCount,
        language,
        "blocker",
        language === "tr" ? "engel" : "blockers"
      )
    );
  }

  if (evidence.repairActionKinds?.length) {
    const preview = Array.from(new Set(evidence.repairActionKinds))
      .slice(0, 2)
      .map((kind) => localizeRepairActionKind(kind, language))
      .join(", ");
    parts.push(language === "tr" ? `Toparlama: ${preview}` : `Recovery: ${preview}`);
  } else if (typeof evidence.repairSignalCount === "number") {
    parts.push(
      pluralize(
        evidence.repairSignalCount,
        language,
        "recovery signal",
        language === "tr" ? "toparlama sinyali" : "recovery signals"
      )
    );
  }

  return parts.length > 0 ? parts.join(" • ") : null;
}

function buildStageEvidence(
  stage: MetaIntegrationSummary["stages"][number],
  language: MetaUiLanguage
) {
  const evidence = stage.evidence;
  if (!evidence) return null;

  if (stage.key === "connection") {
    if (!evidence.primaryTimezone) return null;
    return language === "tr"
      ? `Birincil saat dilimi ${evidence.primaryTimezone}`
      : `Primary timezone ${evidence.primaryTimezone}`;
  }

  if (stage.key === "queue_worker") {
    return buildQueueEvidence(stage, language);
  }

  if (stage.key === "attention") {
    return buildAttentionEvidence(stage, language);
  }

  const parts: string[] = [];
  const pendingSurfaceEvidence = buildPendingSurfaceEvidence(
    evidence.pendingSurfaces ?? [],
    language
  );
  if (pendingSurfaceEvidence) parts.push(pendingSurfaceEvidence);

  const blockerEvidence =
    evidence.blockerCodes?.length
      ? Array.from(new Set(evidence.blockerCodes))
          .slice(0, 2)
          .map((code) => localizeBlockingReasonCode(code, language))
          .join(" • ")
      : null;
  if (blockerEvidence) parts.push(blockerEvidence);

  const countEvidence = buildCountEvidence(
    evidence.completedDays,
    evidence.totalDays,
    language
  );
  if (countEvidence) parts.push(countEvidence);

  const oldestStored = formatMetaHistoricalOldestReachedDate(
    evidence.oldestStoredDate,
    language
  );
  if (oldestStored) parts.push(oldestStored);

  const readyThrough = formatMetaReadyThroughDate(
    evidence.readyThroughDate,
    language
  );
  if (readyThrough && !oldestStored) parts.push(readyThrough);

  return parts.length > 0 ? parts.join(" • ") : null;
}

function getConnectionDetail(
  stage: MetaIntegrationSummary["stages"][number],
  language: MetaUiLanguage
) {
  const assignedCount = stage.evidence?.assignedAccountCount ?? 0;
  if (assignedCount > 1) {
    return language === "tr"
      ? `Bu workspace için ${assignedCount} Meta hesabı atanmış.`
      : `${assignedCount} Meta accounts are assigned to this workspace.`;
  }
  return language === "tr"
    ? "Bu workspace için Meta hesabı atanmış."
    : "Meta account is assigned to this workspace.";
}

function getCoreDetail(
  code: MetaIntegrationSummary["stages"][number]["code"],
  language: MetaUiLanguage,
  scope: MetaIntegrationSummaryScope
) {
  switch (code) {
    case "core_ready":
      if (scope === "current_day") {
        return language === "tr"
          ? "Bugünün özet ve kampanya verisi hazır."
          : "Current-day summary and campaign data are ready.";
      }
      if (scope === "selected_range") {
        return language === "tr"
          ? "Seçili aralık için özet ve kampanya verisi hazır."
          : "Summary and campaign data are ready for the selected range.";
      }
      return language === "tr"
        ? "Özet ve kampanya verisi hazır."
        : "Summary and campaign data are ready.";
    case "core_waiting":
      return language === "tr"
        ? "Meta çekirdek verisi worker'ı bekliyor."
        : "Core Meta data is waiting for the worker.";
    case "core_blocked":
      return language === "tr"
        ? "Özet ve kampanya verisi bu kapsam için bloklu."
        : "Summary and campaign data are blocked for this scope.";
    case "core_preparing":
    default:
      if (scope === "current_day") {
        return language === "tr"
          ? "Bugünün Meta hesap günü için özet ve kampanya verisi hâlâ hazırlanıyor."
          : "Summary and campaign data for the current Meta account day are still preparing.";
      }
      if (scope === "selected_range") {
        return language === "tr"
          ? "Seçili aralık için özet ve kampanya verisi hâlâ hazırlanıyor."
          : "Summary and campaign data are still being prepared for the selected range.";
      }
      return language === "tr"
        ? "Özet ve kampanya verisi hâlâ hazırlanıyor."
        : "Summary and campaign data are still preparing.";
  }
}

function getPriorityDetail(
  code: MetaIntegrationSummary["stages"][number]["code"],
  language: MetaUiLanguage
) {
  switch (code) {
    case "recent_window_ready":
      return language === "tr"
        ? "Özet ve kampanya kapsamı hazır."
        : "Summary and campaign coverage is ready.";
    case "recent_window_waiting":
      return language === "tr"
        ? "Özet ve kampanya kapsamı kuyrukta bekliyor."
        : "Summary and campaign coverage is queued and waiting.";
    case "selected_range_ready":
      return language === "tr"
        ? "Seçili aralık doğrusu hazır."
        : "Selected-range truth is ready.";
    case "selected_range_preparing":
      return language === "tr"
        ? "Seçili aralık doğrusu hâlâ hazırlanıyor."
        : "Selected-range truth is still being prepared.";
    case "selected_range_waiting":
      return language === "tr"
        ? "Seçili aralık doğrusu kuyrukta bekliyor."
        : "Selected-range truth is queued and waiting.";
    case "selected_range_blocked":
      return language === "tr"
        ? "Seçili aralık doğrusu güvenilmeden önce toparlanmalı."
        : "Selected-range truth needs recovery before it can be trusted.";
    case "current_day_ready":
      return language === "tr"
        ? "Geçerli Meta hesap günü hazır."
        : "The current Meta account day is ready.";
    case "current_day_waiting":
      return language === "tr"
        ? "Geçerli Meta hesap günü kuyrukta bekliyor."
        : "The current Meta account day is queued and waiting.";
    case "current_day_blocked":
      return language === "tr"
        ? "Bugünün Meta doğrusu bloklu ve toparlanmalı."
        : "Current-day Meta truth is blocked and needs recovery.";
    case "current_day_preparing":
      return language === "tr"
        ? "Geçerli Meta hesap günü hâlâ hazırlanıyor."
        : "The current Meta account day is still preparing.";
    case "recent_window_preparing":
    default:
      return language === "tr"
        ? "Özet ve kampanya kapsamı hâlâ hazırlanıyor."
        : "Summary and campaign coverage is still preparing.";
  }
}

function getExtendedDetail(
  code: MetaIntegrationSummary["stages"][number]["code"],
  language: MetaUiLanguage
) {
  switch (code) {
    case "extended_ready":
      return language === "tr"
        ? "Breakdownlar, reklamlar ve kreatifler hazır."
        : "Breakdowns, ads, and creatives are ready.";
    case "recent_extended_preparing":
      return language === "tr"
        ? "Reklamlar, kreatifler veya breakdownlar hâlâ hazırlanıyor."
        : "Ads, creatives, or breakdowns are still preparing.";
    case "historical_extended_preparing":
      return language === "tr"
        ? "Reklamlar ve kreatifler arka planda geçmişi tamamlamayı sürdürüyor."
        : "Ads and creatives continue backfilling in the background.";
    case "extended_waiting":
      return language === "tr"
        ? "Genişletilmiş Meta yüzeyleri kuyrukta bekliyor."
        : "Extended Meta surfaces are queued and waiting.";
    case "extended_blocked":
      return language === "tr"
        ? "Bazı genişletilmiş Meta yüzeyleri bu kapsam için bloklu."
        : "Some extended Meta surfaces are blocked for this scope.";
    case "breakdowns_preparing":
    default:
      return language === "tr"
        ? "Breakdown yüzeyleri hâlâ hazırlanıyor."
        : "Breakdown surfaces are still preparing.";
  }
}

function getStageDetail(
  stage: MetaIntegrationSummary["stages"][number],
  scope: MetaIntegrationSummaryScope,
  language: MetaUiLanguage,
  status: MetaStatusResponse
) {
  switch (stage.key) {
    case "connection":
      return getConnectionDetail(stage, language);
    case "queue_worker":
      if (isWorkerUnavailableStage(stage, status)) {
        return language === "tr"
          ? "Taze bir Meta worker heartbeat'i veya aktif lease görünmüyor. Kuyruktaki Meta işi ilerlemiyor."
          : "No fresh Meta worker heartbeat or active lease is visible. Queued Meta work is not draining.";
      }
      if (stage.code === "queue_stale" && status.state === "stale") {
        return getMetaSyncDescription(status, language);
      }
      if (stage.code === "queue_waiting" && status.state === "paused") {
        return getMetaSyncDescription(status, language);
      }
      if (stage.code === "queue_blocked") {
        return language === "tr"
          ? "Kuyruk sağlığı temiz biçimde tamamlanmadan önce toparlanmalı."
          : "Queue health needs recovery before it can finish cleanly.";
      }
      if (stage.code === "queue_waiting") {
        return language === "tr"
          ? "Kuyruktaki Meta işi worker'ın devam etmesini bekliyor."
          : "Queued Meta work is waiting for the worker to continue.";
      }
      if (stage.code === "queue_active") {
        return typeof stage.evidence?.queueDepth === "number"
          ? language === "tr"
            ? "Meta senkronu kuyruktaki işi aktif olarak işliyor."
            : "Meta sync is actively processing queued work."
          : language === "tr"
            ? "Arka plan Meta işi aktif."
            : "Background Meta work is active.";
      }
      if (stage.code === "queue_clear") {
        return language === "tr"
          ? "Bekleyen Meta işi yok."
          : "No queued Meta work is waiting right now.";
      }
      return language === "tr"
        ? "Arka plan ilerlemesi şu anda doğrulanamıyor."
        : "Background progress cannot be verified right now.";
    case "core_data":
      return getCoreDetail(stage.code, language, scope);
    case "priority_window":
      return getPriorityDetail(stage.code, language);
    case "extended_surfaces":
      return getExtendedDetail(stage.code, language);
    case "attention":
      if (
        stage.code === "attention_needed" &&
        status.state === "action_required"
      ) {
        return getMetaSyncDescription(status, language);
      }
      if (stage.code === "queue_waiting" && status.state === "paused") {
        return getMetaSyncDescription(status, language);
      }
      if (stage.code === "progress_stale" && status.state === "stale") {
        return getMetaSyncDescription(status, language);
      }
      if (stage.code === "recovery_running") {
        return language === "tr"
          ? "Meta yeniden denenebilir işleri arka planda temizliyor."
          : "Meta is clearing retryable work in the background.";
      }
      if (stage.code === "recovery_available") {
        return language === "tr"
          ? "Meta hattında toparlama sinyalleri var."
          : "Recovery signals are present for the Meta pipeline.";
      }
      return language === "tr"
        ? "Bu senkron temiz biçimde tamamlanmadan önce Meta toparlanmalı."
        : "Meta needs recovery before this sync can finish cleanly.";
    default:
      return "";
  }
}

function getIntegrationSummary(status: MetaStatusResponse) {
  if (shouldSuppressRecoverableMetaSyncIssue(status)) {
    return buildMetaIntegrationSummary(status);
  }
  return status.integrationSummary ?? buildMetaIntegrationSummary(status);
}

export function resolveMetaIntegrationProgress(
  status: MetaStatusResponse | undefined | null,
  language: MetaUiLanguage = "en"
): MetaIntegrationProgressModel | null {
  if (!status) return null;

  const summary = getIntegrationSummary(status);
  if (!summary.visible) return null;

  return {
    stages: summary.stages.map((stage) => ({
      key: stage.key,
      title: getStageTitle(stage.key, summary.scope, language),
      state: stage.state,
      label: localizeStageLabel(stage, status, language),
      detail: getStageDetail(stage, summary.scope, language, status),
      percent: stage.percent,
      evidence: buildStageEvidence(stage, language),
    })),
    attentionNeeded: summary.attentionNeeded,
  };
}
