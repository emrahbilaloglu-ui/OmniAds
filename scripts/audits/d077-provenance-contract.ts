/**
 * D077 correction 8 — CANONICAL pnpm/Corepack provenance state machine.
 *
 * ONE pure transition function (`deriveCanonicalProbe`) maps strictly
 * validated tagged measurements (a resolver step, an explicit-path
 * existence observation, an optional direct execution step, or the one
 * retained correction-4 record) to the COMPLETE canonical serialized
 * probe. The builders construct probes THROUGH it and the validator
 * re-derives the canonical probe from the serialized measurements and
 * deep-compares the result with exact key sets at every level — no
 * serialized summary field (command, mechanism, commandForm,
 * resolution, resultClass, resolvedPath, reportedVersion, top
 * observation time) is ever trusted independently. Malformed
 * measurements (resolver exit 0 with anything but exactly one clean
 * absolute path, incoherent status/signal/spawn-error tuples,
 * calendar-impossible instants) are REFUSED outright — never converted
 * to `not_found`. The ledger-level validator additionally binds this
 * frozen audit package's exact current outcomes (claude-shell pnpm
 * unresolved; fallback pnpm 11.19.0; Corepack program 0.34.2): a
 * changed tool version stops generation and requires an explicit new
 * audit update instead of silently rewriting the package.
 */

export type ProbeResolution = "resolved" | "unresolved" | "unmeasured";
export type ObservationTimeCertainty = "exact" | "unknown";
export type ProbeResultClass =
  | "version_reported"
  | "not_found"
  | "resolver_error"
  | "execution_error"
  | "retained_observation";
export type ObservationKind = "present_tense" | "retained";
export type CacheSafety = true | false | "not_rerun";
export type TriState = "true" | "false" | "unknown";
export type ResolutionKind = "path_lookup" | "explicit_path" | "retained";

/** One executed measurement, preserved verbatim. */
export interface ExecutedStep {
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
}

/** The explicit-path probe's own tagged existence observation. */
export interface ExistenceObservation {
  path: string;
  /** true/false = measured; null = the observation itself errored. */
  exists: boolean | null;
  observationErrorCode: string | null;
  observationErrorMessage: string | null;
  observedAtUtc: string;
}

interface ProbeCommon {
  probeId: string;
  command: string;
  resolutionMechanism: string;
  resolution: ProbeResolution;
  resolvedPath: string | null;
  reportedVersion: string | null;
  resultClass: ProbeResultClass;
  observationKind: ObservationKind;
  observedAtUtc: string | null;
  observationTimeCertainty: ObservationTimeCertainty;
  cacheSafeReadOnly: CacheSafety;
}
export interface PathLookupProbe extends ProbeCommon {
  resolutionKind: "path_lookup";
  resolutionStep: ExecutedStep;
  directExecutionStep: ExecutedStep | null;
}
export interface ExplicitPathProbe extends ProbeCommon {
  resolutionKind: "explicit_path";
  existenceObservation: ExistenceObservation;
  directExecutionStep: ExecutedStep | null;
}
export interface RetainedC4ProbeShape extends ProbeCommon {
  resolutionKind: "retained";
  stderr: string;
  exitStatus: null;
  signal: null;
}
export type ProvenanceProbe =
  | PathLookupProbe
  | ExplicitPathProbe
  | RetainedC4ProbeShape;

export interface CorepackScopedInspection {
  inspectedPaths: Array<{
    path: string;
    beforeMtime: string | null;
    afterMtime: string | null;
  }>;
  changed: TriState;
  scopeNote: string;
}

export interface PnpmProvenance {
  presentTenseProbes: ProvenanceProbe[];
  correction3CorepackMutation: {
    occurred: true;
    command: string;
    when: string;
    restored: false;
    preMutationValue: "UNKNOWN";
  };
  earlierRetainedStagesRuntime: "UNKNOWN";
  correction5ProhibitedMutationCommandExecuted: false;
  corepackTrackedStateChanged: TriState;
  corepackScopedInspection: CorepackScopedInspection;
  globalHostStateClaim: "attestation_only";
}

export const REQUIRED_PROBE_IDS = [
  "claude-shell-pnpm",
  "codex-fallback-pnpm",
  "corepack-program-version",
  "corepack-pnpm-retained-c4",
] as const;

export const CODEX_FALLBACK_PNPM_PATH =
  "/Users/harmelek/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm";
export const COREPACK_TRACKED_PATHS = [
  "/Users/harmelek/.cache/node/corepack/lastKnownGood.json",
  "/Users/harmelek/.cache/node/corepack/v1",
] as const;
export const CORRECTION3_MUTATION_COMMAND =
  "corepack prepare pnpm@latest --activate";
export const CORRECTION3_MUTATION_WHEN =
  "correction 3, while LOCATING a pnpm executable, BEFORE the first pnpm measurement";
export const SCOPED_INSPECTION_NOTE =
  "SCOPED metadata check of the already-known Corepack tracked paths only, before and after this generation's probes; it proves exactly what it inspected and nothing global — the no-mutation statement remains an attestation (globalHostStateClaim), not universal proof";
export const RETAINED_C4_MECHANISM =
  "RETAINED correction-4 observation; the resolved path was NOT measured by that record and is represented as unmeasured; NOT rerun in later corrections";

/**
 * This frozen audit package's exact measured outputs. A regeneration
 * observing anything else is a CHANGED environment: generation stops and
 * a new explicit audit update is required — the package is never
 * silently rewritten.
 */
