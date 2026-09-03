#!/usr/bin/env node
/**
 * PRE-DEPLOY AUDIT — the whole-program typecheck, split so it fits in memory.
 *
 * WHY. `npx tsc --noEmit` over this repo builds one program of ~4,500 files
 * and dies at 1.8 GiB: "Ineffective mark-compacts near heap limit", ~12s in,
 * peak RSS 1.92 GiB. Raising the heap is not available here, so the gate has
 * to be split — and a split that CHECKS LESS is worse than no gate at all,
 * because it reports green over files nobody looked at.
 *
 * WHY THIS SPLIT IS SOUND. TypeScript reports diagnostics for every file in
 * the program it built, not only for the files named in `include`; imports are
 * pulled in transitively. So if every root file of the full program is a root
 * of EXACTLY ONE shard, and every shard extends the same base config, then:
 *
 *   - every file is type-checked in at least one program (as a root), and
 *   - files reached by imports are checked again in other shards, which can
 *     only ADD diagnostics, never hide one.
 *
 * The union of shard results is therefore a superset of the single-program
 * result. Two differences are stated rather than glossed:
 *
 *   1. Duplicates. A file imported by several shards is reported in each. The
 *      runner de-duplicates by `file(line,col): code` before it counts.
 *   2. The `next` tsconfig plugin is editor-only and never runs under `tsc`,
 *      so splitting cannot change it. `.next/**` route types and
 *      `next-env.d.ts` are given to shard 1 as roots and reached by import
 *      elsewhere, exactly as in the single program.
 *
 * The shard roots come from `tsc --listFilesOnly` on the REAL config, so the
 * partition is derived from the program TypeScript actually builds rather than
 * from a glob written by hand — a glob is where "we forgot a directory" hides.
 *
 * Usage: npm run typecheck:split [-- --shards N]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HEAP_MB = 1800;
const ROOT = process.cwd();

/** The extensions `tsc --listFilesOnly` can legitimately emit for this repo. */
const DISCOVERY_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".json"];

/**
 * The shape of a `spawnSync` result, narrowed to what discovery must judge.
 * Declared so the validator can be driven by tests without spawning anything.
 */
export interface DiscoverySpawnResult {
  status: number | null;
  signal: string | null;
  error?: Error;
  stdout: string | null;
  stderr: string | null;
}

export class DiscoveryRefused extends Error {
  constructor(reason: string) {
    super(`typecheck split refused: discovery ${reason}`);
    this.name = "DiscoveryRefused";
  }
}

/**
 * PRE-DEPLOY AUDIT — discovery FAILS CLOSED, and never parses its way past a
 * failure.
 *
 * The first version of this function read `result.stdout` and checked only
 * that the parsed list was non-empty. Every other way discovery can fail was
 * accepted silently, and each one produces the same catastrophic outcome: a
 * SHORTER file list. A shorter list still partitions, still shards, still
 * runs, and still reports "0 diagnostics" — over files nobody type-checked.
 * A gate that reports green over unexamined files is worse than no gate,
 * because it is believed.
 *
 * The failure modes, all of which are now refusals:
 *
 *  - `error` set: the process could not be spawned, or `maxBuffer` was
 *    exceeded (ENOBUFS), which TRUNCATES stdout mid-stream and yields a
 *    perfectly parseable prefix of the real list;
 *  - `signal` set: killed — SIGKILL from the OOM killer is the realistic one,
 *    and it also leaves a valid-looking prefix;
 *  - non-zero `status`: tsc failed, and `tsc` prints files to stdout BEFORE it
 *    reports a config error, so "non-zero with stdout" is the normal shape of
 *    this failure rather than an exotic one;
 *  - stdout absent or not a string;
 *  - stdout not newline-terminated: the direct signature of truncation, since
 *    a complete listing always ends its last path with a newline;
 *  - any line that is not a plausible path with a known extension: garbage,
 *    interleaved diagnostics, or a half-written line;
 *  - an empty list after filtering.
 *
 * `status === 0` alone is not accepted either: it is checked TOGETHER with the
 * absence of `error` and `signal`, because a truncating ENOBUFS can accompany
 * a zero exit.
 */
