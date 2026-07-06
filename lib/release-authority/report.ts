import { getCurrentRuntimeBuildId } from "@/lib/build-runtime";
import {
  RELEASE_AUTHORITY_CANONICAL_DOC,
  RELEASE_AUTHORITY_PREVIOUS_KNOWN_GOOD_SHA,
  RELEASE_AUTHORITY_PREVIOUS_KNOWN_GOOD_SOURCE,
} from "@/lib/release-authority/config";
import { RELEASE_AUTHORITY_SURFACES } from "@/lib/release-authority/inventory";
import {
  RELEASE_AUTHORITY_REPOSITORY,
  RELEASE_AUTHORITY_SCHEMA_VERSION,
  type ReleaseAuthorityDriftItem,
  type ReleaseAuthorityDriftState,
  type ReleaseAuthorityFlagPosture,
  type ReleaseAuthorityReport,
  type ReleaseAuthorityCarryForwardItem,
  type ReleaseAuthoritySurface,
  type ReleaseAuthoritySurfaceDefinition,
  type ReleaseAuthorityVerdict,
} from "@/lib/release-authority/types";

export function isFullCommitSha(value: string | null | undefined) {
  return /^[0-9a-f]{40}$/i.test(String(value ?? "").trim());
}

function resolveSurfaceRuntimeState(input: {
  definition: ReleaseAuthoritySurfaceDefinition;
  flagPosture: ReleaseAuthorityFlagPosture | null;
}) {
  return typeof input.definition.runtimeState === "function"
    ? input.definition.runtimeState({ flagPosture: input.flagPosture })
    : input.definition.runtimeState;
}

function buildSurface(input: {
  definition: ReleaseAuthoritySurfaceDefinition;
  flagPosture: ReleaseAuthorityFlagPosture | null;
}): ReleaseAuthoritySurface {
  const runtimeState = resolveSurfaceRuntimeState(input);
  const driftReasons: string[] = [];
  let driftState: ReleaseAuthorityDriftState = "aligned";

  if (input.definition.docsState === "missing") {
    driftReasons.push("Authority docs are missing for this surface.");
  } else if (
    input.definition.docsState === "legacy" &&
    runtimeState !== "legacy"
  ) {
    driftReasons.push(
      "Only legacy docs exist for a current or flagged runtime surface.",
    );
  }

  if (runtimeState === "live" && input.flagPosture) {
    if (input.flagPosture.mode !== "enabled") {
      driftReasons.push(
        `Runtime is marked live while flag posture is ${input.flagPosture.mode}.`,
      );
    }
  }

  if (runtimeState === "flagged") {
    if (!input.flagPosture) {
      driftReasons.push(
        "Runtime is marked flagged but no flag posture resolver is attached.",
      );
      driftState = "unknown";
    } else if (input.flagPosture.mode === "enabled") {
      driftReasons.push(
        "Runtime is marked flagged even though the flag posture is globally enabled.",
      );
    }
  }

  if (runtimeState === "legacy" && input.definition.docsState === "missing") {
    driftReasons.push("Legacy surface is not documented in the authority docs.");
  }

  if (driftReasons.length > 0 && driftState !== "unknown") {
    driftState = "drifted";
  }

  return {
    id: input.definition.id,
    label: input.definition.label,
    area: input.definition.area,
    repositoryState: input.definition.repositoryState,
    runtimeState,
    docsState: input.definition.docsState,
    flagPosture: input.flagPosture,
    driftState,
    driftReasons,
    references: input.definition.references,
    notes: input.definition.notes,
  };
}

function buildVerdict(
  status: ReleaseAuthorityDriftState,
  summary: string,
  blocking: boolean,
): ReleaseAuthorityVerdict {
  return { status, summary, blocking };
}

function summarizeDocsVerdict(surfaces: ReleaseAuthoritySurface[]) {
  const docDrift = surfaces.filter((surface) =>
    surface.driftReasons.some((reason) => reason.toLowerCase().includes("doc")),
  );
  if (docDrift.length > 0) {
    return buildVerdict(
      "drifted",
      `${docDrift.length} surface(s) still have docs posture drift.`,
      true,
    );
  }
  return buildVerdict(
    "aligned",
    "Authority docs explicitly cover the current live, flagged, and legacy surfaces.",
    false,
  );
}