export const FROZEN_AUDIT_PACKAGE_VERSIONS = {
  "codex-fallback-pnpm": "11.19.0",
  "corepack-program-version": "0.34.2",
} as const;

/** Stable per-probe bindings: kind, exact command identity, mechanism enum. */
type ProbeBinding =
  | { kind: "path_lookup"; lookupName: string; mechanism: string }
  | { kind: "explicit_path"; path: string; mechanism: string }
  | { kind: "retained" };
export const PROBE_BINDINGS: Record<string, ProbeBinding> = {
  "claude-shell-pnpm": {
    kind: "path_lookup",
    lookupName: "pnpm",
    mechanism:
      "POSIX `command -v` on the generator shell PATH; on success the resolved binary is executed DIRECTLY (no alias, no Corepack shim activation, no installation)",
  },
  "codex-fallback-pnpm": {
    kind: "explicit_path",
    path: CODEX_FALLBACK_PNPM_PATH,
    mechanism:
      "explicit absolute path (the executable Codex's own PATH resolves): fs existence observation, then direct spawn — no shell, no package-manager resolution layer",
  },
  "corepack-program-version": {
    kind: "path_lookup",
    lookupName: "corepack",
    mechanism:
      "POSIX `command -v corepack`, then direct spawn of the resolved binary; `--version` prints Corepack's OWN program version and performs no package-manager resolution (cache-safe)",
  },
  "corepack-pnpm-retained-c4": { kind: "retained" },
};

/** The one retained correction-4 record: ONLY its proven facts, closed. */
export const RETAINED_C4_PROBE: RetainedC4ProbeShape = Object.freeze({
  probeId: "corepack-pnpm-retained-c4",
  resolutionKind: "retained",
  command: "corepack pnpm --version",
  resolutionMechanism: RETAINED_C4_MECHANISM,
  resolution: "unmeasured",
  resolvedPath: null,
  reportedVersion: "11.24.0",
  stderr: "",
  exitStatus: null,
  signal: null,
  resultClass: "retained_observation",
  observationKind: "retained",
  observedAtUtc: null,
  observationTimeCertainty: "unknown",
  cacheSafeReadOnly: "not_rerun",
}) as RetainedC4ProbeShape;

const STEP_KEYS = [
  "executable",
  "argv",
  "commandForm",
  "exitStatus",
  "signal",
  "stdout",
  "stderr",
  "spawnErrorCode",
  "spawnErrorMessage",
  "observedAtUtc",
] as const;
const EXISTENCE_KEYS = [
  "path",
  "exists",
  "observationErrorCode",
  "observationErrorMessage",
  "observedAtUtc",
] as const;
const ROOT_KEYS = [
  "presentTenseProbes",
  "correction3CorepackMutation",
  "earlierRetainedStagesRuntime",
  "correction5ProhibitedMutationCommandExecuted",
  "corepackTrackedStateChanged",
  "corepackScopedInspection",
  "globalHostStateClaim",
] as const;
const MUTATION_KEYS = [
  "occurred",
  "command",
  "when",
  "restored",
  "preMutationValue",
] as const;
const INSPECTION_KEYS = ["inspectedPaths", "changed", "scopeNote"] as const;
const INSPECTED_ENTRY_KEYS = ["path", "beforeMtime", "afterMtime"] as const;

const RESULT_CLASSES: readonly string[] = [
  "version_reported",
  "not_found",
  "resolver_error",
  "execution_error",
  "retained_observation",
];
const OBSERVATION_KINDS: readonly string[] = ["present_tense", "retained"];
const TRI_STATES: readonly string[] = ["true", "false", "unknown"];

function fail(message: string): never {
  throw new Error(`pnpm provenance contract refused: ${message}`);
}

/**
 * Strict ISO-8601 UTC instant that is a REAL calendar instant: regex shape
 * plus a deterministic component round-trip (Date.parse alone normalizes
 * impossible dates such as 2026-02-31, which must be REJECTED).
 */
const STRICT_ISO_UTC =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
export function isStrictIsoUtc(value: string): boolean {
  const match = STRICT_ISO_UTC.exec(value);
  if (!match) return false;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const h = Number(match[4]);
  const mi = Number(match[5]);
  const s = Number(match[6]);
  const ms = match[7] ? Number(match[7].slice(0, 3).padEnd(3, "0")) : 0;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s &&
    date.getUTCMilliseconds() === ms
  );
}

/**
 * Unknown-dominant tri-state: ANY required mtime null/unknown => "unknown";
 * otherwise any differing pair => "true"; otherwise "false".
 */
export function deriveScopedChange(
  inspectedPaths: Array<{ beforeMtime: string | null; afterMtime: string | null }>,
): TriState {
  for (const entry of inspectedPaths) {
    if (entry.beforeMtime === null || entry.afterMtime === null) return "unknown";
  }
  for (const entry of inspectedPaths) {
    if (entry.beforeMtime !== entry.afterMtime) return "true";
  }
  return "false";
}

/** Raw spawn result as data — the pure builders' only spawn input shape. */
export interface RawSpawnResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  errorCode: string | null;
  errorMessage: string | null;
}

/** The tagged measurement core the canonical derivation consumes. */
export type ProbeMeasurement =
  | {
      kind: "path_lookup";
      probeId: string;
      resolutionStep: ExecutedStep;
      directExecutionStep: ExecutedStep | null;
    }
  | {
      kind: "explicit_path";
      probeId: string;
      existenceObservation: ExistenceObservation;
      directExecutionStep: ExecutedStep | null;
    }
  | { kind: "retained"; probeId: string };

