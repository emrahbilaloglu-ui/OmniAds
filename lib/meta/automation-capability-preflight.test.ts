/**
 * PRE-DEPLOY AUDIT — the Phase A -> B capability-open preflight, unit-tested
 * against fixture data. No database, no host, no psql: every evaluator here
 * is a pure function over already-parsed rows, so every blocker this
 * verifier can name is proven to actually fire, deterministically.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_CAPABILITY_TARGET_BUSINESSES,
  BUDGET_WRITE_JOURNAL_ABSENT_ROW,
  BUDGET_WRITE_JOURNAL_PRESENCE_PROBE_SQL,
  BUDGET_WRITE_JOURNAL_PRESENT_SQL,
  RUNTIME_READBACK_SQL_STATEMENTS,
  evaluateAutomationCapabilityPreflight,
  evaluateAutomationCapabilityPreflightFromRows,
  evaluatePerBusinessRows,
  evaluateReadbackRows,
  parseReadbackCsv,
  perBusinessControlQuery,
  runRuntimePerBusinessQuery,
  runRuntimeReadback,
  type BusinessControlRow,
  type ParsedReadbackRow,
  type RuntimeQueryFn,
} from "@/lib/meta/automation-capability-preflight";

/** A complete, healthy `psql --csv` transcript: every section, all PASS. */
const HEALTHY_CSV = [
  "section,read_only,isolation,statement_timeout,application_name,verdict",
  "transaction_posture,on,repeatable read,30s,automation_off_readback_2026_09_03,PASS",
  "",
  "section,control_rows,enabled_rows,account_bound_rows,verdict",
  "master_switch,6,0,0,PASS",
  "",
  "section,business_id,business_name,enabled,activated_account,enabled_by,enabled_at,verdict",
  "",
  "section,control_rows,lifted_rows,verdict",
  "dry_run_guardrail,6,0,PASS",
  "",
  "section,mode_rows,auto_rows,budget_auto_rows,verdict",
  "decision_type_modes,3,0,0,PASS",
  "",
  "section,business_id,decision_type,mode,updated_by,updated_at,verdict",
  "",
  "section,auto_execute_rows,stopped_rows,verdict",
  "readiness_tier,0,0,PASS",
  "",
  "section,auto_execution_default,activated_account_present,activated_account_nullable,activated_account_default,readiness_tier_default,verdict",
  "schema_defaults,false,1,YES,,'manual_review'::text,PASS",
  "",
  "section,guardrails_default,verdict",
  "schema_guardrail_default,\"'{\"\"dryRunOnly\"\": true}'::jsonb\",PASS",
  "",
  "section,budget_proposals,claimed,reconcile,dispatch_started,verdict",
  "budget_queue,2,0,0,PASS",
  "",
  "section,table_present,journal_rows,provider_attempted,verified_writes,verdict",
  "budget_write_journal,true,0,0,0,PASS",
  "",
].join("\n");

function csvWithSectionRow(section: string, rowCsv: string, target: string): string {
  // Replace one data line for `section` with a caller-supplied CSV row,
  // proving each blocker independently rather than hand-building a whole
  // transcript per case.
  const lines = HEALTHY_CSV.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`${section},`));
  expect(at, `fixture must already contain a ${section} row`).toBeGreaterThanOrEqual(0);
  lines[at] = rowCsv;
  void target;
  return lines.join("\n");
}

describe("parseReadbackCsv — the psql --csv transcript reader", () => {
  it("extracts every data row as {section, verdict}, skipping headers and blanks", () => {
    const rows = parseReadbackCsv(HEALTHY_CSV);
    const bySection = Object.fromEntries(rows.map((r) => [r.section, r.verdict]));
    expect(bySection.transaction_posture).toBe("PASS");
    expect(bySection.master_switch).toBe("PASS");
    expect(bySection.budget_write_journal).toBe("PASS");
  });

  it("handles a quoted field containing a comma without splitting it", () => {
    const csv = 'section,note,verdict\nx,"a, b",PASS\n';
    const rows = parseReadbackCsv(csv);
    expect(rows).toEqual([{ section: "x", verdict: "PASS" }]);
  });

  it("never treats a header line's own 'section' cell as a data row", () => {
    const rows = parseReadbackCsv(HEALTHY_CSV);
    expect(rows.some((r) => r.section === "section")).toBe(false);
  });

  it("an empty result set (header + blank line only) contributes zero rows", () => {
    const csv = "section,verdict\n\n";
    expect(parseReadbackCsv(csv)).toEqual([]);
  });
});