function summarizeFlagVerdict(surfaces: ReleaseAuthoritySurface[]) {
  const flagDrift = surfaces.filter((surface) =>
    surface.driftReasons.some((reason) => reason.toLowerCase().includes("flag")),
  );
  const unknown = surfaces.some((surface) => surface.driftState === "unknown");
  if (flagDrift.length > 0) {
    return buildVerdict(
      "drifted",
      `${flagDrift.length} surface(s) have runtime/flag posture drift.`,
      true,
    );
  }
  if (unknown) {
    return buildVerdict(
      "unknown",
      "At least one flagged surface could not be tied back to a known flag posture.",
      true,
    );
  }
  return buildVerdict(
    "aligned",
    "Flag posture matches the declared live, flagged, and legacy surface states.",
    false,
  );
}

function summarizeLiveVsMain(input: {
  currentLiveSha: string;
  currentMainSha: string | null;
}) {
  if (
    !isFullCommitSha(input.currentLiveSha) ||
    !isFullCommitSha(input.currentMainSha)
  ) {
    return buildVerdict(
      "unknown",
      "Current live SHA or remote main SHA could not be resolved as a full commit SHA.",
      true,
    );
  }

  if (input.currentLiveSha === input.currentMainSha) {
    return buildVerdict(
      "aligned",
      "Current live SHA matches remote main.",
      false,
    );
  }

  return buildVerdict(
    "drifted",
    `Current live SHA ${input.currentLiveSha} differs from remote main ${input.currentMainSha}.`,
    true,
  );
}

function buildUnresolvedDriftItems(input: {
  surfaces: ReleaseAuthoritySurface[];
  liveVsMain: ReleaseAuthorityVerdict;
  docsVsRuntime: ReleaseAuthorityVerdict;
  flagsVsRuntime: ReleaseAuthorityVerdict;
}): ReleaseAuthorityDriftItem[] {
  const items: ReleaseAuthorityDriftItem[] = [];

  if (input.liveVsMain.status !== "aligned") {
    items.push({
      id: "release-live-vs-main",
      scope: "release",
      status: input.liveVsMain.status,
      detail: input.liveVsMain.summary,
    });
  }

  if (input.docsVsRuntime.status !== "aligned") {
    items.push({
      id: "docs-vs-runtime",
      scope: "docs",
      status: input.docsVsRuntime.status,
      detail: input.docsVsRuntime.summary,
    });
  }

  if (input.flagsVsRuntime.status !== "aligned") {
    items.push({
      id: "flags-vs-runtime",
      scope: "flags",
      status: input.flagsVsRuntime.status,
      detail: input.flagsVsRuntime.summary,
    });
  }

  for (const surface of input.surfaces) {
    if (surface.driftState === "aligned") continue;
    items.push({
      id: `surface-${surface.id}`,
      scope: surface.driftReasons.some((reason) =>
        reason.toLowerCase().includes("doc"),
      )
        ? "docs"
        : surface.driftReasons.some((reason) =>
              reason.toLowerCase().includes("flag"),
            )
          ? "flags"
          : "surface",
      status: surface.driftState,
      surfaceId: surface.id,
      detail:
        surface.driftReasons[0] ??
        `${surface.label} could not be fully reconciled.`,
    });
  }

  return items;
}

function buildReviewOrder(input: {
  currentLiveSha: string;
  currentMainSha: string | null;
  unresolvedDriftItems: ReleaseAuthorityDriftItem[];
}) {
  const items = [
    `Review release identity first: live SHA ${input.currentLiveSha}${
      input.currentMainSha ? ` vs main ${input.currentMainSha}` : ""
    }.`,
    "Review the feature matrix next: runtime state, flag posture, and docs posture for each surface.",
    `Review ${RELEASE_AUTHORITY_CANONICAL_DOC} before older Phase 02-06 docs when deciding what is truly live.`,
    "Review legacy aliases after the main surfaces so redirects do not get mistaken for canonical entrypoints.",
  ];

  if (input.unresolvedDriftItems.length > 0) {
    items.push(
      "Review unresolved drift items before treating the baseline as release-ready.",
    );
  } else {
    items.push("No unresolved drift items remain after the authority reconciliation.");
  }

  return items;
}

