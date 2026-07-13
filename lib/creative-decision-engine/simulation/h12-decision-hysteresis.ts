import { createHash } from "node:crypto";
import { assignRollingOriginFold } from "./evaluation-folds";
import { wilsonScoreInterval } from "./paired-binary-inference";
import type { DecisionLabel } from "../types";

export type H12EvidenceTier = "restated_ad_daily" | "persisted_raw_label";
export type H12OutcomeStatus =
  "supported" | "refuted" | "neutral" | "unknown" | "censored";
export const H12_OUTCOME_WINDOWS = [3, 7, 14] as const;
export type H12OutcomeWindowDays = (typeof H12_OUTCOME_WINDOWS)[number];
export type H12HardLabel = "cut" | "refresh" | "scale";
export type H12EntryConfirmationCount = 1 | 2 | 3;

export interface H12WindowOutcome {
  outcomeStatus: H12OutcomeStatus;
  outcomeComplete: boolean;
}

export type H12OutcomesByWindow = Partial<
  Record<`${H12OutcomeWindowDays}`, H12WindowOutcome>
>;

export interface H12Observation {
  businessId: string;
  accountId: string | null;
  entityId: string;
  date: string;
  rawLabel: DecisionLabel;
  evidenceTier: H12EvidenceTier;
  sourceMode: string;
  outcomeStatus: H12OutcomeStatus;
  outcomeComplete: boolean;
  outcomesByWindow?: H12OutcomesByWindow;
  targetExact: boolean;
  decisionInputHash: string | null;
}

export interface H12Policy {
  id:
    | "H12_no_hard_label_hysteresis"
    | "H12_two_consecutive_evaluations"
    | "H12_three_consecutive_evaluations"
    | "H12_two_consecutive_gap_reset"
    | "H12_cut1_scale2_refresh2"
    | "H12_cut2_scale3_refresh2"
    | "H12_cut1_scale3_refresh2";
  entryConfirmations: Record<H12HardLabel, H12EntryConfirmationCount>;
  resetPendingAfterCalendarGap: boolean;
  label: string;
}

export const H12_POLICIES = [
  {
    id: "H12_no_hard_label_hysteresis",
    entryConfirmations: { cut: 1, refresh: 1, scale: 1 },
    resetPendingAfterCalendarGap: false,
    label: "No hard-label hysteresis",
  },
  {
    id: "H12_two_consecutive_evaluations",
    entryConfirmations: { cut: 2, refresh: 2, scale: 2 },
    resetPendingAfterCalendarGap: false,
    label: "Two consecutive evaluations",
  },
  {
    id: "H12_three_consecutive_evaluations",
    entryConfirmations: { cut: 3, refresh: 3, scale: 3 },
    resetPendingAfterCalendarGap: false,
    label: "Three consecutive evaluations",
  },
  {
    id: "H12_two_consecutive_gap_reset",
    entryConfirmations: { cut: 2, refresh: 2, scale: 2 },
    resetPendingAfterCalendarGap: true,
    label: "Two consecutive evaluations with calendar-gap reset",
  },
  {
    id: "H12_cut1_scale2_refresh2",
    entryConfirmations: { cut: 1, refresh: 2, scale: 2 },
    resetPendingAfterCalendarGap: false,
    label: "Immediate Cut, two-confirmation Scale and Refresh",
  },
  {
    id: "H12_cut2_scale3_refresh2",
    entryConfirmations: { cut: 2, refresh: 2, scale: 3 },
    resetPendingAfterCalendarGap: false,
    label: "Two-confirmation Cut and Refresh, three-confirmation Scale",
  },
  {
    id: "H12_cut1_scale3_refresh2",
    entryConfirmations: { cut: 1, refresh: 2, scale: 3 },
    resetPendingAfterCalendarGap: false,
    label: "Immediate Cut, two-confirmation Refresh, three-confirmation Scale",
  },
] as const satisfies readonly H12Policy[];

export type H12PolicyId = H12Policy["id"];

export interface H12PublishedObservation extends H12Observation {
  policyId: H12PolicyId;
  publishedLabel: DecisionLabel;
  suppressed: boolean;
  pendingHardLabel: DecisionLabel | null;
  pendingCount: number;
}

interface H12HardEpisode {
  id: string;
  businessId: string;
  accountId: string | null;
  entityId: string;
  label: DecisionLabel;
  startDate: string;
  endDate: string;
  observations: H12Observation[];
  outcomeStatus: H12OutcomeStatus;
  outcomeComplete: boolean;
  targetExact: boolean;
}

export interface H12OutcomeWindowMetrics {
  windowDays: H12OutcomeWindowDays;
  availableObservations: number;
  completeObservations: number;
  outcomeKnownPublishedEntries: number;
  outcomeSupportedPublishedEntries: number;
  outcomeRefutedPublishedEntries: number;
  outcomePrecision: number | null;
  outcomePrecisionWilson95: ReturnType<typeof wilsonScoreInterval>;
  supportedOutcomeEpisodes: number;
  supportedOutcomeEpisodesCaptured: number;
  supportedOutcomeRecall: number | null;
}

