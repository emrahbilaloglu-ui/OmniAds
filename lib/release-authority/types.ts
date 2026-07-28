export const RELEASE_AUTHORITY_SCHEMA_VERSION = "release-authority.v1" as const;

/**
 * The repository that owns releases, after the transfer to emrahbilaloglu-ui.
 *
 * This is the canonical answer to "where does a release come from". CI, the
 * compose file, the remote deploy verifier and the cutover scripts cannot
 * import TypeScript, so they carry their own literals — and a contract test
 * (release-namespace.test.ts) asserts every one of them still agrees with
 * these constants. That is the guard against the copies drifting apart, which
 * is the failure mode a plain find-and-replace leaves behind.
 */
export const RELEASE_AUTHORITY_REPOSITORY = {
  owner: "emrahbilaloglu-ui",
  name: "OmniAds",
  fullName: "emrahbilaloglu-ui/OmniAds",
  branch: "main",
} as const;

/** GHCR namespace that new builds publish into. */
export const RELEASE_AUTHORITY_IMAGE_NAMESPACE = "ghcr.io/emrahbilaloglu-ui" as const;
export const RELEASE_AUTHORITY_WEB_IMAGE =
  `${RELEASE_AUTHORITY_IMAGE_NAMESPACE}/omniads-web` as const;
export const RELEASE_AUTHORITY_WORKER_IMAGE =
  `${RELEASE_AUTHORITY_IMAGE_NAMESPACE}/omniads-worker` as const;

/**
 * The pre-transfer namespace. NOT dead code, and deliberately not deleted.
 *
 * Every image built before the transfer — including whatever SHA production is
 * running right now and the previous known-good SHA a rollback would target —
 * exists only under this namespace. It was never republished under the new
 * owner, so a rollback across the transfer boundary must pull from here.
 * Pretending those tags exist under the new owner would produce a "manifest
 * unknown" at the worst possible moment.
 *
 * The compose file therefore takes the repository as an overridable variable:
 * an ordinary deploy uses the new default, and a legacy rollback sets
 * WEB_IMAGE_REPO / WORKER_IMAGE_REPO to these values explicitly.
 */
export const RELEASE_AUTHORITY_LEGACY_IMAGE_NAMESPACE = "ghcr.io/erhanrdn" as const;
export const RELEASE_AUTHORITY_LEGACY_WEB_IMAGE =
  `${RELEASE_AUTHORITY_LEGACY_IMAGE_NAMESPACE}/omniads-web` as const;
export const RELEASE_AUTHORITY_LEGACY_WORKER_IMAGE =
  `${RELEASE_AUTHORITY_LEGACY_IMAGE_NAMESPACE}/omniads-worker` as const;

export type ReleaseAuthorityRepositoryState = "merged";
export type ReleaseAuthorityRuntimeState =
  | "live"
  | "flagged"
  | "legacy"
  | "hidden";
export type ReleaseAuthorityDocsState = "current" | "legacy" | "missing";
export type ReleaseAuthorityDriftState = "aligned" | "drifted" | "unknown";
export type ReleaseAuthorityFlagMode = "enabled" | "disabled" | "allowlist";
export type ReleaseAuthorityReferenceKind =
  | "page"
  | "api"
  | "component"
  | "doc"
  | "alias";

export interface ReleaseAuthorityFlagPosture {
  mode: ReleaseAuthorityFlagMode;
  flagKeys: string[];
  summary: string;
}

export interface ReleaseAuthorityReference {
  kind: ReleaseAuthorityReferenceKind;
  path: string;
  label: string;
}

export interface ReleaseAuthoritySurfaceDefinition {
  id: string;
  label: string;
  area:
    | "commercial"
    | "meta"
    | "creative"
    | "workflow"
    | "execution"
    | "copy"
    | "legacy";
  repositoryState: ReleaseAuthorityRepositoryState;
  runtimeState:
    | ReleaseAuthorityRuntimeState
    | ((input: {
        flagPosture: ReleaseAuthorityFlagPosture | null;
      }) => ReleaseAuthorityRuntimeState);
  docsState: ReleaseAuthorityDocsState;
  flagResolver?: () => ReleaseAuthorityFlagPosture | null;
  references: ReleaseAuthorityReference[];
  notes: string[];
}

export interface ReleaseAuthoritySurface {
  id: string;
  label: string;
  area: ReleaseAuthoritySurfaceDefinition["area"];
  repositoryState: ReleaseAuthorityRepositoryState;
  runtimeState: ReleaseAuthorityRuntimeState;
  docsState: ReleaseAuthorityDocsState;
  flagPosture: ReleaseAuthorityFlagPosture | null;
  driftState: ReleaseAuthorityDriftState;
  driftReasons: string[];
  references: ReleaseAuthorityReference[];
  notes: string[];
}

export interface ReleaseAuthorityVerdict {
  status: ReleaseAuthorityDriftState;
  summary: string;
  blocking: boolean;
}

export interface ReleaseAuthorityDriftItem {
  id: string;
  scope: "release" | "surface" | "docs" | "flags";
  status: Exclude<ReleaseAuthorityDriftState, "aligned">;
  surfaceId?: string;
  detail: string;
}

export interface ReleaseAuthorityCarryForwardItem {
  id: string;
  surfaceId: string;
  label: string;
  status: "accepted_gap" | "complete";
  proofLevel: string | null;
  detail: string;
  nextRequirement: string;
}

export interface ReleaseAuthorityReport {
  schemaVersion: typeof RELEASE_AUTHORITY_SCHEMA_VERSION;
  generatedAt: string;
  runtime: {
    nodeEnv: string;
    currentLiveSha: string;
    currentLiveShaSource: "build_runtime";
    currentMainSha: string | null;
    currentMainShaSource:
      | "github_branch_head"
      | "env_override"
      | "git_remote"
      | "unresolved";
  };
  release: {
    repository: typeof RELEASE_AUTHORITY_REPOSITORY;
    deployUrl: string;
    buildInfoUrl: string;
    releaseAuthorityUrl: string;
    previousKnownGoodSha: string;
    previousKnownGoodSource: string;
    featureAuthoritySource: {
      manifestModule: string;
      apiRoute: string;
      adminRoute: string;
      canonicalDoc: string;
    };
  };
  verdicts: {
    liveVsMain: ReleaseAuthorityVerdict;
    docsVsRuntime: ReleaseAuthorityVerdict;
    flagsVsRuntime: ReleaseAuthorityVerdict;
    liveMainDocs: ReleaseAuthorityVerdict;
    overall: ReleaseAuthorityVerdict;
  };
  surfaces: ReleaseAuthoritySurface[];
  unresolvedDriftItems: ReleaseAuthorityDriftItem[];
  carryForward: {
    summary: string;
    acceptanceGaps: ReleaseAuthorityCarryForwardItem[];
  };
  reviewOrder: string[];
}