describe("evaluateReadbackRows — every section is checked, by name", () => {
  it("passes the healthy transcript", () => {
    const result = evaluateReadbackRows(parseReadbackCsv(HEALTHY_CSV));
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("refuses when master_switch itself is not PASS", () => {
    const csv = csvWithSectionRow("master_switch", "master_switch,6,2,1,FAIL — see section 1b", "");
    const result = evaluateReadbackRows(parseReadbackCsv(csv));
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" | ")).toContain("master_switch");
  });

  it("refuses when master_switch_offenders has any row, even if master_switch itself is absent from this check", () => {
    const lines = HEALTHY_CSV.split("\n");
    const headerAt = lines.findIndex((l) =>
      l.startsWith("section,business_id,business_name,enabled,activated_account"));
    lines.splice(
      headerAt + 1, 0,
      'master_switch_offenders,f8a3b5ac-588c-462f-8702-11cd24ff3cd2,IwaStore,true,act_1087566732415606,u1,2026-09-03T00:00:00Z,FAIL',
    );
    const result = evaluateReadbackRows(parseReadbackCsv(lines.join("\n")));
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" | ")).toContain("master_switch_offenders: 1 offending row(s)");
  });

  it("refuses a 'PASS (pre-migration)' verdict — this workflow runs strictly after migrations", () => {
    const csv = csvWithSectionRow(
      "schema_defaults",
      "schema_defaults,false,0,,,,PASS (pre-migration)",
      "",
    );
    const result = evaluateReadbackRows(parseReadbackCsv(csv));
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" | ")).toContain("schema_defaults");
    expect(result.blockers.join(" | ")).toContain("PASS (pre-migration)");
  });

  it("refuses budget_write_journal pre-migration too, for the same reason", () => {
    const csv = csvWithSectionRow(
      "budget_write_journal",
      "budget_write_journal,false,0,0,0,PASS (pre-migration)",
      "",
    );
    expect(evaluateReadbackRows(parseReadbackCsv(csv)).ok).toBe(false);
  });

  it("refuses a missing section — the read did not happen", () => {
    const lines = HEALTHY_CSV.split("\n").filter((l) => !l.startsWith("master_switch,"));
    const result = evaluateReadbackRows(parseReadbackCsv(lines.join("\n")));
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" | ")).toContain("master_switch: no row returned");
  });

  it.each([
    "dry_run_guardrail", "decision_type_modes", "readiness_tier",
    "schema_guardrail_default", "budget_queue",
  ])("refuses when %s reports FAIL", (section) => {
    const csv = csvWithSectionRow(section, `${section},1,1,FAIL`, "");
    const result = evaluateReadbackRows(parseReadbackCsv(csv));
    expect(result.ok).toBe(false);
  });
});

