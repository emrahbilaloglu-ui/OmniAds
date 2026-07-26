import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const runnerPath = resolve(
  process.cwd(),
  "deploy/db/adsecute-table-fingerprint-runner.sh",
);
const reducerPath = resolve(
  process.cwd(),
  "deploy/db/adsecute-table-fingerprint-reduce.py",
);
const pythonPath = "/usr/bin/python3";
const sqlPath = resolve(
  process.cwd(),
  "deploy/db/adsecute-table-fingerprint-chunk.sql",
);
const runner = readFileSync(runnerPath, "utf8");
const sql = readFileSync(sqlPath, "utf8");
const temporaryDirectories: string[] = [];

const PART_HEADER = [
  "start_block",
  "end_block",
  "bucket",
  "row_count",
  "xor_a",
  "sum_a",
  "xor_b",
  "sum_b",
  "xor_c",
  "sum_c",
  "xor_d",
  "sum_d",
].join(",");

function makeTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "adsecute-fingerprint-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writePart(
  directory: string,
  start: number,
  end: number,
  second: boolean,
) {
  const rows = [PART_HEADER];
  for (let bucket = 0; bucket < 256; bucket += 1) {
    rows.push(
      [
        start,
        end,
        bucket,
        second ? 2 : 1,
        second ? 1 : -1,
        second ? 20 : 10,
        second ? 3 : 2,
        second ? 30 : 20,
        second ? 5 : -2,
        second ? 10 : -10,
        second ? "9223372036854775807" : 0,
        0,
      ].join(","),
    );
  }
  const path = join(directory, `part-${start}-${end}.csv`);
  writeFileSync(path, `${rows.join("\n")}\n`, "utf8");
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("bounded table fingerprint tooling", () => {
  it("keeps the SQL on a locked CTID range with a zero temp-file budget", () => {
    expect(sql).toContain(
      'LOCK TABLE public.:"fingerprint_table" IN SHARE MODE NOWAIT',
    );
    expect(sql).toContain("SET LOCAL temp_file_limit = 0");
    expect(sql).toContain(
      "WHERE ctid >= format('(%s,0)', :start_block::bigint)::tid",
    );
    expect(sql).toContain(
      "AND ctid < format('(%s,0)', :end_block::bigint)::tid",
    );
    expect(sql).toContain("FROM generate_series(0, 255)");
    expect(sql).toContain(
      "EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, TIMING OFF, SUMMARY ON)",
    );
    expect(sql).not.toContain("statement_timeout = '4h'");
    expect(sql).not.toContain("temp_file_limit = '64MB'");
  });

  it("keeps the runner syntactically valid and fail-closed", () => {
    const syntax = spawnSync("bash", ["-n", runnerPath], {
      encoding: "utf8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);

    const pythonSyntax = spawnSync(
      pythonPath,
      [
        "-c",
        "compile(open(__import__('sys').argv[1], encoding='utf-8').read(), __import__('sys').argv[1], 'exec')",
        reducerPath,
      ],
      { encoding: "utf8" },
    );
    expect(pythonSyntax.status, pythonSyntax.stderr).toBe(0);

    const help = spawnSync("bash", [runnerPath, "--help"], {
      encoding: "utf8",
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("GLOBAL WRITERS FROZEN");
    expect(runner).toContain("OUTPUT IS OFF DB VOLUME");
    expect(runner).toContain("pg_ls_waldir()");
    expect(runner).toContain("CURRENT_TEMP_BYTES != temp_bytes_before");
    expect(runner).toContain("DB_MIN_FREE_BYTES_FLOOR=21474836480");
    expect(runner).toContain("OUTPUT_MIN_FREE_BYTES_FLOOR=32212254720");
    expect(runner).toContain("WAL_MAX_BYTES_CEILING=4294967296");
    expect(runner).toContain('PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"');
    expect(runner).not.toContain("NODE_BIN");
  });

  it("reduces complete chunks with exact BigInt sum and signed 64-bit XOR", () => {
    const directory = makeTemporaryDirectory();
    // Create out of order to prove filename order is not filesystem order.
    writePart(directory, 10, 20, true);
    writePart(directory, 0, 10, false);
    const output = join(directory, "fingerprint.csv");

    const result = spawnSync(
      pythonPath,
      [reducerPath, "reduce", directory, "20", output],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("status=ok chunks=2 total_blocks=20");

    const lines = readFileSync(output, "utf8").trim().split("\n");
    expect(lines).toHaveLength(257);
    expect(lines[0]).toBe(
      "contract_version,bucket,row_count,xor_a,sum_a,xor_b,sum_b,xor_c,sum_c,xor_d,sum_d",
    );
    expect(lines[1]).toBe(
      "adsecute-table-fingerprint.v2,0,3,-2,30,1,50,-5,0,9223372036854775807,0",
    );
    expect(
      lines[256].startsWith("adsecute-table-fingerprint.v2,255,3,"),
    ).toBe(true);
  });

  it("rejects incomplete coverage and malformed bucket sets", () => {
    const incomplete = makeTemporaryDirectory();
    writePart(incomplete, 0, 10, false);
    const incompleteResult = spawnSync(
      pythonPath,
      [
        reducerPath,
        "reduce",
        incomplete,
        "20",
        join(incomplete, "fingerprint.csv"),
      ],
      { encoding: "utf8" },
    );
    expect(incompleteResult.status).toBe(1);
    expect(incompleteResult.stderr).toContain("incomplete chunk coverage");

    const malformed = makeTemporaryDirectory();
    const malformedPart = writePart(malformed, 0, 10, false);
    const lines = readFileSync(malformedPart, "utf8").trim().split("\n");
    const last = lines.at(-1)!.split(",");
    last[2] = "254";
    lines[lines.length - 1] = last.join(",");
    writeFileSync(malformedPart, `${lines.join("\n")}\n`, "utf8");

    const malformedResult = spawnSync(
      pythonPath,
      [reducerPath, "validate-part", malformedPart, "0", "10"],
      { encoding: "utf8" },
    );
    expect(malformedResult.status).toBe(1);
    expect(malformedResult.stderr).toContain("duplicate bucket 254");
  });
});
