/**
 * WP-26 / G10 — the accepted design package as a machine-readable authority.
 *
 * The reference is the checksum-bound ZIP named in `SOURCE.md`. Its **active**
 * `.dc.html` artifacts are the visual authority: each artboard carries
 * `data-screen-label` (e.g. `H03 Client Home`), `data-artboard` (its width), and
 * the anatomy the composition must contain — `data-el` regions, `data-ctl`
 * controls, `data-collection` collections.
 *
 * An earlier version of this work claimed the reference was mechanically
 * unavailable. That was wrong: it generalised a note about the archived v2
 * *check PNGs* ("history, not evidence") into a claim about the whole package.
 * The active HTML is the authority the master plan names, and this module reads
 * it directly.
 *
 * Everything here is bound to hashes. The archive SHA-256 must equal the value
 * recorded in `SOURCE.md`, and every extracted source file's own digest is
 * recorded in the emitted manifest, so reference drift fails rather than
 * silently changing what "correct" means.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DESIGN_ZIP, DESIGN_ZIP_SHA256 } from "@/lib/zero-base/design-package";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export { DESIGN_ZIP, DESIGN_ZIP_SHA256 } from "@/lib/zero-base/design-package";

export const REFERENCE_MANIFEST = path.join(
  "docs",
  "zero-base-design",
  "v3",
  "reference-manifest.json",
);

export interface ReferenceFrame {
  id: string;
  label: string;
  /** Source `.dc.html` file and its SHA-256, so drift is detectable. */
  file: string;
  fileSha256: string;
  /** Artboard width declared on the enclosing artboard. */
  width: number | null;
  els: string[];
  ctls: string[];
  collections: string[];
}

export interface ReferenceContract {
  key: string;
  event: string;
  trigger: string;
  outcome: string;
  focus: string;
  failure: string;
}

export interface ReferenceManifest {
  zipSha256: string;
  generatedFrom: string;
  frames: ReferenceFrame[];
  contracts: ReferenceContract[];
  style: { palette: string[]; typeScale: number[]; minFontPx: number };
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Verify and unpack the archive to a temp directory. */
export function extractPackage(): string {
  if (!existsSync(DESIGN_ZIP)) {
    throw new Error(`Design package not found at ${DESIGN_ZIP}`);
  }
  const actual = sha256File(DESIGN_ZIP);
  if (actual !== DESIGN_ZIP_SHA256) {
    throw new Error(
      `Design package digest mismatch.\n  expected ${DESIGN_ZIP_SHA256}\n  actual   ${actual}\n` +
        "The reference authority changed; the manifest must be regenerated deliberately.",
    );
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "zero-base-design-"));
  execFileSync("unzip", ["-q", DESIGN_ZIP, "-d", dir]);
  return dir;
}

/**
 * Parse every artboard out of the active HTML.
 *
 * Each `data-screen-label` opens a block that runs to the next label; the
 * anatomy inside that block is what the frame requires. Width comes from the
 * nearest preceding `data-artboard`, which is how the package expresses the
 * artboard a section is drawn at.
 */
