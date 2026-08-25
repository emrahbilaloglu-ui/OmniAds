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
 * Literals that are allowed to stay inline, each with the reason it is not copy.
 *
 * This replaces the earlier ceiling. A ceiling accepts an arbitrary amount of
 * untranslated copy as long as the number does not grow, which is not the same
 * as finishing the work. The gate now requires **zero unexplained inline
 * operator copy**: anything not on this list fails.
 *
 * Every entry here is a provider or metric identifier from
 * NON_TRANSLATABLE_TERMS, which must render byte-identical in both languages —
 * translating them would break the join between what this product says and what
 * the provider's own UI says.
 */
export const REVIEWED_EXEMPTIONS: Record<string, string> = {
  Meta: "Provider identifier in NON_TRANSLATABLE_TERMS; Meta's own UI says Meta.",
  "Google Ads": "Provider identifier in NON_TRANSLATABLE_TERMS.",
  "GA4 and Shopify": "Two provider identifiers joined by a conjunction; both are reserved terms.",
  CPA: "Metric identifier in NON_TRANSLATABLE_TERMS.",
  ROAS: "Metric identifier in NON_TRANSLATABLE_TERMS; an operator types it into a spreadsheet unchanged.",
  Adsecute:
    "The product's own name. A brand is not copy — translating it would make the page name a different product.",
};

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
  /** The literals themselves, so an exemption can be judged rather than counted. */
  strings: string[];
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
  // The negative lookbehind keeps type annotations out: in `=> Promise<T>` the
  // `>` belongs to an arrow, not to a JSX tag, and `Promise` is a type name.
  const texts = source.match(/(?<![=>|])>\s*([A-Z][A-Za-z0-9 ,.'"’\-—/%()]{3,})\s*</g) ?? [];
  /*
   * `data-*` markers are not copy, and this is what excludes them.
   *
   * The rule was already stated above and the pattern did not implement it:
   * `data-screen-label="Meta · Account Intelligence"` matched, because the
   * alternation found `label` in the middle of the attribute name. The
   * lookbehind anchors the match to the START of an attribute, so `aria-label`
   * still counts and `data-screen-label`, `data-el` and their kind do not.
   */
  const props =
    source.match(
      /(?<![-\w])(?:aria-)?(?:label|title|caption|header|hint|reason|placeholder)="([^"]{4,})"/g,
    ) ?? [];
  const strings = [
    ...texts.map((match) => match.replace(/^[^>]*>\s*/, "").replace(/\s*<.*$/, "").trim()),
    ...props.map((match) => match.replace(/^[^"]*"/, "").replace(/"$/, "").trim()),
  ].filter(Boolean);

  return {
    file: path.relative(ROOT, file),
    inline: strings.length,
    strings: [...new Set(strings)],
    usesCatalogue: source.includes("useCopy") || source.includes("zeroBaseCopy"),
  };
}

export function measureCoverage(): {
  files: FileCoverage[];
  inline: number;
  unexplained: { file: string; text: string }[];
  wired: number;
} {
  const files = walk(TARGET).map(measureFile);
  const unexplained: { file: string; text: string }[] = [];
  for (const file of files) {
    for (const text of file.strings) {
      if (!(text in REVIEWED_EXEMPTIONS)) unexplained.push({ file: file.file, text });
    }
  }
  return {
    files,
    inline: files.reduce((total, file) => total + file.inline, 0),
    unexplained,
    wired: files.filter((file) => file.usesCatalogue).length,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const { files, inline, unexplained, wired } = measureCoverage();

  console.log("zero-base locale coverage (WP-26 step 7)\n");
  console.log(`  components wired to the catalogue   ${wired} / ${files.length}`);
  console.log(`  inline literals found               ${inline}`);
  console.log(`  reviewed exemptions                 ${Object.keys(REVIEWED_EXEMPTIONS).length}`);
  console.log(`  unexplained operator copy           ${unexplained.length}\n`);

  for (const [term, why] of Object.entries(REVIEWED_EXEMPTIONS)) {
    console.log(`    "${term}" — ${why}`);
  }

  if (unexplained.length > 0) {
    console.log("\n  unexplained inline copy:");
    for (const entry of unexplained) {
      console.log(`    ${entry.file}: "${entry.text}"`);
    }
    console.log(
      "\nFAIL: every operator-facing string must route through lib/zero-base/copy.ts,\n" +
        "or be listed in REVIEWED_EXEMPTIONS with the reason it is not copy.",
    );
    process.exit(1);
  }
  console.log("\nPASS: zero unexplained inline operator copy.");
}
