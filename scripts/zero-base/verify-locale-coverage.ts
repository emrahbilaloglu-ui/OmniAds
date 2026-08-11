/**
 * WP-26 step 7 — how much zero-base copy actually routes through the catalogue.
 *
 * This exists because "we added i18n" is the kind of claim that survives review
 * while the surfaces still render hardcoded English. It counts, per file, the
 * user-facing string literals that are still inline, and it holds the total to a
 * recorded ceiling so the number can only go down.
 *
 * A ratchet, not a pass/fail on perfection: the ceiling is the measured value at
 * the time of writing. Adding a new hardcoded string fails the gate; converting
 * one lowers the ceiling on the next honest update.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TARGET = path.join(ROOT, "components", "zero-base");

/**
 * The measured ceiling.
 *
 * Lower this when strings are converted. Never raise it: a rise means new
 * hardcoded copy shipped, which is the defect this gate exists to stop.
 */
export const INLINE_STRING_CEILING = 116;

/** Files that legitimately hold no operator-facing copy. */
const EXEMPT = /\.test\.tsx?$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry) && !EXEMPT.test(entry)) out.push(full);
  }
  return out;
}

export interface FileCoverage {
  file: string;
  inline: number;
  usesCatalogue: boolean;
}

/**
 * Count inline operator-facing strings.
 *
 * JSX text nodes beginning with a capital letter, plus the string props that
 * reach the operator. Deliberately conservative: `data-*` markers, class names
 * and ids are not copy and are not counted.
 */
export function measureFile(file: string): FileCoverage {
  const source = readFileSync(file, "utf8");
  const texts = source.match(/>\s*([A-Z][A-Za-z0-9 ,.'"’\-—/%()]{3,})\s*</g) ?? [];
  const props =
    source.match(/(?:label|title|caption|header|hint|reason|placeholder|aria-label)="([^"]{4,})"/g) ?? [];
  return {
    file: path.relative(ROOT, file),
    inline: texts.length + props.length,
    usesCatalogue: source.includes("useCopy") || source.includes("zeroBaseCopy"),
  };
}

export function measureCoverage(): { files: FileCoverage[]; inline: number; wired: number } {
  const files = walk(TARGET).map(measureFile);
  return {
    files,
    inline: files.reduce((total, file) => total + file.inline, 0),
    wired: files.filter((file) => file.usesCatalogue).length,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const { files, inline, wired } = measureCoverage();
  const withCopy = files.filter((file) => file.inline > 0);

  console.log("zero-base locale coverage (WP-26 step 7)\n");
  console.log(`  components wired to the catalogue   ${wired} / ${files.length}`);
  console.log(`  inline operator-facing strings      ${inline} (ceiling ${INLINE_STRING_CEILING})`);
  console.log(`  files still holding inline copy     ${withCopy.length}\n`);

  console.log("  largest remaining:");
  for (const file of [...withCopy].sort((a, b) => b.inline - a.inline).slice(0, 8)) {
    console.log(`    ${String(file.inline).padStart(4)}  ${file.file}`);
  }

  if (inline > INLINE_STRING_CEILING) {
    console.log(
      `\nFAIL: inline copy rose to ${inline}, above the recorded ceiling of ${INLINE_STRING_CEILING}.`,
    );
    console.log("New hardcoded copy must go through lib/zero-base/copy.ts instead.");
    process.exit(1);
  }
  console.log(`\nPASS: inline copy is at or below the recorded ceiling (${inline} ≤ ${INLINE_STRING_CEILING}).`);
  if (inline > 0) {
    console.log(
      "NOTE: this is a ratchet, not completion. Locale parity is not finished while any inline copy remains.",
    );
  }
}
