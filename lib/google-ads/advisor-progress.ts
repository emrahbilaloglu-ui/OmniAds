import { GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS } from "@/lib/google-ads/advisor-readiness";

export interface GoogleAdsAdvisorProgressCoverageInput {
  completedDays?: number | null;
}

export interface GoogleAdsAdvisorProgressState {
  percent: number;
  visible: boolean;
  summary: string;
}

export function buildGoogleAdsAdvisorProgress(input: {
  connected: boolean;
  assignedAccountCount: number;
  coreUsable: boolean;
  advisorReady: boolean;
  coverages: GoogleAdsAdvisorProgressCoverageInput[];
  coverageUnavailableCount?: number;
}): GoogleAdsAdvisorProgressState {
  const normalizedCoverages = input.coverages.filter(
    (coverage) => coverage.completedDays != null && Number.isFinite(Number(coverage.completedDays))
  );
  const coverageUnavailableCount = Math.max(
    0,
    input.coverages.length - normalizedCoverages.length + (input.coverageUnavailableCount ?? 0)
  );
  const missingCoverage = normalizedCoverages.some(
    (coverage) =>
      Math.max(
        0,
        Math.min(GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS, Number(coverage.completedDays ?? 0))
      ) < GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS
  );
  const averageCoverageRatio =
    normalizedCoverages.reduce((sum, coverage) => {
      const completedDays = Math.max(
        0,
        Math.min(GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS, Number(coverage.completedDays ?? 0))
      );
      return sum + completedDays / GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS;
    }, 0) / Math.max(1, normalizedCoverages.length);

  // 100 belongs to `advisorReady` alone.
  //
  // `advisorReady` is now freshness-gated upstream — it requires every day in
  // the advisor window to have been re-read after it closed — so it is the one
  // input here backed by evidence. The `!missingCoverage` branch below used to
  // return 100 as well, on nothing but `completedDays >= 90` for each scope: a
  // window captured once and never refreshed reported the advisor fully
  // prepared. It is now capped at 99 like every other coverage-derived value.
  const percent = input.advisorReady
    ? 100
    : coverageUnavailableCount > 0 && normalizedCoverages.length > 0
      ? Math.max(
          input.coreUsable ? 95 : 10,
          Math.min(99, Math.round(averageCoverageRatio * 100))
        )
    : !missingCoverage
      ? 99
      : Math.max(
          input.coreUsable ? 10 : 0,
          Math.min(99, Math.round(averageCoverageRatio * 100))
        );

  const summary = !input.coreUsable
    ? `Campaign history is still being prepared for the ${GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS}-day decision snapshot.`
    : coverageUnavailableCount > 0
      ? `Finalizing ${GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS}-day decision snapshot support.`
      : !missingCoverage
      ? `Finalizing ${GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS}-day decision snapshot support.`
      : `Campaign, search term, and product history are still being prepared for the ${GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS}-day decision snapshot.`;

  return {
    percent,
    visible:
      input.connected &&
      input.assignedAccountCount > 0 &&
      percent < 100 &&
      (missingCoverage || coverageUnavailableCount > 0),
    summary,
  };
}
