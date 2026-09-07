/**
 * Maps the existing Meta history authority onto the canonical History surface.
 *
 * Two provenance facts survive this mapping intact, because losing either is
 * how a later reader mistakes a reconstruction for a record:
 *
 * - **replay.** A replayed entry was recomputed after the fact and did not
 *   drive the decision taken at the time. The flag comes straight from the read
 *   model's `replay` object, and any replayed row raises a banner that cannot
 *   be dismissed.
 * - **actor.** The read model distinguishes an actor that is *available*, one
 *   that is *unavailable*, and one that is *not applicable* because no human
 *   acted. Those are three different sentences, and none of them is "System".
 */
import type {
  MetaHistoryEntry,
  MetaHistoryMoneyFact,
  MetaHistoryResponse,
} from "@/lib/meta/history-contract";

export interface HistoryRow {
  id: string;
  occurredAt: string;
  action: string;
  outcome: string;
  actor: string | null;
  replayed: boolean;
  /**
   * The engine version the replayed snapshot was produced by.
   *
   * `replayed` alone says a row is a reconstruction; the design's replay caveat
   * exists to ask *which* engine reconstructed it ("Replay ≠ live; V1/V2
   * snapshot badges"). The served `replay.engineVersion` is carried verbatim,
   * and a served `null` stays `null` so the drawer prints an em-dash rather
   * than a guessed version.
   */
  replayEngineVersion?: string | null;
  /** The engine's own reasoning for the entry, served or absent. Never composed here. */
  summary?: string | null;
  /**
   * The money facts the read model served, verbatim.
   *
   * Nothing is re-derived: a fact whose currency could not be resolved arrives
   * with a null amount and is rendered as an em-dash, because a number with no
   * currency is not an amount.
   */
  money?: readonly MetaHistoryMoneyFact[];
}

export interface HistoryPage {
  rows: HistoryRow[];
  /** Stated whenever the page is capped, so "no more" is never implied. */
  disclosure: string | null;
  limitations: string[];
  accountLabel: string | null;
  /**
   * The cursor the disclosure is talking about.
   *
   * It used to be dropped here, so the surface printed "More exist beyond this
   * page" while holding nothing that could ask for them: the operator read a
   * sentence about row 41 with no way to reach it.
   */
  nextCursor: string | null;
}

/** Keep unnamed accounts distinguishable without printing a full provider id. */
export function historyAccountLabel(account: {
  id: string;
  name: string | null;
}): string {
  const id = account.id.trim();
  const name = (account.name ?? "").trim();
  const providerId = id.replace(/^act_/i, "");
  if (name && name !== id && name !== providerId) return name;
  const suffix = providerId.slice(-4);
  return suffix ? `Meta account ••••${suffix}` : "Meta account";
}

function outcomeSummary(status: MetaHistoryEntry["status"]): string | null {
  if (status === "improved")
    return "Performance improved over the next 7 days.";
  if (status === "regressed")
    return "Performance declined over the next 7 days.";
  if (status === "flat")
    return "Performance was broadly unchanged over the next 7 days.";
  if (status === "inconclusive") {
    return "There is not enough evidence to judge the 7-day result.";
  }
  return null;
}

/**
 * Stored summaries predate the buyer UI and can contain rule names or JSON.
 * Preserve normal explanatory prose. Known KPI rows retain their measured
 * movement and action receipt; unknown machine-shaped detail stays hidden.
 */
