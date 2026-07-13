const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BootstrapSampleObservation<T> {
  observation: T;
  businessId: string;
  entityId: string;
  date: string;
  sourceIndex: number;
  bootstrapBusinessInstance: number;
  bootstrapEntityInstance: number;
  temporalBlockInstance: number;
}

export interface BootstrapStatisticContext {
  kind: "point" | "replicate";
  iteration: number | null;
}

export interface ClusteredMovingBlockBootstrapOptions<T> {
  getBusinessId: (observation: T) => string;
  getEntityId: (observation: T) => string;
  getDate: (observation: T) => string;
  statistic: (
    sample: readonly BootstrapSampleObservation<T>[],
    context: BootstrapStatisticContext,
  ) => number | null;
  seed: string | number;
  iterations?: number;
  blockLengthDays?: number;
  confidenceLevel?: number;
}

export interface ClusteredMovingBlockBootstrapResult {
  seed: string;
  iterations: number;
  validIterations: number;
  invalidIterations: number;
  blockLengthDays: number;
  confidenceLevel: number;
  businessCount: number;
  entityCount: number;
  observationCount: number;
  pointEstimate: number | null;
  estimates: Array<number | null>;
  standardError: number | null;
  lower: number | null;
  median: number | null;
  upper: number | null;
}

interface TaggedObservation<T> {
  observation: T;
  businessId: string;
  entityId: string;
  date: string;
  epochDay: number;
  sourceIndex: number;
}

interface EntityCluster<T> {
  entityId: string;
  rows: TaggedObservation<T>[];
  movingBlocks: TaggedObservation<T>[][];
}

interface BusinessCluster<T> {
  businessId: string;
  entities: EntityCluster<T>[];
}

type Random = () => number;

function positiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function normalizedId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} cannot be empty`);
  return normalized;
}

function epochDay(value: string): number {
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new Error("bootstrap dates must be ISO calendar dates");
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value
  ) {
    throw new Error("bootstrap dates must be valid ISO calendar dates");
  }
  return Math.floor(timestamp / DAY_MS);
}

function deterministicRandom(seed: string): Random {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  state >>>= 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomIndex(length: number, random: Random): number {
  return Math.floor(random() * length);
}

function movingBlocks<T>(
  rows: readonly TaggedObservation<T>[],
  blockLengthDays: number,
): TaggedObservation<T>[][] {
  if (rows.length === 0) return [];
  // Trailing blocks may be shorter, which keeps sparse end-of-life rows in the
  // resampling support instead of silently dropping them.
  const starts = Array.from(new Set(rows.map((row) => row.epochDay)));
  const blocks = starts
    .map((start) =>
      rows.filter(
        (row) =>
          row.epochDay >= start && row.epochDay < start + blockLengthDays,
      ),
    )
    .filter((block) => block.length > 0);

  // Short-lived entities still remain a cluster; no synthetic days are added.
  return blocks.length > 0 ? blocks : [[...rows]];
}

function buildClusters<T>(
  observations: readonly T[],
  options: ClusteredMovingBlockBootstrapOptions<T>,
  blockLengthDays: number,
): { businesses: BusinessCluster<T>[]; tagged: TaggedObservation<T>[] } {
  if (observations.length === 0) {
    throw new Error("clustered bootstrap requires at least one observation");
  }

  const tagged = observations.map((observation, sourceIndex) => {
    const businessId = normalizedId(
      options.getBusinessId(observation),
      "business id",
    );
    const entityId = normalizedId(
      options.getEntityId(observation),
      "entity id",
    );
    const date = options.getDate(observation);
    return {
      observation,
      businessId,
      entityId,
      date,
      epochDay: epochDay(date),
      sourceIndex,
    };
  });
  const businessIds = Array.from(
    new Set(tagged.map((row) => row.businessId)),
  ).sort((left, right) => left.localeCompare(right));
  const businesses = businessIds.map((businessId) => {
    const businessRows = tagged.filter((row) => row.businessId === businessId);
    const entityIds = Array.from(
      new Set(businessRows.map((row) => row.entityId)),
    ).sort((left, right) => left.localeCompare(right));
    const entities = entityIds.map((entityId) => {
      const rows = businessRows
        .filter((row) => row.entityId === entityId)
        .sort(
          (left, right) =>
            left.epochDay - right.epochDay ||
            left.sourceIndex - right.sourceIndex,
        );
      return {
        entityId,
        rows,
        movingBlocks: movingBlocks(rows, blockLengthDays),
      };
    });
    return { businessId, entities };
  });

  return { businesses, tagged };
}

function pointSample<T>(
  businesses: readonly BusinessCluster<T>[],
): BootstrapSampleObservation<T>[] {
  return businesses.flatMap((business, businessIndex) =>
    business.entities.flatMap((entity, entityIndex) =>
      entity.rows.map((row) => ({
        observation: row.observation,
        businessId: row.businessId,
        entityId: row.entityId,
        date: row.date,
        sourceIndex: row.sourceIndex,
        bootstrapBusinessInstance: businessIndex,
        bootstrapEntityInstance: entityIndex,
        temporalBlockInstance: 0,
      })),
    ),
  );
}

function resampleEntity<T>(
  entity: EntityCluster<T>,
  random: Random,
  businessInstance: number,
  entityInstance: number,
): BootstrapSampleObservation<T>[] {
  const sample: BootstrapSampleObservation<T>[] = [];
  let temporalBlockInstance = 0;

  while (sample.length < entity.rows.length) {
    const block =
      entity.movingBlocks[randomIndex(entity.movingBlocks.length, random)];
    for (const row of block) {
      if (sample.length >= entity.rows.length) break;
      sample.push({
        observation: row.observation,
        businessId: row.businessId,
        entityId: row.entityId,
        date: row.date,
        sourceIndex: row.sourceIndex,
        bootstrapBusinessInstance: businessInstance,
        bootstrapEntityInstance: entityInstance,
        temporalBlockInstance,
      });
    }
    temporalBlockInstance += 1;
  }
  return sample;
}

function replicateSample<T>(
  businesses: readonly BusinessCluster<T>[],
  random: Random,
): BootstrapSampleObservation<T>[] {
  const sample: BootstrapSampleObservation<T>[] = [];
  for (
    let businessInstance = 0;
    businessInstance < businesses.length;
    businessInstance += 1
  ) {
    const business = businesses[randomIndex(businesses.length, random)];
    for (
      let entityInstance = 0;
      entityInstance < business.entities.length;
      entityInstance += 1
    ) {
      const entity =
        business.entities[randomIndex(business.entities.length, random)];
      sample.push(
        ...resampleEntity(entity, random, businessInstance, entityInstance),
      );
    }
  }
  return sample;
}

function checkedEstimate(value: number | null, context: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) {
    throw new Error(`${context} bootstrap statistic must be finite or null`);
  }
  return value;
}

function percentile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const fraction = position - lowerIndex;
  return (
    sorted[lowerIndex] + fraction * (sorted[upperIndex] - sorted[lowerIndex])
  );
}

export function clusteredMovingBlockBootstrap<T>(
  observations: readonly T[],
  options: ClusteredMovingBlockBootstrapOptions<T>,
): ClusteredMovingBlockBootstrapResult {
  const iterations = options.iterations ?? 1_000;
  const blockLengthDays = options.blockLengthDays ?? 7;
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  positiveInteger(iterations, "iterations");
  positiveInteger(blockLengthDays, "blockLengthDays");
  if (!(confidenceLevel > 0 && confidenceLevel < 1)) {
    throw new Error("confidenceLevel must be between 0 and 1");
  }

  const seed = String(options.seed);
  const random = deterministicRandom(seed);
  const { businesses } = buildClusters(observations, options, blockLengthDays);
  const pointEstimate = checkedEstimate(
    options.statistic(pointSample(businesses), {
      kind: "point",
      iteration: null,
    }),
    "point",
  );
  const estimates: Array<number | null> = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    estimates.push(
      checkedEstimate(
        options.statistic(replicateSample(businesses, random), {
          kind: "replicate",
          iteration,
        }),
        `replicate ${iteration}`,
      ),
    );
  }

  const valid = estimates
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  const average =
    valid.length === 0
      ? null
      : valid.reduce((sum, value) => sum + value, 0) / valid.length;
  const standardError =
    valid.length < 2 || average === null
      ? null
      : Math.sqrt(
          valid.reduce((sum, value) => sum + (value - average) ** 2, 0) /
            (valid.length - 1),
        );
  const alpha = 1 - confidenceLevel;

  return {
    seed,
    iterations,
    validIterations: valid.length,
    invalidIterations: iterations - valid.length,
    blockLengthDays,
    confidenceLevel,
    businessCount: businesses.length,
    entityCount: businesses.reduce(
      (sum, business) => sum + business.entities.length,
      0,
    ),
    observationCount: observations.length,
    pointEstimate,
    estimates,
    standardError,
    lower: valid.length > 0 ? percentile(valid, alpha / 2) : null,
    median: valid.length > 0 ? percentile(valid, 0.5) : null,
    upper: valid.length > 0 ? percentile(valid, 1 - alpha / 2) : null,
  };
}