export function parseDiscoveryOutput(result: DiscoverySpawnResult): string[] {
  if (result.error) {
    throw new DiscoveryRefused(`could not run to completion: ${result.error.message}`);
  }
  if (result.signal) {
    throw new DiscoveryRefused(
      `was killed by signal ${result.signal} — its output is a truncated prefix, not a file list`,
    );
  }
  if (result.status !== 0) {
    const tail = (result.stderr ?? "").slice(-400).trim();
    throw new DiscoveryRefused(
      `exited ${String(result.status)}${tail ? `: ${tail}` : ""}`
      + " — stdout is NOT parsed after a failed discovery",
    );
  }
  if (typeof result.stdout !== "string") {
    throw new DiscoveryRefused("produced no stdout to read");
  }
  if (result.stdout.length === 0) {
    throw new DiscoveryRefused("produced empty output");
  }
  if (!result.stdout.endsWith("\n")) {
    throw new DiscoveryRefused(
      "output is not newline-terminated, which is what a truncated listing looks like",
    );
  }

  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  const malformed = lines.filter(
    (line) =>
      line !== line.trim()
      || /[\u0000-\u001f]/.test(line)
      || !DISCOVERY_EXTENSIONS.some((extension) => line.endsWith(extension)),
  );
  if (malformed.length > 0) {
    throw new DiscoveryRefused(
      `emitted ${malformed.length} line(s) that are not file paths, first: ${JSON.stringify(malformed[0])}`,
    );
  }

  const files = lines
    .map((file) => (file.startsWith(ROOT) ? path.relative(ROOT, file) : file))
    .filter((file) => !file.startsWith("/") && !file.includes("node_modules/"));
  if (files.length === 0) {
    throw new DiscoveryRefused("listed no in-repo program files");
  }
  return [...new Set(files)].sort();
}

