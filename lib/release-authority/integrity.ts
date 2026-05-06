import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RELEASE_AUTHORITY_CANONICAL_DOC } from "@/lib/release-authority/config";
import { RELEASE_AUTHORITY_SURFACES } from "@/lib/release-authority/inventory";

export interface ReleaseAuthorityIntegrityReport {
  missingPaths: string[];
  missingDocs: string[];
  bannerFailures: Array<{
    path: string;
    expectedSnippet: string;
  }>;
}

const PHASE_REFERENCE_DOCS = [
  "docs/phase-02-operating-modes.md",
  "docs/phase-03-meta-decision-os.md",
  "docs/phase-04-creative-action-contract.md",
  "docs/phase-05-command-center.md",
  "docs/phase-06-safe-execution-layer.md",
] as const;

const EXPECTED_BANNER_SNIPPET =
  "Live release posture for this surface now lives in `docs/v3-01-release-authority.md` and `/api/release-authority`.";

export function verifyReleaseAuthorityManifestIntegrity(): ReleaseAuthorityIntegrityReport {
  const missingPaths = new Set<string>();
  const missingDocs = new Set<string>();

  for (const surface of RELEASE_AUTHORITY_SURFACES) {
    for (const reference of surface.references) {
      const resolvedPath = path.join(process.cwd(), reference.path);
      if (existsSync(resolvedPath)) continue;
      missingPaths.add(reference.path);
      if (reference.kind === "doc") {
        missingDocs.add(reference.path);
      }
    }
  }

  const canonicalDocPath = path.join(process.cwd(), RELEASE_AUTHORITY_CANONICAL_DOC);
  if (!existsSync(canonicalDocPath)) {
    missingPaths.add(RELEASE_AUTHORITY_CANONICAL_DOC);
    missingDocs.add(RELEASE_AUTHORITY_CANONICAL_DOC);
  }

  const bannerFailures = PHASE_REFERENCE_DOCS.flatMap((relativePath) => {
    const absolutePath = path.join(process.cwd(), relativePath);
    if (!existsSync(absolutePath)) {
      return [{ path: relativePath, expectedSnippet: EXPECTED_BANNER_SNIPPET }];
    }
    const contents = readFileSync(absolutePath, "utf8");
    if (contents.includes(EXPECTED_BANNER_SNIPPET)) {
      return [];
    }
    return [{ path: relativePath, expectedSnippet: EXPECTED_BANNER_SNIPPET }];
  });

  return {
    missingPaths: [...missingPaths].sort(),
    missingDocs: [...missingDocs].sort(),
    bannerFailures,
  };
}

function runGitCommand(args: string[]) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

export function resolveLocalGitHeadSha() {
  return runGitCommand(["rev-parse", "HEAD"]);
}

export function resolveOriginMainSha() {
  const output = runGitCommand(["ls-remote", "origin", "refs/heads/main"]);
  const sha = output.split(/\s+/)[0]?.trim() ?? "";
  return sha || null;
}
