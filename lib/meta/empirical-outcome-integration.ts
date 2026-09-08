import { getDb } from "@/lib/db";
import { resolveMetaProviderLocalDayEnd } from "@/lib/meta/provider-local-day";
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

/**
 * ── ROUND 9 ITEM 6 ─────────────────────────────────────────────────────────
 * `providerAccountId` was optional here and optional in the query beneath it,
 * and no cutoff existed at all — so this helper could attach another account's
 * outcome history, or outcomes recorded after the window being served, to
 * recommendations an operator acts on. Both are required now, and an absent
 * scope attaches NOTHING rather than widening the read.
 */
export async function attachMetaEmpiricalOutcomeSummariesFromLogs(input: {
  businessId: string;
  providerAccountId: string;
  /** The served range's `endDate`; outcomes effective after it are excluded. */
  endDate: string;
  recommendations: MetaRecommendation[];
}): Promise<MetaRecommendation[]> {
  const recTypes = Array.from(
    new Set(input.recommendations.map((recommendation) => recommendation.type)),
  );
  if (recTypes.length === 0) return input.recommendations;
  // Outcome history is optional EVIDENCE, but an unscoped read is not a
  // degraded read — it is a wrong one. No account or no cutoff means no
  // history, and the recommendations serve unannotated.
  if (!input.providerAccountId?.trim() || !input.endDate?.trim()) {
    return input.recommendations;
  }

  // Outcome history is optional evidence; serving recommendations must stay available if it is absent.
  /*
    ROUND 10 ITEM 4. The window ends at the end of the ADVERTISER's day, as an
    absolute instant. A null here — no binding, no timezone, an unresolvable
    zone — attaches no history at all: an unbounded or UTC-guessed window is
    exactly what this replaces, and this signal can only ever raise confidence.
  */
  const occurredBefore = await resolveMetaProviderLocalDayEnd({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    day: input.endDate,
    query: (text, params) => getDb().query(text, params),
  }).catch(() => null);
  if (!occurredBefore) return input.recommendations;

  const rows = await readMetaDecisionActionOutcomeLogsForRecommendationTypes({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    occurredBefore,
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
