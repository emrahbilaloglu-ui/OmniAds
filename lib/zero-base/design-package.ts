/**
 * Where the accepted design package is, and the digest it is bound to.
 *
 * Kept apart from the extractor deliberately. The extractor resolves paths from
 * `import.meta.url`, which the Playwright transform compiles as an ES module
 * into a CommonJS scope — importing it from a spec fails before any test is
 * collected. A spec that needs to record *which* archive the evidence came from
 * should not have to load the machinery that unpacks it.
 */

/** The archive, and the digest `SOURCE.md` binds it to. */
export const DESIGN_ZIP = "/Users/harmelek/Downloads/Adsecute Zero-Base Design.zip";

export const DESIGN_ZIP_SHA256 =
  "0695ae452469ba3efe2615efe3ffd30fcdb88f5847db53d569042fb864c09b9d";
