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
 *   acted. Those are three different buyer-facing states, and none of them is
 *   the vague attribution "System".
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
  /** Buyer-facing explanation mapped from the stored reason, or absent. */
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

const CAMPAIGN_SETUP_REVIEW =
  "Campaign setup is unclear, so spend changes are waiting for fresher evidence.";

function statusSummary(status: MetaHistoryEntry["status"]): string | null {
  if (status === "partially_succeeded") {
    return "Some changes were applied. Review the result before continuing.";
  }
  if (
    status === "failed" ||
    status === "silent_failure" ||
    status === "unknown_outcome" ||
    status === "unknown"
  ) {
    return "The result could not be verified.";
  }
  if (status === "validation_blocked" || status === "write_blocked") {
    return "The change was not applied.";
  }
  return outcomeSummary(status);
}

function looksLikeOpaqueIdentifier(value: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ) ||
    /^act_\d{6,}$/i.test(value) ||
    /^\d{10,}$/.test(value)
  );
}

const BUYER_REASON_CODES: Record<string, string> = {
  seasonal_expected: "Seasonal change was expected.",
  wrong_call: "The decision was marked incorrect.",
  wrong_target: "The decision targeted the wrong item.",
};

function containsUnsafeBackendDetail(
  value: string,
  allowedIdentifier?: string,
): boolean {
  const inspected =
    allowedIdentifier && looksLikeOpaqueIdentifier(allowedIdentifier)
      ? value.replaceAll(allowedIdentifier, "")
      : value;
  return (
    /provider response|decision reference|canonical (?:decision|identity)|persisted (?:source|row)|\b(?:provider|database|postgres|supabase|redis|sqlstate|sql|relation|schema|table|column|query|payload|resolver|engine|checkpoint|internal|exception|status code|stack trace|undefined|null|uuid|econn\w*|connection refused|timed? out|timeout|fetch failed|source read failed|access token|rate limit|unauthorized|forbidden|graphql|oauth|launchintent)\b|\b(?:request|response)\b[^.]*\b(?:failed|failure|error|http)\b|\b(?:failed|failure|error)\b[^.]*\b(?:request|response|http)\b/i.test(
      inspected,
    ) ||
    /https?:\/\//i.test(inspected) ||
    /\bact_\d{6,}\b/i.test(inspected) ||
    /\b\d{10,}\b/.test(inspected) ||
    /\b[\w.-]+\.(?:ts|tsx|js|mjs|sql):\d+\b/i.test(inspected) ||
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(
      inspected,
    )
  );
}

