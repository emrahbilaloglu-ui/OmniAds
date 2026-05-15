import type { MetaBreakdownsResponse } from "@/app/api/meta/breakdowns/route";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { AppLanguage } from "@/lib/i18n";
import type {
  MetaCalibrationScopeResult,
  MetaCalibrationThresholds,
  MetaMetricPercentiles,
} from "@/lib/meta/calibration";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import type { MetaBidRegimeHistorySummary } from "@/lib/meta/config-snapshots";
import type { MetaCreativeIntelligenceSummary } from "@/lib/meta/creative-intelligence";
import type { MetaEvidenceTrail } from "@/lib/meta/evidence-trail";
import {
  inferBidRegime,
  inferCampaignRole,
} from "@/lib/meta/campaign-roles";
import {
  buildMetaCampaignLaneSignals,
  buildMetaCampaignLaneSummary,
  comparableMetaIntentKey,
  comparableMetaIntentLabel,
  isScalingCampaignFamily,
  metaCampaignFamilyLabel,
  resolveMetaCampaignFamily,
  type MetaCampaignFamily,
  type MetaCampaignLaneFamilySummary,
  type MetaCampaignLaneLabel,
  type MetaCampaignLaneSignal,
} from "@/lib/meta/campaign-lanes";
import type { MetaBidRegime, MetaCampaignRole } from "@/lib/meta/types";
import {
  emitHighPriorityCampaignScenario,
  maybeG2DownshiftToPurchase,
} from "@/lib/meta/scenario-emitters/high-priority";
import type { MetaEntityDecisionSignal } from "@/lib/meta/entity-signals";
import {
  isPurchaseCohort,
  resolveMetaFunnelCohort,
  type MetaFunnelCohort,
} from "@/lib/meta/funnel-cohort";
import {
  metaCutRoasCeiling,
  metaLossBudgetMaturity,
  metaScaleRoasFloor,
  type MetaCommercialTargets,
} from "@/lib/meta/commercial-targets";
import {
  deriveMetaAutomationReadiness,
  type MetaAutomationReadiness,
} from "@/lib/meta/automation-readiness";
import {
  metaEmpiricalOutcomeSummaryKey,
  type MetaEmpiricalOutcomeSummary,
} from "@/lib/meta/empirical-outcomes";
import { decisionLabelForMetaRec } from "@/lib/meta/rec-label-mapping";

export type MetaDecisionState = "act" | "test" | "watch";
export type MetaRecommendationLens = "volume" | "profitability" | "structure";
export type MetaRecommendationPriority = "high" | "medium" | "low";
export type MetaRecommendationConfidence = "high" | "medium" | "low";
export type MetaRecommendationLevel = "account" | "campaign" | "adset";
export type MetaRecommendationType =
  | "entity_state"
  | "campaign_state"
  | "adset_state"
  | "scenario_a1_math_floor_unmet"
  | "scenario_a2_learning_weak_structural"
  | "scenario_a3_learning_on_pace_wait"
  | "scenario_a4_learning_limited_persistent"
  | "scenario_a5_post_learning_underperformer"
  | "scenario_b1_capped_winner_bid_raise"
  | "scenario_b2_lowest_cost_budget_scale"
  | "scenario_b3_bid_cap_underperforming"
  | "scenario_b4_min_roas_loosen"
  | "scenario_b5_lowest_cost_volatility_switch"
  | "scenario_b6_profit_first_bid_cap_keep"
  | "scenario_c1_controlled_scale"
  | "scenario_c2_recent_edit_cooldown"
  | "scenario_c3_scale_sample_gate"
  | "scenario_d1_lal_beats_broad_control"
  | "scenario_d2_lal_wide_efficiency_loss"
  | "scenario_d3_lal_compound_scale"
  | "scenario_d4_audience_overlap_consolidate"
  | "scenario_d5_funnel_mixed_split"
  | "scenario_e1_frequency_fatigue"
  | "scenario_e2_ctr_decay_refresh"
  | "scenario_e3_frequency_p80_fatigue"
  | "scenario_e4_creative_age_refresh"
  | "scenario_f1_roas_drop_diagnostic"
  | "scenario_f2_recent_data_confidence_cap"
  | "scenario_f3_budget_change_cooldown"
  | "scenario_f4_stable_winner_drop_context"
  | "scenario_g1_upper_funnel_event"
  | "scenario_g2_downshift_to_purchase"
  | "scenario_g3_ab_test_bottom_funnel_verdict"
  | "scenario_h1_dedup_tracking"
  | "scenario_h2_meta_crm_ratio"
  | "scenario_h3_ios_tracking_degradation"
  | "scenario_h4_event_quota"
  | "scenario_i1_abo_winner_budget_shift"
  | "scenario_i2_abo_to_cbo"
  | "scenario_i3_cbo_overcrowded"
  | "scenario_i4_test_should_use_abo"
  | "scenario_i5_cross_campaign_overlap"
  | "scenario_j1_stable_winner_protected"
  | "scenario_j2_fade_risk_diagnose"
  | "scenario_j3_aggressive_scale_guard"
  | "scenario_k1_mixed_config_rebuild"
  | "scenario_k2_peak_scale_ceiling"
  | "scenario_k3_post_peak_taper"
  | "scenario_k4_catalog_feed_first"
  | "scenario_m1_mid_funnel_efficient_scale"
  | "scenario_m2_mid_funnel_steady_keep"
  | "scenario_m3_mid_funnel_inefficient_cut"
  | "scenario_m4_mid_funnel_refresh"
  | "scenario_l1_lead_efficient_scale"
  | "scenario_l2_lead_steady_keep"
  | "scenario_l3_lead_inefficient_cut"
  | "scenario_l4_lead_refresh"
  | "scenario_t1_traffic_efficient_scale"
  | "scenario_t2_traffic_steady_keep"
  | "scenario_t3_traffic_inefficient_cut"
  | "scenario_t4_traffic_refresh"
  | "scenario_eg1_engagement_efficient_scale"
  | "scenario_eg2_engagement_steady_keep"
  | "scenario_eg3_engagement_inefficient_cut"
  | "scenario_eg4_engagement_refresh"
  | "adset_scale_budget"
  | "adset_cut_spend"
  | "adset_watch_learning"
  | "campaign_structure"
  | "optimization_fit"
  | "bid_strategy_fit"
  | "bid_value_guidance"
  | "budget_allocation"
  | "scale_for_volume"
  | "scale_for_profitability"
  | "seasonal_regime_shift"
  | "historical_bid_regime_fit"
  | "rebuild_with_constraints"
  | "bid_band_from_history"
  | "geo_cluster_for_signal_density"
  | "creative_test_structure"
  | "scaling_structure_fit"
  | "promote_test_to_main"
  | "winner_promotion_flow";

export type MetaDecisionLabel =
  | "scale"
  | "cut"
  | "refresh"
  | "keep"
  | "test_more"
  | "diagnose"
  | "below_breakeven"
  | "fatigue"
  | "rebuild"
  | "switch"
  | "tune"
  | "swap"
  | "review_placements"
  | "review_adsets"
  | "out_of_scope";

export interface MetaRecommendationLabelTransform {
  reason: "test_refresh_to_cut" | "test_scale_to_promote_main";
  campaignKind: "test";
  fromType: MetaRecommendationType;
  toType: MetaRecommendationType;
  fromDecisionLabel: MetaDecisionLabel | null;
  toDecisionLabel: MetaDecisionLabel;
}

export type MetaSeasonalState = "peak" | "post_peak" | "normalized" | "unstable";

export interface MetaRecommendationEvidence {
  label: string;
  value: string;
  tone: "positive" | "warning" | "neutral";
}

export interface MetaRecommendationTimeframeContext {
  coreVerdict: string;
  selectedRangeOverlay: string;
  historicalSupport: string;
  seasonalityFlag: "none" | "possible" | "strong";
  note: string | null;
}

export interface MetaRecommendation {
  id: string;
  level: MetaRecommendationLevel;
  campaignId?: string;
  campaignName?: string;
  adsetId?: string;
  adsetName?: string;
  type: MetaRecommendationType;
  kind?: "recommendation" | "anomaly" | "state";
  decisionLabel?: MetaDecisionLabel;
  labelTransform?: MetaRecommendationLabelTransform;
  stateReason?: string | null;
  signalQuality?: Record<string, unknown>;
  calibrationScope?: Record<string, unknown>;
  lens: MetaRecommendationLens;
  priority: MetaRecommendationPriority;
  confidence: MetaRecommendationConfidence;
  confidenceScore?: number;
  confidenceReason?: string | null;
  empiricalOutcomeSummary?: MetaEmpiricalOutcomeSummary;
  automationReadiness?: MetaAutomationReadiness;
  decisionState: MetaDecisionState;
  decision: string;
  title: string;
  why: string;
  summary: string;
  recommendedAction: string;
  expectedImpact: string;
  evidence: MetaRecommendationEvidence[];
  timeframeContext: MetaRecommendationTimeframeContext;
  strategyLayer?: "seasonality" | "bidding" | "structure" | "budget" | "scaling";
  comparisonCohort?: string | null;
  historicalRegime?: string | null;
  seasonalState?: MetaSeasonalState | null;
  defensiveBidBand?: string | null;
  scaleBidBand?: string | null;
  requiresRebuild?: boolean;
  rebuildReason?: string | null;
  promoteCreatives?: string[];
  keepTestingCreatives?: string[];
  doNotDeployCreatives?: string[];
  targetScalingLane?: string | null;
  scalingGeoCluster?: string[];
  testingGeoCluster?: string[];
  matureGeoSplit?: string[];
  targetValue?: unknown;
  predictiveOverlay?: string | null;
  engineVersion?: string;
  evidenceTrail?: MetaEvidenceTrail;
  campaignRole?: MetaCampaignRole;
  bidRegime?: MetaBidRegime;
  cohort?: MetaFunnelCohort | null;
}

export interface MetaDecisionSummary {
  title: string;
  summary: string;
  primaryLens: MetaRecommendationLens;
  confidence: MetaRecommendationConfidence;
  recommendationCount: number;
  operatingMode?: string | null;
  currentRegime?: string | null;
  recommendedMode?: string | null;
}

export type MetaRecommendationAnalysisSourceSystem =
  | "snapshot_fallback"
  | "snapshot_persistent"
  | "snapshot_live"
  | "demo";

export interface MetaRecommendationAnalysisSource {
  system: MetaRecommendationAnalysisSourceSystem;
  decisionOsAvailable: boolean;
  fallbackReason?: string;
}

export interface MetaRecommendationsResponse {
  status: "ok";
  businessId?: string;
  startDate?: string;
  endDate?: string;
  summary: MetaDecisionSummary;
  recommendations: MetaRecommendation[];
  sourceModel?: "snapshot_heuristics" | "snapshot_persistent" | "snapshot_live";
  analysisSource?: MetaRecommendationAnalysisSource;
}

export const META_RECOMMENDATION_ENGINE_VERSION = "v1.0.0";

export interface MetaCalibrationContext {
  thresholds: MetaCalibrationThresholds;
  scope?: MetaCalibrationScopeResult["scope"];
  reason?: MetaCalibrationScopeResult["reason"];
  cohort?: MetaFunnelCohort;
}

export interface MetaStatisticalConfidenceInput {
  level: MetaRecommendationLevel;
  metricValue: number;
  threshold: number;
  sampleSize: number;
  minRequiredSample: number;
  ageDays?: number | null;
  severeLoser?: boolean;
}

export interface MetaStatisticalConfidenceResult {
  score: number;
  label: MetaRecommendationConfidence;
  reason?: "thin_data_watching" | "severe_loser_bypass";
}

function evidenceValue(recommendation: MetaRecommendation, label: string) {
  return recommendation.evidence.find((item) => item.label === label)?.value ?? null;
}