export function renderCommandForm(executable: string, argv: string[]): string {
  return `${executable} ${argv.join(" ")}`.trim();
}

function sortedKeys(value: object): string {
  return JSON.stringify(Object.keys(value).sort());
}

function assertExactKeys(
  context: string,
  value: object,
  keys: readonly string[],
): void {
  if (sortedKeys(value) !== JSON.stringify([...keys].sort()))
    fail(
      `${context}: keys must be exactly [${[...keys].sort().join(", ")}] (got [${Object.keys(
        value,
      )
        .sort()
        .join(", ")}])`,
    );
}

type StepOutcome = "exited" | "signaled" | "spawn_error";

/**
 * Exact measurement tuple invariants. Exactly one coherent outcome is
 * allowed: exited (integer status ≥ 0, null signal, null spawn-error
 * pair), signaled (null status, non-empty signal, null pair), or
 * spawn_error (null status, null signal, non-empty pair). commandForm is
 * DERIVED — an invented one fails.
 */
export function validateExecutedStep(
  context: string,
  step: ExecutedStep,
): StepOutcome {
  if (step === null || typeof step !== "object" || Array.isArray(step))
    fail(`${context}: step must be an object`);
  assertExactKeys(`${context} step`, step, STEP_KEYS);
  if (typeof step.executable !== "string" || step.executable.length === 0)
    fail(`${context}: step needs a non-empty executable`);
  if (!Array.isArray(step.argv) || step.argv.some((a) => typeof a !== "string"))
    fail(`${context}: step argv must be a string array`);
  if (
    typeof step.commandForm !== "string" ||
    step.commandForm !== renderCommandForm(step.executable, step.argv)
  )
    fail(`${context}: step commandForm must render exactly from executable+argv`);
  if (
    step.exitStatus !== null &&
    (typeof step.exitStatus !== "number" ||
      !Number.isInteger(step.exitStatus) ||
      step.exitStatus < 0)
  )
    fail(`${context}: step exitStatus must be null or a non-negative integer`);
  if (step.signal !== null && (typeof step.signal !== "string" || step.signal.length === 0))
    fail(`${context}: step signal must be null or a non-empty string`);
  if (typeof step.stdout !== "string" || typeof step.stderr !== "string")
    fail(`${context}: step stdout/stderr must be strings`);
  const codeNull = step.spawnErrorCode === null;
  const messageNull = step.spawnErrorMessage === null;
  if (
    codeNull !== messageNull ||
    (!codeNull &&
      (typeof step.spawnErrorCode !== "string" ||
        step.spawnErrorCode.length === 0 ||
        typeof step.spawnErrorMessage !== "string" ||
        step.spawnErrorMessage.length === 0))
  )
    fail(
      `${context}: spawnErrorCode and spawnErrorMessage must be BOTH null or BOTH non-empty strings`,
    );
  if (typeof step.observedAtUtc !== "string" || !isStrictIsoUtc(step.observedAtUtc))
    fail(`${context}: step observedAtUtc must be a strict calendar-valid UTC instant`);
  // Outcome coherence — exactly one of three.
  if (!codeNull) {
    if (step.exitStatus !== null || step.signal !== null)
      fail(
        `${context}: incoherent measurement tuple — a spawn-error outcome requires null exitStatus and null signal`,
      );
    return "spawn_error";
  }
  if (step.signal !== null) {
    if (step.exitStatus !== null)
      fail(
        `${context}: incoherent measurement tuple — a signaled outcome requires null exitStatus and a null spawn-error pair`,
      );
    return "signaled";
  }
  if (step.exitStatus === null)
    fail(
      `${context}: incoherent measurement tuple — null exitStatus with null signal and no spawn error is not a coherent outcome`,
    );
  return "exited";
}

function isSingleCleanAbsolutePath(candidate: string): boolean {
  return (
    candidate.length > 0 &&
    candidate.startsWith("/") &&
    !/[\s\u0000]/.test(candidate)
  );
}

type ResolverClassification =
  | { state: "resolved"; path: string }
  | { state: "not_found" }
  | { state: "resolver_error" };

function classifyResolverCore(
  probeId: string,
  outcome: StepOutcome,
  exitStatus: number | null,
  stdout: string,
  stderr: string,
): ResolverClassification {
  if (outcome === "spawn_error" || outcome === "signaled")
    return { state: "resolver_error" };
  if (exitStatus === 0) {
    const trimmed = stdout.trim();
    if (stderr !== "" || !isSingleCleanAbsolutePath(trimmed))
      fail(
        `${probeId}: resolver exit 0 with malformed output is an INVALID measurement (exactly one newline-free, whitespace-free, NUL-free absolute POSIX path and empty stderr are required) — refused, never converted to not_found`,
      );
    return { state: "resolved", path: trimmed };
  }
  if (stdout.trim() !== "" || stderr !== "")
    fail(
      `${probeId}: resolver nonzero exit with non-empty stdout/stderr is an INVALID measurement — refused, never converted to not_found`,
    );
  return { state: "not_found" };
}

/** Raw-level resolver classification for the generator's branch decision. */
export function classifyRawResolverOutcome(
  probeId: string,
  raw: RawSpawnResult,
): ResolverClassification {
  const codeNull = raw.errorCode === null;
  let outcome: StepOutcome;
  if (!codeNull) outcome = "spawn_error";
  else if (raw.signal !== null) outcome = "signaled";
  else if (raw.status === null)
    fail(
      `${probeId}: incoherent measurement tuple — null exitStatus with null signal and no spawn error is not a coherent outcome`,
    );
  else outcome = "exited";
  return classifyResolverCore(probeId, outcome, raw.status, raw.stdout, raw.stderr);
}

