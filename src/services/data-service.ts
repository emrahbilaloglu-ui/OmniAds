import {
  DateRange,
  IntegrationConnection,
  Platform,
  PlatformLevel,
  PlatformTableRow,
  Creative,
  LandingPage,
  Copy,
  MetricsRow,
} from "@/src/types";
import { getGooglePlatformTable } from "@/src/services/data-service-google";
import {
  getDemoCopies,
  getDemoCreatives,
  getDemoIntegrations,
  getDemoLandingPages,
  getDemoPlatformTable,
} from "@/src/services/data-service-demo";

export * from "@/src/services/data-service-overview";
export * from "@/src/services/data-service-ai-insights";

export async function getPlatformTable(
  platform: Platform,
  level: PlatformLevel,
  businessId: string,
  accountId: string | null,
  dateRange: DateRange,
  metrics: Array<keyof MetricsRow>
): Promise<PlatformTableRow[]> {
  if (platform === Platform.GOOGLE) {
    return getGooglePlatformTable(level, businessId, accountId, dateRange, metrics);
  }

  return getDemoPlatformTable(platform, level, businessId, accountId, dateRange, metrics);
}

export async function getCreatives(
  businessId: string,
  filters?: {
    platforms?: Platform[];
    dateRange?: "7d" | "30d";
    format?: "all" | "image" | "video";
    sortBy?: "roas" | "spend" | "ctr";
    search?: string;
  }
): Promise<Creative[]> {
  return getDemoCreatives(businessId, filters);
}

export async function getLandingPages(
  businessId: string,
  filters?: {
    platform?: Platform;
    dateRange?: "7d" | "30d";
    search?: string;
  }
): Promise<LandingPage[]> {
  return getDemoLandingPages(businessId, filters);
}

export async function getCopies(
  businessId: string,
  filters?: {
    platform?: Platform;
    dateRange?: "7d" | "30d";
    objective?: Copy["objective"] | "all";
    search?: string;
  }
): Promise<Copy[]> {
  return getDemoCopies(businessId, filters);
}

export async function getIntegrations(
  businessId: string
): Promise<IntegrationConnection[]> {
  return getDemoIntegrations(businessId);
}
