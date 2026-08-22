import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DASHBOARD_V2_REFERENCE_FILE = "Adsecute Dashboard v2.dc.html";
/**
 * The current visual source authority.
 *
 * Ratified in `docs/meta-market-ready/WP0_BASELINE.md` §3 against the plan at
 * `docs/meta-market-ready-master-plan-2026-08-22.md` §3. The previous digest
 * `d65c0117871aa392fb2f93e79d02540f6538be6a00b1d2ecea03bdd9f8432193` is
 * superseded: it remains correct inside dated findings such as
 * `docs/dashboard-v2-parity-defects.md`, which measured the bytes of that
 * revision, but it is no longer authority and must not be restored here.
 *
 * Only this digest moved. Re-hashing the whole pinned set below at ratification
 * time showed `support.js`, the mark and all nine platform logos unchanged, so
 * this is the complete correction rather than the first of several.
 */
export const DASHBOARD_V2_REFERENCE_SHA256 =
  "2af6cbaf5f366a7dee8fc0ae96fdf713eff777c62f16e2d57638368d1678637a";

export const DASHBOARD_V2_REFERENCE_DIR =
  process.env.DASHBOARD_V2_REFERENCE_DIR ??
  "/Users/harmelek/Downloads/Dashboard tasarımı yenileme";

/**
 * Runtime files painted by the canonical HTML. Supporting notes and uploaded
 * screenshots are intentionally not part of this contract: the rendered HTML
 * wins when those sources disagree.
 */
export const DASHBOARD_V2_REFERENCE_FILES = {
  [DASHBOARD_V2_REFERENCE_FILE]: DASHBOARD_V2_REFERENCE_SHA256,
  "support.js":
    "8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe",
  "assets/adsecute-mark.svg":
    "ad739bcc3d76b4b35e19796cac9cb52dbc08b6c523b673cafa7b46fc17acfb8b",
  "assets/platform-logos/GA4.svg":
    "38556c93ed3e129ceb5e1463128de8799f851e158b6b57fe89cfdfe03da60af3",
  "assets/platform-logos/Klaviyo.svg":
    "4b1234cfdd95ce61ccff646acd45c2721a988cc7f566fa5866d1795b5ad5a3b2",
  "assets/platform-logos/Meta.png":
    "0f5615f5adb944c79b8ac8baca1be38f5802329a2997776ed3ce98df712800cc",
  "assets/platform-logos/Pinterest.svg":
    "47c3b0c3d49753c5f2bee98ffa824e44d1f7b39372704a432fa17dfadb125b2f",
  "assets/platform-logos/googleAds.svg":
    "da7ffce5a4bb200ff610a9adbc8b62614245662238a5b6da28c45f4ac1ec7812",
  "assets/platform-logos/searchconsole.svg":
    "2674c7911f631916e25630a834f3dccf3edc1b585f0d841037bc9ee19acf3c72",
  "assets/platform-logos/shopify_glyph.svg":
    "1e5011c063b5225e441ad74d62a0ff03df530964b5e655129d7a015978afeb2a",
  "assets/platform-logos/snapchat.svg":
    "6a7f48b6436c933d7647ca5c3c1e7a966be1256a592dd6c57f29cb8ee56a29d9",
  "assets/platform-logos/tiktok.svg":
    "3e00fe11b83b3eaa77d03c45f8a3b3dcdb9dc78a3e3f89ff5c3842dd26f263da",
} as const;

/**
 * Network responses used by Chromium to paint the three canonical families.
 * They are pinned because a font change can move every glyph while leaving the
 * CSS untouched. The strict runner verifies these bytes before capturing any
 * application frame, then requires the app to load the same WOFF2 digests.
 */
export const DASHBOARD_V2_REFERENCE_FONT_RESPONSES = [
  {
    kind: "stylesheet",
    url: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap",
    sha256: "6e661b8412c902c345539b7e4e63ea4dc422fb95e7805aeb81279bbe4eab079a",
  },
  {
    kind: "font",
    family: "Instrument Sans",
    url: "https://fonts.gstatic.com/s/instrumentsans/v4/pxiTypc9vsFDm051Uf6KVwgkfoSxQ0GsQv8ToedPibnr0SZe1ZuWi3g.woff2",
    sha256: "6219bc4bfdfc5d9b2201dcdf046218b122a758f932e25ed5f168f929b7ca2311",
  },
  {
    kind: "font",
    family: "IBM Plex Mono 400",
    url: "https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q131nj-o.woff2",
    sha256: "c36f509c0a8f9f85f29cb44bc8701d8a9e0b14c499e77a884f789ead7093a7ac",
  },
  {
    kind: "font",
    family: "Space Grotesk",
    url: "https://fonts.gstatic.com/s/spacegrotesk/v22/V8mDoQDjQSkFtoMM3T6r8E7mPbF4C_k3HqU.woff2",
    sha256: "a0d054c4af557de20afd6ca59f47ab353bcaec49c63ff04b6c9d39d0f8910557",
  },
  {
    kind: "font",
    family: "IBM Plex Mono 500",
    url: "https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwlBFgsAXHNk.woff2",
    sha256: "a76f53ca6612e7b3828eec2311098675b7f9849ae4169a8bcef6302aec02a6c0",
  },
] as const;

export interface ReferenceFileVerification {
  relativePath: string;
  absolutePath: string;
  expectedSha256: string;
  actualSha256: string | null;
  pass: boolean;
}

export function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function referenceFileUrl(
  referenceDir = DASHBOARD_V2_REFERENCE_DIR,
): string {
  const absolute = path.resolve(referenceDir, DASHBOARD_V2_REFERENCE_FILE);
  return `file://${encodeURI(absolute)}`;
}

export function verifyReferenceFiles(
  referenceDir = DASHBOARD_V2_REFERENCE_DIR,
): ReferenceFileVerification[] {
  return Object.entries(DASHBOARD_V2_REFERENCE_FILES).map(
    ([relativePath, expectedSha256]) => {
      const absolutePath = path.resolve(referenceDir, relativePath);
      const actualSha256 = existsSync(absolutePath)
        ? sha256(readFileSync(absolutePath))
        : null;

      return {
        relativePath,
        absolutePath,
        expectedSha256,
        actualSha256,
        pass: actualSha256 === expectedSha256,
      };
    },
  );
}

export function assertReferenceFiles(
  referenceDir = DASHBOARD_V2_REFERENCE_DIR,
): ReferenceFileVerification[] {
  const results = verifyReferenceFiles(referenceDir);
  const failures = results.filter((result) => !result.pass);
  if (failures.length > 0) {
    const details = failures
      .map(
        (failure) =>
          `${failure.relativePath}: expected ${failure.expectedSha256}, got ${failure.actualSha256 ?? "missing"}`,
      )
      .join("\n");
    throw new Error(
      `Dashboard v2 canonical reference verification failed:\n${details}`,
    );
  }
  return results;
}
