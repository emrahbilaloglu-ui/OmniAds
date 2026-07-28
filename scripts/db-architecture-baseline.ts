import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const runtimeOnly = process.argv.includes("--runtime-only");

function fail(message: string): never {
  throw new Error(message);
}

function ensureFileContains(filePath: string, requiredSnippets: string[]) {
  const absolutePath = path.join(repoRoot, filePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`Missing required file: ${filePath}`);
  }
  const content = fs.readFileSync(absolutePath, "utf8");
  if (!content.trim()) {
    fail(`File is empty: ${filePath}`);
  }
  for (const snippet of requiredSnippets) {
    if (!content.includes(snippet)) {
      fail(`File ${filePath} is missing required snippet: ${snippet}`);
    }
  }
}

function stripSqlComments(sql: string) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");
}

function validateReadOnlySql(filePath: string) {
  const absolutePath = path.join(repoRoot, filePath);
  const content = fs.readFileSync(absolutePath, "utf8");
  const normalized = stripSqlComments(content).toUpperCase();
  const forbidden = [
    /\bINSERT\s+INTO\b/,
    /\bUPDATE\s+[A-Z_]/,
    /\bDELETE\s+FROM\b/,
    /\bALTER\s+TABLE\b/,
    /\bCREATE\s+TABLE\b/,
    /\bDROP\s+TABLE\b/,
    /\bTRUNCATE\b/,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(normalized)) {
      fail(`Read-only SQL check failed for ${filePath}: found forbidden statement ${pattern}`);
    }
  }
}

function runCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    fail(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function runCommandCapture(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    fail(`Command failed: ${command} ${args.join(" ")}`);
  }
  return result.stdout ?? "";
}