const ANCHORED_VERSION_STDOUT = /^(\d+\.\d+\.\d+)\n?$/;

function classifyDirect(
  step: ExecutedStep,
  outcome: StepOutcome,
): { resultClass: "version_reported" | "execution_error"; version: string | null } {
  if (
    outcome === "exited" &&
    step.exitStatus === 0 &&
    step.stderr === "" &&
    ANCHORED_VERSION_STDOUT.test(step.stdout)
  )
    return { resultClass: "version_reported", version: step.stdout.trim() };
  return { resultClass: "execution_error", version: null };
}

function normalizeStep(step: ExecutedStep): ExecutedStep {
  return {
    executable: step.executable,
    argv: [...step.argv],
    commandForm: renderCommandForm(step.executable, step.argv),
    exitStatus: step.exitStatus,
    signal: step.signal,
    stdout: step.stdout,
    stderr: step.stderr,
    spawnErrorCode: step.spawnErrorCode,
    spawnErrorMessage: step.spawnErrorMessage,
    observedAtUtc: step.observedAtUtc,
  };
}

function validateExistenceObservation(
  probeId: string,
  binding: { path: string },
  obs: ExistenceObservation,
): void {
  if (obs === null || typeof obs !== "object" || Array.isArray(obs))
    fail(`${probeId}: existenceObservation must be an object`);
  assertExactKeys(`${probeId} existenceObservation`, obs, EXISTENCE_KEYS);
  if (obs.path !== binding.path)
    fail(
      `${probeId}: existenceObservation.path must be exactly the frozen fallback path ${binding.path}`,
    );
  if (obs.exists !== true && obs.exists !== false && obs.exists !== null)
    fail(`${probeId}: existenceObservation.exists must be true, false, or null`);
  const codeNull = obs.observationErrorCode === null;
  const messageNull = obs.observationErrorMessage === null;
  if (obs.exists !== null) {
    if (!codeNull || !messageNull)
      fail(
        `${probeId}: existenceObservation with boolean exists must carry a null observation-error pair`,
      );
  } else if (
    codeNull ||
    messageNull ||
    typeof obs.observationErrorCode !== "string" ||
    obs.observationErrorCode.length === 0 ||
    typeof obs.observationErrorMessage !== "string" ||
    obs.observationErrorMessage.length === 0
  )
    fail(
      `${probeId}: an errored existence observation (exists null) requires a coherent non-empty observation-error code+message pair`,
    );
  if (typeof obs.observedAtUtc !== "string" || !isStrictIsoUtc(obs.observedAtUtc))
    fail(
      `${probeId}: existenceObservation.observedAtUtc must be a strict calendar-valid UTC instant`,
    );
}

function assertDirectStepBinding(
  probeId: string,
  direct: ExecutedStep,
  expectedExecutable: string,
  executableRule: string,
  earlierTimeUtc: string,
): StepOutcome {
  const outcome = validateExecutedStep(`${probeId}: directExecution`, direct);
  if (direct.executable !== expectedExecutable) fail(`${probeId}: ${executableRule}`);
  if (direct.argv.length !== 1 || direct.argv[0] !== "--version")
    fail(`${probeId}: direct execution argv must be exactly ['--version']`);
  if (Date.parse(direct.observedAtUtc) < Date.parse(earlierTimeUtc))
    fail(
      `${probeId}: the direct execution time may not precede the resolver/existence observation time`,
    );
  return outcome;
}

/**
 * THE canonical state transition: strictly validated tagged measurements
 * in, the complete canonical serialized probe out. Both the builders and
 * the validator run every probe through this one function.
 */