export function readFrames(dir: string): ReferenceFrame[] {
  const frames = new Map<string, ReferenceFrame>();

  for (const name of readdirSync(dir).filter((f) => f.endsWith(".dc.html")).sort()) {
    const file = path.join(dir, name);
    const source = readFileSync(file, "utf8");
    const digest = sha256File(file);

    const labels = [...source.matchAll(/data-screen-label="([^"]+)"/g)];
    for (let index = 0; index < labels.length; index += 1) {
      const match = labels[index];
      const label = match[1];
      const id = /^([HBPM]\d\d)\b/.exec(label)?.[1];
      if (!id) continue;

      const start = match.index ?? 0;
      const end = index + 1 < labels.length ? labels[index + 1].index ?? source.length : source.length;
      const block = source.slice(start, end);

      // Nearest preceding artboard declaration.
      const before = source.slice(0, start);
      const widthMatch = [...before.matchAll(/data-artboard="(\d+)"/g)].at(-1);

      const existing = frames.get(id);
      const els = new Set(existing?.els ?? []);
      const ctls = new Set(existing?.ctls ?? []);
      const collections = new Set(existing?.collections ?? []);
      for (const [, value] of block.matchAll(/data-el="([^"]*)"/g)) if (value) els.add(value);
      for (const [, value] of block.matchAll(/data-ctl="([^"]*)"/g)) if (value) ctls.add(value);
      for (const [, value] of block.matchAll(/data-collection="([^"]*)"/g)) if (value) collections.add(value);

      frames.set(id, {
        id,
        label,
        file: name,
        fileSha256: digest,
        width: widthMatch ? Number(widthMatch[1]) : existing?.width ?? null,
        els: [...els].sort(),
        ctls: [...ctls].sort(),
        collections: [...collections].sort(),
      });
    }
  }
  return [...frames.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The 142 interaction contracts, verbatim from the package's own manifest. */
export function readContracts(dir: string): ReferenceContract[] {
  const source = readFileSync(path.join(dir, "data", "interactions.js"), "utf8");
  const rows = [...source.matchAll(/\{"k":"(.*?)","ev":"(.*?)","t":"(.*?)","o":"(.*?)","f":"(.*?)","x":"(.*?)"\}/g)];
  return rows.map((row) => ({
    key: row[1],
    event: row[2],
    trigger: row[3],
    outcome: row[4],
    focus: row[5],
    failure: row[6],
  }));
}

/**
 * The reference palette and type scale.
 *
 * The design canvas is a static specification: it writes literal hex values and
 * pixel sizes inline rather than declaring CSS custom properties. So the
 * comparable facts are the **palette** every Hi-Fi artboard actually draws with
 * and the **type scale** it uses — both of which the implementation's Ledger
 * tokens and font sizes must cover.
 */
export function readStyleFacts(dir: string): { palette: string[]; typeScale: number[]; minFontPx: number } {
  const palette = new Set<string>();
  const sizes = new Set<number>();

  for (const name of readdirSync(dir).filter((f) => /^1[0-4] Hi-Fi/.test(f))) {
    const source = readFileSync(path.join(dir, name), "utf8");
    for (const [, hex] of source.matchAll(/#([0-9a-fA-F]{6})\b/g)) palette.add(`#${hex.toLowerCase()}`);
    for (const [, px] of source.matchAll(/font-size:\s*([0-9.]+)px/g)) sizes.add(Number(px));
  }
  const typeScale = [...sizes].sort((a, b) => a - b);
  return {
    palette: [...palette].sort(),
    typeScale,
    // The smallest size the accepted design itself draws product copy at.
    minFontPx: typeScale[0] ?? 0,
  };
}

export function buildReferenceManifest(): ReferenceManifest {
  const dir = extractPackage();
  return {
    zipSha256: DESIGN_ZIP_SHA256,
    generatedFrom: path.basename(DESIGN_ZIP),
    frames: readFrames(dir),
    contracts: readContracts(dir),
    style: readStyleFacts(dir),
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  /**
   * Regenerate from the archive when it is here; otherwise verify the vendored
   * manifest and stop.
   *
   * `docs/zero-base-design/v3/SOURCE.md` states the rule this now follows:
   * *"The application must never import the design package from `Downloads/` or
   * `/tmp`. These files are the exact bytes copied from the hash-verified
   * archive at vendor time."* The manifest beside it was generated from that
   * archive and records the digest it came from — so on a machine without the
   * archive the honest answer is not to fail, and it is certainly not to
   * regenerate a partial manifest from whatever happens to be vendored. It is
   * to check that the vendored manifest is the one the accepted archive
   * produced, and to say which bytes the run is standing on.
   *
   * This refuses in three cases, and each is a real problem rather than a
   * missing laptop:
   *
   *   - the archive is present but its digest does not match — the reference
   *     authority changed and the manifest must be regenerated deliberately;
   *   - the archive is absent and no vendored manifest exists — there is no
   *     reference at all;
   *   - the archive is absent and the vendored manifest names a DIFFERENT
   *     archive — the two authorities disagree, and neither may be assumed.
   */
  const out = path.join(ROOT, REFERENCE_MANIFEST);

  if (existsSync(DESIGN_ZIP)) {
    const manifest = buildReferenceManifest();
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log("zero-base design reference (regenerated from the accepted archive)\n");
    console.log(`  archive        ${manifest.generatedFrom}`);
    console.log(`  sha256         ${manifest.zipSha256}`);
    console.log(`  artboards      ${manifest.frames.length}`);
    console.log(`  contracts      ${manifest.contracts.length}`);
    console.log(`  palette        ${manifest.style.palette.length} colours`);
    console.log(
      `  type scale     ${manifest.style.typeScale.length} sizes, smallest ${manifest.style.minFontPx}px`,
    );
    console.log(`\n  written to ${REFERENCE_MANIFEST}`);
  } else {
    if (!existsSync(out)) {
      throw new Error(
        `No design archive at ${DESIGN_ZIP} and no vendored manifest at ${REFERENCE_MANIFEST}.\n` +
          "There is no reference to check against. Restore one of the two.",
      );
    }
    const vendored = JSON.parse(readFileSync(out, "utf8")) as ReferenceManifest;
    if (vendored.zipSha256 !== DESIGN_ZIP_SHA256) {
      throw new Error(
        "The vendored reference manifest was generated from a different archive.\n" +
          `  manifest names ${vendored.zipSha256}\n` +
          `  this tree binds ${DESIGN_ZIP_SHA256}\n` +
          "Neither may be assumed correct; regenerate from the accepted archive.",
      );
    }

    console.log("zero-base design reference (vendored bytes — archive not on this machine)\n");
    console.log(`  bound to       ${vendored.zipSha256}`);
    console.log(`  generated from ${vendored.generatedFrom}`);
    console.log(`  artboards      ${vendored.frames.length}`);
    console.log(`  contracts      ${vendored.contracts.length}`);
    console.log(`  palette        ${vendored.style.palette.length} colours`);
    console.log(
      `  type scale     ${vendored.style.typeScale.length} sizes, smallest ${vendored.style.minFontPx}px`,
    );
    console.log(`\n  read from ${REFERENCE_MANIFEST} — not regenerated.`);
  }
}
