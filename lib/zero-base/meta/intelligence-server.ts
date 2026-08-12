/**
 * Account Intelligence composition (H17/H18).
 *
 * Nine authorities, each read on the server and each reported on its own terms.
 * The rule that shapes the whole module: a source that could not be read says
 * so, in its own row, with its own reason. Collapsing them into one "some data
 * missing" line would hide that the remedies differ — a token to reconnect, a
 * window to wait for, an account to assign — and folding a failed read into a
 * zero would state a fact nobody observed.
 *
 * Every section is read through `Promise.allSettled`, so one failing authority
 * degrades one row rather than the page. Nothing here computes a decision or a
 * metric: sections carry counts and states the read models themselves produced.
 */
import { getIntegrationStatusByBusiness } from "@/lib/integration-status";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import {
  getMetaCanonicalOverviewSummary,
  getMetaCanonicalOverviewTrends,
} from "@/lib/meta/canonical-overview";
import { getMetaBreakdownsForRange } from "@/lib/meta/breakdowns-source";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import { readMetaAnomaliesForBusiness } from "@/lib/meta/anomalies";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import { readMetaDecisionsWorkspaceReadModel } from "@/lib/meta/decisions-workspace-read-model";
import type { ProviderSourceState } from "@/lib/zero-base/meta/automation-posture";

export interface IntelligenceFact {
  label: string;
  value: string;
}

export interface IntelligenceSection {
  key: string;
  label: string;
  state: ProviderSourceState;
  reason: string | null;
  observedAt: string | null;
  facts: IntelligenceFact[];
}

export interface MetaIntelligence {
  providerAccountId: string | null;
  sections: IntelligenceSection[];
  /** Set only when the whole surface cannot be composed. */
  unavailableReason: string | null;
}

/** Shape of a read model that reports its own partial state. */
interface PartialAware {
  isPartial?: boolean;
  notReadyReason?: string | null;
}

/**
 * Turn one authority's outcome into a section.
 *
 * A rejected read is `degraded` with the verbatim error, never `unavailable`:
 * unavailable means the source has nothing to give, and a failed read means we
 * do not know which of the two it is.
 */
function section(
  key: string,
  label: string,
  outcome: PromiseSettledResult<{ facts: IntelligenceFact[]; partial?: PartialAware } | null>,
  observedAt: string | null,
): IntelligenceSection {
  if (outcome.status === "rejected") {
    return {
      key,
      label,
      state: "degraded",
      reason:
        outcome.reason instanceof Error
          ? outcome.reason.message
          : "This source could not be read.",
      observedAt: null,
      facts: [],
    };
  }
  if (!outcome.value) {
    return {
      key,
      label,
      state: "unavailable",
      reason: "This source is not configured for this business.",
      observedAt: null,
      facts: [],
    };
  }
  const partial = outcome.value.partial;
  if (partial?.isPartial) {
    return {
      key,
      label,
      state: "partial",
      // The read model's own words. Rewriting them here would let this surface
      // disagree with the source about why it is incomplete.
      reason: partial.notReadyReason ?? "This source returned an incomplete window.",
      observedAt,
      facts: outcome.value.facts,
    };
  }
  return { key, label, state: "serving", reason: null, observedAt, facts: outcome.value.facts };
}

function count(value: unknown): string {
  return Array.isArray(value) ? String(value.length) : "Not reported";
}

/**
 * Compose Account Intelligence for one business.
 *
 * `startDate`/`endDate` scope every windowed source to the same range, so two
 * sections cannot silently describe different periods.
 */