export function deriveCanonicalProbe(measurement: ProbeMeasurement): ProvenanceProbe {
  const binding = PROBE_BINDINGS[measurement.probeId];
  if (!binding) fail(`unknown probe id ${measurement.probeId}`);
  if (binding.kind !== measurement.kind)
    fail(
      `${measurement.probeId}: resolutionKind must be ${binding.kind} (got ${measurement.kind})`,
    );

  if (measurement.kind === "retained")
    return JSON.parse(JSON.stringify(RETAINED_C4_PROBE)) as RetainedC4ProbeShape;

  if (measurement.kind === "path_lookup") {
    const lookupBinding = binding as { kind: "path_lookup"; lookupName: string; mechanism: string };
    const step = measurement.resolutionStep;
    const outcome = validateExecutedStep(`${measurement.probeId}: resolution`, step);
    if (
      step.executable !== "bash" ||
      step.argv.length !== 2 ||
      step.argv[0] !== "-lc" ||
      step.argv[1] !== `command -v ${lookupBinding.lookupName}`
    )
      fail(
        `${measurement.probeId}: resolver must be exactly bash -lc 'command -v ${lookupBinding.lookupName}'`,
      );
    const classification = classifyResolverCore(
      measurement.probeId,
      outcome,
      step.exitStatus,
      step.stdout,
      step.stderr,
    );
    if (classification.state !== "resolved") {
      if (measurement.directExecutionStep !== null)
        fail(`${measurement.probeId}: failed resolution must NOT carry a direct execution`);
      const errored = classification.state === "resolver_error";
      return {
        probeId: measurement.probeId,
        command: `command -v ${lookupBinding.lookupName}  (version NOT executed — resolution ${errored ? "errored" : "failed"})`,
        resolutionMechanism: lookupBinding.mechanism,
        resolutionKind: "path_lookup",
        resolutionStep: normalizeStep(step),
        resolution: "unresolved",
        resolvedPath: null,
        directExecutionStep: null,
        reportedVersion: null,
        resultClass: errored ? "resolver_error" : "not_found",
        observationKind: "present_tense",
        observedAtUtc: step.observedAtUtc,
        observationTimeCertainty: "exact",
        cacheSafeReadOnly: true,
      };
    }
    const direct = measurement.directExecutionStep;
    if (direct === null)
      fail(`${measurement.probeId}: resolved requires the direct execution step`);
    const directOutcome = assertDirectStepBinding(
      measurement.probeId,
      direct,
      classification.path,
      "the executed binary must be exactly the resolved path",
      step.observedAtUtc,
    );
    const directClass = classifyDirect(direct, directOutcome);
    return {
      probeId: measurement.probeId,
      command: `command -v ${lookupBinding.lookupName}  →  ${classification.path} --version`,
      resolutionMechanism: lookupBinding.mechanism,
      resolutionKind: "path_lookup",
      resolutionStep: normalizeStep(step),
      resolution: "resolved",
      resolvedPath: classification.path,
      directExecutionStep: normalizeStep(direct),
      reportedVersion: directClass.version,
      resultClass: directClass.resultClass,
      observationKind: "present_tense",
      observedAtUtc: direct.observedAtUtc,
      observationTimeCertainty: "exact",
      cacheSafeReadOnly: true,
    };
  }

  // explicit_path
  const pathBinding = binding as { kind: "explicit_path"; path: string; mechanism: string };
  const obs = measurement.existenceObservation;
  validateExistenceObservation(measurement.probeId, pathBinding, obs);
  const normalizedObs: ExistenceObservation = {
    path: obs.path,
    exists: obs.exists,
    observationErrorCode: obs.observationErrorCode,
    observationErrorMessage: obs.observationErrorMessage,
    observedAtUtc: obs.observedAtUtc,
  };
  if (obs.exists === true) {
    const direct = measurement.directExecutionStep;
    if (direct === null)
      fail(`${measurement.probeId}: resolved requires the direct execution step`);
    const directOutcome = assertDirectStepBinding(
      measurement.probeId,
      direct,
      pathBinding.path,
      `the executed binary must be exactly the frozen fallback path ${pathBinding.path}`,
      obs.observedAtUtc,
    );
    const directClass = classifyDirect(direct, directOutcome);
    return {
      probeId: measurement.probeId,
      command: `${pathBinding.path} --version`,
      resolutionMechanism: pathBinding.mechanism,
      resolutionKind: "explicit_path",
      existenceObservation: normalizedObs,
      resolution: "resolved",
      resolvedPath: pathBinding.path,
      directExecutionStep: normalizeStep(direct),
      reportedVersion: directClass.version,
      resultClass: directClass.resultClass,
      observationKind: "present_tense",
      observedAtUtc: direct.observedAtUtc,
      observationTimeCertainty: "exact",
      cacheSafeReadOnly: true,
    };
  }
  if (measurement.directExecutionStep !== null)
    fail(
      obs.exists === false
        ? `${measurement.probeId}: an absent explicit path must NOT carry an invented execution`
        : `${measurement.probeId}: an errored existence observation must NOT carry an invented execution`,
    );
  const observationErrored = obs.exists === null;
  return {
    probeId: measurement.probeId,
    command: observationErrored
      ? `${pathBinding.path} --version (NOT executed — existence observation errored)`
      : `${pathBinding.path} --version (NOT executed — path absent)`,
    resolutionMechanism: pathBinding.mechanism,
    resolutionKind: "explicit_path",
    existenceObservation: normalizedObs,
    resolution: "unresolved",
    resolvedPath: null,
    directExecutionStep: null,
    reportedVersion: null,
    resultClass: observationErrored ? "resolver_error" : "not_found",
    observationKind: "present_tense",
    observedAtUtc: obs.observedAtUtc,
    observationTimeCertainty: "exact",
    cacheSafeReadOnly: true,
  };
}

function toStep(input: {
  executable: string;
  argv: string[];
  raw: RawSpawnResult;
  observedAtUtc: string;
}): ExecutedStep {
  return {
    executable: input.executable,
    argv: [...input.argv],
    commandForm: renderCommandForm(input.executable, input.argv),
    exitStatus: input.raw.status,
    signal: input.raw.signal,
    stdout: input.raw.stdout,
    stderr: input.raw.stderr,
    spawnErrorCode: input.raw.errorCode,
    spawnErrorMessage: input.raw.errorMessage,
    observedAtUtc: input.observedAtUtc,
  };
}

/**
 * PURE builder — `command -v <name>` path-lookup probe through the
 * canonical derivation. `directRaw` must be provided iff the resolver
 * measurement classifies as resolved; the builder enforces the branch
 * contract before deriving.
 */
