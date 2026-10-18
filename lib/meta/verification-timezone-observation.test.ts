import { describe, expect, it, vi } from "vitest";
import {
  observeMetaVerificationTimezones as observe,
  runWithMetaVerificationTimezoneObservations as scoped,
} from "./verification-timezone-observation";

const rows = () => [{ provider_account_id: "act_owned", account_timezone: "UTC" }];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("workspace verification timezone observations", () => {
  it("shares pending and completed observations, with independent consumer rows", async () => {
    const source = {}, gate = deferred();
    const load = vi.fn(async () => { await gate.promise; return rows(); });
    await scoped(async () => {
      const a = observe(source, "same", load), b = observe(source, "same", load);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      gate.resolve();
      const [first, second] = await Promise.all([a, b]);
      first[0]!.account_timezone = "owned-mutation";
      first.push({ provider_account_id: "other", account_timezone: "UTC" });
      expect(second).toEqual(rows());
      expect(await observe(source, "same", load)).toEqual(rows());
      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  it("leaves outside callers independent and isolates requests, sources and full keys", async () => {
    const source = {}, other = {}, load = vi.fn(async () => rows());
    await Promise.all([observe(source, "a", load), observe(source, "a", load)]);
    expect(load).toHaveBeenCalledTimes(2);
    await Promise.all([scoped(() => observe(source, "a", load)), scoped(() => observe(source, "a", load))]);
    expect(load).toHaveBeenCalledTimes(4);
    await scoped(async () => {
      await observe(source, "account-a-deadline-8", load);
      await observe(source, "account-b-deadline-8", load);
      await observe(source, "account-a-deadline-5", load);
      await observe(other, "account-a-deadline-8", load);
    });
    expect(load).toHaveBeenCalledTimes(8);
  });

  it("propagates failure, then retries rather than retaining an unknown result", async () => {
    const source = {}, load = vi.fn().mockRejectedValueOnce(new Error("owned_read_failure")).mockResolvedValue(rows());
    await scoped(async () => {
      await expect(observe(source, "a", load)).rejects.toThrow("owned_read_failure");
      expect(await observe(source, "a", load)).toEqual(rows());
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  it("evicts an invalid row shape instead of turning it into empty timezone evidence", async () => {
    const source = {};
    const load = vi.fn().mockResolvedValueOnce([null]).mockResolvedValue(rows());
    await scoped(async () => {
      await expect(observe(source, "a", load)).rejects.toThrow();
      expect(await observe(source, "a", load)).toEqual(rows());
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  it("does not let nested scopes close the outer one, and shares across module copies", async () => {
    const source = {}, load = vi.fn(async () => rows());
    vi.resetModules();
    const other = await import("./verification-timezone-observation");
    await scoped(async () => {
      await other.runWithMetaVerificationTimezoneObservations(() => other.observeMetaVerificationTimezones(source, "a", load));
      await observe(source, "a", load);
      expect(load).toHaveBeenCalledTimes(1);
    });
    await other.runWithMetaVerificationTimezoneObservations(() => other.observeMetaVerificationTimezones(source, "a", load));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("stops sharing once the request ends, including work that outlives its response", async () => {
    const source = {}, gate = deferred(), load = vi.fn(async () => rows());
    let later!: Promise<void>;
    await scoped(async () => {
      await observe(source, "a", load);
      later = (async () => { await gate.promise; await observe(source, "a", load); })();
    });
    gate.resolve();
    await later;
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("falls back to real reads when its bounded key store is full", async () => {
    const source = {}, load = vi.fn(async () => rows());
    await scoped(async () => {
      for (let i = 0; i < 33; i++) await observe(source, String(i), load);
      await observe(source, "32", load);
      await observe(source, "0", load);
      expect(load).toHaveBeenCalledTimes(34);
    });
  });
});