function localizeMetaRecommendation(recommendation: MetaRecommendation, language: AppLanguage): MetaRecommendation {
  if (language !== "tr") {
    return recommendation;
  }

  const campaignName = recommendation.campaignName ?? "Bu kampanya";
  const comparisonCohort = recommendation.comparisonCohort ?? "mevcut kohort";
  const historicalRegime = recommendation.historicalRegime ?? "Constrained Bidding";
  const currentRegime = evidenceValue(recommendation, "Current regime") ?? "Mixed";
  const historicalRegimeEvidence = evidenceValue(recommendation, "Historical regime") ?? historicalRegime;
  const defensiveBidBand = recommendation.defensiveBidBand ?? evidenceValue(recommendation, "Defensive bid band");
  const scaleBidBand = recommendation.scaleBidBand ?? evidenceValue(recommendation, "Scale bid band");
  const roasBand = evidenceValue(recommendation, "ROAS band");
  const coreRoas = evidenceValue(recommendation, "Core ROAS");
  const corePurchases = evidenceValue(recommendation, "Core purchases");
  const coreCpa = evidenceValue(recommendation, "Core CPA");
  const bidMethod = evidenceValue(recommendation, "Bid method");
  const currentTarget = evidenceValue(recommendation, "Current target");
  const suggestedTargetRange = evidenceValue(recommendation, "Suggested target range");
  const suggestedBidRange = evidenceValue(recommendation, "Suggested bid range");
  const spendShare = evidenceValue(recommendation, "Spend share");
  const peerGroupRoas = evidenceValue(recommendation, "Peer-group ROAS");
  const bestCampaign = evidenceValue(recommendation, "Best campaign");
  const weakCampaign = evidenceValue(recommendation, "Weak campaign");
  const laneMix = evidenceValue(recommendation, "Lane mix");
  const testLanes = evidenceValue(recommendation, "Test lanes");
  const validationLanes = evidenceValue(recommendation, "Validation lanes");
  const scalingLanes = evidenceValue(recommendation, "Scaling lanes");
  const stableScalingCreatives = evidenceValue(recommendation, "Stable scaling creatives");
  const scalingReadyCreatives = evidenceValue(recommendation, "Scaling-ready creatives");
  const keepInTest = evidenceValue(recommendation, "Keep in TEST");
  const keepOutOfScaling = evidenceValue(recommendation, "Keep out of scaling");
  const testOnlyCreatives = evidenceValue(recommendation, "Test-only creatives");
  const blockedCreatives = evidenceValue(recommendation, "Blocked creatives");
  const thinSignalCountries = evidenceValue(recommendation, "Thin-signal countries");
  const thinSignalSpendShare = evidenceValue(recommendation, "Thin-signal spend share");
  const top2CountryShare = evidenceValue(recommendation, "Top-2 country share");
  const scalingGeos = evidenceValue(recommendation, "Scaling geos");
  const selectedRoas = evidenceValue(recommendation, "Selected ROAS");
  const baselineRoas = evidenceValue(recommendation, "Baseline ROAS");
  const peakWindow = evidenceValue(recommendation, "Peak window");
  const constrainedShare = evidenceValue(recommendation, "Constrained share");
  const seasonalityFlag = recommendation.seasonalState ?? "normalized";

  const localizedEvidence = recommendation.evidence.map((item) => {
    const labelMap: Record<string, string> = {
      "Thin-signal countries": "Zayıf sinyalli ülkeler",
      "Thin-signal spend share": "Zayıf sinyal harcama payi",
      "Top-2 country share": "Ilk 2 ülke payi",
      "Scaling geos": "Scaling GEO'lar",
      "Scaling lanes": "Scaling lane'leri",
      "Validation lanes": "Dogrulama lane'leri",
      "Test lanes": "Test lane'leri",
      "Stable scaling creatives": "Stabil scaling creative'leri",
      "Top creative lane": "En iyi creative lane",
      "Compared within": "Karşılaştırma kohortu",
      "Test-only creatives": "Sadece test creative'leri",
      "Blocked creatives": "Bloke creative'ler",
      "Strong campaigns": "Güçlü kampanyalar",
      "Structure": "Yapi",
      "Best scaling lane": "En iyi scaling lane",
      "Test-only queue": "Sadece TEST kuyrugu",
      "Fatigued creatives": "Yorulmus creative'ler",
      "Scaling-ready creatives": "Scaling'e hazir creative'ler",
      "Keep in TEST": "TEST'te tut",
      "Keep out of scaling": "Scaling disinda tut",
      "Target scaling lane": "Hedef scaling lane",
      "Optimization": "Optimizasyon",
      "Bidding": "Teklifleme",
      "Budgeting": "Butceleme",
      "Selected ROAS": "Seçili ROAS",
      "Baseline ROAS": "Baz ROAS",
      "Peak window": "Peak pencere",
      "Historical regime": "Tarihsel rejim",
      "Current regime": "Mevcut rejim",
      "Constrained share": "Kısıtli pay",
      "Defensive bid band": "Defansif teklif bandi",
      "Scale bid band": "Ölçekleme teklif bandi",
      "ROAS band": "ROAS bandi",
      "Seasonal state": "Sezonsal durum",
      "Starting defensive band": "Baslangic defansif bandi",
      "Core purchases": "Temel purchase sayisi",
      "Core ROAS": "Temel ROAS",
      "Cost / lead": "Lead basi maliyet",
      "Leads": "Lead sayisi",
      "Bid method": "Teklif yöntemi",
      "Current target": "Mevcut hedef",
      "Suggested target range": "Önerilen hedef aralığı",
      "Bid value": "Teklif degeri",
      "Suggested bid range": "Önerilen teklif aralığı",
      "Peer-group ROAS": "Benzer grup ROAS",
      "Core CPA": "Temel CPA",
      "Spend share": "Harcama payi",
      "Comparison set": "Karşılaştırma seti",
      "Lane filter": "Lane filtresi",
      "Lane mix": "Lane karisimi",
      "Best campaign": "En iyi kampanya",
      "Weak campaign": "Zayıf kampanya",
      "Low-signal campaigns": "Düşük sinyalli kampanyalar",
    };
    return { ...item, label: labelMap[item.label] ?? item.label };
  });

  const localizedTimeframe = {
    coreVerdict:
      recommendation.type === "rebuild_with_constraints"
        ? "Temel karar, sezonsallik, ağırlıklandirilmis performans ve hesap hafizasini birlikte degerlendirerek artimli optimizasyonun artik yeterli olmadigini soyluyor."
        : recommendation.type === "seasonal_regime_shift"
          ? "Temel karar, seçili aralığı normal çalışma hali saymak yerine normalize baz ve peak dönemini birlikte degerlendiriyor."
          : recommendation.type === "bid_band_from_history"
            ? "Temel karar, teklif bandini 7/14/30/90/geçmiş verimlilik pencerelerinden turetiyor."
            : recommendation.timeframeContext.coreVerdict,
    selectedRangeOverlay:
      recommendation.type === "seasonal_regime_shift"
        ? "Seçili aralık daha geniş rejim modeliyle birlikte okunuyor."
        : recommendation.type === "bid_band_from_history"
          ? "Seçili aralık sadece mevcut dönemin bu bandin üstunde mi altında mi davrandigini doğrulamak için kullaniliyor."
          : recommendation.timeframeContext.selectedRangeOverlay,
    historicalSupport:
      recommendation.type === "historical_bid_regime_fit"
        ? "Tarihsel destek, seçili kampanyalar uzerindeki daha uzun konfigurasyon hafizasindan geliyor."
        : recommendation.timeframeContext.historicalSupport,
    seasonalityFlag: recommendation.timeframeContext.seasonalityFlag,
    note:
      recommendation.timeframeContext.note && recommendation.type === "seasonal_regime_shift"
        ? seasonalityFlag === "peak"
          ? "Seçili aralık hala yüksek talep dönemi gibi davranıyor; bunu kalici baz gibi okumayin."
          : seasonalityFlag === "post_peak"
            ? "Yüksek talep etkisi zayıfladi; mevcut performans artik daha çok normalleşmiş döneme benziyor."
            : "Mevcut performans hem kisa hem uzun vadeli bazin altında. Bu yalnızca normal sezonsallik değil, daha geniş bir zayıflamaya isaret ediyor."
        : recommendation.timeframeContext.note,
  };

  switch (recommendation.type) {
    case "geo_cluster_for_signal_density":
      return {
        ...recommendation,
        decision: "Zayıf sinyalli ülkeleri parcalamak yerine grupla",
        title: "Ikincil pazarlarda GEO sinyali dagiliyor",
        why: "Ülke bazında harcama fazla parçalanıyor. Birden fazla pazar harcama alıyor ama tek başına sağlıklı öğrenme yaratacak conversion derinliğine ulaşmıyor.",
        summary: `${thinSignalCountries ?? "Birden fazla"} ülke halen zayıf sinyalle çalışıyor; buna karşın ${scalingGeos ?? "daha güçlü GEO'lar"} daha net purchase performansı veriyor.`,
        recommendedAction: "Düşük hacimli ülkeleri ortak bir TEST GEO yapısında toplayın. Daha olgun GEO'ları ise ayrı scaling yapılarında yönetin.",
        expectedImpact: "GEO kararlarinda daha net sinyal, küçük pazarlarda daha temiz creative doğrulamasi ve gereksiz parcalanmanin azalmasi.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "scaling_structure_fit":
      return {
        ...recommendation,
        decision: "Scaling kampanyalarini test kampanyalarindan ayir",
        title: "Scaling ve testing ayni katmanda kalmamali",
        why: "Hesapta artık ölçekleme hakkı kazanmış kampanyalar var; buna karşın bazı kampanyalar hâlâ sinyal toplama aşamasında. İkisini aynı operasyon mantığıyla yönetmek hem bütçeyi hem öğrenmeyi bulandırıyor.",
        summary: `${comparisonCohort} ailesinde ${scalingLanes ?? "0"} scaling lane, ${validationLanes ?? "0"} validation lane ve ${testLanes ?? "0"} test lane görünüyor${stableScalingCreatives ? `; ayrıca ${stableScalingCreatives} stabil scaling creative'i var` : ""}.`,
        recommendedAction: "Kanıtlanmış kampanyalari scaling lane olarak koruyun. Keşif aşamasındaki creative ve kampanyalari ayrı bir TEST akışına taşıyın.",
        expectedImpact: "Ölçekleme kararlarinda daha net sinyal, testing tarafında daha temiz geri bildirim ve gereksiz bütçe kesintilerinde azalma.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "creative_test_structure":
      return {
        ...recommendation,
        decision: "Zayıf sinyalli kampanyalar için ortak bir creative test lane kullan",
        title: "Creative testing için ayrı bir TEST yapısı kur",
        why: "Conversion derinliği hâlâ sınırlıyken creative kararlarını birden fazla küçük scaling kampanyasına dağıtmak sağlıklı değil. Ortak bir TEST yapısı daha hızlı ve daha net öğrenme sağlar.",
        summary: `${testLanes ?? "Birden fazla"} TEST lane ayni anda creative kesfi tasiyor görünüyor. Bu yuk daginik kaldigi için test hizi dusuyor${testOnlyCreatives ? `; su an ${testOnlyCreatives} creative hala sadece test asamasinda` : ""}.`,
        recommendedAction: "Keşif creative'leri ortak bir TEST kampanyasinda toplayin. Scaling lane'lerde yalnızca kanitlanmis winner creative'leri bırakın.",
        expectedImpact: "Creative öğrenmesinin hızlanması, scaling bütçesinde daha az israf ve winner seçiminde daha net sinyal.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "winner_promotion_flow":
      return {
        ...recommendation,
        decision: "Kanıtlanmış creative'leri scaling'e taşıyın, kesfi izole tutun",
        title: "Scaling lane winner creative'i devralmali",
        why: "Ayni aile içinde zaten kanitlanmis bir scaling lane varsa, her kampanyanin yeniden winner bulmaya çalışmasi verimsiz olur. Dogrulanmis creative'lerin tek bir güçlü lane'e aktarilmasi gerekir.",
        summary: `${campaignName}, ${comparisonCohort} ailesi içinde winner creative'i absorbe edebilecek güçlü lane'lerden biri gibi duruyor${scalingReadyCreatives ? `; elde ${scalingReadyCreatives} adet scaling'e hazir creative var` : ""}.`,
        recommendedAction: "Winner creative'leri önce en güçlü scaling lane'e taşıyın. Test-only veya zayıf creative'leri TEST tarafında tutmaya devam edin.",
        expectedImpact: "Kanıtlanmış mesajlarla daha hızlı ölçekleme ve creative testing tarafında daha az tekrar emegi.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "campaign_structure":
      return {
        ...recommendation,
        decision: "Kampanya yapısını sadeleştir",
        title: `${campaignName}: kampanya yapısını sadeleştir`,
        why: "Ad set seviyesinde optimization, bidding ve bütçe sinyalleri fazla karışıyor. Bu yapı öğrenmeyi bulandırıyor ve hangi ayarın işe yaradığını okumayı zorlaştırıyor.",
        summary: "Mevcut kurgu ayni kampanya içinde farkli mantıklari bir araya getiriyor. Ayni optimization ve bid mantigina sahip ad set'leri birlikte tutmak daha sağlıklı olur.",
        recommendedAction: "Karışık ad set'leri daha temiz gruplara ayirin. Her kampanyada tek objective ve tek bid mantigi olsun.",
        expectedImpact: "Daha net öğrenme, daha kolay bütçe kontrolü ve ölçekleme kararlarında daha yüksek güven.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "seasonal_regime_shift":
      return {
        ...recommendation,
        decision: seasonalityFlag === "peak" ? "Sezonsal zirveyi kalici baz gibi okumayin" : "Beklentileri güncel baza göre sifirlayin",
        title:
          seasonalityFlag === "post_peak"
            ? "Peak talep zayıfladi"
            : seasonalityFlag === "peak"
              ? "Seçili aralık hala sezonsal görünüyor"
              : "Mevcut dönem yapısal olarak bazın altında görünüyor",
        why: localizedTimeframe.note ?? recommendation.why,
        summary:
          seasonalityFlag === "peak"
            ? `Seçili aralık hâlen normalize bazın (${baselineRoas ?? selectedRoas ?? "mevcut ROAS"}) üstünde; geniş yapısal kararlar için erken olabilir.`
            : `Seçili ROAS ${selectedRoas ?? "mevcut seviye"}, baz ROAS ise ${baselineRoas ?? "baz seviye"} civarinda. ${peakWindow ? `Peak pencere: ${peakWindow}.` : ""}`,
        recommendedAction:
          seasonalityFlag === "peak"
            ? "Buyuk rebuild kararlarini yüksek talep penceresi bittikten sonraya bırakın veya ayrı kontrollu bir testte doğrulayin."
            : "Bidding, budget ve scaling kararlarini mevcut peak olmayan baza göre alin.",
        expectedImpact: "Sezonsal zirvelerden gelen yanlis pozitiflerin azalmasi ve güncel ROAS seviyesine daha uygun operasyonel kararlar.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "historical_bid_regime_fit":
      return {
        ...recommendation,
        decision: "Hesabin tarihsel bidding rejimine geri don",
        title: "Mevcut bidding rejimi hesap hafizasiyla uyusmuyor",
        why: "Hesabın daha stabil çalıştığı dönemlerde kısıtlı bidding daha baskın görünüyor. Bugünkü kampanya seti ise farklı bir bidding modu etrafında yoğunlaşmış durumda.",
        summary: `Tarihsel olarak en sağlıklı çalışan rejim ${historicalRegimeEvidence}; mevcut kampanyalar ise ağırlıkla ${currentRegime} modunda ilerliyor.`,
        recommendedAction: `${historicalRegimeEvidence} rejimini ana rebuild hipotezi olarak alin ve kontrollu bütçeyle mevcut kurguya karşı test edin.`,
        expectedImpact: "Kısa süreli talep oynaklığının dışında, hesabın daha stabil performans yapısıyla daha iyi uyum.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "bid_band_from_history":
      return {
        ...recommendation,
        decision: "Tek nokta tahmini yerine tarihsel verimlilik bantlarını kullan",
        title: "Tarihsel bid bantları daha güvenli bir çalışma alanı veriyor",
        why: "Bid kararlarını tek bir son datapointe göre değil, çoklu pencere AOV ve ROAS bantlarına göre almak daha sağlıklı olur.",
        summary: defensiveBidBand
          ? `Defansif bid bandi ${defensiveBidBand}${scaleBidBand ? `, scaling bandi ise ${scaleBidBand}` : ""}.`
          : `Önerilen ROAS çalışma bandi ${roasBand}.`,
        recommendedAction: defensiveBidBand
          ? `${defensiveBidBand} bandini karlılık korumasi için, ${scaleBidBand ?? defensiveBidBand} bandini ise daha agresif scaling için referans alin.`
          : `${roasBand ?? "Mevcut ROAS bandini"} çalışan hedef band olarak kullanin ve gerçek ROAS buna göre ayarlansin.`,
        expectedImpact: "Bid değişikliklerinde daha istikrarli bir akıs ve kisa vadeli oynakliga daha az asiri tepki.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "rebuild_with_constraints":
      return {
        ...recommendation,
        decision: `${historicalRegime} ile durdur ve yeniden kur`,
        title: `${historicalRegime} rebuild'i, mevcut Lowest Cost ayarlarını zorlamaktan daha güvenli`,
        why: "Hesap daha güçlü talep rejiminden cikiyor ve tarihsel konfigurasyon hafizasi daha kontrollu bir bidding modeline donmenin daha sağlıklı olabilecegini gösteriyor.",
        summary: `Post-peak dönemde veya performans bozulurken, ${historicalRegime} yönündeki tarihsel eğilim küçük ayarlardan daha güvenli bir rebuild sinyali veriyor.`,
        recommendedAction: defensiveBidBand
          ? `En zayıf kampanyalari durdurup ${historicalRegime} ile yeniden kürün; ilk savunma bandi olarak ${defensiveBidBand} kullanin.`
          : `En zayıf kampanyalari durdurup ${historicalRegime} merkezli bir rebuild kurgusu kürün.`,
        expectedImpact: "Hesap yüksek talep döneminden çıkarken kârlılık üzerinde daha temiz kontrol ve daha net koruma sınırları.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "optimization_fit":
      return {
        ...recommendation,
        decision: recommendation.decision.includes("lead") ? "Lead kalitesini yeniden test et" : "Daha alt hunide yeni objective test et",
        title: recommendation.title.replace(": move beyond Add To Cart optimization", ": Add To Cart optimizasyonunun otesine gec").replace(": lead optimization is expensive", ": lead optimizasyonu pahali"),
        why: recommendation.why.includes("Lead cost")
          ? "Lead maliyeti yüksek ve mevcut objective hacmi kaliteye tercih ediyor olabilir."
          : "Kampanya artik anlamli purchase üretiyor. Bu noktada huninin daha asagisina inmek karlılık kontrolünu guclendirebilir.",
        summary: recommendation.summary.includes("lead")
          ? "Ağırlıklandirilmis lead verimliligi kalite odakli bir yeniden testi hakli cikaracak kadar zayıf."
          : "Ağırlıklandirilmis performans, Purchase veya Value optimization testini hakli cikaracak kadar yeterli purchase hacmi gösteriyor.",
        recommendedAction: recommendation.recommendedAction
          .replace("Duplicate the campaign and test Purchase or Value optimization against the current Add To Cart setup.", "Kampanyayı kopyalayın ve mevcut Add To Cart yapısına karşı Purchase veya Value optimization test edin.")
          .replace("Test a tighter audience or quality-lead / purchase-aligned structure instead of scaling the current lead setup.", "Mevcut lead yapısını büyütmek yerine daha sıkı audience veya quality-lead / purchase-aligned bir yapı test edin."),
        expectedImpact: recommendation.expectedImpact.includes("wasted spend")
          ? "Boş harcamanın azalması ve downstream conversion kalitesinin iyileşmesi."
          : "Daha sağlıklı downstream conversion kalitesi ve daha istikrarli ROAS.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "bid_value_guidance":
      return {
        ...recommendation,
        decision: currentTarget ? "Target ROAS seviyesini yeniden kalibre et" : "Target ROAS için çalışan bir band tanımla",
        title: `${campaignName}: Target ROAS ile gerçek getiriyi birlikte ayarla`,
        why: "Target ROAS sabit bir ayar gibi kullanılmamalı. Gerçek getiri hedefin belirgin üzerindeyse gereksiz yere hacim kaybediyor olabilirsiniz.",
        summary: currentTarget
          ? `Temel ROAS ${coreRoas ?? "mevcut seviye"}, hedef ise ${currentTarget}.`
          : `Kampanya config'indeki mevcut Target ROAS net okunamıyor; bu nedenle tarihsel performanstan türetilen ${suggestedTargetRange ?? "bir hedef aralığı"} kullaniliyor.`,
        recommendedAction:
          recommendation.recommendedAction
            .replace("Test lowering Target ROAS from ", "Target ROAS'i ")
            .replace(" by 10-15% to unlock more volume.", " seviyesinden %10-15 dusurerek daha fazla hacim test edin.")
            .replace("Keep Target ROAS tight and avoid aggressive scaling until actual ROAS is consistently above ", "Gerçek ROAS istikrarla ")
            .replace("Use ", "")
            || (suggestedTargetRange
              ? `${suggestedTargetRange} aralığını çalışan Target ROAS bandı olarak alın.`
              : "Scaling öncesi açık bir Target ROAS bandı tanımlayın."),
        expectedImpact: recommendation.expectedImpact.includes("delivery")
          ? "Karlılık korumalarindan tamamen vazgecmeden daha fazla delivery."
          : "Marjı korurken daha kontrollü bir bidding akışı.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "bid_strategy_fit":
      return {
        ...recommendation,
        decision: recommendation.decision.includes("efficiency") ? "Verimlilik için koruma sınırlarını güçlendir" : "Manual bid kısıtını yeniden değerlendir",
        title: recommendation.title
          .replace(": bid constraint may be limiting scale", ": bid kısıtı ölçeklemenin önünü kesiyor olabilir")
          .replace(": Lowest Cost is not protecting profitability", ": Lowest Cost karliligi korumuyor"),
        why: recommendation.why.includes("Lowest Cost")
          ? "Lowest Cost delivery için güçlü olabilir, ancak çoklu pencerede zayıf verimlilik daha güçlü kısıtlar gerektiğini gösteriyor."
          : "Manual bid stratejileri verimliliği koruyabilir; ancak kampanya sağlıklı hâle geldiğinde büyümenin önündeki darboğaza da dönüşebilir.",
        summary: suggestedBidRange
          ? `Kampanya kısıtlı bir bidding stratejisi kullanıyor. Tarihsel AOV ve ROAS'e göre daha güvenli referans bid aralığı ${suggestedBidRange}.`
          : recommendation.summary,
        recommendedAction: recommendation.recommendedAction
          .replace("Test loosening ", "")
          .replace(" by 10-15% before increasing budget aggressively.", " kısıtını bütçeyi agresif şekilde artırmadan önce %10-15 gevşetmeyi test edin."),
        expectedImpact: recommendation.expectedImpact === "More delivery while keeping changes controlled."
          ? "Değişiklikleri kontrollu tutarken daha fazla hacim acma imkani."
          : "Daha agresif hacim acmadan önce kar kalitesi uzerinde daha iyi kontrol.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "scale_for_volume":
      return {
        ...recommendation,
        decision: recommendation.decisionState === "act" ? "Bu kampanyayı daha fazla hacim için ölçekle" : "Ölçekleme testini dikkatli yap",
        title: `${campaignName}: kontrollu ölçekleme için güçlü aday`,
        why: "Bu kampanya ayni optimization niyetindeki akranlarina göre kabul edilebilir karlılık veriyor ve kontrollu ölçekleme için yeterli conversion derinligi toplamis durumda.",
        summary: `Temel ağırlıklandırılmış performans, ${corePurchases ?? "yeterli"} purchase ve ${coreRoas ?? "güçlü"} ROAS ile ilave bütçeyi veya daha gevşek teslimat kısıtlarını destekliyor.`,
        recommendedAction:
          bidMethod && bidMethod !== "Lowest Cost"
            ? `${campaignName} tarafında kontrollü bir ölçekleme testi açın. Önce mevcut ${bidMethod} koruma bandını bozmadan bütçeyi kademeli artırın; teslimat stabil kalırsa ikinci adımda kısıtları gevşetin.`
            : `${campaignName} için bütçeyi kademeli bicimde artirin ve ilk 48-72 saatte ROAS ile CPA dengesini izleyin. Hacim acarken kontrolü kaybetmeyin.`,
        expectedImpact: "Kontrolu tamamen kaybetmeden daha fazla teslimat ve daha yüksek conversion hacmi.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "scale_for_profitability":
      return {
        ...recommendation,
        decision: recommendation.decisionState === "act" ? "Scaling'den önce karliligi koru" : "Daha büyük kesintilerden önce verimliligi izle",
        title: `${campaignName}: ölçeklemeden önce karlılık toparlanmali`,
        why: "Bu kampanya anlamli harcama tuketiyor ama ayni optimization niyetindeki akranlarinin verimlilik cizgisinin gerisinde kaliyor.",
        summary: `Bu noktada ölçekleme, geliri buyutmekten cok israfi buyutebilir. Harcama payi ${spendShare ?? "mevcut seviye"}, peer-group ROAS ise ${peerGroupRoas ?? "referans seviye"}.`,
        recommendedAction:
          bidMethod && bidMethod === "Lowest Cost"
            ? `${campaignName} tarafında ölçekleme açmadan önce verimlilik için net bir koruma bandı ekleyin. Gerekirse Cost Cap veya Target ROAS testiyle kâr kalitesini toparlayın.`
            : `${campaignName} bütçesini buyutmeden önce verimliligi toparlayin. Zayıf alanlari kisip daha sağlıklı kombinasyonlara bütçe açın.`,
        expectedImpact: "Bos harcamanin azalmasi ve bütçenin daha temiz dagilmasi.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    case "budget_allocation":
      return {
        ...recommendation,
        decision: recommendation.decision.includes("efficiency") ? "Butceyi daha verimli ceplere kaydır" : "Butceyi en güçlü scale adaylarina yonelt",
        title: recommendation.title.includes("efficiency") ? "Butce daha verimli ceplere kaymali" : "Butce en güçlü scale adaylarina kaydırilabilir",
        why: `Hesap ${comparisonCohort} içinde net performans dağılımi gösteriyor; bu nedenle bütçe o kohortta esit dagitilmamali.`,
        summary: `${comparisonCohort} içinde ${bestCampaign ?? "güçlü kampanya"} ile ${weakCampaign ?? "zayıf kampanya"} arasinda belirgin fark var${laneMix ? `; lane dağılımi ${laneMix}` : ""}.`,
        recommendedAction:
          bestCampaign && weakCampaign
            ? `Butceyi ${weakCampaign} tarafından kontrollu bicimde cekip ${bestCampaign} tarafina kaydırin. Tum kohortu esit beslemek yerine güçlü kampanyalara daha fazla hacim açın.`
            : "Butceyi esit dagitmak yerine verimliligi ve hacim potansiyeli daha güçlü kampanyalara yeniden dagitin.",
        expectedImpact: "Daha temiz blended ROAS ve güçlü kampanyalarda daha hızlı öğrenme.",
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
    default:
      return {
        ...recommendation,
        evidence: localizedEvidence,
        timeframeContext: localizedTimeframe,
      };
  }
}

function localizeMetaRecommendationsResponse(
  response: MetaRecommendationsResponse,
  language: AppLanguage
): MetaRecommendationsResponse {
  if (language !== "tr") {
    return response;
  }

  return {
    ...response,
    recommendations: response.recommendations.map((recommendation) =>
      localizeMetaRecommendation(recommendation, language)
    ),
  };
}

interface MetaSeasonalContext {
  state: MetaSeasonalState;
  note: string;
  peakWindowLabel: string | null;
  selectedRoas: number;
  baselineRoas: number;
  peakRoas: number;
}

export interface MetaRecommendationWindows {
  selected: MetaCampaignRow[];
  previousSelected: MetaCampaignRow[];
  last3: MetaCampaignRow[];
  last7: MetaCampaignRow[];
  last14: MetaCampaignRow[];
  last30: MetaCampaignRow[];
  last90: MetaCampaignRow[];
  allHistory: MetaCampaignRow[];
}

interface CampaignWindowSnapshot {
  selected: MetaCampaignRow;
  previousSelected?: MetaCampaignRow;
  last3?: MetaCampaignRow;
  last7?: MetaCampaignRow;
  last14?: MetaCampaignRow;
  last30?: MetaCampaignRow;
  last90?: MetaCampaignRow;
  allHistory?: MetaCampaignRow;
}

interface WeightedCampaignSnapshot {
  roas: number;
  spend: number;
  revenue: number;
  purchases: number;
  cpa: number;
}

interface ScalingStructureSnapshot {
  family: MetaCampaignFamily;
  familyLabel: string;
  activeRows: MetaCampaignRow[];
  strongRows: MetaCampaignRow[];
  weakRows: MetaCampaignRow[];
  lowSignalRows: MetaCampaignRow[];
  laneSummary: MetaCampaignLaneFamilySummary | null;
}

interface DeploymentFamilyContext {
  family: MetaCampaignFamily;
  familyLabel: string;
  campaigns: MetaCampaignRow[];
  strongestCampaign: MetaCampaignRow | null;
  familyCreativeSummary: MetaCreativeIntelligenceSummary["byFamily"][string];
}

function r2(value: number) {
  return Math.round(value * 100) / 100;
}

function currencySymbol(currency: string | null | undefined) {
  if (currency === "TRY") return "₺";
  if (currency === "EUR") return "€";
  return "$";
}

function fmtCurrency(value: number, currency = "$") {
  return `${currency}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtRoas(value: number) {
  return `${value.toFixed(2)}x`;
}

function byId(rows: MetaCampaignRow[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function confidenceLabelFromScore(score: number): MetaRecommendationConfidence {
  if (score >= 0.7) return "high";
  if (score >= 0.55) return "medium";
  return "low";
}

function defaultConfidenceScore(confidence: MetaRecommendationConfidence) {
  if (confidence === "high") return 0.85;
  if (confidence === "medium") return 0.6;
  return 0.4;
}

export function calculateMetaStatisticalConfidence(
  input: MetaStatisticalConfidenceInput,
): MetaStatisticalConfidenceResult {
  const sampleFactor = clamp(
    input.minRequiredSample > 0 ? input.sampleSize / input.minRequiredSample : 0,
  );
  const magnitudeFactor =
    input.threshold > 0
      ? clamp(Math.abs(input.metricValue - input.threshold) / input.threshold)
      : input.metricValue > 0
        ? 1
        : 0;
  let score = clamp(0.4 + 0.3 * sampleFactor + 0.3 * magnitudeFactor);
  let reason: MetaStatisticalConfidenceResult["reason"];

  if (input.level === "campaign" && input.ageDays != null && input.ageDays < 7) {
    score = Math.min(score, 0.4);
    reason = "thin_data_watching";
  }

  if (input.severeLoser) {
    score = Math.max(score, 0.7);
    reason = "severe_loser_bypass";
  }

  const roundedScore = Math.round(score * 100) / 100;
  return {
    score: roundedScore,
    label: confidenceLabelFromScore(roundedScore),
    ...(reason ? { reason } : {}),
  };
}

function thresholdMetric(
  calibrationContext: MetaCalibrationContext | null | undefined,
  metricName: keyof MetaCalibrationThresholds["metrics"],
): MetaMetricPercentiles {
  return calibrationContext?.thresholds.metrics[metricName] ??
    LEGACY_META_CALIBRATION_THRESHOLDS.metrics[metricName];
}

function hardCutSpend(calibrationContext: MetaCalibrationContext | null | undefined) {
  return calibrationContext?.thresholds.hardCutSpend ??
    LEGACY_META_CALIBRATION_THRESHOLDS.hardCutSpend;
}

function commercialTargetEvidence(
  targets: MetaCommercialTargets | null | undefined,
  currency: string | null | undefined,
): MetaRecommendationEvidence[] {
  const items: MetaRecommendationEvidence[] = [];
  if (targets?.targetRoas) {
    items.push({ label: "Target ROAS", value: fmtRoas(targets.targetRoas), tone: "neutral" });
  }
  if (targets?.breakEvenRoas) {
    items.push({ label: "Break-even ROAS", value: fmtRoas(targets.breakEvenRoas), tone: "neutral" });
  }
  if (targets?.breakEvenCpa) {
    items.push({ label: "Break-even CPA", value: fmtCurrency(targets.breakEvenCpa, currency ?? "$"), tone: "neutral" });
  } else if (targets?.targetCpa) {
    items.push({ label: "Target CPA", value: fmtCurrency(targets.targetCpa, currency ?? "$"), tone: "neutral" });
  }
  return items;
}

function minRequiredSample(calibrationContext: MetaCalibrationContext | null | undefined) {
  return calibrationContext?.thresholds.minRequiredSample ??
    LEGACY_META_CALIBRATION_THRESHOLDS.minRequiredSample;
}

function campaignAgeDays(row: MetaCampaignRow) {
  const candidate = row as MetaCampaignRow & {
    ageDays?: unknown;
    firstSeenAt?: unknown;
    firstSpendAt?: unknown;
    launchDate?: unknown;
  };
  if (typeof candidate.ageDays === "number" && Number.isFinite(candidate.ageDays)) {
    return candidate.ageDays;
  }
  const dateValue = candidate.firstSpendAt ?? candidate.firstSeenAt ?? candidate.launchDate;
  if (typeof dateValue !== "string") return null;
  const parsed = new Date(dateValue);
  if (!Number.isFinite(parsed.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 86_400_000));
}

function applyConfidence(
  recommendation: MetaRecommendation,
  result: MetaStatisticalConfidenceResult,
): MetaRecommendation {
  return {
    ...recommendation,
    confidence: result.label,
    confidenceScore: result.score,
    confidenceReason: result.reason ?? recommendation.confidenceReason ?? null,
    ...(result.reason === "thin_data_watching"
      ? { decisionState: "watch" as const }
      : {}),
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
  };
}

function stampRecommendation(recommendation: MetaRecommendation): MetaRecommendation {
  const stamped = {
    ...recommendation,
    confidenceScore:
      typeof recommendation.confidenceScore === "number"
        ? recommendation.confidenceScore
        : defaultConfidenceScore(recommendation.confidence),
    confidenceReason: recommendation.confidenceReason ?? null,
    engineVersion: recommendation.engineVersion ?? META_RECOMMENDATION_ENGINE_VERSION,
  };
  return {
    ...stamped,
    automationReadiness: deriveMetaAutomationReadiness(stamped, {
      empiricalOutcomeSummary: stamped.empiricalOutcomeSummary ?? null,
    }),
  };
}

export function empiricalOutcomeSummaryKeyForMetaRecommendation(
  recommendation: MetaRecommendation,
  options: { fallback?: boolean } = {},
) {
  return metaEmpiricalOutcomeSummaryKey({
    recType: recommendation.type,
    decisionLabel: options.fallback ? null : decisionLabelForMetaRec(recommendation),
  });
}

export function attachMetaEmpiricalOutcomeSummariesToRecommendations(
  recommendations: MetaRecommendation[],
  summariesByKey: Record<string, MetaEmpiricalOutcomeSummary | undefined>,
) {
  return recommendations.map((recommendation) => {
    const exactKey = empiricalOutcomeSummaryKeyForMetaRecommendation(recommendation);
    const fallbackKey = empiricalOutcomeSummaryKeyForMetaRecommendation(recommendation, {
      fallback: true,
    });
    const summary =
      (exactKey ? summariesByKey[exactKey] : undefined) ??
      (fallbackKey ? summariesByKey[fallbackKey] : undefined) ??
      null;
    if (!summary) return recommendation;

    const enriched: MetaRecommendation = {
      ...recommendation,
      empiricalOutcomeSummary: summary,
      signalQuality: {
        ...(recommendation.signalQuality ?? {}),
        empirical_outcome_key: exactKey ?? fallbackKey,
        empirical_outcome_summary: summary,
      },
    };
    return {
      ...enriched,
      automationReadiness: deriveMetaAutomationReadiness(enriched, {
        empiricalOutcomeSummary: summary,
      }),
    };
  });
}

interface MetaRecommendationTaxonomyContext {
  campaigns: MetaCampaignRow[];
  campaignsById: Map<string, MetaCampaignRow>;
  laneSignals: Map<string, MetaCampaignLaneSignal>;
}

function buildRecommendationTaxonomyContext(
  campaigns: MetaCampaignRow[],
): MetaRecommendationTaxonomyContext {
  return {
    campaigns,
    campaignsById: new Map(campaigns.map((campaign) => [campaign.id, campaign])),
    laneSignals: buildMetaCampaignLaneSignals(campaigns),
  };
}

function enrichRecommendationTaxonomy(
  recommendation: MetaRecommendation,
  context: MetaRecommendationTaxonomyContext,
): MetaRecommendation {
  if (recommendation.level !== "campaign" && recommendation.level !== "adset") {
    return recommendation;
  }
  const campaignId = recommendation.campaignId;
  if (!campaignId) return recommendation;
  const campaign = context.campaignsById.get(campaignId);
  if (!campaign) return recommendation;

  return {
    ...recommendation,
    campaignRole:
      recommendation.campaignRole ??
      inferCampaignRole(campaign, {
        campaigns: context.campaigns,
        laneSignals: context.laneSignals,
      }),
    bidRegime:
      recommendation.bidRegime ??
      inferBidRegime(null, campaign),
    cohort:
      recommendation.cohort ??
      resolveMetaFunnelCohort({
        optimizationGoal: campaign.optimizationGoal,
        customEventType: campaign.customEventType,
      }),
  };
}

function isActiveCampaign(row: MetaCampaignRow) {
  return row.status === "ACTIVE";
}

function campaignFunnelCohort(
  row: Pick<MetaCampaignRow, "optimizationGoal" | "customEventType" | "objective" | "purchases" | "revenue">,
) {
  return resolveMetaFunnelCohort({
    optimizationGoal: row.optimizationGoal,
    customEventType: row.customEventType,
    objective: row.objective,
    purchases: row.purchases,
    revenue: row.revenue,
  });
}

function filterPurchaseObjectiveRows(rows: MetaCampaignRow[]) {
  return rows.filter((row) => isPurchaseCohort(campaignFunnelCohort(row)));
}

function buildPurchaseDownshiftScenarioRecommendations(input: {
  windows: CampaignWindowSnapshot[];
  selectedRows: MetaCampaignRow[];
  calibrationContext?: MetaCalibrationContext | null;
  calibrationContextByCampaignId?: Record<string, MetaCalibrationContext | null | undefined>;
  entitySignalsByCampaignId?: Record<string, MetaEntityDecisionSignal | null | undefined>;
  commercialTargets?: MetaCommercialTargets | null;
}): MetaRecommendation[] {
  const taxonomyContext = buildRecommendationTaxonomyContext(input.selectedRows);
  const recommendations: MetaRecommendation[] = [];
  for (const campaignWindow of input.windows) {
    const calibrationContext =
      input.calibrationContextByCampaignId?.[campaignWindow.selected.id] ??
      input.calibrationContext ??
      null;
    const campaignRole = inferCampaignRole(campaignWindow.selected, {
      campaigns: input.selectedRows,
      laneSignals: taxonomyContext.laneSignals,
    });
    const scenario = maybeG2DownshiftToPurchase({
      window: campaignWindow,
      context: calibrationContext,
      cohort: campaignFunnelCohort(campaignWindow.selected),
      campaignRole,
      bidRegime: inferBidRegime(null, campaignWindow.selected),
      signals: input.entitySignalsByCampaignId?.[campaignWindow.selected.id] ?? null,
      commercialTargets: input.commercialTargets ?? null,
    });
    if (scenario) recommendations.push(scenario);
  }
  return recommendations;
}

function comparablePeerRows(selectedRows: MetaCampaignRow[], row: MetaCampaignRow) {
  const key = comparableMetaIntentKey(row);
  return selectedRows.filter((candidate) => comparableMetaIntentKey(candidate) === key);
}

function buildScalingStructureSnapshot(windows: CampaignWindowSnapshot[]): ScalingStructureSnapshot | null {
  const grouped = new Map<MetaCampaignFamily, Array<{ row: MetaCampaignRow; core: WeightedCampaignSnapshot }>>();
  const selectedRows = windows.map((window) => window.selected);
  const laneSummaries = buildMetaCampaignLaneSummary(selectedRows);
  for (const window of windows) {
    const row = window.selected;
    const family = resolveMetaCampaignFamily(row);
    if (!isScalingCampaignFamily(family) || !isActiveCampaign(row)) continue;
    const core = buildWeightedCampaignSnapshot(window);
    grouped.set(family, [...(grouped.get(family) ?? []), { row, core }]);
  }

  const candidates = [...grouped.entries()]
    .map(([family, entries]) => {
      const avgRoas = average(entries.map(({ core }) => core.roas).filter((value) => value > 0));
      const avgSpend = average(entries.map(({ core }) => core.spend).filter((value) => value > 0));
      const strongRows = entries
        .filter(({ core }) => core.purchases >= 10 && core.roas >= Math.max(avgRoas * 1.1, 2))
        .map(({ row }) => row);
      const weakRows = entries
        .filter(({ core }) => core.purchases >= 0 && core.roas <= Math.max(avgRoas * 0.75, 1.5))
        .map(({ row }) => row);
      const lowSignalRows = entries
        .filter(({ core }) => core.purchases < 8 || core.spend <= Math.max(avgSpend * 0.75, 0))
        .map(({ row }) => row);
      return {
        family,
        familyLabel: metaCampaignFamilyLabel(family),
        activeRows: entries.map(({ row }) => row),
        strongRows,
        weakRows,
        lowSignalRows,
        laneSummary: laneSummaries.get(family) ?? null,
        score:
          strongRows.length * 3 +
          lowSignalRows.length * 2 +
          weakRows.length +
          (laneSummaries.get(family)?.validationCount ?? 0),
      };
    })
    .filter((candidate) => candidate.activeRows.length >= 2)
    .sort((a, b) => b.score - a.score);

  return candidates[0] ?? null;
}

function buildDeploymentFamilyContext(
  selectedRows: MetaCampaignRow[],
  creativeIntelligence: MetaCreativeIntelligenceSummary | null | undefined
): DeploymentFamilyContext | null {
  if (!creativeIntelligence) return null;

  const grouped = new Map<MetaCampaignFamily, MetaCampaignRow[]>();
  for (const row of selectedRows) {
    const family = resolveMetaCampaignFamily(row);
    if (!isScalingCampaignFamily(family) || !isActiveCampaign(row)) continue;
    grouped.set(family, [...(grouped.get(family) ?? []), row]);
  }

  const candidates = [...grouped.entries()]
    .map(([family, campaigns]) => {
      const familyCreativeSummary = creativeIntelligence.byFamily[family];
      if (!familyCreativeSummary) return null;
      const score =
        familyCreativeSummary.scalingReadyNames.length * 3 +
        familyCreativeSummary.keepTestingNames.length * 2 +
        familyCreativeSummary.doNotDeployNames.length +
        campaigns.length;
      if (score === 0) return null;
      return {
        family,
        familyLabel: metaCampaignFamilyLabel(family),
        campaigns,
        strongestCampaign: [...campaigns].sort((a, b) => b.roas - a.roas)[0] ?? null,
        familyCreativeSummary,
        score,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((a, b) => b.score - a.score);

  return candidates[0] ?? null;
}

function maybeGeoClusterRecommendation(
  breakdowns: MetaBreakdownsResponse | null,
  structureSnapshot: ScalingStructureSnapshot | null,
  creativeIntelligence: MetaCreativeIntelligenceSummary | null | undefined
): MetaRecommendation | null {
  const locationRows = breakdowns?.location?.filter((row) => row.spend > 0) ?? [];
  if (locationRows.length < 4) return null;

  const totalSpend = locationRows.reduce((sum, row) => sum + row.spend, 0);
  if (totalSpend <= 0) return null;
  const enrichedRows = locationRows.map((row) => ({
    ...row,
    roas: row.spend > 0 ? row.revenue / row.spend : 0,
    spendShare: row.spend / totalSpend,
  }));
  const avgRoas = average(enrichedRows.map((row) => row.roas).filter((value) => value > 0));
  const topTwo = enrichedRows.slice(0, 2);
  const topTwoShare = topTwo.reduce((sum, row) => sum + row.spend, 0) / totalSpend;
  const matureRows = enrichedRows.filter(
    (row) => row.purchases >= 5 && row.roas >= Math.max(avgRoas * 0.9, 1.6)
  );
  const thinSignalRows = enrichedRows.filter(
    (row) => row.purchases < 3 || (row.spendShare < 0.12 && row.roas < Math.max(avgRoas * 0.75, 1.2))
  );
  const thinSignalSpend = thinSignalRows.reduce((sum, row) => sum + row.spend, 0);
  const thinSignalShare = thinSignalSpend / totalSpend;
  if (thinSignalRows.length < 3 || thinSignalShare < 0.2) return null;

  const familyLabel = structureSnapshot?.familyLabel ?? "conversion";
  const strongestCountry = topTwo[0]?.label ?? "top market";
  const pooledCountries = thinSignalRows.length;
  const scalingGeoCluster = matureRows.slice(0, 3).map((row) => row.label);
  const testingGeoCluster = thinSignalRows.slice(0, 5).map((row) => row.label);
  const matureGeoSplit = topTwoShare >= 0.6 ? topTwo.map((row) => row.label) : [];
  const familyCreativeSummary =
    structureSnapshot ? creativeIntelligence?.byFamily[structureSnapshot.family] ?? null : null;
  const scalingCreatives = familyCreativeSummary?.scalingReadyNames?.slice(0, 3) ?? [];
  const testCreatives = familyCreativeSummary?.keepTestingNames?.slice(0, 3) ?? [];

  return {
    id: "geo-cluster-for-signal-density",
    level: "account",
    type: "geo_cluster_for_signal_density",
    lens: "structure",
    priority: "high",
    confidence: topTwoShare >= 0.6 ? "high" : "medium",
    decisionState: "act",
    decision: "Cluster weak-signal countries instead of fragmenting them",
    title: "Geo signal is too thin across secondary markets",
    why: "Country-level signal is fragmented. Too many markets are spending without enough conversion depth to justify isolated scaling learning.",
    summary: `${pooledCountries} countries are still below meaningful conversion depth while ${matureRows.length > 0 ? `${matureRows.length} mature market${matureRows.length === 1 ? "" : "s"} already show cleaner purchase economics` : "top markets already absorb most spend"}.`,
    recommendedAction:
      topTwoShare >= 0.6
        ? `Keep ${strongestCountry}${topTwo[1] ? ` and ${topTwo[1].label}` : ""} as mature ${familyLabel} scaling geos${scalingCreatives.length > 0 ? ` for creatives like ${scalingCreatives.join(", ")}` : ""}, and pool ${testingGeoCluster.join(", ")} into one shared TEST geo cluster${testCreatives.length > 0 ? ` for exploratory creatives like ${testCreatives.join(", ")}` : ""}.`
        : `Group low-volume countries like ${testingGeoCluster.join(", ")} into a clustered ${familyLabel} TEST geo until conversion signal is denser${scalingGeoCluster.length > 0 ? `, then keep stronger geos like ${scalingGeoCluster.join(", ")} in scaling` : ""}.`,
    expectedImpact: "Stronger learning density, fewer under-informed geo decisions, and cleaner creative validation in smaller markets.",
    evidence: [
      { label: "Thin-signal countries", value: `${thinSignalRows.length}`, tone: "warning" },
      { label: "Thin-signal spend share", value: `${r2(thinSignalShare * 100)}%`, tone: "warning" },
      { label: "Top-2 country share", value: `${r2(topTwoShare * 100)}%`, tone: "neutral" },
      ...(matureRows.length > 0
        ? [{ label: "Scaling geos", value: `${matureRows.length}`, tone: "positive" as const }]
        : []),
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict says country-level signal is too fragmented for reliable decisioning.",
      "Selected range currently shows spend spread across too many weak-signal markets.",
      "Recommendation is based on current country conversion density, not placement behavior.",
      "none",
      null
    ),
    strategyLayer: "structure",
    comparisonCohort: familyLabel,
    scalingGeoCluster,
    testingGeoCluster,
    matureGeoSplit,
    promoteCreatives: scalingCreatives,
    keepTestingCreatives: testCreatives,
  };
}

function maybeScalingStructureRecommendation(
  structureSnapshot: ScalingStructureSnapshot | null,
  seasonalContext: MetaSeasonalContext,
  creativeIntelligence: MetaCreativeIntelligenceSummary | null | undefined
): MetaRecommendation | null {
  if (!structureSnapshot) return null;
  if (structureSnapshot.strongRows.length === 0 || structureSnapshot.lowSignalRows.length < 2) return null;

  const scalingCreativeWinners = structureSnapshot.strongRows.reduce(
    (sum, row) => sum + (creativeIntelligence?.byCampaignId[row.id]?.stableScalingCount ?? 0),
    0
  );
  const lowSignalCreativeTests = structureSnapshot.lowSignalRows.reduce(
    (sum, row) => sum + (creativeIntelligence?.byCampaignId[row.id]?.testOnlyCount ?? 0),
    0
  );
  const familyCreativeSummary = creativeIntelligence?.byFamily[structureSnapshot.family] ?? null;
  const familyWinnerNames = familyCreativeSummary?.topWinnerNames?.slice(0, 3) ?? [];
  const scalingReadyNames = familyCreativeSummary?.scalingReadyNames?.slice(0, 4) ?? [];
  const keepTestingNames = familyCreativeSummary?.keepTestingNames?.slice(0, 4) ?? [];
  const scalingLaneCount = structureSnapshot.laneSummary?.scalingCount ?? structureSnapshot.strongRows.length;
  const validationLaneCount = structureSnapshot.laneSummary?.validationCount ?? 0;
  const testLaneCount = structureSnapshot.laneSummary?.testCount ?? structureSnapshot.lowSignalRows.length;
  const decisionState: MetaDecisionState =
    seasonalContext.state === "peak" || scalingCreativeWinners === 0 ? "test" : "act";
  const confidence: MetaRecommendationConfidence =
    scalingLaneCount >= 2 && scalingCreativeWinners >= 2 ? "high" : "medium";
  const priority: MetaRecommendationPriority =
    lowSignalCreativeTests >= 3 || testLaneCount >= 2 ? "high" : "medium";

  return {
    id: "scaling-structure-fit",
    level: "account",
    type: "scaling_structure_fit",
    lens: "structure",
    priority,
    confidence,
    decisionState,
    decision: "Separate scaling campaigns from test campaigns",
    title: "Scaling and testing should not live in the same operating layer",
    why: "The account already has campaigns with real conversion proof, while other campaigns still lack enough signal. Running both with the same scaling expectations muddies budget and learning decisions.",
    summary: `The ${structureSnapshot.familyLabel} family has ${scalingLaneCount} scaling lane${scalingLaneCount === 1 ? "" : "s"}, ${validationLaneCount} validation lane${validationLaneCount === 1 ? "" : "s"}, and ${testLaneCount} test lane${testLaneCount === 1 ? "" : "s"}${
      scalingCreativeWinners > 0 ? `, with ${scalingCreativeWinners} stable scaling creative${scalingCreativeWinners === 1 ? "" : "s"} already proven inside scaling lanes` : ""
    }.`,
    recommendedAction:
      lowSignalCreativeTests > 0
        ? `Keep proven ${structureSnapshot.familyLabel} campaigns as scaling lanes, source scaling creative decisions from the ${scalingCreativeWinners || "existing"} stable winner pool${
            familyWinnerNames.length > 0 ? ` (${familyWinnerNames.join(", ")})` : ""
          }, and move ${lowSignalCreativeTests} test-only creative${lowSignalCreativeTests === 1 ? "" : "s"} into a separate TEST structure.`
        : `Keep proven ${structureSnapshot.familyLabel} campaigns as scaling lanes${
            familyWinnerNames.length > 0 ? ` and keep scaling sourced from winners like ${familyWinnerNames.join(", ")}` : ""
          }, then move low-signal launches into a separate TEST structure until they show enough conversion depth.`,
    expectedImpact: "Cleaner scaling, cleaner testing feedback loops, and fewer false budget cuts on exploratory setups.",
    evidence: [
      { label: "Scaling lanes", value: `${scalingLaneCount}`, tone: "positive" },
      { label: "Validation lanes", value: `${validationLaneCount}`, tone: "neutral" },
      { label: "Test lanes", value: `${testLaneCount}`, tone: "warning" },
      ...(scalingCreativeWinners > 0
        ? [{ label: "Stable scaling creatives", value: `${scalingCreativeWinners}`, tone: "positive" as const }]
        : []),
      ...(familyWinnerNames.length > 0
        ? [{ label: "Top creative lane", value: familyWinnerNames.join(", "), tone: "neutral" as const }]
        : []),
      { label: "Compared within", value: structureSnapshot.familyLabel, tone: "neutral" },
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict says mature scaling lanes and low-signal exploration lanes should not share the same operating layer.",
      "Selected range currently shows a mix of mature and immature campaigns inside the same operating family.",
      "Recommendation is reinforced by campaign-level conversion depth and relative efficiency inside the same family.",
      seasonalContext.state === "peak" ? "possible" : "none",
      seasonalContext.state === "peak" ? "If demand is still peaking, validate structural separation with controlled testing rather than a full overnight reset." : null
    ),
    strategyLayer: "structure",
    comparisonCohort: structureSnapshot.familyLabel,
    promoteCreatives: scalingReadyNames,
    keepTestingCreatives: keepTestingNames,
    targetScalingLane: scalingLaneCount > 0 ? `${structureSnapshot.familyLabel} scaling lanes` : null,
  };
}

function maybeCreativeTestStructureRecommendation(
  structureSnapshot: ScalingStructureSnapshot | null,
  geoRecommendation: MetaRecommendation | null,
  creativeIntelligence: MetaCreativeIntelligenceSummary | null | undefined
): MetaRecommendation | null {
  if (!structureSnapshot) return null;
  if (structureSnapshot.lowSignalRows.length < 2) return null;

  const testOnlyCreatives = structureSnapshot.lowSignalRows.reduce(
    (sum, row) => sum + (creativeIntelligence?.byCampaignId[row.id]?.testOnlyCount ?? 0),
    0
  );
  const blockedCreatives = structureSnapshot.lowSignalRows.reduce(
    (sum, row) => sum + (creativeIntelligence?.byCampaignId[row.id]?.blockedCount ?? 0),
    0
  );
  const weakCreativeNames = structureSnapshot.lowSignalRows
    .flatMap((row) => creativeIntelligence?.byCampaignId[row.id]?.topTestOnlyNames ?? [])
    .slice(0, 2);
  const familyCreativeSummary = creativeIntelligence?.byFamily[structureSnapshot.family] ?? null;
  const keepTestingNames = familyCreativeSummary?.keepTestingNames?.slice(0, 4) ?? [];
  const doNotDeployNames = familyCreativeSummary?.doNotDeployNames?.slice(0, 4) ?? [];
  const confidence: MetaRecommendationConfidence =
    testOnlyCreatives >= 2 || blockedCreatives >= 2 ? "high" : "medium";
  const priority: MetaRecommendationPriority =
    blockedCreatives > 0 || testOnlyCreatives >= 3 ? "high" : "medium";
  const validationLaneCount = structureSnapshot.laneSummary?.validationCount ?? 0;
  const testLaneCount = structureSnapshot.laneSummary?.testCount ?? structureSnapshot.lowSignalRows.length;

  return {
    id: "creative-test-structure",
    level: "account",
    type: "creative_test_structure",
    lens: "structure",
    priority,
    confidence,
    decisionState: "act",
    decision: "Use one pooled creative test lane for weak-signal campaigns",
    title: "Creative testing needs its own pooled structure",
    why: "When campaigns still have thin conversion depth, creative decisions should be made in a pooled test environment rather than scattered across multiple small scaling campaigns.",
    summary: `${testLaneCount} TEST lane${testLaneCount === 1 ? "" : "s"} inside ${structureSnapshot.familyLabel} should not each carry their own creative discovery burden${
      testOnlyCreatives > 0 ? `, especially with ${testOnlyCreatives} test-only creative${testOnlyCreatives === 1 ? "" : "s"} still unresolved` : ""
    }.`,
    recommendedAction: geoRecommendation
      ? `Create one pooled TEST campaign for exploratory creatives${testOnlyCreatives > 0 ? ` (${testOnlyCreatives} currently test-only)` : ""}, especially across clustered secondary countries, and keep scaling lanes limited to stable winner creatives.`
      : `Create one pooled TEST campaign where each ad set can carry 4-5 exploratory creatives until clear winners emerge${weakCreativeNames.length > 0 ? `, and keep experimental assets like ${weakCreativeNames.join(", ")} out of scaling for now` : ""}.`,
    expectedImpact: "Faster creative learning and less scaling budget wasted on unproven creative combinations.",
    evidence: [
      { label: "Test lanes", value: `${testLaneCount}`, tone: "warning" },
      { label: "Validation lanes", value: `${validationLaneCount}`, tone: "neutral" },
      ...(testOnlyCreatives > 0
        ? [{ label: "Test-only creatives", value: `${testOnlyCreatives}`, tone: "warning" as const }]
        : []),
      ...(blockedCreatives > 0
        ? [{ label: "Blocked creatives", value: `${blockedCreatives}`, tone: "warning" as const }]
        : []),
      { label: "Strong campaigns", value: `${structureSnapshot.strongRows.length}`, tone: "positive" },
      { label: "Structure", value: "Separate TEST from scaling", tone: "neutral" },
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict says part of the current campaign set still lacks enough conversion depth for clean scaling decisioning.",
      "Selected range currently shows insufficient conversion depth in part of the current campaign set.",
      "Recommendation favors pooled testing until creative confidence is high enough for scaling rollout.",
      "none",
      null
    ),
    strategyLayer: "structure",
    comparisonCohort: structureSnapshot.familyLabel,
    keepTestingCreatives: keepTestingNames,
    doNotDeployCreatives: doNotDeployNames,
  };
}

function maybeWinnerPromotionRecommendation(
  structureSnapshot: ScalingStructureSnapshot | null,
  creativeIntelligence: MetaCreativeIntelligenceSummary | null | undefined
): MetaRecommendation | null {
  if (!structureSnapshot) return null;
  if (structureSnapshot.strongRows.length === 0 || structureSnapshot.lowSignalRows.length === 0) return null;

  const strongest = [...structureSnapshot.strongRows].sort((a, b) => b.roas - a.roas)[0];
  const strongestCreativeSummary = strongest ? creativeIntelligence?.byCampaignId[strongest.id] : null;
  const strongestWinnerCount = strongestCreativeSummary?.stableScalingCount ?? 0;
  const winnerNames = strongestCreativeSummary?.topStableWinnerNames?.slice(0, 2) ?? [];
  const familyCreativeSummary = creativeIntelligence?.byFamily[structureSnapshot.family] ?? null;
  const familyTestOnlyCount = familyCreativeSummary?.testOnlyCount ?? 0;
  const familyFatiguedCount = familyCreativeSummary?.fatiguedCount ?? 0;
  const promoteNames = familyCreativeSummary?.scalingReadyNames?.slice(0, 4) ?? winnerNames;
  const keepTestingNames = familyCreativeSummary?.keepTestingNames?.slice(0, 4) ?? [];
  const doNotDeployNames = familyCreativeSummary?.doNotDeployNames?.slice(0, 4) ?? [];
  const scalingLaneCount = structureSnapshot.laneSummary?.scalingCount ?? structureSnapshot.strongRows.length;
  const validationLaneCount = structureSnapshot.laneSummary?.validationCount ?? 0;
  const decisionState: MetaDecisionState = strongestWinnerCount > 0 ? "act" : "test";
  const confidence: MetaRecommendationConfidence = strongestWinnerCount >= 2 ? "high" : "medium";
  const priority: MetaRecommendationPriority =
    familyTestOnlyCount > 0 || familyFatiguedCount > 0 ? "high" : "medium";
  return {
    id: "winner-promotion-flow",
    level: "account",
    type: "winner_promotion_flow",
    lens: "volume",
    priority,
    confidence,
    decisionState,
    decision: "Promote proven creatives into scaling and keep discovery isolated",
    title: "Scaling campaigns should inherit winners, not learn from scratch",
    why: "Once a campaign family already has a proven scaling lane, the next step is to promote validated creative patterns there instead of asking every smaller campaign to rediscover winners independently.",
    summary: `${strongest?.name ?? "Top-performing campaigns"} already defines one of ${scalingLaneCount} scaling lane${scalingLaneCount === 1 ? "" : "s"} inside the ${structureSnapshot.familyLabel} family${
      strongestWinnerCount > 0 ? `, with ${strongestWinnerCount} stable winner creative${strongestWinnerCount === 1 ? "" : "s"} available for promotion` : ""
    }.`,
    recommendedAction:
      promoteNames.length > 0
        ? `Promote creatives such as ${promoteNames.join(", ")} into ${strongest?.name ?? "the strongest scaling campaign"} first, keep ${familyTestOnlyCount > 0 ? `${familyTestOnlyCount} test-only creatives` : "remaining exploratory creatives"} in the separate TEST lane, and${familyFatiguedCount > 0 ? ` replace ${familyFatiguedCount} fatigued creative${familyFatiguedCount === 1 ? "" : "s"}` : " leave blocked ideas out of scaling until they re-qualify"}.`
        : `Use the best-performing creative patterns from ${strongest?.name ?? "the strongest scaling campaign"} as the first source for scaling rollout, and keep weak-signal creative exploration inside the separate TEST lane.`,
    expectedImpact: "Faster scale on proven messages and less duplication of creative testing effort.",
    evidence: [
      { label: "Best scaling lane", value: strongest ? `${strongest.name} · ${fmtRoas(strongest.roas)}` : "—", tone: "positive" },
      ...(strongestWinnerCount > 0
        ? [{ label: "Stable winner creatives", value: `${strongestWinnerCount}`, tone: "positive" as const }]
        : []),
      ...(familyTestOnlyCount > 0
        ? [{ label: "Test-only queue", value: `${familyTestOnlyCount}`, tone: "warning" as const }]
        : []),
      ...(familyFatiguedCount > 0
        ? [{ label: "Fatigued creatives", value: `${familyFatiguedCount}`, tone: "warning" as const }]
        : []),
      { label: "Validation lanes", value: `${validationLaneCount}`, tone: "neutral" },
      { label: "Low-signal campaigns", value: `${structureSnapshot.lowSignalRows.length}`, tone: "warning" },
      { label: "Compared within", value: structureSnapshot.familyLabel, tone: "neutral" },
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict says a stronger scaling lane already exists inside this family.",
      "Selected range currently shows that scaling lane outperforming the rest of the family.",
      "Recommendation assumes creative promotion should follow proven scaling economics, while discovery remains isolated in test.",
      "none",
      null
    ),
    strategyLayer: "scaling",
    comparisonCohort: structureSnapshot.familyLabel,
    promoteCreatives: promoteNames,
    keepTestingCreatives: keepTestingNames,
    doNotDeployCreatives: doNotDeployNames,
    targetScalingLane: strongest?.name ?? null,
  };
}

function maybeFallbackScalingStructureRecommendation(
  selectedRows: MetaCampaignRow[],
  seasonalContext: MetaSeasonalContext,
  creativeIntelligence: MetaCreativeIntelligenceSummary | null | undefined
): MetaRecommendation | null {
  const context = buildDeploymentFamilyContext(selectedRows, creativeIntelligence);
  if (!context) return null;
  if (context.familyCreativeSummary.scalingReadyNames.length === 0 || context.familyCreativeSummary.keepTestingNames.length === 0) {
    return null;
  }

  return {
    id: "scaling-structure-fit-fallback",
    level: "account",
    type: "scaling_structure_fit",
    lens: "structure",
    priority: "medium",
    confidence: context.familyCreativeSummary.scalingReadyNames.length >= 2 ? "high" : "medium",
    decisionState: seasonalContext.state === "peak" ? "test" : "act",
    decision: "Keep scaling deployment separate from creative testing",
    title: "Scaling deployment should stay separate from creative testing",
    why: "Even with a single mature scaling lane, creative deployment works better when proven assets scale there and exploratory assets stay in TEST.",
    summary: `${context.familyLabel} already has a deployable creative pool, but creative discovery still needs a separate TEST path.`,
    recommendedAction: `Use ${context.strongestCampaign?.name ?? "the strongest current campaign"} as the primary ${context.familyLabel} scaling lane for creatives like ${context.familyCreativeSummary.scalingReadyNames.slice(0, 3).join(", ")}, and keep ${context.familyCreativeSummary.keepTestingNames.slice(0, 3).join(", ")} in TEST until confidence improves.`,
    expectedImpact: "Cleaner scaling decisions even when the account only has one obvious scaling lane today.",
    evidence: [
      { label: "Scaling-ready creatives", value: `${context.familyCreativeSummary.scalingReadyNames.length}`, tone: "positive" },
      { label: "Keep in TEST", value: `${context.familyCreativeSummary.keepTestingNames.length}`, tone: "warning" },
      { label: "Compared within", value: context.familyLabel, tone: "neutral" },
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict says creative deployment and creative discovery should stay separated even if the family currently has only one clear scaling lane.",
      "Selected range is the current operational view, not the sole reason for the deployment split.",
      "Historical creative state is used to decide what is scaling-ready versus still exploratory.",
      seasonalContext.state === "peak" ? "possible" : "none",
      null
    ),
    strategyLayer: "structure",
    comparisonCohort: context.familyLabel,
    promoteCreatives: context.familyCreativeSummary.scalingReadyNames.slice(0, 4),
    keepTestingCreatives: context.familyCreativeSummary.keepTestingNames.slice(0, 4),
    doNotDeployCreatives: context.familyCreativeSummary.doNotDeployNames.slice(0, 4),
    targetScalingLane: context.strongestCampaign?.name ?? null,
  };
}

function maybeFallbackCreativeTestStructureRecommendation(
  selectedRows: MetaCampaignRow[],
  creativeIntelligence: MetaCreativeIntelligenceSummary | null | undefined
): MetaRecommendation | null {
  const context = buildDeploymentFamilyContext(selectedRows, creativeIntelligence);
  if (!context) return null;
  if (
    context.familyCreativeSummary.keepTestingNames.length === 0 &&
    context.familyCreativeSummary.doNotDeployNames.length === 0
  ) {
    return null;
  }

  return {
    id: "creative-test-structure-fallback",
    level: "account",
    type: "creative_test_structure",
    lens: "structure",
    priority: "medium",
    confidence: context.familyCreativeSummary.doNotDeployNames.length > 0 ? "high" : "medium",
    decisionState: "act",
    decision: "Keep exploratory creatives in TEST until they qualify for scaling",
    title: "Creative deployment still needs a TEST queue",
    why: "Some creatives are still exploratory or blocked, so they should not be pushed into the current scaling lane yet.",
    summary: `${context.familyCreativeSummary.keepTestingNames.length} creative${context.familyCreativeSummary.keepTestingNames.length === 1 ? "" : "s"} still belong in TEST and ${context.familyCreativeSummary.doNotDeployNames.length} should stay out of scaling for now.`,
    recommendedAction: `Keep ${context.familyCreativeSummary.keepTestingNames.slice(0, 4).join(", ") || "exploratory creatives"} in a pooled TEST campaign, and leave ${context.familyCreativeSummary.doNotDeployNames.slice(0, 4).join(", ") || "blocked ideas"} out of scaling until they re-qualify.`,
    expectedImpact: "Less contamination of scaling performance with low-confidence or blocked creative decisions.",
    evidence: [
      { label: "Keep in TEST", value: `${context.familyCreativeSummary.keepTestingNames.length}`, tone: "warning" },
      { label: "Keep out of scaling", value: `${context.familyCreativeSummary.doNotDeployNames.length}`, tone: "warning" },
      { label: "Compared within", value: context.familyLabel, tone: "neutral" },
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict uses creative lifecycle state, not jüst current campaign count, to decide what still belongs in TEST.",
      "Selected range is the current snapshot of creative behavior.",
      "Historical creative states reinforce which assets are still exploratory or blocked.",
      "none",
      null
    ),
    strategyLayer: "structure",
    comparisonCohort: context.familyLabel,
    keepTestingCreatives: context.familyCreativeSummary.keepTestingNames.slice(0, 4),
    doNotDeployCreatives: context.familyCreativeSummary.doNotDeployNames.slice(0, 4),
  };
}

function maybeFallbackWinnerPromotionRecommendation(
  selectedRows: MetaCampaignRow[],
  creativeIntelligence: MetaCreativeIntelligenceSummary | null | undefined
): MetaRecommendation | null {
  const context = buildDeploymentFamilyContext(selectedRows, creativeIntelligence);
  if (!context) return null;
  if (context.familyCreativeSummary.scalingReadyNames.length === 0) return null;

  return {
    id: "winner-promotion-flow-fallback",
    level: "account",
    type: "winner_promotion_flow",
    lens: "volume",
    priority: "medium",
    confidence: context.familyCreativeSummary.scalingReadyNames.length >= 2 ? "high" : "medium",
    decisionState: "act",
    decision: "Promote scaling-ready creatives into the current scaling lane",
    title: "Current scaling lane already has creatives ready for promotion",
    why: "You do not need multiple scaling campaigns before making creative deployment decisions. One mature lane is enough to start promoting winners.",
    summary: `${context.strongestCampaign?.name ?? "The strongest campaign"} can already absorb proven creatives from the current ${context.familyLabel} winner pool.`,
    recommendedAction: `Promote ${context.familyCreativeSummary.scalingReadyNames.slice(0, 4).join(", ")} into ${context.strongestCampaign?.name ?? "the strongest scaling lane"} first, keep ${context.familyCreativeSummary.keepTestingNames.slice(0, 3).join(", ") || "exploratory creatives"} in TEST, and leave ${context.familyCreativeSummary.doNotDeployNames.slice(0, 3).join(", ") || "blocked creatives"} out of scaling.`,
    expectedImpact: "Faster deployment of real winners without waiting for the account to build multiple mature scaling lanes.",
    evidence: [
      { label: "Scaling-ready creatives", value: `${context.familyCreativeSummary.scalingReadyNames.length}`, tone: "positive" },
      { label: "Target scaling lane", value: context.strongestCampaign?.name ?? "—", tone: "neutral" },
      { label: "Compared within", value: context.familyLabel, tone: "neutral" },
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict says deployment should follow creative readiness, even if the family currently has only one obvious scaling lane.",
      "Selected range is only the current operating view of that lane.",
      "Historical creative state is used to decide which winners are ready for promotion.",
      "none",
      null
    ),
    strategyLayer: "scaling",
    comparisonCohort: context.familyLabel,
    promoteCreatives: context.familyCreativeSummary.scalingReadyNames.slice(0, 4),
    keepTestingCreatives: context.familyCreativeSummary.keepTestingNames.slice(0, 4),
    doNotDeployCreatives: context.familyCreativeSummary.doNotDeployNames.slice(0, 4),
    targetScalingLane: context.strongestCampaign?.name ?? null,
  };
}

function sortWeight(input: MetaRecommendation) {
  const decisionWeight = input.decisionState === "act" ? 30 : input.decisionState === "test" ? 20 : 10;
  const priorityWeight = input.priority === "high" ? 30 : input.priority === "medium" ? 20 : 10;
  const confidenceWeight = input.confidence === "high" ? 30 : input.confidence === "medium" ? 20 : 10;
  const lensWeight = input.lens === "profitability" ? 3 : input.lens === "volume" ? 2 : 1;
  return decisionWeight + priorityWeight + confidenceWeight + lensWeight;
}

function buildHistoricalSupport(window: CampaignWindowSnapshot, evaluator: (row: MetaCampaignRow) => boolean) {
  const matches = [window.last3, window.last7, window.last14, window.last30, window.last90, window.allHistory].filter(
    (row): row is MetaCampaignRow => Boolean(row)
  );
  const supportCount = matches.filter(evaluator).length;
  return {
    supportCount,
    total: matches.length,
  };
}

function buildWeightedCampaignSnapshot(window: CampaignWindowSnapshot): WeightedCampaignSnapshot {
  const windows: Array<{ weight: number; row: MetaCampaignRow }> = [];
  const push = (weight: number, row: MetaCampaignRow | undefined) => {
    if (!row) return;
    windows.push({ weight, row });
  };

  push(0.18, window.selected);
  push(0.24, window.last3);
  push(0.22, window.last7);
  push(0.18, window.last14);
  push(0.10, window.last30);
  push(0.05, window.last90);
  push(0.03, window.allHistory);

  const totalWeight = windows.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    return {
      roas: window.selected.roas,
      spend: window.selected.spend,
      revenue: window.selected.revenue,
      purchases: window.selected.purchases,
      cpa: window.selected.cpa,
    };
  }

  const weighted = (picker: (row: MetaCampaignRow) => number) =>
    windows.reduce((sum, item) => sum + picker(item.row) * item.weight, 0) / totalWeight;

  return {
    roas: weighted((row) => row.roas),
    spend: weighted((row) => row.spend),
    revenue: weighted((row) => row.revenue),
    purchases: weighted((row) => row.purchases),
    cpa: weighted((row) => row.cpa),
  };
}

function seasonalitySignal(window: CampaignWindowSnapshot) {
  const baseline = average(
    [window.last14?.roas, window.last30?.roas, window.last90?.roas, window.allHistory?.roas].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value)
    )
  );
  if (!baseline || baseline <= 0) {
    return { flag: "none" as const, note: null };
  }

  const roasDelta = Math.abs(window.selected.roas - baseline) / baseline;
  const spendBaseline = average(
    [window.last14?.spend, window.last30?.spend, window.last90?.spend, window.allHistory?.spend].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value)
    )
  );
  const spendDelta = spendBaseline > 0 ? Math.abs(window.selected.spend - spendBaseline) / spendBaseline : 0;

  if (roasDelta >= 0.8 || spendDelta >= 1.2) {
    return {
      flag: "strong" as const,
      note: "Selected period diverges sharply from longer-term performance; likely seasonal or promotional behavior.",
    };
  }

  if (roasDelta >= 0.4 || spendDelta >= 0.6) {
    return {
      flag: "possible" as const,
      note: "Selected period is directionally different from longer-term performance; validate before broad changes.",
    };
  }

  return { flag: "none" as const, note: null };
}

function conservativeDecision(
  supportCount: number,
  total: number,
  seasonalityFlag: "none" | "possible" | "strong"
): { decisionState: MetaDecisionState; confidence: MetaRecommendationConfidence } {
  if (supportCount >= Math.max(2, total) && seasonalityFlag === "none") {
    return { decisionState: "act", confidence: "high" };
  }
  if (supportCount >= 1 && seasonalityFlag !== "strong") {
    return { decisionState: "test", confidence: "medium" };
  }
  return { decisionState: "watch", confidence: "low" };
}

function buildTimeframeContext(
  coreVerdict: string,
  selectedRangeOverlay: string,
  historicalSupport: string,
  seasonalityFlag: "none" | "possible" | "strong",
  note: string | null
): MetaRecommendationTimeframeContext {
  return {
    coreVerdict,
    selectedRangeOverlay,
    historicalSupport,
    seasonalityFlag,
    note,
  };
}

function buildCampaignWindows(input: MetaRecommendationWindows): CampaignWindowSnapshot[] {
  const previousById = byId(input.previousSelected);
  const last3ById = byId(input.last3);
  const last7ById = byId(input.last7);
  const last14ById = byId(input.last14);
  const last30ById = byId(input.last30);
  const last90ById = byId(input.last90);
  const allHistoryById = byId(input.allHistory);

  return input.selected.map((selected) => ({
    selected,
    previousSelected: previousById.get(selected.id),
    last3: last3ById.get(selected.id),
    last7: last7ById.get(selected.id),
    last14: last14ById.get(selected.id),
    last30: last30ById.get(selected.id),
    last90: last90ById.get(selected.id),
    allHistory: allHistoryById.get(selected.id),
  }));
}

function accountMetrics(rows: MetaCampaignRow[]) {
  const spend = rows.reduce((sum, row) => sum + row.spend, 0);
  const revenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const purchases = rows.reduce((sum, row) => sum + row.purchases, 0);
  return {
    spend,
    revenue,
    purchases,
    roas: spend > 0 ? revenue / spend : 0,
    cpa: purchases > 0 ? spend / purchases : 0,
  };
}

function accountAov(rows: MetaCampaignRow[]) {
  const revenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const purchases = rows.reduce((sum, row) => sum + row.purchases, 0);
  return purchases > 0 ? revenue / purchases : 0;
}

function historicalBidCandidates(input: MetaRecommendationWindows) {
  return [input.last7, input.last14, input.last30, input.last90, input.allHistory]
    .map((rows) => {
      const metrics = accountMetrics(rows);
      const aov = accountAov(rows);
      if (metrics.roas <= 0 || aov <= 0) return null;
      return (aov / metrics.roas) * 100;
    })
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function historicalRoasRange(input: MetaRecommendationWindows) {
  const candidates = [input.last7, input.last14, input.last30, input.last90, input.allHistory]
    .map((rows) => accountMetrics(rows).roas)
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => r2(value));

  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const anchor = candidates[0];
    const band = Math.max(anchor * 0.1, 0.1);
    return {
      low: r2(Math.max(anchor - band, 0.1)),
      high: r2(anchor + band),
    };
  }
  return {
    low: r2(Math.min(...candidates)),
    high: r2(Math.max(...candidates)),
  };
}

function historicalBidRange(input: MetaRecommendationWindows) {
  const candidates = historicalBidCandidates(input).map((value) => Math.round(value));
  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    const anchor = candidates[0];
    const band = Math.max(Math.round(anchor * 0.1), 1);
    return {
      low: Math.max(anchor - band, 1),
      high: anchor + band,
    };
  }

  return {
    low: Math.max(Math.min(...candidates), 1),
    high: Math.max(...candidates),
  };
}

function fmtCurrencyRange(low: number, high: number, currency = "$") {
  if (Math.abs(low - high) <= 1) {
    return fmtCurrency(low / 100, currency);
  }
  return `${fmtCurrency(low / 100, currency)}-${fmtCurrency(high / 100, currency)}`;
}

function widenBidRange(
  range: { low: number; high: number } | null,
  lowMultiplier: number,
  highMultiplier: number
) {
  if (!range) return null;
  return {
    low: Math.max(Math.round(range.low * lowMultiplier), 1),
    high: Math.max(Math.round(range.high * highMultiplier), Math.round(range.low * lowMultiplier)),
  };
}

function aggregateBidRegimeSummary(
  rows: MetaCampaignRow[],
  historicalBidRegimes: Record<string, MetaBidRegimeHistorySummary> | undefined
) {
  const counts = new Map<string, { count: number; type: string | null; label: string | null }>();
  let constrainedWeight = 0;
  let openWeight = 0;

  for (const row of rows) {
    const summary = historicalBidRegimes?.[row.id];
    if (!summary?.dominantBidStrategyType && !summary?.dominantBidStrategyLabel) continue;
    const key = `${summary.dominantBidStrategyType ?? "null"}|${summary.dominantBidStrategyLabel ?? "null"}`;
    const existing = counts.get(key) ?? {
      count: 0,
      type: summary.dominantBidStrategyType,
      label: summary.dominantBidStrategyLabel,
    };
    existing.count += Math.max(summary.observationCount, 1);
    counts.set(key, existing);
    constrainedWeight += summary.constrainedShare * Math.max(summary.observationCount, 1);
    openWeight += summary.openShare * Math.max(summary.observationCount, 1);
  }

  const dominant = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  const totalWeight = [...counts.values()].reduce((sum, item) => sum + item.count, 0);
  return {
    dominantBidStrategyType: dominant?.type ?? null,
    dominantBidStrategyLabel: dominant?.label ?? null,
    observationWeight: totalWeight,
    constrainedShare: totalWeight > 0 ? constrainedWeight / totalWeight : 0,
    openShare: totalWeight > 0 ? openWeight / totalWeight : 0,
  };
}

function currentBidRegimeSummary(rows: MetaCampaignRow[]) {
  const counts = new Map<string, { count: number; type: string | null; label: string | null }>();
  for (const row of rows) {
    const key = `${row.bidStrategyType ?? "null"}|${row.bidStrategyLabel ?? "null"}`;
    const existing = counts.get(key) ?? {
      count: 0,
      type: row.bidStrategyType ?? null,
      label: row.bidStrategyLabel ?? null,
    };
    existing.count += 1;
    counts.set(key, existing);
  }
  const dominant = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  return {
    dominantBidStrategyType: dominant?.type ?? null,
    dominantBidStrategyLabel: dominant?.label ?? null,
  };
}

function constrainedRebuildLabel(summary: {
  dominantBidStrategyType: string | null;
  dominantBidStrategyLabel: string | null;
}) {
  if (summary.dominantBidStrategyType === "cost_cap") return "Cost Cap";
  if (summary.dominantBidStrategyType === "bid_cap") return "Bid Cap";
  if (summary.dominantBidStrategyType === "manual_bid") return "Manual Bid";
  if (summary.dominantBidStrategyType === "target_roas") return "Target ROAS";
  return summary.dominantBidStrategyLabel ?? "Constrained Bidding";
}

function describeOperatingMode(input: {
  seasonalContext: MetaSeasonalContext;
  historicalBidRegimes?: Record<string, MetaBidRegimeHistorySummary>;
  selectedRows: MetaCampaignRow[];
}) {
  const historical = aggregateBidRegimeSummary(input.selectedRows, input.historicalBidRegimes);
  const current = currentBidRegimeSummary(input.selectedRows);
  const historicalRegime = constrainedRebuildLabel(historical);
  const currentRegime = current.dominantBidStrategyLabel ?? current.dominantBidStrategyType ?? "Mixed";

  const currentMode =
    current.dominantBidStrategyType === "lowest_cost"
      ? "Open-bid scaling"
      : current.dominantBidStrategyType === "target_roas"
        ? "ROAS-constrained scaling"
        : current.dominantBidStrategyType
          ? `${currentRegime} operating mode`
          : "Mixed operating mode";

  if (
    (input.seasonalContext.state === "post_peak" || input.seasonalContext.state === "unstable") &&
    historical.constrainedShare >= 0.55 &&
    current.dominantBidStrategyType === "lowest_cost"
  ) {
    return {
      operatingMode: "Operating model reset recommended",
      currentRegime: currentMode,
      recommendedMode: `Rebuild with ${historicalRegime}`,
    };
  }

  if (input.seasonalContext.state === "peak") {
    return {
      operatingMode: "Seasonal peak operating mode",
      currentRegime: currentMode,
      recommendedMode: "Delay major resets until peak softens",
    };
  }

  return {
    operatingMode: "Normalized operating mode",
    currentRegime: currentMode,
    recommendedMode:
      historical.constrainedShare >= 0.55
        ? `Historical stable regime: ${historicalRegime}`
        : "Keep current regime under observation",
  };
}

function buildSeasonalContext(input: MetaRecommendationWindows): MetaSeasonalContext {
  const selected = accountMetrics(input.selected);
  const windows = [
    { label: "last 7d", metrics: accountMetrics(input.last7) },
    { label: "last 14d", metrics: accountMetrics(input.last14) },
    { label: "last 30d", metrics: accountMetrics(input.last30) },
    { label: "last 90d", metrics: accountMetrics(input.last90) },
    { label: "history", metrics: accountMetrics(input.allHistory) },
  ].filter((item) => item.metrics.spend > 0 || item.metrics.revenue > 0);

  const baselineCandidates = [accountMetrics(input.last30), accountMetrics(input.last90), accountMetrics(input.allHistory)]
    .filter((item) => item.spend > 0 || item.revenue > 0);
  const baselineRoas = average(baselineCandidates.map((item) => item.roas).filter((value) => value > 0));
  const peakWindow = [...windows].sort((a, b) => b.metrics.roas - a.metrics.roas)[0];
  const peakRoas = peakWindow?.metrics.roas ?? selected.roas;

  if (peakRoas > Math.max(baselineRoas * 1.3, 0) && selected.roas < peakRoas * 0.78 && selected.roas <= baselineRoas * 1.05) {
    return {
      state: "post_peak",
      note: "High-demand performance has cooled and current economics now look closer to post-peak normalization.",
      peakWindowLabel: peakWindow?.label ?? null,
      selectedRoas: selected.roas,
      baselineRoas,
      peakRoas,
    };
  }

  if (selected.roas > Math.max(baselineRoas * 1.25, 0) && selected.spend > average(baselineCandidates.map((item) => item.spend)) * 1.15) {
    return {
      state: "peak",
      note: "Selected range still behaves like a high-demand window and should not be treated as the stable baseline.",
      peakWindowLabel: peakWindow?.label ?? null,
      selectedRoas: selected.roas,
      baselineRoas,
      peakRoas,
    };
  }

  if (baselineRoas > 0 && selected.roas < baselineRoas * 0.8) {
    return {
      state: "unstable",
      note: "Current economics are weaker than both recent and longer-term baselines; this looks like real deterioration rather than normal seasonality.",
      peakWindowLabel: peakWindow?.label ?? null,
      selectedRoas: selected.roas,
      baselineRoas,
      peakRoas,
    };
  }

  return {
    state: "normalized",
    note: "Selected range is directionally aligned with the account's normalized baseline.",
    peakWindowLabel: peakWindow?.label ?? null,
    selectedRoas: selected.roas,
    baselineRoas,
    peakRoas,
  };
}

function maybeStructureRecommendation(window: CampaignWindowSnapshot): MetaRecommendation | null {
  const row = window.selected;
  if (!row.isConfigMixed && !row.isOptimizationGoalMixed && !row.isBidValueMixed) {
    return null;
  }

  const seasonality = seasonalitySignal(window);
  return {
    id: `structure-${row.id}`,
    level: "campaign",
    campaignId: row.id,
    campaignName: row.name,
    type: "campaign_structure",
    lens: "structure",
    priority: "high",
    confidence: "high",
    decisionState: "act",
    decision: "Simplify the campaign setup",
    title: `${row.name}: simplify mixed campaign structure`,
    why: "This campaign is mixing optimization, bidding, or budget signals across ad sets, which weakens clean learning.",
    summary: "Current campaign configuration is mixed. Keep ad sets with the same optimization and bidding method together.",
    recommendedAction: "Split mixed ad sets into cleaner groups so each campaign has one objective and one bid logic.",
    expectedImpact: "Cleaner learning, easier budget control, and more reliable scaling decisions.",
    evidence: [
      { label: "Optimization", value: row.isOptimizationGoalMixed ? "Mixed" : row.optimizationGoal ?? "—", tone: "warning" },
      { label: "Bidding", value: row.isBidStrategyMixed ? "Mixed" : row.bidStrategyLabel ?? "—", tone: "warning" },
      { label: "Budgeting", value: row.isBudgetMixed ? "Mixed" : row.budgetLevel ?? "—", tone: "neutral" },
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict reads this as a current-state structural issue: mixed optimization, bidding, or budget logic weakens clean learning regardless of the chosen reporting window.",
      "Selected range is simply where this structural problem is currently being observed.",
      "This is a current-state recommendation rather than a short-term performance fluctuation.",
      seasonality.flag,
      seasonality.note
    ),
  };
}

function maybeSeasonalRegimeRecommendation(
  input: MetaRecommendationWindows,
  seasonalContext: MetaSeasonalContext
): MetaRecommendation | null {
  if (seasonalContext.state === "normalized") return null;

  return {
    id: "seasonal-regime-shift",
    level: "account",
    type: "seasonal_regime_shift",
    lens: "structure",
    priority: seasonalContext.state === "post_peak" || seasonalContext.state === "unstable" ? "high" : "medium",
    confidence: seasonalContext.state === "peak" ? "medium" : "high",
    decisionState: seasonalContext.state === "peak" ? "watch" : "act",
    decision: seasonalContext.state === "peak" ? "Avoid over-learning from the current seasonal spike" : "Reset expectations to the post-peak baseline",
    title:
      seasonalContext.state === "post_peak"
        ? "Peak demand has faded"
        : seasonalContext.state === "peak"
          ? "Selected range still looks seasonal"
          : "Current period looks structurally weaker than baseline",
    why: seasonalContext.note,
    summary:
      seasonalContext.state === "post_peak"
        ? `Selected range ROAS is ${fmtRoas(seasonalContext.selectedRoas)} versus a historical peak near ${fmtRoas(seasonalContext.peakRoas)}. Do not scale as if peak-season demand is still active.`
        : seasonalContext.state === "peak"
          ? `Selected range is still outperforming the normalized baseline (${fmtRoas(seasonalContext.baselineRoas || seasonalContext.selectedRoas)}), so broad structural conclusions should wait.`
          : `Selected range ROAS is ${fmtRoas(seasonalContext.selectedRoas)} against a normalized baseline near ${fmtRoas(seasonalContext.baselineRoas || seasonalContext.selectedRoas)}.`,
    recommendedAction:
      seasonalContext.state === "post_peak"
        ? "Anchor bidding, budget, and scaling decisions to the post-peak baseline rather than the peak-demand period."
        : seasonalContext.state === "peak"
          ? "Hold major rebuild decisions until the account exits the high-demand window or validate them in a separate controlled test."
          : "Treat this as real deterioration and tighten bidding or rebuild structure before trying to scale again.",
    expectedImpact: "Fewer false positives from seasonal spikes and cleaner operating decisions.",
    evidence: [
      { label: "Selected ROAS", value: fmtRoas(seasonalContext.selectedRoas), tone: seasonalContext.state === "peak" ? "positive" : "warning" },
      { label: "Baseline ROAS", value: fmtRoas(seasonalContext.baselineRoas || seasonalContext.selectedRoas), tone: "neutral" },
      { label: "Peak window", value: seasonalContext.peakWindowLabel ?? "—", tone: "neutral" },
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict is built from normalized and peak-period baselines rather than treating the selected range as the account's natural operating state.",
      "Selected range is being measured against that broader regime model.",
      seasonalContext.peakWindowLabel
        ? `Highest recent efficiency was observed around ${seasonalContext.peakWindowLabel}; recommendation adjüsts for that regime shift.`
        : "Recent and long-term windows were compared to estimate the account's normalized baseline.",
      seasonalContext.state === "peak" ? "strong" : seasonalContext.state === "post_peak" ? "possible" : "none",
      seasonalContext.note
    ),
    strategyLayer: "seasonality",
    seasonalState: seasonalContext.state,
  };
}

function maybeHistoricalBidRegimeRecommendation(
  selectedRows: MetaCampaignRow[],
  historicalBidRegimes: Record<string, MetaBidRegimeHistorySummary> | undefined,
  seasonalContext: MetaSeasonalContext
): MetaRecommendation | null {
  const historical = aggregateBidRegimeSummary(selectedRows, historicalBidRegimes);
  const current = currentBidRegimeSummary(selectedRows);
  if (!historical.dominantBidStrategyType || historical.observationWeight === 0) return null;
  if (historical.dominantBidStrategyType === current.dominantBidStrategyType) return null;
  if (historical.constrainedShare < 0.55) return null;

  return {
    id: "historical-bid-regime-fit",
    level: "account",
    type: "historical_bid_regime_fit",
    lens: "profitability",
    priority: "high",
    confidence: historical.observationWeight >= 4 ? "high" : "medium",
    decisionState: seasonalContext.state === "peak" ? "test" : "act",
    decision: "Return to the account's historical bidding regime",
    title: "Current bidding regime is misaligned with account history",
    why: "This account's stable history leans toward constrained bidding, but the current campaign set is using a different dominant bidding mode.",
    summary: `Historical winning regime is ${historical.dominantBidStrategyLabel ?? historical.dominantBidStrategyType}, while current campaigns are mostly running on ${current.dominantBidStrategyLabel ?? current.dominantBidStrategyType ?? "mixed bidding"}.`,
    recommendedAction: `Use ${historical.dominantBidStrategyLabel ?? historical.dominantBidStrategyType} as the primary rebuild hypothesis, then validate it against the current setup with controlled budget.`,
    expectedImpact: "Better fit with the account's stable economics outside short-lived demand spikes.",
    evidence: [
      { label: "Historical regime", value: historical.dominantBidStrategyLabel ?? "—", tone: "positive" },
      { label: "Current regime", value: current.dominantBidStrategyLabel ?? "—", tone: "warning" },
      { label: "Constrained share", value: `${r2(historical.constrainedShare * 100)}%`, tone: "neutral" },
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict compares current bidding architecture against the account's longer config memory, not against one reporting range.",
      "Selected range only shows whether the current regime is helping or hurting right now.",
      `Historical regime summary is based on ${historical.observationWeight} config snapshots across selected campaigns.`,
      seasonalContext.state === "peak" ? "possible" : "none",
      seasonalContext.state === "peak"
        ? "Historical fit exists, but peak-season demand can temporarily reward more open bidding."
        : null
    ),
    strategyLayer: "bidding",
    historicalRegime: historical.dominantBidStrategyLabel ?? historical.dominantBidStrategyType,
  };
}

function maybeBidBandRecommendation(
  selectedRows: MetaCampaignRow[],
  suggestedBidRange: { low: number; high: number } | null,
  suggestedRoasRange: { low: number; high: number } | null,
  seasonalContext: MetaSeasonalContext
): MetaRecommendation | null {
  const currency = currencySymbol(selectedRows[0]?.currency);
  const defensiveBand = suggestedBidRange ? fmtCurrencyRange(suggestedBidRange.low, suggestedBidRange.high, currency) : null;
  const scaleBandRaw = widenBidRange(suggestedBidRange, 1.05, 1.15);
  const scaleBand = scaleBandRaw ? fmtCurrencyRange(scaleBandRaw.low, scaleBandRaw.high, currency) : null;
  const roasBand = suggestedRoasRange ? `${fmtRoas(suggestedRoasRange.low)}-${fmtRoas(suggestedRoasRange.high)}` : null;

  if (!defensiveBand && !roasBand) return null;

  return {
    id: "bid-band-from-history",
    level: "account",
    type: "bid_band_from_history",
    lens: "profitability",
    priority: "high",
    confidence: "medium",
    decisionState: "act",
    decision: "Use historical efficiency bands instead of single-point bid guesses",
    title: "Historical bid bands define the safer operating zone",
    why: "Bid decisions are more stable when they are anchored to multi-window AOV and ROAS bands rather than a single recent datapoint.",
    summary: defensiveBand
      ? `Defensive bid band is ${defensiveBand}${scaleBand ? ` and scale bid band is ${scaleBand}` : ""}.`
      : `Suggested Target ROAS operating band is ${roasBand}.`,
    recommendedAction: defensiveBand
      ? `Use ${defensiveBand} as the profitability-protecting band and ${scaleBand ?? defensiveBand} as the more aggressive scale band when demand and efficiency justify it.`
      : `Use ${roasBand} as the working ROAS target band, then tighten or loosen based on whether actual ROAS holds above it.`,
    expectedImpact: "More consistent bidding changes and fewer overreactions to short-term volatility.",
    evidence: [
      ...(defensiveBand ? [{ label: "Defensive bid band", value: defensiveBand, tone: "positive" as const }] : []),
      ...(scaleBand ? [{ label: "Scale bid band", value: scaleBand, tone: "neutral" as const }] : []),
      ...(roasBand ? [{ label: "ROAS band", value: roasBand, tone: "positive" as const }] : []),
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict derives bid bands from weighted 7/14/30/90/history efficiency windows.",
      "Selected range is only used to validate whether the current period is behaving above or below that core band.",
      "The engine uses multi-window AOV and ROAS ranges to avoid relying on a single seasonal datapoint.",
      seasonalContext.state === "peak" ? "possible" : "none",
      seasonalContext.state === "post_peak"
        ? "Bands are especially useful here because post-peak economics usually compress relative to the seasonal high."
        : null
    ),
    strategyLayer: "bidding",
    defensiveBidBand: defensiveBand,
    scaleBidBand: scaleBand,
  };
}

function maybeRebuildRecommendation(
  selectedRows: MetaCampaignRow[],
  historicalBidRegimes: Record<string, MetaBidRegimeHistorySummary> | undefined,
  seasonalContext: MetaSeasonalContext,
  suggestedBidRange: { low: number; high: number } | null
): MetaRecommendation | null {
  const historical = aggregateBidRegimeSummary(selectedRows, historicalBidRegimes);
  const current = currentBidRegimeSummary(selectedRows);
  const currency = currencySymbol(selectedRows[0]?.currency);
  const defensiveBand = suggestedBidRange ? fmtCurrencyRange(suggestedBidRange.low, suggestedBidRange.high, currency) : null;
  const rebuildMethod = constrainedRebuildLabel(historical);
  const shouldRebuild =
    (seasonalContext.state === "post_peak" || seasonalContext.state === "unstable") &&
    historical.constrainedShare >= 0.55 &&
    current.dominantBidStrategyType === "lowest_cost";

  if (!shouldRebuild) return null;

  return {
    id: "rebuild-with-constraints",
    level: "account",
    type: "rebuild_with_constraints",
    lens: "structure",
    priority: "high",
    confidence: "high",
    decisionState: "act",
    decision: `Pause and rebuild with ${rebuildMethod}`,
    title: `${rebuildMethod} rebuild is safer than more Lowest Cost tuning`,
    why: "The account has moved out of a stronger demand regime, while historical config memory points toward constrained bidding as the stable operating mode.",
    summary: `Post-peak or deteriorating economics plus a historical bias toward ${rebuildMethod} suggest a rebuild is safer than incremental tweaks.`,
    recommendedAction: defensiveBand
      ? `Pause the weakest current campaigns and relaunch with ${rebuildMethod}, using ${defensiveBand} as the starting defensive band. Keep scale modest until post-launch ROAS proves stable.`
      : `Pause the weakest current campaigns and relaunch with ${rebuildMethod} as the primary operating model, then validate economics before broad scale.`,
    expectedImpact: "Cleaner control over profitability as the account exits the seasonal high-demand regime.",
    evidence: [
      { label: "Seasonal state", value: seasonalContext.state.replace("_", " "), tone: "warning" },
      { label: "Historical regime", value: rebuildMethod, tone: "positive" },
      { label: "Current regime", value: current.dominantBidStrategyLabel ?? "—", tone: "warning" },
      ...(defensiveBand ? [{ label: "Starting defensive band", value: defensiveBand, tone: "neutral" as const }] : []),
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict combines seasonality, weighted performance, and config history to decide whether incremental tuning is no longer enough.",
      "Selected range only confirms whether the current setup is still under pressure right now.",
      `Historical constrained-bidding share is ${r2(historical.constrainedShare * 100)}% across tracked snapshots.`,
      seasonalContext.state === "post_peak" ? "possible" : "none",
      seasonalContext.note
    ),
    strategyLayer: "structure",
    seasonalState: seasonalContext.state,
    historicalRegime: rebuildMethod,
    defensiveBidBand: defensiveBand,
    requiresRebuild: true,
    rebuildReason: `${rebuildMethod} historically fit this account better outside peak demand windows.`,
  };
}

function maybeOptimizationRecommendation(window: CampaignWindowSnapshot): MetaRecommendation | null {
  const row = window.selected;
  const core = buildWeightedCampaignSnapshot(window);
  if (row.optimizationGoal === "Add To Cart" && core.purchases >= 20 && core.roas >= 2) {
    const support = buildHistoricalSupport(window, (historical) => historical.purchases >= 20 && historical.roas >= 2);
    const seasonality = seasonalitySignal(window);
    const decision = conservativeDecision(support.supportCount, support.total, seasonality.flag);
    return {
      id: `optimization-${row.id}`,
      level: "campaign",
      campaignId: row.id,
      campaignName: row.name,
      type: "optimization_fit",
      lens: "profitability",
      priority: "medium",
      confidence: decision.confidence,
      decisionState: decision.decisionState,
      decision: "Test a deeper-funnel optimization goal",
      title: `${row.name}: move beyond Add To Cart optimization`,
      why: "The campaign already generates meaningful purchases, so optimizing one step deeper in the funnel should give better profitability control.",
      summary: "Core weighted performance shows enough purchase volume to justify testing Purchase or Value optimization.",
      recommendedAction: "Duplicate the campaign and test Purchase or Value optimization against the current Add To Cart setup.",
      expectedImpact: "Better downstream conversion quality and more stable ROAS.",
      evidence: [
        { label: "Optimization", value: row.optimizationGoal ?? "—", tone: "warning" },
        { label: "Core purchases", value: String(Math.round(core.purchases)), tone: "positive" },
        { label: "Core ROAS", value: fmtRoas(core.roas), tone: "positive" },
      ],
      timeframeContext: buildTimeframeContext(
        "Core verdict says the campaign is already deep enough in the funnel to justify a lower-funnel objective test.",
        `Selected range currently reads ${fmtRoas(row.roas)} ROAS on ${row.purchases} purchases.`,
        `Historical support found in ${support.supportCount}/${support.total || 1} longer windows.`,
        seasonality.flag,
        seasonality.note
      ),
    };
  }

  if (row.optimizationGoal === "Lead" && row.costPerLead > 0 && core.cpa >= 80) {
    const support = buildHistoricalSupport(window, (historical) => historical.costPerLead >= 80);
    const seasonality = seasonalitySignal(window);
    const decision = conservativeDecision(support.supportCount, support.total, seasonality.flag);
    return {
      id: `optimization-${row.id}`,
      level: "campaign",
      campaignId: row.id,
      campaignName: row.name,
      type: "optimization_fit",
      lens: "profitability",
      priority: "medium",
      confidence: decision.confidence,
      decisionState: decision.decisionState,
      decision: "Revisit lead optimization quality",
      title: `${row.name}: lead optimization is expensive`,
      why: "Lead cost is elevated and the current objective may be prioritizing volume over quality.",
      summary: "Core weighted lead efficiency is weak enough to justify a quality-oriented retest.",
      recommendedAction: "Test a tighter audience or quality-lead / purchase-aligned structure instead of scaling the current lead setup.",
      expectedImpact: "Lower wasted spend and better downstream conversion quality.",
      evidence: [
        { label: "Optimization", value: row.optimizationGoal ?? "—", tone: "warning" },
        { label: "Cost / lead", value: fmtCurrency(row.costPerLead, row.currency === "TRY" ? "₺" : row.currency === "EUR" ? "€" : "$"), tone: "warning" },
        { label: "Leads", value: String(row.leads), tone: "neutral" },
      ],
      timeframeContext: buildTimeframeContext(
        "Core verdict says lead quality economics are not strong enough for clean scaling.",
        `Selected range currently reads ${fmtCurrency(row.costPerLead, row.currency === "TRY" ? "₺" : row.currency === "EUR" ? "€" : "$")} per lead.`,
        `Historical support found in ${support.supportCount}/${support.total || 1} longer windows.`,
        seasonality.flag,
        seasonality.note
      ),
    };
  }

  return null;
}

function maybeBidRecommendation(
  window: CampaignWindowSnapshot,
  accountRoas: number,
  suggestedBidRange: { low: number; high: number } | null,
  suggestedRoasRange: { low: number; high: number } | null,
  calibrationContext?: MetaCalibrationContext | null
): MetaRecommendation | null {
  const row = window.selected;
  const core = buildWeightedCampaignSnapshot(window);
  const seasonality = seasonalitySignal(window);
  const roasThresholds = thresholdMetric(calibrationContext, "roas_28d");

  if (row.bidStrategyType === "target_roas") {
    const targetBidValue = typeof row.bidValue === "number" ? row.bidValue : null;
    const support = buildHistoricalSupport(
      window,
      (historical) =>
        historical.bidStrategyType === "target_roas" &&
        historical.roas >= Math.max((targetBidValue ?? suggestedRoasRange?.low ?? accountRoas) * 0.95, 0.1)
    );
    const decision = conservativeDecision(support.supportCount, support.total, seasonality.flag);
    const suggestedRoasText =
      suggestedRoasRange
        ? `${fmtRoas(suggestedRoasRange.low)}-${fmtRoas(suggestedRoasRange.high)}`
        : null;
    const action =
      typeof targetBidValue === "number"
        ? row.roas > targetBidValue * 1.2
          ? `Test lowering Target ROAS from ${fmtRoas(targetBidValue)} by 10-15% to unlock more volume.`
          : `Keep Target ROAS tight and avoid aggressive scaling until actual ROAS is consistently above ${fmtRoas(targetBidValue)}.`
        : suggestedRoasText
          ? `Use ${suggestedRoasText} as the working Target ROAS range, then tighten or loosen based on whether actual ROAS holds above that band.`
          : "Set an explicit Target ROAS range before scaling so delivery and profitability are easier to control.";
    return applyConfidence({
      id: `bid-${row.id}`,
      level: "campaign",
      campaignId: row.id,
      campaignName: row.name,
      type: "bid_value_guidance",
      lens: typeof targetBidValue === "number" && row.roas > targetBidValue ? "volume" : "profitability",
      priority: "high",
      confidence: decision.confidence,
      decisionState: decision.decisionState,
      decision:
        typeof targetBidValue === "number" && core.roas > targetBidValue
          ? "Loosen the ROAS target carefully"
          : "Protect efficiency before scaling",
      title: `${row.name}: tune Target ROAS against actual return`,
      why: "Target ROAS should not be treated as static. When actual return is materially above target, you may be leaving volume on the table.",
      summary:
        typeof targetBidValue === "number"
          ? `Core ROAS is ${fmtRoas(core.roas)} against a ${fmtRoas(targetBidValue)} target.`
          : suggestedRoasText
            ? `Current Target ROAS value is not readable in campaign config, but historical account performance supports a working ROAS target range of ${suggestedRoasText}.`
            : `Current Target ROAS value is not readable in campaign config, so target guidance is being inferred from multi-window account performance.`,
      recommendedAction: action,
      expectedImpact:
        typeof targetBidValue === "number" && row.roas > targetBidValue
          ? "More delivery without fully giving up profitability guardrails."
          : "Protect margin until the campaign proves stable again.",
      evidence: [
        { label: "Bid method", value: row.bidStrategyLabel ?? "—", tone: "neutral" },
        ...(typeof targetBidValue === "number"
          ? [{ label: "Current target", value: fmtRoas(targetBidValue), tone: "neutral" as const }]
          : []),
        ...(suggestedRoasText
          ? [{ label: "Suggested target range", value: suggestedRoasText, tone: "positive" as const }]
          : []),
        {
          label: "Core ROAS",
          value: fmtRoas(core.roas),
          tone: typeof targetBidValue === "number" && core.roas > targetBidValue ? "positive" : "warning",
        },
      ],
      timeframeContext: buildTimeframeContext(
        "Core verdict compares weighted ROAS behavior to the configured ROAS target.",
        `Selected range currently reads ${fmtRoas(row.roas)} ROAS${typeof targetBidValue === "number" ? ` against a ${fmtRoas(targetBidValue)} target` : ""}.`,
        suggestedRoasText
          ? `Historical confirmation found in ${support.supportCount}/${support.total || 1} longer windows. Suggested ROAS target range is derived from 7/14/30/90/history account ROAS windows.`
          : `Historical confirmation found in ${support.supportCount}/${support.total || 1} longer windows.`,
        seasonality.flag,
        seasonality.note
      ),
    }, calculateMetaStatisticalConfidence({
      level: "campaign",
      metricValue: core.roas,
      threshold: targetBidValue ?? suggestedRoasRange?.low ?? roasThresholds.p50,
      sampleSize: roasThresholds.sampleSize,
      minRequiredSample: minRequiredSample(calibrationContext),
      ageDays: campaignAgeDays(row),
    }));
  }

  if (row.bidStrategyType === "bid_cap" || row.bidStrategyType === "cost_cap" || row.bidStrategyType === "manual_bid") {
    const support = buildHistoricalSupport(
      window,
      (historical) => historical.roas >= Math.max(accountRoas * 0.9, 2)
    );
    const decision = conservativeDecision(support.supportCount, support.total, seasonality.flag);
    const bidCurrencySymbol = currencySymbol(row.currency);
    const suggestedBidText =
      suggestedBidRange
        ? fmtCurrencyRange(suggestedBidRange.low, suggestedBidRange.high, bidCurrencySymbol)
        : null;
    return applyConfidence({
      id: `bid-${row.id}`,
      level: "campaign",
      campaignId: row.id,
      campaignName: row.name,
      type: "bid_strategy_fit",
      lens: "volume",
      priority: row.roas >= Math.max(accountRoas, 2) ? "high" : "medium",
      confidence: decision.confidence,
      decisionState: decision.decisionState,
      decision: "Review how restrictive the manual bid is",
      title: `${row.name}: bid constraint may be limiting scale`,
      why: "Manual bid strategies can protect efficiency, but they often become the bottleneck önce the campaign is healthy.",
      summary:
        suggestedBidText
          ? `The campaign is using a constrained bid strategy. Based on historical account AOV and ROAS, a safer reference bid range is ${suggestedBidText}.`
          : "The campaign is using a constrained bid strategy. If efficiency is already acceptable, scale may be capped by the bid setting rather than the budget.",
      recommendedAction:
        suggestedBidText
          ? `Use ${suggestedBidText} as the reference bid range for ${row.bidStrategyLabel ?? "manual bidding"}. If current bid is materially below this band, loosen it into the range first; if it is above the band, validate whether efficiency still holds before scaling budget.`
          : `Test loosening ${row.bidStrategyLabel ?? "manual bidding"} by 10-15% before increasing budget aggressively.`,
      expectedImpact: "More delivery while keeping changes controlled.",
      evidence: [
        { label: "Bid method", value: row.bidStrategyLabel ?? "—", tone: "neutral" },
        ...(typeof row.bidValue === "number"
          ? [{
              label: "Bid value",
              value: row.bidValueFormat === "roas" ? fmtRoas(row.bidValue) : fmtCurrency(row.bidValue / 100, bidCurrencySymbol),
              tone: "neutral" as const,
            }]
          : []),
        { label: "Core ROAS", value: fmtRoas(core.roas), tone: core.roas >= Math.max(accountRoas, 2) ? "positive" : "warning" },
        ...(suggestedBidText
          ? [{ label: "Suggested bid range", value: suggestedBidText, tone: "positive" as const }]
          : []),
      ],
      timeframeContext: buildTimeframeContext(
        "Core verdict reads weighted performance against a constrained bid strategy.",
        `Selected range currently reads ${fmtRoas(row.roas)} ROAS on ${fmtCurrency(row.spend, bidCurrencySymbol)} spend.`,
        suggestedBidText
          ? `Historical support found in ${support.supportCount}/${support.total || 1} longer windows. Suggested bid range is derived from 7/14/30/90/history AOV and ROAS windows.`
          : `Historical support found in ${support.supportCount}/${support.total || 1} longer windows.`,
        seasonality.flag,
        seasonality.note
      ),
    }, calculateMetaStatisticalConfidence({
      level: "campaign",
      metricValue: core.roas,
      threshold: Math.max(
        roasThresholds.p50,
        suggestedRoasRange ? (suggestedRoasRange.low + suggestedRoasRange.high) / 2 : 0,
      ),
      sampleSize: roasThresholds.sampleSize,
      minRequiredSample: minRequiredSample(calibrationContext),
      ageDays: campaignAgeDays(row),
    }));
  }

  const lowestCostWeakThreshold = calibrationContext
    ? roasThresholds.p25
    : Math.max(1.5, accountRoas * 0.75);
  if (row.bidStrategyType === "lowest_cost" && row.roas < lowestCostWeakThreshold) {
    const support = buildHistoricalSupport(window, (historical) => historical.roas < lowestCostWeakThreshold);
    const decision = conservativeDecision(support.supportCount, support.total, seasonality.flag);
    const severeLoser =
      core.roas < roasThresholds.p10 && core.spend > hardCutSpend(calibrationContext);
    return applyConfidence({
      id: `bid-${row.id}`,
      level: "campaign",
      campaignId: row.id,
      campaignName: row.name,
      type: "bid_strategy_fit",
      lens: "profitability",
      priority: "medium",
      confidence: decision.confidence,
      decisionState: decision.decisionState,
      decision: "Add efficiency guardrails",
      title: `${row.name}: Lowest Cost is not protecting profitability`,
      why: "Lowest Cost is great for delivery, but weak efficiency across multiple windows suggests the campaign needs stronger constraints.",
      summary: "Actual efficiency is trailing peer campaigns with the same optimization intent while the campaign is still running on Lowest Cost.",
      recommendedAction: "Test Cost Cap or Target ROAS instead of scaling the current Lowest Cost setup.",
      expectedImpact: "Better control over profit quality before pushing more volume.",
      evidence: [
        { label: "Bid method", value: row.bidStrategyLabel ?? "—", tone: "warning" },
        { label: "Core ROAS", value: fmtRoas(core.roas), tone: "warning" },
        { label: "Peer-group ROAS", value: fmtRoas(accountRoas), tone: "neutral" },
      ],
      timeframeContext: buildTimeframeContext(
        "Core verdict says a fully open bid strategy is not protecting efficiency well enough.",
        `Selected range currently reads ${fmtRoas(row.roas)} ROAS against a peer benchmark of ${fmtRoas(accountRoas)}.`,
        `Historical support found in ${support.supportCount}/${support.total || 1} longer windows.`,
        seasonality.flag,
        seasonality.note
      ),
    }, calculateMetaStatisticalConfidence({
      level: "campaign",
      metricValue: core.roas,
      threshold: lowestCostWeakThreshold,
      sampleSize: roasThresholds.sampleSize,
      minRequiredSample: minRequiredSample(calibrationContext),
      ageDays: campaignAgeDays(row),
      severeLoser,
    }));
  }

  return null;
}

function maybeVolumeScaleRecommendation(
  window: CampaignWindowSnapshot,
  peerRoas: number,
  peerCpa: number,
  calibrationContext?: MetaCalibrationContext | null,
  commercialTargets?: MetaCommercialTargets | null,
): MetaRecommendation | null {
  const row = window.selected;
  const core = buildWeightedCampaignSnapshot(window);
  const roasThresholds = thresholdMetric(calibrationContext, "roas_28d");
  const cpaThresholds = thresholdMetric(calibrationContext, "cpa_28d");
  const scaleFloor = metaScaleRoasFloor(commercialTargets);
  if (!scaleFloor) return null;
  const scaleRoasThreshold = calibrationContext
    ? Math.max(roasThresholds.p75, scaleFloor)
    : Math.max(peerRoas * 0.95, scaleFloor);
  const cpaCeiling = calibrationContext
    ? cpaThresholds.p75
    : peerCpa > 0
      ? peerCpa * 1.1
      : Number.POSITIVE_INFINITY;
  const commercialCpaCeiling =
    commercialTargets?.breakEvenCpa ?? (commercialTargets?.targetCpa ? commercialTargets.targetCpa * 1.1 : null);
  if (row.status !== "ACTIVE") return null;
  if (core.purchases < 10) return null;
  if (core.roas < scaleRoasThreshold) return null;
  if (Number.isFinite(cpaCeiling) && core.cpa > cpaCeiling) return null;
  if (commercialCpaCeiling && core.cpa > commercialCpaCeiling) return null;

  const support = buildHistoricalSupport(
    window,
    (historical) => historical.roas >= Math.max(peerRoas * 0.9, 2) && historical.purchases >= Math.max(10, row.purchases * 0.6)
  );
  const seasonality = seasonalitySignal(window);
  const decision = conservativeDecision(support.supportCount, support.total, seasonality.flag);

  return applyConfidence({
    id: `volume-${row.id}`,
    level: "campaign",
    campaignId: row.id,
    campaignName: row.name,
    type: "scale_for_volume",
    lens: "volume",
    priority: "high",
    confidence: decision.confidence,
    decisionState: decision.decisionState,
    decision: decision.decisionState === "act" ? "Scale this campaign for more volume" : "Test scale carefully",
    title: `${row.name}: strong candidate for volume scale`,
    why: "The campaign is delivering acceptable profitability relative to peers with the same optimization intent and has enough conversion depth to support controlled scaling.",
    summary: "Core weighted performance is strong enough to justify additional budget or looser delivery constraints, subject to historical validation.",
    recommendedAction:
      row.bidStrategyType === "target_roas"
        ? "Start with a 10-15% lower Target ROAS or a modest budget increase to unlock more volume."
        : row.bidStrategyType === "bid_cap" || row.bidStrategyType === "cost_cap" || row.bidStrategyType === "manual_bid"
          ? "Loosen the bid constraint 10-15% before pushing budget higher."
          : "Increase budget by 10-15% and monitor CPA / ROAS for 3-5 days.",
    expectedImpact: "Higher delivery and more conversion volume without immediately giving up control.",
    evidence: [
      { label: "Core ROAS", value: fmtRoas(core.roas), tone: "positive" },
      { label: "Core CPA", value: fmtCurrency(core.cpa, row.currency === "TRY" ? "₺" : row.currency === "EUR" ? "€" : "$"), tone: "positive" },
      { label: "Core purchases", value: String(Math.round(core.purchases)), tone: "positive" },
      ...commercialTargetEvidence(commercialTargets, row.currency === "TRY" ? "₺" : row.currency === "EUR" ? "€" : "$"),
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict says scale economics are healthy across weighted recent-to-historical windows.",
      `Selected range currently reads ${fmtRoas(row.roas)} ROAS and ${String(row.purchases)} purchases.`,
      `Historical support found in ${support.supportCount}/${support.total || 1} longer windows.`,
      seasonality.flag,
      seasonality.note
    ),
    comparisonCohort: comparableMetaIntentLabel(row),
    strategyLayer: "scaling",
  }, calculateMetaStatisticalConfidence({
    level: "campaign",
    metricValue: core.roas,
    threshold: scaleRoasThreshold,
    sampleSize: roasThresholds.sampleSize,
    minRequiredSample: minRequiredSample(calibrationContext),
    ageDays: campaignAgeDays(row),
  }));
}

function maybeProfitabilityRecommendation(
  window: CampaignWindowSnapshot,
  peerRoas: number,
  selectedRows: MetaCampaignRow[],
  calibrationContext?: MetaCalibrationContext | null,
  commercialTargets?: MetaCommercialTargets | null,
): MetaRecommendation | null {
  const row = window.selected;
  const core = buildWeightedCampaignSnapshot(window);
  const roasThresholds = thresholdMetric(calibrationContext, "roas_28d");
  const cpaThresholds = thresholdMetric(calibrationContext, "cpa_28d");
  const cutCeiling = metaCutRoasCeiling(commercialTargets);
  if (!cutCeiling) return null;
  const totalSelectedSpend = selectedRows.reduce((sum, campaign) => sum + campaign.spend, 0);
  const totalSelectedPurchases = selectedRows.reduce((sum, campaign) => sum + campaign.purchases, 0);
  const accountCpaBaseline =
    cpaThresholds.p50 > 0
      ? cpaThresholds.p50
      : totalSelectedPurchases > 0
        ? totalSelectedSpend / totalSelectedPurchases
        : null;
  const maturity = metaLossBudgetMaturity({
    targets: commercialTargets,
    accountCpaBaseline,
    currency: row.currency,
  });
  if (!maturity || core.spend < maturity.spendThreshold) return null;
  const weakRoasThreshold = calibrationContext
    ? roasThresholds.p25
    : Math.max(1.6, peerRoas * 0.8);
  const totalSpend = totalSelectedSpend;
  const spendShare = totalSpend > 0 ? row.spend / totalSpend : 0;
  if (spendShare < 0.12 && row.spend < average(selectedRows.map((campaign) => campaign.spend))) return null;
  if (core.roas >= weakRoasThreshold) return null;
  if (core.roas >= cutCeiling) return null;

  const support = buildHistoricalSupport(window, (historical) => historical.roas < weakRoasThreshold);
  const seasonality = seasonalitySignal(window);
  const decision = conservativeDecision(support.supportCount, support.total, seasonality.flag);
  const severeLoser =
    core.roas < Math.min(roasThresholds.p10, cutCeiling) && core.spend >= maturity.spendThreshold;
  return applyConfidence({
    id: `profit-${row.id}`,
    level: "campaign",
    campaignId: row.id,
    campaignName: row.name,
    type: "scale_for_profitability",
    lens: "profitability",
    priority: "high",
    confidence: decision.confidence,
    decisionState: decision.decisionState,
    decision: decision.decisionState === "act" ? "Protect profitability before scaling" : "Watch efficiency before making larger cuts",
    title: `${row.name}: profitability should come before scale`,
    why: "This campaign is consuming meaningful spend while trailing the efficiency benchmark of campaigns with the same optimization intent.",
    summary: "Scaling now would likely amplify waste faster than revenue.",
    recommendedAction:
      row.bidStrategyType === "lowest_cost"
        ? "Hold or reduce budget 10-15% and test Cost Cap or Target ROAS before scaling again."
        : "Reduce spend pressure, tighten the bid or audience, and reallocate budget toward stronger campaigns.",
    expectedImpact: "Lower wasted spend and cleaner budget allocation.",
    evidence: [
      { label: "Spend share", value: `${r2(spendShare * 100)}%`, tone: "warning" },
      { label: "Core ROAS", value: fmtRoas(core.roas), tone: "warning" },
      { label: "Peer-group ROAS", value: fmtRoas(peerRoas), tone: "neutral" },
      { label: "Loss maturity spend", value: fmtCurrency(maturity.spendThreshold, row.currency === "TRY" ? "₺" : row.currency === "EUR" ? "€" : "$"), tone: "neutral" },
      ...commercialTargetEvidence(commercialTargets, row.currency === "TRY" ? "₺" : row.currency === "EUR" ? "€" : "$"),
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict says profitability is weaker than the comparable optimization cohort.",
      `Selected range currently reads ${fmtRoas(row.roas)} ROAS on ${fmtCurrency(row.spend, row.currency === "TRY" ? "₺" : row.currency === "EUR" ? "€" : "$")} spend.`,
      `Historical weakness confirmed in ${support.supportCount}/${support.total || 1} longer windows.`,
      seasonality.flag,
      seasonality.note
    ),
    comparisonCohort: comparableMetaIntentLabel(row),
    strategyLayer: "scaling",
  }, calculateMetaStatisticalConfidence({
    level: "campaign",
    metricValue: core.roas,
    threshold: weakRoasThreshold,
    sampleSize: roasThresholds.sampleSize,
    minRequiredSample: minRequiredSample(calibrationContext),
    ageDays: campaignAgeDays(row),
    severeLoser,
  }));
}

function maybeAccountBudgetShift(
  windows: CampaignWindowSnapshot[],
  recommendations: MetaRecommendation[]
): MetaRecommendation | null {
  const actVolume = recommendations
    .filter((recommendation) => recommendation.level === "campaign" && recommendation.lens === "volume" && recommendation.decisionState !== "watch")
    .slice(0, 2);
  const actProfit = recommendations
    .filter((recommendation) => recommendation.level === "campaign" && recommendation.lens === "profitability" && recommendation.decisionState !== "watch")
    .slice(0, 2);

  if (actVolume.length === 0 && actProfit.length === 0) return null;
  const selectedRows = windows.map((window) => window.selected);
  const laneSignals = buildMetaCampaignLaneSignals(selectedRows);
  const laneSummaries = buildMetaCampaignLaneSummary(selectedRows);
  const comparableGroups = new Map<string, Array<{ row: MetaCampaignRow; core: WeightedCampaignSnapshot; lane: MetaCampaignLaneLabel | null }>>();
  for (const window of windows) {
    const row = window.selected;
    const lane = laneSignals.get(row.id)?.lane;
    if (lane === "Test") continue;
    const group = comparableMetaIntentKey(row);
    comparableGroups.set(group, [
      ...(comparableGroups.get(group) ?? []),
      { row, core: buildWeightedCampaignSnapshot(window), lane: lane ?? null },
    ]);
  }
  const eligibleGroups = [...comparableGroups.entries()]
    .filter(([, rows]) => {
      if (rows.length < 2) return false;
      const family = resolveMetaCampaignFamily(rows[0]?.row ?? windows[0].selected);
      return laneSummaries.get(family)?.eligibleForBudgetShift ?? false;
    })
    .map(([group, rows]) => ({
      group,
      rows,
      spread: Math.max(...rows.map(({ core }) => core.roas)) - Math.min(...rows.map(({ core }) => core.roas)),
      laneMix: {
        scaling: rows.filter(({ lane }) => lane === "Scaling").length,
        validation: rows.filter(({ lane }) => lane === "Validation").length,
      },
    }))
    .sort((a, b) => b.spread - a.spread);
  const selectedGroup = eligibleGroups[0];
  if (!selectedGroup) return null;

  const bestCampaign = [...selectedGroup.rows]
    .filter(({ lane }) => lane === "Scaling")
    .sort((a, b) => b.core.roas - a.core.roas)[0];
  const weakCampaign = [...selectedGroup.rows]
    .filter(({ lane }) => lane === "Validation")
    .sort((a, b) => a.core.roas - b.core.roas)[0];
  if (!bestCampaign || !weakCampaign) return null;
  const groupLabel = comparableMetaIntentLabel(bestCampaign?.row ?? weakCampaign?.row ?? windows[0].selected);

  return {
    id: "account-budget-allocation",
    level: "account",
    type: "budget_allocation",
    lens: actProfit.length > actVolume.length ? "profitability" : "volume",
    priority: "high",
    confidence: "medium",
    decisionState: "act",
    decision: actProfit.length > actVolume.length ? "Shift budget toward efficiency" : "Reallocate toward scalable campaigns",
    title: actProfit.length > actVolume.length ? "Budget should move toward stronger efficiency pockets" : "Budget can move into the strongest scale candidates",
    why: `The account has clear performance dispersion inside the ${groupLabel} campaign group, so budget should not be spread evenly there.`,
    summary: actProfit.length > actVolume.length
      ? `Weak ${groupLabel} campaigns are dragging efficiency. Reallocation should happen inside that cohort before broad scaling.`
      : `At least one ${groupLabel} campaign is materially stronger than its comparable peers and can absorb more spend.`,
    recommendedAction: bestCampaign && weakCampaign
      ? `Shift 10-15% budget from ${weakCampaign.row.name} into ${bestCampaign.row.name} inside the ${groupLabel} cohort, then validate cohort ROAS over 3-5 days.`
      : "Reallocate budget away from weaker campaigns into the top-performing comparable structure.",
    expectedImpact: "Cleaner blended ROAS and faster learning on stronger campaigns.",
    evidence: [
      { label: "Comparison set", value: groupLabel, tone: "neutral" },
      { label: "Lane filter", value: "Scaling + validation only", tone: "neutral" },
      { label: "Lane mix", value: `${selectedGroup.laneMix.scaling} scaling / ${selectedGroup.laneMix.validation} validation`, tone: "neutral" },
      bestCampaign
        ? { label: "Best campaign", value: `${bestCampaign.row.name} · ${fmtRoas(bestCampaign.core.roas)}`, tone: "positive" }
        : { label: "Best campaign", value: "—", tone: "neutral" },
      weakCampaign
        ? { label: "Weak campaign", value: `${weakCampaign.row.name} · ${fmtRoas(weakCampaign.core.roas)}`, tone: "warning" }
        : { label: "Weak campaign", value: "—", tone: "neutral" },
    ],
    timeframeContext: buildTimeframeContext(
      "Core verdict compares only like-for-like campaigns inside the same cohort before suggesting budget movement.",
      "Selected range is only the current view of a broader, weighted cohort ranking.",
      "It is reinforced by weighted performance dispersion between current campaign leaders and laggards across recent and historical windows.",
      "none",
      null
    ),
    comparisonCohort: groupLabel,
    strategyLayer: "budget",
  };
}

function buildSummary(recommendations: MetaRecommendation[], language: AppLanguage): MetaDecisionSummary {
  if (recommendations.length === 0) {
    return {
      title: language === "tr" ? "Güçlü bir mudahale sinyali yok" : "No strong intervention signal",
      summary:
        language === "tr"
          ? "Meta karar motoru henüz yüksek güvenli bir yapı, ölçekleme veya kârlılık aksiyonu görmüyor. Mevcut kurulumla izlemeye devam edin."
          : "Meta decision engine does not see a high-confidence structural, scale, or profitability action yet. Keep monitoring with the current setup.",
      primaryLens: "structure",
      confidence: "low",
      recommendationCount: 0,
    };
  }

  const top = recommendations[0];
  const actCount = recommendations.filter((recommendation) => recommendation.decisionState === "act").length;
  const rebuildRecommendation = recommendations.find((recommendation) => recommendation.type === "rebuild_with_constraints");
  const seasonalRecommendation = recommendations.find((recommendation) => recommendation.type === "seasonal_regime_shift");
  const scalingStructureRecommendation = recommendations.find((recommendation) => recommendation.type === "scaling_structure_fit");
  const creativeTestRecommendation = recommendations.find((recommendation) => recommendation.type === "creative_test_structure");
  const winnerPromotionRecommendation = recommendations.find((recommendation) => recommendation.type === "winner_promotion_flow");
  const operatingMode =
    rebuildRecommendation
      ? language === "tr"
        ? "Meta operating model için rebuild öneriliyor"
        : "Operating model reset recommended"
      : seasonalRecommendation?.seasonalState === "peak"
        ? language === "tr"
          ? "Sezonsal zirve modu"
          : "Seasonal peak operating mode"
        : language === "tr"
          ? "Normalize çalışma modu"
          : "Normalized operating mode";
  const currentRegime = rebuildRecommendation
    ? language === "tr"
      ? `Mevcut rejim: ${rebuildRecommendation.evidence.find((item) => item.label === "Current regime")?.value ?? "Mixed"}`
      : `Current regime: ${rebuildRecommendation.evidence.find((item) => item.label === "Current regime")?.value ?? "Mixed"}`
    : null;
  const recommendedMode = rebuildRecommendation
    ? language === "tr"
      ? `Önerilen mod: ${rebuildRecommendation.historicalRegime ?? "Constrained Bidding"}`
      : `Recommended mode: ${rebuildRecommendation.historicalRegime ?? "Constrained Bidding"}`
    : top.historicalRegime
      ? language === "tr"
        ? `Tarihsel rejim: ${top.historicalRegime}`
        : `Historical regime: ${top.historicalRegime}`
      : null;

  return {
    title: rebuildRecommendation
      ? language === "tr"
        ? "Meta operating model için rebuild öneriliyor"
        : "Meta operating model reset recommended"
      : top.decisionState === "act"
        ? language === "tr"
          ? "Meta tarafında ilk ele alınacak aksiyon"
          : "Highest-priority Meta action"
        : language === "tr"
          ? "Meta izleme listesi ve test alanlari"
          : "Meta watchlist and tests",
    summary:
      rebuildRecommendation
        ? rebuildRecommendation.summary
        : scalingStructureRecommendation && creativeTestRecommendation
        ? `${scalingStructureRecommendation.summary} ${creativeTestRecommendation.summary}`
        : winnerPromotionRecommendation
        ? winnerPromotionRecommendation.summary
        : actCount > 0
        ? language === "tr"
          ? `${actCount} öneri doğrudan aksiyona alınabilecek kadar güçlü görünüyor. İlk odak noktası: ${top.title}.`
          : `${actCount} recommendation${actCount === 1 ? "" : "s"} are strong enough to act on now. Highest priority: ${top.title}.`
        : seasonalRecommendation
          ? seasonalRecommendation.summary
          : language === "tr"
            ? `Hemen aksiyona alınacak yüksek güvenli bir öneri yok. Şu anki en güçlü sinyal: ${top.title}.`
            : `No high-confidence act-now recommendation yet. Strongest current signal: ${top.title}.`,
    primaryLens: top.lens,
    confidence: top.confidence,
    recommendationCount: recommendations.length,
    operatingMode,
    currentRegime,
    recommendedMode,
  };
}

function ensurePriorityRecommendationsIncluded(
  allRecommendations: MetaRecommendation[],
  visibleRecommendations: MetaRecommendation[]
) {
  const requiredTypes: MetaRecommendationType[] = [
    "bid_strategy_fit",
    "bid_value_guidance",
    "scaling_structure_fit",
    "creative_test_structure",
    "winner_promotion_flow",
  ];

  const next = [...visibleRecommendations];
  for (const requiredType of requiredTypes) {
    const bestMatch = [...allRecommendations]
      .sort((a, b) => sortWeight(b) - sortWeight(a))
      .find((recommendation) => recommendation.type === requiredType);
    if (!bestMatch) continue;
    if (next.some((recommendation) => recommendation.type === requiredType)) continue;
    next.push(bestMatch);
  }

  return next
    .filter((recommendation, index, list) => list.findIndex((item) => item.id === recommendation.id) === index)
    .sort((a, b) => sortWeight(b) - sortWeight(a))
    .slice(0, 10);
}

export function buildMetaRecommendations(input: {
  windows: MetaRecommendationWindows;
  breakdowns: MetaBreakdownsResponse | null;
  historicalBidRegimes?: Record<string, MetaBidRegimeHistorySummary>;
  creativeIntelligence?: MetaCreativeIntelligenceSummary | null;
  calibrationContext?: MetaCalibrationContext | null;
  calibrationContextByCampaignId?: Record<string, MetaCalibrationContext | null | undefined>;
  entitySignalsByCampaignId?: Record<string, MetaEntityDecisionSignal | null | undefined>;
  commercialTargets?: MetaCommercialTargets | null;
  language?: AppLanguage;
}): MetaRecommendationsResponse {
  const language = input.language ?? "en";
  const allWindows = buildCampaignWindows(input.windows);
  const allSelectedRows = input.windows.selected;
  const purchaseDownshiftScenarios = buildPurchaseDownshiftScenarioRecommendations({
    windows: allWindows,
    selectedRows: allSelectedRows,
    calibrationContext: input.calibrationContext ?? null,
    calibrationContextByCampaignId: input.calibrationContextByCampaignId,
    entitySignalsByCampaignId: input.entitySignalsByCampaignId,
    commercialTargets: input.commercialTargets ?? null,
  });
  const purchaseWindows: MetaRecommendationWindows = {
    selected: filterPurchaseObjectiveRows(input.windows.selected),
    previousSelected: filterPurchaseObjectiveRows(input.windows.previousSelected),
    last3: filterPurchaseObjectiveRows(input.windows.last3),
    last7: filterPurchaseObjectiveRows(input.windows.last7),
    last14: filterPurchaseObjectiveRows(input.windows.last14),
    last30: filterPurchaseObjectiveRows(input.windows.last30),
    last90: filterPurchaseObjectiveRows(input.windows.last90),
    allHistory: filterPurchaseObjectiveRows(input.windows.allHistory),
  };
  const windows = buildCampaignWindows(purchaseWindows);
  const selectedRows = purchaseWindows.selected;
  if (selectedRows.length === 0) {
    if (purchaseDownshiftScenarios.length > 0) {
      const stampedDownshift = purchaseDownshiftScenarios.map(stampRecommendation);
      return localizeMetaRecommendationsResponse({
        status: "ok",
        summary: buildSummary(stampedDownshift, language),
        recommendations: stampedDownshift,
      }, language);
    }
    return {
      status: "ok",
      summary: {
        title: language === "tr" ? "Purchase odakli Meta icgorusu yok" : "No purchase-focused Meta insight",
        summary:
          language === "tr"
            ? "Öneriler şu anda purchase/value kampanyalariyla sinirli. Bu workspace'in mevcut veri setinde uygun bir purchase kampanyasi yok."
            : "Recommendations are currently limited to purchase/value campaigns. This workspace does not have an eligible purchase campaign in the current dataset.",
        primaryLens: "structure",
        confidence: "low",
        recommendationCount: 0,
      },
      recommendations: [],
    };
  }
  const selectedAccount = accountMetrics(selectedRows);
  const taxonomyContext = buildRecommendationTaxonomyContext(selectedRows);
  const suggestedBidRange = historicalBidRange(purchaseWindows);
  const suggestedRoasRange = historicalRoasRange(purchaseWindows);
  const seasonalContext = buildSeasonalContext(purchaseWindows);
  const scalingStructureSnapshot = buildScalingStructureSnapshot(windows);

  const recommendations: MetaRecommendation[] = [...purchaseDownshiftScenarios];

  const seasonalRecommendation = maybeSeasonalRegimeRecommendation(purchaseWindows, seasonalContext);
  if (seasonalRecommendation) recommendations.push(seasonalRecommendation);

  const historicalBidRegimeRecommendation = maybeHistoricalBidRegimeRecommendation(
    selectedRows,
    input.historicalBidRegimes,
    seasonalContext
  );
  if (historicalBidRegimeRecommendation) recommendations.push(historicalBidRegimeRecommendation);

  const bidBandRecommendation = maybeBidBandRecommendation(
    selectedRows,
    suggestedBidRange,
    suggestedRoasRange,
    seasonalContext
  );
  if (bidBandRecommendation) recommendations.push(bidBandRecommendation);

  const rebuildRecommendation = maybeRebuildRecommendation(
    selectedRows,
    input.historicalBidRegimes,
    seasonalContext,
    suggestedBidRange
  );
  if (rebuildRecommendation) recommendations.push(rebuildRecommendation);

  const geoClusterRecommendation = maybeGeoClusterRecommendation(
    input.breakdowns,
    scalingStructureSnapshot,
    input.creativeIntelligence
  );
  if (geoClusterRecommendation) recommendations.push(geoClusterRecommendation);

  const scalingStructureRecommendation = maybeScalingStructureRecommendation(
    scalingStructureSnapshot,
    seasonalContext,
    input.creativeIntelligence
  ) ?? maybeFallbackScalingStructureRecommendation(selectedRows, seasonalContext, input.creativeIntelligence);
  if (scalingStructureRecommendation) recommendations.push(scalingStructureRecommendation);

  const creativeTestRecommendation = maybeCreativeTestStructureRecommendation(
    scalingStructureSnapshot,
    geoClusterRecommendation,
    input.creativeIntelligence
  ) ?? maybeFallbackCreativeTestStructureRecommendation(selectedRows, input.creativeIntelligence);
  if (creativeTestRecommendation) recommendations.push(creativeTestRecommendation);

  const winnerPromotionRecommendation = maybeWinnerPromotionRecommendation(
    scalingStructureSnapshot,
    input.creativeIntelligence
  ) ?? maybeFallbackWinnerPromotionRecommendation(selectedRows, input.creativeIntelligence);
  if (winnerPromotionRecommendation) recommendations.push(winnerPromotionRecommendation);

  for (const campaignWindow of windows) {
    const peerRows = comparablePeerRows(selectedRows, campaignWindow.selected);
    const peerMetrics = accountMetrics(peerRows);
    const calibrationContext =
      input.calibrationContextByCampaignId?.[campaignWindow.selected.id] ??
      input.calibrationContext ??
      null;
    const campaignRole = inferCampaignRole(campaignWindow.selected, {
      campaigns: selectedRows,
      laneSignals: taxonomyContext.laneSignals,
    });
    const bidRegime = inferBidRegime(null, campaignWindow.selected);
    const scenario = emitHighPriorityCampaignScenario({
      window: campaignWindow,
      context: calibrationContext,
      cohort: campaignFunnelCohort(campaignWindow.selected),
      campaignRole,
      bidRegime,
      signals: input.entitySignalsByCampaignId?.[campaignWindow.selected.id] ?? null,
      commercialTargets: input.commercialTargets ?? null,
    });
    if (scenario) recommendations.push(scenario);

    const structure = maybeStructureRecommendation(campaignWindow);
    if (structure) recommendations.push(structure);

    const optimization = maybeOptimizationRecommendation(campaignWindow);
    if (optimization) recommendations.push(optimization);

    const bid = maybeBidRecommendation(
      campaignWindow,
      selectedAccount.roas,
      suggestedBidRange,
      suggestedRoasRange,
      calibrationContext,
    );
    if (bid) recommendations.push(bid);

    const volume = maybeVolumeScaleRecommendation(
      campaignWindow,
      peerMetrics.roas || selectedAccount.roas,
      peerMetrics.cpa || selectedAccount.cpa,
      calibrationContext,
      input.commercialTargets ?? null,
    );
    if (volume) recommendations.push(volume);

    const profitability = maybeProfitabilityRecommendation(
      campaignWindow,
      peerMetrics.roas || selectedAccount.roas,
      peerRows,
      calibrationContext,
      input.commercialTargets ?? null,
    );
    if (profitability) recommendations.push(profitability);
  }

  const accountBudgetShift = maybeAccountBudgetShift(windows, recommendations);
  if (accountBudgetShift) recommendations.push(accountBudgetShift);

  const stampedRecommendations = recommendations
    .map((recommendation) =>
      enrichRecommendationTaxonomy(recommendation, taxonomyContext),
    )
    .map(stampRecommendation);
  const dedupedBase = stampedRecommendations
    .sort((a, b) => sortWeight(b) - sortWeight(a))
    .filter((recommendation, index, list) =>
      list.findIndex((item) => item.id === recommendation.id) === index
    )
    .slice(0, 250);
  const deduped = ensurePriorityRecommendationsIncluded(stampedRecommendations, dedupedBase);

  return localizeMetaRecommendationsResponse({
    status: "ok",
    summary: buildSummary(deduped, language),
    recommendations: deduped,
  }, language);
}