function buildLiveMainDocsVerdict(input: {
  liveVsMain: ReleaseAuthorityVerdict;
  docsVsRuntime: ReleaseAuthorityVerdict;
  flagsVsRuntime: ReleaseAuthorityVerdict;
}): ReleaseAuthorityVerdict {
  const status: ReleaseAuthorityDriftState =
    input.liveVsMain.status === "drifted" ||
    input.docsVsRuntime.status === "drifted" ||
    input.flagsVsRuntime.status === "drifted"
      ? "drifted"
      : input.liveVsMain.status === "unknown" ||
          input.docsVsRuntime.status === "unknown" ||
          input.flagsVsRuntime.status === "unknown"
        ? "unknown"
        : "aligned";

  return buildVerdict(
    status,
    status === "aligned"
      ? "Live, main, docs, and flag posture are aligned."
      : status === "unknown"
        ? "At least one live/main/docs authority signal could not be fully resolved."
        : "Live, main, docs, or flag posture still drift.",
    status !== "aligned",
  );
}

function buildOverallVerdict(
  unresolvedDriftItems: ReleaseAuthorityDriftItem[],
): ReleaseAuthorityVerdict {
  const status: ReleaseAuthorityDriftState = unresolvedDriftItems.some(
    (item) => item.status === "drifted",
  )
    ? "drifted"
    : unresolvedDriftItems.some((item) => item.status === "unknown")
      ? "unknown"
      : "aligned";

  return buildVerdict(
    status,
    status === "aligned"
      ? "One release authority now explains the accepted baseline."
      : status === "unknown"
        ? "Release authority remains partially unresolved."
        : "Release authority still contains explainable drift that needs review.",
    status !== "aligned",
  );
}

function buildCarryForward(input: {
  surfaces: ReleaseAuthoritySurface[];
}): ReleaseAuthorityReport["carryForward"] {
  void input;
  const acceptanceGaps: ReleaseAuthorityCarryForwardItem[] = [];

  return {
    summary:
      acceptanceGaps.length === 0
        ? "No accepted carry-forward gaps remain."
        : `${acceptanceGaps.length} accepted carry-forward gap(s) remain and must stay literal in the authority docs.`,
    acceptanceGaps,
  };
}

export function buildReleaseAuthorityReport(input: {
  currentLiveSha?: string;
  currentMainSha?: string | null;
  currentMainShaSource?:
    | "github_branch_head"
    | "env_override"
    | "git_remote"
    | "unresolved";
  nodeEnv?: string;
  generatedAt?: string;
} = {}): ReleaseAuthorityReport {
  const surfaces = RELEASE_AUTHORITY_SURFACES.map((definition) =>
    buildSurface({
      definition,
      flagPosture: definition.flagResolver?.() ?? null,
    }),
  );

  const currentLiveSha = input.currentLiveSha ?? getCurrentRuntimeBuildId();
  const currentMainSha = input.currentMainSha ?? null;
  const liveVsMain = summarizeLiveVsMain({
    currentLiveSha,
    currentMainSha,
  });
  const docsVsRuntime = summarizeDocsVerdict(surfaces);
  const flagsVsRuntime = summarizeFlagVerdict(surfaces);
  const unresolvedDriftItems = buildUnresolvedDriftItems({
    surfaces,
    liveVsMain,
    docsVsRuntime,
    flagsVsRuntime,
  });
  const carryForward = buildCarryForward({ surfaces });

  return {
    schemaVersion: RELEASE_AUTHORITY_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    runtime: {
      nodeEnv: input.nodeEnv ?? process.env.NODE_ENV ?? "unknown",
      currentLiveSha,
      currentLiveShaSource: "build_runtime",
      currentMainSha,
      currentMainShaSource: input.currentMainShaSource ?? "unresolved",
    },
    release: {
      repository: RELEASE_AUTHORITY_REPOSITORY,
      deployUrl: "https://adsecute.com",
      buildInfoUrl: "https://adsecute.com/api/build-info",
      releaseAuthorityUrl: "https://adsecute.com/api/release-authority",
      previousKnownGoodSha: RELEASE_AUTHORITY_PREVIOUS_KNOWN_GOOD_SHA,
      previousKnownGoodSource: RELEASE_AUTHORITY_PREVIOUS_KNOWN_GOOD_SOURCE,
      featureAuthoritySource: {
        manifestModule: "lib/release-authority/inventory.ts",
        apiRoute: "/api/release-authority",
        adminRoute: "/admin/release-authority",
        canonicalDoc: RELEASE_AUTHORITY_CANONICAL_DOC,
      },
    },
    verdicts: {
      liveVsMain,
      docsVsRuntime,
      flagsVsRuntime,
      liveMainDocs: buildLiveMainDocsVerdict({
        liveVsMain,
        docsVsRuntime,
        flagsVsRuntime,
      }),
      overall: buildOverallVerdict(unresolvedDriftItems),
    },
    surfaces,
    unresolvedDriftItems,
    carryForward,
    reviewOrder: buildReviewOrder({
      currentLiveSha,
      currentMainSha,
      unresolvedDriftItems,
    }),
  };
}

