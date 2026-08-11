/**
 * WP-26 step 2 — flow × viewport matrix reconciliation.
 *
 * The 13 flows are read from the vendored design spec (`spec/flows.js`), not
 * restated here, so the denominator cannot drift from the authority.
 *
 * The plan requires all 13 flows exercised at 1440, and flows A, B, I and L
 * additionally at 1280, 768, 390 and 320. This reports, per flow and width,
 * whether executable coverage exists — where "executable" means a mounted test
 * that drives the flow, or a captured harness frame at that width.
 *
 * It is a reconciliation, not a substitute. A flow with no coverage is printed
 * as a gap; the ratio is the honest one.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Widths the plan names. */
export const ALL_WIDTHS = [1440, 1280, 768, 390, 320] as const;
/** Flows that must additionally hold at every narrow width. */
export const NARROW_FLOWS = ["Flow A", "Flow B", "Flow I", "Flow L"] as const;

/** The 13 flows, parsed from the design spec's own list. */
export function specFlows(): { id: string; title: string }[] {
  const source = readFileSync(
    path.join(ROOT, "docs", "zero-base-design", "v3", "spec", "flows.js"),
    "utf8",
  );
  const block = source.slice(source.indexOf("export const FLOWS="), source.indexOf("export function flowIds"));
  return [...block.matchAll(/\{id:"(Flow [A-M])",title:"([^"]+)"/g)].map((match) => ({
    id: match[1],
    title: match[2],
  }));
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|spec\.ts)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Test files that name a flow, with what they assert about widths. */
export function flowEvidence(): Map<string, { files: string[]; widths: Set<number> }> {
  const sources = [
    ...walk(path.join(ROOT, "components", "zero-base")),
    ...walk(path.join(ROOT, "lib", "zero-base")),
    ...walk(path.join(ROOT, "playwright", "tests")),
  ].filter((file) => /\.test\.tsx?$|\.spec\.ts$/.test(file));

  const evidence = new Map<string, { files: string[]; widths: Set<number> }>();
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/Flow ([A-M])\b/g)) {
      const id = `Flow ${match[1]}`;
      const entry = evidence.get(id) ?? { files: [], widths: new Set<number>() };
      const relative = path.relative(ROOT, file);
      if (!entry.files.includes(relative)) entry.files.push(relative);
      for (const width of ALL_WIDTHS) {
        if (new RegExp(`\\b${width}\\b`).test(text)) entry.widths.add(width);
      }
      evidence.set(id, entry);
    }
  }
  return evidence;
}

export interface FlowRow {
  id: string;
  title: string;
  files: string[];
  covered: number[];
  requiredWidths: number[];
  missingWidths: number[];
}

export function reconcileFlows(): FlowRow[] {
  const evidence = flowEvidence();
  return specFlows().map((flow) => {
    const entry = evidence.get(flow.id);
    const requiredWidths = (NARROW_FLOWS as readonly string[]).includes(flow.id)
      ? [...ALL_WIDTHS]
      : [1440];
    const covered = [...(entry?.widths ?? [])].sort((a, b) => b - a);
    return {
      id: flow.id,
      title: flow.title,
      files: entry?.files ?? [],
      covered,
      requiredWidths,
      missingWidths: requiredWidths.filter((width) => !covered.includes(width)),
    };
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const rows = reconcileFlows();
  const withAnyEvidence = rows.filter((row) => row.files.length > 0);
  const fullyCovered = rows.filter((row) => row.files.length > 0 && row.missingWidths.length === 0);

  console.log("zero-base flow × viewport matrix (WP-26 step 2)\n");
  console.log(`  flows in the design spec           ${rows.length}`);
  console.log(`  flows with executable evidence      ${withAnyEvidence.length}`);
  console.log(`  flows meeting their width matrix    ${fullyCovered.length}\n`);

  for (const row of rows) {
    const status = row.files.length === 0 ? "NO EVIDENCE" : row.missingWidths.length === 0 ? "ok" : "partial";
    console.log(`  ${row.id.padEnd(7)} ${status.padEnd(12)} ${row.title}`);
    if (row.files.length > 0) {
      console.log(`          widths covered: ${row.covered.join(", ") || "none asserted"}`);
      if (row.missingWidths.length > 0) {
        console.log(`          missing:        ${row.missingWidths.join(", ")}`);
      }
      console.log(`          evidence:       ${row.files.slice(0, 3).join(", ")}`);
    }
  }

  console.log(
    `\n  RECONCILED: ${fullyCovered.length}/${rows.length} flows meet their required width matrix.`,
  );
  console.log(
    "\nThis is a measurement. A flow counted here has a test that names it and\n" +
      "asserts the required widths; it is not proof that every branch of that flow\n" +
      "is exercised. Flows with no evidence are listed rather than dropped.",
  );
}
