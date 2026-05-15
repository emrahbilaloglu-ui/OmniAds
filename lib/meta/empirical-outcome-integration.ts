import {
  readMetaDecisionActionOutcomeLogsForRecommendationTypes,
} from "@/lib/meta/decision-outcomes";
import {
  summarizeMetaDecisionOutcomesByKey,
  type MetaDecisionOutcomeSummaryInputRow,
} from "@/lib/meta/empirical-outcomes";
import {
  attachMetaEmpiricalOutcomeSummariesToRecommendations,
  type MetaRecommendation,
} from "@/lib/meta/recommendations";

export async function attachMetaEmpiricalOutcomeSummariesFromLogs(input: {
  businessId: string;
  providerAccountId?: string | null;
  recommendations: MetaRecommendation[];
}): Promise<MetaRecommendation[]> {
  const recTypes = Array.from(
    new Set(input.recommendations.map((recommendation) => recommendation.type)),
  );
  if (recTypes.length === 0) return input.recommendations;

  // Outcome history is optional evidence; serving recommendations must stay available if it is absent.
  const rows = await readMetaDecisionActionOutcomeLogsForRecommendationTypes({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId ?? null,
    recTypes,
  }).catch((error) => {
    console.warn("[meta-empirical-outcomes] read_failed", {
      businessId: input.businessId,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  });

  if (rows.length === 0) return input.recommendations;
  const summariesByKey = summarizeMetaDecisionOutcomesByKey(
    rows as MetaDecisionOutcomeSummaryInputRow[],
  );
  return attachMetaEmpiricalOutcomeSummariesToRecommendations(
    input.recommendations,
    summariesByKey,
  );
}
