/**
 * Capture the marketing copy snapshot BEFORE any presentation change.
 *
 * WP-25 changes typography, tokens and layout — never claims. The only way to
 * prove that is to record the exact text each page renders first, then assert
 * equality afterwards. Extracting visible text rather than hashing the file
 * means a pure presentation edit is allowed to change the source while the copy
 * must not move a byte.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * The WP-25 marketing surfaces: one list, carrying both the file the copy is
 * read from and the URL it is served at.
 *
 * The URL is here rather than derived from the path because route groups make
 * that derivation wrong — `app/(marketing)/product/page.tsx` is served at
 * `/product`, not `/(marketing)/product`. Anything that needs to *visit* these
 * pages reads this list, so a new marketing surface cannot be added to the copy
 * snapshot while quietly staying out of the smoke that proves it renders.
 */
export const MARKETING_PAGES = [
  { id: "root", file: "app/page.tsx", url: "/" },
  { id: "about", file: "app/about/page.tsx", url: "/about" },
  { id: "product", file: "app/(marketing)/product/page.tsx", url: "/product" },
  { id: "pricing", file: "app/(marketing)/pricing/page.tsx", url: "/pricing" },
  { id: "contact", file: "app/contact/page.tsx", url: "/contact" },
  { id: "privacy", file: "app/privacy/page.tsx", url: "/privacy" },
  { id: "terms", file: "app/terms/page.tsx", url: "/terms" },
  { id: "security", file: "app/security/page.tsx", url: "/security" },
  { id: "ai-transparency", file: "app/ai-transparency/page.tsx", url: "/ai-transparency" },
  { id: "demo", file: "app/(marketing)/demo/page.tsx", url: "/demo" },
] as const;

/**
 * Every string literal and JSX text node in the file, in order.
 *
 * Class names and style values are excluded: those are exactly what WP-25 is
 * allowed to change. What remains is the copy.
 */
export function extractCopy(source: string): string[] {
  const out: string[] = [];

  // JSX text between tags.
  for (const match of source.matchAll(/>([^<>{}]+)</g)) {
    const text = match[1].replace(/\s+/g, " ").trim();
    if (text && /[A-Za-zÀ-ÿĞğİıŞşÇçÖöÜü]/.test(text)) out.push(text);
  }

  // String literals that are prose rather than identifiers or class lists.
  for (const match of source.matchAll(/"([^"\\\n]{12,})"|'([^'\\\n]{12,})'/g)) {
    const text = (match[1] ?? match[2]).replace(/\s+/g, " ").trim();
    if (!/[A-Za-zÀ-ÿĞğİıŞşÇçÖöÜü]/.test(text)) continue;
    // Skip class strings, imports, urls and token names.
    if (/^[a-z0-9:_\- ]+$/.test(text) && /\b(flex|grid|text-|bg-|border|px-|py-|mt-|mb-|rounded|font-)\b/.test(text)) continue;
    if (/^(@\/|\.\/|\.\.\/|https?:|\/[a-z-]*$)/.test(text)) continue;
    if (/^var\(--/.test(text)) continue;
    out.push(text);
  }

  return out;
}

export function copyFor(repoRoot: string, file: string): string[] {
  const full = path.join(repoRoot, file);
  if (!existsSync(full)) return [];
  return extractCopy(readFileSync(full, "utf8"));
}

function main() {
  const root = process.cwd();
  const snapshot: Record<string, string[]> = {};
  for (const page of MARKETING_PAGES) {
    snapshot[page.id] = copyFor(root, page.file);
  }
  const target = path.join(root, "docs", "zero-base-design", "v3", "marketing-copy-snapshot.json");
  writeFileSync(target, JSON.stringify(snapshot, null, 2) + "\n");
  const total = Object.values(snapshot).reduce((sum, list) => sum + list.length, 0);
  console.log(`[marketing-snapshot] captured ${total} copy fragments across ${MARKETING_PAGES.length} pages -> ${target}`);
}

if (process.argv[1]?.includes("capture-marketing-snapshots")) main();
