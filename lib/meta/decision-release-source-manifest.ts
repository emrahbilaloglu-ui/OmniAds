import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The main commit immediately before this Meta decision repair. */
export const META_DECISION_RELEASE_BASE_SHA =
  "ef33d238b9b0a854f884fa85d15804b8d8bd0615";
export const META_DECISION_RELEASE_MANIFEST_PATH =
  "docs/meta-decision-center/RELEASE_SOURCE_MANIFEST_2026-09-22.json";

export interface MetaDecisionReleaseSourceManifest {
  manifestHash: string;
  hashAlgorithm: "sha256";
  hashBasis: string;
  contract: "adsecute.meta-decision-release-source.v1";
  baseSha: string;
  selfExcludedPath: string;
  entries: Array<{ path: string; sha256: string | null }>;
}

function gitPaths(args: string[], root: string): string[] {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

/** Exact changed + new path set, before and after the release commit. */
export function metaDecisionReleaseCandidatePaths(root = process.cwd()): string[] {
  const changed = gitPaths(
    ["diff", "--name-only", "--no-renames", "-z", META_DECISION_RELEASE_BASE_SHA, "--"],
    root,
  );
  const untracked = gitPaths(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    root,
  );
  return [...new Set([...changed, ...untracked])]
    .filter(
      (path) =>
        path !== META_DECISION_RELEASE_MANIFEST_PATH &&
        !path.startsWith("scratchpad/"),
    )
    .sort((left, right) => left.localeCompare(right));
}

export function buildMetaDecisionReleaseSourceManifest(
  root = process.cwd(),
): MetaDecisionReleaseSourceManifest {
  const body = {
    contract: "adsecute.meta-decision-release-source.v1" as const,
    baseSha: META_DECISION_RELEASE_BASE_SHA,
    selfExcludedPath: META_DECISION_RELEASE_MANIFEST_PATH,
    entries: metaDecisionReleaseCandidatePaths(root).map((path) => ({
      path,
      sha256: existsSync(join(root, path))
        ? createHash("sha256")
            .update(readFileSync(join(root, path)))
            .digest("hex")
        : null,
    })),
  };
  return {
    manifestHash: createHash("sha256")
      .update(JSON.stringify(body, null, 2), "utf8")
      .digest("hex"),
    hashAlgorithm: "sha256",
    hashBasis: "sha256 of UTF-8 JSON.stringify(body, null, 2)",
    ...body,
  };
}
