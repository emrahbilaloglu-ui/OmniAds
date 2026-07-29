export function getCurrentRuntimeBuildId() {
  return (
    process.env.APP_BUILD_ID?.trim() ||
    process.env.NEXT_BUILD_ID?.trim() ||
    process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
    process.env.RENDER_GIT_COMMIT?.trim() ||
    "dev-build"
  );
}

/**
 * The release identity BAKED INTO THE IMAGE at build time.
 *
 * `APP_BUILD_ID` is not that. docker-compose interpolates it from the shell or
 * from an env file on the host, and `environment:` overrides whatever the image
 * itself declares — so a `.env.production` left behind by an earlier release
 * renames the running build without changing a byte of it. A worker started
 * from the `8de3…` image then heartbeats `6b0a…`, `sync_runtime_instances`
 * agrees with the heartbeat, and every downstream check that compares the two
 * passes while pointing at the wrong release.
 *
 * This variable is set by the Dockerfile from the same ARG as the image's
 * `org.opencontainers.image.revision` label and is never named in
 * docker-compose.yml, so nothing on the host can overwrite it.
 */
export const IMAGE_BUILD_ID_ENV = "ADSECUTE_IMAGE_BUILD_ID";

/** Values that identify nothing and must never be accepted as a release. */
const PLACEHOLDER_BUILD_IDS = new Set([
  "dev-build",
  "unknown",
  "none",
  "null",
  "undefined",
]);

function readIdentity(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (PLACEHOLDER_BUILD_IDS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

export type ImmutableBuildIdentity =
  | {
      ok: true;
      /** The identity every downstream record must carry. */
      buildId: string;
      /** Where it came from. `image` is authoritative; `declared` is trusted. */
      source: "image" | "declared";
      imageBuildId: string | null;
      declaredBuildId: string | null;
    }
  | {
      ok: false;
      reason: "build_identity_missing" | "build_identity_mismatch";
      message: string;
      imageBuildId: string | null;
      declaredBuildId: string | null;
    };

/**
 * Resolve the one release identity this process is allowed to claim.
 *
 * Fail closed: a mismatch between what the image is and what the host says it
 * is refuses rather than picking a winner, because either value being wrong is
 * a reason to stop — the orchestrator pins an exact target SHA, and a process
 * that cannot prove it is that target must not register as it.
 */
export function resolveImmutableBuildIdentity(
  env: NodeJS.ProcessEnv = process.env,
): ImmutableBuildIdentity {
  const imageBuildId = readIdentity(env[IMAGE_BUILD_ID_ENV]);
  const declaredBuildId = readIdentity(env.APP_BUILD_ID);

  if (imageBuildId && declaredBuildId && imageBuildId !== declaredBuildId) {
    return {
      ok: false,
      reason: "build_identity_mismatch",
      message: `the image was built as ${imageBuildId} but APP_BUILD_ID says ${declaredBuildId}; refusing to identify as either`,
      imageBuildId,
      declaredBuildId,
    };
  }
  if (imageBuildId) {
    return {
      ok: true,
      buildId: imageBuildId,
      source: "image",
      imageBuildId,
      declaredBuildId,
    };
  }
  if (declaredBuildId) {
    return {
      ok: true,
      buildId: declaredBuildId,
      source: "declared",
      imageBuildId,
      declaredBuildId,
    };
  }
  return {
    ok: false,
    reason: "build_identity_missing",
    message: `no immutable release identity: neither ${IMAGE_BUILD_ID_ENV} (baked into the image) nor APP_BUILD_ID names a build`,
    imageBuildId,
    declaredBuildId,
  };
}

export class BuildIdentityRefusal extends Error {
  readonly reason: "build_identity_missing" | "build_identity_mismatch";
  readonly imageBuildId: string | null;
  readonly declaredBuildId: string | null;

  constructor(
    identity: Extract<ImmutableBuildIdentity, { ok: false }>,
    context: string,
  ) {
    super(`${context}: ${identity.message}`);
    this.name = "BuildIdentityRefusal";
    this.reason = identity.reason;
    this.imageBuildId = identity.imageBuildId;
    this.declaredBuildId = identity.declaredBuildId;
  }
}

/**
 * Resolve the immutable identity and make every later reader agree with it.
 *
 * `APP_BUILD_ID` is what `buildRuntimeContract()` reads, which is what
 * `sync_worker_heartbeats.meta_json.runtimeContract.buildId`,
 * `sync_runtime_instances` and `/api/build-info` all carry. Writing the
 * resolved value back is what makes those agree by construction instead of by
 * coincidence; it can only ever fill in a missing value or restate the one
 * already there, because a conflict refuses above.
 */
export function assertImmutableBuildIdentity(input: {
  context: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = input.env ?? process.env;
  const identity = resolveImmutableBuildIdentity(env);
  if (!identity.ok) {
    throw new BuildIdentityRefusal(identity, input.context);
  }
  env.APP_BUILD_ID = identity.buildId;
  return identity.buildId;
}