export interface H12PolicyMetrics {
  policyId: H12PolicyId;
  observations: number;
  entities: number;
  businesses: number;
  accounts: number;
  rawHardRows: number;
  publishedHardRows: number;
  suppressedHardEntries: number;
  rawHardTransitions: number;
  publishedHardTransitions: number;
  rawHardRoundTrips: number;
  publishedHardRoundTrips: number;
  rawHardReversalsWithin3: number;
  publishedHardReversalsWithin3: number;
  hardReversalReduction: number;
  hardReversalReductionRate: number | null;
  rawHardEpisodes: number;
  durableRawHardEpisodes: number;
  durableEpisodesCaptured: number;
  durableEpisodeRecall: number | null;
  publishedHardEntries: number;
  durablePublishedHardEntries: number;
  durabilityPrecision: number | null;
  oneEvaluationBlipsPublished: number;
  outcomeKnownPublishedEntries: number;
  outcomeSupportedPublishedEntries: number;
  outcomeRefutedPublishedEntries: number;
  outcomePrecision: number | null;
  outcomePrecisionWilson95: ReturnType<typeof wilsonScoreInterval>;
  supportedOutcomeEpisodes: number;
  supportedOutcomeEpisodesCaptured: number;
  supportedOutcomeRecall: number | null;
  outcomeWindows: Record<`${H12OutcomeWindowDays}`, H12OutcomeWindowMetrics>;
  safetyExitEvents: number;
  safetyExitDelayViolations: number;
  hardSwitchEvents: number;
  hardSwitchOldActionRepublished: number;
  confirmedHardEpisodes: number;
  unconfirmedHardEpisodes: number;
  transitionDelayEvaluations: {
    mean: number | null;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
  transitionDelayCalendarDays: {
    mean: number | null;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
}

export interface H12FoldResult {
  foldId: "development" | "calibration" | "locked_test";
  stabilityDateRange: { startDate: string; endDate: string };
  outcomeEligibleDateRange: { startDate: string; endDate: string };
  outcomeEligibleDateRanges: Record<
    `${H12OutcomeWindowDays}`,
    { startDate: string; endDate: string }
  >;
  observations: number;
  policyMetrics: H12PolicyMetrics[];
}

export interface H12HoldoutCell {
  id: string;
  observations: number;
  baselineReversals: number;
  candidateReversals: number;
  reversalReduction: number;
  safetyExitDelayViolations: number;
  durableEpisodeRecallDelta: number | null;
  outcomePrecisionDelta: number | null;
}

export interface H12DatasetEvaluation {
  evidenceTier: H12EvidenceTier;
  inputHash: string;
  observations: number;
  businesses: number;
  accountsKnown: number;
  entities: number;
  dateRange: { startDate: string | null; endDate: string | null };
  folds: H12FoldResult[];
  calibrationSelection: {
    selectedPolicyId: H12PolicyId | null;
    rule: string;
    eliminated: Array<{ policyId: H12PolicyId; reasons: string[] }>;
  };
  lockedTestAccountHoldout: H12HoldoutCell[];
  lockedTestEntityHashHoldout: H12HoldoutCell[];
  lockedTestEntityNovelty: H12HoldoutCell[];
}

const HARD_LABELS: ReadonlySet<DecisionLabel> = new Set([
  "cut",
  "refresh",
  "scale",
]);
const SOFT_PENDING_LABEL: DecisionLabel = "keep";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function assertDate(date: string) {
  if (!ISO_DATE.test(date)) throw new Error(`invalid ISO date: ${date}`);
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`invalid calendar date: ${date}`);
  }
}

function dateDiff(left: string, right: string) {
  assertDate(left);
  assertDate(right);
  return Math.round(
    (Date.parse(`${left}T00:00:00.000Z`) -
      Date.parse(`${right}T00:00:00.000Z`)) /
      DAY_MS,
  );
}

function hard(label: DecisionLabel): label is H12HardLabel {
  return HARD_LABELS.has(label);
}

function outcomeForWindow(
  observation: H12Observation,
  windowDays: H12OutcomeWindowDays,
): H12WindowOutcome | null {
  const key = String(windowDays) as `${H12OutcomeWindowDays}`;
  const explicit = observation.outcomesByWindow?.[key];
  if (explicit) return explicit;
  return windowDays === 14
    ? {
        outcomeStatus: observation.outcomeStatus,
        outcomeComplete: observation.outcomeComplete,
      }
    : null;
}

