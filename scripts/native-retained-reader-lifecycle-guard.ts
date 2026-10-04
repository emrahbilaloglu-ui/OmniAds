import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { NATIVE_RETAINED_LEDGER_PATH, validateNativeRetainedReaderLedger,
  type NativeRetainedReaderLedger } from "@/lib/creative-decision-engine/native-retained-reader-lifecycle";

/** Local source inspection only. No DB, archive publication, service/flag change,
 * provider write, production census or source-removal permission. */
export function nativeRetainedReaderSources(root = process.cwd()): Map<string, string> {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (["node_modules", ".next", "__tests__"].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (relative(root, path) === "lib/archive") return [];
    if (entry.isSymbolicLink()) throw new Error("Native retained source guard refused: unclassified source symlink");
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && /\.(?:tsx?|mts|cts|mjs|cjs|js|sql|py)$/.test(entry.name) &&
      !/\.(?:test|spec)\./.test(entry.name) ? [path] : [];
  });
  return new Map(["app", "components", "lib", "scripts"].flatMap(dir => walk(join(root, dir)))
    .map(path => [relative(root, path), readFileSync(path, "utf8")]));
}
export function inspectNativeRetainedReaderSources(root = process.cwd()) {
  const ledger = JSON.parse(readFileSync(join(root, NATIVE_RETAINED_LEDGER_PATH), "utf8")) as NativeRetainedReaderLedger;
  return validateNativeRetainedReaderLedger(nativeRetainedReaderSources(root), ledger);
}
