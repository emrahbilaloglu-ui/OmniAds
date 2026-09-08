/**
 * THE BOOTSTRAP THAT KEEPS A CORRECT REFUSAL FROM BECOMING A BLACKOUT.
 *
 * ── ROUND 15, DEFECT 5 ──────────────────────────────────────────────────────
 * Every receipt written before `sync_run_id` existed reads `sync_run_unlinked`
 * and holds. That refusal is right, and it is supposed to be self-healing —
 * the next sync writes a linked receipt and the account recovers.
 *
 * It does not heal on a HEALTHY account. Current-config receipts are written
 * only by the current-inventory path inside `syncMetaAccountCoreWarehouseDay`,
 * and `syncMetaPartitionDay` skips the entire account-core sync when
 * `coverageState.productCoreComplete` is true. An account that is already up to
 * date therefore never re-observes, never writes a linked receipt, and holds
 * every purchase-budget hard action forever.
 *
 * The bypass is deliberately narrow and self-terminating: current day only,
 * both endpoints must be unlinked, bounded attempts, and it stops the moment
 * linked receipts exist.
 */
import { describe, expect, it } from "vitest";

import {
  META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS,
  shouldBootstrapRecentEditAuthority,
} from "@/lib/meta/recent-edit-authority";
import { shouldBypassMetaCoverageShortCircuit } from "@/lib/sync/meta-sync";

const probe = (over: Partial<{
  campaignReceiptLinked: boolean;
  adsetReceiptLinked: boolean;
  attemptsSpent: number | null;
}> = {}) => ({
  campaignReceiptLinked: false,
  adsetReceiptLinked: false,
  attemptsSpent: 0,
  ...over,
});

describe("the recent-edit authority bootstrap", () => {
  it("fires on the current day when no linked authority receipt exists", () => {
    expect(
      shouldBootstrapRecentEditAuthority({
        truthState: "provisional",
        probe: probe(),
      }),
    ).toBe(true);
  });

  it("SUPPRESSES itself once both endpoints are linked and successful", () => {
    // The loop guard. Without this the bypass would refetch on every refresh.
    expect(
      shouldBootstrapRecentEditAuthority({
        truthState: "provisional",
        probe: probe({ campaignReceiptLinked: true, adsetReceiptLinked: true }),
      }),
    ).toBe(false);
  });

  it("still fires when only ONE endpoint is linked", () => {
    // The authority reads campaign and adset independently; one linked pair
    // does not unblock the other.
    for (const half of [
      { campaignReceiptLinked: true },
      { adsetReceiptLinked: true },
    ]) {
      expect(
        shouldBootstrapRecentEditAuthority({
          truthState: "provisional",
          probe: probe(half),
        }),
        JSON.stringify(half),
      ).toBe(true);
    }
  });

  it("never fires on a completed historical day", () => {
    /*
      A historical partition must not refetch CURRENT inventory: that is the
      amplification the current-evidence gate exists to prevent, and a receipt
      written there would attest the wrong day.
    */
    expect(
      shouldBootstrapRecentEditAuthority({
        truthState: "finalized",
        probe: probe(),
      }),
    ).toBe(false);
  });

  it("is BOUNDED, so a permanently failing attempt is not retried forever", () => {
    // A partial or failed attempt leaves the authority unavailable and spends
    // one bootstrap; after the bound the account waits for the ordinary sync.
    expect(
      shouldBootstrapRecentEditAuthority({
        truthState: "provisional",
        probe: probe({ attemptsSpent: META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS - 1 }),
      }),
    ).toBe(true);
    expect(
      shouldBootstrapRecentEditAuthority({
        truthState: "provisional",
        probe: probe({ attemptsSpent: META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS }),
      }),
    ).toBe(false);
  });

  it("FAILS CLOSED when the attempt ledger cannot be read", () => {
    /*
      ROUND 17. `attemptsSpent: null` means the durable ledger was unreadable.
      Without a trustworthy count the bound cannot be enforced, so no provider
      call is made — the account stays on the HOLD it was already on.
    */
    expect(
      shouldBootstrapRecentEditAuthority({
        truthState: "provisional",
        probe: probe({ attemptsSpent: null }),
      }),
    ).toBe(false);
  });

  it("treats an UNPROBED account as no finding, not as a reason to refetch", () => {
    expect(
      shouldBootstrapRecentEditAuthority({
        truthState: "provisional",
        probe: null,
      }),
    ).toBe(false);
  });
});

describe("the coverage short-circuit honours the bootstrap", () => {
  const base = {
    source: "core_success",
    businessId: "biz_1",
  } as const;

  it("bypasses complete coverage when authority is unlinked", () => {
    /*
      THE WHOLE POINT. `productCoreComplete` is true, so without this the
      account-core sync — the only writer of current-config receipts — is
      skipped and the blackout is permanent.
    */
    expect(
      shouldBypassMetaCoverageShortCircuit({
        ...base,
        truthState: "provisional",
        // ROUND 17: the caller decides (and records the attempt) before this
        // point, because the decision has a write side effect.
        authorityBootstrapForced: true,
      }),
    ).toBe(true);
  });

  it("resumes ordinary short-circuiting once receipts are linked", () => {
    expect(
      shouldBypassMetaCoverageShortCircuit({
        ...base,
        truthState: "provisional",
        authorityBootstrapForced: false,
      }),
    ).toBe(false);
  });

  it("leaves the pre-existing authoritative-historical bypass untouched", () => {
    // The bootstrap is additive. A finalized authoritative source keeps its own
    // bypass, and a provisional day with no probe keeps its own short-circuit.
    expect(
      shouldBypassMetaCoverageShortCircuit({
        ...base,
        truthState: "provisional",
      }),
    ).toBe(false);
  });
});
