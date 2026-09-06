#!/usr/bin/env node
/**
 * D077 correction-1 artifact generator. ONE inspected program owns the
 * final byte shape of the verification ledger, the two approval packets,
 * and (LAST, after every pinned file is final) the release-candidate
 * manifest. Every embedded hash declares `hashAlgorithm` + `hashBasis`
 * and is recomputed from the written file before exit. The manifest
 * excludes its own path and is generated after no further write to any
 * pinned file will occur.
 *
 * Usage:
 *   npx tsx scripts/audits/d077-correction1-artifact-generator.ts phase1
 *     → ledger + packets (report is authored separately, BEFORE phase2)
 *   npx tsx scripts/audits/d077-correction1-artifact-generator.ts phase2
 *     → manifest (LAST; asserts the tree matches phase1's expected counts)
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { buildWholeShellProof } from "@/scripts/audits/d077-whole-shell-proof";
import {
  CODEX_FALLBACK_PNPM_PATH,
  CORRECTION3_MUTATION_COMMAND,
  CORRECTION3_MUTATION_WHEN,
  COREPACK_TRACKED_PATHS,
  SCOPED_INSPECTION_NOTE,
  assertPortableRepoRelativePath,
  buildExplicitPathProbe,
  buildPathLookupProbe,
  buildRetainedC4Probe,
  classifyRawResolverOutcome,
  deriveScopedChange,
  validatePnpmProvenance,
  type PnpmProvenance,
  type ProvenanceProbe,
  type RawSpawnResult,
} from "@/scripts/audits/d077-provenance-contract";
import { execFileSync, spawnSync } from "node:child_process";

/*
  RELEASE CANDIDATE: a NEW dated capture again, for the same reason as before
  and one more.

  The 2026-08-30 log describes a 38-stage script; the 2026-09-03 log describes
  40. Both are kept beside this one as the earlier runs' evidence. A matching
  HEADER COUNT is not proof that a release ran: `buildWholeShellProof` compares
  the ordered stage headings against the current script, and it deliberately
  does not bind the child PROGRAMS those headings invoke. The 2026-09-03 run
  therefore cannot speak for this release — it predates the claim-race seam's
  capability repair, and it never executed the newly registered
  `direct-launch-standing-boundary` child at all, because that registration did
  not exist when it ran.

  The 07:59Z capture of 2026-09-06 was canonical for the Phase 1 checkpoint and
  is kept beside this one, but it is SUPERSEDED rather than historical: between
  the two runs the seam's CHILDREN changed. `bid-history-writes-journal.db.test.ts`
  was registered (five of its six cases had been gated on
  `ADSECUTE_EPHEMERAL_DB_SEAM` while registered in no runner, so they executed
  nowhere), and `runChildVitest` began reading the JSON report back to refuse a
  skipped or short child. Both are exactly the kind of child-program change a
  header comparison cannot see, which is why reusing the earlier log would have
  repeated the error this comment was written about.

  The 10:30Z capture was canonical when the PR was opened, and is superseded for
  the third time by the same rule: addressing the review's five findings changed
  `lib/migrations.ts` and `campaign-context-job.ts`, both of which the seam's
  children execute. Three repins in one day is not churn — it is the rule doing
  its job, because on each occasion the 40 headings were byte-identical and a
  header comparison alone would have accepted a log that no longer described
  what ran.

  Superseded a fourth time by the second review round, which changed the bid
  sizing policy that one of the seam's children exercises. Each repin has the
  same cause and the same justification: the 40 headings were byte-identical
  every time, so nothing but a fresh run can bind what actually executed.

  Superseded a fifth time by the third review round, which changed the
  launch-intent producers that the decision-launch-chain seam child exercises.

  The sixth repin is different in kind from the first five, and worth naming.
  Those replaced a PASSING log whose child programs had changed. This one
  replaces a tree that FAILED the shell: the round-4 carve-out re-offered a
  launch whose approval had been withdrawn, and the decision-launch-chain child
  caught it as two launch rows where it expected one. So this capture is not
  merely the current run — it is the proof of that repair.

  Seventh repin, for round 5: the bid dispatch and the entity-action handler
  both changed, and seam children execute both.

  Eighth repin, for round 6: the provider write client gained a pre-POST
  compare-and-set and the daily brief stopped reaching the queue reader, both
  of which seam children execute.

  Ninth repin, for round 7: the activation-approval route gained a
  compare-and-set under an advisory lock, the profile-output producer stopped
  short-circuiting on a partial set, and the Automation page's bootstrap moved
  onto the viewer's own mutation authority.

  Tenth repin: closing the activation-approval NULL race changed the approval
  validator, the intent store, the unattended pre-filter and the activation
  producer.

  This log is the 16:07Z canonical run on the delivered tree: 40 headers,
  `PASS — 40 stages`, exit 0, 574 s, with the three registered children
  reporting 7/7, 2/2 and 6/6, each `skipped=0`.
*/
const PORTABLE_SHELL_LOG_PATH =
  "docs/audits/generated/d077-canonical-database-seams-whole-shell-2026-09-06T1607Z.log";

/*
  The branch this candidate actually lives on, read from git rather than typed.

  Both artifacts carried the literal "codex/meta-disabled-readiness-20260829".
  That was true when the D077 evidence was first generated and has not been true
  since: this candidate is delivered on `codex/meta-v2-panel-fidelity`, and a
  manifest is the identity artifact — naming the wrong branch in it is not a
  cosmetic slip, it is the candidate identifying itself as something else.

  Read live so it cannot drift again. The superseded value is recorded beside it
  in `supersededBranchLabel` rather than deleted, because the two earlier
  captures were genuinely produced under that name and relabelling them silently
  is the failure mode this whole contract exists to prevent.

  Deliberately NOT touched: `RELEASE_BASE_SHA`, `baseHead` and
  `deploy/PRODUCTION_BASELINE_SHA`. Those are baseline identities, not the
  candidate's, and correcting a branch label must not move them.
*/
const SUPERSEDED_BRANCH_LABEL = "codex/meta-disabled-readiness-20260829";
const CANDIDATE_BRANCH = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
  encoding: "utf8",
}).trim();

const LEDGER_SOURCE_ENV = "D077_C1_LEDGER_SOURCE";
const LEDGER2_SOURCE_ENV = "D077_C2_LEDGER_SOURCE";
const FAILFIRST_DIR_ENV = "D077_C2_FAILFIRST_DIR";
const EVIDENCE_PATH =
  "docs/audits/generated/d077-production-recovery-readonly-evidence-2026-08-30.json";
