import { configureOperationalScriptRuntime } from "@/scripts/_operational-runtime";
import {
  buildReleaseAuthorityCanonicalDoc,
  readReleaseAuthorityCanonicalDoc,
} from "@/lib/release-authority/doc";
import {
  verifyReleaseAuthorityManifestIntegrity,
  resolveLocalGitHeadSha,
  resolveOriginMainSha,
} from "@/lib/release-authority/integrity";
import {
  buildReleaseAuthorityReport,
  isFullCommitSha,
  reconcileReleaseAuthorityMainSha,
  type ReleaseAuthorityResolvedMainShaSource,
} from "@/lib/release-authority/report";
import type { ReleaseAuthorityReport } from "@/lib/release-authority/types";

configureOperationalScriptRuntime();

type VerifyMode = "preflight" | "post_deploy";

interface RemoteJsonResult<T> {
  url: string | null;
  status: "passed" | "failed" | "skipped";
  httpStatus: number | null;
  payload: T | null;
  error: string | null;
}

function getCarryForwardSummary(report: Partial<ReleaseAuthorityReport> | null) {
  const carryForward = report?.carryForward;
  if (!carryForward) {
    return null;
  }

  const acceptanceGaps = Array.isArray(carryForward.acceptanceGaps)
    ? carryForward.acceptanceGaps
    : [];

  return {
    summary:
      typeof carryForward.summary === "string"
        ? carryForward.summary
        : `${acceptanceGaps.length} accepted carry-forward gap(s) remain.`,
    acceptanceGaps,
  };
}

function hasCurrentReleaseAuthoritySchema(
  report: Partial<ReleaseAuthorityReport> | null,
): report is ReleaseAuthorityReport {
  return Boolean(
    report &&
      report.runtime &&
      report.release &&
      report.verdicts &&
      report.carryForward &&
      Array.isArray(report.carryForward.acceptanceGaps),
  );
}

function tryReadCanonicalDoc() {
  try {
    return readReleaseAuthorityCanonicalDoc();
  } catch {
    return null;
  }
}

interface CheckerMainShaResolution {
  sha: string | null;
  source: ReleaseAuthorityResolvedMainShaSource | "unresolved";
  detail: string;
}

/**
 * Resolve the remote main SHA from the checker's own vantage point so the
 * post-deploy verdicts do not depend on the live runtime being able to query
 * the (private) GitHub repository anonymously.
 *
 * Resolution order:
 * 1. RELEASE_AUTHORITY_REMOTE_MAIN_SHA env override (explicit input),
 * 2. `git ls-remote origin refs/heads/main` (works in the workflow because
 *    actions/checkout persists credentials, and on any local clone),
 * 3. GITHUB_SHA when the workflow was dispatched on refs/heads/main.
 */
function resolveCheckerMainSha(): CheckerMainShaResolution {
  const envOverride = process.env.RELEASE_AUTHORITY_REMOTE_MAIN_SHA?.trim();
  if (envOverride && isFullCommitSha(envOverride)) {
    return {
      sha: envOverride.toLowerCase(),
      source: "env_override",
      detail: "RELEASE_AUTHORITY_REMOTE_MAIN_SHA",
    };
  }

  try {
    const sha = resolveOriginMainSha();
    if (sha && isFullCommitSha(sha)) {
      return {
        sha: sha.toLowerCase(),
        source: "git_remote",
        detail: "git ls-remote origin refs/heads/main",
      };
    }
  } catch {
    // fall through to the GITHUB_SHA fallback below
  }

  const githubSha = process.env.GITHUB_SHA?.trim();
  if (
    githubSha &&
    isFullCommitSha(githubSha) &&
    process.env.GITHUB_REF === "refs/heads/main"
  ) {
    return {
      sha: githubSha.toLowerCase(),
      source: "github_branch_head",
      detail: "GITHUB_SHA (refs/heads/main workflow head)",
    };
  }

  return {
    sha: null,
    source: "unresolved",
    detail:
      "No RELEASE_AUTHORITY_REMOTE_MAIN_SHA override, git ls-remote lookup failed, and no GITHUB_SHA on refs/heads/main.",
  };
}

function normalizeBaseUrl(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]) {
  const options = {
    mode: "preflight" as VerifyMode,
    baseUrl: null as string | null,
    expectedBuildId: null as string | null,
    timeoutMs: 15_000,
  };

  for (const arg of argv) {
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length).trim();
      if (value === "preflight" || value === "post_deploy") {
        options.mode = value;
      }
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      options.baseUrl = normalizeBaseUrl(arg.slice("--base-url=".length));
      continue;
    }
    if (arg.startsWith("--expected-build-id=")) {
      options.expectedBuildId =
        arg.slice("--expected-build-id=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      const parsed = Number(arg.slice("--timeout-ms=".length).trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        options.timeoutMs = parsed;
      }
    }
  }

  return options;
}

