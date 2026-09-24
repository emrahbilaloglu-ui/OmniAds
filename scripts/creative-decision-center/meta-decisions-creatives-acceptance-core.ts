/**
 * PURE core of the Meta Decisions -> Creatives acceptance harness.
 *
 * The CLI (`meta-decisions-creatives-acceptance.ts`) owns every database read
 * and every production call. This file owns only what can be decided from
 * values: argument parsing, the explicit-state classifiers the ledger and
 * decision lanes report through, the in-memory generation builder that turns
 * one simulated day into the rows the production read model validates, the
 * served-authority audit, and the invariant evaluator that separates
 * FAIL-OPEN / FABRICATION (violations) from expected SOURCE GAPS
 * (observations).
 *
 * It imports types, version constants and pure production helpers only. It
 * never imports the database client, the environment loader, or a module that
 * performs I/O at call time, so its tests run against an unreachable
 * DATABASE_URL.
 *
 * Nothing here is firm-specific: business ids arrive through `--business`, the
 * harness refuses to run without an explicit list, and nothing iterates all
 * businesses.
 */
import { createHash } from "node:crypto";
import path from "node:path";

import { NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR } from "@/lib/creative-decision-engine/config-values";
import type { NativeSnapshotPayloadRow } from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  META_CONFIG_FIELD_TIERS,
  readinessForConfigFieldTier,
  type MetaConfigFieldReadiness,
  type MetaConfigFieldTier,
} from "@/lib/meta/config-field-source-contract";
import {
  META_DECISIONS_AD_CANDIDATE_LIMIT,
  META_DECISIONS_AD_CANDIDATE_MAX_LIMIT,
} from "@/lib/meta/decisions-workspace-contract";
import type {
  MetaNativeDecisionGeneration,
  MetaNativeDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";

export const ACCEPTANCE_CONTRACT_VERSION =
  "meta-decisions-creatives-acceptance.v1" as const;

/** Every identifier this harness mints starts with this, and nothing else does. */
export const SYNTHETIC_ID_PREFIX = "read-only-simulation:" as const;

export const DEFAULT_ACCEPTANCE_WINDOW = {
  start: "2026-08-25",
  end: "2026-09-22",
} as const;
export const MAX_ACCEPTANCE_BUSINESSES = 4;
export const DEFAULT_CHAIN_DAYS = 2;
export const MAX_CHAIN_DAYS = 3;
/**
 * A bound on how much production history one invocation reads. The ledger
 * issues a per-day D101 slot scan and per-day config-receipt resolution; a
 * two-month bound keeps each pinned snapshot short on a live primary.
 */
export const MAX_ACCEPTANCE_WINDOW_DAYS = 62;
export const DEFAULT_AD_LIMITS: readonly number[] = [
  META_DECISIONS_AD_CANDIDATE_LIMIT,
  META_DECISIONS_AD_CANDIDATE_MAX_LIMIT,
];

/**
 * The production D101 run slots the ledger reports coverage at. The scheduler
 * starts the native decision job at about 03:0x and 15:0x UTC.
 */
export const PRODUCTION_RUN_SLOTS = ["03:05", "15:05"] as const;

/* ============================================================== arguments */

export class AcceptanceUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcceptanceUsageError";
  }
}

export interface AcceptanceChainDay {
  asOf: string;
  /**
   * Independent knowledge instant. The report day stays `asOf`; a replay may
   * evaluate that day after later source certification without backdating the
   * certification itself.
   */
  cutoff: string;
}

export interface AcceptanceArgs {
  businesses: string[];
  negativeControl: string | null;
  /** The control campaign; required with --negative-control, never hard-coded. */
  negativeControlCampaign: string | null;
  /** Any dirty loaded repo module makes the selected gate NOT MET. */
  requireClean: boolean;
  /** `hardAuthorityOutcome` not_demonstrated makes the selected gate NOT MET. */
  requireHardAuthority: boolean;
  /** How each --chain day's cutoff was chosen. */
  cutoffMode: CutoffMode;
  window: { start: string; end: string };
  chainDays: number;
  chain: AcceptanceChainDay[];
  adLimits: number[];
  outPath: string | null;
  write: boolean;
  skipDecisions: boolean;
  /** `--diagnostic` given explicitly; replay can also force diagnostic mode. */
  diagnostic: boolean;
  /**
   * `release` is the only mode that can PASS. `--skip-decisions` or
   * `--diagnostic` or `--knowledge-cutoffs` make the run a diagnostic: it reports, it can surface
   * violations, and it can never produce release success.
   */
  mode: AcceptanceMode;
  /** The gate the EXIT CODE follows; the report always carries both. */
  gate: ReleaseGate;
}

export type AcceptanceMode = "release" | "diagnostic";

/**
 * pre_deploy   HEAD's code is proven on production data before it ships: the
 *              simulated days and presentations must succeed, and the served
 *              path may still be on the previously deployed epoch (the ONLY
 *              acceptable unavailable reason is native_latest_job_engine_mismatch,
 *              and then that epoch's latest run must itself be a complete
 *              success).
 * post_deploy  everything above, and the persisted-served path must return an
 *              AVAILABLE, non-degraded generation in HEAD's epoch for every
 *              selected account.
 */
export type ReleaseGate = "pre_deploy" | "post_deploy";
export const RELEASE_GATES: readonly ReleaseGate[] = ["pre_deploy", "post_deploy"];
export const DEFAULT_RELEASE_GATE: ReleaseGate = "pre_deploy";
/** Before a deploy, HEAD's epoch has never run, so this is the served path's expected answer. */
export const PRE_DEPLOY_EXPECTED_UNAVAILABLE_REASON = "native_latest_job_engine_mismatch";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

const VALUE_FLAGS = new Set([
  "--business",
  "--negative-control",
  "--negative-control-campaign",
  "--cutoff-slot",
  "--cutoffs",
  "--knowledge-cutoffs",
  "--window",
  "--chain",
  "--ad-limits",
  "--out",
  "--write",
  "--gate",
]);
const BOOLEAN_FLAGS = new Set(["--skip-decisions", "--diagnostic", "--require-clean", "--require-hard-authority"]);

/**
 * end-of-day    D T23:59:59.999Z (default): after the day's final heartbeat, so the
 *               hydration receipt is usually reconstructable.
 * natural-0305  D T03:05:00.000Z and natural-1505 D T15:05:00.000Z: the production
 *               run slots. The receipt may not be reconstructable there (last_seen_at
 *               is heartbeat-advanced in place); that is reported, never repaired.
 * explicit      --cutoffs <iso,...>: one per consecutive UTC day, ending on the window end.
 * replay        --knowledge-cutoffs <iso,...>: one per chain report day; each
 *               knowledge instant may be later than its report day.
 */
export type CutoffMode = "end-of-day" | "natural-0305" | "natural-1505" | "explicit" | "replay";
export const CUTOFF_SLOTS = ["end-of-day", "natural-0305", "natural-1505"] as const;
export type CutoffSlot = (typeof CUTOFF_SLOTS)[number];
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function cutoffForDay(day: string, slot: CutoffSlot): string {
  switch (slot) {
    case "natural-0305":
      return `${day}T03:05:00.000Z`;
    case "natural-1505":
      return `${day}T15:05:00.000Z`;
    default:
      return endOfUtcDayCutoff(day);
  }
}

/**
 * The --chain days and their cutoffs. A slot derives one cutoff per day ending
 * on the window end; explicit cutoffs must be ascending, one per consecutive
 * UTC day, the last on the window end, all inside the window.
 */
export function deriveChain(input: {
  window: { start: string; end: string };
  chainDays: number;
  slot: CutoffSlot;
  explicitCutoffs: readonly string[] | null;
  knowledgeCutoffs?: readonly string[] | null;
}): AcceptanceChainDay[] {
  if (input.knowledgeCutoffs !== null && input.knowledgeCutoffs !== undefined) {
    const first = addUtcDays(input.window.end, -(input.chainDays - 1));
    if (first < input.window.start) {
      throw new AcceptanceUsageError(`--chain ${input.chainDays} starts on ${first}, before the window start ${input.window.start}.`);
    }
    const reportDays = enumerateUtcDays(first, input.window.end);
    if (input.knowledgeCutoffs.length !== reportDays.length) {
      throw new AcceptanceUsageError("--knowledge-cutoffs must name one instant per chain report day.");
    }
    return reportDays.map((asOf, index) => {
      const raw = input.knowledgeCutoffs![index]!;
      if (!ISO_INSTANT_PATTERN.test(raw) || !Number.isFinite(new Date(raw).getTime())) {
        throw new AcceptanceUsageError(`--knowledge-cutoffs entry "${raw}" is not an ISO UTC instant.`);
      }
      const cutoff = new Date(raw).toISOString();
      if (cutoff < `${asOf}T00:00:00.000Z` ||
          (index > 0 && cutoff <= new Date(input.knowledgeCutoffs![index - 1]!).toISOString())) {
        throw new AcceptanceUsageError("--knowledge-cutoffs must be at or after their report days and strictly ascending.");
      }
      return { asOf, cutoff };
    });
  }
  if (input.explicitCutoffs === null) {
    const first = addUtcDays(input.window.end, -(input.chainDays - 1));
    if (first < input.window.start) {
      throw new AcceptanceUsageError(`--chain ${input.chainDays} starts on ${first}, before the window start ${input.window.start}.`);
    }
    return enumerateUtcDays(first, input.window.end).map((asOf) => ({ asOf, cutoff: cutoffForDay(asOf, input.slot) }));
  }
  const chain: AcceptanceChainDay[] = [];
  for (const raw of input.explicitCutoffs) {
    if (!ISO_INSTANT_PATTERN.test(raw) || !Number.isFinite(new Date(raw).getTime())) {
      throw new AcceptanceUsageError(`--cutoffs entry "${raw}" is not an ISO UTC instant (YYYY-MM-DDTHH:MM:SS[.sss]Z).`);
    }
    const cutoff = new Date(raw).toISOString();
    chain.push({ asOf: cutoff.slice(0, 10), cutoff });
  }
  for (let index = 1; index < chain.length; index += 1) {
    if (chain[index]!.asOf !== addUtcDays(chain[index - 1]!.asOf, 1)) {
      throw new AcceptanceUsageError("--cutoffs must be ascending, one per consecutive UTC day.");
    }
  }
  if (chain.at(-1)!.asOf !== input.window.end) {
    throw new AcceptanceUsageError(`--cutoffs must end on the window end ${input.window.end}, got ${chain.at(-1)!.asOf}.`);
  }
  if (chain[0]!.asOf < input.window.start) {
    throw new AcceptanceUsageError(`--cutoffs start on ${chain[0]!.asOf}, before the window start ${input.window.start}.`);
  }
  return chain;
}

/**
 * Native Ad calibration is keyed to the UTC date of its computation cutoff.
 * Its source cells and decision inputs must therefore stay on the report-day
 * boundary in a later-knowledge replay. The later instant remains available
 * to the independent D101/config/creative source diagnostics, never to this
 * native decision lane or its hard-authority claims.
 */
export function nativeAdDecisionDay(
  day: AcceptanceChainDay,
  mode: CutoffMode,
): AcceptanceChainDay {
  if (mode !== "replay" || day.cutoff.slice(0, 10) === day.asOf) return day;
  return { asOf: day.asOf, cutoff: endOfUtcDayCutoff(day.asOf) };
}
const META_ENTITY_ID_PATTERN = /^\d{6,25}$/;

/** What the parser may consult about the file system; the CLI passes the real answers. */
export interface AcceptanceParseOptions {
  /** Absolute repository root; `--out` may not point inside it. */
  repoRoot?: string | null;
  /** Base for a relative `--out`. */
  cwd?: string;
  /** Whether an absolute path already exists; `--out` never overwrites. */
  pathExists?: (absolutePath: string) => boolean;
}

export function isIsoDay(value: string): boolean {
  if (!ISO_DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function addUtcDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

export function utcDayCount(start: string, end: string): number {
  return (
    Math.round(
      (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) /
        MS_PER_DAY,
    ) + 1
  );
}

export function enumerateUtcDays(start: string, end: string): string[] {
  const days: string[] = [];
  for (let day = start; day <= end; day = addUtcDays(day, 1)) days.push(day);
  return days;
}

/** The receipt-reconstructable end-of-day cutoff for an as-of day. */
export function endOfUtcDayCutoff(day: string): string {
  return `${day}T23:59:59.999Z`;
}

function parseUuid(value: string, flag: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new AcceptanceUsageError(`${flag} expects a UUID, got "${value}".`);
  }
  return normalized;
}

function parseStrictInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new AcceptanceUsageError(`${flag} expects a positive integer, got "${value}".`);
  }
  return Number(value.trim());
}

/**
 * Parses the CLI. Anything not listed is refused; every flag may appear once.
 * `--business` is REQUIRED: the harness never iterates every business.
 */
export function parseAcceptanceArgs(
  argv: readonly string[],
  now: Date = new Date(),
  options: AcceptanceParseOptions = {},
): AcceptanceArgs {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (BOOLEAN_FLAGS.has(token)) {
      if (booleans.has(token)) {
        throw new AcceptanceUsageError(`${token} was given more than once.`);
      }
      booleans.add(token);
      continue;
    }
    if (!VALUE_FLAGS.has(token)) {
      throw new AcceptanceUsageError(`Unknown argument "${token}".`);
    }
    if (values.has(token)) {
      throw new AcceptanceUsageError(`${token} was given more than once.`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim() === "") {
      throw new AcceptanceUsageError(`${token} requires a value.`);
    }
    values.set(token, value);
    index += 1;
  }

  const businessRaw = values.get("--business");
  if (businessRaw === undefined) {
    throw new AcceptanceUsageError(
      "--business <uuid,...> is required (1 to 4 ids); the harness never iterates all businesses.",
    );
  }
  const businesses = businessRaw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map((value) => parseUuid(value, "--business"));
  if (businesses.length === 0) {
    throw new AcceptanceUsageError("--business must name at least one business.");
  }
  if (businesses.length > MAX_ACCEPTANCE_BUSINESSES) {
    throw new AcceptanceUsageError(
      `--business accepts at most ${MAX_ACCEPTANCE_BUSINESSES} ids, got ${businesses.length}.`,
    );
  }
  if (new Set(businesses).size !== businesses.length) {
    throw new AcceptanceUsageError("--business lists the same id twice.");
  }

  const negativeRaw = values.get("--negative-control");
  const negativeControl =
    negativeRaw === undefined ? null : parseUuid(negativeRaw, "--negative-control");
  if (negativeControl !== null && businesses.includes(negativeControl)) {
    throw new AcceptanceUsageError(
      "--negative-control must not also be listed in --business.",
    );
  }
  const campaignRaw = values.get("--negative-control-campaign")?.trim();
  if (campaignRaw !== undefined && !META_ENTITY_ID_PATTERN.test(campaignRaw)) {
    throw new AcceptanceUsageError("--negative-control-campaign must be a numeric Meta campaign id.");
  }
  const negativeControlCampaign = campaignRaw ?? null;
  if ((negativeControl === null) !== (negativeControlCampaign === null)) {
    throw new AcceptanceUsageError(
      "--negative-control and --negative-control-campaign go together: the control names its business AND the campaign whose source gap it demonstrates.",
    );
  }

  const windowRaw = values.get("--window");
  let window: { start: string; end: string } = { ...DEFAULT_ACCEPTANCE_WINDOW };
  if (windowRaw !== undefined) {
    const parts = windowRaw.split(":");
    if (parts.length !== 2) {
      throw new AcceptanceUsageError("--window expects YYYY-MM-DD:YYYY-MM-DD.");
    }
    window = { start: parts[0]!.trim(), end: parts[1]!.trim() };
  }
  if (!isIsoDay(window.start) || !isIsoDay(window.end)) {
    throw new AcceptanceUsageError("--window days must be valid YYYY-MM-DD dates.");
  }
  if (window.start > window.end) {
    throw new AcceptanceUsageError("--window start must not be after its end.");
  }
  const todayUtc = now.toISOString().slice(0, 10);
  if (window.end > todayUtc) {
    throw new AcceptanceUsageError(
      `--window end ${window.end} is in the future; it must be a past UTC day, or today with natural cutoffs already past (today is ${todayUtc}).`,
    );
  }
  const windowDays = utcDayCount(window.start, window.end);
  if (windowDays > MAX_ACCEPTANCE_WINDOW_DAYS) {
    throw new AcceptanceUsageError(
      `--window spans ${windowDays} days; at most ${MAX_ACCEPTANCE_WINDOW_DAYS} are read per invocation.`,
    );
  }

  const slotRaw = values.get("--cutoff-slot")?.trim();
  const cutoffsRaw = values.get("--cutoffs");
  const knowledgeCutoffsRaw = values.get("--knowledge-cutoffs");
  if ([slotRaw, cutoffsRaw, knowledgeCutoffsRaw].filter((value) => value !== undefined).length > 1) {
    throw new AcceptanceUsageError("--cutoff-slot, --cutoffs, and --knowledge-cutoffs are alternatives; give one.");
  }
  if (slotRaw !== undefined && !(CUTOFF_SLOTS as readonly string[]).includes(slotRaw)) {
    throw new AcceptanceUsageError(`--cutoff-slot accepts only ${CUTOFF_SLOTS.join(", ")}.`);
  }
  const explicitCutoffs =
    cutoffsRaw === undefined
      ? null
      : cutoffsRaw.split(",").map((value) => value.trim()).filter((value) => value !== "");
  if (explicitCutoffs !== null && explicitCutoffs.length === 0) {
    throw new AcceptanceUsageError("--cutoffs must name at least one cutoff.");
  }
  const knowledgeCutoffs = knowledgeCutoffsRaw === undefined ? null
    : knowledgeCutoffsRaw.split(",").map((value) => value.trim()).filter((value) => value !== "");
  if (knowledgeCutoffs !== null && knowledgeCutoffs.length === 0) {
    throw new AcceptanceUsageError("--knowledge-cutoffs must name at least one cutoff.");
  }
  const chainRaw = values.get("--chain");
  const chainDays =
    chainRaw === undefined
      ? explicitCutoffs?.length ?? knowledgeCutoffs?.length ?? DEFAULT_CHAIN_DAYS
      : parseStrictInteger(chainRaw, "--chain");
  if (chainDays < 1 || chainDays > MAX_CHAIN_DAYS) {
    throw new AcceptanceUsageError(`--chain must be between 1 and ${MAX_CHAIN_DAYS}.`);
  }
  if (chainDays > windowDays) {
    throw new AcceptanceUsageError("--chain cannot be longer than --window.");
  }
  if (explicitCutoffs !== null && explicitCutoffs.length !== chainDays) {
    throw new AcceptanceUsageError(`--cutoffs names ${explicitCutoffs.length} cutoffs but --chain is ${chainDays}.`);
  }
  if (knowledgeCutoffs !== null && knowledgeCutoffs.length !== chainDays) {
    throw new AcceptanceUsageError(`--knowledge-cutoffs names ${knowledgeCutoffs.length} cutoffs but --chain is ${chainDays}.`);
  }
  const slot: CutoffSlot = (slotRaw as CutoffSlot | undefined) ?? "end-of-day";
  const cutoffMode: CutoffMode = knowledgeCutoffs !== null ? "replay" : explicitCutoffs !== null ? "explicit" : slot;
  const chain = deriveChain({ window, chainDays, slot, explicitCutoffs, knowledgeCutoffs });
  const nowIso = now.toISOString();
  for (const day of chain) {
    if (!(day.cutoff < nowIso)) {
      throw new AcceptanceUsageError(
        `cutoff ${day.cutoff} (${cutoffMode}) is not in the past (now ${nowIso}); end-of-day cutoffs need a past UTC day.`,
      );
    }
  }

  const limitsRaw = values.get("--ad-limits");
  const adLimits =
    limitsRaw === undefined
      ? [...DEFAULT_AD_LIMITS]
      : limitsRaw.split(",").map((value) => parseStrictInteger(value, "--ad-limits"));
  if (adLimits.length === 0) {
    throw new AcceptanceUsageError("--ad-limits must name at least one limit.");
  }
  for (const limit of adLimits) {
    if (
      limit < META_DECISIONS_AD_CANDIDATE_LIMIT ||
      limit > META_DECISIONS_AD_CANDIDATE_MAX_LIMIT
    ) {
      throw new AcceptanceUsageError(
        `--ad-limits values must be within [${META_DECISIONS_AD_CANDIDATE_LIMIT}, ${META_DECISIONS_AD_CANDIDATE_MAX_LIMIT}], the route's clamp.`,
      );
    }
  }
  if (new Set(adLimits).size !== adLimits.length) {
    throw new AcceptanceUsageError("--ad-limits lists the same limit twice.");
  }
  adLimits.sort((left, right) => left - right);

  const writeRaw = values.get("--write");
  if (writeRaw !== undefined && writeRaw !== "0" && writeRaw !== "1") {
    throw new AcceptanceUsageError('--write accepts only "1" or "0".');
  }
  const write = writeRaw === "1";
  const outRaw = values.get("--out")?.trim() || null;
  if (write && outRaw === null) {
    throw new AcceptanceUsageError(
      "--write 1 requires --out <file>; database writes are never supported.",
    );
  }
  const outPath = outRaw === null ? null : path.resolve(options.cwd ?? process.cwd(), outRaw);
  if (outPath !== null) {
    const root = options.repoRoot ? path.resolve(options.repoRoot) : null;
    if (root !== null) {
      const relative = path.relative(root, outPath);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        throw new AcceptanceUsageError(`--out ${outPath} is inside the repository (${root}); write reports elsewhere.`);
      }
    }
    if (options.pathExists?.(outPath)) {
      throw new AcceptanceUsageError(`--out ${outPath} already exists; the harness never overwrites a file.`);
    }
  }

  const gateRaw = values.get("--gate")?.trim();
  if (gateRaw !== undefined && !(RELEASE_GATES as readonly string[]).includes(gateRaw)) {
    throw new AcceptanceUsageError(`--gate accepts only ${RELEASE_GATES.join(" or ")}.`);
  }
  const gate = (gateRaw as ReleaseGate | undefined) ?? DEFAULT_RELEASE_GATE;

  return {
    businesses,
    negativeControl,
    negativeControlCampaign,
    requireClean: booleans.has("--require-clean"),
    requireHardAuthority: booleans.has("--require-hard-authority"),
    cutoffMode,
    gate,
    window,
    chainDays,
    chain,
    adLimits,
    outPath,
    write,
    skipDecisions: booleans.has("--skip-decisions"),
    diagnostic: booleans.has("--diagnostic"),
    mode:
      booleans.has("--skip-decisions") || booleans.has("--diagnostic") || cutoffMode === "replay"
        ? "diagnostic" : "release",
  };
}

/* ============================================================ classifiers */

export type NumericSign = "positive" | "zero" | "negative" | "null";

export function numericSign(value: unknown): NumericSign {
  if (value === null || value === undefined) return "null";
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "null";
  if (numeric > 0) return "positive";
  if (numeric < 0) return "negative";
  return "zero";
}

