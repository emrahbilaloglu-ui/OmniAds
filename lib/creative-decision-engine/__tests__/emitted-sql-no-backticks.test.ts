/**
 * No emitted SQL may contain a backtick.
 *
 * Every one of these constants is built with a JavaScript template literal, so a
 * backtick inside it — in a comment, quoting an identifier the way prose does —
 * ENDS the literal. The failure is not subtle at runtime but it is subtle to
 * write: the text reads perfectly, and the parse error lands somewhere else
 * entirely, often in a different statement. It happened three separate times
 * while this contract was being built, each time in a comment explaining the
 * very SQL it broke.
 *
 * Structural, not a reminder: a string assertion cannot be forgotten the way a
 * convention can.
 */
import { describe, expect, it } from "vitest";

import {
  HYDRATE_AD_DECISION_INPUTS_QUERY,
} from "@/lib/creative-decision-engine/data-source";
import {
  ALTER_NATIVE_AD_DECISION_PROVENANCE_SQL,
  CREATE_NATIVE_AD_SNAPSHOTS_SQL,
} from "@/lib/creative-decision-engine/ad-evaluation-schema";
import {
  CREATE_NATIVE_AD_CALIBRATION_TABLE_SQL,
  INSERT_NATIVE_AD_CALIBRATION_SQL,
  NATIVE_AD_CALIBRATION_MIGRATION_SQL,
  READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
} from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import { D063_AUTHORITY_BLOCKER_CONSTRAINT_UPGRADE_SQL } from "@/lib/migrations";

const EMITTED: Record<string, string> = {
  HYDRATE_AD_DECISION_INPUTS_QUERY,
  READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
  INSERT_NATIVE_AD_CALIBRATION_SQL,
  CREATE_NATIVE_AD_CALIBRATION_TABLE_SQL,
  NATIVE_AD_CALIBRATION_MIGRATION_SQL,
  ALTER_NATIVE_AD_DECISION_PROVENANCE_SQL,
  CREATE_NATIVE_AD_SNAPSHOTS_SQL,
  D063_AUTHORITY_BLOCKER_CONSTRAINT_UPGRADE_SQL,
};

describe("emitted SQL is free of template-literal terminators", () => {
  for (const [name, sql] of Object.entries(EMITTED)) {
    it(`${name} contains no backtick`, () => {
      expect(typeof sql).toBe("string");
      expect(sql.includes("`"), `${name} has a backtick`).toBe(false);
    });

    /*
      A dollar-brace that survived into the output means an interpolation failed.
      `undefined` is matched only as a WHOLE word, because `undefined_column` is
      a real PostgreSQL error name that a comment may legitimately mention.
    */
    it(`${name} has no unresolved interpolation`, () => {
      expect(sql).not.toContain("${");
      expect(sql).not.toMatch(/\bundefined\b(?!_)/);
    });
  }
});