const MANIFEST_PATH =
  "docs/audits/generated/d077-release-candidate-manifest-2026-08-30.json";
const LEDGER_PATH =
  "docs/audits/generated/d077-correction1-verification-ledger-2026-08-30.json";
const PACKET1_PATH =
  "docs/audits/generated/d077-release-deploy-approval-packet-2026-08-30.json";
const PACKET2_PATH =
  "docs/audits/generated/d077-database-recovery-approval-packet-2026-08-30.json";
const RELEASE_BASE_SHA = "babf158e150fd33057117b39b175da044ac62d2e";

const HASH_BASIS =
  "sha256 over UTF-8 bytes of JSON.stringify(artifact, null, 1) of the artifact WITHOUT its embedded hash fields (the artifact object before {<hashField>, hashAlgorithm, hashBasis} are prepended)";

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function writeHashed(
  path: string,
  hashField: string,
  artifact: Record<string, unknown>,
): string {
  const body = JSON.stringify(artifact, null, 1);
  const hash = sha256Utf8(body);
  writeFileSync(
    path,
    `${JSON.stringify(
      { [hashField]: hash, hashAlgorithm: "sha256", hashBasis: HASH_BASIS, ...artifact },
      null,
      1,
    )}\n`,
  );
  // Independent recomputation from the written bytes.
  const reread = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const { [hashField]: written, hashAlgorithm: _a, hashBasis: _b, ...rest } = reread;
  const recomputed = sha256Utf8(JSON.stringify(rest, null, 1));
  if (recomputed !== written || recomputed !== hash) {
    throw new Error(`${path}: embedded hash failed recomputation`);
  }
  return hash;
}

function versions() {
  const v = (cmd: string) => {
    try {
      return execSync(cmd, { encoding: "utf8" }).trim().split("\n")[0];
    } catch {
      return "unavailable";
    }
  };
  // pnpm: STRUCTURED provenance (correction 5) — typed probes validated
  // by the shared contract; facts are booleans/enums, never prose.
  const nowUtc = () => new Date().toISOString();
  const corepackTrackedFiles = [...COREPACK_TRACKED_PATHS];
  const statMtime = (path: string): string | null => {
    try {
      return statSync(path).mtime.toISOString();
    } catch {
      return null;
    }
  };
  const beforeMtimes = corepackTrackedFiles.map((path) => statMtime(path));

  // Raw spawn adapter: every field of the real measurement is preserved
  // as data before the PURE builders normalize it (spawnSync surfaces
  // ENOENT via result.error — never a throw).
  const toRaw = (result: {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string | Buffer | null;
    stderr: string | Buffer | null;
    error?: Error;
  }): RawSpawnResult => ({
    status: result.status,
    signal: result.signal ?? null,
    stdout: (result.stdout ?? "").toString(),
    stderr: (result.stderr ?? "").toString(),
    errorCode:
      result.error && (result.error as NodeJS.ErrnoException).code
        ? String((result.error as NodeJS.ErrnoException).code)
        : result.error
          ? "SPAWN_ERROR"
          : null,
    errorMessage: result.error ? result.error.message : null,
  });
  // The canonical state machine owns every branch decision: the raw
  // resolver measurement is classified by the SAME shared function the
  // validator re-derives with, and a malformed measurement stops
  // generation outright instead of being coerced to not_found.
  const probes: ProvenanceProbe[] = [];
  for (const probeId of ["claude-shell-pnpm", "corepack-program-version"] as const) {
    const lookupName = probeId === "claude-shell-pnpm" ? "pnpm" : "corepack";
    const lookupRaw = toRaw(
      spawnSync("bash", ["-lc", `command -v ${lookupName}`], { encoding: "utf8" }),
    );
    const lookupAt = nowUtc();
    const classification = classifyRawResolverOutcome(probeId, lookupRaw);
    let directRaw: RawSpawnResult | null = null;
    let directAt: string | null = null;
    if (classification.state === "resolved") {
      directRaw = toRaw(
        spawnSync(classification.path, ["--version"], { encoding: "utf8" }),
      );
      directAt = nowUtc();
    }
    probes.push(
      buildPathLookupProbe({
        probeId,
        lookupRaw,
        lookupObservedAtUtc: lookupAt,
        directRaw,
        directObservedAtUtc: directAt,
      }),
    );
  }
  {
    let pathExists: boolean | null = null;
    let observationErrorCode: string | null = null;
    let observationErrorMessage: string | null = null;
    try {
      pathExists = existsSync(CODEX_FALLBACK_PNPM_PATH);
    } catch (error) {
      pathExists = null;
      observationErrorCode =
        (error as NodeJS.ErrnoException).code ?? "EXISTENCE_OBSERVATION_ERROR";
      observationErrorMessage =
        (error as Error).message || "existence observation failed";
    }
    const existsAt = nowUtc();
    let directRaw: RawSpawnResult | null = null;
    let directAt: string | null = null;
    if (pathExists === true) {
      directRaw = toRaw(
        spawnSync(CODEX_FALLBACK_PNPM_PATH, ["--version"], { encoding: "utf8" }),
      );
      directAt = nowUtc();
    }
    probes.push(
      buildExplicitPathProbe({
        probeId: "codex-fallback-pnpm",
        pathExists,
        observationErrorCode,
        observationErrorMessage,
        existenceObservedAtUtc: existsAt,
        directRaw,
        directObservedAtUtc: directAt,
      }),
    );
  }
  probes.push(buildRetainedC4Probe());

  const afterMtimes = corepackTrackedFiles.map((path) => statMtime(path));
  const inspectedPaths = corepackTrackedFiles.map((path, index) => ({
    path,
    beforeMtime: beforeMtimes[index] ?? null,
    afterMtime: afterMtimes[index] ?? null,
  }));
  // The tri-state is DERIVED from the recorded metadata by the shared
  // contract helper — generator and validator cannot disagree.
  const inspectionChanged = deriveScopedChange(inspectedPaths);
  const pnpmProvenance: PnpmProvenance = validatePnpmProvenance({
    presentTenseProbes: probes,
    correction3CorepackMutation: {
      occurred: true,
      command: CORRECTION3_MUTATION_COMMAND,
      when: CORRECTION3_MUTATION_WHEN,
      restored: false,
      preMutationValue: "UNKNOWN",
    },
    earlierRetainedStagesRuntime: "UNKNOWN",
    correction5ProhibitedMutationCommandExecuted: false,
    corepackTrackedStateChanged: inspectionChanged,
    corepackScopedInspection: {
      inspectedPaths,
      changed: inspectionChanged,
      scopeNote: SCOPED_INSPECTION_NOTE,
    },
    globalHostStateClaim: "attestation_only",
  });
  const pnpmSummary =
    probes.find(
      (probe) =>
        probe.resultClass === "version_reported" &&
        probe.probeId === "claude-shell-pnpm",
    )?.reportedVersion ??
    probes.find(
      (probe) =>
        probe.resultClass === "version_reported" &&
        probe.probeId === "codex-fallback-pnpm",
    )?.reportedVersion ??
    "UNKNOWN";
  return {
    node: process.version,
    npm: v("npm --version"),
    pnpm: `${pnpmSummary} (present-tense probe; see pnpmProvenance — earlier-stage runtime UNKNOWN)`,
    vitest: v("npx vitest --version"),
    postgres: v("/opt/homebrew/opt/postgresql@16/bin/postgres --version"),
    tsc: v("npx tsc --version"),
    pnpmProvenance,
    pnpmLayoutNote:
      "supplemental context only: node_modules is a pnpm layout (.bin entries are #!/bin/sh shims) — the reason the seam entrypoint fix exists",
  };
}