function isMachineShaped(value: string): boolean {
  return (
    /^[a-z0-9]+(?:[_-][a-z0-9]+)+(?:\.[a-z0-9]+)?:/i.test(value) ||
    /^[a-z0-9]+(?:[_-][a-z0-9]+)+$/i.test(value) ||
    /^[\[{]/.test(value)
  );
}

function containsCampaignSetupInternals(value: string): boolean {
  const normalized = value.replace(/[_-]+/g, " ");
  return (
    /rerun automatic (?:campaign role |role )?inference/i.test(normalized) ||
    /(?:automatic (?:main\/test\/mixed )?campaign role(?: inference)?|automatic role inference|campaign role|campaign context|main\/test\/mixed (?:campaign )?context).{0,100}\b(?:unresolved|unknown|low confidence|conflict(?:ed|ing)?|missing|not resolved|cannot be determined)\b/i.test(
      normalized,
    ) ||
    /\b(?:unresolved|unknown|low confidence|conflict(?:ed|ing)?|missing|not resolved|cannot be determined)\b.{0,100}(?:automatic (?:main\/test\/mixed )?campaign role(?: inference)?|automatic role inference|campaign role|campaign context|main\/test\/mixed (?:campaign )?context)/i.test(
      normalized,
    )
  );
}

function translateResolvedCampaignRole(
  value: string,
  context: "action" | "summary",
): string | null {
  const match = value.match(
    /automatic[\s_-]+(?:main\/test\/mixed[\s_-]+)?campaign[\s_-]+role(?:[\s_-]+inference)?[\s_-]+(?:is[\s_-]+)?(?:resolved|confirmed|classified)[\s_-]+(?:as[\s_-]+)?(main|test|mixed)\b[.!]?/i,
  );
  if (!match) return null;
  const role =
    match[1].slice(0, 1).toUpperCase() + match[1].slice(1).toLowerCase();
  const replacement =
    context === "summary"
      ? `Campaign role: ${role}.`
      : `Campaign role confirmed: ${role}`;
  return value
    .replace(match[0], replacement)
    .replace(/\.\s*\./g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function campaignSetupSummary(value: string): string {
  const marker = value.search(
    /automatic (?:main\/test\/mixed )?campaign(?:-| )role|automatic role inference|role inference|the engine (?:emits?|will not emit) hard|hard actions? stay soft-only/i,
  );
  const prefix = marker > 0
    ? value
        .slice(0, marker)
        .replace(/[\s([\u2014:;-]+$/g, "")
        .trim()
    : "";
  if (!prefix) return CAMPAIGN_SETUP_REVIEW;
  const punctuation = /[.!?]$/.test(prefix) ? "" : ".";
  return `${prefix}${punctuation} ${CAMPAIGN_SETUP_REVIEW}`;
}

/**
 * Stored summaries predate the buyer UI and can contain rule names or JSON.
 * Preserve normal explanatory prose and measured facts. Translate known
 * internal wording; unknown machine-shaped detail stays hidden.
 */
export function historySummaryFor(entry: MetaHistoryEntry): string | null {
  const summary = entry.summary?.trim() ?? "";
  if (entry.status === "partially_succeeded") {
    return statusSummary(entry.status);
  }
  if (!summary) return statusSummary(entry.status);

  const knownReason = BUYER_REASON_CODES[summary.toLowerCase()];
  if (knownReason) return knownReason;

  const resolvedRoleSummary = translateResolvedCampaignRole(summary, "summary");
  if (resolvedRoleSummary && !containsCampaignSetupInternals(summary)) {
    return historySummaryFor({ ...entry, summary: resolvedRoleSummary });
  }

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

  const internalDecisionPrefix = summary.match(
    /^\[(soft-only[^\]]*|campaign context[^\]]*)\]\s*(.+)$/i,
  );
  if (internalDecisionPrefix) {
    const explicitCampaignContext = containsCampaignSetupInternals(
      internalDecisionPrefix[1],
    );
    const useful = internalDecisionPrefix[2]
      .replace(/\s*\(threshold baseline[\s\S]*\)\s*$/i, "")
      .trim();
    const buyerEvidence = useful
      ? historySummaryFor({ ...entry, summary: useful })
      : null;
    if (!explicitCampaignContext) {
      return buyerEvidence ?? statusSummary(entry.status);
    }
    if (buyerEvidence?.includes(CAMPAIGN_SETUP_REVIEW)) return buyerEvidence;
    return buyerEvidence
      ? `${buyerEvidence}${/[.!?]$/.test(buyerEvidence) ? "" : "."} ${CAMPAIGN_SETUP_REVIEW}`
      : CAMPAIGN_SETUP_REVIEW;
  }

  if (containsCampaignSetupInternals(summary)) {
    return campaignSetupSummary(summary);
  }

  if (/^Mature entity is above the calibrated upper ROAS band/i.test(summary)) {
    return "Performance is above the upper ROAS range. Leave it unchanged.";
  }
  if (/^Entity is not a sales-action candidate/i.test(summary)) {
    return "This item is outside sales optimization.";
  }
  const nonPurchase = summary.match(
    /^(Campaign|Adset) is configured for (.+?) delivery; not evaluated in the purchase decision engine\.?$/i,
  );
  if (nonPurchase) {
    const [, entity, cohort] = nonPurchase;
    return `${entity.toLowerCase() === "adset" ? "Ad set" : "Campaign"} is optimized for ${cohort}, so purchase-based changes do not apply.`;
  }
  if (/^Paused or inactive entity has no current spend pressure/i.test(summary)) {
    return "This item is paused or inactive and has no recent spend.";
  }
  if (/^Signal is thin or delivery is not mature enough/i.test(summary)) {
    return "There is not enough evidence for a confident change.";
  }
  if (/^Entity is mature enough for coverage but does not meet a scenario action threshold/i.test(summary)) {
    return "Current performance does not justify a change.";
  }
  if (/^Entity state row\.?$/i.test(summary)) return null;

  const stateEvaluation = summary.match(
    /^.+? is covered by Meta Engine v\d+ state evaluation at (\S+) ROAS on (\d+) purchases\.?$/i,
  );
  if (stateEvaluation) {
    return `ROAS is ${stateEvaluation[1]} across ${stateEvaluation[2]} purchases.`;
  }

  const cleanedDecisionSummary = summary
    .replace(/^\[(?:at target|weak target)\]\s*/i, "")
    .replace(/\s*\(threshold baseline[\s\S]*\)\s*$/i, "")
    .trim();
  if (cleanedDecisionSummary !== summary) {
    return cleanedDecisionSummary
      ? historySummaryFor({ ...entry, summary: cleanedDecisionSummary })
      : statusSummary(entry.status);
  }

  const persistedStatus = summary.match(
    /^Last persisted (campaign|ad set) status:\s*([a-z0-9_-]+)\.?$/i,
  );
  if (persistedStatus) {
    const [, entity, rawStatus] = persistedStatus;
    const status = rawStatus.replace(/[_-]+/g, " ").toLowerCase();
    return `${entity === "campaign" ? "Campaign" : "Ad set"} status: ${status}.`;
  }

  if (/^Account-scoped PAUSED launch workflow\.?$/i.test(summary)) {
    return "Launch prepared in paused status.";
  }

  if (
    entry.provenance.source === "meta_ads_action_log" ||
    (entry.provenance.source === "meta_launch_intents" &&
      (entry.status === "failed" ||
        entry.status === "validation_blocked" ||
        entry.status === "write_blocked" ||
        entry.status === "unknown")) ||
    entry.provenance.source === "decision_workflow_events"
  ) {
    return statusSummary(entry.status);
  }

  if (containsUnsafeBackendDetail(summary)) {
    return statusSummary(entry.status);
  }

  if (isMachineShaped(summary)) {
    return statusSummary(entry.status);
  }
  return summary;
}

/**
 * Actor text for one entry.
 *
 * `null` is returned for both "unavailable" and an empty name, which the view
 * renders as "Not recorded". Attributing an unnamed change to the system would
 * be a claim about who acted.
 */
export function actorFor(entry: MetaHistoryEntry): string | null {
  const provenanceLabel = () => {
    if (
      entry.provenance.attribution === "engine_snapshot" ||
      entry.provenance.attribution === "engine_transition"
    ) {
      return "Automated";
    }
    if (
      entry.provenance.attribution === "warehouse_dimension" ||
      entry.provenance.attribution === "provider_config_history" ||
      entry.provenance.attribution === "provider_state_history" ||
      entry.provenance.attribution === "correlational_outcome" ||
      entry.kind === "external_changes"
    ) {
      return "Observed";
    }
    return null;
  };
  if (entry.actor.availability === "not_applicable") return provenanceLabel();
  if (entry.actor.availability === "unavailable") return null;
  const name = (entry.actor.name ?? "").trim();
  if (/^(?:system|automated|no human actor \(engine\))$/i.test(name)) {
    return provenanceLabel();
  }
  if (/^(?:user|usr|actor|system)[_-][a-z0-9-]+$/i.test(name)) return null;
  return name.length > 0 && !looksLikeOpaqueIdentifier(name) ? name : null;
}

/** A stable buyer-facing entity name that never falls back to a provider id. */
export function historyEntityLabel(entry: MetaHistoryEntry): string {
  const entityId = entry.entity.id.trim();
  const name = (entry.entity.name ?? "").trim();
  if (name && name !== entityId && !looksLikeOpaqueIdentifier(name)) return name;
  return {
    account: "Unnamed account",
    campaign: "Unnamed campaign",
    adset: "Unnamed ad set",
    ad: "Unnamed ad",
    creative: "Unnamed creative",
    creative_brief: "Unnamed creative brief",
    launch_intent: "Unnamed launch",
    recommendation: "Unnamed recommendation",
  }[entry.entity.type];
}

const BUYER_LABELS: Record<string, string> = {
  scale: "Scale",
  keep: "Keep",
  refresh: "Refresh",
  cut: "Cut",
  test_more: "Test more",
  diagnose: "Diagnose",
  out_of_scope: "Out of scope",
  active: "Active",
  paused: "Paused",
  archived: "Archived",
  open: "Open",
  acknowledged: "Acknowledged",
  deferred: "Deferred",
  snoozed: "Snoozed",
  rejected: "Rejected",
  resolved: "Resolved",
};

/** Only known product words reach the small row label; storage codes stay out. */
export function historyLabelFor(entry: MetaHistoryEntry): string | null {
  const raw = entry.label?.trim() ?? "";
  if (!raw || raw === entry.entity.id.trim() || looksLikeOpaqueIdentifier(raw)) {
    return null;
  }
  return BUYER_LABELS[raw.toLowerCase()] ?? null;
}

function fallbackAction(entry: MetaHistoryEntry): string {
  if (entry.kind === "writes") {
    if (
      entry.status === "failed" ||
      entry.status === "silent_failure" ||
      entry.status === "unknown_outcome" ||
      entry.status === "unknown"
    ) {
      return "Change failed";
    }
    if (
      entry.status === "validation_blocked" ||
      entry.status === "write_blocked"
    ) {
      return "Change blocked";
    }
    if (entry.status === "partially_succeeded") {
      return "Change partially applied";
    }
    if (entry.status === "pending" || entry.status === "executing") {
      return "Change in progress";
    }
    if (entry.status === "verified_success" || entry.status === "succeeded") {
      return "Change verified";
    }
    return "Change recorded";
  }
  return {
    decisions: "Decision recorded",
    responses: "Action result recorded",
    label_flips: "Decision changed",
    outcomes: "Outcome recorded",
    briefs: "Creative brief updated",
    launches: "Launch updated",
    structures: "Structure updated",
    external_changes: "External change recorded",
  }[entry.kind];
}

function buyerFacingAction(entry: MetaHistoryEntry): string {
  let title = entry.title.trim();
  if (!title || looksLikeOpaqueIdentifier(title)) return fallbackAction(entry);
  if (containsCampaignSetupInternals(title)) return "Review campaign setup";
  title = translateResolvedCampaignRole(title, "action") ?? title;
  if (/^Persisted (?:Meta journal entry|decision)$/i.test(title)) {
    return "Decision recorded";
  }
  if (/^No immediate operator action\.?$/i.test(title)) {
    return "No action needed";
  }
  if (/^Keep out of sales action queue\.?$/i.test(title)) {
    return "No sales action needed";
  }
  if (/^Provider write attempted$/i.test(title)) return "Change started";
  if (/^Provider write\b/i.test(title)) return fallbackAction(entry);

  const workflow = title.match(/^Workflow\s+([a-z0-9_-]+)$/i);
  if (workflow) {
    const event = workflow[1].replace(/[_-]+/g, " ").toLowerCase();
    const labels: Record<string, string> = {
      assign: "Decision assigned",
      acknowledge: "Decision acknowledged",
      defer: "Decision deferred",
      snooze: "Decision snoozed",
      reject: "Decision rejected",
      resolve: "Decision resolved",
      reopen: "Decision reopened",
      comment: "Decision note added",
    };
    return labels[event] ?? "Decision updated";
  }

  const launchIntent = title.match(/^(New Campaign|Add To Existing) LaunchIntent$/i);
  if (launchIntent) {
    return launchIntent[1].toLowerCase() === "new campaign"
      ? "New campaign launch"
      : "Add to existing campaign";
  }
  if (
    entry.kind === "structures" &&
    title === (entry.entity.name ?? "").trim()
  ) {
    return `${entry.entity.type === "adset" ? "Ad set" : "Campaign"} status recorded`;
  }
  if (
    containsUnsafeBackendDetail(title, entry.entity.id.trim()) ||
    isMachineShaped(title)
  ) {
    return fallbackAction(entry);
  }
  return title;
}

/**
 * The Action cell's text.
 *
 * Most branches of the journal SQL already fold the entity into the stored
 * title, but the decisions branch does not. The entity is appended only when
 * the title does not already carry it. Known storage vocabulary is translated
 * before display, and an opaque title falls back to the row's truthful kind.
 *
 * The name is preferred. When it is unavailable, the UI uses a neutral entity
 * label instead of exposing a provider identifier.
 */
export function actionFor(entry: MetaHistoryEntry): string {
  const entityId = entry.entity.id.trim();
  const entityName = (entry.entity.name ?? "").trim();
  const entityLabel = historyEntityLabel(entry);
  let title = buyerFacingAction(entry);
  if (entityId && entityLabel) {
    const rawIdSuffix = ` | ${entityId}`;
    if (looksLikeOpaqueIdentifier(entityId) && title.includes(entityId)) {
      title = title.replaceAll(entityId, entityLabel);
    } else if (title === entityId) title = entityLabel;
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