function listProgramFiles(): string[] {
  /*
    `--listFilesOnly` prints the file list and exits before checking, so it
    costs a fraction of the full run and does not OOM. Everything that decides
    whether the answer is trustworthy lives in `parseDiscoveryOutput`.
  */
  const result = spawnSync(
    "npx",
    ["tsc", "--noEmit", "--listFilesOnly"],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${HEAP_MB}` },
    },
  );
  return parseDiscoveryOutput({
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

interface ShardResult {
  shard: number;
  roots: number;
  status: number | null;
  diagnostics: string[];
  peakRssMb: number | null;
}

function runShard(index: number, roots: string[], dir: string): ShardResult {
  const configPath = path.join(dir, `tsconfig.shard-${index}.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        extends: path.relative(dir, path.join(ROOT, "tsconfig.json")),
        compilerOptions: {
          // Each shard is its own program; a shared .tsbuildinfo would let one
          // shard skip work another shard's roots need.
          incremental: false,
          noEmit: true,
        },
        include: roots.map((file) => path.relative(dir, path.join(ROOT, file))),
      },
      null,
      2,
    ),
    "utf8",
  );
  const result = spawnSync(
    "npx",
    ["tsc", "--noEmit", "-p", configPath],
    {
      encoding: "utf8",
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${HEAP_MB}` },
    },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (/JavaScript heap out of memory/.test(output)) {
    throw new Error(
      `typecheck split refused: shard ${index} ran out of memory at ${HEAP_MB} MB — raise --shards`,
    );
  }
  const diagnostics = output
    .split("\n")
    .filter((line) => /^\S.*\(\d+,\d+\): error TS\d+/.test(line))
    .map((line) => line.trim());
  return { shard: index, roots: roots.length, status: result.status, diagnostics, peakRssMb: null };
}

function main(): void {
  const shardArgIndex = process.argv.indexOf("--shards");
  const shardCount = shardArgIndex > -1 ? Number(process.argv[shardArgIndex + 1]) : 4;
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("--shards must be a positive integer");
  }

  const files = listProgramFiles();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-typecheck-split-"));
  /*
    CONTIGUOUS chunks of the sorted list, not round-robin.

    Round-robin was tried first and every shard still OOM'd, for a reason that
    is obvious afterwards: roots drawn evenly from the whole tree pull in
    nearly the whole import graph, so each shard rebuilds almost the full
    program and saves nothing. Contiguous chunks keep a shard's roots in the
    same directories, so they share their imports and the closure each shard
    materialises is genuinely smaller.

    Partition-ness is what makes the split sound, and it is preserved either
    way — the assertion below proves it.
  */
  /*
    AMBIENT FILES GO IN EVERY SHARD.

    A `.d.ts` (and `vitest-globals.d.ts`, which pulls in the matcher
    augmentations) contributes GLOBAL declarations: in the single program they
    apply to every file, so a shard that omits them is checking a different
    language. The first split attempt did omit them and produced 200+
    diagnostics that exist nowhere in the real program — "Cannot find module
    './X.module.css'" (declared by next-env.d.ts) and "Property
    'toBeInTheDocument' does not exist" (declared by the vitest globals). Those
    were artefacts of the split, and a gate that invents errors is as useless
    as one that hides them.

    They are checked in every shard and de-duplicated afterwards, which
    reproduces the single program's environment exactly.
  */
  const isAmbient = (file: string): boolean => {
    if (file.endsWith(".d.ts")) return true;
    let source = "";
    try {
      source = fs.readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      return false;
    }
    // A global augmentation, wherever it is declared.
    if (/\bdeclare\s+(global|module)\b/.test(source)) return true;
    /*
      A file whose ENTIRE content is side-effect imports exists to pull
      augmentations into the program — `vitest.setup.dom.ts` is exactly this
      (`import "@testing-library/jest-dom/vitest";`), and it is what declares
      `toBeInTheDocument`. Detected by shape rather than by name so a second
      one is covered the day it is added.
    */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .trim();
    if (!code) return false;
    const statements = code.split(";").map((part) => part.trim()).filter(Boolean);
    return statements.every((statement) => /^import\s+["']/.test(statement));
  };
  const ambient = files.filter(isAmbient);
  const partitioned = files.filter((file) => !ambient.includes(file));

  const shards: string[][] = [];
  const size = Math.ceil(partitioned.length / shardCount);
  for (let index = 0; index < shardCount; index += 1) {
    shards.push([...ambient, ...partitioned.slice(index * size, (index + 1) * size)]);
  }

  // Partition-ness of the NON-ambient files is what makes the union complete.
  const assigned = new Set(shards.flat());
  if (assigned.size !== files.length) {
    throw new Error(
      `typecheck split refused: ${assigned.size} distinct roots across shards, program has ${files.length}`,
    );
  }
  const nonAmbientAssigned = shards.reduce(
    (total, shard) => total + shard.length - ambient.length,
    0,
  );
  if (nonAmbientAssigned !== partitioned.length) {
    throw new Error(
      `typecheck split refused: partitioned ${nonAmbientAssigned} of ${partitioned.length} non-ambient files`,
    );
  }

  const results: ShardResult[] = [];
  try {
    for (let index = 0; index < shardCount; index += 1) {
      // Sequential by construction: one tsc at a time, one heap at a time.
      const result = runShard(index + 1, shards[index]!, dir);
      results.push(result);
      console.log(
        `[typecheck-split] shard ${result.shard}/${shardCount}: ${result.roots} roots, `
        + `exit ${result.status}, ${result.diagnostics.length} diagnostics`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const unique = [...new Set(results.flatMap((result) => result.diagnostics))].sort();
  console.log(
    `[typecheck-split] ${files.length} program files across ${shardCount} shards; `
    + `${unique.length} unique diagnostics`,
  );
  for (const diagnostic of unique.slice(0, 200)) console.log(diagnostic);
  process.exit(unique.length === 0 && results.every((r) => r.status === 0) ? 0 : 1);
}

/*
  PRE-DEPLOY AUDIT: run only when invoked as the script, so
  `parseDiscoveryOutput` can be imported and driven by tests without launching
  a full eight-shard typecheck as an import side effect.
*/
if (process.argv[1] && process.argv[1].endsWith("typecheck-split.ts")) {
  main();
}