const SIX_IDS = [
  "f8a3b5ac-588c-462f-8702-11cd24ff3cd2",
  "5dbc7147-f051-4681-a4d6-20617170074f",
  "6c690fa4-6395-40b5-9755-e99b34d69bc3",
  "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  "b79683b4-6f87-48c0-a3ca-44d4356fef51",
  "bc0c6178-7853-4f6f-b026-ef0222a4b9e7",
];

function treeEntries(): Array<{
  path: string;
  git: string;
  class: string;
  sha256: string | null;
}> {
  /*
    The first release freeze happened before the candidate commit existed, so
    `git status` happened to describe the whole release. Follow-up review fixes
    happen on top of that commit: status then contains only the follow-up and
    silently drops every already-committed release path from the manifest.

    Inventory the candidate against its immutable release base instead. Add
    untracked files separately because `git diff` deliberately omits them.
    `--no-renames` keeps the parser and the manifest vocabulary to one path per
    A/M/D record; a rename is represented truthfully as delete + add.
  */
  const diff = execFileSync(
    "git",
    ["diff", "--name-status", "--no-renames", "-z", RELEASE_BASE_SHA, "--"],
    { encoding: "utf8" },
  ).split("\0").filter(Boolean);
  const out: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < diff.length; index += 2) {
    const status = diff[index];
    const path = diff[index + 1];
    if (!status || !path) throw new Error("malformed NUL-delimited release diff");
    out.push({ status, path });
  }
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  ).split("\0").filter(Boolean);
  for (const path of untracked) out.push({ status: "??", path });
  const classify = (p: string, status: string): string => {
    if (status === "D") return "runtime_deletion";
    if (
      p.startsWith("docs/audits/generated/") ||
      p.startsWith("docs/creative-decision-center/generated/")
    )
      return "generated_evidence";
    if (p.startsWith("docs/")) return "docs";
    if (p.includes(".test.") || p.includes("/__tests__/")) return "tests_only";
    if (p === "lib/migrations.ts" || p === "lib/migration-verification.ts")
      return "migration";
    if (p === "docker-compose.yml") return "deploy_config";
    if (p.startsWith("scripts/audits/")) return "audit_script_non_runtime";
    if (p.startsWith("scripts/")) return "script_ops_non_request_path";
    return "runtime";
  };
  const entries: Array<{ path: string; git: string; class: string; sha256: string | null }> = [];
  for (const item of out.sort((left, right) => left.path.localeCompare(right.path))) {
    const { status, path } = item;
    if (path.endsWith("/")) continue;
    if (path === MANIFEST_PATH) continue; // self-exclusion, explicit
    let hash: string | null = null;
    if (status !== "D" && existsSync(path) && statSync(path).isFile()) {
      hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
    entries.push({ path, git: status, class: classify(path, status), sha256: hash });
  }
  return entries;
}