export async function readMetaIntelligence(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  now?: Date;
}): Promise<MetaIntelligence> {
  const { businessId, startDate, endDate } = input;
  const observedAt = (input.now ?? new Date()).toISOString();

  const integrations = await getIntegrationStatusByBusiness(businessId).catch(() => null);
  if (!integrations) {
    return {
      providerAccountId: null,
      sections: [],
      unavailableReason:
        "Integration status could not be read for this business, so no source state can be reported.",
    };
  }
  if (!integrations.meta) {
    return {
      providerAccountId: null,
      sections: [],
      unavailableReason: "Meta is not connected for this business.",
    };
  }

  const assignment = await getProviderAccountAssignments(businessId, "meta").catch(() => null);
  // One assigned account resolves; zero or several do not. Picking one of
  // several would scope every section below to an account nobody chose.
  const providerAccountId =
    assignment?.account_ids?.length === 1 ? assignment.account_ids[0] : null;

  const [status, pulse, summary, trends, breakdowns, anomalies, labels, workspace] =
    await Promise.allSettled([
      // 1 · status — the connection and account assignment behind everything else.
      (async () => ({
        facts: [
          { label: "Meta connection", value: "Connected" },
          {
            label: "Selected account",
            value: providerAccountId ?? "None selected",
          },
        ],
        // An assigned-but-unselected account is a real half-state, not a failure.
        partial: providerAccountId
          ? undefined
          : {
              isPartial: true,
              notReadyReason:
                "No Meta account is selected for this business, so account-scoped sources cannot resolve.",
            },
      }))(),

      // 2 · account pulse — campaign delivery in the window.
      (async () => {
        const campaigns = await getMetaCampaignsForRange({
          businessId,
          startDate,
          endDate,
          accountId: providerAccountId,
        });
        const rows = (campaigns as { campaigns?: unknown }).campaigns;
        return {
          facts: [{ label: "Campaigns in window", value: count(rows) }],
          partial: campaigns as PartialAware,
        };
      })(),

      // 3 · summary
      (async () => {
        const result = await getMetaCanonicalOverviewSummary({ businessId, startDate, endDate });
        return {
          facts: [{ label: "Read source", value: result.readSource }],
          partial: result,
        };
      })(),

      // 4 · trends
      (async () => {
        const result = await getMetaCanonicalOverviewTrends({
          businessId,
          startDate,
          endDate,
          providerAccountId,
        });
        return {
          facts: [
            { label: "Trend points", value: count((result as { points?: unknown }).points) },
          ],
          partial: result,
        };
      })(),

      // 5 · breakdowns
      (async () => {
        const result = await getMetaBreakdownsForRange({ businessId, startDate, endDate });
        return {
          facts: [{ label: "Status", value: String(result.status) }],
          partial: result as PartialAware,
        };
      })(),

      // 6 · anomalies
      (async () => {
        const result = await readMetaAnomaliesForBusiness({
          businessId,
          providerAccountId,
          activeOnly: true,
        });
        return {
          facts: [
            { label: "Active anomalies", value: count((result as { anomalies?: unknown }).anomalies) },
          ],
          partial: result as PartialAware,
        };
      })(),

      // 7 · campaign labels
      (async () => {
        const result = await readMetaCampaignLabels({ businessId });
        return {
          facts: [{ label: "Labelled campaigns", value: count(result) }],
        };
      })(),

      // 8+9 · structure and recommendations both come from the decisions
      //       workspace read model, which is their shared authority.
      (async () => {
        if (!providerAccountId) return null;
        const model = await readMetaDecisionsWorkspaceReadModel({
          businessId,
          providerAccountId,
        });
        return {
          facts: [
            {
              label: "Structure rows",
              value: count((model as { structureRows?: unknown }).structureRows),
            },
          ],
          partial: model as PartialAware,
        };
      })(),
    ]);

  const sections: IntelligenceSection[] = [
    section("status", "Connection & account", status, observedAt),
    section("pulse", "Account pulse", pulse, observedAt),
    section("summary", "Summary", summary, observedAt),
    section("trends", "Trends", trends, observedAt),
    section("breakdowns", "Breakdowns", breakdowns, observedAt),
    section("anomalies", "Anomalies", anomalies, observedAt),
    section("labels", "Campaign labels", labels, observedAt),
    section("structure", "Structure & recommendations", workspace, observedAt),
  ];

  return { providerAccountId, sections, unavailableReason: null };
}
