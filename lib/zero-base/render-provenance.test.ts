import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  RENDER_SOURCE_PATHS,
  compareFingerprints,
  describeDrift,
  isStale,
  renderFingerprint,
  type RenderFingerprint,
} from "@/lib/zero-base/render-provenance";

/**
 * G10 provenance — negative controls.
 *
 * These exist because the gate previously selected evidence by mtime, so 92
 * screenshots taken before thirteen render-affecting files changed went on
 * passing as current. Each case below is a way that could happen again.
 */

const REF = "0695ae452469ba3efe2615efe3ffd30fcdb88f5847db53d569042fb864c09b9d";

/** A fingerprint with one file's content altered. */
function withChange(base: RenderFingerprint, file: string, digest: string): RenderFingerprint {
  return { ...base, files: { ...base.files, [file]: digest } };
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("render provenance", () => {
  const current = renderFingerprint(REF);

  it("covers every category that can move a pixel", () => {
    // Not just "the components in the shot": tokens, copy, fixtures, the
    // harness and dependencies all change what is rendered.
    for (const entry of [
      "components/zero-base",
      "lib/zero-base",
      "app/globals.css",
      "scripts/zero-base/frame-registry.tsx",
      "scripts/zero-base/build-frame-harness.tsx",
      "pnpm-lock.yaml",
    ]) {
      expect(RENDER_SOURCE_PATHS, entry).toContain(entry);
    }
  });

  it("hashes the real tree, not an empty set", () => {
    expect(Object.keys(current.files).length).toBeGreaterThan(100);
    expect(current.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across repeated runs", () => {
    expect(renderFingerprint(REF).digest).toBe(current.digest);
  });

  it("excludes tests, which cannot change a rendered frame", () => {
    const files = Object.keys(current.files);
    expect(files.some((file) => file.endsWith(".test.tsx"))).toBe(false);
    expect(files.some((file) => file.endsWith(".test.ts"))).toBe(false);
  });

  /* ------------------------------------------------------- drift detection */

  it("REGRESSION: a changed component is stale evidence", () => {
    const drift = compareFingerprints(
      withChange(current, "components/zero-base/home/home-view.tsx", "0".repeat(64)),
      current,
    );
    expect(isStale(drift)).toBe(true);
    expect(drift.changed).toContain("components/zero-base/home/home-view.tsx");
    // The failure names the file rather than saying "something moved".
    expect(describeDrift(drift).join("\n")).toContain("home-view.tsx");
  });

  it("REGRESSION: a changed stylesheet is stale evidence", () => {
    const drift = compareFingerprints(withChange(current, "app/globals.css", "1".repeat(64)), current);
    expect(isStale(drift)).toBe(true);
    expect(drift.changed).toContain("app/globals.css");
  });

  it("REGRESSION: a changed copy catalogue is stale evidence", () => {
    // Copy changes what the screenshot says, which is exactly what a reader
    // checks a screenshot for.
    const drift = compareFingerprints(withChange(current, "lib/zero-base/copy.ts", "2".repeat(64)), current);
    expect(isStale(drift)).toBe(true);
    expect(drift.changed).toContain("lib/zero-base/copy.ts");
  });

  it("REGRESSION: a changed fixture or frame registry is stale evidence", () => {
    const drift = compareFingerprints(
      withChange(current, "scripts/zero-base/frame-registry.tsx", "3".repeat(64)),
      current,
    );
    expect(isStale(drift)).toBe(true);
    expect(drift.changed).toContain("scripts/zero-base/frame-registry.tsx");
  });

  it("REGRESSION: a changed harness is stale evidence", () => {
    const drift = compareFingerprints(
      withChange(current, "scripts/zero-base/build-frame-harness.tsx", "4".repeat(64)),
      current,
    );
    expect(isStale(drift)).toBe(true);
  });

  it("REGRESSION: a dependency bump is stale evidence", () => {
    const drift = compareFingerprints(withChange(current, "pnpm-lock.yaml", "5".repeat(64)), current);
    expect(isStale(drift)).toBe(true);
    expect(drift.changed).toContain("pnpm-lock.yaml");
  });

  it("REGRESSION: a changed accepted archive is stale evidence", () => {
    // A capture is only evidence against the reference it was compared to.
    const drift = compareFingerprints({ ...current, referenceSha256: "deadbeef" }, current);
    expect(isStale(drift)).toBe(true);
    expect(drift.referenceChanged).toBe(true);
    expect(describeDrift(drift).join("\n")).toContain("accepted design archive changed");
  });

  it("REGRESSION: a new or deleted render file is stale evidence", () => {
    const added = { ...current, files: { ...current.files } };
    delete added.files["components/zero-base/home/home-view.tsx"];
    // Recorded set is missing a file the tree now has → added.
    expect(isStale(compareFingerprints(added, current))).toBe(true);
    // Recorded set has a file the tree no longer has → removed.
    const removed = withChange(current, "components/zero-base/gone.tsx", "6".repeat(64));
    const drift = compareFingerprints(removed, current);
    expect(drift.removed).toContain("components/zero-base/gone.tsx");
    expect(isStale(drift)).toBe(true);
  });

  /* ----------------------------------------------------- the allowed case */

  it("an artifact-only or report-only commit is NOT stale", () => {
    // This is the case the plan singles out: evidence is committed after the
    // code it describes. Binding by content rather than by commit id gives the
    // right answer — nothing that renders moved, so the capture still holds.
    const dir = mkdtempSync(path.join(os.tmpdir(), "prov-"));
    temps.push(dir);
    mkdirSync(path.join(dir, "docs"), { recursive: true });
    writeFileSync(path.join(dir, "docs", "report.md"), "# report\n");

    const after = renderFingerprint(REF);
    expect(after.digest).toBe(current.digest);
    expect(isStale(compareFingerprints(current, after))).toBe(false);
  });
});