export type ReleaseAuthorityResolvedMainShaSource = Exclude<
  ReleaseAuthorityReport["runtime"]["currentMainShaSource"],
  "unresolved"
>;

/**
 * Fill in the remote-main SHA on a report whose runtime could not resolve it
 * (for example production runtimes that cannot query the private GitHub repo
 * anonymously), and re-derive every verdict that depends on that SHA.
 *
 * This only substitutes an externally-verified SHA when the report itself is
 * unresolved; a report that already resolved remote main is returned
 * unchanged so a genuine runtime-observed drift can never be overwritten.
 */
export function reconcileReleaseAuthorityMainSha(
  report: ReleaseAuthorityReport,
  input: {
    currentMainSha: string;
    currentMainShaSource: ReleaseAuthorityResolvedMainShaSource;
  },
): ReleaseAuthorityReport {
  const runtimeAlreadyResolved =
    report.runtime.currentMainShaSource !== "unresolved" &&
    isFullCommitSha(report.runtime.currentMainSha);
  if (runtimeAlreadyResolved || !isFullCommitSha(input.currentMainSha)) {
    return report;
  }

  const currentMainSha = input.currentMainSha.trim().toLowerCase();
  const liveVsMain = summarizeLiveVsMain({
    currentLiveSha: report.runtime.currentLiveSha,
    currentMainSha,
  });

  const retainedDriftItems = report.unresolvedDriftItems.filter(
    (item) => item.id !== "release-live-vs-main",
  );
  const unresolvedDriftItems: ReleaseAuthorityDriftItem[] =
    liveVsMain.status === "aligned"
      ? retainedDriftItems
      : [
          {
            id: "release-live-vs-main",
            scope: "release",
            status: liveVsMain.status,
            detail: liveVsMain.summary,
          },
          ...retainedDriftItems,
        ];

  return {
    ...report,
    runtime: {
      ...report.runtime,
      currentMainSha,
      currentMainShaSource: input.currentMainShaSource,
    },
    verdicts: {
      ...report.verdicts,
      liveVsMain,
      liveMainDocs: buildLiveMainDocsVerdict({
        liveVsMain,
        docsVsRuntime: report.verdicts.docsVsRuntime,
        flagsVsRuntime: report.verdicts.flagsVsRuntime,
      }),
      overall: buildOverallVerdict(unresolvedDriftItems),
    },
    unresolvedDriftItems,
    reviewOrder: buildReviewOrder({
      currentLiveSha: report.runtime.currentLiveSha,
      currentMainSha,
      unresolvedDriftItems,
    }),
  };
}

export async function resolveRemoteMainSha(input: {
  timeoutMs?: number;
} = {}) {
  const envOverride = process.env.RELEASE_AUTHORITY_REMOTE_MAIN_SHA?.trim();
  if (envOverride) {
    return {
      sha: envOverride,
      source: "env_override" as const,
    };
  }

  const githubToken =
    process.env.RELEASE_AUTHORITY_GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    null;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${RELEASE_AUTHORITY_REPOSITORY.fullName}/commits/${RELEASE_AUTHORITY_REPOSITORY.branch}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "adsecute-release-authority",
          ...(githubToken
            ? { Authorization: `Bearer ${githubToken}` }
            : {}),
        },
        signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return {
        sha: null,
        source: "unresolved" as const,
      };
    }
    const payload = (await response.json().catch(() => null)) as
      | { sha?: unknown }
      | null;
    const sha = typeof payload?.sha === "string" ? payload.sha.trim() : null;
    return {
      sha: sha || null,
      source: sha ? ("github_branch_head" as const) : ("unresolved" as const),
    };
  } catch {
    return {
      sha: null,
      source: "unresolved" as const,
    };
  }
}

export async function getReleaseAuthorityReport() {
  const remoteMain = await resolveRemoteMainSha();
  return buildReleaseAuthorityReport({
    currentLiveSha: getCurrentRuntimeBuildId(),
    currentMainSha: remoteMain.sha,
    currentMainShaSource: remoteMain.source,
    nodeEnv: process.env.NODE_ENV ?? "unknown",
  });
}
