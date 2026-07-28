import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RELEASE_AUTHORITY_IMAGE_NAMESPACE,
  RELEASE_AUTHORITY_LEGACY_IMAGE_NAMESPACE,
  RELEASE_AUTHORITY_LEGACY_WEB_IMAGE,
  RELEASE_AUTHORITY_LEGACY_WORKER_IMAGE,
  RELEASE_AUTHORITY_REPOSITORY,
  RELEASE_AUTHORITY_WEB_IMAGE,
  RELEASE_AUTHORITY_WORKER_IMAGE,
} from "./types";

/**
 * The cross-language release-identity contract, and the guard against the old
 * owner creeping back into an active path.
 *
 * WHY THIS EXISTS. The repository was transferred from erhanrdn/OmniAds to
 * emrahbilaloglu-ui/OmniAds and the GHCR namespace moved with it. CI, the
 * compose file, the remote deploy verifier and the cutover scripts cannot
 * import TypeScript, so each carries its own literal. A find-and-replace makes
 * them agree once; nothing keeps them agreeing. If one copy drifts, the
 * failure is not a compile error — it is a deploy that pulls an image that was
 * never built, or a verifier that passes because it compared the wrong name.
 *
 * WHAT MUST NOT BE "FIXED". Old PR URLs, old commit URLs and incident records
 * name a repository that genuinely had that name at that time. Rewriting them
 * falsifies the record, so the guard below classifies by path and by shape
 * rather than banning the string outright — and it deliberately permits the one
 * legacy image namespace the rollback path still depends on.
 */

function read(path: string) {
  return fs.readFileSync(path, "utf8");
}

describe("release namespace contract", () => {
  it("names the transferred repository as the release authority", () => {
    expect(RELEASE_AUTHORITY_REPOSITORY.owner).toBe("emrahbilaloglu-ui");
    expect(RELEASE_AUTHORITY_REPOSITORY.fullName).toBe("emrahbilaloglu-ui/OmniAds");
    expect(RELEASE_AUTHORITY_WEB_IMAGE).toBe(`${RELEASE_AUTHORITY_IMAGE_NAMESPACE}/omniads-web`);
    expect(RELEASE_AUTHORITY_WORKER_IMAGE).toBe(
      `${RELEASE_AUTHORITY_IMAGE_NAMESPACE}/omniads-worker`,
    );
  });

  it("keeps the pre-transfer namespace available for rollback", () => {
    // Every image built before the transfer — including whatever production is
    // running now and the previous known-good SHA — exists only here. Deleting
    // this constant would turn a rollback into "manifest unknown".
    expect(RELEASE_AUTHORITY_LEGACY_IMAGE_NAMESPACE).toBe("ghcr.io/erhanrdn");
    expect(RELEASE_AUTHORITY_LEGACY_WEB_IMAGE).toBe("ghcr.io/erhanrdn/omniads-web");
    expect(RELEASE_AUTHORITY_LEGACY_WORKER_IMAGE).toBe("ghcr.io/erhanrdn/omniads-worker");
    expect(RELEASE_AUTHORITY_LEGACY_IMAGE_NAMESPACE).not.toBe(
      RELEASE_AUTHORITY_IMAGE_NAMESPACE,
    );
  });

  it("builds, pulls and reads back the same image identity", () => {
    // One name, four files. The whole point of the exact-SHA contract is that
    // the thing CI pushed is the thing the server pulled is the thing the
    // verifier read back; that only holds if these agree.
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain(`WEB_IMAGE: ${RELEASE_AUTHORITY_WEB_IMAGE}`);
    expect(ci).toContain(`WORKER_IMAGE: ${RELEASE_AUTHORITY_WORKER_IMAGE}`);

    const compose = read("docker-compose.yml");
    expect(compose).toContain(RELEASE_AUTHORITY_WEB_IMAGE);
    expect(compose).toContain(RELEASE_AUTHORITY_WORKER_IMAGE);

    const remote = read(".github/scripts/hetzner-remote.sh");
    expect(remote).toContain(RELEASE_AUTHORITY_WEB_IMAGE);
    expect(remote).toContain(RELEASE_AUTHORITY_WORKER_IMAGE);

    const cutover = read("scripts/hetzner-sync-cutover.sh");
    expect(cutover).toContain(RELEASE_AUTHORITY_IMAGE_NAMESPACE);
  });

  it("leaves no active build or deploy path pointing at the old owner", () => {
    // Scoped to the files a machine acts on. Anything under docs/ or
    // _analysis/ is chronology and is checked by the separate historical-
    // evidence case below.
    const activePaths = [
      ".github/workflows/ci.yml",
      ".github/workflows/deploy-hetzner.yml",
      ".github/workflows/post-deploy-verify.yml",
      ".github/scripts/hetzner-remote.sh",
      ".github/scripts/hetzner-ssh.sh",
      "docker-compose.yml",
      "scripts/hetzner-sync-cutover.sh",
      "scripts/cutover-real-postgres-harness.sh",
      "scripts/cutover-wrapper-package.sh",
    ].filter((path) => fs.existsSync(path));

    const offenders: string[] = [];
    for (const path of activePaths) {
      // Explanatory prose is not an active reference. These files SHOULD say
      // why the old namespace still matters — that is the difference between a
      // decision and a leftover — so the guard judges code, not comments.
      // A `#` comment in YAML and shell is the only comment form here.
      let inLegacyBlock = false;
      read(path)
        .split(/\r?\n/)
        .forEach((line, index) => {
          if (/LEGACY|legacy|rollback|pre-transfer|pre_transfer/i.test(line)) {
            // A marker opens a short window in which the old namespace is the
            // deliberate answer — e.g. the `legacy)` arm of a case statement.
            // Scoped to a few lines so it cannot become a per-file amnesty.
            inLegacyBlock = true;
          }
          const code = line.replace(/#.*$/, "");
          if (!/erhanrdn/.test(code)) {
            if (line.trim() === "" || /^\s*(?:;;|esac|fi|\})/.test(line)) inLegacyBlock = false;
            return;
          }
          if (inLegacyBlock) return;
          offenders.push(`${path}:${index + 1} ${line.trim()}`);
        });
    }

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : [
            "An active build/deploy path references the pre-transfer owner.",
            "",
            "GITHUB_TOKEN can only publish to the namespace of the repository's own",
            "owner, so an old-namespace push fails; and an old-namespace pull or",
            "readback compares against an image this pipeline never built.",
            "",
            "If this is a deliberate legacy-rollback reference, say so on the same",
            "line (LEGACY / legacy / rollback / pre-transfer) so the exemption is",
            "visible at the point of use.",
            "",
            ...offenders,
          ].join("\n"),
    ).toEqual([]);
  });

  it("does not reject historical evidence", () => {
    // The guard must never tempt anyone into rewriting the record. These files
    // name the old repository because that is where the work happened.
    const evidence = [
      "docs/meta-sync-hardening/incident-evidence.md",
      "docs/canonical-cleanup-2026-04-30.md",
    ].filter((path) => fs.existsSync(path));
    expect(evidence.length).toBeGreaterThan(0);
    for (const path of evidence) {
      expect(read(path), `${path} should still carry its original evidence`).toMatch(
        /erhanrdn/,
      );
    }
  });
});
