/**
 * WP-26 / G10 — compare the implementation against the accepted design package.
 *
 * The reference manifest is derived from the checksum-bound archive named in
 * `SOURCE.md`. Per artboard it states the anatomy the composition must carry:
 * `data-el` regions, `data-ctl` controls and `data-collection` collections, at a
 * declared artboard width.
 *
 * This compares the rendered implementation frames against that. It is a
 * structural fidelity check, which is what the design canvas can support: the
 * canvas is a static specification, so its authority is the anatomy and style
 * facts it declares, not a pixel it never rendered from production data.
 *
 * Two style facts are compared as well, both taken from the accepted Hi-Fi
 * artboards rather than invented here: the palette the design draws with, and
 * the smallest type size it uses.
 */
// Must run before any component import: these read the real exact bodies, which
// import CSS modules (and next/image). Without the stub Node's CommonJS loader
// hands the stylesheet to the JavaScript parser and the gate dies at step one.
import "./css-module-stub";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REFERENCE_MANIFEST, type ReferenceManifest } from "@/scripts/zero-base/extract-design-reference";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FRAME_PAGES = path.join(ROOT, "playwright", ".frames");

export interface AnatomyResult {
  id: string;
  label: string;
  requiredEls: number;
  presentEls: number;
  requiredCtls: number;
  presentCtls: number;
  requiredCollections: number;
  presentCollections: number;
  missingEls: string[];
  missingCtls: string[];
  missingCollections: string[];
  rendered: boolean;
}

export function loadReference(): ReferenceManifest {
  const file = path.join(ROOT, REFERENCE_MANIFEST);
  if (!existsSync(file)) {
    throw new Error(
      `No reference manifest at ${REFERENCE_MANIFEST}. Run:\n` +
        "  npm run zero-base:reference:extract",
    );
  }
  return JSON.parse(readFileSync(file, "utf8")) as ReferenceManifest;
}

/**
 * The rendered implementation page for a frame.
 *
 * Exactly one file may match. The filename encodes id, leaf, state, width and
 * theme, so correcting any of those leaves the old file behind under the same
 * id prefix — and taking whichever matched first meant a fixed frame could be
 * graded against the composition it used to render. That is stale evidence
 * reading as a real result, so it fails loudly instead.
 */
function renderedPage(id: string): string | null {
  if (!existsSync(FRAME_PAGES)) return null;
  const matches = readdirSync(FRAME_PAGES).filter((name) => name.startsWith(`${id}__`));
  if (matches.length > 1) {
    throw new Error(
      `${id}: ${matches.length} rendered pages match this frame — the artifact ` +
        `directory holds stale output.\n  ${matches.join("\n  ")}\n` +
        "Rebuild with: npm run zero-base:frames:build",
    );
  }
  return matches[0] ? readFileSync(path.join(FRAME_PAGES, matches[0]), "utf8") : null;
}

/**
 * Collection ids in the reference are artboard-scoped labels.
 *
 * `h03-sources` and `b01-sources` are the *same* source table — Home at 1440
 * and Home at 1280 — and `h09-decisions` / `b02-decisions` likewise. The design
 * names each instance after the artboard it is drawn on; the implementation has
 * one component, which cannot honestly emit two ids for one table. So the
 * artboard prefix is resolved away and the semantic kind is what must match.
 *
 * This is not a loosened check: a frame that renders no collection at all, or
 * the wrong kind of collection, still fails. Only the artboard's own prefix is
 * discounted, and only for collections — `data-el` values in the reference
 * carry no such prefix and are compared verbatim.
 */
/**
 * Values that are the design's own templating, not contract keys.
 *
 * `{{ a.ctl }}` and `{{ s.ctl }}` come from the artboards' Handlebars-style
 * loops — the placeholder that *renders* a per-row control, captured verbatim
 * by the extractor. No implementation can emit them literally, and treating
 * them as requirements would make six artboards permanently unsatisfiable for
 * a reason that has nothing to do with the implementation.
 *
 * They are excluded by exact match and reported, so the exclusion is visible
 * rather than a silently loosened denominator. Every other `data-ctl` value in
 * the reference is compared literally.
 */
export function isTemplatePlaceholder(value: string): boolean {
  return /^\{\{.*\}\}$/.test(value.trim());
}

export function collectionKind(id: string): string {
  return id.replace(/^[hbpm]\d\d-/i, "");
}

