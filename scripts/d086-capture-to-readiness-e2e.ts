#!/usr/bin/env node
/**
 * D086 — the CAPTURE-TO-READINESS end-to-end seam.
 *
 * Correction 7 rejected r7 because every "proof" started from hand-written
 * fixture rows: the readiness read was reconciled against INSERTs that no
 * deploy would ever produce. This starts where a real sync starts — at mapped
 * Meta campaign/ad-set response rows — and runs them through the REAL
 * persistence path (`mapCampaignObservationState`, `mapAdSetObservationState`,
 * `persistMetaEntityObservation`) into a real PostgreSQL cluster created by the
 * REAL migration registry, then asks `readBudgetReadiness` what it sees.
 *
 * It is safe to run because it boots its OWN cluster and hands the connection
 * to the child process explicitly; the guard below refuses to proceed unless
 * `DATABASE_URL` is the ephemeral cluster this process created.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const USER = "d086_e2e";
const DB = "d086_e2e";

function pgBinDir(): string {
  const need = ["initdb", "pg_ctl", "createdb"];
  const linux = fs.existsSync("/usr/lib/postgresql")
    ? fs.readdirSync("/usr/lib/postgresql", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join("/usr/lib/postgresql", entry.name, "bin"))
    : [];
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
    "/usr/local/opt/postgresql@16/bin",
    ...linux,
    ...(process.env.PATH ?? "").split(path.delimiter),
  ].filter(Boolean) as string[];
  const found = candidates.find((dir) => need.every((bin) => fs.existsSync(path.join(dir, bin))));
  if (!found) throw new Error("PostgreSQL binaries not found for the D086 e2e seam.");
  return found;
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function run(bin: string, args: string[], label: string, logFile?: string): void {
  const out = spawnSync(bin, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  if (out.status !== 0) {
    const log = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    throw new Error(`${label} failed: ${out.stderr || out.stdout}\n${log}`);
  }
}

export interface D086E2eReport {
  ok: boolean;
  postgresVersion: string;
  steps: Array<{ step: string; detail: string }>;
  cases: Array<{
    name: string; mechanics: string; status: string;
    blocker: string | null; attested: boolean;
  }>;
  capabilityProbe: Record<string, unknown>;
  indexCatalog: Array<{ indexname: string; indexdef: string }>;
  failures: string[];
}

/**
 * The evidence document, VERSIONED. r7's file is frozen and pinned; this is a
 * new path, never an overwrite.
 */
export const D086_E2E_EVIDENCE_PATH =
  "docs/audits/generated/d086-local-postgres-evidence-2026-09-02.r3.json";

/**
 * The exact verdict every case must produce, bound by name.
 *
 * A gate that checks only case NAMES passes while every case errors — that is
 * how r6 shipped a seam whose cases all failed. The status and the blocker are
 * part of the contract here.
 */
export const D086_E2E_REQUIRED_CASES: ReadonlyArray<{
  name: string; status: string; blocker: string | null; attested: boolean;
}> = Object.freeze([
  { name: "real_full_capture_ready", status: "ready", blocker: null, attested: true },
  { name: "real_writer_delta_ready", status: "ready", blocker: null, attested: true },
  { name: "real_scope_exit_ready", status: "ready", blocker: null, attested: true },
  { name: "future_heartbeat_preserves_history", status: "ready", blocker: null, attested: true },
  { name: "missing_partition_never_attests", status: "partial",
    blocker: "budget_universe_campaign_partition_absent", attested: false },
  { name: "foreign_partition_never_attests", status: "partial",
    blocker: "budget_universe_campaign_partition_scope_mismatch", attested: false },
  { name: "extended_lane_partition_never_attests", status: "partial",
    blocker: "budget_universe_campaign_partition_lane_mismatch", attested: false },
  { name: "missing_snapshot_never_attests", status: "partial",
    blocker: "budget_universe_campaign_snapshot_absent", attested: false },
  { name: "snapshot_partition_mismatch_never_attests", status: "partial",
    blocker: "budget_universe_campaign_snapshot_partition_mismatch", attested: false },
  { name: "snapshot_endpoint_mismatch_never_attests", status: "partial",
    blocker: "budget_universe_campaign_snapshot_endpoint_mismatch", attested: false },
  { name: "newer_failed_blocks_older_complete", status: "partial",
    blocker: "budget_universe_campaign_capture_failed", attested: false },
  { name: "newer_partial_blocks_older_complete", status: "partial",
    blocker: "budget_universe_campaign_capture_partial", attested: false },
  { name: "wrong_endpoint_named", status: "partial",
    blocker: "budget_universe_campaign_endpoint_mismatch", attested: false },
  { name: "cohort_mismatch_across_syncs", status: "partial",
    blocker: "budget_universe_cohort_mismatch", attested: false },
  { name: "explicit_tombstone_supersedes_manifest", status: "partial",
    blocker: "budget_universe_campaign_membership_tombstoned", attested: false },
  { name: "receipt_collision_refused", status: "ready", blocker: null, attested: true },
  { name: "true_tie_forward_insertion", status: "partial",
    blocker: "budget_universe_manifest_conflict", attested: false },
  { name: "true_tie_reversed_insertion", status: "partial",
    blocker: "budget_universe_manifest_conflict", attested: false },
]);

