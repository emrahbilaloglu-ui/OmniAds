import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SYNC_AGE_UNKNOWN_LABEL,
  isUnknownSyncAgeLabel,
} from "./provider-sync-vocabulary";
import { formatSyncAge } from "@/components/layout/v2/use-shell-signals";
import { formatProviderSyncLabel } from "@/components/overview/v2/platform-card";

/**
 * One rule, stated once: a sync that did not complete, whose age is unknown,
 * or whose status was a failure must never be described with the affirmative
 * verb "Synced". The previous "Synced —" claimed the sync happened and only
 * its age was missing.
 *
 * The surface-level pins below are source assertions on purpose. The defect
 * class is a copy claim that is individually well-typed everywhere it appears,
 * so a rendered assertion in one component cannot prove the other surfaces
 * still agree.
 */
describe("unknown provider sync age is never stated as a completed sync", () => {
  it("never uses the affirmative verb for the unknown label", () => {
    expect(SYNC_AGE_UNKNOWN_LABEL).not.toContain("Synced");
    expect(SYNC_AGE_UNKNOWN_LABEL.trim()).toBe(SYNC_AGE_UNKNOWN_LABEL);
    expect(SYNC_AGE_UNKNOWN_LABEL.length).toBeGreaterThan(0);
  });

  it("returns the unknown label when the shell has no age", () => {
    expect(formatSyncAge(null)).toBe(SYNC_AGE_UNKNOWN_LABEL);
    expect(formatSyncAge(null)).not.toContain("Synced");
  });

  it("returns the unknown label when a provider sync did not complete", () => {
    // A failed sync previously rendered "Synced —".
    expect(
      formatProviderSyncLabel("2026-08-17T12:00:00.000Z", "failed"),
    ).toBe(SYNC_AGE_UNKNOWN_LABEL);
    expect(formatProviderSyncLabel(null, null)).toBe(SYNC_AGE_UNKNOWN_LABEL);
    expect(formatProviderSyncLabel("not-a-date", "succeeded")).toBe(
      SYNC_AGE_UNKNOWN_LABEL,
    );
  });

  it("still reports a genuine fresh or stale age with the affirmative verb", () => {
    expect(formatSyncAge(0)).toBe("Synced just now");
    expect(formatSyncAge(12)).toBe("Synced 12m ago");
    expect(formatSyncAge(180)).toBe("Synced 3h ago");
    expect(formatSyncAge(2880)).toBe("Synced 2d ago");

    const now = Date.parse("2026-08-29T12:00:00.000Z");
    expect(
      formatProviderSyncLabel("2026-08-29T11:48:00.000Z", "succeeded", now),
    ).toBe("Synced 12m ago");
    expect(
      formatProviderSyncLabel("2026-08-27T12:00:00.000Z", "completed", now),
    ).toBe("Synced 2d ago");
  });

  it("treats the unknown label as neutral wherever tone is derived from text", () => {
    expect(isUnknownSyncAgeLabel(SYNC_AGE_UNKNOWN_LABEL)).toBe(true);
    // The previous em-dash form must keep resolving neutral for persisted or
    // server-supplied labels this release does not own.
    expect(isUnknownSyncAgeLabel("Synced —")).toBe(true);
    expect(isUnknownSyncAgeLabel("")).toBe(true);
    expect(isUnknownSyncAgeLabel(null)).toBe(true);
    expect(isUnknownSyncAgeLabel("Synced 12m ago")).toBe(false);
  });
});

describe("every unavailable sync path shares the one vocabulary", () => {
  const surfaces = [
    "components/layout/v2/use-shell-signals.ts",
    "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
    "components/google-ads/google-advisor-exact-adapter.ts",
    "components/overview/v2/platform-card.tsx",
    "components/overview/AgencyToday.tsx",
  ];

  it.each(surfaces)("%s states the unknown age from the shared constant", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain("SYNC_AGE_UNKNOWN_LABEL");
    expect(source).not.toContain('"Synced —"');
  });

  it("keeps the syncing, attention and reconnect labels unchanged", () => {
    const shell = readFileSync("components/layout/v2/use-shell-signals.ts", "utf8");
    expect(shell).toContain('label: "Syncing now"');
    expect(shell).toContain('label: "Sync needs attention"');

    const google = readFileSync(
      "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
      "utf8",
    );
    expect(google).toContain('label: "Syncing now"');
    expect(google).toContain('label: "Reconnect required"');
  });

  /**
   * The contract document claims these labels cannot drift apart. That claim is
   * only true while no other file restates the string, so the scan is
   * repo-wide rather than a fixed allowlist.
   */
  it("has no second copy of the label anywhere in app, lib or components", () => {
    const roots = ["app", "components", "lib"];
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (full.endsWith("lib/provider-sync-vocabulary.ts")) continue;
        if (full.endsWith("lib/provider-sync-vocabulary.test.ts")) continue;
        if (readFileSync(full, "utf8").includes(`"${SYNC_AGE_UNKNOWN_LABEL}"`)) {
          offenders.push(full);
        }
      }
    };

    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