export function historySummaryFor(entry: MetaHistoryEntry): string | null {
  const summary = entry.summary?.trim() ?? "";
  if (!summary) return null;

  const automaticKpi = summary.match(
    /^auto_kpi_7d:\s*(improved|regressed|flat|inconclusive)\s*\(ROAS\s+(n\/a|-?\d+(?:\.\d+)?)\s*->\s*(n\/a|-?\d+(?:\.\d+)?),\s*operator\s+(acted|did not act)\)$/i,
  );
  if (automaticKpi) {
    const [, rawStatus, before, after, actionState] = automaticKpi;
    const status = rawStatus.toLowerCase() as MetaHistoryEntry["status"];
    const measured =
      before.toLowerCase() !== "n/a" && after.toLowerCase() !== "n/a";
    const result = measured
      ? status === "improved"
        ? `ROAS improved from ${before} to ${after} over the next 7 days.`
        : status === "regressed"
          ? `ROAS declined from ${before} to ${after} over the next 7 days.`
          : status === "flat"
            ? `ROAS moved from ${before} to ${after} with no clear 7-day change.`
            : `The 7-day ROAS result from ${before} to ${after} is inconclusive.`
      : outcomeSummary(status);
    const actionCopy =
      actionState.toLowerCase() === "acted"
        ? "A recorded action was applied."
        : "No action was recorded.";
    return result ? `${result} ${actionCopy}` : actionCopy;
  }

  const machinePrefix = /^[a-z0-9]+(?:[_-][a-z0-9]+)+(?:\.[a-z0-9]+)?:/i;
  if (machinePrefix.test(summary) || /^[\[{]/.test(summary)) {
    return outcomeSummary(entry.status);
  }
  return summary;
}

/**
 * Actor text for one entry.
 *
 * `null` is returned for both "unavailable" and an empty name, which the view
 * renders as "Actor not recorded". Attributing an unnamed change to the system
 * would be a claim about who acted.
 */
export function actorFor(entry: MetaHistoryEntry): string | null {
  if (entry.actor.availability === "not_applicable")
    return "No human actor (engine)";
  if (entry.actor.availability === "unavailable") return null;
  const name = (entry.actor.name ?? "").trim();
  return name.length > 0 ? name : null;
}

/**
 * The Action cell's text.
 *
 * Most branches of the journal SQL already fold the entity into the served
 * title (`'… | ' || COALESCE(entity_name, entity_id)`), but the decisions
 * branch does not: it serves a bare verdict such as "Scale budget", which left
 * the operator unable to tell which campaign or ad set the row was about. The
 * entity is appended only when the served title does not already carry it, in
 * the same ` | ` form the SQL uses, so no row gains a duplicate.
 *
 * The name is preferred. When it is unavailable, the UI uses a neutral entity
 * label instead of exposing a provider identifier.
 */
export function actionFor(entry: MetaHistoryEntry): string {
  const entityId = entry.entity.id.trim();
  const servedEntityName = (entry.entity.name ?? "").trim();
  const entityName =
    servedEntityName && servedEntityName !== entityId ? servedEntityName : "";
  const entityLabel =
    entityName ||
    {
      account: "Unnamed account",
      campaign: "Unnamed campaign",
      adset: "Unnamed ad set",
      ad: "Unnamed ad",
      creative: "Unnamed creative",
      creative_brief: "Unnamed creative brief",
      launch_intent: "Unnamed launch",
      recommendation: "Unnamed recommendation",
    }[entry.entity.type];
  let title = entry.title;
  if (entityId && entityLabel) {
    const rawIdSuffix = ` | ${entityId}`;
    if (title === entityId) title = entityLabel;
    else if (title.endsWith(rawIdSuffix)) {
      title = `${title.slice(0, -rawIdSuffix.length)} | ${entityLabel}`;
    }
  }
  if (!entityId && !entityName) return title;
  if (!entityLabel || title.includes(entityLabel)) return title;
  return `${title} | ${entityLabel}`;
}

/**
 * One money fact as text.
 *
 * An amount is only an amount in a currency. The read model nulls the amount
 * whenever the account currency could not be resolved, and that case renders as
 * an em-dash: printing the bare number would state a sum in no currency, which
 * a reader would silently take as their own.
 */
export function moneyFactText(fact: MetaHistoryMoneyFact): string {
  if (
    fact.availability !== "available" ||
    fact.amount === null ||
    !fact.currency
  ) {
    return "—";
  }
  return `${fact.amount} ${fact.currency}`;
}

export function toHistoryRow(entry: MetaHistoryEntry): HistoryRow {
  return {
    id: entry.id,
    occurredAt: entry.occurredAt,
    action: actionFor(entry),
    // The served status word, not a re-derived one.
    outcome: entry.status,
    actor: actorFor(entry),
    replayed: entry.replay !== null,
    replayEngineVersion: entry.replay?.engineVersion ?? null,
    summary: historySummaryFor(entry),
    money: entry.money,
  };
}

export function toHistoryPage(payload: MetaHistoryResponse): HistoryPage {
  const rows = payload.entries.map(toHistoryRow);
  // `total` is deliberately null on the cursor path, so the honest disclosure
  // names the cap and the fact that more may exist — never a total.
  const disclosure =
    payload.page.nextCursor !== null
      ? `Showing the ${payload.page.returned} most recent entries. More exist beyond this page.`
      : payload.page.returned >= payload.page.limit
        ? `Showing ${payload.page.returned} entries, the maximum for one page.`
        : null;

  return {
    rows,
    disclosure,
    limitations: payload.limitations.map((item) => item.message),
    accountLabel: historyAccountLabel({
      id: payload.scope.providerAccountId,
      name: payload.scope.providerAccountName,
    }),
    nextCursor: payload.page.nextCursor,
  };
}