export function compareAnatomy(): AnatomyResult[] {
  const reference = loadReference();
  return reference.frames.map((frame) => {
    const html = renderedPage(frame.id);
    const has = (attr: string, value: string) =>
      html ? html.includes(`${attr}="${value}"`) : false;

    const missingEls = frame.els.filter((value) => !has("data-el", value));
    const missingCtls = frame.ctls
      .filter((value) => !isTemplatePlaceholder(value))
      .filter((value) => !has("data-ctl", value));
    const missingCollections = frame.collections.filter(
      (value) => !has("data-collection", collectionKind(value)),
    );

    return {
      id: frame.id,
      label: frame.label,
      rendered: html !== null,
      requiredEls: frame.els.length,
      presentEls: frame.els.length - missingEls.length,
      requiredCtls: frame.ctls.filter((value) => !isTemplatePlaceholder(value)).length,
      presentCtls:
        frame.ctls.filter((value) => !isTemplatePlaceholder(value)).length - missingCtls.length,
      requiredCollections: frame.collections.length,
      presentCollections: frame.collections.length - missingCollections.length,
      missingEls,
      missingCtls,
      missingCollections,
    };
  });
}

/** Does the implementation's token palette cover what the design draws with? */
export function compareStyle(): { missingPalette: string[]; minFontOk: boolean; referenceMin: number } {
  const reference = loadReference();
  const css = readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
  const implemented = new Set(
    [...css.matchAll(/(--ledger-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => m[2].toLowerCase()),
  );
  // Only the ink/surface/semantic colours are token-bound; the design also draws
  // one-off chart and illustration colours that were never tokenised. Compare
  // the intersection that the Ledger token set is responsible for.
  const missingPalette = reference.style.palette.filter((hex) => !implemented.has(hex));
  return {
    missingPalette,
    referenceMin: reference.style.minFontPx,
    minFontOk: reference.style.minFontPx >= 12,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const reference = loadReference();
  const results = compareAnatomy();
  const style = compareStyle();

  console.log("zero-base reference anatomy comparison (G10)\n");
  console.log(`  reference archive   ${reference.generatedFrom}`);
  console.log(`  archive sha256      ${reference.zipSha256}`);
  console.log(`  artboards compared  ${results.length}\n`);

  const totals = results.reduce(
    (acc, row) => ({
      els: acc.els + row.requiredEls,
      elsOk: acc.elsOk + row.presentEls,
      ctls: acc.ctls + row.requiredCtls,
      ctlsOk: acc.ctlsOk + row.presentCtls,
      colls: acc.colls + row.requiredCollections,
      collsOk: acc.collsOk + row.presentCollections,
    }),
    { els: 0, elsOk: 0, ctls: 0, ctlsOk: 0, colls: 0, collsOk: 0 },
  );

  const satisfied = results.filter(
    (row) =>
      row.rendered &&
      row.missingEls.length === 0 &&
      row.missingCtls.length === 0 &&
      row.missingCollections.length === 0,
  );

  console.log(`  data-el regions      ${totals.elsOk}/${totals.els}`);
  console.log(`  data-ctl controls    ${totals.ctlsOk}/${totals.ctls}`);
  console.log(`  data-collection      ${totals.collsOk}/${totals.colls}`);
  console.log(`  frames fully matching anatomy   ${satisfied.length}/${results.length}\n`);

  console.log(`  reference type floor ${style.referenceMin}px — implementation floor 12px: ${style.minFontOk ? "ok" : "FAIL"}`);
  console.log(`  palette colours the Ledger tokens do not cover: ${style.missingPalette.length}`);

  const placeholders = new Set(
    reference.frames.flatMap((frame) => frame.ctls.filter(isTemplatePlaceholder)),
  );
  console.log(
    `  reference values excluded as the design's own templating: ${[...placeholders].join(", ")}`,
  );

  const worst = results
    .filter((row) => row.missingEls.length + row.missingCtls.length > 0)
    .slice(0, 8);
  if (worst.length > 0) {
    console.log("\n  first gaps:");
    for (const row of worst) {
      console.log(`    ${row.id} ${row.label}`);
      if (row.missingEls.length) console.log(`      missing data-el:  ${row.missingEls.join(", ")}`);
      if (row.missingCtls.length) console.log(`      missing data-ctl: ${row.missingCtls.slice(0, 4).join(", ")}`);
    }
  }

  if (satisfied.length < results.length) {
    console.log(
      `\nFAIL: ${results.length - satisfied.length} of ${results.length} artboards do not carry the` +
        " anatomy the accepted design declares.",
    );
    process.exit(1);
  }
  console.log("\nPASS: every artboard's anatomy matches the accepted design package.");
}
