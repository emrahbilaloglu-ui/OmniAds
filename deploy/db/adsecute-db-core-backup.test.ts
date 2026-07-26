import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(
  process.cwd(),
  "deploy/db/adsecute-db-core-backup.sh",
);
const script = readFileSync(scriptPath, "utf8");

/**
 * The contract this file guards was written against an allowlist backup: it
 * named four authority tables that had to appear in the list, and asserted one
 * exact `sha256sum` invocation.
 *
 * There is no allowlist any more. The script dumps the whole database and proves
 * completeness against the live catalog, so "these four tables are named" is no
 * longer a property the text can have — asserting it would now be asserting the
 * absence of the fix. The guarantees are kept and widened: no table filter at
 * all, a completeness check that fails by table name, and checksums that survive
 * the atomic rename.
 *
 * These are source-text assertions. They record intent and catch a regression in
 * review; they are NOT the proof that the artifact restores. That proof is
 * `scripts/ephemeral-postgres-dr-restore-seam.ts`, which runs this exact script
 * against a real database and restores the result into an empty one.
 */
describe("database core backup contract", () => {
  it("remains valid Bash", () => {
    const result = spawnSync("bash", ["-n", scriptPath], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("carries every table's data, in one tier or the other, with no hand-written list", () => {
    // The original allowlist omitted 187 of 202 tables, including every object
    // carrying connection, credential, selection or scheduling authority. There
    // is still no list of table names in this file: the primary dump takes
    // everything, and the only exclusions are computed from the recovery policy
    // — where the DEFAULT is tier A, so an unclassified table keeps its data.
    expect(script).not.toContain("CORE_TABLES");
    expect(script).toContain("--format=custom");
    // The per-table archive is the ONLY --table use, and it is how tier-B data
    // is preserved rather than dropped.
    const tableFlagUses = script.match(/--table="/g) ?? [];
    expect(tableFlagUses).toHaveLength(1);
    // Exclusions are generated from the policy, never literals.
    expect(script).toContain('exclude_args+=( "--exclude-table-data=public.${t}" )');
    expect(script).not.toMatch(/--exclude-table-data=public\.[a-z]/);
  });

  it("refuses a policy that would drop authority data or name a missing table", () => {
    expect(script).toContain("RECOVERY_AUTHORITY_TABLES");
    expect(script).toContain("authority_table_in_tier_b");
    expect(script).toContain("tier_b_table_absent_from_catalog");
    // A tier-B table must still have its SCHEMA in the primary artifact, or a
    // tier-A restore has nowhere to replay the archive into.
    expect(script).toContain("tier_b_table_schema_missing_from_dump");
    // And each archive is validated on the two facts a replay depends on.
    expect(script).toContain("tier_b_archive_missing_table_data");
    expect(script).toContain("tier_b_archive_empty");
  });

  it("never writes the archive onto the filesystem holding the data", () => {
    expect(script).toContain("archive_shares_filesystem_with_data");
  });

  it("proves at backup time that nothing was omitted", () => {
    // The successor to "these four tables are named": ask the live catalog what
    // exists, read the dump's own TOC, and fail naming the difference — so a
    // table added tomorrow is covered without anyone editing a list.
    expect(script).toMatch(/pg_restore\s+(--list|-l)/);
    expect(script).toContain("missing_tables");
    expect(script).toContain("backup_incomplete");
  });

  it("stays restorable onto a host that does not share this one's tablespaces", () => {
    // Carried over from the production hotfix this supersedes.
    expect(script).toContain("--no-tablespaces");
    expect(script).toContain("--no-owner");
    expect(script).toContain("--no-privileges");
  });

  it("writes portable checksums that survive the atomic directory rename", () => {
    // Absolute paths recorded under `.tmp-<timestamp>/` are renamed away by the
    // atomic `mv`, which made SHA256SUMS unverifiable by construction.
    expect(script).toContain('cd "$TMP_DIR"');
    expect(script).not.toMatch(/sha256sum "\$TMP_DIR\//);
    expect(script).toContain("verify_command=sha256sum -c SHA256SUMS");
  });

  it("never selects a column value, so no credential can reach the log", () => {
    expect(script).not.toMatch(/SELECT\s+[^;]*access_token/i);
    expect(script).not.toMatch(/SELECT\s+[^;]*refresh_token/i);
  });
});
