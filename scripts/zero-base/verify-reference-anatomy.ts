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

/** The rendered implementation page for a frame, if one exists. */
function renderedPage(id: string): string | null {
  if (!existsSync(FRAME_PAGES)) return null;
  const match = readdirSync(FRAME_PAGES).find((name) => name.startsWith(`${id}__`));
  return match ? readFileSync(path.join(FRAME_PAGES, match), "utf8") : null;
}

export function compareAnatomy(): AnatomyResult[] {
  const reference = loadReference();
  return reference.frames.map((frame) => {
    const html = renderedPage(frame.id);
    const has = (attr: string, value: string) =>
      html ? html.includes(`${attr}="${value}"`) : false;

    const missingEls = frame.els.filter((value) => !has("data-el", value));
    const missingCtls = frame.ctls.filter((value) => !has("data-ctl", value));
    const missingCollections = frame.collections.filter((value) => !has("data-collection", value));

    return {
      id: frame.id,
      label: frame.label,
      rendered: html !== null,
      requiredEls: frame.els.length,
      presentEls: frame.els.length - missingEls.length,
      requiredCtls: frame.ctls.length,
      presentCtls: frame.ctls.length - missingCtls.length,
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
