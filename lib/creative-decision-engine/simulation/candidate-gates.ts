export type MetricDirection = "higher_is_better" | "lower_is_better";

export interface MetricEstimate {
  point: number | null;
  lower: number | null;
  upper: number | null;
  sampleSize: number;
}

export interface CandidateMinusBaselineEstimate extends MetricEstimate {
  /** Explicit source polarity before it is normalized to improvement. */
  direction: MetricDirection;
}

export interface ImprovementEstimate extends MetricEstimate {
  /** Positive always means the candidate is better than the baseline. */
  polarity: "positive_is_candidate_improvement";
}

interface GateBase {
  id: string;
  metric: string;
  required?: boolean;
}

export type CandidateGate =
  | (GateBase & {
      kind: "minimum_evidence";
      observed: number;
      minimum: number;
    })
  | (GateBase & {
      kind: "minimum";
      estimate: MetricEstimate | null;
      minimum: number;
      conservativeBound: "point" | "lower";
    })
  | (GateBase & {
      kind: "maximum";
      estimate: MetricEstimate | null;
      maximum: number;
      conservativeBound: "point" | "upper";
    })
  | (GateBase & {
      kind: "non_inferiority";
      improvement: ImprovementEstimate | null;
      /** Maximum accepted deterioration in positive-is-better units. */
      margin: number;
    })
  | (GateBase & {
      kind: "superiority";
      improvement: ImprovementEstimate | null;
      minimumImprovement: number;
    })
  | (GateBase & {
      kind: "maximum_count";
      observed: number;
      maximum: number;
    });

export interface CandidateGateResult {
  id: string;
  metric: string;
  kind: CandidateGate["kind"];
  required: boolean;
  status: "pass" | "fail" | "insufficient_evidence";
  observed: number | null;
  threshold: number;
  comparator: ">=" | "<=";
  reason: string;
}

export interface CandidateAcceptanceResult {
  status: "accept" | "reject" | "insufficient_evidence";
  accepted: boolean;
  requiredGateCount: number;
  passedRequiredGateCount: number;
  failedRequiredGateIds: string[];
  insufficientRequiredGateIds: string[];
  gates: CandidateGateResult[];
}

function finite(value: number, field: string) {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
}

function nonNegativeInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function validateEstimate(
  estimate: MetricEstimate,
  field: string,
): MetricEstimate {
  nonNegativeInteger(estimate.sampleSize, `${field}.sampleSize`);
  for (const key of ["point", "lower", "upper"] as const) {
    const value = estimate[key];
    if (value !== null) finite(value, `${field}.${key}`);
  }
  if (
    estimate.lower !== null &&
    estimate.upper !== null &&
    estimate.lower > estimate.upper
  ) {
    throw new Error(`${field}.lower cannot exceed ${field}.upper`);
  }
  if (
    estimate.point !== null &&
    estimate.lower !== null &&
    estimate.point < estimate.lower
  ) {
    throw new Error(`${field}.point cannot be below ${field}.lower`);
  }
  if (
    estimate.point !== null &&
    estimate.upper !== null &&
    estimate.point > estimate.upper
  ) {
    throw new Error(`${field}.point cannot exceed ${field}.upper`);
  }
  return estimate;
}

export function normalizeCandidateMinusBaseline(
  estimate: CandidateMinusBaselineEstimate,
): ImprovementEstimate {
  validateEstimate(estimate, "candidateMinusBaseline");
  const direction: string = estimate.direction;
  if (direction !== "higher_is_better" && direction !== "lower_is_better") {
    throw new Error("candidateMinusBaseline.direction is invalid");
  }
  if (direction === "higher_is_better") {
    return {
      point: estimate.point,
      lower: estimate.lower,
      upper: estimate.upper,
      sampleSize: estimate.sampleSize,
      polarity: "positive_is_candidate_improvement",
    };
  }

  return {
    point: estimate.point === null ? null : -estimate.point,
    lower: estimate.upper === null ? null : -estimate.upper,
    upper: estimate.lower === null ? null : -estimate.lower,
    sampleSize: estimate.sampleSize,
    polarity: "positive_is_candidate_improvement",
  };
}

function result(
  gate: CandidateGate,
  status: CandidateGateResult["status"],
  observed: number | null,
  threshold: number,
  comparator: CandidateGateResult["comparator"],
  reason: string,
): CandidateGateResult {
  return {
    id: gate.id,
    metric: gate.metric,
    kind: gate.kind,
    required: gate.required ?? true,
    status,
    observed,
    threshold,
    comparator,
    reason,
  };
}

