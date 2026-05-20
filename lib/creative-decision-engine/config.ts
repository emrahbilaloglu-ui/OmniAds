import type {
  BusinessConfig,
  CampaignObjective,
} from "./types";
import {
  DEFAULT_BUSINESS_CONFIG_VALUES,
  MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
  MIN_CAMPAIGN_CALIBRATION_SAMPLE,
  SCALE_RATIO_BY_PRESET,
} from "./config-values";

export {
  MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
  MIN_CAMPAIGN_CALIBRATION_SAMPLE,
  SCALE_RATIO_BY_PRESET,
} from "./config-values";

export const SUPPORTED_OBJECTIVES: ReadonlySet<CampaignObjective> = new Set([
  "OUTCOME_SALES",
]);

export function defaultBusinessConfig(businessId: string): BusinessConfig {
  return {
    businessId,
    ...DEFAULT_BUSINESS_CONFIG_VALUES,
  };
}
