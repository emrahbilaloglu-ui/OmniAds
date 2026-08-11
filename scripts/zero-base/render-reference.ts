/**
 * WP-26 / G10 — render the accepted artboards and record what they look like.
 *
 * The reference is not a description of a design; it is a set of HTML documents
 * that render. So they are rendered, in a real browser, at the width each
 * artboard declares, and measured — ownership, order, visibility, geometry,
 * typography and colour — with the same function used to measure the
 * implementation.
 *
 * That is the difference between this and what came before. The old gate read
 * generated markup as a string and asked whether `data-el="home-kpis"` appeared
 * anywhere in it. This asks where the region sits, what it contains, whether a
 * reader can see it, and what it is painted with.
 *
 * The archive is verified against the SHA-256 in `SOURCE.md` before anything is
 * read, and that digest is recorded in the output, so a changed reference fails
 * rather than quietly redefining what "correct" means.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { EXTRACT_VISUAL_FACTS, type VisualSnapshot } from "@/lib/zero-base/visual-facts";
import { DESIGN_ZIP_SHA256, extractPackage } from "@/scripts/zero-base/extract-design-reference";
import { loadReference } from "@/scripts/zero-base/verify-reference-anatomy";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const REFERENCE_VISUAL = path.join(
  "docs",
  "zero-base-design",
  "v3",
  "reference-visual.json",
);

export interface ReferenceVisual {
  zipSha256: string;
  /** Widths the artboards were measured at, per frame. */
  snapshots: VisualSnapshot[];
}

/**
 * The width to render an artboard at.
 *
 * The package's `data-artboard` is the nearest *preceding* declaration, which
 * is unreliable for a block halfway down a long file. The label itself is
 * authoritative where it states one — "H63 Scope sheet — open (MOBILE-02)" is
 * drawn at 390 and the block says so — and the frame id families give the rest.
 */
export function artboardWidth(id: string, label: string, declared: number | null): number {
  const inLabel = /\b(320|390|768|1280|1440)\b/.exec(label);
  if (inLabel) return Number(inLabel[1]);
  if (declared && [320, 390, 768, 1280, 1440].includes(declared)) return declared;
  return 1440;
}

async function main() {
  const manifest = loadReference();
  const dir = extractPackage();

  const browser = await chromium.launch();
  const snapshots: VisualSnapshot[] = [];

  try {
    for (const frame of manifest.frames) {
      const width = artboardWidth(frame.id, frame.label, frame.width);
      const page = await browser.newPage({ viewport: { width, height: 1600 } });
      await page.goto(`file://${encodeURI(path.join(dir, frame.file))}`);
      // The package's own runtime hydrates the canvas; measuring before it
      // settles would record an unstyled document.
      await page.waitForTimeout(900);

      const selector = `[data-screen-label="${frame.label.replace(/"/g, '\\"')}"]`;
      const measured = (await page.evaluate(
        `(${EXTRACT_VISUAL_FACTS})(${JSON.stringify(selector)})`,
      )) as Omit<VisualSnapshot, "id" | "width" | "theme"> | null;

      await page.close();

      if (!measured) {
        throw new Error(
          `${frame.id}: the artboard "${frame.label}" was not found in ${frame.file}.`,
        );
      }

      snapshots.push({ id: frame.id, width, theme: "light", ...measured });
    }
  } finally {
    await browser.close();
  }

  const out: ReferenceVisual = { zipSha256: DESIGN_ZIP_SHA256, snapshots };
  const file = path.join(ROOT, REFERENCE_VISUAL);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);

  const markers = snapshots.reduce((total, snapshot) => total + snapshot.facts.length, 0);
  const visible = snapshots.reduce(
    (total, snapshot) => total + snapshot.facts.filter((fact) => fact.visible).length,
    0,
  );

  console.log("zero-base reference render (accepted artboards, measured)\n");
  console.log(`  archive sha256   ${DESIGN_ZIP_SHA256}`);
  console.log(`  artboards        ${snapshots.length}`);
  console.log(`  markers measured ${markers} (${visible} visible)`);
  console.log(
    `  widths           ${[...new Set(snapshots.map((s) => s.width))].sort((a, b) => a - b).join(", ")}`,
  );
  console.log(`\n  written to ${REFERENCE_VISUAL}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