function evaluateGate(gate: CandidateGate): CandidateGateResult {
  if (!gate.id.trim()) throw new Error("candidate gate id cannot be empty");
  if (!gate.metric.trim())
    throw new Error("candidate gate metric cannot be empty");

  if (gate.kind === "minimum_evidence") {
    nonNegativeInteger(gate.observed, `${gate.id}.observed`);
    nonNegativeInteger(gate.minimum, `${gate.id}.minimum`);
    const passes = gate.observed >= gate.minimum;
    return result(
      gate,
      passes ? "pass" : "insufficient_evidence",
      gate.observed,
      gate.minimum,
      ">=",
      passes ? "minimum evidence met" : "minimum evidence not met",
    );
  }

  if (gate.kind === "maximum_count") {
    nonNegativeInteger(gate.observed, `${gate.id}.observed`);
    nonNegativeInteger(gate.maximum, `${gate.id}.maximum`);
    const passes = gate.observed <= gate.maximum;
    return result(
      gate,
      passes ? "pass" : "fail",
      gate.observed,
      gate.maximum,
      "<=",
      passes ? "maximum count respected" : "maximum count exceeded",
    );
  }

  if (gate.kind === "minimum" || gate.kind === "maximum") {
    const threshold = gate.kind === "minimum" ? gate.minimum : gate.maximum;
    finite(threshold, `${gate.id}.threshold`);
    if (gate.estimate === null) {
      return result(
        gate,
        "insufficient_evidence",
        null,
        threshold,
        gate.kind === "minimum" ? ">=" : "<=",
        "estimate is missing",
      );
    }
    const estimate = validateEstimate(gate.estimate, `${gate.id}.estimate`);
    const observed = estimate[gate.conservativeBound];
    if (observed === null) {
      return result(
        gate,
        "insufficient_evidence",
        null,
        threshold,
        gate.kind === "minimum" ? ">=" : "<=",
        `${gate.conservativeBound} estimate is missing`,
      );
    }
    const passes =
      gate.kind === "minimum"
        ? observed >= gate.minimum
        : observed <= gate.maximum;
    return result(
      gate,
      passes ? "pass" : "fail",
      observed,
      threshold,
      gate.kind === "minimum" ? ">=" : "<=",
      passes ? "absolute threshold met" : "absolute threshold missed",
    );
  }

  const threshold =
    gate.kind === "non_inferiority" ? -gate.margin : gate.minimumImprovement;
  if (gate.kind === "non_inferiority") {
    finite(gate.margin, `${gate.id}.margin`);
    if (gate.margin < 0)
      throw new Error(`${gate.id}.margin cannot be negative`);
  } else {
    finite(gate.minimumImprovement, `${gate.id}.minimumImprovement`);
    if (gate.minimumImprovement < 0) {
      throw new Error(`${gate.id}.minimumImprovement cannot be negative`);
    }
  }
  if (gate.improvement === null) {
    return result(
      gate,
      "insufficient_evidence",
      null,
      threshold,
      ">=",
      "paired improvement interval is missing",
    );
  }
  const improvement = validateEstimate(
    gate.improvement,
    `${gate.id}.improvement`,
  );
  if (gate.improvement.polarity !== "positive_is_candidate_improvement") {
    throw new Error(`${gate.id}.improvement polarity is invalid`);
  }
  if (improvement.lower === null) {
    return result(
      gate,
      "insufficient_evidence",
      null,
      threshold,
      ">=",
      "paired improvement lower bound is missing",
    );
  }
  const passes = improvement.lower >= threshold;
  return result(
    gate,
    passes ? "pass" : "fail",
    improvement.lower,
    threshold,
    ">=",
    passes
      ? gate.kind === "non_inferiority"
        ? "non-inferiority margin met"
        : "superiority threshold met"
      : gate.kind === "non_inferiority"
        ? "non-inferiority margin missed"
        : "superiority threshold missed",
  );
}

export function evaluateCandidateAcceptance(
  gates: readonly CandidateGate[],
): CandidateAcceptanceResult {
  const ids = new Set<string>();
  const evaluated = gates.map((gate) => {
    if (ids.has(gate.id))
      throw new Error(`duplicate candidate gate id: ${gate.id}`);
    ids.add(gate.id);
    return evaluateGate(gate);
  });
  const required = evaluated.filter((gate) => gate.required);
  const failedRequiredGateIds = required
    .filter((gate) => gate.status === "fail")
    .map((gate) => gate.id);
  const insufficientRequiredGateIds = required
    .filter((gate) => gate.status === "insufficient_evidence")
    .map((gate) => gate.id);
  const status =
    required.length === 0
      ? "insufficient_evidence"
      : failedRequiredGateIds.length > 0
        ? "reject"
        : insufficientRequiredGateIds.length > 0
          ? "insufficient_evidence"
          : "accept";

  return {
    status,
    accepted: status === "accept",
    requiredGateCount: required.length,
    passedRequiredGateCount: required.filter((gate) => gate.status === "pass")
      .length,
    failedRequiredGateIds,
    insufficientRequiredGateIds,
    gates: evaluated,
  };
}
