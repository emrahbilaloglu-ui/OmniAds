import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

interface ScanFinding {
  type: string;
  file: string;
  summary: string;
  route?: string;
  methods?: string[];
  evidence: Array<{ line: number; snippet: string }>;
}

let cached: { findings: ScanFinding[]; notes: string[]; routesScanned: number } | null = null;

function runScan() {
  if (cached) return cached;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/check-request-path-side-effects.ts", "--json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  expect(result.status, result.stderr).toBe(0);
  cached = JSON.parse(result.stdout) as {
    findings: ScanFinding[];
    notes: string[];
    routesScanned: number;
  };
  return cached;
}

function format(findings: ScanFinding[]) {
  return findings.map(
    (finding) =>
      `${finding.file}: ${finding.summary}\n    ${finding.evidence
        .map((item) => item.snippet)
        .join("\n    ")}`,
  );
}

describe("GET route side-effect scanner guard", { timeout: 120_000 }, () => {
  it("reports zero GET/read-path write findings", () => {
    const output = runScan();
    const violations = output.findings.filter((finding) =>
      [
        "state_write_call",
        "projection_write_call",
        "cache_write_call",
        "refresh_trigger_call",
      ].includes(finding.type),
    );

    expect(format(violations)).toEqual([]);
  });

  /**
   * The check the previous version of this guard did not have.
   *
   * The named-target sets above were the whole of it, and neither
   * `upsertIntegration` nor the credential-refresh helper was in any of them —
   * so ~36 GET routes could rewrite `provider_connections` and
   * `integration_credentials` with the scan reporting a clean zero.
   *
   * Detection is now anchored on the TABLE and runs on every HTTP method: any
   * request path that reaches a write to a guarded identity table must have an
   * entry in REQUEST_PATH_WRITE_EXCEPTIONS naming the caller, the writer, the
   * exact tables, and a written reason.
   */
  it("reports zero unregistered request-path writes to guarded tables", () => {
    const output = runScan();
    const violations = output.findings.filter(
      (finding) => finding.type === "guarded_table_write_call",
    );
    expect(format(violations)).toEqual([]);
  });

  it("has no stale or malformed write-exception registry entries", () => {
    // Frozen in both directions, like the release-owner guard: an entry that
    // stops matching is a hole nobody is watching any more.
    const output = runScan();
    const violations = output.findings.filter((finding) =>
      ["unused_request_path_write_exception", "write_exception_registry_defect"].includes(
        finding.type,
      ),
    );
    expect(format(violations)).toEqual([]);
  });

  it("could resolve a handler body for every route file it scanned", () => {
    // Nine route files export their handler as `export { impl as GET } from …`.
    // Before that shape was followed, those nine were scanned for nothing at
    // all — and the report said zero findings, not "nine unexamined routes".
    const output = runScan();
    const violations = output.findings.filter(
      (finding) => finding.type === "route_handler_not_analyzable",
    );
    expect(format(violations)).toEqual([]);
  });

  it("did not truncate any call graph at the depth bound", () => {
    const output = runScan();
    const violations = output.findings.filter(
      (finding) => finding.type === "reachability_depth_truncated",
    );
    expect(format(violations)).toEqual([]);
  });

  it("scanned a plausible number of routes", () => {
    // A scan that silently stopped discovering routes would pass every
    // assertion above.
    expect(runScan().routesScanned).toBeGreaterThan(150);
  });
});