/** Every required case present, and each producing its exact bound verdict. */
export function verifyE2eCases(report: D086E2eReport): string[] {
  const problems: string[] = [];
  for (const required of D086_E2E_REQUIRED_CASES) {
    const actual = report.cases.find((entry) => entry.name === required.name);
    if (!actual) { problems.push(`missing case ${required.name}`); continue; }
    if (actual.status !== required.status || actual.blocker !== required.blocker
      || actual.attested !== required.attested) {
      problems.push(
        `${required.name}: expected ${required.status}/${required.blocker ?? "none"}`
        + `/attested=${required.attested}, got ${actual.status}/`
        + `${actual.blocker ?? "none"}/attested=${actual.attested}`);
    }
    if (!actual.mechanics || actual.mechanics.length < 20) {
      problems.push(`${required.name}: no mechanics recorded`);
    }
  }
  // The two insertion-order cases must agree, or the evidence proves nothing
  // about order independence.
  const forward = report.cases.find((c) => c.name === "true_tie_forward_insertion");
  const reversed = report.cases.find((c) => c.name === "true_tie_reversed_insertion");
  if (!forward || !reversed
    || forward.status !== reversed.status || forward.blocker !== reversed.blocker) {
    problems.push("the forward and reversed insertion orders did not agree");
  }
  return problems;
}

/**
 * The child does the work, because the observation writer resolves its pool
 * from `DATABASE_URL` at import time. The parent never imports `@/lib/db`, so
 * this process can never touch the workstation's configured database.
 */
export async function runD086CaptureToReadinessE2e(): Promise<D086E2eReport> {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-d086-e2e-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  try {
    run(path.join(bin, "initdb"),
      ["-D", dataDir, "-U", USER, "--auth=trust", "--no-locale"], "initdb");
    run(path.join(bin, "pg_ctl"), [
      "-D", dataDir, "-l", logFile, "-w", "-o",
      `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off`,
      "start",
    ], "pg_ctl start", logFile);
    run(path.join(bin, "createdb"),
      ["-h", "127.0.0.1", "-p", String(port), "-U", USER, DB], "createdb");

    const url = `postgres://${USER}@127.0.0.1:${port}/${DB}`;
    const child = spawnSync(
      path.join(process.cwd(), "node_modules/.bin/tsx"),
      [path.join(process.cwd(), "scripts/d086-capture-to-readiness-child.ts")],
      {
        encoding: "utf8",
        cwd: process.cwd(),
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          LC_ALL: "C",
          LANG: "C",
          DATABASE_URL: url,
          POSTGRES_URL: url,
          D086_E2E_EXPECTED_URL: url,
        },
      },
    );
    const marker = child.stdout?.lastIndexOf("__D086_E2E__") ?? -1;
    if (marker < 0) {
      return {
        ok: false,
        postgresVersion: "",
        steps: [],
        cases: [],
        capabilityProbe: {},
        indexCatalog: [],
        failures: [`child produced no report: ${child.stderr?.slice(-4000) ?? ""}`],
      };
    }
    const report = JSON.parse(
      child.stdout!.slice(marker + "__D086_E2E__".length)) as D086E2eReport;
    const problems = verifyE2eCases(report);
    return problems.length === 0
      ? report
      : { ...report, ok: false, failures: [...report.failures, ...problems] };
  } finally {
    spawnSync(path.join(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith("d086-capture-to-readiness-e2e.ts")) {
  runD086CaptureToReadinessE2e().then((report) => {
    if (process.argv.includes("--write-evidence")) {
      fs.writeFileSync(
        path.join(process.cwd(), D086_E2E_EVIDENCE_PATH),
        `${JSON.stringify({
          contract: "d086.capture-to-readiness-evidence.v2",
          generatedFor: "D086 correction 8",
          postgresVersion: report.postgresVersion,
          ok: report.ok,
          steps: report.steps,
          cases: report.cases,
          capabilityProbe: report.capabilityProbe,
          indexCatalog: report.indexCatalog,
          failures: report.failures,
        }, null, 2)}\n`,
        "utf8",
      );
    }
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  });
}