function withWindowOutcomes(
  observation: H12Observation,
  outcomesByWindow: H12OutcomesByWindow,
): H12Observation {
  const day14 = outcomesByWindow["14"] ?? {
    outcomeStatus: "unknown" as const,
    outcomeComplete: false,
  };
  return {
    ...observation,
    outcomeStatus: day14.outcomeStatus,
    outcomeComplete: day14.outcomeComplete,
    outcomesByWindow,
  };
}

function sequenceKey(observation: H12Observation) {
  return `${observation.businessId}::${observation.accountId ?? "unknown"}::${observation.entityId}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function h12StableHash(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function sortAndValidateH12Observations(
  observations: readonly H12Observation[],
): H12Observation[] {
  const sorted = [...observations].sort(
    (left, right) =>
      sequenceKey(left).localeCompare(sequenceKey(right)) ||
      left.date.localeCompare(right.date),
  );
  const seen = new Set<string>();
  for (const observation of sorted) {
    assertDate(observation.date);
    if (!observation.businessId.trim())
      throw new Error("businessId cannot be empty");
    if (!observation.entityId.trim())
      throw new Error("entityId cannot be empty");
    const key = `${sequenceKey(observation)}::${observation.date}`;
    if (seen.has(key)) throw new Error(`duplicate H12 observation: ${key}`);
    seen.add(key);
  }
  return sorted;
}

export function replayH12Policy(input: {
  observations: readonly H12Observation[];
  policy: H12Policy;
  resetPendingAfterCalendarGap?: boolean;
}): H12PublishedObservation[] {
  const observations = sortAndValidateH12Observations(input.observations);
  const bySequence = new Map<string, H12Observation[]>();
  for (const observation of observations) {
    const key = sequenceKey(observation);
    bySequence.set(key, [...(bySequence.get(key) ?? []), observation]);
  }

  const published: H12PublishedObservation[] = [];
  for (const sequence of bySequence.values()) {
    let publishedLabel: DecisionLabel | null = null;
    let pendingHardLabel: DecisionLabel | null = null;
    let pendingCount = 0;
    let previousDate: string | null = null;

    for (const observation of sequence) {
      if (
        (input.resetPendingAfterCalendarGap ??
          input.policy.resetPendingAfterCalendarGap) &&
        previousDate !== null &&
        dateDiff(observation.date, previousDate) > 1
      ) {
        pendingHardLabel = null;
        pendingCount = 0;
      }
      previousDate = observation.date;

      const confirmations = hard(observation.rawLabel)
        ? input.policy.entryConfirmations[observation.rawLabel]
        : 1;
      if (confirmations === 1) {
        publishedLabel = observation.rawLabel;
        pendingHardLabel = null;
        pendingCount = 0;
        published.push({
          ...observation,
          policyId: input.policy.id,
          publishedLabel,
          suppressed: false,
          pendingHardLabel,
          pendingCount,
        });
        continue;
      }

      if (!hard(observation.rawLabel)) {
        // Safety/authority exits and all soft transitions publish immediately.
        publishedLabel = observation.rawLabel;
        pendingHardLabel = null;
        pendingCount = 0;
        published.push({
          ...observation,
          policyId: input.policy.id,
          publishedLabel,
          suppressed: false,
          pendingHardLabel,
          pendingCount,
        });
        continue;
      }

      if (publishedLabel === observation.rawLabel) {
        pendingHardLabel = null;
        pendingCount = 0;
        published.push({
          ...observation,
          policyId: input.policy.id,
          publishedLabel: observation.rawLabel,
          suppressed: false,
          pendingHardLabel,
          pendingCount,
        });
        continue;
      }

      if (pendingHardLabel === observation.rawLabel) pendingCount += 1;
      else {
        pendingHardLabel = observation.rawLabel;
        pendingCount = 1;
      }

      if (pendingCount >= confirmations) {
        publishedLabel = observation.rawLabel;
        pendingHardLabel = null;
        pendingCount = 0;
        published.push({
          ...observation,
          policyId: input.policy.id,
          publishedLabel,
          suppressed: false,
          pendingHardLabel,
          pendingCount,
        });
      } else {
        // A direct hard-to-hard switch must not preserve the old hard action.
        publishedLabel = SOFT_PENDING_LABEL;
        published.push({
          ...observation,
          policyId: input.policy.id,
          publishedLabel,
          suppressed: true,
          pendingHardLabel,
          pendingCount,
        });
      }
    }
  }
  return published.sort(
    (left, right) =>
      sequenceKey(left).localeCompare(sequenceKey(right)) ||
      left.date.localeCompare(right.date),
  );
}

function groupBySequence<T extends H12Observation>(rows: readonly T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = sequenceKey(row);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  for (const rows of grouped.values())
    rows.sort((a, b) => a.date.localeCompare(b.date));
  return grouped;
}

function crossesHardBoundary(left: DecisionLabel, right: DecisionLabel) {
  return left !== right && (hard(left) || hard(right));
}

function countTransitions(labels: readonly DecisionLabel[]) {
  let count = 0;
  for (let index = 1; index < labels.length; index += 1) {
    if (crossesHardBoundary(labels[index - 1]!, labels[index]!)) count += 1;
  }
  return count;
}

function countRoundTrips(labels: readonly DecisionLabel[]) {
  let count = 0;
  for (let index = 2; index < labels.length; index += 1) {
    if (
      labels[index] === labels[index - 2] &&
      crossesHardBoundary(labels[index - 2]!, labels[index - 1]!)
    ) {
      count += 1;
    }
  }
  return count;
}

function countReversalsWithin3(labels: readonly DecisionLabel[]) {
  let count = 0;
  for (let index = 1; index < labels.length; index += 1) {
    if (!crossesHardBoundary(labels[index - 1]!, labels[index]!)) continue;
    const prior = labels[index - 1]!;
    for (
      let lookahead = index + 1;
      lookahead <= Math.min(labels.length - 1, index + 3);
      lookahead += 1
    ) {
      if (labels[lookahead] === prior) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

function hardEpisodes(
  observations: readonly H12Observation[],
): H12HardEpisode[] {
  const episodes: H12HardEpisode[] = [];
  for (const sequence of groupBySequence(observations).values()) {
    let active: H12Observation[] = [];
    const flush = () => {
      const first = active[0];
      const last = active.at(-1);
      if (!first || !last) return;
      episodes.push({
        id: `${sequenceKey(first)}::${first.date}::${first.rawLabel}`,
        businessId: first.businessId,
        accountId: first.accountId,
        entityId: first.entityId,
        label: first.rawLabel,
        startDate: first.date,
        endDate: last.date,
        observations: active,
        outcomeStatus: first.outcomeStatus,
        outcomeComplete: first.outcomeComplete,
        targetExact: first.targetExact,
      });
      active = [];
    };
    for (const observation of sequence) {
      if (!hard(observation.rawLabel)) {
        flush();
        continue;
      }
      if (active.length > 0 && active[0]!.rawLabel !== observation.rawLabel)
        flush();
      active.push(observation);
    }
    flush();
  }
  return episodes;
}

function percentile(values: readonly number[], probability: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return (
    sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
  );
}

function distribution(values: readonly number[]) {
  return {
    mean:
      values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length > 0 ? Math.max(...values) : null,
  };
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

export function summarizeH12Policy(input: {
  observations: readonly H12Observation[];
  policy: H12Policy;
  resetPendingAfterCalendarGap?: boolean;
}): H12PolicyMetrics {
  const observations = sortAndValidateH12Observations(input.observations);
  const replay = replayH12Policy(input);
  const publishedByKey = new Map(
    replay.map((row) => [`${sequenceKey(row)}::${row.date}`, row]),
  );
  const episodes = hardEpisodes(observations);
  const episodeByObservation = new Map<string, H12HardEpisode>();
  for (const episode of episodes) {
    for (const observation of episode.observations) {
      episodeByObservation.set(
        `${sequenceKey(observation)}::${observation.date}`,
        episode,
      );
    }
  }
  const rawSequences = groupBySequence(observations);
  const publishedSequences = groupBySequence(replay);
  let rawHardTransitions = 0;
  let publishedHardTransitions = 0;
  let rawHardRoundTrips = 0;
  let publishedHardRoundTrips = 0;
  let rawHardReversalsWithin3 = 0;
  let publishedHardReversalsWithin3 = 0;
  let safetyExitEvents = 0;
  let safetyExitDelayViolations = 0;
  let hardSwitchEvents = 0;
  let hardSwitchOldActionRepublished = 0;
  let publishedHardEntries = 0;
  let durablePublishedHardEntries = 0;
  let oneEvaluationBlipsPublished = 0;
  const outcomeAccumulators = Object.fromEntries(
    H12_OUTCOME_WINDOWS.map((windowDays) => [
      String(windowDays),
      {
        windowDays,
        availableObservations: observations.filter(
          (row) => outcomeForWindow(row, windowDays) !== null,
        ).length,
        completeObservations: observations.filter(
          (row) => outcomeForWindow(row, windowDays)?.outcomeComplete === true,
        ).length,
        knownPublishedEntries: 0,
        supportedPublishedEntries: 0,
        refutedPublishedEntries: 0,
        supportedEpisodes: 0,
        supportedEpisodesCaptured: 0,
      },
    ]),
  ) as Record<
    `${H12OutcomeWindowDays}`,
    {
      windowDays: H12OutcomeWindowDays;
      availableObservations: number;
      completeObservations: number;
      knownPublishedEntries: number;
      supportedPublishedEntries: number;
      refutedPublishedEntries: number;
      supportedEpisodes: number;
      supportedEpisodesCaptured: number;
    }
  >;

  for (const [key, sequence] of rawSequences) {
    const published = publishedSequences.get(key) ?? [];
    rawHardTransitions += countTransitions(sequence.map((row) => row.rawLabel));
    publishedHardTransitions += countTransitions(
      published.map((row) => row.publishedLabel),
    );
    rawHardRoundTrips += countRoundTrips(sequence.map((row) => row.rawLabel));
    publishedHardRoundTrips += countRoundTrips(
      published.map((row) => row.publishedLabel),
    );
    rawHardReversalsWithin3 += countReversalsWithin3(
      sequence.map((row) => row.rawLabel),
    );
    publishedHardReversalsWithin3 += countReversalsWithin3(
      published.map((row) => row.publishedLabel),
    );

    for (let index = 0; index < sequence.length; index += 1) {
      const current = sequence[index]!;
      const currentPublished = published[index]!;
      const previousPublished =
        index > 0 ? published[index - 1]!.publishedLabel : null;
      if (
        previousPublished !== null &&
        hard(previousPublished) &&
        !hard(current.rawLabel)
      ) {
        safetyExitEvents += 1;
        if (currentPublished.publishedLabel !== current.rawLabel)
          safetyExitDelayViolations += 1;
      }
      if (
        previousPublished !== null &&
        hard(previousPublished) &&
        hard(current.rawLabel) &&
        previousPublished !== current.rawLabel
      ) {
        hardSwitchEvents += 1;
        if (currentPublished.publishedLabel === previousPublished) {
          hardSwitchOldActionRepublished += 1;
        }
      }
      const enteredHard =
        hard(currentPublished.publishedLabel) &&
        (previousPublished === null ||
          previousPublished !== currentPublished.publishedLabel);
      if (!enteredHard) continue;
      publishedHardEntries += 1;
      const episode = episodeByObservation.get(
        `${sequenceKey(current)}::${current.date}`,
      );
      if ((episode?.observations.length ?? 0) >= 3)
        durablePublishedHardEntries += 1;
      if ((episode?.observations.length ?? 0) === 1)
        oneEvaluationBlipsPublished += 1;
      for (const windowDays of H12_OUTCOME_WINDOWS) {
        const outcome = outcomeForWindow(current, windowDays);
        const accumulator =
          outcomeAccumulators[String(windowDays) as `${H12OutcomeWindowDays}`];
        if (outcome?.outcomeStatus === "supported") {
          accumulator.knownPublishedEntries += 1;
          accumulator.supportedPublishedEntries += 1;
        } else if (outcome?.outcomeStatus === "refuted") {
          accumulator.knownPublishedEntries += 1;
          accumulator.refutedPublishedEntries += 1;
        }
      }
    }
  }

  const evaluationDelays: number[] = [];
  const calendarDelays: number[] = [];
  let durableEpisodesCaptured = 0;
  let confirmedHardEpisodes = 0;
  for (const episode of episodes) {
    const captureIndex = episode.observations.findIndex((observation) => {
      const published = publishedByKey.get(
        `${sequenceKey(observation)}::${observation.date}`,
      );
      return published?.publishedLabel === episode.label;
    });
    if (episode.observations.length >= 3 && captureIndex >= 0)
      durableEpisodesCaptured += 1;
    const firstObservation = episode.observations[0]!;
    for (const windowDays of H12_OUTCOME_WINDOWS) {
      const outcome = outcomeForWindow(firstObservation, windowDays);
      const accumulator =
        outcomeAccumulators[String(windowDays) as `${H12OutcomeWindowDays}`];
      if (outcome?.outcomeComplete && outcome.outcomeStatus === "supported") {
        accumulator.supportedEpisodes += 1;
        if (captureIndex >= 0) accumulator.supportedEpisodesCaptured += 1;
      }
    }
    if (captureIndex >= 0) {
      confirmedHardEpisodes += 1;
      evaluationDelays.push(captureIndex);
      calendarDelays.push(
        dateDiff(episode.observations[captureIndex]!.date, episode.startDate),
      );
    }
  }

  const rawHardRows = observations.filter((row) => hard(row.rawLabel)).length;
  const publishedHardRows = replay.filter((row) =>
    hard(row.publishedLabel),
  ).length;
  const durableRawHardEpisodes = episodes.filter(
    (episode) => episode.observations.length >= 3,
  ).length;
  const hardReversalReduction =
    rawHardReversalsWithin3 - publishedHardReversalsWithin3;
  const outcomeWindows = Object.fromEntries(
    H12_OUTCOME_WINDOWS.map((windowDays) => {
      const accumulator =
        outcomeAccumulators[String(windowDays) as `${H12OutcomeWindowDays}`];
      return [
        String(windowDays),
        {
          windowDays,
          availableObservations: accumulator.availableObservations,
          completeObservations: accumulator.completeObservations,
          outcomeKnownPublishedEntries: accumulator.knownPublishedEntries,
          outcomeSupportedPublishedEntries:
            accumulator.supportedPublishedEntries,
          outcomeRefutedPublishedEntries: accumulator.refutedPublishedEntries,
          outcomePrecision: ratio(
            accumulator.supportedPublishedEntries,
            accumulator.knownPublishedEntries,
          ),
          outcomePrecisionWilson95: wilsonScoreInterval(
            accumulator.supportedPublishedEntries,
            accumulator.knownPublishedEntries,
          ),
          supportedOutcomeEpisodes: accumulator.supportedEpisodes,
          supportedOutcomeEpisodesCaptured:
            accumulator.supportedEpisodesCaptured,
          supportedOutcomeRecall: ratio(
            accumulator.supportedEpisodesCaptured,
            accumulator.supportedEpisodes,
          ),
        } satisfies H12OutcomeWindowMetrics,
      ];
    }),
  ) as Record<`${H12OutcomeWindowDays}`, H12OutcomeWindowMetrics>;
  const day14 = outcomeWindows["14"];
  return {
    policyId: input.policy.id,
    observations: observations.length,
    entities: new Set(observations.map(sequenceKey)).size,
    businesses: new Set(observations.map((row) => row.businessId)).size,
    accounts: new Set(
      observations.flatMap((row) => (row.accountId ? [row.accountId] : [])),
    ).size,
    rawHardRows,
    publishedHardRows,
    suppressedHardEntries: replay.filter((row) => row.suppressed).length,
    rawHardTransitions,
    publishedHardTransitions,
    rawHardRoundTrips,
    publishedHardRoundTrips,
    rawHardReversalsWithin3,
    publishedHardReversalsWithin3,
    hardReversalReduction,
    hardReversalReductionRate: ratio(
      hardReversalReduction,
      rawHardReversalsWithin3,
    ),
    rawHardEpisodes: episodes.length,
    durableRawHardEpisodes,
    durableEpisodesCaptured,
    durableEpisodeRecall: ratio(
      durableEpisodesCaptured,
      durableRawHardEpisodes,
    ),
    publishedHardEntries,
    durablePublishedHardEntries,
    durabilityPrecision: ratio(
      durablePublishedHardEntries,
      publishedHardEntries,
    ),
    oneEvaluationBlipsPublished,
    outcomeKnownPublishedEntries: day14.outcomeKnownPublishedEntries,
    outcomeSupportedPublishedEntries: day14.outcomeSupportedPublishedEntries,
    outcomeRefutedPublishedEntries: day14.outcomeRefutedPublishedEntries,
    outcomePrecision: day14.outcomePrecision,
    outcomePrecisionWilson95: day14.outcomePrecisionWilson95,
    supportedOutcomeEpisodes: day14.supportedOutcomeEpisodes,
    supportedOutcomeEpisodesCaptured: day14.supportedOutcomeEpisodesCaptured,
    supportedOutcomeRecall: day14.supportedOutcomeRecall,
    outcomeWindows,
    safetyExitEvents,
    safetyExitDelayViolations,
    hardSwitchEvents,
    hardSwitchOldActionRepublished,
    confirmedHardEpisodes,
    unconfirmedHardEpisodes: episodes.length - confirmedHardEpisodes,
    transitionDelayEvaluations: distribution(evaluationDelays),
    transitionDelayCalendarDays: distribution(calendarDelays),
  };
}

const FOLD_STABILITY_RANGES = {
  development: { startDate: "2025-12-01", endDate: "2026-03-31" },
  calibration: { startDate: "2026-04-01", endDate: "2026-05-31" },
  locked_test: { startDate: "2026-06-01", endDate: "2026-07-05" },
} as const;

function addCalendarDays(date: string, days: number) {
  assertDate(date);
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function outcomeEligibleDateRange(
  foldId: keyof typeof FOLD_STABILITY_RANGES,
  windowDays: H12OutcomeWindowDays,
  outcomesObservedThrough: string,
) {
  const stability = FOLD_STABILITY_RANGES[foldId];
  const ceiling =
    foldId === "locked_test"
      ? outcomesObservedThrough
      : stability.endDate < outcomesObservedThrough
        ? stability.endDate
        : outcomesObservedThrough;
  const matureEnd = addCalendarDays(ceiling, -windowDays);
  return {
    startDate: stability.startDate,
    endDate: matureEnd < stability.endDate ? matureEnd : stability.endDate,
  };
}

function inRange(date: string, range: { startDate: string; endDate: string }) {
  return date >= range.startDate && date <= range.endDate;
}

function foldObservations(
  observations: readonly H12Observation[],
  foldId: keyof typeof FOLD_STABILITY_RANGES,
  outcomesObservedThrough: string,
) {
  const stabilityRange = FOLD_STABILITY_RANGES[foldId];
  return observations.flatMap((observation) => {
    if (!inRange(observation.date, stabilityRange)) return [];
    const outcomesByWindow = Object.fromEntries(
      H12_OUTCOME_WINDOWS.map((windowDays) => {
        const assignment = assignRollingOriginFold({
          decisionDate: observation.date,
          outcomeWindowDays: windowDays,
          outcomesObservedThrough,
        });
        const outcomeEligible =
          assignment.foldId === foldId && assignment.outcomeEligible;
        const outcome = outcomeForWindow(observation, windowDays);
        return [
          String(windowDays),
          outcomeEligible && outcome !== null
            ? outcome
            : { outcomeStatus: "unknown" as const, outcomeComplete: false },
        ];
      }),
    ) as H12OutcomesByWindow;
    return [withWindowOutcomes(observation, outcomesByWindow)];
  });
}

function policyById(id: H12PolicyId) {
  const policy = H12_POLICIES.find((candidate) => candidate.id === id);
  if (!policy) throw new Error(`unknown H12 policy: ${id}`);
  return policy;
}

function maximumEntryConfirmations(policy: H12Policy) {
  return Math.max(...Object.values(policy.entryConfirmations));
}

export function selectH12Policy(
  calibration: readonly H12PolicyMetrics[],
): H12DatasetEvaluation["calibrationSelection"] {
  const baseline = calibration.find(
    (metric) => metric.policyId === "H12_no_hard_label_hysteresis",
  );
  if (!baseline) throw new Error("H12 baseline is missing");
  const eliminated: Array<{ policyId: H12PolicyId; reasons: string[] }> = [];
  const viable = calibration.filter((metric) => {
    const reasons: string[] = [];
    if (metric.safetyExitDelayViolations > 0)
      reasons.push("safety_exit_delayed");
    if (metric.hardSwitchOldActionRepublished > 0) {
      reasons.push("old_hard_action_republished_on_switch");
    }
    if ((metric.hardReversalReductionRate ?? 0) <= 0) {
      reasons.push("no_calibration_flapping_reduction");
    }
    if (
      (metric.transitionDelayEvaluations.p95 ?? Number.POSITIVE_INFINITY) > 1
    ) {
      reasons.push("p95_transition_delay_exceeds_one_evaluation");
    }
    if (
      metric.durableEpisodeRecall !== null &&
      baseline.durableEpisodeRecall !== null &&
      metric.durableEpisodeRecall < baseline.durableEpisodeRecall - 0.02
    ) {
      reasons.push("durable_episode_recall_loss_exceeds_2pp");
    }
    if (
      metric.outcomePrecision !== null &&
      baseline.outcomePrecision !== null &&
      metric.outcomePrecision < baseline.outcomePrecision - 0.02
    ) {
      reasons.push("outcome_precision_point_loss_exceeds_2pp");
    }
    if (metric.policyId === baseline.policyId)
      reasons.push("baseline_no_stability_guard");
    if (reasons.length > 0)
      eliminated.push({ policyId: metric.policyId, reasons });
    return reasons.length === 0;
  });
  viable.sort(
    (left, right) =>
      (right.hardReversalReductionRate ?? -1) -
        (left.hardReversalReductionRate ?? -1) ||
      maximumEntryConfirmations(policyById(left.policyId)) -
        maximumEntryConfirmations(policyById(right.policyId)) ||
      left.policyId.localeCompare(right.policyId),
  );
  return {
    selectedPolicyId: viable[0]?.policyId ?? null,
    rule: "Select on calibration only: zero safety-exit delay and old-hard republish, positive flapping reduction, p95 entry delay <=1 evaluation, and <=2pp point loss in durable recall/14d outcome precision; maximize flapping reduction, then minimize maximum entry confirmations, then stable policy id.",
    eliminated,
  };
}

function holdoutCell(input: {
  id: string;
  observations: readonly H12Observation[];
  candidate: H12Policy;
}): H12HoldoutCell {
  const baseline = summarizeH12Policy({
    observations: input.observations,
    policy: H12_POLICIES[0],
  });
  const candidate = summarizeH12Policy({
    observations: input.observations,
    policy: input.candidate,
  });
  return {
    id: input.id,
    observations: input.observations.length,
    baselineReversals: baseline.publishedHardReversalsWithin3,
    candidateReversals: candidate.publishedHardReversalsWithin3,
    reversalReduction:
      baseline.publishedHardReversalsWithin3 -
      candidate.publishedHardReversalsWithin3,
    safetyExitDelayViolations: candidate.safetyExitDelayViolations,
    durableEpisodeRecallDelta:
      baseline.durableEpisodeRecall === null ||
      candidate.durableEpisodeRecall === null
        ? null
        : candidate.durableEpisodeRecall - baseline.durableEpisodeRecall,
    outcomePrecisionDelta:
      baseline.outcomePrecision === null || candidate.outcomePrecision === null
        ? null
        : candidate.outcomePrecision - baseline.outcomePrecision,
  };
}

function hashBucket(value: string, buckets: number) {
  const prefix = h12StableHash(value).slice(0, 8);
  return Number.parseInt(prefix, 16) % buckets;
}

export function evaluateH12Dataset(input: {
  observations: readonly H12Observation[];
  evidenceTier: H12EvidenceTier;
  outcomesObservedThrough: string;
}): H12DatasetEvaluation {
  const observations = sortAndValidateH12Observations(input.observations);
  if (observations.some((row) => row.evidenceTier !== input.evidenceTier)) {
    throw new Error("H12 evidence tiers must not be pooled");
  }
  const folds = (["development", "calibration", "locked_test"] as const).map(
    (foldId) => {
      const rows = foldObservations(
        observations,
        foldId,
        input.outcomesObservedThrough,
      );
      return {
        foldId,
        stabilityDateRange: FOLD_STABILITY_RANGES[foldId],
        outcomeEligibleDateRange: outcomeEligibleDateRange(
          foldId,
          14,
          input.outcomesObservedThrough,
        ),
        outcomeEligibleDateRanges: Object.fromEntries(
          H12_OUTCOME_WINDOWS.map((windowDays) => [
            String(windowDays),
            outcomeEligibleDateRange(
              foldId,
              windowDays,
              input.outcomesObservedThrough,
            ),
          ]),
        ) as H12FoldResult["outcomeEligibleDateRanges"],
        observations: rows.length,
        policyMetrics: H12_POLICIES.map((policy) =>
          summarizeH12Policy({ observations: rows, policy }),
        ),
      };
    },
  );
  const calibration = folds.find((fold) => fold.foldId === "calibration")!;
  const selection = selectH12Policy(calibration.policyMetrics);
  const selected = selection.selectedPolicyId
    ? policyById(selection.selectedPolicyId)
    : H12_POLICIES[1];
  const lockedRows = foldObservations(
    observations,
    "locked_test",
    input.outcomesObservedThrough,
  );
  const accountIds = Array.from(
    new Set(
      lockedRows.flatMap((row) => (row.accountId ? [row.accountId] : [])),
    ),
  ).sort();
  const accountHoldout = accountIds.map((accountId) =>
    holdoutCell({
      id: accountId,
      observations: lockedRows.filter((row) => row.accountId === accountId),
      candidate: selected,
    }),
  );
  const entityHashHoldout = Array.from({ length: 5 }, (_, bucket) =>
    holdoutCell({
      id: `entity_hash_fold_${bucket}`,
      observations: lockedRows.filter(
        (row) => hashBucket(sequenceKey(row), 5) === bucket,
      ),
      candidate: selected,
    }),
  ).filter((cell) => cell.observations > 0);
  const preLockedEntities = new Set(
    observations
      .filter((row) => row.date < FOLD_STABILITY_RANGES.locked_test.startDate)
      .map(sequenceKey),
  );
  const entityNovelty = ["seen_pre_locked", "new_in_locked"]
    .map((id) =>
      holdoutCell({
        id,
        observations: lockedRows.filter((row) =>
          id === "seen_pre_locked"
            ? preLockedEntities.has(sequenceKey(row))
            : !preLockedEntities.has(sequenceKey(row)),
        ),
        candidate: selected,
      }),
    )
    .filter((cell) => cell.observations > 0);

  return {
    evidenceTier: input.evidenceTier,
    inputHash: h12StableHash(observations),
    observations: observations.length,
    businesses: new Set(observations.map((row) => row.businessId)).size,
    accountsKnown: new Set(
      observations.flatMap((row) => (row.accountId ? [row.accountId] : [])),
    ).size,
    entities: new Set(observations.map(sequenceKey)).size,
    dateRange: {
      startDate: observations[0]?.date ?? null,
      endDate: observations.at(-1)?.date ?? null,
    },
    folds,
    calibrationSelection: selection,
    lockedTestAccountHoldout: accountHoldout,
    lockedTestEntityHashHoldout: entityHashHoldout,
    lockedTestEntityNovelty: entityNovelty,
  };
}

export function verifyH12PrefixInvariance(input: {
  observations: readonly H12Observation[];
  policy: H12Policy;
  cutoffDate: string;
}) {
  const sorted = sortAndValidateH12Observations(input.observations);
  const baseline = replayH12Policy({
    observations: sorted,
    policy: input.policy,
  }).filter((row) => row.date <= input.cutoffDate);
  const mutated = sorted.map((row) =>
    row.date <= input.cutoffDate
      ? row
      : {
          ...row,
          rawLabel: (row.rawLabel === "cut" ? "scale" : "cut") as DecisionLabel,
        },
  );
  const replay = replayH12Policy({
    observations: mutated,
    policy: input.policy,
  }).filter((row) => row.date <= input.cutoffDate);
  return {
    passed: h12StableHash(baseline) === h12StableHash(replay),
    prefixRows: baseline.length,
    baselineHash: h12StableHash(baseline),
    mutatedFutureHash: h12StableHash(replay),
  };
}