function main() {
  ensureFileContains("docs/architecture/db-dependency-map.md", [
    "## core",
    "## control",
    "## raw",
    "## warehouse",
    "## serving",
    "## audit",
  ]);
  ensureFileContains("docs/architecture/ui-api-dependency-map.md", [
    "## Overview surface",
    "## Meta surface",
    "## Google Ads surface",
    "## Shopify-connected surface",
  ]);
  ensureFileContains("docs/architecture/db-risk-register.md", [
    "## request path içinde migration",
    "## GET sırasında write",
    "## request sırasında lazy projection hydration",
    "## aynı endpoint içinde mixed live + warehouse + projection okuma",
    "## büyük multi-responsibility dosyalar",
    "## schema/state coupling",
  ]);
  ensureFileContains("docs/architecture/db-target-architecture.md", [
    "## Target layer model",
    "## Target data flow",
    "## direct-live lane exceptions",
    "## Safe implementation order",
    "No HTTP route may execute migrations",
  ]);
  ensureFileContains("docs/architecture/serving-write-ownership-map.md", [
    "## Overview serving projections",
    "## User-facing durable reporting caches",
    "## Shopify overview serving state",
  ]);
  ensureFileContains("docs/architecture/db-serving-hardening-final-state.md", [
    "## Before vs after",
    "## Final guarantees now in place",
    "## Explicit owner model",
    "## Automated vs manual freshness",
    "## Runtime validation and release status",
    "## Remaining non-blocking debt",
  ]);
  ensureFileContains("docs/architecture/live-db-baseline-checks.sql", [
    "Projection vs warehouse parity checks",
    "Provider sanity aggregates",
  ]);
  validateReadOnlySql("docs/architecture/live-db-baseline-checks.sql");

  const scanOutput = runCommandCapture(process.execPath, [
    "--import",
    "tsx",
    "scripts/check-request-path-side-effects.ts",
    "--json",
  ]);
  const scanResult = JSON.parse(scanOutput) as {
    findings: Array<{ type: string; file: string; summary: string }>;
  };
  const migrationViolations = scanResult.findings.filter(
    (finding) =>
      finding.type === "migration_call" || finding.type === "migration_import",
  );
  if (migrationViolations.length > 0) {
    const summary = migrationViolations
      .map((finding) => `${finding.file}: ${finding.summary}`)
      .join("\n");
    fail(`Request-path migration guard failed:\n${summary}`);
  }
  const getWriteViolations = scanResult.findings.filter((finding) =>
    [
      "state_write_call",
      "projection_write_call",
      "cache_write_call",
      "refresh_trigger_call",
    ].includes(finding.type),
  );
  if (getWriteViolations.length > 0) {
    const summary = getWriteViolations
      .map((finding) => `${finding.file}: ${finding.summary}`)
      .join("\n");
    fail(`GET/read-path side-effect guard failed:\n${summary}`);
  }
  const ownerViolations = scanResult.findings.filter(
    (finding) => finding.type === "serving_write_owner_violation",
  );
  if (ownerViolations.length > 0) {
    const summary = ownerViolations
      .map((finding) => `${finding.file}: ${finding.summary}`)
      .join("\n");
    fail(`Serving write-owner guard failed:\n${summary}`);
  }
  // Everything the scanner can report is blocking here UNLESS it is named below
  // as advisory. The previous shape was the opposite: three denylists of known
  // types, so a finding type added later was silently ignored by this gate until
  // somebody remembered to extend a list. That is the same defect shape the
  // reachability guard exists to catch — a check that only sees what it was told
  // to look for — so this one now fails closed on anything it does not
  // recognise. Adding a finding type deliberately costs one line here.
  const advisoryFindingTypes = new Set([
    "large_mixed_concern",
    "mixed_live_warehouse_projection",
  ]);
  const alreadyReportedTypes = new Set([
    "migration_call",
    "migration_import",
    "state_write_call",
    "projection_write_call",
    "cache_write_call",
    "refresh_trigger_call",
    "serving_write_owner_violation",
  ]);
  const unrecognisedViolations = scanResult.findings.filter(
    (finding) =>
      !advisoryFindingTypes.has(finding.type) &&
      !alreadyReportedTypes.has(finding.type),
  );
  if (unrecognisedViolations.length > 0) {
    const summary = unrecognisedViolations
      .map((finding) => `${finding.type} ${finding.file}: ${finding.summary}`)
      .join("\n");
    fail(`Request-path write-reachability guard failed:\n${summary}`);
  }
  runCommand(process.execPath, [
    "--import",
    "tsx",
    "scripts/check-request-path-side-effects.ts",
  ]);

  if (runtimeOnly) {
    process.stdout.write(
      "Runtime-only baseline enabled; skipping Vitest contract suite because CI remains the authoritative unit-test gate.\n",
    );
    return;
  }

  runCommand(process.platform === "win32" ? "npm.cmd" : "npm", [
    "exec",
    "vitest",
    "run",
    "app/api/migrate/route.test.ts",
    "app/api/overview/route.test.ts",
    "app/api/overview-summary/route.test.ts",
    "app/api/overview-sparklines/route.test.ts",
    "app/api/sync/refresh/route.test.ts",
    "app/api/businesses/[businessId]/route.test.ts",
    "app/api/google-ads/repair-recent-gap/route.test.ts",
    "app/api/google-ads/status/route.test.ts",
    "app/api/meta/campaigns/route.test.ts",
    "app/api/meta/breakdowns/route.test.ts",
    "app/api/webhooks/shopify/sync/route.test.ts",
    "app/api/webhooks/shopify/customer-events/route.test.ts",
    "lib/access.test.ts",
    "lib/auth.test.ts",
    "lib/provider-account-discovery.test.ts",
    "lib/get-read-path-module-guard.test.ts",
    "lib/get-route-side-effect-guard.test.ts",
    "lib/serving-write-owner-guard.test.ts",
    "lib/user-facing-report-cache-owners.test.ts",
    "lib/overview-summary-range-owner.test.ts",
    "lib/overview-summary-materializer.test.ts",
    "lib/reporting-cache-writer.test.ts",
    "lib/seo/results-cache-writer.test.ts",
    "lib/shopify/overview-materializer.test.ts",
    "lib/sync/ga4-sync.test.ts",
    "lib/sync/search-console-sync.test.ts",
    "lib/sync/shopify-sync.test.ts",
    "lib/http-route-migration-guard.test.ts",
    "lib/request-path-migration-guard.test.ts",
  ]);
}

main();