describe("evaluatePerBusinessRows — the six frozen businesses, named", () => {
  it("declares exactly six target businesses", () => {
    expect(AUTOMATION_CAPABILITY_TARGET_BUSINESSES).toHaveLength(6);
    expect(AUTOMATION_CAPABILITY_TARGET_BUSINESSES.map((b) => b.name).sort()).toEqual([
      "Bilsem Zeka", "ColorFullWorldsTR", "Grandmix", "IwaStore", "IwaTR", "TheSwaf",
    ]);
  });

  const rowAbsentFor = (): BusinessControlRow[] =>
    AUTOMATION_CAPABILITY_TARGET_BUSINESSES.map((b) => ({
      business_id: b.businessId, auto_execution_enabled: null,
      auto_execution_provider_account_id: null,
    }));

  it("passes when every target business has no row at all", () => {
    const result = evaluatePerBusinessRows(rowAbsentFor());
    expect(result.ok).toBe(true);
    expect(result.perBusiness.every((p) => p.status === "row_absent")).toBe(true);
  });

  it("passes when a row exists and is explicitly FALSE (IwaStore's known shape)", () => {
    const rows = rowAbsentFor();
    const iwaStore = rows.find((r) => r.business_id === "f8a3b5ac-588c-462f-8702-11cd24ff3cd2")!;
    iwaStore.auto_execution_enabled = false;
    const result = evaluatePerBusinessRows(rows);
    expect(result.ok).toBe(true);
    const verdict = result.perBusiness.find((p) => p.name === "IwaStore")!;
    expect(verdict.status).toBe("off");
  });

  it("refuses and NAMES the exact business when one is enabled", () => {
    const rows = rowAbsentFor();
    const grandmix = rows.find((r) => r.business_id === "5dbc7147-f051-4681-a4d6-20617170074f")!;
    grandmix.auto_execution_enabled = true;
    grandmix.auto_execution_provider_account_id = "act_805150454596350";
    const result = evaluatePerBusinessRows(rows);
    expect(result.ok).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toContain("Grandmix");
    expect(result.blockers[0]).toContain("5dbc7147-f051-4681-a4d6-20617170074f");
    expect(result.blockers[0]).toContain("act_805150454596350");
    expect(result.perBusiness.find((p) => p.name === "Grandmix")!.status).toBe("ENABLED");
  });

  it("refuses when TWO businesses are enabled, naming both independently", () => {
    const rows = rowAbsentFor();
    rows[0]!.auto_execution_enabled = true; // Bilsem Zeka
    rows[3]!.auto_execution_enabled = true; // IwaStore
    const result = evaluatePerBusinessRows(rows);
    expect(result.blockers).toHaveLength(2);
    expect(result.blockers.some((b) => b.includes("Bilsem Zeka"))).toBe(true);
    expect(result.blockers.some((b) => b.includes("IwaStore"))).toBe(true);
  });

  it("refuses when a target business row is silently missing from the result set", () => {
    const rows = rowAbsentFor().slice(0, 5); // drop the sixth
    const result = evaluatePerBusinessRows(rows);
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" | ")).toContain("expected 6 target-business rows, got 5");
  });

  it("the query names every one of the six businesses by exact ID", () => {
    const sql = perBusinessControlQuery();
    for (const target of AUTOMATION_CAPABILITY_TARGET_BUSINESSES) {
      expect(sql, target.name).toContain(target.businessId);
    }
  });
});

describe("evaluateAutomationCapabilityPreflight — unknown/read-failure fails closed", () => {
  const goodBusinessRows: BusinessControlRow[] = AUTOMATION_CAPABILITY_TARGET_BUSINESSES.map((b) => ({
    business_id: b.businessId, auto_execution_enabled: null, auto_execution_provider_account_id: null,
  }));

  it("passes when both the readback and the six-business check pass", () => {
    const result = evaluateAutomationCapabilityPreflight({
      readbackCsvOutput: HEALTHY_CSV, businessRows: goodBusinessRows,
    });
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.perBusiness).toHaveLength(6);
  });

  it("readback === null is UNKNOWN, never a silent pass", () => {
    const result = evaluateAutomationCapabilityPreflight({
      readbackCsvOutput: null, businessRows: goodBusinessRows,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" | ")).toContain("readback_unreadable");
  });

  it("businessRows === null is UNKNOWN, never a silent pass", () => {
    const result = evaluateAutomationCapabilityPreflight({
      readbackCsvOutput: HEALTHY_CSV, businessRows: null,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" | ")).toContain("target_businesses_unreadable");
  });

  it("both null: both blockers present, and neither hides the other", () => {
    const result = evaluateAutomationCapabilityPreflight({
      readbackCsvOutput: null, businessRows: null,
    });
    expect(result.blockers).toHaveLength(2);
  });

  it("combines blockers from both halves when both fail", () => {
    const enabledRows = goodBusinessRows.map((r, i) =>
      i === 0 ? { ...r, auto_execution_enabled: true } : r);
    const badCsv = csvWithSectionRow("master_switch", "master_switch,6,1,1,FAIL", "");
    const result = evaluateAutomationCapabilityPreflight({
      readbackCsvOutput: badCsv, businessRows: enabledRows,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.length).toBeGreaterThanOrEqual(2);
  });
});

