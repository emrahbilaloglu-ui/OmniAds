// D077 correction 8 — artifact hash-contract guard, FAIL-CLOSED and
// clean-checkout PORTABLE: every runtime input is repository-relative
// (the canonical whole-shell log is a manifest-pinned generated-evidence
// file), so a clean checkout/CI needs no /private/tmp, user home, or
// Claude session directory.
//
// Every named generated artifact MUST exist and every required ledger
// stage/proof/log/source input MUST be present — a missing artifact,
// stage, proof, retained log, or seam script FAILS this suite; nothing
// skips. The whole-shell contract is verified by RECOMPUTING the proof
// (buildWholeShellProof against the retained log and the CURRENT seam
// script) and deep-comparing it to the embedded ledger proof. The pnpm
// provenance is verified by re-deriving ONE canonical probe state from
// the tagged measurements (deriveCanonicalProbe — the same function the
// generator builds with) and deep-comparing it to the serialized probe
// with exact key sets at every level; no summary field is trusted
// independently and no assertion tests prose by substring.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildWholeShellProof } from "@/scripts/audits/d077-whole-shell-proof";
import {
  CODEX_FALLBACK_PNPM_PATH,
  RETAINED_C4_PROBE,
  assertPortableRepoRelativePath,
  buildExplicitPathProbe,
  buildPathLookupProbe,
  deriveCanonicalProbe,
  deriveScopedChange,
  isStrictIsoUtc,
  validatePnpmProvenance,
  type ExecutedStep,
  type ExistenceObservation,
  type PathLookupProbe,
  type PnpmProvenance,
  type ProbeMeasurement,
  type RawSpawnResult,
} from "@/scripts/audits/d077-provenance-contract";

const ROOT = process.cwd();
const GEN = "docs/audits/generated";

const ARTIFACTS: Array<{ file: string; hashField: string }> = [
  { file: `${GEN}/d077-production-recovery-readonly-evidence-2026-08-30.json`, hashField: "evidenceHash" },
  { file: `${GEN}/d077-correction1-verification-ledger-2026-08-30.json`, hashField: "ledgerHash" },
  { file: `${GEN}/d077-release-deploy-approval-packet-2026-08-30.json`, hashField: "packetHash" },
  { file: `${GEN}/d077-database-recovery-approval-packet-2026-08-30.json`, hashField: "packetHash" },
  { file: `${GEN}/d077-release-candidate-manifest-2026-08-30.json`, hashField: "manifestHash" },
];

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Fail-closed load: a missing artifact throws, failing the test. */
function mustLoadJson(path: string): Record<string, unknown> {
  const full = join(ROOT, path);
  if (!existsSync(full)) {
    throw new Error(`required D077 artifact is MISSING: ${path}`);
  }
  return JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
}

// ── Loose structural types for mutation fixtures (runtime shapes) ──────
type MutableStep = {
  executable: string;
  argv: string[];
  commandForm: string;
  exitStatus: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  spawnErrorCode: string | null;
  spawnErrorMessage: string | null;
  observedAtUtc: string;
};
type LooseProbe = {
  probeId: string;
  command: string;
  resolutionMechanism: string;
  resolutionKind: string;
  resolution: string;
  resolvedPath: string | null;
  reportedVersion: string | null;
  resultClass: string;
  observationKind: string;
  observedAtUtc: string | null;
  observationTimeCertainty: string;
  cacheSafeReadOnly: boolean | string;
  resolutionStep?: MutableStep | null;
  directExecutionStep?: MutableStep | null;
  existenceObservation?: {
    path: string;
    exists: boolean | null;
    observationErrorCode: string | null;
    observationErrorMessage: string | null;
    observedAtUtc: string;
  };
  [key: string]: unknown;
};
type LooseProvenance = {
  presentTenseProbes: LooseProbe[];
  correction3CorepackMutation: {
    occurred: boolean;
    command: string;
    when: string;
    restored: boolean;
    preMutationValue: string;
  };
  earlierRetainedStagesRuntime: string;
  correction5ProhibitedMutationCommandExecuted: boolean;
  corepackTrackedStateChanged: string;
  corepackScopedInspection: {
    inspectedPaths: Array<{ path: string; beforeMtime: string | null; afterMtime: string | null }>;
    changed: string;
    scopeNote: string;
  };
  globalHostStateClaim: string;
  [key: string]: unknown;
};

function loadProvenance(): LooseProvenance {
  const ledger = mustLoadJson(
    `${GEN}/d077-correction1-verification-ledger-2026-08-30.json`,
  ) as unknown as { runtimeVersions: { pnpmProvenance: LooseProvenance } };
  const provenance = ledger.runtimeVersions?.pnpmProvenance;
  if (!provenance) throw new Error("structured pnpmProvenance is REQUIRED — fail-closed");
  return provenance;
}
const cloneProvenance = (base: LooseProvenance): LooseProvenance =>
  JSON.parse(JSON.stringify(base)) as LooseProvenance;
const validateLoose = (input: LooseProvenance) =>
  validatePnpmProvenance(input as unknown as PnpmProvenance);
const probeOf = (input: LooseProvenance, id: string): LooseProbe =>
  input.presentTenseProbes.find((probe) => probe.probeId === id)!;

