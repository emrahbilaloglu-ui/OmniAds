/**
 * Pure, injectable source-identity contract for the D077 release manifest.
 *
 * The generator supplies the real Git reader. Tests can supply a recording
 * reader and prove that the SHA serialized as `originMain` is the same value
 * used to calculate divergence, without making a committed artifact depend on
 * where `origin/main` happens to point during a later CI checkout.
 */
export type D077GitReader = (args: readonly string[]) => string;

export interface D077RemoteDivergence {
  aheadOfOriginMain: number;
  behindOriginMain: number;
}

export interface D077SourceIdentity {
  head: string;
  originMain: string;
  remoteDivergence: D077RemoteDivergence;
}

function requireCommitSha(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`D077 ${label} is not a full lowercase commit SHA.`);
  }
  return normalized;
}

export function readD077RemoteDivergence(input: {
  head: string;
  originMain: string;
  readGit: D077GitReader;
}): D077RemoteDivergence {
  const head = requireCommitSha(input.head, "head");
  const originMain = requireCommitSha(input.originMain, "originMain");
  const parts = input
    .readGit(["rev-list", "--left-right", "--count", `${originMain}...${head}`])
    .trim()
    .split(/\s+/);
  if (parts.length !== 2 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error("D077 origin/main divergence is not a two-count Git result.");
  }
  const [behindOriginMain, aheadOfOriginMain] = parts.map(Number);
  return { aheadOfOriginMain, behindOriginMain };
}

export function captureD077SourceIdentity(
  readGit: D077GitReader,
): D077SourceIdentity {
  const head = requireCommitSha(readGit(["rev-parse", "HEAD"]), "head");
  // One observation, reused verbatim below and by the returned manifest field.
  const originMain = requireCommitSha(
    readGit(["rev-parse", "origin/main"]),
    "originMain",
  );
  return {
    head,
    originMain,
    remoteDivergence: readD077RemoteDivergence({
      head,
      originMain,
      readGit,
    }),
  };
}