describe("RUNTIME_READBACK_SQL_STATEMENTS — byte-identical to the operator document, not retyped", () => {
  const doc = readFileSync("docs/audits/AUTOMATION_OFF_READBACK_2026-09-03.md", "utf8");
  const fenceStart = doc.indexOf("```sql");
  const fenceEnd = doc.indexOf("```", fenceStart + 6);
  const fullSql = doc.slice(fenceStart + 6, fenceEnd);

  it("every embedded statement's text is present verbatim in the document's own fenced SQL block", () => {
    for (const { section, sql } of RUNTIME_READBACK_SQL_STATEMENTS) {
      expect(fullSql, `section ${section} must appear verbatim in the doc`).toContain(sql);
    }
  });

  it("covers exactly the ten top-level/offender sections the doc declares before section 6b", () => {
    expect(RUNTIME_READBACK_SQL_STATEMENTS.map((s) => s.section)).toEqual([
      "transaction_posture",
      "master_switch",
      "master_switch_offenders",
      "dry_run_guardrail",
      "decision_type_modes",
      "decision_type_mode_offenders",
      "readiness_tier",
      "schema_defaults",
      "schema_guardrail_default",
      "budget_queue",
    ]);
  });

  it("the presence-probe and present-branch SQL are also verbatim substrings of the doc", () => {
    expect(fullSql).toContain(BUDGET_WRITE_JOURNAL_PRESENCE_PROBE_SQL);
    expect(fullSql).toContain(BUDGET_WRITE_JOURNAL_PRESENT_SQL);
  });

  it("the absent-branch row matches the doc's own \\else literal values exactly", () => {
    expect(fullSql).toContain("'PASS (pre-migration)'   AS verdict");
    expect(BUDGET_WRITE_JOURNAL_ABSENT_ROW).toEqual({
      section: "budget_write_journal",
      verdict: "PASS (pre-migration)",
    });
  });

  it("no embedded statement contains psql meta-commands or the doc's own transaction prelude", () => {
    for (const { sql } of RUNTIME_READBACK_SQL_STATEMENTS) {
      expect(sql).not.toContain("\\gset");
      expect(sql).not.toContain("\\if");
      expect(sql).not.toContain("\\else");
      expect(sql).not.toContain("\\endif");
      expect(sql).not.toMatch(/^BEGIN\b/);
    }
    expect(BUDGET_WRITE_JOURNAL_PRESENCE_PROBE_SQL).not.toContain("\\gset");
    expect(BUDGET_WRITE_JOURNAL_PRESENT_SQL).not.toContain("\\if");
  });
});