function classCounts(entries: Array<{ class: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.class] = (counts[entry.class] ?? 0) + 1;
  return counts;
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function embedLog(path: string): Record<string, unknown> {
  const content = readFileSync(path, "utf8");
  return {
    sourcePath: path,
    sha256: sha256Utf8(content),
    bytes: Buffer.byteLength(content, "utf8"),
    content,
  };
}

function phase1() {
  // ── Verification ledger (correction-2 truth model) ──────────────────────
  const ledger2Source = process.env[LEDGER2_SOURCE_ENV];
  if (!ledger2Source)
    throw new Error(`${LEDGER2_SOURCE_ENV} must point at the correction-2 ledger.jsonl`);
  const stages = readJsonl(ledger2Source);
  for (const stage of stages) {
    for (const field of ["stage", "command", "startUtc", "endUtc", "durationSeconds", "exitCode", "counts", "timeout", "teardown"]) {
      if (!(field in stage))
        throw new Error(`ledger stage ${String(stage.stage)} missing uniform field ${field}`);
    }
  }
  const failfirstDir = process.env[FAILFIRST_DIR_ENV];
  if (!failfirstDir)
    throw new Error(`${FAILFIRST_DIR_ENV} must point at the fail-first log directory`);
  const historicalFailFirstEvidence = {
    note:
      "Raw fail-first outputs embedded verbatim and content-hashed. Their exact start/end/duration were NOT captured when they ran (correction-1 limitation); timing is UNKNOWN by fact, not omission. The route-authority red and the exact execution_not_ready refusal are inside the embedded content.",
    routeAuthorityRed: {
      ...embedLog(`${failfirstDir}/route-authority-failfirst.log`),
      timing: "UNKNOWN — not captured at run time",
      exitCode: 1,
    },
    launchpadSeamRed: {
      ...embedLog(`${failfirstDir}/seam-failfirst.log`),
      timing: "UNKNOWN — not captured at run time",
      exitCode: 1,
      exactRefusal: '{"ok":false,"refusal":"execution_not_ready"}',
    },
  };
  const supplementalSource = process.env[LEDGER_SOURCE_ENV];
  const supplementalCorrection1Records = supplementalSource
    ? {
        note:
          "HISTORICAL, SUPPLEMENTAL ONLY — the correction-1 records (unit-suite splits, 51 extracted seam commands, fast checks). The 51-command extraction is NOT the canonical database-seam equivalent: it omitted the executable CUTOVER_REQUIRED/wrapper-manifest/runbook shell logic (canonical script lines 184–216). The authoritative database-seam proof is wholeShellCanonicalRun below. These records carry no timeout/teardown fields because none were captured at run time (limitation recorded, not invented).",
        limitation: {
          timeout: null,
          timeoutReason: "no external timeout was configured for these historical runs",
          teardown: null,
          teardownReason: "no per-stage teardown capture existed in the correction-1 runner",
        },
        records: readJsonl(supplementalSource),
      }
    : { note: "correction-1 records unavailable", records: [] };
  const wholeShell = stages.find((s2) => s2.stage === "canonical.database-seams-whole-shell");
  if (!wholeShell)
    throw new Error("the whole-shell canonical database-seams stage is missing from the ledger");
  // Correction 3: the composite shell has NO single Vitest aggregate — the
  // runner's first-match count (`passed: 53`) was materially misleading.
  // Replace it fail-closed with an explicit not-applicable object and bind
  // the durable ordered-header proof, built from the RETAINED raw log
  // (re-verified byte-identical) against the CURRENT seam script.
  const shellLogFile = (wholeShell as { logFile?: { path?: string; sha256?: string; bytes?: number } }).logFile;
  if (!shellLogFile?.path || !shellLogFile.sha256 || !shellLogFile.bytes)
    throw new Error("whole-shell stage lacks its retained logFile record");
  // Correction 5: the SOLE runtime input is the repository-relative,
  // manifest-pinned byte-identical copy of the retained capture. The
  // original absolute session path is preserved as provenance only and is
  // never opened here.
  const originalCapturePath = shellLogFile.path;
  assertPortableRepoRelativePath(PORTABLE_SHELL_LOG_PATH);
  if (!existsSync(PORTABLE_SHELL_LOG_PATH))
    throw new Error(
      `portable whole-shell log is MISSING at ${PORTABLE_SHELL_LOG_PATH} — freeze refused`,
    );
  const shellLogText = readFileSync(PORTABLE_SHELL_LOG_PATH, "utf8");
  const wholeShellProof = buildWholeShellProof({
    logText: shellLogText,
    expectedLogSha256: shellLogFile.sha256,
    expectedLogBytes: shellLogFile.bytes,
    seamScriptText: readFileSync("scripts/verify-database-seams.sh", "utf8"),
  });
  wholeShell.logFile = {
    path: PORTABLE_SHELL_LOG_PATH,
    sha256: shellLogFile.sha256,
    bytes: shellLogFile.bytes,
  };
  (wholeShell as Record<string, unknown>).originalCapturePath = {
    path: originalCapturePath,
    note:
      "capture provenance ONLY — the ephemeral Claude-session location where the supervisor wrote the log during the one authoritative run; validated byte-identical to the repository copy before the copy was frozen; no generator/test read path opens it after the freeze",
  };
  wholeShell.counts = {
    notApplicable: true,
    reason:
      "composite shell: the canonical acceptance unit is the exact 40-stage header sequence plus the final '[verify-db-seams] PASS — 40 stages' line (see wholeShellProof). The log contains MANY nested Vitest summaries; taking the first misrepresented the run and summing them would be an unsafe substitute for the shell's own acceptance unit.",
  };
  (wholeShell as Record<string, unknown>).wholeShellProof = wholeShellProof;
  // Chronology: observations are collected FIRST; generatedAtUtc is
  // stamped strictly afterwards so it can never predate a present-tense
  // observation.
  const runtimeVersions = versions();
  const ledger = {
    contract: "adsecute.d077.correction2-verification-ledger.v2",
    generatedAtUtc: new Date().toISOString(),
    runtimeVersions,
    stageSchema:
      "every entry in `stages`: {stage, command, startUtc, endUtc, durationSeconds, exitCode, counts (parsed vitest counts OR {notApplicable:true, reason}), timeout:{configuredSeconds, timedOut}, teardown (readback string or {notApplicable:true, reason}), tail}",
    equivalenceMapping: {
      "verify:pre-push":
        "check:workflows → typecheck → eslint . → vitest run → scripts/verify-database-seams.sh. Correction 2 proves: canonical.check-workflows, canonical.typecheck, canonical.eslint-changed (full `eslint .` was green in correction 1), focused vitest stages on the changed surfaces, and the AUTHORITATIVE canonical.database-seams-whole-shell run (`bash scripts/verify-database-seams.sh` executed as ONE command — including the CUTOVER_REQUIRED/manifest/runbook release-boundary logic the correction-1 extraction missed). The full 13,683-test unit suite is preserved as historical correction-1 evidence (green, timestamped) and was deliberately not rerun to repair audit metadata.",
      authoritativeDatabaseSeamProof: "stages[canonical.database-seams-whole-shell]",
      notReproduced:
        "CI image publish lane, actionlint binary, authenticated deployed-UI reads — recorded as unproven, not claimed",
    },
    stages,
    historicalFailFirstEvidence,
    supplementalCorrection1Records,
    teardownReadback: {
      taskOwnedProcesses: "none remain (verified after the final stage; exact commands in the final response)",
      ephemeralDatabaseListeners: "none remain (seam clusters tear down in their traps)",
      preExistingTunnel:
        "127.0.0.1:15432 SSH tunnel (pid 38894) found running before this task, never started/stopped/touched by it",
      claudeEvidenceScratchpad:
        "INTENTIONALLY RETAINED at the session scratchpad d077/ directory: it holds the raw fail-first logs (embedded above by content and hash), runner sources and planner logs. It is retained evidence, NOT ephemeral database/process residue; nothing in it is a secret.",
    },
  };
  const ledgerHash = writeHashed(LEDGER_PATH, "ledgerHash", ledger);

  // Expected final-tree counts for the manifest phase: file EXISTENCE only
  // (byte changes to already-listed files do not change counts), so the
  // report may still be edited between phase1 and phase2.
  const expected = treeEntries();
  const expectedCounts = classCounts(expected);

  // ── Packet 1: release/deploy (NO_GO) ────────────────────────────────────
  const packet1 = {
    contract: "adsecute.d077.release-deploy-approval-packet.v2",
    status:
      "PREPARED_AWAITING_OPERATOR_APPROVAL — no commit, push, dispatch, or deploy performed; submitted for Codex independent acceptance — not self-accepted",
    generatedAtUtc: new Date().toISOString(),
    decision: "NO_GO",
    blockerLedger: {
      cleared: [
        "battery red 1 CLEARED this correction: meta/campaign-labels tombstone now declared INTENTIONALLY_PUBLIC in the route-authority guard with its compatibility reason (fail-first 1 failed/4 passed preserved; post-fix 5/5)",
        "battery red 2 CLEARED this correction: the duplicate-preselection fixture omitted executionReadiness 'live_preflight_required' after replacing the whole sourceAuthority object; exact refusal recorded fail-first ({ok:false, refusal:'execution_not_ready'}), fixture repaired, authorizeLaunchpadHandoff untouched (canonical seam 26+27 green)",
      ],
      remaining: [
        "RUNBOOK PREFLIGHT BLOCKER (now VERIFIED under one RR RO transaction, 2026-08-30 13:43:16Z): automated_missing serving surfaces on all three release canaries — IwaStore 3, TheSwaf 3 (overview_shopify_orders_aggregate_v6.recent_window, shopify_reconciliation_runs, shopify_serving_state), Grandmix 23 (incl. provider_reporting_snapshots.ecommerce_fallback); non-canaries Bilsem Zeka/IwaTR/ColorFullWorldsTR report 0 automated_missing. Pre-existing production serving state, candidate-independent, but the runbook classes automated_missing as a release blocker: operator triage or explicit written acceptance required before dispatch.",
      ],
      preconditionsNotReadBacks: [
        "host .env.production CAMPAIGN_CONTEXT_MODE override state UNKNOWN — read on the host before dispatch (compose default flips legacy_labels→automatic)",
        "host automation env flags UNKNOWN — deploy precondition/stop condition; control-plane rows (the DB truth) are effective fail-closed for all six businesses",
        "stale hand-added nginx per-route blocks may mask new routes — verify after deploy",
      ],
    },
    sourceTree: {
      repository: "emrahbilaloglu-ui/OmniAds",
      branch: CANDIDATE_BRANCH,
      supersededBranchLabel: SUPERSEDED_BRANCH_LABEL,
      baseHead: "babf158e150fd33057117b39b175da044ac62d2e",
      proposal:
        "Commit the ENTIRE final corrected worktree as ONE release candidate commit, then fast-forward merge to main. The D073–D078 packages interleave in shared files (contracts, read models, lib/migrations.ts) and were verified as one tree; partial release was evaluated and rejected.",
      commitStrategy:
        "single commit -> ff-merge to main; NO commit is made by this preflight",
      candidateShaPlaceholder:
        "<CANDIDATE_SHA: full 40-char lowercase SHA of the release commit once created>",
      manifestReference: {
        path: MANIFEST_PATH,
        generationOrderContract:
          "the manifest is generated LAST by this same inspected generator (phase2), after this packet and every other pinned file is final; it excludes its own path and pins this packet's exact bytes. Its entry counts must equal expectedFinalTree below (asserted at generation).",
        expectedFinalTree: {
          pinnedNonSelfFileCount: expected.length,
          classCounts: expectedCounts,
          historicalContext:
            "pre-task freeze was 217 porcelain entries / 265 files — historical only, NOT the final tree",
        },
      },
    },
    ciImagePrerequisites: {
      imageNamespace:
        "current = ghcr.io/emrahbilaloglu-ui/{omniads-web,omniads-worker}:<CANDIDATE_SHA>",
      publishLane:
        "CI on push to main publishes exact-SHA images; no deploy is dispatched by CI",
      pullability:
        "docker manifest inspect ghcr.io/emrahbilaloglu-ui/omniads-web:<CANDIDATE_SHA> must succeed before dispatch",
    },
    workflowDispatch: {
      workflow: ".github/workflows/deploy-hetzner.yml (manual dispatch only)",
      inputs: {
        sha: "<CANDIDATE_SHA>",
        image_namespace: "current",
        require_current_main_head: "true",
        run_migrations: "true",
        break_glass: "false",
      },
      postDeploy:
        "post-deploy-verify artifact post-deploy-release-authority.json MUST be inspected: summary.result=pass AND blockers=[] (workflow-green alone is insufficient)",
    },
    beforeState: {
      deployed:
        "babf158e150fd33057117b39b175da044ac62d2e on web+worker (re-read via public /api/build-info by the evidence collector, 2026-08-30 ~13:44Z; deploy+release gates pass)",
      schema:
        "production LACKS meta_entity_observation_runs.{manifest_kind,base_run_id,delta_stats_json,last_captured_at} and meta_state_history_compaction_journal (verified 2026-08-30 13:43:16Z, RR RO)",
      ingestion:
        "Meta observation writes admission-refused since 2026-08-22 14:53:48Z (fence 5,368,750,080B vs 5,368,709,120B budget)",
    },
    desiredAfterState: {
      deployed:
        "<CANDIDATE_SHA> live on web+worker; build-info matches; post-deploy artifact pass/empty blockers",
      schema: "D075 columns + D077 journal present (additive, IF NOT EXISTS)",
      behavior:
        "ingestion REMAINS admission-refused until the separate DB-recovery packet clears the fence — deploying does NOT restore ingestion by itself",
    },
    migrationSafety: {
      locking:
        "ALTER TABLE ADD COLUMN (no volatile default → no rewrite; brief ACCESS EXCLUSIVE each) + CREATE TABLE/INDEX on a NEW empty journal table; all IF NOT EXISTS idempotent",
      timeouts:
        "deploy workflow migration timeout inputs available; defaults acceptable for additive DDL",
      partialFailure:
        "migrate failure aborts before web/worker recreate; old containers keep running; rerun after diagnosis",
    },
    exposureAndCanary: {
      exposure:
        "seconds-level web/worker recreate; single host; no provider mutation; automation stays OFF (effective fail-closed control rows unchanged)",
      canaryOrder:
        "verify TheSwaf, Grandmix, IwaStore first (the runtime contract's releaseCanaryBusinesses), then the remaining three",
      readBack: [
        "curl https://adsecute.com/api/build-info → buildId == <CANDIDATE_SHA> (and www)",
        "inspect the post-deploy-verify artifact (pass + empty blockers)",
        "verify-serving-direct-release --mode=post_deploy --expected-build-id=<CANDIDATE_SHA>",
        "RR RO SQL: compaction journal + D075 columns present",
        "authenticated spot-check: stale decisions serve review-only Refresh Decision (no enabled Cut); automation page renders D077 readiness",
      ],
    },
    rollback: {
      sha: "babf158e150fd33057117b39b175da044ac62d2e",
      imageNamespace: "current (currently deployed; images proven published)",
      procedure:
        "dispatch Deploy to Hetzner with sha=babf158e150fd33057117b39b175da044ac62d2e, image_namespace=current, require_current_main_head=false; re-run post-deploy verification",
      nonReversibleMigrationEffects:
        "additive D075 columns and the (empty) D077 journal REMAIN after app rollback; old code ignores them; no schema rollback machinery exists. If compaction executed before rollback (it must not — see the DB packet ordering), deleted duplicate rows are NOT restored by app rollback",
    },
    stopConditions: [
      "CI red or images not pullable for <CANDIDATE_SHA>",
      "deploy/CUTOVER_REQUIRED present (currently absent)",
      "migrate failure or timeout",
      "/api/build-info mismatch after recreate",
      "post-deploy artifact result != pass or blockers non-empty",
      "canary business route non-2xx or stale-Cut withholding NOT observed",
      "worker crash-loop or heartbeats stop (distinct from the PRE-EXISTING admission-refused ingestion, which persists by design until DB recovery)",
      "any automation env flag found set on the host during the precondition read",
    ],
  };
  const packet1Hash = writeHashed(PACKET1_PATH, "packetHash", packet1);

  // ── Packet 2: DB recovery ───────────────────────────────────────────────
  // Bind A1b to the EXACT role the refreshed evidence read in-transaction.
  const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as {
    payload: {
      extensions: {
        currentRoleCapabilities: {
          current_role?: string;
          current_role_sql_identifier?: string;
        };
      };
    };
  };
  const roleName =
    evidence.payload.extensions.currentRoleCapabilities.current_role;
  const roleIdent =
    evidence.payload.extensions.currentRoleCapabilities
      .current_role_sql_identifier;
  if (!roleName || !roleIdent)
    throw new Error(
      "refreshed evidence lacks current_role/current_role_sql_identifier — regenerate the production evidence first",
    );
  const evidenceProofs = (
    evidence as unknown as {
      payload: {
        transactionProofs: {
          retrieved_at?: string;
          application_name?: string;
          transaction_read_only?: string;
          transaction_isolation?: string;
        };
      };
    }
  ).payload.transactionProofs;
  if (
    !evidenceProofs.retrieved_at ||
    !evidenceProofs.application_name ||
    evidenceProofs.transaction_read_only !== "on" ||
    evidenceProofs.transaction_isolation !== "repeatable read"
  )
    throw new Error(
      "refreshed evidence lacks the RR/RO transaction proofs the packet provenance must bind to",
    );
  const packet2 = {
    contract: "adsecute.d077.database-recovery-approval-packet.v2",
    status:
      "PREPARED_AWAITING_OPERATOR_APPROVAL — nothing executed; submitted for Codex independent acceptance — not self-accepted",
    generatedAtUtc: new Date().toISOString(),
    decision:
      "GO_WITH_EXACT_LIMITS — approvable now: A1a (superuser pgstattuple install), A1b (least-privilege EXECUTE capability for the app role — REQUIRED, see privilege facts), and scheduling the A3 planner dry-run. A4 execution stays sequence-blocked behind the release packet and a fresh ready plan",
    scope: {
      businessIds: SIX_IDS,
      rule: "the compaction CLI refuses a global scope; every plan/execute names exactly these six ids",
    },
    privilegeFacts: {
      provenance: {
        boundProgrammaticallyToEvidence: true,
        retrievedAt: evidenceProofs.retrieved_at,
        applicationName: evidenceProofs.application_name,
        transactionReadOnly: evidenceProofs.transaction_read_only,
        transactionIsolation: evidenceProofs.transaction_isolation,
        note:
          "every privilege/extension/role fact in this packet comes from THIS one refreshed RR/RO evidence transaction (no other observation is mixed in); the values above are copied programmatically from payload.transactionProofs of the frozen evidence artifact at packet-generation time",
      },
      pgstattuple:
        "available versions 1.4 and 1.5; BOTH superuser=true, trusted=FALSE — installation therefore REQUIRES a PostgreSQL superuser regardless of database CREATE; installed_version is NULL",
      appRole: `role ${roleIdent} (server-quoted identifier of current_user read in-transaction): rolsuper=false, rolcreaterole=false, rolcreatedb=false; has_database_privilege(current_database,'CREATE')=TRUE (irrelevant for an untrusted extension); pg_has_role('pg_stat_scan_tables','MEMBER')=FALSE; pg_has_role('pg_monitor','MEMBER')=FALSE`,
      consequence:
        "installation alone does NOT let the app role execute pgstattuple_approx: since pgstattuple 1.5 the extension script revokes PUBLIC and grants EXECUTE to pg_stat_scan_tables, and the app role is not a member. Without A1b the fence stays on raw bytes and ingestion stays refused even after A1a + compaction + vacuum.",
    },
    currentPlan: {
      candidatePlanHash: null,
      why:
        "NO valid current production dry-run plan exists (attempt provenance: one honest 300s statement timeout; the 600s attempts were terminated by the Codex supervisor after bounded waiting — SIGINT to the final planner — to limit production read load; no output, no plan file, no writes). Totals are UNKNOWN — never zero, never inferred from census bounds.",
      frozenCensusBoundsOnly: {
        candidateMassUpperBoundRows: 3449571,
        sixBusinessCandidateUpperBoundRows: 1774467,
        rowLevelLineagePinLowerBound: 160477,
        provenance:
          "D077 ADR SELECT-only census 2026-08-30 (DECISION_LOG); NOT planner output; may not be quoted as removable",
      },
      protectionCountsByReason:
        "UNKNOWN pending the fresh planner (families: headDuplicate, liveLineagePinned, archivedLineagePinned, responseEventPinned, interleavedExcluded, multiEndpointExcluded; overlapping, non-additive)",
      insufficiencyToday:
        "even a completed plan today would be status=insufficient_evidence: no effective-size proof (extension uninstalled + no EXECUTE capability) and D075/D077 schema undeployed; the executor refuses insufficiency outright",
    },
    sequence: [
      {
        id: "A1a",
        action: "Install pgstattuple (superuser DDL)",
        sqlShape: "CREATE EXTENSION IF NOT EXISTS pgstattuple;",
        actorPrivilege:
          "PostgreSQL SUPERUSER on the DB host (verified: the extension is untrusted, so database CREATE does NOT suffice; the app role is non-superuser)",
        reversibility: "fully reversible (DROP EXTENSION pgstattuple)",
        lockRuntimeIoRisk: "catalog-only, instantaneous; no user-table lock or IO",
        maxExposure: "none — read-only inspection functions",
        idempotency: "IF NOT EXISTS; safe to re-run",
        beforeReadback:
          "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name='pgstattuple';",
        successPredicate: "installed_version = '1.5'",
        abortTrigger: "any error / privilege refusal",
        rollbackCompensation: "DROP EXTENSION pgstattuple",
        residualRisk: "negligible (contrib module)",
      },
      {
        id: "A1b",
        action: `Least-privilege EXECUTE capability for the exact app role ${roleIdent} (REQUIRED — verified absent)`,
        sqlShape: `preferred (narrowest): GRANT EXECUTE ON FUNCTION pgstattuple_approx(regclass) TO ${roleIdent};  — alternative (broader, standard): GRANT pg_stat_scan_tables TO ${roleIdent};  (identifier produced by the server's quote_ident(current_user) inside the RR/RO evidence transaction — injection-safe by construction)`,
        actorPrivilege: "PostgreSQL superuser (or the function owner)",
        reversibility: `fully reversible: REVOKE EXECUTE ON FUNCTION pgstattuple_approx(regclass) FROM ${roleIdent};  /  REVOKE pg_stat_scan_tables FROM ${roleIdent};`,
        lockRuntimeIoRisk: "catalog-only, instantaneous",
        maxExposure: `${roleIdent} gains read-only physical-statistics visibility on relations it can already see (function-grant variant: exactly one function); no data rows exposed`,
        idempotency: "GRANT is idempotent",
        beforeReadback: `before (post-A1a): SELECT has_function_privilege('${roleName}', 'pgstattuple_approx(regclass)', 'EXECUTE');  → false; after the grant: the same query → true; then the READ-ONLY smoke: SELECT * FROM pgstattuple_approx('meta_entity_state_history'::regclass);  executed AS ${roleIdent}`,
        successPredicate: `${roleIdent}'s fence read reports metric=effective_reusable_heap with a sane sample instead of falling back to raw`,
        abortTrigger: "grant error; smoke returns error or inconsistent values",
        rollbackCompensation: "the exact REVOKE above",
        residualRisk:
          "negligible; the grant is named in the readiness contract and revocable at any time",
        note:
          "NOT executed in this task; the planner must remain insufficient until BOTH extension availability AND executable measurement are proved via read-back",
      },
      {
        id: "A2",
        action:
          "Release/deploy the D074–D078 candidate (adds D075 columns + D077 journal; stops the duplicate-rewrite refill class)",
        reference:
          "d077-release-deploy-approval-packet-2026-08-30.json — NO_GO until its remaining blocker clears; A4 MUST NOT run before this lands (executor needs the journal; without D075 the reclaimed space refills at the measured ~0.89 GiB/4-day rate)",
        actorPrivilege: "operator (git push + workflow dispatch)",
        reversibility: "app-image rollback to babf158e1…; additive schema remains",
        successPredicate: "packet-1 read-backs green",
        abortTrigger: "packet-1 stop conditions",
      },
      {
        id: "A3",
        action: "Fresh planner dry-run (SELECT-only) in a low-traffic window",
        commandShape:
          "DB_QUERY_TIMEOUT_MS=600000 npx tsx scripts/state-history-compaction-cli.ts --mode plan --business-ids <the six ids, comma-joined> --statement-timeout-ms 600000 --plan-out <fresh mkdtemp under /tmp>/plan.json",
        actorPrivilege:
          "operator shell with the read tunnel; app-role SELECT suffices; the planner enforces REPEATABLE READ READ ONLY and refuses weaker isolation",
        reversibility: "nothing to reverse (zero writes)",
        lockRuntimeIoRisk:
          "minutes-class census reads; run off-peak; bounded per-statement 600s",
        maxExposure: "none",
        idempotency: "re-runnable; each run makes a new plan+hash",
        beforeReadback:
          "the plan file + printed planHash/totals/protectionsByReason ARE the readback",
        successPredicate:
          "status='ready' with exact removable runs/rows per scope, all protection families, fence projection under the effective metric; else an honest insufficiency stops the sequence",
        abortTrigger:
          "statement timeout, isolation refusal, count-validator refusal, or insufficiency",
        residualRisk: "read load during the census",
      },
      {
        id: "A4",
        action: "Operator-approved compaction execution (CLI ONLY; never scheduled)",
        commandShape:
          "npx tsx scripts/state-history-compaction-cli.ts --mode execute --business-ids <same six ids> --plan-file <A3 plan.json> --approval-token <operator-constructed from the printed planHash> --acknowledge-physical-shrink-required",
        actorPrivilege:
          "operator shell; DB app role (DELETE on meta_entity_state_history; INSERT on the journal)",
        reversibility:
          "DELETED rows are NOT restorable (byte-identical duplicate manifests whose content survives in each streak's retained copy; per-batch in-transaction proofs guarantee semantic equivalence; the journal is the durable record). The approval must name the plan's exact maximum deletions.",
        lockRuntimeIoRisk:
          "batched row DELETEs, bounded batch size, statement/lock timeouts, journal lease, kill switch STATE_HISTORY_COMPACTION_ABORT honored between batches; RESTRICT FKs fail loud",
        maxExposure:
          "exactly the fresh plan's removableRows (UNKNOWN today; upper-bounded by the frozen six-business candidate mass 1,774,467 rows); financial exposure: none",
        idempotency:
          "idempotent resume of an admitted plan; a completed plan never executes twice; forged/stale plans refuse with zero writes (authoritative re-plan equality before ANY write, journal included)",
        beforeReadback:
          "executor's own authoritative re-plan; after: journal rows for the plan hash, per-scope deleted-row accounting, final whole-timeline recheck, follow-up planner nothing_to_do",
        successPredicate:
          "status completed (completed_with_skips only in the documented race window) with deleted counts == plan; timelines proven equal",
        abortTrigger:
          "ANY hash/scope/count/schema/fence/pin/interleave/worker/build drift → typed zero-write refusal; STOP on authoritative_replan_mismatch",
        rollbackCompensation:
          "none for deleted rows; compensation is the retained-copy equivalence + journal",
        residualRisk:
          "the documented race window between re-plan and a batch (per-batch revalidation covers it)",
      },
      {
        id: "A5",
        action: "Ordinary vacuum + effective-size read-back (NO physical shrink implied)",
        sqlShape:
          "VACUUM (VERBOSE) meta_entity_state_history; -- or await autovacuum; then read the fence",
        actorPrivilege: "table owner/superuser (or autovacuum)",
        lockRuntimeIoRisk: "non-exclusive; IO proportional to dead tuples",
        maxExposure: "none",
        beforeReadback: "pg_total_relation_size + pgstattuple_approx before/after",
        successPredicate:
          "effective size (raw − proven reusable free space) < 5,368,709,120 with the planner-stated margin. EXPLICIT: DELETE + ordinary VACUUM may NOT reduce the RAW relation bytes at all; only the effective metric is expected to clear. VACUUM FULL, pg_repack, and any physical shrink are NOT part of this action and are NOT silently included.",
        abortTrigger:
          "effective metric fails to clear → stop and investigate; no exclusive-lock escalation without a separate approval",
      },
      {
        id: "A6",
        action: "Ingestion re-admission observation (no action taken)",
        readback:
          "next natural worker tick: meta_entity_state_history MAX(captured_at) advances past 2026-08-22 14:53:48Z; meta_sync_runs succeed for the six accounts; fence admission allows",
        successPredicate: "fresh accepted Meta observation writes without any manual trigger",
        abortTrigger: "admission still refused after a healthy fence read → stop, re-measure",
      },
      {
        id: "A7",
        action: "OPTIONAL, SEPARATE APPROVAL — physical byte return",
        options:
          "REINDEX CONCURRENTLY per index (non-exclusive; indexes are ~2.68 GB) and/or pg_repack / VACUUM FULL (EXCLUSIVE lock; high risk)",
        explicit: "kept OUTSIDE this packet; requires its own packet",
      },
    ],
    driftPolicy:
      "A NEW plan is required immediately before execution; the executor independently re-derives the authoritative plan pre-write and refuses on ANY mismatch. Stop on any hash, scope, count, schema, fence, pin, interleave, worker, or build drift. Automation, activation, and every Meta/provider action remain OUTSIDE this packet.",
    secretsPolicy:
      "no credential and no approval token in this packet; the token is constructed by the operator from the fresh plan's printed planHash at execution time. The app ROLE NAME is serialized deliberately (a PostgreSQL role name is an identity, not a credential); no password, DSN, token, cookie, or host credential appears anywhere",
  };
  const packet2Hash = writeHashed(PACKET2_PATH, "packetHash", packet2);

  console.log(
    JSON.stringify(
      { phase: 1, ledgerHash, packet1Hash, packet2Hash, expectedFinalTree: { pinnedNonSelfFileCount: expected.length, classCounts: expectedCounts } },
      null,
      1,
    ),
  );
}

function phase2() {
  let entries = treeEntries();
  let counts = classCounts(entries);
  // A review-fix commit can be followed by an uncommitted correction pass.
  // Refresh the packet's tree-only expectation first, re-hash it, and only
  // then take the final byte hashes for the manifest.
  const packet1WithHash = JSON.parse(readFileSync(PACKET1_PATH, "utf8")) as {
    packetHash: string;
    hashAlgorithm: string;
    hashBasis: string;
    sourceTree: {
      manifestReference: {
        expectedFinalTree: {
          pinnedNonSelfFileCount: number;
          classCounts: Record<string, number>;
          historicalContext?: string;
        };
      };
    };
    [key: string]: unknown;
  };
  const {
    packetHash: _packetHash,
    hashAlgorithm: _packetAlgorithm,
    hashBasis: _packetBasis,
    ...packet1
  } = packet1WithHash;
  const priorExpected = packet1.sourceTree.manifestReference.expectedFinalTree;
  packet1.sourceTree.manifestReference.expectedFinalTree = {
    ...priorExpected,
    pinnedNonSelfFileCount: entries.length,
    classCounts: counts,
  };
  writeHashed(PACKET1_PATH, "packetHash", packet1);

  entries = treeEntries();
  counts = classCounts(entries);
  const expected = packet1.sourceTree.manifestReference.expectedFinalTree;
  if (expected.pinnedNonSelfFileCount !== entries.length) {
    throw new Error(
      `manifest/packet drift: packet expects ${expected.pinnedNonSelfFileCount} non-self files, tree has ${entries.length}`,
    );
  }
  if (JSON.stringify(expected.classCounts) !== JSON.stringify(counts)) {
    throw new Error("manifest/packet drift: class counts differ");
  }
  const porcelain = execSync("git status --porcelain", { encoding: "utf8" })
    .split("\n")
    .filter(Boolean).length;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const [behindOriginMain, aheadOfOriginMain] = execFileSync(
    "git",
    ["rev-list", "--left-right", "--count", `origin/main...${head}`],
    { encoding: "utf8" },
  ).trim().split(/\s+/).map(Number);
  const manifest = {
    contract: "adsecute.d077.release-candidate-manifest.v3",
    generatedAtUtc: new Date().toISOString(),
    branch: CANDIDATE_BRANCH,
    supersededBranchLabel: SUPERSEDED_BRANCH_LABEL,
    head,
    baseMain: RELEASE_BASE_SHA,
    originMain: RELEASE_BASE_SHA,
    remoteDivergence: { aheadOfOriginMain, behindOriginMain },
    selfExclusion: `this manifest's own path (${MANIFEST_PATH}) is EXCLUDED from its entry list: a manifest cannot recursively pin its own final bytes; its external SHA-256 is reported in the final response and by Codex's own hashing`,
    gitPorcelainEntryCount: porcelain,
    releaseDiffEntryCountIncludingSelf: entries.length + 1,
    expandedOnDiskCandidateFileCountIncludingSelf: entries.length + 1,
    pinnedNonSelfFileCount: entries.length,
    historicalContext:
      "pre-task freeze was 217 porcelain entries / 265 files — historical context only, NOT the final tree",
    classCounts: counts,
    entries,
  };
  const manifestHash = writeHashed(MANIFEST_PATH, "manifestHash", manifest);
  console.log(
    JSON.stringify(
      { phase: 2, manifestHash, gitPorcelainEntryCount: porcelain, pinnedNonSelfFileCount: entries.length, classCounts: counts },
      null,
      1,
    ),
  );
}

const phase = process.argv[2];
if (phase === "phase1") phase1();
else if (phase === "phase2") phase2();
else throw new Error("usage: … phase1 | phase2");