describe("D077 artifact hash contract (fail-closed)", () => {
  it("every named artifact exists", () => {
    for (const { file } of ARTIFACTS) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
    }
  });

  it("every embedded hash declares sha256 + a basis and independently recomputes", () => {
    for (const { file, hashField } of ARTIFACTS) {
      const parsed = mustLoadJson(file);
      const { [hashField]: embedded, hashAlgorithm, hashBasis, ...rest } = parsed;
      expect(embedded, `${file} missing ${hashField}`).toBeTruthy();
      expect(hashAlgorithm, file).toBe("sha256");
      expect(typeof hashBasis, file).toBe("string");
      expect(String(hashBasis)).toContain("JSON.stringify");
      expect(sha256Utf8(JSON.stringify(rest, null, 1)), file).toBe(embedded);
    }
  });

  it("the manifest excludes its own path and matches the release packet's expected final tree", () => {
    const manifestPath = `${GEN}/d077-release-candidate-manifest-2026-08-30.json`;
    const manifest = mustLoadJson(manifestPath) as unknown as {
      entries: Array<{ path: string; class: string }>;
      classCounts: Record<string, number>;
      pinnedNonSelfFileCount: number;
      expandedOnDiskCandidateFileCountIncludingSelf: number;
    };
    expect(Array.isArray(manifest.entries)).toBe(true);
    expect(
      manifest.entries.some((entry) => entry.path === manifestPath),
    ).toBe(false);
    expect(manifest.entries).toHaveLength(manifest.pinnedNonSelfFileCount);
    expect(manifest.expandedOnDiskCandidateFileCountIncludingSelf).toBe(
      manifest.pinnedNonSelfFileCount + 1,
    );
    const derived: Record<string, number> = {};
    for (const entry of manifest.entries)
      derived[entry.class] = (derived[entry.class] ?? 0) + 1;
    expect(derived).toEqual(manifest.classCounts);

    const packet = mustLoadJson(
      `${GEN}/d077-release-deploy-approval-packet-2026-08-30.json`,
    ) as unknown as {
      sourceTree: {
        manifestReference: {
          expectedFinalTree: {
            pinnedNonSelfFileCount: number;
            classCounts: Record<string, number>;
          };
        };
      };
    };
    const expected = packet.sourceTree.manifestReference.expectedFinalTree;
    expect(expected, "release packet lacks expectedFinalTree").toBeTruthy();
    expect(expected.pinnedNonSelfFileCount).toBe(
      manifest.pinnedNonSelfFileCount,
    );
    expect(expected.classCounts).toEqual(manifest.classCounts);
  });

  it("every non-deleted manifest entry's pinned sha256 matches the CURRENT file on disk, byte-for-byte — not just internal consistency", () => {
    // The prior test proves the manifest's own hash is self-consistent and
    // that its SHAPE (counts, classes) agrees with the approval packet. It
    // does not prove that any single entries[] sha256 still matches what is
    // actually on disk right now — a manifest can be frozen-internally-
    // consistent while every entry silently describes a tree that no longer
    // exists. This is the gap: entries[] was never independently re-hashed
    // against live disk content by any test until this one. Every
    // non-deleted entry is read and re-hashed here; every deleted entry is
    // checked for a null hash AND absence from disk.
    const manifestPath = `${GEN}/d077-release-candidate-manifest-2026-08-30.json`;
    const manifest = mustLoadJson(manifestPath) as unknown as {
      entries: Array<{ path: string; git: string; sha256: string | null }>;
    };
    expect(manifest.entries.length).toBeGreaterThan(0);

    const mismatches: string[] = [];
    const missingOnDisk: string[] = [];
    const wronglyPresent: string[] = [];
    const malformedHashField: string[] = [];

    for (const entry of manifest.entries) {
      const full = join(ROOT, entry.path);
      const onDisk = existsSync(full);

      if (entry.git === "D") {
        if (entry.sha256 !== null) malformedHashField.push(entry.path);
        if (onDisk) wronglyPresent.push(entry.path);
        continue;
      }

      if (!onDisk) {
        missingOnDisk.push(entry.path);
        continue;
      }
      if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        malformedHashField.push(entry.path);
        continue;
      }
      const actual = createHash("sha256").update(readFileSync(full)).digest("hex");
      if (actual !== entry.sha256) mismatches.push(entry.path);
    }

    expect(missingOnDisk, `entries claimed present but missing from disk: ${missingOnDisk.join(", ")}`).toEqual([]);
    expect(wronglyPresent, `entries claimed deleted but still exist on disk: ${wronglyPresent.join(", ")}`).toEqual([]);
    expect(
      malformedHashField,
      `entries with a malformed or contradictory hash field: ${malformedHashField.join(", ")}`,
    ).toEqual([]);
    expect(mismatches, `entries whose pinned sha256 no longer matches disk: ${mismatches.join(", ")}`).toEqual([]);
  });

  it("the manifest exactly covers the cumulative release diff plus untracked files", () => {
    // Guards the OTHER direction of staleness: not just "what's pinned still
    // matches disk" but "nothing changed or added is silently absent from
    // the pin set" — exactly the gap that let a new test file
    // (budget-preparation-form-interaction.test.tsx) go unpinned. Nothing
    // here is satisfiable by the manifest's own frozen internal agreement
    // with itself; it is checked against `git` on the live tree.
    const manifestPath = `${GEN}/d077-release-candidate-manifest-2026-08-30.json`;
    const manifest = mustLoadJson(manifestPath) as unknown as {
      baseMain: string;
      entries: Array<{ path: string }>;
    };
    const pinned = new Set(manifest.entries.map((entry) => entry.path));
    expect(manifest.baseMain).toMatch(/^[0-9a-f]{40}$/);
    const releaseDiff = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", manifest.baseMain, "--"],
      { cwd: ROOT, encoding: "utf8" },
    ).split("\0").filter(Boolean);
    const untracked = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: ROOT, encoding: "utf8" },
    ).split("\0").filter(Boolean);
    const candidate = new Set(
      [...releaseDiff, ...untracked].filter((path) => path !== manifestPath),
    );

    const missing = [...candidate].filter((path) => !pinned.has(path));
    const extra = [...pinned].filter((path) => !candidate.has(path));
    expect(missing, `changed/new files absent from the manifest: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `manifest paths outside the release diff: ${extra.join(", ")}`).toEqual([]);
  });

  it("runtimeVersions carries the complete version set and a VALID canonical pnpm provenance contract", () => {
    const ledger = mustLoadJson(
      `${GEN}/d077-correction1-verification-ledger-2026-08-30.json`,
    ) as unknown as {
      runtimeVersions: Record<string, unknown> & {
        pnpmProvenance?: PnpmProvenance;
      };
    };
    expect(ledger.runtimeVersions, "ledger lacks runtimeVersions").toBeTruthy();
    for (const key of ["node", "npm", "pnpm", "vitest", "postgres", "tsc"]) {
      const value = ledger.runtimeVersions[key];
      expect(typeof value, key).toBe("string");
      expect(String(value).trim().length, key).toBeGreaterThan(0);
    }
    const provenance = ledger.runtimeVersions.pnpmProvenance;
    if (!provenance) {
      throw new Error("structured pnpmProvenance is REQUIRED — fail-closed");
    }
    // The shared fail-closed contract re-derives every probe canonically
    // and binds this frozen audit package's exact outcomes.
    validatePnpmProvenance(provenance);
    // Exact structured facts (never substring-tested prose):
    expect(provenance.correction5ProhibitedMutationCommandExecuted).toBe(false);
    expect(provenance.correction3CorepackMutation.occurred).toBe(true);
    expect(provenance.correction3CorepackMutation.restored).toBe(false);
    expect(provenance.earlierRetainedStagesRuntime).toBe("UNKNOWN");
    expect(provenance.globalHostStateClaim).toBe("attestation_only");
    expect(["true", "false", "unknown"]).toContain(
      provenance.corepackTrackedStateChanged,
    );
    const retained = provenance.presentTenseProbes.find(
      (probe) => probe.probeId === "corepack-pnpm-retained-c4",
    )!;
    expect(retained.observationKind).toBe("retained");
    expect(retained.cacheSafeReadOnly).toBe("not_rerun");
    expect(retained).toEqual(RETAINED_C4_PROBE);
  });

  it("the provenance contract rejects contradictory fixtures", () => {
    const base = loadProvenance();
    const clone = () => cloneProvenance(base);

    // Unresolved probe carrying a resolved path.
    const contradictory = clone();
    contradictory.presentTenseProbes[0]!.resolution = "unresolved";
    contradictory.presentTenseProbes[0]!.resolvedPath = "/usr/bin/pnpm";
    expect(() => validateLoose(contradictory)).toThrow(/resolvedPath null/);

    // Resolved probe with no absolute path.
    const noPath = clone();
    const resolved = noPath.presentTenseProbes.find((probe) => probe.resolution === "resolved")!;
    resolved.resolvedPath = null;
    expect(() => validateLoose(noPath)).toThrow(/absolute resolvedPath/);

    // Duplicate probe ids.
    const duplicated = clone();
    duplicated.presentTenseProbes.push(duplicated.presentTenseProbes[0]!);
    expect(() => validateLoose(duplicated)).toThrow(/duplicate|extra/);

    // Missing required probe.
    const missing = clone();
    missing.presentTenseProbes = missing.presentTenseProbes.filter(
      (probe) => probe.probeId !== "codex-fallback-pnpm",
    );
    expect(() => validateLoose(missing)).toThrow(/missing required probe/);

    // Prohibited-mutation boolean flipped.
    const mutated = clone();
    mutated.correction5ProhibitedMutationCommandExecuted = true;
    expect(() => validateLoose(mutated)).toThrow(/must be false/);

    // Retained observation smuggling a live step object.
    const freshRetained = clone();
    const retainedProbe = probeOf(freshRetained, "corepack-pnpm-retained-c4");
    retainedProbe.directExecutionStep = JSON.parse(
      JSON.stringify(
        freshRetained.presentTenseProbes.find(
          (probe) => probe.directExecutionStep,
        )!.directExecutionStep,
      ),
    ) as MutableStep;
    expect(() => validateLoose(freshRetained)).toThrow(
      /no live step objects|must carry EXACTLY|non-resolved probe/,
    );
  });

  it("correction-6 would-have-failed matrix: every previously-accepted material contradiction is now rejected", () => {
    const base = loadProvenance();
    const clone = () => cloneProvenance(base);

    // 1. version_reported while UNRESOLVED with a null path (accepted by
    // the correction-5 validator).
    const vrUnresolved = clone();
    const live1 = probeOf(vrUnresolved, "codex-fallback-pnpm");
    live1.resultClass = "version_reported";
    live1.resolution = "unresolved";
    live1.resolvedPath = null;
    expect(() => validateLoose(vrUnresolved)).toThrow(
      /version_reported requires|non-resolved probe must not carry|non-empty absolute resolvedPath/,
    );

    // 2. Top-level changed="false" while scoped changed="true" (mtimes made
    // consistent with the scoped flag so only the agreement rule fires).
    const disagree = clone();
    disagree.corepackScopedInspection.inspectedPaths[0]!.afterMtime =
      "2026-08-30T23:59:59.000Z";
    disagree.corepackScopedInspection.changed = "true";
    disagree.corepackTrackedStateChanged = "false";
    expect(() => validateLoose(disagree)).toThrow(
      /must equal corepackScopedInspection.changed/,
    );

    // 3. Differing non-null before/after mtimes while BOTH flags say
    // "false" — the derived tri-state overrules the serialized flags.
    const drifted = clone();
    drifted.corepackScopedInspection.inspectedPaths[0]!.beforeMtime =
      "2026-08-30T10:00:00.000Z";
    drifted.corepackScopedInspection.inspectedPaths[0]!.afterMtime =
      "2026-08-30T11:00:00.000Z";
    drifted.corepackScopedInspection.changed = "false";
    drifted.corepackTrackedStateChanged = "false";
    expect(() => validateLoose(drifted)).toThrow(
      /contradicts the value derived/,
    );

    // 4. Invalid / non-ISO present-tense timestamp.
    const badTime = clone();
    probeOf(badTime, "codex-fallback-pnpm").observedAtUtc =
      "2026-08-30T18:00Z (window)";
    expect(() => validateLoose(badTime)).toThrow(
      /strict calendar-valid ISO-8601|strict ISO-8601/,
    );

    // 5. Retained C4 with an INVENTED timestamp.
    const inventedTime = clone();
    const retained5 = probeOf(inventedTime, "corepack-pnpm-retained-c4");
    retained5.observedAtUtc = "2026-08-30T18:00:00.000Z";
    retained5.observationTimeCertainty = "exact";
    expect(() => validateLoose(inventedTime)).toThrow(
      /corepack-pnpm-retained-c4 must carry EXACTLY/,
    );

    // 6. Retained C4 with an INVENTED resolved path.
    const inventedPath = clone();
    const retained6 = probeOf(inventedPath, "corepack-pnpm-retained-c4");
    retained6.resolution = "resolved";
    retained6.resolvedPath = "/usr/local/lib/node_modules/corepack/shims/pnpm";
    expect(() => validateLoose(inventedPath)).toThrow(
      /corepack-pnpm-retained-c4/,
    );

    // 7. New-schema contradictions introduced by the fix itself:
    // a live probe claiming 'unmeasured'…
    const liveUnmeasured = clone();
    const live7 = probeOf(liveUnmeasured, "codex-fallback-pnpm");
    live7.resolution = "unmeasured";
    live7.resolvedPath = null;
    expect(() => validateLoose(liveUnmeasured)).toThrow(
      /'unmeasured' is only for retained|may not claim 'unmeasured'|non-resolved probe must not carry/,
    );
    // …a concrete timestamp with certainty 'unknown'…
    const certaintyMismatch = clone();
    probeOf(certaintyMismatch, "codex-fallback-pnpm").observationTimeCertainty = "unknown";
    expect(() => validateLoose(certaintyMismatch)).toThrow(
      /requires time certainty 'exact'/,
    );
    // …and a null time on a present-tense probe.
    const nullPresent = clone();
    const live8 = probeOf(nullPresent, "codex-fallback-pnpm");
    live8.observedAtUtc = null;
    live8.observationTimeCertainty = "unknown";
    expect(() => validateLoose(nullPresent)).toThrow(
      /null observedAtUtc requires a retained observation|present-tense observations require/,
    );
  });

  it("the portable-path rule rejects absolute and traversal paths (clean-checkout regression)", () => {
    expect(assertPortableRepoRelativePath("docs/audits/generated/x.log")).toBe(
      "docs/audits/generated/x.log",
    );
    const sessionAbsolute =
      "/private" + "/tmp/claude-501/some-session/scratchpad/d077/whole-shell.log";
    expect(() => assertPortableRepoRelativePath(sessionAbsolute)).toThrow(/absolute/);
    expect(() => assertPortableRepoRelativePath("/etc/passwd")).toThrow(/absolute/);
    expect(() => assertPortableRepoRelativePath("../outside/x.log")).toThrow(/traversal/);
    expect(() => assertPortableRepoRelativePath("docs/../../x.log")).toThrow(/traversal/);
  });

  it("no executable D077 source depends on the Claude session scratch path (static census)", () => {
    const needle = "/private" + "/tmp/claude-501";
    const executableSources = [
      "lib/meta/__tests__/d077-artifact-hash-contract.test.ts",
      "scripts/audits/d077-whole-shell-proof.ts",
      "scripts/audits/d077-provenance-contract.ts",
      "scripts/audits/d077-correction1-artifact-generator.ts",
      "scripts/audits/d077-production-recovery-readonly-preflight.ts",
    ];
    for (const source of executableSources) {
      expect(
        readFileSync(join(ROOT, source), "utf8").includes(needle),
        `${source} must not reference the session scratch path`,
      ).toBe(false);
    }
    // In the ledger, the scratch path may appear ONLY as attributed
    // provenance — never as the runtime logFile path.
    const ledger = mustLoadJson(
      `${GEN}/d077-correction1-verification-ledger-2026-08-30.json`,
    ) as unknown as {
      stages: Array<{ stage: string; logFile?: { path: string } }>;
    };
    const shell = ledger.stages.find(
      (stage) => stage.stage === "canonical.database-seams-whole-shell",
    );
    if (!shell?.logFile) throw new Error("whole-shell logFile missing");
    expect(shell.logFile.path.includes(needle)).toBe(false);
    assertPortableRepoRelativePath(shell.logFile.path);
  });

  it("the whole-shell stage exists, carries not-applicable counts, and its embedded proof deep-equals a FRESH recomputation from the retained log + CURRENT seam script", () => {
    const ledger = mustLoadJson(
      `${GEN}/d077-correction1-verification-ledger-2026-08-30.json`,
    ) as unknown as {
      stages: Array<{
        stage: string;
        counts: Record<string, unknown>;
        logFile?: { path: string; sha256: string; bytes: number };
        wholeShellProof?: Record<string, unknown>;
      }>;
    };
    const shell = ledger.stages.find(
      (stage) => stage.stage === "canonical.database-seams-whole-shell",
    );
    if (!shell) {
      throw new Error(
        "the canonical whole-shell stage is MISSING from the ledger — fail-closed",
      );
    }
    expect(shell.counts.notApplicable, "counts must be not-applicable").toBe(true);
    expect(String(shell.counts.reason)).toContain("composite shell");
    if (!shell.logFile?.path) {
      throw new Error("whole-shell stage lacks its retained logFile record");
    }
    // Correction 5: the log path must be repository-relative and
    // traversal-free (clean-checkout portable); it resolves under ROOT.
    assertPortableRepoRelativePath(shell.logFile.path);
    const portableLogPath = join(ROOT, shell.logFile.path);
    if (!existsSync(portableLogPath)) {
      throw new Error(
        `portable whole-shell log is MISSING at ${shell.logFile.path} — fail-closed`,
      );
    }
    // The portable log must be manifest-pinned with the exact same SHA.
    const manifest = mustLoadJson(
      `${GEN}/d077-release-candidate-manifest-2026-08-30.json`,
    ) as unknown as { entries: Array<{ path: string; sha256: string | null }> };
    const pinned = manifest.entries.find(
      (entry) => entry.path === shell.logFile!.path,
    );
    if (!pinned) {
      throw new Error(
        "the portable whole-shell log is NOT pinned in the manifest — fail-closed",
      );
    }
    expect(pinned.sha256).toBe(shell.logFile.sha256);
    const seamScriptPath = join(ROOT, "scripts/verify-database-seams.sh");
    if (!existsSync(seamScriptPath)) {
      throw new Error("scripts/verify-database-seams.sh is MISSING — fail-closed");
    }
    if (!shell.wholeShellProof) {
      throw new Error("whole-shell stage lacks its embedded proof — fail-closed");
    }
    // FRESH recomputation against the CURRENT seam script; a drifted source
    // header, altered log, or stale embedded proof all fail here.
    const recomputed = buildWholeShellProof({
      logText: readFileSync(portableLogPath, "utf8"),
      expectedLogSha256: shell.logFile.sha256,
      expectedLogBytes: shell.logFile.bytes,
      seamScriptText: readFileSync(seamScriptPath, "utf8"),
    });
    expect(JSON.parse(JSON.stringify(recomputed))).toEqual(
      shell.wholeShellProof,
    );
    /*
      Pinned invariants of the retained run itself.

      RELEASE CANDIDATE — repinned to the 2026-09-06 14:43Z capture. These are
      the bytes `bash scripts/verify-database-seams.sh` produced on THIS
      release's delivered tree (exit 0, 504 s, 40 stages).

      Why a repin was required even though the header count did not move.
      `buildWholeShellProof` compares the ordered stage HEADINGS against the
      current script; it deliberately does not bind the child PROGRAMS those
      headings invoke. So an identical 40-header sequence proves the shape of
      the script, not that this release's stages ran. The 2026-09-03 capture
      predates the claim-race seam's capability repair, and it never executed
      the newly registered `direct-launch-standing-boundary` child at all,
      because that registration did not exist when it ran. Reusing it would
      have been a pin without a run — exactly what the 2026-08-30 -> 2026-09-03
      repin was made to avoid.

      The same reasoning forced a SECOND repin within 2026-09-06. The 07:59Z
      capture was canonical at the Phase 1 checkpoint; preparing the PR then
      registered `bid-history-writes-journal.db.test.ts` (five of its six cases
      had been seam-gated while registered in no runner, so they ran nowhere)
      and made `runChildVitest` refuse a skipped or short child. Those change
      what the stage EXECUTES while leaving all 40 headings identical — the
      exact blind spot above — so the 07:59Z log cannot speak for this tree
      either. It is retained as the evidence of its own run.

      The 2026-08-30 (38-stage) and 2026-09-03 (40-stage) logs are likewise
      retained and not relabelled. This log is frozen at
      `docs/audits/generated/d077-canonical-database-seams-whole-shell-2026-09-06T1443Z.log`
      and pinned with this same digest in the release-candidate manifest, which
      the assertion above checks — so these three cannot drift apart.
    */
    expect(recomputed.logSha256).toBe(
      "b1adadcaac835d7b6ebee190ca24fa74bfa3b7299b048508b4f3606190a342fd",
    );
    expect(recomputed.logBytes).toBe(661045);
    /*
      PRE-DEPLOY AUDIT — 38 -> 40, from a REGENERATED run. The two stages added
      are the D088 migration seam and the automation-OFF readback. The ledger,
      the retained log and these pins all come from one fresh execution of
      `bash scripts/verify-database-seams.sh` on the final tree; none of them
      was edited to agree with the others.
    */
    expect(recomputed.stageHeaderCount).toBe(40);
    expect(recomputed.finalPassLine).toBe("[verify-db-seams] PASS — 40 stages");
    // The release-owner guard runs LAST, and LAST is now 40.
    expect(recomputed.releaseOwnerLast.number).toBe(40);
  });

  it("the whole-shell proof builder rejects every deterministic mutation of its contract", () => {
    const mkLog = (input: {
      headers?: string[];
      finalLine?: string;
      boundary?: string;
    }) => {
      const headers = input.headers ?? [
        "[verify-db-seams] ── 01 Alpha",
        "[verify-db-seams] ── 02 Ordinary deploy refuses a cutover-required release",
        "[verify-db-seams] ── 03 Release owner references are current (LAST)",
      ];
      const boundary =
        input.boundary ??
        "no cutover pending: deploy/CUTOVER_REQUIRED absent\n[deploy-gate-ordering] PASS all checks";
      const parts = [
        headers[0],
        "ok",
        headers[1],
        boundary,
        ...headers.slice(2),
        input.finalLine ?? "[verify-db-seams] PASS — 3 stages",
      ];
      return parts.join("\n") + "\n";
    };
    const script = ['stage "Alpha"', 'stage "Ordinary deploy refuses a cutover-required release"', 'stage "Release owner references are current (LAST)"', ''].join("\n");
    const good = mkLog({});
    const base = { seamScriptText: script, expectedStageCount: 3 };
    const withSums = (log: string) => ({
      ...base,
      logText: log,
      expectedLogSha256: createHash("sha256").update(log, "utf8").digest("hex"),
      expectedLogBytes: Buffer.byteLength(log, "utf8"),
    });
    const proof = buildWholeShellProof(withSums(good));
    expect(proof.sequenceValid).toBe(true);
    expect(proof.releaseOwnerLast.number).toBe(3);

    expect(() =>
      buildWholeShellProof({ ...withSums(good), expectedLogSha256: "0".repeat(64) }),
    ).toThrow(/sha256/);
    expect(() =>
      buildWholeShellProof({ ...withSums(good), expectedLogBytes: 1 }),
    ).toThrow(/bytes/);
    expect(() =>
      buildWholeShellProof(
        withSums(mkLog({ headers: [
          "[verify-db-seams] ── 01 Alpha",
          "[verify-db-seams] ── 03 Release owner references are current (LAST)",
        ] })),
      ),
    ).toThrow(/stage headers found|sequence/);
    expect(() =>
      buildWholeShellProof(
        withSums(mkLog({ headers: [
          "[verify-db-seams] ── 01 Alpha",
          "[verify-db-seams] ── 01 Alpha",
          "[verify-db-seams] ── 03 Release owner references are current (LAST)",
        ] })),
      ),
    ).toThrow(/sequence/);
    expect(() =>
      buildWholeShellProof(
        withSums(mkLog({ headers: [
          "[verify-db-seams] ── 01 AlphaRenamed",
          "[verify-db-seams] ── 02 Ordinary deploy refuses a cutover-required release",
          "[verify-db-seams] ── 03 Release owner references are current (LAST)",
        ] })),
      ),
    ).toThrow(/title mismatch/);
    expect(() =>
      buildWholeShellProof(withSums(mkLog({ finalLine: "[verify-db-seams] PASS — 2 stages" }))),
    ).toThrow(/final line/);
    const swapped = mkLog({ headers: [
      "[verify-db-seams] ── 01 Release owner references are current (LAST)",
      "[verify-db-seams] ── 02 Ordinary deploy refuses a cutover-required release",
      "[verify-db-seams] ── 03 Alpha",
    ] });
    const swappedScript = ['stage "Release owner references are current (LAST)"', 'stage "Ordinary deploy refuses a cutover-required release"', 'stage "Alpha"', ''].join("\n");
    expect(() =>
      buildWholeShellProof({ ...withSums(swapped), seamScriptText: swappedScript }),
    ).toThrow(/release-owner/);
    expect(() =>
      buildWholeShellProof(withSums(mkLog({ boundary: "nothing here" }))),
    ).toThrow(/marker|deploy-gate/);
  });

  it("a drifted MIDDLE source header is rejected by recomputation even while the STALE stored digest fields still agree with each other", () => {
    const mkLog = () =>
      [
        "[verify-db-seams] ── 01 Alpha",
        "ok",
        "[verify-db-seams] ── 02 Ordinary deploy refuses a cutover-required release",
        "no cutover pending: deploy/CUTOVER_REQUIRED absent",
        "[deploy-gate-ordering] PASS all checks",
        "[verify-db-seams] ── 03 Release owner references are current (LAST)",
        "[verify-db-seams] PASS — 3 stages",
        "",
      ].join("\n");
    const originalScript = ['stage "Alpha"', 'stage "Ordinary deploy refuses a cutover-required release"', 'stage "Release owner references are current (LAST)"', ''].join("\n");
    const log = mkLog();
    const args = {
      logText: log,
      expectedLogSha256: createHash("sha256").update(log, "utf8").digest("hex"),
      expectedLogBytes: Buffer.byteLength(log, "utf8"),
      expectedStageCount: 3,
    };
    const staleProof = buildWholeShellProof({ ...args, seamScriptText: originalScript });
    // The stale STORED digest fields agree with each other — comparing them
    // alone would pass forever.
    expect(staleProof.headerDigestFromLog).toBe(staleProof.headerDigestFromScript);
    // But the CURRENT source drifted (middle header renamed): fresh
    // recomputation — what the guard actually does — refuses.
    const driftedScript = ['stage "Alpha"', 'stage "Ordinary deploy refuses a cutover-required release (RENAMED)"', 'stage "Release owner references are current (LAST)"', ''].join("\n");
    expect(() =>
      buildWholeShellProof({ ...args, seamScriptText: driftedScript }),
    ).toThrow(/title mismatch/);
  });

  it("the DB packet's privilege provenance equals the frozen evidence transaction", () => {
    const evidence = mustLoadJson(
      `${GEN}/d077-production-recovery-readonly-evidence-2026-08-30.json`,
    ) as unknown as {
      payload: {
        transactionProofs: {
          retrieved_at: string;
          application_name: string;
          transaction_read_only: string;
          transaction_isolation: string;
        };
      };
    };
    const packet = mustLoadJson(
      `${GEN}/d077-database-recovery-approval-packet-2026-08-30.json`,
    ) as unknown as {
      privilegeFacts: {
        provenance?: {
          retrievedAt: string;
          applicationName: string;
          transactionReadOnly: string;
          transactionIsolation: string;
        };
        verifiedAtUtc?: string;
      };
    };
    expect(packet.privilegeFacts, "packet lacks privilegeFacts").toBeTruthy();
    expect(packet.privilegeFacts.verifiedAtUtc).toBeUndefined();
    const provenance = packet.privilegeFacts.provenance;
    if (!provenance) {
      throw new Error("DB packet lacks privilegeFacts.provenance — fail-closed");
    }
    const proofs = evidence.payload.transactionProofs;
    expect(proofs, "evidence lacks transactionProofs").toBeTruthy();
    expect(provenance.retrievedAt).toBe(proofs.retrieved_at);
    expect(provenance.applicationName).toBe(proofs.application_name);
    expect(provenance.transactionReadOnly).toBe("on");
    expect(provenance.transactionIsolation).toBe("repeatable read");
  });

  it("correction-7 would-have-failed matrix: every correction-6 validator bypass is rejected", () => {
    const base = loadProvenance();
    const clone = () => cloneProvenance(base);

    // 1. Calendar-impossible timestamp (Date.parse would normalize it).
    expect(isStrictIsoUtc("2026-02-31T12:00:00Z")).toBe(false);
    expect(isStrictIsoUtc("2026-08-30T14:30:32.384Z")).toBe(true);
    const impossible = clone();
    probeOf(impossible, "codex-fallback-pnpm").observedAtUtc =
      "2026-02-31T12:00:00Z";
    expect(() => validateLoose(impossible)).toThrow(
      /calendar-valid/,
    );

    // 2. not_found while the resolver actually SUCCEEDED (exit 0 + path).
    const contradictoryNotFound = clone();
    const shell = probeOf(contradictoryNotFound, "claude-shell-pnpm");
    shell.resultClass = "not_found";
    shell.resolution = "unresolved";
    shell.resolvedPath = null;
    shell.directExecutionStep = null;
    shell.reportedVersion = null;
    shell.resolutionStep!.exitStatus = 0;
    shell.resolutionStep!.stdout = "/usr/local/bin/pnpm\n";
    shell.resolutionStep!.spawnErrorCode = null;
    expect(() => validateLoose(contradictoryNotFound)).toThrow(
      /contradicts a successful resolver/,
    );

    // 3. Invented command/mechanism/path/version under an exact live ID
    // (the step stays internally coherent — the exact-path binding fires).
    const invented = clone();
    const fake = probeOf(invented, "codex-fallback-pnpm");
    fake.resolvedPath = "/tmp/fake-pnpm";
    fake.directExecutionStep!.executable = "/tmp/fake-pnpm";
    fake.directExecutionStep!.commandForm = "/tmp/fake-pnpm --version";
    expect(() => validateLoose(invented)).toThrow(
      /exactly the frozen fallback path/,
    );
    const inventedResolver = clone();
    const badResolverStep = probeOf(inventedResolver, "claude-shell-pnpm").resolutionStep!;
    badResolverStep.argv = ["-lc", "which pnpm"];
    badResolverStep.commandForm = "bash -lc which pnpm";
    expect(() => validateLoose(inventedResolver)).toThrow(
      /exactly bash -lc 'command -v pnpm'/,
    );

    // 4. Retained C4 invented mechanism / command / version.
    for (const mutate of [
      (probe: LooseProbe) => {
        probe.resolutionMechanism = "measured via corepack shim just now";
      },
      (probe: LooseProbe) => {
        probe.command = "corepack pnpm -v";
      },
      (probe: LooseProbe) => {
        probe.reportedVersion = "11.19.0";
      },
    ]) {
      const mutatedRetained = clone();
      mutate(probeOf(mutatedRetained, "corepack-pnpm-retained-c4"));
      expect(() => validateLoose(mutatedRetained)).toThrow(
        /must carry EXACTLY/,
      );
    }

    // 5. Arbitrary / duplicate / extra inspected paths + invalid mtimes.
    const arbitraryPath = clone();
    arbitraryPath.corepackScopedInspection.inspectedPaths[0]!.path =
      "/tmp/unrelated";
    expect(() => validateLoose(arbitraryPath)).toThrow(
      /missing the frozen tracked path/,
    );
    const duplicatePath = clone();
    duplicatePath.corepackScopedInspection.inspectedPaths[1] = JSON.parse(
      JSON.stringify(duplicatePath.corepackScopedInspection.inspectedPaths[0]),
    ) as { path: string; beforeMtime: string | null; afterMtime: string | null };
    expect(() => validateLoose(duplicatePath)).toThrow(
      /duplicate paths|missing the frozen/,
    );
    const extraPath = clone();
    extraPath.corepackScopedInspection.inspectedPaths.push({
      path: "/tmp/extra",
      beforeMtime: null,
      afterMtime: null,
    });
    expect(() => validateLoose(extraPath)).toThrow(
      /exactly the 2 frozen tracked paths/,
    );
    const badMtime = clone();
    badMtime.corepackScopedInspection.inspectedPaths[0]!.beforeMtime =
      "yesterday evening";
    expect(() => validateLoose(badMtime)).toThrow(
      /not a strict calendar-valid UTC instant/,
    );

    // 6. Mixed unknown+changed must derive "unknown" (unknown-dominant).
    expect(
      deriveScopedChange([
        { beforeMtime: null, afterMtime: "2026-08-30T10:00:00.000Z" },
        {
          beforeMtime: "2026-08-30T10:00:00.000Z",
          afterMtime: "2026-08-30T11:00:00.000Z",
        },
      ]),
    ).toBe("unknown");

    // 7. Mutation command that merely CONTAINS the expected substring.
    const substringMutation = clone();
    substringMutation.correction3CorepackMutation.command =
      "echo corepack prepare pnpm@latest --activate was not executed";
    expect(() => validateLoose(substringMutation)).toThrow(
      /must be exactly/,
    );

    // 8. Missing resolver step on a path_lookup probe.
    const missingResolver = clone();
    probeOf(missingResolver, "claude-shell-pnpm").resolutionStep = null;
    expect(() => validateLoose(missingResolver)).toThrow(
      /resolver must be exactly|requires the resolver measurement/,
    );

    // 9. Resolved probe missing its direct-execution step.
    const missingDirect = clone();
    const resolvedProbe = missingDirect.presentTenseProbes.find(
      (probe) => probe.resolution === "resolved",
    )!;
    resolvedProbe.directExecutionStep = null;
    expect(() => validateLoose(missingDirect)).toThrow(
      /requires the direct execution step|requires a successful direct execution/,
    );

    // 10. Resolved path vs executed binary disagreement (coherent step).
    const disagreement = clone();
    const resolved2 = disagreement.presentTenseProbes.find(
      (probe) => probe.resolution === "resolved" && probe.directExecutionStep,
    )!;
    resolved2.directExecutionStep!.executable = "/usr/bin/other-binary";
    resolved2.directExecutionStep!.commandForm = "/usr/bin/other-binary --version";
    expect(() => validateLoose(disagreement)).toThrow(
      /executed binary must be exactly the resolved path|frozen fallback path/,
    );
  });

  it("the pure two-step builders preserve BOTH measurements and enforce their branch contracts", () => {
    const okRaw: RawSpawnResult = {
      status: 0,
      signal: null,
      stdout: "/opt/somewhere/pnpm\n",
      stderr: "",
      errorCode: null,
      errorMessage: null,
    };
    const versionRaw: RawSpawnResult = {
      status: 0,
      signal: null,
      stdout: "9.9.9\n",
      stderr: "",
      errorCode: null,
      errorMessage: null,
    };
    const t1 = "2026-08-30T10:00:00.000Z";
    const t2 = "2026-08-30T10:00:01.000Z";

    // Successful resolution + execution: both steps preserved separately.
    const resolvedProbe = buildPathLookupProbe({
      probeId: "claude-shell-pnpm",
      lookupRaw: okRaw,
      lookupObservedAtUtc: t1,
      directRaw: versionRaw,
      directObservedAtUtc: t2,
    }) as PathLookupProbe;
    expect(resolvedProbe.resolution).toBe("resolved");
    expect(resolvedProbe.resolvedPath).toBe("/opt/somewhere/pnpm");
    expect(resolvedProbe.resolutionStep.exitStatus).toBe(0);
    expect(resolvedProbe.resolutionStep.stdout).toBe("/opt/somewhere/pnpm\n");
    expect(resolvedProbe.resolutionStep.observedAtUtc).toBe(t1);
    expect(resolvedProbe.resolutionStep.commandForm).toBe("bash -lc command -v pnpm");
    expect(resolvedProbe.directExecutionStep!.executable).toBe(
      "/opt/somewhere/pnpm",
    );
    expect(resolvedProbe.directExecutionStep!.argv).toEqual(["--version"]);
    expect(resolvedProbe.directExecutionStep!.observedAtUtc).toBe(t2);
    expect(resolvedProbe.reportedVersion).toBe("9.9.9");
    expect(resolvedProbe.resultClass).toBe("version_reported");
    expect(resolvedProbe.observedAtUtc).toBe(t2);

    // Ordinary not-found vs resolver spawn error stay distinguishable.
    const notFound = buildPathLookupProbe({
      probeId: "claude-shell-pnpm",
      lookupRaw: { ...okRaw, status: 1, stdout: "" },
      lookupObservedAtUtc: t1,
      directRaw: null,
      directObservedAtUtc: null,
    }) as PathLookupProbe;
    expect(notFound.resultClass).toBe("not_found");
    expect(notFound.resolutionStep.exitStatus).toBe(1);
    const resolverErr = buildPathLookupProbe({
      probeId: "claude-shell-pnpm",
      lookupRaw: {
        ...okRaw,
        status: null,
        stdout: "",
        errorCode: "ENOENT",
        errorMessage: "spawn bash ENOENT",
      },
      lookupObservedAtUtc: t1,
      directRaw: null,
      directObservedAtUtc: null,
    }) as PathLookupProbe;
    expect(resolverErr.resultClass).toBe("resolver_error");
    expect(resolverErr.resolutionStep.spawnErrorCode).toBe("ENOENT");

    // Branch contract: failed resolution may not carry a direct execution,
    // and successful resolution requires one.
    expect(() =>
      buildPathLookupProbe({
        probeId: "claude-shell-pnpm",
        lookupRaw: { ...okRaw, status: 1, stdout: "" },
        lookupObservedAtUtc: t1,
        directRaw: versionRaw,
        directObservedAtUtc: t2,
      }),
    ).toThrow(/must NOT carry a direct execution/);
    expect(() =>
      buildPathLookupProbe({
        probeId: "claude-shell-pnpm",
        lookupRaw: okRaw,
        lookupObservedAtUtc: t1,
        directRaw: null,
        directObservedAtUtc: null,
      }),
    ).toThrow(/requires the direct execution measurement/);
    expect(() =>
      buildExplicitPathProbe({
        probeId: "codex-fallback-pnpm",
        pathExists: false,
        existenceObservedAtUtc: t1,
        directRaw: versionRaw,
        directObservedAtUtc: t2,
      }),
    ).toThrow(/must NOT carry an invented execution/);
  });

  it("canonical transition matrix: every allowed path-lookup/explicit-path/retained outcome derives exactly, and every malformed measurement is refused", () => {
    const T1 = "2026-08-30T10:00:00.000Z";
    const T2 = "2026-08-30T10:00:01.000Z";
    const mkStep = (
      executable: string,
      argv: string[],
      over: Partial<ExecutedStep> = {},
    ): ExecutedStep => ({
      executable,
      argv: [...argv],
      commandForm: `${executable} ${argv.join(" ")}`.trim(),
      exitStatus: 0,
      signal: null,
      stdout: "",
      stderr: "",
      spawnErrorCode: null,
      spawnErrorMessage: null,
      observedAtUtc: T1,
      ...over,
    });
    const pnpmResolver = (over: Partial<ExecutedStep> = {}) =>
      mkStep("bash", ["-lc", "command -v pnpm"], over);
    const direct = (path: string, over: Partial<ExecutedStep> = {}) =>
      mkStep(path, ["--version"], { stdout: "9.9.9\n", observedAtUtc: T2, ...over });
    const mkObs = (over: Partial<ExistenceObservation> = {}): ExistenceObservation => ({
      path: CODEX_FALLBACK_PNPM_PATH,
      exists: true,
      observationErrorCode: null,
      observationErrorMessage: null,
      observedAtUtc: T1,
      ...over,
    });
    const lookup = (
      resolutionStep: ExecutedStep,
      directStep: ExecutedStep | null,
    ): ProbeMeasurement => ({
      kind: "path_lookup",
      probeId: "claude-shell-pnpm",
      resolutionStep,
      directExecutionStep: directStep,
    });
    const explicit = (
      obs: ExistenceObservation,
      directStep: ExecutedStep | null,
    ): ProbeMeasurement => ({
      kind: "explicit_path",
      probeId: "codex-fallback-pnpm",
      existenceObservation: obs,
      directExecutionStep: directStep,
    });

    // ── Allowed transitions: exact derived state per outcome. ─────────
    const okCases: Array<{
      name: string;
      core: ProbeMeasurement;
      expected: {
        resolution: string;
        resultClass: string;
        resolvedPath: string | null;
        reportedVersion: string | null;
        observedAtUtc: string;
      };
    }> = [
      {
        name: "lookup resolved → version_reported",
        core: lookup(pnpmResolver({ stdout: "/opt/p/pnpm\n" }), direct("/opt/p/pnpm")),
        expected: { resolution: "resolved", resultClass: "version_reported", resolvedPath: "/opt/p/pnpm", reportedVersion: "9.9.9", observedAtUtc: T2 },
      },
      {
        name: "lookup nonzero/empty → not_found",
        core: lookup(pnpmResolver({ exitStatus: 1 }), null),
        expected: { resolution: "unresolved", resultClass: "not_found", resolvedPath: null, reportedVersion: null, observedAtUtc: T1 },
      },
      {
        name: "lookup spawn error → resolver_error",
        core: lookup(pnpmResolver({ exitStatus: null, spawnErrorCode: "ENOENT", spawnErrorMessage: "spawn bash ENOENT" }), null),
        expected: { resolution: "unresolved", resultClass: "resolver_error", resolvedPath: null, reportedVersion: null, observedAtUtc: T1 },
      },
      {
        name: "lookup signaled → resolver_error",
        core: lookup(pnpmResolver({ exitStatus: null, signal: "SIGKILL" }), null),
        expected: { resolution: "unresolved", resultClass: "resolver_error", resolvedPath: null, reportedVersion: null, observedAtUtc: T1 },
      },
      {
        name: "direct nonzero exit → execution_error",
        core: lookup(pnpmResolver({ stdout: "/opt/p/pnpm\n" }), direct("/opt/p/pnpm", { exitStatus: 1, stdout: "" })),
        expected: { resolution: "resolved", resultClass: "execution_error", resolvedPath: "/opt/p/pnpm", reportedVersion: null, observedAtUtc: T2 },
      },
      {
        name: "direct signaled → execution_error",
        core: lookup(pnpmResolver({ stdout: "/opt/p/pnpm\n" }), direct("/opt/p/pnpm", { exitStatus: null, signal: "SIGSEGV", stdout: "" })),
        expected: { resolution: "resolved", resultClass: "execution_error", resolvedPath: "/opt/p/pnpm", reportedVersion: null, observedAtUtc: T2 },
      },
      {
        name: "direct spawn error → execution_error",
        core: lookup(pnpmResolver({ stdout: "/opt/p/pnpm\n" }), direct("/opt/p/pnpm", { exitStatus: null, stdout: "", spawnErrorCode: "EACCES", spawnErrorMessage: "permission denied" })),
        expected: { resolution: "resolved", resultClass: "execution_error", resolvedPath: "/opt/p/pnpm", reportedVersion: null, observedAtUtc: T2 },
      },
      {
        name: "direct exit 0 with non-version stdout → execution_error",
        core: lookup(pnpmResolver({ stdout: "/opt/p/pnpm\n" }), direct("/opt/p/pnpm", { stdout: "not a version\n" })),
        expected: { resolution: "resolved", resultClass: "execution_error", resolvedPath: "/opt/p/pnpm", reportedVersion: null, observedAtUtc: T2 },
      },
      {
        name: "direct exit 0 with noisy stderr → execution_error",
        core: lookup(pnpmResolver({ stdout: "/opt/p/pnpm\n" }), direct("/opt/p/pnpm", { stderr: "warning" })),
        expected: { resolution: "resolved", resultClass: "execution_error", resolvedPath: "/opt/p/pnpm", reportedVersion: null, observedAtUtc: T2 },
      },
      {
        name: "explicit exists → version_reported at frozen path",
        core: explicit(mkObs(), direct(CODEX_FALLBACK_PNPM_PATH)),
        expected: { resolution: "resolved", resultClass: "version_reported", resolvedPath: CODEX_FALLBACK_PNPM_PATH, reportedVersion: "9.9.9", observedAtUtc: T2 },
      },
      {
        name: "explicit absent → not_found",
        core: explicit(mkObs({ exists: false }), null),
        expected: { resolution: "unresolved", resultClass: "not_found", resolvedPath: null, reportedVersion: null, observedAtUtc: T1 },
      },
      {
        name: "explicit observation error → resolver_error (never reduced to absent)",
        core: explicit(mkObs({ exists: null, observationErrorCode: "EIO", observationErrorMessage: "io failure" }), null),
        expected: { resolution: "unresolved", resultClass: "resolver_error", resolvedPath: null, reportedVersion: null, observedAtUtc: T1 },
      },
      {
        name: "explicit exists + direct exit 2 → execution_error",
        core: explicit(mkObs(), direct(CODEX_FALLBACK_PNPM_PATH, { exitStatus: 2, stdout: "" })),
        expected: { resolution: "resolved", resultClass: "execution_error", resolvedPath: CODEX_FALLBACK_PNPM_PATH, reportedVersion: null, observedAtUtc: T2 },
      },
    ];
    for (const { name, core, expected } of okCases) {
      const probe = deriveCanonicalProbe(core);
      expect(probe.resolution, name).toBe(expected.resolution);
      expect(probe.resultClass, name).toBe(expected.resultClass);
      expect(probe.resolvedPath, name).toBe(expected.resolvedPath);
      expect(probe.reportedVersion, name).toBe(expected.reportedVersion);
      expect(probe.observedAtUtc, name).toBe(expected.observedAtUtc);
      expect(probe.observationKind, name).toBe("present_tense");
    }

    // Retained: the derivation returns EXACTLY the frozen constant.
    expect(
      deriveCanonicalProbe({ kind: "retained", probeId: "corepack-pnpm-retained-c4" }),
    ).toEqual(RETAINED_C4_PROBE);

    // ── Refused measurements/transitions. ─────────────────────────────
    const throwCases: Array<{ name: string; core: () => ProbeMeasurement; pattern: RegExp }> = [
      { name: "exit 0 + EMPTY stdout is refused, never not_found", core: () => lookup(pnpmResolver({ stdout: "" }), null), pattern: /INVALID measurement[\s\S]*never converted to not_found/ },
      { name: "exit 0 + relative path", core: () => lookup(pnpmResolver({ stdout: "opt/p/pnpm\n" }), null), pattern: /INVALID measurement/ },
      { name: "exit 0 + two newline-separated paths", core: () => lookup(pnpmResolver({ stdout: "/a/pnpm\n/b/pnpm\n" }), null), pattern: /INVALID measurement/ },
      { name: "exit 0 + internal whitespace", core: () => lookup(pnpmResolver({ stdout: "/a dir/pnpm\n" }), null), pattern: /INVALID measurement/ },
      { name: "exit 0 + NUL in path", core: () => lookup(pnpmResolver({ stdout: "/a/pnpm\u0000\n" }), null), pattern: /INVALID measurement/ },
      { name: "exit 0 + non-empty stderr", core: () => lookup(pnpmResolver({ stdout: "/a/pnpm\n", stderr: "noise" }), null), pattern: /INVALID measurement/ },
      { name: "nonzero exit + stdout content", core: () => lookup(pnpmResolver({ exitStatus: 1, stdout: "garbage" }), null), pattern: /INVALID measurement[\s\S]*never converted to not_found/ },
      { name: "nonzero exit + stderr content", core: () => lookup(pnpmResolver({ exitStatus: 1, stderr: "err" }), null), pattern: /INVALID measurement/ },
      { name: "wrong resolver argv", core: () => lookup(mkStep("bash", ["-lc", "which pnpm"], { exitStatus: 1 }), null), pattern: /resolver must be exactly bash -lc 'command -v pnpm'/ },
      { name: "wrong resolver executable", core: () => lookup(mkStep("sh", ["-lc", "command -v pnpm"], { exitStatus: 1 }), null), pattern: /resolver must be exactly/ },
      { name: "resolved but direct executable differs", core: () => lookup(pnpmResolver({ stdout: "/opt/p/pnpm\n" }), direct("/other/pnpm")), pattern: /executed binary must be exactly the resolved path/ },
      { name: "resolved but direct argv differs", core: () => lookup(pnpmResolver({ stdout: "/opt/p/pnpm\n" }), { ...direct("/opt/p/pnpm"), argv: ["-v"], commandForm: "/opt/p/pnpm -v" }), pattern: /argv must be exactly \['--version'\]/ },
      { name: "direct time precedes resolver time", core: () => lookup(pnpmResolver({ stdout: "/opt/p/pnpm\n", observedAtUtc: T2 }), direct("/opt/p/pnpm", { observedAtUtc: T1 })), pattern: /may not precede/ },
      { name: "resolved without a direct step", core: () => lookup(pnpmResolver({ stdout: "/opt/p/pnpm\n" }), null), pattern: /resolved requires the direct execution step/ },
      { name: "failed resolution smuggling a direct step", core: () => lookup(pnpmResolver({ exitStatus: 1 }), direct("/opt/p/pnpm")), pattern: /must NOT carry a direct execution/ },
      { name: "mixed tuple: exit status AND signal", core: () => lookup(pnpmResolver({ exitStatus: 1, signal: "SIGTERM" }), null), pattern: /incoherent measurement tuple/ },
      { name: "mixed tuple: all-null outcome", core: () => lookup(pnpmResolver({ exitStatus: null }), null), pattern: /not a coherent outcome/ },
      { name: "spawn error code without message", core: () => lookup(pnpmResolver({ exitStatus: null, spawnErrorCode: "ENOENT" }), null), pattern: /BOTH null or BOTH non-empty/ },
      { name: "spawn error message without code", core: () => lookup(pnpmResolver({ exitStatus: null, spawnErrorMessage: "boom" }), null), pattern: /BOTH null or BOTH non-empty/ },
      { name: "spawn error pair alongside an exit status", core: () => lookup(pnpmResolver({ exitStatus: 0, stdout: "/a/pnpm\n", spawnErrorCode: "E", spawnErrorMessage: "m" }), null), pattern: /incoherent measurement tuple/ },
      { name: "negative exit status", core: () => lookup(pnpmResolver({ exitStatus: -1 }), null), pattern: /non-negative integer/ },
      { name: "calendar-impossible step time", core: () => lookup(pnpmResolver({ exitStatus: 1, observedAtUtc: "2026-02-31T12:00:00Z" }), null), pattern: /calendar-valid/ },
      { name: "invented commandForm", core: () => lookup(pnpmResolver({ exitStatus: 1, commandForm: "bash -c something-else" }), null), pattern: /commandForm must render exactly/ },
      { name: "existence path differs from the frozen path", core: () => explicit(mkObs({ path: "/tmp/fake-pnpm" }), null), pattern: /exactly the frozen fallback path/ },
      { name: "boolean exists with an observation-error pair", core: () => explicit(mkObs({ observationErrorCode: "EIO", observationErrorMessage: "io" }), direct(CODEX_FALLBACK_PNPM_PATH)), pattern: /boolean exists must carry a null observation-error pair/ },
      { name: "errored existence observation without the pair", core: () => explicit(mkObs({ exists: null }), null), pattern: /errored existence observation/ },
      { name: "absent path smuggling a direct execution", core: () => explicit(mkObs({ exists: false }), direct(CODEX_FALLBACK_PNPM_PATH)), pattern: /must NOT carry an invented execution/ },
      { name: "errored observation smuggling a direct execution", core: () => explicit(mkObs({ exists: null, observationErrorCode: "EIO", observationErrorMessage: "io" }), direct(CODEX_FALLBACK_PNPM_PATH)), pattern: /must NOT carry an invented execution/ },
      { name: "exists=true without the direct measurement", core: () => explicit(mkObs(), null), pattern: /resolved requires the direct execution step/ },
      { name: "explicit direct executable differs from the frozen path", core: () => explicit(mkObs(), direct("/tmp/fake-pnpm")), pattern: /exactly the frozen fallback path/ },
      { name: "direct time precedes the existence observation", core: () => explicit(mkObs({ observedAtUtc: T2 }), direct(CODEX_FALLBACK_PNPM_PATH, { observedAtUtc: T1 })), pattern: /may not precede/ },
      { name: "kind/binding mismatch", core: () => ({ kind: "explicit_path", probeId: "claude-shell-pnpm", existenceObservation: mkObs(), directExecutionStep: null }), pattern: /resolutionKind must be path_lookup/ },
      { name: "unknown probe id", core: () => ({ kind: "path_lookup", probeId: "not-a-probe", resolutionStep: pnpmResolver({ exitStatus: 1 }), directExecutionStep: null }), pattern: /unknown probe id/ },
    ];
    for (const { name, core, pattern } of throwCases) {
      expect(() => deriveCanonicalProbe(core()), name).toThrow(pattern);
    }
  });

  it("correction-8 would-have-failed matrix: every correction-7 rejection mutation is refused", () => {
    const base = loadProvenance();
    const clone = () => cloneProvenance(base);

    // 1. not_found with resolver exit 0 and EMPTY stdout — refused as an
    // invalid measurement, never accepted as not_found.
    const exitZeroEmpty = clone();
    probeOf(exitZeroEmpty, "claude-shell-pnpm").resolutionStep!.exitStatus = 0;
    expect(() => validateLoose(exitZeroEmpty)).toThrow(
      /INVALID measurement[\s\S]*never converted to not_found/,
    );

    // 2. Invented live top-level command / resolutionMechanism.
    const inventedCommand = clone();
    probeOf(inventedCommand, "claude-shell-pnpm").command = "pnpm via my own resolver";
    expect(() => validateLoose(inventedCommand)).toThrow(
      /diverges from the canonical derivation/,
    );
    const inventedMechanism = clone();
    probeOf(inventedMechanism, "corepack-program-version").resolutionMechanism =
      "hand-written mechanism prose";
    expect(() => validateLoose(inventedMechanism)).toThrow(
      /diverges from the canonical derivation/,
    );

    // 3. Invented ExecutedStep.commandForm.
    const inventedForm = clone();
    probeOf(inventedForm, "claude-shell-pnpm").resolutionStep!.commandForm =
      "bash -c something-else";
    expect(() => validateLoose(inventedForm)).toThrow(
      /commandForm must render exactly/,
    );

    // 4. Resolved codex-fallback-pnpm with exists=false.
    const resolvedAbsent = clone();
    probeOf(resolvedAbsent, "codex-fallback-pnpm").existenceObservation!.exists = false;
    expect(() => validateLoose(resolvedAbsent)).toThrow(
      /must NOT carry an invented execution/,
    );

    // 5. execution_error despite a fully successful direct execution.
    const mislabelled = clone();
    const fallback5 = probeOf(mislabelled, "codex-fallback-pnpm");
    fallback5.resultClass = "execution_error";
    fallback5.reportedVersion = null;
    expect(() => validateLoose(mislabelled)).toThrow(
      /diverges from the canonical derivation/,
    );

    // 6. Arbitrary 99.99.99 under the exact fallback ID with stdout
    // changed to match — the probe is a VALID transition, but the frozen
    // audit package stops generation on a changed tool version.
    const fakeVersion = clone();
    const fallback6 = probeOf(fakeVersion, "codex-fallback-pnpm");
    fallback6.directExecutionStep!.stdout = "99.99.99\n";
    fallback6.reportedVersion = "99.99.99";
    expect(() => validateLoose(fakeVersion)).toThrow(
      /frozen audit package requires resultClass version_reported with reportedVersion exactly '11\.19\.0'/,
    );
    const fakeCorepackVersion = clone();
    const corepack6 = probeOf(fakeCorepackVersion, "corepack-program-version");
    corepack6.directExecutionStep!.stdout = "9.0.0\n";
    corepack6.reportedVersion = "9.0.0";
    expect(() => validateLoose(fakeCorepackVersion)).toThrow(
      /frozen audit package requires resultClass version_reported with reportedVersion exactly '0\.34\.2'/,
    );
    // …and the claude-shell frozen outcome is equally bound.
    const flippedShell = clone();
    const shell6 = probeOf(flippedShell, "claude-shell-pnpm");
    shell6.resolutionStep!.stdout = "/usr/local/bin/pnpm\n";
    shell6.resolutionStep!.exitStatus = 0;
    shell6.resolution = "resolved";
    shell6.resolvedPath = "/usr/local/bin/pnpm";
    shell6.resultClass = "version_reported";
    shell6.reportedVersion = "11.19.0";
    shell6.directExecutionStep = {
      executable: "/usr/local/bin/pnpm",
      argv: ["--version"],
      commandForm: "/usr/local/bin/pnpm --version",
      exitStatus: 0,
      signal: null,
      stdout: "11.19.0\n",
      stderr: "",
      spawnErrorCode: null,
      spawnErrorMessage: null,
      observedAtUtc: shell6.resolutionStep!.observedAtUtc,
    };
    expect(() => validateLoose(flippedShell)).toThrow(
      /diverges from the canonical derivation|frozen audit package binds the current faithfully measured outcome/,
    );

    // 7. Top-level observedAtUtc differing from the terminal step time.
    const topTime = clone();
    const fallback7 = probeOf(topTime, "codex-fallback-pnpm");
    fallback7.observedAtUtc = fallback7.existenceObservation!.observedAtUtc;
    expect(() => validateLoose(topTime)).toThrow(
      /diverges from the canonical derivation/,
    );

    // 8. A resolved path lookup whose resolver exited nonzero.
    const nonzeroResolved = clone();
    probeOf(nonzeroResolved, "corepack-program-version").resolutionStep!.exitStatus = 1;
    expect(() => validateLoose(nonzeroResolved)).toThrow(
      /INVALID measurement/,
    );

    // 9. Resolver stdout with two newline-separated absolute paths.
    const multiPath = clone();
    probeOf(multiPath, "corepack-program-version").resolutionStep!.stdout =
      "/usr/local/bin/corepack\n/opt/other/corepack\n";
    expect(() => validateLoose(multiPath)).toThrow(
      /INVALID measurement/,
    );

    // 10. Non-null spawnErrorMessage with null spawnErrorCode.
    const pairMismatch = clone();
    probeOf(pairMismatch, "claude-shell-pnpm").resolutionStep!.spawnErrorMessage = "boom";
    expect(() => validateLoose(pairMismatch)).toThrow(
      /BOTH null or BOTH non-empty/,
    );

    // 11. Retained C4 carrying extra legacy properties.
    const extraKeys = clone();
    (probeOf(extraKeys, "corepack-pnpm-retained-c4") as Record<string, unknown>).legacyStderr = "";
    expect(() => validateLoose(extraKeys)).toThrow(/must carry EXACTLY/);
    const legacyStepKeys = clone();
    (probeOf(legacyStepKeys, "corepack-pnpm-retained-c4") as Record<string, unknown>).resolutionStep = null;
    expect(() => validateLoose(legacyStepKeys)).toThrow(/must carry EXACTLY/);
  });

  it("property-style single-field mutation coverage: mutating, deleting, or adding any serialized field of the frozen provenance is refused", () => {
    const base = loadProvenance();
    // Baseline sanity: the untouched frozen provenance validates.
    validateLoose(cloneProvenance(base));

    type PathSeg = string | number;
    const leafPaths: PathSeg[][] = [];
    const objectPaths: PathSeg[][] = [];
    const walk = (value: unknown, path: PathSeg[]) => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, [...path, index]));
        return;
      }
      if (value !== null && typeof value === "object") {
        objectPaths.push(path);
        for (const key of Object.keys(value))
          walk((value as Record<string, unknown>)[key], [...path, key]);
        return;
      }
      leafPaths.push(path);
    };
    walk(base, []);
    expect(leafPaths.length).toBeGreaterThan(80);
    expect(objectPaths.length).toBeGreaterThan(10);

    const getAt = (root: unknown, path: PathSeg[]): unknown =>
      path.reduce<unknown>(
        (acc, seg) => (acc as Record<string, unknown>)[String(seg)],
        root,
      );
    const setAt = (root: unknown, path: PathSeg[], value: unknown): void => {
      const parent = getAt(root, path.slice(0, -1)) as Record<string, unknown>;
      parent[String(path[path.length - 1])] = value;
    };
    const deleteAt = (root: unknown, path: PathSeg[]): void => {
      const parent = getAt(root, path.slice(0, -1)) as Record<string, unknown>;
      delete parent[String(path[path.length - 1])];
    };
    // Sentinels chosen so no mutation lands on another ALLOWED transition
    // (allowed alternatives are covered by the transition-matrix fixtures,
    // which construct them through the canonical derivation instead).
    const mutantFor = (value: unknown): unknown => {
      if (typeof value === "string") return "__MUTATED__";
      if (typeof value === "number") return -7;
      if (typeof value === "boolean") return !value;
      if (value === null) return "__MUTATED__";
      throw new Error(`unexpected leaf type: ${typeof value}`);
    };

    const accepted: string[] = [];
    for (const path of leafPaths) {
      const fixture = cloneProvenance(base);
      setAt(fixture, path, mutantFor(getAt(fixture, path)));
      try {
        validateLoose(fixture);
        accepted.push(`mutate ${path.join(".")}`);
      } catch {
        // refused, as required
      }
    }
    for (const path of objectPaths) {
      const withForeign = cloneProvenance(base);
      (getAt(withForeign, path) as Record<string, unknown>).__unexpected__ = true;
      try {
        validateLoose(withForeign);
        accepted.push(`foreign-key ${path.join(".") || "$"}`);
      } catch {
        // refused, as required
      }
      for (const key of Object.keys(getAt(base, path) as object)) {
        const fixture = cloneProvenance(base);
        deleteAt(fixture, [...path, key]);
        try {
          validateLoose(fixture);
          accepted.push(`delete ${[...path, key].join(".")}`);
        } catch {
          // refused, as required
        }
      }
    }
    expect(accepted).toEqual([]);
  });

  it("ledger chronology: every exact present-tense observation precedes generatedAtUtc", () => {
    const ledger = mustLoadJson(
      `${GEN}/d077-correction1-verification-ledger-2026-08-30.json`,
    ) as unknown as {
      generatedAtUtc: string;
      runtimeVersions: { pnpmProvenance: { presentTenseProbes: LooseProbe[] } };
    };
    expect(isStrictIsoUtc(ledger.generatedAtUtc)).toBe(true);
    const generatedAt = Date.parse(ledger.generatedAtUtc);
    for (const probe of ledger.runtimeVersions.pnpmProvenance.presentTenseProbes) {
      for (const value of [
        probe.observedAtUtc,
        probe.resolutionStep?.observedAtUtc ?? null,
        probe.directExecutionStep?.observedAtUtc ?? null,
        probe.existenceObservation?.observedAtUtc ?? null,
      ]) {
        if (value === null) continue;
        expect(isStrictIsoUtc(value), `${probe.probeId} time`).toBe(true);
        expect(Date.parse(value), `${probe.probeId} <= generatedAtUtc`).toBeLessThanOrEqual(
          generatedAt,
        );
      }
    }
  });

  it("the evidence carries the pinned coverage checksum and the exact role A1b binds to", () => {
    const evidence = mustLoadJson(
      `${GEN}/d077-production-recovery-readonly-evidence-2026-08-30.json`,
    ) as unknown as {
      payload: {
        coverageChecksum: { value: string; pinnedIndependentValue: string; lineCount: number };
        extensions: {
          currentRoleCapabilities: {
            current_role?: string;
            current_role_sql_identifier?: string;
          };
        };
      };
    };
    const coverage = evidence.payload.coverageChecksum;
    expect(coverage, "evidence lacks coverageChecksum").toBeTruthy();
    expect(coverage.value).toBe(coverage.pinnedIndependentValue);
    expect(coverage.value).toBe(
      "18ea0e86085f2086d4d113a9239af9439648a2cec4aecd9907262ef2fff7fc39",
    );
    expect(coverage.lineCount).toBe(7);
    const role = evidence.payload.extensions.currentRoleCapabilities;
    expect(role.current_role).toBeTruthy();
    expect(role.current_role_sql_identifier).toBeTruthy();

    const packet2 = mustLoadJson(
      `${GEN}/d077-database-recovery-approval-packet-2026-08-30.json`,
    );
    const packetText = JSON.stringify(packet2);
    expect(packetText).toContain(
      `GRANT EXECUTE ON FUNCTION pgstattuple_approx(regclass) TO ${role.current_role_sql_identifier};`,
    );
    expect(packetText).toContain(
      `REVOKE EXECUTE ON FUNCTION pgstattuple_approx(regclass) FROM ${role.current_role_sql_identifier};`,
    );
  });
});