export function buildPathLookupProbe(input: {
  probeId: string;
  lookupRaw: RawSpawnResult;
  lookupObservedAtUtc: string;
  directRaw: RawSpawnResult | null;
  directObservedAtUtc: string | null;
}): ProvenanceProbe {
  const binding = PROBE_BINDINGS[input.probeId];
  if (!binding || binding.kind !== "path_lookup")
    fail(`${input.probeId} is not a path_lookup probe`);
  const step = toStep({
    executable: "bash",
    argv: ["-lc", `command -v ${binding.lookupName}`],
    raw: input.lookupRaw,
    observedAtUtc: input.lookupObservedAtUtc,
  });
  const classification = classifyRawResolverOutcome(input.probeId, input.lookupRaw);
  if (classification.state === "resolved") {
    if (!input.directRaw || !input.directObservedAtUtc)
      throw new Error(
        `${input.probeId}: successful resolution requires the direct execution measurement`,
      );
    return deriveCanonicalProbe({
      kind: "path_lookup",
      probeId: input.probeId,
      resolutionStep: step,
      directExecutionStep: toStep({
        executable: classification.path,
        argv: ["--version"],
        raw: input.directRaw,
        observedAtUtc: input.directObservedAtUtc,
      }),
    });
  }
  if (input.directRaw !== null)
    throw new Error(
      `${input.probeId}: failed resolution must NOT carry a direct execution`,
    );
  return deriveCanonicalProbe({
    kind: "path_lookup",
    probeId: input.probeId,
    resolutionStep: step,
    directExecutionStep: null,
  });
}

/** PURE builder — explicit-absolute-path probe through the derivation. */
export function buildExplicitPathProbe(input: {
  probeId: string;
  pathExists: boolean | null;
  observationErrorCode?: string | null;
  observationErrorMessage?: string | null;
  existenceObservedAtUtc: string;
  directRaw: RawSpawnResult | null;
  directObservedAtUtc: string | null;
}): ProvenanceProbe {
  const binding = PROBE_BINDINGS[input.probeId];
  if (!binding || binding.kind !== "explicit_path")
    fail(`${input.probeId} is not an explicit_path probe`);
  const observation: ExistenceObservation = {
    path: binding.path,
    exists: input.pathExists,
    observationErrorCode: input.observationErrorCode ?? null,
    observationErrorMessage: input.observationErrorMessage ?? null,
    observedAtUtc: input.existenceObservedAtUtc,
  };
  if (input.pathExists === true) {
    if (!input.directRaw || !input.directObservedAtUtc)
      throw new Error(
        `${input.probeId}: an existing explicit path requires the direct execution measurement`,
      );
    return deriveCanonicalProbe({
      kind: "explicit_path",
      probeId: input.probeId,
      existenceObservation: observation,
      directExecutionStep: toStep({
        executable: binding.path,
        argv: ["--version"],
        raw: input.directRaw,
        observedAtUtc: input.directObservedAtUtc,
      }),
    });
  }
  if (input.directRaw !== null)
    throw new Error(
      input.pathExists === false
        ? `${input.probeId}: an absent explicit path must NOT carry an invented execution`
        : `${input.probeId}: an errored existence observation must NOT carry an invented execution`,
    );
  return deriveCanonicalProbe({
    kind: "explicit_path",
    probeId: input.probeId,
    existenceObservation: observation,
    directExecutionStep: null,
  });
}

/** The one retained correction-4 observation, exactly its proven facts. */
export function buildRetainedC4Probe(): ProvenanceProbe {
  return deriveCanonicalProbe({
    kind: "retained",
    probeId: "corepack-pnpm-retained-c4",
  });
}