/**
 * One ad-day's link clicks, read through the production authoritative
 * expression (`buildAdDayAuthoritativeLinkClicksSql`). A measured zero needs
 * row-local provenance (an `actions` array); a NULL is split by WHY it is
 * missing. The two `contradiction_*` states cannot occur if the production
 * expression holds its contract; the evaluator reports either as a violation.
 */
export type LinkClickRowState =
  | "measured_positive"
  | "measured_zero_with_provenance"
  | "measured_zero_provider_receipt"
  | "missing_actions_absent"
  | "missing_other"
  | "contradiction_zero_without_provenance"
  | "contradiction_negative";

export function classifyLinkClickRow(input: {
  authoritativeSign: NumericSign;
  actionsIsArray: boolean;
  providerZeroVerified?: boolean;
}): LinkClickRowState {
  switch (input.authoritativeSign) {
    case "positive":
      return "measured_positive";
    case "zero":
      return input.actionsIsArray
        ? "measured_zero_with_provenance"
        : input.providerZeroVerified
          ? "measured_zero_provider_receipt"
        : "contradiction_zero_without_provenance";
    case "negative":
      return "contradiction_negative";
    case "null":
      return input.actionsIsArray ? "missing_other" : "missing_actions_absent";
  }
}

/**
 * One ad-day's funnel stage (LPV / ATC / IC), read through
 * `buildMetaFunnelStageSql`: `measured` | `unmeasurable` | `unreadable`.
 */
export type FunnelStageRowState =
  | "measured_positive"
  | "measured_zero"
  | "measured_zero_provider_receipt"
  | "missing_actions_absent"
  | "missing_unreadable"
  | "missing_other"
  | "contradiction_measured_without_actions";

export function classifyFunnelStageRow(input: {
  state: string | null;
  valueSign: NumericSign;
  actionsIsArray: boolean;
  providerZeroVerified?: boolean;
}): FunnelStageRowState {
  if (input.state === "measured") {
    if (!input.actionsIsArray) return input.providerZeroVerified && input.valueSign === "zero"
      ? "measured_zero_provider_receipt"
      : "contradiction_measured_without_actions";
    if (input.valueSign === "positive") return "measured_positive";
    if (input.valueSign === "zero") return "measured_zero";
    return "missing_other";
  }
  if (input.state === "unmeasurable") return "missing_actions_absent";
  if (input.state === "unreadable") return "missing_unreadable";
  return "missing_other";
}

/**
 * Purchases have only two production states (`conversions` is NOT NULL
 * DEFAULT 0 and ingestion writes 0 when the action is absent). The harness
 * keeps the zero that has no `actions` key in its own bucket so it is never
 * reported as a measured zero.
 */
export type PurchaseRowState =
  | "measured"
  | "provider_zero_verified"
  | "zero_without_actions_key"
  | "contradiction_positive_without_actions_key";

export function classifyPurchaseRow(input: {
  conversionsSign: NumericSign;
  actionsIsArray: boolean;
  providerZeroVerified?: boolean;
}): PurchaseRowState {
  if (input.actionsIsArray) return "measured";
  if (input.conversionsSign === "positive") {
    return "contradiction_positive_without_actions_key";
  }
  if (input.providerZeroVerified && input.conversionsSign === "zero") {
    return "provider_zero_verified";
  }
  return "zero_without_actions_key";
}

/**
 * An ad's decision-window spend. Production serves `$0` for both a measured
 * zero-spend row and an ad with no row in the window; they are different facts.
 */
export type AdSpendState =
  | "measured_positive"
  | "measured_zero_row"
  | "no_row_in_window"
  | "contradiction_spend_without_rows";

export function classifyAdSpend(input: {
  spend: number | null;
  sourceRowCount: number;
}): AdSpendState {
  const sign = numericSign(input.spend);
  if (input.sourceRowCount <= 0) {
    return sign === "positive" || sign === "negative"
      ? "contradiction_spend_without_rows"
      : "no_row_in_window";
  }
  return sign === "positive" ? "measured_positive" : "measured_zero_row";
}

/** A 28-day link-click window as hydrated (`input.linkClicks`). */
export type LinkClickWindowState =
  | "measured_positive"
  | "measured_zero"
  | "missing_window_incomplete";

export function classifyLinkClickWindow(value: number | null | undefined): LinkClickWindowState {
  const sign = numericSign(value);
  if (sign === "positive") return "measured_positive";
  if (sign === "zero") return "measured_zero";
  return "missing_window_incomplete";
}

export interface ConfigTierClassification {
  tier: string;
  knownTier: boolean;
  readiness: MetaConfigFieldReadiness;
}

/** Tier -> readiness through the production ladder (`readinessForConfigFieldTier`). */
export function classifyConfigTier(tier: unknown): ConfigTierClassification {
  const value = typeof tier === "string" ? tier : "unknown";
  const knownTier = (META_CONFIG_FIELD_TIERS as readonly string[]).includes(value);
  return {
    tier: value,
    knownTier,
    readiness: knownTier
      ? readinessForConfigFieldTier(value as MetaConfigFieldTier)
      : "none",
  };
}

export type CoverageStatus = "complete" | "partial" | "unavailable";

/**
 * The D101 status CASE in `account_source_coverage`
 * (lib/creative-decision-engine/data-source.ts), plus the lag in days.
 */
export function classifyCoverage(input: {
  expectedThroughDay: string | null;
  coverageThroughDay: string | null;
}): { status: CoverageStatus; lagDays: number | null } {
  if (!input.expectedThroughDay || !input.coverageThroughDay) {
    return { status: "unavailable", lagDays: null };
  }
  if (input.coverageThroughDay === input.expectedThroughDay) {
    return { status: "complete", lagDays: 0 };
  }
  const lag = utcDayCount(input.coverageThroughDay, input.expectedThroughDay) - 1;
  return { status: "partial", lagDays: lag };
}

export type RoleTrust = "high" | "medium" | "low" | "unknown";

export function classifyRoleTrust(value: unknown): RoleTrust {
  return value === "high" || value === "medium" || value === "low" ? value : "unknown";
}

/**
 * Whether THIS PROCESS arms the campaign-role resolver. The approved version
 * is what `campaignContextAuthorityResolverVersion()` returned; it is armed
 * only when it equals the resolver's own version.
 */
export function describeResolverArming(input: {
  approvedVersion: string | null;
  requiredVersion: string;
}): { resolverArmed: boolean; approvedVersion: string | null; requiredVersion: string } {
  return {
    resolverArmed:
      input.approvedVersion !== null && input.approvedVersion === input.requiredVersion,
    approvedVersion: input.approvedVersion,
    requiredVersion: input.requiredVersion,
  };
}

