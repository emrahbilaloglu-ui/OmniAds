import { describe, expect, it } from "vitest";
import {
  BuildIdentityRefusal,
  IMAGE_BUILD_ID_ENV,
  assertImmutableBuildIdentity,
  resolveImmutableBuildIdentity,
} from "@/lib/build-runtime";

const TARGET = "8de30c461c51d3e76e7cd5cc4fb71984751d014e";
const STALE = "6b0a30df42133c1f5ba07f0bd4c4e0b8bb1b7f5a";

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...values } as NodeJS.ProcessEnv;
}

describe("immutable build identity", () => {
  it("prefers the identity baked into the image", () => {
    const identity = resolveImmutableBuildIdentity(
      env({ [IMAGE_BUILD_ID_ENV]: TARGET, APP_BUILD_ID: TARGET }),
    );
    expect(identity).toMatchObject({ ok: true, buildId: TARGET, source: "image" });
  });

  // The exact production shape: the image is 8de3…, the host's .env.production
  // still says 6b0a… from an earlier release. Picking either one silently
  // identifies the wrong release to the deploy gate.
  it("refuses when a stale host value disagrees with the image", () => {
    const identity = resolveImmutableBuildIdentity(
      env({ [IMAGE_BUILD_ID_ENV]: TARGET, APP_BUILD_ID: STALE }),
    );
    expect(identity.ok).toBe(false);
    if (identity.ok) throw new Error("unreachable");
    expect(identity.reason).toBe("build_identity_mismatch");
    expect(identity.imageBuildId).toBe(TARGET);
    expect(identity.declaredBuildId).toBe(STALE);
    expect(identity.message).toContain(TARGET);
    expect(identity.message).toContain(STALE);
  });

  it("accepts the orchestrator's pinned value when the image carries none", () => {
    const identity = resolveImmutableBuildIdentity(env({ APP_BUILD_ID: TARGET }));
    expect(identity).toMatchObject({ ok: true, buildId: TARGET, source: "declared" });
  });

  it("refuses when nothing names a build", () => {
    const identity = resolveImmutableBuildIdentity(env({}));
    expect(identity.ok).toBe(false);
    if (identity.ok) throw new Error("unreachable");
    expect(identity.reason).toBe("build_identity_missing");
  });

  // "dev-build" is what getCurrentRuntimeBuildId() answers when it has nothing.
  // Accepting it here would let the fallback masquerade as a release.
  it.each(["dev-build", "DEV-BUILD", "unknown", "none", "null", "undefined", "   "])(
    "treats %j as naming no build at all",
    (placeholder) => {
      expect(resolveImmutableBuildIdentity(env({ APP_BUILD_ID: placeholder })).ok).toBe(
        false,
      );
      expect(
        resolveImmutableBuildIdentity(env({ [IMAGE_BUILD_ID_ENV]: placeholder })).ok,
      ).toBe(false);
    },
  );

  it("does not treat a placeholder image value as a conflict with a real one", () => {
    const identity = resolveImmutableBuildIdentity(
      env({ [IMAGE_BUILD_ID_ENV]: "dev-build", APP_BUILD_ID: TARGET }),
    );
    expect(identity).toMatchObject({ ok: true, buildId: TARGET, source: "declared" });
  });

  it("trims surrounding whitespace rather than refusing on it", () => {
    const identity = resolveImmutableBuildIdentity(
      env({ [IMAGE_BUILD_ID_ENV]: ` ${TARGET} `, APP_BUILD_ID: TARGET }),
    );
    expect(identity).toMatchObject({ ok: true, buildId: TARGET });
  });
});

describe("assertImmutableBuildIdentity", () => {
  // Heartbeat metadata and sync_runtime_instances are written by different code
  // paths that both read APP_BUILD_ID. Normalising it is what makes them agree
  // by construction rather than by coincidence.
  it("writes the resolved identity back so every later reader agrees", () => {
    const scope = env({ [IMAGE_BUILD_ID_ENV]: TARGET });
    expect(scope.APP_BUILD_ID).toBeUndefined();
    expect(assertImmutableBuildIdentity({ context: "test", env: scope })).toBe(TARGET);
    expect(scope.APP_BUILD_ID).toBe(TARGET);
  });

  it("throws a refusal that names the conflict", () => {
    const scope = env({ [IMAGE_BUILD_ID_ENV]: TARGET, APP_BUILD_ID: STALE });
    let thrown: unknown = null;
    try {
      assertImmutableBuildIdentity({ context: "durable_worker_boot", env: scope });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BuildIdentityRefusal);
    const refusal = thrown as BuildIdentityRefusal;
    expect(refusal.reason).toBe("build_identity_mismatch");
    expect(refusal.message).toContain("durable_worker_boot");
    // The conflicting value is NOT adopted on the way out.
    expect(scope.APP_BUILD_ID).toBe(STALE);
  });

  it("throws when nothing names a build", () => {
    expect(() => assertImmutableBuildIdentity({ context: "test", env: env({}) })).toThrow(
      BuildIdentityRefusal,
    );
  });
});
