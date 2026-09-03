/**
 * PRE-DEPLOY AUDIT — D082's pinned inputs must survive a CLEAN CHECKOUT.
 *
 * WHY THIS FILE EXISTS. `.gitignore` carried
 * `/docs/creative-decision-center/generated/h11b-context-lifecycle-bundle-*.json`
 * under the claim that it was "generator OUTPUT that no test reads from disk".
 * It is read from disk — by exact path and by pinned SHA-256 — at
 * `scripts/audits/d082-meta-role-provenance-replay.ts` via
 * `D082_PINNED_INPUTS.h11bBundlePath`. The file existed in the working tree
 * where the claim was written, so every gate stayed green while the release
 * being assembled could not reproduce D082 at all: a fresh clone would have no
 * such file and the replay refuses on a missing pinned input.
 *
 * The lesson is not "remember to check the ignore file". It is that a pinned
 * input's presence was never asserted against the inventory a release actually
 * ships. That is what this file asserts.
 *
 * WHAT A CLEAN-CHECKOUT-EQUIVALENT INVENTORY IS. `git ls-files --cached
 * --others --exclude-standard` lists exactly the paths a release can contain:
 * what is already tracked, plus what is untracked-but-stageable. An IGNORED
 * path appears in neither — it is invisible to `git add`, so it cannot reach a
 * commit, so it cannot reach a clone. Membership in that set is therefore the
 * honest local proxy for "a clean checkout will have this file", and it is
 * decided by git itself rather than by re-reading the ignore rules and
 * reasoning about globs.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { D082_PINNED_INPUTS } from "@/scripts/audits/d082-meta-role-provenance-replay";

/** Every path D082 refuses to run without, with the SHA it refuses to differ from. */
const PINNED: ReadonlyArray<readonly [string, string]> = [
  [D082_PINNED_INPUTS.d080aArtifactPath, D082_PINNED_INPUTS.d080aArtifactSha256],
  [D082_PINNED_INPUTS.d080bArtifactPath, D082_PINNED_INPUTS.d080bArtifactSha256],
  [D082_PINNED_INPUTS.d081ArtifactPath, D082_PINNED_INPUTS.d081ArtifactSha256],
  [D082_PINNED_INPUTS.h11bBundlePath, D082_PINNED_INPUTS.h11bBundleSha256],
  [D082_PINNED_INPUTS.h11bEvalArtifactPath, D082_PINNED_INPUTS.h11bEvalArtifactSha256],
];

/**
 * The paths a release can ship: tracked plus untracked-but-not-ignored.
 *
 * Read once. `-z` because a repo path may legally contain a newline, and a
 * newline-split inventory would silently drop the entry after one.
 */
function releaseInventory(): ReadonlySet<string> {
  const stdout = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const paths = stdout.split("\0").filter(Boolean);
  // A floor: an empty or near-empty inventory would satisfy nothing below by
  // being vacuous rather than by being correct.
  if (paths.length < 500) {
    throw new Error(`release inventory implausibly small (${paths.length} paths)`);
  }
  return new Set(paths);
}

describe("D082 pinned inputs survive a clean checkout", () => {
  const inventory = releaseInventory();

  it("names five pinned inputs, so the loops below cannot pass vacuously", () => {
    expect(PINNED).toHaveLength(5);
    for (const [path] of PINNED) expect(path.length).toBeGreaterThan(10);
  });

  it("every pinned input is in the release inventory — none is ignored", () => {
    const missing = PINNED.map(([path]) => path).filter((path) => !inventory.has(path));
    expect(missing).toEqual([]);
  });

  it("git itself agrees no pinned input is ignored", () => {
    /*
      Belt and braces, and NOT redundant: `ls-files` answers "is it listed",
      `check-ignore` answers "does a rule match". A file that is already
      tracked is listed even when a rule matches it, and that combination is
      exactly the trap here — it would keep working in this clone and break in
      the next one that stages from scratch.
    */
    const ignored: string[] = [];
    for (const [path] of PINNED) {
      try {
        execFileSync("git", ["check-ignore", "-q", "--no-index", path], { stdio: "ignore" });
        ignored.push(path);
      } catch {
        // Exit 1 means "no rule matches", which is what we require.
      }
    }
    expect(ignored).toEqual([]);
  });

  it("every pinned input exists, is non-empty, and matches its pinned digest", () => {
    for (const [path, expected] of PINNED) {
      const absolute = resolve(path);
      expect(existsSync(absolute), `${path} missing`).toBe(true);
      expect(statSync(absolute).size, `${path} empty`).toBeGreaterThan(0);
      const actual = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      expect(actual, path).toBe(expected);
    }
  });

  it("the H11b bundle is the exact artifact the ignore rule used to hide", () => {
    // Stated by name and size as well as digest, because this one file is the
    // whole reason this suite exists.
    const path = D082_PINNED_INPUTS.h11bBundlePath;
    expect(path).toBe(
      "docs/creative-decision-center/generated/h11b-context-lifecycle-bundle-2026-07-13-to-2026-08-22.json",
    );
    expect(D082_PINNED_INPUTS.h11bBundleSha256).toBe(
      "f27f6cbe6437c2c8ecd3dff93ea24f9d91356403057d5253a17abc30b91cf13f",
    );
    expect(statSync(resolve(path)).size).toBe(12_908_890);
    expect(inventory.has(path)).toBe(true);
  });

  it("carries no credential-shaped material", () => {
    /*
      The bundle ships advertiser BUSINESS NAMES — six of them, the operator's
      own — which is why it was excluded in the first place. That is data the
      repo owner already owns; a credential is not. Scanned rather than
      asserted, and scanned on the bytes rather than on a parse, so an
      encoded-but-present token is still found.
    */
    const bytes = readFileSync(resolve(D082_PINNED_INPUTS.h11bBundlePath), "latin1");
    const CREDENTIAL_SHAPES = [
      /sk-[A-Za-z0-9]{20,}/,
      /EAA[A-Za-z0-9]{60,}/,
      /ghp_[A-Za-z0-9]{30,}/,
      /github_pat_[A-Za-z0-9_]{40,}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /xox[baprs]-[A-Za-z0-9-]{10,}/,
      /eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}/,
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    ];
    const hits = CREDENTIAL_SHAPES.filter((shape) => shape.test(bytes)).map(String);
    expect(hits).toEqual([]);
  });
});
