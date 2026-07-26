import { describe, expect, it, vi } from "vitest";

import {
  isMetaProviderStopLossFailure,
  runMetaLeasedPartitionBatch,
} from "@/lib/sync/meta-batch-stop";

describe("Meta leased partition batch stop-loss", () => {
  it("stops before starting later leased work after a quota failure", async () => {
    const started: string[] = [];
    const processPartition = vi.fn(async (partition: { id: string }) => {
      started.push(partition.id);
      if (partition.id === "partition-2") {
        return {
          outcome: "failed" as const,
          failureClass: "quota",
          stopBatch: true,
          retryDelayMinutes: 10,
        };
      }
      return { outcome: "succeeded" as const };
    });

    const result = await runMetaLeasedPartitionBatch({
      partitions: [
        { id: "partition-1" },
        { id: "partition-2" },
        { id: "partition-3" },
      ],
      processPartition,
    });

    expect(started).toEqual(["partition-1", "partition-2"]);
    expect(processPartition).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      attempted: 2,
      succeeded: 1,
      failed: 1,
      stopReason: "quota",
      retryDelayMinutes: 10,
    });
  });

  it("does not speculatively start the next partition while the current result is pending", async () => {
    let resolveFirst:
      | ((result: {
          outcome: "failed";
          failureClass: string;
          stopBatch: boolean;
          retryDelayMinutes: number;
        }) => void)
      | undefined;
    const firstResult = new Promise<{
      outcome: "failed";
      failureClass: string;
      stopBatch: boolean;
      retryDelayMinutes: number;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const started: string[] = [];
    const runPromise = runMetaLeasedPartitionBatch({
      partitions: [{ id: "partition-1" }, { id: "partition-2" }],
      processPartition: async (partition) => {
        started.push(partition.id);
        return firstResult;
      },
    });

    await Promise.resolve();
    expect(started).toEqual(["partition-1"]);

    resolveFirst?.({
      outcome: "failed",
      failureClass: "quota",
      stopBatch: true,
      retryDelayMinutes: 10,
    });

    await expect(runPromise).resolves.toMatchObject({
      attempted: 1,
      failed: 1,
      stopReason: "quota",
    });
    expect(started).toEqual(["partition-1"]);
  });

  it("recognizes authoritative quota, rate-limit, and global-breaker signals", () => {
    expect(
      isMetaProviderStopLossFailure({
        error: new Error("Meta request failed with status 429"),
        errorClass: "quota",
      }),
    ).toBe(true);
    expect(
      isMetaProviderStopLossFailure({
        error: new Error("User request limit reached"),
        errorClass: "transient",
      }),
    ).toBe(true);
    expect(
      isMetaProviderStopLossFailure({
        error: Object.assign(new Error("Global circuit breaker is open"), {
          name: "ProviderRequestCooldownError",
          requestType: "__global_circuit_breaker__",
        }),
        errorClass: "transient",
      }),
    ).toBe(true);
    expect(
      isMetaProviderStopLossFailure({
        error: new Error("ECONNRESET"),
        errorClass: "transient",
      }),
    ).toBe(false);
  });

  it("does not count work blocked by a preflight lease fence as attempted", async () => {
    const processPartition = vi.fn();
    const result = await runMetaLeasedPartitionBatch({
      partitions: [{ id: "partition-1" }],
      beforePartition: () => ({
        stopReason: "runner_lease_conflict",
        countAsFailure: true,
      }),
      processPartition,
    });

    expect(processPartition).not.toHaveBeenCalled();
    expect(result).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 1,
      stopReason: "runner_lease_conflict",
      retryDelayMinutes: 0,
    });
  });
});