async function fetchJson<T>(input: {
  baseUrl: string | null;
  path: string;
  timeoutMs: number;
}): Promise<RemoteJsonResult<T>> {
  if (!input.baseUrl) {
    return {
      url: null,
      status: "skipped",
      httpStatus: null,
      payload: null,
      error: null,
    };
  }

  const url = new URL(input.path, `${input.baseUrl}/`).toString();
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(input.timeoutMs),
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => null)) as T | null;
    return {
      url,
      status: response.ok ? "passed" : "failed",
      httpStatus: response.status,
      payload,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      url,
      status: "failed",
      httpStatus: null,
      payload: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildPreflightSummary(input: {
  report: ReleaseAuthorityReport;
  integrity: ReturnType<typeof verifyReleaseAuthorityManifestIntegrity>;
  canonicalDocMatches: boolean;
}) {
  const blockers: string[] = [];
  const notes: string[] = [];
  const localCandidateDiffersFromMain =
    input.report.verdicts.liveVsMain.status === "drifted";

  if (input.integrity.missingPaths.length > 0) {
    blockers.push(
      `Manifest references missing path(s): ${input.integrity.missingPaths.join(", ")}`,
    );
  }

  if (input.integrity.bannerFailures.length > 0) {
    blockers.push(
      `Phase 02-06 reference docs are missing the V3-01 release-authority banner in ${input.integrity.bannerFailures
        .map((entry) => entry.path)
        .join(", ")}`,
    );
  }

  if (input.report.verdicts.docsVsRuntime.status !== "aligned") {
    blockers.push(input.report.verdicts.docsVsRuntime.summary);
  }

  if (input.report.verdicts.flagsVsRuntime.status !== "aligned") {
    blockers.push(input.report.verdicts.flagsVsRuntime.summary);
  }

  if (!input.canonicalDocMatches) {
    if (localCandidateDiffersFromMain) {
      notes.push(
        "Canonical release-authority doc literal comparison was skipped because the local release candidate differs from current remote main. Regenerate the doc on the exact-SHA main deploy candidate before shipping.",
      );
    } else {
      blockers.push(
        "Canonical release-authority doc does not match the generated V3 authority output. Run scripts/generate-release-authority-doc.ts and commit the result.",
      );
    }
  }

  if (input.report.runtime.currentMainShaSource === "unresolved") {
    blockers.push("Remote main SHA could not be resolved in preflight.");
  }

  if (localCandidateDiffersFromMain) {
    notes.push(
      "Local release candidate differs from current remote main. This is expected on pull requests but must align before an exact-SHA production deploy.",
    );
  }

  const carryForward = getCarryForwardSummary(input.report);
  if (carryForward && carryForward.acceptanceGaps.length > 0) {
    notes.push(carryForward.summary);
  }

  return {
    result: blockers.length === 0 ? "pass" : "fail",
    blockers,
    notes,
  };
}

function buildPostDeploySummary(input: {
  expectedBuildId: string | null;
  buildInfo: RemoteJsonResult<{ buildId?: string }>;
  authority: RemoteJsonResult<ReleaseAuthorityReport>;
}) {
  const blockers: string[] = [];
  const notes: string[] = [];

  if (input.buildInfo.status !== "passed") {
    blockers.push(
      input.buildInfo.error
        ? `Build info verification failed: ${input.buildInfo.error}`
        : "Build info verification failed.",
    );
  }

  const observedBuildId =
    typeof input.buildInfo.payload?.buildId === "string"
      ? input.buildInfo.payload.buildId
      : null;
  if (input.expectedBuildId && observedBuildId !== input.expectedBuildId) {
    blockers.push(
      `Build info mismatch: expected ${input.expectedBuildId}, observed ${observedBuildId ?? "unknown"}.`,
    );
  }

  if (input.authority.status !== "passed" || !input.authority.payload) {
    blockers.push(
      input.authority.error
        ? `Release authority verification failed: ${input.authority.error}`
        : "Release authority verification failed.",
    );
  } else {
    const report = input.authority.payload;
    if (
      input.expectedBuildId &&
      report.runtime.currentLiveSha !== input.expectedBuildId
    ) {
      blockers.push(
        `Release authority live SHA mismatch: expected ${input.expectedBuildId}, observed ${report.runtime.currentLiveSha}.`,
      );
    }

    if (observedBuildId && report.runtime.currentLiveSha !== observedBuildId) {
      blockers.push(
        `Release authority live SHA ${report.runtime.currentLiveSha} does not match build-info ${observedBuildId}.`,
      );
    }

    if (report.verdicts.liveVsMain.status !== "aligned") {
      blockers.push(report.verdicts.liveVsMain.summary);
    }

    if (report.verdicts.docsVsRuntime.status !== "aligned") {
      blockers.push(report.verdicts.docsVsRuntime.summary);
    }

    if (report.verdicts.flagsVsRuntime.status !== "aligned") {
      blockers.push(report.verdicts.flagsVsRuntime.summary);
    }

    if (report.unresolvedDriftItems.length > 0) {
      blockers.push(
        `Release authority still reports unresolved drift items: ${report.unresolvedDriftItems
          .map((item) => item.id)
          .join(", ")}`,
      );
    }

    notes.push(
      `Feature authority source: ${report.release.featureAuthoritySource.apiRoute} + ${report.release.featureAuthoritySource.canonicalDoc}`,
    );
    const carryForward = getCarryForwardSummary(report);
    if (carryForward && carryForward.acceptanceGaps.length > 0) {
      notes.push(carryForward.summary);
    }
  }

  return {
    result: blockers.length === 0 ? "pass" : "fail",
    blockers,
    notes,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.mode === "post_deploy" && !options.baseUrl) {
    console.error(
      "post_deploy mode requires --base-url=https://adsecute.com",
    );
    process.exit(1);
  }

  if (options.mode === "preflight") {
    const report = buildReleaseAuthorityReport({
      currentLiveSha: resolveLocalGitHeadSha(),
      currentMainSha: resolveOriginMainSha(),
      currentMainShaSource: "git_remote",
      nodeEnv: process.env.NODE_ENV ?? "development",
    });
    const integrity = verifyReleaseAuthorityManifestIntegrity();
    const canonicalDoc = tryReadCanonicalDoc();
    const summary = buildPreflightSummary({
      report,
      integrity,
      canonicalDocMatches:
        canonicalDoc !== null &&
        canonicalDoc ===
        buildReleaseAuthorityCanonicalDoc(report),
    });

    console.log(
      JSON.stringify(
        {
          mode: options.mode,
          capturedAt: new Date().toISOString(),
          report,
          integrity,
          summary,
        },
        null,
        2,
      ),
    );

    if (summary.result !== "pass") {
      process.exit(1);
    }
    return;
  }

  const [buildInfo, authority] = await Promise.all([
    fetchJson<{ buildId?: string }>({
      baseUrl: options.baseUrl,
      path: "/api/build-info",
      timeoutMs: options.timeoutMs,
    }),
    fetchJson<ReleaseAuthorityReport>({
      baseUrl: options.baseUrl,
      path: "/api/release-authority",
      timeoutMs: options.timeoutMs,
    }),
  ]);

  const rawAuthorityReport =
    authority.payload && hasCurrentReleaseAuthoritySchema(authority.payload)
      ? authority.payload
      : null;
  const runtimeMainUnresolved =
    rawAuthorityReport !== null &&
    (rawAuthorityReport.runtime.currentMainShaSource === "unresolved" ||
      !isFullCommitSha(rawAuthorityReport.runtime.currentMainSha));

  const checkerMain = runtimeMainUnresolved ? resolveCheckerMainSha() : null;
  let verifiedAuthorityReport = rawAuthorityReport;
  if (
    rawAuthorityReport &&
    checkerMain?.sha &&
    checkerMain.source !== "unresolved"
  ) {
    verifiedAuthorityReport = reconcileReleaseAuthorityMainSha(
      rawAuthorityReport,
      {
        currentMainSha: checkerMain.sha,
        currentMainShaSource: checkerMain.source,
      },
    );
  }
  const mainShaReconciliationApplied =
    verifiedAuthorityReport !== null &&
    verifiedAuthorityReport !== rawAuthorityReport;

  const summary = buildPostDeploySummary({
    expectedBuildId: options.expectedBuildId,
    buildInfo,
    authority: verifiedAuthorityReport
      ? { ...authority, payload: verifiedAuthorityReport }
      : authority,
  });

  if (mainShaReconciliationApplied && checkerMain?.sha) {
    summary.notes.push(
      `Live runtime could not resolve remote main; the checker resolved refs/heads/main to ${checkerMain.sha} via ${checkerMain.detail} and re-derived the live-vs-main verdict from that SHA.`,
    );
  } else if (runtimeMainUnresolved) {
    summary.notes.push(
      `Neither the live runtime nor the checker could resolve the remote main SHA (${checkerMain?.detail ?? "checker resolution unavailable"}), so the live-vs-main verdict stays unresolved.`,
    );
  }

  if (authority.payload) {
    if (verifiedAuthorityReport) {
      if (
        tryReadCanonicalDoc() !==
        buildReleaseAuthorityCanonicalDoc(verifiedAuthorityReport)
      ) {
        summary.result = "fail";
        summary.blockers.push(
          "Canonical release-authority doc does not literally match the live release-authority payload.",
        );
      }
    } else {
      summary.notes.push(
        "Live release-authority payload does not expose the current carry-forward schema yet, so canonical-doc literal comparison was skipped.",
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: options.mode,
        capturedAt: new Date().toISOString(),
        targetBaseUrl: options.baseUrl,
        expectedBuildId: options.expectedBuildId,
        buildInfo,
        authority,
        mainShaReconciliation: {
          applied: mainShaReconciliationApplied,
          checkerMainSha: checkerMain?.sha ?? null,
          checkerMainShaSource: checkerMain?.source ?? null,
          checkerMainShaDetail: checkerMain?.detail ?? null,
          reconciledLiveVsMain: mainShaReconciliationApplied
            ? (verifiedAuthorityReport?.verdicts.liveVsMain ?? null)
            : null,
        },
        summary,
      },
      null,
      2,
    ),
  );

  if (summary.result !== "pass") {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