type Diff = { path: string; canonical: unknown; serialized: unknown };
function deepDiff(canonical: unknown, serialized: unknown, path: string): Diff | null {
  if (canonical === serialized) return null;
  if (Array.isArray(canonical) && Array.isArray(serialized)) {
    if (canonical.length !== serialized.length)
      return { path: `${path}.length`, canonical: canonical.length, serialized: serialized.length };
    for (let index = 0; index < canonical.length; index += 1) {
      const diff = deepDiff(canonical[index], serialized[index], `${path}[${index}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (
    canonical !== null &&
    serialized !== null &&
    typeof canonical === "object" &&
    typeof serialized === "object" &&
    !Array.isArray(canonical) &&
    !Array.isArray(serialized)
  ) {
    const canonicalKeys = sortedKeys(canonical);
    const serializedKeys = sortedKeys(serialized);
    if (canonicalKeys !== serializedKeys)
      return { path: `${path}{keys}`, canonical: canonicalKeys, serialized: serializedKeys };
    for (const key of Object.keys(canonical)) {
      const diff = deepDiff(
        (canonical as Record<string, unknown>)[key],
        (serialized as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
      if (diff) return diff;
    }
    return null;
  }
  return { path, canonical, serialized };
}

/**
 * Validate ONE serialized probe by recomputing the canonical state from
 * its tagged measurements and deep-comparing (exact key sets at every
 * level). A short pre-pass produces the established diagnostic messages
 * for common contradictions; everything else is caught by the canonical
 * deep comparison — there is no looser independent path.
 */
export function validateProbe(serialized: unknown): ProvenanceProbe {
  if (serialized === null || typeof serialized !== "object" || Array.isArray(serialized))
    fail("probe must be an object");
  const probe = serialized as Record<string, unknown>;
  const probeId = String(probe.probeId);
  const binding = PROBE_BINDINGS[probeId];
  if (!binding) fail(`unknown probe id ${probeId}`);
  if (probe.resolutionKind !== binding.kind)
    fail(`${probeId}: resolutionKind must be ${binding.kind}`);

  // Pre-pass: established diagnostics for common contradictions.
  if (!RESULT_CLASSES.includes(String(probe.resultClass)))
    fail(`${probeId}: bad resultClass ${String(probe.resultClass)}`);
  if (!OBSERVATION_KINDS.includes(String(probe.observationKind)))
    fail(`${probeId}: bad observationKind`);
  if (
    probe.resolution !== "resolved" &&
    probe.resolution !== "unresolved" &&
    probe.resolution !== "unmeasured"
  )
    fail(`${probeId}: bad resolution`);
  if (
    probe.observationTimeCertainty !== "exact" &&
    probe.observationTimeCertainty !== "unknown"
  )
    fail(`${probeId}: bad observationTimeCertainty`);
  if (
    probe.cacheSafeReadOnly !== true &&
    probe.cacheSafeReadOnly !== false &&
    probe.cacheSafeReadOnly !== "not_rerun"
  )
    fail(`${probeId}: bad cacheSafeReadOnly`);
  if (probe.observedAtUtc === null) {
    if (probe.observationKind === "present_tense")
      fail(`${probeId}: present-tense observations require a concrete timestamp`);
    if (probe.observationKind !== "retained" || probe.observationTimeCertainty !== "unknown")
      fail(
        `${probeId}: null observedAtUtc requires a retained observation with time certainty 'unknown'`,
      );
  } else {
    if (typeof probe.observedAtUtc !== "string" || !isStrictIsoUtc(probe.observedAtUtc))
      fail(
        `${probeId}: observedAtUtc must be a strict calendar-valid ISO-8601 UTC instant`,
      );
    if (probe.observationTimeCertainty !== "exact")
      fail(`${probeId}: a concrete observedAtUtc requires time certainty 'exact'`);
  }
  if (probe.resolution === "unmeasured" && probe.resultClass !== "retained_observation")
    fail(`${probeId}: 'unmeasured' is only for retained observations`);
  if (probe.resolution === "resolved") {
    if (
      typeof probe.resolvedPath !== "string" ||
      probe.resolvedPath.length === 0 ||
      !probe.resolvedPath.startsWith("/")
    )
      fail(`${probeId}: resolved requires a non-empty absolute resolvedPath`);
  } else if (probe.resolvedPath !== null) {
    fail(`${probeId}: ${String(probe.resolution)} requires resolvedPath null`);
  }
  if (probe.resolution !== "resolved" && probe.directExecutionStep)
    fail(`${probeId}: a non-resolved probe must not carry a direct execution`);
  if (probe.resultClass === "version_reported" && probe.resolution !== "resolved")
    fail(`${probeId}: version_reported requires resolution 'resolved'`);
  if (binding.kind === "path_lookup" && probe.resultClass === "not_found") {
    const lookup = probe.resolutionStep as Record<string, unknown> | null;
    if (
      lookup &&
      typeof lookup === "object" &&
      lookup.exitStatus === 0 &&
      typeof lookup.stdout === "string" &&
      lookup.stdout.trim().startsWith("/")
    )
      fail(
        `${probeId}: not_found contradicts a successful resolver (exit 0 with an absolute path in stdout)`,
      );
  }

  // Extraction of the tagged measurements.
  let measurement: ProbeMeasurement;
  if (binding.kind === "retained") {
    measurement = { kind: "retained", probeId };
  } else if (binding.kind === "path_lookup") {
    if (
      probe.resolutionStep === null ||
      typeof probe.resolutionStep !== "object" ||
      Array.isArray(probe.resolutionStep)
    )
      fail(`${probeId}: path_lookup requires the resolver measurement`);
    measurement = {
      kind: "path_lookup",
      probeId,
      resolutionStep: probe.resolutionStep as ExecutedStep,
      directExecutionStep:
        probe.directExecutionStep === null || probe.directExecutionStep === undefined
          ? null
          : (probe.directExecutionStep as ExecutedStep),
    };
  } else {
    if (
      probe.existenceObservation === null ||
      probe.existenceObservation === undefined ||
      typeof probe.existenceObservation !== "object" ||
      Array.isArray(probe.existenceObservation)
    )
      fail(`${probeId}: explicit_path requires the existence observation`);
    measurement = {
      kind: "explicit_path",
      probeId,
      existenceObservation: probe.existenceObservation as ExistenceObservation,
      directExecutionStep:
        probe.directExecutionStep === null || probe.directExecutionStep === undefined
          ? null
          : (probe.directExecutionStep as ExecutedStep),
    };
  }

  const canonical = deriveCanonicalProbe(measurement);
  const diff = deepDiff(canonical, serialized, "$");
  if (diff !== null) {
    if (binding.kind === "retained")
      fail(
        `corepack-pnpm-retained-c4 must carry EXACTLY the correction-4 proven facts — serialized diverges from the canonical retained object at ${diff.path} (serialized=${JSON.stringify(diff.serialized)} canonical=${JSON.stringify(diff.canonical)})`,
      );
    fail(
      `${probeId}: serialized probe diverges from the canonical derivation at ${diff.path} (serialized=${JSON.stringify(diff.serialized)} canonical=${JSON.stringify(diff.canonical)})`,
    );
  }
  return serialized as ProvenanceProbe;
}

/**
 * Fail-closed ledger-level validation: exact root/mutation/inspection
 * key sets, the canonical per-probe recomputation, and this frozen audit
 * package's exact outcome bindings. Returns the input on success.
 */
export function validatePnpmProvenance(input: PnpmProvenance): PnpmProvenance {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail("pnpm provenance must be an object");
  assertExactKeys("pnpm provenance root", input, ROOT_KEYS);
  const probes = input.presentTenseProbes;
  if (!Array.isArray(probes)) fail("presentTenseProbes is not an array");
  const ids = probes.map((probe) => (probe as { probeId: string }).probeId);
  for (const required of REQUIRED_PROBE_IDS) {
    if (!ids.includes(required)) fail(`missing required probe ${required}`);
  }
  if (new Set(ids).size !== ids.length) fail("duplicate probe ids");
  if (ids.length !== REQUIRED_PROBE_IDS.length)
    fail(`unexpected extra probes: ${ids.join(",")}`);
  for (const probe of probes) validateProbe(probe);

  // ── Frozen audit-package outcome bindings ─────────────────────────────
  const byId = new Map(probes.map((probe) => [probe.probeId, probe]));
  const claudeShell = byId.get("claude-shell-pnpm")!;
  if (claudeShell.resultClass !== "not_found" || claudeShell.resolution !== "unresolved")
    fail(
      "claude-shell-pnpm: this frozen audit package binds the current faithfully measured outcome (unresolved not_found resolver) — a changed PATH resolution must stop generation and be introduced by an explicit new audit update, not silently rewritten",
    );
  for (const [frozenId, frozenVersion] of Object.entries(FROZEN_AUDIT_PACKAGE_VERSIONS)) {
    const probe = byId.get(frozenId)!;
    if (probe.resultClass !== "version_reported" || probe.reportedVersion !== frozenVersion)
      fail(
        `${frozenId}: this frozen audit package requires resultClass version_reported with reportedVersion exactly '${frozenVersion}' — a changed tool version must stop generation and be introduced by an explicit new audit update, not silently rewritten`,
      );
  }

  // ── Scoped Corepack inspection: exact tracked paths + strict mtimes ───
  const inspection = input.corepackScopedInspection;
  if (inspection === null || typeof inspection !== "object" || Array.isArray(inspection))
    fail("corepackScopedInspection must be an object");
  assertExactKeys("corepackScopedInspection", inspection, INSPECTION_KEYS);
  if (!Array.isArray(inspection.inspectedPaths))
    fail("corepackScopedInspection.inspectedPaths required");
  const paths = inspection.inspectedPaths.map((entry) => entry.path);
  if (paths.length !== COREPACK_TRACKED_PATHS.length)
    fail(
      `corepackScopedInspection must contain exactly the ${COREPACK_TRACKED_PATHS.length} frozen tracked paths (found ${paths.length})`,
    );
  if (new Set(paths).size !== paths.length)
    fail("corepackScopedInspection has duplicate paths");
  for (const tracked of COREPACK_TRACKED_PATHS) {
    if (!paths.includes(tracked))
      fail(`corepackScopedInspection is missing the frozen tracked path ${tracked}`);
  }
  for (const entry of inspection.inspectedPaths) {
    assertExactKeys("corepackScopedInspection entry", entry, INSPECTED_ENTRY_KEYS);
    for (const [label, value] of [
      ["beforeMtime", entry.beforeMtime],
      ["afterMtime", entry.afterMtime],
    ] as const) {
      if (value !== null && (typeof value !== "string" || !isStrictIsoUtc(value)))
        fail(
          `corepackScopedInspection ${entry.path} ${label} is not a strict calendar-valid UTC instant`,
        );
    }
  }
  const derived = deriveScopedChange(inspection.inspectedPaths);
  if (inspection.changed !== derived)
    fail(
      `corepackScopedInspection.changed='${String(inspection.changed)}' contradicts the value derived from its own before/after mtimes ('${derived}')`,
    );
  if (inspection.scopeNote !== SCOPED_INSPECTION_NOTE)
    fail("corepackScopedInspection.scopeNote must be exactly the frozen scope note");
  if (input.corepackTrackedStateChanged !== inspection.changed)
    fail("corepackTrackedStateChanged must equal corepackScopedInspection.changed exactly");

  // ── Structured conclusions: exact keys, exact frozen values ───────────
  const mutation = input.correction3CorepackMutation;
  if (mutation === null || typeof mutation !== "object" || Array.isArray(mutation))
    fail("correction3CorepackMutation must be an object");
  assertExactKeys("correction3CorepackMutation", mutation, MUTATION_KEYS);
  if (mutation.occurred !== true) fail("correction3CorepackMutation.occurred must be true");
  if (mutation.command !== CORRECTION3_MUTATION_COMMAND)
    fail(
      `correction3CorepackMutation.command must be exactly '${CORRECTION3_MUTATION_COMMAND}'`,
    );
  if (mutation.when !== CORRECTION3_MUTATION_WHEN)
    fail("correction3CorepackMutation.when must be exactly the frozen disclosure text");
  if (mutation.restored !== false) fail("correction3CorepackMutation.restored must be false");
  if (mutation.preMutationValue !== "UNKNOWN") fail("preMutationValue must be UNKNOWN");
  if (input.earlierRetainedStagesRuntime !== "UNKNOWN")
    fail("earlierRetainedStagesRuntime must be the enum UNKNOWN");
  if (input.correction5ProhibitedMutationCommandExecuted !== false)
    fail("correction5ProhibitedMutationCommandExecuted must be false");
  if (!TRI_STATES.includes(String(input.corepackTrackedStateChanged)))
    fail("corepackTrackedStateChanged must be a tri-state enum");
  if (input.globalHostStateClaim !== "attestation_only")
    fail("globalHostStateClaim must be attestation_only");
  return input;
}

/**
 * Portable-evidence path rule: repository-relative, traversal-free.
 */
export function assertPortableRepoRelativePath(path: string): string {
  if (typeof path !== "string" || path.length === 0)
    throw new Error("portable path refused: empty");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
    throw new Error(`portable path refused: absolute path ${path}`);
  if (path.split(/[\\/]/).includes(".."))
    throw new Error(`portable path refused: traversal in ${path}`);
  if (path.includes("\\"))
    throw new Error(`portable path refused: backslash in ${path}`);
  return path;
}
