import path from "node:path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { reachableFromRoutes } from "@/scripts/meta/verify-mounted-bodies";

/**
 * WP4 item 8 — a Meta read's cache key must carry the account it was read for.
 *
 * The failure this prevents is the plan's rollback trigger 3: after switching
 * from account A to account B, the surface shows A's data. A key of
 * `["meta-x", businessId]` has one entry for a business, so on a business with
 * several assigned Meta accounts the first account's rows are served to the
 * second — silently, from cache, with no request and no error.
 *
 * It is written as a **gate** rather than a one-time sweep because the class
 * recurs: every new account-scoped read is one `queryKey` line away from it.
 *
 * ## Scope of the check
 *
 * Only READ keys on files a route can actually reach. Two deliberate exclusions:
 *
 * - **Invalidation prefixes.** `invalidateQueries({ queryKey: ["meta-lanes",
 *   businessId] })` is a prefix that must match every account variant. Adding
 *   the account there would invalidate one account and leave the others stale —
 *   the opposite of the intent.
 * - **Unreachable bodies.** A key in a component no route mounts cannot serve
 *   anyone the wrong account. Those are WP16's dead-module problem, not this
 *   one, and they are listed below so the exclusion is visible rather than
 *   silent.
 */

/** Keys that are genuinely business-scoped, each with the reason. */
const BUSINESS_SCOPED: Readonly<Record<string, string>> = {
  // The list of accounts itself. Scoping it by account would be circular.
  "meta-provider-accounts": "enumerates the accounts; cannot be scoped by one",
  // Connection and sync state belong to the integration, not to one account.
  "meta-status": "integration-level connection state",
  "meta-sync-status": "integration-level sync state",
  "meta-creative-brief-capability": "schema capability, not account data",
};

interface KeyUse {
  file: string;
  line: number;
  name: string;
  key: string;
  isInvalidation: boolean;
}

const SOURCE_CACHE = new Map<string, string[]>();

function fileLines(file: string): string[] {
  const cached = SOURCE_CACHE.get(file);
  if (cached) return cached;
  const lines = readFileSync(file, "utf8").split("\n");
  SOURCE_CACHE.set(file, lines);
  return lines;
}

/**
 * Is this key an invalidation prefix rather than a read?
 *
 * The call is routinely split across lines —
 *
 *   queryClient.invalidateQueries({
 *     queryKey: ["meta-lanes", businessId],
 *   })
 *
 * — so the keyword sits above the key. Looking at the `queryKey` line alone
 * classified every one of those as a read, which would have "fixed" the
 * prefixes and broken invalidation across accounts: adding the account there
 * invalidates one account and leaves the others stale, the opposite of the
 * intent. A short lookback covers the real formatting without swallowing an
 * unrelated call further up.
 */
function isInvalidationAt(file: string, lineNumber: number): boolean {
  const lines = fileLines(file);
  const start = Math.max(0, lineNumber - 4);
  const window = lines.slice(start, lineNumber).join("\n");
  return /invalidateQueries|removeQueries|findAll|cancelQueries|resetQueries|setQueryData|getQueryData/.test(
    window,
  );
}

function metaQueryKeyUses(): KeyUse[] {
  const raw = execSync(
    `git grep -n -E 'queryKey: \\["meta-' -- 'components/**' 'app/**' || true`,
    { encoding: "utf8" },
  );
  return raw
    .split("\n")
    .filter(Boolean)
    .map((entry) => {
      const [file, lineNumber, ...rest] = entry.split(":");
      const text = rest.join(":");
      const key = text.match(/queryKey: (\[[^\]]*\])/)?.[1] ?? "";
      const name = key.match(/"(meta-[a-z0-9-]+)"/)?.[1] ?? "";
      return {
        file: file!,
        line: Number(lineNumber),
        name,
        key,
        isInvalidation: isInvalidationAt(file!, Number(lineNumber)),
      };
    })
    .filter((use) => use.name && !use.file.includes(".test."));
}

const reachable = reachableFromRoutes();

function isReachable(file: string): boolean {
  return reachable.has(path.join(process.cwd(), file));
}

describe("Meta read keys carry the account they were read for", () => {
  it("finds Meta query keys to check, so a pass is not vacuous", () => {
    expect(metaQueryKeyUses().length).toBeGreaterThan(5);
  });

  it("every reachable Meta READ key is account-scoped or reasoned", () => {
    const offenders = metaQueryKeyUses()
      .filter((use) => !use.isInvalidation)
      .filter((use) => isReachable(use.file))
      .filter((use) => !BUSINESS_SCOPED[use.name])
      .filter((use) => !/providerAccountId|accountId|AccountId/.test(use.key))
      .map((use) => `${use.file}:${use.line} ${use.key}`);

    expect(offenders).toEqual([]);
  });

  it("does not mistake an invalidation prefix for a read", () => {
    /**
     * The check has to be able to tell them apart, or it would "fix" the
     * prefixes and break invalidation across accounts. This asserts the
     * distinction is actually being drawn on real lines.
     */
    const uses = metaQueryKeyUses();
    expect(uses.some((use) => use.isInvalidation)).toBe(true);
    expect(uses.some((use) => !use.isInvalidation)).toBe(true);
  });

  it("records the unreachable bodies it skipped rather than skipping silently", () => {
    /**
     * These carry unscoped Meta reads and are mounted by nothing, so they
     * cannot serve anyone the wrong account. Fixing a dead component would be
     * work with no user, and deleting one is WP16's move with its own
     * compatibility and rollback story.
     *
     * If one becomes reachable this list is wrong and the check above starts
     * failing on it — which is the correct signal in both directions.
     */
    const skipped = metaQueryKeyUses()
      .filter((use) => !use.isInvalidation)
      .filter((use) => !isReachable(use.file))
      .filter((use) => !BUSINESS_SCOPED[use.name])
      .filter((use) => !/providerAccountId|accountId|AccountId/.test(use.key))
      .map((use) => use.file);

    expect([...new Set(skipped)].sort()).toEqual([
      "components/meta/meta-campaign-detail.tsx",
      "components/meta/meta-campaign-table.tsx",
    ]);
  });

  it("keeps the account in the keys this sweep fixed", () => {
    // Named explicitly so a revert is loud rather than a silent regression.
    const labels = readFileSync(
      "components/meta/redesign/MetaCampaignLabelsSection.tsx",
      "utf8",
    );
    expect(labels).toContain('"meta-campaigns-for-labels", businessId, providerAccountId');
    expect(labels).toContain("providerAccountId,\n      campaignIds.join(\",\")");

    const actions = readFileSync(
      "components/creatives/CreativeAdActionsSection.tsx",
      "utf8",
    );
    expect(actions).toContain('"meta-action-campaigns", businessId, pickerAccountId');
    expect(actions).toContain('"meta-action-adsets", businessId, pickerAccountId');
  });
});