export function countBy<T>(
  rows: readonly T[],
  select: (row: T) => unknown,
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = String(select(row));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

/** Sums `{state, n}` groups (one SQL GROUP BY row each) into a state tally. */
export function tallyStates<T extends string>(
  groups: ReadonlyArray<{ state: T; n: number }>,
): Record<string, number> {
  const tally = new Map<string, number>();
  for (const group of groups) tally.set(group.state, (tally.get(group.state) ?? 0) + group.n);
  return Object.fromEntries([...tally].sort(([left], [right]) => left.localeCompare(right)));
}

export const HARD_LABELS = new Set(["scale", "cut", "refresh"]);
export function isHardLabel(value: unknown): value is "scale" | "cut" | "refresh" {
  return typeof value === "string" && HARD_LABELS.has(value);
}

export { NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR };

/* ====================================================== receipt gate */

export interface SimulatedHydrationReceipt {
  providerAccountRefId: string;
  providerAccountId: string;
  expectedAdCount: number;
  hydratedAdCount: number;
  expectedManifestHash: string;
  hydratedManifestHash: string;
  authoritativeForPrune: boolean;
  sourceComplete: boolean;
  hydrationComplete: boolean;
  reason: string | null;
}

export interface ReceiptGateResult {
  pass: boolean;
  failures: string[];
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * The manifest clause of `resolveNativeGenerationReceipt`
 * (lib/meta/decisions-workspace-read-model.ts, not exported): the only bar a
 * persisted generation must clear to be served. An in-memory generation is
 * built from a hydration receipt ONLY when it clears the same bar.
 */
export function evaluateReceiptGate(receipt: SimulatedHydrationReceipt): ReceiptGateResult {
  const failures: string[] = [];
  if (!receipt.providerAccountRefId?.trim()) failures.push("provider_account_ref_missing");
  if (!Number.isInteger(receipt.expectedAdCount) || receipt.expectedAdCount < 0) {
    failures.push("expected_count_invalid");
  }
  if (receipt.hydratedAdCount !== receipt.expectedAdCount) {
    failures.push("hydrated_count_differs_from_expected");
  }
  if (!isSha256(receipt.expectedManifestHash)) failures.push("expected_manifest_hash_invalid");
  if (receipt.hydratedManifestHash !== receipt.expectedManifestHash) {
    failures.push("manifest_hash_mismatch");
  }
  if (receipt.authoritativeForPrune !== true) failures.push("not_authoritative_for_prune");
  return { pass: failures.length === 0, failures };
}

/* ============================================ read-model SQL projections */

/*
  The read model projects three evaluation-derived columns in SQL
  (`readNativeSnapshotRows`, lib/meta/decisions-workspace-read-model.ts). None
  of the three mappings is exported, so they are restated here and PINNED by a
  parity test that asserts both the semantics and the SQL text.

  Persisted input:  input_evidence_json = { configEvidence, metricContract }
                    (evaluation-store.ts, `?? null` on both members)
                    decision_output_json = evaluation.decisionPayload.decision
*/

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A value as it round-trips through a jsonb column. */
function asJsonb(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `jsonb #> path`: SQL NULL (undefined) when any step is missing. */
function jsonbPath(value: JsonValue | undefined, path: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const key of path) {
    if (Array.isArray(current)) {
      if (!/^-?\d+$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (isJsonObject(current)) {
      current = Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined;
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** `jsonb #>> path`: text, or SQL NULL for a missing path or a JSON null. */
function jsonbPathText(value: JsonValue | undefined, path: readonly string[]): string | null {
  const found = jsonbPath(value, path);
  if (found === undefined || found === null) return null;
  if (typeof found === "string") return found;
  return JSON.stringify(found);
}

/** The persisted `input_evidence_json` for an in-memory evaluation. */
export function persistedInputEvidence(inputPayload: Record<string, unknown>): JsonValue {
  return asJsonb({
    configEvidence: inputPayload.configEvidence ?? null,
    metricContract: inputPayload.metricContract ?? null,
  })!;
}

/** `config_authority_verified`: the SQL CASE in `readNativeSnapshotRows`. */
export function projectConfigAuthorityVerified(inputEvidence: unknown): boolean | null {
  const evidence = asJsonb(inputEvidence);
  const configEvidence = jsonbPath(evidence, ["configEvidence"]);
  if (configEvidence === undefined || !isJsonObject(configEvidence)) return null;
  return (
    jsonbPathText(evidence, ["configEvidence", "currentValueEvidence", "observed"]) === "true" &&
    jsonbPathText(evidence, ["configEvidence", "decisionEconomics", "fullyVerified"]) === "true"
  );
}

/** `config_evidence_lineage`: the SQL CASE + jsonb_build_object in `readNativeSnapshotRows`. */
export function projectConfigEvidenceLineage(
  inputEvidence: unknown,
  evaluationContractVersion: string | null,
): Record<string, unknown> | null {
  const evidence = asJsonb(inputEvidence);
  if (!isJsonObject(jsonbPath(evidence, ["configEvidence"]))) return null;
  const at = (path: readonly string[]) => jsonbPath(evidence, path) ?? null;
  return {
    contractVersion: evaluationContractVersion,
    refs: at(["configEvidence", "currentValueEvidence", "refs"]),
    refRefusals: at(["configEvidence", "currentValueEvidence", "refRefusals"]),
    lineageSupplied: at(["configEvidence", "currentValueEvidence", "lineageSupplied"]),
    receiptManifest: at(["configEvidence", "decisionEconomics", "receiptManifest"]),
    currentConfigDay: at(["configEvidence", "currentConfigDay"]),
    metricContract: at(["metricContract"]),
  };
}

/** `predicate_blockers` = `evaluation.decision_output_json -> 'blockers'`. */
export function projectPredicateBlockers(decisionPayload: Record<string, unknown>): unknown {
  const decisionOutput = asJsonb(decisionPayload.decision);
  if (!isJsonObject(decisionOutput)) return null;
  return jsonbPath(decisionOutput, ["blockers"]) ?? null;
}

/* ========================================== in-memory generation builder */

export function simulatedJobRunId(input: {
  businessId: string;
  providerAccountId: string;
  cutoff: string;
}): string {
  return `${SYNTHETIC_ID_PREFIX}job-run:${input.businessId}:${input.providerAccountId}:${input.cutoff}`;
}

/** Same form the existing simulator carries as a prior's `sourceSnapshotId`. */
export function simulatedSnapshotId(decisionHash: string): string {
  return `${SYNTHETIC_ID_PREFIX}snapshot:${decisionHash}`;
}

export type SimulatedPayload = Pick<
  NativeSnapshotPayloadRow,
  | "provider_account_ref_id"
  | "provider_account_id"
  | "ad_id"
  | "creative_id"
  | "as_of_date"
  | "engine_version"
  | "scope_type"
  | "scope_id"
  | "label"
  | "raw_label"
  | "pre_authority_label"
  | "authority_blocker"
  | "confidence"
  | "truth_source"
  | "effective_target_roas"
  | "ratio_to_target"
  | "badges"
  | "reason"
  | "spend"
  | "purchases"
  | "roas"
  | "recent7d_roas"
  | "label_transform"
  | "blocked_action_type"
  | "authorized_action"
  | "job_run_id"
  | "evaluation_id"
  | "input_hash"
  | "decision_hash"
  | "computed_at"
>;

export interface SimulatedEvaluationFacts {
  contractVersion: string;
  inputPayload: Record<string, unknown>;
  decisionPayload: Record<string, unknown>;
  inputHash: string;
  decisionHash: string;
}

export interface SimulatedDecisionEntry {
  payload: SimulatedPayload;
  evaluation: SimulatedEvaluationFacts;
}

/**
 * Serve-time identity for one ad. Names come from the present dimension
 * tables (labels only); the three statuses MUST come from a cutoff-bounded
 * `meta_entity_state_history` read.
 */
export interface SimulatedIdentity {
  creative_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  ad_name: string | null;
  campaign_status: string | null;
  adset_status: string | null;
  ad_status: string | null;
  currency: string | null;
  thumbnail_url: string | null;
  media_source_present: boolean;
  media_available: boolean;
  media_source: string | null;
  source_updated_at: string | null;
}

export interface EpisodeMark {
  label: string;
  start: string;
}

export function episodeKey(providerAccountId: string, adId: string): string {
  return `${providerAccountId}\u0000${adId}`;
}

export type SimulatedGenerationRefusalReason =
  | "receipt_unreconstructable"
  | "job_run_mismatch"
  | "non_synthetic_identifier"
  | "duplicate_synthetic_snapshot_id";

export type SimulatedGenerationResult =
  | {
      status: "refused";
      reason: SimulatedGenerationRefusalReason;
      receiptGate: ReceiptGateResult;
      detail: string;
    }
  | {
      status: "built";
      receiptGate: ReceiptGateResult;
      generation: MetaNativeDecisionGeneration;
      rows: MetaNativeDecisionSnapshotSourceRow[];
      /** This day's episode marks, to carry to the next simulated day. */
      episodes: Map<string, EpisodeMark>;
      /** Rows whose `lineage_valid` is true; false everywhere unless hashes verified. */
      lineageValidRows: number;
    };

const EMPTY_IDENTITY: SimulatedIdentity = {
  creative_name: null,
  campaign_id: null,
  campaign_name: null,
  adset_id: null,
  adset_name: null,
  ad_name: null,
  campaign_status: null,
  adset_status: null,
  ad_status: null,
  currency: null,
  thumbnail_url: null,
  media_source_present: false,
  media_available: false,
  media_source: null,
  source_updated_at: null,
};

/**
 * One simulated day's account generation, as the production reader would load
 * it had the job persisted it at `cutoff`.
 *
 * REFUSES (typed) unless the account's hydration receipt passes the
 * production receipt gate; then nothing may be presented. The generation's
 * manifest hash is the RECEIPT's `expectedManifestHash`, never recomputed from
 * the rows, so a row set that does not match the receipt fails the production
 * validator instead of being made to match.
 *
 *   job run id        one visibly synthetic id per business/account/cutoff
 *   snapshot id       `read-only-simulation:snapshot:<decisionHash>`
 *   config columns    the read-model SQL CASE, over the persisted evidence shape
 *   predicate_blockers `decision_output_json -> 'blockers'`
 *   episode_started_at from THIS simulated chain only; a cold start is as_of_date
 *   lineage_valid     true only when the canonical hash integrity was verified
 *   statuses          from the caller's cutoff-bounded identity read
 */
export function buildSimulatedGeneration(input: {
  businessId: string;
  asOf: string;
  cutoff: string;
  receipt: SimulatedHydrationReceipt;
  entries: readonly SimulatedDecisionEntry[];
  identityByAdId: ReadonlyMap<string, Partial<SimulatedIdentity>>;
  priorEpisodes: ReadonlyMap<string, EpisodeMark>;
  hashIntegrityVerified: boolean;
}): SimulatedGenerationResult {
  const receiptGate = evaluateReceiptGate(input.receipt);
  if (!receiptGate.pass) {
    return {
      status: "refused",
      reason: "receipt_unreconstructable",
      receiptGate,
      detail: `hydration receipt for ${input.receipt.providerAccountId} fails the production gate: ${receiptGate.failures.join(", ")}`,
    };
  }
  const jobRunId = simulatedJobRunId({
    businessId: input.businessId,
    providerAccountId: input.receipt.providerAccountId,
    cutoff: input.cutoff,
  });
  const entries = input.entries.filter(
    (entry) =>
      entry.payload.provider_account_id === input.receipt.providerAccountId &&
      entry.payload.provider_account_ref_id === input.receipt.providerAccountRefId,
  );
  const snapshotIds = new Set<string>();
  const rows: MetaNativeDecisionSnapshotSourceRow[] = [];
  const episodes = new Map<string, EpisodeMark>();
  for (const { payload, evaluation } of entries) {
    if (payload.job_run_id !== jobRunId) {
      return {
        status: "refused",
        reason: "job_run_mismatch",
        receiptGate,
        detail: `payload for ad ${payload.ad_id} carries job run "${payload.job_run_id}", expected "${jobRunId}"`,
      };
    }
    if (!payload.evaluation_id.startsWith(SYNTHETIC_ID_PREFIX)) {
      return {
        status: "refused",
        reason: "non_synthetic_identifier",
        receiptGate,
        detail: `evaluation id for ad ${payload.ad_id} is not visibly synthetic`,
      };
    }
    const snapshotId = simulatedSnapshotId(evaluation.decisionHash);
    if (snapshotIds.has(snapshotId)) {
      return {
        status: "refused",
        reason: "duplicate_synthetic_snapshot_id",
        receiptGate,
        detail: `two decisions share decision hash ${evaluation.decisionHash}`,
      };
    }
    snapshotIds.add(snapshotId);
    const identity = { ...EMPTY_IDENTITY, ...(input.identityByAdId.get(payload.ad_id) ?? {}) };
    const key = episodeKey(payload.provider_account_id, payload.ad_id);
    const prior = input.priorEpisodes.get(key);
    const episodeStartedAt =
      prior && prior.label === payload.label ? prior.start : payload.as_of_date;
    episodes.set(key, { label: payload.label, start: episodeStartedAt });
    const evidence = persistedInputEvidence(evaluation.inputPayload);
    rows.push({
      snapshot_id: snapshotId,
      evaluation_id: payload.evaluation_id,
      job_run_id: jobRunId,
      provider_account_ref_id: payload.provider_account_ref_id,
      provider_account_id: payload.provider_account_id,
      ad_id: payload.ad_id,
      creative_id: payload.creative_id,
      as_of_date: payload.as_of_date,
      engine_version: payload.engine_version,
      scope_type: payload.scope_type,
      scope_id: payload.scope_id,
      label: payload.label,
      pre_authority_label: payload.pre_authority_label,
      authority_blocker: payload.authority_blocker,
      raw_label: payload.raw_label,
      confidence: payload.confidence,
      truth_source: payload.truth_source,
      effective_target_roas: payload.effective_target_roas,
      ratio_to_target: payload.ratio_to_target,
      badges: payload.badges,
      reason: payload.reason,
      spend: payload.spend,
      purchases: payload.purchases,
      roas: payload.roas,
      recent7d_roas: payload.recent7d_roas,
      label_transform: payload.label_transform,
      blocked_action_type: payload.blocked_action_type,
      authorized_action: payload.authorized_action,
      input_hash: payload.input_hash,
      decision_hash: payload.decision_hash,
      computed_at: payload.computed_at,
      episode_started_at: episodeStartedAt,
      lineage_valid: input.hashIntegrityVerified === true,
      creative_name: identity.creative_name,
      campaign_id: identity.campaign_id,
      campaign_name: identity.campaign_name,
      adset_id: identity.adset_id,
      adset_name: identity.adset_name,
      ad_name: identity.ad_name,
      campaign_status: identity.campaign_status,
      adset_status: identity.adset_status,
      ad_status: identity.ad_status,
      currency: identity.currency,
      thumbnail_url: identity.thumbnail_url,
      media_source_present: identity.media_source_present,
      media_available: identity.media_available,
      media_source: identity.media_source,
      source_updated_at: identity.source_updated_at,
      // The lifecycle lineage join has no in-memory row; absent is unknown.
      creative_format: null,
      ctr_28d: null,
      frequency_28d: null,
      fatigue_status: null,
      predicate_blockers: projectPredicateBlockers(evaluation.decisionPayload),
      config_authority_verified: projectConfigAuthorityVerified(evidence),
      config_evidence_lineage: projectConfigEvidenceLineage(evidence, evaluation.contractVersion),
    });
  }
  return {
    status: "built",
    receiptGate,
    generation: {
      jobRunId,
      asOfDate: input.asOf,
      providerAccountRefId: input.receipt.providerAccountRefId,
      manifestHash: input.receipt.expectedManifestHash,
      expectedAdCount: input.receipt.expectedAdCount,
    },
    rows,
    episodes,
    lineageValidRows: rows.filter((row) => row.lineage_valid).length,
  };
}

/* ============================================== served authority audit */

export interface AuditRow {
  ad_id: string;
  authorized_action: string | null;
  blocked_action_type: string | null;
}

export interface AuditInventoryItem {
  adId: string | null;
  actionEligible: boolean | null;
  authorizedAction: string | null;
  heldAction: string | null;
  decisionState: string | null;
}

export interface AuditOsItem {
  adId: string;
  lane: string;
  intent: string | null;
  providerMutation: string | null;
  heldAction: string | null;
}

/** A Decisions exact-adapter creative row, joined to the OS row it was drawn from. */
export interface AuditExactAdapterRow {
  rowId: string;
  /** Null when the row joins no OS item. */
  adId: string | null;
  actionTone: string | null;
  intent: string | null;
  providerMutation: string | null;
}

/**
 * An action that can reach a provider write: an executable mutation, a
 * Launchpad route, or a resume / bid change under any intent.
 */
export function isProviderWriteAction(action: { intent: string | null; providerMutation: string | null }): boolean {
  return (
    (action.intent === "execute" && action.providerMutation !== null) ||
    action.intent === "launchpad" ||
    action.providerMutation === "resume" ||
    action.providerMutation === "apply_bid"
  );
}

/** A write affordance as the exact adapter draws it (pause => negative, resume => positive). */
const EXACT_ADAPTER_WRITE_TONES = new Set(["negative", "positive"]);

export interface ServedAuthorityAudit {
  generationAuthorized: number;
  generationHeld: number;
  /** A served row that may act although its generation row authorizes nothing. */
  actionEligibleWithoutAuthorized: string[];
  /** A served authorized action that differs from the generation row's. */
  authorizedActionMismatch: string[];
  /** A briefing Action Now card whose generation row authorizes nothing. */
  briefingActionWithoutAuthorized: string[];
  /** An OS row carrying an executable provider mutation without authorization. */
  osExecutableWithoutAuthorized: string[];
  /** A held hard verdict (blocked_action_type) with no canonical inventory item. */
  heldMissingFromInventory: string[];
  /** A held hard verdict whose canonical item does not carry it as heldAction. */
  heldActionNotCarried: string[];
  /** An exact-adapter row that draws or carries a provider write without authorization. */
  exactAdapterWriteWithoutAuthorized: string[];
  /** An exact-adapter row that joins no served OS item. */
  exactAdapterRowsWithoutOsItem: string[];
}

export function auditServedAuthority(input: {
  rows: readonly AuditRow[];
  inventory: readonly AuditInventoryItem[];
  briefingActionAdIds?: readonly string[];
  osItems?: readonly AuditOsItem[];
  exactAdapterRows?: readonly AuditExactAdapterRow[];
}): ServedAuthorityAudit {
  const rowByAd = new Map(input.rows.map((row) => [row.ad_id, row]));
  const inventoryByAd = new Map<string, AuditInventoryItem>();
  for (const item of input.inventory) {
    if (item.adId) inventoryByAd.set(item.adId, item);
  }
  const authorizedOf = (adId: string | null) =>
    adId ? rowByAd.get(adId)?.authorized_action ?? null : null;
  const audit: ServedAuthorityAudit = {
    generationAuthorized: input.rows.filter((row) => row.authorized_action !== null).length,
    generationHeld: input.rows.filter((row) => row.blocked_action_type !== null).length,
    actionEligibleWithoutAuthorized: [],
    authorizedActionMismatch: [],
    briefingActionWithoutAuthorized: [],
    osExecutableWithoutAuthorized: [],
    heldMissingFromInventory: [],
    heldActionNotCarried: [],
    exactAdapterWriteWithoutAuthorized: [],
    exactAdapterRowsWithoutOsItem: [],
  };
  for (const item of input.inventory) {
    const authorized = authorizedOf(item.adId);
    if (item.actionEligible === true && authorized === null) {
      audit.actionEligibleWithoutAuthorized.push(item.adId ?? "(no ad id)");
    }
    if (item.authorizedAction !== null && item.authorizedAction !== authorized) {
      audit.authorizedActionMismatch.push(item.adId ?? "(no ad id)");
    }
  }
  for (const adId of input.briefingActionAdIds ?? []) {
    if (authorizedOf(adId) === null) audit.briefingActionWithoutAuthorized.push(adId);
  }
  for (const item of input.osItems ?? []) {
    if (isProviderWriteAction(item) && authorizedOf(item.adId) === null) {
      audit.osExecutableWithoutAuthorized.push(item.adId);
    }
  }
  for (const row of input.exactAdapterRows ?? []) {
    if (row.adId === null) {
      audit.exactAdapterRowsWithoutOsItem.push(row.rowId);
      continue;
    }
    const draws = row.actionTone !== null && EXACT_ADAPTER_WRITE_TONES.has(row.actionTone);
    if ((draws || isProviderWriteAction(row)) && authorizedOf(row.adId) === null) {
      audit.exactAdapterWriteWithoutAuthorized.push(row.adId);
    }
  }
  for (const row of input.rows) {
    if (row.blocked_action_type === null) continue;
    const item = inventoryByAd.get(row.ad_id);
    if (!item) audit.heldMissingFromInventory.push(row.ad_id);
    else if (item.heldAction !== row.blocked_action_type) audit.heldActionNotCarried.push(row.ad_id);
  }
  return audit;
}

/**
 * Where each held hard verdict landed in one OS presentation build: a served
 * Creatives row, the uncapped Archive, or nowhere (cap-hidden).
 */
export function locateHeldVerdicts(input: {
  heldAdIds: readonly string[];
  servedAdIds: readonly string[];
  archivedAdIds: readonly string[];
}): { held: number; served: number; archived: number; notServed: string[] } {
  const served = new Set(input.servedAdIds);
  const archived = new Set(input.archivedAdIds);
  const notServed: string[] = [];
  let servedCount = 0;
  let archivedCount = 0;
  for (const adId of input.heldAdIds) {
    if (served.has(adId)) servedCount += 1;
    else if (archived.has(adId)) archivedCount += 1;
    else notServed.push(adId);
  }
  return { held: input.heldAdIds.length, served: servedCount, archived: archivedCount, notServed };
}

/* ====================================================== decision mapping */

/*
  The CLI hands every scoped production decision to these functions; nothing
  between the production objects and the report is computed in the CLI. The
  input is the STRUCTURAL slice the report reads, so a test can drive it with
  a literal and a production ScopedDecision satisfies it unchanged.
*/

/** Reads a nested value from an object whose shape this file does not own. */
export function pickPath(value: unknown, keys: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const stringValue = String(value).trim();
  return stringValue === "" ? null : stringValue;
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export interface DecisionEntrySource {
  computation: {
    input: {
      providerAccountId: string;
      adId: string;
      campaignId?: string | null;
      adsetId?: string | null;
      configAuthority: unknown;
      metricEvidence: unknown;
      dataFreshnessHours?: unknown;
      linkClicks?: unknown;
      spend?: unknown;
      purchases?: unknown;
    };
    rawLabel: string;
    decision: {
      label: string;
      preAuthorityLabel?: string | null;
      authorityBlocker?: string | null;
      reason?: unknown;
      confidence?: unknown;
      campaignRoleStatus?: unknown;
      blockers?: unknown;
    };
    hysteresisSuppressed: boolean;
    campaignContext: unknown;
    priorHysteresis: unknown;
  };
  payload: {
    authority_blocker: string | null;
    blocked_action_type: string | null;
    authorized_action: string | null;
  };
  group: {
    blocker: string | null;
    profile: {
      hardActionEligibility: unknown;
      commercialStopLossCanonicalHardActionEligibility?: unknown;
      commercialStopLossThresholds?: unknown;
    };
  };
}

export function hardActionEligibilityOf(group: DecisionEntrySource["group"]) {
  const eligibility = group.profile.hardActionEligibility;
  return {
    scale: pickPath(eligibility, ["scale"]) === true,
    cut: pickPath(eligibility, ["cut"]) === true,
    refresh: pickPath(eligibility, ["refresh"]) === true,
  };
}

/**
 * The prior-label source as the report states it. A prior carried from an
 * earlier SIMULATED day is shaped like a persisted row (so production code
 * reads it as `persisted_evaluation`), but its ids are synthetic: it is
 * reported as `simulated_prior_day`, never as persisted lineage.
 */
export function reportedPriorSource(prior: unknown): string {
  const source = textOrNull(pickPath(prior, ["source"])) ?? "none";
  const ids = [pickPath(prior, ["sourceSnapshotId"]), pickPath(prior, ["sourceEvaluationId"])];
  const simulated = ids.some((id) => typeof id === "string" && id.startsWith(SYNTHETIC_ID_PREFIX));
  return simulated ? "simulated_prior_day" : source;
}

/** A decision the report lists with its full evidence chain: any hard verdict, held or authorized action. */
export function isHardRowEntry(entry: DecisionEntrySource): boolean {
  return (
    isHardLabel(entry.computation.rawLabel) ||
    isHardLabel(entry.computation.decision.preAuthorityLabel) ||
    entry.payload.blocked_action_type !== null ||
    entry.payload.authorized_action !== null
  );
}

export function toHardRowRecord(input: {
  asOf: string;
  entry: DecisionEntrySource;
  campaignContextById: ReadonlyMap<string, unknown>;
}): HardRowRecord {
  const { computation: c, payload: p, group: g } = input.entry;
  const authority = c.input.configAuthority;
  const coverage = pickPath(c.input.metricEvidence, ["sourceCoverage"]);
  const campaignId = c.input.campaignId ?? null;
  const context = campaignId ? input.campaignContextById.get(campaignId) : undefined;
  const resolverValidated = pickPath(context, ["resolverAuthorityValidated"]);
  const blockers = Array.isArray(c.decision.blockers) ? (c.decision.blockers as unknown[]) : [];
  const preAuthorityAction = c.decision.preAuthorityLabel ?? null;
  const cutEvidence = preAuthorityAction === "cut"
    ? {
        // The group profile can permit the account-AOV Cut overlay while the
        // per-ad resolver correctly restores its canonical, unready profile.
        // This is the decision's actual profile-gate outcome, not a second
        // calculation of Cut policy from the account-level boolean.
        effectiveProfileEligible: c.decision.authorityBlocker !== "profile_hard_action_ineligible",
        canonicalProfileEligible: pickPath(g.profile.commercialStopLossCanonicalHardActionEligibility, ["cut"]) === true
          ? true
          : pickPath(g.profile.commercialStopLossCanonicalHardActionEligibility, ["cut"]) === false
            ? false
            : null,
        spend28d: finiteOrNull(c.input.spend),
        purchases28d: finiteOrNull(c.input.purchases),
        accountAovZeroConversionSpendFloor: finiteOrNull(pickPath(g.profile.commercialStopLossThresholds, ["zeroConvBurnerSpend"])),
        accountAovCommercialMaturitySpendFloor: finiteOrNull(pickPath(g.profile.commercialStopLossThresholds, ["commercialMaturitySpend"])),
        decisionReason: textOrNull(c.decision.reason),
      }
    : null;
  return {
    asOf: input.asOf,
    providerAccountId: c.input.providerAccountId,
    adId: c.input.adId,
    campaignId,
    adsetId: c.input.adsetId ?? null,
    rawLabel: c.rawLabel,
    preAuthorityLabel: c.decision.preAuthorityLabel ?? null,
    publishedLabel: c.decision.label,
    hysteresisSuppressed: c.hysteresisSuppressed,
    firstAuthorityBlocker: c.decision.authorityBlocker ?? null,
    effectiveAuthorityBlocker: p.authority_blocker,
    blockedActionType: p.blocked_action_type,
    authorizedAction: p.authorized_action,
    confidence: finiteOrNull(c.decision.confidence),
    profileBlocker: g.blocker,
    // Account-level eligibility, before per-ad kind and Cut-only gates.
    hardActionEligibility: hardActionEligibilityOf(g),
    cutEvidence,
    config: {
      observed: pickPath(authority, ["currentValueEvidence", "observed"]) === true,
      fullyVerified: pickPath(authority, ["decisionEconomics", "fullyVerified"]) === true,
      blockingField: textOrNull(pickPath(authority, ["latestDay", "blockingField"])),
      weakestTier: textOrNull(pickPath(authority, ["currentValueEvidence", "weakestTier"])),
      unverifiedEconomicDayCount: finiteOrNull(pickPath(authority, ["decisionEconomics", "unverifiedEconomicDayCount"])),
    },
    coverage: {
      status: textOrNull(pickPath(coverage, ["status"])),
      expectedThroughDay: textOrNull(pickPath(coverage, ["expectedThroughDay"])),
      coverageThroughDay: textOrNull(pickPath(coverage, ["coverageThroughDay"])),
    },
    dataFreshnessHours: finiteOrNull(c.input.dataFreshnessHours),
    role: {
      trust: classifyRoleTrust(pickPath(c.campaignContext, ["contextTrust"])),
      campaignRoleStatus: textOrNull(c.decision.campaignRoleStatus),
      resolverArmed: typeof resolverValidated === "boolean" ? resolverValidated : null,
    },
    priorSource: reportedPriorSource(c.priorHysteresis),
    failedPredicates: blockers
      .filter((blocker) => pickPath(blocker, ["status"]) !== "passed")
      .map((blocker) => `${String(pickPath(blocker, ["predicate"]))}:${String(pickPath(blocker, ["status"]))}`),
  };
}

/** Every per-account decision count the report carries, except calibration and the receipt. */
export function summarizeAccountDecisions(input: {
  entries: readonly DecisionEntrySource[];
  campaignContextById: ReadonlyMap<string, unknown>;
}): Omit<DecisionAccountDayReport, "providerAccountId" | "receipt" | "calibration" | "crossCheck"> {
  const { entries } = input;
  const configOf = (entry: DecisionEntrySource) => entry.computation.input.configAuthority;
  const sourceRowsOf = (entry: DecisionEntrySource) =>
    finiteOrNull(pickPath(entry.computation.input.metricEvidence, ["sourceRowCount"])) ?? 0;
  return {
    ads: entries.length,
    rawHard: countBy(entries.filter((entry) => isHardLabel(entry.computation.rawLabel)), (entry) => entry.computation.rawLabel),
    preAuthorityHard: countBy(
      entries.filter((entry) => isHardLabel(entry.computation.decision.preAuthorityLabel)),
      (entry) => entry.computation.decision.preAuthorityLabel,
    ),
    publishedHard: countBy(
      entries.filter((entry) => isHardLabel(entry.computation.decision.label)),
      (entry) => entry.computation.decision.label,
    ),
    hysteresisSuppressed: entries.filter((entry) => entry.computation.hysteresisSuppressed).length,
    authorizedActions: countBy(entries, (entry) => entry.payload.authorized_action ?? "none"),
    blockedActionType: countBy(entries, (entry) => entry.payload.blocked_action_type ?? "none"),
    firstAuthorityBlocker: countBy(entries, (entry) => entry.computation.decision.authorityBlocker ?? "none"),
    effectiveAuthorityBlocker: countBy(entries, (entry) => entry.payload.authority_blocker ?? "none"),
    config: {
      observed: entries.filter((entry) => pickPath(configOf(entry), ["currentValueEvidence", "observed"]) === true).length,
      fullyVerified: entries.filter((entry) => pickPath(configOf(entry), ["decisionEconomics", "fullyVerified"]) === true).length,
      blockingField: countBy(entries, (entry) => textOrNull(pickPath(configOf(entry), ["latestDay", "blockingField"])) ?? "none"),
    },
    coverage: countBy(
      entries,
      (entry) => textOrNull(pickPath(entry.computation.input.metricEvidence, ["sourceCoverage", "status"])) ?? "absent",
    ),
    role: {
      trust: countBy(entries, (entry) => classifyRoleTrust(pickPath(entry.computation.campaignContext, ["contextTrust"]))),
      resolverArmed: countBy(entries, (entry) => {
        const campaignId = entry.computation.input.campaignId;
        const context = campaignId ? input.campaignContextById.get(campaignId) : undefined;
        const validated = pickPath(context, ["resolverAuthorityValidated"]);
        return typeof validated === "boolean" ? String(validated) : "no_context";
      }),
      campaignRoleStatus: countBy(entries, (entry) => textOrNull(entry.computation.decision.campaignRoleStatus) ?? "null"),
    },
    priorSource: countBy(entries, (entry) => reportedPriorSource(entry.computation.priorHysteresis)),
    metrics: {
      linkClicks28d: countBy(entries, (entry) =>
        classifyLinkClickWindow(finiteOrNull(entry.computation.input.linkClicks)),
      ),
      spend: countBy(entries, (entry) =>
        classifyAdSpend({ spend: finiteOrNull(entry.computation.input.spend), sourceRowCount: sourceRowsOf(entry) }),
      ),
      linkClicksZeroWithoutRows: entries.filter(
        (entry) => entry.computation.input.linkClicks === 0 && sourceRowsOf(entry) === 0,
      ).length,
    },
  };
}

/** Hydration's own claims for one account-day, for the independent cross-check. */
export function hydrationClaims(entries: readonly DecisionEntrySource[]): Omit<HydrationCrossCheck, "independent"> {
  return {
    hydrationFullyVerified: entries
      .filter((entry) => pickPath(entry.computation.input.configAuthority, ["decisionEconomics", "fullyVerified"]) === true)
      .map((entry) => ({
        adId: entry.computation.input.adId,
        campaignId: entry.computation.input.campaignId ?? null,
        adsetId: entry.computation.input.adsetId ?? null,
      })),
    hydrationCoverage: countBy(
      entries,
      (entry) => textOrNull(pickPath(entry.computation.input.metricEvidence, ["sourceCoverage", "status"])) ?? "absent",
    ),
  };
}

/** The structural slice of a governed canonical decision the audit reads. */
export interface CanonicalDecisionSource {
  parentChain: { ad?: { id?: string | null } | null };
  sourceAuthority?: unknown;
  classification: { heldAction: string | null; decisionState: string | null };
}

export interface OsItemSource {
  id: string;
  adId: string;
  lane: string;
  heldAction?: string | null;
  action: { intent?: string | null; providerMutation?: string | null };
}

/**
 * The served-authority audit of one presentation mode, from the production
 * objects: the generation rows, the governed canonical inventory, every active
 * Briefing card with its lane, every OS row at every limit, and the exact
 * adapter's creative rows (joined to OS rows by id).
 */
export function auditPresentationMode(input: {
  rows: readonly AuditRow[];
  governed: readonly CanonicalDecisionSource[];
  briefingCards: ReadonlyArray<{ adId: string | null; lane: string }>;
  osItemsByLimit: ReadonlyArray<readonly OsItemSource[]>;
  exactAdapterRows: ReadonlyArray<{ id: string; actionTone?: string | null }>;
}): ServedAuthorityAudit {
  const osItems = input.osItemsByLimit.flat();
  const osById = new Map(osItems.map((item) => [item.id, item]));
  return auditServedAuthority({
    rows: input.rows,
    inventory: input.governed.map((decision) => ({
      adId: decision.parentChain.ad?.id ?? null,
      actionEligible: (pickPath(decision.sourceAuthority, ["actionEligible"]) as boolean | null | undefined) ?? null,
      authorizedAction: textOrNull(pickPath(decision.sourceAuthority, ["authorizedAction"])),
      heldAction: decision.classification.heldAction,
      decisionState: decision.classification.decisionState,
    })),
    briefingActionAdIds: input.briefingCards
      .filter((card) => card.lane === "action")
      .map((card) => card.adId ?? "(no ad id)"),
    osItems: osItems.map((item) => ({
      adId: item.adId,
      lane: item.lane,
      intent: item.action.intent ?? null,
      providerMutation: item.action.providerMutation ?? null,
      heldAction: item.heldAction ?? null,
    })),
    exactAdapterRows: input.exactAdapterRows.map((row) => {
      const item = osById.get(row.id) ?? null;
      return {
        rowId: row.id,
        adId: item?.adId ?? null,
        actionTone: row.actionTone ?? null,
        intent: item?.action.intent ?? null,
        providerMutation: item?.action.providerMutation ?? null,
      };
    }),
  });
}

/* ============================================= authorization grounding */

/**
 * Why an authorized action is NOT grounded; empty when it is. Mirrors the
 * production authorization rule: the published label equals the raw label
 * equals the authorized hard action, not hysteresis-suppressed, eligible for
 * that action, on a day whose receipt passed the gate, with config observed
 * and fully verified, complete coverage, and both the decision blocker and the
 * payload blocker null (and nothing held beside it).
 */
export function authorizationGroundingFailures(row: HardRowRecord, receiptGatePassed: boolean): string[] {
  const action = row.authorizedAction;
  if (action === null) return [];
  const failures: string[] = [];
  if (!isHardLabel(action)) failures.push("authorized_action_not_hard");
  if (row.publishedLabel !== action) failures.push("published_label_differs");
  if (row.rawLabel !== action) failures.push("raw_label_differs");
  if (row.hysteresisSuppressed) failures.push("hysteresis_suppressed");
  if (!isHardLabel(action) || row.hardActionEligibility[action] !== true) failures.push("hard_action_ineligible");
  if (!receiptGatePassed) failures.push("receipt_gate_failed");
  if (row.config.observed !== true) failures.push("config_not_observed");
  if (row.config.fullyVerified !== true) failures.push("config_not_fully_verified");
  if (row.coverage.status !== "complete") failures.push("coverage_not_complete");
  if (row.firstAuthorityBlocker !== null) failures.push("decision_blocker_set");
  if (row.effectiveAuthorityBlocker !== null) failures.push("payload_blocker_set");
  if (row.blockedActionType !== null) failures.push("held_beside_authorized");
  return failures;
}

/**
 * Hydration's verified / complete claims against the independent reading at
 * the same cutoff. A claim the independent source contradicts is fail-open.
 */
export function crossCheckHydration(crossCheck: HydrationCrossCheck | null): {
  configContradictions: string[];
  coverageContradiction: string | null;
  coverageDisagreement: string | null;
  /** Why no independent reading exists; null when one does. */
  unavailable: string | null;
  /** Verified / complete claims left unchecked because the reading is unavailable. */
  unverifiableClaims: number;
} {
  const result = {
    configContradictions: [] as string[],
    coverageContradiction: null as string | null,
    coverageDisagreement: null as string | null,
    unavailable: null as string | null,
    unverifiableClaims: 0,
  };
  if (!crossCheck) {
    result.unavailable = "no cross-check recorded";
    return result;
  }
  const independent = crossCheck.independent;
  const claimsComplete = crossCheck.hydrationCoverage.complete ?? 0;
  if (!independent || independent.error !== null) {
    result.unavailable = independent?.error ?? "independent reading absent";
    result.unverifiableClaims = crossCheck.hydrationFullyVerified.length + claimsComplete;
    return result;
  }
  const campaigns = new Set(independent.objectiveAuthorityCampaigns);
  const adsets = new Set(independent.adsetGoalAuthorityAdsets);
  for (const claim of crossCheck.hydrationFullyVerified) {
    const reasons: string[] = [];
    if (claim.campaignId === null || !campaigns.has(claim.campaignId)) reasons.push(`campaign ${claim.campaignId ?? "null"} has no decision-authority objective day`);
    if (claim.adsetId === null || !adsets.has(claim.adsetId)) reasons.push(`adset ${claim.adsetId ?? "null"} has no decision-authority goal day`);
    if (reasons.length > 0) result.configContradictions.push(`${claim.adId}: ${reasons.join("; ")}`);
  }
  const portStatus = independent.coverage?.status ?? "unavailable";
  if (claimsComplete > 0 && portStatus !== "complete") {
    result.coverageContradiction = `${claimsComplete} ads claim complete coverage; the D101 port reads ${portStatus} (expected ${independent.coverage?.expectedThroughDay ?? "null"}, covered ${independent.coverage?.coverageThroughDay ?? "null"})`;
  }
  const hydrationNotComplete = Object.entries(crossCheck.hydrationCoverage)
    .filter(([status]) => status !== "complete")
    .reduce((sum, [, count]) => sum + count, 0);
  if (portStatus === "complete" && hydrationNotComplete > 0) {
    result.coverageDisagreement = `the D101 port reads complete but hydration reports ${JSON.stringify(crossCheck.hydrationCoverage)}`;
  } else if (portStatus !== "complete" && claimsComplete === 0 && hydrationNotComplete > 0) {
    const hydrationStatuses = Object.keys(crossCheck.hydrationCoverage).filter((status) => status !== "absent");
    if (hydrationStatuses.length > 0 && !hydrationStatuses.includes(portStatus)) {
      result.coverageDisagreement = `the D101 port reads ${portStatus} but hydration reports ${JSON.stringify(crossCheck.hydrationCoverage)}`;
    }
  }
  return result;
}

/* ================================================== cutoff-safe SQL */

/**
 * D101 coverage at explicit cutoffs: the production run slots, and the chain
 * cutoffs where it is compared with hydration's own coverage status.
 *
 * A PORT of three CTEs of HYDRATE_AD_DECISION_INPUTS_QUERY in
 * lib/creative-decision-engine/data-source.ts, with `$11` (the decision cutoff)
 * replaced by each slot's cutoff and the business/account fixed:
 *   account_identity                   -> the `account_identity` LATERAL below
 *   source_coverage_manifest_identity  -> the `manifest_identity` LATERAL below
 *   source_coverage_scope              -> `scoped` (timezone conflict => NULL)
 *   account_source_coverage            -> the `coverage` LATERAL + status CASE
 * Every predicate of the pointer -> slice -> same-run manifest chain is kept
 * verbatim. The as-of day of a slot is its UTC date, as the scheduler sets it.
 * Parameters: $1 business, $2 account id, $3 account ref uuid, then three
 * parallel arrays: $4 as-of days, $5 slot labels, $6 cutoffs
 * (see productionRunSlotCutoffs / chainCutoffSlots). Pinned predicate by
 * predicate against data-source.ts by the parity test.
 */
export const D101_COVERAGE_AT_CUTOFFS_SQL = `
WITH slots AS (
  SELECT slot.as_of::date AS as_of, slot.label AS slot, slot.cutoff::timestamptz AS cutoff
  FROM unnest($4::date[], $5::text[], $6::timestamptz[]) AS slot(as_of, label, cutoff)
),
identity AS (
  SELECT slots.*, account_identity.account_timezone AS account_identity_timezone,
         manifest_identity.account_timezone AS manifest_identity_timezone
  FROM slots
  LEFT JOIN LATERAL (
    SELECT NULLIF(BTRIM(d.account_timezone), '') AS account_timezone
    FROM meta_ad_daily d
    WHERE d.business_id = $1::text
      AND d.provider_account_ref_id = $3::uuid
      AND d.provider_account_id = $2
      AND d.date <= slots.as_of
      AND d.truth_state = 'finalized'
      AND d.validation_status = 'passed'
      AND d.created_at <= slots.cutoff
      AND d.updated_at <= slots.cutoff
      AND NULLIF(BTRIM(d.account_timezone), '') IS NOT NULL
      AND NULLIF(BTRIM(d.account_currency), '') IS NOT NULL
    ORDER BY d.date DESC, d.updated_at DESC, d.id DESC
    LIMIT 1
  ) account_identity ON TRUE
  LEFT JOIN LATERAL (
    SELECT NULLIF(BTRIM(manifest.account_timezone), '') AS account_timezone
    FROM meta_authoritative_publication_pointers pointer
    INNER JOIN meta_authoritative_slice_versions slice
      ON slice.id = pointer.active_slice_version_id
     AND slice.business_ref_id::text = $1::text
     AND slice.business_id = $1::text
     AND slice.provider_account_ref_id = $3::uuid
     AND slice.provider_account_id = $2
     AND slice.day = pointer.day
     AND slice.surface = pointer.surface
    INNER JOIN meta_authoritative_source_manifests manifest
      ON manifest.id = slice.manifest_id
     AND manifest.business_ref_id::text = $1::text
     AND manifest.business_id = $1::text
     AND manifest.provider_account_ref_id = $3::uuid
     AND manifest.provider_account_id = $2
     AND manifest.day = slice.day
     AND manifest.run_id = slice.source_run_id
    WHERE pointer.business_ref_id::text = $1::text
      AND pointer.business_id = $1::text
      AND pointer.provider_account_ref_id = $3::uuid
      AND pointer.provider_account_id = $2
      AND pointer.surface = 'ad_daily'
      AND pointer.published_by_run_id = slice.source_run_id
      AND manifest.fetch_status = 'completed'
      AND manifest.completed_at IS NOT NULL
      AND NULLIF(BTRIM(manifest.account_timezone), '') IS NOT NULL
      AND manifest.created_at <= slots.cutoff
      AND manifest.updated_at <= slots.cutoff
      AND manifest.completed_at <= slots.cutoff
      AND manifest.completed_at <= pointer.published_at
      AND manifest.completed_at <= slice.published_at
      AND manifest.completed_at >= ((pointer.day + 1)::timestamp AT TIME ZONE manifest.account_timezone)
      AND slice.state = 'finalized_verified'
      AND slice.truth_state = 'finalized'
      AND slice.validation_status = 'passed'
      AND slice.status = 'published'
      AND slice.created_at <= slots.cutoff
      AND slice.updated_at <= slots.cutoff
      AND slice.published_at IS NOT NULL
      AND slice.published_at <= slots.cutoff
      AND slice.published_at <= pointer.published_at
      AND pointer.created_at <= slots.cutoff
      AND pointer.updated_at <= slots.cutoff
      AND pointer.published_at <= slots.cutoff
    ORDER BY pointer.day DESC, pointer.published_at DESC, slice.candidate_version DESC
    LIMIT 1
  ) manifest_identity ON TRUE
),
scoped AS (
  SELECT identity.*,
    CASE
      WHEN account_identity_timezone IS NOT NULL
       AND manifest_identity_timezone IS NOT NULL
       AND account_identity_timezone <> manifest_identity_timezone
        THEN NULL
      ELSE COALESCE(account_identity_timezone, manifest_identity_timezone)
    END AS account_timezone
  FROM identity
),
expected AS (
  SELECT scoped.*,
    CASE WHEN scoped.account_timezone IS NOT NULL
      THEN ((scoped.cutoff AT TIME ZONE scoped.account_timezone)::date - 1)
    END AS expected_through_day
  FROM scoped
)
SELECT
  to_char(expected.as_of, 'YYYY-MM-DD') AS as_of,
  expected.slot,
  expected.cutoff,
  expected.account_timezone,
  expected.account_identity_timezone,
  expected.manifest_identity_timezone,
  to_char(expected.expected_through_day, 'YYYY-MM-DD') AS expected_through_day,
  to_char(coverage.coverage_through_day, 'YYYY-MM-DD') AS coverage_through_day,
  coverage.source_completed_at,
  coverage.published_at
FROM expected
LEFT JOIN LATERAL (
  SELECT pointer.day AS coverage_through_day, manifest.completed_at AS source_completed_at, pointer.published_at
  FROM meta_authoritative_publication_pointers pointer
  INNER JOIN meta_authoritative_slice_versions slice
    ON slice.id = pointer.active_slice_version_id
   AND slice.business_ref_id::text = $1::text
   AND slice.business_id = $1::text
   AND slice.provider_account_ref_id = $3::uuid
   AND slice.provider_account_id = $2
   AND slice.day = pointer.day
   AND slice.surface = pointer.surface
  INNER JOIN meta_authoritative_source_manifests manifest
    ON manifest.id = slice.manifest_id
   AND manifest.business_ref_id::text = $1::text
   AND manifest.business_id = $1::text
   AND manifest.provider_account_ref_id = $3::uuid
   AND manifest.provider_account_id = $2
   AND manifest.day = slice.day
   AND manifest.run_id = slice.source_run_id
  WHERE pointer.business_ref_id::text = $1::text
    AND pointer.business_id = $1::text
    AND pointer.provider_account_ref_id = $3::uuid
    AND pointer.provider_account_id = $2
    AND pointer.surface = 'ad_daily'
    AND pointer.day <= expected.expected_through_day
    AND pointer.published_by_run_id = slice.source_run_id
    AND NULLIF(BTRIM(manifest.account_timezone), '') = expected.account_timezone
    AND manifest.fetch_status = 'completed'
    AND manifest.completed_at IS NOT NULL
    AND manifest.created_at <= expected.cutoff
    AND manifest.updated_at <= expected.cutoff
    AND manifest.completed_at <= expected.cutoff
    AND manifest.completed_at <= pointer.published_at
    AND manifest.completed_at <= slice.published_at
    AND manifest.completed_at >= ((pointer.day + 1)::timestamp AT TIME ZONE expected.account_timezone)
    AND slice.state = 'finalized_verified'
    AND slice.truth_state = 'finalized'
    AND slice.validation_status = 'passed'
    AND slice.status = 'published'
    AND NULLIF(BTRIM(slice.source_run_id), '') IS NOT NULL
    AND slice.created_at <= expected.cutoff
    AND slice.updated_at <= expected.cutoff
    AND slice.published_at IS NOT NULL
    AND slice.published_at <= expected.cutoff
    AND slice.published_at <= pointer.published_at
    AND pointer.created_at <= expected.cutoff
    AND pointer.updated_at <= expected.cutoff
    AND pointer.published_at <= expected.cutoff
    AND pointer.published_at >= ((pointer.day + 1)::timestamp AT TIME ZONE expected.account_timezone)
  ORDER BY pointer.day DESC, pointer.published_at DESC, slice.candidate_version DESC
  LIMIT 1
) coverage ON TRUE
ORDER BY expected.cutoff`;

/**
 * Serve-time identity at the cutoff. Names and hierarchy ids come from the
 * dimension tables exactly as `readNativeSnapshotRows` joins them (Meta never
 * moves an ad between campaigns, and names are labels). The three STATUSES are
 * the latest `meta_entity_state_history` observation that existed at the
 * cutoff (observed, captured and created at or before it), not the latest
 * today, which is the one deliberate difference from the served reader.
 * Parameters: $1 business, $2 account, $3 ad ids, $4 creative ids, $5 as-of,
 * $6 account ref uuid, $7 cutoff.
 */
export const IDENTITY_AT_CUTOFF_SQL = `
WITH ids AS (
  SELECT unnest($3::text[]) AS ad_id, unnest($4::text[]) AS creative_id
), ad_daily AS MATERIALIZED (
  SELECT DISTINCT ON (daily.ad_id) daily.ad_id, daily.account_currency
  FROM meta_ad_daily daily
  WHERE daily.business_id = $1 AND daily.provider_account_id = $2
    AND daily.date <= $5::date AND daily.ad_id = ANY($3::text[])
  ORDER BY daily.ad_id, daily.date DESC, daily.updated_at DESC
)
SELECT ids.ad_id,
  creative_dim.creative_name,
  ad_dim.campaign_id,
  COALESCE(campaign_dim.campaign_name_current, campaign_dim.campaign_name_historical) AS campaign_name,
  ad_dim.adset_id,
  COALESCE(adset_dim.adset_name_current, adset_dim.adset_name_historical) AS adset_name,
  COALESCE(ad_dim.ad_name_current, ad_dim.ad_name_historical) AS ad_name,
  CASE WHEN campaign_state.presence = 'present' THEN COALESCE(campaign_state.effective_status, campaign_state.configured_status) END AS campaign_status,
  CASE WHEN adset_state.presence = 'present' THEN COALESCE(adset_state.effective_status, adset_state.configured_status) END AS adset_status,
  CASE WHEN ad_state.presence = 'present' THEN COALESCE(ad_state.effective_status, ad_state.configured_status) END AS ad_status,
  ad_daily.account_currency AS currency,
  COALESCE(media.table_thumbnail_url, media.thumbnail_url, media.card_preview_url, media.poster_url, media.image_url, media.preview_url, creative_dim.thumbnail_url) AS thumbnail_url,
  (media.creative_id IS NOT NULL OR creative_dim.creative_id IS NOT NULL OR ad_dim.creative_id IS NOT NULL) AS media_source_present,
  COALESCE(media.table_thumbnail_url, media.thumbnail_url, media.card_preview_url, media.poster_url, media.image_url, media.preview_url, media.video_url, creative_dim.thumbnail_url) IS NOT NULL AS media_available,
  CASE WHEN media.creative_id IS NOT NULL THEN 'meta_creative_media'
       WHEN creative_dim.creative_id IS NOT NULL THEN 'meta_creative_dimensions'
       WHEN ad_dim.ad_id IS NOT NULL THEN 'meta_ad_dimensions' END AS media_source,
  COALESCE(media.updated_at, creative_dim.updated_at, ad_dim.updated_at) AS source_updated_at
FROM ids
LEFT JOIN LATERAL (SELECT d.* FROM meta_ad_dimensions d WHERE d.business_id = $1 AND d.provider_account_id = $2 AND d.ad_id = ids.ad_id ORDER BY d.updated_at DESC LIMIT 1) ad_dim ON TRUE
LEFT JOIN LATERAL (SELECT d.* FROM meta_creative_dimensions d WHERE ids.creative_id IS NOT NULL AND d.business_id = $1 AND d.provider_account_id = $2 AND d.creative_id = ids.creative_id ORDER BY d.updated_at DESC LIMIT 1) creative_dim ON TRUE
LEFT JOIN LATERAL (SELECT s.* FROM meta_creative_media s WHERE ids.creative_id IS NOT NULL AND s.business_id = $1 AND s.provider_account_id = $2 AND s.creative_id = ids.creative_id ORDER BY s.date DESC, s.updated_at DESC LIMIT 1) media ON TRUE
LEFT JOIN ad_daily ON ad_daily.ad_id = ids.ad_id
LEFT JOIN LATERAL (SELECT d.* FROM meta_adset_dimensions d WHERE d.business_id = $1 AND d.provider_account_id = $2 AND d.adset_id = ad_dim.adset_id ORDER BY d.updated_at DESC LIMIT 1) adset_dim ON TRUE
LEFT JOIN LATERAL (SELECT d.* FROM meta_campaign_dimensions d WHERE d.business_id = $1 AND d.provider_account_id = $2 AND d.campaign_id = ad_dim.campaign_id ORDER BY d.updated_at DESC LIMIT 1) campaign_dim ON TRUE
LEFT JOIN LATERAL (
  SELECT st.presence, st.configured_status, st.effective_status FROM meta_entity_state_history st
  WHERE st.business_ref_id = $1::uuid AND st.business_id = $1 AND st.provider_account_ref_id = $6::uuid AND st.provider_account_id = $2
    AND st.entity_type = 'campaign' AND st.entity_id = ad_dim.campaign_id
    AND st.observed_at <= $7::timestamptz AND st.captured_at <= $7::timestamptz AND st.created_at <= $7::timestamptz
  ORDER BY st.observed_at DESC, st.captured_at DESC, st.id DESC LIMIT 1
) campaign_state ON TRUE
LEFT JOIN LATERAL (
  SELECT st.presence, st.configured_status, st.effective_status FROM meta_entity_state_history st
  WHERE st.business_ref_id = $1::uuid AND st.business_id = $1 AND st.provider_account_ref_id = $6::uuid AND st.provider_account_id = $2
    AND st.entity_type = 'adset' AND st.entity_id = ad_dim.adset_id
    AND st.observed_at <= $7::timestamptz AND st.captured_at <= $7::timestamptz AND st.created_at <= $7::timestamptz
  ORDER BY st.observed_at DESC, st.captured_at DESC, st.id DESC LIMIT 1
) adset_state ON TRUE
LEFT JOIN LATERAL (
  SELECT st.presence, st.configured_status, st.effective_status FROM meta_entity_state_history st
  WHERE st.business_ref_id = $1::uuid AND st.business_id = $1 AND st.provider_account_ref_id = $6::uuid AND st.provider_account_id = $2
    AND st.entity_type = 'ad' AND st.entity_id = ids.ad_id
    AND st.observed_at <= $7::timestamptz AND st.captured_at <= $7::timestamptz AND st.created_at <= $7::timestamptz
  ORDER BY st.observed_at DESC, st.captured_at DESC, st.id DESC LIMIT 1
) ad_state ON TRUE`;

export interface CoverageCutoffSlot {
  asOf: string;
  slot: string;
  cutoff: string;
}

/** Every production run slot of every window day, as D101_COVERAGE_AT_CUTOFFS_SQL takes them. */
export function productionRunSlotCutoffs(start: string, end: string): CoverageCutoffSlot[] {
  return enumerateUtcDays(start, end).flatMap((asOf) =>
    PRODUCTION_RUN_SLOTS.map((slot) => ({ asOf, slot: `${slot}Z`, cutoff: `${asOf}T${slot}:00.000Z` })),
  );
}

export function coverageSlotParams(slots: readonly CoverageCutoffSlot[]): [string[], string[], string[]] {
  return [slots.map((slot) => slot.asOf), slots.map((slot) => slot.slot), slots.map((slot) => slot.cutoff)];
}

/* ======================================================= runtime guard */

/** Why the harness must refuse to start; null when the process is UTC and read-only. */
export function evaluateRuntimeGuard(input: {
  tzEnv: string | undefined;
  timezoneOffsetMinutes: number;
  resolvedZone: string;
  pgOptions: string | undefined;
}): string | null {
  if (input.tzEnv !== "UTC" || input.timezoneOffsetMinutes !== 0 || !["UTC", "Etc/UTC"].includes(input.resolvedZone)) {
    return `TZ must resolve to UTC (TZ=${input.tzEnv ?? "unset"}, resolved ${input.resolvedZone}). Start with TZ=UTC; pg DATE handling in the served path is timezone-sensitive.`;
  }
  if (!/default_transaction_read_only\s*=\s*on/.test(input.pgOptions ?? "")) {
    return 'PGOPTIONS must carry "-c default_transaction_read_only=on"; this harness only runs in a read-only session.';
  }
  return null;
}

/* ================================================ synthetic calibration */

/**
 * The calibration batch id the in-memory profile source hands to production
 * code. It is UUID-shaped because the production contract regex requires a
 * UUID (ad-account-decision-profile.ts); it lives only in memory and must
 * never reach a generation row or the report (findLeakedIds).
 */
export const SIMULATED_CALIBRATION_BATCH_ID_PREFIX = "00000000-0000-4000-8000-";

export function simulatedCalibrationBatchId(batchIndex: number): string {
  return `${SIMULATED_CALIBRATION_BATCH_ID_PREFIX}${String(batchIndex + 1).padStart(12, "0")}`;
}

/** Which of `ids` occur in a serialized payload. */
export function findLeakedIds(serialized: string, ids: Iterable<string>): string[] {
  return [...new Set(ids)].filter((id) => serialized.includes(id));
}

const SIMULATED_CALIBRATION_BATCH_ID_PATTERN = /00000000-0000-4000-8000-\d{12}/g;

/** Every complete in-memory calibration batch id in a serialized payload (the prefix alone, as in prose, is not one). */
export function findLeakedCalibrationBatchIds(serialized: string): string[] {
  return [...new Set(serialized.match(SIMULATED_CALIBRATION_BATCH_ID_PATTERN) ?? [])];
}

/* ================================================================ report */

export interface SnapshotIdentity {
  transactionStartedAt: string;
  snapshotId: string;
}

export interface LaneFailure {
  status: "failed";
  error: string;
}

export interface ConfigTierSummary {
  /** The evaluation cutoff the tiers were read at. */
  cutoff: string;
  scopeRows: number;
  byTier: Record<string, number>;
  byReadiness: Record<string, number>;
  unknownTierStrings: number;
  /** SQL readiness differs from the production TypeScript ladder. */
  readinessDisagreements: number;
  /** SQL granted decision_authority where the ladder does not. */
  sqlGrantedBeyondLadder: number;
  decisionAuthorityDays: string[];
}

export interface CoverageSlotRecord {
  asOf: string;
  slot: string;
  cutoff: string;
  accountTimezone: string | null;
  expectedThroughDay: string | null;
  coverageThroughDay: string | null;
  status: CoverageStatus;
  lagDays: number | null;
}

export interface LedgerAccountReport {
  providerAccountId: string;
  providerAccountRefId: string;
  selected: boolean;
  adDays: Record<string, unknown>;
  restatedAfterCutoff: Array<Record<string, unknown>>;
  linkClicks: Record<string, number>;
  funnel: Record<string, Record<string, number>>;
  purchasesOnSpendRows: Record<string, number>;
  objective: ConfigTierSummary | null;
  adsetGoal: ConfigTierSummary | null;
  configObservations: Array<Record<string, unknown>>;
  coverageAtRunSlots: {
    counts: Record<string, number>;
    bySlot: Record<string, Record<string, number>>;
    slots: CoverageSlotRecord[];
  } | null;
  metaAov: Record<string, unknown> | null;
  targetAuthority: Record<string, unknown> | null;
}

export interface LedgerLaneReport {
  status: "computed";
  snapshot: SnapshotIdentity;
  runtimeMs: number;
  accounts: { selected: string[]; deselected: string[] };
  perAccount: LedgerAccountReport[];
  campaignContext: {
    resolverArmed: boolean;
    approvedVersion: string | null;
    requiredVersion: string;
    groups: Array<Record<string, unknown>>;
    byConfidenceClass: Record<string, number>;
    rowsMatchingRequiredResolver: number;
    rows: number;
    windowDaysWithoutRows: string[];
  };
  /** The existing simulator's business-wide 90-day count, per simulated cutoff. */
  restatedAfterCutoffBusiness90d: Array<Record<string, unknown>>;
}

export interface HardRowRecord {
  asOf: string;
  providerAccountId: string;
  adId: string;
  campaignId: string | null;
  adsetId: string | null;
  rawLabel: string;
  preAuthorityLabel: string | null;
  publishedLabel: string;
  hysteresisSuppressed: boolean;
  firstAuthorityBlocker: string | null;
  effectiveAuthorityBlocker: string | null;
  blockedActionType: string | null;
  authorizedAction: string | null;
  confidence: number | null;
  profileBlocker: string | null;
  /** Account-level profile; use cutEvidence for the effective per-ad Cut gate. */
  hardActionEligibility: { scale: boolean; cut: boolean; refresh: boolean };
  cutEvidence: {
    effectiveProfileEligible: boolean;
    canonicalProfileEligible: boolean | null;
    spend28d: number | null;
    purchases28d: number | null;
    accountAovZeroConversionSpendFloor: number | null;
    accountAovCommercialMaturitySpendFloor: number | null;
    decisionReason: string | null;
  } | null;
  config: {
    observed: boolean;
    fullyVerified: boolean;
    blockingField: string | null;
    weakestTier: string | null;
    unverifiedEconomicDayCount: number | null;
  };
  coverage: { status: string | null; expectedThroughDay: string | null; coverageThroughDay: string | null };
  dataFreshnessHours: number | null;
  role: { trust: RoleTrust; campaignRoleStatus: string | null; resolverArmed: boolean | null };
  priorSource: string | null;
  failedPredicates: string[];
}

export interface DecisionAccountDayReport {
  providerAccountId: string;
  receipt: {
    sourceComplete: boolean;
    hydrationComplete: boolean;
    authoritativeForPrune: boolean;
    expectedAdCount: number;
    hydratedAdCount: number;
    reason: string | null;
    gate: ReceiptGateResult;
  } | null;
  ads: number;
  rawHard: Record<string, number>;
  preAuthorityHard: Record<string, number>;
  publishedHard: Record<string, number>;
  hysteresisSuppressed: number;
  authorizedActions: Record<string, number>;
  blockedActionType: Record<string, number>;
  firstAuthorityBlocker: Record<string, number>;
  effectiveAuthorityBlocker: Record<string, number>;
  config: {
    observed: number;
    fullyVerified: number;
    blockingField: Record<string, number>;
  };
  coverage: Record<string, number>;
  calibration: Record<string, unknown>;
  role: {
    trust: Record<string, number>;
    resolverArmed: Record<string, number>;
    campaignRoleStatus: Record<string, number>;
  };
  priorSource: Record<string, number>;
  metrics: {
    linkClicks28d: Record<string, number>;
    spend: Record<string, number>;
    linkClicksZeroWithoutRows: number;
  };
  /** Hydration's own verified/complete claims beside an independent reading at the same cutoff. */
  crossCheck: HydrationCrossCheck | null;
}

/** An ad hydration calls fully config-verified. */
export interface VerifiedAdClaim {
  adId: string;
  campaignId: string | null;
  adsetId: string | null;
}

/**
 * The independent reading at one chain cutoff, inside the decision lane's own
 * snapshot: the ledger's production tier SQL (campaign objective, ad set goal)
 * over economic days, and the D101 port.
 */
export interface IndependentReading {
  cutoff: string;
  scope: { start: string; end: string };
  coverage: {
    status: CoverageStatus;
    expectedThroughDay: string | null;
    coverageThroughDay: string | null;
    accountTimezone: string | null;
  } | null;
  /** Campaigns with at least one decision_authority objective on an economic day. */
  objectiveAuthorityCampaigns: string[];
  objectiveEconomicCampaigns: number;
  /** Ad sets with at least one decision_authority optimization goal on an economic day. */
  adsetGoalAuthorityAdsets: string[];
  adsetGoalEconomicAdsets: number;
  error: string | null;
}

export interface HydrationCrossCheck {
  hydrationFullyVerified: VerifiedAdClaim[];
  hydrationCoverage: Record<string, number>;
  independent: IndependentReading | null;
}

export interface DecisionDayReport {
  asOf: string;
  cutoff: string;
  status: "computed" | "failed";
  reason: string | null;
  timingsMs: Record<string, number>;
  hashIntegrity: Record<string, unknown> | null;
  hysteresis: Record<string, number> | null;
  pointInTime: Record<string, unknown> | null;
  perAccount: DecisionAccountDayReport[];
  hardRows: HardRowRecord[];
}

export interface DecisionLaneReport {
  status: "computed" | "skipped";
  reason: string | null;
  snapshot: SnapshotIdentity | null;
  runtimeMs: number;
  policy: Record<string, unknown> | null;
  days: DecisionDayReport[];
}

/**
 * Which presented items rest on source rows: an ad is source-backed when its
 * decision input carries at least one metric row in the decision window
 * (metricEvidence.sourceRowCount > 0).
 */
export interface PresentationSourceBacking {
  basis: "metricEvidence.sourceRowCount_gt_0_in_decision_window";
  /** Generation ads with at least one source metric row. */
  sourceBackedAds: number;
  sourceBackedInventoryItems: number;
  sourceBackedBriefingCards: number;
  smallestAdLimit: number | null;
  sourceBackedOsItemsAtSmallestLimit: number;
  /** Distinct source-backed ads reaching a Briefing card or an OS row at the smallest limit. */
  sourceBackedPresentedAds: number;
}

export interface PresentationModeReport {
  mode: "actual_governance" | "governance_verified_counterfactual";
  governance: Record<string, unknown>;
  pipeline: { verified: boolean; executionReady: boolean; basis: string };
  inventory: Record<string, unknown>;
  sourceBacking: PresentationSourceBacking | null;
  briefing: {
    projectionNulls: number;
    statusFilter: "active";
    lanes: { action: number; watching: number; healthy: number };
    servedClassifications: number;
    studioAdsIndexed: number;
  } | null;
  authorityAudit: ServedAuthorityAudit;
  workspace: Array<{
    limit: number;
    status: string;
    os: Record<string, unknown> | null;
    heldServed: ReturnType<typeof locateHeldVerdicts> | null;
    eligiblePreCapCount: number | null;
    exactAdapter: Record<string, unknown> | null;
    error: string | null;
  }>;
}

export interface PresentationAccountReport {
  providerAccountId: string;
  asOf: string;
  cutoff: string;
  status: "presented" | "receipt_unreconstructable" | "refused" | "generation_invalid" | "failed";
  receiptGate: ReceiptGateResult;
  refusal: string | null;
  validation: { status: string; issue: string | null } | null;
  generation: {
    jobRunId: string;
    manifestHash: string;
    expectedAdCount: number;
    rows: number;
    lineageValidRows: number;
  } | null;
  identity: Record<string, unknown> | null;
  /** Cutoff-safe hierarchy statuses of the presented generation's ads. */
  hierarchyAtCutoff: HierarchyStatusDistribution | null;
  targetHardActionEligibility: Record<string, unknown> | null;
  modes: PresentationModeReport[];
  error: string | null;
}

export interface StatusBuckets {
  active: number;
  inactive: number;
  unknown: number;
}

/** ACTIVE / anything else / no status, per level, at the cutoff. */
export interface HierarchyStatusDistribution {
  ads: number;
  ad: StatusBuckets;
  adset: StatusBuckets;
  campaign: StatusBuckets;
  /** Ads whose ad, ad set and campaign are all ACTIVE at the cutoff. */
  allActive: number;
}

export function statusBucket(status: unknown): keyof StatusBuckets {
  if (status === null || status === undefined) return "unknown";
  const value = String(status).trim().toUpperCase();
  if (value === "" || value === "UNKNOWN") return "unknown";
  return value === "ACTIVE" ? "active" : "inactive";
}

export function summarizeHierarchyAtCutoff(
  rows: ReadonlyArray<{ ad_status?: unknown; adset_status?: unknown; campaign_status?: unknown }>,
): HierarchyStatusDistribution {
  const empty = (): StatusBuckets => ({ active: 0, inactive: 0, unknown: 0 });
  const distribution: HierarchyStatusDistribution = {
    ads: rows.length,
    ad: empty(),
    adset: empty(),
    campaign: empty(),
    allActive: 0,
  };
  for (const row of rows) {
    const ad = statusBucket(row.ad_status);
    const adset = statusBucket(row.adset_status);
    const campaign = statusBucket(row.campaign_status);
    distribution.ad[ad] += 1;
    distribution.adset[adset] += 1;
    distribution.campaign[campaign] += 1;
    if (ad === "active" && adset === "active" && campaign === "active") distribution.allActive += 1;
  }
  return distribution;
}

export function describeHierarchy(distribution: HierarchyStatusDistribution | null): string {
  if (!distribution) return "hierarchy at cutoff not recorded";
  const buckets = (value: StatusBuckets) => `${value.active} active/${value.inactive} inactive/${value.unknown} unknown`;
  return `hierarchy at cutoff over ${distribution.ads} ads: ad ${buckets(distribution.ad)}; adset ${buckets(distribution.adset)}; campaign ${buckets(distribution.campaign)}; all three ACTIVE ${distribution.allActive}`;
}

export interface PresentationLaneReport {
  status: "computed" | "skipped";
  reason: string | null;
  asOf: string | null;
  cutoff: string | null;
  accounts: PresentationAccountReport[];
}

export interface PersistedServedAccountReport {
  providerAccountId: string;
  bundle: {
    status: string;
    unavailableReason: string | null;
    validationIssue: string | null;
    /** Available, but the retained last-success generation because the latest run failed. */
    degraded: boolean;
  };
  latestRow: Record<string, unknown> | null;
  headEngineVersion: string;
  latestEngineMatchesHead: boolean | null;
  latestGenerationCounts: Record<string, unknown> | null;
  workspace: Record<string, unknown> | null;
}

export interface PersistedServedLaneReport {
  status: "computed";
  snapshot: SnapshotIdentity;
  runtimeMs: number;
  servingInstant: string;
  accounts: PersistedServedAccountReport[];
}

export interface NegativeControlReport {
  campaignId: string;
  /** The --window; nothing here is hard-coded. */
  from: string;
  to: string;
  snapshot: SnapshotIdentity | null;
  /** The simulated chain days (--chain) the control must hold on. */
  targetDays: string[];
  campaignFound: boolean;
  /** meta_ad_daily rows of the control campaign in from..to, per provider account. */
  campaignAccounts: Array<{
    providerAccountId: string;
    adDays: number;
    spendPositiveAdDays: number;
    targetDayAdDays: number;
  }>;
  /** The campaign's objective over the whole window, read at the window-end cutoff. */
  objectiveByDay: Array<{
    day: string;
    tier: string;
    readiness: string;
    value: string | null;
    pitClass: string | null;
  }>;
  /** Each target day's objective, read at THAT day's own cutoff. */
  objectiveAtTargetCutoffs: Array<{
    day: string;
    cutoff: string;
    providerAccountId: string;
    tier: string;
    readiness: string;
  }>;
  decisionAuthorityDays: string[];
  simulatedHardRows: HardRowRecord[];
  simulatedAuthorizedActions: number;
  persistedHardRows: Array<Record<string, unknown>>;
}

export interface BusinessAcceptanceReport {
  businessId: string;
  role: "subject" | "negative_control";
  ledger: LedgerLaneReport | LaneFailure;
  decisions: DecisionLaneReport | LaneFailure;
  presentation: PresentationLaneReport | LaneFailure;
  persistedServed: PersistedServedLaneReport | LaneFailure;
  negativeControl: NegativeControlReport | LaneFailure | null;
}

export interface AcceptanceReport {
  contract: typeof ACCEPTANCE_CONTRACT_VERSION;
  mode: AcceptanceMode;
  generatedAt: string;
  runtimeMs: number;
  args: Omit<AcceptanceArgs, "outPath" | "write"> & { outPath: string | null; write: boolean };
  runtime: Record<string, unknown>;
  claims: typeof ACCEPTANCE_CLAIMS;
  /** Which code this run certifies (read-only git + module hashes). */
  provenance: RunProvenance | null;
  businesses: BusinessAcceptanceReport[];
}

/* ============================================================= provenance */

export interface DirtyModule {
  /** Repository-relative path. */
  path: string;
  /** git status --porcelain XY code. */
  status: string;
  /** sha256 of the file content when the run started; null for a deleted file. */
  sha256: string | null;
  /** Not under scripts/ and not a test file. */
  production: boolean;
}

export interface RunProvenance {
  gitHead: string | null;
  /** `git status --porcelain=v1` lines at the start of the run. */
  gitStatusPorcelain: string[];
  moduleEnumeration: "require_cache" | "unavailable";
  loadedRepoModules: number;
  /** Loaded repo modules that differ from HEAD, with their content hash. */
  dirtyLoadedModules: DirtyModule[];
  /** Diagnostic subset of dirty loaded modules; not the code-identity gate. */
  dirtyProductionModules: string[];
  /** Porcelain lines that appeared or vanished, or a dirty loaded module whose hash changed, during the run. */
  changedDuringRun: string[];
  requireClean: boolean;
  /** "HEAD <sha>" only when every loaded repo module matches HEAD and no code changed during the run. */
  certifies: string;
}

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Parses `git status --porcelain=v1 -z` output into path -> XY status. Rename/copy sources are skipped. */
export function parseGitPorcelainZ(output: string): Map<string, string> {
  const entries = output.split("\0").filter((entry) => entry.length > 0);
  const dirty = new Map<string, string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    dirty.set(entry.slice(3), status);
    if (status[0] === "R" || status[0] === "C") index += 1; // the next entry is the source path
  }
  return dirty;
}

export function isProductionModulePath(repoRelativePath: string): boolean {
  return (
    !repoRelativePath.startsWith("scripts/") &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(repoRelativePath) &&
    !repoRelativePath.includes("/__tests__/")
  );
}

/**
 * Which code a run certifies. Pure: the CLI supplies git's answers and the
 * loaded-module list; any dirty loaded module means the verdict is about the
 * working tree, never HEAD. Production-only dirt is reported separately.
 */
export function summarizeProvenance(input: {
  gitHead: string | null;
  porcelainLines: readonly string[];
  dirty: ReadonlyMap<string, string>;
  loadedModules: readonly string[] | null;
  hashes: ReadonlyMap<string, string | null>;
  changedDuringRun?: readonly string[];
  requireClean: boolean;
}): RunProvenance {
  const loaded = input.loadedModules;
  const candidates = loaded === null ? [...input.dirty.keys()] : loaded.filter((module) => input.dirty.has(module));
  const dirtyLoadedModules: DirtyModule[] = [...new Set(candidates)].sort().map((module) => ({
    path: module,
    status: input.dirty.get(module) ?? "??",
    sha256: input.hashes.get(module) ?? null,
    production: isProductionModulePath(module),
  }));
  const dirtyProductionModules = dirtyLoadedModules.filter((module) => module.production).map((module) => module.path);
  const head = input.gitHead ?? "unknown";
  const changed = [...(input.changedDuringRun ?? [])];
  const certifies =
    dirtyLoadedModules.length === 0 && changed.length === 0 && input.gitHead !== null
      ? `HEAD ${head}`
      : `working tree (dirty: ${dirtyLoadedModules.length} loaded modules; ${dirtyProductionModules.length} production modules${changed.length > 0 ? `; ${changed.length} changed during the run` : ""}) on HEAD ${head}, not HEAD`;
  return {
    gitHead: input.gitHead,
    gitStatusPorcelain: [...input.porcelainLines],
    moduleEnumeration: loaded === null ? "unavailable" : "require_cache",
    loadedRepoModules: loaded?.length ?? 0,
    dirtyLoadedModules,
    dirtyProductionModules,
    changedDuringRun: changed,
    requireClean: input.requireClean,
    certifies,
  };
}

export interface ProvenanceSnapshot {
  gitHead: string | null;
  porcelainLines: string[];
  dirty: ReadonlyMap<string, string>;
  loadedModules: readonly string[] | null;
  hashes: ReadonlyMap<string, string | null>;
}

/**
 * What changed between the start and the end of a run that could matter to
 * what ran: HEAD, and every LOADED module (including one loaded lazily) whose
 * git status or content changed. A change to a module the run never loaded
 * cannot affect it and is not listed.
 */
export function diffProvenanceSnapshots(before: ProvenanceSnapshot, after: ProvenanceSnapshot): string[] {
  const changes: string[] = [];
  if (before.gitHead !== after.gitHead) changes.push(`HEAD ${before.gitHead} -> ${after.gitHead}`);
  const loaded =
    before.loadedModules === null || after.loadedModules === null
      ? new Set([...before.dirty.keys(), ...after.dirty.keys()])
      : new Set([...before.loadedModules, ...after.loadedModules]);
  for (const module of [...loaded].sort()) {
    const statusBefore = before.dirty.get(module) ?? "clean";
    const statusAfter = after.dirty.get(module) ?? "clean";
    if (statusBefore !== statusAfter) {
      changes.push(`${module}: ${statusBefore.trim() || "clean"} -> ${statusAfter.trim() || "clean"}`);
      continue;
    }
    if (before.hashes.has(module) && after.hashes.has(module) && before.hashes.get(module) !== after.hashes.get(module)) {
      changes.push(`${module}: content changed`);
    }
  }
  const lazy = (after.loadedModules ?? []).filter(
    (module) => !(before.loadedModules ?? []).includes(module) && after.dirty.has(module),
  );
  for (const module of lazy) changes.push(`${module}: loaded during the run while dirty`);
  return changes;
}

/** Why --require-clean refuses this run; empty when it does not. */
export function provenanceFailures(provenance: RunProvenance | null | undefined): string[] {
  if (!provenance || !provenance.requireClean) return [];
  const failures: string[] = [];
  if (provenance.gitHead === null) failures.push("--require-clean: git HEAD could not be read");
  if (provenance.dirtyLoadedModules.length > 0) {
    failures.push(
      `--require-clean: ${provenance.dirtyLoadedModules.length} loaded module(s) differ from HEAD: ${provenance.dirtyLoadedModules.slice(0, 10).map((module) => module.path).join(", ")}`,
    );
  }
  if (provenance.changedDuringRun.length > 0) {
    failures.push(`--require-clean: the working tree changed during the run: ${provenance.changedDuringRun.slice(0, 10).join(", ")}`);
  }
  return failures;
}

/* ================================================================ claims */

export const ACCEPTANCE_CLAIMS = {
  proven: [
    "Every database read ran in a REPEATABLE READ READ ONLY transaction pinned with pinReadOnlySnapshot, in a session whose default_transaction_read_only was verified on; one transaction per business-lane.",
    "Ledger counts come from production SQL builders (buildAdDayAuthoritativeLinkClicksSql, buildMetaFunnelStageSql, buildMetaConfigFieldSourceSql, buildMetaAdsetConfigFieldSourceSql, computeMetaAttributedAov, READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL) or from a cited port of the production D101 CTE.",
    "Decision-lane verdicts are the CURRENT code's: the exported production job functions (calibration batch, hydration, profile groups, campaign-role map, prior labels, ready/soft-only computation, toNativeSnapshotPayload) called the way runAdDecisionsJob calls them.",
    "An in-memory generation is presented only when its hydration receipt clears the production receipt gate, and only after validateMetaNativeDecisionGenerationBundle accepts it.",
    "Presentation counts are the production pure builders' output over that generation.",
  ],
  notProven: [
    "Not the integrated persisted job: calibration is recomputed in memory at the cutoff; evaluations, snapshots, change events, pruning and the job ledger are never produced.",
    "Not the policy in force at the cutoff: engine flags, CAMPAIGN_CONTEXT_* and the resolver-arming env are THIS process's current values.",
    "Not provider truth: no Meta/Graph call is made, so live ACTIVE inventory, pendingInventoryCount and the current-ads status reconciliation are not reproduced.",
    "Not the served pipeline health or governance at the cutoff: both are current-state; the actual-governance mode uses today's governance and a fail-closed pipeline, the counterfactual mode assumes both verified.",
    "Not a reconstruction of ad-days restated after a cutoff, of heartbeat-advanced observation runs, or of in-place updated D101 pointers; those are counted, never filled.",
    "Presentation names (campaign/ad set/ad/creative) come from present dimension tables; they are labels and decide nothing.",
    "Campaign-context rows for presentation are bounded by as_of_date but, like the production reader, not by updated_at.",
    "Presentation runs with 'now' equal to the cutoff and with lifecycle (event/outcome/response) sources absent, so the stale-decision path and lifecycle fields are not exercised.",
    "The config cross-check is necessary, not sufficient: it proves a verified ad's campaign and ad set had at least one decision-authority day at the cutoff, not every economic day of the ad.",
  ],
  syntheticIdentifiers:
    "Every id minted into a generation row or the report starts with 'read-only-simulation:' (job run per business/account/cutoff, evaluation and snapshot per decision hash). ONE in-memory id is UUID-shaped: the calibration batch id handed to production profile code (00000000-0000-4000-8000-<n>), because that contract's regex requires a UUID. It never reaches a generation row or the report; the harness searches the serialized report for it before writing and records a violation if it is found.",
  provenance:
    "The report records git HEAD, `git status --porcelain` and the sha256 of every loaded repo module that differs from HEAD (read-only git: rev-parse, --no-optional-locks status). A pass with any dirty loaded module, including acceptance scripts, certifies that working tree, never HEAD; --require-clean makes it NOT MET. The production-module count is diagnostic only.",
  hardAuthority:
    "PRESENCE (both gates) and HARD AUTHORITY are separate results. hardAuthorityOutcome is `demonstrated` only when a row on a successful simulated native decision day passes the full production authorization rule (published == raw == authorized hard action, not hysteresis-suppressed, eligible for that action, receipt gate passed, config observed and fully verified, coverage complete, both blockers null); otherwise `not_demonstrated` with raw / pre-authority / held counts and a blocker breakdown (objective_config, d101_coverage, role_campaign_context, hysteresis, profile_calibration_eligibility, receipt, other). In --knowledge-cutoffs replay this outcome refers ONLY to the native report-day cutoff shown in decisions.days, never to the later knowledge instant in args.chain; replay is diagnostic and cannot grant release or later-knowledge hard authority. A presence PASS never means a source-authorized Cut/Scale/Refresh. Only --require-hard-authority lets not_demonstrated change a release-mode exit code (NOT MET, exit 3).",
  hardRowCutEvidence:
    "hardRows[].hardActionEligibility is the account/group profile before per-ad gates. On a pre-authority Cut, cutEvidence.effectiveProfileEligible is the actual decision profile-gate result. Its candidate spend, purchases, canonical eligibility, account-AOV spend floors and decision reason explain an account-level Cut=true that still correctly ends review-only; the floors alone do not recalculate or grant authority.",
  cutoffs:
    "--cutoff-slot end-of-day (default, D T23:59:59.999Z) | natural-0305 (D T03:05Z) | natural-1505 D T15:05Z, --cutoffs <iso,...> (one per consecutive UTC day), or --knowledge-cutoffs <iso,...> (a later knowledge instant for each fixed report day). Every cutoff must be in the past. Replay is diagnostic only: the ledger/config/D101 reads use args.chain later knowledge instants, while the native calibration/decision/presentation lane uses decisions.days report-day UTC cutoffs. It cannot certify a later-knowledge native hard action or claim later evidence was known on the report day. At natural cutoffs the hydration receipt is often not reconstructable (last_seen_at is heartbeat-advanced in place); an account-day whose receipt fails the gate at its cutoff is reported as receipt_unreconstructable_at_cutoff, never repaired, and counts as a FAILED day. The ledger and the control read at the last chain cutoff.",
  crossCheck:
    "At every chain cutoff, inside the decision lane's own snapshot, hydration's fullyVerified and complete-coverage claims are read against the ledger's production tier SQL (objective per campaign, optimization goal per ad set, economic days) and the D101 port. A claim the independent reading contradicts is a violation; a claim with no independent reading fails the gate.",
  decisionLane: {
    cutoffChoice:
      "Each simulated native day uses its report-day cutoff. In replay, args.chain records a separate later knowledge instant for independent ledger/config/D101 diagnostics, while decisions.days and presentation retain the native report-day cutoff; no later source is borrowed by native calibration. The production 03:0x/15:0x slots are often NOT reconstructable for the hydration receipt: READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY needs a complete observation run whose COALESCE(last_seen_at, observed_at) falls between the as-of day and the cutoff, and last_seen_at / last_captured_at are heartbeat-advanced IN PLACE, so a run that was complete at a production slot now carries a last_seen after that slot and the receipt reads complete_source_run_missing. A failed receipt is reported receipt_unreconstructable.",
    chainedHysteresis:
      "Days are chained: each simulated day's published labels are carried in memory as the next day's prior, exactly like native-ad-current-code-historical-simulation.",
  },
  ledgerLane: {
    d101:
      "D101 coverage is reported at the production run slots 03:05Z and 15:05Z for every window day by a port of source_coverage_manifest_identity / source_coverage_scope / account_source_coverage (lib/creative-decision-engine/data-source.ts). Pointer clocks are current-state, so days republished later are understated.",
    missingVersusZero:
      "Link clicks and funnel stages are split into measured / missing-with-reason; purchases carry zero_without_actions_key separately and are never reported as measured zero.",
  },
  exitCodes: {
    "0": "RELEASE mode: the --gate verdict (pre_deploy or post_deploy) is met for every --business AND no invariant violation",
    "1": "at least one invariant VIOLATION (fail-open or fabrication), in either mode",
    "2": "usage error or read-only / UTC guard refused to run",
    "3": "RELEASE mode: the --gate verdict is NOT met (a failed day, including a receipt unreconstructable at its cutoff, or a failed presentation, no successful day or presentation, a failed lane, an empty presentation with no source-backed decision reaching the UI, a negative control that is NOT MET, --require-clean on dirty loaded modules, --require-hard-authority without a demonstrated source-authorized hard action, or no available persisted-served generation) or the harness crashed",
    "4": "DIAGNOSTIC mode (--skip-decisions, --diagnostic or --knowledge-cutoffs) finished without a violation; a diagnostic run is never release success",
  },
  releaseGates: {
    pre_deploy:
      "Every --business: no lane failed; no simulated decision day failed and at least one succeeded with at least one ad decision; no hydration claim went without an independent reading; no presentation raised, none whose receipt passed produced an invalid or refused generation, and at least one account was presented; PRESENCE (below) holds; the persisted-served lane ran, and its answer is either an available generation or native_latest_job_engine_mismatch whose latest persisted run is a complete success (receipt hydrated == expected, manifest match, authoritative). No new-epoch persisted generation is required. With --negative-control, the NEGATIVE CONTROL (below) must be MET. With --require-clean, no loaded repo module may differ from HEAD.",
    post_deploy:
      "Everything in pre_deploy, and the persisted-served path returned an AVAILABLE, non-degraded generation in HEAD's epoch for every selected account.",
    presence:
      "A passing receipt and hash over nothing is not a pass. At least one presented account, in the actual-governance mode, must carry: decision (generation) rows > 0; ledger ad-day rows in the window > 0; canonical inventory items > 0 of which > 0 are source-backed (the ad has metric rows in the decision window); active-filter Briefing cards > 0 and served classifications > 0; OS/workspace rows > 0 at the smallest --ad-limits value; and at least one source-backed ad reaching a Briefing card or that OS row set. No hard or authorized action is ever required.",
    negativeControl:
      "Optional (--negative-control <business> with --negative-control-campaign <id>; nothing is hard-coded, the dates are the --window and the target days are the --chain days). When given, it counts only when source-backed and meaningful: the control business has ledger ad-days; the campaign has meta_ad_daily rows in the window on a selected account; on every target day the campaign's objective, read at THAT day's cutoff, exists and is not decision_authority; and at least one held or raw hard verdict for the campaign on a target day comes from real data (a successful simulated day, or a persisted snapshot row) and stays unauthorized. No authorized hard verdict for the campaign is allowed. Anything absent => negative control NOT MET => the gate is NOT MET. Without it, the run records the labelled observation negative_control_not_requested.",
    selection:
      "The JSON always carries both verdicts from the same lanes; --gate (default pre_deploy) picks the one the exit code follows.",
  },
  releaseAcceptance:
    "A release run passes only if, for EVERY --business: no lane failed; no simulated decision day failed and at least one day succeeded with ad decisions (every account's hydration receipt passed the production gate, canonical hash integrity verified, no exception); no per-account presentation raised and at least one account was presented (canonical inventory, briefing projection with zero nulls, workspace/OS presentation at every --ad-limits value without error, in both governance modes) AND carries a source-backed decision into the Briefing and the OS rows (releaseGates.presence); and the persisted-served path met the selected gate. With --negative-control, the control must be MET (releaseGates.negativeControl), not merely have run.",
} as const;

/* ============================================================ invariants */

export interface InvariantFinding {
  code: string;
  businessId: string;
  providerAccountId?: string | null;
  asOf?: string | null;
  count?: number;
  detail: string;
  sample?: string[];
}

export interface InvariantEvaluation {
  violations: InvariantFinding[];
  observations: InvariantFinding[];
  laneFailures: InvariantFinding[];
}

/**
 * The cross-check of one account-day, including a day recorded without one
 * (then every claim hydration made there is unverifiable).
 */
export function crossCheckAccountDay(account: DecisionAccountDayReport) {
  if (account.crossCheck) return crossCheckHydration(account.crossCheck);
  const result = crossCheckHydration(null);
  result.unverifiableClaims = account.config.fullyVerified + (account.coverage.complete ?? 0);
  return result;
}

function isFailure(value: unknown): value is LaneFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "failed" &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

function sumRecord(record: Record<string, number> | null | undefined, keys?: readonly string[]) {
  if (!record) return 0;
  return Object.entries(record)
    .filter(([key]) => (keys ? keys.includes(key) : true))
    .reduce((sum, [, value]) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function sample(values: readonly string[], limit = 10): string[] {
  return values.slice(0, limit);
}

/**
 * Separates FAIL-OPEN / FABRICATION (violations) from expected SOURCE GAPS
 * (observations). A source gap is reported, never a failure: the harness
 * exists to show where the evidence runs out, and only an authority granted
 * without evidence, or evidence invented, fails it.
 */
export function evaluateAcceptanceInvariants(report: {
  businesses: readonly BusinessAcceptanceReport[];
  args?: { negativeControl: string | null };
}): InvariantEvaluation {
  const violations: InvariantFinding[] = [];
  const observations: InvariantFinding[] = [];
  const laneFailures: InvariantFinding[] = [];
  if (report.args && report.args.negativeControl === null) {
    observations.push({
      code: "negative_control_not_requested",
      businessId: "-",
      detail: "no --negative-control given: this run demonstrates no fail-closed control (labelled; not a gate failure)",
    });
  }

  for (const business of report.businesses) {
    const businessId = business.businessId;
    const lanes: Array<[string, unknown]> = [
      ["ledger", business.ledger],
      ["decisions", business.decisions],
      ["presentation", business.presentation],
      ["persistedServed", business.persistedServed],
      ["negativeControl", business.negativeControl],
    ];
    for (const [lane, value] of lanes) {
      if (isFailure(value)) {
        laneFailures.push({
          code: "lane_failed",
          businessId,
          detail: `${lane}: ${value.error}`,
        });
      }
    }

    /* ---------------------------------------------------------- ledger */
    if (!isFailure(business.ledger)) {
      const ledger = business.ledger;
      if (!ledger.campaignContext.resolverArmed) {
        observations.push({
          code: "role_resolver_unarmed",
          businessId,
          detail: `CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION is not armed in this process (required ${ledger.campaignContext.requiredVersion}); a high-confidence role row is served at medium trust.`,
        });
      }
      if (ledger.campaignContext.windowDaysWithoutRows.length > 0) {
        observations.push({
          code: "role_context_rows_absent",
          businessId,
          count: ledger.campaignContext.windowDaysWithoutRows.length,
          detail: "window days with no engine_v3_campaign_context_daily row",
          sample: sample(ledger.campaignContext.windowDaysWithoutRows),
        });
      }
      for (const account of ledger.perAccount) {
        const providerAccountId = account.providerAccountId;
        const lcContradictions = sumRecord(account.linkClicks, [
          "contradiction_zero_without_provenance",
          "contradiction_negative",
        ]);
        if (lcContradictions > 0) {
          violations.push({
            code: "missing_metric_counted_as_measured_zero",
            businessId,
            providerAccountId,
            count: lcContradictions,
            detail: "the authoritative link-click expression returned a zero/negative without row-local provenance",
          });
        }
        const lcAbsent = account.linkClicks.missing_actions_absent ?? 0;
        if (lcAbsent > 0) {
          observations.push({
            code: "link_clicks_missing_actions_absent",
            businessId,
            providerAccountId,
            count: lcAbsent,
            detail: "finalized ad-days whose actions key is absent without a complete published Graph receipt",
          });
        }
        const lcProviderZero = account.linkClicks.measured_zero_provider_receipt ?? 0;
        if (lcProviderZero > 0) {
          observations.push({
            code: "link_clicks_provider_zero_verified", businessId,
            providerAccountId, count: lcProviderZero,
            detail: "zero link clicks supported by the complete published Graph ad Insights receipt",
          });
        }
        for (const [stage, states] of Object.entries(account.funnel)) {
          const contradictions = states.contradiction_measured_without_actions ?? 0;
          if (contradictions > 0) {
            violations.push({
              code: "missing_metric_counted_as_measured_zero",
              businessId,
              providerAccountId,
              count: contradictions,
              detail: `${stage}: measured state without an actions array`,
            });
          }
        }
        const purchaseContradictions =
          account.purchasesOnSpendRows.contradiction_positive_without_actions_key ?? 0;
        if (purchaseContradictions > 0) {
          observations.push({
            code: "purchase_positive_without_actions_key",
            businessId,
            providerAccountId,
            count: purchaseContradictions,
            detail: "conversions > 0 on a row with no actions key",
          });
        }
        const zeroWithoutKey = account.purchasesOnSpendRows.zero_without_actions_key ?? 0;
        if (zeroWithoutKey > 0) {
          observations.push({
            code: "purchases_zero_without_actions_key",
            businessId,
            providerAccountId,
            count: zeroWithoutKey,
            detail: "spend > 0 ad-days whose zero purchases carry no actions key and no verified complete provider receipt; purchase evidence remains unknown",
          });
        }
        const providerZero = account.purchasesOnSpendRows.provider_zero_verified ?? 0;
        if (providerZero > 0) observations.push({
          code: "purchases_provider_zero_verified", businessId,
          providerAccountId, count: providerZero,
          detail: "spend > 0 ad-days with an omitted actions key and a complete published Graph receipt; measured zero",
        });
        for (const [field, summary] of [
          ["objective", account.objective],
          ["adset_goal", account.adsetGoal],
        ] as const) {
          if (!summary) continue;
          if (summary.sqlGrantedBeyondLadder > 0) {
            violations.push({
              code: "config_readiness_granted_beyond_contract",
              businessId,
              providerAccountId,
              count: summary.sqlGrantedBeyondLadder,
              detail: `${field}: SQL readiness decision_authority where readinessForConfigFieldTier does not grant it`,
            });
          }
          const withoutAuthority = summary.scopeRows - (summary.byReadiness.decision_authority ?? 0);
          if (withoutAuthority > 0) {
            observations.push({
              code: field === "objective" ? "objective_receipts_absent_or_review_only" : "adset_goal_receipts_absent_or_review_only",
              businessId,
              providerAccountId,
              count: withoutAuthority,
              detail: `${withoutAuthority} of ${summary.scopeRows} economic ${field === "objective" ? "campaign" : "ad set"}-days lack decision-authority config receipts (${JSON.stringify(summary.byTier)})`,
            });
          }
        }
        const absentDays = account.configObservations.filter((row) => Number(row.obs ?? 0) === 0);
        if (absentDays.length > 0) {
          observations.push({
            code: "config_observations_absent",
            businessId,
            providerAccountId,
            count: absentDays.length,
            detail: "endpoint-days with no campaign_configs / adset_configs observation at all",
            sample: sample(absentDays.map((row) => `${row.endpoint}:${row.utcDay}`)),
          });
        }
        const http400Days = account.configObservations.filter(
          (row) => Number(row.http400 ?? 0) > 0 && Number(row.complete200 ?? 0) === 0,
        );
        if (http400Days.length > 0) {
          observations.push({
            code: "config_observations_http_400_only",
            businessId,
            providerAccountId,
            count: http400Days.length,
            detail: "endpoint-days whose config observations were all HTTP 400 (no complete 200)",
            sample: sample(http400Days.map((row) => `${row.endpoint}:${row.utcDay}`)),
          });
        }
        if (account.coverageAtRunSlots) {
          const partial = account.coverageAtRunSlots.counts.partial ?? 0;
          const unavailable = account.coverageAtRunSlots.counts.unavailable ?? 0;
          const total = account.coverageAtRunSlots.slots.length;
          if (partial > 0) {
            observations.push({
              code: "coverage_partial_by_timing",
              businessId,
              providerAccountId,
              count: partial,
              detail: `${partial} of ${total} production run slots see D101 coverage partial (lags ${JSON.stringify(countBy(account.coverageAtRunSlots.slots.filter((slot) => slot.status === "partial"), (slot) => slot.lagDays))} days)`,
            });
          }
          if (unavailable > 0) {
            observations.push({
              code: "coverage_unavailable",
              businessId,
              providerAccountId,
              count: unavailable,
              detail: `${unavailable} of ${total} production run slots see no D101 coverage`,
            });
          }
        }
        const restated = account.restatedAfterCutoff.reduce(
          (sum, row) =>
            sum + Number((row.hydrationWindow28d as Record<string, unknown> | undefined)?.restatedRows ?? 0),
          0,
        );
        if (restated > 0) {
          observations.push({
            code: "restated_after_cutoff",
            businessId,
            providerAccountId,
            count: restated,
            detail: "hydration-window ad-days rewritten after a simulated cutoff (invisible at that cutoff, counted, never reconstructed)",
          });
        }
        const lateVisible = Number(account.adDays.currentVersionVisibleAfter72h ?? 0);
        if (lateVisible > 0) {
          observations.push({
            code: "ad_days_first_visible_after_72h",
            businessId,
            providerAccountId,
            count: lateVisible,
            detail: "finalized ad-days whose current version became visible more than 72h after local day close",
          });
        }
      }
    }

    /* ------------------------------------------------------- decisions */
    if (!isFailure(business.decisions)) {
      for (const day of business.decisions.days) {
        if (day.status === "failed") {
          laneFailures.push({
            code: "decision_day_failed",
            businessId,
            asOf: day.asOf,
            detail: day.reason ?? "day failed",
          });
          continue;
        }
        for (const row of day.hardRows) {
          if (row.authorizedAction === null) continue;
          const receiptPassed =
            day.perAccount.find((account) => account.providerAccountId === row.providerAccountId)?.receipt?.gate.pass === true;
          const failures = authorizationGroundingFailures(row, receiptPassed);
          if (failures.length > 0) {
            violations.push({
              code: "authorized_action_without_evidence",
              businessId,
              providerAccountId: row.providerAccountId,
              asOf: day.asOf,
              detail: `ad ${row.adId} authorizes ${row.authorizedAction} but fails: ${failures.join(", ")} (raw ${row.rawLabel}, published ${row.publishedLabel}, config observed=${row.config.observed} fullyVerified=${row.config.fullyVerified}, coverage ${row.coverage.status}, blockers ${row.firstAuthorityBlocker}/${row.effectiveAuthorityBlocker})`,
            });
          }
        }
        for (const account of day.perAccount) {
          const authorized = sumRecord(account.authorizedActions) - (account.authorizedActions.none ?? 0);
          const listed = day.hardRows.filter(
            (row) => row.providerAccountId === account.providerAccountId && row.authorizedAction !== null,
          ).length;
          if (authorized !== listed) {
            violations.push({
              code: "authorized_action_unaccounted",
              businessId,
              providerAccountId: account.providerAccountId,
              asOf: day.asOf,
              detail: `${authorized} authorized actions counted but ${listed} listed with their evidence chain`,
            });
          }
          if (account.metrics.linkClicksZeroWithoutRows > 0) {
            violations.push({
              code: "missing_metric_counted_as_measured_zero",
              businessId,
              providerAccountId: account.providerAccountId,
              asOf: day.asOf,
              count: account.metrics.linkClicksZeroWithoutRows,
              detail: "28d link clicks hydrated as a measured 0 for an ad with no source rows",
            });
          }
          const spendContradictions = account.metrics.spend.contradiction_spend_without_rows ?? 0;
          if (spendContradictions > 0) {
            violations.push({
              code: "metric_without_source_rows",
              businessId,
              providerAccountId: account.providerAccountId,
              asOf: day.asOf,
              count: spendContradictions,
              detail: "non-zero spend hydrated for an ad with no source rows",
            });
          }
          const noRowZero = account.metrics.spend.no_row_in_window ?? 0;
          if (noRowZero > 0) {
            observations.push({
              code: "spend_zero_no_row_in_window",
              businessId,
              providerAccountId: account.providerAccountId,
              asOf: day.asOf,
              count: noRowZero,
              detail: "ads with no ad-day row in the window carry spend 0: no row in window (zero delivery or restated)",
            });
          }
          const crossCheck = crossCheckAccountDay(account);
          if (crossCheck.configContradictions.length > 0) {
            violations.push({
              code: "hydration_config_verified_without_independent_receipt",
              businessId,
              providerAccountId: account.providerAccountId,
              asOf: day.asOf,
              count: crossCheck.configContradictions.length,
              detail: "hydration calls the ad's decision economics fully config-verified, but the ledger's tier SQL at the same cutoff finds no decision-authority objective (campaign) or goal (ad set) day",
              sample: sample(crossCheck.configContradictions),
            });
          }
          if (crossCheck.coverageContradiction) {
            violations.push({
              code: "hydration_coverage_complete_without_d101",
              businessId,
              providerAccountId: account.providerAccountId,
              asOf: day.asOf,
              detail: crossCheck.coverageContradiction,
            });
          }
          if (crossCheck.coverageDisagreement) {
            observations.push({
              code: "d101_port_disagrees_with_hydration",
              businessId,
              providerAccountId: account.providerAccountId,
              asOf: day.asOf,
              detail: `${crossCheck.coverageDisagreement} (fail-closed direction)`,
            });
          }
          if (crossCheck.unavailable) {
            (crossCheck.unverifiableClaims > 0 ? laneFailures : observations).push({
              code: "hydration_cross_check_unavailable",
              businessId,
              providerAccountId: account.providerAccountId,
              asOf: day.asOf,
              count: crossCheck.unverifiableClaims,
              detail: `no independent reading at ${day.cutoff}: ${crossCheck.unavailable}; ${crossCheck.unverifiableClaims} verified/complete claims unchecked`,
            });
          }
          if (account.receipt && !account.receipt.gate.pass) {
            observations.push({
              code: "receipt_unreconstructable_at_cutoff",
              businessId,
              providerAccountId: account.providerAccountId,
              asOf: day.asOf,
              detail: `hydration receipt fails the production gate at ${day.cutoff}: ${account.receipt.gate.failures.join(", ")} (reason ${account.receipt.reason})`,
            });
          }
          const nonComplete = sumRecord(account.coverage) - (account.coverage.complete ?? 0);
          if (nonComplete > 0) {
            observations.push({
              code: "decision_coverage_not_complete",
              businessId,
              providerAccountId: account.providerAccountId,
              asOf: day.asOf,
              count: nonComplete,
              detail: `ads whose D101 coverage is not complete at the simulated cutoff (${JSON.stringify(account.coverage)})`,
            });
          }
          const notVerified = account.ads - account.config.fullyVerified;
          if (notVerified > 0) {
            observations.push({
              code: "decision_config_not_fully_verified",
              businessId,
              providerAccountId: account.providerAccountId,
              asOf: day.asOf,
              count: notVerified,
              detail: `ads whose decision economics are not fully config-verified (blocking field ${JSON.stringify(account.config.blockingField)})`,
            });
          }
        }
      }
    }

    /* ---------------------------------------------------- presentation */
    if (!isFailure(business.presentation)) {
      for (const account of business.presentation.accounts) {
        const providerAccountId = account.providerAccountId;
        if (account.status === "presented" && !account.receiptGate.pass) {
          violations.push({
            code: "generation_presented_from_non_authoritative_receipt",
            businessId,
            providerAccountId,
            asOf: account.asOf,
            detail: `presented although the receipt fails: ${account.receiptGate.failures.join(", ")}`,
          });
        }
        if (account.generation && !account.generation.jobRunId.startsWith(SYNTHETIC_ID_PREFIX)) {
          violations.push({
            code: "non_synthetic_identifier",
            businessId,
            providerAccountId,
            detail: `simulated job run id "${account.generation.jobRunId}" is not visibly synthetic`,
          });
        }
        if (account.status === "receipt_unreconstructable") {
          observations.push({
            code: "presentation_withheld_receipt_unreconstructable",
            businessId,
            providerAccountId,
            asOf: account.asOf,
            detail: `nothing presented: ${account.receiptGate.failures.join(", ")}`,
          });
        }
        if (account.status === "failed") {
          laneFailures.push({
            code: "presentation_failed",
            businessId,
            providerAccountId,
            asOf: account.asOf,
            detail: account.error ?? account.refusal ?? "presentation raised",
          });
        }
        if (account.status === "generation_invalid" || account.status === "refused") {
          observations.push({
            code: "presentation_withheld_generation_invalid",
            businessId,
            providerAccountId,
            asOf: account.asOf,
            detail: `${account.status}: ${account.refusal ?? account.validation?.issue ?? "unknown"}`,
          });
        }
        for (const mode of account.modes) {
          const audit = mode.authorityAudit;
          const failOpen: Array<[string, string[]]> = [
            ["served_action_eligible_without_authorized_action", audit.actionEligibleWithoutAuthorized],
            ["served_authorized_action_differs_from_generation", audit.authorizedActionMismatch],
            ["action_lane_card_without_authorized_action", audit.briefingActionWithoutAuthorized],
            ["executable_os_row_without_authorized_action", audit.osExecutableWithoutAuthorized],
            ["held_hard_verdict_absent_from_canonical_inventory", audit.heldMissingFromInventory],
            ["held_hard_verdict_not_carried_as_held", audit.heldActionNotCarried],
            ["exact_adapter_row_offers_write_without_authorized_action", audit.exactAdapterWriteWithoutAuthorized ?? []],
            ["exact_adapter_row_without_os_item", audit.exactAdapterRowsWithoutOsItem ?? []],
          ];
          for (const [code, adIds] of failOpen) {
            if (adIds.length > 0) {
              violations.push({
                code,
                businessId,
                providerAccountId,
                asOf: account.asOf,
                count: adIds.length,
                detail: `${mode.mode}`,
                sample: sample(adIds),
              });
            }
          }
          if (mode.briefing && mode.briefing.projectionNulls > 0) {
            violations.push({
              code: "briefing_projection_null",
              businessId,
              providerAccountId,
              asOf: account.asOf,
              count: mode.briefing.projectionNulls,
              detail: `${mode.mode}: projectCanonicalNativeAdDecisionToBriefing returned null (the route would blank the whole surface)`,
            });
          }
          if (mode.mode !== "actual_governance") continue;
          const maxLimit = Math.max(...mode.workspace.map((entry) => entry.limit));
          for (const entry of mode.workspace) {
            if (entry.error) {
              laneFailures.push({
                code: "presentation_build_failed",
                businessId,
                providerAccountId,
                detail: `limit ${entry.limit}: ${entry.error}`,
              });
              continue;
            }
            const notServed = entry.heldServed?.notServed ?? [];
            if (notServed.length > 0) {
              observations.push({
                code:
                  entry.limit < maxLimit
                    ? "cap_hides_held_verdicts"
                    : "held_verdicts_not_served_at_max_limit",
                businessId,
                providerAccountId,
                asOf: account.asOf,
                count: notServed.length,
                detail: `limit ${entry.limit}: ${notServed.length} of ${entry.heldServed?.held ?? 0} held hard verdicts are neither a served Creatives row nor archived`,
                sample: sample(notServed),
              });
            }
          }
        }
      }
    }

    /* ------------------------------------------------ persisted served */
    if (!isFailure(business.persistedServed)) {
      for (const account of business.persistedServed.accounts) {
        if (account.bundle.status !== "available") {
          observations.push({
            code:
              account.bundle.unavailableReason === "native_latest_job_engine_mismatch"
                ? "persisted_served_engine_mismatch"
                : "persisted_served_unavailable",
            businessId,
            providerAccountId: account.providerAccountId,
            detail: `HEAD would serve no native generation: ${account.bundle.unavailableReason}${account.latestRow ? ` (latest persisted epoch ${String(account.latestRow.engine_version)}, as of ${String(account.latestRow.as_of_date)})` : ""}`,
          });
        }
      }
    }

    /* ------------------------------------------------ negative control */
    if (business.role === "negative_control") {
      const control = business.negativeControl;
      if (control && !isFailure(control)) {
        if (control.decisionAuthorityDays.length > 0) {
          // Not fail-open by itself: a receipt that arrives later can bracket an earlier day at the
          // window-end cutoff. The gate reads each target day at ITS OWN cutoff (negative_control_no_source_gap).
          observations.push({
            code: "negative_control_objective_verified",
            businessId,
            count: control.decisionAuthorityDays.length,
            detail: `campaign ${control.campaignId} objective reads decision_authority at the window-end cutoff on these days; the control's source gap is judged per target-day cutoff`,
            sample: sample(control.decisionAuthorityDays),
          });
        }
        const heldHard = [
          ...control.simulatedHardRows
            .filter((row) => row.authorizedAction === null)
            .map((row) => `simulated:${row.asOf}:${row.adId}:${row.rawLabel}->${row.publishedLabel}:${row.effectiveAuthorityBlocker ?? "hysteresis"}`),
          ...control.persistedHardRows.map(
            (row) => `persisted:${String(row.as_of_date)}:${String(row.ad_id)}:${String(row.raw_label)}->${String(row.label)}:${String(row.authority_blocker)}`,
          ),
        ];
        if (heldHard.length > 0) {
          observations.push({
            code: "negative_control_hard_verdicts_held",
            businessId,
            count: heldHard.length,
            detail: `campaign ${control.campaignId}: hard verdicts present and withheld (expected for this control)`,
            sample: sample(heldHard),
          });
        }
      }
      // The same findings make the gate's negative control NOT MET (evaluateReleaseAcceptance).
      for (const finding of evaluateNegativeControl(business).findings) {
        if (finding.code === "negative_control_lane_failed") continue; // already a lane failure
        observations.push({ code: finding.code, businessId, detail: finding.detail });
      }
      if (!isFailure(business.decisions)) {
        const authorized = business.decisions.days.flatMap((day) =>
          day.hardRows.filter((row) => row.authorizedAction !== null),
        );
        if (authorized.length > 0) {
          violations.push({
            code: "negative_control_authorized_action",
            businessId,
            count: authorized.length,
            detail: "the negative-control business produced an authorized action",
            sample: sample(authorized.map((row) => `${row.asOf}:${row.adId}:${row.authorizedAction}`)),
          });
        }
      }
    }
  }

  return { violations, observations, laneFailures };
}

/* =============================================================== summary */

export interface AcceptanceSummaryRow {
  business: string;
  role: string;
  lanes: string;
  accounts: string;
  adDays: string;
  lcMissing: string;
  purchZeroNoKey: string;
  objectiveAuthority: string;
  covCompleteSlots: string;
  aov: string;
  days: string;
  lastDay: string;
  presented: string;
  served: string;
  persisted: string;
}

function laneState(value: unknown): string {
  if (isFailure(value)) return "F";
  if (value === null || value === undefined) return "-";
  const status = (value as { status?: unknown }).status;
  return status === "skipped" ? "S" : "ok";
}

/** A compact per-business table for stdout. */
export function summarizeReport(report: {
  businesses: readonly BusinessAcceptanceReport[];
}): AcceptanceSummaryRow[] {
  return report.businesses.map((business) => {
    const ledger = isFailure(business.ledger) ? null : business.ledger;
    const decisions = isFailure(business.decisions) ? null : business.decisions;
    const presentation = isFailure(business.presentation) ? null : business.presentation;
    const persisted = isFailure(business.persistedServed) ? null : business.persistedServed;
    const selected = ledger?.perAccount.filter((account) => account.selected) ?? [];
    const sumOver = (select: (account: LedgerAccountReport) => number) =>
      selected.reduce((sum, account) => sum + select(account), 0);
    const lastDay = decisions?.days.at(-1) ?? null;
    const dayStrings = (decisions?.days ?? []).map((day) => {
      if (day.status === "failed") return `${day.asOf.slice(5)}:FAILED`;
      const accounts = day.perAccount;
      const raw = accounts.reduce((sum, account) => sum + sumRecord(account.rawHard), 0);
      const pre = accounts.reduce((sum, account) => sum + sumRecord(account.preAuthorityHard), 0);
      const pub = accounts.reduce((sum, account) => sum + sumRecord(account.publishedHard), 0);
      const held = accounts.reduce(
        (sum, account) => sum + sumRecord(account.blockedActionType) - (account.blockedActionType.none ?? 0),
        0,
      );
      const auth = accounts.reduce(
        (sum, account) => sum + sumRecord(account.authorizedActions) - (account.authorizedActions.none ?? 0),
        0,
      );
      const gate = accounts.every((account) => account.receipt?.gate.pass === true) ? "R+" : "R-";
      return `${day.asOf.slice(5)} ${gate} raw${raw}/pre${pre}/pub${pub}/held${held}/auth${auth}`;
    });
    const presentedAccounts = presentation?.accounts ?? [];
    const actual = presentedAccounts
      .flatMap((account) => account.modes.filter((mode) => mode.mode === "actual_governance"))
      .at(0);
    const servedParts = actual
      ? actual.workspace.map(
          (entry) =>
            `@${entry.limit}:${String((entry.os as { items?: unknown } | null)?.items ?? "?")} rows held${entry.heldServed?.served ?? 0}/${entry.heldServed?.held ?? 0}`,
        )
      : [];
    const briefing = actual?.briefing
      ? `brief a${actual.briefing.lanes.action}/w${actual.briefing.lanes.watching}/h${actual.briefing.lanes.healthy}`
      : "";
    return {
      business: business.businessId.slice(0, 8),
      role: business.role === "negative_control" ? "neg" : "subj",
      lanes: [business.ledger, business.decisions, business.presentation, business.persistedServed]
        .map(laneState)
        .join(","),
      accounts: ledger
        ? `${ledger.accounts.selected.length} sel/${ledger.accounts.deselected.length} desel`
        : "?",
      adDays: ledger
        ? `${sumOver((account) => Number(account.adDays.adDays ?? 0))} (${sumOver((account) => Number(account.adDays.spendPositive ?? 0))} spend>0)`
        : "?",
      lcMissing: ledger
        ? `${sumOver((account) => account.linkClicks.missing_actions_absent ?? 0)} absent/${sumOver((account) => account.linkClicks.missing_other ?? 0)} other`
        : "?",
      purchZeroNoKey: ledger
        ? String(sumOver((account) => account.purchasesOnSpendRows.zero_without_actions_key ?? 0))
        : "?",
      objectiveAuthority: ledger
        ? `${sumOver((account) => account.objective?.byReadiness.decision_authority ?? 0)}/${sumOver((account) => account.objective?.scopeRows ?? 0)}`
        : "?",
      covCompleteSlots: ledger
        ? `${sumOver((account) => account.coverageAtRunSlots?.counts.complete ?? 0)}/${sumOver((account) => account.coverageAtRunSlots?.slots.length ?? 0)}`
        : "?",
      aov: ledger
        ? selected
            .map((account) =>
              account.metaAov
                ? `${Number(account.metaAov.aovMean ?? NaN).toFixed(2)}/${String(account.metaAov.purchaseCount)}`
                : "?",
            )
            .join(";")
        : "?",
      days: decisions?.status === "skipped" ? `skipped:${decisions.reason}` : dayStrings.join(" | "),
      lastDay: lastDay ? `${lastDay.asOf}` : "-",
      presented: presentedAccounts.map((account) => `${account.providerAccountId}:${account.status}`).join(";") || "-",
      served: [briefing, ...servedParts].filter(Boolean).join(" "),
      persisted: persisted
        ? persisted.accounts
            .map((account) => `${account.bundle.status}${account.bundle.unavailableReason ? `(${account.bundle.unavailableReason})` : ""}`)
            .join(";")
        : "?",
    };
  });
}

/* ===================================================== release acceptance */

/** What one presented account carries to the UI (actual-governance mode). */
export interface PresenceRecord {
  providerAccountId: string;
  ledgerAdDays: number;
  ledgerSpendPositiveAdDays: number;
  decisionRows: number;
  inventoryItems: number;
  sourceBackedInventoryItems: number;
  briefingCards: number;
  servedClassifications: number;
  smallestAdLimit: number | null;
  osItemsAtSmallestLimit: number;
  sourceBackedPresentedAds: number;
  /** Cutoff-safe hierarchy of the presented generation: why the OS can be empty while the Briefing is not. */
  hierarchyAtCutoff: HierarchyStatusDistribution | null;
  /** Requirements this account does not meet; empty means it carries a source-backed decision to the UI. */
  missing: string[];
}

export interface PresenceVerdict {
  /** Decisions across the successful simulated days (sum of per-account ads). */
  decisionsOnSuccessfulDays: number;
  accounts: PresenceRecord[];
  accountsWithPresence: string[];
}

export interface NegativeControlFinding {
  code: string;
  detail: string;
}

export interface NegativeControlVerdict {
  met: boolean;
  campaignId: string | null;
  targetDays: string[];
  controlBusinessAdDays: number;
  campaignAdDays: number;
  campaignSpendPositiveAdDays: number;
  campaignTargetDayAdDays: number;
  campaignAccounts: string[];
  campaignAccountsSelected: string[];
  objectiveOnTargetDays: Array<{ day: string; readiness: string[] }>;
  unauthorizedHardEvidence: { simulated: number; persisted: number; sample: string[] };
  findings: NegativeControlFinding[];
}

export interface BusinessReleaseVerdict {
  businessId: string;
  role: BusinessAcceptanceReport["role"];
  accepted: boolean;
  successfulDecisionDays: string[];
  failedDecisionDays: string[];
  presentedAccounts: string[];
  failedPresentations: string[];
  persistedServedAvailable: string[];
  persistedServedUnavailable: string[];
  /** Subjects only. */
  presence: PresenceVerdict | null;
  /** The negative control only. */
  negativeControl: NegativeControlVerdict | null;
  /** Subjects only: whether a source-authorized hard action was demonstrated (separate from presence). */
  hardAuthority: HardAuthorityOutcome | null;
  failures: string[];
}

export type ReleaseVerdictLabel =
  | "PRE_DEPLOY GATE PASSED"
  | "PRE_DEPLOY GATE NOT MET"
  | "POST_DEPLOY GATE PASSED"
  | "POST_DEPLOY GATE NOT MET"
  | "DIAGNOSTIC (never release success)";

export interface ReleaseAcceptanceVerdict {
  gate: ReleaseGate;
  mode: AcceptanceMode;
  /** True only for a RELEASE-mode run in which every --business met this gate. */
  accepted: boolean;
  label: ReleaseVerdictLabel;
  negativeControl: "not_requested" | "MET" | "NOT MET";
  /** What a pass certifies: HEAD, or the dirty working tree it actually loaded. */
  certifies: string;
  failures: string[];
  businesses: BusinessReleaseVerdict[];
}

/** The report fields a gate reads; `args` is optional so a bare fixture still evaluates. */
export interface ReleaseEvaluationInput {
  mode: AcceptanceMode;
  businesses: readonly BusinessAcceptanceReport[];
  args?: { negativeControl: string | null; requireHardAuthority?: boolean; cutoffMode?: CutoffMode };
  provenance?: RunProvenance | null;
}

export interface ReleaseGatesReport {
  mode: AcceptanceMode;
  /** The gate the exit code follows. */
  selectedGate: ReleaseGate;
  gates: Record<ReleaseGate, ReleaseAcceptanceVerdict>;
  /**
   * SEPARATE from both gates: PRESENCE (the gates) proves real decisions reach
   * the UI; this says whether a source-authorized hard action was shown. It
   * changes the exit code only with --require-hard-authority.
   */
  hardAuthorityOutcome: HardAuthorityOutcome[];
  requireHardAuthority: boolean;
}

function decisionDaySucceeded(day: DecisionDayReport): boolean {
  return (
    day.status === "computed" &&
    day.perAccount.length > 0 &&
    day.perAccount.every((account) => account.receipt?.gate.pass === true) &&
    (day.hashIntegrity as { canonicalHashesVerified?: unknown } | null)?.canonicalHashesVerified === true
  );
}

function presentationSucceeded(account: PresentationAccountReport): boolean {
  if (account.status !== "presented" || !account.receiptGate.pass || account.error) return false;
  if (account.modes.length === 0) return false;
  return account.modes.every(
    (mode) =>
      mode.briefing !== null &&
      mode.briefing.projectionNulls === 0 &&
      mode.workspace.length > 0 &&
      mode.workspace.every((entry) => entry.error === null && entry.os !== null),
  );
}

/** Whether one account's persisted-served answer satisfies a gate; null when it does. */
function persistedServedFailure(
  account: PersistedServedAccountReport,
  gate: ReleaseGate,
): string | null {
  if (account.bundle.status === "available") {
    return account.bundle.degraded
      ? `persisted-served generation for ${account.providerAccountId} is the retained last-success fallback (latest run failed)`
      : null;
  }
  const reason = account.bundle.unavailableReason ?? "unknown";
  if (gate === "post_deploy") {
    return `persisted-served generation unavailable for ${account.providerAccountId}: ${reason}`;
  }
  if (reason !== PRE_DEPLOY_EXPECTED_UNAVAILABLE_REASON) {
    return `persisted-served generation unavailable for ${account.providerAccountId} for a reason a deploy does not explain: ${reason}`;
  }
  const latest = account.latestRow;
  const count = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
  const expected = count(latest?.expected_ad_count);
  const hydrated = count(latest?.hydrated_ad_count);
  const healthy =
    latest !== null &&
    latest.job_status === "success" &&
    latest.manifest_matches === true &&
    latest.authoritative_for_prune === true &&
    expected !== null &&
    hydrated !== null &&
    expected === hydrated;
  return healthy
    ? null
    : `pre-deploy: the currently served epoch's latest run for ${account.providerAccountId} is not a complete success (${JSON.stringify(latest)})`;
}

function numberOr0(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function isHardOrHeld(input: { raw: unknown; preAuthority: unknown; blocked: unknown }): boolean {
  return isHardLabel(input.raw) || isHardLabel(input.preAuthority) || (input.blocked !== null && input.blocked !== undefined);
}

/**
 * Whether the negative control is source-backed and meaningful in the window
 * (ACCEPTANCE_CLAIMS.releaseGates.negativeControl). Every finding makes it NOT
 * MET; the same findings are reported as observations by the invariants.
 */
export function evaluateNegativeControl(business: BusinessAcceptanceReport): NegativeControlVerdict {
  const findings: NegativeControlFinding[] = [];
  const control = business.negativeControl;
  const verdict: NegativeControlVerdict = {
    met: false,
    campaignId: null,
    targetDays: [],
    controlBusinessAdDays: 0,
    campaignAdDays: 0,
    campaignSpendPositiveAdDays: 0,
    campaignTargetDayAdDays: 0,
    campaignAccounts: [],
    campaignAccountsSelected: [],
    objectiveOnTargetDays: [],
    unauthorizedHardEvidence: { simulated: 0, persisted: 0, sample: [] },
    findings,
  };
  if (control === null) {
    findings.push({ code: "negative_control_not_run", detail: "the control business carries no negative-control check" });
    return verdict;
  }
  if (isFailure(control)) {
    findings.push({ code: "negative_control_lane_failed", detail: `negative-control lane failed: ${control.error}` });
    return verdict;
  }
  const campaignId = control.campaignId;
  verdict.campaignId = campaignId;
  const targetDays = [...(control.targetDays ?? [])];
  verdict.targetDays = targetDays;
  const campaignAccounts = control.campaignAccounts ?? [];

  // 1. The control business has real ledger rows in the window.
  const ledger = isFailure(business.ledger) ? null : business.ledger;
  verdict.controlBusinessAdDays = (ledger?.perAccount ?? [])
    .filter((account) => account.selected)
    .reduce((sum, account) => sum + numberOr0(account.adDays.adDays), 0);
  if (verdict.controlBusinessAdDays <= 0) {
    findings.push({
      code: "negative_control_business_without_ledger_rows",
      detail: `the control business has no ledger ad-day on a selected account in the window${ledger ? "" : " (ledger lane failed)"}`,
    });
  }

  // 2. The control campaign has real ad-day rows in the window, on a selected account.
  verdict.campaignAccounts = campaignAccounts.map((account) => account.providerAccountId);
  verdict.campaignAdDays = campaignAccounts.reduce((sum, account) => sum + numberOr0(account.adDays), 0);
  verdict.campaignSpendPositiveAdDays = campaignAccounts.reduce((sum, account) => sum + numberOr0(account.spendPositiveAdDays), 0);
  verdict.campaignTargetDayAdDays = campaignAccounts.reduce((sum, account) => sum + numberOr0(account.targetDayAdDays), 0);
  const selected = new Set(ledger?.accounts.selected ?? []);
  verdict.campaignAccountsSelected = verdict.campaignAccounts.filter((id) => selected.has(id));
  if (!control.campaignFound || verdict.campaignAdDays <= 0) {
    findings.push({
      code: "negative_control_campaign_not_found",
      detail: `campaign ${campaignId} has no meta_ad_daily row in ${control.from}..${control.to} for this business; the control proves nothing about it`,
    });
  } else if (verdict.campaignAccountsSelected.length === 0) {
    findings.push({
      code: "negative_control_campaign_account_not_selected",
      detail: `campaign ${campaignId} runs on ${verdict.campaignAccounts.join(",")}, none of which is a selected account, so no decision covers it`,
    });
  }

  // 3. The source gap on every target day: evaluated, and never decision_authority.
  if (targetDays.length === 0) {
    findings.push({ code: "negative_control_no_target_days", detail: "no target (--chain) day was recorded for the control" });
  }
  for (const day of targetDays) {
    const readiness = (control.objectiveAtTargetCutoffs ?? [])
      .filter((row) => row.day === day)
      .map((row) => row.readiness);
    verdict.objectiveOnTargetDays.push({ day, readiness });
    if (readiness.length === 0) {
      findings.push({
        code: "negative_control_target_day_unevaluated",
        detail: `no objective evaluation for campaign ${campaignId} on target day ${day} at that day's cutoff (window ${control.from}..${control.to}); the source gap is not demonstrated`,
      });
    } else if (readiness.includes("decision_authority")) {
      findings.push({
        code: "negative_control_no_source_gap",
        detail: `campaign ${campaignId} objective reads decision_authority on target day ${day}; the control has no source gap to demonstrate`,
      });
    }
  }

  // 4. At least one held/raw hard verdict from real data on a target day that stays unauthorized.
  const targets = new Set(targetDays);
  const decisions = isFailure(business.decisions) ? null : business.decisions;
  const successfulDays = new Set(
    (decisions?.days ?? []).filter((day) => decisionDaySucceeded(day)).map((day) => day.asOf),
  );
  const simulatedCampaignRows = control.simulatedHardRows.filter((row) => row.campaignId === campaignId);
  const simulated = simulatedCampaignRows.filter(
    (row) =>
      targets.has(row.asOf) &&
      successfulDays.has(row.asOf) &&
      row.authorizedAction === null &&
      isHardOrHeld({ raw: row.rawLabel, preAuthority: row.preAuthorityLabel, blocked: row.blockedActionType }),
  );
  const persisted = control.persistedHardRows.filter(
    (row) =>
      targets.has(String(row.as_of_date)) &&
      (row.authorized_action === null || row.authorized_action === undefined) &&
      isHardOrHeld({ raw: row.raw_label, preAuthority: row.pre_authority_label, blocked: row.blocked_action_type }),
  );
  verdict.unauthorizedHardEvidence = {
    simulated: simulated.length,
    persisted: persisted.length,
    sample: sample([
      ...simulated.map((row) => `simulated:${row.asOf}:${row.adId}:${row.rawLabel}->${row.publishedLabel}:held=${row.blockedActionType ?? "none"}`),
      ...persisted.map((row) => `persisted:${String(row.as_of_date)}:${String(row.ad_id)}:${String(row.raw_label)}->${String(row.label)}:held=${String(row.blocked_action_type ?? "none")}`),
    ]),
  };
  if (simulated.length + persisted.length === 0) {
    const onTarget = simulatedCampaignRows.filter((row) => targets.has(row.asOf)).length;
    findings.push({
      code: "negative_control_no_unauthorized_hard_evidence",
      detail: `no held or raw hard verdict for campaign ${campaignId} on a target day from real data stays unauthorized (simulated campaign hard rows ${simulatedCampaignRows.length}, on target days ${onTarget}, successful target days ${[...successfulDays].filter((day) => targets.has(day)).join(",") || "none"}; persisted rows on target days ${control.persistedHardRows.filter((row) => targets.has(String(row.as_of_date))).length})`,
    });
  }
  const authorized = [
    ...simulatedCampaignRows
      .filter((row) => row.authorizedAction !== null)
      .map((row) => `simulated:${row.asOf}:${row.adId}:${row.authorizedAction}`),
    ...control.persistedHardRows
      .filter((row) => row.authorized_action !== null && row.authorized_action !== undefined)
      .map((row) => `persisted:${String(row.as_of_date)}:${String(row.ad_id)}:${String(row.authorized_action)}`),
  ];
  if (authorized.length > 0) {
    findings.push({
      code: "negative_control_hard_verdict_authorized",
      detail: `campaign ${campaignId} carries ${authorized.length} authorized hard verdict(s): ${sample(authorized, 5).join(", ")}`,
    });
  }
  verdict.met = findings.length === 0;
  return verdict;
}

/* ===================================================== hard authority */

export const HARD_AUTHORITY_BLOCKER_CATEGORIES = [
  "objective_config",
  "d101_coverage",
  "role_campaign_context",
  "hysteresis",
  "profile_calibration_eligibility",
  "receipt",
  "other",
] as const;
export type HardAuthorityBlockerCategory = (typeof HARD_AUTHORITY_BLOCKER_CATEGORIES)[number];

export interface HardAuthorityCounts {
  rawHard: number;
  preAuthorityHard: number;
  held: number;
  authorized: number;
  /** Authorized rows that pass the full production authorization rule. */
  authorizedGrounded: number;
  /** Rows (a row can count in several) that fail each condition; hard, held or authorized rows only. */
  blockers: Record<HardAuthorityBlockerCategory, number>;
  /** The single blocker production names per row (payload authority_blocker). */
  effectiveBlockers: Record<string, number>;
}

export interface HardAuthorityDayOutcome extends HardAuthorityCounts {
  asOf: string;
  cutoff: string;
  status: "demonstrated" | "not_demonstrated" | "day_not_successful";
  groundedSample: string[];
}

/**
 * Separate from PRESENCE: whether any real row carries a SOURCE-AUTHORIZED
 * hard action (the full production authorization rule). A presence PASS with
 * this not_demonstrated proves the UI path, not an authorized Cut/Scale/Refresh.
 */
export interface HardAuthorityOutcome {
  businessId: string;
  status: "demonstrated" | "not_demonstrated";
  days: HardAuthorityDayOutcome[];
  totals: HardAuthorityCounts;
}

const AUTHORITY_BLOCKER_CATEGORY: Record<string, HardAuthorityBlockerCategory> = {
  config_source_authority: "objective_config",
  source_freshness: "d101_coverage",
  campaign_context: "role_campaign_context",
  profile_hard_action_ineligible: "profile_calibration_eligibility",
  native_profile_unavailable: "profile_calibration_eligibility",
};

function hardLabelOf(row: HardRowRecord): "scale" | "cut" | "refresh" | null {
  if (isHardLabel(row.preAuthorityLabel)) return row.preAuthorityLabel;
  if (isHardLabel(row.rawLabel)) return row.rawLabel;
  if (isHardLabel(row.blockedActionType)) return row.blockedActionType;
  return isHardLabel(row.authorizedAction) ? row.authorizedAction : null;
}

/** Every condition this hard / held row fails, by category. */
export function hardAuthorityBlockerCategories(row: HardRowRecord, receiptGatePassed: boolean): HardAuthorityBlockerCategory[] {
  const categories = new Set<HardAuthorityBlockerCategory>();
  for (const blocker of [row.firstAuthorityBlocker, row.effectiveAuthorityBlocker]) {
    if (blocker !== null) categories.add(AUTHORITY_BLOCKER_CATEGORY[blocker] ?? "other");
  }
  if (!row.config.observed || !row.config.fullyVerified) categories.add("objective_config");
  if (row.coverage.status !== "complete") categories.add("d101_coverage");
  if (row.hysteresisSuppressed) categories.add("hysteresis");
  const label = hardLabelOf(row);
  if (row.profileBlocker !== null || label === null || row.hardActionEligibility[label] !== true) {
    categories.add("profile_calibration_eligibility");
  }
  if (!receiptGatePassed) categories.add("receipt");
  if (categories.size === 0) categories.add("other");
  return HARD_AUTHORITY_BLOCKER_CATEGORIES.filter((category) => categories.has(category));
}

function emptyHardAuthorityCounts(): HardAuthorityCounts {
  return {
    rawHard: 0,
    preAuthorityHard: 0,
    held: 0,
    authorized: 0,
    authorizedGrounded: 0,
    blockers: Object.fromEntries(HARD_AUTHORITY_BLOCKER_CATEGORIES.map((category) => [category, 0])) as Record<HardAuthorityBlockerCategory, number>,
    effectiveBlockers: {},
  };
}

function addHardAuthorityCounts(into: HardAuthorityCounts, from: HardAuthorityCounts) {
  into.rawHard += from.rawHard;
  into.preAuthorityHard += from.preAuthorityHard;
  into.held += from.held;
  into.authorized += from.authorized;
  into.authorizedGrounded += from.authorizedGrounded;
  for (const category of HARD_AUTHORITY_BLOCKER_CATEGORIES) into.blockers[category] += from.blockers[category];
  for (const [blocker, count] of Object.entries(from.effectiveBlockers)) {
    into.effectiveBlockers[blocker] = (into.effectiveBlockers[blocker] ?? 0) + count;
  }
}

export function evaluateHardAuthority(business: BusinessAcceptanceReport): HardAuthorityOutcome {
  const outcome: HardAuthorityOutcome = {
    businessId: business.businessId,
    status: "not_demonstrated",
    days: [],
    totals: emptyHardAuthorityCounts(),
  };
  if (isFailure(business.decisions)) return outcome;
  for (const day of business.decisions.days) {
    const counts = emptyHardAuthorityCounts();
    const receiptPassed = (providerAccountId: string) =>
      day.perAccount.find((account) => account.providerAccountId === providerAccountId)?.receipt?.gate.pass === true;
    const grounded: string[] = [];
    for (const row of day.hardRows) {
      if (isHardLabel(row.rawLabel)) counts.rawHard += 1;
      if (isHardLabel(row.preAuthorityLabel)) counts.preAuthorityHard += 1;
      if (row.blockedActionType !== null) counts.held += 1;
      if (row.authorizedAction !== null) counts.authorized += 1;
      const passed = receiptPassed(row.providerAccountId);
      if (row.authorizedAction !== null && isHardLabel(row.authorizedAction) && authorizationGroundingFailures(row, passed).length === 0) {
        counts.authorizedGrounded += 1;
        grounded.push(`${row.adId}:${row.authorizedAction}`);
        continue;
      }
      for (const category of hardAuthorityBlockerCategories(row, passed)) counts.blockers[category] += 1;
      const effective = row.effectiveAuthorityBlocker ?? (row.hysteresisSuppressed ? "hysteresis" : "none");
      counts.effectiveBlockers[effective] = (counts.effectiveBlockers[effective] ?? 0) + 1;
    }
    const successful = decisionDaySucceeded(day);
    outcome.days.push({
      asOf: day.asOf,
      cutoff: day.cutoff,
      status: !successful ? "day_not_successful" : counts.authorizedGrounded > 0 ? "demonstrated" : "not_demonstrated",
      groundedSample: sample(grounded),
      ...counts,
    });
    addHardAuthorityCounts(outcome.totals, counts);
  }
  outcome.status = outcome.days.some((day) => day.status === "demonstrated") ? "demonstrated" : "not_demonstrated";
  return outcome;
}

export function describeHardAuthority(outcome: HardAuthorityOutcome): string {
  const totals = outcome.totals;
  const blockers = HARD_AUTHORITY_BLOCKER_CATEGORIES.filter((category) => totals.blockers[category] > 0)
    .map((category) => `${category} ${totals.blockers[category]}`)
    .join(", ");
  const days = outcome.days.map((day) => `${day.asOf}:${day.status}`).join(" ");
  return `${outcome.status === "demonstrated" ? "DEMONSTRATED" : "NOT DEMONSTRATED"} (raw hard ${totals.rawHard}, pre-authority hard ${totals.preAuthorityHard}, held ${totals.held}, authorized ${totals.authorized}, source-authorized ${totals.authorizedGrounded}; blockers: ${blockers || "none"}; ${days})`;
}

/** An account-day's receipt at its cutoff: reported as it is, never repaired. */
export function receiptStatusOf(account: DecisionAccountDayReport): "passed" | "receipt_unreconstructable_at_cutoff" | "absent" {
  if (!account.receipt) return "absent";
  return account.receipt.gate.pass ? "passed" : "receipt_unreconstructable_at_cutoff";
}

function smallestLimitEntry(mode: PresentationModeReport) {
  if (mode.workspace.length === 0) return null;
  return mode.workspace.reduce((smallest, entry) => (entry.limit < smallest.limit ? entry : smallest));
}

/** What one presented account carries to the UI, read from its actual-governance mode. */
export function presenceOf(
  account: PresentationAccountReport,
  ledger: LedgerLaneReport | null,
): PresenceRecord {
  const ledgerAccount = ledger?.perAccount.find((entry) => entry.providerAccountId === account.providerAccountId) ?? null;
  const mode = account.modes.find((entry) => entry.mode === "actual_governance") ?? null;
  const smallest = mode ? smallestLimitEntry(mode) : null;
  const briefing = mode?.briefing ?? null;
  const record: PresenceRecord = {
    providerAccountId: account.providerAccountId,
    ledgerAdDays: numberOr0(ledgerAccount?.adDays.adDays),
    ledgerSpendPositiveAdDays: numberOr0(ledgerAccount?.adDays.spendPositive),
    decisionRows: numberOr0(account.generation?.rows),
    inventoryItems: numberOr0(mode?.inventory.items),
    sourceBackedInventoryItems: numberOr0(mode?.sourceBacking?.sourceBackedInventoryItems),
    briefingCards: briefing ? briefing.lanes.action + briefing.lanes.watching + briefing.lanes.healthy : 0,
    servedClassifications: numberOr0(briefing?.servedClassifications),
    smallestAdLimit: smallest?.limit ?? null,
    osItemsAtSmallestLimit: numberOr0((smallest?.os as { items?: unknown } | null | undefined)?.items),
    sourceBackedPresentedAds: numberOr0(mode?.sourceBacking?.sourceBackedPresentedAds),
    hierarchyAtCutoff: account.hierarchyAtCutoff ?? null,
    missing: [],
  };
  const require = (condition: boolean, code: string) => {
    if (!condition) record.missing.push(code);
  };
  require(mode !== null, "actual_governance_mode");
  require(record.decisionRows > 0, "decision_rows");
  require(record.ledgerAdDays > 0, "ledger_ad_days_in_window");
  require(record.inventoryItems > 0, "inventory_items");
  require(record.sourceBackedInventoryItems > 0, "source_backed_inventory_items");
  require(record.briefingCards > 0, "briefing_active_cards");
  require(record.servedClassifications > 0, "served_classifications");
  require(record.osItemsAtSmallestLimit > 0, `os_items_at_smallest_limit`);
  require(record.sourceBackedPresentedAds > 0, "source_backed_ad_reaching_briefing_or_os");
  return record;
}

/** Why the OS can be empty while the Briefing is not: the OS serves only an ACTIVE hierarchy. */
export function describeBriefingVersusOs(record: PresenceRecord): string {
  const counts = `Briefing active-filter ${record.briefingCards} cards vs OS@${record.smallestAdLimit ?? "?"} ${record.osItemsAtSmallestLimit} rows`;
  const hierarchy = describeHierarchy(record.hierarchyAtCutoff);
  if (record.briefingCards > 0 && record.osItemsAtSmallestLimit === 0) {
    const reading =
      record.hierarchyAtCutoff && record.hierarchyAtCutoff.allActive === 0
        ? "no ACTIVE parent hierarchy visible at the cutoff (a point-in-time hierarchy source gap)"
        : "the OS served nothing although some ads have an ACTIVE hierarchy at the cutoff";
    return `${counts}: ${reading}; ${hierarchy}`;
  }
  return `${counts}; ${hierarchy}`;
}

export function describePresence(record: PresenceRecord): string {
  return `${record.providerAccountId} missing [${record.missing.join(", ")}] (decision rows ${record.decisionRows}; ledger ad-days ${record.ledgerAdDays}; inventory ${record.inventoryItems}, source-backed ${record.sourceBackedInventoryItems}; ${record.servedClassifications} served classifications; source-backed ads presented ${record.sourceBackedPresentedAds}; ${describeBriefingVersusOs(record)})`;
}

/**
 * One gate's verdict, separate from invariant violations (fail-open /
 * fabrication) and from observations (source gaps). A source gap can make a
 * gate NOT MET; it can never make it pass. See ACCEPTANCE_CLAIMS.releaseGates.
 */
export function evaluateReleaseAcceptance(
  report: ReleaseEvaluationInput,
  gate: ReleaseGate,
): ReleaseAcceptanceVerdict {
  const verdicts: BusinessReleaseVerdict[] = report.businesses.map((business) => {
    const failures: string[] = [];
    const lanes: Array<[string, unknown]> = [
      ["ledger", business.ledger],
      ["decisions", business.decisions],
      ["presentation", business.presentation],
      ["persistedServed", business.persistedServed],
      ["negativeControl", business.negativeControl],
    ];
    for (const [lane, value] of lanes) {
      if (isFailure(value)) failures.push(`${lane} lane failed: ${value.error}`);
    }
    const verdict: BusinessReleaseVerdict = {
      businessId: business.businessId,
      role: business.role,
      accepted: false,
      successfulDecisionDays: [],
      failedDecisionDays: [],
      presentedAccounts: [],
      failedPresentations: [],
      persistedServedAvailable: [],
      persistedServedUnavailable: [],
      presence: null,
      negativeControl: null,
      hardAuthority: null,
      failures,
    };
    // The negative control is not part of --business: it is held to being source-backed
    // and meaningful (never to presence, a served generation or an action).
    if (business.role === "negative_control") {
      const control = evaluateNegativeControl(business);
      verdict.negativeControl = control;
      for (const finding of control.findings) {
        if (finding.code === "negative_control_lane_failed") continue; // already listed as a lane failure
        failures.push(`negative control NOT MET: ${finding.code}: ${finding.detail}`);
      }
      verdict.accepted = failures.length === 0;
      return verdict;
    }

    if (!isFailure(business.decisions)) {
      if (business.decisions.status !== "computed") {
        failures.push(`decisions ${business.decisions.status}: ${business.decisions.reason ?? "no reason"}`);
      }
      for (const day of business.decisions.days) {
        const unreconstructable = day.perAccount.filter((account) => receiptStatusOf(account) !== "passed");
        if (day.status === "failed") {
          verdict.failedDecisionDays.push(day.asOf);
          failures.push(`decision day ${day.asOf} failed: ${day.reason ?? "no reason"}`);
        } else if (unreconstructable.length > 0) {
          // Reported as it is at this cutoff, never repaired; it counts as a failed day.
          verdict.failedDecisionDays.push(day.asOf);
          failures.push(
            `decision day ${day.asOf} (cutoff ${day.cutoff}): ${unreconstructable
              .map((account) => `${account.providerAccountId} ${receiptStatusOf(account)}${account.receipt ? ` [${account.receipt.gate.failures.join(", ")}; reason ${account.receipt.reason ?? "none"}]` : ""}`)
              .join("; ")}`,
          );
        } else if (decisionDaySucceeded(day)) {
          verdict.successfulDecisionDays.push(day.asOf);
        }
      }
      if (business.decisions.status === "computed" && verdict.successfulDecisionDays.length === 0) {
        failures.push("no simulated decision day succeeded (authoritative receipt for every account, verified hashes, no exception)");
      }
      for (const day of business.decisions.days) {
        if (day.status !== "computed") continue;
        for (const account of day.perAccount) {
          const crossCheck = crossCheckAccountDay(account);
          if (crossCheck.unverifiableClaims > 0) {
            failures.push(
              `decision day ${day.asOf} ${account.providerAccountId}: ${crossCheck.unverifiableClaims} verified/complete hydration claims have no independent reading (${crossCheck.unavailable})`,
            );
          }
        }
      }
    }
    const successful = new Set(verdict.successfulDecisionDays);
    const presence: PresenceVerdict = {
      decisionsOnSuccessfulDays: isFailure(business.decisions)
        ? 0
        : business.decisions.days
            .filter((day) => successful.has(day.asOf))
            .reduce((sum, day) => sum + day.perAccount.reduce((inner, account) => inner + numberOr0(account.ads), 0), 0),
      accounts: [],
      accountsWithPresence: [],
    };
    verdict.presence = presence;
    if (verdict.successfulDecisionDays.length > 0 && presence.decisionsOnSuccessfulDays === 0) {
      failures.push(
        `empty decisions: the successful days (${verdict.successfulDecisionDays.join(",")}) passed receipt and hash over 0 ad decisions`,
      );
    }

    if (!isFailure(business.presentation)) {
      if (business.presentation.status !== "computed") {
        failures.push(`presentation ${business.presentation.status}: ${business.presentation.reason ?? "no reason"}`);
      }
      for (const account of business.presentation.accounts) {
        const workspaceErrors = account.modes.flatMap((mode) =>
          mode.workspace.filter((entry) => entry.error !== null).map((entry) => `${mode.mode}@${entry.limit}: ${entry.error}`),
        );
        const invalidAfterReceipt =
          (account.status === "generation_invalid" || account.status === "refused") && account.receiptGate.pass;
        if (account.status === "failed" || workspaceErrors.length > 0 || invalidAfterReceipt) {
          verdict.failedPresentations.push(account.providerAccountId);
          failures.push(
            invalidAfterReceipt
              ? `presentation for ${account.providerAccountId} failed: the receipt passed but the simulated generation is ${account.status}: ${account.refusal ?? account.validation?.issue ?? "no reason"}`
              : `presentation for ${account.providerAccountId} failed: ${account.error ?? account.refusal ?? workspaceErrors.join("; ")}`,
          );
        } else if (presentationSucceeded(account)) {
          verdict.presentedAccounts.push(account.providerAccountId);
        }
      }
      if (business.presentation.status === "computed" && verdict.presentedAccounts.length === 0) {
        failures.push("no per-account presentation succeeded (inventory, zero-null briefing projection and OS presentation at every limit)");
      }
      const ledger = isFailure(business.ledger) ? null : business.ledger;
      const presented = new Set(verdict.presentedAccounts);
      presence.accounts = business.presentation.accounts
        .filter((account) => presented.has(account.providerAccountId))
        .map((account) => presenceOf(account, ledger));
      presence.accountsWithPresence = presence.accounts
        .filter((record) => record.missing.length === 0)
        .map((record) => record.providerAccountId);
      if (presence.accounts.length > 0 && presence.accountsWithPresence.length === 0) {
        failures.push(
          `empty presentation: no presented account carries a real, source-backed decision to the UI: ${presence.accounts.map(describePresence).join("; ")}`,
        );
      }
    }

    if (!isFailure(business.persistedServed)) {
      for (const account of business.persistedServed.accounts) {
        if (account.bundle.status === "available" && !account.bundle.degraded) {
          verdict.persistedServedAvailable.push(account.providerAccountId);
        } else {
          verdict.persistedServedUnavailable.push(account.providerAccountId);
        }
        const failure = persistedServedFailure(account, gate);
        if (failure) failures.push(failure);
      }
      if (business.persistedServed.accounts.length === 0) {
        failures.push("persisted-served: no selected account to serve");
      }
    }
    verdict.hardAuthority = evaluateHardAuthority(business);
    if (report.args?.requireHardAuthority && verdict.hardAuthority.status !== "demonstrated") {
      failures.push(`--require-hard-authority: hard authority ${describeHardAuthority(verdict.hardAuthority)}`);
    }
    verdict.accepted = failures.length === 0;
    return verdict;
  });

  const subjects = verdicts.filter((verdict) => verdict.role === "subject");
  const controls = verdicts.filter((verdict) => verdict.role === "negative_control");
  const failures = verdicts.flatMap((verdict) =>
    verdict.failures.map((failure) => `${verdict.businessId.slice(0, 8)}: ${failure}`),
  );
  if (subjects.length === 0) failures.push("no --business subject was evaluated");
  failures.push(...provenanceFailures(report.provenance));
  const certifies = report.provenance?.certifies ?? "unknown: no provenance recorded";
  const controlRequested = Boolean(report.args?.negativeControl) || controls.length > 0;
  if (report.args?.negativeControl && controls.length === 0) {
    failures.push(`negative control NOT MET: negative_control_not_run: --negative-control ${report.args.negativeControl} produced no control report`);
  }
  const negativeControl: ReleaseAcceptanceVerdict["negativeControl"] = !controlRequested
    ? "not_requested"
    : controls.length > 0 && controls.every((verdict) => verdict.accepted)
      ? "MET"
      : "NOT MET";
  if (report.mode === "diagnostic") {
    return {
      gate,
      mode: "diagnostic",
      accepted: false,
      label: "DIAGNOSTIC (never release success)",
      negativeControl,
      certifies,
      failures: ["diagnostic mode (--skip-decisions, --diagnostic or --knowledge-cutoffs) can never produce release success", ...failures],
      businesses: verdicts,
    };
  }
  const accepted =
    failures.length === 0 && negativeControl !== "NOT MET" && verdicts.every((verdict) => verdict.accepted);
  const name = gate === "pre_deploy" ? "PRE_DEPLOY" : "POST_DEPLOY";
  return {
    gate,
    mode: "release",
    accepted,
    label: `${name} GATE ${accepted ? "PASSED" : "NOT MET"}` as ReleaseVerdictLabel,
    negativeControl,
    certifies,
    failures,
    businesses: verdicts,
  };
}

/** Both gates from the same lanes; `selectedGate` is the one the exit code follows. */
export function evaluateReleaseGates(
  report: ReleaseEvaluationInput,
  selectedGate: ReleaseGate,
): ReleaseGatesReport {
  return {
    mode: report.mode,
    selectedGate,
    gates: {
      pre_deploy: evaluateReleaseAcceptance(report, "pre_deploy"),
      post_deploy: evaluateReleaseAcceptance(report, "post_deploy"),
    },
    hardAuthorityOutcome: report.businesses
      .filter((business) => business.role === "subject")
      .map((business) => evaluateHardAuthority(business)),
    requireHardAuthority: report.args?.requireHardAuthority === true,
  };
}

/** The documented exit code (ACCEPTANCE_CLAIMS.exitCodes), following the selected gate only. */
export function decideExitCode(input: {
  invariants: Pick<InvariantEvaluation, "violations">;
  release: Pick<ReleaseAcceptanceVerdict, "mode" | "accepted">;
}): 0 | 1 | 3 | 4 {
  if (input.invariants.violations.length > 0) return 1;
  if (input.release.mode === "diagnostic") return 4;
  return input.release.accepted ? 0 : 3;
}

export const HEAD_NATIVE_AD_ENGINE_VERSION = NATIVE_AD_ENGINE_VERSION;
