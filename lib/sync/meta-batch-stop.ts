export interface MetaPartitionBatchProcessResult {
  outcome: "succeeded" | "failed" | "requeued";
  failureClass?: string | null;
  stopBatch?: boolean;
  retryDelayMinutes?: number;
}

export interface MetaPartitionBatchResult {
  attempted: number;
  succeeded: number;
  failed: number;
  stopReason: string | null;
  retryDelayMinutes: number;
}

export interface MetaPartitionBatchPreflightStop {
  stopReason: string;
  retryDelayMinutes?: number;
  countAsFailure?: boolean;
}

export class MetaProviderBatchStopError extends Error {
  readonly failureClass: string;
  readonly retryDelayMinutes: number;

  constructor(input: {
    failureClass: string;
    retryDelayMinutes?: number;
    message?: string;
  }) {
    super(
      input.message ??
        `Meta provider batch stopped after ${input.failureClass}`,
    );
    this.name = "MetaProviderBatchStopError";
    this.failureClass = input.failureClass;
    this.retryDelayMinutes = Math.max(
      0,
      Math.floor(input.retryDelayMinutes ?? 0),
    );
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

function getErrorName(error: unknown) {
  return error instanceof Error ? error.name : "";
}

function getErrorRequestType(error: unknown) {
  if (!error || typeof error !== "object" || !("requestType" in error)) {
    return "";
  }
  const requestType = (error as { requestType?: unknown }).requestType;
  return typeof requestType === "string" ? requestType : "";
}

export function isMetaProviderStopLossFailure(input: {
  error: unknown;
  errorClass?: string | null;
}) {
  const errorClass = input.errorClass?.trim().toLowerCase() ?? "";
  if (
    errorClass === "quota" ||
    errorClass === "global_circuit_breaker" ||
    errorClass === "provider_execution_fenced"
  ) {
    return true;
  }

  if (getErrorName(input.error) === "ProviderRequestCooldownError") {
    return true;
  }

  const requestType = getErrorRequestType(input.error);
  if (
    requestType === "__global_circuit_breaker__" ||
    requestType === "__global_circuit_breaker_recovery__"
  ) {
    return true;
  }

  const message = getErrorMessage(input.error).toLowerCase();
  return (
    /(?:status[\s:_=-]*|http[\s:_=-]*|:)429\b/.test(message) ||
    [
      "rate limit",
      "too many calls",
      "quota",
      "request limit reached",
      "user request limit reached",
      "status 429",
      "global circuit breaker",
      "provider_execution_fenced",
    ].some((signature) => message.includes(signature))
  );
}

export async function runMetaLeasedPartitionBatch<TPartition>(input: {
  partitions: readonly TPartition[];
  beforePartition?(
    partition: TPartition,
  ):
    | MetaPartitionBatchPreflightStop
    | null
    | Promise<MetaPartitionBatchPreflightStop | null>;
  processPartition(
    partition: TPartition,
  ): Promise<MetaPartitionBatchProcessResult>;
}): Promise<MetaPartitionBatchResult> {
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let stopReason: string | null = null;
  let retryDelayMinutes = 0;

  for (const partition of input.partitions) {
    const preflightStop = (await input.beforePartition?.(partition)) ?? null;
    if (preflightStop) {
      stopReason = preflightStop.stopReason;
      retryDelayMinutes = Math.max(
        0,
        Math.floor(preflightStop.retryDelayMinutes ?? 0),
      );
      if (preflightStop.countAsFailure !== false) {
        failed += 1;
      }
      break;
    }
    attempted += 1;
    const result = await input.processPartition(partition);
    if (result.outcome === "succeeded") {
      succeeded += 1;
      continue;
    }
    if (result.outcome === "failed") {
      failed += 1;
    }
    if (result.stopBatch) {
      stopReason = result.failureClass?.trim() || "meta_provider_stop_loss";
      retryDelayMinutes = Math.max(
        0,
        Math.floor(result.retryDelayMinutes ?? 0),
      );
      break;
    }
  }

  return {
    attempted,
    succeeded,
    failed,
    stopReason,
    retryDelayMinutes,
  };
}