describe("runRuntimeReadback — the injected-query DB path, no CSV, no psql", () => {
  /** A fake `RuntimeQueryFn`: healthy, journal table present. */
  function healthyQuery(overrides: Record<string, ParsedReadbackRow> = {}): RuntimeQueryFn {
    const healthy: Record<string, ParsedReadbackRow> = {
      transaction_posture: { section: "transaction_posture", verdict: "PASS" },
      master_switch: { section: "master_switch", verdict: "PASS" },
      master_switch_offenders: { section: "master_switch_offenders", verdict: "FAIL" }, // never returned when healthy
      dry_run_guardrail: { section: "dry_run_guardrail", verdict: "PASS" },
      decision_type_modes: { section: "decision_type_modes", verdict: "PASS" },
      decision_type_mode_offenders: { section: "decision_type_mode_offenders", verdict: "FAIL" },
      readiness_tier: { section: "readiness_tier", verdict: "PASS" },
      schema_defaults: { section: "schema_defaults", verdict: "PASS" },
      schema_guardrail_default: { section: "schema_guardrail_default", verdict: "PASS" },
      budget_queue: { section: "budget_queue", verdict: "PASS" },
      ...overrides,
    };
    return async (sql: string) => {
      if (sql === BUDGET_WRITE_JOURNAL_PRESENCE_PROBE_SQL) {
        return [{ journal_present: true }];
      }
      if (sql === BUDGET_WRITE_JOURNAL_PRESENT_SQL) {
        return [{ section: "budget_write_journal", verdict: "PASS" }];
      }
      const statement = RUNTIME_READBACK_SQL_STATEMENTS.find((s) => s.sql === sql);
      if (!statement) throw new Error(`unexpected SQL sent: ${sql.slice(0, 60)}`);
      // The two `_offenders` sections return NO rows when healthy — empty is
      // the pass case for those, exactly like the doc's own contract.
      if (statement.section.endsWith("_offenders")) return [];
      return [healthy[statement.section]!];
    };
  }

  it("a fully healthy run, journal table present, returns one row per section plus the journal row", () => {
    return runRuntimeReadback(healthyQuery()).then((rows) => {
      const evaluated = evaluateReadbackRows(rows);
      expect(evaluated.ok).toBe(true);
      expect(evaluated.blockers).toEqual([]);
      expect(rows.some((r) => r.section === "budget_write_journal" && r.verdict === "PASS")).toBe(true);
    });
  });

  it("when the journal presence probe reports false, the ABSENT row is used, the present-branch SQL is never sent, and the pure evaluator still refuses (pre-migration is never a pass here)", async () => {
    const sentSql: string[] = [];
    const query: RuntimeQueryFn = async (sql) => {
      sentSql.push(sql);
      if (sql === BUDGET_WRITE_JOURNAL_PRESENCE_PROBE_SQL) return [{ journal_present: false }];
      const statement = RUNTIME_READBACK_SQL_STATEMENTS.find((s) => s.sql === sql);
      if (statement?.section.endsWith("_offenders")) return [];
      if (statement) return [{ section: statement.section, verdict: "PASS" }];
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
    };
    const rows = await runRuntimeReadback(query);
    expect(sentSql).not.toContain(BUDGET_WRITE_JOURNAL_PRESENT_SQL);
    expect(rows).toContainEqual(BUDGET_WRITE_JOURNAL_ABSENT_ROW);
    // `evaluateReadbackRows` requires the EXACT verdict "PASS" for
    // budget_write_journal, never "PASS (pre-migration)" — the capability
    // workflow only ever runs strictly after migrations, so a pre-migration
    // journal state reaching this evaluator is itself a blocker, matching
    // the CSV-based "refuses budget_write_journal pre-migration too" case
    // above. The runtime path must fail closed the same way.
    const evaluated = evaluateReadbackRows(rows);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.blockers.join(" | ")).toContain("PASS (pre-migration)");
  });

  it("a single FAIL verdict from one real statement is caught by the pure evaluator, not swallowed", async () => {
    const rows = await runRuntimeReadback(
      healthyQuery({ master_switch: { section: "master_switch", verdict: "FAIL" } }),
    );
    const evaluated = evaluateReadbackRows(rows);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.blockers.join(" | ")).toContain("master_switch");
  });

  it("an offender row present when its parent section failed is itself a blocker", async () => {
    const query: RuntimeQueryFn = async (sql) => {
      if (sql === BUDGET_WRITE_JOURNAL_PRESENCE_PROBE_SQL) return [{ journal_present: false }];
      const statement = RUNTIME_READBACK_SQL_STATEMENTS.find((s) => s.sql === sql);
      if (statement?.section === "master_switch") return [{ section: "master_switch", verdict: "FAIL" }];
      if (statement?.section === "master_switch_offenders") {
        return [{ section: "master_switch_offenders", business_id: "x", verdict: "FAIL" }];
      }
      if (statement?.section.endsWith("_offenders")) return [];
      if (statement) return [{ section: statement.section, verdict: "PASS" }];
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
    };
    const rows = await runRuntimeReadback(query);
    const evaluated = evaluateReadbackRows(rows);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.blockers.some((b) => b.startsWith("master_switch_offenders"))).toBe(true);
  });

  it("a query that throws propagates — the caller must treat a thrown preflight as a hard failure, never a silent pass", async () => {
    const query: RuntimeQueryFn = async () => {
      throw new Error("connection reset");
    };
    await expect(runRuntimeReadback(query)).rejects.toThrow("connection reset");
  });
});

describe("runRuntimePerBusinessQuery — the injected-query six-business path", () => {
  it("maps enabled/off/absent rows correctly from raw query rows", async () => {
    const targetIds = AUTOMATION_CAPABILITY_TARGET_BUSINESSES.map((b) => b.businessId);
    const query: RuntimeQueryFn = async () => [
      { business_id: targetIds[0], auto_execution_enabled: false, auto_execution_provider_account_id: null },
      { business_id: targetIds[1], auto_execution_enabled: true, auto_execution_provider_account_id: "act_1" },
      { business_id: targetIds[2], auto_execution_enabled: null, auto_execution_provider_account_id: null },
    ];
    const rows = await runRuntimePerBusinessQuery(query);
    expect(rows).toHaveLength(3);
    const evaluated = evaluatePerBusinessRows(rows.concat(
      AUTOMATION_CAPABILITY_TARGET_BUSINESSES.slice(3).map((b) => ({
        business_id: b.businessId, auto_execution_enabled: false, auto_execution_provider_account_id: null,
      })),
    ));
    expect(evaluated.ok).toBe(false);
    expect(evaluated.blockers.some((b) => b.includes(targetIds[1]!))).toBe(true);
  });

  it("sends exactly perBusinessControlQuery()'s SQL text", async () => {
    let sentSql = "";
    const query: RuntimeQueryFn = async (sql) => {
      sentSql = sql;
      return [];
    };
    await runRuntimePerBusinessQuery(query);
    expect(sentSql).toBe(perBusinessControlQuery());
  });
});

describe("evaluateAutomationCapabilityPreflightFromRows — the row-based sibling of the CSV-based combiner", () => {
  const goodReadbackRows: ParsedReadbackRow[] = [
    { section: "transaction_posture", verdict: "PASS" },
    { section: "master_switch", verdict: "PASS" },
    { section: "dry_run_guardrail", verdict: "PASS" },
    { section: "decision_type_modes", verdict: "PASS" },
    { section: "readiness_tier", verdict: "PASS" },
    { section: "schema_defaults", verdict: "PASS" },
    { section: "schema_guardrail_default", verdict: "PASS" },
    { section: "budget_queue", verdict: "PASS" },
    { section: "budget_write_journal", verdict: "PASS" },
  ];
  const goodBusinessRows: BusinessControlRow[] = AUTOMATION_CAPABILITY_TARGET_BUSINESSES.map((b) => ({
    business_id: b.businessId, auto_execution_enabled: false, auto_execution_provider_account_id: null,
  }));

  it("passes when both halves are healthy", () => {
    const result = evaluateAutomationCapabilityPreflightFromRows({
      readbackRows: goodReadbackRows, businessRows: goodBusinessRows,
    });
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.perBusiness).toHaveLength(6);
  });

  it("readbackRows === null is UNKNOWN, never a silent pass", () => {
    const result = evaluateAutomationCapabilityPreflightFromRows({
      readbackRows: null, businessRows: goodBusinessRows,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" | ")).toContain("readback_unreadable");
  });

  it("businessRows === null is UNKNOWN, never a silent pass", () => {
    const result = evaluateAutomationCapabilityPreflightFromRows({
      readbackRows: goodReadbackRows, businessRows: null,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" | ")).toContain("target_businesses_unreadable");
  });

  it("an enabled business fails even when every readback section is PASS", () => {
    const enabledRows = goodBusinessRows.map((r, i) => (i === 0 ? { ...r, auto_execution_enabled: true } : r));
    const result = evaluateAutomationCapabilityPreflightFromRows({
      readbackRows: goodReadbackRows, businessRows: enabledRows,
    });
    expect(result.ok).toBe(false);
  });
});

describe("scripts/automation-capability-preflight-cli.ts — the runtime package contract", () => {
  const cliSource = readFileSync("scripts/automation-capability-preflight-cli.ts", "utf8");

  it("no longer shells out to psql", () => {
    // The docstring legitimately explains, in prose, why psql is no longer
    // used — strip comments before checking so that correct prose doesn't
    // trip a check meant to catch a real spawned subprocess.
    const codeOnly = cliSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(codeOnly).not.toContain("psql");
    expect(codeOnly).not.toContain("spawnSync");
  });

  it("no longer reads the operator markdown document", () => {
    // The explanatory docstring legitimately NAMES the doc, in prose, to
    // say why it is no longer read — strip comments before checking so
    // that correct prose doesn't trip a check meant to catch real code.
    const codeOnly = cliSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(codeOnly).not.toContain("AUTOMATION_OFF_READBACK");
    expect(codeOnly).not.toContain("readFileSync");
  });

  it("uses the app's own getDb()/runDbTransaction() instead", () => {
    expect(cliSource).toContain("getDb");
    expect(cliSource).toContain("runDbTransaction");
    expect(cliSource).toMatch(/@\/lib\/db/);
  });

  it("sets a bounded READ ONLY transaction — isolation, timeout, and a unique application_name", () => {
    expect(cliSource).toMatch(/READ ONLY/i);
    expect(cliSource).toContain("statement_timeout");
    expect(cliSource).toContain("application_name");
  });

  it("every static import this script reaches resolves under a directory the worker image actually copies", () => {
    // Mirrors Dockerfile's `worker-runner` stage COPY list exactly — a
    // directory NOT in this set (most notably `docs/`) does not exist in
    // the shipped container, so an import reaching outside it would throw
    // at runtime no matter how correct the code inside it is.
    const workerImageDirs = [
      "app", "lib", "providers", "scripts", "deploy", "src", "store", "hooks", "components",
    ];
    const workerImageRootFiles = [
      "package.json", "package-lock.json", "next.config.ts", "next-env.d.ts",
      "tsconfig.json", "postcss.config.mjs",
    ];
    const seen = new Set<string>();
    const queue: string[] = ["scripts/automation-capability-preflight-cli.ts"];
    const offenders: string[] = [];

    while (queue.length > 0) {
      const relPath = queue.shift()!;
      if (seen.has(relPath)) continue;
      seen.add(relPath);

      const topLevel = relPath.split("/")[0]!;
      const isRootFile = workerImageRootFiles.includes(relPath);
      if (!workerImageDirs.includes(topLevel) && !isRootFile) {
        offenders.push(relPath);
        continue;
      }

      let source: string;
      try {
        source = readFileSync(relPath, "utf8");
      } catch {
        continue; // a .ts/.tsx extension guess below may not exist; skip silently
      }
      const importPattern = /from\s+["']([^"']+)["']/g;
      for (const match of source.matchAll(importPattern)) {
        const spec = match[1]!;
        if (!spec.startsWith("@/")) continue; // only trace this repo's own modules
        const withoutAlias = spec.slice(2);
        for (const ext of [".ts", ".tsx", "/index.ts"]) {
          const candidate = withoutAlias + ext;
          try {
            readFileSync(candidate, "utf8");
            queue.push(candidate);
            break;
          } catch {
            // try the next extension
          }
        }
      }
    }

    expect(offenders, `imports reaching outside the worker image: ${offenders.join(", ")}`).toEqual([]);
  });
});
